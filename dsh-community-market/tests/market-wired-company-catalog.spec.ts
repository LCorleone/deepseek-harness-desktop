/**
 * Wired-state integration of the locked company catalog (L2): the plugin
 * index wiring builder assembles the provider, the settings-backed sequence
 * ratchet, the catalog source lock record, the catalog-service adapter
 * registration, and the signed-manifest install whitelist from one policy
 * projection. The spec drives the real chain: a packaged-layout manifest
 * asset read through the content provider, a catalog scan that produces
 * install candidates, install decisions over the signed entries, and the
 * untrusted-reporting propagation from a failed scan through the adapter
 * wrapper into the authority.
 *
 * Scope note: the signed company manifest schema pins each entry's true VCS
 * repository identity; the provider carries it onto the catalog rows so the
 * install service admits them as preview candidates and the npm verifier can
 * back-link them against live registry metadata (covered end to end in
 * signed-manifest-install.spec). This spec asserts the wired authority
 * decisions over the provider's candidate stream plus the catalog rows'
 * repository identity — the surface the L2 wiring owns.
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultCatalogService } from '../src/catalog/service.js'
import {
  SettingsCatalogSourceStore,
  type MarketSettingsDocument,
} from '../src/catalog/source-store.js'
import { CompanyCatalogUntrustedError } from '../src/catalog/company-provider.js'
import type { CatalogHttpClient } from '../src/contracts/index.js'
import { createCommunityMarketCompanyCatalog, type DesktopPolicyView } from '../src/index.js'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from '../src/signing/index.js'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustRoots = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const verifiedAt = Date.parse('2026-09-01T00:00:00.000Z')
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const safePackage = 'dsh-plugin-safe'
const safeVersion = '1.2.3'
const safeIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`
const retiredPackage = 'dsh-plugin-retired'
const retiredVersion = '3.1.4'
const retiredIntegrity = `sha512-${Buffer.alloc(64, 5).toString('base64')}`
const absentPackage = 'dsh-plugin-absent'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packageEntry(
  packageName: string,
  version: string,
  integrity: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    packageName,
    version,
    integrity,
    bundlePatch: './cordis.patch.yml',
    repository: { url: `https://github.com/example/${packageName}` },
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    ...overrides,
  }
}

function signedManifestText(
  packages: readonly Record<string, unknown>[],
  sequence = 42,
): string {
  const manifest = {
    manifestVersion: '1.0.0',
    sequence,
    expiresAt: '2030-01-01T00:00:00Z',
    packages,
  }
  const signature = createCompanyManifestSignature(
    manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    privateKey,
    keyId,
  )
  return canonicalJsonText({ ...manifest, signature })
}

/** Build the packaged-layout fixture: `<root>/app/lib/company-market/catalog-manifest.json`. */
function packagedAppFixture(manifestText: string): {
  policy: DesktopPolicyView
  moduleUrl: string
  assetPath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-market-wired-'))
  roots.push(root)
  const assetPath = join(root, 'app', 'lib', 'company-market', 'catalog-manifest.json')
  mkdirSync(join(root, 'app', 'lib', 'company-market'), { recursive: true })
  writeFileSync(assetPath, manifestText)
  return {
    policy: {
      locked: true,
      trustRoots,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
    },
    moduleUrl: pathToFileURL(join(
      root, 'app', 'node_modules', 'dsh-community-market', 'lib', 'index.js',
    )).href,
    assetPath,
  }
}

function memoryScope(): SettingsScope<MarketSettingsDocument> & { readonly document: () => MarketSettingsDocument } {
  let document: MarketSettingsDocument = { sources: [] }
  return {
    get: () => document,
    watch: () => () => {},
    update: vi.fn(async (patch: Partial<MarketSettingsDocument>) => {
      document = { ...document, ...patch } as MarketSettingsDocument
    }),
    replace: vi.fn(async (section: MarketSettingsDocument) => { document = section }),
    document: () => document,
  }
}

const unusedHttp: CatalogHttpClient = {
  getJson: vi.fn(async () => { throw new Error('the wired content-mode chain must not fetch') }),
}

