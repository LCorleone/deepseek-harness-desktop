import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISCLAIMER_ACK_FILENAME,
  disclaimerAckPath,
  needsDisclaimer,
  parseDisclaimerAck,
  readDisclaimerAck,
  runDisclaimerGate,
  writeDisclaimerAck,
  type DisclaimerAck,
  type DisclaimerCurrent,
} from '../src/disclaimer-gate.ts'

const CURRENT: DisclaimerCurrent = { clientVersion: '0.4.184', textHash: 'a'.repeat(64) }
const ACKED: DisclaimerAck = { ...CURRENT, acknowledgedAt: '2026-09-07T12:00:00.000Z' }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Fresh private tmp dir registered for afterEach cleanup. */
function tmpUserDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-disclaimer-gate-'))
  roots.push(root)
  return root
}

// ---------------------------------------------------------------------------
// Trigger judgment (pure)
// ---------------------------------------------------------------------------

describe('needsDisclaimer', () => {
  it('prompts when no acknowledgment exists (fresh install)', () => {
    expect(needsDisclaimer(CURRENT, undefined)).toBe(true)
  })

  it('stays quiet when version and text hash both match (everyday boot)', () => {
    expect(needsDisclaimer(CURRENT, ACKED)).toBe(false)
  })

  it('prompts again when the client version changed (update)', () => {
    expect(needsDisclaimer(CURRENT, { ...ACKED, clientVersion: '0.4.183' })).toBe(true)
  })

  it('prompts again when the statement hash changed (text revision)', () => {
    expect(needsDisclaimer(CURRENT, { ...ACKED, textHash: 'b'.repeat(64) })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Ack document: strict parse + disk round-trip
// ---------------------------------------------------------------------------

describe('disclaimer ack document', () => {
  it('parses the exact three-field shape and tolerates extra keys', () => {
    expect(parseDisclaimerAck(JSON.stringify(ACKED))).toEqual(ACKED)
    expect(parseDisclaimerAck(JSON.stringify({ ...ACKED, futureField: 1 }))).toEqual(ACKED)
  })

  it('rejects every malformed document as "not acknowledged"', () => {
    for (const bad of [
      '',
      'not json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ clientVersion: 1, textHash: 'a', acknowledgedAt: 'b' }),
      JSON.stringify({ clientVersion: 'a', textHash: null, acknowledgedAt: 'b' }),
      JSON.stringify({ clientVersion: 'a', textHash: 'b' }),
    ]) {
      expect(parseDisclaimerAck(bad), bad).toBeUndefined()
    }
  })

  it('reads a missing or unreadable file as "not acknowledged"', () => {
    const dir = tmpUserDataDir()
    expect(readDisclaimerAck(dir)).toBeUndefined()
    writeFileSync(disclaimerAckPath(dir), 'garbage')
    expect(readDisclaimerAck(dir)).toBeUndefined()
  })

  it('writes user-private pretty JSON that reads back identically', async () => {
    const dir = tmpUserDataDir()
    const now = new Date('2026-09-07T12:34:56.789Z')
    const ack = await writeDisclaimerAck(dir, CURRENT, () => now)
    expect(ack).toEqual({ ...CURRENT, acknowledgedAt: now.toISOString() })
    expect(readDisclaimerAck(dir)).toEqual(ack)
    const text = readFileSync(disclaimerAckPath(dir), 'utf8')
    expect(text).toBe(`${JSON.stringify(ack, undefined, 2)}\n`)
    // User-private state file, the install-recovery state discipline: no
    // group/other access regardless of the process umask's owner bits.
    expect(statSync(disclaimerAckPath(dir)).mode & 0o077).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Gate orchestration (fake window injection — the §6.2 integration surface)
// ---------------------------------------------------------------------------

/** Scriptable stand-in for DesktopDisclaimerWindow. */
function fakeWindow(decision: 'agree' | 'disagree'): {
  readonly run: () => Promise<'agree' | 'disagree'>
} {
  return { run: async () => decision }
}

/** Everything the gate observes, with defaults for the quiet path. */
function gateHarness(overrides: Partial<Parameters<typeof runDisclaimerGate>[1]> = {}) {
  const calls = {
    opened: 0,
    decisions: [] as ('agree' | 'disagree')[],
    quit: 0,
    logs: [] as string[],
  }
  const options = {
    userDataDir: tmpUserDataDir(),
    openWindow: () => {
      calls.opened += 1
      return { run: async () => 'agree' as const }
    },
    reportDecision: (decision: 'agree' | 'disagree') => { calls.decisions.push(decision) },
    quit: vi.fn(async () => { calls.quit += 1 }),
    logError: (message: string) => { calls.logs.push(message) },
    ...overrides,
  }
  return { options, calls }
}

describe('runDisclaimerGate', () => {
  it('skips the window, the event, and the quit when the ack already matches', async () => {
    const { options, calls } = gateHarness()
    await writeDisclaimerAck(options.userDataDir, CURRENT)
    await expect(runDisclaimerGate(CURRENT, options)).resolves.toBe('agreed')
    expect(calls.opened).toBe(0)
    expect(calls.decisions).toEqual([])
    expect(calls.quit).toBe(0)
  })

  it('agree: persists the ack, reports agree, and lets the boot continue', async () => {
    const { options, calls } = gateHarness({ openWindow: () => {
      calls.opened += 1
      return fakeWindow('agree')
    } })
    const outcome = await runDisclaimerGate(CURRENT, options)
    expect(outcome).toBe('agreed')
    expect(calls.opened).toBe(1)
    // The ack landed on disk for exactly the current version+hash pair.
    expect(readDisclaimerAck(options.userDataDir)).toMatchObject({
      clientVersion: CURRENT.clientVersion,
      textHash: CURRENT.textHash,
    })
    expect(calls.decisions).toEqual(['agree'])
    expect(options.quit).not.toHaveBeenCalled()
  })

  it('disagree: reports disagree, runs the quit chain, and writes no ack', async () => {
    const { options, calls } = gateHarness({ openWindow: () => {
      calls.opened += 1
      return fakeWindow('disagree')
    } })
    const outcome = await runDisclaimerGate(CURRENT, options)
    expect(outcome).toBe('refused')
    expect(calls.opened).toBe(1)
    expect(calls.decisions).toEqual(['disagree'])
    expect(options.quit).toHaveBeenCalledOnce()
    // Refusal must leave no acknowledgment behind: the next boot asks again.
    expect(readDisclaimerAck(options.userDataDir)).toBeUndefined()
  })

  it('reports the row before the quit chain starts (fire-and-forget, no flush wait)', async () => {
    const order: string[] = []
    const { options } = gateHarness({
      openWindow: () => ({ run: async () => 'disagree' }),
      reportDecision: () => { order.push('report') },
      quit: async () => { order.push('quit') },
      logError: () => {},
    })
    await expect(runDisclaimerGate(CURRENT, options)).resolves.toBe('refused')
    expect(order).toEqual(['report', 'quit'])
  })

  it('still continues the boot when the ack write fails (next boot re-asks)', async () => {
    const dir = tmpUserDataDir()
    // A directory at the ack path: reads fail (EISDIR → not acknowledged)
    // and the atomic replacement cannot land on it.
    mkdirSync(join(dir, DISCLAIMER_ACK_FILENAME))
    const { options, calls } = gateHarness({
      userDataDir: dir,
      openWindow: () => fakeWindow('agree'),
    })
    await expect(runDisclaimerGate(CURRENT, options)).resolves.toBe('agreed')
    expect(calls.decisions).toEqual(['agree'])
    expect(options.quit).not.toHaveBeenCalled()
    expect(calls.logs).toHaveLength(1)
    expect(calls.logs[0]).toContain('failed to persist the disclaimer acknowledgment')
  })

  it('prompts again after an update (ack pinned to the previous version)', async () => {
    const { options, calls } = gateHarness({ openWindow: () => {
      calls.opened += 1
      return fakeWindow('agree')
    } })
    await writeDisclaimerAck(options.userDataDir, { clientVersion: '0.4.183', textHash: CURRENT.textHash })
    await expect(runDisclaimerGate(CURRENT, options)).resolves.toBe('agreed')
    expect(calls.opened).toBe(1)
    expect(readDisclaimerAck(options.userDataDir)).toMatchObject({ clientVersion: '0.4.184' })
  })
})
