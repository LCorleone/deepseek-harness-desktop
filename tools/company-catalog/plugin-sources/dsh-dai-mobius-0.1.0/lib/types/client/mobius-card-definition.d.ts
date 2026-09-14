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
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
/** Final keyed Chat payload for the workflow summary card. */
export interface MobiusCardData {
    readonly workflowId: string;
    /** The captain session that owns this workflow (card follows it). */
    readonly captainSessionId: string;
    readonly name: string;
    readonly goal: string;
    readonly steps: number;
}
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
    interface ChatNodeDataMap {
        /** Lightweight workflow summary card anchoring the conversation. */
        'mobius': MobiusCardData;
    }
}
/** Folded workflow record (the node's business state). */
export interface MobiusNodeState {
    readonly workflowId: string;
    readonly name: string;
    readonly goal: string;
    readonly steps: number;
    readonly accepted: boolean;
}
/** Parse the only create-call fields the card owns. */
export declare function parseMobiusCreateArgs(value: string): {
    workflowId: string;
    name: string;
    goal: string;
    steps: number;
} | undefined;
/** Durable first-party tool events folded into one keyed Chat node. */
export declare const mobiusCardDefinition: ConversationNodeDefinition<MobiusNodeState>;
