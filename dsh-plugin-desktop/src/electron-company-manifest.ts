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
 * Redirects are refused by the request's `redirect: 'error'` init: Chromium's
 * network stack honors that mode and fails the request when the origin answers
 * with a redirect (verified on Electron 43.4.0 — the `ClientRequest` redirect
 * event dies the request and `net.fetch` rejects, exactly like undici). This
 * is the single layer the pinned-origin guarantee rests on, so an Electron
 * upgrade must re-verify it (see tests/electron-company-manifest.spec.ts).
 * The wrapper below additionally inspects `response.redirected` as a purely
 * defensive second layer: Electron 43.4.0's `net.fetch` Responses never carry
 * the redirect flag (the underlying Response carries no URL list; upstream
 * PR electron#44725 would change that and is not merged), so that check
 * cannot fire on the current boundary — it exists so a future Electron that
 * starts reporting `redirected` is still refused instead of silently
 * weakening the policy's pinned-origin guarantee.
 *
 * This module is linked only from the Electron main process. The shared
 * origin-mode helpers stay Electron-free because the bundled-Node CLI child
 * also loads them (importing Electron there crashes the child), so the
 * Chromium import stays inside the function body and the redirect wrapper
 * below remains testable from Electron-free unit tests.
 */

import {
  fetchCompanyManifestText,
  type CompanyManifestFetchOptions,
} from './company-manifest-origin.ts'
import type { DesktopPolicy } from './desktop-policy.ts'
import type { UpdateChannelRequest } from './update-manifest.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/**
 * Wrap one request boundary so a response that reports a followed redirect
 * still fails the fetch.
 *
 * Defensive second layer only — see the module doc: on Electron 43.4.0 the
 * Chromium boundary never sets `redirected`, so today the refusal comes
 * solely from the request's `redirect: 'error'` init. If a later Electron
 * starts populating the flag, this wrapper keeps the refusal explicit.
 * @param request - the wrapped boundary (for example Electron's `net.fetch`).
 * @returns a boundary that rejects with a TypeError whenever the response
 *   reports `redirected` — the same failure shape a `redirect: 'error'`
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

/**
 * Structural mirror of the market catalog HTTP client interface
 * (`CatalogHttpClient` in `dsh-community-market/src/contracts/types.ts`) the
 * Desktop host injects for origin-mode manifest fetches. The market package
 * defines the contract and never imports Desktop code; this local mirror
 * keeps the two declarations in sync the same way `market-signing-types.ts`
 * does for the signing surface.
 */
export interface CompanyCatalogHttpClient {
  getJson(
    url: string,
    signal: AbortSignal,
    policy?: { readonly allowedOrigin?: string },
  ): Promise<{ readonly value: unknown; readonly finalUrl: string }>
}

/** Options for {@link companyCatalogHttpOverElectronNet}. */
export interface CompanyCatalogHttpOptions {
  /** Chromium-stack fetch boundary; defaults to Electron's `net.fetch` (injectable for tests). */
  readonly request?: UpdateChannelRequest
  /** Whole-request timeout override; defaults to the shared 8 s manifest bound. */
  readonly timeoutMs?: number
  /** Manifest body bound override; defaults to the shared 4 MiB manifest cap. */
  readonly maxBytes?: number
}

/**
 * The Desktop host's origin-mode catalog HTTP client for the locked market:
 * the main process provides it to the community-market host plugin (the
 * `desktopCompanyCatalogHttp` capability), whose portable restricted client
 * cannot reach internal GitLab hosting — the pinned origin resolves into the
 * private network its blocklist refuses by design, and Node's `https` does
 * not trust the corporate CA. Every fetch rides the same Chromium boundary as
 * boot verification ({@link fetchCompanyManifestTextOverElectronNet}), so the
 * restricted client's guarantees for this one policy-pinned URL are carried
 * over unchanged: the URL never leaves the policy-pinned origin (checked
 * here, again by the shared fetch helper, and the caller's `allowedOrigin`
 * policy is honored), redirects are refused, the body is capped, and the
 * whole request is time-bounded. Anything else this client is asked to fetch
 * is refused outright. The trust decision still belongs to the market's
 * signature gate over the returned bytes.
 */
export function companyCatalogHttpOverElectronNet(
  policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  options: CompanyCatalogHttpOptions = {},
): CompanyCatalogHttpClient {
  const request: UpdateChannelRequest = options.request ?? (async (url, init) => {
    const { net } = await import('electron')
    return await net.fetch(url, init)
  })
  return {
    async getJson(url, signal, httpRequestPolicy = {}) {
      if (url !== policy.companyManifestUrl) {
        throw new Error(`${BIN_NAME}: the company catalog HTTP client only serves the policy-pinned manifest URL`)
      }
      if (httpRequestPolicy.allowedOrigin !== undefined
        && httpRequestPolicy.allowedOrigin !== policy.companyCatalogOrigin) {
        throw new Error(`${BIN_NAME}: refused a company catalog request pinned outside the policy catalog origin`)
      }
      signal.throwIfAborted()
      const text = await fetchCompanyManifestText(policy, {
        request: refuseCompanyManifestRedirects((requestUrl, init) => request(requestUrl, {
          ...init,
          // Fold the caller's cancellation into the shared whole-request
          // bound so an abandoned market scan stops the Chromium fetch too.
          ...(init.signal == null ? {} : { signal: AbortSignal.any([init.signal, signal]) }),
        })),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      })
      let value: unknown
      try {
        value = JSON.parse(text) as unknown
      } catch {
        throw new Error(`${BIN_NAME}: the company catalog manifest did not decode as JSON`)
      }
      return { value, finalUrl: url }
    },
  }
}
