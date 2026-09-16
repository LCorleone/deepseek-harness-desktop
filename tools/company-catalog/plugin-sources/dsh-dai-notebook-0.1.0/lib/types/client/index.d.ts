/**
 * Browser plugin for the DAI notebook capsule.
 *
 * Registers a single shell-overlay floater: a global floating capsule that
 * expands into a lightweight notes/tasks panel. Everything persists through
 * the host HTTP routes so the capsule shares the notebook with the notebook_*
 * chat tools.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
/** Required services: slots and sessions. */
export declare const inject: string[];
/**
 * Register the notebook capsule in the shell's additive overlay. It is a
 * single always-available floating entry, visually distinct from any
 * collocated agent-teams / mobius panels.
 */
export declare function apply(ctx: ClientContext): void;
