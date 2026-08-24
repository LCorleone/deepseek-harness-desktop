/**
 * Origin-mode acquisition of the signed company catalog manifest (L2 wiring).
 *
 * Origin-mode deployment policies pin a full https manifest URL inside
 * `companyCatalogOrigin`. Two Desktop consumers need those bytes without any
 * local cache: the locked terminal plugin-add gate (bundled-Node CLI child)
 * and boot verification's origin branch (Electron main process). Both share
 * this one restricted fetch — the origin stays pinned to the policy, redirects
 * are refused, the whole request is bounded to a few seconds, and the body is
 * capped like the embedded asset. Every failure throws, and both callers turn
 * the throw into their own fail-closed rejection: the CLI denies the plugin
 * add, and boot verification rejects all third-party bundles while the
 * upstream Web client keeps booting.
 *
 * The bytes are handed straight to the market signing library's
 * `verifyCompanyManifest`; the signature and trust-root binding, not the
 * transport, provide the authenticity decision.
 */

import { fetchUpdateChannelBytes, type UpdateChannelRequest } from './update-manifest.ts'
import type { DesktopPolicy } from './desktop-policy.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/** Default whole-request bound for one origin-mode manifest fetch. */
export const COMPANY_MANIFEST_FETCH_TIMEOUT_MS = 8_000
/** Default manifest body bound, mirroring the embedded asset cap (schema max ≈ 2.5 MiB). */
export const COMPANY_MANIFEST_MAX_BYTES = 4 * 1024 * 1024

/** Options for {@link fetchCompanyManifestText}. */
export interface CompanyManifestFetchOptions {
  /** Fetch-compatible request boundary; defaults to `globalThis.fetch`. */
  readonly request?: UpdateChannelRequest
  /** Whole-request timeout; defaults to {@link COMPANY_MANIFEST_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Manifest body bound; defaults to {@link COMPANY_MANIFEST_MAX_BYTES}. */
  readonly maxBytes?: number
}

const defaultRequest: UpdateChannelRequest = (url, init) => globalThis.fetch(url, init)

/**
 * Fetch the signed company manifest text from the policy-pinned origin.
 * @param policy - origin-mode policy carrying the manifest URL and its origin.
 * @param options - fetch boundary, timeout, and body bound overrides.
 * @returns the manifest bytes as UTF-8 text, exactly as fetched.
 * @throws on every transport, status, redirect, timeout, or size failure — callers fail closed.
 */
export async function fetchCompanyManifestText(
  policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  options: CompanyManifestFetchOptions = {},
): Promise<string> {
  const origin = policy.companyCatalogOrigin
  let url: URL
  try {
    url = new URL(policy.companyManifestUrl)
  } catch {
    throw new Error(`${BIN_NAME}: the company manifest URL is not a valid URL`)
  }
  if (origin === null || url.origin !== origin || url.protocol !== 'https:') {
    throw new Error(`${BIN_NAME}: the company manifest URL must stay inside the pinned https catalog origin`)
  }
  const result = await fetchUpdateChannelBytes({
    request: options.request ?? defaultRequest,
    url: url.href,
    label: 'company catalog manifest',
    maxBytes: options.maxBytes ?? COMPANY_MANIFEST_MAX_BYTES,
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? COMPANY_MANIFEST_FETCH_TIMEOUT_MS),
  })
  if (!result.ok) {
    throw new Error(`${BIN_NAME}: ${result.reason}`)
  }
  return result.bytes.toString('utf8')
}
