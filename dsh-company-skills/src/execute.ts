/**
 * Company-skill script execution (P6 batch 3) — run one `scripts/…` entry that
 * travels inside the obfuscated bundle, staging it only for the lifetime of
 * the run (the code-runtime-python paradigm).
 *
 * ## The channel
 *
 * The whole skill — every `scripts[]` and every `assets[]` entry — is decoded
 * in memory and materialized into one private per-run directory created with
 * `mkdtemp` (mode 0600 files under a `$TMPDIR/dsh-skill-assets-*` root), the
 * interpreter is pointed at the materialized script file
 * (`argv = [<interpreter>, <dir>/scripts/run.mjs, …]`), and the directory is
 * removed in a `finally` block the moment the run settles — including on
 * timeout, cancellation, and failure. Plaintext does not *persist*: nothing
 * survives the run, and no log line, telemetry event, or error message ever
 * carries a byte of the body.
 *
 * This shape is what makes unmodified collected skills work: `__file__`
 * locates the skill root (`Path(__file__).parent.parent` is the staged root,
 * exactly what `ppt-designer`'s `export_pptx.py` computes), sibling imports
 * resolve through `sys.path[0]` / the script's own directory, and the child's
 * working directory is the staged root so bundle-relative reads
 * (`assets/notes.md`, `reference/pptd.md`) resolve as written.
 *
 * ## Interpreter selection
 *
 * The extension picks the interpreter *family*: `.mjs`/`.js` → Node, `.py` →
 * Python. The exact command is then resolved, in order:
 *
 * - Node: `DSH_DESKTOP_NODE_EXECUTABLE` (the absolute command the desktop
 *   publishes for its bundled runtime) → `node` on the child's `PATH` → the
 *   host executable itself (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`,
 *   which is Node in a CLI host and Electron-as-Node in the desktop.
 * - Python: `DSH_DESKTOP_PYTHON_EXECUTABLE` → `python` on the child's `PATH`.
 *   There is no host-executable fallback: an unresolvable Python interpreter
 *   rejects with a clear error naming the skill and script path.
 *
 * The desktop publishes the two variables because on a packaged Windows
 * machine the only PATH entries are `.cmd` shims that `spawn` (no shell)
 * cannot execute. This module never imports a desktop module: it reads the
 * process environment and stays a standalone plugin. An extension with no
 * interpreter family is rejected before anything spawns.
 *
 * ## Addressing, staging, and assets
 *
 * `script` must be exactly one of the skill bundle's own `scripts[]` paths
 * (`bundle-root-relative`, e.g. `scripts/run.mjs`); it is compared for
 * equality, never joined into a filesystem path, so `../` cannot escape — the
 * file the interpreter runs is `<staged>/scripts/<that same path>`. When the
 * skill carries assets they materialize beside the scripts under the same
 * private root — `assets/notes.md` lands at `<dir>/assets/notes.md` — the root
 * is published to the child as `DSH_SKILL_ASSETS`, serves as the child's
 * `cwd`, and is deleted the moment execution settles.
 *
 * ## Bounds
 *
 * Per-stream output is retained as a bounded **tail** (default 64 KiB), the
 * run has its own deadline (default 120 s) independent of the caller's
 * cancellation, at most one run per session may be in flight (configurable),
 * and every failure is a {@link SkillRunError} whose message names the skill
 * and script path but never a byte of the body.
 *
 * @module dsh-company-skills/execute
 */

import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { CompanySkillCatalog } from './catalog.js'
import type { SkillBundle } from './bundle.js'
import { decodeCanonicalBase64 } from './codec.js'

/** The subprocess seam the executor writes through; `ctx.subprocess.spawn` in the plugin. */
export type ScriptSpawn = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** Cooperative deadline for one script run, milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Terminate-escalation grace handed to the subprocess seam, milliseconds. */
export const DEFAULT_GRACE_MS = 5_000

/** Retained bytes per output stream; overflow keeps the tail. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** Concurrent runs allowed per session; one keeps a stuck script from flooding the session. */
export const DEFAULT_MAX_CONCURRENT_PER_SESSION = 1

/** Environment variable carrying the staged skill root (scripts + assets) to the child. */
export const ASSETS_ENV_VAR = 'DSH_SKILL_ASSETS'

/** Prefix of the per-run staged-skill directory under the temp root. */
export const ASSETS_TMP_PREFIX = 'dsh-skill-assets-'

