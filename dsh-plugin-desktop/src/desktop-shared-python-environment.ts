/** Shared desktop-wide Python environment provisioned once under `%LOCALAPPDATA%`. */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Directory name of the shared environment below its parent. */
export const DESKTOP_SHARED_PYTHON_DIRECTORY_NAME = 'pyenv'

/** Parent directory name the shared environment lives in. */
const DESKTOP_SHARED_PYTHON_PARENT_NAME = 'DSH Desktop'

/** Provisioning deadline: virtualenv seeding is local, so minutes mean a hang. */
const SHARED_PYTHON_PROVISION_TIMEOUT_MS = 180_000

/** Interpreter liveness deadline: `--version` only boots the interpreter. */
const SHARED_PYTHON_PROBE_TIMEOUT_MS = 30_000

/** Longest failure diagnostic kept for the degradation log line. */
const SHARED_PYTHON_DIAGNOSTIC_LIMIT = 160

/** Absolute locations inside the shared Python environment. */
export interface DesktopSharedPythonEnvironmentPaths {
  /** The environment root (`...\DSH Desktop\pyenv`). */
  readonly root: string
  /** The environment's command directory (`Scripts`). */
  readonly scriptsDirectory: string
  /** Interpreter command the desktop aliases execute. */
  readonly pythonExecutable: string
  /** pip command the desktop `pip` alias executes. */
  readonly pipExecutable: string
}

/** Inputs of one shared-environment provisioning run. */
export interface DesktopSharedPythonEnvironmentInputs {
  /** Host platform; only Windows provisions the shared environment. */
  readonly platform: NodeJS.Platform
  /**
   * Preferred base interpreter: a real local Python (WindowsApps store
   * stubs already excluded by the resolution the caller reused). Absent
   * falls back to the digest-verified bundled interpreter.
   */
  readonly localPythonExecutable: string | undefined
  /** Digest-verified bundled interpreter — the fallback base and the fallback alias target. */
  readonly bundledPythonExecutable: string
  /** Parent directory receiving the `pyenv` directory. */
  readonly rootDirectory: string
  /** Environment the provisioning child inherits; defaults to `process.env`. */
  readonly environment?: NodeJS.ProcessEnv
  /** File-existence probe; production uses `existsSync`. */
  readonly exists?: (filename: string) => boolean
  /** Interpreter liveness probe; production runs `<python> --version`. */
  readonly probe?: DesktopSharedPythonProbe
  /** Recursive directory removal; production uses `rmSync`. */
  readonly removeAll?: (directory: string) => void
  /** Provisioning runner; production spawns the base interpreter (stdlib `venv` for a local base, bundled `virtualenv` otherwise). */
  readonly provision?: DesktopSharedPythonProvision
  /** Degradation sink; defaults to a no-op (the launcher wires its logger). */
  readonly log?: (message: string) => void
}

/** The resolved shared-environment command surface. */
export interface DesktopSharedPythonEnvironment {
  /** Python command the desktop aliases execute. */
  readonly pythonExecutable: string
  /** pip command the desktop `pip` alias executes; absent without the shared environment. */
  readonly pipExecutable: string | undefined
  /** Whether the shared environment is the published command surface. */
  readonly shared: boolean
}

/**
 * One provisioning attempt: runs the virtualenv command and resolves with its
 * exit code plus a bounded, sanitized failure diagnostic (empty on success).
 */
export type DesktopSharedPythonProvision = (
  command: string,
  args: readonly string[],
  options: { readonly environment?: NodeJS.ProcessEnv },
) => Promise<{ readonly exitCode: number | null, readonly diagnostic: string }>

/**
 * One interpreter liveness probe: resolves whether the executable at the
 * given path actually runs (an existing but corrupt `python.exe` resolves
 * `false`, a thrown probe counts as `false` too).
 */
export type DesktopSharedPythonProbe = (
  pythonExecutable: string,
  options: { readonly environment?: NodeJS.ProcessEnv },
) => Promise<boolean>

/** Locate the shared environment below one parent directory. */
export function desktopSharedPythonEnvironmentPaths(
  rootDirectory: string,
): DesktopSharedPythonEnvironmentPaths {
  const root = join(rootDirectory, DESKTOP_SHARED_PYTHON_DIRECTORY_NAME)
  const scriptsDirectory = join(root, 'Scripts')
  return {
    root,
    scriptsDirectory,
    pythonExecutable: join(scriptsDirectory, 'python.exe'),
    pipExecutable: join(scriptsDirectory, 'pip.exe'),
  }
}

