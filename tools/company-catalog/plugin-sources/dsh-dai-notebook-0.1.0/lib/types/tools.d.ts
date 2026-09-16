/**
 * Host tools for the DAI notebook.
 *
 * These expose the pure-note notebook to the model so the user can drive it
 * from the chat ("帮我记一条笔记", "新建一个文件夹", "把我的笔记挪到 XX 文件夹"),
 * mirroring the agent-teams pattern: the tools write durable state to the
 * workspace, and the browser capsule feeds from the same on-disk truth via
 * the HTTP snapshot route.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { StateLock } from './store.ts';
import { type DailySummary, type NotebookDocument, type NotebookSnapshotView } from './types.ts';
export interface NotebookToolsConfig {
    /** State directory name under the caller's workspace (default `.dai-notebook`). */
    stateDir: string;
}
export declare class NotebookRuntime {
    readonly ctx: Context;
    private readonly config;
    readonly lock: StateLock;
    constructor(ctx: Context, config: NotebookToolsConfig);
    private stateRootOf;
    private mutate;
    private read;
    /** Reconcile the Markdown files under each folder dir against the notes. */
    private syncNoteFiles;
    createFolder(agent: Agent, args: {
        name: string;
    }): Promise<{
        id: string;
        name: string;
        snapshot: NotebookSnapshotView;
    }>;
    renameFolder(agent: Agent, args: {
        id: string;
        name: string;
    }): Promise<{
        id: string;
        name: string;
        snapshot: NotebookSnapshotView;
    }>;
    deleteFolder(agent: Agent, args: {
        id: string;
    }): Promise<{
        ok: true;
        snapshot: NotebookSnapshotView;
    }>;
    createNote(agent: Agent, args: {
        title: string;
        body?: string;
        folderId?: string;
        pinned?: boolean;
    }): Promise<{
        id: string;
        title: string;
        folderName: string;
        snapshot: NotebookSnapshotView;
    }>;
    updateNote(agent: Agent, args: {
        id: string;
        title?: string;
        body?: string;
        folderId?: string;
        pinned?: boolean;
    }): Promise<{
        id: string;
        title: string;
        snapshot: NotebookSnapshotView;
    }>;
    deleteNote(agent: Agent, args: {
        id: string;
    }): Promise<{
        ok: true;
        snapshot: NotebookSnapshotView;
    }>;
    getSnapshot(agent: Agent): Promise<NotebookSnapshotView>;
    search(agent: Agent, args: {
        query: string;
    }): Promise<{
        count: number;
        snapshot: NotebookSnapshotView;
    }>;
    summaries(agent: Agent): Promise<{
        summaries: readonly DailySummary[];
        snapshot: NotebookSnapshotView;
    }>;
    /** Snapshot helper used by the HTTP mutate route (index.ts). */
    snapshotFromDoc(doc: NotebookDocument): NotebookSnapshotView;
}
/** Register every notebook tool onto the shared registry. */
export declare function registerNotebookTools(ctx: Context, config: NotebookToolsConfig): NotebookRuntime;
