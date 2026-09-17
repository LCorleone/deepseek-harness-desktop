/** Shared desktop-wide Python environment provisioned once under `%LOCALAPPDATA%`. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { stat, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** Directory name of the shared environment below its parent. */
export const DESKTOP_SHARED_PYTHON_DIRECTORY_NAME = 'pyenv'

/**
 * Filename of the preinstall wheel lock beside the staged wheels (issue #043,
 * decision D2). The committed source is `assets/python-wheels-lock.json`
 * (see `scripts/bundled-python-wheels.ts`); `extraResources` ships the staged
 * copy at `resources/python-wheels/python-wheels-lock.json`, and this module
 * reads it there — one file pins the names, versions, and sha256s the
 * ensure-present step installs and verifies.
 */
export const SHARED_PYTHON_WHEELS_LOCK_NAME = 'python-wheels-lock.json'

/** Parent directory name the shared environment lives in. */
const DESKTOP_SHARED_PYTHON_PARENT_NAME = 'DSH Desktop'

/** Provisioning deadline: virtualenv seeding is local, so minutes mean a hang. */
const SHARED_PYTHON_PROVISION_TIMEOUT_MS = 180_000

/** Interpreter liveness deadline: `--version` only boots the interpreter. */
const SHARED_PYTHON_PROBE_TIMEOUT_MS = 30_000

/** Longest failure diagnostic kept for the degradation log line. */
const SHARED_PYTHON_DIAGNOSTIC_LIMIT = 160

/**
 * Longest pip diagnostic kept for the library-install failure log line
 * (issue #050): pip's stderr is the only evidence a failed wheel batch
 * leaves, and its error text easily outgrows the 160-char provisioning cap
 * that strangled the b104 failure line to an undiagnosable `(Processing
 * ... ERROR: aiohttp-3.14.3-cp312-cp3)`. The desktop log discipline bounds
 * whole FILES, not individual lines (10 MiB rotation segments per file), so
 * an 8 KiB single-line diagnostic rides it safely; only the spawn's capture
 * buffer (4x the kept size, like every capture here) and the slice ever
 * bound it. The short provisioning and repair legs keep the 160-char cap.
 */
const SHARED_PYTHON_LIBRARY_INSTALL_DIAGNOSTIC_LIMIT = 8192

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
 * A lock file older than this can no longer belong to a live holder. The
 * wait above is only ~6.5 minutes, but since #043 batch C the locked cycle
 * runs more legs than that wait covers, so the stale gate cannot reuse it.
 * Worst live holder, all deadlines at their bound: one liveness probe (30 s)
 * + both provision tiers (2 × 180 s) + one ensurepip repair (180 s) + the
 * plan's pre-install distributions probe (30 s) + the install leg's in-lock
 * revalidation probe (30 s, review P3-1) + the library install deadline
 * (300 s) + the post-install recount probe (30 s) ≈ 16 minutes. (The
 * production boot defers the install leg, making it a second, shorter
 * lock hold; the non-deferred sum is the bound this gate must cover.) This
 * 20 minute threshold covers that worst case with margin, so a second
 * instance never deletes the lock of a holder that is still installing —
 * it only breaks a file a crash left behind instead of waiting the full
 * bounded turn for an owner that will never return. A crash-left lock is
 * usually reclaimed long before the threshold: the file records its
 * holder's PID, so one that {@link sharedPythonLockHolderGone} proves gone is
 * reclaimed on sight (review P3-2), and this age gate only decides the
 * cases that leave doubt (an unreadable or unparseable PID, or a live one).
 */
const SHARED_PYTHON_PROVISION_LOCK_STALE_MS = 20 * 60 * 1000

/**
 * Lock-layer failures worth exactly one bounded retry (issue #038): real
 * `fs` errors carry an errno `code`, and these are the codes the
 * atomic-write package itself treats as transient Windows interference
 * (`EACCES`, `EPERM`, `EBUSY` around file creation) plus `ENOENT` — the
 * missing-parent signature pinned below. The mutex's defined
 * contention-timeout failure stays out on purpose: it is a plain `Error`
 * without a `code`, and its degrade-with-log semantics must not turn into a
 * second full bounded wait.
 */
const SHARED_PYTHON_LOCK_RETRYABLE_CODES: ReadonlySet<string>
  = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY'])

/**
 * Pause before the single lock-acquisition retry: long enough for antivirus
 * or indexer interference around the exclusive-create open to clear, short
 * enough to stay invisible in the boot.
 */
const SHARED_PYTHON_LOCK_RETRY_DELAY_MS = 250

/**
 * Library-repair pip deadline: the first provisioning installs the whole
 * pinned wheel set (~48 wheels, ~52 MB) from the local verified wheel files,
 * which on an antivirus-throttled disk outlasts the seeding deadline — 5
 * minutes bounds it. Since #043 batch C the install runs on a background leg
 * after boot (see `deferLibraryInstall`), so this deadline no longer rides
 * the boot path.
 */
const SHARED_PYTHON_LIBRARY_INSTALL_TIMEOUT_MS = 300_000

