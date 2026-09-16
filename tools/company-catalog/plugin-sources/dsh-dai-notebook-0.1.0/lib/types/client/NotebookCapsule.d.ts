/**
 * The DAI notebook global floating capsule.
 *
 * A single collapsed pill (bottom-right) that expands into a minimalist panel
 * organized like a file browser: a folder sidebar on the left, and the note
 * list of the selected folder (or all notes) on the right, plus a notepad-style
 * Markdown editor. Pure notes, no tasks. All data flows through the host HTTP
 * routes so it is durable and shared with the chat notebook_* tools.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
interface CapsuleProps {
    readonly sessionsList: ObservableSnapshot<SessionListState>;
}
export declare function NotebookCapsule({ sessionsList }: CapsuleProps): import("react").JSX.Element;
export {};
