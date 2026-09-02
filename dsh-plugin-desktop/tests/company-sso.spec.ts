import { createHash } from 'node:crypto'
import { get } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeSsoAppKeyBlob } from '../scripts/make-sso-app-key-blob.mjs'
import {
  SSO_CALLBACK_SUCCESS_HTML,
  SSO_TOKEN_TIMEOUT_MS,
  SSO_VERIFY_TIMEOUT_MS,
  SsoCallbackServer,
  browserSsoLogin,
  buildSsoCodeChallenge,
  buildSsoLoginUrl,
  buildSsoRedirectUri,
  buildSsoSignEntity,
  buildSsoTokenJsonData,
  canonicalizeSsoEmail,
  clearSsoSession,
  decodeSsoAppKeyBlob,
  decodeSsoCallbackCode,
  desktopSsoGateRequired,
  fetchSsoToken,
  formatSsoProcessTime,
  getSsoSession,
  getSsoEncodeStr,
  probeSsoOsUser,
  setSsoSession,
  silentSsoLogin,
  SsoPortalTokenError,
  describeSsoTokenFailure,
  ssoAppId,
  ssoAppName,
  ssoAppKey,
  ssoBaseUrl,
  ssoCallbackFailureHtml,
  ssoConfirmedCodeDigest,
  ssoLoginUrl,
  ssoSessionFromPayload,
  ssoSelfCheckStatus,
  ssoTokenUrl,
  ssoUsernameFromPayload,
  ssoVerifyAuthCodeUrl,
  verifySsoAuthCode,
  type SsoOsUser,
  type SsoRequestBoundary,
} from '../src/company-sso.ts'
import { SSO_APP_KEY_BLOB } from '../src/sso-app-key-blob.ts'

// Test golden vectors are decoupled from the real credential: this synthetic
// fixed key mirrors the issued key's 32-alphanumeric shape but never was a
// secret. The shipped key lives only inside the obfuscated blob and is
// asserted structurally (see the blob codec tests), never by value.
const APP_KEY = 'testSsoAppKey0000000000000000000'

/** One recorded call of the injected fetch boundary stub. */
type BoundaryCall = {
  url: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal | undefined
}

/** Response stub factory for the injected fetch boundary. */
function boundary(body: string, status = 200): SsoRequestBoundary & { calls: BoundaryCall[] } {
  const calls: BoundaryCall[] = []
  const request = async (url: string, init: Parameters<SsoRequestBoundary>[1]) => {
    calls.push({ url, headers: init.headers, body: init.body, signal: init.signal })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }
  }
  return Object.assign(request, { calls })
}

