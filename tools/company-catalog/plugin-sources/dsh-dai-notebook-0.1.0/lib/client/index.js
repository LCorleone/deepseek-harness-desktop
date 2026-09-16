import { jsx as _jsx } from "react/jsx-runtime";
import { NotebookCapsule } from "./NotebookCapsule.js";
/** Required services: slots and sessions. */
export const inject = ['slots', 'sessions'];
/**
 * Register the notebook capsule in the shell's additive overlay. It is a
 * single always-available floating entry, visually distinct from any
 * collocated agent-teams / mobius panels.
 */
export function apply(ctx) {
    const NotebookCapsuleView = () => _jsx(NotebookCapsule, { sessionsList: ctx.sessions.list });
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dai-notebook-capsule',
        order: 78,
        label: 'DAI Notebook',
    }, NotebookCapsuleView));
}
