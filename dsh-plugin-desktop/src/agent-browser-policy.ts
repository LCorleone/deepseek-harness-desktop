/**
 * Agent-browser URL policy (design §5.5): the pure decision helpers behind
 * every enforcement point, plus the report lines those points record.
 *
 * Enforcement points (all B4):
 *
 * - the tool-level pre-commit gate (`browser_open`/`browser_navigate`,
 *   applied in the host plugin before the executor is touched);
 * - the guest webContents' `will-navigate` (renderer-initiated main-frame
 *   navigation — link clicks, form submissions, `location.assign` timers)
 *   and `will-redirect` (each server-side 30x hop; `preventDefault` there
 *   cancels the NAVIGATION, not merely the hop, so an off-allowlist chain
 *   is broken before the target origin receives a request) — both
 *   pre-commit, both installed by the session on the guest;
 * - `Page.frameNavigated` stays as the post-commit BACKSTOP: it fires after
 *   commit, when the target may already have run script, so it never blocks
 *   — it only surfaces a violation (double insurance for anything that
 *   slipped the pre-commit points).
 *
 * Stated boundary: the allowlist governs the MAIN FRAME only — iframes and
 * subresources may still reach non-allowlisted origins; in-page data
 * exfiltration is page behavior, outside navigation policy's scope (the
 * same sentence ships in the model-facing prompt section).
 *
 * Deny, not ask: when an allowlist is configured (non-`'*'`), an
 * off-allowlist navigation is denied outright; `ask` applies only to
 * allowlisted-but-cross-origin transitions through the tool-level §5.1
 * approval seam.
 *
 * @module dsh-plugin-desktop/agent-browser-policy
 */

import type { DesktopPolicyAgentBrowser } from './desktop-policy.ts'

/**
 * Whether one navigation target passes the policy allowlist.
 *
 * `'*'` (the dev default) admits every *origin* (http/https), never every
 * scheme: file:/data:/javascript: fail even under `['*']` (B2 review P1).
 */
export function agentBrowserAllowsUrl(url: string, policy: DesktopPolicyAgentBrowser): boolean {
  if (policy.allowOrigins.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (policy.allowOrigins.includes('*')) return true
  return policy.allowOrigins.includes(parsed.origin)
}

/** Deny text for a disallowed navigation; names the policy, not the list. */
export function agentBrowserDeniedMessage(url: string): string {
  return 'the agent browser policy does not allow navigating to '
    + `${url}; ask the operator to extend the allowlist or use claimControl for this site`
}

/** Which pre-commit enforcement point denied a guest navigation (§5.5). */
export type AgentBrowserNavigationGuardKind = 'will-navigate' | 'will-redirect'

/**
 * Report line for one pre-commit guest-navigation denial (§5.5). Recorded as
 * a session policy notice and written to the desktop log; the log sinks run
 * every line through `mask-secrets`, so a token-shaped query value in the
 * URL cannot survive into the log file.
 */
export function agentBrowserNavigationDeniedNotice(
  kind: AgentBrowserNavigationGuardKind,
  url: string,
): string {
  const point = kind === 'will-navigate'
    ? 'a renderer-initiated navigation (will-navigate)'
    : 'a server-side redirect chain (will-redirect; the whole navigation was cancelled)'
  return `blocked ${point} to ${url} — outside the agent browser allowlist`
}

/**
 * Report line for the post-commit backstop (§5.5): the navigation already
 * committed, so this only surfaces the violation for the operator and the
 * model-facing policy notices.
 */
export function agentBrowserNavigationBackstopNotice(url: string): string {
  return `a navigation committed to ${url} which is outside the agent browser allowlist (post-commit backstop; the page may already have run script)`
}

/**
 * Report line for one cancelled download (§5.1: v1 cancels outright and
 * reports — a pre-ask remains a possible later refinement).
 *
 * `.crdownload` residue: Chromium may already have flushed partial bytes
 * before the cancel, so an inert `<name>.crdownload` temp file can remain —
 * residual temp cleanup, not a persistence mechanism.
 */
export function agentBrowserDownloadCancelledNotice(url: string, filename: string): string {
  return `cancelled a page-initiated download of ${filename} from ${url} — downloads are not permitted in this version`
}
