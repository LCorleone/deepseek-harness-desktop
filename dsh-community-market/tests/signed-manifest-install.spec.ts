import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import {
  CompanyCatalogUntrustedError,
  createCompanyCatalogProvider,
  type CompanyManifestSequenceStore,
} from '../src/catalog/company-provider.js'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import type { CatalogHttpClient, CatalogSnapshot, LocalSourceRecord } from '../src/contracts/index.js'
import { createNpmRegistryVerifier } from '../src/install/service.js'
import {
  createSignedManifestInstallTargetAuthority,
  type SignedManifestInstallTargetAuthority,
} from '../src/install/signed-manifest-authority.js'
import { computeInstallTreeDigest } from '../src/install/tree-digest.js'
import {
  MarketInstallService,
  type InstallTargetCandidate,
  type MarketDesktopPnpm,
  type MarketInstallReceipt,
} from '../src/install/service.js'
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

const packageName = 'dsh-plugin-safe'
const version = '1.2.3'
const otherIntegrity = `sha512-${Buffer.alloc(64, 3).toString('base64')}`
const signedIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`
const tarball = `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`
const verification = { integrity: signedIntegrity, bundlePatch: './cordis.patch.yml', tarball }
const candidate: InstallTargetCandidate = { packageName, version, integrity: signedIntegrity }
const temporaryDirectories: string[] = []
const sha256hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => await rm(path, { recursive: true, force: true })))
})

function packageEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName,
    version,
    integrity: signedIntegrity,
    bundlePatch: './cordis.patch.yml',
    repository: { url: 'https://github.com/example/dsh-plugin-safe' },
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2', nodeRuntimeVersion: '>=22.0.0' },
    ...overrides,
  }
}

function signedManifestText(packages: readonly Record<string, unknown>[], sequence = 42): string {
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

function contentContext() {
  const http: CatalogHttpClient = { getJson: vi.fn(async () => { throw new Error('company manifest must not be fetched here') }) }
  const source: LocalSourceRecord = {
    sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120021',
    registrationKind: 'built-in',
    adapterId: 'market.company-manifest-v1',
    providerId: 'com.deepseek.company-catalog',
    builtInProviderKey: 'company-catalog',
    enabled: true,
    order: 0,
  }
  return { source, signal: new AbortController().signal, http, media: { register: vi.fn() } }
}

/** Company source scanned once over real signed bytes; `rescan` publishes a newer sequence. */
async function scannedCompanySource(packages: readonly Record<string, unknown>[], sequence = 42) {
  let text = signedManifestText(packages, sequence)
  const records: { sequence: number; keyId: string; verifiedAt: string }[] = []
  const sequenceStore: CompanyManifestSequenceStore = {
    async load() { return records[records.length - 1] },
    async save(record) { records.push(record) },
  }
  const provider = createCompanyCatalogProvider({
    manifestContentProvider: () => text,
    trustRoots,
    sequenceStore,
    now: () => verifiedAt,
  })
  const scan = async () => await provider.scanCatalog!({}, contentContext())
  await scan()
  return {
    provider,
    async rescan(nextPackages: readonly Record<string, unknown>[], nextSequence: number) {
      text = signedManifestText(nextPackages, nextSequence)
      await scan()
    },
  }
}

describe('signed manifest install target authority', () => {
  it('allows a signed entry with matching integrity and carries manifest evidence', async () => {
    const { provider } = await scannedCompanySource([packageEntry()])
    const authority = createSignedManifestInstallTargetAuthority(provider)

    expect(authority.canInstall(candidate)).toEqual({
      allowed: true,
      evidence: { manifestSequence: 42, keyId },
    })
  })

  it('carries the signed approvedBuilds of a matching entry as install evidence', async () => {
    const { provider } = await scannedCompanySource([
      packageEntry({ approvedBuilds: ['sharp', '@scope/native-helper'] }),
    ])
    const authority = createSignedManifestInstallTargetAuthority(provider)

    expect(authority.canInstall(candidate)).toEqual({
      allowed: true,
      evidence: { manifestSequence: 42, keyId, approvedBuildDependencies: ['sharp', '@scope/native-helper'] },
    })
  })

  it('rejects an integrity mismatch naming both digests', async () => {
    const { provider } = await scannedCompanySource([packageEntry()])
    const authority = createSignedManifestInstallTargetAuthority(provider)

    const decision = authority.canInstall({ ...candidate, integrity: otherIntegrity })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('signed company manifest pins dsh-plugin-safe@1.2.3 to integrity ' + signedIntegrity)
    expect(decision.reason).toContain(otherIntegrity)
  })

  it('rejects a revoked signed entry even though browsing hides it', async () => {
    const { provider } = await scannedCompanySource([packageEntry({ revoked: true })])
    const authority = createSignedManifestInstallTargetAuthority(provider)

    expect(provider.findVerifiedPackage(packageName, version)).toBeUndefined()
    const decision = authority.canInstall(candidate)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('revoked in the signed company manifest')
  })

  it('rejects a target not present in the signed manifest', async () => {
    const { provider } = await scannedCompanySource([packageEntry({ packageName: 'dsh-plugin-other' })])
    const authority = createSignedManifestInstallTargetAuthority(provider)

    const decision = authority.canInstall(candidate)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('is not in the signed company manifest')
  })

  it('fails closed before the first verified scan', () => {
    const provider = createCompanyCatalogProvider({ manifestContentProvider: () => signedManifestText([]), trustRoots })
    const authority = createSignedManifestInstallTargetAuthority(provider)

    const decision = authority.canInstall(candidate)
    expect(decision).toEqual({ allowed: false, reason: 'no verified company manifest is available yet' })
  })

  it('fails closed with the reported untrusted cause until a newer manifest verifies', async () => {
    const source = await scannedCompanySource([packageEntry()])
    const authority = createSignedManifestInstallTargetAuthority(source.provider)
    expect(authority.canInstall(candidate).allowed).toBe(true)

    authority.reportUntrustedCatalog(new CompanyCatalogUntrustedError('bad-signature', 'ed25519 signature verification failed'))
    const denied = authority.canInstall(candidate)
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('company catalog is not trusted')
    expect(denied.reason).toContain('ed25519 signature verification failed')

    await source.rescan([packageEntry()], 43)
    expect(authority.canInstall(candidate)).toEqual({
      allowed: true,
      evidence: { manifestSequence: 43, keyId },
    })
  })

  it('fails closed once the verified manifest expired on the injected clock', async () => {
    const { provider } = await scannedCompanySource([packageEntry()])
    const authority = createSignedManifestInstallTargetAuthority(provider, { now: () => Date.parse('2031-01-01T00:00:00.000Z') })

    const decision = authority.canInstall(candidate)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('expired at 2030-01-01T00:00:00Z')
  })

  it('decides from memory and never re-pulls the manifest at install time', async () => {
    let pulls = 0
    const provider = createCompanyCatalogProvider({
      manifestContentProvider: () => {
        pulls += 1
        if (pulls > 1) throw new Error('the manifest must not be re-pulled for install decisions')
        return signedManifestText([packageEntry()])
      },
      trustRoots,
      now: () => verifiedAt,
    })
    await provider.scanCatalog!({}, contentContext())
    const authority = createSignedManifestInstallTargetAuthority(provider)

    expect(authority.canInstall(candidate).allowed).toBe(true)
    expect(authority.canInstall(candidate).allowed).toBe(true)
    expect(pulls).toBe(1)
  })

  it('requires the narrow source contract', () => {
    expect(() => createSignedManifestInstallTargetAuthority({} as never)).toThrow(TypeError)
  })
})

describe('install tree digest', () => {
  async function contentTree(order: 'forward' | 'reverse'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'market-tree-digest-'))
    temporaryDirectories.push(dir)
    const files: Array<[string, string]> = [
      ['package.json', '{"name":"dsh-plugin-safe"}\n'],
      ['cordis.patch.yml', '[]\n'],
      ['lib/alpha.js', 'alpha'],
      ['lib/nested/deep.txt', 'deep'],
      ['lib/beta.js', 'beta'],
    ]
    for (const [path, body] of order === 'forward' ? files : [...files].reverse()) {
      await mkdir(join(dir, path, '..'), { recursive: true })
      await writeFile(join(dir, path), body)
    }
    // Empty directories contribute no record.
    await mkdir(join(dir, 'lib/empty-dir'), { recursive: true })
    return dir
  }

  it('is deterministic across repeated computation and file order', async () => {
    const first = await computeInstallTreeDigest(await contentTree('forward'))
    const second = await computeInstallTreeDigest(await contentTree('forward'))
    const reordered = await computeInstallTreeDigest(await contentTree('reverse'))

    expect(second).toEqual(first)
    expect(reordered).toEqual(first)
    expect(first.files.map(file => file.path)).toEqual([
      'cordis.patch.yml',
      'lib/alpha.js',
      'lib/beta.js',
      'lib/nested/deep.txt',
      'package.json',
    ])
  })

  it('follows the documented per-file and root digest rules', async () => {
    const dir = await contentTree('forward')
    const digest = await computeInstallTreeDigest(dir)

    expect(digest.algorithm).toBe('sha256')
    expect(digest.files[0]).toEqual({ path: 'cordis.patch.yml', digest: sha256hex('[]\n') })
    expect(digest.files.find(file => file.path === 'lib/nested/deep.txt')).toEqual({
      path: 'lib/nested/deep.txt',
      digest: sha256hex('deep'),
    })
    const root = createHash('sha256')
    for (const file of digest.files) root.update(`sha256:${file.path}\n${file.digest}\n`, 'utf8')
    expect(digest.rootDigest).toBe(root.digest('hex'))
  })

  it.runIf(process.platform !== 'win32')('hashes symbolic link targets without following them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'market-tree-digest-link-'))
    temporaryDirectories.push(dir)
    await writeFile(join(dir, 'outside.txt'), 'external content')
    await writeFile(join(dir, 'package.json'), '{}\n')
    const linkTarget = join(dir, 'outside.txt')
    await symlink(linkTarget, join(dir, 'package.json', '..', 'link.txt'))

    const digest = await computeInstallTreeDigest(dir)

    expect(digest.files.find(file => file.path === 'link.txt')).toEqual({
      path: 'link.txt',
      digest: sha256hex(linkTarget),
    })
    expect(digest.files.find(file => file.path === 'link.txt')?.digest).not.toBe(sha256hex('external content'))
  })
})

describe('market install service behind the signed manifest', () => {
  function snapshot(): CatalogSnapshot {
    return {
      schemaVersion: '1.0.0',
      source: {
        sourceRecordId: 'source-1',
        providerId: DSH_1024STORE_PROVIDER_ID,
        adapterId: DSH_1024STORE_ADAPTER_ID,
        registrationKind: 'built-in',
        fetchedAt: '2026-08-18T00:00:00.000Z',
        finalUrl: 'https://deepseek1024.com/api/v1/plugins',
      },
      items: [{
        id: 'example/dsh-plugin-safe',
        name: packageName,
        displayName: 'Safe Plugin',
        summary: 'Fixture plugin',
        latestVersion: version,
        package: { registry: 'npm', name: packageName },
        repository: { url: 'https://github.com/example/dsh-plugin-safe' },
        provenance: {
          sourceRecordId: 'source-1',
          providerId: DSH_1024STORE_PROVIDER_ID,
          itemId: 'example/dsh-plugin-safe',
        },
      }],
      page: {},
    } as CatalogSnapshot
  }

  async function createProfile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'market-signed-install-'))
    temporaryDirectories.push(dir)
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }))
    return dir
  }

  async function writeInstalledPlugin(profileDir: string): Promise<void> {
    const pluginDir = join(profileDir, 'node_modules', packageName)
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'cordis.patch.yml'), '[]\n')
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
      name: packageName,
      version,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      dependencies: { [packageName]: version },
      dsh: { profile: { bundles: [packageName] } },
    }))
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
      lockfileVersion: '9.0',
      importers: {
        '.': {
          dependencies: {
            [packageName]: { specifier: version, version },
          },
        },
      },
      packages: { [`${packageName}@${version}`]: { resolution: { integrity: signedIntegrity } } },
      snapshots: { [`${packageName}@${version}`]: {} },
    }))
  }

  async function removeInstalledPlugin(profileDir: string): Promise<void> {
    await rm(join(profileDir, 'node_modules', packageName), { recursive: true, force: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    }))
    await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
      lockfileVersion: '9.0',
      importers: { '.': {} },
      packages: {},
      snapshots: {},
    }))
  }

  function runner(
    profileDir: string,
    calls: string[][],
    installRequests: { approvedBuildDependencies?: readonly string[] }[] = [],
  ): MarketDesktopPnpm {
    return {
      runPlugin(args) {
        calls.push([...args])
        const done = (async () => {
          if (args[0] === 'add') await writeInstalledPlugin(profileDir)
          if (args[0] === 'remove') await removeInstalledPlugin(profileDir)
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
      async installPlugin(request) {
        installRequests.push({
          ...(request.approvedBuildDependencies === undefined
            ? {}
            : { approvedBuildDependencies: request.approvedBuildDependencies }),
        })
        return this.runPlugin([
          'add',
          ...(request.pnpmOptions ?? []),
          `${request.recovery.packageName}@${request.recovery.packageVersion}`,
        ], request.invokingDir, request.signal)
      },
      async recoveredInstallReceiptIds() { return [] },
      async acknowledgeRecoveredInstall() {},
      async rollbackPluginInstall() { return false },
    }
  }

  function memoryScope(initial: readonly MarketInstallReceipt[] = []): {
    readonly scope: SettingsScope<MarketSettingsDocument>
    readonly receipts: () => readonly MarketInstallReceipt[]
  } {
    let document: MarketSettingsDocument = { sources: [], installReceipts: initial }
    return {
      scope: {
        get: () => document,
        watch: () => () => {},
        update: vi.fn(async patch => { document = { ...document, ...patch } as MarketSettingsDocument }),
        replace: vi.fn(async section => { document = section as MarketSettingsDocument }),
      },
      receipts: () => document.installReceipts ?? [],
    }
  }

  async function signedService(packages: readonly Record<string, unknown>[], options: {
    readonly profileDir: string
    readonly settings: ReturnType<typeof memoryScope>
    readonly calls: string[][]
    readonly installRequests?: { approvedBuildDependencies?: readonly string[] }[]
    readonly verifyIntegrity?: string
    readonly authority?: (provider: Awaited<ReturnType<typeof scannedCompanySource>>['provider']) => SignedManifestInstallTargetAuthority
  }) {
    const { provider } = await scannedCompanySource(packages)
    const authority = options.authority?.(provider) ?? createSignedManifestInstallTargetAuthority(provider)
    const service = new MarketInstallService(
      options.settings.scope,
      () => ({ name: 'web', dir: options.profileDir }),
      runner(options.profileDir, options.calls, options.installRequests),
      { verify: vi.fn(async () => ({ ...verification, integrity: options.verifyIntegrity ?? verification.integrity })) },
      { installTargetAuthority: authority },
    )
    service.observeCatalog(snapshot())
    return { service, authority, provider }
  }

  const legacyReceipt: MarketInstallReceipt = {
    receiptId: 'receipt:legacy-v1-00000001',
    profileName: 'web',
    packageName,
    version,
    integrity: signedIntegrity,
    bundlePatch: './cordis.patch.yml',
    sourceRecordId: 'source-1',
    providerId: DSH_1024STORE_PROVIDER_ID,
    itemId: 'example/dsh-plugin-safe',
    displayName: 'Safe Plugin',
    installedAt: '2026-08-18T00:00:00.000Z',
  }

  it('installs with full signed evidence and persists a receipt v2 with the measured tree', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[][] = []
    const { service } = await signedService([packageEntry()], { profileDir, settings, calls })

    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    const result = await service.executeInstall(preview.intent, new AbortController().signal)

    expect(calls.map(args => args[0])).toEqual(['add'])
    expect(result.receipt.receiptVersion).toBe(2)
    if (result.receipt.receiptVersion !== 2) throw new Error('expected a v2 receipt')
    const receipt = result.receipt
    expect(receipt).toMatchObject({
      packageName,
      version,
      integrity: signedIntegrity,
      bundlePatch: './cordis.patch.yml',
      manifestSequence: 42,
      keyId,
      resolved: { registryIntegrity: signedIntegrity, treeRootDigest: receipt.treeDigest.rootDigest },
      decided: { allowedBy: 'signed-company-manifest' },
    })
    expect(receipt.treeDigest.algorithm).toBe('sha256')
    expect(receipt.treeDigest.files.map(file => file.path)).toEqual(['cordis.patch.yml', 'package.json'])
    const pluginDir = join(profileDir, 'node_modules', packageName)
    expect(receipt.treeDigest.files).toEqual([
      { path: 'cordis.patch.yml', digest: sha256hex(await readFile(join(pluginDir, 'cordis.patch.yml'))) },
      { path: 'package.json', digest: sha256hex(await readFile(join(pluginDir, 'package.json'))) },
    ])
    const root = createHash('sha256')
    for (const file of receipt.treeDigest.files) root.update(`sha256:${file.path}\n${file.digest}\n`, 'utf8')
    expect(receipt.treeDigest.rootDigest).toBe(root.digest('hex'))
    expect(settings.receipts()).toEqual([receipt])

    // The v2 receipt remains a valid uninstall reconciliation credential.
    const uninstallPreview = await service.previewUninstall(receipt.receiptId, new AbortController().signal)
    const removed = await service.executePreview(uninstallPreview.intent, new AbortController().signal)
    expect(removed).toMatchObject({ action: 'uninstall', receiptId: receipt.receiptId, packageName })
    expect(settings.receipts()).toEqual([])
  })

  it('forwards the signed approvedBuilds to the package-manager install boundary', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[][] = []
    const installRequests: { approvedBuildDependencies?: readonly string[] }[] = []
    const { service } = await signedService(
      [packageEntry({ approvedBuilds: ['sharp', 'node-pty'] })],
      { profileDir, settings, calls, installRequests },
    )

    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    const result = await service.executeInstall(preview.intent, new AbortController().signal)

    expect(result.receipt.receiptVersion).toBe(2)
    expect(calls.map(args => args[0])).toEqual(['add'])
    // The signed approval list reaches the desktop install boundary exactly
    // as signed; the receipt itself keeps the v2 shape (no approval copy).
    expect(installRequests).toEqual([{ approvedBuildDependencies: ['sharp', 'node-pty'] }])
    expect(result.receipt).not.toHaveProperty('approvedBuildDependencies')
  })

  it('omits approvedBuildDependencies when the signed entry carries no approvedBuilds', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[][] = []
    const installRequests: { approvedBuildDependencies?: readonly string[] }[] = []
    const { service } = await signedService([packageEntry()], {
      profileDir,
      settings,
      calls,
      installRequests,
    })

    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await service.executeInstall(preview.intent, new AbortController().signal)

    expect(installRequests).toEqual([{}])
  })

  it('rejects a registry integrity that disagrees with the signed manifest', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[][] = []
    const { service } = await signedService([packageEntry()], {
      profileDir,
      settings,
      calls,
      verifyIntegrity: otherIntegrity,
    })

    await expect(service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({
        code: 'verification-failed',
        message: expect.stringContaining('signed company manifest pins'),
      })
    expect(calls).toEqual([])
    expect(settings.receipts()).toEqual([])
  })

  it('rejects a revoked signed entry end to end', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[][] = []
    const { service } = await signedService([packageEntry({ revoked: true })], { profileDir, settings, calls })

    await expect(service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({
        code: 'verification-failed',
        message: expect.stringContaining('revoked in the signed company manifest'),
      })
    expect(calls).toEqual([])
    expect(settings.receipts()).toEqual([])
  })

  it('rejects a target absent from the signed manifest end to end', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[][] = []
    const { service } = await signedService([packageEntry({ packageName: 'dsh-plugin-other' })], {
      profileDir,
      settings,
      calls,
    })

    await expect(service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({
        code: 'verification-failed',
        message: expect.stringContaining('is not in the signed company manifest'),
      })
    expect(calls).toEqual([])
  })

  it('rejects installs while the catalog is untrusted or the manifest expired', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[][] = []
    const untrusted = await signedService([packageEntry()], { profileDir, settings, calls })
    untrusted.authority.reportUntrustedCatalog(new CompanyCatalogUntrustedError('stale-sequence', 'rollback observed'))
    await expect(untrusted.service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({
        code: 'verification-failed',
        message: expect.stringContaining('the company catalog is not trusted'),
      })
    await expect(untrusted.service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({ message: expect.stringContaining('rollback observed') })

    const expiredSettings = memoryScope()
    const expired = await signedService([packageEntry()], {
      profileDir,
      settings: expiredSettings,
      calls,
      authority: provider => createSignedManifestInstallTargetAuthority(provider, { now: () => Date.parse('2031-01-01T00:00:00.000Z') }),
    })
    await expect(expired.service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({
        code: 'verification-failed',
        message: expect.stringContaining('expired at 2030-01-01T00:00:00Z'),
      })
    expect(calls).toEqual([])
  })

  it('never lets a stored receipt influence the install decision', async () => {
    const profileDir = await createProfile()
    // A perfectly valid receipt on record for another profile: it must not
    // turn a manifest-absent target into an installable one.
    const settings = memoryScope([{ ...legacyReceipt, profileName: 'staging' }])
    const calls: string[][] = []
    const { service } = await signedService([packageEntry({ packageName: 'dsh-plugin-other' })], {
      profileDir,
      settings,
      calls,
    })

    await expect(service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({
        code: 'verification-failed',
        message: expect.stringContaining('is not in the signed company manifest'),
      })
    expect(calls).toEqual([])
    expect(settings.receipts()).toHaveLength(1)

    // And a receipt for the active profile can only ever block, never allow.
    const blocked = memoryScope([legacyReceipt])
    const blockedService = await signedService([packageEntry({ packageName: 'dsh-plugin-other' })], {
      profileDir,
      settings: blocked,
      calls,
    })
    await expect(blockedService.service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({ code: 'conflict' })
    expect(calls).toEqual([])
  })

  it('reconciles uninstall through a legacy v1 receipt', async () => {
    const profileDir = await createProfile()
    await writeInstalledPlugin(profileDir)
    const settings = memoryScope([legacyReceipt])
    const calls: string[][] = []
    const { service } = await signedService([packageEntry()], { profileDir, settings, calls })

    const preview = await service.previewUninstall(legacyReceipt.receiptId, new AbortController().signal)
    expect(preview).toMatchObject({ action: 'uninstall', packageName, version })
    const removed = await service.executePreview(preview.intent, new AbortController().signal)
    expect(removed).toMatchObject({ action: 'uninstall', receiptId: legacyReceipt.receiptId })
    expect(settings.receipts()).toEqual([])
  })

  it('treats a malformed v2 receipt as an invalid store while v1 stays valid', async () => {
    const profileDir = await createProfile()
    const malformed = {
      ...legacyReceipt,
      receiptVersion: 2,
      manifestSequence: 42,
      keyId,
    }
    const settings = memoryScope([malformed as unknown as MarketInstallReceipt])
    const calls: string[][] = []
    const { service } = await signedService([packageEntry()], { profileDir, settings, calls })

    await expect(service.listReceipts()).rejects.toMatchObject({
      code: 'persistence-failed',
      message: expect.stringContaining('receipt store is invalid'),
    })

    const valid = memoryScope([{ ...legacyReceipt, receiptVersion: 1 }])
    const validService = await signedService([packageEntry()], { profileDir, settings: valid, calls })
    await expect(validService.service.listReceipts()).resolves.toHaveLength(1)
  })

  // End-to-end back-link proof (repo-identity fix): the signed manifest entry
  // carries the package's true VCS repository; the catalog item inherits it,
  // observeCatalog admits the row as an install candidate, and previewInstall's
  // npm registry verifier back-links it against the live metadata — whose raw
  // spelling differs (`git+https://….git`) but normalizes to the same identity.
  describe('signed repository identity back-link', () => {
    const companyRepoUrl = 'https://github.com/omdsh-dev/DSH-better-sidebar'
    const liveNpmRepository = { type: 'git', url: 'git+https://github.com/omdsh-dev/DSH-better-sidebar.git' }
    const companySourceRecordId = '018f1f77-a5c4-7b73-a9ae-0242ac120021'

    function npmMetadata(repository: unknown): unknown {
      return {
        name: packageName,
        version,
        repository,
        scripts: { test: 'vitest' },
        dependencies: { '@deepseek-ai/dsh-agent': '^0.1.1-rc.2' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
        engines: { node: '>=22.19.0' },
        dist: { integrity: signedIntegrity, tarball },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }
    }

    function npmHttp(metadata: unknown): CatalogHttpClient {
      return {
        getJson: vi.fn(async () => ({
          finalUrl: `https://registry.npmjs.org/${packageName}/${version}`,
          value: metadata,
        })),
      }
    }

    async function companyWiredService(entryOverrides: Record<string, unknown>, options: {
      readonly profileDir: string
      readonly calls: string[][]
      readonly npmMetadata?: unknown
    }) {
      const { provider } = await scannedCompanySource([packageEntry({ repository: { url: companyRepoUrl }, ...entryOverrides })])
      const snapshots = await provider.scanCatalog!({}, contentContext())
      const service = new MarketInstallService(
        memoryScope().scope,
        () => ({ name: 'web', dir: options.profileDir }),
        runner(options.profileDir, options.calls),
        createNpmRegistryVerifier(npmHttp(options.npmMetadata ?? npmMetadata(liveNpmRepository))),
        { installTargetAuthority: createSignedManifestInstallTargetAuthority(provider) },
      )
      for (const snapshot of snapshots) service.observeCatalog(snapshot)
      return { service, provider }
    }

    it('admits a signed entry whose repository matches live npm metadata and installs it', async () => {
      const profileDir = await createProfile()
      const calls: string[][] = []
      const { service } = await companyWiredService({}, { profileDir, calls })

      const preview = await service.previewInstall(companySourceRecordId, `npm:${packageName}@${version}`, new AbortController().signal)
      expect(preview).toMatchObject({ action: 'install', packageName, version })

      const result = await service.executeInstall(preview.intent, new AbortController().signal)
      expect(calls.map(args => args[0])).toEqual(['add'])
      expect(result.receipt).toMatchObject({ packageName, version, integrity: signedIntegrity })
    })

    it('fails preview when the npm metadata points at a different repository', async () => {
      const profileDir = await createProfile()
      const calls: string[][] = []
      const { service } = await companyWiredService({}, {
        profileDir,
        calls,
        npmMetadata: npmMetadata({ ...liveNpmRepository, url: 'git+https://github.com/attacker/mirror.git' }),
      })

      await expect(service.previewInstall(companySourceRecordId, `npm:${packageName}@${version}`, new AbortController().signal))
        .rejects.toMatchObject({ code: 'verification-failed', message: 'The npm package repository did not match the catalog.' })
      expect(calls).toEqual([])
    })
  })
})
