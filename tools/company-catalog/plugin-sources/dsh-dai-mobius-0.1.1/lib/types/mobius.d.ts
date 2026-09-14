/**
 * Mobius: a sequential research/analysis workflow orchestrator for DeepSeek
 * Harness, layered on the agent-teams subagent plumbing.
 *
 * The user gives a research goal ("我要研究 xxx"). The captain plans an
 * ordered list of steps. Each step runs as ONE dedicated continuable
 * subagent. When a step finishes, its result is collected and handed — together
 * with the next step's brief — to the next dedicated subagent, until every
 * step is done and the final conclusion is consolidated.
 *
 * Mobius reuses the agent-teams member lifecycle (`spawnMember`,
 * `deliverToMember`, `installMemberSelectionRuntime`, retired-member guard,
 * atomic state writes and locking) so model routing, cold resume and the
 * "no true delete" retirement boundary behave identically. Workflow state
 * lives in its own `mobius.json` per captain so it never pollutes an
 * agent-teams `team.json`.
 *
 * Tools:
 *  - `mobius_create`  (captain): plan a step list (staged)
 *  - `mobius_start`   (captain): begin the pipeline (auto-stepping)
 *  - `mobius_done`    (step member): write the step result; auto-advances
 *  - `mobius_status`  (captain/member): progress + per-step outputs
 *  - `mobius_finalize`(captain): consolidate the conclusion and retire members
 * @module dsh-agent-teams/mobius
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { installMemberSelectionRuntime } from './members.ts';
/** Stop (and deregister) any timeout timer for one running step. */
export declare function clearWorkflowStepTimeout(captainId: string, workflowId: string, stepId: string): void;
/** Stop every timeout timer for a whole workflow (used on halt/finalize). */
export declare function clearWorkflowAllTimeouts(captainId: string, workflowId: string): void;
export type MobiusStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'halted';
export interface MobiusStep {
    /** Stable id inside the workflow (`s1`, `s2`, …). */
    id: string;
    /** Short title for the step. */
    title: string;
    /** What this step should accomplish / research now. */
    target: string;
    /** Optional extra guidance from planning. */
    context?: string;
    /**
     * Optional execution stage. Steps sharing the same non-empty stage run
     * concurrently (each as its own dedicated subagent); stages run serially.
     * Steps without a stage each get their own implicit stage, preserving the
     * original linear "result feeds the next"接力 model.
     */
    stage?: string;
    status: MobiusStepStatus;
    /** The result text written by the step's member via mobius_done. */
    output?: string;
    /** Durable child session id of this step's dedicated subagent. */
    assigneeId?: string;
    /** Failure detail (currently unused by tools; reserved). */
    error?: string;
    /** How many times this step has been retried after an unrecoverable failure. */
    retryCount?: number;
    /**
     * True when this step was spawned by a Eureka discover (a derived node).
     * Derived nodes get no `mobius_discover` permission, so a derived sub-agent
     * cannot nest further — one node may discover new nodes, but those new
     * nodes may never discover again. This keeps a runaway
     * "one node builds many, many build more" recursion from inflating the
     * pipeline (e.g. 4 concurrent stages turning into 30 nodes).
     */
    derived?: boolean;
    createdAt: number;
    updatedAt: number;
}
export interface MobiusWorkflow {
    id: string;
    name: string;
    /** The user's original research goal. */
    goal: string;
    /** Steps in execution order. */
    steps: MobiusStep[];
    /** Two-phase lifecycle. */
    phase: 'staged' | 'running' | 'done';
    /**
     * Staged-plan review gate, mirroring agent-teams' `planReviewState`.
     * `awaiting_review` (default) means the Web panel shows 启动/返回对话/discard;
     * `awaiting_feedback` means "返回对话重新规划" was pressed and the captain has
     * been returned to chat to revise the plan.
     */
    planReviewState?: 'awaiting_review' | 'awaiting_feedback';
    /**
     * User-approval gate. A staged workflow may only be started through the
     * panel's「启动」button (`approveStagedWorkflow`), which sets this to true.
     * The `mobius_start` tool is locked: it refuses to run unless this flag is
     * true, so an agent can never start a workflow without an explicit human
     * approval. Absent/false = not yet approved (staged).
     */
    approvedByUser?: boolean;
    /**
     * Final-conclusion review state (the "agent loop"). Set once
     * `mobius_finalize` submits a conclusion for an independent reviewer.
     * `awaiting_review` → an independent review subagent is (or was) judging the
     * latest conclusion; `passed` → the conclusion cleared review and the
     * workflow is done; `needs_revision` → the review bounced it and the captain
     * must rewrite before re-submitting.
     */
    review?: {
        status: 'awaiting_review' | 'passed' | 'needs_revision';
        /** Reviewer verdict text / findings when bounced. */
        findings: string;
        /** 1-based review round (increments on each re-submission). */
        round: number;
    };
    /** The latest (possibly review-revised) final conclusion submitted via mobius_finalize. */
    conclusion?: string;
    /**
     * Workflow-wide step timeout in milliseconds. Every running step must report
     * (mobius_done) within this budget or it is failed (direct fail-stop, no
     * retry) and the pipeline stops. Falls back to the plugin `timeoutMs` config
     * when unset.
     */
    timeoutMs?: number;
    /**
     * "Eureka" (尤里卡) mode: while the workflow is running, each step agent is
     * allowed to discover new viewpoints and self-adjust the workflow by editing
     * still-pending (not-yet-started) steps — adding, removing, or refining
     * future steps. Never touches already-running or completed steps. Auto-applies
     * on the next stage advance.
     */
    eureka?: boolean;
    /**
     * Optional display metadata for stages: a friendly summary name per stage.
     * Keyed by stage id (`stageIdOf`: the explicit `stage` name, or `@<stepId>`
     * for an implicit sequential single-step stage). When present, the panel
     * shows the summary as the stage-block heading; otherwise it falls back to
     * the stage name / "阶段 N". This is display-only metadata; it never affects
     * execution grouping.
     */
    stageTitles?: Record<string, string>;
    /**
     * When true, step agents are denied the web-search / web-fetch tools
     * (web_search, web_fetch), so steps rely on their own knowledge and memory
     * instead of web lookups. Useful for fast, self-contained research where
     * web searching dominates runtime. Defaults to false.
     */
    disableWebSearch?: boolean;
    /**
     * Hard cap on the total number of execution stages this workflow may have.
     * When set (> 0), creating a plan whose stage count exceeds this is rejected
     * at plan/edit time, and eureka discover cannot add a node that would push
     * the workflow past it. Default 0 = unlimited.
     */
    maxStageCount?: number;
    captainSessionId: string;
    createdAt: number;
    updatedAt: number;
}
/** Resolved plugin config consumed by the mobius orchestrator. */
export interface MobiusConfig {
    stateDir: string;
    memberProvider: string;
    memberModel?: string;
    executionPrompt?: string;
    fallback?: {
        provider: string;
        model: string;
    };
    memberMaxDepth?: number;
    /** Auto-retry a failed step this many times before giving up (default 1). */
    maxStepRetries?: number;
    /** Max review rounds for the final-conclusion "agent loop" before it gives up (default 2). */
    maxReviewRounds?: number;
    /** Default workflow-wide step timeout in ms; a step failing to report in time is failed and the pipeline stops (overridable per workflow). */
    timeoutMs?: number;
    /** Soft cap on web_search/web_fetch calls per step agent (prompt discipline). Default 3. */
    stepSearchLimit?: number;
    /** Hard cap on the total number of execution stages a workflow may have (default 0 = unlimited). */
    maxStageCount?: number;
    maxMembers: number;
}
/** Process-local member-selection bridge shared by every step spawn. */
export interface MobiusRuntime {
    config: MobiusConfig;
    selections: ReturnType<typeof installMemberSelectionRuntime>;
}
export declare function validateStepList(steps: readonly {
    title: string;
    target: string;
}[]): string | undefined;
/** Render a millisecond duration as a short, human-readable label (e.g. "5 分钟"). */
export declare function durationLabel(ms: number): string;
/** Portable, reusable workflow template format (export/import payload). */
export interface MobiusWorkflowTemplate {
    format: 'dsh-mobius-workflow';
    version: number;
    name: string;
    goal: string;
    /** Workflow-wide step timeout in ms (optional; the plugin default applies when absent). */
    timeoutMs?: number;
    /** "Eureka" mode flag (optional; defaults to off on import). */
    eureka?: boolean;
    /** Disable web-search/web-fetch for step agents (optional; defaults to off). */
    disableWebSearch?: boolean;
    /** Hard cap on the total number of execution stages (optional; 0/absent = unlimited). */
    maxStageCount?: number;
    /** Display-only summary name per stage id (see MobiusWorkflow.stageTitles). */
    stageTitles?: Record<string, string>;
    steps: {
        title: string;
        target: string;
        context?: string;
        stage?: string;
    }[];
}
/** The current template format version. */
export declare const MOBIUS_TEMPLATE_VERSION = 1;
/**
 * Serialize a workflow into a portable, reusable template. Runtime state
 * (status/output/assigneeId/review/phase) is intentionally dropped so the
 * exported file is a clean definition that can be re-imported and re-run.
 */
