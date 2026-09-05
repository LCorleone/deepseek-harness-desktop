/**
 * Beta catalog channel (P9): the small-area soak channel in front of the
 * stable company catalog.
 *
 * A single signed manifest is a company-wide release, so a plugin needs a
 * way to reach a few testers before it reaches everyone. The beta channel
 * reuses the entire stable trust chain — same signing key, same verifier,
 * same entry schema — and adds exactly one visibility rule: the beta
 * manifest (`catalog-manifest.beta.json`, hosted beside the stable manifest
 * on the policy-pinned origin) carries an optional top-level `testers`
 * roster of SSO emails, and a beta entry takes effect on a machine only when
 * the locally authenticated SSO identity is in that signed roster.
 *
 * There is no switch and no UI: every machine fetches the beta file on each
 * stable scan (a 404, corrupt bytes, or a failed signature silently keep the
 * machine on the stable manifest — exactly today's behavior), verifies it
 * under the deployment trust roots with the beta channel's one recognized
 * extension, and matches the roster. An unresolved identity is not a tester
 * (fail-closed). Testers need zero configuration.
 *
 * This module owns the host side of that decision:
 *
 * - {@link desktopBetaManifestUrl} derives the beta URL from the policy's
 *   stable manifest URL (same directory, `catalog-manifest.beta.json`) — the
 *   deployment policy assets stay untouched, which is the point: no client
 *   release is needed to light the channel up;
 * - {@link desktopBetaTesterEmailCandidates} projects the current SSO session
 *   into match candidates (lowercase, both domain spellings of the corporate
 *   alias — the browser login canonicalizes `@deloittecn.com.cn` to
 *   `@deloitte.com.cn` while the silent path keeps the raw UPN, so both
 *   spellings must match a roster written in either form);
 * - {@link desktopBetaTesterMatch} applies the roster rule with the same
 *   normalization on both sides;
 * - {@link resolveDesktopBetaChannelOverlay} is the resolver the desktop
 *   host hands to its three consumers — the market catalog provider (the
 *   `desktopCompanyBetaCatalog` capability), boot verification, and the
 *   tarball install channel. It fetches, verifies, and roster-checks, then
 *   returns the verified beta entries or `undefined`, and writes exactly one
 *   diagnostic line per outcome (never the roster contents, never the
 *   identity — the roster lives in a signed file the operator already owns,
 *   and the email already appears in the SSO log lines).
 *
 * The resolver never persists beta state: the anti-rollback ratchet stays
 * the stable channel's, and consumers additionally require the beta sequence
 * not to regress below the stable sequence (the publishing pipeline shares
 * one global sequence, so a published beta is always at or above stable).
 * One further in-process floor lives here (P9 review fix): the highest beta
 * sequence this session has verified — memory only, never persisted — so a
 * same-session replay of an older, previously verified beta manifest (a
 * stuck proxy, a tampered cache) is rejected like any unverified one
 * instead of walking a roster machine back to superseded beta content.
 */

import type { SsoSession } from './company-sso.ts'
import { canonicalizeSsoEmail } from './company-sso.ts'
import {
  verifyDesktopCompanyManifest,
  type DesktopCompanyManifestPackage,
} from './desktop-market.ts'
import type { DesktopPolicy } from './desktop-policy.ts'
import { fetchUpdateChannelBytes, type UpdateChannelRequest } from './update-manifest.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/** File name of the beta manifest, hosted in the stable manifest's directory. */
export const COMPANY_BETA_MANIFEST_FILENAME = 'catalog-manifest.beta.json'
/** Default whole-request bound of one beta manifest fetch (the stable manifest's bound). */
export const COMPANY_BETA_MANIFEST_FETCH_TIMEOUT_MS = 8_000
/** Default beta manifest body bound, mirroring the stable manifest cap. */
export const COMPANY_BETA_MANIFEST_MAX_BYTES = 4 * 1024 * 1024

/**
 * Derive the beta manifest URL from the stable one: the same directory, with
 * the file name replaced by `catalog-manifest.beta.json`. The derivation is
 * deliberately mechanical — the deployment pins one origin and one stable
 * manifest URL, and the beta file is hosted next to it, so the channel needs
 * no policy change and no client release.
 * @param companyManifestUrl - the policy's stable manifest URL (origin mode).
 * @returns the beta manifest URL on the same origin.
 * @throws when the stable URL is not a parseable absolute https URL.
 */
