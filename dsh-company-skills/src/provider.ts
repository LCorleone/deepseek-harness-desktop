/**
 * The `company-skills` skill provider.
 *
 * `list()` is index-only: it hands out one candidate per carried skill with the
 * name, description, rank, and an opaque locator (the skill name), and never
 * touches a body. `get()` validates and materializes exactly the skill the
 * locator names, and returns `undefined` for anything it cannot load — the
 * registry's documented "no longer loadable" answer.
 *
 * A degraded catalog still produces a registered provider; it simply lists
 * nothing. That keeps `list()`/`get()` shapes uniform and keeps the host alive.
 */

import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import {
  PROVIDER_NAME,
  RESOURCE_BASE,
  SKILL_INVOCATION,
  SKILL_SOURCE,
  type CatalogEntry,
  type CompanySkillCatalog,
} from './catalog.js'

/** Receives degradation messages; `ctx.logger.warn` in the plugin. */
export type CatalogWarn = (message: string) => void

function candidateOf(entry: CatalogEntry): SkillCandidate {
  return {
    name: entry.name,
    description: entry.description,
    invocation: SKILL_INVOCATION,
    provider: PROVIDER_NAME,
    source: SKILL_SOURCE,
    resourceBase: RESOURCE_BASE,
    rank: entry.rank,
    locator: entry.locator,
  }
}

/**
 * Build the provider for one loaded catalog.
 * @param catalog - the loaded (possibly empty) catalog.
 * @param warn - optional sink for load and per-skill degradation messages.
 * @returns the provider the plugin registers.
 */
export function createProvider(catalog: CompanySkillCatalog, warn?: CatalogWarn): SkillProvider {
  let reportedCatalog = false
  const report = (message: string): void => {
    warn?.(`${PROVIDER_NAME}: ${message}`)
  }
  return {
    name: PROVIDER_NAME,
    list(_options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      if (!reportedCatalog && catalog.reason !== undefined) {
        reportedCatalog = true
        report(catalog.reason)
      }
      return Promise.resolve(catalog.entries.map((entry) => candidateOf(entry)))
    },
    get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      const locator = candidate.locator
      if (typeof locator !== 'string') {
        report(`ignored a candidate for "${candidate.name}" whose locator is not a skill name`)
        return Promise.resolve(undefined)
      }
      const loaded = catalog.skill(locator)
      if (!loaded.ok) {
        report(loaded.reason)
        return Promise.resolve(undefined)
      }
      const { bundle } = loaded
      return Promise.resolve({
        name: bundle.name,
        description: bundle.description,
        invocation: SKILL_INVOCATION,
        provider: PROVIDER_NAME,
        source: SKILL_SOURCE,
        resourceBase: RESOURCE_BASE,
        content: bundle.body,
      })
    },
  }
}