/** Encode one callback payload exactly the way the portal hands it to the browser. */
function encodeCallback(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

afterEach(() => {
  clearSsoSession()
  vi.unstubAllEnvs()
})

describe('sso credentials and endpoints', () => {
  it('pins the issued app credentials by default', () => {
    expect(ssoAppId({})).toBe('1008')
    // The shipped app key is asserted structurally — it resolves through
    // the obfuscated blob and only its issued shape (32 alphanumeric
    // characters) is pinned here, never the value itself.
    expect(ssoAppKey({})).toMatch(/^[A-Za-z0-9]{32}$/u)
    expect(ssoAppKey({})).toBe(decodeSsoAppKeyBlob(SSO_APP_KEY_BLOB))
    // Registered portal name for app id 1008 (ops rotation, 2026-09-02) — the portal
    // matches configuration by the (appId, appName) pair.
    expect(ssoAppName({})).toBe('DSH')
    expect(ssoLoginUrl()).toBe('https://sdp.deloitte.com.cn/web/login')
    expect(ssoTokenUrl()).toBe('https://sdp.deloitte.com.cn/web/dai/token')
    expect(ssoVerifyAuthCodeUrl()).toBe('https://sdp.deloitte.com.cn/web/work/agent/verify_auth_code')
  })

  it('honors environment overrides in unpackaged runs only', () => {
    expect(ssoAppId({ DSH_SSO_APP_ID: ' 9999 ' })).toBe('9999')
    expect(ssoAppKey({ DSH_SSO_APP_KEY: 'test-key' })).toBe('test-key')
    expect(ssoAppName({ DSH_SSO_APP_NAME: ' coWork.Nova ' })).toBe('coWork.Nova')
    // Empty spellings fall back to the built-ins.
    expect(ssoAppId({ DSH_SSO_APP_ID: ' ' })).toBe('1008')
    expect(ssoAppName({ DSH_SSO_APP_NAME: '' })).toBe('DSH')
    expect(ssoBaseUrl({ DSH_SSO_BASE_URL: 'https://sso-test.example/' }))
      .toBe('https://sso-test.example')
    expect(ssoTokenUrl({ DSH_SSO_BASE_URL: 'https://sso-test.example' }))
      .toBe('https://sso-test.example/web/dai/token')
    expect(ssoVerifyAuthCodeUrl({ DSH_SSO_BASE_URL: 'https://sso-test.example' }))
      .toBe('https://sso-test.example/web/work/agent/verify_auth_code')
    // A packaged build ignores every override and pins the shipped
    // credentials and portal — including the app.asar.unpacked mirror.
    const packaged = '/opt/Deloitte DSH Desktop/resources/app.asar/lib/company-sso.js'
    const packagedUnpacked = '/opt/Deloitte DSH Desktop/resources/app.asar.unpacked/lib/company-sso.js'
    expect(ssoAppId({ DSH_SSO_APP_ID: '9999' }, packaged)).toBe('1008')
    expect(ssoAppKey({ DSH_SSO_APP_KEY: 'evil-key' }, packaged)).toMatch(/^[A-Za-z0-9]{32}$/u)
    expect(ssoAppName({ DSH_SSO_APP_NAME: 'evil-name' }, packaged)).toBe('DSH')
    expect(ssoBaseUrl({ DSH_SSO_BASE_URL: 'https://evil.example/' }, packaged)).toBe('https://sdp.deloitte.com.cn')
    expect(ssoAppId({ DSH_SSO_APP_ID: '9999' }, packagedUnpacked)).toBe('1008')
    expect(ssoAppKey({ DSH_SSO_APP_KEY: 'evil-key' }, packagedUnpacked)).toMatch(/^[A-Za-z0-9]{32}$/u)
    expect(ssoAppName({ DSH_SSO_APP_NAME: 'evil-name' }, packagedUnpacked)).toBe('DSH')
    expect(ssoBaseUrl({ DSH_SSO_BASE_URL: 'https://evil.example/' }, packagedUnpacked))
      .toBe('https://sdp.deloitte.com.cn')
  })
})

describe('sso app key blob codec', () => {
  // The obfuscation key is public by design (it ships in the runtime
  // decoder), so tests can build arbitrary malformed payloads with it.
  const obfuscate = (json: string): string => {
    const key = Buffer.from('dsh-desktop-sso-app-key-obfuscation-key-v1', 'utf8')
    const cipher = Buffer.from(json, 'utf8')
    for (let index = 0; index < cipher.length; index += 1) {
      cipher[index] = cipher[index]! ^ key[index % key.length]!
    }
    return cipher.toString('base64')
  }

  it('round-trips a key through the generator encoder and the runtime decoder', () => {
    expect(decodeSsoAppKeyBlob(encodeSsoAppKeyBlob('company-sso-test-key'))).toBe('company-sso-test-key')
  })

  it('never leaves the key inside the blob', () => {
    const blob = encodeSsoAppKeyBlob('company-sso-test-key')

    expect(blob).not.toContain('company-sso-test-key')
    expect(blob).not.toContain('company')
  })

  it('decodes the committed blob to the issued key shape', () => {
    // The repository must never carry the app key in plaintext, so the
    // assertion stays structural: decoding succeeds and yields exactly the
    // issued 32-character alphanumeric shape. The value itself is never
    // pinned in a test (or anywhere else outside the blob).
    const appKey = decodeSsoAppKeyBlob(SSO_APP_KEY_BLOB)

    expect(appKey).toMatch(/^[A-Za-z0-9]{32}$/u)
    // And the committed ciphertext carries no plaintext run of it.
    expect(SSO_APP_KEY_BLOB).not.toContain(appKey)
  })

  it.each([
    ['an empty blob', ''],
    ['a whitespace blob', '   '],
    ['a non-base64 blob', '!!!!not-base64-payload!!!!'],
    ['a blob that is not JSON', Buffer.from('this is not json at all', 'utf8').toString('base64')],
    ['a JSON array payload', Buffer.from('[1,2,3]', 'utf8').toString('base64')],
    ['a payload without appKey', obfuscate(JSON.stringify({ appId: '1007' }))],
    ['a payload with extra fields', obfuscate(JSON.stringify({ appKey: 'k', appId: '1007' }))],
    ['a payload with an empty appKey', obfuscate(JSON.stringify({ appKey: '' }))],
    ['a payload with a non-string appKey', obfuscate(JSON.stringify({ appKey: 17 }))],
  ])('rejects %s', (_label, blob) => {
    expect(() => decodeSsoAppKeyBlob(blob)).toThrow('invalid sso app key blob')
  })

  it('keeps blob content out of the failure diagnostics', () => {
    const blob = encodeSsoAppKeyBlob('company-sso-test-key')
    // Truncate the tail so the decoded payload is unterminated JSON: the
    // failure must name the condition, never the payload bytes.
    const malformed = blob.slice(0, -4)

    try {
      decodeSsoAppKeyBlob(malformed)
      expect.unreachable('decoding must fail')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      expect(message).not.toContain('company-sso-test-key')
      expect(message).not.toContain('company')
    }
  })
})

describe('SignEntity protocol (silent path)', () => {
  it('keeps exactly the characters at indices divisible by 7, 11, or 23', () => {
    // Index membership on a 30-char alphabet: 0, 7, 11, 14, 21, 22, 23, 28.
    expect(getSsoEncodeStr('0123456789abcdefghijklmnopqrst')).toBe('07belmns')
    // Membership is per-index: an index divisible by both 7 and 11 (0, 77)
    // still contributes exactly one character — the sieve dedupes naturally.
    let expected = ''
    const long = 'x'.repeat(78)
    for (let index = 0; index < long.length; index += 1) {
      if (index % 11 === 0 || index % 7 === 0 || index % 23 === 0) expected += long[index]
    }
    expect(getSsoEncodeStr(long)).toBe(expected)
    expect([...expected].indexOf('x')).toBe(0)
    expect(getSsoEncodeStr('')).toBe('')
  })

  it('serializes jsonData with the exact userName-then-email key order', () => {
    const data = buildSsoTokenJsonData('张三', 'zhangsan@deloitte.com.cn')
    expect(data).toBe('{"userName":"张三","email":"zhangsan@deloitte.com.cn"}')
    expect(data.startsWith('{"userName":')).toBe(true)
    // Node preserves insertion order — the portal's server-side check depends
    // on these bytes, so a re-sorted object literal would break the signature.
    expect(Object.keys({ userName: 1, email: 2 })).toEqual(['userName', 'email'])
  })

  it('formats local process time as yyyy-MM-dd HH:mm:ss', () => {
    // Constructed in local time, formatted in local time: TZ-independent.
    expect(formatSsoProcessTime(new Date(2026, 7, 31, 12, 0, 9))).toBe('2026-08-31 12:00:09')
    expect(formatSsoProcessTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05')
  })

  it('reproduces the golden signature over fixed inputs', () => {
    const entity = buildSsoSignEntity({
      jsonData: '{"userName":"张三","email":"zhangsan@deloitte.com.cn"}',
      appId: '1007',
      appKey: APP_KEY,
      now: () => new Date(2026, 7, 31, 12, 0, 0),
      uuid: () => '01234567-89ab-cdef-0123-456789abcdef',
    })
    expect(entity.id).toBe('0123456789abcdef0123456789abcdef')
    expect(entity.processTime).toBe('2026-08-31 12:00:00')
    expect(entity.appName).toBe('DSH')
    // Golden vector: sha256 over encodeStr(id + processTime + appKey + jsonData),
    // computed independently of the implementation under test with the
    // synthetic test key. The signature covers the concatenated values, so
    // it is unaffected by the JSON key spelling (nova's camelCase SignEntity
    // signs the same string).
    expect(entity.signature).toBe('N+RaOK6aBThzjnX81CqjlVMSmJ36VdkKtvQeAu5bEX4=')
    // The exact wire body — complete camelCase key set in the portal's
    // id-first insertion order, pinned as a literal so a spelling or key-order
    // regression cannot slip back in through a partial matcher.
    expect(JSON.stringify(entity)).toBe(
      '{"id":"0123456789abcdef0123456789abcdef","appId":"1007","appName":"DSH",'
      + '"jsonData":"{\\"userName\\":\\"张三\\",\\"email\\":\\"zhangsan@deloitte.com.cn\\"}",'
      + '"processTime":"2026-08-31 12:00:00","signature":"N+RaOK6aBThzjnX81CqjlVMSmJ36VdkKtvQeAu5bEX4="}',
    )
  })

  it('generates a 32-hex id without hyphens by default', () => {
    const entity = buildSsoSignEntity({
      jsonData: '{"userName":"A","email":"a@b.c"}',
      appId: '1007',
      appKey: APP_KEY,
    })
    expect(entity.id).toMatch(/^[0-9a-f]{32}$/u)
    expect(entity.id.includes('-')).toBe(false)
  })

  it('accepts code "200" (string or number) with a non-empty token', async () => {
    const stringCode = boundary('{"code":"200","token":"tok","message":"ok"}')
    await expect(fetchSsoToken('{}', { request: stringCode, appId: '1007', appKey: APP_KEY }))
      .resolves.toBe('tok')
    const numericCode = boundary('{"code":200,"token":"tok2"}')
    await expect(fetchSsoToken('{}', { request: numericCode, appId: '1007', appKey: APP_KEY }))
      .resolves.toBe('tok2')
    expect(numericCode.calls[0]?.url).toBe('https://sdp.deloitte.com.cn/web/dai/token')
    expect(JSON.parse(numericCode.calls[0]!.body)).toMatchObject({ appId: '1007' })
  })

  it('always arms a request deadline — a hanging boundary is clamped', async () => {
    // A fetch that never settles on its own and only rejects when the abort
    // signal fires proves the deadline is attached to every token POST.
    const hanging: SsoRequestBoundary = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new Error('aborted'))
      }, { once: true })
    })
    await expect(fetchSsoToken('{}', {
      request: hanging,
      appId: '1007',
      appKey: APP_KEY,
      timeoutMs: 25,
    })).rejects.toThrow('token network error')
    // The default is nova's 45 s bound — pinned without waiting for it.
    expect(SSO_TOKEN_TIMEOUT_MS).toBe(45_000)
  })

  it('rejects every non-success answer with the portal message and its code', async () => {
    const refusal = fetchSsoToken('{}', {
      request: boundary('{"code":"401","message":"Invalid username!"}'),
      appId: '1007',
      appKey: APP_KEY,
    })
    await expect(refusal).rejects.toThrow('Invalid username!')
    // The structured reason keeps the portal code beside the message so the
    // silent path can log both on one line (never the token).
    await expect(refusal).rejects.toBeInstanceOf(SsoPortalTokenError)
    const error = await refusal.catch((cause: unknown) => cause) as SsoPortalTokenError
    expect(error.portalCode).toBe('401')
    expect(describeSsoTokenFailure(error)).toBe('Invalid username! (code 401)')
    // A code-less answer degrades to the message alone.
    expect(describeSsoTokenFailure(new Error('token network error: ECONNRESET')))
      .toBe('token network error: ECONNRESET')
    expect(describeSsoTokenFailure(new SsoPortalTokenError('Unable to obtain access token', '')))
      .toBe('Unable to obtain access token')
    // Success code without a token is still a failure.
    await expect(fetchSsoLogin('{}', '{"code":"200","token":"  "}')).rejects
      .toThrow('Unable to obtain access token')
    // Non-2xx surfaces the body snippet.
    await expect(fetchSsoLogin('{}', 'gateway exploded', 502)).rejects.toThrow('gateway exploded')
    await expect(fetchSsoLogin('{}', '', 500)).rejects.toThrow('token HTTP 500')
    // Invalid JSON.
    await expect(fetchSsoLogin('{}', '<html>login page</html>')).rejects.toThrow('Invalid JSON response')
    // Transport failure.
    await expect(fetchSsoToken('{}', {
      request: async () => { throw new Error('ECONNRESET') },
      appId: '1007',
      appKey: APP_KEY,
    })).rejects.toThrow('token network error: ECONNRESET')
  })

  async function fetchSsoLogin(jsonData: string, body: string, status = 200): Promise<string> {
    return await fetchSsoToken(jsonData, {
      request: boundary(body, status),
      appId: '1007',
      appKey: APP_KEY,
    })
  }
})

