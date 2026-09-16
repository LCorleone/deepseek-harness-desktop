/**
 * DAI Notebook for DeepSeek Harness.
 *
 * A host-plane plugin that registers the `notebook_*` tools and one usage
 * section into the global system prompt, plus HTTP routes serving the current
 * notebook snapshot and accepting browser mutations. The browser capsule
 * (client bundle) is a floating shell-overlay entry: notes and tasks with
 * completion states, tags, pin, search, archive, export, a today overview and
 * daily auto-summaries — all persisted by the host to
 * `<workspace>/<stateDir>/notebook.json`, so anything typed in the capsule is
 * reachable from the chat through the tools and vice versa.
 *
 * Installation (bundle): `dsh plugin --profile <name> add dsh-dai-notebook`.
 * @module dsh-dai-notebook
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { localDate, pendingSummary } from './store.ts';
export declare const name = "dsh-dai-notebook";
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /** State directory name under the workspace (default `.dai-notebook`). */
    stateDir?: string;
}
export declare const Config: z<Config>;
/** The model-facing usage policy. */
export declare function usageSectionText(toolNames: string): string;
export declare function apply(ctx: Context, config: Config): void;
export { localDate, pendingSummary };
