/** Shared desktop-wide Python environment provisioned once under `%LOCALAPPDATA%`. */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

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

/**
 * How long a second desktop instance waits for the provisioning mutex before
 * degrading to the bundled aliases: the historical worst live holder runs both
 * base tiers under their spawn timeouts plus one probe — two provisions plus
 * one probe — so waiting that long is productive (the winner finishes and the
 * waiter reuses the result). Since #033 a live holder can run one more leg
 * (the ensurepip repair, ~180 s) and exceed this wait — see the NOTE below.
 */
const SHARED_PYTHON_PROVISION_LOCK_WAIT_MS
  = 2 * SHARED_PYTHON_PROVISION_TIMEOUT_MS + SHARED_PYTHON_PROBE_TIMEOUT_MS

// NOTE (#033 review P3): the wait above intentionally stays at its historical
// value — probe + two provisions — which a repair-then-reseed boot can now
// exceed by the ensurepip repair leg (~180 s worst). Bumping it instead would
// make every genuinely-stuck-holder wait that much longer before degrading;
// the chosen trade keeps degradation fast and relies on the next boot to heal
// (the stale-break threshold below still clears any live worst case).

/**
 * A lock file older than this can no longer belong to a live holder (the
 * worst case above is ~6.5 minutes) — a crash between acquiring and
 * releasing left it behind, and the next boot breaks it by mtime instead of
 * waiting the full bounded turn for an owner that will never return.
 */
const SHARED_PYTHON_PROVISION_LOCK_STALE_MS = 10 * 60 * 1000

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
  /** Provisioning runner; production spawns a Python command — the base interpreter seeding the tree (stdlib `venv` for a local base, bundled `virtualenv` otherwise) or the tree's own interpreter repairing a missing pip through `ensurepip`. */
  readonly provision?: DesktopSharedPythonProvision
  /**
   * Cross-process provisioning mutex (review P3): production serializes the
   * whole decide/probe/provision cycle through an exclusive lock file beside
   * the shared root, so two desktop instances never write the same `pyenv`
   * tree concurrently (the loser used to silently corrupt or overwrite the
   * winner's half-written environment). Tests inject a recording seam.
   */
  readonly provisionLock?: DesktopSharedPythonProvisionLock
  /** Clock for the default lock's stale-lock age gate; defaults to `Date.now`. */
  readonly now?: () => number
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
 * One provisioning attempt: runs a Python command (a virtualenv seeding or
 * the pip-less-tree `ensurepip` repair) and resolves with its exit code
 * plus a bounded, sanitized failure diagnostic (empty on success).
 */
export type DesktopSharedPythonProvision = (
  command: string,
  args: readonly string[],
  options: { readonly environment?: NodeJS.ProcessEnv },
) => Promise<{ readonly exitCode: number | null, readonly diagnostic: string }>

/**
 * Cross-process provisioning mutex over the shared environment: the lock
 * file lives beside the shared root (the one location every desktop build
 * agrees on — `%LOCALAPPDATA%\\DSH Desktop` — which is exactly the resource
 * the two racing instances fight over), so the winner provisions while the
 * loser waits its bounded turn and then reuses (or rebuilds) the result.
 */
export type DesktopSharedPythonProvisionLock = <T>(
  lockPath: string,
  operation: () => Promise<T>,
) => Promise<T>

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

/** The lock-file name of the shared environment's provisioning mutex. */
function sharedPythonProvisionLockPath(rootDirectory: string): string {
  return join(rootDirectory, `${DESKTOP_SHARED_PYTHON_DIRECTORY_NAME}.provision`)
}

/**
 * Default cross-process provisioning mutex: an exclusive `<pyenv.provision>.lock`
 * beside the shared root, waited for at most
 * {@link SHARED_PYTHON_PROVISION_LOCK_WAIT_MS} (a productive wait — the holder
 * is provisioning the very tree the waiter wants) and broken by mtime once
 * older than {@link SHARED_PYTHON_PROVISION_LOCK_STALE_MS}, because a crashed
 * holder will never release and the shared surface must not degrade forever
 * after one crash.
 */
