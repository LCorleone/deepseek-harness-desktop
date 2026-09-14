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
import { LlmError, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { MEMBER_LABEL_PREFIX, deliverToMember, installMemberSelectionRuntime, installRetiredMemberGuard, interruptMember, resolveMemberLlmSelection, steerCaptainReport, } from "./members.js";
import { installContinuableMemberSetup, sessionOwnEvents, } from "./harness-compat.js";
import { recordRetiredMemberIds, sanitizeKey, withTeamLock } from "./state.js";
import { appendTeamEvent } from "./events.js";
/**
 * Durable workflow state lives at `<stateDir>/mobius/mobius.json`: a map of
 * captainSessionId → workflow record. Versioned by migrations if the shape ever changes.
 */
const MOBIUS_FILE = 'mobius.json';
/**
 * Process-local in-flight step timeout timers, keyed by
 * `<captainId>\u0000<workflowId>\u0000<stepId>`. Module-scoped so both the
 * orchestrator and the module-level web actions (halt) can arm/clear them.
 * Timers are intentionally not persisted (a crash/restart drops them); a later
 * run re-arms each dispatched step.
 */
const stepTimeouts = new Map();
/** Stop (and deregister) any timeout timer for one running step. */
export function clearWorkflowStepTimeout(captainId, workflowId, stepId) {
    const key = `${captainId}\u0000${workflowId}\u0000${stepId}`;
    const timer = stepTimeouts.get(key);
    if (timer !== undefined) {
        clearTimeout(timer);
        stepTimeouts.delete(key);
    }
}
/** Stop every timeout timer for a whole workflow (used on halt/finalize). */
export function clearWorkflowAllTimeouts(captainId, workflowId) {
    const prefix = `${captainId}\u0000${workflowId}\u0000`;
    for (const key of [...stepTimeouts.keys()]) {
        if (!key.startsWith(prefix))
            continue;
        const timer = stepTimeouts.get(key);
        if (timer !== undefined)
            clearTimeout(timer);
        stepTimeouts.delete(key);
    }
}
// ── pure state helpers (no I/O) ──────────────────────────────────────────────
export function validateStepList(steps) {
    if (steps.length === 0)
        return 'a mobius workflow needs at least one step';
    for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (step?.title.trim() === '' || step?.target.trim() === '') {
            return `step ${index + 1} needs a non-empty title and target`;
        }
    }
    return undefined;
}
/** Render a millisecond duration as a short, human-readable label (e.g. "5 分钟"). */
export function durationLabel(ms) {
    const minutes = ms / 60_000;
    if (minutes >= 1 && Number.isInteger(minutes))
        return `${minutes} 分钟`;
    if (minutes >= 1)
        return `${minutes.toFixed(1)} 分钟`;
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
}
/** The current template format version. */
export const MOBIUS_TEMPLATE_VERSION = 1;
/**
 * Serialize a workflow into a portable, reusable template. Runtime state
 * (status/output/assigneeId/review/phase) is intentionally dropped so the
 * exported file is a clean definition that can be re-imported and re-run.
 */
export function serializeMobiusTemplate(workflow) {
    return {
        format: 'dsh-mobius-workflow',
        version: MOBIUS_TEMPLATE_VERSION,
        name: workflow.name,
        goal: workflow.goal,
        ...workflow.timeoutMs !== undefined && workflow.timeoutMs > 0 ? { timeoutMs: workflow.timeoutMs } : {},
        ...workflow.eureka === true ? { eureka: true } : {},
        ...workflow.disableWebSearch === true ? { disableWebSearch: true } : {},
        ...workflow.maxStageCount !== undefined && workflow.maxStageCount > 0 ? { maxStageCount: workflow.maxStageCount } : {},
        ...workflow.stageTitles !== undefined && Object.keys(workflow.stageTitles).length > 0 ? { stageTitles: workflow.stageTitles } : {},
        steps: workflow.steps.map((step) => ({
            title: step.title,
            target: step.target,
            ...step.context !== undefined && step.context.trim() !== '' ? { context: step.context.trim() } : {},
            ...step.stage !== undefined && step.stage.trim() !== '' ? { stage: step.stage.trim() } : {},
        })),
    };
}
/** Pretty-printed JSON string of a workflow template (for download / chat). */
export function serializeMobiusTemplateJson(workflow) {
    return JSON.stringify(serializeMobiusTemplate(workflow), null, 2);
}
/**
 * Parse and validate a workflow template from untrusted JSON. Returns the
 * parsed template, or throws a descriptive Error when the payload is invalid.
 */
export function parseMobiusTemplate(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('导入失败：不是有效的 JSON');
    }
    if (value === null || typeof value !== 'object')
        throw new Error('导入失败：模板不是对象');
    const obj = value;
    if (obj.format !== 'dsh-mobius-workflow') {
        throw new Error('导入失败：缺少 dsh-mobius-workflow 格式标记');
    }
    if (typeof obj.name !== 'string' || obj.name.trim() === '')
        throw new Error('导入失败：缺少有效的 name');
    if (typeof obj.goal !== 'string' || obj.goal.trim() === '')
        throw new Error('导入失败：缺少有效的 goal');
    if (!Array.isArray(obj.steps) || obj.steps.length === 0)
        throw new Error('导入失败：缺少至少一个步骤');
    const steps = obj.steps.map((item, index) => {
        const step = item;
        if (typeof step.title !== 'string' || step.title.trim() === '') {
            throw new Error(`导入失败：步骤 ${index + 1} 缺少有效 title`);
        }
        if (typeof step.target !== 'string' || step.target.trim() === '') {
            throw new Error(`导入失败：步骤 ${index + 1} 缺少有效 target`);
        }
        return {
            title: step.title.trim(),
            target: step.target.trim(),
            ...typeof step.context === 'string' && step.context.trim() !== '' ? { context: step.context.trim() } : {},
            ...typeof step.stage === 'string' && step.stage.trim() !== '' ? { stage: step.stage.trim() } : {},
        };
    });
    return {
        format: 'dsh-mobius-workflow',
        version: typeof obj.version === 'number' ? obj.version : MOBIUS_TEMPLATE_VERSION,
        name: obj.name.trim(),
        goal: obj.goal.trim(),
        ...typeof obj.timeoutMs === 'number' && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
            ? { timeoutMs: obj.timeoutMs }
            : {},
        ...obj.eureka === true ? { eureka: true } : {},
        ...obj.disableWebSearch === true ? { disableWebSearch: true } : {},
        ...typeof obj.maxStageCount === 'number' && Number.isFinite(obj.maxStageCount) && obj.maxStageCount > 0
            ? { maxStageCount: obj.maxStageCount }
            : {},
        ...isRecord(obj.stageTitles)
            ? { stageTitles: sanitizeStageTitles(obj.stageTitles) }
            : {},
        steps,
    };
}
/** Keep only string values from a raw stageTitles object. */
function sanitizeStageTitles(raw) {
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.trim() !== '')
            out[key] = value.trim();
    }
    return out;
}
/** Narrow guard: is `value` a plain object? */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Build a fresh staged workflow from an imported template. */
export function workflowFromTemplate(template, captainSessionId, workflowId) {
    const now = Date.now();
    return {
        id: workflowId,
        name: template.name,
        goal: template.goal,
        steps: template.steps.map((step, index) => ({
            id: `s${index + 1}`,
            title: step.title,
            target: step.target,
            ...step.context !== undefined ? { context: step.context } : {},
            ...step.stage !== undefined ? { stage: step.stage } : {},
            status: 'pending',
            createdAt: now,
            updatedAt: now,
        })),
        phase: 'staged',
        ...template.timeoutMs !== undefined ? { timeoutMs: template.timeoutMs } : {},
        ...template.eureka === true ? { eureka: true } : {},
        // Web search is off by default (only a template that explicitly re-enables
        // it — disableWebSearch:false — turns it on).
        ...(template.disableWebSearch === false ? {} : { disableWebSearch: true }),
        ...template.maxStageCount !== undefined && template.maxStageCount > 0 ? { maxStageCount: template.maxStageCount } : {},
        ...template.stageTitles !== undefined && Object.keys(template.stageTitles).length > 0 ? { stageTitles: template.stageTitles } : {},
        captainSessionId,
        createdAt: now,
        updatedAt: now,
    };
}
/** Build the接力 prompt for one step: prior results + this step's brief. */
export function buildStepPrompt(workflow, step, previous, searchLimit) {
    const results = previous
        .filter((item) => item.status === 'completed' && item.output !== undefined)
        .map((item) => `### ${item.id} — ${item.title}\n${item.output}`);
    const lines = [
        `You are step ${step.id} of the Mobius research workflow "${workflow.name}".`,
        '',
        '## Overall goal',
        workflow.goal,
        '',
        '## Steps completed so far (their results are your source material — do not ignore them)',
        results.length === 0 ? '(none — you start the pipeline)' : results.join('\n\n'),
        '',
        '## Your step',
        step.context === undefined || step.context.trim() === ''
            ? step.target
            : `${step.target}\n\n${step.context}`,
        '',
        'Work this step thoroughly with your available tools, then report your result by calling mobius_done with a concise but complete written output. Do not start any later step, and do not restart earlier work.',
    ];
    // Eureka is a live, encouraged capability: when the workflow has it enabled,
    // each node is told to actively evaluate the pipeline during its work and to
    // use mobius_discover whenever that evaluation turns up a genuine improvement.
    // It is not a mandate to churn — high-value adjustments only — but the agent
    // is pushed to actually make the evaluation rather than skip it.
    if (workflow.eureka === true) {
        lines.push('', '## Eureka mode — evaluate and improve the pipeline', 'Your workflow has Eureka enabled, which gives you the mobius_discover tool to actively improve the research pipeline as part of doing your step.', '', 'While you work, consciously evaluate the plan (the overall goal and the steps that come after you). Ask yourself: is there an angle, sub-question, or caveat that the remaining steps will likely miss? Would any still-not-started step be materially stronger if split, merged, reworded, or given extra guidance?', '', 'If your answer to either is a clear "yes", act on it with mobius_discover rather than only noting it in your output:', '- addSteps: add a brand-new node (joins your current stage by default) for a genuinely missing angle.', '- editSteps: refine a still-not-started (PENDING) node, including in later stages, when the new information materially changes what it should do.', '- removeStepIds: drop a pending node you now see is redundant.', '', 'Notes:', '- This is encouraged, not forced: you are not required to change anything. Only make focused, high-quality edits that clearly improve the final research outcome; never edit for its own sake.', '- Never modify the node you are currently running, nor any already-completed node.', '- Finish your own step with mobius_done as usual either way; your discover edits take effect automatically for the steps ahead.');
    }
    // When web search is disabled, forbid any web/network lookups outright and
    // do NOT show the "search discipline" block (which encourages searching).
    if (workflow.disableWebSearch === true) {
        lines.push('', '## Web access disabled', 'Web search / page fetching is DISABLED for this workflow. Do NOT use any web, search, or page-fetch tool (web_search, web_fetch, read_page, x_search, or any other network-capable tool), and do not try to reach the internet through other means. Rely on the earlier steps\' results and your own knowledge. If a fact genuinely requires external verification, state it as an open question / uncertainty in your mobius_done output rather than going online.');
    }
    else if (typeof searchLimit === 'number' && searchLimit > 0) {
        // Search discipline: cap how much a single step spends on web lookups, so
        // research stays snappy instead of hanging on repeated web_search/web_fetch.
        lines.push('', `## Web search discipline (max ${searchLimit} lookups)`, `For THIS step only, limit your web searching to at most ${searchLimit} total lookups (each web_search call, or each web_fetch of a page, counts as one).`, '- Prefer your existing knowledge first; search only to fill genuine gaps or verify key facts you must have right.', '- Make each lookup count: combine related questions into few, high-signal searches; fetch only the most authoritative pages.', '- Do not keep re-searching, re-fetching, or chasing every link. Once you have enough to answer your step, stop searching and write your result.', '- If you still have gaps after the cap, state them plainly as what remains uncertain — do not exceed the cap.');
    }
    return lines.join('\n');
}
/** The effective stage id of a step (its `stage`, or a unique per-step id). */
export function stageIdOf(workflow, step) {
    return step.stage !== undefined && step.stage.trim() !== ''
        ? step.stage.trim()
        : `@${step.id}`; // implicit stage: one step per sequential unit
}
/**
 * Group steps into their execution stages, preserving order of first
 * appearance. Each group's steps run concurrently; groups run serially.
 * A step without an explicit `stage` forms its own single-step stage so the
 * original linear接力 order is preserved.
 */
