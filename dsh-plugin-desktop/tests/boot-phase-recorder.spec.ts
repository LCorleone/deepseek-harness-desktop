/**
 * Boot-phase telemetry (#042, Phase 1): the shape contract of `boot_phase`
 * client events — the closed phase vocabulary the boot chain anchors on and
 * the numeric fields a fleet dashboard subtracts against — plus the
 * recorder mechanics (process-start origin, buffered attach, duration
 * stamping) and the recorder↔collector composition invariant behind the
 * b97 `process_start` postmortem. Headless by construction: no window, no
 * Electron import.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BOOT_PHASES,
  bootPhaseEvent,
  CLIENT_EVENT_TYPES,
  createClientEventCollector,
  type BootPhase,
  type ClientEventConnectionConfig,
  type ClientEventDbDsn,
  type ClientEventWriteBoundary,
} from '../src/client-event-reporter.ts'
import { createBootPhaseRecorder } from '../src/boot-phase-recorder.ts'
import { parseDesktopPolicy, type DesktopPolicy } from '../src/desktop-policy.ts'
import { encodeUsageReportDbBlob } from '../scripts/make-usage-report-blob.mjs'

/** The Phase-1 instrumentation set — every anchor the main boot chain emits. */
const EXPECTED_PHASES: readonly BootPhase[] = [
  'process_start',
  'boot_verify_start',
  'boot_verify_end',
  'gate_shown',
  'disclaimer_agreed',
  'profile_boot_start',
  'profile_boot_end',
  'host_composed',
  'window_ready',
  'python_check',
  'catalog_fetch_start',
  'catalog_fetch_end',
]

