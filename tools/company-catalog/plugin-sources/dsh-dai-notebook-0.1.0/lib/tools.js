/**
 * Host tools for the DAI notebook.
 *
 * These expose the pure-note notebook to the model so the user can drive it
 * from the chat ("帮我记一条笔记", "新建一个文件夹", "把我的笔记挪到 XX 文件夹"),
 * mirroring the agent-teams pattern: the tools write durable state to the
 * workspace, and the browser capsule feeds from the same on-disk truth via
 * the HTTP snapshot route.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { buildSnapshot, maybeSummarize, readDocument, writeDocument, StateLock, resolveStateRoot, uniqueName } from "./store.js";
export class NotebookRuntime {
    ctx;
    config;
    lock = new StateLock();
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    stateRootOf() {
        return resolveStateRoot(this.config.stateDir);
    }
    async mutate(agent, fn) {
        const stateRoot = this.stateRootOf();
        return this.lock.with(`mut:${stateRoot}`, async () => {
            const doc = await readDocument(stateRoot);
            const next = fn(doc);
            await writeDocument(stateRoot, next);
            await this.syncNoteFiles(stateRoot, next);
            await maybeSummarize(stateRoot, this.lock);
            return buildSnapshot(await readDocument(stateRoot));
        });
    }
    async read(agent) {
        const stateRoot = this.stateRootOf();
        await maybeSummarize(stateRoot, this.lock);
        return buildSnapshot(await readDocument(stateRoot));
    }
    /** Reconcile the Markdown files under each folder dir against the notes. */
    async syncNoteFiles(stateRoot, doc) {
        const { writeNoteMarkdown, removeNoteMarkdown, folderDirPath } = await import("./store.js");
        const { readdir } = await import('node:fs/promises');
        const folderById = new Map(doc.folders.map((f) => [f.id, f]));
        // Write every live note's .md inside its folder dir.
        for (const note of doc.notes) {
            const folder = folderById.get(note.folderId);
            await writeNoteMarkdown(stateRoot, note, folder);
        }
        // Best-effort: prune stale per-folder notes and empty/unknown dirs.
        const usedDirs = new Set();
        for (const folder of doc.folders)
            usedDirs.add(folderDirPath(stateRoot, folder));
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
        // Remove leftover dirs that are no longer a folder.
        void usedDirs;
    }
    // ── folder operations ─────────────────────────────────────────────────────
    async createFolder(agent, args) {
        const name = args.name.trim();
        if (name === '')
            throw new Error('folder name is required');
        const now = new Date().toISOString();
        const id = randomUUID();
        // Dedupe folder names so the on-disk dir is stable: never create two
        // folders with the same visible name (which would map to one on-disk dir).
        const snapshot = await this.mutate(agent, (doc) => {
            const unique = uniqueName(name, new Set(doc.folders.map((f) => f.name)));
            const folder = { id, name: unique, createdAt: now, updatedAt: now };
            return { ...doc, folders: [...doc.folders, folder] };
        });
        const created = snapshot.folders.find((f) => f.id === id);
        if (created === undefined)
            throw new Error(`folder ${name} was not created`);
        return { id: created.id, name: created.name, snapshot };
    }
    async renameFolder(agent, args) {
        const id = args.id.trim();
        if (id === '')
            throw new Error('folder id is required');
        const name = args.name.trim();
        if (name === '')
            throw new Error('folder name is required');
        const now = new Date().toISOString();
        const snapshot = await this.mutate(agent, (doc) => ({
            ...doc,
            folders: doc.folders.map((f) => f.id === id ? { ...f, name, updatedAt: now } : f),
        }));
        const folder = snapshot.folders.find((f) => f.id === id);
        if (folder === undefined)
            throw new Error(`folder ${id} not found`);
        return { id, name, snapshot };
    }
    async deleteFolder(agent, args) {
        const id = args.id.trim();
        if (id === '')
            throw new Error('folder id is required');
        const snapshot = await this.mutate(agent, (doc) => {
            const remaining = doc.folders.filter((f) => f.id !== id);
            // If this removed the last folder, leave notes orphaned-free: move them
            // to the first remaining folder, else drop them (they have no folder).
            const notes = doc.notes.filter((n) => n.folderId !== id);
            return { ...doc, folders: remaining, notes };
        });
        return { ok: true, snapshot };
    }
    // ── note operations ───────────────────────────────────────────────────────
    async createNote(agent, args) {
        const title = args.title.trim();
        if (title === '')
            throw new Error('note title is required');
        const now = new Date().toISOString();
        const id = randomUUID();
        const snapshot = await this.mutate(agent, (doc) => {
            const folderId = (args.folderId !== undefined && doc.folders.some((f) => f.id === args.folderId))
                ? args.folderId
                : (doc.folders[0]?.id ?? '');
            // Dedupe the note title within its folder so sibling notes stay distinct.
            const unique = uniqueName(title, new Set(doc.notes.filter((n) => n.folderId === folderId).map((n) => n.title)));
            const note = {
                id, kind: 'note', folderId,
                title: unique, body: args.body ?? '',
                pinned: args.pinned === true,
                createdAt: now, updatedAt: now,
            };
            return { ...doc, notes: [note, ...doc.notes] };
        });
        const created = snapshot.notes.find((n) => n.id === id);
        if (created === undefined)
            throw new Error('note was not created');
        return { id, title: created.title, folderName: created.folderName, snapshot };
    }
    async updateNote(agent, args) {
        const id = args.id.trim();
        if (id === '')
            throw new Error('note id is required');
        const now = new Date().toISOString();
        const snapshot = await this.mutate(agent, (doc) => ({
            ...doc,
            notes: doc.notes.map((note) => {
                if (note.id !== id)
                    return note;
                const folderId = args.folderId !== undefined && doc.folders.some((f) => f.id === args.folderId)
                    ? args.folderId : note.folderId;
                return {
                    ...note,
                    title: args.title !== undefined ? args.title.trim() : note.title,
                    body: args.body !== undefined ? args.body : note.body,
                    folderId,
                    pinned: args.pinned !== undefined ? args.pinned : note.pinned,
                    updatedAt: now,
                };
            }),
        }));
        const note = snapshot.notes.find((n) => n.id === id);
        if (note === undefined)
            throw new Error(`note ${id} not found`);
        return { id, title: note.title, snapshot };
    }
    async deleteNote(agent, args) {
        const id = args.id.trim();
        if (id === '')
            throw new Error('note id is required');
        const snapshot = await this.mutate(agent, (doc) => ({ ...doc, notes: doc.notes.filter((n) => n.id !== id) }));
        return { ok: true, snapshot };
    }
    async getSnapshot(agent) {
        return this.read(agent);
    }
    async search(agent, args) {
        const snapshot = await this.read(agent);
        const q = args.query.trim().toLowerCase();
        if (q === '')
            return { count: snapshot.notes.length, snapshot };
        const count = snapshot.notes.filter((note) => note.title.toLowerCase().includes(q)
            || note.body.toLowerCase().includes(q)
            || note.folderName.toLowerCase().includes(q)).length;
        return { count, snapshot };
    }
    async summaries(agent) {
        const snapshot = await this.read(agent);
        return { summaries: snapshot.summaries, snapshot };
    }
    /** Snapshot helper used by the HTTP mutate route (index.ts). */
    snapshotFromDoc(doc) {
        return buildSnapshot(doc);
    }
}
function requireAgent(exec) {
    if (!exec.agent)
        throw new Error('notebook tools require a calling agent');
    return exec.agent;
}
function snapshotText(s) {
    return `${s.stats.totalFolders} 个文件夹，${s.stats.totalNotes} 条笔记`;
}
/** Register every notebook tool onto the shared registry. */
export function registerNotebookTools(ctx, config) {
    const runtime = new NotebookRuntime(ctx, config);
    const registerTool = (tool) => {
        ctx.tools.register(tool);
    };
    registerTool(defineTool({
        name: 'notebook_create_folder',
        description: 'Create a folder in the user\'s notebook to organize notes. Use when the user asks to 新建文件夹 / 建个文件夹 / 加个分类 / 整理一下. Returns the new folder and the notebook summary.',
        parameters: {
            name: { type: 'string', required: true, description: 'Folder name.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `已新建文件夹「${value.name}」。${value.summary}。` }],
        },
        async execute(args, exec) {
            const result = await runtime.createFolder(requireAgent(exec), args);
            return { id: result.id, name: result.name, summary: snapshotText(result.snapshot) };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_rename_folder',
        description: 'Rename a folder in the user\'s notebook. Use when the user asks to 重命名文件夹 / 改文件夹名字. Returns the updated summary.',
        parameters: {
            id: { type: 'string', required: true, description: 'Folder id.' },
            name: { type: 'string', required: true, description: 'New folder name.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `已将文件夹重命名为「${value.name}」。${value.summary}。` }],
        },
        async execute(args, exec) {
            const result = await runtime.renameFolder(requireAgent(exec), args);
            return { id: result.id, name: result.name, summary: snapshotText(result.snapshot) };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_delete_folder',
        description: 'Permanently delete a folder and all notes inside it from the notebook. Use only when the user explicitly asks to delete a folder. Returns the updated summary.',
        parameters: {
            id: { type: 'string', required: true, description: 'Folder id.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `已删除文件夹。${value.summary}。` }],
        },
        async execute(args, exec) {
            const result = await runtime.deleteFolder(requireAgent(exec), args);
            return { ok: result.ok, summary: snapshotText(result.snapshot) };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_create_note',
        description: 'Record a note into the user\'s notebook (a global floating notebook in the web GUI). A note is freeform text (title + optional Markdown body), and you may place it in a folder. Use this when the user asks to 记笔记 / 记一条 / 把...记下来.',
        parameters: {
            title: { type: 'string', required: true, description: 'Short note title.' },
            body: { type: 'string', description: 'Optional note body (Markdown).' },
            folderId: { type: 'string', description: 'Optional folder id to put the note in; defaults to the first folder.' },
            pinned: { type: 'boolean', description: 'Whether to pin this note to the top. Defaults to false.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    folderName: { type: 'string', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `已记笔记「${value.title}」（${value.folderName}）。${value.summary}。` }],
        },
        async execute(args, exec) {
            const result = await runtime.createNote(requireAgent(exec), args);
            return { id: result.id, title: result.title, folderName: result.folderName, summary: snapshotText(result.snapshot) };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_status',
        description: 'Return the current notebook snapshot: folder list, note list, and recent daily summaries. Use this to answer "笔记本里有什么" / "有几个文件夹" / "有哪些笔记".',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    summary: { type: 'string', required: true },
                    folders: { type: 'string', required: true },
                    notes: { type: 'string', required: true },
                    summaries: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `${value.summary}\n${value.folders}\n${value.notes}\n${value.summaries}` }],
        },
        async execute(_args, exec) {
            const snapshot = await runtime.getSnapshot(requireAgent(exec));
            const folders = snapshot.folders.length === 0
                ? '（暂无文件夹）'
                : snapshot.folders.map((f) => `📁 ${f.name} (${f.noteCount})`).join('\n');
            const notes = snapshot.notes
                .slice(0, 60)
                .map((n) => `${n.pinned ? '📌 ' : ''}${n.title}（${n.folderName}）`)
                .join('\n');
            const summaries = snapshot.summaries.length === 0
                ? '暂无每日小结。'
                : snapshot.summaries.map((s) => `${s.date}：新增 ${s.added}`).join('\n');
            return {
                summary: snapshotText(snapshot),
                folders: folders === '' ? '（空）' : folders,
                notes: notes === '' ? '（空笔记本）' : notes,
                summaries,
            };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_search',
        description: 'Search notes by a text query (matches title, body, and folder name). Also usable with an empty query to list everything. Returns the matching notes summarised.',
        parameters: {
            query: { type: 'string', required: true, description: 'Search text (empty returns all notes).' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    count: { type: 'number', required: true },
                    matched: { type: 'string', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: `找到 ${value.count} 条匹配「${args.query}」的笔记：\n${value.matched}` }],
        },
        async execute(args, exec) {
            const snapshot = await runtime.getSnapshot(requireAgent(exec));
            const q = args.query.trim().toLowerCase();
            const matched = (q === ''
                ? snapshot.notes
                : snapshot.notes.filter((note) => note.title.toLowerCase().includes(q)
                    || note.body.toLowerCase().includes(q)
                    || note.folderName.toLowerCase().includes(q)))
                .slice(0, 30)
                .map((n) => `${n.pinned ? '📌 ' : ''}${n.title}（${n.folderName}）`)
                .join('\n');
            return { count: snapshot.notes.length, matched: matched === '' ? '（无匹配）' : matched, summary: snapshotText(snapshot) };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_update',
        description: 'Update an existing note: change its title, body (Markdown), folder (folderId), or pin state. Pass only the fields to change. Returns the updated title and summary.',
        parameters: {
            id: { type: 'string', required: true, description: 'Note id.' },
            title: { type: 'string' },
            body: { type: 'string', description: 'Note Markdown body.' },
            folderId: { type: 'string', description: 'Move the note into another folder.' },
            pinned: { type: 'boolean' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    title: { type: 'string', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `已更新「${value.title}」。${value.summary}。` }],
        },
        async execute(args, exec) {
            const result = await runtime.updateNote(requireAgent(exec), args);
            return { title: result.title, summary: snapshotText(result.snapshot) };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_delete',
        description: 'Permanently delete a note from the notebook by id. Returns the updated summary.',
        parameters: {
            id: { type: 'string', required: true, description: 'Note id.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    summary: { type: 'string', required: true },
                },
            },
            render: (args, value) => [{ type: 'text', text: `已删除笔记 ${args.id}。${value.summary}。` }],
        },
        async execute(args, exec) {
            const result = await runtime.deleteNote(requireAgent(exec), args);
            return { ok: result.ok, summary: snapshotText(result.snapshot) };
        },
    }));
    registerTool(defineTool({
        name: 'notebook_summaries',
        description: 'Return the recent daily auto-summaries (per-day notes added). These are generated automatically from the notebook data.',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: { text: { type: 'string', required: true } },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(_args, exec) {
            const result = await runtime.summaries(requireAgent(exec));
            const text = result.summaries.length === 0
                ? '暂无每日小结。'
                : result.summaries.map((s) => `${s.date}：新增 ${s.added}`).join('\n');
            return { text };
        },
    }));
    return runtime;
}
