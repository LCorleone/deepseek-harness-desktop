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
import { type SkillResourceBase } from '@deepseek-ai/dsh-skill';
import { type SkillBundle } from './bundle.js';
/** Registry name this provider registers under. */
export declare const PROVIDER_NAME = "company-skills";
/**
 * Discovery source bucket. Company skills are product-shipped content, so they
 * report `bundled` and rank with the other packaged roots.
 */
export declare const SKILL_SOURCE = "bundled";
/**
 * Precedence of every company skill. `BUNDLED_SKILL_RANK` is the packaged-root
 * rank, which is the lowest: a project (`project-dsh`/`project-agents`) or a
 * user (`user-dsh`/`user-agents`) skill of the same name keeps winning. That is
 * the intended product behaviour — the company catalog is always available but
 * never silently overrides a skill the repository or the user deliberately
 * wrote down.
 */
export declare const SKILL_RANK = 600;
/** Both surfaces may invoke a company skill: the model by routing, the user by command. */
export declare const SKILL_INVOCATION: Readonly<{
    modelInvocable: true;
    userInvocable: true;
}>;
/**
 * Relative resources are carried inside the plugin, not on the local disk, so
 * the skill loader renders an opaque hint instead of a directory or URL. That
 * is the zero-change consumption path: consumers only render the hint
 * (`packages/skill/skill/src/index.ts`), and the batch-3 execution tool is what
 * resolves `scripts/…` and `assets/…` names.
 */
export declare const RESOURCE_BASE: SkillResourceBase;
/** One indexed skill: everything `list()` needs and nothing that reads a body. */
export interface CatalogEntry {
    readonly name: string;
    readonly description: string;
    readonly rank: number;
    /** Opaque provider handle, stable across loads; it is the skill name. */
    readonly locator: string;
}
/** Result of asking the catalog for one full skill. */
export type SkillLoad = {
    readonly ok: true;
    readonly bundle: SkillBundle;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** Index plus on-demand body access for one loaded container. */
export interface CompanySkillCatalog {
    /** Index of every carried skill, in container order. */
    readonly entries: readonly CatalogEntry[];
    /** Why the catalog is empty or reduced; `undefined` for a clean load. */
    readonly reason: string | undefined;
    /**
     * Validate and materialize exactly one skill. This is the only function that
     * reads a body; it never throws.
     * @param name - the skill name (the locator `list()` handed out).
     * @returns the validated bundle, or why it cannot be loaded.
     */
    skill(name: string): SkillLoad;
}
/** The empty catalog a failed or empty load degrades to. */
export declare function emptyCatalog(reason: string): CompanySkillCatalog;
/**
 * Decode one asset's text into a catalog. Never throws.
 * @param text - the raw blob or generated-module text.
 * @returns the catalog, or an empty one carrying the failure reason.
 */
export declare function loadCatalogFromText(text: string): CompanySkillCatalog;
/**
 * Read and decode the shipped container asset at module initialization. A
 * missing or unreadable file is a degraded catalog, not an exception.
 * @param url - the asset URL inside the owning package.
 * @returns the catalog, or an empty one carrying the failure reason.
 */
export declare function loadCatalogFromFile(url: URL): CompanySkillCatalog;
