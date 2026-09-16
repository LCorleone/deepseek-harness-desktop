import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_SHARED_PYTHON_DIRECTORY_NAME,
  SHARED_PYTHON_WHEELS_LOCK_NAME,
  canonicalDistributionName,
  desktopSharedPythonEnvironmentPaths,
  desktopSharedPythonEnvironmentRoot,
  ensureDesktopSharedPythonEnvironment,
  missingSharedPythonDistributions,
  parseSharedPythonWheelsLock,
  resolveDesktopSharedPythonEnvironment,
  sharedPythonLibraryInstallArguments,
  type DesktopSharedPythonDistributionsProbe,
  type DesktopSharedPythonProvision,
  type DesktopSharedPythonProbe,
  type DesktopSharedPythonProvisionLock,
  type DesktopSharedPythonWheelsLockEntry,
} from '../src/desktop-shared-python-environment.ts'
import { resolveDesktopLocalPythonExecutable } from '../src/desktop-python-runtime.ts'

const BUNDLED_PYTHON = 'C:\\Program Files\\DSH Desktop\\resources\\python-runtime\\python.exe'
const LOCAL_PYTHON = 'C:\\Python312\\python.exe'
const STUB_DIRECTORY = 'C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps'
const REAL_DIRECTORY = 'C:\\Python312'

