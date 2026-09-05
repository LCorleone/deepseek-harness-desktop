/**
 * Beta catalog channel (P9): the provider-side merge seam for the
 * host-resolved beta overlay.
 *
 * The Host (the Electron desktop) owns every beta decision — fetch,
 * verify, and the signed SSO tester roster match — and hands the provider
 * an already-filtered package list plus the beta manifest's sequence. These
 * tests pin the provider's half of the contract:
 *
 * - an admitted overlay's entries join the scan: new entries appear as
 *   browsing rows, install candidates, and signed packages (the install
 *   whitelist's source);
 * - the merge rule is additive-with-beta-precedence: a `name@version` both
 *   manifests pin changes nothing when identical (the post-promote steady
 *   state) and the beta entry wins when the signed fields diverge;
 * - every other overlay outcome — `undefined` (a non-roster machine, an
 *   unverified beta file), a thrown resolution, a beta sequence below the
 *   verified stable sequence, an unrepresentable beta entry — keeps the
 *   scan byte-for-byte on the stable manifest alone, never fails the stable
 *   scan, and never touches the anti-rollback ratchet;
 * - the stable verification view (sequence, keyId, expiresAt) stays the
 *   catalog's identity, so receipts keep tracking the stable channel.
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPANY_CATALOG_ADAPTER_ID,
  COMPANY_CATALOG_PROVIDER_ID,
  createCompanyCatalogProvider,
  mergeCompanyBetaPackages,
  type CompanyBetaCatalogOverlayProvider,
  type CompanyManifestSequenceStore,
} from '../src/catalog/company-provider.js'
import type { MarketCompanyManifestRecord } from '../src/catalog/source-store.js'
import type { LocalSourceRecord } from '../src/contracts/index.js'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  type CompanyManifestPackage,
  type CompanyManifestTrustRoot,
} from '../src/signing/index.js'

const keyId = 'company-catalog-2026.09'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustRoots: readonly CompanyManifestTrustRoot[] = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const verifiedAt = Date.parse('2026-09-01T00:00:00.000Z')

const source = (): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac130021',
  registrationKind: 'built-in',
  adapterId: COMPANY_CATALOG_ADAPTER_ID,
  providerId: COMPANY_CATALOG_PROVIDER_ID,
  builtInProviderKey: 'company-catalog',
  enabled: true,
  order: 0,
})

const asUnsigned = (manifest: Record<string, unknown>) =>
  manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0]

function packageEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: 'dsh-plugin-safe',
    version: '1.2.3',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    repository: { url: 'https://github.com/example/dsh-plugin-safe' },
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    ...overrides,
  }
}

function unsignedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [
      packageEntry(),
      packageEntry({ packageName: '@deepseek-ai/cool-plugin', version: '2.0.0', revoked: true }),
    ],
    ...overrides,
  }
}

function signedText(
  manifest: Record<string, unknown> = unsignedManifest(),
  signingKey: KeyObject = privateKey,
): string {
  const signature = createCompanyManifestSignature(asUnsigned(manifest), signingKey, keyId)
  return canonicalJsonText({ ...manifest, signature })
}

function memorySequenceStore(): CompanyManifestSequenceStore & { readonly records: readonly MarketCompanyManifestRecord[] } {
  const records: MarketCompanyManifestRecord[] = []
  return {
    records,
    async load() { return records[records.length - 1] },
    async save(record) { records.push(record) },
  }
}

const contentContext = () => ({
  source: source(),
  signal: new AbortController().signal,
  http: { getJson: vi.fn(async () => { throw new Error('content mode must not fetch') }) },
  media: { register: vi.fn() },
})

function betaProvider(
  stableText: string,
  overlay: CompanyBetaCatalogOverlayProvider,
  options: { logger?: { warn: (message: string) => void } } = {},
) {
  const sequenceStore = memorySequenceStore()
  const provider = createCompanyCatalogProvider({
    manifestContentProvider: () => stableText,
    trustRoots,
    sequenceStore,
    now: () => verifiedAt,
    betaOverlayProvider: overlay,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  return { provider, sequenceStore, context: contentContext() }
}

/** Parse a signed manifest back into the market-known package projections. */
function betaPackagesOf(manifest: Record<string, unknown>): readonly CompanyManifestPackage[] {
  return (manifest.packages as readonly CompanyManifestPackage[])
}

const betaEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  packageEntry({
    packageName: 'dsh-plugin-beta',
    version: '0.9.0',
    ...overrides,
  })