export declare function serializeMobiusTemplate(workflow: MobiusWorkflow): MobiusWorkflowTemplate;
/** Pretty-printed JSON string of a workflow template (for download / chat). */
export declare function serializeMobiusTemplateJson(workflow: MobiusWorkflow): string;
/**
 * Parse and validate a workflow template from untrusted JSON. Returns the
 * parsed template, or throws a descriptive Error when the payload is invalid.
 */
export declare function parseMobiusTemplate(raw: string): MobiusWorkflowTemplate;
/** Build a fresh staged workflow from an imported template. */
export declare function workflowFromTemplate(template: MobiusWorkflowTemplate, captainSessionId: string, workflowId: string): MobiusWorkflow;
/** Build the接力 prompt for one step: prior results + this step's brief. */
export declare function buildStepPrompt(workflow: MobiusWorkflow, step: MobiusStep, previous: readonly MobiusStep[], searchLimit?: number): string;
/** The effective stage id of a step (its `stage`, or a unique per-step id). */
export declare function stageIdOf(workflow: MobiusWorkflow, step: MobiusStep): string;
/**
 * Group steps into their execution stages, preserving order of first
 * appearance. Each group's steps run concurrently; groups run serially.
 * A step without an explicit `stage` forms its own single-step stage so the
 * original linear接力 order is preserved.
 */
