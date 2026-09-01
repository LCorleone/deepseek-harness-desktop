import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { parseDesktopPolicy, type DesktopPolicy } from '../src/desktop-policy.ts'
import { encodeModelGatewayBlob } from '../scripts/make-model-gateway-blob.mjs'
import {
  apply,
  decodeUsageReportDbBlob,
  inject,
  MODEL_USAGE_COLUMNS,
  MODEL_USAGE_FLUSH_INTERVAL_MS,
  MODEL_USAGE_FLUSH_THRESHOLD_ROWS,
  MODEL_USAGE_QUEUE_LIMIT_ROWS,
  MODEL_USAGE_RECONNECT_BASE_MS,
  MODEL_USAGE_RECONNECT_MAX_MS,
  MODEL_USAGE_TABLE,
  modelUsageInsertSql,
  ModelUsageProjection,
  modelUsageRowValues,
  ModelUsageSink,
  name,
  resolveUsageReportDbDsn,
  sanitizeUsageReportError,
  USAGE_REPORT_DB_ENVIRONMENT,
  type ModelUsageConnection,
  type ModelUsageReporterOptions,
  type ModelUsageRow,
  type ModelUsageWriteBoundary,
  type UsageReportConnectionConfig,
  type UsageReportDbDsn,
} from '../src/model-usage-reporter.ts'
import { USAGE_REPORT_DB_BLOB } from '../src/usage-report-db-blob.ts'
import {
  encodeUsageReportDbBlob,
  renderUsageReportDbBlobModule,
  usageReportDbPayloadFromEnvironment,
} from '../scripts/make-usage-report-blob.mjs'

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-usage-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Fake destination used everywhere except the committed-blob assertions. */
function fakeDsn(overrides: Partial<UsageReportDbDsn> = {}): UsageReportDbDsn {
  return {
    host: 'db.telemetry.example',
    port: 3307,
    user: 'report_writer',
    password: 's3cret-report-pw',
    database: 'dsh_usage_test',
    ...overrides,
  }
}

function fakeBlob(dsn: UsageReportDbDsn = fakeDsn()): string {
  return encodeUsageReportDbBlob(dsn)
}

function usagePolicy(usageReport: boolean): DesktopPolicy {
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked: true,
    managedModels: usageReport,
    requireSso: false,
    trustRoots: [],
    usageReport,
  })
}

// ---------------------------------------------------------------------------
// Session event fixtures
// ---------------------------------------------------------------------------

function session(id: string | null): Session {
  return {
    header: id === null ? { version: 0, createdAt: 0 } : { id, version: 0, createdAt: 0 },
  } as unknown as Session
}

function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq: number,
  time: number,
): Extract<SessionEvent, { type: T }> {
  return { type, data, seq, time } as Extract<SessionEvent, { type: T }>
}

function requestHeader(provider: string, model: string, seq: number, time: number): SessionEvent {
  return event('request/header', {
    header: { config: { provider, model } },
    reason: 'initial',
  } as never, seq, time)
}

function textDelta(text: string, turn: number, step: number, seq: number, time: number): SessionEvent {
  return event('assistant/chunk', {
    turn,
    step,
    chunk: { type: 'text-delta', text },
  } as never, seq, time)
}

const CLASSIFIED_RESPONSE = 'SECRET-RESPONSE api-key sk-000000000000'

const FAKE_GATEWAY_BLOB = encodeModelGatewayBlob({
  baseUrl: 'https://gateway.company.example/v1',
  apiKey: 'fake-gateway-key',
  models: ['DSV4-DSH'],
})

function assistantMessage(
  usage: unknown,
  turn: number,
  step: number,
  seq: number,
  time: number,
  options: { interrupted?: boolean } = {},
): SessionEvent {
  return event('assistant/message', {
    turn,
    step,
    message: {
      id: `message-${String(seq)}`,
      role: 'assistant',
      content: [{ type: 'text', text: CLASSIFIED_RESPONSE }],
      source: { kind: 'model', provider: 'message-provider', model: 'message-model' },
    },
    ...(usage === undefined ? {} : { usage: usage as never }),
    ...options,
  } as never, seq, time)
}

const ATTRIBUTION = {
  userEmail: () => 'user@company.example',
  baseUrlFor: (provider: string) => provider === 'dsh-company-gateway' ? 'https://gateway.company.example/v1' : '',
  clientVersion: '9.9.9-test',
}

// ---------------------------------------------------------------------------
// Blob codec and destination resolution
// ---------------------------------------------------------------------------