describe('company catalog provider beta overlay (P9)', () => {
  it('an admitted overlay adds beta entries to the browsing rows, install candidates, and signed packages', async () => {
    const betaManifest = unsignedManifest({
      sequence: 43,
      packages: [
        packageEntry(),
        betaEntry({ treeDigest: '648b218888dce4f35b4ab642273f808089e81b5c3bd93e8b42e605117b824237' }),
      ],
    })
    const { provider, context } = betaProvider(
      signedText(),
      async () => ({ packages: betaPackagesOf(betaManifest), sequence: 43 }),
    )

    const snapshots = await provider.scanCatalog!({}, context)

    const items = snapshots.flatMap(snapshot => snapshot.items)
    expect(items.map(item => item.id)).toEqual([
      'npm:dsh-plugin-beta@0.9.0',
      'npm:dsh-plugin-safe@1.2.3',
    ])
    expect(provider.verifiedPackages().map(candidate => candidate.packageName)).toEqual(['dsh-plugin-beta', 'dsh-plugin-safe'])
    expect(provider.findSignedPackage('dsh-plugin-beta', '0.9.0')).toMatchObject({
      treeDigest: '648b218888dce4f35b4ab642273f808089e81b5c3bd93e8b42e605117b824237',
    })
    expect(snapshots[0]?.source.providerRevision).toBe('company-manifest-42+beta')
    expect(provider.verification()).toMatchObject({ sequence: 42 })
  })

  it('a byte-identical overlay entry (the post-promote steady state) changes nothing and adds no duplicate', async () => {
    const stable = unsignedManifest()
    // The beta manifest repeats every stable entry verbatim at a higher
    // sequence — exactly what the pipeline publishes after promote.
    const betaManifest = unsignedManifest({ sequence: 44 })
    const { provider, context } = betaProvider(
      signedText(stable),
      async () => ({ packages: betaPackagesOf(betaManifest), sequence: 44 }),
    )

    const snapshots = await provider.scanCatalog!({}, context)

    const items = snapshots.flatMap(snapshot => snapshot.items)
    expect(items).toHaveLength(1)
    expect(provider.findSignedPackage('dsh-plugin-safe', '1.2.3')).toEqual(betaPackagesOf(stable)[0])
    expect(provider.verifiedPackages()).toHaveLength(1)
  })

  it('a divergent beta entry for the same name@version wins (beta precedence), stable wins for everything else', async () => {
    const betaIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`
    const betaManifest = unsignedManifest({
      sequence: 45,
      packages: [
        packageEntry({ integrity: betaIntegrity, treeDigest: '1111111111111111111111111111111111111111111111111111111111111111' }),
      ],
    })
    const { provider, context } = betaProvider(
      signedText(),
      async () => ({ packages: betaPackagesOf(betaManifest), sequence: 45 }),
    )

    await provider.scanCatalog!({}, context)

    const entry = provider.findSignedPackage('dsh-plugin-safe', '1.2.3')
    expect(entry?.integrity).toBe(betaIntegrity)
    expect(entry?.treeDigest).toBe('1111111111111111111111111111111111111111111111111111111111111111')
  })

  it('an overlay resolving to undefined (a non-roster machine) keeps the scan byte-for-byte stable-only', async () => {
    const overlay = vi.fn(async () => undefined)
    const { provider, sequenceStore, context } = betaProvider(signedText(), overlay)
    // Control: the same stable manifest scanned without any overlay option.
    const control = createCompanyCatalogProvider({
      manifestContentProvider: () => signedText(),
      trustRoots,
      sequenceStore: memorySequenceStore(),
      now: () => verifiedAt,
    })

    const snapshots = await provider.scanCatalog!({}, context)
    const controlSnapshots = await control.scanCatalog!({}, contentContext())

    expect(overlay).toHaveBeenCalledTimes(1)
    expect(snapshots).toEqual(controlSnapshots)
    expect(provider.verifiedPackages().map(candidate => candidate.packageName)).toEqual(['dsh-plugin-safe'])
    expect(provider.findSignedPackage('dsh-plugin-beta', '0.9.0')).toBeUndefined()
    expect(snapshots[0]?.source.providerRevision).toBe('company-manifest-42')
    expect(sequenceStore.records.map(record => record.sequence)).toEqual([42])
  })

  it('a thrown overlay resolution never fails the stable scan and warns once', async () => {
    const warn = vi.fn()
    const { provider, context } = betaProvider(
      signedText(),
      async () => { throw new Error('the beta fetch boundary exploded') },
      { logger: { warn } },
    )

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots.flatMap(snapshot => snapshot.items).map(item => item.id)).toEqual(['npm:dsh-plugin-safe@1.2.3'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).toContain('beta catalog overlay')
  })

  it('a beta sequence below the verified stable sequence is a stale overlay the provider ignores', async () => {
    const warn = vi.fn()
    const betaManifest = unsignedManifest({ sequence: 41, packages: [packageEntry(), betaEntry()] })
    const { provider, context } = betaProvider(
      signedText(),
      async () => ({ packages: betaPackagesOf(betaManifest), sequence: 41 }),
      { logger: { warn } },
    )

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots.flatMap(snapshot => snapshot.items).map(item => item.id)).toEqual(['npm:dsh-plugin-safe@1.2.3'])
    expect(provider.findSignedPackage('dsh-plugin-beta', '0.9.0')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a beta entry that cannot be represented drops the overlay, not the scan', async () => {
    const warn = vi.fn()
    const unrepresentable = unsignedManifest({
      sequence: 46,
      packages: [packageEntry({ packageName: 'x'.repeat(200), version: '9.9.9' })],
    })
    const { provider, context } = betaProvider(
      signedText(),
      async () => ({ packages: betaPackagesOf(unrepresentable), sequence: 46 }),
      { logger: { warn } },
    )

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots.flatMap(snapshot => snapshot.items).map(item => item.id)).toEqual(['npm:dsh-plugin-safe@1.2.3'])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a revoked beta entry stays out of the candidate stream but findable for install-time refusal', async () => {
    const betaManifest = unsignedManifest({
      sequence: 47,
      packages: [packageEntry(), betaEntry({ revoked: true })],
    })
    const { provider, context } = betaProvider(
      signedText(),
      async () => ({ packages: betaPackagesOf(betaManifest), sequence: 47 }),
    )

    await provider.scanCatalog!({}, context)

    expect(provider.verifiedPackages().map(candidate => candidate.packageName)).toEqual(['dsh-plugin-safe'])
    expect(provider.findSignedPackage('dsh-plugin-beta', '0.9.0')?.revoked).toBe(true)
  })

  it('a stable-revoked name@version is not resurrected by a stale beta overlay saying revoked:false (red)', async () => {
    // The incident shape: the revocation reached the stable manifest while
    // the deployed beta file still claims the entry installable. The merge
    // must keep revocation sticky — no browsing row, no candidate, and the
    // signed lookup still reports revoked.
    const staleBeta = unsignedManifest({
      sequence: 49,
      packages: [
        packageEntry(),
        packageEntry({ packageName: '@deepseek-ai/cool-plugin', version: '2.0.0', revoked: false }),
        betaEntry(),
      ],
    })
    const { provider, context } = betaProvider(
      signedText(),
      async () => ({ packages: betaPackagesOf(staleBeta), sequence: 49 }),
    )

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots.flatMap(snapshot => snapshot.items).map(item => item.id))
      .toEqual(['npm:dsh-plugin-beta@0.9.0', 'npm:dsh-plugin-safe@1.2.3'])
    expect(provider.findSignedPackage('@deepseek-ai/cool-plugin', '2.0.0')?.revoked).toBe(true)
  })

  it('rejects a betaOverlayProvider that is not a function', () => {
    expect(() => createCompanyCatalogProvider({
      manifestContentProvider: () => signedText(),
      trustRoots,
      // The cast mirrors what a JS caller could do; the constructor must refuse.
      betaOverlayProvider: 'not-a-function' as unknown as CompanyBetaCatalogOverlayProvider,
    })).toThrow(TypeError)
  })
})

describe('mergeCompanyBetaPackages (P9)', () => {
  it('appends new entries, replaces divergent ones, and keeps identical ones once', () => {
    const stable = betaPackagesOf(unsignedManifest())
    const beta = betaPackagesOf(unsignedManifest({
      sequence: 48,
      packages: [
        packageEntry({ integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}` }),
        betaEntry(),
        packageEntry({ packageName: 'dsh-plugin-extra', version: '5.0.0' }),
      ],
    }))
    const merged = mergeCompanyBetaPackages(stable, beta)
    expect(merged.map(entry => `${entry.packageName}@${entry.version}`)).toEqual([
      '@deepseek-ai/cool-plugin@2.0.0',
      'dsh-plugin-beta@0.9.0',
      'dsh-plugin-extra@5.0.0',
      'dsh-plugin-safe@1.2.3',
    ])
    expect(merged.find(entry => entry.packageName === 'dsh-plugin-safe')?.integrity)
      .toBe(`sha512-${Buffer.alloc(64, 3).toString('base64')}`)
    expect(merged.find(entry => entry.packageName === 'dsh-plugin-safe')?.revoked).toBe(false)
  })

  it('never resurrects a stable-revoked name@version: revocation is sticky across the merge (red)', () => {
    const stable = betaPackagesOf(unsignedManifest()) // pins @deepseek-ai/cool-plugin@2.0.0 revoked:true
    const beta = betaPackagesOf(unsignedManifest({
      sequence: 50,
      packages: [
        packageEntry(),
        packageEntry({ packageName: '@deepseek-ai/cool-plugin', version: '2.0.0', revoked: false }),
      ],
    }))
    const merged = mergeCompanyBetaPackages(stable, beta)
    expect(merged.find(entry => entry.packageName === '@deepseek-ai/cool-plugin')?.revoked).toBe(true)
    expect(merged).toHaveLength(2)
  })
})
