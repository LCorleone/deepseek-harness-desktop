/** Electron adapter for the upstream Windows ACL PowerShell executor. */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { BrowserWindow, MessageBoxOptions } from 'electron'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecSpec, ShellProcess, ShellRunResult, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-local'
import { resolveDesktopNodeExecutable } from './desktop-node-runtime.ts'
import { revealWindow, type RevealableApplication } from './window-reveal.ts'

const UPSTREAM_RUNNER = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))

/** Inputs controlling one exact ACL-runner argv rewrite. */
export interface WindowsAclAdaptation {
  /** Host platform; only Windows is adapted. */
  platform: NodeJS.Platform
  /** Whether the current Host executable is Electron. */
  electron: boolean
  /** Current Electron executable path. */
  execPath: string
  /** Resolved upstream ACL runner path. */
  upstreamRunner: string
  /** Node command the adapted runner executes under. */
  nodeExecutable: string
}

/** Adapted execution inputs passed to the ordinary local executor. */
export interface AdaptedWindowsAclExecution {
  /** Spec unchanged from the upstream sandbox provider. */
  spec: ShellExecSpec
  /** Exact argv, with the bundled Node command running the ACL runner. */
  argv: readonly string[]
}

/** Windows PowerShell paths that do not depend on PATH-provided portable runtimes. Built with win32 semantics on every host so results are deterministic off Windows. */
export function desktopWindowsPwshPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (platform !== 'win32') return undefined
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  return candidates.find(candidate => exists(candidate))
}

/** Keep explicit user config, otherwise avoid PATH-resolved portable pwsh in the Windows ACL sandbox. */
export function desktopWindowsPwshConfig(
  config: PwshConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): PwshConfig {
  if (config.pwshPath !== undefined && config.pwshPath.length > 0) return config
  const pwshPath = desktopWindowsPwshPath(env, platform, exists)
  return pwshPath === undefined ? config : { ...config, pwshPath }
}

/**
 * Run the exact upstream ACL runner under the bundled Node command.
 * @param spec - resolved PowerShell execution spec.
 * @param argv - argv after the upstream sandbox provider has confined it.
 * @param adaptation - executable and runner identities for this Host.
 * @returns unchanged inputs for every non-runner call, otherwise the bundled-Node runner launch.
 */
export function adaptWindowsAclExecution(
  spec: ShellExecSpec,
  argv: readonly string[],
  adaptation: WindowsAclAdaptation,
): AdaptedWindowsAclExecution {
  const [program, runner, ...args] = argv
  if (adaptation.platform !== 'win32'
    || !adaptation.electron
    || program !== adaptation.execPath
    || runner !== adaptation.upstreamRunner) {
    return { spec, argv }
  }

  return {
    spec,
    argv: [adaptation.nodeExecutable, adaptation.upstreamRunner, ...args],
  }
}

/**
 * How one sandbox-write-denial escalation ended: the user approved an
 * unsandboxed rerun, rejected it, or the per-session prompt already ran for
 * the same normalized command and this denial was answered silently.
 */
export type SandboxEscalationOutcome = 'approved' | 'rejected' | 'suppressed'

/** Sandbox facts plus the desktop's escalation stamp on the returned result. */
export interface DesktopSandboxInfo extends ShellSandboxInfo {
  /** How the escalation flow answered this denial. */
  readonly escalation?: SandboxEscalationOutcome
}

/** `sandbox_escalation` telemetry facts; the command text itself never leaves the host. */
export interface SandboxEscalationTelemetryEvent {
  /** sha256 of the normalized command, first 16 hex characters. */
  readonly commandHash: string
  readonly outcome: SandboxEscalationOutcome
  /** Sandbox mode the denied run actually executed under. */
  readonly mode: SandboxMode
}

/** Telemetry sink the Electron launcher wires to the client-event collector. */
export type DesktopSandboxEscalationSink = (event: SandboxEscalationTelemetryEvent) => void

/**
 * One escalation answer: the user approved or rejected the unsandboxed
 * rerun, or the caller aborted while the dialog was still pending and the
 * question was settled as cancelled (the dialog's late reply is ignored).
 */
export type SandboxEscalationDecision = 'approved' | 'rejected' | 'cancelled'

/**
 * The native-window surface the escalation popup needs from one candidate
 * main window. Structural, so a real Electron `BrowserWindow` satisfies it
 * and tests can pass plain fakes (this module must not import `electron`
 * statically — CLI hosts load it too).
 */
export interface SandboxEscalationParentWindow {
  /** Whether the native window was already destroyed. */
  isDestroyed(): boolean
  /** Whether the window is minimized. */
  isMinimized(): boolean
  /** The window's loaded document URL. */
  readonly webContents: { readonly getURL: () => string }
  /** Un-minimize the window. */
  restore(): void
  /** Un-hide the window (a shell hidden to the tray included). */
  show(): void
  /** Bring the window to the front. */
  focus(): void
}

