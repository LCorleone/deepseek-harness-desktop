/**
 * Transient-vs-permanent classification of a failed install preview or
 * install execution, judged purely from the failure shape the Client
 * observed (#048).
 *
 * The input is the thrown value that reaches the item modal — a
 * {@link MarketApiError} carrying the HTTP status, the Host's safe
 * `reasonCode` vocabulary, and the surfaced message tail — or the Client's
 * own deadline error (`operation-timeout`). Nothing Host-private is
 * consulted, so the classifier stays pure and testable.
 *
 * The classification is deliberately conservative: an unrecognized shape is
 * NOT transient. Offering "Retry" on a deterministic refusal (missing
 * target, integrity or policy refusal, an expired intent) misleads more
 * than it helps, while withholding it on a rare misclassified jitter only
 * costs the user one manual re-open of the item.
 *
 * | reasonCode / shape                                  | transient | why |
 * | --------------------------------------------------- | --------- | --- |
 * | `operation-timeout` (Client deadline, HTTP 408)      | yes       | the deadline class — the Host never answered in time |
 * | `operation-failed` + network-signature message tail  | yes       | npm/pnpm transport jitter: reset connections, DNS retry, registry fetch failures, registry 5xx, timeouts |
 * | `operation-failed` without a network signature       | no        | profile/policy/service unavailability, cancelled generations, non-network package-manager stderr |
 * | `not-available` (404)                                | no        | the verified target is genuinely absent |
 * | `conflict` (409)                                     | no        | state the user must reconcile first |
 * | `intent-expired` (410)                               | no        | a spent confirmation is not a network fact |
 * | `verification-failed` (422)                          | no        | integrity/policy refusals — and even the registry-fetch failure inside verification is ambiguous with a genuinely missing package, so it stays conservative |
 * | `client-update-required` (422)                       | no        | a runtime-window refusal the client must act on |
 * | `persistence-failed` (500)                           | no        | local receipt-store failure |
 * | `operation-failed` from an unexpected Host error (500) | no      | the generic wrapper message carries no network signature |
 * | anything else (no reasonCode, plain `Error`, …)      | no        | UNKNOWN — judged unclassifiable, therefore not transient |
 */

import type { MarketApiError } from './api.js'

/**
 * Network-transport signatures that mark an `operation-failed` tail as
 * transient. Deliberately narrow: exact Node/undici/pnpm error tokens and
 * the plain-English "timed out" / "socket hang up" phrases their stderr
 * tails carry. A 404 from the registry (a genuinely missing target), auth
 * failures, TLS misconfigurations, and DNS `ENOTFOUND` (an authoritative
 * answer, unlike the temporary `EAI_AGAIN`) are all intentionally absent.
 */
const TRANSIENT_NETWORK_FAILURE_PATTERN = new RegExp([
  '\\b(?:ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN)\\b',
  '\\b(?:UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|ERR_SOCKET_TIMEOUT)\\b',
  '\\bERR_PNPM_META_FETCH_FAIL\\b',
  '\\bERR_PNPM_FETCH_5\\d\\d\\b',
  '\\bsocket hang up\\b',
  '\\btimed out\\b',
].join('|'), 'iu')

/** Whether a failed install preview/execution looks transient enough to offer a retry. */
export function isTransientInstallFailure(cause: unknown): boolean {
  if (cause === null || typeof cause !== 'object' || !('code' in cause)) return false
  const { code, message } = cause as Pick<MarketApiError, 'code' | 'message'>
  if (typeof code !== 'string' || code.length === 0) return false
  // The Client-side deadline: the Host never answered within the operation
  // bound — the canonical timeout class.
  if (code === 'operation-timeout') return true
  // The package-manager leg is where npm registry jitter surfaces: its
  // MarketInstallError carries the pnpm stderr tail, so the network
  // signatures above decide. Every other first-party reasonCode is a
  // deterministic refusal and stays non-transient.
  if (code !== 'operation-failed') return false
  return typeof message === 'string' && TRANSIENT_NETWORK_FAILURE_PATTERN.test(message)
}
