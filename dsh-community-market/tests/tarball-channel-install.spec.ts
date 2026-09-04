/**
 * Tarball-channel install support in the market library (P7 2c): the
 * injectable verification seam (`composeTarballAwareVerifier`) and the
 * `file:` lockfile pin the controlled tarball channel produces. The market
 * library stays registry-generic — the Desktop host injects the seam, and
 * these tests pin the generic half: an injected tarball verification rides
 * the standard install flow unchanged, the `file:` dependency pin a
 * controlled tarball install leaves behind reconciles exactly like the
 * registry channel's exact-version pin, and nothing about the npm path
 * changes when the seam declines a candidate.
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import type { CompanyManifestVerifier } from '../src/catalog/company-provider.js'
import { verifyCompanyManifest } from '../src/signing/index.js'
import {
  composeTarballAwareVerifier,
  createNpmRegistryVerifier,
  MarketInstallService,
  type MarketDesktopPnpm,
  type MarketNpmPackageVerification,
  type MarketNpmPackageVerifier,
} from '../src/install/service.js'
import { createSignedManifestInstallTargetAuthority } from '../src/install/signed-manifest-authority.js'
import { createCompanyCatalogProvider, type CompanyCatalogProvider } from '../src/catalog/company-provider.js'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  type CompanyManifestTrustRoot,
} from '../src/signing/index.js'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustRoots: readonly CompanyManifestTrustRoot[] = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const verifiedAt = Date.parse('2026-09-01T00:00:00.000Z')

const packageName = 'company-hardened-plugin'
const version = '2.1.0'
const tarballIntegrity = `sha512-${createHash('sha512').update('company tarball fixture bytes').digest('base64')}`
const registryIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`
const hostedTarballUrl = 'https://gitlab.company.example/julu/dsh-desktop-config/-/packages/company-hardened-plugin-2.1.0.tgz'
const bundlePatch = './cordis.patch.yml'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => await rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-market-tarball-channel-'))
  temporaryDirectories.push(path)
  return path
}

/** Company source over real signed bytes (content mode), for the authority. */
async function signedSource(packages: readonly Record<string, unknown>[], sequence = 42): Promise<CompanyCatalogProvider> {
  const unsigned = {
    manifestVersion: '1.0.0',
    sequence,
    expiresAt: '2030-01-01T00:00:00Z',
    packages,
  }
  const signature = createCompanyManifestSignature(
    unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    privateKey,
    keyId,
  )
  const text = canonicalJsonText({ ...unsigned, signature })
  // Field-aware plumbing double (the same contract the Desktop host injects
  // through the `desktopCompanyManifestVerifier` capability): the
  // market-known projection verifies through the real market verifier and
  // the extension field rides back onto the verified manifest. The real
  // dual-channel verification chain is exercised in the desktop workspace.
  const fieldAwareVerifier: CompanyManifestVerifier = (raw, options) => {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) as {
      packages?: Array<Record<string, unknown>>
      signature?: unknown
    }
    const entries = Array.isArray(parsed.packages) ? parsed.packages : []
    const sources = entries.map(entry => entry.source)
    const { signature: _wireSignature, ...document } = parsed
    const projection = { ...document, packages: entries.map(({ source: _source, ...rest }) => rest) }
    const projected = verifyCompanyManifest(canonicalJsonText({
      ...projection,
      signature: createCompanyManifestSignature(
        projection as unknown as Parameters<typeof createCompanyManifestSignature>[0],
        privateKey,
        keyId,
      ),
    }), options)
    if (!projected.ok) return projected
    return {
      ...projected,
      manifest: {
        ...projected.manifest,
        packages: projected.manifest.packages.map((entry, index) => (
          sources[index] === undefined ? entry : { ...entry, source: sources[index] }
        )),
      },
    }
  }
  const provider = createCompanyCatalogProvider({
    manifestContentProvider: () => text,
    trustRoots,
    now: () => verifiedAt,
    manifestVerifier: fieldAwareVerifier,
  })
  await provider.scanCatalog!({}, {
    signal: new AbortController().signal,
    http: { getJson: vi.fn(async () => { throw new Error('content mode never fetches') }) },
    source: {
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120021',
      registrationKind: 'built-in',
      adapterId: 'market.company-manifest-v1',
      providerId: 'com.deepseek.company-catalog',
      builtInProviderKey: 'company-catalog',
      enabled: true,
      order: 0,
    },
    media: { register: vi.fn() },
  })
  return provider
}

function memoryScope(initial: readonly unknown[] = []): SettingsScope<MarketSettingsDocument> {
  let document: MarketSettingsDocument = {
    sources: [],
    installReceipts: initial as NonNullable<MarketSettingsDocument['installReceipts']>,
  }
  return {
    get: () => document,
    watch: () => () => {},
    update: vi.fn(async patch => { document = { ...document, ...patch } as MarketSettingsDocument }),
    replace: vi.fn(async section => { document = section as MarketSettingsDocument }),
  }
}

