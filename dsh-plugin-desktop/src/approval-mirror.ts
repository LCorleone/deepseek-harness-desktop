/**
 * Mirror the upstream executor's own sandbox-escalation approvals into the
 * desktop's client-event telemetry (#039).
 *
 * PRIVACY CONTRACT (extends the client-event-reporter posture): one mirrored
 * decision carries ONLY the 16-hex-character sha256 prefix of the normalized
 * command text (the same hash pipeline as `sandbox_escalation`), the upstream
 * outcome, and the asked target mode. The command text itself, the
 * justification, the approval id, and the tool call id NEVER enter a sink
 * event or a log line — the log surface of this module is skip categories
 * and counters only.
 *
 * Composition facts:
 *
 * - The upstream executor families (bash shell, sandboxed fs) ask for
 *   full-access reruns through `approveEscalation`
 *   (`@deepseek-ai/dsh-sandbox`), which routes the question through the
 *   approval service (`@deepseek-ai/dsh-user-approval`) — the waterfall the
 *   client UI answers. That flow never touches the desktop's own PowerShell
 *   escalation adapter, so before this mirror the widest permissions a user
 *   can grant were exactly the telemetry blind spot (Lucy, b94: a fully
 *   approved danger-full-access session produced zero `sandbox_escalation`
 *   rows even with the #034 fix).
 * - The mirror is read-only over the session log: it pairs
 *   `approval/asked` with `approval/decided` by id, filters on the
 *   escalation reason prefix, and resolves the command text HOST-SIDE by
 *   back-scanning the session's `tool/call` events by callId. Nothing is
 *   appended and no tool flow is intercepted.
 * - Telemetry must never break a session: every step is fail-open — an
 *   unresolvable pair skips with ONE warn line and the handler keeps
 *   folding.
 *
 * UPSTREAM CONTRACTS this mirror depends on (replay when upgrading
 * @deepseek-ai/* past 0.1.2):
 *
 * - `ApprovalService.request` appends `approval/asked {id, toolName,
 *   callId?, reason?}` and then `approval/decided {id, outcome}` with
 *   outcome from `'allowed-once' | 'rejected' | 'cancelled' |
 *   'unavailable'` (the fail-closed rogue-value normalization is upstream's
 *   own).
 * - The escalation reason is `escalate sandbox to ${mode}: ${justification}`
 *   with mode from `ESCALATION_TARGETS` (`'workspace-write' |
 *   'danger-full-access'`); every other approval ask (policy auto-rejects,
 *   hooks) carries a different reason and must stay invisible here.
 * - `tool/call {callId, name, arguments}` carries the raw arguments JSON
 *   string exactly as the model produced it; the shell tools' arguments
 *   object holds the `command` member hashed here.
 */

