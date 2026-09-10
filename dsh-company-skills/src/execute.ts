/**
 * Company-skill script execution (P6 batch 3) — run one `scripts/…` entry that
 * travels inside the obfuscated bundle, staging it only for the lifetime of
 * the run (the code-runtime-python paradigm).
 *
 * ## The channel
 *
 * The whole skill — every `scripts[]` and every `assets[]` entry — is decoded
 * in memory and materialized at its own bundle-relative path into one private
 * per-run directory created with `mkdtemp` under a
 * `$TMPDIR/dsh-skill-assets-*` root, the interpreter is pointed at the
 * materialized script file (`argv = [<interpreter>,
 * <dir>/scripts/run.mjs, …]`), and the directory is removed in a `finally`
 * block the moment the run settles — including on timeout, cancellation, and
 * failure. Plaintext does not *persist*: nothing survives the run, and no log
 * line, telemetry event, or error message ever carries a byte of the body.
 *
 * On-disk modes (measured, not assumed): `mkdtemp` creates the private root
 * as 0700 on POSIX, the nested directories created for each entry default to
 * 0755 under the process umask, and every materialized file is written 0600.
 * `mode` is effectively ignored on Windows, where NTFS ACLs decide instead;
 * the guarantee there is the same as everywhere else — the directory is
 * private to the user and is deleted the moment the run settles.
 *
 * This shape is what makes unmodified collected skills work: `__file__`
 * locates the skill root (`Path(__file__).parent.parent` is the staged root,
 * exactly what `ppt-designer`'s `export_pptx.py` computes), sibling imports
 * resolve through `sys.path[0]` / the script's own directory, and the child's
 * working directory is the staged root so bundle-relative reads
 * (`reference/pptd.md`, `editor/index.html`) resolve as written.
 *
 * ## Reading resources
 *
 * The same bundle also carries prose a script expects the caller to have read
 * first (`reference/pptd.md`, `references/workflows.md`). `read()` is the text
 * channel for those: it addresses exactly one carried entry, materializes
 * just that entry into a private directory under the same staging root, reads
 * it back as UTF-8 text, and removes the directory in a `finally` block. The
 * path must equal a bundle entry exactly (no traversal), the entry must be
 * valid UTF-8 text (binaries are refused), and it must fit the read bound.
 * Neither the directory nor the bytes survive the call. `company_skill_read`
 * in the tool layer is the model-facing surface of `read()`.
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
 * file the interpreter runs is `<staged>/<that same path>`. Every other
 * entry — the rest of `scripts[]` and all of `assets[]` — materializes beside
 * it at its own relative path (`reference/pptd.md` lands at
 * `<dir>/reference/pptd.md`, `editor/index.html` at
 * `<dir>/editor/index.html`), the root is published to the child as
 * `DSH_SKILL_ASSETS`, serves as the child's `cwd`, and is deleted the moment
 * execution settles.
 *
 * ## Bounds
 *
 * Per-stream output is retained as a bounded **tail** (default 64 KiB), a
 * resource read fits a separate bound (default 256 KiB), the run has its own
 * deadline (default 120 s) independent of the caller's cancellation, at most
 * one run per session may be in flight (configurable), and every failure is a
 * {@link SkillRunError} whose message names the skill and path but never a
 * byte of the body.
 *
 * @module dsh-company-skills/execute
 */

import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

/** Largest single resource `read()` will decode as text. */
export const DEFAULT_MAX_READ_BYTES = 256 * 1024

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
  /** Largest resource {@link ScriptExecutor.read} returns as text. */
  readonly maxReadBytes: number
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

/** One resource-read request: a carried entry addressed by exact path. */
export interface ReadResourceRequest {
  /** Skill name exactly as the catalog lists it. */
  readonly skill: string
  /** Bundle-root-relative path that must equal exactly one carried entry. */
  readonly path: string
  /** Reject when the entry exceeds this many bytes; defaults to `limits.maxReadBytes`. */
  readonly maxBytes?: number
}

