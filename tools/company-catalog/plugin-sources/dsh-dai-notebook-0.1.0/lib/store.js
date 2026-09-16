/**
 * File-backed persistence for the DAI notebook.
 *
 * The notebook lives at `<workspace>/<stateDir>/notebook.json`: a list of
 * folders and notes. Each note is also rendered as a real Markdown file on disk
 * under its folder's directory at `<stateDir>/<folder dir>/<note>.md`, so the
 * user can browse and edit notes like a plain Markdown folder tree. Reads and
 * writes are serialized per state-root with a promise-chain mutex.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
const DOCUMENT_FILENAME = 'notebook.json';
/** In-process latches: one settle promise per state root, recursive safe. */
export class StateLock {
    queue = new Map();
    with(key, fn) {
        const previous = this.queue.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        this.queue.set(key, previous.then(() => gate));
        return previous
            .then(fn)
            .finally(() => {
            release();
            if (this.queue.get(key) === gate)
                this.queue.delete(key);
        });
    }
}
/**
 * Resolve the one global notebook root. When `stateDir` is an absolute path it
 * is used as-is; otherwise it names a directory under the user's home, so every
 * workspace shares a single notebook (global, not per-workspace).
 */
export function resolveStateRoot(stateDir) {
    const dir = stateDir.trim();
    if (dir === '')
        return join(homedir(), '.dai-notebook');
    return isAbsolute(dir) ? dir : join(homedir(), dir);
}
export function documentPath(stateRoot) {
    return join(stateRoot, DOCUMENT_FILENAME);
}
/** Always-on-empty read: a missing or corrupt file yields an empty document. */
export async function readDocument(stateRoot) {
    try {
        const raw = await readFile(documentPath(stateRoot), 'utf8');
        const parsed = JSON.parse(raw);
        return normalizeDocument(parsed);
    }
    catch {
        return emptyDocument();
    }
}
const emptyDocument = () => ({ version: 2, folders: [], notes: [], summaries: [] });
export async function writeDocument(stateRoot, doc) {
    await mkdir(dirname(documentPath(stateRoot)), { recursive: true });
    const raw = JSON.stringify(doc, null, 2);
    const target = documentPath(stateRoot);
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, raw, 'utf8');
    await writeFile(target, raw, 'utf8');
    await rm(tmp, { force: true }).catch(() => { });
}
/** The state root's folder directory root (`<stateRoot>`). */
export function folderRoot(stateRoot) {
    return stateRoot;
}
/** Directory name for one folder (its visible name, path-sanitized). */
export function folderDirName(folder) {
    return sanitizeDirName(folder.name) || `folder-${folder.id.slice(0, 8)}`;
}
/** Absolute path to a folder's directory on disk. */
export function folderDirPath(stateRoot, folder) {
    return join(folderRoot(stateRoot), folderDirName(folder));
}
/** Markdown file path for one note (`<stateRoot>/<folder>/<note>.md`). */
export function noteMarkdownPath(stateRoot, folder, id) {
    const dir = folder === undefined ? folderRoot(stateRoot) : folderDirPath(stateRoot, folder);
    return join(dir, `${safeId(id)}.md`);
}
/** A note's rendered Markdown file content (notepad-style, editable truth). */
export function renderNoteMarkdown(note, folderName) {
    const title = note.title.trim();
    const body = note.body.trim();
    const lines = [
        `---`,
        `id: ${note.id}`,
        `kind: note`,
        ...(folderName !== undefined ? [`folder: ${folderName}`] : []),
        `---`,
        ``,
        `# ${title}`,
    ];
    if (body !== '')
        lines.push('', body);
    return lines.join('\n') + '\n';
}
/** Write one note's Markdown file inside its folder directory. */
export async function writeNoteMarkdown(stateRoot, note, folder) {
    const dir = folder === undefined ? folderRoot(stateRoot) : folderDirPath(stateRoot, folder);
    await mkdir(dir, { recursive: true });
    await writeFile(noteMarkdownPath(stateRoot, folder, note.id), renderNoteMarkdown(note, folder?.name), 'utf8');
}
/** Remove one note's Markdown file. */
export async function removeNoteMarkdown(stateRoot, folder, id) {
    await rm(noteMarkdownPath(stateRoot, folder, id), { force: true }).catch(() => { });
}
/**
 * Choose a unique display name for a new folder/note that would otherwise
 * collide: `base` → `base`, `base`, `base(2)`, `base(3)`, … while keeping
 * every existing name in `existing` untouched. This keeps the on-disk dir /
 * note filename stable and collision-free.
 */
