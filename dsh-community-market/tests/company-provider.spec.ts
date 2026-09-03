import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPANY_CATALOG_ADAPTER_ID,
  COMPANY_CATALOG_BUILT_IN_KEY,
  COMPANY_CATALOG_CONTENT_FINAL_URL,
  COMPANY_CATALOG_PROVIDER_ID,
  CompanyCatalogUntrustedError,
  createCompanyCatalogProvider,
  SettingsCompanyManifestSequenceStore,
  type CompanyCatalogProviderOptions,
  type CompanyManifestSequenceStore,
  type CompanyManifestVerifier,
} from '../src/catalog/company-provider.js'
import {
  MemoryCatalogSourceStore,
  type MarketCompanyManifestRecord,
  type MarketSettingsDocument,
  type MarketSettingsMutatingScope,
} from '../src/catalog/source-store.js'
import { DefaultCatalogService } from '../src/catalog/service.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/index.js'
import { registerMarketSettings } from '../src/host/routes.js'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  verifyCompanyManifest,
  type CompanyManifestPackage,
  type CompanyManifestTrustRoot,
} from '../src/signing/index.js'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const { privateKey: strangerPrivateKey } = generateKeyPairSync('ed25519')
const trustRoots: readonly CompanyManifestTrustRoot[] = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const verifiedAt = Date.parse('2026-09-01T00:00:00.000Z')
const MANIFEST_URL = 'https://catalog.company.example/manifest.json'

const source = (): LocalSourceRecord => ({
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120021',
  registrationKind: 'built-in',
  adapterId: COMPANY_CATALOG_ADAPTER_ID,
  providerId: COMPANY_CATALOG_PROVIDER_ID,
  builtInProviderKey: COMPANY_CATALOG_BUILT_IN_KEY,
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
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2', nodeRuntimeVersion: '>=22.0.0' },
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
      packageEntry({
        packageName: '@deepseek-ai/cool-plugin',
        version: '2.0.0',
        revoked: false,
        repository: { url: 'https://github.com/DeepSeek-AI/Cool-Plugin' },
      }),
      packageEntry({ packageName: 'dsh-plugin-retired', version: '3.1.4', revoked: true }),
    ],
    ...overrides,
  }
}

function signedText(
  manifest: Record<string, unknown> = unsignedManifest(),
  signingKey: KeyObject = privateKey,
  signingKeyId: string = keyId,
): string {
  const signature = createCompanyManifestSignature(asUnsigned(manifest), signingKey, signingKeyId)
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

function contentProvider(text: () => string) {
  return vi.fn(() => text())
}

function contentContext() {
  const http: CatalogHttpClient = { getJson: vi.fn(async () => { throw new Error('content mode must not fetch') }) }
  return {
    source: source(),
    signal: new AbortController().signal,
    http,
    media: { register: vi.fn() },
  }
}

function contentProviderScan(
  text: () => string,
  sequenceStore: CompanyManifestSequenceStore = memorySequenceStore(),
  logger?: Pick<Context['logger'], 'warn'>,
  manifestVerifier?: CompanyCatalogProviderOptions['manifestVerifier'],
) {
  const provider = createCompanyCatalogProvider({
    manifestContentProvider: contentProvider(text),
    trustRoots,
    sequenceStore,
    now: () => verifiedAt,
    ...(logger === undefined ? {} : { logger }),
    ...(manifestVerifier === undefined ? {} : { manifestVerifier }),
  })
  return { provider, sequenceStore, context: contentContext() }
}

/** Store that keeps no ratchet, so repeated verification of one manifest is allowed. */
const replayTolerantStore: CompanyManifestSequenceStore = {
  async load() { return undefined },
  async save() {},
}

const untrusted = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    cause => cause,
  )
  expect(error).toBeInstanceOf(CompanyCatalogUntrustedError)
  return error as CompanyCatalogUntrustedError
}

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Host logger sink for asserting the self-heal path warns loudly. */
const warnLogger = () => ({ warn: vi.fn() })

describe('company catalog provider construction', () => {
  it('requires exactly one acquisition mode and at least one trust root', () => {
    expect(() => createCompanyCatalogProvider({ trustRoots })).toThrow(TypeError)
    expect(() => createCompanyCatalogProvider({
      companyManifestUrl: MANIFEST_URL,
      manifestContentProvider: () => '[]',
      trustRoots,
    })).toThrow(TypeError)
    expect(() => createCompanyCatalogProvider({ manifestContentProvider: () => '', trustRoots: [] })).toThrow(TypeError)
    expect(() => createCompanyCatalogProvider({
      companyManifestUrl: 'http://insecure.example/manifest.json',
      trustRoots,
    })).toThrow(TypeError)
    expect(() => createCompanyCatalogProvider({
      companyManifestUrl: 'https://user:pass@catalog.company.example/manifest.json',
      trustRoots,
    })).toThrow(TypeError)
    expect(() => createCompanyCatalogProvider({
      companyManifestUrl: MANIFEST_URL,
      trustRoots,
    })).not.toThrow()
  })
})