describe('usage report database blob codec', () => {
  it('round-trips a fake destination through the generator codec', () => {
    const dsn = fakeDsn()

    expect(decodeUsageReportDbBlob(fakeBlob(dsn))).toEqual(dsn)
    expect(fakeBlob(dsn)).not.toContain('report_writer')
    expect(fakeBlob(dsn)).not.toContain('s3cret-report-pw')
  })

  it('decodes the committed blob to the pinned company destination', () => {
    // Structural assertions only (same posture as the model gateway blob):
    // the host, account, and database names are already public design facts,
    // while the password must never appear anywhere in the repository.
    const dsn = decodeUsageReportDbBlob(USAGE_REPORT_DB_BLOB)

    expect(dsn).toEqual({
      host: '10.173.46.21',
      port: 3306,
      user: 'dsh_report_writer',
      database: 'dsh_usage',
      password: expect.any(String),
    })
    expect(dsn.password.length).toBeGreaterThan(0)
    expect(Object.isFrozen(dsn)).toBe(true)
  })

  it.each([
    ['an empty blob', ''],
    ['non-base64 text', '!!!!!'],
    ['payload that is not JSON', encodeUsageReportDbBlob({ host: 1 } as never)],
    ['payload with a missing field', encodeUsageReportDbBlob({
      host: 'db.example', port: 3306, user: 'u', password: 'p',
    } as never)],
    ['payload with an extra field', encodeUsageReportDbBlob({
      ...fakeDsn(), rootPassword: 'x',
    } as never)],
    ['a non-host host', encodeUsageReportDbBlob(fakeDsn({ host: 'user@host/name' }))],
    ['an out-of-range port', encodeUsageReportDbBlob(fakeDsn({ port: 70_000 }))],
    ['a fractional port', encodeUsageReportDbBlob(fakeDsn({ port: 3306.5 }))],
    ['an empty password', encodeUsageReportDbBlob(fakeDsn({ password: '' }))],
  ])('rejects %s', (_label, blob) => {
    expect(() => decodeUsageReportDbBlob(blob as string)).toThrow(
      'invalid usage report database blob',
    )
  })
})

describe('usage report destination resolution', () => {
  const devModuleUrl = pathToFileURL(join('/workspace', 'dsh-plugin-desktop', 'lib', 'model-usage-reporter.js')).href
  const packagedModuleUrl = pathToFileURL(join(
    '/Applications', 'DSH Desktop.app', 'Contents', 'Resources',
    'app.asar.unpacked', 'lib', 'model-usage-reporter.js',
  )).href

  it('keeps the blob destination in a packaged layout', () => {
    const environment: NodeJS.ProcessEnv = {
      [USAGE_REPORT_DB_ENVIRONMENT.host]: 'override.example',
      [USAGE_REPORT_DB_ENVIRONMENT.user]: 'override_user',
    }

    expect(resolveUsageReportDbDsn(fakeBlob(), environment, packagedModuleUrl)).toEqual(fakeDsn())
  })

  it('honors field-wise overrides in an unpackaged layout only', () => {
    expect(resolveUsageReportDbDsn(
      fakeBlob(),
      {
        [USAGE_REPORT_DB_ENVIRONMENT.host]: 'override.example',
        [USAGE_REPORT_DB_ENVIRONMENT.port]: '3307',
        [USAGE_REPORT_DB_ENVIRONMENT.database]: 'dsh_usage_override',
      },
      devModuleUrl,
    )).toEqual(fakeDsn({ host: 'override.example', database: 'dsh_usage_override' }))
  })

  it('rejects an invalid override combination instead of degrading silently', () => {
    expect(() => resolveUsageReportDbDsn(
      fakeBlob(),
      { [USAGE_REPORT_DB_ENVIRONMENT.port]: 'not-a-port' },
      devModuleUrl,
    )).toThrow('port must be an integer between 1 and 65535')
  })
})

describe('usage report blob generator', () => {
  it('validates the plaintext environment inputs', () => {
    const environment: NodeJS.ProcessEnv = {
      DSH_REPORT_DB_HOST: 'db.telemetry.example',
      DSH_REPORT_DB_PORT: '3306',
      DSH_REPORT_DB_USER: 'report_writer',
      DSH_REPORT_DB_PASSWORD: 's3cret-report-pw',
      DSH_REPORT_DB_DATABASE: 'dsh_usage_test',
      DSH_REPORT_DB_EXTRA: 'ignored',
    }

    // Unknown names are simply never read; the five known ones validate.
    expect(usageReportDbPayloadFromEnvironment(environment)).toEqual(fakeDsn({ port: 3306 }))
    expect(() => usageReportDbPayloadFromEnvironment({})).toThrow('DSH_REPORT_DB_HOST')
    expect(() => usageReportDbPayloadFromEnvironment({
      ...environment,
      DSH_REPORT_DB_PORT: 'not-a-port',
    })).toThrow('DSH_REPORT_DB_PORT must be an integer between 1 and 65535')
    expect(() => usageReportDbPayloadFromEnvironment({
      ...environment,
      DSH_REPORT_DB_PASSWORD: '',
    })).toThrow('DSH_REPORT_DB_PASSWORD')
  })

  it('writes the blob module with no plaintext destination', () => {
    const target = join(temporaryDirectory(), 'usage-report-db-blob.ts')
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/make-usage-report-blob.mjs', import.meta.url)),
      '--out', target,
    ], {
      env: {
        ...process.env,
        DSH_REPORT_DB_HOST: 'db.telemetry.example',
        DSH_REPORT_DB_PORT: '3307',
        DSH_REPORT_DB_USER: 'report_writer',
        DSH_REPORT_DB_PASSWORD: 's3cret-report-pw',
        DSH_REPORT_DB_DATABASE: 'dsh_usage_test',
      },
    })
    expect(result.status).toBe(0)

    const text = readFileSync(target, 'utf8')
    expect(renderUsageReportDbBlobModule(fakeBlob())).toContain('export const USAGE_REPORT_DB_BLOB =')
    expect(text).toContain('export const USAGE_REPORT_DB_BLOB =')
    expect(text).not.toContain('report_writer')
    expect(text).not.toContain('s3cret-report-pw')
    expect(decodeUsageReportDbBlob(
      /USAGE_REPORT_DB_BLOB = ("(?:[^"\\]|\\.)*")/u.exec(text)?.[1]?.replaceAll('\\', '') ?? '',
    )).toEqual(fakeDsn())
  })
})