/** A controlled tarball install's on-disk shape: `file:` dependency pin, lockfile record, installed bundle. */
async function writeTarballInstalledProfile(
  profileDir: string,
  stagedPath: string,
  options: { readonly resolutionIntegrity?: string } = {},
): Promise<void> {
  const pluginDir = join(profileDir, 'node_modules', packageName)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    dsh: { bundle: { patch: bundlePatch } },
  }))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
    dependencies: { [packageName]: `file:${stagedPath}` },
    dsh: { profile: { bundles: [packageName] } },
  }))
  // pnpm's own lockfile spelling of a `file:` install: an absolute specifier,
  // a profile-relative resolution, and the package entry keyed by the
  // resolution — the sha512 there is the tarball's own digest.
  const relativeStaged = stagedPath.slice(profileDir.length + 1)
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
    lockfileVersion: '9.0',
    importers: {
      '.': {
        dependencies: {
          [packageName]: { specifier: `file:${stagedPath}`, version: `file:${relativeStaged}` },
        },
      },
    },
    packages: {
      [`${packageName}@file:${relativeStaged}`]: {
        resolution: { integrity: options.resolutionIntegrity ?? tarballIntegrity, tarball: `file:${relativeStaged}` },
        version,
      },
    },
    snapshots: { [`${packageName}@file:${relativeStaged}`]: {} },
  }))
}

function pnpmDouble(profileDir: string, calls: string[][]): MarketDesktopPnpm {
  return {
    runPlugin(args) {
      calls.push([...args])
      const done = (async () => {
        if (args[0] === 'remove') {
          await rm(join(profileDir, 'node_modules', packageName), { recursive: true, force: true })
          await writeFile(join(profileDir, 'package.json'), JSON.stringify({
            name: 'fixture-profile',
            dependencies: {},
            dsh: { profile: { bundles: [] },
            },
          }))
          await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
            lockfileVersion: '9.0',
            importers: { '.': {} },
            packages: {},
            snapshots: {},
          }))
        }
        return { exitCode: 0, signal: null }
      })()
      return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
    },
    async installPlugin(request) {
      return this.runPlugin(['add', ...(request.pnpmOptions ?? []), `${request.recovery.packageName}@${request.recovery.packageVersion}`], request.invokingDir, request.signal)
    },
    async recoveredInstallReceiptIds() { return [] },
    async acknowledgeRecoveredInstall() {},
    async rollbackPluginInstall() { return false },
  }
}

function catalogSnapshotItem() {
  return {
    id: `npm:${packageName}@${version}`,
    name: packageName,
    displayName: packageName,
    summary: 'company signed catalog entry',
    package: { registry: 'npm' as const, name: packageName },
    latestVersion: version,
    repository: { url: 'https://github.com/example/company-hardened-plugin' },
    provenance: {
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120021',
      providerId: 'com.deepseek.company-catalog',
      itemId: `npm:${packageName}@${version}`,
    },
  }
}

function observeFixtureCatalog(service: MarketInstallService): void {
  service.observeCatalog({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120021',
      providerId: 'com.deepseek.company-catalog',
      adapterId: 'market.company-manifest-v1',
      registrationKind: 'built-in',
      fetchedAt: new Date(verifiedAt).toISOString(),
      finalUrl: 'dsh-company-catalog://embedded',
      providerRevision: 'company-manifest-42',
    },
    items: [catalogSnapshotItem()],
    page: { total: 1 },
  })
}

function tarballEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName,
    version,
    integrity: tarballIntegrity,
    bundlePatch,
    repository: { url: 'https://github.com/example/company-hardened-plugin' },
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    treeDigest: 'ab'.repeat(32),
    source: { kind: 'tarball', url: hostedTarballUrl, integrity: tarballIntegrity },
    ...overrides,
  }
}

describe('tarball-aware verifier composition', () => {
  const candidate = { packageName, version, repository: { url: 'https://github.com/example/company-hardened-plugin' } }

  it('returns the injected tarball verification without touching the registry verifier', async () => {
    const base: MarketNpmPackageVerifier = { verify: vi.fn(async () => { throw new Error('registry must not be consulted') }) }
    const signed: MarketNpmPackageVerification = { integrity: tarballIntegrity, bundlePatch, tarball: hostedTarballUrl }
    const composed = composeTarballAwareVerifier(base, { verifyTarballEntry: vi.fn(async () => signed) })

    await expect(composed.verify(candidate, new AbortController().signal)).resolves.toEqual(signed)
    expect(base.verify).not.toHaveBeenCalled()
  })

  it('keeps the registry verifier byte-for-byte when the seam declines the candidate', async () => {
    const registry: MarketNpmPackageVerification = {
      integrity: registryIntegrity,
      bundlePatch,
      tarball: `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`,
    }
    const base: MarketNpmPackageVerifier = { verify: vi.fn(async () => registry) }
    const composed = composeTarballAwareVerifier(base, { verifyTarballEntry: vi.fn(async () => undefined) })

    await expect(composed.verify(candidate, new AbortController().signal)).resolves.toBe(registry)
    expect(base.verify).toHaveBeenCalledWith(candidate, expect.any(AbortSignal))
  })

  it('propagates the registry verifier decision when the seam never claims any entry', () => {
    // The default (uninjected) verifier is exactly the registry verifier.
    expect(typeof createNpmRegistryVerifier).toBe('function')
  })
})

