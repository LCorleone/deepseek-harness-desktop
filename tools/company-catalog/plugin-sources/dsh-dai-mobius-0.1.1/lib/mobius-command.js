import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const MOBIUS_COMMAND = 'mobius';
const GESTURE = /^\/mobius(?=$|[\t\n\r ])/u;
/** Extract the goal text that follows the `/mobius` gesture, if any. */
export function parseMobiusGoal(text) {
    const trimmed = text.trimStart();
    if (!GESTURE.test(trimmed))
        return '';
    const rest = trimmed.slice(MOBIUS_COMMAND.length + 1);
    return rest.trim();
}
/**
 * Register the `/mobius` slash command so it appears in the command list.
 * When the user supplies a goal, the handler replays it as a plain user
 * message prefixed with the Mobius activation phrase — the Mobius usage
 * system prompt already routes that into `mobius_create`, so the captain
 * stages a research workflow for review.
 */
export function registerMobiusCommand(ctx) {
    ctx.effect(() => {
        const dispose = ctx.commands.register({
            name: MOBIUS_COMMAND,
            description: 'run a sequential research/analysis workflow (Mobius)',
            input: { hint: '<目标>' },
            handler(invocation) {
                const goal = invocation.rawInput.trim();
                invocation.agent.followup(createUserMessage({
                    content: [{ type: 'text', text: goal === ''
                                ? '/mobius 已激活 —— 请用 Mobius 顺序研究工作流处理用户接下来的请求。'
                                : `请用 Mobius 顺序研究工作流执行这个目标：${goal}` }],
                    source: { kind: 'user' },
                }));
                return {
                    kind: 'success',
                    text: goal === ''
                        ? 'Mobius 已激活，等待目标。'
                        : `Mobius 已激活，将用顺序研究工作流执行：「${goal}」`,
                };
            },
        });
        return () => { dispose(); };
    }, 'dsh-mobius: slash command');
}