describe('company catalog provider (content mode)', () => {
  it('converts a verified manifest into installable candidates with signed metadata', async () => {
    const { provider, context } = contentProviderScan(() => signedText())

    const snapshots = await provider.scanCatalog!({}, context)

    const items = snapshots.flatMap(snapshot => snapshot.items)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      id: 'npm:dsh-plugin-safe@1.2.3',
      name: 'dsh-plugin-safe',
      displayName: 'dsh-plugin-safe',
      summary: 'Company signed catalog entry dsh-plugin-safe@1.2.3',
      repository: { url: 'https://github.com/example/dsh-plugin-safe' },
      package: { registry: 'npm', name: 'dsh-plugin-safe' },
      latestVersion: '1.2.3',
      provenance: {
        sourceRecordId: source().sourceRecordId,
        providerId: COMPANY_CATALOG_PROVIDER_ID,
        itemId: 'npm:dsh-plugin-safe@1.2.3',
      },
    })
    // The signed VCS identity is carried through verbatim (normalized), not
    // replaced by a registry page URL: install-time verification back-links it
    // against the live npm metadata.
    expect(items[1]?.repository).toEqual({ url: 'https://github.com/deepseek-ai/cool-plugin' })
    expect(items.map(item => item.id)).toEqual([
      'npm:dsh-plugin-safe@1.2.3',
      'npm:@deepseek-ai/cool-plugin@2.0.0',
    ])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.source).toMatchObject({
      sourceRecordId: source().sourceRecordId,
      providerId: COMPANY_CATALOG_PROVIDER_ID,
      adapterId: COMPANY_CATALOG_ADAPTER_ID,
      registrationKind: 'built-in',
      fetchedAt: '2026-09-01T00:00:00.000Z',
      finalUrl: COMPANY_CATALOG_CONTENT_FINAL_URL,
      providerRevision: 'company-manifest-42',
    })
    expect(snapshots[0]?.page.total).toBe(2)
    expect(context.http.getJson).not.toHaveBeenCalled()
    expect(context.media.register).not.toHaveBeenCalled()

    expect(provider.verifiedPackages()).toEqual([
      expect.objectContaining({
        itemId: 'npm:dsh-plugin-safe@1.2.3',
        packageName: 'dsh-plugin-safe',
        version: '1.2.3',
        integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
        bundlePatch: './cordis.patch.yml',
        runtime: { dshRuntimeVersion: '^0.1.1-rc.2', nodeRuntimeVersion: '>=22.0.0' },
      }),
      expect.objectContaining({ packageName: '@deepseek-ai/cool-plugin', version: '2.0.0' }),
    ])
    expect(provider.findVerifiedPackage('dsh-plugin-safe', '1.2.3')).toMatchObject({
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    })
    expect(provider.verification()).toMatchObject({
      mode: 'content',
      sequence: 42,
      keyId,
      expiresAt: '2030-01-01T00:00:00Z',
      verifiedAt: '2026-09-01T00:00:00.000Z',
    })
  })

  it('carries a signed repository subdirectory through to catalog items', async () => {
    // Monorepo packages sign `{url, subdirectory}` (npm `repository.directory`);
    // install-time verification compares both parts against the live npm
    // metadata, so the catalog item must keep the subdirectory, not just the URL.
    const { provider, context } = contentProviderScan(() => signedText(unsignedManifest({
      packages: [packageEntry({
        repository: {
          url: 'https://github.com/example/company-monorepo',
          subdirectory: 'packages/dsh-plugin-safe',
        },
      })],
    })))

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots[0]?.items).toHaveLength(1)
    expect(snapshots[0]?.items[0]?.repository).toEqual({
      url: 'https://github.com/example/company-monorepo',
      subdirectory: 'packages/dsh-plugin-safe',
    })
    expect(provider.findVerifiedPackage('dsh-plugin-safe', '1.2.3')).toMatchObject({
      packageName: 'dsh-plugin-safe',
      version: '1.2.3',
    })
  })

  it('never emits revoked entries into the candidate stream', async () => {
    const { provider, context } = contentProviderScan(() => signedText())

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots.flatMap(snapshot => snapshot.items.map(item => item.id))).toEqual([
      'npm:dsh-plugin-safe@1.2.3',
      'npm:@deepseek-ai/cool-plugin@2.0.0',
    ])
    expect(provider.verifiedPackages().map(candidate => candidate.packageName)).not.toContain('dsh-plugin-retired')
    expect(provider.findVerifiedPackage('dsh-plugin-retired', '3.1.4')).toBeUndefined()
  })

  it('accepts injected manifest bytes (catalog-as-content) without any network', async () => {
    const bytes = () => Buffer.from(signedText(), 'utf8')
    const provider = createCompanyCatalogProvider({
      manifestContentProvider: bytes,
      trustRoots,
      now: () => verifiedAt,
    })
    const context = contentContext()

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots.flatMap(snapshot => snapshot.items)).toHaveLength(2)
    expect(context.http.getJson).not.toHaveBeenCalled()
  })

  it('enforces the raw-byte canonical form of injected content', async () => {
    const pretty = () => JSON.stringify(JSON.parse(signedText()), null, 2)
    const sequenceStore = memorySequenceStore()
    const { provider, context } = contentProviderScan(pretty, sequenceStore)

    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('non-canonical')
    expect(sequenceStore.records).toHaveLength(0)
    expect(provider.verifiedPackages()).toHaveLength(0)
  })

  it('pages large manifests into bounded snapshots', async () => {
    const packages = Array.from({ length: 150 }, (_, index) => packageEntry({
      packageName: `dsh-plugin-${index}`,
      version: '1.0.0',
    }))
    const { provider, context } = contentProviderScan(() => signedText(unsignedManifest({ packages })))

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]?.items).toHaveLength(100)
    expect(snapshots[1]?.items).toHaveLength(50)
    for (const snapshot of snapshots) expect(snapshot.page.total).toBe(150)
    expect(provider.verifiedPackages()).toHaveLength(150)
  })

  it('serves query pages from the verified manifest', async () => {
    // Each fetch re-verifies the same manifest, which a ratcheted deployment
    // would reject as a replay (see the rollback test below).
    const { provider, context } = contentProviderScan(() => signedText(), replayTolerantStore)

    const page = await provider.fetch({ limit: 1 }, context)
    expect(page.items.map(item => item.id)).toEqual(['npm:dsh-plugin-safe@1.2.3'])
    expect(page.page).toEqual({ total: 2, nextCursor: '1' })

    const search = await provider.fetch({ q: 'cool-plugin' }, context)
    expect(search.items.map(item => item.id)).toEqual(['npm:@deepseek-ai/cool-plugin@2.0.0'])
    expect(search.page.total).toBe(1)
  })

  it('represents an empty manifest as one empty snapshot', async () => {
    const { provider, context } = contentProviderScan(() => signedText(unsignedManifest({ packages: [] })))

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.items).toEqual([])
    expect(snapshots[0]?.page.total).toBe(0)
    expect(provider.verifiedPackages()).toEqual([])
  })

  it('self-heals a residual stale digest left by a historical partial write', async () => {
    // The field incident this regression guards: an origin-era record was
    // saved without bytesSha256, the merge-mode settings write resurrected
    // the content-era digest under the new sequence, and every later scan
    // computed the true digest, mismatched the residual, and rejected the
    // catalog as stale-sequence with no write path left to recover. The
    // heal: the bytes that just passed full verification win, the warning
    // carries both digests, the record refreshes, and the next scan is the
    // silent steady state again.
    const text = signedText(unsignedManifest({ sequence: 6 }))
    const computed = sha256Hex(text)
    const residual = sha256Hex('content-era sequence-2 bytes')
    const saved: MarketCompanyManifestRecord[] = [{
      sequence: 6,
      keyId,
      verifiedAt: '2026-08-01T00:00:00.000Z',
      bytesSha256: residual,
    }]
    const sequenceStore: CompanyManifestSequenceStore = {
      async load() { return saved[saved.length - 1] },
      async save(record) { saved.push(record) },
    }
    const logger = warnLogger()
    const { provider, context } = contentProviderScan(() => text, sequenceStore, logger)

    const snapshots = await provider.scanCatalog!({}, context)

    expect(snapshots.flatMap(snapshot => snapshot.items)).toHaveLength(2)
    expect(provider.verification()).toMatchObject({ mode: 'content', sequence: 6 })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toContain(`recorded digest ${residual}`)
    expect(logger.warn.mock.calls[0]?.[0]).toContain(`computed digest ${computed}`)
    expect(saved.at(-1)).toEqual({
      sequence: 6,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: computed,
    })

    // Healed: the follow-up scan is the silent same-bytes steady state.
    const steady = contentProviderScan(() => text, sequenceStore, logger)
    await expect(steady.provider.scanCatalog!({}, steady.context)).resolves.toBeTruthy()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('company catalog provider (origin mode)', () => {
  function originScan(
    text: string,
    finalUrl = MANIFEST_URL,
    sequenceStore: CompanyManifestSequenceStore = memorySequenceStore(),
    logger?: Pick<Context['logger'], 'warn'>,
  ) {
    const getJson = vi.fn(async () => ({ value: JSON.parse(text), finalUrl }))
    const http: CatalogHttpClient = { getJson }
    const provider = createCompanyCatalogProvider({
      companyManifestUrl: MANIFEST_URL,
      trustRoots,
      sequenceStore,
      now: () => verifiedAt,
      ...(logger === undefined ? {} : { logger }),
    })
    const context = {
      source: source(),
      signal: new AbortController().signal,
      http,
      media: { register: vi.fn() },
    }
    return { provider, sequenceStore, context, getJson }
  }

  it('fetches the manifest through the restricted client with a pinned origin', async () => {
    const { provider, context, getJson } = originScan(signedText())

    const snapshots = await provider.scanCatalog!({}, context)

    expect(getJson).toHaveBeenCalledOnce()
    expect(getJson).toHaveBeenNthCalledWith(1, MANIFEST_URL, expect.any(AbortSignal), {
      allowedOrigin: 'https://catalog.company.example',
    })
    expect(snapshots.flatMap(snapshot => snapshot.items)).toHaveLength(2)
    expect(snapshots[0]?.source.finalUrl).toBe(MANIFEST_URL)
    expect(provider.verification()).toMatchObject({ mode: 'origin', sequence: 42 })
  })

  it('rejects a response whose final URL left the pinned origin', async () => {
    const { provider, context } = originScan(signedText(), 'https://attacker.example/manifest.json')

    await expect(provider.scanCatalog!({}, context)).rejects.toThrow(/pinned origin/u)
  })

  it('rejects parsed responses that cannot be canonically serialized', async () => {
    const sequenceStore = memorySequenceStore()
    const { provider, context } = originScan('{"float": 1.5, "signed": true}', MANIFEST_URL, sequenceStore)

    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('non-canonical')
    expect(sequenceStore.records).toHaveLength(0)
  })

  it('re-verifies the same fetched manifest on every scan (static-hosting steady state)', async () => {
    // The production regression this suite guards: an origin that publishes
    // sequence 6 once and then serves the same bytes forever. The first scan
    // persists the sequence; every later scan — same provider or a fresh
    // process sharing only the store — must keep verifying instead of
    // failing as a stale replay.
    const text = signedText(unsignedManifest({ sequence: 6 }))
    const sequenceStore = memorySequenceStore()
    const first = originScan(text, MANIFEST_URL, sequenceStore)

    await first.provider.scanCatalog!({}, first.context)
    await first.provider.scanCatalog!({}, first.context)
    expect(sequenceStore.records).toEqual([{
      sequence: 6,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: sha256Hex(text),
    }, {
      sequence: 6,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: sha256Hex(text),
    }])

    const restart = originScan(text, MANIFEST_URL, sequenceStore)
    await expect(restart.provider.scanCatalog!({}, restart.context)).resolves.toBeTruthy()
    expect(restart.provider.verification()).toMatchObject({ mode: 'origin', sequence: 6 })
    expect(sequenceStore.records).toHaveLength(3)
  })

  it('warns and heals when a same-sequence fetch re-issues different legitimately signed bytes', async () => {
    const sequenceStore = memorySequenceStore()
    const published = signedText(unsignedManifest({ sequence: 6 }))
    const first = originScan(published, MANIFEST_URL, sequenceStore)
    await first.provider.scanCatalog!({}, first.context)

    // Tampering the bytes breaks the signature, so the honest construction
    // is a different legitimately signed manifest at the same sequence (an
    // operator re-issuing content without bumping). The signature chain is
    // the content authority and the sequence did not regress, so the scan
    // proceeds on the new bytes — with a loud warning, and the persisted
    // record refreshed to the new digest instead of bricking the catalog.
    const reissued = signedText(unsignedManifest({ sequence: 6, expiresAt: '2031-01-01T00:00:00Z' }))
    const logger = warnLogger()
    const second = originScan(reissued, MANIFEST_URL, sequenceStore, logger)
    await expect(second.provider.scanCatalog!({}, second.context)).resolves.toBeTruthy()
    expect(second.provider.verification()).toMatchObject({ mode: 'origin', sequence: 6 })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]?.[0]).toContain('re-observed at sequence 6 with different bytes')
    expect(logger.warn.mock.calls[0]?.[0]).toContain(`recorded digest ${sha256Hex(published)}`)
    expect(logger.warn.mock.calls[0]?.[0]).toContain(`computed digest ${sha256Hex(reissued)}`)
    expect(sequenceStore.records).toEqual([{
      sequence: 6,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: sha256Hex(published),
    }, {
      sequence: 6,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: sha256Hex(reissued),
    }])

    // The heal restored the steady state: replaying the re-issued bytes is
    // the silent static-hosting normal from here on.
    const replay = originScan(reissued, MANIFEST_URL, sequenceStore, logger)
    await expect(replay.provider.scanCatalog!({}, replay.context)).resolves.toBeTruthy()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('backfills the persisted bytes digest when a legacy record carries none', async () => {
    // Records written before origin-mode digest persistence carry only the
    // sequence — the state every already-deployed machine is in. The first
    // same-sequence scan after upgrading must pass and persist the digest.
    const text = signedText(unsignedManifest({ sequence: 42 }))
    const saved: MarketCompanyManifestRecord[] = [{ sequence: 42, keyId, verifiedAt: '2026-08-01T00:00:00.000Z' }]
    const sequenceStore: CompanyManifestSequenceStore = {
      async load() { return saved[saved.length - 1] },
      async save(record) { saved.push(record) },
    }
    const { provider, context } = originScan(text, MANIFEST_URL, sequenceStore)

    await expect(provider.scanCatalog!({}, context)).resolves.toBeTruthy()

    expect(saved).toEqual([
      { sequence: 42, keyId, verifiedAt: '2026-08-01T00:00:00.000Z' },
      {
        sequence: 42,
        keyId,
        verifiedAt: '2026-09-01T00:00:00.000Z',
        bytesSha256: sha256Hex(text),
      },
    ])
  })

  it('admits one unknown same-sequence manifest against a digest-less legacy record, then pins it', async () => {
    // A legacy record pins the sequence but not the bytes, so a
    // same-sequence manifest with different — yet legitimately signed —
    // bytes cannot be told apart from the last verified bytes. It is
    // admitted exactly once and the digest is backfilled: from then on the
    // record observes every same-sequence byte change loudly (warn + heal,
    // see the module security note) while the digest-less window itself
    // still requires the signing key to enter, with which a strictly higher
    // sequence is publishable anyway; this test pins the boundary so no
    // refactor quietly widens it.
    const reissued = signedText(unsignedManifest({ sequence: 42, expiresAt: '2031-01-01T00:00:00Z' }))
    const saved: MarketCompanyManifestRecord[] = [{ sequence: 42, keyId, verifiedAt: '2026-08-01T00:00:00.000Z' }]
    const sequenceStore: CompanyManifestSequenceStore = {
      async load() { return saved[saved.length - 1] },
      async save(record) { saved.push(record) },
    }
    const admitted = originScan(reissued, MANIFEST_URL, sequenceStore)
    await expect(admitted.provider.scanCatalog!({}, admitted.context)).resolves.toBeTruthy()
    expect(saved.at(-1)).toEqual({
      sequence: 42,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: sha256Hex(reissued),
    })

    // Replaying the now-pinned bytes is the static-hosting steady state.
    const replay = originScan(reissued, MANIFEST_URL, sequenceStore)
    await expect(replay.provider.scanCatalog!({}, replay.context)).resolves.toBeTruthy()

    // Any other same-sequence bytes diverge from the pinned observation:
    // detected loudly, admitted on the freshly verified bytes, and the
    // record re-pinned to them.
    const swappedText = signedText(unsignedManifest({ sequence: 42, expiresAt: '2032-01-01T00:00:00Z' }))
    const logger = warnLogger()
    const swapped = originScan(swappedText, MANIFEST_URL, sequenceStore, logger)
    await expect(swapped.provider.scanCatalog!({}, swapped.context)).resolves.toBeTruthy()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('re-observed at sequence 42 with different bytes'))
    // legacy, admitted+backfilled, steady replay, divergent+re-pinned
    expect(saved).toHaveLength(4)
    expect(saved.at(-1)?.bytesSha256).toBe(sha256Hex(swappedText))
  })

  it('rejects a fetched sequence that regressed below the persisted ratchet', async () => {
    const sequenceStore = memorySequenceStore()
    const first = originScan(signedText(unsignedManifest({ sequence: 7 })), MANIFEST_URL, sequenceStore)
    await first.provider.scanCatalog!({}, first.context)

    const rolled = originScan(signedText(unsignedManifest({ sequence: 6 })), MANIFEST_URL, sequenceStore)
    const error = await untrusted(rolled.provider.scanCatalog!({}, rolled.context))
    expect(error.code).toBe('stale-sequence')
    expect(error.message).toContain('regressed below the last seen sequence 7')
    expect(sequenceStore.records).toHaveLength(1)
  })
})

describe('company catalog provider verification failures', () => {
  it('rejects a manifest signed by a stranger key claiming a trusted keyId', async () => {
    const sequenceStore = memorySequenceStore()
    const { provider, context } = contentProviderScan(
      () => signedText(unsignedManifest(), strangerPrivateKey),
      sequenceStore,
    )

    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('key-mismatch')
    expect(sequenceStore.records).toHaveLength(0)
    expect(provider.verifiedPackages()).toHaveLength(0)
  })

  it('rejects an unknown keyId', async () => {
    const { provider, context } = contentProviderScan(() => signedText(unsignedManifest(), privateKey, 'unlisted-key'))

    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('unknown-key')
  })

  it('rejects a tampered manifest and produces no partial candidates', async () => {
    const tampered = JSON.parse(signedText()) as Record<string, unknown>
    const packages = tampered.packages as Record<string, unknown>[]
    packages[0] = { ...packages[0]!, version: '9.9.9' }
    const sequenceStore = memorySequenceStore()
    const { provider, context } = contentProviderScan(() => canonicalJsonText(tampered), sequenceStore)

    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('bad-signature')
    expect(sequenceStore.records).toHaveLength(0)
    expect(provider.verifiedPackages()).toHaveLength(0)
    expect(provider.verification()).toBeUndefined()
  })

  it('rejects a manifest that expired', async () => {
    const sequenceStore = memorySequenceStore()
    const { provider, context } = contentProviderScan(
      () => signedText(unsignedManifest({ expiresAt: '2026-08-31T23:59:59Z' })),
      sequenceStore,
    )

    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('expired')
    expect(sequenceStore.records).toHaveLength(0)
  })

  it('rejects sequence rollback and keeps the last verified catalog', async () => {
    const sequenceStore = memorySequenceStore()
    const latest = signedText(unsignedManifest({ sequence: 42 }))
    const { provider, context } = contentProviderScan(() => latest, sequenceStore)

    await provider.scanCatalog!({}, context)
    expect(sequenceStore.records).toEqual([{
      sequence: 42,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }])

    const rolled = signedText(unsignedManifest({ sequence: 41 }))
    const rolling = contentProviderScan(() => rolled, sequenceStore)
    const error = await untrusted(rolling.provider.scanCatalog!({}, rolling.context))
    expect(error.code).toBe('stale-sequence')

    // Fail-closed: the previous provider keeps exactly its last verified
    // catalog and the persisted ratchet never moves backwards.
    expect(provider.verifiedPackages()).toHaveLength(2)
    expect(provider.verification()?.sequence).toBe(42)
    expect(sequenceStore.records).toHaveLength(1)

    // Same-sequence replay of the identical embedded asset is the normal
    // content-mode every-scan case and must keep verifying; the same
    // sequence with different legitimately signed bytes warns and heals
    // (record refreshed), never bricks the catalog.
    const equal = signedText(unsignedManifest({ sequence: 42 }))
    const repeating = contentProviderScan(() => equal, sequenceStore)
    await expect(repeating.provider.scanCatalog!({}, repeating.context)).resolves.toBeTruthy()

    const mutated = signedText(unsignedManifest({
      sequence: 42,
      packages: [packageEntry(), packageEntry({ packageName: '@deepseek-ai/cool-plugin', version: '9.9.9', revoked: false })],
    }))
    const logger = warnLogger()
    const replaying = contentProviderScan(() => mutated, sequenceStore, logger)
    await expect(replaying.provider.scanCatalog!({}, replaying.context)).resolves.toBeTruthy()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('re-observed at sequence 42 with different bytes'))
    expect(sequenceStore.records.at(-1)?.bytesSha256).toBe(sha256Hex(mutated))
  })

  it('refuses to adopt a manifest when the sequence ratchet cannot be persisted', async () => {
    const sequenceStore: CompanyManifestSequenceStore = {
      async load() { return undefined },
      save: async () => { throw new Error('settings unavailable') },
    }
    const { provider, context } = contentProviderScan(() => signedText(), sequenceStore)

    await expect(provider.scanCatalog!({}, context)).rejects.toThrow(/settings unavailable/u)
    expect(provider.verifiedPackages()).toHaveLength(0)
  })

  it('fails closed when the persisted anti-rollback state is invalid', async () => {
    const sequenceStore: CompanyManifestSequenceStore = {
      async load() { return { sequence: 0, keyId: '../escape', verifiedAt: 'not a date' } },
      async save() { throw new Error('unused') },
    }
    const { provider, context } = contentProviderScan(() => signedText(), sequenceStore)

    await expect(provider.scanCatalog!({}, context)).rejects.toThrow(/anti-rollback state is invalid/u)
  })

  it('fails closed when the persisted bytesSha256 is not lowercase sha256 hex', async () => {
    const sequenceStore: CompanyManifestSequenceStore = {
      // Otherwise-valid record; only the persisted byte digest is corrupt, so
      // every same-sequence comparison would misfire were it trusted.
      async load() {
        return {
          sequence: 42,
          keyId,
          verifiedAt: '2026-09-01T00:00:00.000Z',
          bytesSha256: 'nothex',
        } satisfies MarketCompanyManifestRecord
      },
      async save() { throw new Error('unused') },
    }
    const { provider, context } = contentProviderScan(() => signedText(), sequenceStore)

    await expect(provider.scanCatalog!({}, context))
      .rejects.toThrow('bytesSha256 must be lowercase sha256 hex')
  })

  it('rejects entries the v1 catalog contract cannot represent', async () => {
    const longName = `dsh-${'a'.repeat(200)}`
    const { provider, context } = contentProviderScan(() => signedText(unsignedManifest({
      packages: [packageEntry({ packageName: longName })],
    })))

    await expect(provider.scanCatalog!({}, context)).rejects.toThrow(/cannot be represented/u)
  })

  it('rejects entries whose signed repository identity cannot be normalized', async () => {
    const { provider, context } = contentProviderScan(() => signedText(unsignedManifest({
      packages: [packageEntry({ repository: { url: 'https://github.com/example/dsh-plugin-safe/tree/main' } })],
    })))

    await expect(provider.scanCatalog!({}, context)).rejects.toThrow(/repository identity that cannot be represented/u)
  })

  it('rejects a whole manifest whose entries lack the required repository identity', async () => {
    const anonymous = { ...packageEntry({ packageName: 'dsh-plugin-anon', version: '5.0.0' }) }
    delete (anonymous as Record<string, unknown>).repository
    const { provider, context } = contentProviderScan(() => signedText(unsignedManifest({
      packages: [packageEntry(), anonymous],
    })))
    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('invalid-manifest')
    expect(error.message).toContain('repository')
    expect(provider.verifiedPackages()).toHaveLength(0)
  })
})

