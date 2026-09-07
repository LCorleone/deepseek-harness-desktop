/**
 * Client event telemetry (2026-09-07): the low-frequency collector that
 * reports sso_login / catalog_refresh / plugin_install / boot_verify into
 * `dsh_client_events`.
 *
 * The posture mirrors `model-usage-reporter.spec.ts`: a fake mysql2 boundary
 * (never a real connection), fake clock-free fire-and-forget writes, counter
 * log assertions, and the same privacy red line — detail content never
 * appears in any log line the module emits.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseDesktopPolicy, type DesktopPolicy } from '../src/desktop-policy.ts'
import {
  betaCatalogRefreshEvent,
  betaDeliveredPackageKeys,
  bootVerifyEvent,
  CLIENT_EVENT_COLUMNS,
  CLIENT_EVENTS_TABLE,
  CLIENT_EVENT_TYPES,
  ClientEventCollector,
  ClientEventReporter,
  clientEventInsertSql,
  clientEventRowValues,
  createClientEventCollector,
  pluginInstallEvent,
  stableCatalogRefreshEvent,
  stableManifestEntryCount,
  type BetaCatalogOutcomeView,
  type ClientEventConnection,
  type ClientEventConnectionConfig,
  type ClientEventDbDsn,
  type ClientEventRow,
  type ClientEventWriteBoundary,
} from '../src/client-event-reporter.ts'
import { encodeUsageReportDbBlob } from '../scripts/make-usage-report-blob.mjs'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeDsn(overrides: Partial<ClientEventDbDsn> = {}): ClientEventDbDsn {
  return {
    host: 'db.telemetry.example',
    port: 3307,
    user: 'report_writer',
    password: 's3cret-event-pw',
    database: 'dsh_usage_test',
    ...overrides,
  }
}

function fakeBlob(dsn: ClientEventDbDsn = fakeDsn()): string {
  return encodeUsageReportDbBlob(dsn)
}

function eventPolicy(usageReport: boolean): DesktopPolicy {
  return parseDesktopPolicy({
    agentBrowser: { allowOrigins: [], allowPersistLogin: false, enabled: false },
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

interface RecordedQuery { sql: string, values: unknown[] }

function recorderBoundary(options: { failWrites?: number, failConnects?: number } = {}) {
  const queries: RecordedQuery[] = []
  const connectionConfigs: ClientEventConnectionConfig[] = []
  const ended: boolean[] = []
  let writesLeft = options.failWrites ?? 0
  let connectsLeft = options.failConnects ?? 0
  const boundary: ClientEventWriteBoundary = {
    async createConnection(config) {
      if (connectsLeft > 0) {
        connectsLeft -= 1
        throw new Error(`connect ECONNREFUSED ${config.host}:${String(config.port)}`)
      }
      connectionConfigs.push(config)
      ended.push(false)
      const connection: ClientEventConnection = {
        async query(sql, values) {
          if (writesLeft > 0) {
            writesLeft -= 1
            throw new Error(`write refused for ${config.user}@${config.host}:${String(config.port)}`)
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

/** Drain the fire-and-forget trailing task chain. */
async function settle(...steps: number[]): Promise<void> {
  for (let index = 0; index < Math.max(1, ...steps); index += 1) {
    await new Promise(resolve => { setImmediate(resolve) })
  }
}

function row(overrides: Partial<ClientEventRow> = {}): ClientEventRow {
  return {
    eventType: CLIENT_EVENT_TYPES.bootVerify,
    userEmail: 'user@company.example',
    clientVersion: '9.9.9-test',
    detail: { outcome: 'applied', channel: 'stable' },
    createdAt: new Date(1_700_000_000_000),
    ...overrides,
  }
}

const SECRET_DETAIL = 'sk-000000000000'

// ---------------------------------------------------------------------------
// Statement shape and row flattening
// ---------------------------------------------------------------------------