describe('shared python environment paths', () => {
  it('derives the environment layout below one parent directory', () => {
    expect(desktopSharedPythonEnvironmentPaths('C:\\Users\\Example\\AppData\\Local\\DSH Desktop')).toEqual({
      root: join('C:\\Users\\Example\\AppData\\Local\\DSH Desktop', DESKTOP_SHARED_PYTHON_DIRECTORY_NAME),
      scriptsDirectory: join('C:\\Users\\Example\\AppData\\Local\\DSH Desktop', DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts'),
      pythonExecutable: join('C:\\Users\\Example\\AppData\\Local\\DSH Desktop', DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts', 'python.exe'),
      pipExecutable: join('C:\\Users\\Example\\AppData\\Local\\DSH Desktop', DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts', 'pip.exe'),
    })
  })

  it('roots the environment under LOCALAPPDATA with an application-owned fallback', () => {
    expect(desktopSharedPythonEnvironmentRoot({ LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local' }, 'D:\\fallback'))
      .toBe(join('C:\\Users\\Example\\AppData\\Local', 'DSH Desktop'))
    expect(desktopSharedPythonEnvironmentRoot({ LOCALAPPDATA: '' }, 'D:\\fallback')).toBe('D:\\fallback')
    expect(desktopSharedPythonEnvironmentRoot({}, 'D:\\fallback')).toBe('D:\\fallback')
  })
})

describe('local python resolution for the shared environment base', () => {
  it('prefers a real PATH install over the WindowsApps store stub', () => {
    expect(resolveDesktopLocalPythonExecutable({
      platform: 'win32',
      environment: { PATH: `${STUB_DIRECTORY};${REAL_DIRECTORY}` },
      exists: filename => filename === join(REAL_DIRECTORY, 'python.exe') || filename === join(STUB_DIRECTORY, 'python.exe'),
    })).toBe(join(REAL_DIRECTORY, 'python.exe'))
  })

  it('resolves nothing when only the store stub exists, and never off Windows', () => {
    expect(resolveDesktopLocalPythonExecutable({
      platform: 'win32',
      environment: { PATH: STUB_DIRECTORY },
      exists: () => true,
    })).toBeUndefined()
    expect(resolveDesktopLocalPythonExecutable({
      platform: 'darwin',
      environment: { PATH: '/usr/bin' },
      exists: () => true,
    })).toBeUndefined()
  })
})

/** One provisioning seam recording every attempt against a mutable file set. */
function provisionRecorder(
  existing: Set<string>,
  options: { exitCode?: number, error?: Error, failCommands?: ReadonlySet<string>, diagnostic?: string } = {},
) {
  const calls: Array<{ command: string, args: readonly string[], environment: NodeJS.ProcessEnv | undefined }> = []
  const provision: DesktopSharedPythonProvision = async (command, args, provisionOptions) => {
    calls.push({ command, args, environment: provisionOptions.environment })
    if (options.error !== undefined) throw options.error
    const failed = (options.exitCode !== undefined && options.exitCode !== 0)
      || (options.failCommands?.has(command) ?? false)
    if (!failed) {
      existing.add(join(args[3] ?? '', 'Scripts', 'python.exe'))
      existing.add(join(args[3] ?? '', 'Scripts', 'pip.exe'))
    }
    return {
      exitCode: failed ? (options.exitCode ?? 1) : 0,
      diagnostic: failed ? (options.diagnostic ?? 'No module named virtualenv') : '',
    }
  }
  return { calls, provision }
}

/** One liveness-probe seam recording every probe and answering fixed health. */
function probeRecorder(runnable: boolean) {
  const calls: Array<{ pythonExecutable: string, environment: NodeJS.ProcessEnv | undefined }> = []
  const probe: DesktopSharedPythonProbe = async (pythonExecutable, options) => {
    calls.push({ pythonExecutable, environment: options.environment })
    return runnable
  }
  return { calls, probe }
}

describe('ensureDesktopSharedPythonEnvironment', () => {
  it('creates the environment from the preferred local base through stdlib venv --copies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-root-'))
    try {
      const existing = new Set<string>()
      const { calls, provision } = provisionRecorder(existing)

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => existing.has(filename),
      })

      // Exactly one provisioning attempt: the LOCAL interpreter seeds the
      // environment through the standard library (`-m venv` — a stock local
      // Python does not install the third-party `virtualenv` package),
      // writing only below the shared root.
      expect(calls.map(call => ({ command: call.command, args: call.args }))).toEqual([{
        command: LOCAL_PYTHON,
        args: ['-m', 'venv', '--copies', join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME)],
      }])
      expect(environment).toEqual({
        pythonExecutable: join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts', 'python.exe'),
        pipExecutable: join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts', 'pip.exe'),
        shared: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('seeds from the bundled interpreter when no local Python exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-root-'))
    try {
      const { calls, provision } = provisionRecorder(new Set<string>())

      await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: () => false,
      })

      expect(calls.map(call => call.command)).toEqual([BUNDLED_PYTHON])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is idempotent: a healthy existing environment is reused without provisioning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-root-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const { calls, provision } = provisionRecorder(new Set<string>())
      const { calls: probeCalls, probe } = probeRecorder(true)
      const removals: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        removeAll: directory => { removals.push(directory) },
        exists: filename => filename === paths.pythonExecutable || filename === paths.pipExecutable,
      })

      // Reuse requires the interpreter to actually run, not merely exist.
      expect(probeCalls.map(call => call.pythonExecutable)).toEqual([paths.pythonExecutable])
      expect(calls).toEqual([])
      expect(removals).toEqual([])
      expect(environment.shared).toBe(true)
      expect(environment.pythonExecutable).toBe(paths.pythonExecutable)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes and rebuilds a corrupt environment whose interpreter no longer runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-corrupt-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      // python.exe and pip.exe are present (a corrupt, not missing, env);
      // the rebuild re-adds both through the recorder on success.
      const existing = new Set<string>([paths.pythonExecutable, paths.pipExecutable])
      const { calls, provision } = provisionRecorder(existing)
      const { calls: probeCalls, probe } = probeRecorder(false)
      const removals: string[] = []
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        removeAll: directory => { removals.push(directory) },
        exists: filename => existing.has(filename),
        log: message => { logs.push(message) },
      })

      // A present-but-broken python.exe means corruption: delete the whole
      // pyenv directory once (logged) and provision from scratch.
      expect(probeCalls.map(call => call.pythonExecutable)).toEqual([paths.pythonExecutable])
      expect(removals).toEqual([paths.root])
      expect(calls.map(call => ({ command: call.command, args: call.args }))).toEqual([{
        command: LOCAL_PYTHON,
        args: ['-m', 'venv', '--copies', paths.root],
      }])
      expect(environment.shared).toBe(true)
      expect(environment.pythonExecutable).toBe(paths.pythonExecutable)
      expect(logs).toEqual([
        `dsh-plugin-desktop: the shared python environment at ${paths.root} held an interpreter `
          + 'that no longer runs; removed it and reprovisioning from scratch',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('repairs a runnable pip-less environment in place through ensurepip without removing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-pipless-repair-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      // Lucy's tree (#033): the interpreter exists and runs, pip.exe never
      // did — an older build accepted this as provisioning success.
      const existing = new Set<string>([paths.pythonExecutable])
      const { calls: probeCalls, probe } = probeRecorder(true)
      const calls: Array<{ command: string, args: readonly string[], environment: NodeJS.ProcessEnv | undefined }> = []
      const provision: DesktopSharedPythonProvision = async (command, args, provisionOptions) => {
        calls.push({ command, args, environment: provisionOptions.environment })
        expect(args).toEqual(['-m', 'ensurepip', '--upgrade'])
        existing.add(paths.pipExecutable)
        return { exitCode: 0, diagnostic: '' }
      }
      const removals: string[] = []
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        removeAll: directory => { removals.push(directory) },
        exists: filename => existing.has(filename),
        log: message => { logs.push(message) },
      })

      // Exactly one spawn — the tree's own interpreter running ensurepip —
      // bytecode-blind like every other spawn of this module; the tree is
      // kept (no removal, no reseed), pip gets published, one log line.
      expect(calls.map(call => ({ command: call.command, args: call.args }))).toEqual([{
        command: paths.pythonExecutable,
        args: ['-m', 'ensurepip', '--upgrade'],
      }])
      expect(calls[0]?.environment?.PYTHONDONTWRITEBYTECODE).toBe('1')
      expect(probeCalls.map(call => call.pythonExecutable)).toEqual([paths.pythonExecutable])
      expect(removals).toEqual([])
      expect(environment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('ran without pip')
      expect(logs[0]).toContain('repaired it in place through ensurepip')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('removes and rebuilds a pip-less environment whose ensurepip repair fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-pipless-rebuild-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const existing = new Set<string>([paths.pythonExecutable])
      const { probe } = probeRecorder(true)
      const calls: Array<{ command: string, args: readonly string[] }> = []
      const provision: DesktopSharedPythonProvision = async (command, args) => {
        calls.push({ command, args })
        if (args[1] === 'ensurepip') {
          return { exitCode: 1, diagnostic: 'No module named ensurepip' }
        }
        existing.add(paths.pythonExecutable)
        existing.add(paths.pipExecutable)
        return { exitCode: 0, diagnostic: '' }
      }
      const removals: string[] = []
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        removeAll: directory => { removals.push(directory) },
        exists: filename => existing.has(filename),
        log: message => { logs.push(message) },
      })

      // One bounded repair attempt, then the same removal-once + two-tier
      // reseed the corrupt tree takes — with the pip-less defect and the
      // ensurepip diagnostic named in the removal log line.
      expect(calls.map(call => ({ command: call.command, args: call.args }))).toEqual([
        { command: paths.pythonExecutable, args: ['-m', 'ensurepip', '--upgrade'] },
        { command: LOCAL_PYTHON, args: ['-m', 'venv', '--copies', paths.root] },
      ])
      expect(removals).toEqual([paths.root])
      expect(environment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('held a runnable interpreter but no pip')
      expect(logs[0]).toContain('the ensurepip repair failed: No module named ensurepip')
      expect(logs[0]).toContain('removed it and reprovisioning from scratch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades to the bundled aliases when an unrepairable pip-less environment cannot be removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-pipless-stuck-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const { probe } = probeRecorder(true)
      const calls: Array<{ command: string, args: readonly string[] }> = []
      const provision: DesktopSharedPythonProvision = async (command, args) => {
        calls.push({ command, args })
        return { exitCode: 1, diagnostic: 'No module named ensurepip' }
      }
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        removeAll: () => { throw new Error('EBUSY: locked by another process') },
        exists: filename => filename === paths.pythonExecutable,
        log: message => { logs.push(message) },
      })

      // Boot is never blocked: one repair attempt, one degradation line.
      expect(calls.map(call => call.args[1])).toEqual(['ensurepip'])
      expect(environment).toEqual({ pythonExecutable: BUNDLED_PYTHON, pipExecutable: undefined, shared: false })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('holds a runnable interpreter but no pip')
      expect(logs[0]).toContain('could not be removed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('heals an existing pip-less tree on one boot and reuses the healed tree on the next', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-pipless-boots-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      // The fleet's pre-fix state: a pip-less tree an older build left
      // behind (python runs, pip.exe never existed).
      const existing = new Set<string>([paths.pythonExecutable])
      const removals: string[] = []
      const provisionCalls: Array<{ command: string, args: readonly string[] }> = []
      const provision: DesktopSharedPythonProvision = async (command, args) => {
        provisionCalls.push({ command, args })
        expect(args[1]).toBe('ensurepip')
        existing.add(paths.pipExecutable)
        return { exitCode: 0, diagnostic: '' }
      }
      const { calls: probeCalls, probe } = probeRecorder(true)
      // main.ts runs the provisioning flow on EVERY boot (not first boot
      // only), so the exported seam stands in for two successive boots.
      const boot = () => ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        removeAll: directory => { removals.push(directory) },
        exists: filename => existing.has(filename),
      })

      const first = await boot()
      const second = await boot()

      // Boot 1 re-entered the pip-less tree instead of reusing it and
      // repaired it in place; boot 2 found python AND pip and reused the
      // healed tree without spawning anything or removing anything.
      expect(first).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      expect(second).toEqual(first)
      expect(provisionCalls).toHaveLength(1)
      expect(provisionCalls[0]).toEqual({
        command: paths.pythonExecutable,
        args: ['-m', 'ensurepip', '--upgrade'],
      })
      expect(probeCalls.map(call => call.pythonExecutable)).toEqual([paths.pythonExecutable, paths.pythonExecutable])
      expect(removals).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades to the bundled aliases when a corrupt environment cannot be removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-unremovable-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const { calls, provision } = provisionRecorder(new Set<string>())
      const { probe } = probeRecorder(false)
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        removeAll: () => { throw new Error('EBUSY: locked by another process') },
        exists: filename => filename === paths.pythonExecutable,
        log: message => { logs.push(message) },
      })

      // Nothing can be rebuilt into a directory that cannot be cleared.
      expect(calls).toEqual([])
      expect(environment).toEqual({ pythonExecutable: BUNDLED_PYTHON, pipExecutable: undefined, shared: false })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('could not be removed')
      expect(logs[0]).toContain('EBUSY')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs every provisioning and probe spawn bytecode-blind (PYTHONDONTWRITEBYTECODE)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-bytecode-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      // A corrupt present-but-broken env drives the probe path; the local
      // provisioning attempt fails so BOTH bases (local, bundled) spawn.
      const existing = new Set<string>([paths.pythonExecutable, paths.pipExecutable])
      const { calls, provision } = provisionRecorder(existing, {
        failCommands: new Set([LOCAL_PYTHON]),
        diagnostic: 'No module named venv',
      })
      const { calls: probeCalls, probe } = probeRecorder(false)

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        environment: { SENTINEL: 'inherited' },
        provision,
        probe,
        removeAll: () => {},
        exists: filename => existing.has(filename),
      })

      // Importing the bundled tree (site-packages/virtualenv) must never
      // write __pycache__ into it: the digest manifest verifies an exact
      // file set, and one unexpected bytecode file would disable the whole
      // python surface on the next boot. Both bases get the guard.
      expect(environment.shared).toBe(true)
      expect(calls.map(call => call.command)).toEqual([LOCAL_PYTHON, BUNDLED_PYTHON])
      for (const call of calls) {
        expect(call.environment?.PYTHONDONTWRITEBYTECODE).toBe('1')
        expect(call.environment?.SENTINEL).toBe('inherited')
      }
      expect(probeCalls[0]?.environment?.PYTHONDONTWRITEBYTECODE).toBe('1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retries with the bundled base when the local venv attempt fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-two-tier-'))
    try {
      const existing = new Set<string>()
      const { calls, provision } = provisionRecorder(existing, {
        failCommands: new Set([LOCAL_PYTHON]),
        diagnostic: 'No module named venv',
      })

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => existing.has(filename),
      })

      // Tier 1 (local stdlib venv) fails, so tier 2 seeds from the bundled
      // interpreter, whose tree ships virtualenv by construction.
      expect(calls.map(call => ({ command: call.command, args: call.args }))).toEqual([
        { command: LOCAL_PYTHON, args: ['-m', 'venv', '--copies', join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME)] },
        { command: BUNDLED_PYTHON, args: ['-m', 'virtualenv', '--always-copy', join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME)] },
      ])
      expect(environment).toEqual({
        pythonExecutable: join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts', 'python.exe'),
        pipExecutable: join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts', 'pip.exe'),
        shared: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls through to the bundled base when the local venv produces no pip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-pipless-tier-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const existing = new Set<string>()
      const calls: Array<{ command: string, args: readonly string[] }> = []
      const provision: DesktopSharedPythonProvision = async (command, args) => {
        calls.push({ command, args })
        if (command === LOCAL_PYTHON) {
          // Issue #033's producer: a base Python without the ensurepip
          // wheels exits 0 yet never writes pip.exe into the venv.
          existing.add(paths.pythonExecutable)
          return { exitCode: 0, diagnostic: '' }
        }
        existing.add(paths.pythonExecutable)
        existing.add(paths.pipExecutable)
        return { exitCode: 0, diagnostic: '' }
      }

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => existing.has(filename),
      })

      // The pip-less tier-1 tree is a failure now, not a success: tier 2
      // (bundled virtualenv, which ships pip by construction) takes over.
      expect(calls.map(call => ({ command: call.command, args: call.args }))).toEqual([
        { command: LOCAL_PYTHON, args: ['-m', 'venv', '--copies', paths.root] },
        { command: BUNDLED_PYTHON, args: ['-m', 'virtualenv', '--always-copy', paths.root] },
      ])
      expect(environment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades with the pip-less reason when every tier produces no pip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-pipless-all-'))
    try {
      const existing = new Set<string>()
      const provision: DesktopSharedPythonProvision = async (_command, args) => {
        // Every seeding run lands a pip-less tree.
        existing.add(join(args[3] ?? '', 'Scripts', 'python.exe'))
        return { exitCode: 0, diagnostic: '' }
      }
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => existing.has(filename),
        log: message => { logs.push(message) },
      })

      // Both tiers produced no pip: one degradation line naming the
      // ensurepip-wheels cause, bundled aliases, no pip published.
      expect(environment).toEqual({ pythonExecutable: BUNDLED_PYTHON, pipExecutable: undefined, shared: false })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('produced no pip')
      expect(logs[0]).toContain('base Python without ensurepip wheels')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('logs once and falls back to the bundled aliases when provisioning fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-root-'))
    try {
      const logs: string[] = []
      for (const options of [{ exitCode: 1 }, { error: new Error('spawn ENOENT') }] as const) {
        const { calls, provision } = provisionRecorder(new Set<string>(), options)

        const environment = await ensureDesktopSharedPythonEnvironment({
          platform: 'win32',
          localPythonExecutable: LOCAL_PYTHON,
          bundledPythonExecutable: BUNDLED_PYTHON,
          rootDirectory: root,
          provision,
          exists: () => false,
          log: message => { logs.push(message) },
        })

        // Today's behavior verbatim: bundled interpreter, no pip alias. Both
        // bases were attempted before degrading, and exactly one line logged.
        expect(environment).toEqual({ pythonExecutable: BUNDLED_PYTHON, pipExecutable: undefined, shared: false })
        expect(calls.map(call => call.command)).toEqual([LOCAL_PYTHON, BUNDLED_PYTHON])
      }
      expect(logs).toHaveLength(2)
      expect(logs[0]).toContain('the shared python environment at')
      expect(logs[0]).toContain('No module named virtualenv')
      expect(logs[1]).toContain('spawn ENOENT')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back when virtualenv reports success but no interpreter appeared', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-root-'))
    try {
      const { provision } = provisionRecorder(new Set<string>(), { exitCode: 0 })

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: () => false,
      })

      expect(environment).toEqual({ pythonExecutable: BUNDLED_PYTHON, pipExecutable: undefined, shared: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never provisions off Windows', async () => {
    const { calls, provision } = provisionRecorder(new Set<string>())

    const environment = await ensureDesktopSharedPythonEnvironment({
      platform: 'darwin',
      localPythonExecutable: undefined,
      bundledPythonExecutable: '/opt/python/python',
      rootDirectory: '/tmp/root',
      provision,
      exists: () => true,
    })

    expect(calls).toEqual([])
    expect(environment).toEqual({ pythonExecutable: '/opt/python/python', pipExecutable: undefined, shared: false })
  })
})