/** The app shell always loads from its loopback web server; every auxiliary
 * native window (agent browser, SSO gate, disclaimer, recovery, profile
 * creator) loads a `file://` document — see `desktopRendererUrl` and
 * `nativeUiDocumentUrl`. */
const SHELL_WINDOW_URL_PREFIX = 'http://127.0.0.1'

/**
 * Pick the desktop's main shell window to parent the escalation popup to.
 * A dialog attached to a hidden or minimized window is invisible with it
 * (b85: a tray-hidden shell swallowed the popup for the whole 120 s shell
 * command timeout), so the caller must also reveal the returned window before
 * asking. Destroyed windows and auxiliary `file://` windows never qualify;
 * `undefined` means no shell window exists and the caller falls back to a
 * parentless dialog. The Cordis loader builds this executor from composition
 * data, so it holds no reference to the shell generation/runtime that owns
 * the window: `BrowserWindow.getAllWindows()` plus the shell URL is the
 * available route, and the shell is the only window serving loopback.
 */
export function sandboxEscalationParentWindow(
  windows: readonly SandboxEscalationParentWindow[],
): SandboxEscalationParentWindow | undefined {
  return windows.find(window => !window.isDestroyed()
    && window.webContents.getURL().startsWith(SHELL_WINDOW_URL_PREFIX))
}

/** Reveal inputs for the escalation popup's parent window: the Electron `app`
 * handle (macOS a Cmd+H-hidden application must be shown before any window can
 * appear — b85) and the host platform. This module is loaded by CLI hosts
 * too, so it never imports `electron`; the caller hands the handle in. */