describe('client event insert statement shape', () => {
  it('renders the single-row INSERT for the provisioned table', () => {
    expect(clientEventInsertSql()).toBe(
      `INSERT INTO \`${CLIENT_EVENTS_TABLE}\` (\`event_type\`, \`user_email\`, \`client_version\`, \`detail\`, \`created_at\`) VALUES (?, ?, ?, ?, ?)`,
    )
    expect(CLIENT_EVENT_COLUMNS).toEqual(['event_type', 'user_email', 'client_version', 'detail', 'created_at'])
    expect(Object.values(CLIENT_EVENT_TYPES)).toEqual(['sso_login', 'catalog_refresh', 'plugin_install', 'boot_verify'])
  })

  it('flattens the row in column order with the detail serialized', () => {
    const values = clientEventRowValues(row())
    expect(values).toHaveLength(5)
    expect(values[0]).toBe('boot_verify')
    expect(values[1]).toBe('user@company.example')
    expect(values[2]).toBe('9.9.9-test')
    expect(JSON.parse(values[3] as string)).toEqual({ outcome: 'applied', channel: 'stable' })
    expect(values[4]).toEqual(new Date(1_700_000_000_000))
    expect(clientEventRowValues(row({ userEmail: null, clientVersion: null })))
      .toEqual(['boot_verify', null, null, expect.any(String), expect.any(Date)])
  })
})

// ---------------------------------------------------------------------------
// Reporter: fire-and-forget, drop-on-failure, never throw
// ---------------------------------------------------------------------------

describe('client event reporter', () => {
  it('writes each event as one statement on one lazy connection', async () => {
    const recorder = recorderBoundary()
    const infos: string[] = []
    const reporter = new ClientEventReporter(() => recorder.boundary, fakeDsn(), {
      logInfo: message => { infos.push(message) },
    })

    reporter.record(row())
    expect(recorder.queries).toHaveLength(0)
    await settle()

    reporter.record(row({ eventType: CLIENT_EVENT_TYPES.ssoLogin, detail: { result: 'failure', reason: 'no corporate email', mode: 'silent' } }))
    await settle()

    expect(recorder.connectionConfigs).toHaveLength(1)
    expect(recorder.queries).toHaveLength(2)
    expect(recorder.queries[1]?.values[3]).toBe('{"result":"failure","reason":"no corporate email","mode":"silent"}')
    expect(reporter.stats()).toEqual({ recorded: 2, written: 2, dropped: 0, errors: 0, connected: true })
    // Counter logs only: type plus counts, never the detail content.
    expect(infos).toHaveLength(2)
    expect(infos[0]).toContain('type=boot_verify')
    expect(infos.join('\n')).not.toContain('applied')
  })

  it('drops a failed write, ends the connection, and lets the next event retry', async () => {
    const recorder = recorderBoundary({ failWrites: 1 })
    const errors: string[] = []
    const reporter = new ClientEventReporter(() => recorder.boundary, fakeDsn(), {
      logError: message => { errors.push(message) },
    })

    reporter.record(row())
    await settle(3)

    expect(reporter.stats()).toMatchObject({ recorded: 1, written: 0, dropped: 1, errors: 1, connected: false })
    expect(recorder.ended).toEqual([true])
    expect(errors).toHaveLength(1)
    // The failure line carries the event type and counters but no DSN
    // fragments (account, host, password) and no detail content.
    expect(errors[0]).toContain('type=boot_verify')
    expect(errors[0]).not.toContain('s3cret-event-pw')
    expect(errors[0]).not.toContain('report_writer')
    expect(errors[0]).not.toContain('db.telemetry.example')

    // The dropped row is gone forever (no queue, no retry of the row), but
    // the NEXT event dials a fresh connection and succeeds.
    reporter.record(row({ eventType: CLIENT_EVENT_TYPES.catalogRefresh }))
    await settle(3)

    expect(recorder.connectionConfigs).toHaveLength(2)
    expect(recorder.queries).toHaveLength(1)
    expect(reporter.stats()).toEqual({ recorded: 2, written: 1, dropped: 1, errors: 1, connected: true })
  })

  it('degrades a failed connect to a counted drop without throwing', async () => {
    const recorder = recorderBoundary({ failConnects: 1 })
    const errors: string[] = []
    const reporter = new ClientEventReporter(() => recorder.boundary, fakeDsn(), {
      logError: message => { errors.push(message) },
    })

    expect(() => reporter.record(row())).not.toThrow()
    await settle(3)

    expect(reporter.stats()).toMatchObject({ recorded: 1, written: 0, dropped: 1, errors: 1, connected: false })
    expect(errors[0]).not.toContain('s3cret-event-pw')
  })

  it('never throws from a rejecting boundary factory', async () => {
    const errors: string[] = []
    const reporter = new ClientEventReporter(
      () => { throw new Error(`factory exploded for ${fakeDsn().password}`) },
      fakeDsn(),
      { logError: message => { errors.push(message) } },
    )

    expect(() => reporter.record(row())).not.toThrow()
    await settle(3)
    expect(reporter.stats()).toMatchObject({ dropped: 1, errors: 1 })
    expect(errors[0]).not.toContain('s3cret-event-pw')
  })

  it('counts records after disposal as drops', async () => {
    const recorder = recorderBoundary()
    const reporter = new ClientEventReporter(() => recorder.boundary, fakeDsn())

    await reporter.dispose()
    reporter.record(row())
    await settle()

    expect(reporter.stats()).toMatchObject({ recorded: 0, written: 0, dropped: 1 })
    expect(recorder.queries).toHaveLength(0)
  })

  it('ends its connection on dispose', async () => {
    const recorder = recorderBoundary()
    const reporter = new ClientEventReporter(() => recorder.boundary, fakeDsn())
    reporter.record(row())
    await settle()
    expect(reporter.stats().connected).toBe(true)

    await reporter.dispose()
    expect(reporter.stats().connected).toBe(false)
    expect(recorder.ended).toEqual([true])
  })
})