// ---------------------------------------------------------------------------
// Event projection
// ---------------------------------------------------------------------------

describe('model usage projection', () => {
  it('folds one assembled step into a fully attributed row', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-1')

    expect(projection.sessionEvent(active, requestHeader('dsh-company-gateway', 'DSV4-DSH', 1, 900))).toBeUndefined()
    expect(projection.sessionEvent(active, event('step/start', { turn: 3, step: 2 }, 2, 1_000))).toBeUndefined()
    expect(projection.sessionEvent(active, textDelta('', 3, 2, 3, 1_400))).toBeUndefined()
    expect(projection.sessionEvent(active, textDelta('Hello', 3, 2, 4, 1_800))).toBeUndefined()
    expect(projection.sessionEvent(active, textDelta(' world', 3, 2, 5, 2_600))).toBeUndefined()
    const row = projection.sessionEvent(active, assistantMessage({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      reasoningTokens: 15,
    }, 3, 2, 6, 3_800))

    // Four disjoint buckets; reasoning is an output subset and never added.
    expect(row).toMatchObject({
      userEmail: 'user@company.example',
      provider: 'dsh-company-gateway',
      model: 'DSV4-DSH',
      baseUrl: 'https://gateway.company.example/v1',
      inputTokens: 100,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      outputTokens: 40,
      reasoningTokens: 15,
      totalTokens: 155,
      tokensPerSecond: 20,
      ttftMs: 800,
      latencyMs: 2_800,
      sessionId: 'session-1',
      turn: 3,
      step: 2,
      clientVersion: '9.9.9-test',
    })
    expect(row?.createdAt).toEqual(new Date(3_800))
  })

  it('merges absent optional buckets as null and omits timing without a first token', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-2')

    projection.sessionEvent(active, requestHeader('openai-completions', 'gpt-test', 1, 100))
    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 2, 1_000))
    const row = projection.sessionEvent(active, assistantMessage({
      inputTokens: 7,
      outputTokens: 5,
    }, 1, 1, 3, 2_500))

    expect(row).toMatchObject({
      provider: 'openai-completions',
      model: 'gpt-test',
      baseUrl: '',
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 12,
      tokensPerSecond: null,
      ttftMs: null,
      latencyMs: 1_500,
    })
  })

  it('records interrupted steps because their tokens were consumed', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-3')

    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 1, 1_000))
    projection.sessionEvent(active, textDelta('partial', 1, 1, 2, 1_200))
    const row = projection.sessionEvent(active, assistantMessage({
      inputTokens: 10, outputTokens: 4,
    }, 1, 1, 3, 2_000, { interrupted: true }))

    expect(row).toMatchObject({ sessionId: 'session-3', totalTokens: 14, ttftMs: 200, latencyMs: 1_000 })
  })

  it('skips steps without a reportable usage record', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-4')

    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 1, 1_000))
    expect(projection.sessionEvent(active, assistantMessage(undefined, 1, 1, 2, 2_000))).toBeUndefined()
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: Number.NaN, outputTokens: 1 }, 1, 1, 3, 2_100))).toBeUndefined()
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: -5 }, 1, 1, 4, 2_200))).toBeUndefined()
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 2 }, 1, 1, 5, 2_300))).toMatchObject({ totalTokens: 3 })
  })

  it('deduplicates a defensively repeated (session, turn, step)', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-5')

    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 1, 1_000))
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 1, 2, 1_500))).toBeDefined()
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 1, 3, 1_600))).toBeUndefined()
    projection.sessionEvent(active, event('step/start', { turn: 1, step: 2 }, 4, 2_000))
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 2, 5, 2_500))).toBeDefined()
  })

  it('keeps multiple NULL-session rows coexisting', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const rows: ModelUsageRow[] = []

    // Two distinct sessions without a durable id: the same (turn, step)
    // shape must not deduplicate across them, and both rows carry a NULL
    // session id (SQL UNIQUE keys never collide with NULL).
    for (const active of [session(null), session(null)]) {
      projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 1, 1_000))
      const row = projection.sessionEvent(active, assistantMessage({
        inputTokens: 1, outputTokens: 1,
      }, 1, 1, 2, 1_100))
      expect(row).toBeDefined()
      expect(row?.sessionId).toBeNull()
      rows.push(row as ModelUsageRow)
    }
    expect(rows).toHaveLength(2)
  })

  it('never carries message text into the projected row', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-6')

    projection.sessionEvent(active, requestHeader('p', 'm', 1, 100))
    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 2, 1_000))
    projection.sessionEvent(active, textDelta('visible stream text', 1, 1, 3, 1_100))
    const row = projection.sessionEvent(active, assistantMessage({
      inputTokens: 1, outputTokens: 1,
    }, 1, 1, 4, 1_200))

    const serialized = JSON.stringify(row)
    expect(serialized).not.toContain('SECRET-RESPONSE')
    expect(serialized).not.toContain('visible stream text')
    expect(serialized).not.toContain('message-provider')
    // The row is exactly the token/metadata column set — nothing else.
    expect(Object.keys(row as object).sort()).toEqual([
      'baseUrl',
      'cacheReadTokens',
      'cacheWriteTokens',
      'clientVersion',
      'createdAt',
      'inputTokens',
      'latencyMs',
      'model',
      'outputTokens',
      'provider',
      'reasoningTokens',
      'sessionId',
      'step',
      'tokensPerSecond',
      'totalTokens',
      'ttftMs',
      'turn',
      'userEmail',
    ])
  })

  it('attributes rows without a seen header to empty provider and model', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-7')

    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 1, 1_000))
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 1, 2, 1_100)))
      .toMatchObject({ provider: '', model: '', baseUrl: '' })
  })

  it('releases per-session state on disposal', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-8')

    projection.sessionEvent(active, requestHeader('p', 'm', 1, 100))
    projection.sessionDisposed(active)
    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 2, 1_000))
    expect(projection.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 1, 3, 1_100)))
      .toMatchObject({ provider: '', model: '' })
  })

  it('ignores chunks outside the open step and keeps timing per session separate', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const first = session('session-9')
    const second = session('session-10')

    projection.sessionEvent(first, event('step/start', { turn: 1, step: 1 }, 1, 1_000))
    projection.sessionEvent(second, event('step/start', { turn: 1, step: 1 }, 1, 5_000))
    // A chunk of another session's step must not set this session's boundary.
    projection.sessionEvent(second, textDelta('other', 1, 1, 2, 5_500))
    const row = projection.sessionEvent(first, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 1, 3, 2_000))

    expect(row).toMatchObject({ sessionId: 'session-9', ttftMs: null, latencyMs: 1_000 })
  })

  it('nulls timing when the message does not match the stale open step', () => {
    const projection = new ModelUsageProjection(ATTRIBUTION)
    const active = session('session-11')

    // A step/start whose message never arrives (a missed step/end leaves a
    // stale boundary behind); the next message belongs to another step.
    projection.sessionEvent(active, requestHeader('p', 'm', 1, 100))
    projection.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 2, 1_000))
    projection.sessionEvent(active, textDelta('token', 1, 1, 3, 1_500))
    const row = projection.sessionEvent(active, assistantMessage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
    }, 2, 1, 4, 9_000))

    // Same rejection rule as the session-stats projection (which drops such
    // messages outright): the row survives with its token columns, but the
    // stale step's clock must not leak into ttft/latency/tps.
    expect(row).toMatchObject({
      sessionId: 'session-11',
      turn: 2,
      step: 1,
      inputTokens: 10,
      cacheReadTokens: 2,
      outputTokens: 5,
      totalTokens: 17,
      tokensPerSecond: null,
      ttftMs: null,
      latencyMs: null,
    })
  })
})

