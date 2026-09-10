/** Shared desktop-wide Python environment provisioned once under `%LOCALAPPDATA%`. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Directory name of the shared environment below its parent. */
export const DESKTOP_SHARED_PYTHON_DIRECTORY_NAME = 'pyenv'

/** Parent directory name the shared environment lives in. */
const DESKTOP_SHARED_PYTHON_PARENT_NAME = 'DSH Desktop'

/** Provisioning deadline: virtualenv seeding is local, so minutes mean a hang. */
const SHARED_PYTHON_PROVISION_TIMEOUT_MS = 180_000

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
  /** Provisioning runner; production spawns `<base> -m virtualenv --always-copy`. */
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

/** Default provisioning runner: spawn the base interpreter's virtualenv module. */
async function spawnSharedPythonVirtualenv(
  command: string,
  args: readonly string[],
  options: { readonly environment?: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null, diagnostic: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.environment ?? process.env,
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
 * The provisioning command writes ONLY below the shared root — the bundled
 * runtime tree stays byte-identical, so its packaged digest keeps verifying.
 * Creation is idempotent: an environment whose interpreter already exists is
 * reused without spawning. Every failure degrades to today's behavior (the
 * aliases keep targeting the bundled interpreter and `pip` stays unpublished)
 * with exactly one log line — the shared environment is an enhancement, not
 * a boot dependency.
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
  if (exists(paths.pythonExecutable)) return sharedEnvironment(paths, exists)

  const base = inputs.localPythonExecutable ?? inputs.bundledPythonExecutable
  const provision = inputs.provision ?? spawnSharedPythonVirtualenv
  let outcome: { exitCode: number | null, diagnostic: string }
  try {
    outcome = await provision(
      base,
      ['-m', 'virtualenv', '--always-copy', paths.root],
      { ...(inputs.environment === undefined ? {} : { environment: inputs.environment }) },
    )
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
    ? `could not start ${base}`
    : `virtualenv exited with code ${outcome.exitCode} from ${base}`
  ;(inputs.log ?? (() => {}))(
    `dsh-plugin-desktop: the shared python environment at ${paths.root} is unavailable `
      + `(${failure}${outcome.diagnostic === '' ? '' : `: ${outcome.diagnostic}`}); `
      + 'python aliases keep targeting the bundled runtime and pip stays unpublished',
  )
  return fallback
}