// ---------------------------------------------------------------------------
// Collector: typed facade with attribution
// ---------------------------------------------------------------------------

describe('client event collector', () => {
  function collectorWith(recorder: ReturnType<typeof recorderBoundary>) {
    const rows: ClientEventRow[] = []
    const boundary: ClientEventWriteBoundary = {
      async createConnection(config) {
        const connection = await recorder.boundary.createConnection(config)
        return {
          query: async (sql, values) => {
            rows.push({
              eventType: values[0] as string,
              userEmail: values[1] as string | null,
              clientVersion: values[2] as string | null,
              detail: JSON.parse(values[3] as string) as object,
              createdAt: values[4] as Date,
            })
            return await connection.query(sql, values)
          },
          end: () => connection.end(),
        }
      },
    }
    return {
      rows,
      collector: new ClientEventCollector(
        new ClientEventReporter(() => boundary, fakeDsn()),
        { userEmail: () => 'user@company.example', clientVersion: '9.9.9-test' },
        { now: () => 1_700_000_000_000 },
      ),
    }
  }

  it('stamps event type, attribution, and time on every event kind', async () => {
    const { rows, collector } = collectorWith(recorderBoundary())

    collector.ssoLogin({ result: 'success', mode: 'silent' })
    collector.ssoLogin({ result: 'failure', reason: 'the portal rejected the token', mode: 'browser' })
    collector.catalogRefresh({ outcome: 'applied', sequence: 16, entries: 3, channel: 'stable' })
    collector.catalogRefresh({ outcome: 'not-a-tester', channel: 'beta-overlay' })
    collector.pluginInstall({ packageName: 'corp-plugin', version: '1.0.0', channel: 'stable', outcome: 'installed' })
    collector.bootVerify({ rejected: [{ packageName: 'corp-plugin', code: 'revoked' }], loaded: 4 })
    await settle()

    expect(rows.map(row => row.eventType)).toEqual([
      'sso_login', 'sso_login', 'catalog_refresh', 'catalog_refresh', 'plugin_install', 'boot_verify',
    ])
    for (const captured of rows) {
      expect(captured.userEmail).toBe('user@company.example')
      expect(captured.clientVersion).toBe('9.9.9-test')
      expect(captured.createdAt).toEqual(new Date(1_700_000_000_000))
    }
    expect(rows[1]?.detail).toEqual({ result: 'failure', reason: 'the portal rejected the token', mode: 'browser' })
  })

  it('carries a null email when no SSO session exists', async () => {
    const recorder = recorderBoundary()
    const rows: ClientEventRow[] = []
    const boundary: ClientEventWriteBoundary = {
      async createConnection(config) {
        const connection = await recorder.boundary.createConnection(config)
        return {
          query: async (sql, values) => {
            rows.push(values[1] as string | null as never as ClientEventRow)
            return await connection.query(sql, values)
          },
          end: () => connection.end(),
        }
      },
    }
    const collector = new ClientEventCollector(
      new ClientEventReporter(() => boundary, fakeDsn()),
      { userEmail: () => null, clientVersion: '9.9.9-test' },
    )
    collector.ssoLogin({ result: 'failure', mode: 'silent', reason: 'no identity' })
    await settle()
    expect(rows).toEqual([null])
  })
})

// ---------------------------------------------------------------------------
// Detail projections
// ---------------------------------------------------------------------------

