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
 * ## Listing entries
 *
 * `read()` addresses one carried entry by *exact* path, which presumes the
 * caller already knows the name — a presumption the opaque bundle breaks: a
 * model without a filesystem to list cannot discover that the finance
 * presets are `black-gold-ledger`/`prospect-annual`/…, only guess them
 * (the real-device failure this closes). `list()` returns names only: every
 * `scripts[]` and `assets[]` path as one sorted list, optionally narrowed to
 * a bundle-root-relative directory prefix. No entry is decoded, staged, or
 * materialized, so the listing adds no plaintext-exposure surface; a prefix
 * that matches nothing is a normal empty listing, not an error, because
 * discovery is probing. Listings past `maxListEntries` (default 1000) keep
 * the head and report the remainder as a truncation fact.
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
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { CompanySkillCatalog } from './catalog.js';
/** The subprocess seam the executor writes through; `ctx.subprocess.spawn` in the plugin. */
export type ScriptSpawn = (spec: SubprocessSpawnSpec) => SubprocessHandle;
/** Cooperative deadline for one script run, milliseconds. */
export declare const DEFAULT_TIMEOUT_MS = 120000;
/** Terminate-escalation grace handed to the subprocess seam, milliseconds. */
export declare const DEFAULT_GRACE_MS = 5000;
/** Retained bytes per output stream; overflow keeps the tail. */
export declare const DEFAULT_MAX_OUTPUT_BYTES: number;
/** Largest single resource `read()` will decode as text. */
export declare const DEFAULT_MAX_READ_BYTES: number;
/** Most entry paths one `list()` returns; the remainder is an explicit truncation fact. */
export declare const DEFAULT_MAX_LIST_ENTRIES = 1000;
/** Concurrent runs allowed per session; one keeps a stuck script from flooding the session. */
export declare const DEFAULT_MAX_CONCURRENT_PER_SESSION = 1;
/** Environment variable carrying the staged skill root (scripts + assets) to the child. */
export declare const ASSETS_ENV_VAR = "DSH_SKILL_ASSETS";
/** Prefix of the per-run staged-skill directory under the temp root. */
export declare const ASSETS_TMP_PREFIX = "dsh-skill-assets-";
/** Node's largest representable timer delay: a longer bound would overflow its timer. */
export declare const MAX_TIMER_DELAY_MS: number;
/** Desktop-published absolute Node command; preferred over the `PATH` lookup. */
export declare const DESKTOP_NODE_EXECUTABLE_ENV = "DSH_DESKTOP_NODE_EXECUTABLE";
/** Desktop-published absolute Python command; preferred over the `PATH` lookup. */
export declare const DESKTOP_PYTHON_EXECUTABLE_ENV = "DSH_DESKTOP_PYTHON_EXECUTABLE";
/** Electron's "run as a plain Node CLI" switch, paired with `process.execPath`. */
export declare const ELECTRON_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";
/** The interpreter families the executor can launch. */
export type ScriptInterpreterFamily = 'node' | 'python';
/** One resolved and enforced execution bound. */
export interface ScriptExecutorLimits {
    readonly timeoutMs: number;
    readonly graceMs: number;
    readonly maxOutputBytes: number;
    readonly maxConcurrentPerSession: number;
    /** Largest resource {@link ScriptExecutor.read} returns as text. */
    readonly maxReadBytes: number;
    /** Most entry paths {@link ScriptExecutor.list} returns; the rest is a truncation fact. */
    readonly maxListEntries: number;
}
/** One run request: the addressed script plus the caller-owned execution context. */
export interface RunScriptRequest {
    /** Skill name exactly as the catalog lists it. */
    readonly skill: string;
    /** Bundle-root-relative script path that must be one of the skill's own scripts. */
    readonly script: string;
    /** Extra argv appended after the materialized script path. */
    readonly args?: readonly string[];
    /** Session identity for the concurrency bound. */
    readonly sessionKey: string;
    /** Caller cancellation, forwarded to the subprocess seam. */
    readonly signal: AbortSignal;
}
/** One bounded output stream: text plus whether the head was dropped. */
export interface ScriptOutput {
    readonly text: string;
    readonly truncated: boolean;
}
/** A settled run that reached `close` normally. */
export interface RunScriptResult {
    readonly skill: string;
    readonly script: string;
    /** Process exit code; signal-terminated runs reject instead of reporting here. */
    readonly exitCode: number;
    readonly stdout: ScriptOutput;
    readonly stderr: ScriptOutput;
}
/** One resource-read request: a carried entry addressed by exact path. */
export interface ReadResourceRequest {
    /** Skill name exactly as the catalog lists it. */
    readonly skill: string;
    /** Bundle-root-relative path that must equal exactly one carried entry. */
    readonly path: string;
    /** Reject when the entry exceeds this many bytes; defaults to `limits.maxReadBytes`. */
    readonly maxBytes?: number;
}
/** One decoded text resource. */
export interface ReadResourceResult {
    readonly skill: string;
    readonly path: string;
    readonly text: string;
    /** Byte length of the decoded text (equal to the entry's byte length). */
    readonly bytes: number;
}
/** One listing request: discover carried entry names, never their content. */
export interface ListEntriesRequest {
    /** Skill name exactly as the catalog lists it. */
    readonly skill: string;
    /**
     * Bundle-root-relative directory prefix that narrows the listing (for
     * example `reference/design_system/finance`); the default root lists every
     * carried entry. A trailing slash is ignored.
     */
    readonly path?: string;
}
/** One entry listing: sorted names plus how complete they are. */
export interface ListEntriesResult {
    readonly skill: string;
    /** The prefix the listing was narrowed by; `''` is the bundle root. */
    readonly path: string;
    /** Sorted bundle-relative entry paths, at most `limits.maxListEntries` of them. */
    readonly entries: readonly string[];
    /** Every entry matching the prefix, including the ones past the cap. */
    readonly total: number;
    /** Whether `entries` was capped below `total`. */
    readonly truncated: boolean;
}
/** The execution surface the tool layer consumes. */
export interface ScriptExecutor {
    readonly limits: ScriptExecutorLimits;
    /**
     * Validate, stage, and run one script. The child runs with its working
     * directory at the staged skill root.
     * @param request - addressed script, session identity, and cancellation.
     * @returns the exit code and bounded output.
     * @throws {SkillRunError} for any rejected address, bound, or launch failure.
     */
    run(request: RunScriptRequest): Promise<RunScriptResult>;
    /**
     * Decode exactly one carried entry as UTF-8 text, materializing it only for
     * the duration of the call.
     * @param request - addressed entry and optional read bound.
     * @returns the entry's text and byte length.
     * @throws {SkillRunError} for an unknown skill/entry, a binary entry, or an
     * entry over the read bound — never for a body byte.
     */
    read(request: ReadResourceRequest): Promise<ReadResourceResult>;
    /**
     * List the carried entry paths of one skill — `scripts[]` and `assets[]`
     * together, sorted — optionally narrowed to a bundle-root-relative prefix.
     * Names only: no entry is decoded, staged, or materialized.
     * @param request - the skill and an optional narrowing prefix.
     * @returns the sorted paths, the match total, and the truncation fact.
     * @throws {SkillRunError} for an unknown skill — never for an empty match.
     */
    list(request: ListEntriesRequest): Promise<ListEntriesResult>;
}
/** Construction options; every bound and the spawn seam are explicit for testability. */
export interface ScriptExecutorOptions {
    /** The catalog the scripts are read from. */
    readonly catalog: CompanySkillCatalog;
    /** The subprocess seam, normally `(spec) => ctx.subprocess.spawn(spec)`. */
    readonly spawn: ScriptSpawn;
    readonly timeoutMs?: number;
    readonly graceMs?: number;
    readonly maxOutputBytes?: number;
    readonly maxConcurrentPerSession?: number;
    /** Largest resource a read returns as text; defaults to 256 KiB. */
    readonly maxReadBytes?: number;
    /** Most entry paths one listing returns; defaults to 1000. */
    readonly maxListEntries?: number;
    /** Temp root for the staged-skill directory; defaults to `os.tmpdir()`. */
    readonly tempRoot?: string;
    /**
     * Interpreter-resolution seam; defaults to this process's environment,
     * platform, `execPath`, and a real `PATH` probe. Tests override it to make
     * the injected/PATH/host-executable order deterministic.
     */
    readonly interpreterResolution?: InterpreterResolutionInputs;
    /** Injected staged-directory remover; defaults to `fs.rm(..., { recursive, force })`. */
    readonly removeStagedAssets?: (directory: string) => Promise<void>;
    /** Cleanup-failure sink; defaults to a no-op so a warning never changes a result. */
    readonly logWarning?: (message: string) => void;
}
/** Inputs controlling one interpreter resolution. */
export interface InterpreterResolutionInputs {
    /** Environment read for the desktop-published command; defaults to `process.env`. */
    readonly environment?: NodeJS.ProcessEnv;
    /** Platform selecting the `PATH` dialect and executable extensions. */
    readonly platform?: NodeJS.Platform;
    /** Host executable used as the Node fallback; defaults to `process.execPath`. */
    readonly execPath?: string;
    /** Executable probe over the resolved environment; defaults to a real `PATH` search. */
    readonly commandOnPath?: (command: string) => boolean;
    /** File-existence probe for the desktop-published command; defaults to `fs.existsSync`. */
    readonly exists?: (path: string) => boolean;
}
/** One resolved interpreter command plus the child environment it requires. */
export interface ResolvedInterpreter {
    /** `argv[0]` handed to the subprocess seam. */
    readonly command: string;
    /** Extra environment entries to merge into the spawn spec. */
    readonly env: Readonly<Record<string, string>>;
}
/**
 * Every rejection this module raises. The message names the skill and script
 * (both catalog metadata) and never carries body, asset, or output bytes.
 */
export declare class SkillRunError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Map one script path to its interpreter family, or `undefined` when unsupported. */
export declare function interpreterFor(scriptPath: string): ScriptInterpreterFamily | undefined;
/** The extensions this executor can launch, in a stable display order. */
export declare function supportedScriptExtensions(): readonly string[];
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
export declare function resolveInterpreter(family: ScriptInterpreterFamily, inputs?: InterpreterResolutionInputs): ResolvedInterpreter | undefined;
/**
 * Build the executor for one catalog.
 * @param options - catalog, spawn seam, and the resolved bounds.
 * @returns the executor the tool layer registers.
 */
export declare function createScriptExecutor(options: ScriptExecutorOptions): ScriptExecutor;
