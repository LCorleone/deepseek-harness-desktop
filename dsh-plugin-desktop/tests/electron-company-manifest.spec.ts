import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonText,
  createCompanyCatalogProvider,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  type MarketCompanyManifestSequenceRecord,
  type MarketCompanyManifestSequenceStore,
} from 'dsh-community-market'
import { fetchCompanyManifestText } from '../src/company-manifest-origin.ts'
import {
  companyCatalogHttpOverElectronNet,
  refuseCompanyManifestRedirects,
} from '../src/electron-company-manifest.ts'
import { authorizeLockedPluginAdd } from '../src/cli-install-channel.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')

const originPolicy = parseDesktopPolicy({
  allowHomePatch: false,
  allowManualPluginAdd: false,
  companyCatalogOrigin: 'https://market.company.example',
  companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
  locked: true,
  trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
})

/** Signed manifest fixture the fake Chromium boundary serves. */
function signedManifestText(sequence = 42, overrides: Record<string, unknown> = {}): string {
  const manifest = {
    manifestVersion: '1.0.0',
    sequence,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [{
      packageName: 'example-plugin',
      version: '1.0.0',
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      bundlePatch: './cordis.patch.yml',
      repository: { url: 'https://github.com/example/example-plugin' },
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    }],
    ...overrides,
  }
  const signature = createCompanyManifestSignature(
    manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    privateKey,
    keyId,
  )
  return canonicalJsonText({ ...manifest, signature })
}

/**
 * The Electron main process injects its Chromium-stack fetch through the
 * redirect wrapper (`fetchCompanyManifestTextOverElectronNet` composes it
 * over `net.fetch`); these tests drive that exact wrapper with fake
 * boundaries — importing Electron inside vitest would crash the run — so the
 * redirect contract stays pinned without a live `net.fetch`.
 */
describe('electron main-process manifest boundary', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('passes a non-redirected response through unchanged', async () => {
    const manifestText = signedManifestText()
    const chromium = vi.fn(async () => new Response(manifestText))

    await expect(fetchCompanyManifestText(
      originPolicy,
      { request: refuseCompanyManifestRedirects(chromium) },
    )).resolves.toBe(manifestText)
    expect(chromium).toHaveBeenCalledTimes(1)
    expect(chromium).toHaveBeenCalledWith(
      'https://market.company.example/catalog-manifest.json',
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('keeps refusing a response that one day reports a followed redirect (defensive second layer)', async () => {
    // Electron 43.4.0's `net.fetch` never sets `redirected` (the Response
    // carries no URL list; upstream PR electron#44725 would change that and
    // is not merged), so on today's boundary the refusal comes solely from
    // the request's `redirect: 'error'` init — see the previous test. This
    // pins the defensive wrapper for the day a Chromium backend starts
    // reporting the flag: that response must still fail closed, with the
    // same bounded network failure an `redirect: 'error'` rejection yields.
    const chromium = vi.fn(async () => ({
      redirected: true,
      url: 'https://evil.example/catalog-manifest.json',
      status: 200,
    } as unknown as Response))
    const wrapped = refuseCompanyManifestRedirects(chromium)

    await expect(wrapped('https://market.company.example/catalog-manifest.json', {}))
      .rejects.toThrow('refused a redirect of the company catalog manifest request')
    await expect(fetchCompanyManifestText(originPolicy, { request: wrapped }))
      .rejects.toThrow('the company catalog manifest could not be downloaded')
    expect(chromium).toHaveBeenCalledTimes(2)
  })

  it('maps a redirect-mode rejection to the bounded network failure, never an uncaught throw', async () => {
    // The effective first layer: under `redirect: 'error'` a 302 answer makes
    // the Chromium ClientRequest die and `net.fetch` reject (mirrored here by
    // the same TypeError shape). The shared fetch helper must fold that
    // rejection into its network-failure result reason — the caller's
    // fail-closed denial — not let it escape as an unhandled exception.
    const chromium = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    await expect(fetchCompanyManifestText(originPolicy, { request: chromium }))
      .rejects.toThrow('the company catalog manifest could not be downloaded')

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      originPolicy,
      { fetch: { request: chromium } },
    )
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('could not be fetched from https://market.company.example')
      expect(decision.reason).toContain('could not be downloaded')
    }
  })

  it('fails a locked plugin add closed when the Chromium boundary followed a redirect', async () => {
    // The production composition is (redirect wrapper) ∘ (net.fetch); a
    // redirect that slips through the backend must surface as the shared
    // fail-closed denial, never as fetched manifest bytes.
    const root = mkdtempSync(join(tmpdir(), 'dsh-electron-manifest-redirect-'))
    roots.push(root)
    const chromium = vi.fn(async () => ({
      redirected: true,
      url: 'https://evil.example/catalog-manifest.json',
      status: 200,
    } as unknown as Response))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      originPolicy,
      { fetch: { request: refuseCompanyManifestRedirects(chromium) } },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('could not be fetched from https://market.company.example')
    }
  })
})