describe('stable catalog refresh projection', () => {
  const manifestText = JSON.stringify({ manifestVersion: '1.0.0', sequence: 16, packages: [{}, {}, {}] })

  it('projects an applied stable catalog with sequence and entries', () => {
    expect(stableCatalogRefreshEvent(
      { manifestTrusted: true, manifestSequence: 16, manifestFailureCode: undefined },
      manifestText,
    )).toEqual({ outcome: 'applied', sequence: 16, entries: 3, channel: 'stable' })
  })

  it('omits the entry count when the manifest text is absent or unparseable', () => {
    expect(stableCatalogRefreshEvent(
      { manifestTrusted: true, manifestSequence: 7, manifestFailureCode: undefined },
      undefined,
    )).toEqual({ outcome: 'applied', sequence: 7, channel: 'stable' })
    expect(stableCatalogRefreshEvent(
      { manifestTrusted: true, manifestSequence: 7, manifestFailureCode: undefined },
      'not json',
    )).toEqual({ outcome: 'applied', sequence: 7, channel: 'stable' })
    expect(stableManifestEntryCount('{"packages": "nope"}')).toBeUndefined()
    expect(stableManifestEntryCount(new TextEncoder().encode('{"packages":[{},{}]}'))).toBe(2)
  })

  it('projects every stable failure code', () => {
    for (const code of ['manifest-missing', 'bad-signature', 'stale-sequence', 'expired'] as const) {
      expect(stableCatalogRefreshEvent(
        { manifestTrusted: false, manifestSequence: undefined, manifestFailureCode: code },
        manifestText,
      )).toEqual({ outcome: code, channel: 'stable' })
    }
    // A trusted-false decision without a recorded code fails closed to
    // manifest-missing rather than inventing an outcome.
    expect(stableCatalogRefreshEvent(
      { manifestTrusted: false, manifestSequence: undefined, manifestFailureCode: undefined },
      manifestText,
    )).toEqual({ outcome: 'manifest-missing', channel: 'stable' })
  })

  it('reports nothing for unlocked boots', () => {
    expect(stableCatalogRefreshEvent(undefined, manifestText)).toBeUndefined()
  })
})

describe('beta catalog refresh projection', () => {
  it('projects the applied overlay with sequence and entries', () => {
    expect(betaCatalogRefreshEvent({ outcome: 'applied', sequence: 43, entries: 2 }))
      .toEqual({ outcome: 'applied', sequence: 43, entries: 2, channel: 'beta-overlay' })
  })

  it('projects every ignored reason category', () => {
    const reasons: BetaCatalogOutcomeView[] = [
      { outcome: 'fetch-failed' },
      { outcome: 'unverified' },
      { outcome: 'stale-sequence' },
      { outcome: 'no-sso-identity' },
      { outcome: 'not-a-tester' },
    ]
    for (const reason of reasons) {
      expect(betaCatalogRefreshEvent(reason)).toEqual({ outcome: reason.outcome, channel: 'beta-overlay' })
    }
  })
})

describe('boot verify projection', () => {
  it('stays silent for healthy and unlocked boots', () => {
    expect(bootVerifyEvent({ allowed: [{}, {}], rejected: [] })).toBeUndefined()
    expect(bootVerifyEvent(undefined)).toBeUndefined()
  })

  it('projects refusal codes and the loaded count', () => {
    expect(bootVerifyEvent({
      allowed: [{}, {}, {}],
      rejected: [
        { packageName: 'corp-plugin', code: 'revoked' },
        { packageName: 'other-plugin', code: 'not-pinned-newer-pinned' },
      ],
    })).toEqual({
      rejected: [
        { packageName: 'corp-plugin', code: 'revoked' },
        { packageName: 'other-plugin', code: 'not-pinned-newer-pinned' },
      ],
      loaded: 3,
    })
  })
})

