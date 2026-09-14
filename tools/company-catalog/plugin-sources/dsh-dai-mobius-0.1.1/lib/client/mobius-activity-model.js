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
export function mobiusPanelPhaseOf(workflows) {
    if (workflows.length === 0)
        return 'idle';
    if (workflows.some((workflow) => workflow.phase === 'staged'))
        return 'planning';
    if (workflows.some((workflow) => workflow.phase === 'running'))
        return 'running';
    return 'completed';
}
/** Whether the floater shows its animated water-wave surface (any real state). */
export function mobiusRunsWater(phase) {
    return phase !== 'idle';
}
/**
 * Whether an expanded panel still belongs to the current session.
 *
 * The panel is mounted in the root-scoped shell overlay, so React does not
 * remount it when the conversation route changes. Ownership keeps an expanded
 * panel from leaking onto the new-session screen (or another conversation)
 * while its local open state is being reset.
 */
export function mobiusPanelExpandedForSession(open, owner, current) {
    return open && owner !== undefined && owner === current;
}
/**
 * Auto-expand only for workflows that appear after the current session's
 * initial restore pass. Workflows restored while reopening a conversation must
 * remain behind the collapsed badge.
 */
export function mobiusPanelShouldAutoExpand({ alreadyAutoOpened, pageSettled, restoreComplete, previousLiveWorkflowIds, currentLiveWorkflowIds, }) {
    return !alreadyAutoOpened
        && pageSettled
        && restoreComplete
        && currentLiveWorkflowIds.some((workflowId) => !previousLiveWorkflowIds.has(workflowId));
}
