import { describe, expect, it } from 'vitest'
import { maskSecrets } from '../src/mask-secrets.ts'

describe('maskSecrets', () => {
  it('masks API key values', () => {
    const masked = maskSecrets('key is sk-1234abcd5678')
    expect(masked).toContain('sk-****')
    expect(masked).not.toContain('sk-1234abcd')
  })

  it('masks bearer tokens in headers', () => {
    const masked = maskSecrets('Authorization: Bearer abc.def.ghi')
    expect(masked).toContain('Bearer ****')
    expect(masked).not.toContain('abc.def.ghi')
  })

  it('masks basic authorization credentials', () => {
    const masked = maskSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA==')
    expect(masked).toBe('Authorization: Basic ****')
    expect(masked).not.toContain('dXNlcjpwYXNzd29yZA==')
  })

  it('masks cookie header values', () => {
    const masked = maskSecrets('Cookie: session=short-secret; theme=dark')
    expect(masked).toBe('Cookie: ****')
    expect(masked).not.toContain('short-secret')
  })

  it('masks URL userinfo and sensitive query values', () => {
    const masked = maskSecrets('GET https://user:pass@example.com/api?token=short&mode=fast')
    expect(masked).toBe('GET https://****:****@example.com/api?token=****&mode=fast')
    expect(masked).not.toContain('user:pass')
    expect(masked).not.toContain('token=short')
  })

  it('masks named secret fields even when their values are short', () => {
    const masked = maskSecrets('api_key=short password: hunter2 mode=fast')
    expect(masked).toBe('api_key=**** password: **** mode=fast')
    expect(masked).not.toContain('hunter2')
  })

  it('masks bare UUID-shaped tokens the long-token rule cannot see', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    // Contrast with the pre-existing rules: every hyphen-delimited run is far
    // shorter than the 32+ character token rule, so a bare company gateway
    // key in UUID form survives those rules and only the dedicated UUID
    // pattern masks it.
    expect(uuid.split('-').every(run => run.length < 32)).toBe(true)

    const masked = maskSecrets(`gateway rejected key ${uuid} for route dsh-company-gateway`)
    expect(masked).toBe(`gateway rejected key ${uuid.slice(0, 3)}**** for route dsh-company-gateway`)
    expect(masked).not.toContain(uuid)
  })

  it('masks the company gateway key the generic named rule misses', () => {
    // Contrast with NAMED_SECRET: `\bkey\b` finds no word boundary inside the
    // underscored DSH_COMPANY_LLM_KEY identifier, so the generic rule passes
    // over it; the dedicated rule masks even values too short for any token
    // pattern to catch.
    const masked = maskSecrets('DSH_COMPANY_LLM_KEY=shortkey1 mode=fast')
    expect(masked).toBe('DSH_COMPANY_LLM_KEY=**** mode=fast')
    expect(masked).not.toContain('shortkey1')
  })

  it('masks UUID-valued company gateway keys in env and JSON renderings', () => {
    const uuid = '0f8d4a1c-23b5-47e9-8c6a-9d0e1f2a3b4c'
    expect(maskSecrets(`DSH_COMPANY_LLM_KEY=${uuid}`)).toBe('DSH_COMPANY_LLM_KEY=****')
    // Quoted JSON defeats the named rule (the closing quote precedes the
    // separator), but the UUID pattern still masks the value itself.
    expect(maskSecrets(JSON.stringify({ DSH_COMPANY_LLM_KEY: uuid }))).toBe(`{"DSH_COMPANY_LLM_KEY":"${uuid.slice(0, 3)}****"}`)
  })

  it('masks quoted secret fields in rendered JSON', () => {
    const masked = maskSecrets(JSON.stringify({
      api_key: 'short-secret',
      code: 'short-code',
      nested: {
        access_token: 'access123',
        authorization: 'custom-auth',
        password: 'hunter2',
        token: 'abc123',
        'x-api-key': 'short-key',
      },
      mode: 'fast',
    }))

    expect(masked).toBe('{"api_key":"****","code":"****","nested":{"access_token":"****","authorization":"****","password":"****","token":"****","x-api-key":"****"},"mode":"fast"}')
    expect(masked).not.toContain('short-secret')
    expect(masked).not.toContain('short-code')
    expect(masked).not.toContain('access123')
    expect(masked).not.toContain('custom-auth')
    expect(masked).not.toContain('short-key')
    expect(masked).not.toContain('hunter2')
    expect(masked).not.toContain('abc123')
  })

  it('leaves ordinary prose untouched', () => {
    expect(maskSecrets('hello world, profile "desktop"')).toBe('hello world, profile "desktop"')
  })
})