describe('verify_auth_code confirmation (browser path)', () => {
  it('digests the app key and the raw code as one md5 hex string', () => {
    // Golden vectors computed independently of the implementation.
    expect(ssoConfirmedCodeDigest('key', 'code')).toBe('1a54c1036ccb10069e9c06281d52007a')
    expect(ssoConfirmedCodeDigest(APP_KEY, 'raw-callback-code'))
      .toBe('d9958e1f1c96ac8a5b42ac842b49ca44')
    expect(ssoConfirmedCodeDigest(APP_KEY, 'raw-callback-code')).toMatch(/^[0-9a-f]{32}$/u)
  })

  it('posts the digest with the callback token to the pinned endpoint', async () => {
    const request = boundary('{"code":0,"message":"ok"}')
    await expect(verifySsoAuthCode('raw-code', '  callback-token  ', {
      request,
      appKey: APP_KEY,
    })).resolves.toBeUndefined()
    expect(request.calls).toHaveLength(1)
    expect(request.calls[0]?.url).toBe('https://sdp.deloitte.com.cn/web/work/agent/verify_auth_code')
    expect(request.calls[0]?.headers).toEqual({
      'x-auth-token': 'callback-token',
      'Content-Type': 'application/json',
    })
    expect(request.calls[0]?.body)
      .toBe(JSON.stringify({ code: ssoConfirmedCodeDigest(APP_KEY, 'raw-code') }))
    expect(request.calls[0]?.signal).toBeInstanceOf(AbortSignal)
    // A numeric-string code 0 confirms too (nova parses either spelling).
    await expect(verifySsoAuthCode('raw-code', 't', {
      request: boundary('{"code":"0"}'),
      appKey: APP_KEY,
    })).resolves.toBeUndefined()
  })

  it('rejects every non-confirmed answer', async () => {
    // code != 0 surfaces the portal message, else the code itself.
    await expect(confirm('{"code":401,"message":"认证码已失效"}')).rejects.toThrow('认证码已失效')
    await expect(confirm('{"code":5}')).rejects.toThrow('认证码确认失败 (code 5)')
    // Missing / non-numeric code and non-JSON bodies.
    await expect(confirm('{}')).rejects.toThrow('认证码确认接口返回无效 code')
    await expect(confirm('<html>gateway</html>')).rejects.toThrow('认证码确认接口返回非 JSON')
    // Failure status: a body message wins, else the HTTP status — even when
    // the body claims code 0 (nova parse_confirmed_error).
    await expect(confirm('{"code":9,"message":"expired"}', 502)).rejects.toThrow('expired')
    await expect(confirm('{"code":0}', 502)).rejects.toThrow('认证码确认 HTTP 502')
    // Transport failure wraps without the token.
    await expect(verifySsoAuthCode('raw', 'secret-token', {
      request: async () => { throw new Error('ECONNRESET') },
      appKey: APP_KEY,
    })).rejects.toThrow('认证码确认网络错误: ECONNRESET')
    // Guard rails on the inputs (nova verify_confirmed_code preconditions).
    await expect(verifySsoAuthCode('  ', 't', { request: boundary('{}'), appKey: APP_KEY }))
      .rejects.toThrow('缺少认证参数 code')
    await expect(verifySsoAuthCode('raw', '', { request: boundary('{}'), appKey: APP_KEY }))
      .rejects.toThrow('缺少访问令牌')
  })

  it('always arms a request deadline — a hanging boundary is clamped', async () => {
    const hanging: SsoRequestBoundary = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new Error('aborted'))
      }, { once: true })
    })
    await expect(verifySsoAuthCode('raw-code', 'token', {
      request: hanging,
      appKey: APP_KEY,
      timeoutMs: 25,
    })).rejects.toThrow('认证码确认网络错误')
    // The default is nova's 45 s bound — pinned without waiting for it.
    expect(SSO_VERIFY_TIMEOUT_MS).toBe(45_000)
  })

  async function confirm(body: string, status = 200): Promise<void> {
    await verifySsoAuthCode('raw-code', 'callback-token', {
      request: boundary(body, status),
      appKey: APP_KEY,
    })
  }
})

