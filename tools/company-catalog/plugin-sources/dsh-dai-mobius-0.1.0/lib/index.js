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
import z from '@deepseek-ai/schemastery';
import { installMobius, collectMobiusWorkflows, haltMobiusWorkflow, readWorkflows, serializeMobiusTemplateJson } from "./mobius.js";
import { registerMobiusCommand } from "./mobius-command.js";
import { join } from 'node:path';
import { authenticatedWebRoutes, readJsonRequest, RequestBodyError, } from "./web-routes.js";
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'];
/** Narrow guard: is `value` a plain (non-array) object? */
function isPlainRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const name = 'dsh-dai-mobius';
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'];
// `z.object()` has an implicit `{}` default in Schemastery.  Fallback routes
// are optional, so model absence explicitly; otherwise a missing route is
// validated as an empty object and fails on the required provider/model keys.
const fallbackRouteConfig = z.union([
    z.object({ provider: z.string().required(), model: z.string().required() }),
    z.const(undefined),
]);
export const Config = z.object({
    stateDir: z.string().default('.agent-teams'),
    memberProvider: z.string().default('spawn'),
    memberModel: z.string(),
    executionPrompt: z.string(),
    fallback: fallbackRouteConfig,
    memberMaxDepth: z.natural().default(1),
    maxMembers: z.natural().min(1).default(8),
    maxStepRetries: z.natural().default(1),
    maxReviewRounds: z.natural().default(2),
    timeoutMs: z.natural().min(1),
    stepSearchLimit: z.natural().min(0).default(3),
    maxStageCount: z.natural().min(0).default(0),
    slashCommand: z.boolean().default(true),
    promptSectionOrder: z.natural().default(117),
});
/** The model-facing usage policy for the Mobius sequential workflow. */
export function mobiusUsageSectionText() {
    return `When the user asks to research, analyze, or investigate a topic (e.g. "我要研究 xxx", "研究一下 xxx", "帮我分析 xxx"), you run a Mobius sequential workflow. Follow this protocol:
1. Call mobius_create with a short name, the user's goal, and an ordered list of steps. Each step runs as ONE dedicated subagent, and the result of every earlier step is handed to each later step. Plan genuinely sequential work: gathering → analysis → synthesis → conclusion. Keep the step list lean (usually 3-6 steps).
2. Optional parallelism: steps that can run independently may share a "stage" field (e.g. stage: "research") — all steps in the same stage run concurrently as parallel subagents, and stages run serially. Steps without a stage run sequentially, each feeding the next.
2b. 尤里卡模式（Eureka mode）默认始终关闭。除非用户明确要求开启，否则一律不要设置 eureka:true —— 不要因为觉得研究"开放"或"有创意"就擅自开启。仅当用户明确表示想要研究能自我调整、自动补充/重构后续步骤时才开启。开启后，运行中的步骤 agent 会主动新增/删除/修改仍处于"未开始"的后续步骤；它永不会改动已完成或正在运行的步骤。
3. 创建计划后立即停下，把分阶段计划展示给用户，并明确请用户点击面板的「启动」按钮确认。**你绝对不要调用 mobius_start** —— 该工具已锁定，没有用户点击「启动」按钮（approvedByUser=true）会拒绝执行。只有用户按了按钮，工作流才会开始。
4. The pipeline is automatic: each step's subagent calls mobius_done when finished, and the workflow advances to the next step/stage with all prior results. Do not reinvent or duplicate this orchestration — just monitor with mobius_status.
5. When every step is done (mobius_status shows phase "done"), consolidate the per-step outputs into a final conclusion and call mobius_finalize with it. An independent reviewer subagent judges the conclusion: if it bounces back (needs_revision), the findings are returned to you — rewrite the conclusion addressing them and call mobius_finalize again. This repeats up to the review-round cap (default 2) before giving up and asking for human help.
6. Workflow reuse: call mobius_export to get the workflow as a reusable JSON template, or mobius_import to load a template as a fresh staged plan (replaces any existing staged plan). You may also export from the activity panel's per-card download button.
7. Present the final conclusion to the user.`;
}
export function apply(ctx, config) {
    const resolved = {
        stateDir: config.stateDir ?? '.agent-teams',
        memberProvider: config.memberProvider ?? 'spawn',
        memberModel: config.memberModel,
        executionPrompt: config.executionPrompt,
        fallback: config.fallback,
        memberMaxDepth: config.memberMaxDepth ?? 1,
        maxMembers: config.maxMembers ?? 8,
        maxStepRetries: config.maxStepRetries ?? 1,
        maxReviewRounds: config.maxReviewRounds ?? 2,
        timeoutMs: config.timeoutMs,
        stepSearchLimit: config.stepSearchLimit ?? 3,
    };
    // Provider registration is a sibling plugin's effect (`subagent-spawn` /
    // `subagent-fork` rows), which can land after this mount under the Loader's
    // concurrent activation — so capability validation happens at the first step
    // spawn (`spawnStepAgent`), the earliest point the provider list is settled,
    // rather than here.
    const mobiusRuntime = installMobius(ctx, resolved);
    ctx.systemPrompt.section({
        name: 'mobius:usage',
        order: config.promptSectionOrder ?? 117,
        text: () => mobiusUsageSectionText(),
    });
    // The `/mobius` slash command is registered lazily against the `commands`
    // service (not a required inject): it ships in the base bundle of every
    // standard profile, but a minimal composition that omits the command
    // registry keeps the plugin fully functional — it simply never gains the
    // slash command.
    if (config.slashCommand ?? true) {
        ctx.inject(['commands'], (commandCtx) => {
            registerMobiusCommand(commandCtx);
        });
    }
    // The activity-panel data route needs the Web server and the workspace
    // registry, which headless profiles do not mount; under concurrent
    // activation they may also bind after this plugin. Register the route
    // lazily: try now, then on each service binding event. In a webless
    // profile the plugin stays tool-only and never blocks boot.
    let webRegistered = false;
    const registerWebSurface = () => {
        if (webRegistered)
            return;
        const rawWebServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]));
        const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1]));
        if (rawWebServer === undefined || workspaceRegistry === undefined)
            return;
        const webServer = authenticatedWebRoutes(rawWebServer, () => ctx.get('connection'));
        webRegistered = true;
        // Mobius workflow snapshot route for the activity panel: all workflows on
        // disk (steps, status, outputs, phase), scoped to the workspace roots.
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-mobius/mobius',
            handler: async (_req, res) => {
                const roots = workspaceRegistry.list().map((workspace) => (join(workspace.path, resolved.stateDir)));
                const workflows = (await Promise.all(roots.map(collectMobiusWorkflows))).flat();
                const body = JSON.stringify({ workflows });
                res.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                });
                res.end(body);
            },
        }), 'dsh-mobius: workflow route');
        // Interrupt route for the conversation card's stop button: abort the
        // running workflow's step members and mark it done. Mirrors the
        // agent-teams halt route so the card can stop a workflow from the chat.
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-mobius/halt',
            handler: async (req, res) => {
                if (req.method !== 'POST') {
                    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
                    res.end();
                    return;
                }
                let payload;
                try {
                    payload = await readJsonRequest(req);
                }
                catch (error) {
                    res.writeHead(error instanceof RequestBodyError ? error.status : 400, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }));
                    return;
                }
                const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
                const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId.trim() : '';
                if (sessionId === '' || workflowId === '') {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'sessionId and workflowId are required' }));
                    return;
                }
                // Resolve this workflow's workspace through the captain session.
                const captain = ctx.agents?.get(sessionId);
                if (captain === undefined) {
                    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'captain session is not attached' }));
                    return;
                }
                const workspace = captain.session.header.cwd ?? process.cwd();
                const stateRoot = join(workspace, resolved.stateDir);
                try {
                    const result = await haltMobiusWorkflow({ ctx, stateRoot, workflowId, captain });
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify(result));
                }
                catch (error) {
                    ctx.logger.warn(`dsh-mobius: halt failed for ${workflowId}: ${String(error)}`);
                    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'failed to stop the mobius workflow' }));
                }
            },
        }), 'dsh-mobius: halt route');
        // Export route for the panel's per-card download button: serialize the
        // workflow as a reusable JSON template and serve it as a file download.
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-mobius/export',
            handler: async (req, res) => {
                const url = new URL(req.url ?? '/', 'http://localhost');
                const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
                const workflowId = (url.searchParams.get('workflowId') ?? '').trim();
                if (sessionId === '' || workflowId === '') {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'sessionId and workflowId are required' }));
                    return;
                }
                const captain = ctx.agents?.get(sessionId);
                if (captain === undefined) {
                    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'captain session is not attached' }));
                    return;
                }
                const workspace = captain.session.header.cwd ?? process.cwd();
                const stateRoot = join(workspace, resolved.stateDir);
                try {
                    const store = await readWorkflows(stateRoot);
                    const workflow = store[sessionId];
                    if (workflow === undefined || workflow.id !== workflowId) {
                        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ error: `no mobius workflow "${workflowId}" for session` }));
                        return;
                    }
                    const body = serializeMobiusTemplateJson(workflow);
                    const filename = `${workflow.id.replace(/[^\w.-]+/g, '_')}.mobius.json`;
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'content-disposition': `attachment; filename="${filename}"`,
                        'cache-control': 'no-store',
                    });
                    res.end(body);
                }
                catch (error) {
                    ctx.logger.warn(`dsh-mobius: export failed for ${workflowId}: ${String(error)}`);
                    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'failed to export the mobius workflow' }));
                }
            },
        }), 'dsh-mobius: export route');
        // Staged-plan review route for the panel's three buttons: approve (start),
        // continue (return to chat to re-plan), and discard. Mirrors the
        // agent-teams plan route's approve/continue/discard surface.
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-mobius/plan',
            handler: async (req, res) => {
                if (req.method !== 'POST') {
                    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' });
                    res.end();
                    return;
                }
                let payload;
                try {
                    payload = await readJsonRequest(req);
                }
                catch (error) {
                    res.writeHead(error instanceof RequestBodyError ? error.status : 400, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'invalid request body' }));
                    return;
                }
                const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
                const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId.trim() : '';
                const action = typeof payload.action === 'string' ? payload.action : '';
                if (sessionId === '' || workflowId === '' || action === '') {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'sessionId, workflowId, and action are required' }));
                    return;
                }
                const captain = ctx.agents?.get(sessionId);
                if (captain === undefined) {
                    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'captain session is not attached' }));
                    return;
                }
                try {
                    if (action === 'approve') {
                        const approved = await mobiusRuntime.approveStagedWorkflow(captain, workflowId);
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ ok: true, phase: 'running', ...approved }));
                        return;
                    }
                    if (action === 'continue') {
                        const continued = await mobiusRuntime.continueStagedPlanning(captain, workflowId);
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ ok: true, phase: 'staged', review: 'awaiting_feedback', ...continued }));
                        return;
                    }
                    if (action === 'discard') {
                        const discarded = await mobiusRuntime.discardStagedWorkflow(captain, workflowId);
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ ok: true, phase: 'archived', ...discarded }));
                        return;
                    }
                    if (action === 'update') {
                        const goal = typeof payload.goal === 'string' ? payload.goal : undefined;
                        const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : undefined;
                        const eureka = typeof payload.eureka === 'boolean' ? payload.eureka : undefined;
                        const disableWebSearch = typeof payload.disableWebSearch === 'boolean' ? payload.disableWebSearch : undefined;
                        const maxStageCount = typeof payload.maxStageCount === 'number' ? payload.maxStageCount : undefined;
                        const stageTitles = isPlainRecord(payload.stageTitles)
                            ? payload.stageTitles
                            : undefined;
                        const steps = Array.isArray(payload.steps)
                            ? payload.steps
                            : undefined;
                        const addSteps = Array.isArray(payload.addSteps)
                            ? payload.addSteps
                            : undefined;
                        const removeStepIds = Array.isArray(payload.removeStepIds)
                            ? payload.removeStepIds
                            : undefined;
                        const updated = await mobiusRuntime.updateStagedWorkflow(captain, workflowId, { goal, timeoutMs, eureka, disableWebSearch, maxStageCount, stageTitles, steps, addSteps, removeStepIds });
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ ok: true, ...updated }));
                        return;
                    }
                    throw new Error(`unknown plan action "${action}"`);
                }
                catch (error) {
                    ctx.logger.warn(`dsh-mobius: plan "${action}" failed for ${workflowId}: ${String(error)}`);
                    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'plan operation failed' }));
                }
            },
        }), 'dsh-mobius: plan route');
    };
    registerWebSurface();
    ctx.on('internal/service', (name) => {
        if (WEB_SERVER_KEYS.includes(name)
            || WORKSPACE_KEYS.includes(name)) {
            registerWebSurface();
        }
    });
}
