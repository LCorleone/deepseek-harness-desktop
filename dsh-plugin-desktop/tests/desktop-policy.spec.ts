import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopPolicyAssetPath,
  parseDesktopPolicy,
  readDesktopPolicy,
} from '../src/desktop-policy.ts'

const roots: string[] = []

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-policy-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function companyPolicy(): Record<string, unknown> {
  return {
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: 'https://market.company.example',
    companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    locked: true,
    trustRoots: [
      { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
      { keyId: 'company-2026-b', fingerprint: '0123456789abcdef'.repeat(4) },
    ],
  }
}

describe('desktop policy schema parsing', () => {
  it('accepts a locked network-catalog policy with overlapping trust roots', () => {
    const policy = parseDesktopPolicy(companyPolicy())

    expect(policy).toEqual({
      locked: true,
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
      allowHomePatch: false,
      allowManualPluginAdd: false,
      trustRoots: [
        { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
        { keyId: 'company-2026-b', fingerprint: '0123456789abcdef'.repeat(4) },
      ],
    })
    expect(policy.trustRoots).toHaveLength(2)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.trustRoots)).toBe(true)
  })

  it('normalizes the catalog origin and manifest URL', () => {
    const policy = parseDesktopPolicy({
      ...companyPolicy(),
      companyCatalogOrigin: 'https://Market.Company.Example/',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json?from=policy',
    })

    expect(policy.companyCatalogOrigin).toBe('https://market.company.example')
    expect(policy.companyManifestUrl).toBe(
      'https://market.company.example/catalog-manifest.json?from=policy',
    )
  })

  it('accepts an unlocked catalog-as-content policy', () => {
    const policy = parseDesktopPolicy({
      allowHomePatch: false,
      allowManualPluginAdd: false,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
      locked: false,
      trustRoots: [],
    })

    expect(policy.locked).toBe(false)
    expect(policy.companyCatalogOrigin).toBe(null)
    expect(policy.companyManifestUrl).toBe('company-market/catalog-manifest.json')
    expect(policy.trustRoots).toEqual([])
  })

  it.each([
    'allowHomePatch',
    'allowManualPluginAdd',
    'companyCatalogOrigin',
    'companyManifestUrl',
    'locked',
    'trustRoots',
  ])('rejects a policy missing %s', field => {
    const document = companyPolicy()
    delete document[field]

    expect(() => parseDesktopPolicy(document)).toThrow('unexpected fields')
  })

  it('rejects unexpected fields', () => {
    expect(() => parseDesktopPolicy({ ...companyPolicy(), extra: true }))
      .toThrow('unexpected fields')
  })

  it.each([
    null,
    [],
    'locked',
    42,
  ])('rejects the non-object root %j', value => {
    expect(() => parseDesktopPolicy(value)).toThrow('root must be an object')
  })

  it.each([
    ['locked as text', { locked: 'true' }, 'locked must be a boolean'],
    ['enabled home patching', { allowHomePatch: true }, 'allowHomePatch must be false'],
    ['enabled manual plugin add', { allowManualPluginAdd: true }, 'allowManualPluginAdd must be false'],
    ['http catalog origin', { companyCatalogOrigin: 'http://market.company.example' }, 'companyCatalogOrigin'],
    ['catalog origin with a path', { companyCatalogOrigin: 'https://market.company.example/catalog' }, 'companyCatalogOrigin'],
    ['numeric catalog origin', { companyCatalogOrigin: 1 }, 'companyCatalogOrigin'],
    ['cross-origin manifest', { companyManifestUrl: 'https://evil.example/catalog-manifest.json' }, 'must stay inside companyCatalogOrigin'],
    ['http manifest', { companyManifestUrl: 'http://market.company.example/catalog-manifest.json' }, 'must be an absolute https URL'],
    ['relative manifest in network mode', { companyManifestUrl: 'catalog-manifest.json' }, 'must be an absolute https URL'],
    ['empty manifest', { companyManifestUrl: '' }, 'must be a non-empty path'],
    ['traversal manifest in content mode', {
      companyCatalogOrigin: null,
      companyManifestUrl: '../outside/catalog-manifest.json',
    }, 'must be a relative bundled asset path'],
    ['absolute manifest in content mode', {
      companyCatalogOrigin: null,
      companyManifestUrl: '/etc/catalog-manifest.json',
    }, 'must be a relative bundled asset path'],
    ['backslash manifest in content mode', {
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market\\catalog-manifest.json',
    }, 'must be a non-empty path'],
    ['trust roots as an object', { trustRoots: {} }, 'trustRoots must be an array'],
    ['trust root that is not an object', { trustRoots: ['company-2026-a'] }, 'trust roots must be objects'],
    ['trust root with extra fields', {
      trustRoots: [{ keyId: 'company-2026-a', fingerprint: 'a'.repeat(64), algorithm: 'ed25519' }],
    }, 'trust roots have unexpected fields'],
    ['trust root with an invalid key id', {
      trustRoots: [{ keyId: 'invalid key!', fingerprint: 'a'.repeat(64) }],
    }, 'trust root keyId is invalid'],
    ['trust root with a short fingerprint', {
      trustRoots: [{ keyId: 'company-2026-a', fingerprint: 'a'.repeat(63) }],
    }, 'trust root fingerprint must be 64 lowercase hex characters'],
    ['trust root with an uppercase fingerprint', {
      trustRoots: [{ keyId: 'company-2026-a', fingerprint: 'A'.repeat(64) }],
    }, 'trust root fingerprint must be 64 lowercase hex characters'],
    ['duplicate trust root key id', {
      trustRoots: [
        { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
        { keyId: 'company-2026-a', fingerprint: 'b'.repeat(64) },
      ],
    }, 'duplicate trust root keyId'],
    ['duplicate trust root fingerprint', {
      trustRoots: [
        { keyId: 'company-2026-a', fingerprint: 'a'.repeat(64) },
        { keyId: 'company-2026-b', fingerprint: 'a'.repeat(64) },
      ],
    }, 'duplicate trust root fingerprint'],
  ])('rejects %s', (_label, patch, message) => {
    expect(() => parseDesktopPolicy({ ...companyPolicy(), ...patch })).toThrow(message)
  })
})

describe('desktop policy asset location', () => {
  it('resolves the policy asset beside a built module', () => {
    const assetPath = desktopPolicyAssetPath(import.meta.url)

    expect(assetPath).toBe(join(
      dirname(fileURLToPath(import.meta.url)),
      'policy',
      'desktop-policy.json',
    ))
    expect(assetPath.endsWith(join('policy', 'desktop-policy.json'))).toBe(true)
  })

  it('rejects module URLs that are not file URLs', () => {
    expect(() => desktopPolicyAssetPath('lib/index.js')).toThrow()
    expect(() => desktopPolicyAssetPath('')).toThrow()
  })
})

describe('desktop policy asset reading', () => {
  it('reads a locked policy from an injected asset path', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, `${JSON.stringify(companyPolicy())}\n`, 'utf8')

    expect(readDesktopPolicy(assetPath).locked).toBe(true)
  })

  it('reads an unlocked policy from an injected asset path', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, `${JSON.stringify({ ...companyPolicy(), locked: false })}\n`, 'utf8')

    expect(readDesktopPolicy(assetPath).locked).toBe(false)
  })

  it('fails closed on corrupted JSON', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, '{broken', 'utf8')

    expect(() => readDesktopPolicy(assetPath)).toThrow('unreadable desktop policy asset')
  })

  it('fails closed on a missing asset', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')

    expect(existsSync(assetPath)).toBe(false)
    expect(() => readDesktopPolicy(assetPath)).toThrow('unreadable desktop policy asset')
  })

  it('fails closed on a semantically invalid asset', () => {
    const assetPath = join(temporaryDirectory(), 'desktop-policy.json')
    writeFileSync(assetPath, `${JSON.stringify({ ...companyPolicy(), locked: 'yes' })}\n`, 'utf8')

    expect(() => readDesktopPolicy(assetPath)).toThrow('invalid desktop policy')
  })

  it('rejects relative injected asset paths', () => {
    expect(() => readDesktopPolicy('policy/desktop-policy.json'))
      .toThrow('must be absolute without NUL')
    expect(() => readDesktopPolicy('policy\0/desktop-policy.json'))
      .toThrow('must be absolute without NUL')
  })
})

describe('shipped desktop policy assets', () => {
  it('ships an unlocked dev policy with placeholder defaults', () => {
    const text = readFileSync(new URL('../src/policy/desktop-policy.dev.json', import.meta.url), 'utf8')
    const policy = parseDesktopPolicy(JSON.parse(text))

    expect(policy.locked).toBe(false)
    expect(policy.companyCatalogOrigin).toBe(null)
    expect(policy.companyManifestUrl).toBe('company-market/catalog-manifest.json')
    expect(policy.allowHomePatch).toBe(false)
    expect(policy.allowManualPluginAdd).toBe(false)
    expect(policy.trustRoots).toEqual([])
  })

  it('ships a locked release policy with the same placeholder defaults', () => {
    const text = readFileSync(new URL('../src/policy/desktop-policy.release.json', import.meta.url), 'utf8')
    const policy = parseDesktopPolicy(JSON.parse(text))

    expect(policy.locked).toBe(true)
    expect(policy.companyCatalogOrigin).toBe(null)
    expect(policy.companyManifestUrl).toBe('company-market/catalog-manifest.json')
    expect(policy.allowHomePatch).toBe(false)
    expect(policy.allowManualPluginAdd).toBe(false)
    expect(policy.trustRoots).toEqual([])
  })
})
