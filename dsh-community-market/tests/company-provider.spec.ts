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
  type CompanyManifestSequenceStore,
} from '../src/catalog/company-provider.js'
import {
  MemoryCatalogSourceStore,
  type MarketCompanyManifestRecord,
  type MarketSettingsDocument,
} from '../src/catalog/source-store.js'
import { DefaultCatalogService } from '../src/catalog/service.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/index.js'
import { registerMarketSettings } from '../src/host/routes.js'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
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

function contentProviderScan(text: () => string, sequenceStore: CompanyManifestSequenceStore = memorySequenceStore()) {
  const provider = createCompanyCatalogProvider({
    manifestContentProvider: contentProvider(text),
    trustRoots,
    sequenceStore,
    now: () => verifiedAt,
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
})

describe('company catalog provider (origin mode)', () => {
  function originScan(text: string, finalUrl = MANIFEST_URL, sequenceStore: CompanyManifestSequenceStore = memorySequenceStore()) {
    const getJson = vi.fn(async () => ({ value: JSON.parse(text), finalUrl }))
    const http: CatalogHttpClient = { getJson }
    const provider = createCompanyCatalogProvider({
      companyManifestUrl: MANIFEST_URL,
      trustRoots,
      sequenceStore,
      now: () => verifiedAt,
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

  it('rejects a same-sequence fetch whose bytes changed', async () => {
    const sequenceStore = memorySequenceStore()
    const first = originScan(signedText(unsignedManifest({ sequence: 6 })), MANIFEST_URL, sequenceStore)
    await first.provider.scanCatalog!({}, first.context)

    // Tampering the bytes breaks the signature, so the honest construction
    // is a different legitimately signed manifest at the same sequence (an
    // operator re-issuing content without bumping); it must not replay over
    // the verified one.
    const reissued = signedText(unsignedManifest({ sequence: 6, expiresAt: '2031-01-01T00:00:00Z' }))
    const second = originScan(reissued, MANIFEST_URL, sequenceStore)
    const error = await untrusted(second.provider.scanCatalog!({}, second.context))
    expect(error.code).toBe('stale-sequence')
    expect(error.message).toContain('re-observed at sequence 6 with different bytes')
    expect(sequenceStore.records).toHaveLength(1)
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
    // The accepted residual (review Low): a legacy record pins the sequence
    // but not the bytes, so a same-sequence manifest with different — yet
    // legitimately signed — bytes cannot be told apart from the last verified
    // bytes. It is admitted exactly once and the digest is backfilled:
    // replays of those very bytes keep verifying, any other same-sequence
    // bytes are rejected from then on. Manufacturing the window requires the
    // signing key, with which a strictly higher sequence is publishable
    // anyway; this test pins the boundary so no refactor quietly widens it.
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

    // Any other same-sequence bytes are a replay attack from here on.
    const swapped = originScan(
      signedText(unsignedManifest({ sequence: 42, expiresAt: '2032-01-01T00:00:00Z' })),
      MANIFEST_URL,
      sequenceStore,
    )
    const error = await untrusted(swapped.provider.scanCatalog!({}, swapped.context))
    expect(error.code).toBe('stale-sequence')
    expect(error.message).toContain('re-observed at sequence 42 with different bytes')
    expect(saved).toHaveLength(3)
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
    // sequence with different bytes is a replay attack and stays rejected.
    const equal = signedText(unsignedManifest({ sequence: 42 }))
    const repeating = contentProviderScan(() => equal, sequenceStore)
    await expect(repeating.provider.scanCatalog!({}, repeating.context)).resolves.toBeTruthy()

    const mutated = signedText(unsignedManifest({
      sequence: 42,
      packages: [packageEntry(), packageEntry({ packageName: '@deepseek-ai/cool-plugin', version: '9.9.9', revoked: false })],
    }))
    const replaying = contentProviderScan(() => mutated, sequenceStore)
    expect((await untrusted(replaying.provider.scanCatalog!({}, replaying.context))).code).toBe('stale-sequence')
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
