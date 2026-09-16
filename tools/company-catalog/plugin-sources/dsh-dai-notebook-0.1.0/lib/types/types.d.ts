/**
 * Shared domain types for the DAI notebook.
 *
 * These are host-side durable records persisted to
 * `<workspace>/<stateDir>/notebook.json`. The notebook is a pure-note app
 * (no tasks): notes live inside folders, and each note is also rendered as a
 * real Markdown file on disk at `<stateDir>/<folder>/<note>.md`, so the on-disk
 * layout mirrors the folder → note structure the user sees.
 */
/** A folder that groups notes. */
export interface NotebookFolder {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** A pure note (Markdown body), belonging to one folder. */
export interface NotebookNote {
    readonly id: string;
    readonly kind: 'note';
    /** Owning folder id. */
    readonly folderId: string;
    readonly title: string;
    readonly body: string;
    readonly pinned: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** The durable notebook document. */
export interface NotebookDocument {
    readonly version: 2;
    readonly folders: readonly NotebookFolder[];
    readonly notes: readonly NotebookNote[];
    /** Last time the per-day auto-summary was generated, keyed by local date. */
    readonly lastSummaryAt?: string;
    /** The most recent auto-generated daily summary block (latest first). */
    readonly summaries: readonly DailySummary[];
}
/** One generated daily summary block (notes-only). */
export interface DailySummary {
    readonly date: string;
    readonly added: number;
    readonly createdAt: string;
}
/** Model-facing view of one folder. */
export interface NotebookFolderView {
    readonly id: string;
    readonly name: string;
    readonly noteCount: number;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** Model-facing view of one note, flattened for the LLM. */
export interface NotebookNoteView {
    readonly id: string;
    readonly kind: 'note';
    readonly folderId: string;
    readonly folderName: string;
    readonly title: string;
    readonly body: string;
    readonly pinned: boolean;
    readonly createdAt: string;
    readonly updatedAt: string;
}
/** The model-facing snapshot returned by every tool. */
export interface NotebookSnapshotView {
    readonly folders: readonly NotebookFolderView[];
    readonly notes: readonly NotebookNoteView[];
    readonly summaries: readonly DailySummary[];
    readonly stats: {
        readonly totalFolders: number;
        readonly totalNotes: number;
        readonly pinned: number;
    };
}