export function uniqueName(base, existing) {
    const trimmed = base.trim();
    if (trimmed === '')
        return trimmed;
    if (!existing.has(trimmed))
        return trimmed;
    let i = 2;
    let candidate = `${trimmed}(${i})`;
    while (existing.has(candidate)) {
        i += 1;
        candidate = `${trimmed}(${i})`;
    }
    return candidate;
}
function sanitizeDirName(name) {
    const cleaned = name
        .trim()
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5 _-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[_-]+|[_-]+$/g, '');
    return cleaned.slice(0, 60);
}
function safeId(id) {
    return id.replace(/[^a-zA-Z0-9_-]/g, '-') || 'note';
}
function normalizeDocument(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return emptyDocument();
    const record = value;
    const foldersRaw = Array.isArray(record.folders) ? record.folders : [];
    const folders = foldersRaw
        .map(toFolder)
        .filter((f) => f !== undefined);
    const notesRaw = Array.isArray(record.notes) ? record.notes : [];
    const notes = notesRaw
        .map((n) => toNote(n, folders))
        .filter((n) => n !== undefined);
    const summariesRaw = Array.isArray(record.summaries) ? record.summaries : [];
    const summaries = summariesRaw
        .filter((s) => s !== null && typeof s === 'object')
        .map((s) => {
        const r = s;
        return {
            date: typeof r.date === 'string' ? r.date : '',
            added: typeof r.added === 'number' ? r.added : 0,
            createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
        };
    })
        .filter((s) => s.date !== '');
    const last = typeof record.lastSummaryAt === 'string' ? record.lastSummaryAt : undefined;
    if (folders.length === 0 && notes.length === 0)
        return emptyDocument();
    return { version: 2, folders, notes, summaries, ...(last === undefined ? {} : { lastSummaryAt: last }) };
}
function toFolder(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const r = value;
    const id = typeof r.id === 'string' ? r.id : '';
    if (id === '')
        return undefined;
    const now = new Date().toISOString();
    return {
        id,
        name: typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : '未命名文件夹',
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
    };
}
function toNote(value, folders) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const r = value;
    const id = typeof r.id === 'string' ? r.id : '';
    if (id === '' || r.kind !== 'note')
        return undefined;
    const folderId = typeof r.folderId === 'string' && folders.some((f) => f.id === r.folderId)
        ? r.folderId
        : (folders[0]?.id ?? '');
    const now = new Date().toISOString();
    return {
        id,
        kind: 'note',
        folderId,
        title: typeof r.title === 'string' ? r.title : '',
        body: typeof r.body === 'string' ? r.body : '',
        pinned: r.pinned === true,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
    };
}
/** Export helpers. */
export function folderToView(folder, noteCount) {
    return {
        id: folder.id,
        name: folder.name,
        noteCount,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
    };
}
export function noteToView(note, folders) {
    const folder = folders.find((f) => f.id === note.folderId);
    return {
        id: note.id,
        kind: 'note',
        folderId: note.folderId,
        folderName: folder?.name ?? '',
        title: note.title,
        body: note.body,
        pinned: note.pinned,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    };
}
export function buildSnapshot(doc) {
    const folderCounts = new Map();
    for (const note of doc.notes) {
        folderCounts.set(note.folderId, (folderCounts.get(note.folderId) ?? 0) + 1);
    }
    const folders = doc.folders.map((folder) => folderToView(folder, folderCounts.get(folder.id) ?? 0));
    const notes = doc.notes.map((note) => noteToView(note, doc.folders));
    return {
        folders,
        notes,
        summaries: [...doc.summaries],
        stats: {
            totalFolders: folders.length,
            totalNotes: notes.length,
            pinned: notes.filter((n) => n.pinned).length,
        },
    };
}
/** Local YYYY-MM-DD for a date (server local time, matches the browser day). */
export function localDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
/** Compute but do not persist the pending daily summary for a document. */
export function pendingSummary(doc, notes) {
    const today = localDate(new Date());
    if (doc.lastSummaryAt === today)
        return undefined;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = localDate(yesterday);
    const added = notes.filter((note) => dayKey(note.createdAt) === yesterdayKey).length;
    return { date: yesterdayKey, added, createdAt: new Date().toISOString() };
}
function dayKey(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '9999-99-99';
    return localDate(date);
}
/** Persist a daily summary snapshot if one is due for today. */
export async function maybeSummarize(stateRoot, lock) {
    await lock.with(`summarize:${stateRoot}`, async () => {
        const doc = await readDocument(stateRoot);
        const pending = pendingSummary(doc, doc.notes);
        if (pending === undefined)
            return;
        await writeDocument(stateRoot, {
            ...doc,
            notes: doc.notes,
            folders: doc.folders,
            summaries: [pending, ...doc.summaries].slice(0, 40),
            lastSummaryAt: localDate(new Date()),
        });
    });
}
