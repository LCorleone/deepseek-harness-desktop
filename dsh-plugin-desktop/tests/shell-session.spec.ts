import { describe, expect, it } from 'vitest'
import {
  parseShellSessionCookie,
  plantShellSessionCookie,
  type ShellSessionCookieJar,
} from '../src/shell-session.ts'

function mintResponse(setCookie: string[] | string | null): Response {
  return new Response(null, {
    status: 303,
    headers: { 'set-cookie': Array.isArray(setCookie) ? setCookie.join(', ') : String(setCookie) },
  }) as Response & { headers: { getSetCookie?: () => string[] } }
}

describe('parseShellSessionCookie', () => {
  it('parses the BrowserAuth mint line with every emitted attribute', () => {
    const expires = new Date('Wed, 09 Sep 2026 12:00:00 GMT')
    const cookie = parseShellSessionCookie(
      `dsh-auth-abc=v1.eyJ2ZXJzaW9uIjoxfQ.sig; Max-Age=2592000; Path=/; Expires=${expires.toUTCString()}; HttpOnly; SameSite=Strict`,
    )
    expect(cookie).toEqual({
      name: 'dsh-auth-abc',
      value: 'v1.eyJ2ZXJzaW9uIjoxfQ.sig',
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Math.floor(expires.getTime() / 1000),
    })
  })

  it('rejects lines without a parsable pair or date', () => {
    expect(parseShellSessionCookie('novalue')).toBeUndefined()
    expect(parseShellSessionCookie('=value')).toBeUndefined()
    expect(parseShellSessionCookie('a=b; Expires=not-a-date')).toBeUndefined()
  })
})

describe('plantShellSessionCookie', () => {
  function recordingJar(): ShellSessionCookieJar & { planted: unknown[] } {
    const planted: unknown[] = []
    return {
      planted,
      async set(details) { planted.push(details) },
    }
  }

  it('exchanges the seed URL for a planted authority cookie', async () => {
    const jar = recordingJar()
    const name = await plantShellSessionCookie(
      'http://127.0.0.1:43120/?token=launch',
      'http://127.0.0.1:43120',
      jar,
      async () => mintResponse(['dsh-auth-x=v1.payload.sig; Path=/; Expires=Fri, 09 Oct 2026 00:00:00 GMT; HttpOnly; SameSite=Strict']),
    )
    expect(name).toBe('dsh-auth-x')
    expect(jar.planted).toEqual([{
      url: 'http://127.0.0.1:43120/',
      name: 'dsh-auth-x',
      value: 'v1.payload.sig',
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Math.floor(new Date('Fri, 09 Oct 2026 00:00:00 GMT').getTime() / 1000),
    }])
  })

  it('uses the raw header when getSetCookie is unavailable', async () => {
    const jar = recordingJar()
    const response = {
      status: 303,
      headers: {
        get: (name: string) => name.toLowerCase() === 'set-cookie'
          ? 'dsh-auth-y=v1.p.s; Path=/; HttpOnly; SameSite=Strict'
          : null,
      },
    }
    const name = await plantShellSessionCookie(
      'http://127.0.0.1:43120/?token=launch',
      'http://127.0.0.1:43120',
      jar,
      async () => response,
    )
    expect(name).toBe('dsh-auth-y')
    expect(jar.planted[0]).toMatchObject({ name: 'dsh-auth-y', httpOnly: true, sameSite: 'strict' })
  })

  it('fails loud on an authentication wall instead of planting nothing silently', async () => {
    const jar = recordingJar()
    await expect(plantShellSessionCookie(
      'http://127.0.0.1:43120/?token=stale',
      'http://127.0.0.1:43120',
      jar,
      async () => ({ status: 401, headers: { get: () => null } }),
    )).rejects.toThrow('HTTP 401')
    expect(jar.planted).toEqual([])
  })

  it('fails loud when the mint carries no cookie header', async () => {
    const jar = recordingJar()
    await expect(plantShellSessionCookie(
      'http://127.0.0.1:43120/?token=launch',
      'http://127.0.0.1:43120',
      jar,
      async () => ({ status: 303, headers: { get: () => null } }),
    )).rejects.toThrow('no parsable Set-Cookie')
  })
})