/**
 * The Desktop host's origin-mode catalog HTTP client (`desktopCompanyCatalogHttp`
 * capability): the locked market's catalog scan must run through the injected
 * Chromium-stack boundary instead of the market's portable restricted client,
 * whose private-network blocklist deterministically refuses internal GitLab
 * hosting and whose node:https TLS chain does not trust the corporate CA. The
 * GitLab-like hostname below resolves nowhere in this environment, so a scan
 * that succeeds through the fake `net.fetch` boundary proves no node:https/DNS
 * path is taken; every restricted-client guarantee for this one policy-pinned
 * URL (origin pin, refused redirects, bounded body and time) must carry over
 * unchanged, and the market's signature gate over the returned bytes —
 * including the sequence replay rules (a regressed sequence stays rejected;
 * the same sequence re-observed with different legitimately signed bytes now
 * warns and self-heals instead of bricking the catalog — see the market
 * provider's security note) — stays intact.
 */
describe('origin-mode market catalog scan over the injected Chromium boundary', () => {
  const gitlabOrigin = 'https://gitlab.company.example'
  const gitlabPolicy = parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: gitlabOrigin,
    companyManifestUrl: `${gitlabOrigin}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`,
    locked: true,
    trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
  })
  const verifiedNow = Date.parse('2026-09-01T00:00:00.000Z')

  function memorySequenceStore(): MarketCompanyManifestSequenceStore & {
    record(): MarketCompanyManifestSequenceRecord | undefined
  } {
    let saved: MarketCompanyManifestSequenceRecord | undefined
    return {
      load: async () => saved,
      save: async record => { saved = record },
      record: () => saved,
    }
  }

  const companySource = {
    sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac130001',
    registrationKind: 'built-in',
    adapterId: 'market.company-manifest-v1',
    providerId: 'com.deepseek.company-catalog',
    builtInProviderKey: 'company-catalog',
    enabled: true,
    order: 0,
  }

  it('scans the locked market catalog through the injected client with the sequence-3 fixture', async () => {
    const manifestText = signedManifestText(3)
    const chromium = vi.fn(async () => new Response(manifestText))
    const client = companyCatalogHttpOverElectronNet(gitlabPolicy, { request: chromium })
    const store = memorySequenceStore()
    const provider = createCompanyCatalogProvider({
      companyManifestUrl: gitlabPolicy.companyManifestUrl,
      trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
      sequenceStore: store,
      now: () => verifiedNow,
    })

    const snapshots = await provider.scanCatalog({}, {
      signal: new AbortController().signal,
      http: client,
      source: companySource,
    })

    expect(snapshots.flatMap(snapshot => snapshot.items.map(item => item.id)))
      .toEqual(['npm:example-plugin@1.0.0'])
    expect(provider.verification()).toMatchObject({ mode: 'origin', sequence: 3, keyId })
    // The settings-backed ratchet recorded the verified sequence and, like
    // content mode, the verified bytes digest that guards same-sequence
    // replays of a statically hosted origin.
    expect(store.record()).toEqual({
      sequence: 3,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    // The whole fetch rode the Chromium boundary under `redirect: 'error'`;
    // the unresolvable internal hostname proves the node:https path stayed
    // out of the scan.
    expect(chromium).toHaveBeenCalledTimes(1)
    expect(chromium).toHaveBeenCalledWith(
      `${gitlabOrigin}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`,
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('re-verifies a same-sequence re-fetch and heals changed bytes at that sequence', async () => {
    // The steady state of a statically hosted origin: the same manifest
    // bytes come back on every scan, and a re-scan — same provider, or a
    // fresh process sharing only the persisted ratchet — must keep
    // verifying instead of failing as a stale replay. A regressed sequence
    // still rejects; the same sequence re-signed over different content
    // now warns and heals (the signature chain is the content authority,
    // the persisted digest only a local observation cache); injecting the
    // transport client never changes either rule.
    const store = memorySequenceStore()
    const chromium = vi.fn(async () => new Response(signedManifestText(3)))
    const client = companyCatalogHttpOverElectronNet(gitlabPolicy, { request: chromium })
    const provider = createCompanyCatalogProvider({
      companyManifestUrl: gitlabPolicy.companyManifestUrl,
      trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
      sequenceStore: store,
      now: () => verifiedNow,
    })
    const context = {
      signal: new AbortController().signal,
      http: client,
      source: companySource,
    }
    await provider.scanCatalog({}, context)
    chromium.mockClear()

    await expect(provider.scanCatalog({}, context)).resolves.toBeTruthy()
    expect(chromium).toHaveBeenCalledTimes(1)

    const reissuedText = signedManifestText(3, { expiresAt: '2031-01-01T00:00:00Z' })
    const reissued = companyCatalogHttpOverElectronNet(gitlabPolicy, {
      request: vi.fn(async () => new Response(reissuedText)),
    })
    const restart = createCompanyCatalogProvider({
      companyManifestUrl: gitlabPolicy.companyManifestUrl,
      trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
      sequenceStore: store,
      now: () => verifiedNow,
    })
    await expect(restart.scanCatalog({}, {
      signal: new AbortController().signal,
      http: reissued,
      source: companySource,
    })).resolves.toBeTruthy()
    // The catalog recovered on the freshly verified bytes and the ratchet
    // re-pinned its digest to them.
    expect(store.record()).toEqual({
      sequence: 3,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: createHash('sha256').update(reissuedText, 'utf8').digest('hex'),
    })
  })

  it('refuses any URL or caller-pinned origin outside the policy', async () => {
    const chromium = vi.fn(async () => new Response(signedManifestText(3)))
    const client = companyCatalogHttpOverElectronNet(gitlabPolicy, { request: chromium })
    const signal = new AbortController().signal

    await expect(client.getJson(`${gitlabOrigin}/other-manifest.json`, signal, {
      allowedOrigin: gitlabOrigin,
    })).rejects.toThrow('only serves the policy-pinned manifest URL')
    await expect(client.getJson(gitlabPolicy.companyManifestUrl, signal, {
      allowedOrigin: 'https://evil.example',
    })).rejects.toThrow('pinned outside the policy catalog origin')
    expect(chromium).not.toHaveBeenCalled()
  })

  it('carries the boundary bounds: refused redirects, body cap, and cancellation', async () => {
    const signal = new AbortController().signal
    await expect(companyCatalogHttpOverElectronNet(
      gitlabPolicy,
      { request: async () => ({ redirected: true, url: 'https://evil.example/x' }) as unknown as Response },
    ).getJson(gitlabPolicy.companyManifestUrl, signal, { allowedOrigin: gitlabOrigin }))
      .rejects.toThrow('the company catalog manifest could not be downloaded')

    await expect(companyCatalogHttpOverElectronNet(
      gitlabPolicy,
      { request: async () => new Response('a'.repeat(4 * 1024 * 1024 + 1)) },
    ).getJson(gitlabPolicy.companyManifestUrl, signal, { allowedOrigin: gitlabOrigin }))
      .rejects.toThrow('the company catalog manifest exceeds 4194304 bytes')

    await expect(companyCatalogHttpOverElectronNet(
      gitlabPolicy,
      { request: async () => new Response('not json') },
    ).getJson(gitlabPolicy.companyManifestUrl, signal, { allowedOrigin: gitlabOrigin }))
      .rejects.toThrow('did not decode as JSON')

    const aborted = AbortSignal.abort()
    const chromium = vi.fn(async () => new Response(signedManifestText(3)))
    await expect(companyCatalogHttpOverElectronNet(gitlabPolicy, { request: chromium })
      .getJson(gitlabPolicy.companyManifestUrl, aborted, { allowedOrigin: gitlabOrigin }))
      .rejects.toThrow()
    expect(chromium).not.toHaveBeenCalled()
  })
})
