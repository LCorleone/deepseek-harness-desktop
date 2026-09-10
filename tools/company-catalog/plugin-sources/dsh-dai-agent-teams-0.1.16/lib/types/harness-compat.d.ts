/**
 * The audited Harness 0.1.2 subagent boundary. Keep version-specific shapes
 * here: API presence alone is not a promise of support for future versions.
 *
 * Alpha.2 owns followup/registerContinuableSetup; Alpha.5 and rc.1 own a
 * host-only FIFO queue and synchronous agent/session-start. Their public
 * sendMessage instead steers a running Agent and must never carry team jobs.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
type Setup = (childCtx: Context) => () => void;
/** Read child-owned history, excluding any descriptor inherited from a parent. */
export declare function sessionOwnEvents(session: Session): readonly SessionEvent[];
/** Install before the first request, including cold resume, with HMR cleanup. */
export declare function installContinuableMemberSetup(ctx: Context, setup: Setup): void;
/** Queue a distinct host-authored turn; never substitute model-message steer. */
export declare function queueMemberPrompt(runtime: Context['subagents'], parent: Agent, childId: SessionId, content: ContentBlock[], signal: AbortSignal): Promise<MessageId>;
/** Guard all resumable delivery paths, preserving the native service receiver. */
export declare function guardSubagentDelivery(ctx: Context, isRetired: (sender: Agent, targetId: SessionId) => Promise<boolean>): void;
export {};
