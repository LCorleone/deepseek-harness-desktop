import { describe, expect, it, vi } from 'vitest'
import {
  authenticateRendererSession,
  type ShellRendererSession,
  type ShellRendererSessionResponse,
} from '../src/shell-session.ts'

function sessionWith(
  respond: (url: string, init: unknown) => Promise<ShellRendererSessionResponse>,
): ShellRendererSession & { fetch: ReturnType<typeof vi.fn> } {
  return { fetch: vi.fn(respond) }
}

describe('authenticateRendererSession', () => {
  it('rides the window session through the follow-redirect mint (upstream v2.0.5 init)', async () => {
    const session = sessionWith(async () => ({
      status: 200,
      body: { cancel: vi.fn(async () => undefined) },
    }))

    await authenticateRendererSession('http://127.0.0.1:43120/?token=launch', session)

    // The exact upstream init: the 303 mint is walked by Chromium and the
    // Set-Cookie lands in THIS session's jar (credentials include) — the
    // manual-redirect surface Electron net-fetch cannot serve (electron#43715)
    // is never touched.
    expect(session.fetch.mock.calls[0]?.[1]).toEqual({
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
    })
  })

  it('cancels the authenticated body without reading it', async () => {
    const cancel = vi.fn(async () => undefined)
    const session = sessionWith(async () => ({ status: 200, body: { cancel } }))

    await authenticateRendererSession('http://127.0.0.1:43120/?token=launch', session)

    expect(cancel).toHaveBeenCalledOnce()
  })

  it('fails loud on an authentication wall instead of loading it silently', async () => {
    const session = sessionWith(async () => ({ status: 401, body: null }))

    await expect(authenticateRendererSession('http://127.0.0.1:43120/?token=stale', session))
      .rejects.toThrow('answered HTTP 401')
  })

  it('fails loud on any other non-application outcome', async () => {
    const session = sessionWith(async () => ({ status: 307, body: null }))

    await expect(authenticateRendererSession('http://127.0.0.1:43120/?token=launch', session))
      .rejects.toThrow('answered HTTP 307')
  })

  it('propagates transport failures (the dead-server shape) to the caller', async () => {
    const session = sessionWith(async () => {
      throw new Error('Redirect was cancelled')
    })

    await expect(authenticateRendererSession('http://127.0.0.1:43120/?token=launch', session))
      .rejects.toThrow('Redirect was cancelled')
  })
})