/** Node's largest representable timer delay: a longer bound would overflow its timer. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Extension → interpreter family, resolved to a command by {@link resolveInterpreter}. */
const INTERPRETER_BY_EXTENSION: ReadonlyMap<string, ScriptInterpreterFamily> = new Map([
  ['.mjs', 'node'],
  ['.js', 'node'],
  ['.py', 'python'],
])

/** Desktop-published absolute Node command; preferred over the `PATH` lookup. */
export const DESKTOP_NODE_EXECUTABLE_ENV = 'DSH_DESKTOP_NODE_EXECUTABLE'

/** Desktop-published absolute Python command; preferred over the `PATH` lookup. */
export const DESKTOP_PYTHON_EXECUTABLE_ENV = 'DSH_DESKTOP_PYTHON_EXECUTABLE'

/** Electron's "run as a plain Node CLI" switch, paired with `process.execPath`. */
export const ELECTRON_RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'

/** The interpreter families the executor can launch. */
export type ScriptInterpreterFamily = 'node' | 'python'

/** One resolved and enforced execution bound. */
export interface ScriptExecutorLimits {
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxOutputBytes: number
  readonly maxConcurrentPerSession: number
}

/** One run request: the addressed script plus the caller-owned execution context. */
export interface RunScriptRequest {
  /** Skill name exactly as the catalog lists it. */
  readonly skill: string
  /** Bundle-root-relative script path that must be one of the skill's own scripts. */
  readonly script: string
  /** Extra argv appended after the materialized script path. */
  readonly args?: readonly string[]
  /** Session identity for the concurrency bound. */
  readonly sessionKey: string
  /** Caller cancellation, forwarded to the subprocess seam. */
  readonly signal: AbortSignal
}

/** One bounded output stream: text plus whether the head was dropped. */
export interface ScriptOutput {
  readonly text: string
  readonly truncated: boolean
}

/** A settled run that reached `close` normally. */
export interface RunScriptResult {
  readonly skill: string
  readonly script: string
  /** Process exit code; signal-terminated runs reject instead of reporting here. */
  readonly exitCode: number
  readonly stdout: ScriptOutput
  readonly stderr: ScriptOutput
}

/** The execution surface the tool layer consumes. */
export interface ScriptExecutor {
  readonly limits: ScriptExecutorLimits
  /**
   * Validate, stage, and run one script. The child runs with its working
   * directory at the staged skill root.
   * @param request - addressed script, session identity, and cancellation.
   * @returns the exit code and bounded output.
   * @throws {SkillRunError} for any rejected address, bound, or launch failure.
   */
  run(request: RunScriptRequest): Promise<RunScriptResult>
}

/** Construction options; every bound and the spawn seam are explicit for testability. */
export interface ScriptExecutorOptions {
  /** The catalog the scripts are read from. */
  readonly catalog: CompanySkillCatalog
  /** The subprocess seam, normally `(spec) => ctx.subprocess.spawn(spec)`. */
  readonly spawn: ScriptSpawn
  readonly timeoutMs?: number
  readonly graceMs?: number
  readonly maxOutputBytes?: number
  readonly maxConcurrentPerSession?: number
  /** Temp root for the staged-skill directory; defaults to `os.tmpdir()`. */
  readonly tempRoot?: string
  /**
   * Interpreter-resolution seam; defaults to this process's environment,
   * platform, `execPath`, and a real `PATH` probe. Tests override it to make
   * the injected/PATH/host-executable order deterministic.
   */
  readonly interpreterResolution?: InterpreterResolutionInputs
  /** Injected staged-directory remover; defaults to `fs.rm(..., { recursive, force })`. */
  readonly removeStagedAssets?: (directory: string) => Promise<void>
  /** Cleanup-failure sink; defaults to a no-op so a warning never changes a result. */
  readonly logWarning?: (message: string) => void
}

/** Inputs controlling one interpreter resolution. */
export interface InterpreterResolutionInputs {
  /** Environment read for the desktop-published command; defaults to `process.env`. */
  readonly environment?: NodeJS.ProcessEnv
  /** Platform selecting the `PATH` dialect and executable extensions. */
  readonly platform?: NodeJS.Platform
  /** Host executable used as the Node fallback; defaults to `process.execPath`. */
  readonly execPath?: string
  /** Executable probe over the resolved environment; defaults to a real `PATH` search. */
  readonly commandOnPath?: (command: string) => boolean
  /** File-existence probe for the desktop-published command; defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean
}

/** One resolved interpreter command plus the child environment it requires. */
export interface ResolvedInterpreter {
  /** `argv[0]` handed to the subprocess seam. */
  readonly command: string
  /** Extra environment entries to merge into the spawn spec. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * Every rejection this module raises. The message names the skill and script
 * (both catalog metadata) and never carries body, asset, or output bytes.
 */
export class SkillRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SkillRunError'
  }
}

