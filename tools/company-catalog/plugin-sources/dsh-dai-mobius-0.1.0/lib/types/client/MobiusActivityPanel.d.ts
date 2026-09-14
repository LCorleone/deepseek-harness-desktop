/**
 * Mobius activity panel: the top-right floater monitoring every research
 * workflow for the current session.
 *
 * This is the Mobius sibling of the AgentTeams ActivityPanel: the same
 * shell-overlay floater that docks at the conversation's top-right edge by
 * default, can be dragged into a floating window, resized, and folded into an
 * activity badge. On wide viewports the docked panel makes the conversation
 * column yield space; narrow viewports keep a simple inset overlay. It polls
 * the host `/plugins/dsh-mobius/mobius` route for server-side workflow
 * snapshots, with a collapsed badge that auto-expands once when activity
 * appears. Every workflow card shows its ordered steps, per-step status and
 * output, and the final conclusion.
 *
 * The floater mounts in ui-layout's additive `shell.overlay`; it is not a
 * conversation node. All shell geometry, resize/dock gestures and cross-session
 * collapse logic mirror the AgentTeams panel, but the content is workflow
 * cards instead of a team graph.
 * @module dsh-agent-teams/client/mobius-activity
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
/** The top-right activity floater. Workflows follow the current session. */
export type MobiusActivityPanelProps = {
    readonly sessionsList: ObservableSnapshot<SessionListState>;
};
export declare function MobiusActivityPanel({ sessionsList }: MobiusActivityPanelProps): import("react").JSX.Element | null;
