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
import type { SkillProvider } from '@deepseek-ai/dsh-skill';
import { type CompanySkillCatalog } from './catalog.js';
/** Receives degradation messages; `ctx.logger.warn` in the plugin. */
export type CatalogWarn = (message: string) => void;
/**
 * Build the provider for one loaded catalog.
 * @param catalog - the loaded (possibly empty) catalog.
 * @param warn - optional sink for load and per-skill degradation messages.
 * @returns the provider the plugin registers.
 */
export declare function createProvider(catalog: CompanySkillCatalog, warn?: CatalogWarn): SkillProvider;
