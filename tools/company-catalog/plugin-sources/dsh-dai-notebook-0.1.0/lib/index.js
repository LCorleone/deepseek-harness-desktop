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
import z from '@deepseek-ai/schemastery';
import { registerNotebookTools } from "./tools.js";
import { buildSnapshot, maybeSummarize, readDocument, writeDocument, localDate, pendingSummary, resolveStateRoot, uniqueName, StateLock, } from "./store.js";
import { randomUUID } from 'node:crypto';
import { authenticatedWebRoutes, readJsonRequest, RequestBodyError, } from "./web-routes.js";
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'];
export const name = 'dsh-dai-notebook';
export const inject = ['tools', 'agents', 'systemPrompt'];
export const Config = z.object({
    stateDir: z.string().default('.dai-notebook'),
});
/** The model-facing usage policy. */
export function usageSectionText(toolNames) {
    return `The user has a notebook (a global floating notebook in the web GUI) organized into folders, with pure notes (no tasks). You can read and edit it through the notebook_* tools. Rules:
1. When the user asks to 记笔记 / 记一条 / 把...记下来, call notebook_create_note. When they ask to create or manage folders (新建文件夹 / 重命名文件夹 / 删除文件夹), call the notebook_*_folder tools.
2. To answer "笔记本里有什么 / 有几个文件夹 / 有哪些笔记", call notebook_status. To search, call notebook_search. To review daily summaries, call notebook_summaries.
3. Use notebook_update for note edits (title/body/folderId/pinned), notebook_delete only when the user explicitly asks to delete.
4. Prefer reporting the human-readable snapshot summary (folders + notes) over dumping raw ids. The capsule and these tools share the same on-disk notebook, so changes from either side are immediately visible in the other.

Tools: ${toolNames}`;
}
export function apply(ctx, config) {
    const resolved = {
        stateDir: config.stateDir ?? '.dai-notebook',
    };
    const toolNames = [
        'notebook_create_folder',
        'notebook_rename_folder',
        'notebook_delete_folder',
        'notebook_create_note',
        'notebook_status',
        'notebook_search',
        'notebook_update',
        'notebook_delete',
        'notebook_summaries',
    ].join(', ');
    ctx.systemPrompt.section({
        name: 'dai-notebook:usage',
        order: 118,
        text: () => usageSectionText(toolNames),
    });
    const runtime = registerNotebookTools(ctx, resolved);
    const lock = new StateLock();
    // The snapshot/mutate routes need the Web server and the workspace
    // registry, which headless profiles do not mount; register lazily.
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
        // Notebook snapshot route for the browser capsule: the full on-disk truth
        // (items + stats + summaries), served for the single global notebook.
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-dai-notebook/state',
            handler: async (_req, res) => {
                try {
                    const stateRoot = resolveStateRoot(resolved.stateDir);
                    await maybeSummarize(stateRoot, lock);
                    const doc = await readDocument(stateRoot);
                    const notebooks = [{
                            workspace: stateRoot,
                            title: '全局笔记本',
                            snapshot: buildSnapshot(doc),
                        }];
                    res.writeHead(200, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ notebooks }));
                }
                catch (error) {
                    ctx.logger.warn(`dsh-dai-notebook: state route failed: ${String(error)}`);
                    res.writeHead(500, {
                        'content-type': 'application/json; charset=utf-8',
                        'cache-control': 'no-store',
                    });
                    res.end(JSON.stringify({ error: 'failed to read the notebook' }));
                }
            },
        }), 'dsh-dai-notebook: state route');
        // Browser mutation route: one op per request, scoped to a session's own
        // workspace (resolved through the attached agent).
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/plugins/dsh-dai-notebook/mutate',
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
                if (sessionId === '') {
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'sessionId is required' }));
                    return;
                }
                const captain = ctx.agents?.get(sessionId);
                if (captain === undefined) {
                    res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: 'session is not attached' }));
                    return;
                }
                const stateRoot = resolveStateRoot(resolved.stateDir);
                try {
                    const snapshot = await applyMutation(runtime, lock, captain, stateRoot, payload);
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify(snapshot));
                }
                catch (error) {
                    ctx.logger.warn(`dsh-dai-notebook: mutate failed for ${sessionId}: ${String(error)}`);
                    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'mutation failed' }));
                }
            },
        }), 'dsh-dai-notebook: mutate route');
    };
    registerWebSurface();
    ctx.on('internal/service', (serviceName) => {
        if (WEB_SERVER_KEYS.includes(serviceName)
            || WORKSPACE_KEYS.includes(serviceName)) {
            registerWebSurface();
        }
    });
}
/** Dispatch one browser mutation onto the durable notebook and return the snapshot. */
async function applyMutation(runtime, lock, agent, stateRoot, payload) {
    const op = typeof payload.op === 'string' ? payload.op : '';
    const now = new Date().toISOString();
    switch (op) {
        case 'create_folder': {
            const name = typeof payload.name === 'string' ? payload.name.trim() : '';
            if (name === '')
                throw new Error('folder name is required');
            return mutating(runtime, lock, stateRoot, (doc) => {
                const unique = uniqueName(name, new Set(doc.folders.map((f) => f.name)));
                const folder = {
                    id: randomUUID(), name: unique, createdAt: now, updatedAt: now,
                };
                return { ...doc, folders: [...doc.folders, folder] };
            });
        }
        case 'rename_folder': {
            const id = typeof payload.id === 'string' ? payload.id : '';
            const name = typeof payload.name === 'string' ? payload.name.trim() : '';
            if (id === '' || name === '')
                throw new Error('id and name are required');
            return mutating(runtime, lock, stateRoot, (doc) => ({
                ...doc,
                folders: doc.folders.map((f) => f.id === id ? { ...f, name, updatedAt: now } : f),
            }));
        }
        case 'delete_folder': {
            const id = typeof payload.id === 'string' ? payload.id : '';
            if (id === '')
                throw new Error('id is required');
            return mutating(runtime, lock, stateRoot, (doc) => ({
                ...doc,
                folders: doc.folders.filter((f) => f.id !== id),
                notes: doc.notes.filter((n) => n.folderId !== id),
            }));
        }
        case 'create': {
            const title = typeof payload.title === 'string' ? payload.title.trim() : '';
            if (title === '')
                throw new Error('title is required');
            return mutating(runtime, lock, stateRoot, (doc) => {
                const folderId = (typeof payload.folderId === 'string' && doc.folders.some((f) => f.id === payload.folderId))
                    ? payload.folderId
                    : (doc.folders[0]?.id ?? '');
                const unique = uniqueName(title, new Set(doc.notes.filter((n) => n.folderId === folderId).map((n) => n.title)));
                const note = {
                    id: randomUUID(), kind: 'note', folderId, title: unique,
                    body: typeof payload.body === 'string' ? payload.body : '',
                    pinned: payload.pinned === true,
                    createdAt: now, updatedAt: now,
                };
                return { ...doc, notes: [note, ...doc.notes] };
            });
        }
        case 'update': {
            const id = typeof payload.id === 'string' ? payload.id : '';
            if (id === '')
                throw new Error('id is required');
            return mutating(runtime, lock, stateRoot, (doc) => ({
                ...doc,
                notes: doc.notes.map((note) => {
                    if (note.id !== id)
                        return note;
                    const folderId = (typeof payload.folderId === 'string' && doc.folders.some((f) => f.id === payload.folderId))
                        ? payload.folderId : note.folderId;
                    return {
                        ...note,
                        title: typeof payload.title === 'string' ? payload.title.trim() : note.title,
                        body: typeof payload.body === 'string' ? payload.body : note.body,
                        folderId,
                        pinned: typeof payload.pinned === 'boolean' ? payload.pinned : note.pinned,
                        updatedAt: now,
                    };
                }),
            }));
        }
        case 'delete': {
            const id = typeof payload.id === 'string' ? payload.id : '';
            if (id === '')
                throw new Error('id is required');
            return mutating(runtime, lock, stateRoot, (doc) => ({ ...doc, notes: doc.notes.filter((n) => n.id !== id) }));
        }
        case 'toggle_pin': {
            const id = typeof payload.id === 'string' ? payload.id : '';
            if (id === '')
                throw new Error('id is required');
            return mutating(runtime, lock, stateRoot, (doc) => ({
                ...doc,
                notes: doc.notes.map((note) => note.id === id ? { ...note, pinned: !note.pinned, updatedAt: now } : note),
            }));
        }
        case 'summarize': {
            await maybeSummarize(stateRoot, lock);
            return buildSnapshot(await readDocument(stateRoot));
        }
        default:
            throw new Error(`unknown op "${op}"`);
    }
}
async function mutating(runtime, lock, stateRoot, fn) {
    void runtime;
    return lock.with(`mut:${stateRoot}`, async () => {
        const doc = await readDocument(stateRoot);
        const next = fn(doc);
        await writeDocument(stateRoot, next);
        await syncNoteFiles(stateRoot, next);
        await maybeSummarize(stateRoot, lock);
        return buildSnapshot(await readDocument(stateRoot));
    });
}
/**
 * Reconcile the editable Markdown files (`<stateRoot>/<folder>/<note>.md`)
 * against the note records, so every note is a real .md file on disk under its
 * folder's directory.
 */
async function syncNoteFiles(stateRoot, doc) {
    const { writeNoteMarkdown, removeNoteMarkdown, folderDirPath } = await import("./store.js");
    const { readdir } = await import('node:fs/promises');
    const folderById = new Map(doc.folders.map((f) => [f.id, f]));
    for (const note of doc.notes) {
        const folder = folderById.get(note.folderId);
        await writeNoteMarkdown(stateRoot, note, folder);
    }
    for (const folder of doc.folders) {
        const dir = folderDirPath(stateRoot, folder);
        const liveIds = new Set(doc.notes.filter((n) => n.folderId === folder.id).map((n) => n.id));
        const entries = await readdir(dir).catch(() => []);
        for (const name of entries) {
            if (!name.endsWith('.md'))
                continue;
            const id = name.slice(0, -3);
            if (!liveIds.has(id))
                await removeNoteMarkdown(stateRoot, folder, id);
        }
    }
}
// Re-export for offline verification.
export { localDate, pendingSummary };
