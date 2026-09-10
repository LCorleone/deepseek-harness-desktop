/**
 * The company-skill catalog: one shipped container asset → N indexed skills.
 *
 * Load policy (the "does not blow up the host" choice): a missing, unreadable,
 * corrupt, empty, or future-versioned asset yields an *empty catalog with a
 * reason*, never a throw. Two things follow, and both are deliberate:
 *
 *  - the module can be imported and the provider registered on any profile,
 *    even one whose asset was lost or tampered with, so a bad skill bundle can
 *    never take the whole boot down (a throw during plugin import fails the
 *    profile composition, which is far worse than an empty catalog);
 *  - `list()` returns an empty catalog and `get()` returns `undefined`, which
 *    is exactly what the registry already handles for a provider with nothing
 *    to offer, so every consumer keeps its existing behaviour.
 *
 * The reason travels with the catalog instead of being logged at import time,
 * where no context logger exists yet; the provider logs it once at its first
 * `list()` and once per unloadable skill.
 */

import { readFileSync } from 'node:fs'
import { BUNDLED_SKILL_RANK, type SkillResourceBase } from '@deepseek-ai/dsh-skill'
import { validateSkillBundle, type SkillBundle } from './bundle.js'
import { decodeContainer, type SkillElementIndex } from './container.js'

/** Registry name this provider registers under. */
export const PROVIDER_NAME = 'company-skills'

/**
 * Discovery source bucket. Company skills are product-shipped content, so they
 * report `bundled` and rank with the other packaged roots.
 */
export const SKILL_SOURCE = 'bundled'

/**
 * Precedence of every company skill. `BUNDLED_SKILL_RANK` is the packaged-root
 * rank, which is the lowest: a project (`project-dsh`/`project-agents`) or a
 * user (`user-dsh`/`user-agents`) skill of the same name keeps winning. That is
 * the intended product behaviour — the company catalog is always available but
 * never silently overrides a skill the repository or the user deliberately
 * wrote down.
 */
export const SKILL_RANK = BUNDLED_SKILL_RANK

/** Both surfaces may invoke a company skill: the model by routing, the user by command. */
export const SKILL_INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })

/**
 * Relative resources are carried inside the plugin, not on the local disk, so
 * the skill loader renders an opaque hint instead of a directory or URL. That
 * is the zero-change consumption path: consumers only render the hint
 * (`packages/skill/skill/src/index.ts`), and the batch-3 execution tool is what
 * resolves `scripts/…` and `assets/…` names.
 */
export const RESOURCE_BASE: SkillResourceBase = Object.freeze({
  kind: 'opaque',
  description: 'These company skills travel inside the dsh-company-skills plugin bundle; their referenced scripts and assets are not files on this machine, so they cannot be read as local paths.',
})

/** One indexed skill: everything `list()` needs and nothing that reads a body. */
export interface CatalogEntry {
  readonly name: string
  readonly description: string
  readonly rank: number
  /** Opaque provider handle, stable across loads; it is the skill name. */
  readonly locator: string
}

/** Result of asking the catalog for one full skill. */
export type SkillLoad =
  | { readonly ok: true; readonly bundle: SkillBundle }
  | { readonly ok: false; readonly reason: string }

/** Index plus on-demand body access for one loaded container. */
export interface CompanySkillCatalog {
  /** Index of every carried skill, in container order. */
  readonly entries: readonly CatalogEntry[]
  /** Why the catalog is empty or reduced; `undefined` for a clean load. */
  readonly reason: string | undefined
  /**
   * Validate and materialize exactly one skill. This is the only function that
   * reads a body; it never throws.
   * @param name - the skill name (the locator `list()` handed out).
   * @returns the validated bundle, or why it cannot be loaded.
   */
  skill(name: string): SkillLoad
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildCatalog(elements: readonly SkillElementIndex[], reason: string | undefined): CompanySkillCatalog {
  const byName = new Map(elements.map((entry) => [entry.name, entry]))
  return {
    entries: elements.map((entry) => ({
      name: entry.name,
      description: entry.description,
      rank: SKILL_RANK,
      locator: entry.name,
    })),
    reason,
    skill(name: string): SkillLoad {
      const entry = byName.get(name)
      if (entry === undefined) return { ok: false, reason: `unknown company skill "${name}"` }
      try {
        return { ok: true, bundle: validateSkillBundle(entry.element) }
      } catch (error) {
        return { ok: false, reason: `company skill "${name}" is not loadable: ${errorMessage(error)}` }
      }
    },
  }
}

/** The empty catalog a failed or empty load degrades to. */
export function emptyCatalog(reason: string): CompanySkillCatalog {
  return buildCatalog([], reason)
}

/**
 * Decode one asset's text into a catalog. Never throws.
 * @param text - the raw blob or generated-module text.
 * @returns the catalog, or an empty one carrying the failure reason.
 */
export function loadCatalogFromText(text: string): CompanySkillCatalog {
  try {
    const elements = decodeContainer(text)
    if (elements.length === 0) return emptyCatalog('the company skills container carries no skills')
    return buildCatalog(elements, undefined)
  } catch (error) {
    return emptyCatalog(`the company skills container did not load: ${errorMessage(error)}`)
  }
}

/**
 * Read and decode the shipped container asset at module initialization. A
 * missing or unreadable file is a degraded catalog, not an exception.
 * @param url - the asset URL inside the owning package.
 * @returns the catalog, or an empty one carrying the failure reason.
 */
export function loadCatalogFromFile(url: URL): CompanySkillCatalog {
  let text: string
  try {
    text = readFileSync(url, 'utf8')
  } catch (error) {
    return emptyCatalog(`the company skills container is unreadable: ${errorMessage(error)}`)
  }
  return loadCatalogFromText(text)
}