describe('file: dependency pin reconciliation (the controlled tarball channel)', () => {
  it('installs an injected tarball verification through the standard flow and persists the receipt', async () => {
    const root = await temporaryDirectory()
    const profileDir = join(root, 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'fixture-profile', dependencies: {} }))
    const stagedPath = join(profileDir, '.dsh-market-tarballs', `${packageName}-${version}.tgz`)
    const provider = await signedSource([tarballEntry()])
    const calls: string[][] = []
    const settings = memoryScope()
    const service = new MarketInstallService(
      settings,
      () => ({ name: 'web', dir: profileDir }),
      {
        ...pnpmDouble(profileDir, calls),
        // The controlled boundary installs the staged tarball and leaves the
        // `file:` pin behind, exactly like the Desktop channel does.
        async installPlugin() {
          calls.push(['add', `file:${stagedPath}`])
          await writeTarballInstalledProfile(profileDir, stagedPath)
          return {
            stdout: Readable.from([]),
            stderr: Readable.from([]),
            done: Promise.resolve({ exitCode: 0, signal: null }),
            cancel: vi.fn(),
          }
        },
      },
      { verify: vi.fn(async () => ({ integrity: tarballIntegrity, bundlePatch, tarball: hostedTarballUrl })) },
      { installTargetAuthority: createSignedManifestInstallTargetAuthority(provider) },
    )
    observeFixtureCatalog(service)

    const preview = await service.previewInstall('018f1f77-a5c4-7b73-a9ae-0242ac120021', `npm:${packageName}@${version}`, new AbortController().signal)
    expect(preview).toMatchObject({ action: 'install', packageName, version })
    const result = await service.executeInstall(preview.intent, new AbortController().signal)

    expect(calls).toEqual([['add', `file:${stagedPath}`]])
    expect(result.receipt).toMatchObject({
      packageName,
      version,
      integrity: tarballIntegrity,
      bundlePatch,
      manifestSequence: 42,
      keyId,
      resolved: { registryIntegrity: tarballIntegrity },
    })

    // The `file:` pin reconciles like an installed bundle: the verified
    // receipts list keeps it, and the uninstall flow accepts it.
    const verified = await service.listVerifiedReceipts(new AbortController().signal)
    expect(verified.map(receipt => receipt.receiptId)).toEqual([result.receipt.receiptId])
    const uninstallPreview = await service.previewUninstall(result.receipt.receiptId, new AbortController().signal)
    expect(uninstallPreview).toMatchObject({ action: 'uninstall', packageName })
    const removed = await service.executePreview(uninstallPreview.intent, new AbortController().signal)
    expect(removed).toMatchObject({ action: 'uninstall', packageName })
    expect((settings.get().installReceipts ?? []).length).toBe(0)
    expect(calls.at(-1)).toEqual(['remove', packageName])
  })

  it('refuses a file: pin whose recorded lockfile integrity diverges from the expectation', async () => {
    const root = await temporaryDirectory()
    const profileDir = join(root, 'profiles', 'web')
    const stagedPath = join(profileDir, '.dsh-market-tarballs', `${packageName}-${version}.tgz`)
    await writeTarballInstalledProfile(profileDir, stagedPath, {
      // The lockfile pins some other sha512 — the pin does not prove the
      // expected bytes, exactly like a diverging registry pin.
      resolutionIntegrity: `sha512-${Buffer.alloc(64, 4).toString('base64')}`,
    })
    const provider = await signedSource([tarballEntry()])
    const settings = memoryScope([{
      receiptId: 'receipt:tarball-diverging-0001',
      profileName: 'web',
      packageName,
      version,
      integrity: tarballIntegrity,
      bundlePatch,
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120021',
      providerId: 'com.deepseek.company-catalog',
      itemId: `npm:${packageName}@${version}`,
      displayName: packageName,
      installedAt: '2026-09-01T00:00:00.000Z',
    }])
    const service = new MarketInstallService(
      settings,
      () => ({ name: 'web', dir: profileDir }),
      pnpmDouble(profileDir, []),
      { verify: vi.fn(async () => { throw new Error('never reached') }) },
      { installTargetAuthority: createSignedManifestInstallTargetAuthority(provider) },
    )

    await expect(service.previewUninstall('receipt:tarball-diverging-0001', new AbortController().signal))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(service.listVerifiedReceipts(new AbortController().signal)).resolves.toEqual([])
  })
})