export interface SandboxEscalationRevealOptions {
  /** Electron `app` handle; `undefined` in non-Electron hosts. */
  readonly application?: RevealableApplication
  /** Host platform; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

/**
 * Ask one escalation question with the popup parented to the app's main shell
 * window, revealing that window first (app before window, then restore + show
 * + focus, through the same `revealWindow` policy `revealApplication` uses).
 * A dialog attached to a minimized or tray-hidden window is invisible with it,
 * so the question would sit unanswered until the shell command timeout (b85).
 * With no shell window at all, `ask` receives `undefined` and the caller falls
 * back to the parentless dialog.
 * @param windows - every open native window this host owns.
 * @param ask - the question; its `parent` is the revealed shell window, or `undefined` for the fallback.
 * @param reveal - the Electron `app` handle and platform to reveal with.
 * @returns the question's answer.
 */
export async function withSandboxEscalationParentWindow<Answer>(
  windows: readonly SandboxEscalationParentWindow[],
  ask: (parent: SandboxEscalationParentWindow | undefined) => Promise<Answer>,
  reveal: SandboxEscalationRevealOptions = {},
): Promise<Answer> {
  const parent = sandboxEscalationParentWindow(windows)
  if (parent === undefined) return await ask(undefined)
  revealWindow(reveal.application, parent, reveal.platform)
  return await ask(parent)
}

let sandboxEscalationSink: DesktopSandboxEscalationSink | undefined

/**
 * Wire (or clear) the process-wide escalation telemetry sink. The Cordis
 * loader constructs this executor from composition data, so the Electron
 * launcher hands the collector in through this module seam after boot.
 */
export function setDesktopSandboxEscalationSink(sink: DesktopSandboxEscalationSink | undefined): void {
  sandboxEscalationSink = sink
}

/** Normalize one command for dedupe keys and telemetry hashes: CRLF-safe
 * whitespace collapse — but only outside quotes. Whitespace inside a
 * quoted PowerShell argument stays verbatim, so two commands differing only
 * in quoted whitespace keep distinct dedupe keys and telemetry hashes. */
export function normalizeSandboxEscalationCommand(command: string): string {
  let normalized = ''
  let space = false
  let quote: '"' | "'" | undefined
  for (const character of command) {
    if (quote !== undefined) {
      normalized += character
      if (character === quote) quote = undefined
    } else if (character === '"' || character === "'") {
      if (space && normalized !== '') normalized += ' '
      space = false
      quote = character
      normalized += character
    } else if (/\s/u.test(character)) {
      space = true
    } else {
      if (space && normalized !== '') normalized += ' '
      space = false
      normalized += character
    }
  }
  return normalized
}

/** Telemetry identity of one command: sha256 of its normalized text, first 16 hex characters. */
export function sandboxEscalationCommandHash(command: string): string {
  return createHash('sha256').update(normalizeSandboxEscalationCommand(command), 'utf8').digest('hex').slice(0, 16)
}

/** Dedupe key: one prompt per normalized command per session (agentless denials share one bucket). */
export function sandboxEscalationDedupeKey(command: string, sessionId: string | undefined): string {
  return `${sessionId ?? 'agentless'}\u0000${normalizeSandboxEscalationCommand(command)}`
}

/** Stamp one escalation outcome onto a settled result without touching any other fact. */
function withEscalation(result: ShellRunResult, escalation: SandboxEscalationOutcome): ShellRunResult {
  if (result.sandbox === undefined) return result
  const sandbox: DesktopSandboxInfo = { ...result.sandbox, escalation }
  return { ...result, sandbox }
}

/** The escalation message box, shared by the parented and fallback paths. */
function sandboxEscalationMessageBoxOptions(command: string): MessageBoxOptions {
  return {
    type: 'warning',
    title: '沙箱拦截 / Sandbox blocked a write',
    message: '沙箱拒绝了这条命令的写入操作。',
    detail: `仅此一次允许它在无沙箱模式下重新运行吗？\n\n${command}\n\nA sandboxed command was denied a file write. Allow rerunning this exact command once without the sandbox?`,
    buttons: ['仅此一次允许 / Allow once', '拒绝 / Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

/**
 * Ask through the Electron main-process dialog whether one exact denied
 * command may rerun unsandboxed. The full command text is shown verbatim —
 * this is the one surface where the command appears outside the host.
 * The box is parented to the app's main shell window (revealed first when it
 * was minimized or hidden, b85) so it cannot sit invisibly behind a hidden
 * parent; with no window at all it falls back to the parentless dialog.
 * MessageBoxOptions carries no always-on-top flag; a parented box is modal
 * to its (now-focused) parent, which is the accepted visibility posture.
 */
async function electronSandboxEscalationPrompt(command: string): Promise<boolean> {
  const { app, BrowserWindow, dialog } = await import('electron')
  const options = sandboxEscalationMessageBoxOptions(command)
  return await withSandboxEscalationParentWindow(
    BrowserWindow.getAllWindows(),
    async parent => (parent === undefined
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent as BrowserWindow, options)).response === 0,
    { application: app },
  )
}

/** PowerShell sandbox provider that repairs only Electron-hosted Windows ACL launches.
 *
 * Besides the ACL launch repair it also owns the P16 sandbox-write-denial
 * escalation popup on `run()`. UPSTREAM CONTRACTS this override depends on
 * (replay this override when upgrading @deepseek-ai/* past 0.1.2):
 *
 * - `SandboxPwshExecutor.run(spec)` resolves `spec.sandboxPolicy`, routes
 *   `danger-full-access` specs straight to the local executor (no
 *   confinement), confines every other mode through `this.runArgv(spec,
 *   confined.argv)` (the seam this class adapts for the bundled-Node runner
 *   launch), and returns a buffered `ShellRunResult` whose `sandbox` carries
 *   `{ mode, denied, enforcement? }` — `denied` comes from the provider's
 *   denial-signature classification (Windows dialect includes
 *   'access is denied' / 'access to the path' / 'permission denied').
 * - A FATAL runner failure never returns: `run()` throws
 *   `SandboxUnavailableError` instead, so a returned `denied: true` result
 *   means the command ran and was denied a write. `sandbox.runnerFailed`
 *   exists only on the background `start()` path, which this class does not
 *   override — background jobs never escalate (no synchronous wait point).
 * - `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`
 *   (`@deepseek-ai/dsh-sandbox`); a spec re-run with
 *   `sandboxPolicy.mode = 'danger-full-access'` executes the SAME spec
 *   (command/workdir/env/timeout) unconfined, which is exactly the rerun
 *   used here — the command string is never re-parsed or re-joined.
 */
export class DesktopWindowsPwshSandbox extends SandboxPwshExecutor {
  /** Normalized-command keys already answered by the user this process,
   * namespaced by session. Only real decisions (approved/rejected) land
   * here: a cancelled prompt records nothing, so the agent's retry asks
   * again (b85 — the old mark-first dedup swallowed the retry's popup after
   * a shell command timeout cancellation and the install stuck forever). */
  private readonly promptedKeys = new Set<string>()

  /** Normalized-command keys with a prompt currently on screen. Guards
   * against two parallel identical denials opening stacked dialogs; cleared
   * when the prompt settles either way. */
  private readonly pendingPromptKeys = new Set<string>()

  /** Normalized-command keys whose suppressed denial was already reported.
   *
   * Repeated denials of one already-prompted command must not stream one
   * `suppressed` telemetry row each, so only the first suppression per
   * session per command is delivered; later ones are silent (the smallest
   * dedupe — no counter field was added to the event schema). */
  private readonly suppressedKeys = new Set<string>()

  constructor(ctx: ConstructorParameters<typeof SandboxPwshExecutor>[0], config: PwshConfig) {
    super(ctx, desktopWindowsPwshConfig(config, process.env, process.platform))
  }

  /** Whether this host can show the escalation popup (the Electron GUI). */
  protected canPromptSandboxEscalation(): boolean {
    return process.versions.electron !== undefined
  }

  /** Ask the user whether one exact denied command may rerun unsandboxed. */
  protected async promptSandboxEscalation(command: string): Promise<boolean> {
    return await electronSandboxEscalationPrompt(command)
  }

  /** Deliver one escalation decision to the telemetry sink. */
  protected reportSandboxEscalation(event: SandboxEscalationTelemetryEvent): void {
    sandboxEscalationSink?.(event)
  }

  /**
   * Wait for one escalation answer, settling 'cancelled' the moment the
   * caller's abort signal fires (the shell spec carries the tool call's
   * signal). Electron cannot dismiss a pending message box, so the abort
   * path races the dialog: this promise settles 'cancelled' immediately,
   * and the dialog's late reply — including a belated "Allow" — is ignored
   * and can never trigger an unsandboxed rerun the user may not have seen.
   */
  private async raceSandboxEscalationDecision(
    command: string,
    signal: AbortSignal | undefined,
  ): Promise<SandboxEscalationDecision> {
    if (signal?.aborted === true) return 'cancelled'
    const answer = this.promptSandboxEscalation(command)
      .then(approved => approved ? 'approved' as const : 'rejected' as const)
    if (signal === undefined) return await answer
    let onAbort: () => void = () => {}
    const cancelled = new Promise<'cancelled'>(resolve => {
      onAbort = () => { resolve('cancelled') }
    })
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Promise.race keeps `answer` handled, so a late dialog error after
      // cancellation cannot surface as an unhandled rejection.
      return await Promise.race([answer, cancelled])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Foreground run with the P16 write-denial escalation: a settled result
   * whose `sandbox.denied` is true (and whose runner did not fail) is first
   * offered to the user once per normalized command per session — approval
   * reruns the SAME spec under `danger-full-access`, rejection returns the
   * denied result stamped `escalation: 'rejected'`. Only a real user decision
   * consumes the per-session prompt: when the caller aborts while the dialog
   * is pending (shell command timeout / stop), the original denied result
   * returns unchanged, nothing is recorded, and a retry prompts again.
   * Non-Electron
   * (CLI) hosts, non-denied results, and already-prompted commands keep the
   * upstream behavior verbatim. Background `start()` is not overridden and
   * never escalates.
   */
  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const result = await super.run(spec)
    if (result.sandbox?.denied !== true || result.sandbox.runnerFailed === true) return result
    const policy = spec.sandboxPolicy
    if (policy === undefined) return result
    if (!this.canPromptSandboxEscalation()) return result
    const denied = result.sandbox
    const key = sandboxEscalationDedupeKey(spec.command, policy.sessionId)
    if (this.promptedKeys.has(key) || this.pendingPromptKeys.has(key)) {
      if (!this.suppressedKeys.has(key)) {
        this.suppressedKeys.add(key)
        this.reportSandboxEscalation({
          commandHash: sandboxEscalationCommandHash(spec.command),
          outcome: 'suppressed',
          mode: denied.mode,
        })
      }
      return result
    }
    this.pendingPromptKeys.add(key)
    let decision: SandboxEscalationDecision
    try {
      decision = await this.raceSandboxEscalationDecision(spec.command, spec.signal)
    } finally {
      this.pendingPromptKeys.delete(key)
    }
    if (decision === 'cancelled') return result
    this.promptedKeys.add(key)
    this.reportSandboxEscalation({
      commandHash: sandboxEscalationCommandHash(spec.command),
      outcome: decision,
      mode: denied.mode,
    })
    if (decision === 'rejected') return withEscalation(result, 'rejected')
    const escalated = await super.run({
      ...spec,
      sandboxPolicy: { ...policy, mode: 'danger-full-access' },
    })
    return withEscalation(escalated, 'approved')
  }

  private adapt(spec: ShellExecSpec, argv: readonly string[]): AdaptedWindowsAclExecution {
    return adaptWindowsAclExecution(spec, argv, {
      platform: process.platform,
      electron: process.versions.electron !== undefined,
      execPath: process.execPath,
      upstreamRunner: UPSTREAM_RUNNER,
      nodeExecutable: resolveDesktopNodeExecutable(import.meta.url, {
        platform: process.platform,
        environment: process.env,
      }),
    })
  }

  protected override async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    const adapted = this.adapt(spec, argv)
    return super.runArgv(adapted.spec, adapted.argv)
  }

  protected override startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    const adapted = this.adapt(spec, argv)
    return super.startArgv(adapted.spec, adapted.argv)
  }
}

export default DesktopWindowsPwshSandbox
