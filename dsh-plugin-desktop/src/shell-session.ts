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
 * The fix rides the upstream desktop v2.0.5 `authenticateRendererSession`
 * semantics (consulted, not vendored — our 0.1.2-rc.1 runtime carries no
 * `desktopBrowserAccess.rendererHeader` seam, so the process token stays in
 * the `authenticatedUrl` query our `connection` service mints): the
 * window's own Electron session performs one ordinary fetch of the
 * authenticated root with `redirect: 'follow'` and
 * `credentials: 'include'`. BrowserAuth answers the token URL with
 * `303` + `Set-Cookie`; Chromium's network stack walks the redirect, stores
 * the authority-bound cookie straight into that session's cookie jar, and
 * re-requests the clean root — the final response must be the `200`
 * application document. The renderer then loads the ordinary desktop URL
 * through the same session, query markers intact, no gate weakened, and the
 * token never appears in any window URL.
 *
 * Transport note (why `session.fetch` and not `net.fetch` with
 * `redirect: 'manual'`, the #73 review P0): Electron's net-fetch rejects a
 * manual-redirect 303 outright (`Redirect was cancelled`, electron#43715,
 * closed NOT_PLANNED — v43 carries no handling), so the manual mint could
 * never run in the Electron main process. `session.fetch` never touches the
 * manual-redirect surface at all, and `credentials: 'include'` binds the
 * cookie to the exact session the renderer will load through
 * (`webContents.session`), not a hand-planted `defaultSession` jar entry.
 *
 * @module dsh-plugin-desktop/shell-session
 */

/** Session surface used by the seeding flow (Electron `Session.fetch`). */
export interface ShellRendererSession {
  /** Electron `Session.fetch` compatible surface (Chromium network stack). */
  fetch(url: string, init: ShellRendererSessionFetchInit): Promise<ShellRendererSessionResponse>
}

/** Fetch init the seeding flow issues (the upstream v2.0.5 exact shape). */
export interface ShellRendererSessionFetchInit {
  readonly method: 'GET'
  /** Store/forward this session's cookies — the mint's Set-Cookie lands in the jar. */
  readonly credentials: 'include'
  /** Let Chromium walk the 303 mint to the clean root. */
  readonly redirect: 'follow'
  readonly cache: 'no-store'
}

/** Follow-redirect response the authenticated root must answer with. */
export interface ShellRendererSessionResponse {
  readonly status: number
  readonly body?: { cancel(): Promise<unknown> } | null
}

/**
 * Exchange the launcher's authenticated root URL for the browser-session
 * cookie inside the window's own Electron session.
 *
 * One `session.fetch` of {@link seedUrl} with the upstream init: the 303
 * mint's `Set-Cookie` is stored by Chromium into the session jar
 * (`credentials: 'include'`), the redirect is followed to the clean root,
 * and any final status other than 200 (a wall, a dead server, a redirect
 * loop) rejects for the caller's degradation handling — the renderer health
 * gate then reports the dead boot instead of a silent wall.
 * @param seedUrl - authenticated root URL from `ctx.connection.authenticatedUrl`.
 * @param session - the shell window's Electron session (`webContents.session`).
 */
export async function authenticateRendererSession(
  seedUrl: string,
  session: ShellRendererSession,
): Promise<void> {
  const authenticated = await session.fetch(seedUrl, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
  })
  await authenticated.body?.cancel()
  if (authenticated.status !== 200) {
    throw new Error(
      `dsh-plugin-desktop: shell browser-session authentication answered HTTP ${String(authenticated.status)} instead of the application document`,
    )
  }
}