describe('browser login url and code challenge', () => {
  it('reproduces the golden code challenge', () => {
    expect(buildSsoCodeChallenge('http://localhost:49152/callback', '1007', 1_789_000_000))
      .toBe('LhkhVebF1qVAHu3+BG8b8oXSNQJZQHOPlHMkgOHIWEE=')
  })

  it('builds the login url with the exact parameter set and order', () => {
    expect(buildSsoLoginUrl('http://localhost:49152/callback', {
      appId: '1007',
      now: () => 1_789_000_000,
    })).toBe(
      'https://sdp.deloitte.com.cn/web/login'
      + '?redirect_uri=http%3A%2F%2Flocalhost%3A49152%2Fcallback'
      + '&app_id=1007'
      + '&timestamp=1789000000'
      + '&code_challenge=LhkhVebF1qVAHu3%2BBG8b8oXSNQJZQHOPlHMkgOHIWEE%3D',
    )
  })

  it('binds the redirect uri to the loopback callback path', () => {
    expect(buildSsoRedirectUri(49152)).toBe('http://localhost:49152/callback')
  })
})

describe('callback payload validation', () => {
  const validPayload = {
    code: 0,
    message: 'ok',
    token: 'demo-token-abcdef',
    username: 'Zhang San',
    email: 'zhangsan@deloitte.com.cn',
    timestamp: 1_789_000_123,
    verify: 'Io3ITKrDdDQMQuEe3hly6otwbfp2UaxUSk/CyDagI9s=',
  }

  it('accepts a correctly signed fresh payload', () => {
    const result = decodeSsoCallbackCode(encodeCallback(validPayload), {
      appKey: APP_KEY,
      now: () => 1_789_000_000,
    })
    expect(result).toMatchObject({
      ok: true,
      payload: { code: 0, token: 'demo-token-abcdef', email: 'zhangsan@deloitte.com.cn' },
    })
    // The ±600 s window accepts both edges.
    expect(decodeSsoCallbackCode(encodeCallback(validPayload), {
      appKey: APP_KEY, now: () => 1_789_000_123 + 600,
    }).ok).toBe(true)
  })

  it('accepts numeric-string code and timestamp spellings', () => {
    const result = decodeSsoCallbackCode(encodeCallback({
      ...validPayload,
      code: '0',
      timestamp: '1789000123',
    }), { appKey: APP_KEY, now: () => 1_789_000_000 })
    expect(result.ok).toBe(true)
  })

  it('rejects a failed login code with the portal message', () => {
    const result = decodeSsoCallbackCode(encodeCallback({
      ...validPayload,
      code: 1001,
      message: '账号被冻结',
    }), { appKey: APP_KEY, now: () => 1_789_000_000 })
    expect(result).toEqual({ ok: false, reason: '账号被冻结' })
    // Without a message the code number itself is surfaced.
    expect(decodeSsoCallbackCode(encodeCallback({ ...validPayload, code: 7, message: '' }), {
      appKey: APP_KEY, now: () => 1_789_000_000,
    })).toEqual({ ok: false, reason: 'Authentication failed (code 7)' })
  })

  it('rejects timestamps outside the ±600 s window', () => {
    expect(decodeSsoCallbackCode(encodeCallback(validPayload), {
      appKey: APP_KEY, now: () => 1_789_000_123 + 601,
    })).toEqual({ ok: false, reason: 'Callback timestamp expired' })
    expect(decodeSsoCallbackCode(encodeCallback(validPayload), {
      appKey: APP_KEY, now: () => 1_789_000_123 - 601,
    })).toEqual({ ok: false, reason: 'Callback timestamp expired' })
  })

  it('rejects a forged verify signature', () => {
    const forged = {
      ...validPayload,
      verify: createHash('sha256')
        .update(`wrong${validPayload.timestamp}`, 'utf8')
        .digest('base64'),
    }
    expect(decodeSsoCallbackCode(encodeCallback(forged), {
      appKey: APP_KEY, now: () => 1_789_000_000,
    })).toEqual({ ok: false, reason: 'Signature verification failed' })
    // A different app key must not validate the same payload.
    expect(decodeSsoCallbackCode(encodeCallback(validPayload), {
      appKey: 'another-key', now: () => 1_789_000_000,
    })).toEqual({ ok: false, reason: 'Signature verification failed' })
  })

  it('rejects malformed inputs without trusting any field', () => {
    expect(decodeSsoCallbackCode('')).toEqual({ ok: false, reason: 'Missing callback code' })
    expect(decodeSsoCallbackCode('   ')).toEqual({ ok: false, reason: 'Missing callback code' })
    expect(decodeSsoCallbackCode('!!!not-base64!!!', { appKey: APP_KEY }))
      .toEqual({ ok: false, reason: 'Invalid callback payload' })
    expect(decodeSsoCallbackCode(Buffer.from('[]').toString('base64url'), { appKey: APP_KEY }))
      .toEqual({ ok: false, reason: 'Invalid callback payload' })
    expect(decodeSsoCallbackCode(encodeCallback({ ...validPayload, token: '' }), {
      appKey: APP_KEY, now: () => 1_789_000_000,
    })).toEqual({ ok: false, reason: 'Invalid callback payload' })
    expect(decodeSsoCallbackCode(encodeCallback({ ...validPayload, timestamp: 'soon' }), {
      appKey: APP_KEY, now: () => 1_789_000_000,
    })).toEqual({ ok: false, reason: 'Invalid callback payload' })
  })

  it('canonicalizes the alias domain and derives the session username', () => {
    expect(canonicalizeSsoEmail('a@deloittecn.com.cn')).toBe('a@deloitte.com.cn')
    expect(canonicalizeSsoEmail('a@DELOITTECN.COM.CN'.toLowerCase())).toBe('a@deloitte.com.cn')
    expect(canonicalizeSsoEmail('a@deloitte.com.cn')).toBe('a@deloitte.com.cn')
    expect(canonicalizeSsoEmail('not-an-email')).toBe('not-an-email')
    expect(ssoUsernameFromPayload({ email: 'zhangsan@deloitte.com.cn', username: 'Zhang San' }))
      .toBe('zhangsan')
    expect(ssoUsernameFromPayload({ email: '@deloitte.com.cn', username: 'fallback' }))
      .toBe('fallback')
    expect(ssoUsernameFromPayload({ email: '', username: '' })).toBe('user')
  })

  it('builds the browser session from a validated payload', () => {
    const session = ssoSessionFromPayload({
      code: 0,
      message: 'ok',
      token: 'tok',
      username: 'Zhang San',
      email: 'zhangsan@deloittecn.com.cn',
      timestamp: 1,
      verify: 'v',
    })
    expect(session).toEqual({
      email: 'zhangsan@deloitte.com.cn',
      username: 'zhangsan',
      fullName: 'Zhang San',
      domain: 'deloitte.com.cn',
      token: 'tok',
      source: 'browser',
    })
  })
})