export function stageGroups(workflow) {
    const order = [];
    const byId = new Map();
    for (const step of workflow.steps) {
        const key = stageIdOf(workflow, step);
        if (!byId.has(key)) {
            byId.set(key, []);
            order.push(key);
        }
        byId.get(key).push(step);
    }
    return order.map((key) => byId.get(key));
}
/** The number of execution stages in a workflow (see stageGroups). */
export function stageCount(workflow) {
    return stageGroups(workflow).length;
}
/** The effective hard cap on stages for a workflow: its own maxStageCount when
 *  set, else the plugin-wide config cap, else 0 = unlimited. */
export function effectiveMaxStageCount(workflow, configMax) {
    if (workflow.maxStageCount !== undefined && workflow.maxStageCount > 0)
        return workflow.maxStageCount;
    if (configMax !== undefined && configMax > 0)
        return configMax;
    return 0;
}
/**
 * The steps of the current (first non-completed) stage, or undefined when done.
 * A stage is "current" while any of its steps is not yet completed.
 */
export function currentStageSteps(workflow) {
    for (const group of stageGroups(workflow)) {
        if (group.some((step) => step.status !== 'completed'))
            return group;
    }
    return undefined;
}
/** The first not-yet-completed step (for legacy callers wanting a single step). */
export function nextPendingStep(workflow) {
    return workflow.steps.find((step) => step.status === 'pending');
}
/** First non-completed step (running preferred, else next pending), or undefined when done. */
export function currentStepOf(workflow) {
    return workflow.steps.find((step) => step.status === 'running') ?? nextPendingStep(workflow);
}
export function completedOutputs(workflow) {
    return workflow.steps
        .filter((step) => step.status === 'completed' && step.output !== undefined)
        .map((step) => `### ${step.id} — ${step.title}\n${step.output}`);
}
export function workflowSummary(workflow) {
    return {
        phase: workflow.phase,
        done: workflow.steps.filter((step) => step.status === 'completed').length,
        total: workflow.steps.length,
        current: currentStepOf(workflow)?.id ?? '',
    };
}
// ── I/O helpers ──────────────────────────────────────────────────────────────
/** All workflows live in one file per state root: `<stateRoot>/mobius/mobius.json`. */
function mobiusCapRoot(stateRoot) {
    return join(stateRoot, 'mobius');
}
async function readWorkflows(stateRoot) {
    try {
        const raw = await readFile(join(mobiusCapRoot(stateRoot), MOBIUS_FILE), 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export { readWorkflows };
/**
 * Collect every mobius workflow under one state root, newest first. Used by
 * the web snapshot route for the activity panel.
 */
export async function collectMobiusWorkflows(stateRoot) {
    const store = await readWorkflows(stateRoot);
    return Object.values(store).sort((a, b) => b.createdAt - a.createdAt);
}
/**
 * Interrupt a running mobius workflow: abort the currently-running step's
 * dedicated member (if any), mark any non-terminal steps halted, and set the
 * workflow to `done` so the panel/card stop treating it as live. Mirrors the
 * agent-teams halt boundary without touching an agent-teams `team.json`.
 *
 * Safe to call when the workflow is `staged` (nothing to interrupt) or already
 * `done` (idempotent). Returned counts let the web route report what changed.
 */
export async function haltMobiusWorkflow(input) {
    return withTeamLock(`mobius:${input.captain.id}`, async () => {
        const store = await readWorkflows(input.stateRoot);
        const workflow = store[input.captain.id];
        if (workflow === undefined || workflow.id !== input.workflowId) {
            throw new Error(`no mobius workflow "${input.workflowId}" for this captain`);
        }
        if (workflow.phase === 'done') {
            return { workflowId: workflow.id, name: workflow.name, interruptedMembers: 0, alreadyStopped: true };
        }
        let interrupted = 0;
        for (const step of workflow.steps) {
            if (step.status !== 'running')
                continue;
            if (step.assigneeId !== undefined && step.assigneeId !== '') {
                interruptMember(input.ctx, input.captain, step.assigneeId);
                interrupted += 1;
            }
            step.status = 'halted';
            step.error = 'Stopped from the captain chat.';
            step.updatedAt = Date.now();
        }
        // Any still-pending steps never get dispatched; mark them halted too so the
        // panel reflects an interrupted pipeline rather than a queue that "will run".
        for (const step of workflow.steps) {
            if (step.status !== 'pending')
                continue;
            step.status = 'halted';
            step.error = 'Stopped from the captain chat before dispatch.';
            step.updatedAt = Date.now();
        }
        workflow.phase = 'done';
        workflow.updatedAt = Date.now();
        await writeWorkflows(input.stateRoot, store);
        clearWorkflowAllTimeouts(input.captain.id, workflow.id);
        return { workflowId: workflow.id, name: workflow.name, interruptedMembers: interrupted, alreadyStopped: false };
    });
}
async function writeWorkflows(stateRoot, workflows) {
    const dir = mobiusCapRoot(stateRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MOBIUS_FILE), JSON.stringify(workflows, null, 2), 'utf8');
}
/** Context queued after the human returns a staged plan to chat for revision. */
export function stagedPlanFeedbackContext(workflowName) {
    return [
        `The user selected "Return to chat and revise" for the staged Mobius workflow "${workflowName}".`,
        'The existing staged plan is still the only draft. Do not start it, create a replacement workflow, or finalize it in this turn.',
        'Ask the user one concise, concrete question about what they want changed (goal or any step), then stop and wait for their answer.',
        'After the user answers, revise this same staged plan and present it again for review.',
    ].join('\n');
}
/** Context queued after the human discards a staged Mobius plan. */
export function stagedPlanDiscardContext(workflowName) {
    return [
        `The user discarded the staged Mobius workflow "${workflowName}" from the review UI.`,
        'That decision is final for this draft: no member was spawned and no step may run.',
        'Do not start, recreate, or finalize this workflow. Wait for a later explicit user request.',
    ].join('\n');
}
/** Delete a staged workflow from the store (discard). Returns true if removed. */
export async function removeWorkflow(stateRoot, captainId, workflowId) {
    const store = await readWorkflows(stateRoot);
    const existing = store[captainId];
    if (existing === undefined || existing.id !== workflowId)
        return false;
    delete store[captainId];
    await writeWorkflows(stateRoot, store);
    return true;
}
/** Tools a mobius step member must never call (workflow orchestration is the captain's). */
const MOBIUS_DENIED_TOOLS = [
    'mobius_create',
    'mobius_start',
    'mobius_finalize',
    'mobius_export',
    'mobius_import',
    'mobius_update',
    'ask_user_question',
];
/** Web-search / web-fetch tools denied to step agents when disableWebSearch is set. */
/**
 * Web-capable tools denied to step agents when disableWebSearch is set.
 * Covers the DSH native web_search/web_fetch seam AND the modsearch-provided
 * read_page / x_search tools, which can otherwise fetch web content directly
 * even when "web search" is toggled off.
 */
const MOBIUS_DENIED_WEB_TOOLS = [
    'web_search',
    'web_fetch',
    'read_page',
    'x_search',
];
/** The system prompt (persona) for ONE mobius step agent. */
export function mobiusPersona(config, workflowName, stepTitle, eureka) {
    const eurekaBlock = eureka ? `

EUREKA MODE (self-improving pipeline) — 已启用，请主动使用:
As an execution agent you are EXPECTED to aggressively improve the remaining pipeline as you work, not merely follow it. You have the mobius_discover tool, which lets you add new future steps, remove or refine still-pending (not-yet-started) steps. Be proactive:
- As soon as your step surfaces a new angle, a missing sub-question, a step worth splitting into more depth, or a step that is redundant or off-track, USE mobius_discover right away — do not wait and do not be shy about acting.
- Actively look for gaps: what important aspect is NOT covered by the remaining steps? Add it. Is a remaining step too broad to be useful? Split it. Is a step now redundant given your findings? Remove or tighten it.
- Default to acting: when in doubt about whether an edit helps, prefer making the workflow deeper and more complete. Aim for thorough, multi-perspective coverage.
- Guardrails: only touch steps that are still PENDING (not yet started) — never the step you are currently running, nor any completed step. Keep each edit coherent and reason about the real shape of the research; avoid edits that are empty, contradictory, or purely cosmetic.
- You still must finish your own step with mobius_done as usual.
` : '';
    return `You are an execution agent working inside a Mobius sequential research workflow in DeepSeek Harness.

Workflow: ${workflowName}
Your step: ${stepTitle}

You are one step of an ordered pipeline. You receive a prompt that includes the overall goal, the results of every earlier step, and the exact target of YOUR step.${config.executionPrompt !== undefined && config.executionPrompt.trim() !== '' ? `

Execution guidance:
${config.executionPrompt}` : ''}
${eurekaBlock}
Rules:
1. Work ONLY your own step with your available tools. Do not start any later step, and do not restart or duplicate earlier work.
2. Treat the earlier steps' results in your prompt as source material — do not ignore them.
3. When you finish, call mobius_done with a concise but complete written result. That is the ONLY way to record your step's output; it also automatically hands your result to the next step.
4. You cannot create/start work, finalize, or act as a captain — those are the orchestrator's job.
5. Report thoroughly; your output becomes the input of the next step, so write it self-contained and unambiguous.
6. You cannot pause to ask the human. If your step surfaces a genuine question or decision that needs the user, do NOT try to prompt them — state the open question, the options you considered, and your recommendation explicitly in your mobius_done report so the captain can surface it.`;
}
/** Spawn ONE dedicated continuable subagent for a mobius step with its own persona. */
async function spawnStepAgent(ctx, config, selections, captain, workflow, step, llmSelection, assignmentPrompt) {
    const provider = config.memberProvider;
    const label = `agent-teams:${workflow.id}:${step.id}`;
    // Deny only web tools that are actually registered in this profile
    // (tools.restrict() throws on a name that is not a known global tool, e.g.
    // on a profile without modsearch there is no read_page/x_search). This keeps
    // the web cut robust across profiles while still covering every web-capable
    // tool the step agent could otherwise reach.
    const deny = [...MOBIUS_DENIED_TOOLS];
    if (workflow.disableWebSearch === true) {
        const registered = new Set(ctx.tools.schemas().map((tool) => tool.name));
        deny.push(...MOBIUS_DENIED_WEB_TOOLS.filter((name) => registered.has(name)));
        // A step must not be able to reach the network through a shell either.
        for (const shell of ['bash', 'pwsh']) {
            if (registered.has(shell))
                deny.push(shell);
        }
    }
    const start = await selections.withPending(captain.id, label, llmSelection, () => (ctx.subagents.startContinuable({
        provider,
        label,
        request: {
            // The full assignment (goal + all prior-stage conclusions + this
            // step's brief) is the subagent's INITIAL prompt, so it is born with
            // its complete upstream context and DSH's native subagent view shows
            // it as the opening message.
            prompt: [{
                    type: 'text',
                    text: assignmentPrompt,
                }],
            parent: captain,
            persona: mobiusPersona(config, workflow.name, step.title, workflow.eureka === true),
            toolFilter: { deny },
            agentOptions: {
                provider: llmSelection.provider,
                model: llmSelection.model,
                ...llmSelection.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: ReasoningEffortId(llmSelection.reasoningEffort) },
            },
            ...config.memberMaxDepth !== undefined ? { maxDepth: config.memberMaxDepth } : {},
        },
        signal: new AbortController().signal,
    })));
    return start.childId;
}
/** The system prompt (persona) for ONE independent final-conclusion reviewer. */
export function mobiusReviewerPersona(config, workflowName) {
    return `You are an independent quality reviewer inside a Mobius research workflow in DeepSeek Harness.

Workflow: ${workflowName}

Your job is to judge whether a final research conclusion adequately answers the workflow's goal, given all the step outputs that produced it. You are independent: you did NOT write the conclusion.

Rules:
1. Read the workflow goal, the step outputs, and the submitted conclusion.
2. Judge whether the conclusion is complete, accurate, well-structured, and directly answers the goal without leaving important gaps.
3. Call mobius_review_verdict with a verdict of "pass" when the conclusion is acceptable, or "needs_revision" when it has material problems. In the latter case, provide concrete, actionable findings — what is missing, wrong, or should be strengthened.
4. Be strict but fair. Do not demand perfection; demand that the conclusion genuinely serves the research goal.`;
}
/** Spawn ONE dedicated continuable subagent to review a final conclusion. */
async function spawnReviewer(ctx, config, selections, captain, workflow, llmSelection) {
    const provider = config.memberProvider;
    const label = `agent-teams:${workflow.id}:review`;
    const start = await selections.withPending(captain.id, label, llmSelection, () => (ctx.subagents.startContinuable({
        provider,
        label,
        request: {
            prompt: [{ type: 'text', text: `You are reviewing the final conclusion of the Mobius workflow "${workflow.name}". Read the review prompt and call mobius_review_verdict when you reach a verdict.` }],
            parent: captain,
            persona: mobiusReviewerPersona(config, workflow.name),
            toolFilter: { deny: [...MOBIUS_DENIED_TOOLS] },
            agentOptions: {
                provider: llmSelection.provider,
                model: llmSelection.model,
                ...llmSelection.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: ReasoningEffortId(llmSelection.reasoningEffort) },
            },
            ...config.memberMaxDepth !== undefined ? { maxDepth: config.memberMaxDepth } : {},
        },
        signal: new AbortController().signal,
    })));
    return start.childId;
}
function requireAgent(exec) {
    if (!exec.agent)
        throw new Error('mobius tools require a calling agent');
    return exec.agent;
}
function workspaceOf(agent) {
    return agent.session.header.cwd ?? process.cwd();
}
/**
 * Install every mobius capability: the shared member-selection bridge, the
 * retired-member guard, the `mobius_*` tools, and the Web plan actions. This
 * is called from the plugin's `apply` alongside the agent-teams tools.
 */
