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
function provisionRecorder(existing: Set<string>, options: { exitCode?: number, error?: Error } = {}) {
  const calls: Array<{ command: string, args: readonly string[] }> = []
  const provision: DesktopSharedPythonProvision = async (command, args) => {
    calls.push({ command, args })
    if (options.error !== undefined) throw options.error
    if ((options.exitCode ?? 0) === 0) {
      existing.add(join(args[3] ?? '', 'Scripts', 'python.exe'))
      existing.add(join(args[3] ?? '', 'Scripts', 'pip.exe'))
    }
    return { exitCode: options.exitCode ?? 0, diagnostic: options.exitCode === 1 ? 'No module named virtualenv' : '' }
  }
  return { calls, provision }
}

describe('ensureDesktopSharedPythonEnvironment', () => {
  it('creates the environment from the preferred local base with --always-copy', async () => {
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
      // environment, writing only below the shared root.
      expect(calls).toEqual([{
        command: LOCAL_PYTHON,
        args: ['-m', 'virtualenv', '--always-copy', join(root, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME)],
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

  it('is idempotent: an existing environment is reused without provisioning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-root-'))
    try {
      const paths = desktopSharedPythonEnvironmentPaths(root)
      const { calls, provision } = provisionRecorder(new Set<string>())

      const environment = await ensureDesktopSharedPythonEnvironment({
        platform: 'win32',
        localPythonExecutable: LOCAL_PYTHON,
        bundledPythonExecutable: BUNDLED_PYTHON,
        rootDirectory: root,
        provision,
        exists: filename => filename === paths.pythonExecutable || filename === paths.pipExecutable,
      })

      expect(calls).toEqual([])
      expect(environment.shared).toBe(true)
      expect(environment.pythonExecutable).toBe(paths.pythonExecutable)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('logs once and falls back to the bundled aliases when provisioning fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pyenv-root-'))
    try {
      const logs: string[] = []
      for (const options of [{ exitCode: 1 }, { error: new Error('spawn ENOENT') }] as const) {
        const { provision } = provisionRecorder(new Set<string>(), options)

        const environment = await ensureDesktopSharedPythonEnvironment({
          platform: 'win32',
          localPythonExecutable: LOCAL_PYTHON,
          bundledPythonExecutable: BUNDLED_PYTHON,
          rootDirectory: root,
          provision,
          exists: () => false,
          log: message => { logs.push(message) },
        })

        // Today's behavior verbatim: bundled interpreter, no pip alias.
        expect(environment).toEqual({ pythonExecutable: BUNDLED_PYTHON, pipExecutable: undefined, shared: false })
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