async function withSharedPythonProvisionLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  now: () => number,
): Promise<T> {
  try {
    const info = await stat(`${lockPath}.lock`)
    if (now() - info.mtimeMs > SHARED_PYTHON_PROVISION_LOCK_STALE_MS) {
      await rm(`${lockPath}.lock`, { force: true })
    }
  } catch {
    // No lock file (the common case) or an unreadable one: the bounded
    // acquisition below decides — an unremovable stale lock surfaces as the
    // bounded wait, never as an unhandled failure here.
  }
  return await withFileLock(lockPath, operation, { waitMs: SHARED_PYTHON_PROVISION_LOCK_WAIT_MS })
}

/** Decide, probe, repair, and provision the shared tree; never throws (every tier degrades internally). */
async function provisionSharedPythonEnvironment(
  inputs: DesktopSharedPythonEnvironmentInputs,
  paths: DesktopSharedPythonEnvironmentPaths,
): Promise<DesktopSharedPythonEnvironment> {
  const exists = inputs.exists ?? existsSync
  const log = inputs.log ?? (() => {})
  const spawnEnvironment = sharedPythonSpawnEnvironment(inputs.environment)
  const provision = inputs.provision ?? spawnSharedPythonVirtualenv
  const fallback: DesktopSharedPythonEnvironment = {
    pythonExecutable: inputs.bundledPythonExecutable,
    pipExecutable: undefined,
    shared: false,
  }
  if (exists(paths.pythonExecutable)) {
    const probe = inputs.probe ?? spawnSharedPythonProbe
    let runnable = false
    try {
      runnable = await probe(paths.pythonExecutable, { environment: spawnEnvironment })
    } catch {
      runnable = false
    }
    if (runnable && exists(paths.pipExecutable)) return sharedEnvironment(paths, exists)
    // One of two defects remains: the interpreter no longer runs (a corrupt
    // tree), or it runs without `pip.exe` — the tier-1 venv a base Python
    // without ensurepip wheels used to seed, which every later boot then
    // reused forever (issue #033: `dsh-pip` never published, no self-heal).
    // The pip-less tree gets ONE in-place repair through its own ensurepip
    // before anything is deleted, so it keeps every package the user
    // already installed into it; only a failed repair falls to the removal
    // and full reseed the corrupt tree always takes.
    let defect: string
    if (runnable) {
      let repaired = false
      let diagnostic = ''
      try {
        const outcome = await provision(
          paths.pythonExecutable,
          ['-m', 'ensurepip', '--upgrade'],
          { environment: spawnEnvironment },
        )
        repaired = outcome.exitCode === 0 && exists(paths.pipExecutable)
        diagnostic = outcome.diagnostic
      } catch (cause) {
        diagnostic = sanitizeDiagnostic(cause instanceof Error ? cause.message : String(cause))
      }
      if (repaired) {
        log(
          `dsh-plugin-desktop: the shared python environment at ${paths.root} ran without pip; `
            + 'repaired it in place through ensurepip and published the pip aliases',
        )
        return sharedEnvironment(paths, exists)
      }
      defect = `a runnable interpreter but no pip (the ensurepip repair failed${diagnostic === '' ? '' : `: ${diagnostic}`})`
    } else {
      defect = 'an interpreter that no longer runs'
    }
    // Remove the defective tree once and rebuild below; an unremovable tree
    // cannot be rebuilt in place.
    const removeAll = inputs.removeAll ?? ((directory: string) => {
      rmSync(directory, { recursive: true, force: true })
    })
    try {
      removeAll(paths.root)
    } catch (cause) {
      log(
        `dsh-plugin-desktop: the shared python environment at ${paths.root} holds ${defect} and could not be removed `
          + `(${cause instanceof Error ? cause.message : String(cause)}); `
          + 'python aliases keep targeting the bundled runtime and pip stays unpublished',
      )
      return fallback
    }
    log(
      `dsh-plugin-desktop: the shared python environment at ${paths.root} held ${defect}; `
        + 'removed it and reprovisioning from scratch',
    )
  }
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
    if (outcome.exitCode === 0 && exists(paths.pythonExecutable) && exists(paths.pipExecutable)) {
      return sharedEnvironment(paths, exists)
    }
    let failure: string
    if (outcome.exitCode === null) {
      failure = `could not start ${attempt.base} (${attempt.tool})`
    } else if (outcome.exitCode !== 0) {
      failure = `${attempt.tool} exited with code ${outcome.exitCode} from ${attempt.base}`
    } else if (exists(paths.pythonExecutable)) {
      // Exit 0 with an interpreter but no pip (issue #033): the base Python
      // lacks the ensurepip wheels, so its venv can never seed pip — the
      // next tier takes over instead of publishing a pip-less tree.
      failure = `${attempt.tool} from ${attempt.base} produced no pip (base Python without ensurepip wheels)`
    } else {
      failure = `${attempt.tool} exited with code 0 from ${attempt.base}`
    }
    failures.push(`${failure}${outcome.diagnostic === '' ? '' : `: ${outcome.diagnostic}`}`)
  }
  log(
    `dsh-plugin-desktop: the shared python environment at ${paths.root} is unavailable `
      + `(${failures.join('; ')}); `
      + 'python aliases keep targeting the bundled runtime and pip stays unpublished',
  )
  return fallback
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
 * `virtualenv` (`--always-copy`). A tier succeeds only when it produces the
 * interpreter AND `pip.exe` (issue #033): a base Python without the
 * ensurepip wheels exits 0 yet seeds a pip-less venv, which used to be
 * accepted as success and then reused forever with `dsh-pip` unpublished —
 * such a tree now records a failure and falls through to the bundled tier,
 * which ships pip by construction. Only when both tiers fail does the
 * environment degrade to today's behavior.
 *
 * Creation is idempotent and self-healing: an existing environment is
 * reused only when its interpreter both exists and actually runs (probed
 * with `--version`) AND its `pip.exe` is present. A runnable tree without
 * pip — the pip-less venvs earlier builds left across the fleet — gets ONE
 * in-place repair through its own `ensurepip` (preserving every package
 * already installed into it); only a failed repair, or a present-but-broken
 * interpreter (a corrupt environment), removes the tree once — logging the
 * repair — and rebuilds it through the same two tiers. Every failure
 * degrades to the bundled aliases and unpublished `pip` with one log line
 * per degradation stage — the shared environment is an enhancement, not a
 * boot dependency.
 *
 * Concurrency (review P3): the whole decide/probe/provision cycle runs under
 * a cross-process mutex beside the shared root, so two desktop instances
 * sharing `%LOCALAPPDATA%\\DSH Desktop` never write the same tree at once —
 * the second instance waits its bounded turn and then reuses the winner's
 * result (or rebuilds when the winner failed). A wait that outlasts the
 * bound degrades to the bundled aliases with one log line instead of
 * blocking the boot behind a stuck holder.
 */
export async function ensureDesktopSharedPythonEnvironment(
  inputs: DesktopSharedPythonEnvironmentInputs,
): Promise<DesktopSharedPythonEnvironment> {
  if (inputs.platform !== 'win32') {
    return {
      pythonExecutable: inputs.bundledPythonExecutable,
      pipExecutable: undefined,
      shared: false,
    }
  }
  const paths = desktopSharedPythonEnvironmentPaths(inputs.rootDirectory)
  const log = inputs.log ?? (() => {})
  const lockPath = sharedPythonProvisionLockPath(inputs.rootDirectory)
  const runLocked: DesktopSharedPythonProvisionLock = inputs.provisionLock
    ?? ((lockMarkerPath, operation) =>
      withSharedPythonProvisionLock(lockMarkerPath, operation, inputs.now ?? Date.now))
  try {
    return await runLocked(lockPath, () => provisionSharedPythonEnvironment(inputs, paths))
  } catch (cause) {
    // Only the mutex reaches here — the operation itself never throws. A
    // refused or expired wait is the defined loser path: degrade exactly
    // like a failed provisioning tier, never block the boot.
    log(
      `dsh-plugin-desktop: could not serialize the shared python environment provisioning at ${lockPath}`
        + ` (${cause instanceof Error ? cause.message : String(cause)}); `
        + 'python aliases keep targeting the bundled runtime and pip stays unpublished',
    )
    return {
      pythonExecutable: inputs.bundledPythonExecutable,
      pipExecutable: undefined,
      shared: false,
    }
  }
}