import type { Context } from '@deepseek-ai/cordis'
import { ESCALATION_TARGETS, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { sandboxEscalationCommandHash } from './windows-pwsh-sandbox.ts'

/** Stable Cordis plugin name (launcher profile row `desktop-full-access-approval-mirror`). */
export const name = 'desktop-full-access-approval-mirror'

/** The runtime service probe; `sessions` attaches independently below. */
export const inject = ['desktopRuntime']

// ---------------------------------------------------------------------------
// Telemetry event and process-global sink
// ---------------------------------------------------------------------------

/** How one upstream escalation approval ended (the upstream `ApprovalOutcome` vocabulary, verbatim). */
export type FullAccessApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** `full_access_approval` telemetry facts; the command text itself never leaves the host. */
export interface FullAccessApprovalTelemetryEvent {
  /** sha256 of the normalized command, first 16 hex characters. */
  readonly commandHash: string
  readonly outcome: FullAccessApprovalOutcome
  /** Sandbox mode the approved ask escalated this call to. */
  readonly mode: SandboxMode
}

/** Telemetry sink the Electron launcher wires to the client-event collector. */
export type DesktopFullAccessApprovalSink = (event: FullAccessApprovalTelemetryEvent) => void

/**
 * Process-global slot carrying the full-access approval telemetry sink, the
 * `DESKTOP_SANDBOX_ESCALATION_SINK_SLOT` pattern repeated (#034 lesson):
 * tsdown inlines this module into lib/main.js (whose `apply` never runs
 * there, but whose `setDesktopFullAccessApprovalSink` the launcher calls
 * after boot), while the Cordis loader separately loads the plugin face from
 * lib/approval-mirror.js through the package exports map — the copy whose
 * `apply` subscribes to `session/event`. A module-local `let` would give each
 * copy its own binding and silently drop every row again; `Symbol.for`
 * returns the SAME registry symbol to every module instance of this process,
 * so the setter and the mirror always meet on globalThis (the plugin runs
 * only in the Electron main process, the same process the collector lives
 * in). Exported so tests can pin the registry key against drift onto the
 * sandbox escalation slot.
 */
export const DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT: unique symbol = Symbol.for('dsh.desktopFullAccessApprovalSink')

/** globalThis narrowed to the sink slot; the slot is only touched through the helpers below. */
const approvalSinkGlobals = globalThis as unknown as {
  [DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT]: DesktopFullAccessApprovalSink | undefined
}

/** Read the process-wide approval sink, whichever module instance wrote it. */
function desktopFullAccessApprovalSink(): DesktopFullAccessApprovalSink | undefined {
  return approvalSinkGlobals[DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT]
}

/**
 * Wire (or clear) the process-wide full-access approval telemetry sink. The
 * Cordis loader loads the plugin face as its own module instance, so the
 * Electron launcher hands the collector in through this module seam after
 * boot; the slot lives on globalThis so the seam also crosses module
 * instances (see {@link DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT} above).
 */
export function setDesktopFullAccessApprovalSink(sink: DesktopFullAccessApprovalSink | undefined): void {
  approvalSinkGlobals[DESKTOP_FULL_ACCESS_APPROVAL_SINK_SLOT] = sink
}

// ---------------------------------------------------------------------------
// Reason and session-log readers (untrusted-shape guards)
// ---------------------------------------------------------------------------

/** Reason prefix every sandbox-escalation ask carries (`approveEscalation`). */
const ESCALATION_REASON_PREFIX = 'escalate sandbox to '

/**
 * The target mode one escalation reason asked for, or undefined. Only
 * `ESCALATION_TARGETS` spellings count: the mode runs from the prefix to the
 * first colon of the `escalate sandbox to ${mode}: ${justification}` shape,
 * and a reason without the prefix is some other approval question (policy
 * auto-reject, hook) that must stay invisible here.
 */
export function escalationAskMode(reason: string): SandboxMode | undefined {
  if (!reason.startsWith(ESCALATION_REASON_PREFIX)) return undefined
  const rest = reason.slice(ESCALATION_REASON_PREFIX.length)
  const colon = rest.indexOf(':')
  const candidate = colon === -1 ? rest : rest.slice(0, colon)
  return (ESCALATION_TARGETS as readonly string[]).includes(candidate) ? candidate as SandboxMode : undefined
}

/** Guarded `approval/asked` facts; malformed events read as absent. */
function readAsked(data: unknown): { id: string, callId: string | undefined, reason: string | undefined } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const id = (data as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) return undefined
  const callId = (data as { callId?: unknown }).callId
  const reason = (data as { reason?: unknown }).reason
  return {
    id,
    callId: typeof callId === 'string' && callId.length > 0 ? callId : undefined,
    reason: typeof reason === 'string' ? reason : undefined,
  }
}

/** Guarded `approval/decided` facts; malformed events read as absent. */
function readDecided(data: unknown): { id: string, outcome: FullAccessApprovalOutcome } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const id = (data as { id?: unknown }).id
  const outcome = (data as { outcome?: unknown }).outcome
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled' && outcome !== 'unavailable') {
    return undefined
  }
  return { id, outcome }
}