export function desktopBetaManifestUrl(companyManifestUrl: string): string {
  let url: URL
  try {
    url = new URL(companyManifestUrl)
  } catch {
    throw new TypeError(`${BIN_NAME}: the company manifest URL is not a valid URL`)
  }
  if (url.protocol !== 'https:') {
    throw new TypeError(`${BIN_NAME}: the company manifest URL must be https`)
  }
  url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}${COMPANY_BETA_MANIFEST_FILENAME}`
  return url.href
}

/**
 * The SSO identity as roster-match candidates: lowercase, deduplicated, and
 * carrying both domain spellings whenever the corporate alias rewrite
 * (`@deloittecn.com.cn` ↔ `@deloitte.com.cn`) distinguishes them — the
 * browser login stores the canonicalized spelling, the silent path stores
 * the raw UPN, and the signed roster may be written in either. A missing
 * session yields no candidates: an unresolved identity is not a tester.
 */
export function desktopBetaTesterEmailCandidates(session: SsoSession | undefined): readonly string[] {
  if (session === undefined || typeof session.email !== 'string' || session.email.length === 0) {
    return []
  }
  const candidates = new Set<string>()
  for (const email of [session.email, canonicalizeSsoEmail(session.email)]) {
    const lowered = email.trim().toLowerCase()
    if (lowered.length > 0) candidates.add(lowered)
  }
  return [...candidates]
}

/**
 * Whether one roster-match candidate is in the verified `testers` roster.
 * Both sides get the same normalization — lowercase, trim, and the corporate
 * alias rewrite — so a roster written in either domain spelling matches an
 * identity stored in either; everything else is exact-match (no substring,
 * no wildcard: a roster entry is a full email address).
 */
export function desktopBetaTesterMatch(
  testers: readonly string[],
  candidates: readonly string[],
): boolean {
  // Symmetric normalization on BOTH sides: the roster's
  // `@deloittecn.com.cn` spellings rewrite to `@deloitte.com.cn` exactly
  // like the session's raw UPN, so a roster written in either domain form
  // matches an identity stored in either — everything else is exact match.
  const normalize = (email: string): string => canonicalizeSsoEmail(email.trim()).toLowerCase()
  const roster = new Set(testers.map(normalize))
  return candidates.some(candidate => roster.has(normalize(candidate)))
}

/** A verified, roster-admitted beta overlay: the entries and their sequence. */
export interface DesktopBetaChannelOverlay {
  /** Signed entries of the verified beta manifest, revoked entries included. */
  readonly packages: readonly DesktopCompanyManifestPackage[]
  /** Sequence of the verified beta manifest (consumers floor it at the stable sequence). */
  readonly sequence: number
}

/** Why a beta resolution ended without an overlay (diagnostic categories only). */
export type DesktopBetaChannelIgnoredReason =
  | 'fetch-failed'
  | 'unverified'
  | 'stale-sequence'
  | 'no-sso-identity'
  | 'not-a-tester'

/** Options of {@link resolveDesktopBetaChannelOverlay}. */
export interface DesktopBetaChannelOptions {
  /** Deployment policy: trust roots and the pinned catalog origin. */
  readonly policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl' | 'trustRoots'>
  /** Fetch-compatible request boundary (the Electron composition injects `net.fetch`). */
  readonly request: UpdateChannelRequest
  /** Current SSO session; absent resolves to "not a tester" (fail-closed). */
  readonly session?: SsoSession
  /** Caller cancellation folded into the whole-request bound. */
  readonly signal?: AbortSignal
  /** Whole-request timeout; defaults to {@link COMPANY_BETA_MANIFEST_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Manifest body bound; defaults to {@link COMPANY_BETA_MANIFEST_MAX_BYTES}. */
  readonly maxBytes?: number
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /** Diagnostic sink receiving exactly one line per outcome. */
  readonly log?: (message: string) => void
}

const defaultRequest: UpdateChannelRequest = (url, init) => globalThis.fetch(url, init)

/**
 * The highest beta manifest sequence this process has verified (P9 review
 * fix). Module memory only — deliberately NOT persisted (the stable
 * channel's receipts ratchet stays the only durable anti-rollback bound),
 * because the threat here is same-session replay, not a restart. Every
 * subsequent verification requires `sequence >= ` this floor; the equal case
 * is the steady state (each scan re-fetches the same publication).
 */
let highestVerifiedBetaSequence = 0

/**
 * Mask email-shaped literals in a diagnostic detail before it reaches a log
 * line (P9 review fix): verification reasons may quote a roster entry
 * verbatim — the duplicate-roster rejection embeds the address — and the log
 * contract is that roster contents and identities never appear. The address
 * survives as `***@domain` for the operator's orientation; the pipeline side
 * keeps its full error text for the publishing workflow, which is the right
 * place to see the literal.
 */
const maskEmailLiterals = (text: string): string =>
  text.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/gu, email => `***@${email.slice(email.lastIndexOf('@') + 1)}`)

/**
 * Resolve the beta channel overlay for one consumer call: fetch the beta
 * manifest from the derived policy-pinned URL, verify it end to end under
 * the deployment trust roots with the beta channel schema (the one
 * recognized extension being the `testers` roster), and admit it only when
 * the current SSO identity matches the signed roster. Every other outcome —
 * transport failure, a non-200 answer (a 404 is the channel simply not
 * being used yet), any verification failure (corrupt bytes, a bad
 * signature, a malformed roster, expiry), a beta sequence below the
 * highest this session verified (a same-session replay), no authenticated
 * identity, or a roster miss — returns `undefined`: the caller keeps the
 * stable manifest alone, exactly today's behavior. Never throws for
 * business outcomes; caller cancellation propagates like on every other
 * fetch boundary.
 */
export async function resolveDesktopBetaChannelOverlay(
  options: DesktopBetaChannelOptions,
): Promise<DesktopBetaChannelOverlay | undefined> {
  const candidates = desktopBetaTesterEmailCandidates(options.session)
  const ignored = (reason: DesktopBetaChannelIgnoredReason, detail?: string): undefined => {
    options.log?.(`${BIN_NAME}: beta catalog ignored (${reason}${detail === undefined ? '' : `: ${detail}`})`)
    return undefined
  }
  const betaUrl = desktopBetaManifestUrl(options.policy.companyManifestUrl)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? COMPANY_BETA_MANIFEST_FETCH_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let bytes: Buffer
  try {
    const result = await fetchUpdateChannelBytes({
      request: options.request ?? defaultRequest,
      url: betaUrl,
      label: 'beta company catalog manifest',
      maxBytes: options.maxBytes ?? COMPANY_BETA_MANIFEST_MAX_BYTES,
      redirect: 'error',
      signal,
    })
    if (!result.ok) return ignored('fetch-failed')
    bytes = result.bytes
  } catch (cause) {
    // fetchUpdateChannelBytes maps transport failures to result values and
    // rethrows caller cancellation as the original abort failure — anything
    // reaching this catch is either that cancellation (propagated) or an
    // unexpected boundary error (the beta channel is best-effort: ignore).
    if (options.signal?.aborted === true) throw cause
    return ignored('fetch-failed')
  }
  const verification = verifyDesktopCompanyManifest(bytes, {
    trustRoots: options.policy.trustRoots,
    companyCatalogOrigin: options.policy.companyCatalogOrigin,
    channel: 'beta',
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (!verification.ok) {
    return ignored('unverified', maskEmailLiterals(`${verification.code}: ${verification.reason}`).slice(0, 200))
  }
  if (verification.manifest.sequence < highestVerifiedBetaSequence) {
    return ignored(
      'stale-sequence',
      `beta sequence ${String(verification.manifest.sequence)} is below the highest verified this session (${String(highestVerifiedBetaSequence)}) — treated as a replay`,
    )
  }
  highestVerifiedBetaSequence = verification.manifest.sequence
  if (candidates.length === 0) return ignored('no-sso-identity')
  const testers = verification.manifest.testers ?? []
  if (!desktopBetaTesterMatch(testers, candidates)) return ignored('not-a-tester')
  options.log?.(
    `${BIN_NAME}: beta catalog applied (sequence ${String(verification.manifest.sequence)}, `
      + `${String(verification.manifest.packages.length)} entries, ${String(testers.length)} testers)`,
  )
  return {
    packages: verification.manifest.packages,
    sequence: verification.manifest.sequence,
  }
}