// ---------------------------------------------------------------------------
// Queue and write boundary
// ---------------------------------------------------------------------------

interface RecordedQuery { sql: string, values: unknown[] }

function recorderBoundary(options: { failWrites?: number } = {}) {
  const queries: RecordedQuery[] = []
  const connectionConfigs: UsageReportConnectionConfig[] = []
  const ended: boolean[] = []
  let writesLeft = options.failWrites ?? 0
  const boundary: ModelUsageWriteBoundary = {
    async createConnection(config) {
      connectionConfigs.push(config)
      ended.push(false)
      const connection: ModelUsageConnection = {
        async query(sql, values) {
          if (writesLeft > 0) {
            writesLeft -= 1
            throw new Error(`connect ECONNREFUSED ${config.host}:${String(config.port)}`)
          }
          queries.push({ sql, values: [...values] })
        },
        async end() { ended[ended.length - 1] = true },
      }
      return connection
    },
  }
  return { boundary, queries, connectionConfigs, ended }
}

function row(index: number): ModelUsageRow {
  return {
    userEmail: 'user@company.example',
    provider: 'p',
    model: 'm',
    baseUrl: '',
    inputTokens: index,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: 1,
    reasoningTokens: null,
    totalTokens: index + 1,
    tokensPerSecond: null,
    ttftMs: null,
    latencyMs: null,
    sessionId: `session-${String(index)}`,
    turn: 1,
    step: index,
    clientVersion: 'test',
    createdAt: new Date(1_700_000_000_000 + index),
  }
}