/** The `command` member of one tool call's raw arguments JSON, when the tool carries one. */
function commandOfToolCallArguments(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const command = (parsed as { command?: unknown }).command
  return typeof command === 'string' && command.length > 0 ? command : undefined
}

/**
 * Back-scan one session's log for the `tool/call` a callId names and return
 * its command text. The call always precedes the approval inside the same
 * step, so the scan meets it near the tail; decisions are human-paced and
 * rare, so even an unresolvable full-log scan costs nothing observable. The
 * command stays inside this function — only its hash leaves.
 */
function commandForCall(session: Session, callId: string): string | undefined {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const candidate = session.eventAt(seq as SessionSeq)
    if ((candidate?.type as string | undefined) !== 'tool/call') continue
    const data = candidate?.data as unknown as { callId?: unknown, arguments?: unknown } | undefined
    if (data?.callId !== callId) continue
    return commandOfToolCallArguments(data.arguments)
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Pairing projection (pure; the plugin wiring drives it)
// ---------------------------------------------------------------------------

/** One tracked escalation ask awaiting its decision. */
interface PendingApprovalAsk {
  readonly callId: string | undefined
  readonly mode: SandboxMode
}

/** Per-session pairing state. */
interface SessionApprovalState {
  readonly asks: Map<string, PendingApprovalAsk>
}

/**
 * Ceiling on tracked-but-undecided asks per session. Real flows hold one ask
 * at a time (the waterfall blocks the call); the bound only stops a runaway
 * producer (a session that asks forever without deciding) from growing the
 * map — oldest asks drop first and their (never-arriving) decisions then
 * read as unpaired, which is silent.
 */
export const FULL_ACCESS_APPROVAL_PENDING_ASK_LIMIT = 32

/** Projection options; tests substitute the warn sink. */
export interface FullAccessApprovalProjectionOptions {
  /** Category-only warn line sink (skip reasons); never the command text. */
  readonly warn?: ((message: string) => void) | undefined
}

/** Pair escalation approval audit events into telemetry facts, per session. */
export class FullAccessApprovalProjection {
  readonly #warn: (message: string) => void
  readonly #sessions = new Map<string, SessionApprovalState>()
  readonly #syntheticKeys = new WeakMap<object, string>()
  #nextSyntheticKey = 0

  constructor(options: FullAccessApprovalProjectionOptions = {}) {
    this.#warn = options.warn ?? (() => {})
  }

  /**
   * Fold one firehose event. Non-approval events are free; a foreign
   * (non-escalation) ask is invisible; an escalation ask is tracked until
   * its decision pairs it into one telemetry event.
   * @param session - the session the event belongs to.
   * @param event - the live session event.
   * @returns the reportable event, or undefined when the event carries none.
   */
  sessionEvent(session: Session, event: SessionEvent): FullAccessApprovalTelemetryEvent | undefined {
    const type = event.type as string
    if (type === 'approval/asked') return this.#asked(session, event.data)
    if (type === 'approval/decided') return this.#decided(session, event.data)
    return undefined
  }

  /** Release one session's pending asks. */
  sessionDisposed(session: Session): void {
    this.#sessions.delete(this.#keyFor(session))
  }

  #asked(session: Session, data: unknown): FullAccessApprovalTelemetryEvent | undefined {
    const asked = readAsked(data)
    if (asked === undefined) return undefined
    if (asked.reason === undefined) return undefined
    if (!asked.reason.startsWith(ESCALATION_REASON_PREFIX)) return undefined
    const mode = escalationAskMode(asked.reason)
    if (mode === undefined) {
      // The prefix matches but the mode is outside ESCALATION_TARGETS —
      // vocabulary drift worth one category line, never the reason text.
      this.#warn('dsh-plugin-desktop: full-access approval mirror skipped an escalation ask with an unknown target mode')
      return undefined
    }
    const state = this.#stateFor(session)
    if (state.asks.size >= FULL_ACCESS_APPROVAL_PENDING_ASK_LIMIT) {
      const oldest = state.asks.keys().next().value
      if (oldest !== undefined) state.asks.delete(oldest)
    }
    state.asks.set(asked.id, { callId: asked.callId, mode })
    return undefined
  }

  #decided(session: Session, data: unknown): FullAccessApprovalTelemetryEvent | undefined {
    const decided = readDecided(data)
    if (decided === undefined) return undefined
    const state = this.#sessions.get(this.#keyFor(session))
    const ask = state?.asks.get(decided.id)
    if (ask === undefined) return undefined
    state?.asks.delete(decided.id)
    if (ask.callId === undefined) {
      this.#warn('dsh-plugin-desktop: full-access approval mirror skipped an escalation decision whose ask carried no call id')
      return undefined
    }
    const command = commandForCall(session, ask.callId)
    if (command === undefined) {
      // No resolvable command means no identity anchor for the row —
      // emitting without the hash would poison per-command aggregates, so
      // the pair skips with one category line instead. This is also where
      // non-shell escalations land today: the fs family escalates
      // `operation` asks whose arguments carry no `command` member (a path
      // identity scheme is a recorded follow-up, not a silent guess).
      this.#warn('dsh-plugin-desktop: full-access approval mirror skipped an escalation decision with no resolvable command')
      return undefined
    }
    return {
      commandHash: sandboxEscalationCommandHash(command),
      outcome: decided.outcome,
      mode: ask.mode,
    }
  }

  #keyFor(session: Session): string {
    const id = (session as { header?: { id?: unknown } }).header?.id
    if (typeof id === 'string' && id.length > 0) return id
    const existing = this.#syntheticKeys.get(session)
    if (existing !== undefined) return existing
    this.#nextSyntheticKey += 1
    const synthetic = `#anonymous:${String(this.#nextSyntheticKey)}`
    this.#syntheticKeys.set(session, synthetic)
    return synthetic
  }

  #stateFor(session: Session): SessionApprovalState {
    const key = this.#keyFor(session)
    let state = this.#sessions.get(key)
    if (state === undefined) {
      state = { asks: new Map() }
      this.#sessions.set(key, state)
    }
    return state
  }
}

