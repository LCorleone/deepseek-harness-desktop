/**
 * Browser plugin for the Mobius activity floater and in-conversation card.
 *
 * Registers a single shell-overlay floater that shows every sequential
 * research workflow for the current session: ordered steps, per-step status
 * and output, phase, and the接力 (relay) chain. It also registers a compact
 * conversation card whenever a `mobius_create` workflow is staged, with an
 * interrupt button to stop a running pipeline from the chat.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services: conversation nodes, slots, and sessions. */
export declare const inject: string[];
/**
 * Register the Mobius activity monitor in the shell's additive overlay and the
 * in-conversation workflow card. A separate overlay slot keeps the floater
 * visually distinct from any collocated agent-teams floater.
 */
export declare function apply(ctx: ClientContext): void;
