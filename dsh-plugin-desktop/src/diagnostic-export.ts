/** Bundle recent logs and system information without blocking Electron's main thread. */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { getSsoSession } from './company-sso.ts'
import type { DiagnosticExportWorkerResult } from './diagnostic-export-worker.ts'
import { assembleDesktopSelfCheckExport } from './diagnostic-self-check.ts'
import type { DesktopSelfCheckExportPayload } from './diagnostic-self-check.ts'
import { desktopLifecycleEvidencePath } from './lifecycle-events.ts'

/** Bound both worker memory and the amount of potentially sensitive log history exported. */
export const MAX_DIAGNOSTIC_EVIDENCE_BYTES = 50 * 1024 * 1024

/** Stop an export that cannot complete because its Worker or filesystem is wedged. */
export const DIAGNOSTIC_EXPORT_TIMEOUT_MS = 60_000

export interface DiagnosticExportOptions {
  /** Installed Desktop package version recorded in system-info.txt. */
  readonly appVersion: string
  /** Override used by focused tests; production logs and dumps share the 50 MB cap. */
  readonly maxEvidenceBytes?: number
  /** Electron Crashpad directory whose local minidumps should be included. */
  readonly crashDumpsDir?: string
  /** Active-run marker used to identify a launch that did not shut down cleanly. */
  readonly runStatePath?: string
  /** Current-run lifecycle JSONL written by the Electron launcher. */
  readonly lifecycleEvidencePath?: string
  /** Pre-assembled signed self-check report (P4-1); omitted disables the entry. */
  readonly selfCheck?: DesktopSelfCheckExportPayload
  /** Cancels the short-lived worker when its owning UI or process operation ends. */
  readonly signal?: AbortSignal
}

export interface DesktopDiagnosticExportOptions {
  readonly appVersion: string
  /** Exact Electron Crashpad directory; defaults to the conventional user-data location. */
  readonly crashDumpsDir?: string
  readonly maxEvidenceBytes?: number
  /** Pre-assembled self-check payload; defaults to assembling one for this user data. */
  readonly selfCheck?: DesktopSelfCheckExportPayload
  readonly signal?: AbortSignal
}

function workerEntryUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  return new URL(`./diagnostic-export-worker.${extension}`, import.meta.url)
}

/** Wait for one diagnostic Worker result and terminate it when it stops responding. */
export function waitForDiagnosticExportWorker(
  worker: Worker,
  timeoutMs: number = DIAGNOSTIC_EXPORT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const settle = (complete: () => void, terminate: boolean): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (terminate) void worker.terminate().catch(() => {})
      complete()
    }
    const abort = (): void => {
      settle(
        () => reject(new DOMException('Diagnostic export was cancelled.', 'AbortError')),
        true,
      )
    }
    timeout = setTimeout(() => {
      settle(
        () => reject(new Error(
          `dsh-plugin-desktop: diagnostic export worker timed out after ${String(timeoutMs)}ms`,
        )),
        true,
      )
    }, timeoutMs)
    worker.once('message', (result: DiagnosticExportWorkerResult) => {
      if (result.ok) settle(() => resolve(result.path), true)
      else settle(() => reject(new Error(result.error)), true)
    })
    worker.once('error', cause => settle(() => reject(cause), true))
    worker.once('exit', (code) => {
      settle(
        () => reject(new Error(
          `dsh-plugin-desktop: diagnostic export worker exited with code ${String(code)}`,
        )),
        false,
      )
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) abort()
  })
}

/** Write a diagnostics zip in a short-lived worker and return its published path. */
export function exportDiagnosticsZip(
  logsDir: string,
  userDataDir: string,
  options: DiagnosticExportOptions,
): Promise<string> {
  const maxEvidenceBytes = options.maxEvidenceBytes ?? MAX_DIAGNOSTIC_EVIDENCE_BYTES
  if (!Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes <= 0) {
    return Promise.reject(new Error('dsh-plugin-desktop: diagnostic evidence byte limit must be a positive integer'))
  }
  if (options.appVersion.length === 0 || options.appVersion.length > 512 || /[\0\r\n]/u.test(options.appVersion)) {
    return Promise.reject(new Error('dsh-plugin-desktop: diagnostic app version must be a single non-empty line'))
  }

  const worker = new Worker(workerEntryUrl(), {
    name: 'dsh-diagnostic-export',
    workerData: {
      logsDir,
      userDataDir,
      appVersion: options.appVersion,
      maxEvidenceBytes,
      ...(options.crashDumpsDir === undefined ? {} : { crashDumpsDir: options.crashDumpsDir }),
      ...(options.runStatePath === undefined ? {} : { runStatePath: options.runStatePath }),
      ...(options.lifecycleEvidencePath === undefined ? {} : { lifecycleEvidencePath: options.lifecycleEvidencePath }),
      ...(options.selfCheck === undefined ? {} : { selfCheck: options.selfCheck }),
    },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  })
  return waitForDiagnosticExportWorker(worker, DIAGNOSTIC_EXPORT_TIMEOUT_MS, options.signal)
}

/** Export diagnostics directly from Desktop user data without booting Host, profiles, or a window. */
export function exportDesktopDiagnostics(
  userDataDir: string,
  options: DesktopDiagnosticExportOptions,
): Promise<string> {
  const logsDir = join(userDataDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  // The self-check assembles in THIS process, so the live in-memory SSO
  // session (when the exporting process is the authenticated Electron main)
  // reaches the report without ever touching disk; the token stays out by
  // construction — only email and source cross this seam.
  const ssoSession = getSsoSession()
  const selfCheck = options.selfCheck
    ?? assembleDesktopSelfCheckExport(userDataDir, options.appVersion, {
      ...(ssoSession === undefined
        ? {}
        : { ssoSession: { email: ssoSession.email, source: ssoSession.source } }),
    })
  return exportDiagnosticsZip(logsDir, userDataDir, {
    appVersion: options.appVersion,
    crashDumpsDir: options.crashDumpsDir ?? join(userDataDir, 'Crashpad'),
    runStatePath: join(userDataDir, 'crash-evidence', 'active-run.json'),
    lifecycleEvidencePath: desktopLifecycleEvidencePath(userDataDir),
    ...(options.maxEvidenceBytes === undefined ? {} : { maxEvidenceBytes: options.maxEvidenceBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    selfCheck,
  })
}