export function installMobius(ctx, config) {
    installRetiredMemberGuard(ctx, config.stateDir);
    const selections = installMemberSelectionRuntime(ctx, config.stateDir, async () => { });
    const load = async (captain) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const store = await readWorkflows(stateRoot);
        return store[captain.id];
    };
    const save = async (captain, workflow) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const store = await readWorkflows(stateRoot);
        store[captain.id] = workflow;
        await writeWorkflows(stateRoot, store);
    };
    // ── Workflow-level step timeout (direct fail-stop) ────────────────────────
    // A timeout is a workflow-wide budget applied to every running step: when a
    // step's dedicated subagent has not called mobius_done within `timeoutMs`, the
    // step is failed, the whole pipeline is stopped, and (per user choice) there
    // is NO auto-retry. The global config value is the default; a per-workflow
    // `timeoutMs` overrides it. Timers are process-local keyed by the step.
    const stepTimeoutMs = (workflow) => {
        const value = workflow.timeoutMs ?? config.timeoutMs;
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const scheduleStepTimeout = (captain, workflow, step) => {
        const ms = stepTimeoutMs(workflow);
        clearWorkflowStepTimeout(captain.id, workflow.id, step.id);
        if (ms === undefined)
            return;
        const timer = setTimeout(() => {
            void failStepOnTimeout(captain, workflow.id, step.id);
        }, ms);
        stepTimeouts.set(`${captain.id}\u0000${workflow.id}\u0000${step.id}`, timer);
    };
    /** Fail a running step for timeout and stop the pipeline (no retry). */
    const failStepOnTimeout = async (captain, workflowId, stepId) => {
        clearWorkflowStepTimeout(captain.id, workflowId, stepId);
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const overview = { stepTitle: stepId, label: '' };
        await withTeamLock(`mobius:${captain.id}`, async () => {
            const store = await readWorkflows(stateRoot);
            const fresh = store[captain.id];
            const step = fresh?.steps.find((s) => s.id === stepId && s.status === 'running');
            if (fresh === undefined || step === undefined)
                return;
            overview.stepTitle = step.title;
            const ms = stepTimeoutMs(fresh);
            const label = ms === undefined ? '超时' : `${durationLabel(ms)} 超时`;
            overview.label = label;
            if (step.assigneeId !== undefined && step.assigneeId !== '') {
                interruptMember(ctx, captain, step.assigneeId);
            }
            step.status = 'failed';
            step.error = `执行超时（${label}），流水线已停止。`;
            step.updatedAt = Date.now();
            for (const pending of fresh.steps) {
                if (pending.status !== 'pending')
                    continue;
                pending.status = 'failed';
                pending.error = '前序步骤执行超时，流水线已停止。';
                pending.updatedAt = Date.now();
            }
            fresh.phase = 'done';
            fresh.updatedAt = Date.now();
            await writeWorkflows(stateRoot, store);
        });
        steerCaptainReport(captain, 'Mobius', `第 ${stepId}（${overview.stepTitle}）${overview.label}，研究流水线已停止。`);
    };
    /**
     * Mark a step (and every trailing pending step) as failed, persist, and
     * notify the captain. Used when a step's dedicated subagent cannot be
     * spawned or delivered — an unrecoverable dispatch failure that would
     * otherwise leave the step stuck `running` with no assignee.
     */
    const failStepDispatch = async (captain, workflow, step, cause) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const summary = cause instanceof Error ? cause.message : String(cause);
        ctx.logger.error(`dsh-mobius: failed to dispatch step ${step.id} (${step.title}): ${summary}`);
        try {
            await withTeamLock(`mobius:${workflow.captainSessionId}`, async () => {
                const store = await readWorkflows(stateRoot);
                const fresh = store[workflow.captainSessionId];
                if (fresh === undefined || fresh.id !== workflow.id)
                    return;
                const current = fresh.steps.find((s) => s.id === step.id && s.status === 'running');
                const target = current ?? fresh.steps.find((s) => s.id === step.id);
                if (target === undefined)
                    return;
                target.status = 'failed';
                target.error = summary;
                target.updatedAt = Date.now();
                for (const pending of fresh.steps) {
                    if (pending.status !== 'pending')
                        continue;
                    pending.status = 'failed';
                    pending.error = 'Previous step failed; pipeline stopped.';
                    pending.updatedAt = Date.now();
                }
                fresh.phase = 'done';
                fresh.updatedAt = Date.now();
                await writeWorkflows(stateRoot, store);
            });
        }
        catch (error) {
            ctx.logger.warn(`dsh-mobius: failed to persist step dispatch failure: ${String(error)}`);
        }
        steerCaptainReport(captain, 'Mobius', `第 ${step.id} 步（${step.title}）无法启动子代理：${summary}。研究流水线已停止，可重新发起研究。`);
    };
    /** Spawn ONE dedicated subagent for `step` and deliver its接力 prompt. */
    const dispatchStep = async (captain, workflow, step) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        try {
            const selection = await resolveMemberLlmSelection(ctx, captain, {
                defaultModel: config.memberModel,
                fallback: config.fallback,
            });
            // Build the full assignment (goal + all prior-stage conclusions + brief)
            // ONCE and use it both as the subagent's initial prompt and as the first
            // delivered turn, so the native subagent view carries the upstream context.
            const assignment = buildStepPrompt(workflow, step, previousStepsOf(workflow, step), config.stepSearchLimit);
            const childId = await spawnStepAgent(ctx, config, selections, captain, workflow, step, selection, assignment);
            step.assigneeId = childId;
            step.status = 'running';
            step.updatedAt = Date.now();
            // Persist the assignment before delivery so mobius_done can authorize.
            const store = await readWorkflows(stateRoot);
            store[captain.id] = workflow;
            await writeWorkflows(stateRoot, store);
            await deliverToMember(ctx, captain, childId, assignment, new AbortController().signal);
            // Arm the workflow-level timeout for this step once it is actually running.
            scheduleStepTimeout(captain, workflow, step);
        }
        catch (error) {
            // A spawn/delivery failure is unrecoverable at this layer: there is no
            // child session to retry (the subagent never materialized), so surface
            // the real error and stop the pipeline instead of leaving the step stuck
            // `running` with no assignee (which previously wedged the workflow).
            await failStepDispatch(captain, workflow, step, error);
        }
    };
    /**
     * Already-completed steps from strictly earlier execution stages, in order,
     * as接力 source material. Steps in the SAME stage run concurrently and must
     * not consume each other's results, so only prior-stage outputs are offered.
     * The ordered stage list is derived fresh so implicit single-step stages keep
     * the original linear接力 order.
     */
    const previousStepsOf = (workflow, step) => {
        const ordered = stageGroups(workflow);
        const stepKey = stageIdOf(workflow, step);
        const priorKeys = new Set();
        for (const group of ordered) {
            const key = stageIdOf(workflow, group[0]);
            if (key === stepKey)
                break;
            priorKeys.add(key);
        }
        return ordered
            .filter((group) => priorKeys.has(stageIdOf(workflow, group[0])))
            .flat()
            .filter((item) => item.status === 'completed' && item.output !== undefined);
    };
    /**
     * Dispatch every currently-pending step of the first non-completed stage,
     * concurrently (each spawns its own dedicated subagent). Returns the steps
     * dispatched.
     */
    const dispatchCurrentStage = async (captain, workflow) => {
        const group = currentStageSteps(workflow);
        if (group === undefined)
            return [];
        const pending = group.filter((step) => step.status === 'pending');
        // Persist the running markers up front (before any child can call
        // mobius_done) so authorization and retry logic see a consistent state,
        // then spawn+deliver each step concurrently.
        for (const step of pending) {
            step.status = 'running';
            step.updatedAt = Date.now();
        }
        workflow.updatedAt = Date.now();
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const store = await readWorkflows(stateRoot);
        store[captain.id] = workflow;
        await writeWorkflows(stateRoot, store);
        await Promise.allSettled(pending.map((step) => dispatchStep(captain, workflow, step)));
        return pending;
    };
    // ── Mobius-specific failure handling (independent of agent-teams) ──────────
    // agent-teams' own agent/error listener reads `<root>/<teamId>/team.json` and
    // is a silent no-op for mobius steps (state lives in mobius.json). Install a
    // second, mobius-owned listener that writes to mobius.json and auto-retries.
    const maxStepRetries = Math.max(0, config.maxStepRetries ?? 1);
    installContinuableMemberSetup(ctx, (childCtx) => {
        const child = childCtx.agent;
        if (child === undefined)
            return () => undefined;
        const descriptor = foldSubagentDescriptor(sessionOwnEvents(child.session));
        if (descriptor?.mode !== 'continuable' || !descriptor.label.startsWith(MEMBER_LABEL_PREFIX)) {
            return () => undefined;
        }
        let lastFailedTurn;
        const dispose = childCtx.on('agent/error', async (payload) => {
            if (payload.agent.id !== child.id || payload.turn === lastFailedTurn)
                return;
            lastFailedTurn = payload.turn;
            try {
                // Locate the mobius workflow whose running step owns this child. The
                // label carries `<workflowId>:<stepId>` after the 'agent-teams:' prefix.
                const identity = descriptor.label.slice(MEMBER_LABEL_PREFIX.length);
                const separator = identity.indexOf(':');
                if (separator < 1 || separator === identity.length - 1)
                    return;
                const workflowId = identity.slice(0, separator);
                const stepId = identity.slice(separator + 1);
                const parentSessionId = child.session.header.parentSession;
                if (parentSessionId === undefined)
                    return;
                const workspace = child.session.header.cwd ?? process.cwd();
                const stateRoot = join(workspace, config.stateDir);
                let workflow;
                let step;
                await withTeamLock(`mobius:${parentSessionId}`, async () => {
                    const store = await readWorkflows(stateRoot);
                    const candidate = store[parentSessionId];
                    if (candidate === undefined || candidate.id !== workflowId || candidate.phase !== 'running')
                        return;
                    const runningStep = candidate.steps.find((s) => s.id === stepId && s.assigneeId === child.id && s.status === 'running');
                    if (runningStep === undefined)
                        return;
                    workflow = candidate;
                    step = runningStep;
                });
                if (workflow === undefined || step === undefined) {
                    ctx.logger.warn(`dsh-mobius: step subagent ${child.id} errored but no running mobius step owned it; ignoring`);
                    return;
                }
                // A step that raised an LLM error is no longer "in flight" under its
                // original timeout; clear the timer before deciding retry vs fail. The
                // retry respawn re-arms a fresh timer inside dispatchStep.
                clearWorkflowStepTimeout(workflow.captainSessionId, workflow.id, stepId);
                const failure = payload.error instanceof LlmError ? payload.error.failure : {
                    code: 'UNKNOWN',
                    message: payload.error instanceof Error ? payload.error.message : String(payload.error),
                };
                const summary = `${failure.message} (code ${failure.code})`;
                const captainId = workflow.captainSessionId;
                const captain = ctx.agents.get(captainId);
                if (captain === undefined)
                    return;
                const retry = (step.retryCount ?? 0) < maxStepRetries;
                const retryCount = retry ? (step.retryCount ?? 0) + 1 : (step.retryCount ?? 0);
                // Interrupt the old (failed) child so a stale late turn cannot deliver.
                interruptMember(ctx, captain, child.id);
                await withTeamLock(`mobius:${captainId}`, async () => {
                    const store = await readWorkflows(stateRoot);
                    const fresh = store[captainId];
                    const current = fresh?.steps.find((s) => s.id === stepId && s.assigneeId === child.id && s.status === 'running');
                    if (fresh === undefined || current === undefined)
                        return;
                    current.retryCount = retryCount;
                    if (retry) {
                        // Re-spawn a fresh dedicated subagent for the same step.
                        current.status = 'running';
                        current.assigneeId = undefined;
                        current.updatedAt = Date.now();
                        await writeWorkflows(stateRoot, store);
                        await dispatchStep(captain, fresh, current);
                    }
                    else {
                        current.status = 'failed';
                        current.error = summary;
                        current.updatedAt = Date.now();
                        for (const pending of fresh.steps) {
                            if (pending.status !== 'pending')
                                continue;
                            pending.status = 'failed';
                            pending.error = 'Previous step failed; pipeline stopped.';
                            pending.updatedAt = Date.now();
                        }
                        fresh.phase = 'done';
                        fresh.updatedAt = Date.now();
                        await writeWorkflows(stateRoot, store);
                        steerCaptainReport(captain, 'Mobius', `第 ${stepId} 步（${current.title}）失败：${summary}。研究流水线已停止，可重新发起研究。`);
                    }
                });
            }
            catch (error) {
                ctx.logger.warn(`dsh-mobius: failed to record step failure: ${String(error)}`);
            }
        });
        return () => {
            dispose();
        };
    });
    const registerTool = (tool) => {
        ctx.tools.register(tool);
    };
    registerTool(defineTool({
        name: 'mobius_create',
        description: 'Plan a research/analysis workflow. Provide the ordered steps; each runs as one dedicated subagent. Steps sharing the same "stage" run concurrently (as parallel subagents); stages run serially, and steps without a stage each run sequentially, the result of every earlier step feeding the next. Returns the staged plan; call mobius_start only after the user reviews it.',
        parameters: {
            name: { type: 'string', required: true, description: 'Short workflow name.' },
            goal: { type: 'string', required: true, description: 'The research goal to achieve.' },
            timeoutMs: { type: 'number', description: 'Optional per-step execution timeout in milliseconds. When a step does not report within this budget it fails (no retry) and the pipeline stops. Defaults to the plugin timeoutMs config.' },
            eureka: { type: 'boolean', description: '"尤里卡模式"（Eureka mode），默认关闭，除非用户明确要求，否则一律设为 false/不传。开启后，运行中的步骤 agent 会在执行时主动发现新问题，并新增/删除/修改仍处于"未开始"的后续步骤，让研究更有弹性、更能深挖。它从不会改动已完成或正在运行的步骤。仅当用户明确提出想要"自我调整、自动补充新角度"时才设 true。' },
            disableWebSearch: { type: 'boolean', description: 'Optional. When true, step agents are denied the web-search/web-fetch tools (web_search, web_fetch), so steps rely on their own knowledge and memory instead of web lookups. Set this when the research is self-contained and web searching would dominate runtime. Defaults to false.' },
            maxStageCount: { type: 'number', description: 'Optional hard cap on the total number of execution stages this workflow may have. When set (> 0), creating a plan with more stages is rejected. Default 0 = unlimited (or the plugin maxStageCount config).' },
            steps: {
                type: 'array',
                required: true,
                description: 'Ordered steps. Steps in the same "stage" run as concurrent parallels; otherwise each step is sequential and receives the results of all earlier steps.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        title: { type: 'string', required: true },
                        target: { type: 'string', required: true, description: 'What this step should research/analyze and produce.' },
                        context: { type: 'string', description: 'Optional extra guidance for this step.' },
                        stage: { type: 'string', description: 'Optional execution stage: steps sharing the same stage run concurrently as parallel subagents; stages run serially. Omit for sequential (each step then feeds the next).' },
                    },
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    steps: { type: 'number', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: `Mobius workflow "${value.name}" staged (${value.steps} steps, id ${value.workflow_id}): ${value.summary}` }],
        },
        async execute(args, exec) {
            const captain = requireAgent(exec);
            const invalid = validateStepList(args.steps);
            if (invalid !== undefined)
                throw new Error(invalid);
            const stateRoot = join(workspaceOf(captain), config.stateDir);
            const id = sanitizeKey(args.name.trim());
            const now = Date.now();
            const workflow = {
                id,
                name: args.name.trim(),
                goal: args.goal.trim(),
                steps: args.steps.map((step, index) => ({
                    id: `s${index + 1}`,
                    title: step.title.trim(),
                    target: step.target.trim(),
                    ...step.context !== undefined && step.context.trim() !== '' ? { context: step.context.trim() } : {},
                    ...step.stage !== undefined && step.stage.trim() !== '' ? { stage: step.stage.trim() } : {},
                    status: 'pending',
                    createdAt: now,
                    updatedAt: now,
                })),
                phase: 'staged',
                ...typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
                    ? { timeoutMs: args.timeoutMs }
                    : {},
                ...args.eureka === true ? { eureka: true } : {},
                // Web search is off by default: the step agent relies on its own
                // knowledge unless web search is explicitly enabled (disableWebSearch: false).
                ...(args.disableWebSearch === false ? {} : { disableWebSearch: true }),
                ...typeof args.maxStageCount === 'number' && Number.isFinite(args.maxStageCount) && args.maxStageCount > 0
                    ? { maxStageCount: args.maxStageCount }
                    : {},
                captainSessionId: captain.id,
                createdAt: now,
                updatedAt: now,
            };
            const cap = effectiveMaxStageCount(workflow, config.maxStageCount);
            if (cap > 0 && stageCount(workflow) > cap) {
                throw new Error(`workflow would have ${stageCount(workflow)} stages, exceeding the max of ${cap}`);
            }
            await withTeamLock(`mobius:${captain.id}`, async () => {
                const existing = await load(captain);
                if (existing !== undefined)
                    throw new Error(`captain already leads a mobius workflow ("${existing.name}") — finalize or delete it first`);
                await save(captain, workflow);
            });
            appendTeamEvent(ctx, captain.session, 'agent-teams/team-created', {
                teamId: workflow.id, captainSessionId: captain.id, name: workflow.name, description: workflow.goal,
            });
            return {
                workflow_id: workflow.id,
                name: workflow.name,
                steps: workflow.steps.length,
                summary: workflow.steps.map((s) => `${s.id}: ${s.title}`).join(' → '),
            };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_start',
        description: 'Begin a staged mobius workflow. IMPORTANT: this tool is LOCKED and will refuse to run until the user has clicked the panel「启动」(Start) button to approve the staged plan. Do NOT call this tool yourself — present the staged plan and ask the user to click「启动」. A workflow can only start through explicit user approval.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    step: { type: 'string', required: true },
                    steps: { type: 'number', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Mobius workflow ${value.workflow_id} started at ${value.step} (stage of ${value.steps} parallel step(s)).` }],
        },
        async execute(_args, exec) {
            const captain = requireAgent(exec);
            const workflow = await load(captain);
            if (workflow === undefined)
                throw new Error('no staged mobius workflow for this captain — call mobius_create first');
            if (workflow.phase !== 'staged')
                throw new Error(`workflow "${workflow.name}" is ${workflow.phase}, not staged`);
            if (workflow.approvedByUser !== true) {
                throw new Error('此工作流尚未经用户确认，mobius_start 已锁定：只有点击面板的「启动」按钮（用户明确批准）后才会开始执行。'
                    + '请将计划展示给用户，并请用户点击面板上的「启动」按钮确认，不要调用 mobius_start。');
            }
            const first = workflow.steps[0];
            if (first === undefined)
                throw new Error('workflow has no steps');
            workflow.phase = 'running';
            workflow.updatedAt = Date.now();
            await save(captain, workflow);
            const dispatched = await dispatchCurrentStage(captain, workflow);
            const label = dispatched.length > 1
                ? `${first.id}（${first.title}）等 ${dispatched.length} 个并行步骤`
                : `${first.id}（${first.title}）`;
            steerCaptainReport(captain, 'Mobius', `研究工作流「${workflow.name}」已启动，第 1 阶段 ${label} 开始执行。`);
            return { workflow_id: workflow.id, step: first.id, steps: dispatched.length };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_done',
        description: 'Report the result of the current step. Marks the step completed; when every step of its execution stage is done, automatically advances to the next stage (dispatching all its steps concurrently), or completes the workflow when all stages are done.',
        parameters: {
            output: { type: 'string', required: true, description: 'The written result of this step.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    step: { type: 'string', required: true },
                    next: { type: 'string', required: true },
                    done: { type: 'boolean', required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: `Step ${value.step} done${value.done ? '; workflow complete' : `; advancing to ${value.next}`}.` }],
        },
        async execute(args, exec) {
            const caller = requireAgent(exec);
            const stateRoot = join(workspaceOf(caller), config.stateDir);
            // Locate the workflow whose running step owns this session.
            const store = await readWorkflows(stateRoot);
            let ownerCaptain;
            let workflow;
            for (const candidate of Object.values(store)) {
                const step = candidate.steps.find((s) => s.assigneeId === caller.id && s.status === 'running');
                if (step === undefined)
                    continue;
                const captain = ctx.agents.get(candidate.captainSessionId);
                if (captain === undefined)
                    continue;
                workflow = candidate;
                ownerCaptain = captain;
                break;
            }
            if (workflow === undefined || ownerCaptain === undefined) {
                throw new Error('you do not own the running step of any mobius workflow');
            }
            let stepId = '';
            let stepTitle = '';
            let next = '';
            let nextTitle = '';
            let allDone = false;
            await withTeamLock(`mobius:${ownerCaptain.id}`, async () => {
                const fresh = await load(ownerCaptain);
                const current = fresh?.steps.find((s) => s.assigneeId === caller.id && s.status === 'running');
                if (fresh === undefined || current === undefined)
                    return;
                stepId = current.id;
                stepTitle = current.title;
                current.output = args.output;
                current.status = 'completed';
                current.updatedAt = Date.now();
                clearWorkflowStepTimeout(ownerCaptain.id, fresh.id, current.id);
                // Is this step's own execution stage now fully completed? (Concurrent
                // siblings may still be running; don't advance until all of them land.)
                const thisStageKey = stageIdOf(fresh, current);
                const stageFullyDone = fresh.steps
                    .filter((s) => stageIdOf(fresh, s) === thisStageKey)
                    .every((s) => s.status === 'completed');
                const nextStage = currentStageSteps(fresh);
                if (nextStage === undefined || nextStage.length === 0) {
                    // Every stage is complete.
                    fresh.phase = 'done';
                    fresh.updatedAt = Date.now();
                    allDone = true;
                    await save(ownerCaptain, fresh);
                }
                else if (stageFullyDone) {
                    // This step finished the last work of its stage: move to the next stage
                    // (dispatching all its steps concurrently).
                    const firstNext = nextStage[0];
                    next = firstNext.id;
                    nextTitle = firstNext.title;
                    fresh.updatedAt = Date.now();
                    await save(ownerCaptain, fresh);
                    await dispatchCurrentStage(ownerCaptain, fresh);
                }
                else {
                    // Sibling parallel steps in the same stage may still be running, or a
                    // discover-added pending node was inserted into this stage while we
                    // were running. Re-dispatch any still-pending steps of this stage so
                    // a discover-added sibling node actually gets executed rather than
                    // silently hanging in the wait branch.
                    fresh.updatedAt = Date.now();
                    await save(ownerCaptain, fresh);
                    const pendingHere = fresh.steps.filter((s) => stageIdOf(fresh, s) === thisStageKey && s.status === 'pending');
                    if (pendingHere.length > 0) {
                        await dispatchCurrentStage(ownerCaptain, fresh);
                    }
                }
            });
            // Mirror agent-teams: the completing member reports progress to the
            // captain through the same steering channel (renders as a live
            // conversation line without spawning a separate captain turn).
            if (allDone) {
                steerCaptainReport(ownerCaptain, 'Mobius', `已完成 ${stepId}（${stepTitle}）——本次研究流水线已全部完成。`);
            }
            else {
                steerCaptainReport(ownerCaptain, 'Mobius', `已完成 ${stepId}（${stepTitle}），接下来是 ${next}（${nextTitle}）。`);
            }
            return {
                step: stepId,
                next,
                done: allDone,
            };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_review_verdict',
        description: 'Record the verdict of an independent final-conclusion review. Called by a reviewer subagent with a pass / needs_revision decision and, when bounced, concrete findings.',
        parameters: {
            verdict: { type: 'string', required: true, description: '"pass" or "needs_revision".' },
            findings: { type: 'string', description: 'Required when needs_revision: concrete, actionable problems to fix.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    accepted: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Review recorded for ${value.workflow_id}; accepted=${value.accepted}` }],
        },
        async execute(args, exec) {
            const reviewer = requireAgent(exec);
            const parentSessionId = reviewer.session.header.parentSession;
            if (parentSessionId === undefined)
                throw new Error('reviewer must be a direct child of the captain');
            const captain = ctx.agents.get(parentSessionId);
            if (captain === undefined)
                throw new Error('captain session is not attached');
            const stateRoot = join(workspaceOf(captain), config.stateDir);
            const verdict = args.verdict === 'pass' ? 'passed' : args.verdict === 'needs_revision' ? 'needs_revision' : undefined;
            if (verdict === undefined)
                throw new Error('verdict must be "pass" or "needs_revision"');
            if (verdict === 'needs_revision' && (args.findings === undefined || args.findings.trim() === '')) {
                throw new Error('needs_revision requires non-empty findings');
            }
            const findingsText = verdict === 'needs_revision' ? (args.findings ?? '').trim() : '';
            let accepted = false;
            let workflowId = '';
            await withTeamLock(`mobius:${parentSessionId}`, async () => {
                const store = await readWorkflows(stateRoot);
                const workflow = store[parentSessionId];
                workflowId = workflow?.id ?? '';
                if (workflow === undefined || workflow.review?.status !== 'awaiting_review')
                    return;
                if (workflow.review.round > (config.maxReviewRounds ?? 2))
                    return;
                workflow.review = { status: verdict, findings: verdict === 'passed' ? '' : findingsText, round: workflow.review.round };
                workflow.updatedAt = Date.now();
                await writeWorkflows(stateRoot, store);
                accepted = verdict === 'passed';
            });
            return { workflow_id: workflowId, accepted };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_status',
        description: 'Report the current mobius workflow: phase, per-step status and outputs, and the接力 chain.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Workflow "${String(value.name ?? '')}" [${String(value.phase ?? '')}]\nGoal: ${String(value.goal ?? '')}`,
                }],
        },
        async execute(_args, exec) {
            const caller = requireAgent(exec);
            const stateRoot = join(workspaceOf(caller), config.stateDir);
            const store = await readWorkflows(stateRoot);
            const workflow = store[caller.id]
                ?? Object.values(store).find((c) => c.steps.some((s) => s.assigneeId === caller.id));
            if (workflow === undefined)
                throw new Error('no mobius workflow found for you');
            // Return a JSON-safe projection (interface lacks an index signature).
            return {
                workflow_id: workflow.id,
                name: workflow.name,
                goal: workflow.goal,
                phase: workflow.phase,
                ...workflow.timeoutMs !== undefined && workflow.timeoutMs > 0 ? { timeout_ms: workflow.timeoutMs } : {},
                ...workflow.maxStageCount !== undefined && workflow.maxStageCount > 0 ? { max_stage_count: workflow.maxStageCount } : {},
                steps: workflow.steps.map((step) => ({
                    id: step.id,
                    title: step.title,
                    target: step.target,
                    status: step.status,
                    ...step.stage === undefined ? {} : { stage: step.stage },
                    ...step.output === undefined ? {} : { output: step.output },
                    ...step.assigneeId === undefined ? {} : { assignee_id: step.assigneeId },
                })),
            };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_export',
        description: 'Export the current mobius workflow as a portable, reusable JSON template (name, goal, and step definitions only — no runtime state). Returns the JSON text inline for copying, or download it from the activity panel.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    template: { type: 'string', required: true },
                    filename: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Workflow ${value.workflow_id} exported as ${value.filename}:\n${value.template}` }],
        },
        async execute(_args, exec) {
            const captain = requireAgent(exec);
            const workflow = await load(captain);
            if (workflow === undefined)
                throw new Error('no mobius workflow for this captain — call mobius_create or mobius_import first');
            return {
                workflow_id: workflow.id,
                template: serializeMobiusTemplateJson(workflow),
                filename: `${sanitizeKey(workflow.name)}.mobius.json`,
            };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_import',
        description: 'Import a reusable mobius workflow template (JSON produced by mobius_export or downloaded from the panel) and stage it as a fresh plan for the current session. Replaces any existing staged plan; errors if a workflow is running or done.',
        parameters: {
            template: { type: 'string', required: true, description: 'The JSON workflow template to import.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    goal: { type: 'string', required: true },
                    steps: { type: 'number', required: true },
                    replaced_existing: { type: 'boolean', required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: `Workflow "${value.name}" imported (${value.steps} steps, id ${value.workflow_id})${value.replaced_existing ? ' — replaced the previous staged plan' : ''}` }],
        },
        async execute(args, exec) {
            const captain = requireAgent(exec);
            const template = parseMobiusTemplate(args.template);
            const stateRoot = join(workspaceOf(captain), config.stateDir);
            const id = sanitizeKey(template.name.trim());
            let replacedExisting = false;
            await withTeamLock(`mobius:${captain.id}`, async () => {
                const existing = await load(captain);
                if (existing !== undefined && existing.phase !== 'staged') {
                    throw new Error(`cannot import while workflow "${existing.name}" is ${existing.phase} — finish or discard it first`);
                }
                replacedExisting = existing !== undefined;
                const workflow = workflowFromTemplate(template, captain.id, id);
                const cap = effectiveMaxStageCount(workflow, config.maxStageCount);
                if (cap > 0 && stageCount(workflow) > cap) {
                    throw new Error(`imported workflow would have ${stageCount(workflow)} stages, exceeding the max of ${cap}`);
                }
                await save(captain, workflow);
            });
            return { workflow_id: id, name: template.name, goal: template.goal, steps: template.steps.length, replaced_existing: replacedExisting };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_update',
        description: 'Edit the current STAGED mobius workflow: change its goal, its workflow-wide step timeout, and/or individual step content (title/target/context/stage), append new steps, or remove steps — all by step id. Only allowed while the workflow is still "staged" (before start); a running or done workflow cannot be edited.',
        parameters: {
            goal: { type: 'string', description: 'Optional replacement for the workflow goal.' },
            timeoutMs: { type: 'number', description: 'Optional replacement for the workflow-wide step timeout in ms (a step that fails to report within this budget is failed and the pipeline stops).' },
            eureka: { type: 'boolean', description: 'Optional "Eureka" mode flag: when true, running step agents may self-adjust still-pending future steps (add/remove/refine) as they discover new viewpoints.' },
            maxStageCount: { type: 'number', description: 'Optional hard cap on the total number of execution stages (0 removes the cap; default 0 = unlimited or the plugin config).' },
            steps: {
                type: 'array',
                description: 'Optional step edits, keyed by step id (e.g. s1). Only the fields you provide are changed; omit a field to leave it as-is.',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', required: true, description: 'The step id to edit (e.g. s1, s2).' },
                        title: { type: 'string', description: 'Replacement title.' },
                        target: { type: 'string', description: 'Replacement target.' },
                        context: { type: 'string', description: 'Replacement context (empty string clears it).' },
                        stage: { type: 'string', description: 'Replacement stage (empty string clears it, making the step sequential).' },
                    },
                },
            },
            addSteps: {
                type: 'array',
                description: 'Optional new step definitions to append to the workflow. Each must have a title and target; stage is optional (omit for sequential).',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        title: { type: 'string', required: true, description: 'New step title.' },
                        target: { type: 'string', required: true, description: 'What the new step should research/analyze and produce.' },
                        context: { type: 'string', description: 'Optional extra guidance for the new step.' },
                        stage: { type: 'string', description: 'Optional execution stage for the new step.' },
                    },
                },
            },
            removeStepIds: {
                type: 'array',
                description: 'Optional step ids to remove from the workflow (e.g. ["s2"]). Only valid while staged.',
                items: { type: 'string' },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    steps: { type: 'number', required: true },
                    updated_steps: { type: 'array', items: { type: 'string' }, required: true },
                    added_steps: { type: 'array', items: { type: 'string' }, required: true },
                    removed_steps: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: `Workflow "${value.name}" updated (${value.updated_steps.length} changed, ${value.added_steps.length} added, ${value.removed_steps.length} removed).` }],
        },
        async execute(args, exec) {
            const captain = requireAgent(exec);
            const workflow = await load(captain);
            if (workflow === undefined)
                throw new Error('no mobius workflow for this captain — call mobius_create or mobius_import first');
            const patch = {
                ...args.goal !== undefined ? { goal: args.goal } : {},
                ...typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {},
                ...typeof args.eureka === 'boolean' ? { eureka: args.eureka } : {},
                ...typeof args.maxStageCount === 'number' ? { maxStageCount: args.maxStageCount } : {},
                ...Array.isArray(args.steps) && args.steps.length > 0
                    ? { steps: args.steps }
                    : {},
                ...Array.isArray(args.addSteps) && args.addSteps.length > 0
                    ? { addSteps: args.addSteps }
                    : {},
                ...Array.isArray(args.removeStepIds) && args.removeStepIds.length > 0
                    ? { removeStepIds: args.removeStepIds }
                    : {},
            };
            const result = await updateStagedWorkflow(captain, workflow.id, patch);
            return {
                workflow_id: result.workflowId,
                name: result.name,
                steps: result.steps,
                updated_steps: result.updatedSteps,
                added_steps: result.addedSteps,
                removed_steps: result.removedSteps,
            };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_discover',
        description: 'Eureka mode: while a workflow is RUNNING with eureka enabled, a step agent may self-adjust the workflow after discovering new viewpoints. Add, remove, or refine still-PENDING (not-yet-started) future steps. Never touches running or completed steps; changes auto-apply on the next stage advance.',
        parameters: {
            addSteps: {
                type: 'array',
                description: 'Optional new future steps to append. Each needs title + target; stage is optional (omit for sequential).',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        title: { type: 'string', required: true, description: 'New step title.' },
                        target: { type: 'string', required: true, description: 'What the new step should research/analyze and produce.' },
                        context: { type: 'string', description: 'Optional extra guidance.' },
                        stage: { type: 'string', description: 'Optional execution stage for the new step.' },
                    },
                },
            },
            removeStepIds: {
                type: 'array',
                description: 'Optional step ids to remove — only steps that are still pending (not yet started).',
                items: { type: 'string' },
            },
            editSteps: {
                type: 'array',
                description: 'Optional content edits to still-pending steps, keyed by step id. Only pending steps may be edited.',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', required: true, description: 'The pending step id to edit (e.g. s3).' },
                        title: { type: 'string', description: 'Replacement title.' },
                        target: { type: 'string', description: 'Replacement target.' },
                        context: { type: 'string', description: 'Replacement context (empty clears it).' },
                        stage: { type: 'string', description: 'Replacement stage (empty clears it).' },
                    },
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    steps: { type: 'number', required: true },
                    added: { type: 'array', items: { type: 'string' }, required: true },
                    removed: { type: 'array', items: { type: 'string' }, required: true },
                    edited: { type: 'array', items: { type: 'string' }, required: true },
                    message: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        async execute(args, exec) {
            const caller = requireAgent(exec);
            const stateRoot = join(workspaceOf(caller), config.stateDir);
            let ownerCaptain;
            let workflowId = '';
            let workflowName = '';
            let stepsBefore = 0;
            // The stage grouping key of the discoverer's OWN running step. New nodes
            // added without an explicit stage join THIS stage as sibling nodes
            // ("自行添加当前阶段的 node"). Refining a future/other stage's nodes is
            // done via editSteps, which already works on any pending node.
            let ownStageKey = '';
            // Locate the running eureka workflow whose running step owns this caller.
            const store = await readWorkflows(stateRoot);
            for (const candidate of Object.values(store)) {
                if (candidate.eureka !== true || candidate.phase !== 'running')
                    continue;
                const own = candidate.steps.find((s) => s.assigneeId === caller.id && s.status === 'running');
                if (own === undefined)
                    continue;
                const captain = ctx.agents.get(candidate.captainSessionId);
                if (captain === undefined)
                    continue;
                ownerCaptain = captain;
                workflowId = candidate.id;
                workflowName = candidate.name;
                stepsBefore = candidate.steps.length;
                ownStageKey = stageIdOf(candidate, own);
                break;
            }
            if (ownerCaptain === undefined || workflowId === '') {
                throw new Error('mobius_discover is only usable by a step agent of a RUNNING workflow with eureka mode enabled');
            }
            const added = [];
            const removed = [];
            const edited = [];
            await withTeamLock(`mobius:${ownerCaptain.id}`, async () => {
                const fresh = await load(ownerCaptain);
                if (fresh === undefined || fresh.id !== workflowId || fresh.eureka !== true) {
                    throw new Error('workflow is no longer running or eureka was disabled');
                }
                // Edits must target only pending steps.
                const editOps = args.editSteps ?? [];
                if (!Array.isArray(editOps))
                    throw new Error('editSteps must be an array when provided');
                for (const op of editOps) {
                    if (typeof op.id !== 'string' || op.id.trim() === '')
                        throw new Error('each edit needs a non-empty step id');
                    const id = op.id.trim();
                    const step = fresh.steps.find((s) => s.id === id);
                    if (step === undefined)
                        throw new Error(`no step with id "${id}" in this workflow`);
                    if (step.status !== 'pending')
                        throw new Error(`step ${id} is ${step.status}, not pending — eureka can only edit future steps`);
                    if (op.title !== undefined) {
                        if (typeof op.title !== 'string' || op.title.trim() === '')
                            throw new Error(`step ${id}: title must be non-empty`);
                        step.title = op.title.trim();
                    }
                    if (op.target !== undefined) {
                        if (typeof op.target !== 'string' || op.target.trim() === '')
                            throw new Error(`step ${id}: target must be non-empty`);
                        step.target = op.target.trim();
                    }
                    if (op.context !== undefined) {
                        if (typeof op.context !== 'string')
                            throw new Error(`step ${id}: context must be a string`);
                        const trimmed = op.context.trim();
                        if (trimmed === '')
                            delete step.context;
                        else
                            step.context = trimmed;
                    }
                    if (op.stage !== undefined) {
                        if (typeof op.stage !== 'string')
                            throw new Error(`step ${id}: stage must be a string`);
                        const trimmed = op.stage.trim();
                        if (trimmed === '')
                            delete step.stage;
                        else
                            step.stage = trimmed;
                    }
                    step.updatedAt = Date.now();
                    edited.push(id);
                }
                // Remove only pending steps.
                const removeIds = args.removeStepIds ?? [];
                if (!Array.isArray(removeIds))
                    throw new Error('removeStepIds must be an array when provided');
                for (const rawId of removeIds) {
                    if (typeof rawId !== 'string' || rawId.trim() === '')
                        continue;
                    const id = rawId.trim();
                    const step = fresh.steps.find((s) => s.id === id);
                    if (step === undefined)
                        continue;
                    if (step.status !== 'pending')
                        throw new Error(`step ${id} is ${step.status}, not pending — eureka can only remove future steps`);
                    const index = fresh.steps.findIndex((s) => s.id === id);
                    fresh.steps.splice(index, 1);
                    removed.push(id);
                }
                // Append new pending steps (unique ids).
                const adds = args.addSteps ?? [];
                if (!Array.isArray(adds))
                    throw new Error('addSteps must be an array when provided');
                if (adds.length > 0) {
                    const taken = new Set(fresh.steps.map((s) => s.id));
                    let serial = fresh.steps.length + 1;
                    const nextId = () => {
                        let id = `s${serial}`;
                        while (taken.has(id)) {
                            serial += 1;
                            id = `s${serial}`;
                        }
                        serial += 1;
                        taken.add(id);
                        return id;
                    };
                    const now = Date.now();
                    for (const add of adds) {
                        if (typeof add.title !== 'string' || add.title.trim() === '')
                            throw new Error('added step needs a non-empty title');
                        if (typeof add.target !== 'string' || add.target.trim() === '')
                            throw new Error('added step needs a non-empty target');
                        const id = nextId();
                        // When the discoverer does not pick a stage, join the discoverer's
                        // OWN stage so the new node appears as a sibling node in the current
                        // stage block instead of a fresh sequential stage.
                        const addStage = typeof add.stage === 'string' && add.stage.trim() !== '' ? add.stage.trim() : ownStageKey;
                        fresh.steps.push({
                            id,
                            title: add.title.trim(),
                            target: add.target.trim(),
                            ...typeof add.context === 'string' && add.context.trim() !== '' ? { context: add.context.trim() } : {},
                            ...addStage !== '' ? { stage: addStage } : {},
                            status: 'pending',
                            createdAt: now,
                            updatedAt: now,
                        });
                        added.push(id);
                    }
                }
                fresh.updatedAt = Date.now();
                const cap = effectiveMaxStageCount(fresh, config.maxStageCount);
                if (cap > 0 && stageCount(fresh) > cap) {
                    throw new Error(`eureka discovery would push the workflow to ${stageCount(fresh)} stages, exceeding the max of ${cap} — reuse an existing stage or do not add a new one`);
                }
                await save(ownerCaptain, fresh);
            });
            const parts = [
                added.length > 0 ? `新增 ${added.join(', ')}` : '',
                removed.length > 0 ? `删除 ${removed.join(', ')}` : '',
                edited.length > 0 ? `调整 ${edited.join(', ')}` : '',
            ].filter(Boolean);
            const message = `尤里卡：已${parts.join('；') || '未做变更'}，后续流水线将自动采用。`;
            return {
                workflow_id: workflowId,
                steps: stepsBefore,
                added,
                removed,
                edited,
                message,
            };
        },
    }));
    registerTool(defineTool({
        name: 'mobius_finalize',
        description: 'Consolidate the completed workflow into a final conclusion. Retires all step members.',
        parameters: {
            conclusion: { type: 'string', required: true, description: 'The consolidated final conclusion/report.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    workflow_id: { type: 'string', required: true },
                    steps: { type: 'number', required: true },
                    conclusion: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: `Workflow ${value.workflow_id} finalized (${value.steps} steps).\n${value.conclusion}` }],
        },
        async execute(args, exec) {
            const captain = requireAgent(exec);
            const stateRoot = join(workspaceOf(captain), config.stateDir);
            const workflow = await load(captain);
            if (workflow === undefined)
                throw new Error('no mobius workflow for this captain — call mobius_create first');
            const maxRounds = config.maxReviewRounds ?? 2;
            const members = workflow.steps.map((s) => s.assigneeId).filter((id) => id !== undefined && id !== '');
            await recordRetiredMemberIds(stateRoot, members);
            for (const id of members)
                interruptMember(ctx, captain, id);
            clearWorkflowAllTimeouts(captain.id, workflow.id);
            // Persist the (possibly rewritten) conclusion and start a fresh review round.
            const round = (workflow.review?.round ?? 0) + 1;
            workflow.review = { status: 'awaiting_review', findings: '', round };
            workflow.phase = 'running';
            workflow.updatedAt = Date.now();
            workflow.conclusion = args.conclusion;
            await save(captain, workflow);
            // Independent review: spawn a reviewer that judges the latest conclusion.
            const llmSelection = await resolveMemberLlmSelection(ctx, captain, {
                defaultModel: config.memberModel,
                fallback: config.fallback,
            });
            const reviewerId = await spawnReviewer(ctx, config, selections, captain, workflow, llmSelection);
            const reviewerPrompt = [
                `# Mobius review — ${workflow.name}`,
                '',
                `## Goal`,
                workflow.goal,
                '',
                '## Step outputs',
                ...completedOutputs(workflow),
                '',
                '## Submitted conclusion',
                args.conclusion,
                '',
                'Judge the conclusion against the goal and step outputs. Call mobius_review_verdict with "pass" or "needs_revision" (with concrete findings when bouncing).',
            ].join('\n');
            await deliverToMember(ctx, captain, reviewerId, reviewerPrompt, new AbortController().signal);
            const reviewerChild = ctx.agents.get(reviewerId);
            if (reviewerChild !== undefined)
                await reviewerChild.whenIdle();
            // Read the recorded verdict.
            let verdict;
            let findings = '';
            let currentRound = round;
            await withTeamLock(`mobius:${captain.id}`, async () => {
                const fresh = await load(captain);
                if (fresh?.review === undefined)
                    return;
                verdict = fresh.review.status;
                findings = fresh.review.findings;
                currentRound = fresh.review.round;
            });
            if (verdict === 'passed') {
                // Review cleared: real finalization.
                await withTeamLock(`mobius:${captain.id}`, async () => {
                    const fresh = await load(captain);
                    if (fresh === undefined)
                        return;
                    fresh.phase = 'done';
                    fresh.updatedAt = Date.now();
                    await save(captain, fresh);
                });
                steerCaptainReport(captain, 'Mobius', `最终结论审核通过，研究工作流「${workflow.name}」已完成。`);
                return { workflow_id: workflow.id, steps: workflow.steps.length, conclusion: args.conclusion };
            }
            // needs_revision
            if (currentRound <= maxRounds) {
                // Bounce back to the captain to rewrite, then they call finalize again.
                const message = [
                    `最终结论第 ${currentRound} 轮审核未通过。请针对以下审核意见重写最终结论，然后再次调用 mobius_finalize 提交新结论。`,
                    '',
                    `审核意见：`,
                    findings,
                ].join('\n');
                try {
                    captain.followup(createUserMessage({
                        content: [{ type: 'text', text: message }],
                        source: { kind: 'plugin', plugin: 'dsh-dai-mobius' },
                    }));
                }
                catch (error) {
                    ctx.logger.warn(`dsh-mobius: failed to inject review feedback: ${String(error)}`);
                }
                steerCaptainReport(captain, 'Mobius', `最终结论第 ${currentRound} 轮审核未通过，已请 captain 重写后重新提交。`);
                return { workflow_id: workflow.id, steps: workflow.steps.length, conclusion: args.conclusion };
            }
            // Exceeded the retry cap.
            await withTeamLock(`mobius:${captain.id}`, async () => {
                const fresh = await load(captain);
                if (fresh === undefined)
                    return;
                fresh.review = { status: 'needs_revision', findings, round: currentRound };
                fresh.updatedAt = Date.now();
                await save(captain, fresh);
            });
            steerCaptainReport(captain, 'Mobius', `最终结论已达审核上限（${maxRounds} 轮）仍未通过，需人工处理。审核意见：${findings}`);
            return { workflow_id: workflow.id, steps: workflow.steps.length, conclusion: args.conclusion };
        },
    }));
    // ── Web plan actions (approve / continue / discard / update), mirroring agent-teams ──
    /** "编辑": mutate a STAGED workflow's goal and/or step fields, then persist. */
    const updateStagedWorkflow = async (captain, workflowId, patch) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const updatedSteps = [];
        const addedSteps = [];
        const removedSteps = [];
        await withTeamLock(`mobius:${captain.id}`, async () => {
            const workflow = await load(captain);
            if (workflow === undefined || workflow.id !== workflowId) {
                throw new Error(`no staged mobius workflow "${workflowId}" for this captain`);
            }
            if (workflow.phase !== 'staged') {
                throw new Error(`cannot edit a workflow in phase "${workflow.phase}" — only staged plans can be edited`);
            }
            if (patch.goal !== undefined) {
                if (typeof patch.goal !== 'string' || patch.goal.trim() === '')
                    throw new Error('goal must be a non-empty string when provided');
                workflow.goal = patch.goal.trim();
            }
            if (patch.timeoutMs !== undefined) {
                if (typeof patch.timeoutMs !== 'number' || !Number.isFinite(patch.timeoutMs) || patch.timeoutMs <= 0) {
                    throw new Error('timeoutMs must be a positive number when provided');
                }
                workflow.timeoutMs = patch.timeoutMs;
            }
            if (patch.eureka !== undefined) {
                if (typeof patch.eureka !== 'boolean')
                    throw new Error('eureka must be a boolean when provided');
                if (patch.eureka)
                    workflow.eureka = true;
                else
                    delete workflow.eureka;
            }
            if (patch.disableWebSearch !== undefined) {
                if (typeof patch.disableWebSearch !== 'boolean')
                    throw new Error('disableWebSearch must be a boolean when provided');
                if (patch.disableWebSearch)
                    workflow.disableWebSearch = true;
                else
                    delete workflow.disableWebSearch;
            }
            if (patch.maxStageCount !== undefined) {
                if (typeof patch.maxStageCount !== 'number' || !Number.isFinite(patch.maxStageCount) || patch.maxStageCount < 0) {
                    throw new Error('maxStageCount must be a non-negative number when provided');
                }
                if (patch.maxStageCount > 0)
                    workflow.maxStageCount = patch.maxStageCount;
                else
                    delete workflow.maxStageCount;
            }
            if (patch.stageTitles !== undefined) {
                const titles = {};
                for (const [key, value] of Object.entries(patch.stageTitles)) {
                    if (typeof value === 'string' && value.trim() !== '')
                        titles[key] = value.trim();
                }
                if (Object.keys(titles).length > 0)
                    workflow.stageTitles = titles;
                else
                    delete workflow.stageTitles;
            }
            const edits = patch.steps ?? [];
            if (!Array.isArray(edits))
                throw new Error('steps must be an array when provided');
            for (const edit of edits) {
                if (typeof edit.id !== 'string' || edit.id.trim() === '')
                    throw new Error('each step edit needs a non-empty id');
                const id = edit.id.trim();
                const step = workflow.steps.find((s) => s.id === id);
                if (step === undefined)
                    throw new Error(`no step with id "${id}" in this workflow`);
                if (edit.title !== undefined) {
                    if (typeof edit.title !== 'string' || edit.title.trim() === '')
                        throw new Error(`step ${id}: title must be a non-empty string`);
                    step.title = edit.title.trim();
                }
                if (edit.target !== undefined) {
                    if (typeof edit.target !== 'string' || edit.target.trim() === '')
                        throw new Error(`step ${id}: target must be a non-empty string`);
                    step.target = edit.target.trim();
                }
                if (edit.context !== undefined) {
                    if (typeof edit.context !== 'string')
                        throw new Error(`step ${id}: context must be a string`);
                    const trimmed = edit.context.trim();
                    if (trimmed === '')
                        delete step.context;
                    else
                        step.context = trimmed;
                }
                if (edit.stage !== undefined) {
                    if (typeof edit.stage !== 'string')
                        throw new Error(`step ${id}: stage must be a string`);
                    const trimmed = edit.stage.trim();
                    if (trimmed === '')
                        delete step.stage;
                    else
                        step.stage = trimmed;
                }
                step.updatedAt = Date.now();
                updatedSteps.push(id);
            }
            // Remove steps first (so appended ids don't collide with removed ones).
            const removeIds = patch.removeStepIds ?? [];
            if (!Array.isArray(removeIds))
                throw new Error('removeStepIds must be an array when provided');
            for (const rawId of removeIds) {
                if (typeof rawId !== 'string' || rawId.trim() === '')
                    continue;
                const id = rawId.trim();
                const index = workflow.steps.findIndex((s) => s.id === id);
                if (index < 0)
                    continue;
                workflow.steps.splice(index, 1);
                removedSteps.push(id);
            }
            // Append new steps.
            const adds = patch.addSteps ?? [];
            if (!Array.isArray(adds))
                throw new Error('addSteps must be an array when provided');
            if (adds.length > 0) {
                // Re-derive guaranteed-unique ids after removal.
                const taken = new Set(workflow.steps.map((s) => s.id));
                let serial = workflow.steps.length + 1;
                const nextId = () => {
                    let id = `s${serial}`;
                    while (taken.has(id)) {
                        serial += 1;
                        id = `s${serial}`;
                    }
                    serial += 1;
                    taken.add(id);
                    return id;
                };
                const now = Date.now();
                for (const add of adds) {
                    if (typeof add.title !== 'string' || add.title.trim() === '')
                        throw new Error('added step needs a non-empty title');
                    if (typeof add.target !== 'string' || add.target.trim() === '')
                        throw new Error('added step needs a non-empty target');
                    const id = nextId();
                    workflow.steps.push({
                        id,
                        title: add.title.trim(),
                        target: add.target.trim(),
                        ...typeof add.context === 'string' && add.context.trim() !== '' ? { context: add.context.trim() } : {},
                        ...typeof add.stage === 'string' && add.stage.trim() !== '' ? { stage: add.stage.trim() } : {},
                        status: 'pending',
                        createdAt: now,
                        updatedAt: now,
                    });
                    addedSteps.push(id);
                }
            }
            workflow.updatedAt = Date.now();
            const cap = effectiveMaxStageCount(workflow, config.maxStageCount);
            if (cap > 0 && stageCount(workflow) > cap) {
                throw new Error(`edited workflow would have ${stageCount(workflow)} stages, exceeding the max of ${cap}`);
            }
            await save(captain, workflow);
        });
        const fresh = await load(captain);
        return {
            workflowId,
            name: fresh?.name ?? '',
            steps: fresh?.steps.length ?? 0,
            updatedSteps,
            addedSteps,
            removedSteps,
        };
    };
    /** "启动": approve a staged plan into running and dispatch the first stage (all its steps). */
    const approveStagedWorkflow = async (captain, workflowId) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        return withTeamLock(`mobius:${captain.id}`, async () => {
            const workflow = await load(captain);
            if (workflow === undefined || workflow.id !== workflowId) {
                throw new Error(`no staged mobius workflow "${workflowId}" for this captain`);
            }
            if (workflow.phase !== 'staged')
                throw new Error(`workflow "${workflow.name}" is ${workflow.phase}, not staged`);
            const first = workflow.steps[0];
            if (first === undefined)
                throw new Error('workflow has no steps');
            // The panel「启动」button is the ONLY sanctioned approval path: record the
            // user's explicit approval so mobius_start (locked) and this path agree.
            workflow.approvedByUser = true;
            workflow.phase = 'running';
            delete workflow.planReviewState;
            workflow.updatedAt = Date.now();
            await save(captain, workflow);
            // Dispatch the first stage AFTER persisting running so a crash leaves a
            // consistent resumable run.
            const dispatched = await dispatchCurrentStage(captain, workflow);
            const label = dispatched.length > 1
                ? `${first.id}（${first.title}）等 ${dispatched.length} 个并行步骤`
                : `${first.id}（${first.title}）`;
            steerCaptainReport(captain, 'Mobius', `研究工作流「${workflow.name}」已启动，第 1 阶段 ${label} 开始执行。`);
            return { teamId: workflow.id, steps: workflow.steps.length };
        });
    };
    /** "返回对话重新规划": park the staged plan as awaiting_feedback and return control to the captain. */
    const continueStagedPlanning = async (captain, workflowId) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const prepared = await withTeamLock(`mobius:${captain.id}`, async () => {
            const workflow = await load(captain);
            if (workflow === undefined || workflow.id !== workflowId) {
                throw new Error(`no staged mobius workflow "${workflowId}" for this captain`);
            }
            if (workflow.phase !== 'staged')
                throw new Error(`workflow "${workflow.name}" is ${workflow.phase}, not staged`);
            if (workflow.planReviewState === 'awaiting_feedback') {
                return { alreadyWaiting: true, name: workflow.name };
            }
            workflow.planReviewState = 'awaiting_feedback';
            workflow.updatedAt = Date.now();
            await save(captain, workflow);
            return { alreadyWaiting: false, name: workflow.name };
        });
        if (prepared.alreadyWaiting)
            return { workflowId, alreadyWaiting: true };
        // End any planning turn still producing tool calls, then wake the captain
        // in chat to ask what to revise (mirrors agent-teams' continue).
        captain.cancel({ kind: 'user' }, { keepInbox: true });
        try {
            captain.followup(createUserMessage({
                content: [{ type: 'text', text: stagedPlanFeedbackContext(prepared.name) }],
                source: { kind: 'plugin', plugin: 'dsh-dai-mobius' },
            }));
        }
        catch (error) {
            // Do not leave the durable UI in a false waiting state when the live
            // Captain disappeared between lookup and delivery.
            await withTeamLock(`mobius:${captain.id}`, async () => {
                const fresh = await load(captain);
                if (fresh?.id === workflowId && fresh.planReviewState === 'awaiting_feedback') {
                    fresh.planReviewState = 'awaiting_review';
                    fresh.updatedAt = Date.now();
                    await save(captain, fresh);
                }
            });
            throw error;
        }
        return { workflowId, alreadyWaiting: false };
    };
    /** "Discard": archive a staged plan so it can never run, releasing the captain. */
    const discardStagedWorkflow = async (captain, workflowId) => {
        const stateRoot = join(workspaceOf(captain), config.stateDir);
        const discarded = await withTeamLock(`mobius:${captain.id}`, async () => {
            const workflow = await load(captain);
            if (workflow === undefined || workflow.id !== workflowId) {
                throw new Error(`no staged mobius workflow "${workflowId}" for this captain`);
            }
            if (workflow.phase === 'staged') {
                await removeWorkflow(stateRoot, captain.id, workflowId);
            }
            return { workflowId: workflow.id, name: workflow.name };
        });
        // Preserve this control fact for the next genuine user turn, then abort the
        // still-running Captain turn so a late model step cannot recreate it.
        try {
            captain.inject(createUserMessage({
                content: [{ type: 'text', text: stagedPlanDiscardContext(discarded.name) }],
                source: { kind: 'plugin', plugin: 'dsh-dai-mobius' },
            }));
        }
        catch (error) {
            ctx.logger.warn(`dsh-mobius: failed to inject discard context for "${discarded.workflowId}": ${String(error)}`);
        }
        captain.cancel({ kind: 'user' }, { keepInbox: true });
        return { workflowId: discarded.workflowId, name: discarded.name };
    };
    return { approveStagedWorkflow, continueStagedPlanning, discardStagedWorkflow, updateStagedWorkflow };
}