/**
 * Resolve the parent directory owning the shared environment:
 * `%LOCALAPPDATA%\DSH Desktop`, falling back to the caller-supplied
 * application-owned directory when the variable is absent.
 */
export function desktopSharedPythonEnvironmentRoot(
  environment: NodeJS.ProcessEnv,
  fallbackRoot: string,
): string {
  const localAppData = environment.LOCALAPPDATA
  return localAppData === undefined || localAppData.length === 0
    ? fallbackRoot
    : join(localAppData, DESKTOP_SHARED_PYTHON_PARENT_NAME)
}

/** Bound and sanitize one provisioning diagnostic for a log line. */
function sanitizeDiagnostic(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, SHARED_PYTHON_DIAGNOSTIC_LIMIT)
}

/**
 * Bytecode-safe environment for every shared-environment python spawn.
 *
 * Provisioning imports the base interpreter's packages; without this guard
 * CPython writes `__pycache__` bytecode while importing the bundled tree's
 * `site-packages`, and the bundled manifest verifies an exact file set —
 * one unexpected `__pycache__` entry would disable the whole python surface
 * on the next boot. The local base is in no danger, but every spawn of this
 * module uses the same environment so the guard cannot be forgotten.
 */
function sharedPythonSpawnEnvironment(environment: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(environment ?? process.env), PYTHONDONTWRITEBYTECODE: '1' }
}

/** Default provisioning runner: spawn the base interpreter's virtualenv module. */
async function spawnSharedPythonVirtualenv(
  command: string,
  args: readonly string[],
  options: { readonly environment?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null, diagnostic: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: sharedPythonSpawnEnvironment(options.environment),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: SHARED_PYTHON_PROVISION_TIMEOUT_MS,
    })
    let output = ''
    const capture = (stream: NodeJS.ReadableStream): void => {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        if (output.length < SHARED_PYTHON_DIAGNOSTIC_LIMIT * 4) output += chunk
      })
    }
    capture(child.stdout)
    capture(child.stderr)
    child.once('error', cause => { reject(cause) })
    child.once('close', exitCode => {
      resolve({ exitCode, diagnostic: sanitizeDiagnostic(output) })
    })
  })
}

/** Default liveness probe: `--version` boots only the interpreter (no `-c` snippet to compile) and resolves `true` on exit 0. */
async function spawnSharedPythonProbe(
  pythonExecutable: string,
  options: { readonly environment?: NodeJS.ProcessEnv },
): Promise<boolean> {
  return await new Promise(resolve => {
    const child = spawn(pythonExecutable, ['--version'], {
      env: sharedPythonSpawnEnvironment(options.environment),
      stdio: 'ignore',
      windowsHide: true,
      timeout: SHARED_PYTHON_PROBE_TIMEOUT_MS,
    })
    child.once('error', () => { resolve(false) })
    child.once('close', exitCode => { resolve(exitCode === 0) })
  })
}

/** The shared environment's command surface when its interpreter is present. */
function sharedEnvironment(
  paths: DesktopSharedPythonEnvironmentPaths,
  exists: (filename: string) => boolean,
): DesktopSharedPythonEnvironment {
  return {
    pythonExecutable: paths.pythonExecutable,
    pipExecutable: exists(paths.pipExecutable) ? paths.pipExecutable : undefined,
    shared: true,
  }
}

/**
 * Resolve the shared environment without provisioning it: the terminal and
 * any later surface only publish what an earlier boot already created.
 *
 * @returns the shared command surface, or `undefined` when the shared
 * environment's interpreter is not present (fall back to the bundled one).
 */
export function resolveDesktopSharedPythonEnvironment(inputs: {
  readonly platform: NodeJS.Platform
  readonly rootDirectory: string
  readonly exists?: (filename: string) => boolean
}): DesktopSharedPythonEnvironment | undefined {
  if (inputs.platform !== 'win32') return undefined
  const exists = inputs.exists ?? existsSync
  const paths = desktopSharedPythonEnvironmentPaths(inputs.rootDirectory)
  return exists(paths.pythonExecutable) ? sharedEnvironment(paths, exists) : undefined
}

