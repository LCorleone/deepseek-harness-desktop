import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SHARED_PYTHON_DIRECTORY_NAME,
  desktopSharedPythonEnvironmentPaths,
  desktopSharedPythonEnvironmentRoot,
  ensureDesktopSharedPythonEnvironment,
  resolveDesktopSharedPythonEnvironment,
  type DesktopSharedPythonProbe,
  type DesktopSharedPythonProvision,
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
