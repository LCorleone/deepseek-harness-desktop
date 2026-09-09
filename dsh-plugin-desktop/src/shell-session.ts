/**
 * Browser-session seeding for the native shell document.
 *
 * DSH 0.1.2 authenticates every Web index request (launch-token mint or
 * authority-bound cookie; upstream `client-connection` BrowserAuth). The
 * desktop shell window loads its renderer over that same loopback Web server,
 * so since the 0.1.2 runtime the plain renderer URL (`/?dsh-desktop-mode=…`)
 * is answered with the 401 authentication wall instead of the application —
 * the packaged DOA of #73 (renderer 30s timeout, `pluginCount 0`, a loaded
 * wall document that never boots the client Loader).
 *
 * The contract-conformant adaptation: the Host owns the process launch token
 * in-process (`ctx.connection.authenticatedUrl`), the launcher exchanges it
 * for the browser-session cookie OUT of band (a manual-redirect fetch that
 * captures the `Set-Cookie` mint), plants that cookie into the Electron
 * session jar, and only then loads the ordinary renderer URL. The desktop
 * query markers survive (no token redirect inside the window), no
 * authentication surface is weakened (the cookie is exactly what a browser
 * mint would have received), and the token never appears in any window URL.
 *
 * @module dsh-plugin-desktop/shell-session
 */

/** Cookie-jar subset of the Electron session used by the seeding flow. */
export interface ShellSessionCookieJar {
  /** Electron `session.cookies.set` compatible surface. */
  set(details: {
    url: string
    name: string
    value: string
    expirationDate?: number
    path?: string
    httpOnly?: boolean
    sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  }): Promise<void>
}

/** Fetch surface used to perform the token mint (Electron `net.fetch`). */
export type ShellSessionFetch = (url: string, init: { redirect: 'manual' }) => Promise<ResponseLike>

/** Manual-redirect response carrying the mint's `Set-Cookie` header(s). */
export interface ResponseLike {
  readonly status: number
  readonly headers: { getSetCookie?: () => string[]; get(name: string): string | null }
}

/** Parsed browser-session cookie ready for the Electron jar. */
export interface ShellSessionCookie {
  readonly name: string
  readonly value: string
  readonly path: string
  readonly httpOnly: boolean
  readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  readonly expirationDate: number | undefined
}

/**
 * Parse one `Set-Cookie` header line into Electron jar details.
 *
 * Only the attributes BrowserAuth emits are honored (`Max-Age`, `Path`,
 * `Expires`, `HttpOnly`, `SameSite`); a line without a `name=value` pair or
 * with an unparsable `Expires` is rejected so a malformed mint fails loud at
 * the caller instead of planting a half-cookie.
 * @param line - one `Set-Cookie` header value.
 * @returns the cookie details, or undefined when the line is not a cookie.
 */
export function parseShellSessionCookie(line: string): ShellSessionCookie | undefined {
  const segments = line.split(';')
  const assignment = segments[0] ?? ''
  const at = assignment.indexOf('=')
  if (at <= 0) return undefined
  const name = assignment.slice(0, at).trim()
  const value = assignment.slice(at + 1).trim()
  if (name === '' || value === '') return undefined
  let path = '/'
  let httpOnly = false
  let sameSite: ShellSessionCookie['sameSite'] = 'unspecified'
  let expires: Date | undefined
  for (const raw of segments.slice(1)) {
    const attribute = raw.trim()
    const lower = attribute.toLowerCase()
    if (lower === 'httponly') {
      httpOnly = true
      continue
    }
    const separator = attribute.indexOf('=')
    const attributeName = (separator === -1 ? attribute : attribute.slice(0, separator)).trim().toLowerCase()
    const attributeValue = separator === -1 ? '' : attribute.slice(separator + 1).trim()
    if (attributeName === 'path' && attributeValue !== '') path = attributeValue
    else if (attributeName === 'samesite') {
      if (attributeValue.toLowerCase() === 'strict') sameSite = 'strict'
      else if (attributeValue.toLowerCase() === 'lax') sameSite = 'lax'
      else if (attributeValue.toLowerCase() === 'none') sameSite = 'no_restriction'
    } else if (attributeName === 'expires') {
      const parsed = new Date(attributeValue)
      if (Number.isNaN(parsed.getTime())) return undefined
      expires = parsed
    }
  }
  return {
    name,
    value,
    path,
    httpOnly,
    sameSite,
    expirationDate: expires === undefined ? undefined : Math.floor(parsedTime(expires) / 1000),
  }
}

function parsedTime(date: Date): number {
  return date.getTime()
}

/**
 * Exchange the launcher's authenticated root URL for the browser-session
 * cookie and plant it into the Electron session jar.
 *
 * The mint request is issued with manual redirects: BrowserAuth answers the
 * token URL with `303` + `Set-Cookie`, and the first header names the
 * authority-bound session cookie. Any other outcome (network failure, a wall,
 * a missing header, an unparsable cookie) rejects, leaving the caller free to
 * surface the failure — the renderer health gate then reports the dead boot
 * instead of a silent wall.
 * @param seedUrl - authenticated root URL from `ctx.connection.authenticatedUrl`.
 * @param origin - renderer origin the cookie is scoped to.
 * @param jar - Electron session cookie jar.
 * @param fetch - manual-redirect fetch (Electron `net.fetch`).
 * @returns the planted cookie name.
 */
export async function plantShellSessionCookie(
  seedUrl: string,
  origin: string,
  jar: ShellSessionCookieJar,
  fetch: ShellSessionFetch,
): Promise<string> {
  const response = await fetch(seedUrl, { redirect: 'manual' })
  if (response.status !== 303) {
    throw new Error(`dsh-plugin-desktop: shell session mint answered HTTP ${String(response.status)} instead of the cookie redirect`)
  }
  const lines = response.headers.getSetCookie?.() ?? splitSetCookie(response.headers.get('set-cookie'))
  for (const line of lines) {
    const cookie = parseShellSessionCookie(line)
    if (cookie === undefined) continue
    await jar.set({
      url: `${origin}/`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
    })
    return cookie.name
  }
  throw new Error('dsh-plugin-desktop: shell session mint carried no parsable Set-Cookie header')
}

/** Split a comma-joined `Set-Cookie` header the way `Headers.getSetCookie` would. */
function splitSetCookie(joined: string | null): string[] {
  if (joined === null) return []
  // Expires dates carry the only legal commas in these headers.
  return joined.split(/,(?=[^;,]*=|[^;,]*$)/u).map(part => part.trim()).filter(part => part !== '')
}
