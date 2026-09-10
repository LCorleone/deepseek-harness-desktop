/** The `dsh-pip` pre-gate: fail fast when the ACL sandbox will deny an install. */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Field evidence (b85): a sandboxed `pip install` does not fail — pip retries
 * the denied write and hangs until the tool's 120 s timeout. The run never
 * settles with `sandbox.denied = true`, so the desktop's escalation dialog
 * (`windows-pwsh-sandbox.ts`, P16) never gets the chance to appear and the
 * install sticks forever.
 *
 * The `dsh-pip` command turns that hang into an immediate, signature-bearing
 * denial: inside the sandbox it prints an `Access is denied` line and exits
 * non-zero WITHOUT spawning pip, and outside the sandbox it is a transparent
 * pass-through to the real pip (argv, exit code, and stdio inherited).
 *
 * Sandbox self-check. The Windows ACL runner rewrites `TMP` and `TEMP` in the
 * confined child's own environment
 * (`packages/sandbox/sandbox-windows-acl/src/runner.ts:173-177`) to a private
 * directory created with `mkdtempSync(join(tmpdir(), 'dsh-'))`
 * (`packages/sandbox/sandbox-local/src/index.ts:415`), so a process whose
 * `TEMP`/`TMP` names a `<...>/dsh-<6 random chars>` component runs under the
 * `workspace-write` confinement. Read-only confinement leaves the ambient
 * temp alone, but read-only cannot write the workspace either, so no install
 * is ever attempted under it.
 * @module dsh-plugin-desktop/desktop-pip-gate
 */

/** Public command name the shim generators publish beside the Python aliases. */
export const DSH_PIP_COMMAND_NAME = 'dsh-pip.cmd'

/** Environment hand-off naming the real pip executable the shim guards. */
export const DSH_PIP_EXECUTABLE_ENV = 'DSH_PIP_REAL_PIP'

/** Environment hand-off naming the interpreter behind the `python -m pip` fallback. */
export const DSH_PIP_PYTHON_ENV = 'DSH_PIP_REAL_PYTHON'

/** Exit status of a pre-gated denial: non-zero, and distinct from the runner's 127 failure. */
export const DSH_PIP_DENIED_EXIT = 1

/** The runner's private-temp directory prefix (`mkdtempSync(join(tmpdir(), 'dsh-'))`). */
export const DSH_SANDBOX_TEMP_PREFIX = 'dsh-'

/** One full path component created by the runner's `mkdtemp` private temp. */
const SANDBOX_TEMP_COMPONENT = new RegExp(`^${DSH_SANDBOX_TEMP_PREFIX}[0-9A-Za-z]{6}$`, 'u')

/**
 * The denial line the sandboxed gate prints. The first clause carries the
 * upstream windows-acl denial dialect (`'access is denied'`) verbatim, so
 * `classifyDenial` marks the settled run `denied: true` and the desktop's
 * escalation flow takes over; the rest tells the agent what to do next.
 */
export const DSH_PIP_DENIED_STDERR = 'dsh-pip: Access is denied — the DSH sandbox does not allow this install to write, so the real pip was not started. The desktop can authorize one unsandboxed rerun: retry the exact same dsh-pip command in the foreground and answer the authorization dialog.'

/** Process launcher seam; production passes `node:child_process.spawn`. */
export type DshPipSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Inputs of one `dsh-pip` invocation. */
export interface DshPipGateOptions {
  /** Arguments after the `dsh-pip` command name, passed through to pip verbatim. */
  argv: readonly string[]
  /** Environment to inspect and hand to pip; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Stderr sink; defaults to `process.stderr`. */
  stderr?: (text: string) => void
  /** Process launcher; defaults to `node:child_process.spawn`. */
  spawn?: DshPipSpawn
}

/** Read one environment entry without trusting Windows key casing. */
function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalized = name.toUpperCase()
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === normalized) return value
  }
  return undefined
}

/**
 * Whether one `TEMP`/`TMP` value names the runner's private temp directory.
 * @param value - the raw environment value, or `undefined` when unset.
 * @returns whether a path component is exactly `dsh-` plus `mkdtemp`'s six-character suffix.
 */
export function isSandboxPrivateTempDirectory(value: string | undefined): boolean {
  if (value === undefined || value.length === 0) return false
  return value.split(/[\\/]+/u).some(component => SANDBOX_TEMP_COMPONENT.test(component))
}

/**
 * Whether this process runs inside the confinement.
 * @param environment - the process environment to classify.
 * @returns whether `TEMP`/`TMP` carries the runner's private-temp marker.
 */
export function isSandboxConfinedEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return isSandboxPrivateTempDirectory(environmentValue(environment, 'TEMP'))
    || isSandboxPrivateTempDirectory(environmentValue(environment, 'TMP'))
}

/** Resolve the pip command the gate passes through to, or `undefined` when none is published. */
function resolveRealPip(environment: NodeJS.ProcessEnv): { command: string, args: string[] } | undefined {
  const pip = environmentValue(environment, DSH_PIP_EXECUTABLE_ENV)
  if (pip !== undefined && pip.length > 0) return { command: pip, args: [] }
  const python = environmentValue(environment, DSH_PIP_PYTHON_ENV)
  if (python !== undefined && python.length > 0) return { command: python, args: ['-m', 'pip'] }
  return undefined
}

/**
 * Run the gate: deny immediately inside the sandbox, otherwise hand the exact
 * argv to the real pip and mirror its exit code.
 * @param options - argv, environment, stderr sink, and process launcher seam.
 * @returns the process exit status the shim mirrors.
 */
export async function runDshPipGate(options: DshPipGateOptions): Promise<number> {
  const environment = options.environment ?? process.env
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text) })
  if (isSandboxConfinedEnvironment(environment)) {
    stderr(`${DSH_PIP_DENIED_STDERR}\n`)
    return DSH_PIP_DENIED_EXIT
  }
  const target = resolveRealPip(environment)
  if (target === undefined) {
    stderr('dsh-pip: no pip executable is published for the desktop shared Python environment.\n')
    return DSH_PIP_DENIED_EXIT
  }
  const spawn = options.spawn ?? nodeSpawn
  return await new Promise<number>(resolve => {
    const child = spawn(target.command, [...target.args, ...options.argv], {
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', (cause: Error) => {
      stderr(`dsh-pip: failed to start ${JSON.stringify(target.command)}: ${cause.message}\n`)
      resolve(DSH_PIP_DENIED_EXIT)
    })
    child.once('exit', (code: number | null) => { resolve(code ?? DSH_PIP_DENIED_EXIT) })
  })
}

/** Whether this module is the process entry the generated `dsh-pip` shim launched. */
function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  void runDshPipGate({ argv: process.argv.slice(2) }).then(exitCode => { process.exitCode = exitCode })
}