/**
 * Ensure the shared Python environment exists, creating it once from the
 * preferred base interpreter (a real local Python, else the bundled one).
 *
 * The provisioning command writes ONLY below the shared root — and every
 * python this module spawns runs with `PYTHONDONTWRITEBYTECODE=1`, so
 * importing the bundled tree never writes `__pycache__` into it and its
 * packaged digest keeps verifying against the exact file set.
 *
 * The base is chosen in two tiers: a local base is seeded through the
 * standard library (`venv --copies` — `virtualenv` is a third-party package
 * a stock local Python does not install), and any local failure (or no
 * local Python at all) retries with the bundled base, whose tree ships
 * `virtualenv` (`--always-copy`). Only when both tiers fail does the
 * environment degrade to today's behavior.
 *
 * Creation is idempotent and self-healing: an existing environment is
 * reused only when its interpreter both exists and actually runs (probed
 * with `--version`); a present-but-broken interpreter means a corrupt
 * environment, which is removed once — logging the repair — and rebuilt
 * through the same two tiers. Every failure degrades to the bundled
 * aliases and unpublished `pip` with one log line per degradation stage — the shared
 * environment is an enhancement, not a boot dependency.
 */
export async function ensureDesktopSharedPythonEnvironment(
  inputs: DesktopSharedPythonEnvironmentInputs,
): Promise<DesktopSharedPythonEnvironment> {
  const fallback: DesktopSharedPythonEnvironment = {
    pythonExecutable: inputs.bundledPythonExecutable,
    pipExecutable: undefined,
    shared: false,
  }
  if (inputs.platform !== 'win32') return fallback
  const exists = inputs.exists ?? existsSync
  const paths = desktopSharedPythonEnvironmentPaths(inputs.rootDirectory)
  const log = inputs.log ?? (() => {})
  const spawnEnvironment = sharedPythonSpawnEnvironment(inputs.environment)

  if (exists(paths.pythonExecutable)) {
    const probe = inputs.probe ?? spawnSharedPythonProbe
    let runnable = false
    try {
      runnable = await probe(paths.pythonExecutable, { environment: spawnEnvironment })
    } catch {
      runnable = false
    }
    if (runnable) return sharedEnvironment(paths, exists)
    // python.exe exists but does not run: a corrupt environment. Remove it
    // once and rebuild below; an unremovable tree cannot be rebuilt in place.
    const removeAll = inputs.removeAll ?? ((directory: string) => {
      rmSync(directory, { recursive: true, force: true })
    })
    try {
      removeAll(paths.root)
    } catch (cause) {
      log(
        `dsh-plugin-desktop: the shared python environment at ${paths.root} holds an interpreter `
          + `that no longer runs and could not be removed `
          + `(${cause instanceof Error ? cause.message : String(cause)}); `
          + 'python aliases keep targeting the bundled runtime and pip stays unpublished',
      )
      return fallback
    }
    log(
      `dsh-plugin-desktop: the shared python environment at ${paths.root} held an interpreter `
        + 'that no longer runs; removed it and reprovisioning from scratch',
    )
  }

  const provision = inputs.provision ?? spawnSharedPythonVirtualenv
  const attempts: ReadonlyArray<{ readonly tool: string, readonly base: string, readonly args: readonly string[] }> = [
    // Tier 1: a local base through the standard library it always ships.
    ...(inputs.localPythonExecutable === undefined
      ? []
      : [{
          tool: 'venv',
          base: inputs.localPythonExecutable,
          args: ['-m', 'venv', '--copies', paths.root] as const,
        }]),
    // Tier 2: the bundled base, whose tree ships virtualenv by construction.
    {
      tool: 'virtualenv',
      base: inputs.bundledPythonExecutable,
      args: ['-m', 'virtualenv', '--always-copy', paths.root] as const,
    },
  ]
  const failures: string[] = []
  for (const attempt of attempts) {
    let outcome: { exitCode: number | null, diagnostic: string }
    try {
      outcome = await provision(attempt.base, attempt.args, { environment: spawnEnvironment })
    } catch (cause) {
      outcome = {
        exitCode: null,
        diagnostic: sanitizeDiagnostic(cause instanceof Error ? cause.message : String(cause)),
      }
    }
    if (outcome.exitCode === 0 && exists(paths.pythonExecutable)) {
      return sharedEnvironment(paths, exists)
    }
    const failure = outcome.exitCode === null
      ? `could not start ${attempt.base} (${attempt.tool})`
      : `${attempt.tool} exited with code ${outcome.exitCode} from ${attempt.base}`
    failures.push(`${failure}${outcome.diagnostic === '' ? '' : `: ${outcome.diagnostic}`}`)
  }
  log(
    `dsh-plugin-desktop: the shared python environment at ${paths.root} is unavailable `
      + `(${failures.join('; ')}); `
      + 'python aliases keep targeting the bundled runtime and pip stays unpublished',
  )
  return fallback
}