/** One-shot gate for holding a write open across synchronous enqueues. */
function createGate(): { promise: Promise<void>, release(): void } {
  let release: () => void = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function fakeClock(start = 0) {
  let now = start
  const pending: Array<{ at: number, run: () => void, cancelled: boolean }> = []
  const fired: number[] = []
  return {
    now: () => now,
    schedule: (delayMs: number, run: () => void) => {
      const task = { at: now + delayMs, run, cancelled: false }
      pending.push(task)
      return () => { task.cancelled = true }
    },
    advance(ms: number): void {
      now += ms
      for (;;) {
        const due = pending.filter(task => !task.cancelled && task.at <= now)
            .sort((a, b) => a.at - b.at)[0]
        if (due === undefined) return
        due.cancelled = true
        fired.push(due.at)
        due.run()
      }
    },
    pendingDelays(): number[] {
      return pending.filter(task => !task.cancelled).map(task => task.at - now)
    },
    firedAt: fired,
  }
}

describe('model usage insert statement shape', () => {
  it('renders one INSERT IGNORE statement with every column', () => {
    const sql = modelUsageInsertSql(3)
    const oneRowPlaceholders = `(${MODEL_USAGE_COLUMNS.map(() => '?').join(', ')})`

    expect(sql).toBe(`INSERT IGNORE INTO \`${MODEL_USAGE_TABLE}\` (`
      + MODEL_USAGE_COLUMNS.map(column => `\`${column}\``).join(', ')
      + `) VALUES ${oneRowPlaceholders}, ${oneRowPlaceholders}, ${oneRowPlaceholders}`)
    expect(sql.match(/\?/gu)).toHaveLength(3 * MODEL_USAGE_COLUMNS.length)
    expect(sql.match(/\((?:\?(?:, \?)*?)\)/gu)).toHaveLength(3)
  })

  it('flattens rows in column order and rejects empty batches', () => {
    const values = modelUsageRowValues(row(7))

    expect(values).toHaveLength(MODEL_USAGE_COLUMNS.length)
    expect(values[0]).toBe('user@company.example')
    expect(values[13]).toBe('session-7')
    expect(values[16]).toBe('test')
    expect(values[17]).toEqual(new Date(1_700_000_000_007))
    expect(() => modelUsageInsertSql(0)).toThrow()
  })
})

describe('model usage sink queue', () => {
  it('drops the oldest rows beyond the limit and counts them', async () => {
    // A gated boundary holds the first write open while the enqueue loop
    // runs, so the overflow drop is fully deterministic.
    const gate = createGate()
    const queries: RecordedQuery[] = []
    const boundary: ModelUsageWriteBoundary = {
      async createConnection() {
        return {
          async query(sql, values) { await gate.promise; queries.push({ sql, values: [...values] }) },
          async end() {},
        }
      },
    }
    const clock = fakeClock()
    const sink = new ModelUsageSink(() => boundary, fakeDsn(), {
      now: clock.now, schedule: clock.schedule,
    })

    // The gated write holds the first 50 rows, so 61 rows beyond the limit
    // overflow the queue itself and drop its 11 oldest rows (50..60).
    const total = MODEL_USAGE_QUEUE_LIMIT_ROWS + 61
    const droppedCount = 11
    for (let index = 0; index < total; index += 1) sink.enqueue(row(index))
    expect(sink.stats()).toMatchObject({ queued: MODEL_USAGE_QUEUE_LIMIT_ROWS, dropped: droppedCount })

    gate.release()
    await new Promise(resolve => { setImmediate(resolve) })
    await new Promise(resolve => { setImmediate(resolve) })

    expect(sink.stats()).toMatchObject({
      queued: 0,
      flushed: total - droppedCount,
      dropped: droppedCount,
    })
    const inputColumn = MODEL_USAGE_COLUMNS.indexOf('input_tokens')
    const flushedIndexes = queries
      .flatMap(query => query.values.filter((_value, position) => position % MODEL_USAGE_COLUMNS.length === inputColumn))
      .map(value => value as number)
    // Rows 50..60 are the dropped ones; everything else was flushed.
    expect(flushedIndexes).toHaveLength(total - droppedCount)
    expect(flushedIndexes).not.toContain(50)
    expect(flushedIndexes).not.toContain(60)
    expect(flushedIndexes).toContain(49)
    expect(flushedIndexes).toContain(total - 1)
  })

  it('flushes on the row threshold without waiting for the interval', async () => {
    const recorder = recorderBoundary()
    const clock = fakeClock()
    const sink = new ModelUsageSink(() => recorder.boundary, fakeDsn(), {
      now: clock.now, schedule: clock.schedule,
    })

    for (let index = 0; index < MODEL_USAGE_FLUSH_THRESHOLD_ROWS - 1; index += 1) sink.enqueue(row(index))
    await new Promise(resolve => { setImmediate(resolve) })
    expect(recorder.queries).toHaveLength(0)

    sink.enqueue(row(MODEL_USAGE_FLUSH_THRESHOLD_ROWS - 1))
    await new Promise(resolve => { setImmediate(resolve) })

    expect(recorder.queries).toHaveLength(1)
    expect(recorder.queries[0]?.values).toHaveLength(MODEL_USAGE_FLUSH_THRESHOLD_ROWS * MODEL_USAGE_COLUMNS.length)
    expect(clock.pendingDelays()).toHaveLength(0)
  })

  it('flushes on the interval trigger for a slow trickle', async () => {
    const recorder = recorderBoundary()
    const clock = fakeClock()
    const sink = new ModelUsageSink(() => recorder.boundary, fakeDsn(), {
      now: clock.now, schedule: clock.schedule,
    })

    sink.enqueue(row(0))
    await new Promise(resolve => { setImmediate(resolve) })
    expect(recorder.queries).toHaveLength(0)
    expect(clock.pendingDelays()).toEqual([MODEL_USAGE_FLUSH_INTERVAL_MS])

    clock.advance(MODEL_USAGE_FLUSH_INTERVAL_MS)
    await new Promise(resolve => { setImmediate(resolve) })

    expect(recorder.queries).toHaveLength(1)
    expect(sink.stats()).toMatchObject({ queued: 0, flushed: 1 })
  })

  it('connects lazily with the configured handshake budget', async () => {
    let created = 0
    const recorder = recorderBoundary()
    const clock = fakeClock()
    const sink = new ModelUsageSink(() => {
      created += 1
      return recorder.boundary
    }, fakeDsn(), { now: clock.now, schedule: clock.schedule })

    expect(created).toBe(0)
    sink.enqueue(row(0))
    expect(created).toBe(0)
    clock.advance(MODEL_USAGE_FLUSH_INTERVAL_MS)
    await new Promise(resolve => { setImmediate(resolve) })

    expect(created).toBe(1)
    expect(recorder.connectionConfigs).toEqual([{
      host: 'db.telemetry.example',
      port: 3307,
      user: 'report_writer',
      password: 's3cret-report-pw',
      database: 'dsh_usage_test',
      connectTimeout: 8_000,
    }])
  })

  it('retries failed writes with a capped doubling backoff', async () => {
    const recorder = recorderBoundary({ failWrites: 2 })
    const clock = fakeClock()
    const infos: string[] = []
    const errors: string[] = []
    const sink = new ModelUsageSink(() => recorder.boundary, fakeDsn(), {
      now: clock.now, schedule: clock.schedule,
      logInfo: message => { infos.push(message) },
      logError: message => { errors.push(message) },
    })

    sink.enqueue(row(0))
    clock.advance(MODEL_USAGE_FLUSH_INTERVAL_MS)
    await new Promise(resolve => { setImmediate(resolve) })

    expect(recorder.queries).toHaveLength(0)
    expect(sink.stats()).toMatchObject({ queued: 1, errors: 1 })
    expect(errors[0]).toContain('connection=failed')
    expect(errors[0]).not.toContain('db.telemetry.example')
    expect(clock.pendingDelays()).toEqual([MODEL_USAGE_RECONNECT_BASE_MS])

    clock.advance(MODEL_USAGE_RECONNECT_BASE_MS)
    await new Promise(resolve => { setImmediate(resolve) })
    expect(recorder.queries).toHaveLength(0)
    expect(sink.stats()).toMatchObject({ errors: 2 })
    expect(clock.pendingDelays()).toEqual([MODEL_USAGE_RECONNECT_BASE_MS * 2])

    clock.advance(MODEL_USAGE_RECONNECT_BASE_MS * 2)
    await new Promise(resolve => { setImmediate(resolve) })
    expect(recorder.queries).toHaveLength(1)
    expect(sink.stats()).toMatchObject({ queued: 0, flushed: 1, errors: 2 })
    expect(infos[0]).toContain('connection=ok')
  })

  it('caps the reconnect backoff', async () => {
    const recorder = recorderBoundary({ failWrites: 10 })
    const clock = fakeClock()
    const sink = new ModelUsageSink(() => recorder.boundary, fakeDsn(), {
      now: clock.now, schedule: clock.schedule,
    })

    sink.enqueue(row(0))
    clock.advance(MODEL_USAGE_FLUSH_INTERVAL_MS)
    await new Promise(resolve => { setImmediate(resolve) })
    const seenDelays: number[] = []
    let guard = 0
    while (clock.pendingDelays().length > 0 && guard < 20) {
      guard += 1
      const delay = clock.pendingDelays()[0] ?? 0
      seenDelays.push(delay)
      clock.advance(delay)
      await new Promise(resolve => { setImmediate(resolve) })
    }

    expect(seenDelays).toEqual([
      MODEL_USAGE_RECONNECT_BASE_MS,
      MODEL_USAGE_RECONNECT_BASE_MS * 2,
      MODEL_USAGE_RECONNECT_BASE_MS * 4,
      MODEL_USAGE_RECONNECT_BASE_MS * 8,
      MODEL_USAGE_RECONNECT_BASE_MS * 16,
      MODEL_USAGE_RECONNECT_BASE_MS * 32,
      MODEL_USAGE_RECONNECT_MAX_MS,
      MODEL_USAGE_RECONNECT_MAX_MS,
      MODEL_USAGE_RECONNECT_MAX_MS,
      MODEL_USAGE_RECONNECT_MAX_MS,
    ])
    expect(guard).toBeLessThan(20)
  })

  it('drains queued rows and ends the connection on dispose', async () => {
    const recorder = recorderBoundary()
    const clock = fakeClock()
    const sink = new ModelUsageSink(() => recorder.boundary, fakeDsn(), {
      now: clock.now, schedule: clock.schedule,
    })

    sink.enqueue(row(0))
    sink.enqueue(row(1))
    await sink.dispose()

    expect(recorder.queries).toHaveLength(1)
    expect(recorder.queries[0]?.values).toHaveLength(2 * MODEL_USAGE_COLUMNS.length)
    expect(recorder.ended).toEqual([true])
    expect(sink.stats()).toMatchObject({ queued: 0, flushed: 2 })

    const droppedBefore = sink.stats().dropped
    sink.enqueue(row(2))
    expect(sink.stats().dropped).toBe(droppedBefore + 1)
    await sink.dispose()
    expect(recorder.queries).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------

describe('usage report error sanitization', () => {
  const dsn = fakeDsn()

  it('strips the account, host, and host:port from access failures', () => {
    const sanitized = sanitizeUsageReportError(
      new Error(`Access denied for user '${dsn.user}'@'${dsn.host}' (using password: YES)`),
      dsn,
    )

    expect(sanitized).not.toContain(dsn.user)
    expect(sanitized).not.toContain(dsn.host)
    expect(sanitized).not.toContain(dsn.password)
    expect(sanitized).toContain('****')
  })

  it('strips host:port from connection failures and the password anywhere', () => {
    const connect = sanitizeUsageReportError(
      new Error(`connect ECONNREFUSED ${dsn.host}:${String(dsn.port)} in 8000ms`),
      dsn,
    )
    const password = sanitizeUsageReportError(
      new Error(`query failed for ${dsn.database} with ${dsn.password}`),
      dsn,
    )

    expect(connect).not.toContain(`${dsn.host}:${String(dsn.port)}`)
    expect(connect).not.toContain(dsn.host)
    expect(password).not.toContain(dsn.password)
    expect(password).not.toContain(dsn.user)
  })

  it('renders non-error causes and still applies the generic secret mask', () => {
    expect(sanitizeUsageReportError('plain failure', dsn)).toBe('plain failure')
    expect(sanitizeUsageReportError(new Error('token sk-abcdefabcdefabcdef'), dsn))
      .not.toContain('sk-abcdefabcdefabcdef')
  })
})

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

interface ReporterHarness {
  readonly logError: ReturnType<typeof vi.fn>
  readonly injections: string[][]
  readonly effects: Array<() => unknown>
  sessionEvent(session: Session, event: SessionEvent): Promise<void>
  sessionDisposed(session: Session): Promise<void>
  dispose(): Promise<void>
}

function reporterHarness(
  options: Partial<ModelUsageReporterOptions> = {},
  runtime: { ssoAccountEmail?: string | undefined } = { ssoAccountEmail: 'user@company.example' },
): { harness: ReporterHarness, recorder: ReturnType<typeof recorderBoundary> } {
  const recorder = recorderBoundary()
  const sessionListeners: Array<(session: Session, event: SessionEvent) => void> = []
  const disposedListeners: Array<(session: Session) => void> = []
  const injections: string[][] = []
  const effects: Array<() => unknown> = []
  const logError = vi.fn()
  const clock = fakeClock()
  const ctx = {
    desktopRuntime: runtime,
    logger: { info: vi.fn(), error: logError },
    on: (event: string, listener: (...args: never[]) => void) => {
      if (event === 'session/event') sessionListeners.push(listener as (session: Session, event: SessionEvent) => void)
      else if (event === 'session/disposed') disposedListeners.push(listener as (session: Session) => void)
      return () => {
        const asEvent = listener as (session: Session, event: SessionEvent) => void
        const asDisposed = listener as (session: Session) => void
        if (event === 'session/event') sessionListeners.splice(sessionListeners.indexOf(asEvent), 1)
        if (event === 'session/disposed') disposedListeners.splice(disposedListeners.indexOf(asDisposed), 1)
      }
    },
    inject: (services: string[], callback: (child: Context) => void) => {
      injections.push(services)
      callback(ctx as unknown as Context)
    },
    effect: (register: () => (() => unknown) | void) => {
      const dispose = register()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
  }

  apply(ctx as unknown as Context, {
    policy: usagePolicy(true),
    dsnBlob: fakeBlob(),
    gatewayBlob: FAKE_GATEWAY_BLOB,
    createWriteBoundary: () => recorder.boundary,
    schedule: clock.schedule,
    now: clock.now,
    logInfo: () => {},
    logError,
    clientVersion: '9.9.9-test',
    ...options,
  })

  return {
    recorder,
    harness: {
      logError,
      injections,
      effects,
      async sessionEvent(active, event) {
        for (const listener of [...sessionListeners]) await listener(active, event)
      },
      async sessionDisposed(active) {
        for (const listener of [...disposedListeners]) await listener(active)
      },
      async dispose() {
        for (const dispose of [...effects].reverse()) await dispose()
      },
    },
  }
}

describe('model usage reporter plugin', () => {
  it('declares the composition identity', () => {
    expect(name).toBe('desktop-model-usage-reporter')
    expect(inject).toEqual(['desktopRuntime'])
  })

  it('stays completely unwired while the policy disables reporting', () => {
    const boundary = vi.fn()
    const { harness } = reporterHarness({ policy: usagePolicy(false), createWriteBoundary: boundary })

    expect(harness.injections).toEqual([])
    expect(harness.effects).toHaveLength(0)
    expect(boundary).not.toHaveBeenCalled()
    expect(harness.logError).not.toHaveBeenCalled()
  })

  it('degrades to offline with one sanitized line on an invalid destination', () => {
    const { harness } = reporterHarness({ dsnBlob: 'not-a-blob!!' })

    expect(harness.injections).toEqual([])
    expect(harness.logError).toHaveBeenCalledOnce()
    expect(String(harness.logError.mock.calls[0])).toContain('stays offline')
    expect(String(harness.logError.mock.calls[0])).not.toContain('db.telemetry.example')
  })

  it('collects, attributes, and flushes rows end to end', async () => {
    const { harness, recorder } = reporterHarness()
    expect(harness.injections).toEqual([['sessions']])
    const active = session('live-session')

    await harness.sessionEvent(active, requestHeader('dsh-company-gateway', 'DSV4-DSH', 1, 900))
    await harness.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 2, 1_000))
    await harness.sessionEvent(active, textDelta('tok', 1, 1, 3, 1_250))
    await harness.sessionEvent(active, assistantMessage({
      inputTokens: 9, outputTokens: 6, cacheReadTokens: 2,
    }, 1, 1, 4, 1_750))
    await harness.dispose()

    expect(recorder.queries).toHaveLength(1)
    const query = recorder.queries[0]
    expect(query?.sql.startsWith('INSERT IGNORE INTO `dsh_model_call_events`')).toBe(true)
    const columns = MODEL_USAGE_COLUMNS
    const byColumn = Object.fromEntries(columns.map((column, index) => [column, query?.values[index]]))
    expect(byColumn).toEqual({
      user_email: 'user@company.example',
      provider: 'dsh-company-gateway',
      model: 'DSV4-DSH',
      base_url: 'https://gateway.company.example/v1',
      input_tokens: 9,
      cache_read_tokens: 2,
      cache_write_tokens: null,
      output_tokens: 6,
      reasoning_tokens: null,
      total_tokens: 17,
      tokens_per_second: 6 * 1_000 / 500,
      ttft_ms: 250,
      latency_ms: 750,
      session_id: 'live-session',
      turn: 1,
      step: 1,
      client_version: '9.9.9-test',
      created_at: new Date(1_750),
    })
    expect(JSON.stringify(query)).not.toContain('SECRET-RESPONSE')
    expect(recorder.ended).toEqual([true])
  })

  it('reports with an empty email when no SSO session exists', async () => {
    const { harness, recorder } = reporterHarness({}, { ssoAccountEmail: undefined })
    const active = session('anonymous-user')

    await harness.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 1, 1_000))
    await harness.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 1, 2, 1_100))
    await harness.dispose()

    expect(recorder.queries[0]?.values[MODEL_USAGE_COLUMNS.indexOf('user_email')]).toBe('')
  })

  it('releases session state on disposal through the firehose', async () => {
    const { harness, recorder } = reporterHarness()
    const active = session('disposed-session')

    await harness.sessionEvent(active, requestHeader('p', 'm', 1, 100))
    await harness.sessionDisposed(active)
    await harness.sessionEvent(active, event('step/start', { turn: 1, step: 1 }, 2, 1_000))
    await harness.sessionEvent(active, assistantMessage({ inputTokens: 1, outputTokens: 1 }, 1, 1, 3, 1_100))
    await harness.dispose()

    expect(recorder.queries[0]?.values[MODEL_USAGE_COLUMNS.indexOf('provider')]).toBe('')
  })
})