export declare function stageGroups(workflow: MobiusWorkflow): MobiusStep[][];
/** The number of execution stages in a workflow (see stageGroups). */
export declare function stageCount(workflow: Pick<MobiusWorkflow, 'steps'>): number;
/** The effective hard cap on stages for a workflow: its own maxStageCount when
 *  set, else the plugin-wide config cap, else 0 = unlimited. */
export declare function effectiveMaxStageCount(workflow: Pick<MobiusWorkflow, 'maxStageCount'>, configMax: number | undefined): number;
/**
 * The steps of the current (first non-completed) stage, or undefined when done.
 * A stage is "current" while any of its steps is not yet completed.
 */
export declare function currentStageSteps(workflow: MobiusWorkflow): MobiusStep[] | undefined;
/** The first not-yet-completed step (for legacy callers wanting a single step). */
export declare function nextPendingStep(workflow: MobiusWorkflow): MobiusStep | undefined;
/** First non-completed step (running preferred, else next pending), or undefined when done. */
export declare function currentStepOf(workflow: MobiusWorkflow): MobiusStep | undefined;
export declare function completedOutputs(workflow: MobiusWorkflow): string[];
export declare function workflowSummary(workflow: MobiusWorkflow): {
    phase: MobiusWorkflow['phase'];
    done: number;
    total: number;
    current: string;
};
declare function readWorkflows(stateRoot: string): Promise<Record<string, MobiusWorkflow>>;
export { readWorkflows };
/**
 * Collect every mobius workflow under one state root, newest first. Used by
 * the web snapshot route for the activity panel.
 */