describe('resolveDesktopSharedPythonEnvironment', () => {
  it('publishes the shared surface only while its interpreter exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-resolve-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)

      expect(resolveDesktopSharedPythonEnvironment({
        platform: 'win32',
        rootDirectory: root,
        exists: filename => filename === paths.pythonExecutable,
      })).toEqual({ pythonExecutable: paths.pythonExecutable, pipExecutable: undefined, shared: true })

      expect(resolveDesktopSharedPythonEnvironment({
        platform: 'win32',
        rootDirectory: root,
        exists: () => false,
      })).toBeUndefined()

      expect(resolveDesktopSharedPythonEnvironment({
        platform: 'darwin',
        rootDirectory: root,
        exists: () => true,
      })).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('shared python environment provisioning mutex (review P3)', () => {
  /** A truly serializing lock seam that records entry/exit order. */
  function serializingLock(): {
    readonly lock: DesktopSharedPythonProvisionLock
    readonly events: string[]
  } {
    const events: string[] = []
    let tail: Promise<unknown> = Promise.resolve()
    const lock: DesktopSharedPythonProvisionLock = (lockPath, operation) => {
      // The chain covers the WHOLE locked section, not just the acquisition:
      // a contender's turn starts only after its predecessor's operation
      // settled — exactly the ordering the real lock file provides.
      const run = tail.then(() => {
        events.push(`enter ${lockPath}`)
        return operation()
      })
      tail = run.then(() => undefined, () => undefined)
      return run.finally(() => { events.push('exit') })
    }
    return { lock, events }
  }

  function deferredGate(): { promise: Promise<void>, open(): void } {
    let open!: () => void
    const promise = new Promise<void>(resolve => { open = resolve })
    return { promise, open }
  }

  it('serializes two concurrent instances: the loser waits and reuses the winner\u2019s environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-mutex-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const existing = new Set<string>()
      const gate = deferredGate()
      let released = false
      let inFlight = 0
      let maxInFlight = 0
      const provision: DesktopSharedPythonProvision = async (_command, args) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          // The winner's provisioning takes a while; the loser must not be
          // able to start its own while it runs.
          if (!released) await gate.promise
          existing.add(join(args[3] ?? '', 'Scripts', 'python.exe'))
          existing.add(join(args[3] ?? '', 'Scripts', 'pip.exe'))
          return { exitCode: 0, diagnostic: '' }
        } finally {
          inFlight -= 1
        }
      }
      const { lock, events } = serializingLock()
      const options = () => ({
        platform: 'win32' as const,
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        provisionLock: lock,
        // Both instances accept the winner's interpreter as runnable, so the
        // loser's decision is made purely on existence inside its own turn.
        probe: async () => true,
        exists: (filename: string) => existing.has(filename),
      })

      const first = ensureDesktopSharedPythonEnvironment(options())
      // Let the winner reach its provisioning before the loser starts.
      await new Promise(resolve => { setImmediate(resolve) })
      const second = ensureDesktopSharedPythonEnvironment(options())
      await new Promise(resolve => { setImmediate(resolve) })
      released = true
      gate.open()

      const [firstEnvironment, secondEnvironment] = await Promise.all([first, second])
      // Exactly one provisioning run, never two in flight at once.
      expect(maxInFlight).toBe(1)
      // The loser found the winner's interpreter on its locked turn and
      // reused it instead of rebuilding (or corrupting) the same tree.
      expect(firstEnvironment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      expect(secondEnvironment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      expect(secondEnvironment.shared).toBe(true)
      expect(events.filter(event => event.startsWith('enter'))).toHaveLength(2)
      expect(events).toEqual(['enter ' + join(root, 'pyenv.provision'), 'exit', 'enter ' + join(root, 'pyenv.provision'), 'exit'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('degrades to the bundled aliases when the mutex wait expires instead of blocking the boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-mutex-timeout-'))
    try {
      const logs: string[] = []
      const provision = vi.fn(async () => ({ exitCode: 0, diagnostic: '' }))
      let refusals = 0
      const refused: DesktopSharedPythonProvisionLock = async () => {
        // The defined contention-timeout failure: a plain `Error` with no
        // errno `code`, so the #038 retry must not apply to it.
        refusals += 1
        throw new Error('atomic-write: timed out waiting for the writer lock')
      }

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        provisionLock: refused,
        exists: () => false,
        log: message => { logs.push(message) },
      })

      expect(environment).toEqual({
        pythonExecutable: BUNDLED_PYTHON,
        pipExecutable: undefined,
        shared: false,
      })
      expect(provision).not.toHaveBeenCalled()
      // The timeout path degrades immediately — exactly one refusal, no
      // retry, no lock-less second attempt.
      expect(refusals).toBe(1)
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('could not serialize the shared python environment provisioning')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Lucy's lock-layer failure (#038): an errno-coded ENOENT from the mutex's exclusive-create open. */
  function enoentLockFailure(lockPath: string): NodeJS.ErrnoException {
    return Object.assign(
      new Error(`ENOENT: no such file or directory, open '${lockPath}.lock'`),
      { code: 'ENOENT' },
    )
  }

  it('still heals a pip-less tree when the lock layer fails once with ENOENT (#038)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-lock-enoent-once-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      // The #033 fleet state (a runnable tree without pip) behind a lock
      // layer whose first acquisition throws ENOENT: pre-#038 this skipped
      // the whole body and the self-heal never ran.
      const existing = new Set<string>([paths.pythonExecutable])
      const { probe } = probeRecorder(true)
      const provisionCalls: Array<{ command: string, args: readonly string[] }> = []
      const provision: DesktopSharedPythonProvision = async (command, args) => {
        provisionCalls.push({ command, args })
        existing.add(paths.pipExecutable)
        return { exitCode: 0, diagnostic: '' }
      }
      const lockPaths: string[] = []
      const flaky: DesktopSharedPythonProvisionLock = async (lockMarkerPath, operation) => {
        lockPaths.push(lockMarkerPath)
        if (lockPaths.length === 1) throw enoentLockFailure(lockMarkerPath)
        return await operation()
      }
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        probe,
        provisionLock: flaky,
        exists: filename => existing.has(filename),
        log: message => { logs.push(message) },
      })

      // One bounded retry reacquired the mutex, the ensurepip repair ran
      // inside it, and exactly one line notes the transient failure.
      expect(lockPaths).toHaveLength(2)
      expect(provisionCalls.map(call => ({ command: call.command, args: call.args }))).toEqual([{
        command: paths.pythonExecutable,
        args: ['-m', 'ensurepip', '--upgrade'],
      }])
      expect(environment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      // Two lines: the repair log of the provisioning body itself, then
      // the retry note (logged once the reacquired lock released).
      expect(logs).toHaveLength(2)
      expect(logs[0]).toContain('repaired it in place through ensurepip')
      expect(logs[1]).toContain('failed once')
      expect(logs[1]).toContain('ENOENT')
      expect(logs[1]).toContain('the retry acquired it')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('provisions without the cross-process lock when ENOENT outlasts the retry (#038)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-lock-enoent-always-'))
    try {
      // Every acquisition fails with ENOENT: the first attempt, then the
      // single retry — the cycle must still provision, unlocked.
      const existing = new Set<string>()
      const { calls, provision } = provisionRecorder(existing)
      let lockCalls = 0
      const enoent: DesktopSharedPythonProvisionLock = async (lockMarkerPath) => {
        lockCalls += 1
        throw enoentLockFailure(lockMarkerPath)
      }
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        provisionLock: enoent,
        exists: filename => existing.has(filename),
        log: message => { logs.push(message) },
      })

      // First attempt plus exactly one retry, then the lock-less run built
      // the tree anyway under one loud warning naming the lock error.
      expect(lockCalls).toBe(2)
      expect(calls.map(call => call.command)).toEqual([BUNDLED_PYTHON])
      expect(environment.shared).toBe(true)
      expect(environment.pipExecutable).toBe(join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME, 'Scripts', 'pip.exe'))
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('could not acquire the shared python environment provisioning lock')
      expect(logs[0]).toContain('ENOENT')
      expect(logs[0]).toContain('even after one retry')
      expect(logs[0]).toContain('WITHOUT the cross-process lock')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('creates the lock parent directory before acquiring, so a missing parent cannot fail the first acquisition (#038)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-pyenv-lock-parent-'))
    try {
      // The first-boot shape: `%LOCALAPPDATA%\DSH Desktop` does not exist
      // yet, and only the provisioning INSIDE the lock would create it. The
      // default lock (the real withFileLock) must acquire against the
      // mkdir'd parent instead of failing the open with ENOENT.
      const root = join(base, 'DSH Desktop')
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const existing = new Set<string>()
      const { calls, provision } = provisionRecorder(existing)
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => existing.has(filename),
        log: message => { logs.push(message) },
      })

      // First acquisition succeeded (no lock-layer line — a lock failure
      // would have logged on the retry path), the tree was seeded once,
      // and the parent now exists.
      expect(calls.map(call => call.command)).toEqual([BUNDLED_PYTHON])
      expect(environment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      expect(logs).toEqual([])
      expect(existsSync(root)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('breaks a crash-left default lock by age when its PID offers no liveness proof (review P3-2)', async () => {
    // An unparseable PID (an interrupted write) and an empty file (a `wx`
    // create whose write has not landed) prove nothing either way, so the
    // mtime gate still decides for them.
    for (const content of ['1234x\n', '']) {
      const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-mutex-stale-'))
      try {
        const paths = desktopSharedPythonEnvironmentPaths(root)
        // A lock file 21 minutes old: no live holder can still own it (the
        // worst legitimate hold is ~16 minutes since the #043 batch C wheel
        // install and its revalidation probe joined the cycle, so the stale
        // gate is 20 minutes), so the next boot must break it and provision
        // rather than degrade behind a ghost.
        const lockPath = join(root, 'pyenv.provision.lock')
        writeFileSync(lockPath, content)
        const now = Date.parse('2026-09-11T01:00:00.000Z')
        const stale = new Date(now - 21 * 60 * 1000)
        utimesSync(lockPath, stale, stale)
        const existing = new Set<string>()
        const { calls, provision } = provisionRecorder(existing)

        const environment = await ensureDesktopSharedPythonEnvironment({
          platform: 'win32',
          localPythonExecutable: undefined,
          bundledPythonExecutable: BUNDLED_PYTHON,
          rootDirectory: root,
          provision,
          now: () => now,
          exists: filename => existing.has(filename),
        })

        expect(calls, content).toHaveLength(1)
        expect(environment).toEqual({
          pythonExecutable: paths.pythonExecutable,
          pipExecutable: paths.pipExecutable,
          shared: true,
        })
        // The broken ghost lock itself is gone after the cycle.
        expect(existsSync(lockPath)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('reclaims a crash-left lock on sight when its recorded holder PID is dead (review P3-2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-mutex-dead-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      // The lock is FRESH (just written), so the age gate has not passed and
      // only the liveness check can reclaim it — the shape a relaunch within
      // 20 minutes of a mid-provision crash finds. The PID belongs to a child
      // this test already reaped, so it is provably gone.
      const lockPath = join(root, 'pyenv.provision.lock')
      const deadHolder = spawnSync(process.execPath, ['-e', '']).pid ?? -1
      expect(deadHolder).toBeGreaterThan(0)
      writeFileSync(lockPath, `${deadHolder}\n`)
      const existing = new Set<string>()
      const { calls, provision } = provisionRecorder(existing)

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => existing.has(filename),
      })

      expect(calls).toHaveLength(1)
      expect(environment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an alive holder\u2019s fresh lock to the age gate (review P3-2)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-mutex-live-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      // This process is trivially alive and the lock is fresh: the liveness
      // check must NOT reclaim it (only ESRCH proves death), so the boot
      // contends on the lock exactly as before.
      const lockPath = join(root, 'pyenv.provision.lock')
      writeFileSync(lockPath, `${process.pid}\n`)
      const existing = new Set<string>()
      const { calls, provision } = provisionRecorder(existing)

      const boot = ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: undefined,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => existing.has(filename),
      })
      // The boot is blocked on the live holder: no provisioning started and
      // the holder's lock file is still in place.
      await new Promise(resolve => { setTimeout(resolve, 150) })
      expect(calls).toEqual([])
      expect(existsSync(lockPath)).toBe(true)

      // The holder then exits; the next bounded acquisition retry proceeds.
      rmSync(lockPath, { force: true })
      const environment = await boot
      expect(calls).toHaveLength(1)
      expect(environment).toEqual({
        pythonExecutable: paths.pythonExecutable,
        pipExecutable: paths.pipExecutable,
        shared: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('shared python environment preinstalled library set (issue #043 batch C)', () => {
  /** Three pinned entries with valid-shape 64-hex checksums. */
  const LOCK_ENTRIES: readonly DesktopSharedPythonWheelsLockEntry[] = [
    { name: 'pdfplumber', version: '0.11.10', filename: 'pdfplumber-0.11.10-py3-none-any.whl', sha256: 'a'.repeat(64) },
    { name: 'pyyaml', version: '6.0.3', filename: 'pyyaml-6.0.3-cp312-cp312-win_amd64.whl', sha256: 'b'.repeat(64) },
    { name: 'requests', version: '2.34.2', filename: 'requests-2.34.2-py3-none-any.whl', sha256: 'c'.repeat(64) },
  ]
  const LOCK_TEXT = `${JSON.stringify({ version: 1, python: '3.12', platform: 'win_amd64', distributions: LOCK_ENTRIES })}\n`
  const WHEELS_DIRECTORY = 'C:\\Program Files\\DSH Desktop\\resources\\python-wheels'

  /** Digest seam answering each wheel's own pinned sha256. */
  const lockDigest = (filename: string): string =>
    LOCK_ENTRIES.find(entry => join(WHEELS_DIRECTORY, entry.filename) === filename)?.sha256 ?? '0'.repeat(64)

  /** Answer queue for the installed-distributions probe: one answer per spawn. */
  function distributionsProbeRecorder(answers: ReadonlyArray<Record<string, string> | undefined>) {
    const calls: Array<{ pythonExecutable: string, environment: NodeJS.ProcessEnv | undefined }> = []
    let index = 0
    const probeDistributions: DesktopSharedPythonDistributionsProbe = async (pythonExecutable, options) => {
      calls.push({ pythonExecutable, environment: options.environment })
      const answer = answers[Math.min(index, answers.length - 1)]
      index += 1
      return answer === undefined ? undefined : { ...answer }
    }
    return { calls, probeDistributions }
  }

  /** Recording library-install seam answering a fixed outcome. */
  function installRecorder(outcome: { exitCode: number | null, diagnostic?: string } = { exitCode: 0 }) {
    const calls: Array<{ command: string, args: readonly string[], environment: NodeJS.ProcessEnv | undefined }> = []
    const installDistributions: DesktopSharedPythonProvision = async (command, args, options) => {
      calls.push({ command, args, environment: options.environment })
      return { exitCode: outcome.exitCode, diagnostic: outcome.diagnostic ?? '' }
    }
    return { calls, installDistributions }
  }

  /** A healthy shared tree plus the full library-repair input set. */
  function libraryFixture() {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-libs-'))
    const paths = desktopSharedPythonEnvironmentPaths(root)
    const existing = new Set<string>([paths.pythonExecutable, paths.pipExecutable])
    const { calls: probeCalls, probe } = probeRecorder(true)
    return {
      root,
      paths,
      existing,
      probe,
      probeCalls,
      baseInputs: () => ({
        platform: 'win32' as const,
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        probe,
        exists: (filename: string) => existing.has(filename),
      }),
    }
  }

  it('parses a well-formed lock and degrades every malformed input to undefined', () => {
    expect(parseSharedPythonWheelsLock(LOCK_TEXT)?.distributions.map(entry => entry.name))
      .toEqual(['pdfplumber', 'pyyaml', 'requests'])
    const malformed = [
      '{',
      '[]',
      JSON.stringify({ version: 1, python: '3.12', platform: 'win_amd64', distributions: [] }),
      JSON.stringify({ version: 1, python: '3.12', platform: 'win_amd64', distributions: [{ name: 'x' }] }),
      JSON.stringify({ version: 1, python: '3.12', platform: 'win_amd64', distributions: [{ name: 'x', version: '1', filename: 'x.tar.gz', sha256: 'a'.repeat(64) }] }),
      JSON.stringify({ version: 1, python: '3.12', platform: 'win_amd64', distributions: [{ name: 'x', version: '1', filename: 'x-1-py3-none-any.whl', sha256: 'short' }] }),
      // Duplicate names after canonicalization are ambiguous input.
      JSON.stringify({
        version: 1,
        python: '3.12',
        platform: 'win_amd64',
        distributions: [
          { name: 'x', version: '1', filename: 'x-1-py3-none-any.whl', sha256: 'a'.repeat(64) },
          { name: 'X', version: '2', filename: 'X-2-py3-none-any.whl', sha256: 'b'.repeat(64) },
        ],
      }),
    ]
    for (const text of malformed) expect(parseSharedPythonWheelsLock(text), text).toBeUndefined()
  })

  it('computes the missing set ensure-present style: any version counts, names normalize', () => {
    expect(canonicalDistributionName('PyYAML')).toBe('pyyaml')
    expect(canonicalDistributionName('python_dateutil')).toBe('python-dateutil')
    const installed = { PyYAML: '5.3', requests: '2.25.0 (user-downgraded)' }
    const missing = missingSharedPythonDistributions(LOCK_ENTRIES, installed)
    // pyyaml (different case) and requests (any version, even an odd one)
    // count as present; only the truly absent name is missing.
    expect(missing.map(entry => entry.name)).toEqual(['pdfplumber'])
    expect(missingSharedPythonDistributions(LOCK_ENTRIES, {
      pdfplumber: '0.11.0',
      pyyaml: '6.0.3',
      requests: '2.34.2',
    })).toEqual([])
  })

  it('builds the strictly offline pip invocation over the missing set', () => {
    const missing = LOCK_ENTRIES.slice(0, 2)
    expect(sharedPythonLibraryInstallArguments(WHEELS_DIRECTORY, missing)).toEqual([
      '-m', 'pip', 'install',
      '--disable-pip-version-check',
      '--no-index',
      '--no-deps',
      '--no-warn-script-location',
      '--no-compile',
      join(WHEELS_DIRECTORY, 'pdfplumber-0.11.10-py3-none-any.whl'),
      join(WHEELS_DIRECTORY, 'pyyaml-6.0.3-cp312-cp312-win_amd64.whl'),
    ])
  })

  it('names verified wheel files by absolute path so pip never scans the directory', () => {
    const missing = LOCK_ENTRIES.slice(0, 2)
    const args = sharedPythonLibraryInstallArguments(WHEELS_DIRECTORY, missing)
    // Review P2-a: a directory argument (e.g. `--find-links <dir>`) would let
    // pip resolve a differently-named same-version wheel planted beside the
    // verified set (x-1.0-99-py3-none-any.whl wins for x==1.0). Passing the
    // verified wheel files themselves leaves pip no directory to scan, so the
    // ONLY wheel-shaped arguments are the locked filenames.
    expect(args).not.toContain('--find-links')
    expect(args).not.toContain(WHEELS_DIRECTORY)
    expect(args.filter(argument => argument.endsWith('.whl'))).toEqual(missing.map(
      entry => join(WHEELS_DIRECTORY, entry.filename),
    ))
  })

  it('installs only the missing pinned libraries on first provisioning, verified against the lock', async () => {
    const fixture = libraryFixture()
    try {
      const { calls: probeCalls, probeDistributions } = distributionsProbeRecorder([
        { PyYAML: '6.0.3' },
        // The install leg re-runs the probe inside its own lock hold before
        // building pip's argv (review P3-1); nothing changed in between.
        { PyYAML: '6.0.3' },
        { pdfplumber: '0.11.10', pyyaml: '6.0.3', requests: '2.34.2' },
      ])
      const { calls: installCalls, installDistributions } = installRecorder()
      const digested: string[] = []
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions,
        digestFile: filename => {
          digested.push(filename)
          return lockDigest(filename)
        },
        log: message => { logs.push(message) },
      })

      // One probe named the missing set, the install leg revalidated it, every
      // consumed wheel was verified against its pinned sha256, one strictly
      // offline pip run installed exactly the missing pins, and a fresh probe
      // set the coverage counts.
      expect(probeCalls.map(call => call.pythonExecutable)).toEqual([
        fixture.paths.pythonExecutable,
        fixture.paths.pythonExecutable,
        fixture.paths.pythonExecutable,
      ])
      for (const call of probeCalls) expect(call.environment?.PYTHONDONTWRITEBYTECODE).toBe('1')
      expect(digested).toEqual([join(WHEELS_DIRECTORY, 'pdfplumber-0.11.10-py3-none-any.whl'), join(WHEELS_DIRECTORY, 'requests-2.34.2-py3-none-any.whl')])
      expect(installCalls).toEqual([{
        command: fixture.paths.pythonExecutable,
        args: sharedPythonLibraryInstallArguments(WHEELS_DIRECTORY, LOCK_ENTRIES.filter((_, index) => index !== 1)),
        environment: installCalls[0]?.environment,
      }])
      expect(installCalls[0]?.environment?.PYTHONDONTWRITEBYTECODE).toBe('1')
      expect(environment.libraries).toEqual({ pinned: 3, installed: 3 })
      expect(logs).toEqual([
        `dsh-plugin-desktop: installed 2 missing preinstalled python libraries into the shared python environment at ${fixture.paths.root} from ${WHEELS_DIRECTORY}`,
      ])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('is idempotent: a healthy second boot probes once and never runs pip', async () => {
    const fixture = libraryFixture()
    try {
      const { calls: probeCalls, probeDistributions } = distributionsProbeRecorder([
        { pdfplumber: '0.11.10', PyYAML: '6.0.3', requests: '2.34.2' },
      ])
      const { calls: installCalls, installDistributions } = installRecorder()
      const logs: string[] = []
      const inputs = () => ({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions,
        digestFile: () => { throw new Error('a healthy boot hashes nothing') },
        log: (message: string) => { logs.push(message) },
      })

      const first = await ensureDesktopSharedPythonEnvironment(inputs())
      const second = await ensureDesktopSharedPythonEnvironment(inputs())

      expect(first.libraries).toEqual({ pinned: 3, installed: 3 })
      expect(second.libraries).toEqual({ pinned: 3, installed: 3 })
      expect(probeCalls).toHaveLength(2)
      expect(installCalls).toEqual([])
      expect(logs).toEqual([])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('skips pip entirely when a wheel fails its pinned checksum', async () => {
    const fixture = libraryFixture()
    try {
      const { probeDistributions } = distributionsProbeRecorder([{ pyyaml: '6.0.3' }])
      const { calls: installCalls, installDistributions } = installRecorder()
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions,
        digestFile: () => 'f'.repeat(64),
        log: message => { logs.push(message) },
      })

      // A tampered wheel must never reach pip — the repair skips with the
      // coverage counts of the untouched tree and one log line.
      expect(installCalls).toEqual([])
      expect(environment.libraries).toEqual({ pinned: 3, installed: 1 })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('failed their pinned checksums')
      expect(logs[0]).toContain('pdfplumber-0.11.10-py3-none-any.whl')
      expect(logs[0]).toContain('requests-2.34.2-py3-none-any.whl')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('degrades with a recount when pip itself fails, and never blocks the boot', async () => {
    const fixture = libraryFixture()
    try {
      const { probeDistributions } = distributionsProbeRecorder([
        { pyyaml: '6.0.3' },
        // The install leg's revalidation sees the same pre-pip tree (P3-1).
        { pyyaml: '6.0.3' },
        // pip half-succeeded before dying: pdfplumber landed, requests did not.
        { pdfplumber: '0.11.10', pyyaml: '6.0.3' },
      ])
      const { calls: installCalls, installDistributions } = installRecorder({ exitCode: 1, diagnostic: 'disk full' })
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions,
        digestFile: lockDigest,
        log: message => { logs.push(message) },
      })

      expect(installCalls).toHaveLength(1)
      expect(environment.shared).toBe(true)
      expect(environment.libraries).toEqual({ pinned: 3, installed: 2 })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('pip could not install the 2 missing')
      expect(logs[0]).toContain('disk full')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('omits the libraries fact when the probe or the lock cannot answer', async () => {
    const fixture = libraryFixture()
    try {
      const logs: string[] = []
      const { calls: installCalls, installDistributions } = installRecorder()

      const probed = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions: async () => undefined,
        installDistributions,
        log: message => { logs.push(message) },
      })
      expect(probed.libraries).toBeUndefined()
      expect(installCalls).toEqual([])

      const unlocked = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => undefined,
        log: message => { logs.push(message) },
      })
      expect(unlocked.libraries).toBeUndefined()

      const malformed = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => '{',
        log: message => { logs.push(message) },
      })
      expect(malformed.libraries).toBeUndefined()
      expect(logs).toHaveLength(3)
      expect(logs[0]).toContain('could not be probed')
      expect(logs[1]).toContain(`${join(WHEELS_DIRECTORY, SHARED_PYTHON_WHEELS_LOCK_NAME)} is unavailable`)
      expect(logs[2]).toContain(`${join(WHEELS_DIRECTORY, SHARED_PYTHON_WHEELS_LOCK_NAME)} is unavailable`)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('never consults the wheel set when no wheels directory is wired', async () => {
    const fixture = libraryFixture()
    try {
      const probeDistributions: DesktopSharedPythonDistributionsProbe = async () => {
        throw new Error('the probe must not run without a wheel set')
      }
      const { calls: installCalls, installDistributions } = installRecorder()

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        probeDistributions,
        installDistributions,
      })

      expect(environment.libraries).toBeUndefined()
      expect(installCalls).toEqual([])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('runs the library repair inside the provisioning mutex', async () => {
    const fixture = libraryFixture()
    try {
      const { probeDistributions } = distributionsProbeRecorder([{}])
      const installHeldLock: boolean[] = []
      let lockHeld = false
      const lock: DesktopSharedPythonProvisionLock = async (_lockPath, operation) => {
        lockHeld = true
        try {
          return await operation()
        } finally {
          lockHeld = false
        }
      }

      await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        provisionLock: lock,
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions: async (_command, _args) => {
          installHeldLock.push(lockHeld)
          return { exitCode: 0, diagnostic: '' }
        },
        digestFile: lockDigest,
      })

      // pip only ever ran while the cross-process mutex was held, so two
      // desktop instances can never install into the same tree at once.
      expect(installHeldLock).toEqual([true])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('defers the pip leg to a background repair behind the same mutex (review P2-b)', async () => {
    const fixture = libraryFixture()
    try {
      const { probeDistributions } = distributionsProbeRecorder([
        { pyyaml: '6.0.3' },
        // The background leg re-probes the plan before pip runs (review P3-1).
        { pyyaml: '6.0.3' },
        { pdfplumber: '0.11.10', pyyaml: '6.0.3', requests: '2.34.2' },
      ])
      const installHeldLock: boolean[] = []
      let lockHeld = false
      const lock: DesktopSharedPythonProvisionLock = async (_lockPath, operation) => {
        lockHeld = true
        try {
          return await operation()
        } finally {
          lockHeld = false
        }
      }
      let releaseInstall: (() => void) | undefined
      let installCompleted = false
      const installCalls: string[][] = []
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        provisionLock: lock,
        deferLibraryInstall: true,
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions: async (_command, args) => {
          installCalls.push([...args])
          installHeldLock.push(lockHeld)
          await new Promise<void>(resolve => { releaseInstall = resolve })
          installCompleted = true
          return { exitCode: 0, diagnostic: '' }
        },
        digestFile: lockDigest,
        log: message => { logs.push(message) },
      })

      // Boot resolved with the PRE-install coverage after only the cheap
      // read-only probe: the background pip leg has started but is still
      // blocked, proving the boot never awaited it.
      expect(environment.shared).toBe(true)
      expect(environment.libraries).toEqual({ pinned: 3, installed: 1 })
      await vi.waitFor(() => { expect(installCalls).toHaveLength(1) })
      expect(installCompleted).toBe(false)

      // The background leg then finishes, holding the same cross-process mutex.
      expect(installHeldLock).toEqual([true])
      releaseInstall?.()
      await vi.waitFor(() => {
        expect(logs.some(message => message.includes('installed 2 missing preinstalled python libraries'))).toBe(true)
      })
      expect(installCompleted).toBe(true)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('revalidates a deferred plan inside the lock, so a pin the user installed is never overwritten (review P3-1)', async () => {
    const fixture = libraryFixture()
    try {
      const { calls: probeCalls, probeDistributions: recorded } = distributionsProbeRecorder([
        // The boot's probe: pdfplumber and requests are missing.
        { pyyaml: '6.0.3' },
        // While the pip leg sat deferred, the user (or their agent) ran
        // `dsh-pip install pdfplumber` — the boot's plan is now stale.
        { pyyaml: '6.0.3', pdfplumber: '0.11.10' },
        // The post-install recount.
        { pdfplumber: '0.11.10', pyyaml: '6.0.3', requests: '2.34.2' },
      ])
      const probeHeldLock: boolean[] = []
      let lockHeld = false
      const lock: DesktopSharedPythonProvisionLock = async (_lockPath, operation) => {
        lockHeld = true
        try {
          return await operation()
        } finally {
          lockHeld = false
        }
      }
      const probeDistributions: DesktopSharedPythonDistributionsProbe = async (pythonExecutable, options) => {
        probeHeldLock.push(lockHeld)
        return await recorded(pythonExecutable, options)
      }
      const { calls: installCalls, installDistributions } = installRecorder()
      const digested: string[] = []
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        provisionLock: lock,
        deferLibraryInstall: true,
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions,
        digestFile: filename => {
          digested.push(filename)
          return lockDigest(filename)
        },
        log: message => { logs.push(message) },
      })

      // The boot still reports the pre-install coverage it probed.
      expect(environment.libraries).toEqual({ pinned: 3, installed: 1 })
      await vi.waitFor(() => { expect(probeCalls).toHaveLength(3) })
      // Only the wheel still absent when the leg actually ran reaches pip —
      // the user's own pdfplumber keeps winning — and only that wheel is
      // hashed. Both the revalidation and the pip run sit inside the mutex.
      expect(installCalls).toHaveLength(1)
      expect(installCalls[0]?.args.filter(argument => argument.endsWith('.whl'))).toEqual([
        join(WHEELS_DIRECTORY, 'requests-2.34.2-py3-none-any.whl'),
      ])
      expect(digested).toEqual([join(WHEELS_DIRECTORY, 'requests-2.34.2-py3-none-any.whl')])
      expect(probeHeldLock).toEqual([true, true, true])
      expect(logs).toEqual([
        `dsh-plugin-desktop: installed 1 missing preinstalled python libraries into the shared python environment at ${fixture.paths.root} from ${WHEELS_DIRECTORY}`,
      ])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('skips pip when the deferred window already satisfied every pin (review P3-1)', async () => {
    const fixture = libraryFixture()
    try {
      const { calls: probeCalls, probeDistributions } = distributionsProbeRecorder([
        { pyyaml: '6.0.3' },
        // The whole set landed while the leg was deferred.
        { pdfplumber: '0.11.10', pyyaml: '6.0.3', requests: '2.34.2' },
      ])
      const { calls: installCalls, installDistributions } = installRecorder()
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        deferLibraryInstall: true,
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions,
        digestFile: () => { throw new Error('a satisfied set hashes nothing') },
        log: message => { logs.push(message) },
      })

      expect(environment.libraries).toEqual({ pinned: 3, installed: 1 })
      // The revalidation probe is the leg's last probe (no recount follows a
      // skipped pip), and nothing was installed or logged.
      await vi.waitFor(() => { expect(probeCalls).toHaveLength(2) })
      expect(installCalls).toEqual([])
      expect(logs).toEqual([])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('never installs blindly when the pre-install re-probe cannot answer (review P3-1)', async () => {
    const fixture = libraryFixture()
    try {
      const { probeDistributions } = distributionsProbeRecorder([
        { pyyaml: '6.0.3' },
        undefined,
      ])
      const { calls: installCalls, installDistributions } = installRecorder()
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions,
        digestFile: () => { throw new Error('nothing to verify without a fresh plan') },
        log: message => { logs.push(message) },
      })

      // Losing a boot to a re-probe that cannot see the tree beats installing
      // over a pin this boot cannot vouch for; the counts describe the tree as
      // the boot probed it, and the next boot retries.
      expect(environment.libraries).toEqual({ pinned: 3, installed: 1 })
      expect(installCalls).toEqual([])
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('could not be probed again before installing')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('logs and skips the background repair when the deferred lock cannot be acquired', async () => {
    const fixture = libraryFixture()
    try {
      const { probeDistributions } = distributionsProbeRecorder([{ pyyaml: '6.0.3' }])
      let lockAttempts = 0
      const lock: DesktopSharedPythonProvisionLock = async (_lockPath, operation) => {
        lockAttempts += 1
        // The boot's provision succeeds; the background repair's re-acquire
        // finds the mutex unavailable.
        if (lockAttempts > 1) throw new Error('busy')
        return await operation()
      }
      const installCalls: string[][] = []
      const logs: string[] = []

      const environment = await ensureDesktopSharedPythonEnvironment({
        ...fixture.baseInputs(),
        provisionLock: lock,
        deferLibraryInstall: true,
        wheelsDirectory: WHEELS_DIRECTORY,
        readWheelsLock: () => LOCK_TEXT,
        probeDistributions,
        installDistributions: async (_command, args) => {
          installCalls.push([...args])
          return { exitCode: 0, diagnostic: '' }
        },
        digestFile: lockDigest,
        log: message => { logs.push(message) },
      })

      expect(environment.shared).toBe(true)
      await vi.waitFor(() => {
        expect(logs.some(message => message.includes('background install') && message.includes('busy'))).toBe(true)
      })
      // Without the mutex the pip leg never runs — it must not race a
      // concurrent provisioning — and the missing libraries heal next boot.
      expect(installCalls).toEqual([])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