describe('company catalog service registration', () => {
  const http: CatalogHttpClient = { getJson: vi.fn(async () => { throw new Error('unused') }) }

  async function serviceWith(manifest: () => string) {
    const provider = createCompanyCatalogProvider({
      manifestContentProvider: manifest,
      trustRoots,
      now: () => verifiedAt,
    })
    const store = new MemoryCatalogSourceStore()
    await store.save([source()])
    const service = new DefaultCatalogService(store, http, { adapters: [provider] })
    return { provider, service }
  }

  it('scans the locked company source end to end', async () => {
    const { service, provider } = await serviceWith(() => signedText())

    const index = await service.scanCatalog(new AbortController().signal)

    expect(index?.source.sourceRecordId).toBe(source().sourceRecordId)
    expect(index?.snapshots.flatMap(snapshot => snapshot.items)).toHaveLength(2)
    expect(index?.providerRevision).toBe('company-manifest-42')
    expect(provider.findVerifiedPackage('@deepseek-ai/cool-plugin', '2.0.0')).toMatchObject({
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    })
  })

  it('fails the whole catalog when the manifest is untrusted', async () => {
    const tampered = JSON.parse(signedText()) as Record<string, unknown>
    const packages = tampered.packages as Record<string, unknown>[]
    packages[0] = { ...packages[0]!, version: '9.9.9' }
    const { service } = await serviceWith(() => canonicalJsonText(tampered))

    await expect(service.scanCatalog(new AbortController().signal)).rejects.toThrow(CompanyCatalogUntrustedError)
  })

  it('rejects duplicate adapter registrations', () => {
    const provider = createCompanyCatalogProvider({ manifestContentProvider: () => signedText(), trustRoots })
    expect(() => new DefaultCatalogService(new MemoryCatalogSourceStore(), http, {
      adapters: [provider, provider],
    })).toThrow(TypeError)
  })
})

