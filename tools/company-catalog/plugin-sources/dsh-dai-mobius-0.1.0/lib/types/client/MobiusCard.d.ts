/**
 * Mobius conversation card: the lightweight in-conversation summary for one
 * sequential research workflow — the workflow name, its goal, a step count,
 * and an "open activity panel" button that re-activates the top-right floater
 * (useful after it was closed, or when re-opening an old session for review).
 *
 * The card anchors to the durable `mobius_create` tool/call + tool/result fold
 * (see mobius-card-definition.ts). It holds no interrupt control here — the
 * activity panel owns the interrupt and staged-plan actions.
 * @module dsh-dai-mobius/client/card
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Window event the floater listens for to open itself with this workflow. */
export declare const OPEN_MOBIUS_PANEL_EVENT = "dsh-mobius:open-panel";
/** Complete keyed Chat renderer props. */
export type MobiusCardProps = PropsRuntime<'conversation.chat.node', 'mobius'>;
export declare function MobiusCard({ node }: MobiusCardProps): import("react").JSX.Element;
