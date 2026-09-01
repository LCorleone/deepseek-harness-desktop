import { createHash } from 'node:crypto'
import { get } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SSO_CALLBACK_SUCCESS_HTML,
  SsoCallbackServer,
  browserSsoLogin,
  buildSsoCodeChallenge,
  buildSsoLoginUrl,
  buildSsoRedirectUri,
  buildSsoSignEntity,
  buildSsoTokenJsonData,
  canonicalizeSsoEmail,
  clearSsoSession,
  decodeSsoCallbackCode,
  desktopSsoGateRequired,
  fetchSsoToken,
  formatSsoProcessTime,
  getSsoSession,
  getSsoEncodeStr,
  probeSsoOsUser,
  setSsoSession,
  silentSsoLogin,
  ssoAppId,
  ssoAppKey,
  ssoBaseUrl,
  ssoCallbackFailureHtml,
  ssoLoginUrl,
  ssoSessionFromPayload,
  ssoSelfCheckStatus,
  ssoTokenUrl,
  ssoUsernameFromPayload,
  type SsoOsUser,
  type SsoRequestBoundary,
} from '../src/company-sso.ts'

const APP_KEY = '[REDACTED-SO-APP-KEY-2026-09-02]'

/** Response stub factory for the injected fetch boundary. */
function boundary(
  body: string,
  status = 200,
): SsoRequestBoundary & { calls: { url: string, body: string }[] } {
  const calls: { url: string, body: string }[] = []
  const request = async (url: string, init: Parameters<SsoRequestBoundary>[1]) => {
    calls.push({ url, body: init.body })
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
    expect(ssoAppId({})).toBe('1007')
    expect(ssoAppKey({})).toBe(APP_KEY)
    expect(ssoLoginUrl()).toBe('https://sdp.deloitte.com.cn/web/login')
    expect(ssoTokenUrl()).toBe('https://sdp.deloitte.com.cn/web/dai/token')
  })

  it('honors environment overrides for tests', () => {
    expect(ssoAppId({ DSH_SSO_APP_ID: ' 9999 ' })).toBe('9999')
    expect(ssoAppKey({ DSH_SSO_APP_KEY: 'test-key' })).toBe('test-key')
    // Empty spellings fall back to the built-ins.
    expect(ssoAppId({ DSH_SSO_APP_ID: ' ' })).toBe('1007')
    expect(ssoBaseUrl({ DSH_SSO_BASE_URL: 'https://sso-test.example/' }))
      .toBe('https://sso-test.example')
    expect(ssoTokenUrl({ DSH_SSO_BASE_URL: 'https://sso-test.example' }))
      .toBe('https://sso-test.example/web/dai/token')
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
    expect(entity.process_time).toBe('2026-08-31 12:00:00')
    expect(entity.app_name).toBe('DSH Desktop')
    // Golden vector: sha256 over encodeStr(id + processTime + appKey + jsonData),
    // computed independently of the implementation under test.
    expect(entity.signature).toBe('LE+k93vW/q1D4EzZ4HuI8n4Y49UHq8EshfwvNPCbTsI=')
    // The JSON body's insertion order is id-first, matching the portal's
    // Node-insertion-order expectation.
    expect(JSON.stringify(entity).startsWith('{"id":')).toBe(true)
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
    expect(JSON.parse(numericCode.calls[0]!.body)).toMatchObject({ app_id: '1007' })
  })

  it('rejects every non-success answer with the portal message', async () => {
    await expect(fetchSsoToken('{}', {
      request: boundary('{"code":"401","message":"Invalid username!"}'),
      appId: '1007',
      appKey: APP_KEY,
    })).rejects.toThrow('Invalid username!')
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
    verify: 'TYCiKE7vnZjble54pVfNyOdHR0qypov5BiWgCl0TMx8=',
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
    verify: 'TYCiKE7vnZjble54pVfNyOdHR0qypov5BiWgCl0TMx8=',
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
    const opened: string[] = []
    let openedUrl: ((url: string) => void) | undefined
    const openedSignal = new Promise<void>(resolve => { openedUrl = url => { void url; resolve() } })
    const login = browserSsoLogin({
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
    expect(url.searchParams.get('app_id')).toBe('1007')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/u)
    expect(url.searchParams.get('code_challenge')).toBe(
      buildSsoCodeChallenge(url.searchParams.get('redirect_uri')!, '1007', 1_789_000_000),
    )
    const callbackPort = Number(new URL(url.searchParams.get('redirect_uri')!).port)
    const response = await new Promise<{ status: number, body: string }>(resolve => {
      get(`http://127.0.0.1:${String(callbackPort)}/callback?code=${encodeCallback(validPayload)}`, res => {
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
  })

  it('reports an opener failure without leaving a waiter behind', async () => {
    const result = await browserSsoLogin({
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
    expect(body.json_data).toBe('{"userName":"Jane Doe","email":"jane.doe@deloitte.com.cn"}')
  })

  it('tries the canonical alias as the second candidate only when it differs', async () => {
    const request = boundary('{"code":"401","message":"Invalid username!"}')
    const result = await silentSsoLogin({
      request,
      appId: '1007',
      appKey: APP_KEY,
      probe: async () => ({ ...os, email: 'jane.doe@deloittecn.com.cn' }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('Invalid username!')
    expect(request.calls).toHaveLength(2)
    expect(JSON.parse(request.calls[0]!.body).json_data)
      .toBe('{"userName":"Jane Doe","email":"jane.doe@deloittecn.com.cn"}')
    expect(JSON.parse(request.calls[1]!.body).json_data)
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