describe('settings-backed company manifest sequence store', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!()
  })

  async function bootMarketSettings() {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-company-provider-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const ctx = new Context()
    await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    let disposed = false
    cleanups.push(async () => {
      if (disposed) return
      disposed = true
      await ctx.fiber.dispose()
    })
    return { scope: registerMarketSettings(ctx) }
  }

  it('persists the verified sequence across settings documents (processes)', async () => {
    const { scope } = await bootMarketSettings()
    const store = new SettingsCompanyManifestSequenceStore(scope)
    expect(await store.load()).toBeUndefined()

    await store.save({ sequence: 42, keyId, verifiedAt: '2026-09-01T00:00:00.000Z' })
    expect(scope.get().companyManifest).toEqual({
      sequence: 42,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    } satisfies MarketSettingsDocument['companyManifest'])
    expect(await store.load()).toEqual({ sequence: 42, keyId, verifiedAt: '2026-09-01T00:00:00.000Z' })
  })

  it('replaces the record atomically: a digest-less save never resurrects the previous digest', async () => {
    // The write-path half of the field incident: merge-mode `update` deep-
    // merged the stored section, so saving the origin-era record shape
    // (no bytesSha256) over a content-era record (with one) left the stale
    // digest parked under the new sequence. The store must swap the whole
    // subtree, and the read-back after the save must be exactly the record.
    const { scope } = await bootMarketSettings()
    const store = new SettingsCompanyManifestSequenceStore(scope)

    await store.save({
      sequence: 2,
      keyId,
      verifiedAt: '2026-08-01T00:00:00.000Z',
      bytesSha256: sha256Hex('content-era sequence-2 bytes'),
    })
    await store.save({ sequence: 6, keyId, verifiedAt: '2026-09-01T00:00:00.000Z' })

    expect(scope.get().companyManifest).toEqual({
      sequence: 6,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
    } satisfies MarketSettingsDocument['companyManifest'])
    expect(await store.load()).toEqual({ sequence: 6, keyId, verifiedAt: '2026-09-01T00:00:00.000Z' })
  })

  it('writes through a path set-op when the scope provides mutation, never a merge', async () => {
    const mutate = vi.fn(async () => {})
    const scope: MarketSettingsMutatingScope = {
      get: () => ({ sources: [] }),
      watch: () => () => {},
      update: vi.fn(async () => {}),
      replace: vi.fn(async () => {}),
      mutate,
    }
    const store = new SettingsCompanyManifestSequenceStore(scope)
    const record: MarketCompanyManifestRecord = { sequence: 6, keyId, verifiedAt: '2026-09-01T00:00:00.000Z' }

    await store.save(record)

    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['companyManifest'], value: record }])
    expect(scope.update).not.toHaveBeenCalled()
    expect(scope.replace).not.toHaveBeenCalled()
  })

  it('falls back to a wholesale section replace that preserves sibling fields', async () => {
    // Scopes without path mutation (narrower hosts, focused fakes) still
    // get subtree-replacement semantics: the section is replaced wholesale
    // with the current document and the record swapped in, so `sources`
    // and the other siblings survive and no stale field can linger.
    const document: MarketSettingsDocument = { sources: [source()] }
    const replace = vi.fn(async (_section: MarketSettingsDocument) => {})
    const scope: MarketSettingsMutatingScope = {
      get: () => document,
      watch: () => () => {},
      update: vi.fn(async () => {}),
      replace,
    }
    const store = new SettingsCompanyManifestSequenceStore(scope)
    const record: MarketCompanyManifestRecord = { sequence: 6, keyId, verifiedAt: '2026-09-01T00:00:00.000Z' }

    await store.save(record)

    expect(replace).toHaveBeenCalledWith({ sources: [source()], companyManifest: record })
    expect(scope.update).not.toHaveBeenCalled()
  })

  it('blocks rollback for a fresh provider instance sharing only settings', async () => {
    const { scope } = await bootMarketSettings()
    const first = createCompanyCatalogProvider({
      manifestContentProvider: () => signedText(unsignedManifest({ sequence: 42 })),
      trustRoots,
      sequenceStore: new SettingsCompanyManifestSequenceStore(scope),
      now: () => verifiedAt,
    })
    await first.scanCatalog!({}, contentContext())
    expect(first.verifiedPackages()).toHaveLength(2)

    // A new process sees only the persisted sequence and must reject a rollback.
    const second = createCompanyCatalogProvider({
      manifestContentProvider: () => signedText(unsignedManifest({ sequence: 41 })),
      trustRoots,
      sequenceStore: new SettingsCompanyManifestSequenceStore(scope),
      now: () => verifiedAt,
    })
    const error = await untrusted(second.scanCatalog!({}, contentContext()))
    expect(error.code).toBe('stale-sequence')
    expect(scope.get().companyManifest?.sequence).toBe(42)
  })

  it('fails closed on a corrupted persisted ratchet', async () => {
    const { scope } = await bootMarketSettings()
    // Schema-shaped but semantically invalid: a bad keyId and a non-date.
    await scope.update({
      companyManifest: { sequence: 7, keyId: '../escape', verifiedAt: 'never' } as unknown as MarketCompanyManifestRecord,
    })
    const store = new SettingsCompanyManifestSequenceStore(scope)
    await expect(store.load()).rejects.toThrow(/anti-rollback state is invalid/u)
  })

  it('fails closed on a corrupted ratchet from any injected store', async () => {
    const sequenceStore: CompanyManifestSequenceStore = {
      async load() { return { sequence: 0, keyId: '../escape', verifiedAt: 'not a date' } },
      async save() { throw new Error('unused') },
    }
    const { provider, context } = contentProviderScan(() => signedText(), sequenceStore)

    await expect(provider.scanCatalog!({}, context)).rejects.toThrow(/anti-rollback state is invalid/u)
  })
})

