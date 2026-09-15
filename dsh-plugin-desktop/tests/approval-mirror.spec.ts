/**
 * Full-access approval mirror (#039): the Cordis plugin that pairs the
 * session log's upstream approval audit events (`approval/asked` +
 * `approval/decided` with the `escalate sandbox to ...` reason) into
 * `full_access_approval` telemetry facts and delivers them through the
 * process-global sink.
 *
 * The posture mirrors `notifications.spec.ts` (a synthesized Cordis-like ctx
 * around a session/event emitter) and `windows-pwsh-sandbox.spec.ts` (the
 * #034 dual-module-instance delivery proof), with the same privacy red line:
 * command text, justification text, approval ids, and call ids never appear
 * in a sink event or a log line.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT,
  escalationAskMode,
  FULL_ACCESS_APPROVAL_PENDING_ASK_LIMIT,
  FullAccessApprovalProjection,
  inject,
  name,
  setDesktopFullAccessApprovalSink,
  type FullAccessApprovalMirrorOptions,
  type FullAccessApprovalTelemetryEvent,
} from '../src/approval-mirror.ts'
import { sandboxEscalationCommandHash } from '../src/windows-pwsh-sandbox.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** In-memory session log the back-scan reads, mirroring `Session.eventAt`. */
class FakeSession {
  readonly header: { id: SessionId }
  readonly events: SessionEvent[] = []

  constructor(id: string) {
    this.header = { id: id as SessionId }
  }

  get seq(): number {
    return this.events.length
  }

  eventAt(seq: number): SessionEvent | undefined {
    return this.events[seq]
  }
}

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: seq } as unknown as SessionEvent
}

