import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DesktopWindowsPwshSandbox,
  adaptWindowsAclExecution,
  desktopWindowsPwshConfig,
  desktopWindowsPwshPath,
  normalizeSandboxEscalationCommand,
  sandboxEscalationCommandHash,
  sandboxEscalationDedupeKey,
  setDesktopSandboxEscalationSink,
  type DesktopSandboxInfo,
  type SandboxEscalationTelemetryEvent,
  type WindowsAclAdaptation,
} from '../src/windows-pwsh-sandbox.ts'

function shellSpec(env?: Record<string, string>): ShellExecSpec {
  return {
    command: 'Write-Output ok',
    workdir: 'C:\\workspace',
    timeoutMs: 60_000,
    stdoutMaxBytes: 64_000,
    sandboxPolicy: undefined,
    ...(env === undefined ? {} : { env }),
  }
}

const adaptation: WindowsAclAdaptation = {
  platform: 'win32',
  electron: true,
  execPath: 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
  upstreamRunner: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\runner.js',
  nodeExecutable: 'C:\\Program Files\\DSH Desktop\\resources\\node-runtime\\node.exe',
}

describe('Windows Electron PowerShell sandbox adaptation', () => {
  it('prefers stable Windows PowerShell locations over PATH-provided portable pwsh', () => {
    const programFilesPwsh = desktopWindowsPwshPath({
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows',
      PATH: 'D:\\AI-Agent\\tools\\pwsh',
    }, 'win32', path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

    expect(programFilesPwsh).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('keeps the regular Program Files PowerShell 7 install as the first Windows choice', () => {
    const programFilesPwsh = desktopWindowsPwshPath({
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows',
    }, 'win32', () => true)

    expect(programFilesPwsh).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('keeps explicit pwshPath config and non-Windows config unchanged', () => {
    const explicit = { cwd: 'C:\\workspace', pwshPath: 'D:\\tools\\pwsh\\pwsh.exe' }
    expect(desktopWindowsPwshConfig(explicit, {}, 'win32')).toBe(explicit)

    const nonWindows = { cwd: '/workspace' }
    expect(desktopWindowsPwshConfig(nonWindows, {}, 'darwin')).toBe(nonWindows)
  })

  it('defaults Windows sandbox config to a stable system PowerShell when available', () => {
    const result = desktopWindowsPwshConfig({ cwd: 'C:\\workspace' }, {
      ProgramFiles: 'C:\\missing',
      SystemRoot: 'C:\\Windows',
      PATH: 'D:\\portable\\pwsh',
    }, 'win32', path => path === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

    expect(result).toEqual({
      cwd: 'C:\\workspace',
      pwshPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    })
  })

  it('adapts only the exact Electron-hosted win32 ACL runner argv', () => {
    const env = Object.freeze({ KEEP: 'value' })
    const spec = Object.freeze(shellSpec(env))
    const argv = Object.freeze([
      adaptation.execPath,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
      '-Command',
      'Write-Output ok',
    ])

    const result = adaptWindowsAclExecution(spec, argv, adaptation)

    expect(result.spec).toBe(spec)
    expect(result.argv).toEqual([
      adaptation.nodeExecutable,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
      '-Command',
      'Write-Output ok',
    ])
    expect(result.spec.env).toEqual({ KEEP: 'value' })
    expect(spec.env).toBe(env)
    expect(argv).toEqual([
      adaptation.execPath,
      adaptation.upstreamRunner,
      '--workspace',
      'C:\\workspace',
      '--',
      'powershell.exe',
      '-Command',
      'Write-Output ok',
    ])
  })

  it.each([
    ['non-Windows host', { platform: 'darwin' as const }],
    ['plain Node host', { electron: false }],
    ['different executable', { execPath: 'C:\\other\\electron.exe' }],
    ['different runner', { upstreamRunner: 'C:\\other\\runner.js' }],
  ])('leaves a %s invocation and its object identities unchanged', (_label, override) => {
    const spec = shellSpec({ KEEP: 'value' })
    const argv = [adaptation.execPath, adaptation.upstreamRunner, '--', 'powershell.exe']

    const result = adaptWindowsAclExecution(spec, argv, { ...adaptation, ...override })

    expect(result.spec).toBe(spec)
    expect(result.argv).toBe(argv)
    expect(result.spec.env).toEqual({ KEEP: 'value' })
  })

  it('leaves the danger-full-access direct PowerShell argv unchanged', () => {
    const spec = shellSpec({ KEEP: 'value' })
    const argv = [
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Write-Output ok',
    ]

    const result = adaptWindowsAclExecution(spec, argv, adaptation)

    expect(result).toEqual({ spec, argv })
    expect(result.spec).toBe(spec)
    expect(result.argv).toBe(argv)
  })
})

// ---------------------------------------------------------------------------
// P16 sandbox-write-denial escalation (adapter run() override)
// ---------------------------------------------------------------------------

/** One fake pwsh settlement: denied runs match the fake provider's dialect. */
function fakeRunResult(denied: boolean): ShellRunResult {
  return {
    exitCode: denied ? 1 : 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 5_000,
    stdout: { text: '', truncated: false },
    stderr: { text: denied ? 'New-Item: Access is denied.' : '', truncated: false },
  }
}

/** A subprocess service that would throw if the fake executor ever spawned. */
class ThrowingSubprocessRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }

  spawn(): never {
    throw new Error('the escalation harness must not spawn a real process')
  }
}

/** The adapter under test with every escalation seam recorded and faked. */
class RecordingEscalationSandbox extends DesktopWindowsPwshSandbox {
  readonly runArgvCalls: Array<{ spec: ShellExecSpec, argv: readonly string[] }> = []
  readonly prompts: string[] = []
  readonly reports: SandboxEscalationTelemetryEvent[] = []
  letPromptApprove = true
  letPromptCanAsk = true
  private letDenied = true

  /** Force every confined run denied (or not) for one scenario. */
  denyEveryRun(denied: boolean): void {
    this.letDenied = denied
  }

  protected override async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    this.runArgvCalls.push({ spec, argv: [...argv] })
    const confined = spec.sandboxPolicy?.mode !== 'danger-full-access'
    return fakeRunResult(confined && this.letDenied)
  }

  protected override startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    this.runArgvCalls.push({ spec, argv: [...argv] })
    return {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
    }
  }

  protected override canPromptSandboxEscalation(): boolean {
    return this.letPromptCanAsk
  }

  protected override async promptSandboxEscalation(command: string): Promise<boolean> {
    this.prompts.push(command)
    return this.letPromptApprove
  }

  protected override reportSandboxEscalation(event: SandboxEscalationTelemetryEvent): void {
    this.reports.push(event)
    super.reportSandboxEscalation(event)
  }
}

interface EscalationHarness {
  executor: RecordingEscalationSandbox
  confineCalls: Array<{ argv: string[], policy: SandboxPolicy }>
  request(partial?: Partial<ShellExecRequest>): ShellExecRequest
  dispose(): void
}

const escalationContexts: Context[] = []

async function escalationHarness(): Promise<EscalationHarness> {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-desktop-escalation-'))
  const confineCalls: Array<{ argv: string[], policy: SandboxPolicy }> = []
  class FakeSandboxProvider extends SandboxProvider {
    override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
      confineCalls.push({ argv: [...argv], policy })
      return {
        argv: [...argv],
        enforcement: 'full',
        denialSignatures: ['access is denied', 'access to the path'],
        runnerFailureRules: [],
      }
    }
  }
  const ctx = new Context()
  escalationContexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workdir })
  await ctx.plugin(ThrowingSubprocessRuntime)
  await ctx.plugin(RecordingEscalationSandbox, { cwd: workdir, graceMs: 200 })
  return {
    executor: ctx.shell as unknown as RecordingEscalationSandbox,
    confineCalls,
    request: (partial = {}) => ({
      command: 'pip install requests',
      workdir,
      timeoutMs: 5_000,
      stdoutMaxBytes: 64_000,
      env: { KEEP: 'value' },
      ...partial,
    }),
    dispose: () => {
      rmSync(workdir, { recursive: true, force: true })
    },
  }
}

