/**
 * Pure relationship projections for the Mobius activity panel.
 *
 * Mobius is the sequential-research sibling of AgentTeams: instead of a team
 * graph it owns one or more ordered *workflows* per captain session, and this
 * model derives the floater-wide lifecycle phase and cross-session expansion
 * rules from those workflows. It is deliberately free of I/O so the panel and
 * its tests share one source of truth.
 * @module dsh-agent-teams/client/mobius-activity-model
 */
import type { MobiusWorkflowView } from './mobius-monitor.ts';
/** The collapsed-badge floater-wide lifecycle phase for the current session. */
export type MobiusPanelPhase = 'idle' | 'planning' | 'running' | 'completed';
/**
 * Derive the panel's overall phase from the workflows owned by the current
 * captain session.
 *
 * - `idle`: no workflow in this session (the collapsed badge / empty state).
 * - `planning`: any workflow is still staged (planned but not started) —
 *   "Mobius 规划中".
 * - `running`: any workflow is in flight ("Mobius 运行中").
 * - `completed`: there is at least one workflow and every workflow is fully
 *   done ("Mobius 已完成").
 *
 * Precedence makes planning and running dominate over completion: while any
 * workflow is still planned or in flight the floater keeps signalling active
 * coordination, and completion only reads once the whole set is settled.
 */
export declare function mobiusPanelPhaseOf(workflows: readonly MobiusWorkflowView[]): MobiusPanelPhase;
/** Whether the floater shows its animated water-wave surface (any real state). */
export declare function mobiusRunsWater(phase: MobiusPanelPhase): boolean;
/**
 * Whether an expanded panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export declare function mobiusPanelExpandedForSession(open: boolean, owner: string | undefined, current: string | undefined): boolean;
/** Inputs for deciding whether genuinely new live workflows may expand the panel. */
export interface MobiusPanelAutoExpandInput {
    readonly alreadyAutoOpened: boolean;
    readonly pageSettled: boolean;
    readonly restoreComplete: boolean;
    readonly previousLiveWorkflowIds: ReadonlySet<string>;
    readonly currentLiveWorkflowIds: readonly string[];
}
/**
 * Auto-expand only for workflows that appear after the current session's
 * initial restore pass. Workflows restored while reopening a conversation must
 * remain behind the collapsed badge.
 */
export declare function mobiusPanelShouldAutoExpand({ alreadyAutoOpened, pageSettled, restoreComplete, previousLiveWorkflowIds, currentLiveWorkflowIds, }: MobiusPanelAutoExpandInput): boolean;