function toolCall(seq: number, callId: string, command: string | undefined): SessionEvent {
  const argumentsJson = command === undefined
    ? JSON.stringify({ path: 'C:\\somewhere\\private' })
    : JSON.stringify({ command, sandbox_permissions: 'danger-full-access' })
  return event('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: argumentsJson }, seq)
}

function asked(seq: number, id: string, callId: string | undefined, reason: string | undefined): SessionEvent {
  return event('approval/asked', {
    id,
    toolName: 'bash',
    ...(callId === undefined ? {} : { callId }),
    ...(reason === undefined ? {} : { reason }),
  }, seq)
}

function decided(seq: number, id: string, outcome: string): SessionEvent {
  return event('approval/decided', { id, outcome }, seq)
}

const DANGER_REASON = 'escalate sandbox to danger-full-access: the model needs the network'
const WORKSPACE_REASON = 'escalate sandbox to workspace-write: write build outputs'

interface MirrorHarness {
  readonly received: FullAccessApprovalTelemetryEvent[]
  readonly warnings: string[]
  readonly errors: string[]
  sessionEvent(session: FakeSession, event: SessionEvent): void
  sessionDisposed(session: FakeSession): void
}

type ApplyFn = typeof apply

function createHarness(applyFn: ApplyFn = apply, options: FullAccessApprovalMirrorOptions = {}): MirrorHarness {
  const warnings: string[] = []
  const errors: string[] = []
  const received: FullAccessApprovalTelemetryEvent[] = []
  let sessionListener: ((session: Session, event: SessionEvent) => void | PromiseLike<void>) | undefined
  let sessionDisposedListener: ((session: Session) => void | PromiseLike<void>) | undefined

  const ctx = {
    logger: { warn: (message: string) => { warnings.push(message) }, error: (message: string) => { errors.push(message) } },
    on: (name: string, listener: unknown) => {
      if (name === 'session/event') sessionListener = listener as typeof sessionListener
      else if (name === 'session/disposed') sessionDisposedListener = listener as typeof sessionDisposedListener
      return () => {
        if (name === 'session/event') sessionListener = undefined
        else sessionDisposedListener = undefined
      }
    },
    inject: (services: string[], callback: (child: Context) => void) => {
      if (services[0] === 'sessions') callback(ctx as unknown as Context)
    },
    effect: (register: () => void | (() => void)) => register(),
  } as unknown as Context

  applyFn(ctx, {
    logWarn: options.logWarn ?? ((message: string) => { warnings.push(message) }),
    logError: options.logError ?? ((message: string) => { errors.push(message) }),
  })

  return {
    received,
    warnings,
    errors,
    sessionEvent(session, occurrence) {
      // The durable log sees every event before the firehose does.
      session.events.push(occurrence)
      sessionListener?.(session as unknown as Session, occurrence)
    },
    sessionDisposed(session) {
      sessionDisposedListener?.(session as unknown as Session)
    },
  }
}

/** Wire the collector-side sink and return its recorder. */
function collectSink(): FullAccessApprovalTelemetryEvent[] {
  const received: FullAccessApprovalTelemetryEvent[] = []
  setDesktopFullAccessApprovalSink(occurrence => { received.push(occurrence) })
  return received
}

/** One full approved escalation flow through a fresh session. */
function driveApproval(
  harness: MirrorHarness,
  overrides: {
    readonly id?: string
    readonly callId?: string
    readonly toolCallId?: string
    readonly command?: string
    readonly reason?: string
    readonly outcome?: string
  } = {},
): void {
  const id = overrides.id ?? 'approval-1'
  const callId = overrides.callId ?? 'call-1'
  const session = new FakeSession('session-1')
  harness.sessionEvent(session, toolCall(1, overrides.toolCallId ?? 'call-1', overrides.command ?? 'pip  install requests'))
  harness.sessionEvent(session, asked(2, id, callId, overrides.reason ?? DANGER_REASON))
  harness.sessionEvent(session, decided(3, id, overrides.outcome ?? 'allowed-once'))
}

/** Fold one event through the projection the way the firehose does: the
 * durable log sees the event first, then the projection folds it. */
function fold(
  projection: FullAccessApprovalProjection,
  session: FakeSession,
  occurrence: SessionEvent,
): FullAccessApprovalTelemetryEvent | undefined {
  session.events.push(occurrence)
  return projection.sessionEvent(session as unknown as Session, occurrence)
}

afterEach(() => {
  setDesktopFullAccessApprovalSink(undefined)
})

// ---------------------------------------------------------------------------
// Reason parsing
// ---------------------------------------------------------------------------

describe('escalation ask reason parsing', () => {
  it('extracts the target mode from escalation reasons', () => {
    expect(escalationAskMode(DANGER_REASON)).toBe('danger-full-access')
    expect(escalationAskMode(WORKSPACE_REASON)).toBe('workspace-write')
    expect(escalationAskMode('escalate sandbox to danger-full-access')).toBe('danger-full-access')
  })

  it('rejects foreign reasons and unknown modes', () => {
    expect(escalationAskMode('policy preset denied the write')).toBeUndefined()
    expect(escalationAskMode('a hook wants confirmation')).toBeUndefined()
    expect(escalationAskMode('escalate sandbox to ultra-access: unknown vocabulary')).toBeUndefined()
    expect(escalationAskMode('')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

describe('full access approval projection', () => {
  it('pairs an allowed escalation with its command hash and asked mode', () => {
    const projection = new FullAccessApprovalProjection()
    const session = new FakeSession('session-1')

    expect(fold(projection, session, toolCall(1, 'call-1', 'pip  install requests'))).toBeUndefined()
    expect(fold(projection, session, asked(2, 'ask-1', 'call-1', DANGER_REASON))).toBeUndefined()
    // Whitespace collapses through the shared normalization pipeline, so the
    // double space in the raw command and the single space hash alike.
    expect(fold(projection, session, decided(3, 'ask-1', 'allowed-once'))).toEqual({
      commandHash: sandboxEscalationCommandHash('pip install requests'),
      outcome: 'allowed-once',
      mode: 'danger-full-access',
    })
  })

  it('mirrors every decided outcome vocabulary value', () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
      const projection = new FullAccessApprovalProjection()
      const session = new FakeSession(`session-${outcome}`)
      fold(projection, session, toolCall(1, 'call-9', 'curl https://example.invalid'))
      fold(projection, session, asked(2, 'ask-9', 'call-9', WORKSPACE_REASON))
      expect(fold(projection, session, decided(3, 'ask-9', outcome))).toEqual({
        commandHash: sandboxEscalationCommandHash('curl https://example.invalid'),
        outcome,
        mode: 'workspace-write',
      })
    }
  })

  it('resolves commands from earlier in the log, not only the tail', () => {
    const projection = new FullAccessApprovalProjection()
    const session = new FakeSession('session-2')
    fold(projection, session, toolCall(1, 'call-early', 'npm ci'))
    fold(projection, session, toolCall(2, 'call-late', 'npm run build'))
    fold(projection, session, event('assistant/message', {}, 3))
    fold(projection, session, asked(4, 'ask-2', 'call-early', DANGER_REASON))
    expect(fold(projection, session, decided(5, 'ask-2', 'allowed-once'))).toEqual({
      commandHash: sandboxEscalationCommandHash('npm ci'),
      outcome: 'allowed-once',
      mode: 'danger-full-access',
    })
  })

  it('never emits for an undecided ask or an unpaired decision', () => {
    const projection = new FullAccessApprovalProjection()
    const session = new FakeSession('session-3')
    fold(projection, session, toolCall(1, 'call-1', 'whoami'))
    expect(fold(projection, session, asked(2, 'ask-open', 'call-1', DANGER_REASON))).toBeUndefined()

    // A decision for an id nobody asked about (the common non-escalation
    // approval) reads as unpaired and stays silent.
    expect(fold(projection, session, decided(3, 'ask-foreign', 'rejected'))).toBeUndefined()
    // The still-open ask has not emitted anything.
    expect(fold(projection, session, decided(4, 'ask-open', 'allowed-once'))).not.toBeUndefined()
  })

  it('keeps sessions independent and drops state on disposal', () => {
    const projection = new FullAccessApprovalProjection()
    const first = new FakeSession('session-a')
    const second = new FakeSession('session-b')
    fold(projection, first, toolCall(1, 'call-a', 'terraform apply'))
    fold(projection, first, asked(2, 'ask-a', 'call-a', DANGER_REASON))
    fold(projection, second, toolCall(1, 'call-b', 'kubectl delete all'))
    fold(projection, second, asked(2, 'ask-b', 'call-b', DANGER_REASON))

    projection.sessionDisposed(first as unknown as Session)
    expect(fold(projection, first, decided(3, 'ask-a', 'allowed-once'))).toBeUndefined()
    expect(fold(projection, second, decided(3, 'ask-b', 'allowed-once'))).toEqual({
      commandHash: sandboxEscalationCommandHash('kubectl delete all'),
      outcome: 'allowed-once',
      mode: 'danger-full-access',
    })
  })

  it('bounds tracked undecided asks per session', () => {
    const projection = new FullAccessApprovalProjection()
    const session = new FakeSession('session-flood')
    const ids = Array.from({ length: FULL_ACCESS_APPROVAL_PENDING_ASK_LIMIT + 1 }, (_, index) => `ask-${String(index)}`)
    for (const [index, id] of ids.entries()) {
      fold(projection, session, asked(index + 1, id, `call-${id}`, DANGER_REASON))
    }
    const oldest = ids[0] as string
    const newest = ids.at(-1) as string
    // The newest ask's call resolves (its tool/call landed later in the log).
    fold(projection, session, toolCall(50, `call-${newest}`, 'whoami'))
    // The oldest ask dropped; its late decision reads as unpaired (silent),
    // while the newest still pairs.
    expect(fold(projection, session, decided(99, oldest, 'allowed-once'))).toBeUndefined()
    expect(fold(projection, session, decided(100, newest, 'allowed-once'))).toEqual({
      commandHash: sandboxEscalationCommandHash('whoami'),
      outcome: 'allowed-once',
      mode: 'danger-full-access',
    })
  })

  it('ignores malformed approval events without throwing', () => {
    const projection = new FullAccessApprovalProjection()
    const session = new FakeSession('session-malformed')
    expect(fold(projection, session, event('approval/asked', { id: 42 }, 1))).toBeUndefined()
    expect(fold(projection, session, event('approval/decided', null, 2))).toBeUndefined()
    expect(fold(projection, session, event('approval/decided', { id: 'x', outcome: 'granted' }, 3))).toBeUndefined()
    expect(fold(projection, session, event('turn/start', { turn: 1 }, 4))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Plugin wiring (Cordis-like ctx)
// ---------------------------------------------------------------------------

describe('full access approval mirror plugin', () => {
  it('exposes the desktop plugin identity', () => {
    expect(name).toBe('desktop-full-access-approval-mirror')
    expect(inject).toEqual(['desktopRuntime'])
  })

  it('delivers one event per paired escalation through the sink', () => {
    const received = collectSink()
    const harness = createHarness()

    driveApproval(harness)

    expect(received).toEqual([{
      commandHash: sandboxEscalationCommandHash('pip install requests'),
      outcome: 'allowed-once',
      mode: 'danger-full-access',
    }])
  })

  it('ignores approvals that are not escalation asks', () => {
    const received = collectSink()
    const harness = createHarness()
    const session = new FakeSession('session-policy')

    // A policy auto-reject and a hook question: neither carries the
    // escalation reason prefix, so both stay invisible — no event, no warn.
    harness.sessionEvent(session, toolCall(1, 'call-p', 'rm -rf build'))
    harness.sessionEvent(session, asked(2, 'ask-p', 'call-p', 'the permission preset denied this write'))
    harness.sessionEvent(session, decided(3, 'ask-p', 'rejected'))
    harness.sessionEvent(session, asked(4, 'ask-h', undefined, 'a hook requires confirmation'))
    harness.sessionEvent(session, decided(5, 'ask-h', 'cancelled'))
    harness.sessionEvent(session, asked(6, 'ask-none', 'call-p', undefined))
    harness.sessionEvent(session, decided(7, 'ask-none', 'rejected'))

    expect(received).toEqual([])
    expect(harness.warnings).toEqual([])
    expect(harness.errors).toEqual([])
  })

  it('skips unresolvable pairs with one category-only warn line', () => {
    const received = collectSink()
    const harness = createHarness()

    // The ask's callId names no tool/call in the log (the logged call kept a
    // different id).
    driveApproval(harness, { callId: 'call-ghost', toolCallId: 'call-1' })
    void ((): void => {
      // The ask carries no callId at all.
      const session = new FakeSession('session-nocall')
      harness.sessionEvent(session, toolCall(1, 'call-1', 'pip  install requests'))
      harness.sessionEvent(session, asked(2, 'ask-nocall', undefined, DANGER_REASON))
      harness.sessionEvent(session, decided(3, 'ask-nocall', 'allowed-once'))
    })()
    void ((): void => {
      // The tool call exists but carries no command member (the fs family).
      const session = new FakeSession('session-fs')
      harness.sessionEvent(session, toolCall(1, 'call-fs', undefined))
      harness.sessionEvent(session, asked(2, 'ask-fs', 'call-fs', DANGER_REASON))
      harness.sessionEvent(session, decided(3, 'ask-fs', 'allowed-once'))
    })()

    expect(received).toEqual([])
    expect(harness.warnings).toHaveLength(3)
    // Category lines only: no command text, justification, approval id, or call id.
    for (const line of [...harness.warnings, ...harness.errors]) {
      expect(line).toMatch(/^dsh-plugin-desktop: full-access approval mirror skipped an escalation /u)
      expect(line).not.toMatch(/pip|requests|danger-full-access: the model|call-ghost|ask-nocall|ask-fs/u)
    }
  })

  it('warns when an escalation reason names an unknown target mode', () => {
    const received = collectSink()
    const harness = createHarness()

    driveApproval(harness, { reason: 'escalate sandbox to ultra-access: future vocabulary' })

    expect(received).toEqual([])
    expect(harness.warnings).toEqual([
      'dsh-plugin-desktop: full-access approval mirror skipped an escalation ask with an unknown target mode',
    ])
  })

  it('keeps delivering after a throwing sink and a throwing fold', () => {
    const failing = vi.fn(() => { throw new Error('sink exploded') })
    setDesktopFullAccessApprovalSink(failing)
    const harness = createHarness()

    expect(() => { driveApproval(harness) }).not.toThrow()
    expect(failing).toHaveBeenCalledOnce()
    expect(harness.errors).toHaveLength(1)
    expect(harness.errors[0]).toMatch(/^dsh-plugin-desktop: full-access approval sink failed: sink exploded$/u)

    const recovered = collectSink()
    driveApproval(harness, { id: 'ask-2', callId: 'call-2', toolCallId: 'call-2', command: 'dotnet build' })
    expect(recovered).toEqual([{
      commandHash: sandboxEscalationCommandHash('dotnet build'),
      outcome: 'allowed-once',
      mode: 'danger-full-access',
    }])
  })

  it('keeps the command text out of sink events and log lines', () => {
    const received = collectSink()
    const harness = createHarness()
    driveApproval(harness, { command: 'curl  https://internal.example/secret-path --token hunter2' })
    driveApproval(harness, { callId: 'call-missing' })

    const rendered = JSON.stringify({ received, warnings: harness.warnings, errors: harness.errors })
    expect(rendered).not.toMatch(/curl|internal\.example|secret-path|hunter2/u)
  })
})

// ---------------------------------------------------------------------------
// #034 build-time dual module instance: bundled main.js copy vs the
// loader-loaded lib/approval-mirror.js plugin face
// ---------------------------------------------------------------------------

describe('full access approval sink across module instances', () => {
  // The query string makes vite/vitest treat the specifier as a distinct
  // module record, simulating the loader-loaded plugin face; the plain
  // static import above stands in for the copy inlined into lib/main.js.
  it('delivers to the sink registered through the other module instance', async () => {
    const loaderFace = await import('../src/approval-mirror.ts?loader-instance' as string) as typeof import('../src/approval-mirror.ts')
    // Guard: the query must have produced a genuinely distinct module
    // instance (fresh plugin state) — otherwise this test would prove nothing.
    expect(loaderFace.setDesktopFullAccessApprovalSink).not.toBe(setDesktopFullAccessApprovalSink)

    // Instance A (bundled-main face): the Electron launcher registers the
    // collector through THIS module copy, exactly like src/main.ts does.
    const received = collectSink()
    // Instance B (loader face): the Cordis plugin loaded from the exports
    // entry must still reach instance A's registration.
    const harness = createHarness(loaderFace.apply)

    driveApproval(harness)

    expect(received).toEqual([{
      commandHash: sandboxEscalationCommandHash('pip install requests'),
      outcome: 'allowed-once',
      mode: 'danger-full-access',
    }])
  })

  it('occupies its own process-global slot, distinct from the sandbox escalation sink', () => {
    expect(Symbol.keyFor(DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT)).toBe('dsh.desktopFullAccessApprovalSink')
    expect(Symbol.keyFor(DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT)).not.toBe('dsh.desktopSandboxEscalationSink')
    // Distinct symbols mean distinct globalThis properties: wiring one sink
    // can never shadow or clear the other.
    expect(DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT).not.toBe(Symbol.for('dsh.desktopSandboxEscalationSink'))
  })
})