/** Upper bound on the installed-distributions probe's JSON answer. */
const SHARED_PYTHON_DISTRIBUTIONS_PROBE_OUTPUT_LIMIT = 256 * 1024

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
   * Directory the packaged preinstall wheel set lives in (issue #043, D2:
   * `resources/python-wheels`). Absent — non-Windows platforms, unpackaged
   * development checkouts — skips the library repair entirely.
   */
  readonly wheelsDirectory?: string
  /** Wheel-lock reader; production reads `<directory>/python-wheels-lock.json`. */
  readonly readWheelsLock?: DesktopSharedPythonWheelsLockReader
  /** Installed-distributions probe; production runs a one-shot importlib.metadata script. */
  readonly probeDistributions?: DesktopSharedPythonDistributionsProbe
  /** Library-install runner; production spawns the tree's pip once, strictly offline. */
  readonly installDistributions?: DesktopSharedPythonProvision
  /**
   * Run the library install on a fire-and-forget background leg instead of
   * the boot path (issue #043 batch C, review P2-b): the cheap read-only
   * probe still runs while provisioning is locked, so the resolved
   * environment carries the pre-install coverage counts, but the pip leg
   * (up to {@link SHARED_PYTHON_LIBRARY_INSTALL_TIMEOUT_MS}) is scheduled
   * after boot behind the SAME cross-process mutex — an unverified wheel set
   * therefore never races a concurrent provisioning, while the aliases and
   * profile start as soon as the tree is up (a missing library degrades the
   * skill gracefully until the background leg or a later boot heals it).
   * Defaults to `false` (the boot awaits the full repair).
   */
  readonly deferLibraryInstall?: boolean
  /** sha256 seam over one wheel file; production hashes with node:crypto. */
  readonly digestFile?: (filename: string) => string
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
  /**
   * How much of the pinned preinstall wheel set this boot verified installed
   * (issue #043, decision D2): `pinned` counts the lock, `installed` counts
   * the pinned names present at ANY version when this boot probed or
   * repaired the tree (the pre-install probe on the deferred background
   * leg — a later boot reports the healed count). Omitted whenever the boot
   * cannot vouch for the count (no wheel set, unreadable lock, failed
   * probe) — the row keeps its legacy shape.
   */
  readonly libraries?: DesktopSharedPythonLibraries
}

/** Coverage of the pinned preinstall wheel set in the shared environment. */
export interface DesktopSharedPythonLibraries {
  /** Distributions the wheel lock pins. */
  readonly pinned: number
  /** Pinned distributions installed at any version when this boot probed or repaired the tree. */
  readonly installed: number
}

/** One pinned distribution of the preinstall wheel lock. */
export interface DesktopSharedPythonWheelsLockEntry {
  /** Canonical (PEP 503) distribution name, lowercase with single dashes. */
  readonly name: string
  /** Exact pinned version. */
  readonly version: string
  /** Exact wheel filename whose sha256 is pinned below. */
  readonly filename: string
  /** sha256 of the wheel bytes the install step verifies before running pip. */
  readonly sha256: string
}

/** Parsed contents of the packaged `python-wheels-lock.json`. */
export interface DesktopSharedPythonWheelsLock {
  /** Interpreter minor the wheels target (the shared environment's CPython). */
  readonly python: string
  /** Wheel platform tag the set targets. */
  readonly platform: string
  /** Every pinned distribution, in lock order. */
  readonly distributions: readonly DesktopSharedPythonWheelsLockEntry[]
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

/** Wheel-lock reader returning the raw lockfile text, or `undefined` when unreadable. */
export type DesktopSharedPythonWheelsLockReader = (directory: string) => string | undefined

/**
 * Installed-distributions probe: resolves the shared tree's installed
 * distributions as a name→version record (names exactly as the interpreter
 * reports them — both sides normalize through
 * {@link canonicalDistributionName}), or `undefined` when the probe cannot
 * answer (a failed spawn, a timeout, an unparsable answer) — the caller then
 * skips this boot's repair check instead of guessing.
 */
export type DesktopSharedPythonDistributionsProbe = (
  pythonExecutable: string,
  options: { readonly environment?: NodeJS.ProcessEnv },
) => Promise<Readonly<Record<string, string>> | undefined>

/** Canonicalize one distribution name the way Python normalizes project names (PEP 503). */
export function canonicalDistributionName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, '-')
}

/** Whether one string is a 64-character lowercase-hex sha256. */
function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value)
}

/**
 * Parse the packaged wheel lock (lenient sibling of the build-time strict
 * parser in `scripts/bundled-python-wheels.ts`, which fails the build loud):
 * runtime malformed input must degrade — skip this boot's repair check —
 * never block the boot, so every drift resolves to `undefined`.
 */