describe('callback html responses', () => {
  it('brands both pages as Deloitte DSH Desktop and escapes failure reasons', () => {
    expect(SSO_CALLBACK_SUCCESS_HTML).toContain('Deloitte DSH Desktop')
    expect(SSO_CALLBACK_SUCCESS_HTML).toContain('登录成功')
    const failure = ssoCallbackFailureHtml('<script>alert("x")</script>')
    expect(failure).toContain('Deloitte DSH Desktop')
    expect(failure).toContain('&lt;script&gt;')
    expect(failure).not.toContain('<script>')
  })
})

describe('loopback callback server', () => {
  const validPayload = {
    code: 0,
    message: 'ok',
    token: 'demo-token-abcdef',
    username: 'Zhang San',
    email: 'zhangsan@deloitte.com.cn',
    timestamp: 1_789_000_123,
    verify: 'Io3ITKrDdDQMQuEe3hly6otwbfp2UaxUSk/CyDagI9s=',
  }

  /** Issue one raw HTTP request against the loopback server. */
  function request(
    port: number,
    path: string,
  ): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
      get(`http://127.0.0.1:${String(port)}${path}`, response => {
        let body = ''
        response.on('data', chunk => { body += chunk })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
      }).once('error', reject)
    })
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves a validated callback with the branded success page', async () => {
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const wait = server.waitForCallback({ appKey: APP_KEY, now: () => 1_789_000_000 })
      const response = await request(port, `/callback?code=${encodeCallback(validPayload)}`)
      expect(response.status).toBe(200)
      expect(response.body).toContain('登录成功')
      const payload = await wait
      expect(payload.email).toBe('zhangsan@deloitte.com.cn')
    } finally {
      server.stop()
    }
  })

  it('confirms a validated callback with the portal before settling', async () => {
    const confirm = boundary('{"code":0}')
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const rawCode = encodeCallback(validPayload)
      const wait = server.waitForCallback({
        appKey: APP_KEY,
        now: () => 1_789_000_000,
        confirm: { request: confirm, appKey: APP_KEY },
      })
      const response = await request(port, `/callback?code=${rawCode}`)
      expect(response.status).toBe(200)
      const payload = await wait
      // The confirmation carries the RAW code parameter string and the
      // payload's token, addressed to the pinned endpoint.
      expect(confirm.calls).toHaveLength(1)
      expect(confirm.calls[0]?.url).toBe('https://sdp.deloitte.com.cn/web/work/agent/verify_auth_code')
      expect(confirm.calls[0]?.headers).toMatchObject({ 'x-auth-token': 'demo-token-abcdef' })
      expect(confirm.calls[0]?.body).toBe(JSON.stringify({ code: ssoConfirmedCodeDigest(APP_KEY, rawCode) }))
      expect(payload.token).toBe('demo-token-abcdef')
    } finally {
      server.stop()
    }
  })

  it('rejects the login when the portal rejects the confirmation', async () => {
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const wait = server.waitForCallback({
        appKey: APP_KEY,
        now: () => 1_789_000_000,
        confirm: { request: boundary('{"code":401,"message":"认证码已失效"}', 401), appKey: APP_KEY },
      })
      const rejection = expect(wait).rejects.toThrow('认证码已失效')
      const response = await request(port, `/callback?code=${encodeCallback(validPayload)}`)
      // The browser sees the branded failure page; the waiter — the login —
      // is rejected even though the local validation passed.
      expect(response.status).toBe(400)
      expect(response.body).toContain('认证失败')
      expect(response.body).toContain('认证码已失效')
      await rejection
    } finally {
      server.stop()
    }
  })

  it('answers a rejected callback with the branded failure page and rejects the waiter', async () => {
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const wait = server.waitForCallback({ appKey: APP_KEY, now: () => 1_789_000_123 + 10_000 })
      // Attach the rejection handler before the request can fire it.
      const rejection = expect(wait).rejects.toThrow('Callback timestamp expired')
      const response = await request(port, `/callback?code=${encodeCallback(validPayload)}`)
      expect(response.status).toBe(400)
      expect(response.body).toContain('认证失败')
      expect(response.body).toContain('Callback timestamp expired')
      await rejection
    } finally {
      server.stop()
    }
  })

  it('rejects requests without a code parameter and unknown paths', async () => {
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const wait = server.waitForCallback({ appKey: APP_KEY, now: () => 1_789_000_000 })
      const rejection = expect(wait).rejects.toThrow('缺少认证参数 code')
      const missing = await request(port, '/callback')
      expect(missing.status).toBe(400)
      expect(missing.body).toContain('缺少认证参数 code')
      await rejection
      const notFound = await request(port, '/elsewhere?code=x')
      expect(notFound.status).toBe(404)
    } finally {
      server.stop()
    }
  })

  it('lets the newest waiter supersede the previous one and reuses the port', async () => {
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const first = server.waitForCallback({ appKey: APP_KEY })
      const second = server.waitForCallback({ appKey: APP_KEY, now: () => 1_789_000_000 })
      await expect(first).rejects.toThrow('新的登录请求已取代当前等待')
      const response = await request(port, `/callback?code=${encodeCallback(validPayload)}`)
      expect(response.status).toBe(200)
      await expect(second).resolves.toMatchObject({ token: 'demo-token-abcdef' })
      // start() is idempotent while the server lives.
      await expect(server.start()).resolves.toMatchObject({ port })
    } finally {
      server.stop()
    }
  })

  it('times out an idle waiter without breaking later retries', async () => {
    const server = new SsoCallbackServer()
    try {
      await server.start()
      const expired = server.waitForCallback({ appKey: APP_KEY, timeoutMs: 5 })
      await expect(expired).rejects.toThrow('登录超时')
      const retry = server.waitForCallback({ appKey: APP_KEY, now: () => 1_789_000_000, timeoutMs: 5_000 })
      void retry.catch(() => {})
      await new Promise(resolve => { setTimeout(resolve, 10) })
    } finally {
      server.stop('登录已取消')
    }
  })

  it('does not time the waiter out once a validated callback is being confirmed', async () => {
    // The confirmation round trip is held in flight across the (shortened)
    // idle deadline: the timer bounds only the wait for the browser to
    // come back, so a callback that lands late in the login window must
    // not time the login out mid-confirmation.
    let releaseConfirm!: () => void
    const inFlight = new Promise<void>(resolve => { releaseConfirm = resolve })
    const confirm = vi.fn(async (): Promise<{ ok: boolean, status: number, text: () => Promise<string> }> => {
      await inFlight
      return { ok: true, status: 200, text: async () => '{"code":0}' }
    })
    const server = new SsoCallbackServer()
    try {
      const { port } = await server.start()
      const wait = server.waitForCallback({
        appKey: APP_KEY,
        now: () => 1_789_000_000,
        timeoutMs: 40,
        confirm: { request: confirm, appKey: APP_KEY },
      })
      let rejection: unknown
      void wait.catch(cause => { rejection = cause })
      const settling = request(port, `/callback?code=${encodeCallback(validPayload)}`)
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
      // The idle deadline passes while the portal confirms.
      await new Promise(resolve => { setTimeout(resolve, 150) })
      expect(rejection).toBeUndefined()
      releaseConfirm()
      const response = await settling
      expect(response.status).toBe(200)
      expect(response.body).toContain('登录成功')
      await expect(wait).resolves.toMatchObject({ token: 'demo-token-abcdef' })
    } finally {
      server.stop()
    }
  })
})

