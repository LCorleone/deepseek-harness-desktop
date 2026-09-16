/**
 * The process-global seam the desktop main process uses to hand the executor
 * its host-injected child environment (#043 D1).
 *
 * ## Why a `Symbol.for` slot, and not a constructor argument
 *
 * The desktop never imports this package: the Cordis loader loads the plugin
 * face (`lib/index.js`) as its own module instance inside the Electron main
 * process, so no import graph the plugin could declare reaches the launcher's
 * composition root. The repo's standing answer for exactly this split is the
 * #034/#039 process-global slot: the launcher writes through a setter, the
 * loader-loaded copy reads through the same `Symbol.for` registry symbol, and
 * the two always meet on `globalThis` because `Symbol.for` returns the SAME
 * symbol to every module instance of the process (a module-local `let` gave
 * each copy its own binding — the #034 lesson, where every telemetry row was
 * silently dropped until the slot moved to `globalThis`).
 *
 * ## What rides on the slot
 *
 * A frozen, validated `Record<string, string>` — the API skills'
 * `ROUTER_URL`/`ROUTER_API_KEY`, decoded by the desktop from its build-time
 * blob. The values exist only in process memory, never on disk, never in this
 * process's `process.env` (so agent-side children — whose environment comes
 * from the harness's scrubbed parent base — cannot inherit them), never in a
 * log line, and never in the renderer. The executor merges the fragment into
 * the skill child's spawn environment through the subprocess seam's explicit
 * `env` layer; see `execute.ts` (`childEnv`).
 *
 * @module dsh-company-skills/host-env
 */

/**
 * The registry symbol both sides declare. The desktop main process pins the
 * SAME string in `dsh-plugin-desktop/src/company-skills-env.ts`
 * (`COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT`); a test there pins this key
 * against drift so the two declarations cannot silently diverge.
 */
export const COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT: unique symbol = Symbol.for(
  'dsh.companySkillsExecutionEnvironment',
)

/** globalThis narrowed to the slot; the slot is only touched through the helpers below. */
const executionEnvironmentGlobals = globalThis as unknown as {
  [COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT]: Readonly<Record<string, string>> | undefined
}

/** Uppercase environment-name shape every fragment entry must carry (mirrors `execute.ts`). */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u

/**
 * Read the process-wide host-injected execution environment, whichever module
 * instance wrote it. The record is validated shape-only (names and non-empty
 * string values) before it is returned, so a malformed hand-off degrades to
 * "no injection" instead of reaching a child half-formed; values are never
 * surfaced in the rejection reason.
 * @returns the validated fragment, or undefined when the host injected none.
 */
export function companySkillsExecutionEnvironment(): Readonly<Record<string, string>> | undefined {
  const fragment = executionEnvironmentGlobals[COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT]
  if (fragment === undefined) return undefined
  if (typeof fragment !== 'object' || Array.isArray(fragment)) return undefined
  const validated: Record<string, string> = {}
  for (const [name, value] of Object.entries(fragment)) {
    if (!ENV_NAME_PATTERN.test(name)) return undefined
    if (typeof value !== 'string' || value.length === 0) return undefined
    validated[name] = value
  }
  return Object.freeze(validated)
}
