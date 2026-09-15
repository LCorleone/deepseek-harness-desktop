/**
 * Boot-phase recorder (#042, Phase 1 instrumentation only): a tiny
 * phase-timer that turns boot-chain seams into `boot_phase` client events.
 *
 * Design constraints, from the issue's measurement postmortem:
 *
 * - The recorder exists BEFORE the client-event collector (its first anchor,
 *   `process_start`, fires at the top of the boot), so events emitted before
 *   {@link BootPhaseRecorder.attach} are buffered in order and flushed
 *   through the sink the moment it exists. A boot that never wires a sink
 *   (offline telemetry policy, early quit) drops its buffered anchors
 *   silently — instrumentation must never fail or delay the boot.
 * - `elapsedMs` counts from process start, not recorder creation:
 *   `performance.timeOrigin` is the process-start epoch, so the very first
 *   anchor already includes Electron/module-load time — the number a fleet
 *   dashboard wants to subtract against.
 * - `durMs` is opt-in: the emitting site passes the epoch value a previous
 *   `emit` (or `now`) returned, so only genuinely measurable stretches
 *   (`_end` anchors, the python check) carry a duration; point anchors
 *   omit the field.
 *
 * The event shape itself (closed phase vocabulary, numeric clamping) lives
 * with the other event projections in `client-event-reporter.ts`.
 *
 * @module dsh-plugin-desktop/boot-phase-recorder
 */

import { bootPhaseEvent, type BootPhase, type BootPhaseEventDetail } from './client-event-reporter.ts'

/** Factory options; tests substitute the clock and the origin. */
export interface BootPhaseRecorderOptions {
  /** Epoch-millisecond clock; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined
  /** Process-start epoch in epoch milliseconds; defaults to `performance.timeOrigin`. */
  readonly originMs?: number | undefined
}

/** The phase-timer handed around the boot chain. */
export interface BootPhaseRecorder {
  /** The recorder's epoch-millisecond clock (a span's start point). */
  now(): number
  /**
   * Record one boot-chain anchor. Returns the epoch value the anchor fired
   * at, so a later `emit('<phase>_end', startedAt)` can stamp the stretch.
   */
  emit(phase: BootPhase, startedAtMs?: number): number
  /** Wire the client-event sink; buffered anchors flush through it in order. */
  attach(sink: (detail: BootPhaseEventDetail) => void): void
}

/**
 * Create the boot's phase-timer. Created once at the top of the main boot
 * function; every anchor is one fire-and-forget row.
 */
export function createBootPhaseRecorder(options: BootPhaseRecorderOptions = {}): BootPhaseRecorder {
  const now = options.now ?? (() => Date.now())
  const originMs = options.originMs ?? performance.timeOrigin
  const buffered: BootPhaseEventDetail[] = []
  let sink: ((detail: BootPhaseEventDetail) => void) | undefined
  return {
    now: () => now(),
    emit(phase, startedAtMs) {
      const at = now()
      const detail = bootPhaseEvent(phase, at - originMs, startedAtMs === undefined ? undefined : at - startedAtMs)
      if (sink === undefined) buffered.push(detail)
      else sink(detail)
      return at
    },
    attach(next) {
      sink = next
      for (const detail of buffered) next(detail)
      buffered.length = 0
    },
  }
}
