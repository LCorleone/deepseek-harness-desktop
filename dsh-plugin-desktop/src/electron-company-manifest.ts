/**
 * Electron-main acquisition of the origin-mode company catalog manifest
 * (L2 TLS wiring).
 *
 * The Electron main process's global fetch is Node's undici with the bundled
 * Mozilla trust store, which ignores the Windows system certificate store —
 * on corporate-CA machines every https fetch of an internal origin fails the
 * TLS handshake before a byte arrives. Electron's `net.fetch` drives the
 * Chromium network stack, which honors the operating system's trust store
 * (and the corporate root deployed there), so the main-process origin-mode
 * boundary routes through it.
 *
 * This module is linked only from the Electron main process. The shared
 * origin-mode helpers stay Electron-free because the bundled-Node CLI child
 * also loads them (importing Electron there crashes the child), so the
 * Chromium import stays inside the function body and the redirect wrapper
 * below remains testable from Electron-free unit tests.
 *
 * Redirects stay refused in two layers: the request keeps `redirect: 'error'`
 * in its init (the shared fetch helper refuses to send anything else, and
 * Chromium rejects a redirect under that mode like undici does), and the
 * wrapper additionally rejects any response that reports it already followed
 * one — a backend that silently ignored the mode cannot weaken the
 * pinned-origin guarantee of the policy.
 */

import {
  fetchCompanyManifestText,
  type CompanyManifestFetchOptions,
} from './company-manifest-origin.ts'
import type { DesktopPolicy } from './desktop-policy.ts'
import type { UpdateChannelRequest } from './update-manifest.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/**
 * Wrap one request boundary so a followed redirect still fails the fetch.
 * @param request - the wrapped boundary (for example Electron's `net.fetch`).
 * @returns a boundary that rejects with a TypeError whenever the response
 *   reports `redirected` — the same failure shape an `redirect: 'error'`
 *   rejection produces upstream.
 */
export function refuseCompanyManifestRedirects(request: UpdateChannelRequest): UpdateChannelRequest {
  return async (url, init) => {
    const response = await request(url, init)
    if (response.redirected) {
      throw new TypeError(
        `${BIN_NAME}: refused a redirect of the company catalog manifest request to ${response.url}`,
      )
    }
    return response
  }
}

/**
 * Fetch the origin-mode manifest text through Electron's Chromium network
 * stack. Same contract as {@link fetchCompanyManifestText}: the policy stays
 * pinned to its origin, redirects are refused, and every transport, status,
 * redirect, timeout, or size failure throws for the caller's fail-closed
 * handling.
 * @param policy - origin-mode policy carrying the manifest URL and its origin.
 * @param options - fetch boundary, timeout, and body bound overrides.
 * @returns the manifest bytes as UTF-8 text, exactly as fetched.
 */
export async function fetchCompanyManifestTextOverElectronNet(
  policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  options: CompanyManifestFetchOptions = {},
): Promise<string> {
  const { net } = await import('electron')
  return await fetchCompanyManifestText(policy, {
    ...options,
    request: refuseCompanyManifestRedirects((url, init) => net.fetch(url, init)),
  })
}