describe('locked company catalog wiring', () => {
  it('serves the packaged manifest through the full chain: scan, candidates, and install decisions', async () => {
    const fixture = packagedAppFixture(signedManifestText([
      packageEntry(safePackage, safeVersion, safeIntegrity),
      packageEntry(retiredPackage, retiredVersion, retiredIntegrity, { revoked: true }),
    ]))
    const scope = memoryScope()
    const wiring = createCommunityMarketCompanyCatalog(fixture.policy, scope, {
      moduleUrl: fixture.moduleUrl,
      now: () => verifiedAt,
    })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters },
    )

    const index = await service.scanCatalog(new AbortController().signal)

    expect(index?.source.sourceRecordId).toBe('018f1f77-a5c4-7b73-a9ae-0242ac130001')
    expect(index?.snapshots.flatMap(snapshot => snapshot.items.map(item => item.id))).toEqual([
      `npm:${safePackage}@${safeVersion}`,
    ])
    // The catalog row inherits the signed repository identity verbatim
    // (normalized), which is what makes it an install candidate at all.
    expect(index?.snapshots.flatMap(snapshot => snapshot.items)).toEqual([
      expect.objectContaining({
        repository: { url: `https://github.com/example/${safePackage}` },
      }),
    ])
    // The settings-backed ratchet recorded the verified sequence and bytes.
    expect(scope.document().companyManifest).toEqual({
      sequence: 42,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })

    // The signed entry is installable, the revoked one is not, and an
    // unsigned (absent) target never becomes installable.
    expect(wiring.installTargetAuthority.canInstall({
      packageName: safePackage,
      version: safeVersion,
      integrity: safeIntegrity,
    })).toEqual({ allowed: true, evidence: { manifestSequence: 42, keyId } })
    const revoked = wiring.installTargetAuthority.canInstall({
      packageName: retiredPackage,
      version: retiredVersion,
      integrity: retiredIntegrity,
    })
    expect(revoked.allowed).toBe(false)
    expect(revoked.reason).toContain('revoked in the signed company manifest')
    const absent = wiring.installTargetAuthority.canInstall({
      packageName: absentPackage,
      version: '1.0.0',
      integrity: safeIntegrity,
    })
    expect(absent.allowed).toBe(false)
    expect(absent.reason).toContain('is not in the signed company manifest')
    expect(unusedHttp.getJson).not.toHaveBeenCalled()
  })

  it('admits a signed catalog entry through the wired install chain', async () => {
    const fixture = packagedAppFixture(signedManifestText([
      packageEntry(safePackage, safeVersion, safeIntegrity),
    ]))
    const scope = memoryScope()
    const wiring = createCommunityMarketCompanyCatalog(fixture.policy, scope, {
      moduleUrl: fixture.moduleUrl,
      now: () => verifiedAt,
    })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters },
    )

    const index = await service.scanCatalog(new AbortController().signal)

    // The scan produced the install candidates: signed integrity, bundle
    // patch, and runtime ranges carried verbatim for the install-time check.
    // (Catalog rows also carry the signed repository identity, so the market
    // install service admits them as preview candidates — see the module docs.)
    expect(wiring.provider.verifiedPackages()).toEqual([expect.objectContaining({
      itemId: `npm:${safePackage}@${safeVersion}`,
      packageName: safePackage,
      version: safeVersion,
      integrity: safeIntegrity,
      bundlePatch: './cordis.patch.yml',
    })])
    expect(index?.source.providerId).toBe('com.deepseek.company-catalog')
    expect(wiring.companySource).toMatchObject({
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac130001',
      adapterId: 'market.company-manifest-v1',
      providerId: 'com.deepseek.company-catalog',
      builtInProviderKey: 'company-catalog',
      enabled: true,
    })
  })

  it('closes the install authority when a later scan fails verification', async () => {
    const fixture = packagedAppFixture(signedManifestText([
      packageEntry(safePackage, safeVersion, safeIntegrity),
    ]))
    const scope = memoryScope()
    const wiring = createCommunityMarketCompanyCatalog(fixture.policy, scope, {
      moduleUrl: fixture.moduleUrl,
      now: () => verifiedAt,
    })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters },
    )
    await service.scanCatalog(new AbortController().signal)
    expect(wiring.installTargetAuthority.canInstall({
      packageName: safePackage,
      version: safeVersion,
      integrity: safeIntegrity,
    }).allowed).toBe(true)

    // Tamper with the packaged asset: the next forced scan must fail closed
    // and the adapter wrapper must propagate the untrusted verdict.
    const tampered = JSON.parse(signedManifestText([
      packageEntry(safePackage, '9.9.9', safeIntegrity),
    ])) as Record<string, unknown>
    const packages = tampered.packages as Record<string, unknown>[]
    packages[0] = { ...packages[0]!, version: safeVersion }
    writeFileSync(fixture.assetPath, canonicalJsonText(tampered))

    await expect(service.scanCatalog(new AbortController().signal, { force: true }))
      .rejects.toBeInstanceOf(CompanyCatalogUntrustedError)
    const denied = wiring.installTargetAuthority.canInstall({
      packageName: safePackage,
      version: safeVersion,
      integrity: safeIntegrity,
    })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('the company catalog is not trusted')
  })

  it('logs the fine-grained failure code to the injected host logger before propagating', async () => {
    const fixture = packagedAppFixture(signedManifestText([
      packageEntry(safePackage, safeVersion, safeIntegrity),
    ]))
    const scope = memoryScope()
    const logger = { error: vi.fn(), warn: vi.fn() }
    const wiring = createCommunityMarketCompanyCatalog(fixture.policy, scope, {
      moduleUrl: fixture.moduleUrl,
      now: () => verifiedAt,
      logger,
    })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters },
    )

    // Tamper with the packaged asset so the forced scan fails verification.
    const tampered = JSON.parse(signedManifestText([
      packageEntry(safePackage, '9.9.9', safeIntegrity),
    ])) as Record<string, unknown>
    const packages = tampered.packages as Record<string, unknown>[]
    packages[0] = { ...packages[0]!, version: safeVersion }
    writeFileSync(fixture.assetPath, canonicalJsonText(tampered))

    const cause = await service.scanCatalog(new AbortController().signal, { force: true })
      .then(() => { throw new Error('the tampered scan must fail') })
      .catch((error: unknown) => error as CompanyCatalogUntrustedError)
    expect(cause).toBeInstanceOf(CompanyCatalogUntrustedError)
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`company catalog scan failed: [${cause.code}]`),
    )
  })

  it('self-heals a residual stale digest in the settings ratchet and warns through the host logger', async () => {
    // The field incident at wired level: the settings document carries a
    // record whose bytesSha256 is a merge-era leftover that matches nothing
    // being served. The scan must recover the catalog on the freshly
    // verified bytes, surface the divergence through the injected host
    // logger (the desktop wiring hands it ctx.logger), and refresh the
    // settings-backed record so the next scan is the silent steady state.
    const manifestText = signedManifestText([
      packageEntry(safePackage, safeVersion, safeIntegrity),
    ], 3)
    const fixture = packagedAppFixture(manifestText)
    const residual = sha256Hex('merge-era leftover bytes')
    let document: MarketSettingsDocument = {
      sources: [],
      companyManifest: { sequence: 3, keyId, verifiedAt: '2026-08-01T00:00:00.000Z', bytesSha256: residual },
    }
    const scope: SettingsScope<MarketSettingsDocument> = {
      get: () => document,
      watch: () => () => {},
      update: vi.fn(async (patch: Partial<MarketSettingsDocument>) => {
        document = { ...document, ...patch } as MarketSettingsDocument
      }),
      replace: vi.fn(async (section: MarketSettingsDocument) => { document = section }),
    }
    const logger = { error: vi.fn(), warn: vi.fn() }
    const wiring = createCommunityMarketCompanyCatalog(fixture.policy, scope, {
      moduleUrl: fixture.moduleUrl,
      now: () => verifiedAt,
      logger,
    })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters },
    )

    const index = await service.scanCatalog(new AbortController().signal)

    expect(index?.snapshots.flatMap(snapshot => snapshot.items.map(item => item.id)))
      .toEqual([`npm:${safePackage}@${safeVersion}`])
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`recorded digest ${residual}`))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      `computed digest ${sha256Hex(manifestText)}`,
    ))
    expect(document.companyManifest).toEqual({
      sequence: 3,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: sha256Hex(manifestText),
    })

    // The healed ratchet serves the steady state silently from here on.
    const steady = await service.scanCatalog(new AbortController().signal, { force: true })
    expect(steady?.snapshots).toBeTruthy()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the packaged manifest asset is missing', async () => {
    const fixture = packagedAppFixture('unused')
    rmSync(fixture.assetPath)
    const scope = memoryScope()
    const wiring = createCommunityMarketCompanyCatalog(fixture.policy, scope, {
      moduleUrl: fixture.moduleUrl,
      now: () => verifiedAt,
    })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters },
    )

    await expect(service.scanCatalog(new AbortController().signal)).rejects.toThrow()
    expect(wiring.installTargetAuthority.canInstall({
      packageName: safePackage,
      version: safeVersion,
      integrity: safeIntegrity,
    })).toEqual({ allowed: false, reason: 'no verified company manifest is available yet' })
    expect(scope.document().companyManifest).toBeUndefined()
  })

  it('requires a locked policy with pinned trust roots', () => {
    const scope = memoryScope()
    expect(() => createCommunityMarketCompanyCatalog({
      locked: false,
      trustRoots,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
    }, scope)).toThrow(/locked/u)
    expect(() => createCommunityMarketCompanyCatalog({
      locked: true,
      trustRoots: [],
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
    }, scope)).toThrow(/trust roots/u)
  })

  it('rejects unsafe packaged asset specifiers', () => {
    expect(() => {
      createCommunityMarketCompanyCatalog({
        locked: true,
        trustRoots,
        companyCatalogOrigin: null,
        companyManifestUrl: '../escape.json',
      }, memoryScope(), { moduleUrl: packagedAppFixture('unused').moduleUrl })
    }).toThrow(/empty or dot path segments/u)
  })
})

