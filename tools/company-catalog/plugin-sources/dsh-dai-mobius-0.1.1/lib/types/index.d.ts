/**
 * Mobius for DeepSeek Harness.
 *
 * A host-plane plugin that registers the `mobius_*` tools and one usage
 * section into the global system prompt, plus a lightweight workflow snapshot
 * route for the web activity panel.
 *
 * Mobius is a sequential research/analysis orchestrator: given a research goal
 * ("我要研究 xxx"), the captain plans an ordered list of steps; each step runs
 * as ONE dedicated continuable subagent; when a step finishes, its result is
 * collected and handed — together with the next step's brief — to the next
 * dedicated subagent, until every step is done and the conclusion is
 * consolidated.
 *
 * This package is intentionally the Mobius-only sibling: it reuses the
 * agent-teams subagent plumbing (continuable children, delivery, retirement)
 * as internal modules but does NOT register any `agent_teams_*` tool, so it
 * can coexist with a separately-installed agent-teams package without tool
 * collisions.
 *
 * Installation (bundle): `dsh plugin --profile <name> add dsh-dai-mobius`
 * (or a local path). The bundle patch mounts this plugin row into the host
 * composition; the tools register into the shared `tools` registry and the
 * usage section into the global system prompt, so the plugin needs no realm.
 *
 * @module dsh-dai-mobius
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-dai-mobius";
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /**
     * State directory name under the captain's workspace; mobius state lives at
     * `<workspace>/<stateDir>/mobius/mobius.json` (default `.agent-teams`).
     */
    stateDir?: string;
    /** `ctx.subagents` provider used to spawn step agents; must support continuable children and personas (default `spawn`). */
    memberProvider?: string;
    /** Optional model override applied to every step agent. */
    memberModel?: string;
    /** Prompt injected into step-agent personas. */
    executionPrompt?: string;
    /** Plugin-wide fallback route for unavailable step models. */
    fallback?: import('./profiles.ts').TeamModelFallbackConfig;
    /** Step-agent delegation depth cap (default `1`; `0` forbids delegation entirely). */
    memberMaxDepth?: number;
    /** Maximum number of concurrently spawned step agents (default `8`). */
    maxMembers?: number;
    /** Auto-retry a failed step this many times before giving up (default `1`). */
    maxStepRetries?: number;
    /** Max review rounds for the final-conclusion "agent loop" before giving up (default `2`). */
    maxReviewRounds?: number;
    /** Default workflow-wide step timeout in ms; a step that fails to report within this budget is failed and the pipeline stops. Overridable per workflow. */
    timeoutMs?: number;
    /** Cap on how many web_search / web_fetch tool calls a single step agent should make (soft prompt limit). Default 3. 0 disables the web-search discipline entirely. */
    stepSearchLimit?: number;
    /** Hard cap on the total number of execution stages a workflow may have. Stages beyond this are rejected at plan time. Default 0 = unlimited. */
    maxStageCount?: number;
    /** Register the `/mobius` slash command in the command list (default true). */
    slashCommand?: boolean;
    /** Prompt-section order for the usage policy (default `117`). */
    promptSectionOrder?: number;
}
export declare const Config: z<Config>;
/** The model-facing usage policy for the Mobius sequential workflow. */
export declare function mobiusUsageSectionText(): string;
export declare function apply(ctx: Context, config: Config): void;