describe('boot_phase event vocabulary', () => {
  it('pins the event type and the closed phase list', () => {
    expect(CLIENT_EVENT_TYPES.bootPhase).toBe('boot_phase')
    expect([...BOOT_PHASES]).toEqual(EXPECTED_PHASES)
  })

  it('projects a point anchor without durMs and a stretch anchor with it', () => {
    expect(bootPhaseEvent('gate_shown', 5_123)).toEqual({ phase: 'gate_shown', elapsedMs: 5_123 })
    expect(bootPhaseEvent('boot_verify_end', 9_001, 3_879)).toEqual({
      phase: 'boot_verify_end',
      elapsedMs: 9_001,
      durMs: 3_879,
    })
  })

  it('keeps every phase name inside the vocabulary and both fields numeric', () => {
    for (const phase of EXPECTED_PHASES) {
      const point = bootPhaseEvent(phase, 12_345)
      expect(Object.keys(point).sort()).toEqual(['elapsedMs', 'phase'])
      expect(point.phase).toBe(phase)
      expect(typeof point.elapsedMs).toBe('number')
      expect(Number.isInteger(point.elapsedMs)).toBe(true)
      expect(point.elapsedMs).toBeGreaterThanOrEqual(0)

      const stretch = bootPhaseEvent(phase, 12_345, 678)
      expect(Object.keys(stretch).sort()).toEqual(['durMs', 'elapsedMs', 'phase'])
      expect(typeof stretch.durMs).toBe('number')
      expect(Number.isInteger(stretch.durMs)).toBe(true)
      expect(stretch.durMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('degrades non-finite or negative readings to 0 instead of throwing', () => {
    expect(bootPhaseEvent('host_composed', Number.NaN).elapsedMs).toBe(0)
    expect(bootPhaseEvent('host_composed', -5).elapsedMs).toBe(0)
    expect(bootPhaseEvent('host_composed', Number.POSITIVE_INFINITY, -1)).toEqual({
      phase: 'host_composed',
      elapsedMs: 0,
      durMs: 0,
    })
  })

  it('rounds fractional milliseconds to whole numbers', () => {
    expect(bootPhaseEvent('python_check', 1_234.6, 789.4)).toEqual({
      phase: 'python_check',
      elapsedMs: 1_235,
      durMs: 789,
    })
  })
})

describe('boot phase recorder', () => {
  /** Deterministic clock: an injectable cursor over epoch milliseconds. */
  function fakeClock(startAt: number) {
    let at = startAt
    return {
      now: () => at,
      advance: (ms: number) => { at += ms },
    }
  }

  it('counts elapsedMs from the process-start origin, not recorder creation', () => {
    const clock = fakeClock(1_700_000_000_000)
    const recorder = createBootPhaseRecorder({ now: clock.now, originMs: 1_700_000_000_000 - 2_500 })
    const sink = vi.fn()
    recorder.attach(sink)

    recorder.emit('process_start')

    expect(sink).toHaveBeenCalledWith({ phase: 'process_start', elapsedMs: 2_500 })
  })

  it('buffers anchors that fire before the sink exists and flushes them in order', () => {
    const clock = fakeClock(1_700_000_000_000)
    const recorder = createBootPhaseRecorder({ now: clock.now, originMs: 1_699_999_999_000 })
    recorder.emit('process_start')
    clock.advance(4_000)
    recorder.emit('gate_shown')

    const sink = vi.fn()
    recorder.attach(sink)
    clock.advance(1_000)
    recorder.emit('disclaimer_agreed')

    expect(sink.mock.calls.map(([detail]) => detail)).toEqual([
      { phase: 'process_start', elapsedMs: 1_000 },
      { phase: 'gate_shown', elapsedMs: 5_000 },
      { phase: 'disclaimer_agreed', elapsedMs: 6_000 },
    ])
  })

  it('stamps durMs from the epoch a start anchor returned', () => {
    const clock = fakeClock(1_700_000_000_000)
    const recorder = createBootPhaseRecorder({ now: clock.now, originMs: 1_700_000_000_000 })
    const sink = vi.fn()
    recorder.attach(sink)

    const startedAt = recorder.emit('catalog_fetch_start')
    clock.advance(9_012)
    recorder.emit('catalog_fetch_end', startedAt)

    expect(sink).toHaveBeenLastCalledWith({
      phase: 'catalog_fetch_end',
      elapsedMs: 9_012,
      durMs: 9_012,
    })
  })

  it('measures a single-anchor duration from now() without emitting a start row', () => {
    const clock = fakeClock(1_700_000_000_000)
    const recorder = createBootPhaseRecorder({ now: clock.now, originMs: 1_700_000_000_000 })
    const sink = vi.fn()
    recorder.attach(sink)

    const pythonCheckStartedAt = recorder.now()
    clock.advance(3_200)
    recorder.emit('python_check', pythonCheckStartedAt)

    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith({ phase: 'python_check', elapsedMs: 3_200, durMs: 3_200 })
  })

  it('never throws when no sink is ever attached', () => {
    const recorder = createBootPhaseRecorder({ originMs: 0 })
    expect(() => {
      recorder.emit('process_start')
      recorder.emit('window_ready')
    }).not.toThrow()
  })
})

describe('buffered flush and collector attribution (the process_start postmortem)', () => {
  /** Deterministic clock: an injectable cursor over epoch milliseconds. */
  function fakeClock(startAt: number) {
    let at = startAt
    return {
      now: () => at,
      advance: (ms: number) => { at += ms },
    }
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
      pluginResetOnVersionChange: false,
      requireSso: false,
      trustRoots: [],
      usageReport,
    })
  }

  function fakeDsn(): ClientEventDbDsn {
    return { host: 'db.telemetry.example', port: 3307, user: 'report_writer', password: 'pw', database: 'dsh_usage_test' }
  }

  /** Rows the reporter wrote, in write order: [userEmail, detail]. */
  interface RecordedRow { userEmail: unknown, detail: { phase: BootPhase, elapsedMs: number, durMs?: number } }
  function recordingBoundary(): { boundary: ClientEventWriteBoundary, rows: RecordedRow[] } {
    const rows: RecordedRow[] = []
    const boundary: ClientEventWriteBoundary = {
      async createConnection(_config: ClientEventConnectionConfig) {
        return {
          async query(_sql, values) {
            rows.push({ userEmail: values[1], detail: JSON.parse(values[3] as string) })
          },
          async end() {},
        }
      },
    }
    return { boundary, rows }
  }

  /** Drain the fire-and-forget trailing write chain. */
  async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>(resolve => { setImmediate(resolve) })
    }
  }

  it('reproduces the b97 symptom: a flush before the session exists lands process_start unattributed', async () => {
    // The production shape: the collector stamps user_email from the live SSO
    // session at emit time, and process_start anchors fire before any session
    // exists. Flushing at collector creation therefore landed the row with a
    // NULL identity — present in the table, invisible to every email-keyed
    // fleet view, which is exactly how "process_start went missing on both
    // julu boots" looked from the dashboard.
    let sessionEmail: string | null = null
    const { boundary, rows } = recordingBoundary()
    const collector = createClientEventCollector({
      policy: eventPolicy(true),
      dsnBlob: encodeUsageReportDbBlob(fakeDsn()),
      clientVersion: '9.9.9-test',
      userEmail: () => sessionEmail,
      createWriteBoundary: () => boundary,
    })
    expect(collector).toBeDefined()

    const clock = fakeClock(1_700_000_000_000)
    const recorder = createBootPhaseRecorder({ now: clock.now, originMs: 1_699_999_999_000 })
    recorder.emit('process_start')
    // The sink attaches while no SSO session exists (collector creation).
    recorder.attach(detail => { collector?.bootPhase(detail) })
    // The session settles only later in the boot.
    sessionEmail = 'julu@company.example'
    clock.advance(5_000)
    recorder.emit('disclaimer_agreed')

    await settle()

    expect(rows.map(row => row.detail.phase)).toEqual(['process_start', 'disclaimer_agreed'])
    expect(rows[0]?.userEmail).toBeNull()
    expect(rows[1]?.userEmail).toBe('julu@company.example')
  })

  it('stamps the buffered process_start with the boot identity when the sink attaches after the session settles', async () => {
    // The fixed wiring: the recorder buffers until the boot-phase sink
    // attaches AFTER the SSO gate, so the flushed anchors carry the same
    // user_email as every later row of the boot and identity-keyed fleet
    // views stay whole. elapsedMs still counts from the process-start
    // origin, not the (later) flush moment.
    let sessionEmail: string | null = null
    const { boundary, rows } = recordingBoundary()
    const collector = createClientEventCollector({
      policy: eventPolicy(true),
      dsnBlob: encodeUsageReportDbBlob(fakeDsn()),
      clientVersion: '9.9.9-test',
      userEmail: () => sessionEmail,
      createWriteBoundary: () => boundary,
    })
    expect(collector).toBeDefined()

    const clock = fakeClock(1_700_000_000_000)
    const recorder = createBootPhaseRecorder({ now: clock.now, originMs: 1_699_999_999_000 })
    recorder.emit('process_start')
    clock.advance(3_500)
    // The session settles; only then does the sink attach and the buffer flush.
    sessionEmail = 'julu@company.example'
    recorder.attach(detail => { collector?.bootPhase(detail) })
    clock.advance(1_000)
    recorder.emit('disclaimer_agreed')

    await settle()

    expect(rows.map(row => row.detail.phase)).toEqual(['process_start', 'disclaimer_agreed'])
    expect(rows[0]).toEqual({ userEmail: 'julu@company.example', detail: { phase: 'process_start', elapsedMs: 1_000 } })
    expect(rows[1]?.userEmail).toBe('julu@company.example')
  })
})