describe('browser login orchestration', () => {
  const validPayload = {
    code: 0,
    message: 'ok',
    token: 'browser-token',
    username: 'Li Si',
    email: 'lisi@deloittecn.com.cn',
    timestamp: 1_789_000_123,
    verify: ((): string => {
      const source = `browser-token1789000123Li Si${APP_KEY}lisi@deloittecn.com.cn`
      return createHash('sha256').update(source, 'utf8').digest('base64')
    })(),
  }

  it('resolves a complete browser round trip with the canonicalized session', async () => {
    const confirm = boundary('{"code":0}')
    const opened: string[] = []
    let openedUrl: ((url: string) => void) | undefined
    const openedSignal = new Promise<void>(resolve => { openedUrl = url => { void url; resolve() } })
    const login = browserSsoLogin({
      request: confirm,
      appKey: APP_KEY,
      now: () => 1_789_000_000,
      openExternal: async url => {
        opened.push(url)
        openedUrl?.(url)
      },
    })
    // Play the browser: once the flow opened the login page, redirect to the
    // loopback callback with the portal-shaped code parameter.
    await openedSignal
    const url = new URL(opened[0]!)
    expect(url.origin + url.pathname).toBe('https://sdp.deloitte.com.cn/web/login')
    expect(url.searchParams.get('app_id')).toBe('1008')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/u)
    expect(url.searchParams.get('code_challenge')).toBe(
      buildSsoCodeChallenge(url.searchParams.get('redirect_uri')!, '1008', 1_789_000_000),
    )
    const callbackPort = Number(new URL(url.searchParams.get('redirect_uri')!).port)
    const rawCode = encodeCallback(validPayload)
    const response = await new Promise<{ status: number, body: string }>(resolve => {
      get(`http://127.0.0.1:${String(callbackPort)}/callback?code=${rawCode}`, res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
      })
    })
    expect(response.status).toBe(200)
    expect(response.body).toContain('登录成功')
    const result = await login
    expect(result).toEqual({
      ok: true,
      session: {
        email: 'lisi@deloitte.com.cn',
        username: 'lisi',
        fullName: 'Li Si',
        domain: 'deloitte.com.cn',
        token: 'browser-token',
        source: 'browser',
      },
    })
    // The portal confirmation ran inside the round trip: raw code digest,
    // callback token in x-auth-token, pinned endpoint.
    expect(confirm.calls).toHaveLength(1)
    expect(confirm.calls[0]?.url).toBe('https://sdp.deloitte.com.cn/web/work/agent/verify_auth_code')
    expect(confirm.calls[0]?.headers).toEqual({
      'x-auth-token': 'browser-token',
      'Content-Type': 'application/json',
    })
    expect(confirm.calls[0]?.body).toBe(JSON.stringify({ code: ssoConfirmedCodeDigest(APP_KEY, rawCode) }))
  })

  it('rejects the login when the portal rejects the confirmation', async () => {
    const opened: string[] = []
    let openedUrl: ((url: string) => void) | undefined
    const openedSignal = new Promise<void>(resolve => { openedUrl = url => { void url; resolve() } })
    const login = browserSsoLogin({
      request: boundary('{"code":403,"message":"认证码已被使用"}', 403),
      appKey: APP_KEY,
      now: () => 1_789_000_000,
      openExternal: async url => {
        opened.push(url)
        openedUrl?.(url)
      },
    })
    await openedSignal
    const loginUrl = new URL(opened[0]!)
    const callbackPort = Number(new URL(loginUrl.searchParams.get('redirect_uri')!).port)
    // The local validation passes; only the portal confirmation rejects.
    const response = await new Promise<{ status: number, body: string }>(resolve => {
      get(`http://127.0.0.1:${String(callbackPort)}/callback?code=${encodeCallback(validPayload)}`, res => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }) })
      })
    })
    expect(response.status).toBe(400)
    const result = await login
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('认证码已被使用')
  })

  it('reports an opener failure without leaving a waiter behind', async () => {
    const result = await browserSsoLogin({
      request: boundary('{"code":0}'),
      appKey: APP_KEY,
      openExternal: async () => { throw new Error('no default browser') },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('无法打开浏览器登录页')
  })
})