/** Map one script path to its interpreter family, or `undefined` when unsupported. */
export function interpreterFor(scriptPath: string): ScriptInterpreterFamily | undefined {
  return INTERPRETER_BY_EXTENSION.get(extname(scriptPath).toLowerCase())
}

/** The extensions this executor can launch, in a stable display order. */
export function supportedScriptExtensions(): readonly string[] {
  return [...INTERPRETER_BY_EXTENSION.keys()]
}

/** Whether one command is executable on the environment's `PATH`.
 *
 * Windows only accepts a native image (`.exe`/`.com`): a `.cmd` shim on `PATH`
 * is not executable by a shell-less spawn, which is exactly the packaged-desktop
 * case the injected variable exists to bypass. */
function executableOnPath(command: string, environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const rawPath = platform === 'win32'
    ? Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    : environment.PATH ?? ''
  const delimiter = platform === 'win32' ? ';' : ':'
  const extensions = platform === 'win32' ? ['.exe', '.com'] : ['']
  for (const directory of rawPath.split(delimiter)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      try {
        const stat = statSync(join(directory, command + extension))
        if (stat.isFile() && (platform === 'win32' || (stat.mode & 0o111) !== 0)) return true
      } catch {
        // Not this candidate; keep searching the remaining PATH entries.
      }
    }
  }
  return false
}

/**
 * Resolve one interpreter family to a concrete command.
 *
 * Order: the desktop-published absolute command, then the bare family name on
 * the child's `PATH`, then — for Node only — the host executable itself with
 * `ELECTRON_RUN_AS_NODE=1` (Node in a CLI host, Electron-as-Node in the
 * desktop). Python has no host-executable fallback.
 * @param family - the extension-selected interpreter family.
 * @param inputs - environment, platform, host-executable, and `PATH`-probe seams.
 * @returns the command and its required child environment, or `undefined` when
 * no Python interpreter is available.
 */
export function resolveInterpreter(
  family: ScriptInterpreterFamily,
  inputs: InterpreterResolutionInputs = {},
): ResolvedInterpreter | undefined {
  const environment = inputs.environment ?? process.env
  const platform = inputs.platform ?? process.platform
  const injected = environment[family === 'node' ? DESKTOP_NODE_EXECUTABLE_ENV : DESKTOP_PYTHON_EXECUTABLE_ENV]
  // The desktop only publishes a path it verified, but a CLI host inherits the
  // user's shell: a stale export of the same name must not turn a working
  // fallback into a launch failure, so the value is probed before it is used.
  if (injected !== undefined && injected.length > 0 && (inputs.exists ?? existsSync)(injected)) {
    return { command: injected, env: {} }
  }
  const commandOnPath = inputs.commandOnPath ?? ((command: string) => executableOnPath(command, environment, platform))
  if (commandOnPath(family)) return { command: family, env: {} }
  if (family === 'python') return undefined
  return { command: inputs.execPath ?? process.execPath, env: { [ELECTRON_RUN_AS_NODE_ENV]: '1' } }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-company-skills: ${name} must be a positive integer`)
  }
}

function resolveLimits(options: ScriptExecutorOptions): ScriptExecutorLimits {
  const limits: ScriptExecutorLimits = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxConcurrentPerSession: options.maxConcurrentPerSession ?? DEFAULT_MAX_CONCURRENT_PER_SESSION,
  }
  assertPositiveInteger('timeoutMs', limits.timeoutMs)
  assertPositiveInteger('graceMs', limits.graceMs)
  assertPositiveInteger('maxOutputBytes', limits.maxOutputBytes)
  assertPositiveInteger('maxConcurrentPerSession', limits.maxConcurrentPerSession)
  if (limits.timeoutMs > MAX_TIMER_DELAY_MS || limits.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-company-skills: timeoutMs and graceMs must be no greater than ${String(MAX_TIMER_DELAY_MS)}`)
  }
  return limits
}