// ---------------------------------------------------------------------------
// Manifest verifier injection: a Host whose manifests carry entry fields
// beyond the market schema (Desktop's P7 signed `source` install channel)
// injects its field-aware verifier; the provider must keep every other
// behavior — anti-rollback, replay, fail-closed propagation — keyed only on
// what the injected verifier reports. The real dual-channel verifier is
// exercised in the desktop workspace against this provider; here the stubs
// pin the provider-side contract.
// ---------------------------------------------------------------------------

describe('company catalog provider manifest verifier injection (field-aware hosts)', () => {
  /** A manifest whose entry carries a field the market schema does not know. */
  const sourceCarryingManifest = unsignedManifest({
    packages: [packageEntry({ source: { kind: 'npm' } })],
  })

  /**
   * Field-aware plumbing double: verifies the manifest's market-known
   * projection (the same document with the `source` extension stripped)
   * through the real market verifier — same key, same signature chain — and
   * grafts the extension back onto the verified manifest. It proves the
   * provider-side contract (the provider consumes the verified projection
   * and transports the extension untouched) without duplicating the
   * dual-channel verifier's ed25519 code; the real field-aware verifier is
   * exercised in the desktop workspace against this same provider.
   */
  const fieldAwareVerifier: CompanyManifestVerifier = (raw, options) => {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    const parsed = JSON.parse(text) as { packages?: Array<Record<string, unknown>>; signature?: unknown }
    const packages = Array.isArray(parsed.packages) ? parsed.packages : []
    const sources = packages.map(entry => entry.source)
    const { signature: _wireSignature, ...document } = parsed
    const projection = {
      ...document,
      packages: packages.map(({ source: _source, ...rest }) => rest),
    }
    const signature = createCompanyManifestSignature(asUnsigned(projection), privateKey, keyId)
    const market = verifyCompanyManifest(canonicalJsonText({ ...projection, signature }), options)
    if (!market.ok) return market
    const extended = market.manifest.packages.map((entry, index) => (
      sources[index] === undefined ? entry : { ...entry, source: sources[index] } as CompanyManifestPackage
    ))
    return { ...market, manifest: { ...market.manifest, packages: extended } }
  }

  it('rejects a manifest with schema-unknown entry fields whole with the default verifier', async () => {
    // The default is byte-for-byte the market library verifier: one unknown
    // entry key rejects the entire manifest, catalog and install authority
    // stay empty, and the whole scan fails closed (the fleet-upgrade gate
    // every field-unaware deployment still lives behind).
    const { provider, context } = contentProviderScan(() => signedText(sourceCarryingManifest))
    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('invalid-manifest')
    expect(error.message).toContain('company catalog is not trusted (invalid-manifest)')
    expect(provider.verifiedPackages()).toEqual([])
    expect(provider.verification()).toBeUndefined()
  })

  it('catalogs a source-carrying manifest through an injected field-aware verifier', async () => {
    const { provider, context } = contentProviderScan(
      () => signedText(sourceCarryingManifest),
      memorySequenceStore(),
      undefined,
      fieldAwareVerifier,
    )
    const snapshots = await provider.scanCatalog!({}, context)
    expect(snapshots.flatMap(snapshot => snapshot.items.map(item => item.id)))
      .toEqual(['npm:dsh-plugin-safe@1.2.3'])
    expect(provider.verifiedPackages()).toEqual([
      expect.objectContaining({ packageName: 'dsh-plugin-safe', version: '1.2.3' }),
    ])
    // The extension field rides through the signed-package query untouched:
    // the provider consumes only the market-known projection of each entry.
    const signed = provider.findSignedPackage('dsh-plugin-safe', '1.2.3')
    expect((signed as { readonly source?: unknown }).source).toEqual({ kind: 'npm' })
    expect(provider.verification()).toMatchObject({ mode: 'content', sequence: 42, keyId })
  })

  it('forwards the exact bytes, trust roots, and clock to the injected verifier', async () => {
    const text = signedText()
    const manifestVerifier = vi.fn((raw: string | Uint8Array, options: Parameters<CompanyManifestVerifier>[1]) =>
      verifyCompanyManifest(raw, options))
    const injected = contentProviderScan(() => text, memorySequenceStore(), undefined, manifestVerifier)
    await injected.provider.scanCatalog!({}, injected.context)
    expect(manifestVerifier).toHaveBeenCalledTimes(1)
    const call = manifestVerifier.mock.calls[0]!
    expect(call[0]).toBe(text)
    expect(call[1].trustRoots).toEqual(trustRoots)
    expect(call[1].lastSeenSequence).toBeUndefined()
    expect(typeof call[1].now === 'function' && call[1].now()).toBe(verifiedAt)
    // Same scan outcome as the default provider over the same bytes.
    const plain = contentProviderScan(() => text)
    await plain.provider.scanCatalog!({}, plain.context)
    expect(injected.provider.verification()).toEqual(plain.provider.verification())
    expect(injected.provider.verifiedPackages()).toEqual(plain.provider.verifiedPackages())
  })

  it('carries an injected verifier rejection into the untrusted scan code', async () => {
    const manifestVerifier = vi.fn(() => ({ ok: false as const, code: 'expired' as const, reason: 'injected rejection' }))
    const { provider, context } = contentProviderScan(
      () => signedText(),
      memorySequenceStore(),
      undefined,
      manifestVerifier,
    )
    const error = await untrusted(provider.scanCatalog!({}, context))
    expect(error.code).toBe('expired')
    expect(error.message).toContain('injected rejection')
    expect(provider.verification()).toBeUndefined()
  })

  it('rejects a non-function manifest verifier at construction', () => {
    expect(() => createCompanyCatalogProvider({
      manifestContentProvider: () => signedText(),
      trustRoots,
      manifestVerifier: 'not a function' as unknown as CompanyManifestVerifier,
    })).toThrow(TypeError)
  })
})
