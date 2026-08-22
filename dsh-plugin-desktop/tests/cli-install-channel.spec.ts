import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import {
  authorizeLockedPluginAdd,
  companyManifestAssetPath,
  parseExactPluginAddSpec,
} from '../src/cli-install-channel.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'
import type { DesktopPolicy } from '../src/desktop-policy.ts'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')

function lockedCatalogPolicy(overrides: Record<string, unknown> = {}): DesktopPolicy {
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked: true,
    trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
    ...overrides,
  })
}

const asUnsigned = (manifest: Record<string, unknown>) =>
  manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0]

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: 'example-plugin',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    ...overrides,
  }
}

function unsignedCatalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [catalogEntry()],
    ...overrides,
  }
}

describe('locked plugin-add spec parsing', () => {
  it.each([
    ['example-plugin@1.0.0', { packageName: 'example-plugin', version: '1.0.0' }],
    ['@scope/example-plugin@20.3.4', { packageName: '@scope/example-plugin', version: '20.3.4' }],
  ])('accepts the exact form %s', (spec, expected) => {
    expect(parseExactPluginAddSpec(spec)).toEqual(expected)
  })

  it.each([
    ['bare package name', 'example-plugin'],
    ['dist tag', 'example-plugin@latest'],
    ['caret range', 'example-plugin@^1.0.0'],
    ['gte range', 'example-plugin@>=1.0.0 <2.0.0'],
    ['prerelease', 'example-plugin@1.0.0-beta.1'],
    ['build metadata', 'example-plugin@1.0.0+build.7'],
    ['leading v', 'example-plugin@v1.0.0'],
    ['leading zero', 'example-plugin@01.0.0'],
    ['missing patch', 'example-plugin@1.0'],
    ['empty spec', ''],
    ['scoped name without version', '@scope/example-plugin'],
    ['at only', '@'],
    ['uppercase package name', 'Example-Plugin@1.0.0'],
  ])('rejects the non-exact form %s', (_label, spec) => {
    expect(parseExactPluginAddSpec(spec)).toBeUndefined()
  })
})

describe('company manifest asset path', () => {
  it('resolves the policy manifest URL beside a built module', () => {
    const moduleUrl = pathToFileURL('/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/desktop-cli.js').href
    expect(companyManifestAssetPath(moduleUrl, 'company-market/catalog-manifest.json'))
      .toBe('/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/company-market/catalog-manifest.json')
  })

  it.each([
    ['empty module URL', ''],
    ['non-string module URL', undefined],
  ])('rejects %s', (_label, moduleUrl) => {
    expect(() => companyManifestAssetPath(moduleUrl as string, 'company-market/catalog-manifest.json'))
      .toThrow('non-empty file URL')
  })

  it.each([
    ['absolute path', '/etc/company/catalog-manifest.json'],
    ['parent escape', '../company-market/catalog-manifest.json'],
    ['dot segment', './company-market/catalog-manifest.json'],
    ['empty segment', 'company-market//catalog-manifest.json'],
    ['backslash', 'company-market\\catalog-manifest.json'],
    ['NUL byte', 'company-market/catalog-manifest.json\0'],
    ['empty URL', ''],
  ])('rejects the manifest URL %s', (_label, companyManifestUrl) => {
    const moduleUrl = pathToFileURL('/app/lib/desktop-cli.js').href
    expect(() => companyManifestAssetPath(moduleUrl, companyManifestUrl))
      .toThrow('company manifest URL')
  })
})

describe('locked plugin-add authorization', () => {
  const roots = mkdtempSync(join(tmpdir(), 'dsh-desktop-cli-install-channel-'))

  afterEach(() => {
    rmSync(roots, { recursive: true, force: true })
  })

  function writeCatalog(manifest: Record<string, unknown>, directory = roots): string {
    const signature = createCompanyManifestSignature(asUnsigned(manifest), privateKey, keyId)
    const assetPath = join(directory, 'company-market', 'catalog-manifest.json')
    mkdirSync(join(directory, 'company-market'), { recursive: true })
    writeFileSync(assetPath, canonicalJsonText({ ...manifest, signature }))
    return assetPath
  }

  it('allows an exact target with a verified unrevoked entry', async () => {
    const assetPath = writeCatalog(unsignedCatalog())

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision).toEqual({
      allowed: true,
      packages: [{ packageName: 'example-plugin', version: '1.0.0' }],
    })
  })

  it('denies spec counts other than exactly one package argument', async () => {
    const decision = await authorizeLockedPluginAdd([], lockedCatalogPolicy())

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('exactly one package argument')
  })

  it('denies non-exact specs before touching the manifest asset', async () => {
    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@latest'],
      lockedCatalogPolicy(),
      { assetPath: join(roots, 'missing-asset.json') },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('<exact version>')
      expect(decision.reason).toContain('company plugin market')
    }
  })

  it('denies network-catalog policies that have no embedded asset', async () => {
    const policy = parseDesktopPolicy({
      allowHomePatch: false,
      allowManualPluginAdd: false,
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
      locked: true,
      trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
    })

    const decision = await authorizeLockedPluginAdd(['example-plugin@1.0.0'], policy)

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('embedded in the application')
      expect(decision.reason).toContain('company plugin market')
    }
  })

  it('denies an unreadable manifest asset', async () => {
    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath: join(roots, 'absent', 'catalog-manifest.json') },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('unreadable company catalog manifest asset')
  })

  it('denies a tampered manifest with the verification code', async () => {
    const assetPath = writeCatalog(unsignedCatalog())
    writeFileSync(assetPath, 'not json at all')

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('malformed-json')
  })

  it('denies an expired manifest against the injected clock', async () => {
    const assetPath = writeCatalog(unsignedCatalog({ expiresAt: '2026-01-01T00:00:00Z' }))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath, now: () => Date.parse('2026-06-01T00:00:00.000Z') },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('expired')
      expect(decision.reason).toContain('2026-01-01T00:00:00Z')
    }
  })

  it('denies packages the signed catalog does not contain', async () => {
    const assetPath = writeCatalog(unsignedCatalog())

    const decision = await authorizeLockedPluginAdd(
      ['unapproved-plugin@9.9.9'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('not in the signed company plugin catalog')
  })

  it('denies revoked entries while keeping the audit trail readable', async () => {
    const assetPath = writeCatalog(unsignedCatalog({
      packages: [catalogEntry({ revoked: true })],
    }))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('revoked in the signed company plugin catalog')
  })
})