export function parseSharedPythonWheelsLock(
  text: string,
): DesktopSharedPythonWheelsLock | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (typeof document.python !== 'string' || typeof document.platform !== 'string') return undefined
  if (!Array.isArray(document.distributions) || document.distributions.length === 0) return undefined
  const distributions: DesktopSharedPythonWheelsLockEntry[] = []
  const seen = new Set<string>()
  for (const entry of document.distributions) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const { name, version, filename, sha256 } = entry as Record<string, unknown>
    if (typeof name !== 'string' || name.length === 0
      || typeof version !== 'string' || version.length === 0
      || typeof filename !== 'string' || !filename.endsWith('.whl')) return undefined
    if (typeof sha256 !== 'string' || !isSha256Hex(sha256)) return undefined
    const canonical = canonicalDistributionName(name)
    if (seen.has(canonical)) return undefined
    seen.add(canonical)
    distributions.push({ name, version, filename, sha256 })
  }
  return { python: document.python, platform: document.platform, distributions }
}

/**
 * The locked distributions absent from an installed name→version record —
 * the ensure-present core of decision D2: a name counts as present at ANY
 * version (a user's or agent's own install is never touched, never upgraded,
 * never downgraded), and names compare after PEP 503 normalization so the
 * interpreter's `PyYAML`/`python_dateutil` spellings match the lock's
 * canonical `pyyaml`/`python-dateutil`.
 */
export function missingSharedPythonDistributions(
  pinned: readonly DesktopSharedPythonWheelsLockEntry[],
  installed: Readonly<Record<string, string>>,
): readonly DesktopSharedPythonWheelsLockEntry[] {
  const installedNames = new Set(Object.keys(installed).map(canonicalDistributionName))
  return pinned.filter(entry => !installedNames.has(canonicalDistributionName(entry.name)))
}

/**
 * The pip arguments that install exactly the missing pinned distributions
 * from their VERIFIED wheel files by absolute path (issue #043 batch C,
 * review P2-a): the sha256 gate above verifies each wheel, and naming the
 * wheel itself leaves pip no directory to scan — a differently-named
 * same-version wheel planted beside the set can never win the resolution.
 * `--no-index` keeps the run strictly on the packaged wheels and
 * `--no-compile` keeps bytecode (whose mtimes embed build noise) out of the
 * fresh tree.
 *
 * `--no-deps` and `--upgrade` together are the issue #050 fix. The wheel
 * set is a closed, exactly-pinned, pre-resolved closure that needs NO
 * dependency resolution, yet pip's resolver still ran over it and
 * conflicted with the stale dists an older build's lock had left in a
 * shared pyenv — one conflict failed the whole 48-wheel batch
 * (`pinned:48, installed:0`, b104/liamzhong). `--no-deps` removes the
 * resolution entirely; `--upgrade` makes pip REPLACE a same-lib dist it
 * can still see with the pinned wheel instead of skipping it as "already
 * satisfied" — without it, a stale version pip alone knows about survives
 * every repair this leg ever runs.
 *
 * #050 invariant — why `--upgrade` can never touch a user's own choice:
 * this argv is only ever built for names a FRESH in-lock probe (see
 * {@link installSharedPythonLibraries}) found ABSENT, where ANY installed
 * version of a pinned name — the user's own newer or older `dsh-pip
 * install` — counts as present and keeps the name OUT of the missing list
 * entirely. So the only same-lib dists `--upgrade` can act on are stale
 * ones of lock-owned names that the probe could not see (pip-visible
 * leftovers of a partially-failed earlier batch, or a dist landing between
 * the probe and pip's run inside the same lock hold) — exactly the
 * dirty-pyenv case the flag exists to heal. A user-installed version that
 * satisfies the probe is never named in this argv and is never upgraded,
 * downgraded, or replaced.
 */