// ---------------------------------------------------------------------------
// Plugin wiring
// ---------------------------------------------------------------------------

/** Every dependency `apply` can take from its host; tests substitute the log sinks. */
export interface FullAccessApprovalMirrorOptions {
  readonly logWarn?: ((message: string) => void) | undefined
  readonly logError?: ((message: string) => void) | undefined
}

/**
 * Subscribe the mirror. Fail-open everywhere: a throwing fold or a throwing
 * sink degrades to ONE log line and the session keeps flowing — telemetry
 * must never break a session. With no sink wired (an ordinary dsh boot that
 * somehow loads this row), events pair internally and deliver to nothing.
 */
export function apply(ctx: Context, options: FullAccessApprovalMirrorOptions = {}): void {
  const logWarn = options.logWarn ?? ((message: string) => { ctx.logger.warn(message) })
  const logError = options.logError ?? ((message: string) => { ctx.logger.error(message) })
  ctx.inject(['sessions'], (sessionsCtx) => {
    sessionsCtx.effect(() => {
      const projection = new FullAccessApprovalProjection({ warn: logWarn })
      const stopEvents = sessionsCtx.on('session/event', (session, event) => {
        let mirrored: FullAccessApprovalTelemetryEvent | undefined
        try {
          mirrored = projection.sessionEvent(session, event)
        } catch (cause) {
          logError(`dsh-plugin-desktop: full-access approval mirror fold failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          return
        }
        if (mirrored === undefined) return
        try {
          desktopFullAccessApprovalSink()?.(mirrored)
        } catch (cause) {
          logError(`dsh-plugin-desktop: full-access approval sink failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })
      const stopDisposed = sessionsCtx.on('session/disposed', (session) => {
        projection.sessionDisposed(session)
      })
      return () => {
        stopDisposed()
        stopEvents()
      }
    }, 'dsh-plugin-desktop: full-access approval mirror')
  })
}