describe('origin-mode host HTTP client injection', () => {
  const gitlabLikeOrigin = 'https://gitlab.company.example'
  const manifestUrl = `${gitlabLikeOrigin}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`

  function originPolicy(): DesktopPolicyView {
    return {
      locked: true,
      trustRoots,
      companyCatalogOrigin: gitlabLikeOrigin,
      companyManifestUrl: manifestUrl,
    }
  }

  it('serves the origin-mode catalog scan through the host-injected client', async () => {
    // The Electron Desktop main process injects its Chromium-stack client for
    // corporate-CA origins whose addresses the portable restricted client
    // refuses; the scan must run entirely through that client — the pinned
    // URL and `allowedOrigin` policy included — while the shared restricted
    // client is never contacted.
    const injected: CatalogHttpClient = {
      getJson: vi.fn(async (url: string, signal: AbortSignal, policy?: { allowedOrigin?: string }) => {
        expect(url).toBe(manifestUrl)
        expect(policy?.allowedOrigin).toBe(gitlabLikeOrigin)
        expect(signal.aborted).toBe(false)
        return { value: JSON.parse(signedManifestText([
          packageEntry(safePackage, safeVersion, safeIntegrity),
        ], 3)), finalUrl: url }
      }),
    }
    const scope = memoryScope()
    const wiring = createCommunityMarketCompanyCatalog(originPolicy(), scope, {
      originHttpClient: injected,
      now: () => verifiedAt,
    })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters, adapterHttpClients: wiring.adapterHttpClients },
    )

    const index = await service.scanCatalog(new AbortController().signal)

    expect(index?.snapshots.flatMap(snapshot => snapshot.items.map(item => item.id))).toEqual([
      `npm:${safePackage}@${safeVersion}`,
    ])
    expect(injected.getJson).toHaveBeenCalledTimes(1)
    expect(unusedHttp.getJson).not.toHaveBeenCalled()
    // Origin mode records the verified sequence and bytes digest too: the
    // same-sequence replay of a static origin is the normal steady state and
    // is guarded by byte identity instead of a strict-increase ratchet.
    expect(scope.document().companyManifest).toEqual({
      sequence: 3,
      keyId,
      verifiedAt: '2026-09-01T00:00:00.000Z',
      bytesSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(wiring.provider.verification()).toMatchObject({ mode: 'origin', sequence: 3 })
  })

  it('keeps the restricted client without injection: a private-network origin stays refused', async () => {
    // The portable default must not be weakened for the company path: an
    // origin pinned to a loopback address is refused deterministically by the
    // restricted client's blocklist (no DNS, no request) — the internal-
    // hosting case the Desktop host solves by injecting its own client.
    const scope = memoryScope()
    const wiring = createCommunityMarketCompanyCatalog({
      locked: true,
      trustRoots,
      companyCatalogOrigin: 'https://127.0.0.1',
      companyManifestUrl: 'https://127.0.0.1/catalog-manifest.json',
    }, scope, { now: () => verifiedAt })
    const service = new DefaultCatalogService(
      new SettingsCatalogSourceStore(scope, { locked: true, companySource: wiring.companySource }),
      unusedHttp,
      { adapters: wiring.adapters, adapterHttpClients: wiring.adapterHttpClients },
    )

    await expect(service.scanCatalog(new AbortController().signal))
      .rejects.toThrow('blocked-address')
    expect(scope.document().companyManifest).toBeUndefined()
  })
})