describe('plugin install projection', () => {
  const stableText = JSON.stringify({
    packages: [{ packageName: 'corp-plugin', version: '1.0.0' }],
  })
  const betaKeys = betaDeliveredPackageKeys(
    [
      { packageName: 'corp-plugin', version: '2.0.0' },
      { packageName: 'corp-plugin', version: '1.0.0' },
    ],
    stableText,
  )

  it('attributes beta only to overlay pins the stable manifest does not carry', () => {
    expect(betaKeys).toBeInstanceOf(Set)
    expect([...betaKeys ?? []]).toEqual(['corp-plugin@2.0.0'])
    expect(pluginInstallEvent(
      { packageName: 'corp-plugin', version: '2.0.0', outcome: 'installed' },
      betaKeys,
    )).toMatchObject({ channel: 'beta', outcome: 'installed' })
    // The post-promote steady state: the same pin exists in stable, so the
    // overlay changes nothing — the install is a stable delivery.
    expect(pluginInstallEvent(
      { packageName: 'corp-plugin', version: '1.0.0', outcome: 'updated-in-place' },
      betaKeys,
    )).toMatchObject({ channel: 'stable', outcome: 'updated-in-place' })
    // Without an overlay everything is stable.
    expect(pluginInstallEvent(
      { packageName: 'corp-plugin', version: '2.0.0', outcome: 'rolled-back' },
      undefined,
    )).toMatchObject({ channel: 'stable', outcome: 'rolled-back' })
  })

  it('bounds the failure reason and strips control characters', () => {
    const detail = pluginInstallEvent({
      packageName: 'corp-plugin',
      version: '1.0.0',
      outcome: 'failed',
      reasonCode: 'operation-failed',
      reason: `boom\n${SECRET_DETAIL} ${'x'.repeat(400)}`,
    }, undefined)
    expect(detail.reasonCode).toBe('operation-failed')
    expect(detail.reason).not.toContain('\n')
    expect(detail.reason!.length).toBeLessThanOrEqual(200)
    // The whole detail stays categorical metadata.
    expect(JSON.stringify(detail)).not.toContain(SECRET_DETAIL)
  })

  it('keeps every outcome vocabulary member representable', () => {
    for (const outcome of ['installed', 'updated-in-place', 'rolled-back', 'failed'] as const) {
      expect(pluginInstallEvent({ packageName: 'p', version: '1.0.0', outcome }, undefined).outcome).toBe(outcome)
    }
  })

  it('returns no beta keys when the overlay is empty or fully promoted', () => {
    expect(betaDeliveredPackageKeys(undefined, stableText)).toBeUndefined()
    expect(betaDeliveredPackageKeys([], stableText)).toBeUndefined()
    expect(betaDeliveredPackageKeys(
      [{ packageName: 'corp-plugin', version: '1.0.0' }],
      stableText,
    )).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Desktop wiring and degradation
// ---------------------------------------------------------------------------

describe('client event collector factory', () => {
  it('stays completely offline under a usageReport:false policy', () => {
    const logError = vi.fn()
    // Even an invalid blob must not be decoded under a false policy.
    expect(createClientEventCollector({
      policy: eventPolicy(false),
      dsnBlob: 'not-a-blob',
      logError,
    })).toBeUndefined()
    expect(logError).not.toHaveBeenCalled()
  })

  it('degrades an invalid destination to offline with one sanitized line', () => {
    const logError = vi.fn()
    expect(createClientEventCollector({
      policy: eventPolicy(true),
      dsnBlob: 'not-a-blob',
      logError,
    })).toBeUndefined()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(String(logError.mock.calls[0])).toContain('client event reporting stays offline')
  })

  it('wires a working collector under an enabling policy', async () => {
    const recorder = recorderBoundary()
    const collector = createClientEventCollector({
      policy: eventPolicy(true),
      dsnBlob: fakeBlob(),
      clientVersion: '9.9.9-test',
      userEmail: () => 'user@company.example',
      createWriteBoundary: () => recorder.boundary,
    })
    expect(collector).toBeInstanceOf(ClientEventCollector)

    collector?.ssoLogin({ result: 'success', mode: 'browser' })
    await settle()

    expect(recorder.queries).toHaveLength(1)
    expect(recorder.queries[0]?.values[0]).toBe('sso_login')
    expect(recorder.queries[0]?.values[1]).toBe('user@company.example')
    await collector?.dispose()
  })

  it('stamps the real client version from the package manifest when unset', async () => {
    const recorder = recorderBoundary()
    const collector = createClientEventCollector({
      policy: eventPolicy(true),
      dsnBlob: fakeBlob(),
      createWriteBoundary: () => recorder.boundary,
    })
    expect(collector).toBeInstanceOf(ClientEventCollector)

    collector?.bootVerify({ rejected: [{ packageName: 'p', code: 'other' }], loaded: 0 })
    await settle()

    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(recorder.queries[0]?.values[2]).toBe(manifest.version)
    await collector?.dispose()
  })
})
