/**
 * Company-skill script execution (P6 batch 3) — run one `scripts/…` entry that
 * travels inside the obfuscated bundle, without ever writing the script itself
 * to disk.
 *
 * ## The channel
 *
 * The script's plaintext text is decoded in memory and handed to the
 * interpreter over **stdin** (`node -` / `python -`), so the source bytes only
 * ever touch the parent's heap and the child's pipe. Nothing here writes a
 * script to the filesystem: no workspace file, no temp file, no log line, no
 * error message. The only disk artifacts are the *assets* (see below), which
 * are staged on demand and removed in a `finally` block.
 *
 * ## Interpreter selection
 *
 * The extension picks the interpreter: `.mjs`/`.js` → `node`, `.py` →
 * `python`. The bare name is resolved by the subprocess seam against the
 * child's `PATH` (the desktop injects its bundled runtime commands there), so
 * this module imports nothing from the desktop and stays a standalone plugin.
 * An extension with no interpreter is rejected before anything spawns.
 *
 * ## Addressing and assets
 *
 * `script` must be exactly one of the skill bundle's own `scripts[]` paths
 * (`bundle-root-relative`, e.g. `scripts/run.mjs`); it is compared for
 * equality, never joined into a filesystem path, so `../` cannot escape.
 * When the skill carries assets they are materialized under one private
 * `mkdtemp` directory (`$TMPDIR/dsh-skill-assets-*`) that stands in for the
 * bundle root — `assets/notes.md` lands at `<dir>/assets/notes.md` — and the
 * directory is published to the child as `DSH_SKILL_ASSETS` and deleted the
 * moment execution settles, including on timeout, cancellation, and failure.
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

/** Environment variable carrying the staged-assets directory to the child. */
export const ASSETS_ENV_VAR = 'DSH_SKILL_ASSETS'

/** Prefix of the per-run staged-assets directory under the temp root. */
export const ASSETS_TMP_PREFIX = 'dsh-skill-assets-'

/** Node's largest representable timer delay: a longer bound would overflow its timer. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Extension → interpreter command, resolved against the child's `PATH`. */
const INTERPRETER_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.mjs', 'node'],
  ['.js', 'node'],
  ['.py', 'python'],
])

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
  /** Extra argv appended after the interpreter's `-` script marker. */
  readonly args?: readonly string[]
  /** Working directory for the child (the session workspace when available). */
  readonly cwd: string
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
   * Validate, stage, and run one script.
   * @param request - addressed script, cwd, session identity, and cancellation.
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
  /** Temp root for the staged-assets directory; defaults to `os.tmpdir()`. */
  readonly tempRoot?: string
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

/** Map one script path to its interpreter command, or `undefined` when unsupported. */
export function interpreterFor(scriptPath: string): string | undefined {
  return INTERPRETER_BY_EXTENSION.get(extname(scriptPath).toLowerCase())
}

/** The extensions this executor can launch, in a stable display order. */
export function supportedScriptExtensions(): readonly string[] {
  return [...INTERPRETER_BY_EXTENSION.keys()]
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

/** Decode one base64 bundle entry to UTF-8 script text. */
function decodeScriptText(bundle: SkillBundle, script: { path: string; content: string }): string {
  return decodeCanonicalBase64(script.content, `${bundle.name} script ${script.path}`).toString('utf8')
}

/**
 * Stage every asset under one private temp directory that stands in for the
 * bundle root. On any failure the partial directory is removed before the
 * error propagates, so a failed run leaves nothing behind.
 * @param bundle - the skill whose assets are staged.
 * @param tempRoot - the temp root to create the private directory under.
 * @returns the directory published as `DSH_SKILL_ASSETS`.
 */
async function stageAssets(bundle: SkillBundle, tempRoot: string): Promise<string> {
  const directory = await mkdtemp(join(tempRoot, ASSETS_TMP_PREFIX))
  try {
    for (const asset of bundle.assets) {
      // `asset.path` passed bundle validation (normalized relative, under
      // `assets/`), so joining it onto the private directory cannot escape.
      const target = join(directory, asset.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, decodeCanonicalBase64(asset.content, `${bundle.name} asset ${asset.path}`), { mode: 0o600 })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw new SkillRunError(`company skill "${bundle.name}" assets could not be staged for execution`, { cause: error })
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
    const interpreter = interpreterFor(script.path)
    if (interpreter === undefined) {
      throw new SkillRunError(
        `company skill "${bundle.name}" script "${script.path}" has no supported interpreter `
        + `(supported extensions: ${supportedScriptExtensions().join(', ')})`,
      )
    }
    const body = decodeScriptText(bundle, script)

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
    const failLaunch = (interpreter: string, error: unknown): never => {
      if (timedOut) {
        throw new SkillRunError(
          `company skill "${bundle.name}" script "${script.path}" timed out after ${String(limits.timeoutMs)} ms`,
        )
      }
      if (request.signal.aborted) {
        throw new SkillRunError(`company skill "${bundle.name}" script "${script.path}" was cancelled`)
      }
      throw new SkillRunError(
        `company skill "${bundle.name}" script "${script.path}" could not start (${interpreter} launch failed)`,
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

    let assetsDirectory: string | undefined
    try {
      if (bundle.assets.length > 0) assetsDirectory = await stageAssets(bundle, tempRoot)
      const spec: SubprocessSpawnSpec = {
        argv: [interpreter, '-', ...(request.args ?? [])],
        cwd: request.cwd,
        stdio: {
          stdin: { data: body },
          stdout: { maxBytes: limits.maxOutputBytes },
          stderr: { maxBytes: limits.maxOutputBytes },
        },
        graceMs: limits.graceMs,
        signal,
        ...(assetsDirectory === undefined ? {} : { env: { [ASSETS_ENV_VAR]: assetsDirectory } }),
      }

      // The definite-assignment assertions hold because `failLaunch` never returns.
      let handle!: SubprocessHandle
      try {
        handle = options.spawn(spec)
      } catch (error) {
        failLaunch(interpreter, error)
      }

      let outcome!: SubprocessOutcome
      try {
        outcome = await handle.done
      } catch (error) {
        failLaunch(interpreter, error)
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
      if (assetsDirectory !== undefined) {
        await rm(assetsDirectory, { recursive: true, force: true })
      }
    }
  }

  return { limits, run }
}