/** Locate one declared script by exact path equality — never by path arithmetic. */
function findScript(bundle: SkillBundle, script: string): { path: string; content: string } | undefined {
  const entry = bundle.scripts.find((candidate) => candidate.path === script)
  return entry === undefined ? undefined : { path: entry.path, content: entry.content }
}

/** Render the declared script paths for a rejection message (paths are catalog metadata). */
function describeScripts(bundle: SkillBundle): string {
  return bundle.scripts.length === 0
    ? 'none'
    : bundle.scripts.map((entry) => `"${entry.path}"`).join(', ')
}

/** Strict UTF-8 decoder: invalid bytes throw instead of becoming U+FFFD. */
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * Decode one base64 bundle entry to UTF-8 script text. Invalid UTF-8 is a
 * rejection (never a silently lossy decode), and the error carries no bytes.
 */
function decodeScriptText(bundle: SkillBundle, script: { path: string; content: string }): string {
  const bytes = decodeCanonicalBase64(script.content, `${bundle.name} script ${script.path}`)
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw new SkillRunError(
      `company skill "${bundle.name}" script "${script.path}" is not valid UTF-8 text`,
      { cause },
    )
  }
}

/**
 * Materialize the whole skill — every script and every asset — into one
 * private temp directory that stands in for the skill root: `scripts/run.mjs`
 * lands at `<dir>/scripts/run.mjs`, `assets/notes.md` at
 * `<dir>/assets/notes.md`. Script entries are validated as UTF-8 text before
 * they are written (a binary script is a rejection, never a lossy decode).
 * On any failure the partial directory is removed before the error
 * propagates, so a failed run leaves nothing behind.
 * @param bundle - the skill whose scripts and assets are staged.
 * @param tempRoot - the temp root to create the private directory under.
 * @returns the directory published as `DSH_SKILL_ASSETS` and used as `cwd`.
 */
