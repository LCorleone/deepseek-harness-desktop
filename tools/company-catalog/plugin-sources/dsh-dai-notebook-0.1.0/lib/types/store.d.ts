/**
 * File-backed persistence for the DAI notebook.
 *
 * The notebook lives at `<workspace>/<stateDir>/notebook.json`: a list of
 * folders and notes. Each note is also rendered as a real Markdown file on disk
 * under its folder's directory at `<stateDir>/<folder dir>/<note>.md`, so the
 * user can browse and edit notes like a plain Markdown folder tree. Reads and
 * writes are serialized per state-root with a promise-chain mutex.
 */
import { type DailySummary, type NotebookDocument, type NotebookFolder, type NotebookNote, type NotebookFolderView, type NotebookNoteView, type NotebookSnapshotView } from './types.ts';
/** In-process latches: one settle promise per state root, recursive safe. */
export declare class StateLock {
    private readonly queue;
    with<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
/**
 * Resolve the one global notebook root. When `stateDir` is an absolute path it
 * is used as-is; otherwise it names a directory under the user's home, so every
 * workspace shares a single notebook (global, not per-workspace).
 */
export declare function resolveStateRoot(stateDir: string): string;
export declare function documentPath(stateRoot: string): string;
/** Always-on-empty read: a missing or corrupt file yields an empty document. */
export declare function readDocument(stateRoot: string): Promise<NotebookDocument>;
export declare function writeDocument(stateRoot: string, doc: NotebookDocument): Promise<void>;
/** The state root's folder directory root (`<stateRoot>`). */
export declare function folderRoot(stateRoot: string): string;
/** Directory name for one folder (its visible name, path-sanitized). */
export declare function folderDirName(folder: NotebookFolder): string;
/** Absolute path to a folder's directory on disk. */
export declare function folderDirPath(stateRoot: string, folder: NotebookFolder): string;
/** Markdown file path for one note (`<stateRoot>/<folder>/<note>.md`). */
export declare function noteMarkdownPath(stateRoot: string, folder: NotebookFolder | undefined, id: string): string;
/** A note's rendered Markdown file content (notepad-style, editable truth). */
export declare function renderNoteMarkdown(note: NotebookNote, folderName?: string): string;
/** Write one note's Markdown file inside its folder directory. */
export declare function writeNoteMarkdown(stateRoot: string, note: NotebookNote, folder: NotebookFolder | undefined): Promise<void>;
/** Remove one note's Markdown file. */
export declare function removeNoteMarkdown(stateRoot: string, folder: NotebookFolder | undefined, id: string): Promise<void>;
/**
 * Choose a unique display name for a new folder/note that would otherwise
 * collide: `base` → `base`, `base`, `base(2)`, `base(3)`, … while keeping
 * every existing name in `existing` untouched. This keeps the on-disk dir /
 * note filename stable and collision-free.
 */
export declare function uniqueName(base: string, existing: ReadonlySet<string>): string;
/** Export helpers. */
export declare function folderToView(folder: NotebookFolder, noteCount: number): NotebookFolderView;
export declare function noteToView(note: NotebookNote, folders: readonly NotebookFolder[]): NotebookNoteView;
export declare function buildSnapshot(doc: NotebookDocument): NotebookSnapshotView;
/** Local YYYY-MM-DD for a date (server local time, matches the browser day). */
export declare function localDate(date: Date): string;
/** Compute but do not persist the pending daily summary for a document. */
export declare function pendingSummary(doc: NotebookDocument, notes: readonly NotebookNote[]): DailySummary | undefined;
/** Persist a daily summary snapshot if one is due for today. */
export declare function maybeSummarize(stateRoot: string, lock: StateLock): Promise<void>;