describe('os identity probe', () => {
  it('resolves the Windows fast path: whoami upn, net user full name', async () => {
    const warnings: string[] = []
    const os = await probeSsoOsUser({
      platform: 'win32',
      environment: {
        USERNAME: 'jdoe',
        USERDOMAIN: 'CORP',
        COMPUTERNAME: 'WIN-1',
      },
      now: () => 0,
      onWarn: message => { warnings.push(message) },
      run: async (program, args) => {
        if (program === 'whoami' && args[0] === '/upn') return 'jane.doe@deloitte.com.cn'
        if (program === 'net' && args[0] === 'user' && args[1] === 'jdoe' && args.length === 2) {
          return 'User name                    jdoe\nFull Name                    Jane Doe\nComment\n'
        }
        return undefined
      },
    })
    expect(os).toEqual({
      username: 'jdoe',
      fullName: 'Jane Doe',
      email: 'jane.doe@deloitte.com.cn',
      domain: 'CORP',
    })
    // A resolved display name is not weak: no warning.
    expect(warnings).toEqual([])
  })

  it('warns but continues when no display-name source resolves', async () => {
    const warnings: string[] = []
    const os = await probeSsoOsUser({
      platform: 'win32',
      environment: { USERNAME: 'jdoe', USERDOMAIN: 'CORP' },
      now: () => 0,
      onWarn: message => { warnings.push(message) },
      run: async program => (program === 'whoami' ? 'jane.doe@deloitte.com.cn' : undefined),
    })
    // No full-name source ran: the fallback keeps the email's local part,
    // which differs from the login id and therefore stays usable.
    expect(os?.email).toBe('jane.doe@deloitte.com.cn')
    expect(os?.fullName).toBe('jane.doe')
    expect(warnings).toEqual([])
    // With neither email nor display name the full name collapses onto the
    // login id — exactly the weak shape the warning exists for.
    const weakWarnings: string[] = []
    const weak = await probeSsoOsUser({
      platform: 'win32',
      environment: { USERNAME: 'jdoe' },
      now: () => 0,
      onWarn: message => { weakWarnings.push(message) },
      run: async () => undefined,
    })
    expect(weak?.fullName).toBe('jdoe')
    expect(weak?.email).toBe('')
    expect(weakWarnings).toHaveLength(1)
    expect(weakWarnings[0]).toContain('weak full name')
  })

  it('tries net user /domain and wmic when the local sources miss', async () => {
    const runs: string[] = []
    const os = await probeSsoOsUser({
      platform: 'win32',
      environment: { USERNAME: 'jdoe' },
      now: () => 0,
      run: async (program, args) => {
        runs.push([program, ...args].join(' '))
        if (program === 'net' && args.includes('/domain')) {
          return 'User name                    jdoe\nComment\n'
        }
        if (program === 'wmic') return 'FullName=域名用户\n'
        return undefined
      },
    })
    expect(runs).toEqual([
      'whoami /upn',
      'net user jdoe',
      'net user jdoe /domain',
      'wmic useraccount where name="jdoe" get fullname /format:value',
    ])
    expect(os?.fullName).toBe('域名用户')
    expect(os?.email).toBe('')
  })

  it('respects the overall probe budget', async () => {
    let clock = 0
    const runs: { program: string, timeout: number }[] = []
    const os = await probeSsoOsUser({
      platform: 'win32',
      environment: { USERNAME: 'jdoe' },
      deadlineMs: 3_000,
      now: () => clock,
      run: async (program, _args, timeout) => {
        runs.push({ program, timeout })
        clock += 2_900
        return undefined
      },
    })
    // First two calls run (2s and 2.9s→clamp to 100ms remaining); the rest is
    // starved out by the 200ms floor.
    expect(runs.length).toBeLessThan(4)
    expect(os?.username).toBe('jdoe')
  })

  it('falls back to id -F and environment email off Windows', async () => {
    const os = await probeSsoOsUser({
      platform: 'linux',
      environment: { USER: 'jdoe', EMAIL: 'jane@deloitte.com.cn' },
      now: () => 0,
      run: async program => (program === 'id' ? 'Jane Doe' : undefined),
    })
    expect(os).toEqual({
      username: 'jdoe',
      fullName: 'Jane Doe',
      email: 'jane@deloitte.com.cn',
      domain: '',
    })
  })

  it('returns undefined without any username source', async () => {
    expect(await probeSsoOsUser({
      platform: 'win32',
      environment: {},
      now: () => 0,
      run: async () => undefined,
    })).toBeUndefined()
  })
})

