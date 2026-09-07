/**
 * Beta disclaimer gate: the once-per-version+text-revision decision that
 * gates the desktop shell mount (decided 2026-09-07).
 *
 * Three facts drive everything here:
 *
 * - **Trigger** — {@link needsDisclaimer} is pure: no ack record (fresh
 *   install), a client-version change (update), or a text-hash change
 *   (revised statement) each prompt exactly once; everyday boots read the
 *   ack and continue without a single prompt. Dev and unpackaged boots run
 *   the same rule (decision: no dev exemption), so the flow is verifiable
 *   on real machines.
 * - **Storage** — one small JSON file in `userData` (the same directory
 *   discipline as the updates state), written ONLY on agreement through
 *   the atomic writer, never containing anything but version, hash, time.
 * - **Decision** — {@link runDisclaimerGate} orchestrates: prompt due →
 *   open the window and await its verdict; agree → persist the ack, report,
 *   boot continues; refuse (the 「不同意」 button or closing the window — a
 *   close is the same refusal) → report, then run the caller's graceful
 *   quit chain. Telemetry is fire-and-forget: the quit does not wait for
 *   the single-row write to flush, so a refuse row may be lost when the
 *   teardown outpaces it — an accepted trade (the collector keeps no retry
 *   queue), noted here so nobody "fixes" it by blocking the exit.
 *
 * @module dsh-plugin-desktop/disclaimer-gate
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Acknowledgment file name inside `userData`. */
export const DISCLAIMER_ACK_FILENAME = 'disclaimer-ack.json'

/** Version facts a disclaimer acknowledgment is pinned to. */
export interface DisclaimerCurrent {
  readonly clientVersion: string
  readonly textHash: string
}

/** Shape of `disclaimer-ack.json`; written only on agreement. */
export interface DisclaimerAck {
  readonly clientVersion: string
  readonly textHash: string
  readonly acknowledgedAt: string
}

/** Absolute ack path inside one `userData` directory. */
export function disclaimerAckPath(userDataDir: string): string {
  return join(userDataDir, DISCLAIMER_ACK_FILENAME)
}

/**
 * Strict parse of the ack document: all three fields must be strings.
 * Unknown extra keys are tolerated (a future field must not re-prompt the
 * whole fleet); anything malformed is `undefined` — fail toward prompting.
 */
export function parseDisclaimerAck(text: string): DisclaimerAck | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.clientVersion !== 'string') return undefined
  if (typeof record.textHash !== 'string') return undefined
  if (typeof record.acknowledgedAt !== 'string') return undefined
  return {
    clientVersion: record.clientVersion,
    textHash: record.textHash,
    acknowledgedAt: record.acknowledgedAt,
  }
}

/** Read the ack; missing, unreadable, or malformed means "not acknowledged". */
export function readDisclaimerAck(userDataDir: string): DisclaimerAck | undefined {
  try {
    return parseDisclaimerAck(readFileSync(disclaimerAckPath(userDataDir), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist the ack for `current` (agree path only): user-private mode, atomic
 * replacement, pretty-printed with a trailing newline like the other state
 * documents. The returned value is exactly what a later read yields.
 */
export async function writeDisclaimerAck(
  userDataDir: string,
  current: DisclaimerCurrent,
  now: () => Date = () => new Date(),
): Promise<DisclaimerAck> {
  const ack: DisclaimerAck = { ...current, acknowledgedAt: now().toISOString() }
  await writeFileAtomic(disclaimerAckPath(userDataDir), `${JSON.stringify(ack, undefined, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
  return ack
}

/**
 * Pure trigger judgment: prompt when there is no ack, when the client
 * version changed (an update), or when the statement hash changed (a text
 * revision). Same version AND same hash is the only quiet combination.
 */
export function needsDisclaimer(current: DisclaimerCurrent, ack: DisclaimerAck | undefined): boolean {
  if (ack === undefined) return true
  return ack.clientVersion !== current.clientVersion || ack.textHash !== current.textHash
}

/** Window surface the gate drives (a structural subset of `DesktopDisclaimerWindow`). */
export interface DisclaimerGateWindow {
  /** Settle on the user's decision; a closed window settles as a refusal. */
  run(): Promise<'agree' | 'disagree'>
}

/** Every dependency of {@link runDisclaimerGate} is injectable for tests. */
export interface DisclaimerGateOptions {
  readonly userDataDir: string
  /** Opens the disclaimer window; called only when a prompt is actually due. */
  readonly openWindow: () => DisclaimerGateWindow
  /**
   * Fire-and-forget telemetry sink for the decision; must never throw and
   * is never awaited by the gate.
   */
  readonly reportDecision: (decision: 'agree' | 'disagree') => void
  /**
   * The graceful quit chain (the same teardown the shell's X-close quit
   * runs: dispose the Host tree, then exit); invoked only on refusal.
   */
  readonly quit: () => Promise<void> | void
  readonly logError?: (message: string) => void
  readonly now?: () => Date
}

/** `agreed` lets the boot continue; `refused` means the app is exiting. */
export type DisclaimerGateOutcome = 'agreed' | 'refused'

/**
 * Run the gate for one boot: judge from disk, prompt only when due, then
 * persist-and-report (agree) or report-and-quit (refuse). Never throws past
 * a decision: an ack write failure logs and continues (the cost is one
 * re-prompt next boot, not a blocked user who just agreed).
 */
export async function runDisclaimerGate(
  current: DisclaimerCurrent,
  options: DisclaimerGateOptions,
): Promise<DisclaimerGateOutcome> {
  if (!needsDisclaimer(current, readDisclaimerAck(options.userDataDir))) return 'agreed'
  const decision = await options.openWindow().run()
  if (decision === 'agree') {
    try {
      await writeDisclaimerAck(options.userDataDir, current, options.now)
    } catch (cause) {
      options.logError?.(
        `dsh-plugin-desktop: failed to persist the disclaimer acknowledgment (the next boot will ask again): ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    options.reportDecision('agree')
    return 'agreed'
  }
  // The refuse row is queued fire-and-forget and the quit below does NOT
  // wait for the single-row write to flush — the row can be lost when the
  // teardown outpaces it, an accepted trade (documented in the module doc).
  options.reportDecision('disagree')
  options.logError?.('dsh-plugin-desktop: the beta disclaimer was declined; exiting')
  await options.quit()
  return 'refused'
}