afterEach(async () => {
  setDesktopSandboxEscalationSink(undefined)
  await Promise.all(escalationContexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('sandbox escalation pure helpers', () => {
  it('normalizes command text for dedupe keys and hashes', () => {
    expect(normalizeSandboxEscalationCommand('  pip   install\r\n requests ')).toBe('pip install requests')
    expect(normalizeSandboxEscalationCommand('pip\tinstall\trequests')).toBe('pip install requests')
  })

  it('hashes the normalized command to 16 stable hex characters', () => {
    const hash = sandboxEscalationCommandHash('pip   install requests')
    expect(hash).toMatch(/^[0-9a-f]{16}$/u)
    expect(hash).toBe(sandboxEscalationCommandHash('pip install requests'))
    expect(hash).not.toBe(sandboxEscalationCommandHash('pip install urllib3'))
  })

  it('separates dedupe keys by session while collapsing identical command text', () => {
    expect(sandboxEscalationDedupeKey('  pip install requests ', 'session-a'))
      .toBe(sandboxEscalationDedupeKey('pip install\r\nrequests', 'session-a'))
    expect(sandboxEscalationDedupeKey('pip install requests', 'session-a'))
      .not.toBe(sandboxEscalationDedupeKey('pip install requests', 'session-b'))
    expect(sandboxEscalationDedupeKey('pip install requests', undefined))
      .toBe(sandboxEscalationDedupeKey('pip install requests', undefined))
  })
})

describe('sandbox write-denial escalation', () => {
  it('reruns the same spec unconfined after the user approves', async () => {
    const harness = await escalationHarness()
    try {
      const request = harness.request()
      const result = await harness.executor.run(harness.executor.resolve(request))

      // One prompt showing the verbatim command, one approval event, and a
      // rerun that reused the SAME spec under danger-full-access.
      expect(harness.executor.prompts).toEqual(['pip install requests'])
      expect(harness.executor.reports).toEqual([{
        commandHash: sandboxEscalationCommandHash('pip install requests'),
        outcome: 'approved',
        mode: 'workspace-write',
      }])
      expect(harness.executor.runArgvCalls).toHaveLength(2)
      const [deniedRun, rerun] = harness.executor.runArgvCalls
      expect(deniedRun?.spec.sandboxPolicy?.mode).toBe('workspace-write')
      expect(rerun?.spec.sandboxPolicy?.mode).toBe('danger-full-access')
      // The rerun must not re-derive the command: same text, same argv words.
      expect(rerun?.spec.command).toBe(deniedRun?.spec.command)
      expect(rerun?.argv).toEqual(deniedRun?.argv)
      expect(rerun?.spec.workdir).toBe(deniedRun?.spec.workdir)
      expect(rerun?.spec.timeoutMs).toBe(deniedRun?.spec.timeoutMs)
      expect(rerun?.spec.stdoutMaxBytes).toBe(deniedRun?.spec.stdoutMaxBytes)
      expect(rerun?.spec.env).toBe(deniedRun?.spec.env)
      // The rerun is NOT re-confined: the sandbox provider saw one call.
      expect(harness.confineCalls).toHaveLength(1)
      expect(result.exitCode).toBe(0)
      expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false, escalation: 'approved' })
    } finally {
      await harness.dispose()
    }
  })

  it('keeps the denied result and stamps rejected when the user refuses', async () => {
    const harness = await escalationHarness()
    harness.executor.letPromptApprove = false
    try {
      const result = await harness.executor.run(harness.executor.resolve(harness.request()))

      expect(harness.executor.runArgvCalls).toHaveLength(1)
      expect(result.exitCode).toBe(1)
      expect(result.stderr.text).toBe('New-Item: Access is denied.')
      expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full', escalation: 'rejected' })
      expect(harness.executor.reports).toEqual([{
        commandHash: sandboxEscalationCommandHash('pip install requests'),
        outcome: 'rejected',
        mode: 'workspace-write',
      }])
    } finally {
      await harness.dispose()
    }
  })

  it('keeps upstream behavior verbatim on a non-Electron (CLI) host', async () => {
    const harness = await escalationHarness()
    harness.executor.letPromptCanAsk = false
    try {
      const result = await harness.executor.run(harness.executor.resolve(harness.request()))

      expect(harness.executor.runArgvCalls).toHaveLength(1)
      expect(harness.executor.prompts).toEqual([])
      expect(harness.executor.reports).toEqual([])
      expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    } finally {
      await harness.dispose()
    }
  })

  it('prompts at most once per normalized command per session', async () => {
    const harness = await escalationHarness()
    try {
      await harness.executor.run(harness.executor.resolve(harness.request()))
      const second = await harness.executor.run(harness.executor.resolve(
        harness.request({ command: 'pip   install\r\n requests' }),
      ))

      expect(harness.executor.prompts).toEqual(['pip install requests'])
      expect(harness.executor.runArgvCalls).toHaveLength(3)
      expect(harness.executor.reports.map(report => report.outcome)).toEqual(['approved', 'suppressed'])
      expect(second.sandbox?.denied).toBe(true)
      expect((second.sandbox as DesktopSandboxInfo | undefined)?.escalation).toBeUndefined()

      // A different session may be asked again for the same command.
      const otherSession = await harness.executor.run(harness.executor.resolve(harness.request({
        sandboxPolicy: {
          mode: 'workspace-write',
          workspaceRoot: 'C:\\workspace',
          sessionId: 'session-b' as SessionId,
        },
      })))
      expect((otherSession.sandbox as DesktopSandboxInfo | undefined)?.escalation).toBe('approved')
      expect(harness.executor.prompts).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  it('never escalates a result that was not denied a write', async () => {
    const harness = await escalationHarness()
    harness.executor.denyEveryRun(false)
    try {
      const result = await harness.executor.run(harness.executor.resolve(harness.request()))

      expect(harness.executor.prompts).toEqual([])
      expect(harness.executor.runArgvCalls).toHaveLength(1)
      expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    } finally {
      await harness.dispose()
    }
  })

  it('never prompts on the background start path', async () => {
    const harness = await escalationHarness()
    try {
      const proc = harness.executor.start(harness.executor.resolve(harness.request()))

      expect(proc.status).toBe('running')
      expect(harness.executor.prompts).toEqual([])
      expect(harness.executor.reports).toEqual([])
      expect(harness.executor.runArgvCalls).toHaveLength(1)
      proc.kill()
    } finally {
      await harness.dispose()
    }
  })

  it('delivers decisions through the module telemetry sink', async () => {
    const events: SandboxEscalationTelemetryEvent[] = []
    setDesktopSandboxEscalationSink(event => { events.push(event) })
    const harness = await escalationHarness()
    try {
      await harness.executor.run(harness.executor.resolve(harness.request()))

      expect(events).toEqual([{
        commandHash: sandboxEscalationCommandHash('pip install requests'),
        outcome: 'approved',
        mode: 'workspace-write',
      }])
    } finally {
      await harness.dispose()
    }
  })
})