async function stageBundle(bundle: SkillBundle, tempRoot: string): Promise<string> {
  const directory = await mkdtemp(join(tempRoot, ASSETS_TMP_PREFIX))
  try {
    for (const script of bundle.scripts) {
      // `script.path` passed bundle validation (normalized relative, under
      // `scripts/`), so joining it onto the private directory cannot escape.
      const target = join(directory, script.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, decodeScriptText(bundle, script), { mode: 0o600 })
    }
    for (const asset of bundle.assets) {
      // `asset.path` passed bundle validation (normalized relative, under
      // `assets/`), so joining it onto the private directory cannot escape.
      const target = join(directory, asset.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, decodeCanonicalBase64(asset.content, `${bundle.name} asset ${asset.path}`), { mode: 0o600 })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    // A SkillRunError is already a classified rejection (for example the
    // invalid-UTF-8 script diagnosis); wrapping it would only hide the cause.
    if (error instanceof SkillRunError) throw error
    throw new SkillRunError(`company skill "${bundle.name}" could not be staged for execution`, { cause: error })
  }
  return directory
}

/** Read one collected stream at offset 0; `lossy` is the seam's truncation fact. */
function collectOutput(reader: SubprocessOutputReader | undefined): ScriptOutput {
  if (reader === undefined) return { text: '', truncated: false }
  const read = reader.readFrom(0)
  return { text: read.text, truncated: read.lossy }
}

/**
 * Build the executor for one catalog.
 * @param options - catalog, spawn seam, and the resolved bounds.
 * @returns the executor the tool layer registers.
 */
export function createScriptExecutor(options: ScriptExecutorOptions): ScriptExecutor {
  const limits = resolveLimits(options)
  const tempRoot = options.tempRoot ?? tmpdir()
  const logWarning = options.logWarning ?? (() => {})
  const activeBySession = new Map<string, number>()

  const release = (sessionKey: string): void => {
    const remaining = (activeBySession.get(sessionKey) ?? 1) - 1
    if (remaining <= 0) activeBySession.delete(sessionKey)
    else activeBySession.set(sessionKey, remaining)
  }

  async function run(request: RunScriptRequest): Promise<RunScriptResult> {
    const loaded = options.catalog.skill(request.skill)
    if (!loaded.ok) {
      throw new SkillRunError(`cannot run company skill "${request.skill}": ${loaded.reason}`)
    }
    const bundle = loaded.bundle
    const script = findScript(bundle, request.script)
    if (script === undefined) {
      throw new SkillRunError(
        `company skill "${bundle.name}" carries no script "${request.script}"; its scripts are ${describeScripts(bundle)}`,
      )
    }
    const family = interpreterFor(script.path)
    if (family === undefined) {
      throw new SkillRunError(
        `company skill "${bundle.name}" script "${script.path}" has no supported interpreter `
        + `(supported extensions: ${supportedScriptExtensions().join(', ')})`,
      )
    }
    const interpreter = resolveInterpreter(family, options.interpreterResolution)
    if (interpreter === undefined) {
      const variable = family === 'python' ? DESKTOP_PYTHON_EXECUTABLE_ENV : DESKTOP_NODE_EXECUTABLE_ENV
      throw new SkillRunError(
        `company skill "${bundle.name}" script "${script.path}" cannot run: `
        + `no ${family} interpreter was found (set ${variable} or put ${family} on PATH)`,
      )
    }

    const running = activeBySession.get(request.sessionKey) ?? 0
    if (running >= limits.maxConcurrentPerSession) {
      throw new SkillRunError(
        `company skill "${bundle.name}" script "${script.path}" is already running for this session `
        + `(at most ${String(limits.maxConcurrentPerSession)} concurrent run may be in flight)`,
      )
    }
    activeBySession.set(request.sessionKey, running + 1)

    // A start failure is classified before it is reported: a deadline or a
    // caller abort arriving between the claim and the spawn is a timeout or a
    // cancellation, not a launch failure.
    const failLaunch = (command: string, error: unknown): never => {
      if (timedOut) {
        throw new SkillRunError(
          `company skill "${bundle.name}" script "${script.path}" timed out after ${String(limits.timeoutMs)} ms`,
        )
      }
      if (request.signal.aborted) {
        throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" was cancelled`)
      }
      throw new SkillRunError(
        `company skill "${bundle.name}" script "${script.path}" could not start (${command} launch failed)`,
        { cause: error },
      )
    }

    // The run's own deadline, fused with the caller's cancellation: whichever
    // fires first aborts the seam's signal and terminates the process tree.
    const deadline = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      deadline.abort()
    }, limits.timeoutMs)
    const signal = AbortSignal.any([request.signal, deadline.signal])

    let stagedRoot: string | undefined
    try {
      stagedRoot = await stageBundle(bundle, tempRoot)
      const env: Record<string, string> = { ...interpreter.env, [ASSETS_ENV_VAR]: stagedRoot }
      const spec: SubprocessSpawnSpec = {
        argv: [interpreter.command, join(stagedRoot, script.path), ...(request.args ?? [])],
        cwd: stagedRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: limits.maxOutputBytes },
          stderr: { maxBytes: limits.maxOutputBytes },
        },
        graceMs: limits.graceMs,
        signal,
        env,
      }

      // The definite-assignment assertions hold because `failLaunch` never returns.
      let handle!: SubprocessHandle
      try {
        handle = options.spawn(spec)
      } catch (error) {
        failLaunch(interpreter.command, error)
      }

      let outcome!: SubprocessOutcome
      try {
        outcome = await handle.done
      } catch (error) {
        failLaunch(interpreter.command, error)
      }

      if (timedOut) {
        throw new SkillRunError(
          `company skill "${bundle.name}" script "${script.path}" timed out after ${String(limits.timeoutMs)} ms`,
        )
      }
      // The caller signal can abort while `done` is awaited; a plain read cannot
      // see that transition.
      if (request.signal.aborted) {
        throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" was cancelled`)
      }
      if (outcome.exitCode === null) {
        throw new SkillRunError(
          `company skill "${bundle.name}" script "${script.path}" was terminated by signal ${outcome.signal ?? 'unknown'}`,
        )
      }
      return {
        skill: bundle.name,
        script: script.path,
        exitCode: outcome.exitCode,
        stdout: collectOutput(handle.collected.stdout),
        stderr: collectOutput(handle.collected.stderr),
      }
    } finally {
      clearTimeout(timer)
      release(request.sessionKey)
      if (stagedRoot !== undefined) {
        // A cleanup failure (Windows can report EPERM while a just-exited child
        // still holds a handle) must never turn a settled run into an error.
        try {
          await (options.removeStagedAssets ?? ((directory: string) => rm(directory, { recursive: true, force: true })))(stagedRoot)
        } catch (error) {
          logWarning(
            `dsh-company-skills: could not remove the staged skill files for company skill "${bundle.name}" `
            + `script "${script.path}": ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  return { limits, run }
}
