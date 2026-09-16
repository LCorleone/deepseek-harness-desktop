/**
 * `dsh-company-skills` — the container plugin that ships a set of curated
 * company skills as one obfuscated bundle and publishes them through the skill
 * registry seam.
 *
 * Registration uses the reactive child-fiber form on purpose:
 *
 *   ctx.inject(['skills'], inner => inner.effect(() => inner.skills.registerProvider(...)))
 *
 * A bare `ctx.skills` read inside a plugin fiber throws (`cannot get property
 * "skills" without inject` under Cordis reflective contexts — the failure mode
 * a real third-party plugin hit and documented in
 * `tools/company-catalog/plugin-sources/dsh-dai-engramory-0.2.4/README.md`),
 * and registering straight from `apply()` would bind the registration to this
 * plugin's own fiber instead of a disposable child. The child fiber's
 * `effect()` ties the registration to that fiber, so unmounting the plugin
 * unregisters the provider and invalidates the catalog caches; the regex pin in
 * `tests/provider.spec.ts` keeps a later refactor from reintroducing a direct
 * service read.
 *
 * The container is read and decoded once, at module initialization; nothing on
 * this path throws, and a missing or corrupt asset degrades to an empty
 * catalog (see `catalog.ts` for the reasoning).
 *
 * Batch 3 adds the execution channel: the same reactive-injection form mounts
 * the `company_skill_run` and `company_skill_read` tools as soon as the host
 * provides `tools` and `subprocess`, so a profile without those services still
 * gets the provider (and a profile that mounts them later gets the tools then).
 * The run tool's spawn is the host's `ctx.subprocess.spawn`, and the addressed
 * script runs from a per-run staged copy of the skill that is removed when the
 * run settles — see `execute.ts`. The read tool resolves the opaque bundle's
 * prose resources (which no workspace `read` can see) by materializing exactly
 * one entry for the duration of the call. The listing tool
 * (`company_skill_list`, added for 0.1.1) closes the discoverability gap
 * those two leave: names only, never content, so a model without a filesystem
 * — which had nothing to enumerate and could only guess entry paths, wrongly —
 * can discover the exact paths before addressing read or run.
 *
 * @module dsh-company-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { createProvider } from './provider.js'
import { loadCatalogFromFile } from './catalog.js'
import { createScriptExecutor } from './execute.js'
import { companySkillsExecutionEnvironment } from './host-env.js'
import { createCompanySkillListTool, createCompanySkillReadTool, createCompanySkillRunTool } from './tool.js'

/** Cordis plugin name. */
export const name = 'company-skills'

/** The skill registry this plugin contributes to. */
export const inject = ['skills']

/** The shipped container asset: one obfuscated block carrying every bundled skill. */
export const SKILLS_BUNDLE_URL = new URL('../assets/skills.bundle', import.meta.url)

/** The catalog decoded from the shipped asset at module initialization. */
export const catalog = loadCatalogFromFile(SKILLS_BUNDLE_URL)

/**
 * Per-skill run-deadline overrides, milliseconds (#043 D6). The OCR/VLM
 * skills drive external APIs whose per-file processing runs to ~20 minutes
 * (the skills' own SKILL.md instruct the caller to budget 20–60 minutes), so
 * the executor's 120 s default would kill every real run. The map lives in
 * this composition — not in the packer or the skill frontmatter — so a
 * deadline stays an execution policy, not bundle metadata. Keys are kebab-
 * case skill names and must match the catalog; an unknown name is inert (it
 * simply never matches a run).
 */
export const SKILL_DEADLINE_OVERRIDES_MS: Readonly<Record<string, number>> = Object.freeze({
  ocr: 1_200_000,
  'vlm-image': 1_200_000,
  // Review P2 (2026-09-16): this skill's SKILL.md budgets up to 10 minutes
  // per page on multi-page parses (documented 1-hour ceiling) — the override
  // must honor that budget or a real run dies mid-parse. The host backstop
  // auto-sizes via maximumDeadlineMs.
  'smart-pdf-parser': 3_600_000,
})

/** Register the company-skill provider and the script-execution tool on their seams. */
export function apply(ctx: Context): void {
  const provider = createProvider(catalog, (message) => { ctx.logger.warn(message) })
  ctx.inject(['skills'], (inner) => {
    inner.effect(() => inner.skills.registerProvider(() => provider))
  })
  ctx.inject(['tools', 'subprocess'], (inner) => {
    // #043 D1: the desktop main process (a separate module instance of this
    // process) publishes the API skills' ROUTER_URL/ROUTER_API_KEY through
    // the process-global slot; read it at executor construction so a later
    // hand-off needs a plugin reload rather than a silent per-run re-read.
    const childEnv = companySkillsExecutionEnvironment()
    const executor = createScriptExecutor({
      catalog,
      // The host's subprocess seam is the only spawn path: the executor never
      // imports a desktop module, so the plugin stays independently installable.
      spawn: (spec) => inner.subprocess.spawn(spec),
      // #043 D6: the long-queue OCR/VLM skills run under their own deadline.
      deadlineBySkill: SKILL_DEADLINE_OVERRIDES_MS,
      // #043 D1: undefined when the host injected nothing (an unpackaged or
      // unmanaged launch), which keeps the executor fully functional for the
      // offline skills.
      ...(childEnv === undefined ? {} : { childEnv }),
      // A cleanup failure (e.g. a Windows EPERM while an exited child still
      // holds a handle) is a warning, never the run's outcome.
      logWarning: (message) => { ctx.logger.warn(message) },
    })
    inner.effect(() => inner.tools.register(createCompanySkillRunTool(executor)))
    inner.effect(() => inner.tools.register(createCompanySkillReadTool(executor)))
    inner.effect(() => inner.tools.register(createCompanySkillListTool(executor)))
  })
}