export declare function collectMobiusWorkflows(stateRoot: string): Promise<MobiusWorkflow[]>;
/**
 * Interrupt a running mobius workflow: abort the currently-running step's
 * dedicated member (if any), mark any non-terminal steps halted, and set the
 * workflow to `done` so the panel/card stop treating it as live. Mirrors the
 * agent-teams halt boundary without touching an agent-teams `team.json`.
 *
 * Safe to call when the workflow is `staged` (nothing to interrupt) or already
 * `done` (idempotent). Returned counts let the web route report what changed.
 */
export declare function haltMobiusWorkflow(input: {
    ctx: Context;
    stateRoot: string;
    workflowId: string;
    captain: Agent;
}): Promise<{
    workflowId: string;
    name: string;
    interruptedMembers: number;
    alreadyStopped: boolean;
}>;
/** Context queued after the human returns a staged plan to chat for revision. */
export declare function stagedPlanFeedbackContext(workflowName: string): string;
/** Context queued after the human discards a staged Mobius plan. */
export declare function stagedPlanDiscardContext(workflowName: string): string;
/** Delete a staged workflow from the store (discard). Returns true if removed. */
export declare function removeWorkflow(stateRoot: string, captainId: string, workflowId: string): Promise<boolean>;
/** The system prompt (persona) for ONE mobius step agent. */
export declare function mobiusPersona(config: MobiusConfig, workflowName: string, stepTitle: string, eureka: boolean): string;
/** The system prompt (persona) for ONE independent final-conclusion reviewer. */
export declare function mobiusReviewerPersona(config: MobiusConfig, workflowName: string): string;
/**
 * Server-side plan actions exposed to the web plan route, mirroring
 * agent-teams' `AgentTeamsRuntime` surface (subset used by the panel buttons).
 */
export interface MobiusPlanRuntime {
    approveStagedWorkflow(captain: Agent, workflowId: string): Promise<{
        teamId: string;
        steps: number;
    }>;
    continueStagedPlanning(captain: Agent, workflowId: string): Promise<{
        workflowId: string;
        alreadyWaiting: boolean;
    }>;
    discardStagedWorkflow(captain: Agent, workflowId: string): Promise<{
        workflowId: string;
        name: string;
    }>;
    updateStagedWorkflow(captain: Agent, workflowId: string, patch: MobiusStepPatch): Promise<{
        workflowId: string;
        name: string;
        steps: number;
        updatedSteps: string[];
        addedSteps: string[];
        removedSteps: string[];
    }>;
}
/** A partial edit of a staged workflow: optional goal/timeout/eureka plus per-step field overrides. */
export interface MobiusStepPatch {
    goal?: string;
    /** Replace the workflow-wide step timeout (ms). Unset leaves it unchanged. */
    timeoutMs?: number;
    /** Replace the "Eureka" mode flag (only meaningful while staged). */
    eureka?: boolean;
    /** Replace whether step agents are denied web-search/web-fetch tools. */
    disableWebSearch?: boolean;
    /** Replace the hard cap on total execution stages (0/absent removes it). */
    maxStageCount?: number;
    /** Replace the display-only stage summary names (keyed by stage id). */
    stageTitles?: Record<string, string>;
    steps?: {
        id: string;
        title?: string;
        target?: string;
        context?: string;
        stage?: string;
    }[];
    /** Append new step definitions to the workflow (each becomes a full step). */
    addSteps?: {
        title: string;
        target: string;
        context?: string;
        stage?: string;
    }[];
    /** Remove the given steps from the workflow (only valid while staged). */
    removeStepIds?: string[];
}
/**
 * Install every mobius capability: the shared member-selection bridge, the
 * retired-member guard, the `mobius_*` tools, and the Web plan actions. This
 * is called from the plugin's `apply` alongside the agent-teams tools.
 */
export declare function installMobius(ctx: Context, config: MobiusConfig): MobiusPlanRuntime;