describe('silent login orchestration', () => {
  const os: SsoOsUser = {
    username: 'jdoe',
    fullName: 'Jane Doe',
    email: 'jane.doe@deloitte.com.cn',
    domain: 'CORP',
  }

  it('resolves a session through one SignEntity POST', async () => {
    const request = boundary('{"code":"200","token":"silent-token"}')
    const result = await silentSsoLogin({
      request,
      appId: '1007',
      appKey: APP_KEY,
      probe: async () => os,
    })
    expect(result).toEqual({
      ok: true,
      session: {
        email: 'jane.doe@deloitte.com.cn',
        username: 'jdoe',
        fullName: 'Jane Doe',
        domain: 'CORP',
        token: 'silent-token',
        source: 'silent',
      },
    })
    // The SignEntity carried the display name and the raw OS email.
    const body = JSON.parse(request.calls[0]!.body) as Record<string, string>
    expect(body.jsonData).toBe('{"userName":"Jane Doe","email":"jane.doe@deloitte.com.cn"}')
  })

  it('tries the canonical alias as the second candidate only when it differs', async () => {
    const request = boundary('{"code":"401","message":"Invalid username!"}')
    const warnings: string[] = []
    const result = await silentSsoLogin({
      request,
      appId: '1007',
      appKey: APP_KEY,
      probe: async () => ({ ...os, email: 'jane.doe@deloittecn.com.cn' }),
      onWarn: message => { warnings.push(message) },
    })
    expect(result.ok).toBe(false)
    // Message and portal code share one line — in the returned reason and in
    // each candidate's warn line (the sink masks; the token never appears).
    if (!result.ok) expect(result.reason).toBe('Invalid username! (code 401)')
    expect(warnings).toEqual([
      'dsh-plugin-desktop: sso silent token request failed: Invalid username! (code 401)',
      'dsh-plugin-desktop: sso silent token request failed: Invalid username! (code 401)',
    ])
    expect(request.calls).toHaveLength(2)
    expect(JSON.parse(request.calls[0]!.body).jsonData)
      .toBe('{"userName":"Jane Doe","email":"jane.doe@deloittecn.com.cn"}')
    expect(JSON.parse(request.calls[1]!.body).jsonData)
      .toBe('{"userName":"Jane Doe","email":"jane.doe@deloitte.com.cn"}')
  })

  it('fails with a reason when no identity or email resolves', async () => {
    const noIdentity = await silentSsoLogin({
      request: boundary('{}'),
      probe: async () => undefined,
    })
    expect(noIdentity).toEqual({
      ok: false,
      reason: 'the operating system identity could not be resolved',
    })
    const noEmail = await silentSsoLogin({
      request: boundary('{}'),
      probe: async () => ({ ...os, email: '' }),
    })
    expect(noEmail.ok).toBe(false)
    if (!noEmail.ok) expect(noEmail.reason).toContain('use the browser login')
  })

  it('warns on a weak display name but still posts', async () => {
    const warnings: string[] = []
    const result = await silentSsoLogin({
      request: boundary('{"code":"200","token":"t"}'),
      appId: '1007',
      appKey: APP_KEY,
      probe: async () => ({ ...os, fullName: 'jdoe' }),
      onWarn: message => { warnings.push(message) },
    })
    expect(result.ok).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('weak display name')
  })
})

describe('gate decision, session store, and self-check projection', () => {
  it('gates only locked builds that require sso', () => {
    expect(desktopSsoGateRequired({ locked: true, requireSso: true })).toBe(true)
    expect(desktopSsoGateRequired({ locked: true, requireSso: false })).toBe(false)
    expect(desktopSsoGateRequired({ locked: false, requireSso: true })).toBe(false)
    expect(desktopSsoGateRequired({ locked: false, requireSso: false })).toBe(false)
  })

  it('keeps the session memory-only through the module store', () => {
    expect(getSsoSession()).toBeUndefined()
    setSsoSession({
      email: 'a@deloitte.com.cn',
      username: 'a',
      fullName: 'A',
      domain: 'deloitte.com.cn',
      token: 'secret-token',
      source: 'silent',
    })
    expect(getSsoSession()?.token).toBe('secret-token')
    clearSsoSession()
    expect(getSsoSession()).toBeUndefined()
  })

  it('projects the self-check section without the token', () => {
    expect(ssoSelfCheckStatus(true, undefined)).toEqual({ required: true, authenticated: false })
    expect(ssoSelfCheckStatus(false, undefined)).toEqual({ required: false, authenticated: false })
    expect(ssoSelfCheckStatus(true, {
      email: 'a@deloitte.com.cn',
      username: 'a',
      fullName: 'A',
      domain: 'deloitte.com.cn',
      token: 'secret-token',
      source: 'browser',
    })).toEqual({
      required: true,
      authenticated: true,
      email: 'a@deloitte.com.cn',
      source: 'browser',
    })
  })
})

// Real-network reachability (opt-in through DSH_SSO_NETWORK_TESTS=1): one fake
// SignEntity against the real token endpoint asserts only that the portal
// answers with a recognizable error shape — no real authentication attempt,
// no credentials beyond the embedded app key every client already holds.
describe.skipIf(process.env.DSH_SSO_NETWORK_TESTS !== '1')('portal endpoint reachability', () => {
  it('answers a fake SignEntity with a handled error shape', async () => {
    const result = await silentSsoLogin({
      request: (url, init) => fetch(url, init),
      probe: async () => ({
        username: 'reachability',
        fullName: 'Reachability Probe',
        email: 'reachability.probe@example.com',
        domain: 'EXAMPLE',
      }),
    })
    // The assertion is the shape, not success: the portal must reject a
    // non-employee identity through its documented error surface, and the
    // transport itself must have completed (i.e. no network error).
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0)
      expect(result.reason).not.toMatch(/network error/u)
    }
  })
})