export function sharedPythonLibraryInstallArguments(
  wheelsDirectory: string,
  missing: readonly DesktopSharedPythonWheelsLockEntry[],
): readonly string[] {
  return [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-index',
    '--no-deps',
    '--upgrade',
    '--no-warn-script-location',
    '--no-compile',
    ...missing.map(entry => join(wheelsDirectory, entry.filename)),
  ]
}

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
function sanitizeDiagnostic(
  text: string,
  limit: number = SHARED_PYTHON_DIAGNOSTIC_LIMIT,
): string {
  return text.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, limit)
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
  timeoutMs: number = SHARED_PYTHON_PROVISION_TIMEOUT_MS,
  diagnosticLimit: number = SHARED_PYTHON_DIAGNOSTIC_LIMIT,
): Promise<{ exitCode: number | null, diagnostic: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: sharedPythonSpawnEnvironment(options.environment),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
    })
    let output = ''
    const capture = (stream: NodeJS.ReadableStream): void => {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        if (output.length < diagnosticLimit * 4) output += chunk
      })
    }
    capture(child.stdout)
    capture(child.stderr)
    child.once('error', cause => { reject(cause) })
    child.once('close', exitCode => {
      resolve({ exitCode, diagnostic: sanitizeDiagnostic(output, diagnosticLimit) })
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

/**
 * Installed-distributions probe script: one `importlib.metadata` walk that
 * answers as JSON on stdout. Per-distribution failures (a broken dist-info)
 * skip that entry instead of failing the whole probe, and the interpreter's
 * original name spellings pass through — normalization happens on this side.
 */
const SHARED_PYTHON_DISTRIBUTIONS_PROBE_SCRIPT = [
  'import json, sys',
  'from importlib.metadata import distributions',
  'installed = {}',
  'for distribution in distributions():',
  '    try:',
  '        installed[distribution.metadata["Name"]] = distribution.version',
  '    except Exception:',
  '        pass',
  'json.dump(installed, sys.stdout)',
].join('\n')

/** Default installed-distributions probe: one spawn of the shared tree's interpreter. */
async function spawnSharedPythonDistributionsProbe(
  pythonExecutable: string,
  options: { readonly environment?: NodeJS.ProcessEnv },
): Promise<Readonly<Record<string, string>> | undefined> {
  return await new Promise(resolve => {
    const child = spawn(pythonExecutable, ['-c', SHARED_PYTHON_DISTRIBUTIONS_PROBE_SCRIPT], {
      env: sharedPythonSpawnEnvironment(options.environment),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: SHARED_PYTHON_PROBE_TIMEOUT_MS,
    })
    let output = ''
    let answered = false
    const answer = (value: Readonly<Record<string, string>> | undefined): void => {
      if (answered) return
      answered = true
      resolve(value)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (output.length < SHARED_PYTHON_DISTRIBUTIONS_PROBE_OUTPUT_LIMIT) output += chunk
    })
    child.once('error', () => { answer(undefined) })
    child.once('close', exitCode => {
      if (exitCode !== 0) {
        answer(undefined)
        return
      }
      try {
        const parsed: unknown = JSON.parse(output.trim())
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          answer(undefined)
          return
        }
        const installed: Record<string, string> = {}
        for (const [name, version] of Object.entries(parsed)) {
          if (typeof name === 'string' && typeof version === 'string') installed[name] = version
        }
        answer(installed)
      } catch {
        answer(undefined)
      }
    })
  })
}

/** Default wheel-lock reader: `<directory>/python-wheels-lock.json`, `undefined` on any error. */
function readSharedPythonWheelsLock(directory: string): string | undefined {
  try {
    return readFileSync(join(directory, SHARED_PYTHON_WHEELS_LOCK_NAME), 'utf8')
  } catch {
    return undefined
  }
}

