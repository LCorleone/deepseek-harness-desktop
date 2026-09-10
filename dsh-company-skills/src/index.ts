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
 * @module dsh-company-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import { createProvider } from './provider.js'
import { loadCatalogFromFile } from './catalog.js'

/** Cordis plugin name. */
export const name = 'company-skills'

/** The skill registry this plugin contributes to. */
export const inject = ['skills']

/** The shipped container asset: one obfuscated block carrying every bundled skill. */
export const SKILLS_BUNDLE_URL = new URL('../assets/skills.bundle', import.meta.url)

/** The catalog decoded from the shipped asset at module initialization. */
export const catalog = loadCatalogFromFile(SKILLS_BUNDLE_URL)

/** Register the company-skill provider on `ctx.skills` through a disposable child fiber. */
export function apply(ctx: Context): void {
  const provider = createProvider(catalog, (message) => { ctx.logger.warn(message) })
  ctx.inject(['skills'], (inner) => {
    inner.effect(() => inner.skills.registerProvider(() => provider))
  })
}
