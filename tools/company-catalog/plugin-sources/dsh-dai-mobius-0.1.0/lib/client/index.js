import { jsx as _jsx } from "react/jsx-runtime";
import { MobiusActivityPanel } from "./MobiusActivityPanel.js";
import { MobiusCard } from "./MobiusCard.js";
import { mobiusCardDefinition } from "./mobius-card-definition.js";
/** Required services: conversation nodes, slots, and sessions. */
export const inject = ['uiConversation', 'slots', 'sessions'];
/**
 * Register the Mobius activity monitor in the shell's additive overlay and the
 * in-conversation workflow card. A separate overlay slot keeps the floater
 * visually distinct from any collocated agent-teams floater.
 */
export function apply(ctx) {
    const MobiusActivityPanelView = () => (_jsx(MobiusActivityPanel, { sessionsList: ctx.sessions.list }));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'mobius-activity',
        order: 79,
        label: 'Mobius workflow',
    }, MobiusActivityPanelView));
    // The in-conversation workflow card folds the durable `mobius_create`
    // tool/call + tool/result into one keyed Chat node, with an interrupt button.
    ctx.uiConversation.events.register(mobiusCardDefinition);
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'mobius',
    }, MobiusCard));
}
