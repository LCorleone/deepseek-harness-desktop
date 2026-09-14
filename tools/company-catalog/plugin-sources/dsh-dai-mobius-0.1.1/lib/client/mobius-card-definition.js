/**
 * Mobius conversation card: a lightweight in-conversation summary shown when a
 * sequential research workflow is created — the workflow name, its goal, a
 * step count, and an interrupt button to stop a running pipeline from the chat.
 *
 * The fold anchors to the Harness's durable `tool/call` + `tool/result`
 * records for `mobius_create`. Those are first-party session events, so the
 * card survives restarts without writing an out-of-repo event type (it mirrors
 * the agent-teams card, which anchors on `agent_teams_create`).
 * @module dsh-dai-mobius/client/card
 */
/** Parse the only create-call fields the card owns. */
export function parseMobiusCreateArgs(value) {
    try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'object' || parsed === null || !('name' in parsed) || typeof parsed.name !== 'string') {
            return undefined;
        }
        const name = parsed.name.trim();
        if (name === '')
            return undefined;
        const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const goal = 'goal' in parsed && typeof parsed.goal === 'string' ? parsed.goal.trim() : '';
        const steps = 'steps' in parsed && Array.isArray(parsed.steps) ? parsed.steps.length : 0;
        if (steps === 0)
            return undefined;
        return { workflowId: cleaned === '' ? 'workflow' : cleaned, name, goal, steps };
    }
    catch {
        return undefined;
    }
}
/** Durable first-party tool events folded into one keyed Chat node. */
export const mobiusCardDefinition = {
    kind: 'mobius',
    target: 'chat',
    match: (event) => {
        if (event.type === 'tool/call' && event.data.name === 'mobius_create') {
            return parseMobiusCreateArgs(event.data.arguments) === undefined
                ? null
                : { id: String(event.data.callId), role: 'start' };
        }
        if (event.type === 'tool/result' && event.data.message.source.kind === 'tool') {
            return { id: String(event.data.message.source.callId), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'tool/call') {
            throw new Error('mobius card start requires mobius_create tool/call');
        }
        const parsed = parseMobiusCreateArgs(match.event.data.arguments);
        if (parsed === undefined)
            throw new Error('mobius card start requires valid create arguments');
        return { ...parsed, accepted: false };
    },
    update: (context, match) => {
        if (match.event.type !== 'tool/result')
            return context.state;
        const failed = match.event.data.error !== undefined
            || match.event.data.message.content.some((block) => block.type === 'tool-result' && block.isError === true);
        if (failed)
            return context.state;
        return { ...context.state, accepted: true };
    },
    buildViewNode: (context) => {
        if (context.start === undefined)
            return null;
        const state = context.state;
        if (!state.accepted)
            return null;
        return {
            key: context.key,
            kind: 'mobius',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: 'visible',
            data: {
                workflowId: state.workflowId,
                captainSessionId: '',
                name: state.name,
                goal: state.goal,
                steps: state.steps,
            },
        };
    },
};
