/** Electron adapter for the upstream Windows ACL PowerShell executor. */

import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecSpec, ShellProcess, ShellRunResult, ShellSandboxInfo } from '@deepseek-ai/dsh-shell'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-local'
import { resolveDesktopNodeExecutable } from './desktop-node-runtime.ts'

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

/**
 * Ask through the Electron main-process dialog whether one exact denied
 * command may rerun unsandboxed. The full command text is shown verbatim —
 * this is the one surface where the command appears outside the host.
 */
async function electronSandboxEscalationPrompt(command: string): Promise<boolean> {
  const { dialog } = await import('electron')
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: '沙箱拦截 / Sandbox blocked a write',
    message: '沙箱拒绝了这条命令的写入操作。',
    detail: `仅此一次允许它在无沙箱模式下重新运行吗？\n\n${command}\n\nA sandboxed command was denied a file write. Allow rerunning this exact command once without the sandbox?`,
    buttons: ['仅此一次允许 / Allow once', '拒绝 / Deny'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return result.response === 0
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
  /** Normalized-command keys already prompted this process, namespaced by session. */
  private readonly promptedKeys = new Set<string>()

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
   * Foreground run with the P16 write-denial escalation: a settled result
   * whose `sandbox.denied` is true (and whose runner did not fail) is first
   * offered to the user once per normalized command per session — approval
   * reruns the SAME spec under `danger-full-access`, rejection returns the
   * denied result stamped `escalation: 'rejected'`. Non-Electron (CLI) hosts,
   * non-denied results, and already-prompted commands keep the upstream
   * behavior verbatim. Background `start()` is not overridden and never
   * escalates.
   */
  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const result = await super.run(spec)
    if (result.sandbox?.denied !== true || result.sandbox.runnerFailed === true) return result
    const policy = spec.sandboxPolicy
    if (policy === undefined) return result
    if (!this.canPromptSandboxEscalation()) return result
    const denied = result.sandbox
    const key = sandboxEscalationDedupeKey(spec.command, policy.sessionId)
    if (this.promptedKeys.has(key)) {
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
    this.promptedKeys.add(key)
    const approved = await this.promptSandboxEscalation(spec.command)
    this.reportSandboxEscalation({
      commandHash: sandboxEscalationCommandHash(spec.command),
      outcome: approved ? 'approved' : 'rejected',
      mode: denied.mode,
    })
    if (!approved) return withEscalation(result, 'rejected')
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