/** Default wheel hashing: sha256 hex over one file's bytes. */
function digestSharedPythonWheel(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

/**
 * How many pinned distributions an installed name→version record covers, at
 * any version: the coverage count the `python_runtime` telemetry row reports
 * and the repair verdict after pip, so both sides agree on the semantics.
 */
function countPinnedSharedPythonDistributions(
  lock: DesktopSharedPythonWheelsLock,
  installed: Readonly<Record<string, string>>,
): number {
  const present = new Set(Object.keys(installed).map(canonicalDistributionName))
  return lock.distributions.reduce(
    (sum, entry) => sum + (present.has(canonicalDistributionName(entry.name)) ? 1 : 0),
    0,
  )
}

/** Attach this boot's pinned-versus-installed coverage to the resolved environment. */
function withSharedPythonLibraries(
  environment: DesktopSharedPythonEnvironment,
  pinned: number,
  installed: number,
): DesktopSharedPythonEnvironment {
  return { ...environment, libraries: { pinned, installed } }
}

/** One boot's ensure-present plan over the pinned wheel set. */
interface DesktopSharedPythonLibraryRepair {
  /** The parsed lock this plan was computed against. */
  readonly lock: DesktopSharedPythonWheelsLock
  /** Distributions installed in the tree (any version) when the plan was made. */
  readonly installed: Readonly<Record<string, string>>
  /**
   * Pinned distributions absent from `installed` when the plan was made, in
   * lock order. This is the boot's verdict, not pip's argv: the install leg
   * re-derives the set from a fresh in-lock probe before building its
   * arguments (review P3-1).
   */
  readonly missing: readonly DesktopSharedPythonWheelsLockEntry[]
}

/**
 * Cheap read-only half of the ensure-present step: read the lock, probe the
 * tree's installed distributions, and name what is missing. `undefined` means
 * this boot cannot vouch for the set (no wheel set wired, unreadable or
 * malformed lock, failed probe) — the caller then skips its repair and omits
 * the `libraries` fact. Never throws.
 */
async function probeSharedPythonLibraries(
  inputs: DesktopSharedPythonEnvironmentInputs,
  paths: DesktopSharedPythonEnvironmentPaths,
): Promise<DesktopSharedPythonLibraryRepair | undefined> {
  const log = inputs.log ?? (() => {})
  const wheelsDirectory = inputs.wheelsDirectory
  if (wheelsDirectory === undefined) return undefined
  const spawnEnvironment = sharedPythonSpawnEnvironment(inputs.environment)
  try {
    const readWheelsLock = inputs.readWheelsLock ?? readSharedPythonWheelsLock
    const lockText = readWheelsLock(wheelsDirectory)
    const lock = lockText === undefined ? undefined : parseSharedPythonWheelsLock(lockText)
    if (lock === undefined) {
      log(
        `dsh-plugin-desktop: the shared python environment's preinstalled wheel lock at ${join(wheelsDirectory, SHARED_PYTHON_WHEELS_LOCK_NAME)} is unavailable; `
          + 'skipping this boot\'s library repair check',
      )
      return undefined
    }
    const probeDistributions = inputs.probeDistributions ?? spawnSharedPythonDistributionsProbe
    let installed: Readonly<Record<string, string>> | undefined
    try {
      installed = await probeDistributions(paths.pythonExecutable, { environment: spawnEnvironment })
    } catch {
      installed = undefined
    }
    if (installed === undefined) {
      log(
        `dsh-plugin-desktop: the installed libraries of the shared python environment at ${paths.root} could not be probed; `
          + 'skipping this boot\'s library repair check',
      )
      return undefined
    }
    return {
      lock,
      installed,
      missing: missingSharedPythonDistributions(lock.distributions, installed),
    }
  } catch (cause) {
    log(
      `dsh-plugin-desktop: the shared python environment's library probe at ${wheelsDirectory} failed unexpectedly (${cause instanceof Error ? cause.message : String(cause)}); `
        + 'skipping this boot\'s library repair check',
    )
    return undefined
  }
}

/**
 * Install the missing pinned distributions of one probed repair plan into the
 * shared tree. This is the mutating half of the ensure-present step: each
 * wheel is verified against the lock's sha256 before pip consumes it (a
 * tampered wheel never reaches pip — the wheels are build inputs outside the
 * bundled tree's digest manifest, and this check is their integrity gate),
 * the pip run names exactly those verified wheel files, and a fresh probe
 * reports the resulting coverage. Ensure-present semantics: a pinned name
 * installed at ANY version counts as present and never enters pip's argv,
 * so it is never upgraded or downgraded — the shared environment is the
 * user's mutable surface, and whatever they installed into it wins. The
 * names that DO enter the argv install as a `--no-deps --upgrade` closed
 * set (issue #050): zero dependency resolution for the exactly-pinned
 * closure, and replacement — not an "already satisfied" skip — over any
 * stale same-lib dist pip alone can see. Every failure degrades with one
 * log line and never throws; the result carries the `libraries` coverage
 * counts when this boot can vouch for them, and omits the field when it
 * cannot. The failure line carries pip's whole (sanitized, single-line)
 * stderr, not the provisioning legs' 160-char cap — a failed wheel batch
 * is otherwise undiagnosable from the log alone (#050).
 *
 * The plan is revalidated immediately before pip runs (review P3-1): this leg
 * can start minutes after the boot that planned it (see
 * `deferLibraryInstall`), and a user's own `dsh-pip install
 * <pinned>==<other version>` in that window must keep winning, so a fresh
 * in-lock probe re-derives the missing set and pip receives only the wheels
 * still absent. A re-probe that cannot answer leaves the tree untouched —
 * installing blind could overwrite a pin this boot cannot see — and the next
 * boot retries.
 */
async function installSharedPythonLibraries(
  inputs: DesktopSharedPythonEnvironmentInputs,
  paths: DesktopSharedPythonEnvironmentPaths,
  environment: DesktopSharedPythonEnvironment,
  repair: DesktopSharedPythonLibraryRepair,
): Promise<DesktopSharedPythonEnvironment> {
  const log = inputs.log ?? (() => {})
  const wheelsDirectory = inputs.wheelsDirectory
  if (wheelsDirectory === undefined) return environment
  const { lock, installed } = repair
  const pinned = lock.distributions.length
  const spawnEnvironment = sharedPythonSpawnEnvironment(inputs.environment)
  const probeDistributions = inputs.probeDistributions ?? spawnSharedPythonDistributionsProbe
  try {
    // Revalidate the plan where it is about to be consumed — inside the same
    // lock hold that runs pip (review P3-1). The boot's `installed` record
    // may be minutes old, and between the two probes a user (or their agent)
    // can `dsh-pip install` any pinned name at another version; pip would
    // then silently replace it. A missing set re-derived from THIS probe can
    // only shrink, so whatever the user installed in the window wins.
    let present: Readonly<Record<string, string>> | undefined
    try {
      present = await probeDistributions(paths.pythonExecutable, { environment: spawnEnvironment })
    } catch {
      present = undefined
    }
    if (present === undefined) {
      log(
        `dsh-plugin-desktop: the installed libraries of the shared python environment at ${paths.root} could not be probed again before installing; `
          + 'skipping this boot\'s library repair rather than installing over libraries it cannot see',
      )
      return withSharedPythonLibraries(environment, pinned, countPinnedSharedPythonDistributions(lock, installed))
    }
    const missing = missingSharedPythonDistributions(lock.distributions, present)
    if (missing.length === 0) {
      // The window's own installs (or a finished sibling leg) already
      // satisfied every pin: pip has nothing to do, and the fresh probe is
      // this boot's coverage verdict.
      return withSharedPythonLibraries(environment, pinned, countPinnedSharedPythonDistributions(lock, present))
    }
    // Integrity gate before pip consumes anything: every wheel this run
    // would install must hash to its pinned sha256 (an unreadable file
    // counts as unverified too — a swapped wheel must never execute).
    const digestFile = inputs.digestFile ?? digestSharedPythonWheel
    const unverified: string[] = []
    for (const entry of missing) {
      let digest: string | undefined
      try {
        digest = digestFile(join(wheelsDirectory, entry.filename))
      } catch {
        digest = undefined
      }
      if (digest !== entry.sha256) unverified.push(entry.filename)
    }
    if (unverified.length > 0) {
      log(
        `dsh-plugin-desktop: the shared python environment's preinstalled wheels at ${wheelsDirectory} failed their pinned checksums (${unverified.join(', ')}); `
          + 'skipping this boot\'s library repair — the next boot retries once the wheels match the lock again',
      )
      return withSharedPythonLibraries(environment, pinned, countPinnedSharedPythonDistributions(lock, present))
    }
    const installDistributions = inputs.installDistributions ?? ((command, args, installOptions) =>
      spawnSharedPythonVirtualenv(
        command,
        args,
        installOptions,
        SHARED_PYTHON_LIBRARY_INSTALL_TIMEOUT_MS,
        SHARED_PYTHON_LIBRARY_INSTALL_DIAGNOSTIC_LIMIT,
      ))
    const outcome = await installDistributions(
      paths.pythonExecutable,
      sharedPythonLibraryInstallArguments(wheelsDirectory, missing),
      { environment: spawnEnvironment },
    )
    if (outcome.exitCode !== 0) {
      // A b93-era environment running an interpreter older than the cp312
      // wheel set fails every wheel with "is not a supported wheel on this
      // platform" — no flag combination heals that; name the palliative in
      // the same line so the next log read points straight at the fix
      // (#050 review P2).
      const platformMismatch = /is not a supported wheel on this platform/iu.test(outcome.diagnostic)
      log(
        `dsh-plugin-desktop: pip could not install the ${String(missing.length)} missing preinstalled python libraries into the shared python environment at ${paths.root}`
          + `${outcome.diagnostic === '' ? '' : ` (${outcome.diagnostic})`}; `
          + 'they stay missing until the next boot retries them'
          + (platformMismatch
            ? `; the environment's interpreter predates this build's wheels — delete ${paths.root} and restart to rebuild it`
            : ''),
      )
    } else {
      log(
        `dsh-plugin-desktop: installed ${String(missing.length)} missing preinstalled python libraries into the shared python environment at ${paths.root} from ${wheelsDirectory}`,
      )
    }
    // The repair verdict comes from a fresh probe — pip may have partially
    // succeeded (or partially failed), and the count must describe the tree.
    let recount: Readonly<Record<string, string>> | undefined
    try {
      recount = await probeDistributions(paths.pythonExecutable, { environment: spawnEnvironment })
    } catch {
      recount = undefined
    }
    const installedAfter = recount === undefined ? countPinnedSharedPythonDistributions(lock, present) : countPinnedSharedPythonDistributions(lock, recount)
    return withSharedPythonLibraries(environment, pinned, installedAfter)
  } catch (cause) {
    log(
      `dsh-plugin-desktop: the shared python environment's library repair check at ${wheelsDirectory} failed unexpectedly (${cause instanceof Error ? cause.message : String(cause)}); `
        + 'python aliases stay published and the check retries on the next boot',
    )
    return environment
  }
}

/**
 * Ensure-present step over the pinned preinstall wheel set (issue #043,
 * decision D2). Runs on the provisioning path — inside the same
 * cross-process mutex, so two instances never pip-install into the same
 * tree at once — and as a repair check on every later boot: one cheap
 * read-only probe names the missing pinned distributions, the install leg
 * re-derives that set from a second probe immediately before pip runs
 * (review P3-1: the leg can start minutes after the probe), pip runs only
 * when the re-derived set is non-empty, and each wheel the run would consume
 * is verified against the lock's sha256 first (see
 * {@link installSharedPythonLibraries}).
 *
 * Every failure degrades with one log line and never blocks the boot; the
 * result carries the `libraries` coverage counts when this boot can vouch
 * for them, and omits the field when it cannot.
 */
async function ensureSharedPythonLibraries(
  inputs: DesktopSharedPythonEnvironmentInputs,
  paths: DesktopSharedPythonEnvironmentPaths,
  environment: DesktopSharedPythonEnvironment,
): Promise<DesktopSharedPythonEnvironment> {
  if (inputs.wheelsDirectory === undefined || !environment.shared) return environment
  const repair = await probeSharedPythonLibraries(inputs, paths)
  if (repair === undefined) return environment
  const pinned = repair.lock.distributions.length
  if (repair.missing.length === 0) {
    return withSharedPythonLibraries(environment, pinned, pinned)
  }
  return await installSharedPythonLibraries(inputs, paths, environment, repair)
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
 * Whether a lock-layer failure is a transient filesystem error worth the
 * single bounded retry of issue #038: real `fs` failures carry an errno
 * `code`, while the mutex's contention-timeout failure is a plain `Error`
 * without one and keeps its degrade-with-log semantics instead.
 */
function isRetryableLockFailure(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && SHARED_PYTHON_LOCK_RETRYABLE_CODES.has(code)
}

/**
 * Whether one provisioning lock file records a holder process that is
 * provably gone (review P3-2). The age gate is twenty minutes, so without
 * this check a relaunch within that window of a mid-provision crash — the
 * case the lock exists for — would wait the whole bounded turn (~390 s)
 * before degrading, even though the holder died minutes ago. The lock file
 * records its holder's PID (the atomic-write package writes `<pid>\n`), and
 * `process.kill(pid, 0)` settles what mtime cannot: `ESRCH` proves the holder
 * no longer exists, while `EPERM` means the PID belongs to a live process
 * owned by someone else (and any other failure is doubt). Unreadable or
 * unparseable content — including the empty file a `wx` create leaves before
 * its write lands — is no proof either way, so both the "alive" and the
 * "no PID" answers leave the caller on the mtime gate.
 */
function sharedPythonLockHolderGone(lockFile: string): boolean {
  let text: string
  try {
    text = readFileSync(lockFile, 'utf8')
  } catch {
    return false
  }
  const trimmed = text.trim()
  if (!/^\d+$/u.test(trimmed)) return false
  const pid = Number.parseInt(trimmed, 10)
  // PID 0 addresses the whole process group on POSIX and is never a holder.
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (cause) {
    return (cause as NodeJS.ErrnoException | null)?.code === 'ESRCH'
  }
}

/**
 * Default cross-process provisioning mutex: an exclusive `<pyenv.provision>.lock`
 * beside the shared root, waited for at most
 * {@link SHARED_PYTHON_PROVISION_LOCK_WAIT_MS} (a productive wait — the holder
 * is provisioning the very tree the waiter wants) and broken once the lock is
 * provably dead or older than {@link SHARED_PYTHON_PROVISION_LOCK_STALE_MS},
 * because a crashed holder will never release and the shared surface must not
 * degrade forever after one crash. A holder whose recorded PID no longer
 * exists is reclaimed on sight ({@link sharedPythonLockHolderGone}); the age
 * gate backs that up for a lock that offers no liveness proof.
 */
async function withSharedPythonProvisionLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  now: () => number,
): Promise<T> {
  try {
    const lockFile = `${lockPath}.lock`
    const info = await stat(lockFile)
    if (sharedPythonLockHolderGone(lockFile)
      || now() - info.mtimeMs > SHARED_PYTHON_PROVISION_LOCK_STALE_MS) {
      await rm(lockFile, { force: true })
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
 * Preinstalled libraries (issue #043, decision D2): once the shared tree is
 * up, the same locked cycle runs the ensure-present step over the packaged
 * wheel set (`resources/python-wheels` + its lockfile) — one cheap read-only
 * probe names the missing pinned distributions, pip installs exactly those
 * from the local verified wheel files as a `--no-deps --upgrade` closed set
 * (never the network, no dependency resolution against stale tree
 * contents, and never an upgrade/downgrade of a name the user already
 * installed — re-derived from a fresh in-lock probe right before pip runs,
 * so an install that lands while the leg is deferred still wins: review
 * P3-1), and each consumed wheel is verified against the lock's sha256
 * first. With
 * `deferLibraryInstall` (the production boot, review P2-b) only the probe
 * rides the boot path; the pip leg (up to its 5-minute deadline) is a
 * fire-and-forget background repair behind the same mutex, so the aliases
 * and profile start as soon as the tree is up and the skills degrade
 * gracefully until the install heals them (this boot or a later one).
 * Either way the result carries `libraries` coverage counts for the
 * `python_runtime` telemetry row whenever this boot can vouch for them.
 *
 * Concurrency (review P3): the whole decide/probe/provision cycle runs under
 * a cross-process mutex beside the shared root, so two desktop instances
 * sharing `%LOCALAPPDATA%\\DSH Desktop` never write the same tree at once —
 * the second instance waits its bounded turn and then reuses the winner's
 * result (or rebuilds when the winner failed). A wait that outlasts the
 * bound degrades to the bundled aliases with one log line instead of
 * blocking the boot behind a stuck holder. The lock layer itself is
 * fail-open in three steps (issue #038): the lock parent directory is
 * created before the acquisition (the mutex cannot create it itself), a
 * transient filesystem failure of the acquisition gets exactly one bounded
 * retry, and a retry that fails too proceeds WITHOUT the lock under a loud
 * warning — the mutex guards a rare double-instance race whose damage the
 * once-semantics of the repair and reseed steps already bound, so a lock
 * layer that is down must never cost the provisioning itself (the pre-#038
 * behavior: any lock failure skipped the whole body, pip stayed unpublished
 * forever, and the #033 self-heal never ran). Only the defined
 * contention-timeout failure keeps its degrade-to-bundled semantics.
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
  // One boot's deferred library repair: the read-only probe runs on the boot
  // path (so the resolved environment still carries the pre-install coverage
  // counts) while the mutating pip leg is scheduled after the boot, behind
  // the same cross-process mutex (review P2-b).
  let deferredRepair: DesktopSharedPythonLibraryRepair | undefined
  const provision = async (): Promise<DesktopSharedPythonEnvironment> => {
    const environment = await provisionSharedPythonEnvironment(inputs, paths)
    if (!environment.shared) return environment
    if (inputs.deferLibraryInstall !== true) {
      return await ensureSharedPythonLibraries(inputs, paths, environment)
    }
    const repair = await probeSharedPythonLibraries(inputs, paths)
    if (repair === undefined) return environment
    const pinned = repair.lock.distributions.length
    if (repair.missing.length === 0) return withSharedPythonLibraries(environment, pinned, pinned)
    deferredRepair = repair
    return withSharedPythonLibraries(
      environment,
      pinned,
      countPinnedSharedPythonDistributions(repair.lock, repair.installed),
    )
  }
  // Schedule the deferred (or, on a healthy tree, already-complete) repair and
  // hand the boot its environment. The background leg re-acquires the SAME
  // cross-process mutex, so it can never race a concurrent provisioning —
  // when the lock is unavailable it logs and skips instead of installing
  // unsafely; a missing library then heals on a later boot.
  const finalize = (environment: DesktopSharedPythonEnvironment): DesktopSharedPythonEnvironment => {
    const repair = deferredRepair
    deferredRepair = undefined
    if (repair === undefined || !environment.shared) return environment
    void runLocked(lockPath, () => installSharedPythonLibraries(inputs, paths, environment, repair))
      .catch(cause => {
        log(
          `dsh-plugin-desktop: the background install of the shared python environment's preinstalled libraries at ${paths.root} did not run`
            + ` (${cause instanceof Error ? cause.message : String(cause)}); `
            + 'the libraries stay missing until the next boot retries them',
        )
      })
    return environment
  }
  // Issue #038, pinned cause — the mutex opens `<pyenv.provision>.lock`
  // through `writeFile(..., { flag: 'wx' })` and, unlike the same package's
  // `writeFileAtomic`, creates NO parent directory (its documented contract:
  // the parent must exist). An exclusive-create race is NOT the source: a
  // `wx` open onto an existing lock surfaces as `EEXIST`/`EPERM` contention
  // inside the bounded wait, and the only `ENOENT` escape anywhere in the
  // lock layer is that initial open hitting a MISSING PATH COMPONENT. The
  // component is `%LOCALAPPDATA%\\DSH Desktop` itself: nothing creates it
  // before this point — the directory is born as a side effect of the
  // provisioning that runs INSIDE the lock — so every first-ever provision
  // (a fresh install, a new Windows profile, a cleaner wiping LOCALAPPDATA)
  // hit Lucy's `ENOENT: ... open '...\\DSH Desktop\\pyenv.provision.lock'`
  // and skipped the whole provisioning body; antivirus removing the
  // just-created directory or lock file between operations is the same
  // failure in transient form. Layer 1 kills the missing-parent class:
  // a recursive mkdir before the acquisition is idempotent and cheap.
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch {
    // An uncreatable parent resurfaces as the acquisition failure below,
    // which retries and then degrades to lock-less provisioning — this
    // guard must never crash the boot itself.
  }
  try {
    return finalize(await runLocked(lockPath, provision))
  } catch (cause) {
    // Only the mutex reaches here — the operation itself never throws. A
    // refused or expired wait is the defined loser path: degrade exactly
    // like a failed provisioning tier, never block the boot.
    if (!isRetryableLockFailure(cause)) {
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
    // Issue #038, layer 2 — one bounded retry for transient filesystem
    // interference (antivirus quarantining the just-created lock file or
    // its parent directory): the failure left the operation unstarted or
    // left an idempotent probe-then-act cycle behind, so re-entering the
    // lock is safe.
    await new Promise(resolve => { setTimeout(resolve, SHARED_PYTHON_LOCK_RETRY_DELAY_MS) })
    try {
      const environment = await runLocked(lockPath, provision)
      log(
        `dsh-plugin-desktop: the shared python environment provisioning lock at ${lockPath}`
          + ` failed once (${cause instanceof Error ? cause.message : String(cause)}); `
          + 'the retry acquired it, so provisioning stayed serialized',
      )
      return finalize(environment)
    } catch (retryCause) {
      // Issue #038, layer 3 — provision WITHOUT the cross-process lock. The
      // worst outcome is no provisioning at all (pip unpublished forever,
      // the #033 self-heal dead), while the mutex only protects a rare
      // double-instance race whose failure mode — both instances
      // provisioning the same tree — is bounded by the once-semantics the
      // body already carries (ONE in-place ensurepip repair, ONE removal,
      // one full reseed per boot: see the removeAll-once paths above).
      // The once-semantics are per-process, not cross-process: two unlocked
      // instances CAN interleave removal/reseed (a torn tree this boot) —
      // convergence lands on the NEXT boot through the corrupt-branch heal
      // (review P3: the honest wording).
      log(
        `dsh-plugin-desktop: could not acquire the shared python environment provisioning lock at ${lockPath}`
          + ` (${retryCause instanceof Error ? retryCause.message : String(retryCause)}) even after one retry; `
          + 'provisioning WITHOUT the cross-process lock — concurrently starting desktop instances may '
          + 'rebuild the same tree, though every step keeps its once-semantics and the tree converges on the next boot',
      )
      return finalize(await provision())
    }
  }
}
