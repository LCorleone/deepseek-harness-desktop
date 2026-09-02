/**
 * Corrupt-blob degradation contract of the SSO app key: a damaged
 * `src/sso-app-key-blob.ts` must fail the login feature through its reason
 * unions and rejections — never crash the boot, never escape as an unhandled
 * rejection out of the loopback callback handler (which calls
 * `decodeSsoCallbackCode` unguarded). This mirrors the usage-report blob's
 * degradation pattern: the failure surfaces as one sanitized reason line at
 * the orchestration boundary, where the launcher logs it masked.
 */
import { get } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  SsoCallbackServer,
  decodeSsoCallbackCode,
  fetchSsoToken,
  silentSsoLogin,
  verifySsoAuthCode,
  type SsoOsUser,
  type SsoRequestBoundary,
} from '../src/company-sso.ts'

vi.mock('../src/sso-app-key-blob.ts', () => ({
  // Decodes to non-JSON garbage: every builtin-key resolution must throw
  // `invalid sso app key blob` while this mock is in force.
  SSO_APP_KEY_BLOB: 'bm90LXZhbGlkLWJsb2ItcGF5bG9hZA==',
}))

/** Response stub factory for the injected fetch boundary (never reached). */
function boundary(body: string, status = 200): SsoRequestBoundary & { calls: number } {
  const calls = { count: 0 }
  const request: SsoRequestBoundary = async () => {
    calls.count += 1
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return Object.assign(request, {
    get calls(): number { return calls.count },
  })
}

/** One portal-shaped callback code parameter (valid shape, any signature). */
function callbackCode(): string {
  return Buffer.from(JSON.stringify({
    code: 0,
    message: 'ok',
    token: 'demo-token-abcdef',
    username: 'Zhang San',
    email: 'zhangsan@deloitte.com.cn',
    timestamp: 1_789_000_123,
    verify: 'anything-the-portal-might-have-signed',
  }), 'utf8').toString('base64url')
}

const os: SsoOsUser = {
  username: 'jdoe',
  fullName: 'Jane Doe',
  email: 'jane.doe@deloitte.com.cn',
  domain: 'CORP',
}

describe('sso app key corrupt-blob degradation', () => {
  it('fails callback validation through the reason union, not a throw', () => {
    const result = decodeSsoCallbackCode(callbackCode(), { now: () => 1_789_000_000 })

    expect(result).toEqual({
      ok: false,
      reason: 'dsh-plugin-desktop: invalid sso app key blob: the decoded payload is not valid JSON',
    })
  })

  it('settles a loopback callback as a branded failure without an unhandled rejection', async () => {
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const wait = server.waitForCallback({ now: () => 1_789_000_000 })
      const rejection = expect(wait).rejects.toThrow('invalid sso app key blob')
      const response = await new Promise<{ status: number, body: string }>(resolve => {
        get(`http://127.0.0.1:${String(port)}/callback?code=${callbackCode()}`, res => {
          let body = ''
          res.on('data', chunk => { body += chunk })
          res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
        })
      })
      // The browser still gets the branded failure page carrying the blob
      // condition — the handler survived the corrupt builtin.
      expect(response.status).toBe(400)
      expect(response.body).toContain('认证失败')
      expect(response.body).toContain('invalid sso app key blob')
      await rejection
    } finally {
      server.stop()
    }
  })

  it('rejects the portal confirmation with the blob condition, not a network error', async () => {
    await expect(verifySsoAuthCode('raw-code', 'token', {
      request: boundary('{"code":0}'),
    })).rejects.toThrow('dsh-plugin-desktop: invalid sso app key blob')
  })

  it('rejects the silent token request before any network round trip', async () => {
    const request = boundary('{"code":"200","token":"tok"}')
    await expect(fetchSsoToken('{}', { request })).rejects
      .toThrow('dsh-plugin-desktop: invalid sso app key blob')
    expect(request.calls).toBe(0)
  })

  it('degrades the whole silent login to one reason per warn line', async () => {
    const warnings: string[] = []
    const result = await silentSsoLogin({
      request: boundary('{"code":"200","token":"tok"}'),
      probe: async () => os,
      onWarn: message => { warnings.push(message) },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe(
        'dsh-plugin-desktop: invalid sso app key blob: the decoded payload is not valid JSON',
      )
    }
    // Exactly one line per email candidate (here: one, the UPN needs no
    // canonicalization) — the launcher logs each masked at the boundary.
    expect(warnings).toEqual([
      'dsh-plugin-desktop: sso silent token request failed: '
      + 'dsh-plugin-desktop: invalid sso app key blob: the decoded payload is not valid JSON',
    ])
  })
})
