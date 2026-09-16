/**
 * Browser-side API + shared polled state for the DAI notebook capsule.
 *
 * The capsule is a global floating entry. It reads the workspace-scoped
 * notebook snapshots from the host and issues mutations through the same host,
 * so anything typed here is immediately visible to (and editable by) the
 * notebook_* tools in the chat.
 */
import { type NotebookFolderView, type NotebookNoteView, type DailySummary, type NotebookSnapshotView } from '../types.ts';
/** One workspace-scoped notebook as served by the host state route. */
export interface NotebookWorkspaceView {
    readonly workspace: string;
    readonly title: string;
    readonly snapshot: NotebookSnapshotView;
}
export declare const STATE_URL = "/plugins/dsh-dai-notebook/state";
export declare const MUTATE_URL = "/plugins/dsh-dai-notebook/mutate";
/** Copy of the item view union for local editing. */
export type { NotebookFolderView, NotebookNoteView, DailySummary };
/** Shared polled snapshot. */
export interface NotebookSharedState {
    readonly notebooks: readonly NotebookWorkspaceView[];
}
export declare function subscribeNotebookSnapshot(listener: () => void): () => void;
export declare function getNotebookSnapshot(): NotebookSharedState;
export declare function refreshNotebookState(): Promise<void>;
/** Start a lightweight polling loop; returns a stop function. */
export declare function startNotebookPolling(intervalMs?: number): () => void;
/** Pick the workspace notebook for a given cwd (path), else the first. */
export declare function selectWorkspace(notebooks: readonly NotebookWorkspaceView[], cwd: string | undefined): NotebookWorkspaceView | undefined;
export type MutationOp = 'create_folder' | 'rename_folder' | 'delete_folder' | 'create' | 'update' | 'delete' | 'toggle_pin' | 'summarize';
/** Issue one mutation and refresh the shared snapshot from the result. */
export declare function mutateNotebook(sessionId: string, op: MutationOp, payload?: Record<string, unknown>): Promise<NotebookSnapshotView>;