/** One decoded text resource. */
export interface ReadResourceResult {
  readonly skill: string
  readonly path: string
  readonly text: string
  /** Byte length of the decoded text (equal to the entry's byte length). */
  readonly bytes: number
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
  /**
   * Decode exactly one carried entry as UTF-8 text, materializing it only for
   * the duration of the call.
   * @param request - addressed entry and optional read bound.
   * @returns the entry's text and byte length.
   * @throws {SkillRunError} for an unknown skill/entry, a binary entry, or an
   * entry over the read bound — never for a body byte.
   */
  read(request: ReadResourceRequest): Promise<ReadResourceResult>
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
  /** Largest resource a read returns as text; defaults to 256 KiB. */
  readonly maxReadBytes?: number
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
    maxReadBytes: options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
  }
  assertPositiveInteger('timeoutMs', limits.timeoutMs)
  assertPositiveInteger('graceMs', limits.graceMs)
  assertPositiveInteger('maxOutputBytes', limits.maxOutputBytes)
  assertPositiveInteger('maxConcurrentPerSession', limits.maxConcurrentPerSession)
  assertPositiveInteger('maxReadBytes', limits.maxReadBytes)
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

/** Locate one carried entry (script or asset) by exact path equality — never by path arithmetic. */
function findEntry(bundle: SkillBundle, path: string): { path: string; content: string } | undefined {
  const entry = [...bundle.scripts, ...bundle.assets].find((candidate) => candidate.path === path)
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
 * Reject an addressed script that is not valid UTF-8 before anything is
 * staged or spawned (a binary script can never be decoded losslessly, and the
 * error carries no bytes). Entry content in general is written as raw bytes:
 * a collected skill legitimately carries binaries under `scripts/` (a WASM
 * module), and only the entry actually handed to an interpreter must be text.
 */
function assertScriptText(bundle: SkillBundle, script: { path: string; content: string }): void {
  const bytes = decodeCanonicalBase64(script.content, `${bundle.name} script ${script.path}`)
  try {
    UTF8_DECODER.decode(bytes)
  } catch (cause) {
    throw new SkillRunError(
      `company skill "${bundle.name}" script "${script.path}" is not valid UTF-8 text`,
      { cause },
    )
  }
}

/**
 * Materialize the whole skill — every `scripts[]` and every `assets[]` entry —
 * into one private temp directory that stands in for the skill root, at each
 * entry's own bundle-relative path: `scripts/export_pptx.py` lands at
 * `<dir>/scripts/export_pptx.py`, `editor/index.html` at
 * `<dir>/editor/index.html`, `reference/pptd.md` at `<dir>/reference/pptd.md`.
 * The root is created 0700 by `mkdtemp`; entry directories default to 0755
 * under the process umask and files are written 0600 (`mode` is a no-op on
 * Windows). On any failure the partial directory is removed before the error
 * propagates, so a failed run leaves nothing behind.
 * @param bundle - the skill whose entries are staged.
 * @param tempRoot - the temp root to create the private directory under.
 * @returns the directory published as `DSH_SKILL_ASSETS` and used as `cwd`.
 */
async function stageBundle(bundle: SkillBundle, tempRoot: string): Promise<string> {
  const directory = await mkdtemp(join(tempRoot, ASSETS_TMP_PREFIX))
  try {
    for (const entry of [...bundle.scripts, ...bundle.assets]) {
      // `entry.path` passed bundle validation (normalized relative, not
      // escaping, and disjoint between the two arrays), so joining it onto the
      // private directory cannot escape.
      const target = join(directory, entry.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, decodeCanonicalBase64(entry.content, `${bundle.name} entry ${entry.path}`), { mode: 0o600 })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    // A SkillRunError is already a classified rejection; wrapping it would
    // only hide the cause.
    if (error instanceof SkillRunError) throw error
    throw new SkillRunError(`company skill "${bundle.name}" could not be staged for execution`, { cause: error })
  }
  return directory
}

/**
 * Materialize exactly one entry into its own private per-read directory so it
 * can be read back as text; the caller removes the directory in a `finally`
 * block. The same `mkdtemp`/`ASSETS_TMP_PREFIX` staging root the run channel
 * uses is reused, and the entry lands at its own relative path.
 * @param bundle - the skill the entry belongs to.
 * @param entry - the addressed entry.
 * @param bytes - the entry's decoded bytes.
 * @param tempRoot - the temp root to create the private directory under.
 * @returns the private directory and the materialized file path.
 */
async function stageEntry(
  bundle: SkillBundle,
  entry: { path: string },
  bytes: Buffer,
  tempRoot: string,
): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tempRoot, ASSETS_TMP_PREFIX))
  try {
    const file = join(directory, entry.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes, { mode: 0o600 })
    return { directory, file }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    if (error instanceof SkillRunError) throw error
    throw new SkillRunError(`company skill "${bundle.name}" resource "${entry.path}" could not be staged`, { cause: error })
  }
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
    // A script that is not valid UTF-8 rejects before any staging or spawn.
    assertScriptText(bundle, script)
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
          // The warning sink is user-supplied: a throwing sink must not
          // replace the already-settled result (or the classified rejection).
          try {
            logWarning(
              `dsh-company-skills: could not remove the staged skill files for company skill "${bundle.name}" `
              + `script "${script.path}": ${error instanceof Error ? error.message : String(error)}`,
            )
          } catch {
            // Swallowed on purpose: cleanup reporting is best-effort.
          }
        }
      }
    }
  }

  async function read(request: ReadResourceRequest): Promise<ReadResourceResult> {
    const bound = request.maxBytes ?? limits.maxReadBytes
    if (!Number.isInteger(bound) || bound < 1) {
      throw new SkillRunError(
        `company skill "${request.skill}" read bound must be a positive integer (got ${JSON.stringify(request.maxBytes)})`,
      )
    }
    const loaded = options.catalog.skill(request.skill)
    if (!loaded.ok) {
      throw new SkillRunError(`cannot read from company skill "${request.skill}": ${loaded.reason}`)
    }
    const bundle = loaded.bundle
    // The path is compared for exact equality against the carried entries, so
    // `../`, absolute paths, and unknown names all reject without a disk write.
    const entry = findEntry(bundle, request.path)
    if (entry === undefined) {
      throw new SkillRunError(`company skill "${bundle.name}" carries no resource "${request.path}"`)
    }
    const bytes = decodeCanonicalBase64(entry.content, `${bundle.name} resource ${entry.path}`)
    if (bytes.byteLength > bound) {
      throw new SkillRunError(
        `company skill "${bundle.name}" resource "${entry.path}" is ${String(bytes.byteLength)} bytes, `
        + `over the ${String(bound)}-byte read bound`,
      )
    }

    let staged: { directory: string; file: string } | undefined
    try {
      staged = await stageEntry(bundle, entry, bytes, tempRoot)
      const stagedBytes = await readFile(staged.file)
      let text: string
      try {
        text = UTF8_DECODER.decode(stagedBytes)
      } catch (cause) {
        throw new SkillRunError(
          `company skill "${bundle.name}" resource "${entry.path}" is not UTF-8 text; `
          + 'binary resources cannot be read',
          { cause },
        )
      }
      return { skill: bundle.name, path: entry.path, text, bytes: stagedBytes.byteLength }
    } finally {
      if (staged !== undefined) {
        try {
          await (options.removeStagedAssets ?? ((directory: string) => rm(directory, { recursive: true, force: true })))(staged.directory)
        } catch (error) {
          try {
            logWarning(
              `dsh-company-skills: could not remove the staged files for company skill "${bundle.name}" `
              + `resource "${entry.path}": ${error instanceof Error ? error.message : String(error)}`,
            )
          } catch {
            // Swallowed on purpose: cleanup reporting is best-effort.
          }
        }
      }
    }
  }

  return { limits, run, read }
}
