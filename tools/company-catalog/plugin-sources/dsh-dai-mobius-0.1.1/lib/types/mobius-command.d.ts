import type { Context } from '@deepseek-ai/cordis';
export declare const MOBIUS_COMMAND = "mobius";
/** Extract the goal text that follows the `/mobius` gesture, if any. */
export declare function parseMobiusGoal(text: string): string;
/**
 * Register the `/mobius` slash command so it appears in the command list.
 * When the user supplies a goal, the handler replays it as a plain user
 * message prefixed with the Mobius activation phrase — the Mobius usage
 * system prompt already routes that into `mobius_create`, so the captain
 * stages a research workflow for review.
 */
export declare function registerMobiusCommand(ctx: Context): void;
