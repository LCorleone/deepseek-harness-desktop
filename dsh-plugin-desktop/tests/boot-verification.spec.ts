import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  verifyCompanyManifest,
} from 'dsh-community-market'
import type { DesktopCompanyManifestPackage } from '../src/desktop-market.ts'
import { pendingDesktopBootClientUpdates, pendingDesktopBootPluginUpdates } from '../src/boot-update-prompt.ts'
import { desktopMarketTarballStagingPath } from '../src/pnpm.js'
import {
  BOOT_TREE_MAX_PATH_LENGTH,
  createCachedDesktopBootTreeRootDigestMeasure,
  collectDesktopBootBundles,
  companyManifestAssetPath,
  computeDesktopBootTreeRootDigest,
  DESKTOP_BOOT_DSH_RUNTIME_VERSION,
  desktopBootBundleNames,
  desktopBootControlledTarballPinProblem,
  desktopBootLockIntegrity,
  desktopBootReceipts,
  desktopBootTreeStatFingerprint,
  desktopBootVerificationInputs,
  desktopBootVerificationInputsFromSettings,
  DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME,
  marketInstallReceiptsFromSettingsDocument,
  marketManifestSequenceRatchetFromSettings,
  readCompanyManifestAsset,
  readDesktopBootLockfile,
  readDesktopBootReceiptsFromSettings,
  verifyDesktopBootBundles,
  type DesktopBootBundle,
  type DesktopBootReceipt,
  type DesktopBootRejectionCode,
  type DesktopBootRejectedBundle,
  type DesktopBootTreeMeasurePurpose,
} from '../src/boot-verification.ts'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustRoots = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const packageName = 'dsh-plugin-safe'
const version = '1.2.3'
const signedIntegrity = `sha512-${Buffer.alloc(64, 9).toString('base64')}`
const otherIntegrity = `sha512-${Buffer.alloc(64, 3).toString('base64')}`
const manifestSequence = 21
const temporaryDirectories: string[] = []
const sha256hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-boot-verification-'))
  temporaryDirectories.push(dir)
  return dir
}

function packageEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName,
    version,
    integrity: signedIntegrity,
    bundlePatch: './cordis.patch.yml',
    repository: { url: 'https://github.com/example/dsh-plugin-safe' },
    revoked: false,
    runtime: { dshRuntimeVersion: '*' },
    ...overrides,
  }
}

function signedManifestText(
  packages: readonly Record<string, unknown>[],
  options: { sequence?: number; expiresAt?: string } = {},
): string {
  const unsigned = {
    manifestVersion: '1.0.0',
    sequence: options.sequence ?? manifestSequence,
    expiresAt: options.expiresAt ?? '2030-01-01T00:00:00Z',
    packages,
  }
  const signature = createCompanyManifestSignature(
    unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    privateKey,
    keyId,
  )
  return canonicalJsonText({ ...unsigned, signature })
}

/** Write one installed package tree and return its directory. */
function installedPackage(files: Record<string, string>): string {
  const dir = join(temporaryDirectory(), 'node_modules', packageName)
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}

const defaultFiles: Record<string, string> = {
  'package.json': `{"name":"${packageName}","version":"${version}"}\n`,
  'cordis.patch.yml': '- insert:\n    - id: safe-marker\n      name: dsh-plugin-safe\n',
  'lib/payload.js': 'export const marker = 1\n',
}

function bundleInput(overrides: Partial<DesktopBootBundle> = {}): DesktopBootBundle {
  return {
    packageName,
    version,
    lockIntegrity: signedIntegrity,
    packageDir: installedPackage(defaultFiles),
    ...overrides,
  }
}

function receiptFor(bundle: DesktopBootBundle, overrides: Partial<DesktopBootReceipt> = {}): DesktopBootReceipt {
  return {
    packageName: bundle.packageName,
    version: bundle.version!,
    manifestSequence,
    keyId,
    rootDigest: computeDesktopBootTreeRootDigest(bundle.packageDir!),
    ...overrides,
  }
}

/** Full market receipt v2 record as the settings document stores it. */
function marketV2Receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptId: 'receipt:boot-verification-0001',
    profileName: 'desktop',
    packageName,
    version,
    integrity: signedIntegrity,
    bundlePatch: './cordis.patch.yml',
    sourceRecordId: 'company-catalog',
    providerId: 'com.deepseek.company-catalog',
    itemId: `npm:${packageName}@${version}`,
    displayName: packageName,
    installedAt: '2026-09-01T00:00:00.000Z',
    receiptVersion: 2,
    manifestSequence,
    keyId,
    treeDigest: { algorithm: 'sha256', files: [], rootDigest: 'ab'.repeat(32) },
    resolved: { registryIntegrity: signedIntegrity, treeRootDigest: 'ab'.repeat(32) },
    decided: { allowedBy: 'signed-company-manifest' },
    ...overrides,
  }
}

const verify = (
  manifestBytes: string | undefined,
  bundles: readonly DesktopBootBundle[],
  options: {
    receipts?: readonly DesktopBootReceipt[]
    lastSeenSequence?: number
    now?: () => number
    companyCatalogOrigin?: string | null
    measureTreeRootDigest?: (packageDir: string, purpose: DesktopBootTreeMeasurePurpose) => string
    betaPackages?: readonly DesktopCompanyManifestPackage[]
    betaSequence?: number
    dshRuntimeVersion?: string
  } = {},
) => verifyDesktopBootBundles(manifestBytes, bundles, { trustRoots, ...options })

describe('desktop boot tree digest', () => {
  it('matches the documented serialization over files, symlinks, and nested directories', () => {
    const dir = installedPackage({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'a.txt': 'hello\n',
      'nested/b.js': 'payload\n',
      'nested/empty/.keep': '',
    })
    symlinkSync('./a.txt', join(dir, 'link'))

    const digest = computeDesktopBootTreeRootDigest(dir)
    // Independent re-derivation from the published rules: sorted relative
    // POSIX paths, file bytes hashed, symlink target text hashed.
    const entries: [string, string][] = [
      ['a.txt', sha256hex('hello\n')],
      ['link', sha256hex('./a.txt')],
      ['nested/b.js', sha256hex('payload\n')],
      ['nested/empty/.keep', sha256hex('')],
      ['package.json', sha256hex('{"name":"x","version":"1.0.0"}\n')],
    ]
    const records = entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    const root = createHash('sha256')
    for (const [path, fileDigest] of records) root.update(`sha256:${path}\n${fileDigest}\n`, 'utf8')
    expect(digest).toBe(root.digest('hex'))
  })

  it('is independent of file creation order and ignores empty directories', () => {
    const first = installedPackage({ 'z.txt': 'z', 'a/m.txt': 'm' })
    const secondRoot = temporaryDirectory()
    const second = join(secondRoot, 'node_modules', packageName)
    mkdirSync(join(second, 'ignored-empty-dir'), { recursive: true })
    mkdirSync(join(second, 'a'), { recursive: true })
    writeFileSync(join(second, 'z.txt'), 'z')
    writeFileSync(join(second, 'a', 'm.txt'), 'm')
    expect(computeDesktopBootTreeRootDigest(first)).toBe(computeDesktopBootTreeRootDigest(second))
  })

  it('rejects paths beyond the documented length limit', () => {
    const dir = temporaryDirectory()
    let path = dir
    let length = 0
    while (length <= BOOT_TREE_MAX_PATH_LENGTH) {
      const segment = 'd'.repeat(64)
      path = join(path, segment)
      length += segment.length + 1
    }
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'f.txt'), 'x')
    expect(() => computeDesktopBootTreeRootDigest(dir)).toThrow('path length limit')
  })

  it.skipIf(process.platform === 'win32')('rejects foreign entry types instead of skipping them', () => {
    const dir = temporaryDirectory()
    expect(spawnSync('mkfifo', [join(dir, 'pipe')]).status).toBe(0)
    expect(() => computeDesktopBootTreeRootDigest(dir)).toThrow(
      'is not a file, directory, or symbolic link',
    )
  })
})

describe('desktop boot bundle verification', () => {
  it('allows a fully verified bundle with receipt evidence', () => {
    const bundle = bundleInput()
    const result = verify(signedManifestText([packageEntry()]), [bundle], { receipts: [receiptFor(bundle)] })
    expect(result).toEqual({
      manifestTrusted: true,
      manifestSequence,
      keyId,
      manifestFailure: undefined,
      allowed: [{ packageName, evidence: 'receipt', manifestSequence, keyId }],
      rejected: [],
    })
  })

  it('degrades to manifest-only evidence without a usable receipt', () => {
    const result = verify(signedManifestText([packageEntry()]), [bundleInput()])
    expect(result.allowed).toEqual([{ packageName, evidence: 'manifest-only', manifestSequence, keyId }])
    expect(result.rejected).toEqual([])
  })

  it('ignores legacy and malformed receipts and falls back to manifest-only', () => {
    const bundle = bundleInput()
    const legacy = { ...receiptFor(bundle), manifestSequence: 1, keyId: '', rootDigest: 'not-hex' }
    const v1 = desktopBootReceipts([{
      receiptId: 'r'.repeat(16),
      profileName: 'desktop',
      packageName,
      version,
      integrity: signedIntegrity,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'company-catalog',
      providerId: 'com.deepseek.company-catalog',
      itemId: `npm:${packageName}@${version}`,
      displayName: packageName,
      installedAt: '2026-09-01T00:00:00.000Z',
    }])
    expect(v1).toEqual([])
    const result = verify(signedManifestText([packageEntry()]), [bundle], { receipts: [legacy] })
    expect(result.allowed.map(entry => entry.evidence)).toEqual(['manifest-only'])
  })

  it('normalizes market receipt v2 records into boot evidence', () => {
    const bundle = bundleInput()
    const rootDigest = computeDesktopBootTreeRootDigest(bundle.packageDir!)
    const receipts = desktopBootReceipts([{
      receiptId: 'r'.repeat(16),
      profileName: 'desktop',
      packageName,
      version,
      integrity: signedIntegrity,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'company-catalog',
      providerId: 'com.deepseek.company-catalog',
      itemId: `npm:${packageName}@${version}`,
      displayName: packageName,
      installedAt: '2026-09-01T00:00:00.000Z',
      receiptVersion: 2,
      manifestSequence,
      keyId,
      treeDigest: { algorithm: 'sha256', files: [], rootDigest },
      resolved: { registryIntegrity: signedIntegrity, treeRootDigest: rootDigest },
      decided: { allowedBy: 'signed-company-manifest' },
    }])
    expect(receipts).toEqual([{ packageName, version, manifestSequence, keyId, rootDigest }])
    const result = verify(signedManifestText([packageEntry()]), [bundle], { receipts })
    expect(result.allowed.map(entry => entry.evidence)).toEqual(['receipt'])
  })

  it('skips malformed v2 receipts instead of throwing, degrading only their bundles', () => {
    const bundle = bundleInput()
    const peer = bundleInput({ packageName: 'peer-plugin' })
    // Each malformed shape previously reached `treeDigest.rootDigest` (or a
    // bogus sequence floor) directly and threw a TypeError through profile
    // composition; the normalizer must skip them like legacy receipts.
    const malformedRecords: unknown[] = [
      marketV2Receipt({ receiptId: 'missing-tree-digest', treeDigest: undefined }),
      marketV2Receipt({ receiptId: 'tree-digest-not-object', treeDigest: 'sha256' }),
      marketV2Receipt({ receiptId: 'root-digest-not-hex', treeDigest: { algorithm: 'sha256', files: [], rootDigest: 'zz' } }),
      marketV2Receipt({ receiptId: 'sequence-not-number', manifestSequence: 'twenty-one' }),
      marketV2Receipt({ receiptId: 'sequence-below-one', manifestSequence: 0 }),
      marketV2Receipt({ receiptId: 'blank-key-id', keyId: '' }),
      marketV2Receipt({ receiptId: 'version-not-string', version: 123 }),
      'not-a-record',
    ]
    const asReceipts = (value: readonly unknown[]): Parameters<typeof desktopBootReceipts>[0] =>
      value as Parameters<typeof desktopBootReceipts>[0]
    expect(() => desktopBootReceipts(asReceipts(malformedRecords))).not.toThrow()
    expect(desktopBootReceipts(asReceipts(malformedRecords))).toEqual([])

    // A usable peer receipt survives the same store untouched: its bundle
    // keeps receipt evidence while the malformed one degrades to manifest-only.
    const peerRaw = marketV2Receipt({
      packageName: peer.packageName,
      itemId: `npm:${peer.packageName}@${version}`,
      treeDigest: { algorithm: 'sha256', files: [], rootDigest: computeDesktopBootTreeRootDigest(peer.packageDir!) },
    })
    const evidence = desktopBootReceipts(asReceipts([...malformedRecords, peerRaw]))
    expect(evidence).toEqual([receiptFor(peer)])
    const result = verify(
      signedManifestText([packageEntry(), packageEntry({ packageName: peer.packageName })]),
      [bundle, peer],
      { receipts: evidence },
    )
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([
      { packageName, evidence: 'manifest-only', manifestSequence, keyId },
      { packageName: peer.packageName, evidence: 'receipt', manifestSequence, keyId },
    ])
  })

  it('rejects a bundle whose installed files differ from the receipt tree', () => {
    const bundle = bundleInput()
    const forged = receiptFor(bundle, { rootDigest: 'ab'.repeat(32) })
    const result = verify(signedManifestText([packageEntry()]), [bundle], { receipts: [forged] })
    expect(result.allowed).toEqual([])
    expect(result.rejected).toEqual([{
      packageName,
      reason: `the installed files of ${packageName}@${version} differ from the tree recorded in its install receipt`,
      code: 'tree-mismatch',
    }])
  })

  it('rejects a bundle whose tree cannot be measured', () => {
    const bundle = bundleInput({ packageDir: join(temporaryDirectory(), 'missing') })
    const result = verify(signedManifestText([packageEntry()]), [bundle], {
      receipts: [receiptFor({ ...bundle, packageDir: installedPackage(defaultFiles) })],
    })
    expect(result.rejected[0]?.reason).toContain('could not be measured')
    // Measurement failures carry no explicit classification — the fallback.
    expect(result.rejected[0]?.code).toBe('other')
  })

  it('rejects absent, misversioned, and revoked manifest entries', () => {
    const absent = verify(signedManifestText([]), [bundleInput()])
    expect(absent.rejected[0]?.reason).toBe(`${packageName}@${version} is not in the signed company manifest`)
    expect(absent.rejected[0]?.code).toBe('not-in-manifest')

    const otherVersion = verify(signedManifestText([packageEntry({ version: '2.0.0' })]), [bundleInput()])
    expect(otherVersion.rejected[0]?.reason).toBe(
      `the signed company manifest pins ${packageName}@2.0.0, but ${version} is installed`,
    )
    expect(otherVersion.rejected[0]?.code).toBe('not-pinned-newer-pinned')
    expect(otherVersion.rejected[0]).toMatchObject({ installedVersion: version, pinnedVersion: '2.0.0' })

    const revoked = verify(signedManifestText([packageEntry({ revoked: true })]), [bundleInput()])
    expect(revoked.rejected[0]?.reason).toBe(`${packageName}@${version} is revoked in the signed company manifest`)
    expect(revoked.rejected[0]?.code).toBe('revoked')
  })

  it('rejects unresolvable bundles and missing or diverging lock integrity', () => {
    const unresolvable = verify(signedManifestText([packageEntry()]), [bundleInput({ packageDir: undefined, version: undefined })])
    expect(unresolvable.rejected[0]?.reason).toContain('cannot be resolved as an installed package')
    expect(unresolvable.rejected[0]?.code).toBe('unresolved')

    const unpinned = verify(signedManifestText([packageEntry()]), [bundleInput({ lockIntegrity: undefined })])
    expect(unpinned.rejected[0]?.reason).toContain('no exact pinned record in the profile lockfile')
    expect(unpinned.rejected[0]?.code).toBe('no-lock-integrity')

    const diverging = verify(signedManifestText([packageEntry()]), [bundleInput({ lockIntegrity: otherIntegrity })])
    expect(diverging.rejected[0]?.reason).toBe(
      `the profile lockfile pins ${packageName}@${version} to integrity ${otherIntegrity}, but the signed company manifest pins ${signedIntegrity}`,
    )
    expect(diverging.rejected[0]?.code).toBe('integrity-mismatch')
  })

  it('rejects every bundle when the manifest is missing, expired, or badly signed', () => {
    const bundles = [bundleInput(), bundleInput({ packageName: 'second-plugin' })]
    const missing = verify(undefined, bundles)
    expect(missing).toEqual({
      manifestTrusted: false,
      manifestSequence: undefined,
      keyId: undefined,
      manifestFailure: {
        code: 'manifest-missing',
        reason: 'no signed company manifest bytes are available for this boot',
      },
      allowed: [],
      rejected: [
        { packageName, reason: expect.stringContaining('manifest-missing'), code: 'other' },
        { packageName: 'second-plugin', reason: expect.stringContaining('manifest-missing'), code: 'other' },
      ],
    })

    const expired = verify(signedManifestText([packageEntry()], { expiresAt: '2020-01-01T00:00:00Z' }), bundles)
    expect(expired.manifestFailure?.code).toBe('expired')
    expect(expired.rejected).toHaveLength(2)

    const tamperedText = signedManifestText([packageEntry()]).replace(/"value":"[^"]{20}/u, '"value":"AAAA')
    const tampered = verify(tamperedText, bundles)
    expect(['bad-signature', 'non-canonical', 'malformed-json', 'invalid-manifest'])
      .toContain(tampered.manifestFailure?.code)
    expect(tampered.manifestTrusted).toBe(false)
    expect(tampered.rejected).toHaveLength(2)
  })

  it('re-verifies the same manifest sequence as the receipts but rejects older manifests', () => {
    const bundle = bundleInput()
    const same = verify(signedManifestText([packageEntry()]), [bundle], {
      receipts: [receiptFor(bundle, { manifestSequence })],
    })
    expect(same.manifestTrusted).toBe(true)

    const older = verify(signedManifestText([packageEntry()], { sequence: manifestSequence - 1 }), [bundle], {
      receipts: [receiptFor(bundle, { manifestSequence })],
    })
    expect(older.manifestFailure?.code).toBe('stale-sequence')
    expect(older.rejected.map(entry => entry.packageName)).toEqual([packageName])
  })

  it('honors an injected sequence floor and clock', () => {
    const bundle = bundleInput()
    // The floor is a lower bound: replaying the same sequence re-verifies,
    // only a strictly higher floor regresses the manifest into stale.
    const replayed = verify(signedManifestText([packageEntry()]), [bundle], { lastSeenSequence: manifestSequence })
    expect(replayed.manifestTrusted).toBe(true)
    const floored = verify(signedManifestText([packageEntry()]), [bundle], { lastSeenSequence: manifestSequence + 1 })
    expect(floored.manifestFailure?.code).toBe('stale-sequence')

    const expiredAtFixedClock = verify(
      signedManifestText([packageEntry()], { expiresAt: '2030-01-01T00:00:00Z' }),
      [bundle],
      { now: () => Date.parse('2031-01-01T00:00:00.000Z') },
    )
    expect(expiredAtFixedClock.manifestFailure?.code).toBe('expired')
  })

  it('decides each duplicate bundle name once and skips blank names', () => {
    const bundle = bundleInput()
    const blank: DesktopBootBundle = { packageName: '', version: undefined, lockIntegrity: undefined, packageDir: undefined }
    const result = verify(signedManifestText([packageEntry()]), [bundle, bundle, blank])
    expect(result.allowed).toHaveLength(1)
    expect(result.rejected).toEqual([])
  })

  it('fails closed with empty trust roots', () => {
    const result = verifyDesktopBootBundles(signedManifestText([packageEntry()]), [bundleInput()], {
      trustRoots: [],
    })
    expect(result.manifestFailure?.code).toBe('unknown-key')
    expect(result.rejected).toHaveLength(1)
  })

  it('classifies a beta overlay re-pin as update-available against the beta pin (P10 a-class beta fallback)', () => {
    // A tester's stale beta install while the admitted beta manifest already
    // re-pins: the rejection must carry the a-class code with the beta pin
    // as the update target — the pinned lookup runs beta-first.
    const staleBeta = '0.9.0'
    const betaPinned = '0.9.1'
    const result = verify(
      signedManifestText([]),
      [bundleInput({ version: staleBeta })],
      {
        betaPackages: [packageEntry({ version: betaPinned }) as unknown as DesktopCompanyManifestPackage],
        betaSequence: manifestSequence,
      },
    )
    expect(result.rejected[0]?.code).toBe('not-pinned-newer-pinned')
    expect(result.rejected[0]).toMatchObject({ installedVersion: staleBeta, pinnedVersion: betaPinned })
    expect(result.rejected[0]?.reason).toBe(
      `the signed company manifest pins ${packageName}@${betaPinned}, but ${staleBeta} is installed`,
    )

    // Without the overlay the same install is simply absent from the
    // manifest — never update-available (non-roster machines never see beta
    // content, so their classification stays not-in-manifest).
    const stableOnly = verify(signedManifestText([]), [bundleInput({ version: staleBeta })])
    expect(stableOnly.rejected[0]?.code).toBe('not-in-manifest')
  })

  it('guarantees classification completeness: the code vocabulary is closed and unclassified branches fall back to other', () => {
    // The union admits exactly the P10 classification vocabulary; the cast
    // fails to compile the moment a code leaves or joins it.
    const vocabulary = [
      'not-pinned-newer-pinned',
      'not-in-manifest',
      'revoked',
      'integrity-mismatch',
      'tree-mismatch',
      'unresolved',
      'no-lock-integrity',
      'client-update-required',
      'other',
    ] as const satisfies readonly DesktopBootRejectionCode[]
    expect(vocabulary).toContain('other')

    // Every already-covered rejection branch lands inside the vocabulary
    // with a defined code (the per-branch assertions above pin the exact
    // values); the branch that passes no classification at all — the
    // measurement failure stands in for any future branch — still produces
    // the total fallback instead of undefined.
    const branches = [
      verify(signedManifestText([packageEntry()]), [bundleInput({ packageDir: undefined, version: undefined })]),
      verify(signedManifestText([]), [bundleInput()]),
      verify(signedManifestText([packageEntry({ version: '2.0.0' })]), [bundleInput()]),
      verify(signedManifestText([packageEntry({ revoked: true })]), [bundleInput()]),
      verify(signedManifestText([packageEntry()]), [bundleInput({ lockIntegrity: undefined })]),
      verify(signedManifestText([packageEntry()]), [bundleInput({ lockIntegrity: otherIntegrity })]),
      verify(signedManifestText([packageEntry({ treeDigest: 'ab'.repeat(32) })]), [bundleInput()], {
        measureTreeRootDigest: () => 'cd'.repeat(32),
      }),
      verify(undefined, [bundleInput()]),
    ]
    const seen = new Set<DesktopBootRejectionCode>()
    for (const decision of branches) {
      expect(decision.rejected.length).toBeGreaterThan(0)
      for (const rejected of decision.rejected as readonly DesktopBootRejectedBundle[]) {
        expect(typeof rejected.code).toBe('string')
        expect(vocabulary).toContain(rejected.code)
        seen.add(rejected.code)
      }
    }
    // Both fallback producers are present: the manifest-level rejection and
    // the unclassified measurement failure.
    expect(seen.has('other')).toBe(true)
  })
})

describe('runtime-aware update classification (P15 phase 1)', () => {
  // The catalog compatibility window: same package pinned at several
  // versions, each entry carrying its own dshRuntimeVersion range. The
  // acceptance matrix from the P15 card, one machine runtime per row.
  const oldRuntime = '0.1.1'
  const newRuntime = '0.1.2'
  const oldLine = '^0.1.1'
  const newLine = '^0.1.2'
  const nextLine = '^0.1.3'
  const sidebar = 'dsh-better-sidebar'

  const windowEntry = (version: string, range: string, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
    packageEntry({ packageName: sidebar, version, runtime: { dshRuntimeVersion: range }, ...overrides })

  const windowBundle = (version: string, overrides: Partial<DesktopBootBundle> = {}): DesktopBootBundle =>
    bundleInput({ packageName: sidebar, version, ...overrides })

  it('row 1: an old-runtime machine loads its exact pin from the window with no update offer', () => {
    const result = verify(
      signedManifestText([windowEntry('0.15.2', oldLine), windowEntry('0.18.1', newLine)]),
      [windowBundle('0.15.2')],
      { dshRuntimeVersion: oldRuntime },
    )
    expect(result.rejected).toEqual([])
    expect(result.deferredUpdates).toBeUndefined()
    // Loaded with the plain allow shape — no update target for a machine
    // whose runtime the newer line does not accept.
    expect(result.allowed).toEqual([{ packageName: sidebar, evidence: 'manifest-only', manifestSequence, keyId }])
    expect(pendingDesktopBootPluginUpdates(result)).toEqual([])
    expect(pendingDesktopBootClientUpdates(result)).toEqual([])
  })

  it('row 2: a new-runtime machine loads the same install and is offered the newest compatible pin', () => {
    const result = verify(
      signedManifestText([
        windowEntry('0.15.2', oldLine),
        // A mid-window pin for the same line: the target must be the newest
        // compatible entry, not the first same-name one.
        windowEntry('0.16.0', newLine),
        windowEntry('0.18.1', newLine),
      ]),
      [windowBundle('0.15.2')],
      { dshRuntimeVersion: newRuntime },
    )
    expect(result.rejected).toEqual([])
    expect(result.deferredUpdates).toBeUndefined()
    expect(result.allowed).toEqual([{
      packageName: sidebar,
      evidence: 'manifest-only',
      manifestSequence,
      keyId,
      updateVersion: '0.18.1',
      installedVersion: '0.15.2',
    }])
    // The P10 prompt consumes the allowed-bundle update slice exactly like
    // a class-a rejection: the user action is the same (open the market).
    expect(pendingDesktopBootPluginUpdates(result)).toEqual([
      { packageName: sidebar, installedVersion: '0.15.2', pinnedVersion: '0.18.1' },
    ])
    expect(pendingDesktopBootClientUpdates(result)).toEqual([])
  })

  it('row 3: the newest pin already installed stays quiet', () => {
    const result = verify(
      signedManifestText([windowEntry('0.15.2', oldLine), windowEntry('0.18.1', newLine)]),
      [windowBundle('0.18.1')],
      { dshRuntimeVersion: newRuntime },
    )
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([{ packageName: sidebar, evidence: 'manifest-only', manifestSequence, keyId }])
    expect(pendingDesktopBootPluginUpdates(result)).toEqual([])
  })

  it('row 4: a retired install with only other-runtime pins left defers onto its receipt (client-update-required)', () => {
    const bundle = windowBundle('0.18.1')
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const result = verify(
      signedManifestText([windowEntry('0.19.0', nextLine)]),
      [bundle],
      { dshRuntimeVersion: newRuntime, receipts: [receiptFor(bundle)], measureTreeRootDigest: measure },
    )
    // Not refused: the bundle loads on receipt evidence — the exact
    // receipt-anchored comparison of step 4, proven here by the purpose the
    // measurement was requested with.
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([{ packageName: sidebar, evidence: 'receipt', manifestSequence, keyId }])
    expect(measure).toHaveBeenCalledWith(bundle.packageDir, 'receipt')
    // The deferral facts ride their own slice: package, waiting version,
    // required runtime.
    expect(result.deferredUpdates).toEqual([{
      packageName: sidebar,
      installedVersion: '0.18.1',
      availableVersion: '0.19.0',
      requiredRuntime: nextLine,
    }])
    // The deferral is never an update offer for this machine — its own
    // notification carries the client-upgrade copy instead.
    expect(pendingDesktopBootPluginUpdates(result)).toEqual([])
    expect(pendingDesktopBootClientUpdates(result)).toEqual([{
      packageName: sidebar,
      installedVersion: '0.18.1',
      availableVersion: '0.19.0',
      requiredRuntime: nextLine,
    }])
  })

  it('row 4 (the P12 rescue, core): an old machine never bricks when the catalog moves to a newer runtime line', () => {
    // The pre-P15 behavior for this exact fleet state: class-a rejection,
    // plugin bricked until the client upgrade AND a manual reinstall. The
    // runtime filter is what separates the deferred branch from class a —
    // removing it turns this decision back into the brick (red).
    const bundle = windowBundle('0.15.2')
    const result = verify(
      signedManifestText([windowEntry('0.18.1', newLine)]),
      [bundle],
      { dshRuntimeVersion: oldRuntime, receipts: [receiptFor(bundle)] },
    )
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([{ packageName: sidebar, evidence: 'receipt', manifestSequence, keyId }])
    expect(result.deferredUpdates).toEqual([{
      packageName: sidebar,
      installedVersion: '0.15.2',
      availableVersion: '0.18.1',
      requiredRuntime: newLine,
    }])
  })

  it('a deferred-eligible install without a usable receipt fails closed as client-update-required', () => {
    const result = verify(
      signedManifestText([windowEntry('0.19.0', nextLine)]),
      [windowBundle('0.18.1')],
      { dshRuntimeVersion: newRuntime },
    )
    expect(result.allowed).toEqual([])
    expect(result.deferredUpdates).toBeUndefined()
    expect(result.rejected).toEqual([{
      packageName: sidebar,
      reason: expect.stringContaining('no install receipt exists to load the installed version — upgrade the desktop client') as unknown as string,
      code: 'client-update-required',
      installedVersion: '0.18.1',
      pinnedVersion: '0.19.0',
    }])
    expect(result.rejected[0]?.reason).toContain('requires dsh runtime ^0.1.3')
    // The client-update-required rejection is log-only, never an update offer.
    expect(pendingDesktopBootPluginUpdates(result)).toEqual([])
    expect(pendingDesktopBootClientUpdates(result)).toEqual([])
  })

  it('a tampered tree is refused by the deferred receipt comparison (P12: 回执摘要拒载)', () => {
    const bundle = windowBundle('0.18.1')
    const forged = receiptFor(bundle, { rootDigest: 'ab'.repeat(32) })
    const result = verify(
      signedManifestText([windowEntry('0.19.0', nextLine)]),
      [bundle],
      { dshRuntimeVersion: newRuntime, receipts: [forged] },
    )
    expect(result.allowed).toEqual([])
    expect(result.deferredUpdates).toBeUndefined()
    expect(result.rejected).toEqual([{
      packageName: sidebar,
      reason: `the installed files of ${sidebar}@0.18.1 differ from the tree recorded in its install receipt`,
      code: 'tree-mismatch',
    }])
  })

  it('a revoked same-name pin kills the deferral — security is never forgiven (matrix: revoked 照拒)', () => {
    const bundle = windowBundle('0.18.1')
    const result = verify(
      signedManifestText([windowEntry('0.19.0', nextLine, { revoked: true })]),
      [bundle],
      { dshRuntimeVersion: newRuntime, receipts: [receiptFor(bundle)] },
    )
    expect(result.allowed).toEqual([])
    expect(result.deferredUpdates).toBeUndefined()
    expect(result.rejected[0]?.code).toBe('revoked')
    expect(result.rejected[0]?.reason).toContain('revoked in the signed company manifest')
  })

  it('a revoked newer pin is never the advertised update target (phase 1 review: 不宣传已 retire 的版本)', () => {
    // The installed 0.15.2 is still pinned and live; the same-name 0.18.1
    // was retired by version (`revoked: true`) on a runtime line this
    // machine accepts. Without the `!candidate.revoked` filter the retired
    // pin becomes the update target — a P10 prompt pointing at the one
    // version the market install gate must refuse, dead-looping the user
    // (red without the filter; Phase 0 version-keyed retire made this a
    // real catalog shape).
    const result = verify(
      signedManifestText([
        windowEntry('0.15.2', newLine),
        windowEntry('0.18.1', newLine, { revoked: true }),
      ]),
      [windowBundle('0.15.2')],
      { dshRuntimeVersion: newRuntime },
    )
    expect(result.rejected).toEqual([])
    expect(result.deferredUpdates).toBeUndefined()
    // Loads with the plain allow shape — no update offer may name 0.18.1.
    expect(result.allowed).toEqual([{ packageName: sidebar, evidence: 'manifest-only', manifestSequence, keyId }])
    expect(pendingDesktopBootPluginUpdates(result)).toEqual([])
    expect(pendingDesktopBootClientUpdates(result)).toEqual([])

    // Control (regression): the same window with 0.18.1 alive keeps
    // advertising it — the retire filter must not mute live pins.
    const alive = verify(
      signedManifestText([windowEntry('0.15.2', newLine), windowEntry('0.18.1', newLine)]),
      [windowBundle('0.15.2')],
      { dshRuntimeVersion: newRuntime },
    )
    expect(alive.rejected).toEqual([])
    expect(alive.allowed[0]?.updateVersion).toBe('0.18.1')
    expect(pendingDesktopBootPluginUpdates(alive)).toEqual([
      { packageName: sidebar, installedVersion: '0.15.2', pinnedVersion: '0.18.1' },
    ])
  })

  it('class-a targets the newest runtime-compatible pin once the installed version is retired (目标选对)', () => {
    // Installed 0.15.2 is gone from the manifest; 0.20.0 is the newest
    // same-name pin but needs ^0.1.3, so a 0.1.2 machine must be pointed at
    // 0.18.1 — not at 0.20.0, and not at the first (lowest) entry either.
    const result = verify(
      signedManifestText([windowEntry('0.18.1', newLine), windowEntry('0.20.0', nextLine)]),
      [windowBundle('0.15.2')],
      { dshRuntimeVersion: newRuntime },
    )
    expect(result.rejected).toEqual([{
      packageName: sidebar,
      reason: `the signed company manifest pins ${sidebar}@0.18.1, but 0.15.2 is installed`,
      code: 'not-pinned-newer-pinned',
      installedVersion: '0.15.2',
      pinnedVersion: '0.18.1',
    }])
    expect(pendingDesktopBootPluginUpdates(result)).toEqual([
      { packageName: sidebar, installedVersion: '0.15.2', pinnedVersion: '0.18.1' },
    ])
  })

  it('the classification runtime defaults to the build-pinned DSH runtime version', () => {
    // No injected machine: the default must be DESKTOP_BOOT_DSH_RUNTIME_VERSION
    // ('0.1.2-rc.1' at the time of writing) — the same value the market
    // install gate compares against. The equality pin keeps a runtime bump
    // from silently shifting these fixtures; update it with the bump.
    expect(DESKTOP_BOOT_DSH_RUNTIME_VERSION).toBe('0.1.2-rc.1')
    // ^0.1.2-rc.1 accepts it only with the install gate's includePrerelease
    // semantics; ^0.1.1 accepts it plainly.
    const result = verify(
      signedManifestText([windowEntry('0.15.2', oldLine), windowEntry('0.18.1', '^0.1.2-rc.1')]),
      [windowBundle('0.15.2')],
    )
    expect(result.allowed[0]?.updateVersion).toBe('0.18.1')
    expect(result.deferredUpdates).toBeUndefined()
    // And a pin requiring a runtime newer than the build's stays deferred
    // territory even at the default runtime: the newest pin is ^0.1.3, the
    // older line still pins the installed version, so this simply loads.
    const retired = verify(
      signedManifestText([windowEntry('0.15.2', oldLine), windowEntry('0.19.0', nextLine)]),
      [windowBundle('0.15.2')],
    )
    expect(retired.rejected).toEqual([])
    expect(retired.allowed[0]?.updateVersion).toBeUndefined()
    expect(retired.deferredUpdates).toBeUndefined()
  })

  it('row 7 (regression): single-pin production manifests decide exactly as before', () => {
    // Today's catalog form: one entry per package, ranges the build's
    // runtime satisfies ('*' and the production '^0.1.1-rc.2' spelling).
    const wildcard = verify(signedManifestText([packageEntry()]), [bundleInput()], { dshRuntimeVersion: oldRuntime })
    expect(wildcard.allowed).toEqual([{ packageName, evidence: 'manifest-only', manifestSequence, keyId }])
    expect(wildcard.deferredUpdates).toBeUndefined()

    const productionRange = verify(
      signedManifestText([packageEntry({ runtime: { dshRuntimeVersion: '^0.1.1-rc.2' } })]),
      [bundleInput()],
    )
    expect(productionRange.rejected).toEqual([])
    expect(productionRange.allowed[0]?.updateVersion).toBeUndefined()

    // The hard cutover keeps its class-a classification and prompt target.
    const rePinned = verify(
      signedManifestText([packageEntry({ version: '2.0.0', runtime: { dshRuntimeVersion: '^0.1.1-rc.2' } })]),
      [bundleInput()],
    )
    expect(rePinned.allowed).toEqual([])
    expect(rePinned.rejected[0]).toMatchObject({
      code: 'not-pinned-newer-pinned',
      installedVersion: version,
      pinnedVersion: '2.0.0',
    })
    expect(pendingDesktopBootPluginUpdates(rePinned)).toEqual([
      { packageName, installedVersion: version, pinnedVersion: '2.0.0' },
    ])
  })

  it('collects classification candidates beta-first by package name (the overlay replaces the name)', () => {
    // The overlay carries the name with a compatible newer pin: the update
    // target is the beta pin, even though stable pins the same name too.
    const betaTarget = verify(
      signedManifestText([windowEntry('0.15.2', oldLine)]),
      [windowBundle('0.15.2')],
      {
        dshRuntimeVersion: oldRuntime,
        betaPackages: [windowEntry('0.18.1', oldLine) as unknown as DesktopCompanyManifestPackage],
        betaSequence: manifestSequence,
      },
    )
    expect(betaTarget.rejected).toEqual([])
    expect(betaTarget.allowed[0]?.updateVersion).toBe('0.18.1')

    // The overlay wholly replaces the stable entries of a carried name, so
    // a stable-only newer pin never becomes the target for a tester.
    const stableShadowed = verify(
      signedManifestText([windowEntry('0.16.0', oldLine)]),
      [windowBundle('0.15.2')],
      {
        dshRuntimeVersion: oldRuntime,
        betaPackages: [windowEntry('0.15.2', oldLine) as unknown as DesktopCompanyManifestPackage],
        betaSequence: manifestSequence,
      },
    )
    expect(stableShadowed.rejected).toEqual([])
    expect(stableShadowed.allowed[0]?.updateVersion).toBeUndefined()
  })
})

describe('dual-channel manifest source invariants (P7 wiring)', () => {
  // The boot path verifies through `verifyDesktopCompanyManifest` since the
  // P7 batch-2 wiring: same source-free decisions as the field-unaware
  // market verifier, plus the one recognized extension — a signed per-entry
  // `source` install channel.
  const catalogOrigin = 'https://gitlab.company.example'
  const tarballIntegrity = `sha512-${Buffer.alloc(64, 5).toString('base64')}`
  const treeDigest = 'ab'.repeat(32)
  const tarballUrl = `${catalogOrigin}/julu/dsh-desktop-config/-/packages/${packageName}-${version}.tgz`

  const tarballChannelEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => packageEntry({
    integrity: tarballIntegrity,
    treeDigest,
    source: { kind: 'tarball', url: tarballUrl, integrity: tarballIntegrity },
    ...overrides,
  })

  it('decides source-free manifests exactly like the field-unaware market verifier through the boot path, in both catalog modes', () => {
    const valid = signedManifestText([packageEntry()])
    // Same parsed value, deliberately non-sorted key order: the bytes are
    // not the canonical serialization, so both verifiers reject them before
    // any signature is even examined.
    const nonCanonical = (() => {
      const parsed = JSON.parse(valid) as Record<string, unknown>
      return JSON.stringify({
        signature: parsed.signature,
        packages: parsed.packages,
        sequence: parsed.sequence,
        manifestVersion: parsed.manifestVersion,
        expiresAt: parsed.expiresAt,
      })
    })()
    // Manifest-level corpus cases (P7 2a review): the document-level
    // decisions the entry cases cannot reach. Non-object JSON shares the
    // market verifier's `malformed-json` code; the bad-`expiresAt` cases pin
    // the ajv-formats `date-time` mirror of the desktop verifier — note the
    // space-separated spelling is ACCEPTED by both verifiers (ajv's full
    // date-time splits on t/T or whitespace and V8 parses it), so the
    // equivalence is locked in both directions.
    const signatureBlock = (): Record<string, unknown> => {
      const signature = createCompanyManifestSignature(
        {
          manifestVersion: '1.0.0',
          sequence: manifestSequence,
          expiresAt: '2030-01-01T00:00:00Z',
          packages: [packageEntry()],
        } as unknown as Parameters<typeof createCompanyManifestSignature>[0],
        privateKey,
        keyId,
      )
      return signature as unknown as Record<string, unknown>
    }
    const signedDocument = (document: Record<string, unknown>): string => canonicalJsonText({
      ...document,
      signature: createCompanyManifestSignature(
        document as unknown as Parameters<typeof createCompanyManifestSignature>[0],
        privateKey,
        keyId,
      ),
    })
    const corpus: readonly [string, string][] = [
      ['valid', valid],
      ['entry unknown key', signedManifestText([packageEntry({ extra: 1 })])],
      ['non-canonical bytes', nonCanonical],
      ['bad integrity shape', signedManifestText([packageEntry({ integrity: 'sha512-nope' })])],
      ['bad bundlePatch escape', signedManifestText([packageEntry({ bundlePatch: '../escape.yml' })])],
      ['bad repository url', signedManifestText([packageEntry({ repository: { url: 'http://insecure.example/r' } })])],
      ['repository subdirectory escape', signedManifestText([packageEntry({ repository: { url: 'https://github.com/example/dsh-plugin-safe', subdirectory: '../up' } })])],
      ['bad runtime range', signedManifestText([packageEntry({ runtime: { dshRuntimeVersion: 'bogus range' } })])],
      ['missing dshRuntimeVersion', signedManifestText([packageEntry({ runtime: {} })])],
      ['bad approvedBuilds entry', signedManifestText([packageEntry({ approvedBuilds: ['not valid!'] })])],
      ['bad treeDigest shape', signedManifestText([packageEntry({ treeDigest: 'xyz' })])],
      ['revoked non-boolean', signedManifestText([packageEntry({ revoked: 'yes' })])],
      ['bad version', signedManifestText([packageEntry({ version: '1.0.0-rc.1' })])],
      ['non-object JSON (array)', canonicalJsonText([])],
      ['non-object JSON (number)', canonicalJsonText(5)],
      ['non-object JSON (string)', canonicalJsonText('x')],
      ['unknown top-level key', signedDocument({
        manifestVersion: '1.0.0',
        sequence: manifestSequence,
        expiresAt: '2030-01-01T00:00:00Z',
        packages: [packageEntry()],
        futureField: 1,
      })],
      ['missing top-level key', signedDocument({
        manifestVersion: '1.0.0',
        expiresAt: '2030-01-01T00:00:00Z',
        packages: [packageEntry()],
      })],
      ['signature not an object', canonicalJsonText({
        manifestVersion: '1.0.0',
        sequence: manifestSequence,
        expiresAt: '2030-01-01T00:00:00Z',
        packages: [packageEntry()],
        signature: 5,
      })],
      ['signature missing value key', canonicalJsonText({
        manifestVersion: '1.0.0',
        sequence: manifestSequence,
        expiresAt: '2030-01-01T00:00:00Z',
        packages: [packageEntry()],
        signature: (() => { const block = signatureBlock(); return { keyId: block.keyId, publicKey: block.publicKey } })(),
      })],
      ['bad expiresAt (RFC-1123 spelling)', signedManifestText([packageEntry()], { expiresAt: 'Wed, 01 Jan 2030 00:00:00 GMT' })],
      ['bad expiresAt (leap second, format-valid but unparseable)', signedManifestText([packageEntry()], { expiresAt: '2030-12-31T23:59:60Z' })],
      ['bad expiresAt (non-string)', signedDocument({
        manifestVersion: '1.0.0',
        sequence: manifestSequence,
        expiresAt: 20300101,
        packages: [packageEntry()],
      })],
      ['space-separated expiresAt (both accept)', signedManifestText([packageEntry()], { expiresAt: '2030-01-01 00:00:00Z' })],
      [`packages over-limit (${String(10_001)} entries)`, signedManifestText(
        Array.from({ length: 10_001 }, (_, index) => packageEntry({ packageName: `dsh-plugin-safe-${String(index)}` })),
      )],
    ]
    // The corpus runs in both production policy modes: origin mode (a pinned
    // catalog origin) and content mode (no origin — the production default
    // for embedded manifests, `companyCatalogOrigin ?? null`). For
    // source-free manifests the two modes share every code path (the origin
    // only matters inside the tarball `source` branch), so both must decide
    // exactly like the market verifier.
    const bundle = bundleInput()
    for (const mode of ['origin', 'content'] as const) {
      const bootOptions = mode === 'origin' ? { companyCatalogOrigin: catalogOrigin } : {}
      for (const [label, text] of corpus) {
        // The manifest decision must be the market verifier's decision: same
        // trust outcome, same failure code, and the boot failure template
        // over that code — exactly what the field-unaware verifier produced
        // on this corpus before the switch. (Human-readable `reason` wording
        // differs between the verifiers by design; the pinned compatibility
        // surface is the decision plus the code.)
        const market = verifyCompanyManifest(text, { trustRoots })
        const boot = verify(text, [bundle], bootOptions)
        expect(boot.manifestTrusted, `${mode}: ${label}`).toBe(market.ok)
        if (market.ok || boot.manifestTrusted) continue
        expect(boot.manifestFailure?.code, `${mode}: ${label}`).toBe(market.code)
        expect(boot.rejected, `${mode}: ${label}`).toHaveLength(1)
        const reason = boot.rejected[0]?.reason ?? ''
        expect(reason.startsWith('the company manifest is not trusted ('), `${mode}: ${label}`).toBe(true)
        expect(reason.includes(`(${String(market.code)}): `), `${mode}: ${label}`).toBe(true)
      }
    }
    const validBoot = verify(valid, [bundleInput()], { companyCatalogOrigin: catalogOrigin })
    expect(validBoot.allowed).toEqual([{ packageName, evidence: 'manifest-only', manifestSequence, keyId }])
    expect(validBoot.rejected).toEqual([])
    // And the production-default content mode allows the same bundle.
    const validContentBoot = verify(valid, [bundleInput()], {})
    expect(validContentBoot.allowed).toEqual([{ packageName, evidence: 'manifest-only', manifestSequence, keyId }])
    expect(validContentBoot.rejected).toEqual([])
  })

  it('allows a bundle pinned by a source-carrying entry under an origin-mode policy', () => {
    const result = verify(
      signedManifestText([tarballChannelEntry()]),
      [bundleInput({ lockIntegrity: tarballIntegrity })],
      {
        companyCatalogOrigin: catalogOrigin,
        measureTreeRootDigest: (_packageDir, purpose) => {
          expect(purpose).toBe('signed-tree')
          return treeDigest
        },
      },
    )
    expect(result.manifestTrusted).toBe(true)
    expect(result.manifestFailure).toBeUndefined()
    expect(result.allowed).toEqual([{ packageName, evidence: 'signed-tree', manifestSequence, keyId }])
    expect(result.rejected).toEqual([])
  })

  it('rejects a source-carrying manifest whole without a pinned origin, exactly like the field-unaware verifier', () => {
    const text = signedManifestText([tarballChannelEntry()])
    // Content-mode boot (no `companyCatalogOrigin` option) keeps the legacy
    // whole-manifest rejection — one unknown key to the field-unaware
    // verifier, the tarball-channel-needs-an-origin rule to the dual one.
    const result = verify(text, [bundleInput({ lockIntegrity: tarballIntegrity })])
    expect(result.manifestTrusted).toBe(false)
    expect(result.manifestFailure?.code).toBe('invalid-manifest')
    expect(result.manifestFailure?.reason).toContain('requires an origin-mode catalog policy')
    expect(result.rejected).toHaveLength(1)
    expect(verifyCompanyManifest(text, { trustRoots }).ok).toBe(false)
    // A different pinned origin refuses the entry's url just the same.
    const otherOrigin = verify(text, [bundleInput({ lockIntegrity: tarballIntegrity })], {
      companyCatalogOrigin: 'https://elsewhere.company.example',
    })
    expect(otherOrigin.manifestFailure?.code).toBe('invalid-manifest')
    expect(otherOrigin.manifestFailure?.reason).toContain('must stay inside the pinned catalog origin')
  })

  it('accepts an explicit npm source object as the npm channel', () => {
    const result = verify(
      signedManifestText([packageEntry({ source: { kind: 'npm' } })]),
      [bundleInput()],
      { companyCatalogOrigin: catalogOrigin },
    )
    expect(result.manifestTrusted).toBe(true)
    expect(result.allowed).toEqual([{ packageName, evidence: 'manifest-only', manifestSequence, keyId }])
  })
})

describe('signed tree digest authority (entries carrying treeDigest)', () => {
  // The manifest-authority anchor: when the signed entry pins the expected
  // installed-tree digest, that value — not the user-writable receipt — is
  // the expectation the measured disk tree must equal.
  const authorityEntry = (digest: string): Record<string, unknown> => packageEntry({ treeDigest: digest })

  it('allows a bundle whose measured tree equals the signed digest, with signed-tree evidence and no receipt', () => {
    const bundle = bundleInput()
    const result = verify(
      signedManifestText([authorityEntry(computeDesktopBootTreeRootDigest(bundle.packageDir!))]),
      [bundle],
      {},
    )
    expect(result).toEqual({
      manifestTrusted: true,
      manifestSequence,
      keyId,
      manifestFailure: undefined,
      allowed: [{ packageName, evidence: 'signed-tree', manifestSequence, keyId }],
      rejected: [],
    })
  })

  it('rejects a bundle whose measured tree differs from the signed digest (the core negative)', () => {
    const bundle = bundleInput()
    const result = verify(
      signedManifestText([authorityEntry('ab'.repeat(32))]),
      [bundle],
      {},
    )
    expect(result.allowed).toEqual([])
    expect(result.rejected).toEqual([{
      packageName,
      reason: `the installed files of ${packageName}@${version} differ from the tree digest pinned in the signed company manifest`,
      code: 'tree-mismatch',
    }])
  })

  it('rejects tampered files even when the receipt is forged to match the tampered tree', () => {
    const original = bundleInput()
    const digest = computeDesktopBootTreeRootDigest(original.packageDir!)
    // Tamper the installed tree, then rewrite the receipt to the digest of
    // the tampered tree: the receipt is no longer the comparison target, so
    // the tamper stands out against the signed digest.
    const tampered = bundleInput()
    writeFileSync(join(tampered.packageDir!, 'lib/payload.js'), 'export const marker = 2\n')
    const forged = receiptFor(tampered)
    const result = verify(signedManifestText([authorityEntry(digest)]), [tampered], { receipts: [forged] })
    expect(result.allowed).toEqual([])
    expect(result.rejected[0]?.reason).toContain('differ from the tree digest pinned in the signed company manifest')
  })

  it('rejects tampered files even when an intact receipt still pins the signed digest (no receipt-keyed skip)', () => {
    const original = bundleInput()
    const digest = computeDesktopBootTreeRootDigest(original.packageDir!)
    // Tamper the installed tree but leave the legitimate receipt — which
    // still records the signed digest — untouched. A receipt match must not
    // skip the measurement: the receipt lives in user-writable storage, so
    // honoring it as a pass would reintroduce the deleted-receipt bypass.
    const tampered = bundleInput({
      packageDir: installedPackage({ ...defaultFiles, 'lib/payload.js': 'export const marker = 2\n' }),
    })
    const result = verify(
      signedManifestText([authorityEntry(digest)]),
      [tampered],
      { receipts: [receiptFor(original, { rootDigest: digest })] },
    )
    expect(result.allowed).toEqual([])
    expect(result.rejected[0]?.reason).toContain('differ from the tree digest pinned in the signed company manifest')
  })

  it('allows a matching tree while ignoring a divergent receipt, keeping signed-tree evidence', () => {
    const bundle = bundleInput()
    const digest = computeDesktopBootTreeRootDigest(bundle.packageDir!)
    // A stale receipt (recorded from an older install with a different
    // layout) disagrees with the signed digest; the disk tree matches the
    // signed value, so the bundle loads — the receipt is advisory only.
    const result = verify(
      signedManifestText([authorityEntry(digest)]),
      [bundle],
      { receipts: [receiptFor(bundle, { rootDigest: 'cd'.repeat(32) })] },
    )
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([{ packageName, evidence: 'signed-tree', manifestSequence, keyId }])
  })

  it('rejects a bundle whose tree cannot be measured in authority mode, receipt or not', () => {
    const reference = installedPackage(defaultFiles)
    const bundle = bundleInput({ packageDir: join(temporaryDirectory(), 'missing') })
    const result = verify(
      signedManifestText([authorityEntry(computeDesktopBootTreeRootDigest(reference))]),
      [bundle],
      { receipts: [receiptFor({ ...bundle, packageDir: reference })] },
    )
    expect(result.allowed).toEqual([])
    expect(result.rejected[0]?.reason).toContain('could not be measured')
  })

  it('keeps receipt-mode evidence for peer entries without a signed tree digest in the same manifest', () => {
    const authoritative = bundleInput()
    const receiptAnchored = bundleInput({ packageName: 'dsh-plugin-receipt-anchored' })
    const result = verify(
      signedManifestText([
        authorityEntry(computeDesktopBootTreeRootDigest(authoritative.packageDir!)),
        packageEntry({ packageName: receiptAnchored.packageName }),
      ]),
      [authoritative, receiptAnchored],
      { receipts: [receiptFor(receiptAnchored)] },
    )
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([
      { packageName: authoritative.packageName, evidence: 'signed-tree', manifestSequence, keyId },
      { packageName: receiptAnchored.packageName, evidence: 'receipt', manifestSequence, keyId },
    ])
  })
})

describe('signed tree digest authority bypasses the fingerprint cache', () => {
  // The attack these tests model: the fingerprint cache lives in
  // user-writable <userData> and a hit returns the recorded digest without
  // reading the tree, so an attacker who can tamper a plugin can also forge
  // a cache line claiming the signed digest for the tampered tree. Every
  // test uses a real installed tree, a real signed manifest, and a real
  // forged cache document — only the authority path's cache bypass keeps
  // the decision honest.
  const tamperedFiles: Record<string, string> = {
    ...defaultFiles,
    'lib/payload.js': 'export const marker = 2\n',
  }

  /** Forge a fingerprint cache that will hit for the given tree with the given digest. */
  function forgedFingerprintCache(packageDir: string, digest: string): string {
    const fingerprint = desktopBootTreeStatFingerprint(packageDir)
    const cachePath = join(temporaryDirectory(), DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME)
    writeFileSync(cachePath, `${JSON.stringify({
      [packageDir]: { mtime: fingerprint.mtime, size: fingerprint.size, digest },
    }, null, 2)}\n`)
    return cachePath
  }

  it('rejects tampered files even when the forged cache records the signed digest (the core negative)', () => {
    const signedDigest = computeDesktopBootTreeRootDigest(installedPackage(defaultFiles))
    const tampered = bundleInput({ packageDir: installedPackage(tamperedFiles) })
    // The forged cache line carries the signed digest and a stat fingerprint
    // matching the tampered tree, so a cache-consuming measurement would
    // return the signed value without ever reading the tampered files.
    const cachePath = forgedFingerprintCache(tampered.packageDir!, signedDigest)
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, { measure })
    // Attack proof: the forged line really is a cache hit — the receipt-mode
    // measurement returns the signed digest without calling the full measure.
    expect(cached(tampered.packageDir!)).toBe(signedDigest)
    expect(measure).not.toHaveBeenCalled()

    const result = verify(
      signedManifestText([packageEntry({ treeDigest: signedDigest })]),
      [tampered],
      { measureTreeRootDigest: cached },
    )
    expect(result.allowed).toEqual([])
    expect(result.rejected).toEqual([{
      packageName,
      reason: `the installed files of ${packageName}@${version} differ from the tree digest pinned in the signed company manifest`,
      code: 'tree-mismatch',
    }])
    // The authority path measured the tampered contents for real.
    expect(measure).toHaveBeenCalledTimes(1)
    // And the bypass left the forged document untouched: a receipt-mode
    // measurement afterwards still hits the forged line (no full measure,
    // still the forged digest) instead of one rewritten with the truth.
    expect(cached(tampered.packageDir!)).toBe(signedDigest)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('measures in full on a cache hit for authority entries, ignoring a forged clean cache both ways', () => {
    const digest = computeDesktopBootTreeRootDigest(installedPackage(defaultFiles))
    const matching = bundleInput()
    // A forged "clean" cache line claims a divergent digest for a tree that
    // actually matches the signed value: the authority decision must come
    // from the measured tree, so the bundle still loads.
    const cachePath = forgedFingerprintCache(matching.packageDir!, 'cd'.repeat(32))
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, { measure })
    expect(cached(matching.packageDir!)).toBe('cd'.repeat(32))
    expect(measure).not.toHaveBeenCalled()

    const result = verify(
      signedManifestText([packageEntry({ treeDigest: digest })]),
      [matching],
      { measureTreeRootDigest: cached },
    )
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([{ packageName, evidence: 'signed-tree', manifestSequence, keyId }])
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('keeps serving receipt-mode entries from a valid cache (repeat-boot acceleration unchanged)', () => {
    const bundle = bundleInput()
    const receipt = receiptFor(bundle)
    const manifest = signedManifestText([packageEntry()])
    const cachePath = join(temporaryDirectory(), DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME)
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, { measure })

    const first = verify(manifest, [bundle], { receipts: [receipt], measureTreeRootDigest: cached })
    const second = verify(manifest, [bundle], { receipts: [receipt], measureTreeRootDigest: cached })
    expect(first.allowed).toEqual([{ packageName, evidence: 'receipt', manifestSequence, keyId }])
    expect(second.allowed).toEqual([{ packageName, evidence: 'receipt', manifestSequence, keyId }])
    // The first boot measured the tree; the repeat boot hit the cache.
    expect(measure).toHaveBeenCalledTimes(1)
  })
})

describe('boot verification target selection', () => {
  it('exempts upstream, desktop, and market bundles from verification', () => {
    const declared = [
      ...(PROFILE_TEMPLATES.web?.bundles ?? []),
      'dsh-plugin-desktop',
      'dsh-community-market',
      'dshmarket',
      '@deepseek-ai/dsh-desktop-app',
      'third-party-plugin',
      '@scope/third-party-plugin',
    ]
    expect(desktopBootBundleNames(declared)).toEqual(['third-party-plugin', '@scope/third-party-plugin'])
  })
})

describe('profile lockfile reader', () => {
  function lockfileFixture(overrides: { version?: string; specifier?: string } = {}): string {
    const profileDir = temporaryDirectory()
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      `lockfileVersion: '${overrides.version ?? '9.0'}'`,
      'importers:',
      '  .:',
      '    dependencies:',
      `      '${packageName}':`,
      `        specifier: '${overrides.specifier ?? version}'`,
      `        version: '${version}'`,
      'packages:',
      `  '${packageName}@${version}':`,
      '    resolution:',
      `      integrity: '${signedIntegrity}'`,
      '',
    ].join('\n'))
    return profileDir
  }

  it('pins integrity for an exact specifier and resolution', () => {
    const lockfile = readDesktopBootLockfile(lockfileFixture())!
    expect(lockfile).toBeDefined()
    expect(desktopBootLockIntegrity(lockfile, packageName, version)).toBe(signedIntegrity)
  })

  it('accepts a peer-suffixed resolution through the resolved key', () => {
    const profileDir = temporaryDirectory()
    const resolvedVersion = `${version}(_abc)`
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      `      '${packageName}':`,
      `        specifier: '${version}'`,
      `        version: '${resolvedVersion}'`,
      'packages:',
      `  '${packageName}@${resolvedVersion}':`,
      '    resolution:',
      `      integrity: '${signedIntegrity}'`,
      '',
    ].join('\n'))
    const lockfile = readDesktopBootLockfile(profileDir)!
    expect(desktopBootLockIntegrity(lockfile, packageName, version)).toBe(signedIntegrity)
  })

  it('returns nothing for range specifiers or missing package entries', () => {
    const rangeLockfile = readDesktopBootLockfile(lockfileFixture({ specifier: `^${version}` }))!
    expect(desktopBootLockIntegrity(rangeLockfile, packageName, version)).toBeUndefined()

    const lockfile = readDesktopBootLockfile(lockfileFixture())!
    expect(desktopBootLockIntegrity(lockfile, packageName, '9.9.9')).toBeUndefined()
    expect(desktopBootLockIntegrity(lockfile, 'other-package', version)).toBeUndefined()
  })

  it('refuses to load a caret-specifier install that an exact save would have pinned', () => {
    const manifest = signedManifestText([packageEntry()])
    const bundle = bundleInput()

    // pnpm's default caret save (`^1.2.3`) leaves no exact pinned record, so
    // the bundle is refused even though the signed entry matches.
    const caretPinned = desktopBootLockIntegrity(
      readDesktopBootLockfile(lockfileFixture({ specifier: `^${version}` }))!,
      packageName,
      version,
    )
    expect(caretPinned).toBeUndefined()
    const caret = verify(manifest, [{ ...bundle, lockIntegrity: caretPinned }])
    expect(caret.allowed).toEqual([])
    expect(caret.rejected[0]?.reason).toContain('no exact pinned record in the profile lockfile')

    // The exact specifier (`1.2.3`) a `--save-exact` add produces pins the
    // same signed integrity and loads.
    const exactPinned = desktopBootLockIntegrity(readDesktopBootLockfile(lockfileFixture())!, packageName, version)
    expect(exactPinned).toBe(signedIntegrity)
    const exact = verify(manifest, [{ ...bundle, lockIntegrity: exactPinned }])
    expect(exact.rejected).toEqual([])
    expect(exact.allowed).toEqual([{ packageName, evidence: 'manifest-only', manifestSequence, keyId }])
  })

  it('treats missing, corrupt, and unsupported lockfiles as unpinned', () => {
    expect(readDesktopBootLockfile(temporaryDirectory())).toBeUndefined()

    const profileDir = temporaryDirectory()
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: [broken\n')
    expect(readDesktopBootLockfile(profileDir)).toBeUndefined()

    const unsupported = readDesktopBootLockfile(lockfileFixture({ version: '6.0' }))
    expect(unsupported).toBeUndefined()
  })
})

describe('boot bundle collection', () => {
  it('collects version, lock integrity, and the installed directory', () => {
    const profileDir = temporaryDirectory()
    const packageDir = join(profileDir, 'node_modules', packageName)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), `{"name":"${packageName}","version":"${version}"}\n`)
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      `      '${packageName}':`,
      `        specifier: '${version}'`,
      `        version: '${version}'`,
      'packages:',
      `  '${packageName}@${version}':`,
      '    resolution:',
      `      integrity: '${signedIntegrity}'`,
      '',
    ].join('\n'))

    expect(collectDesktopBootBundles(profileDir, [packageName])).toEqual([{
      packageName,
      version,
      lockIntegrity: signedIntegrity,
      packageDir,
    }])
  })

  it('keeps unresolvable and unpinned bundles as records with undefined evidence fields', () => {
    const profileDir = temporaryDirectory()
    expect(collectDesktopBootBundles(profileDir, [packageName, 'missing-plugin'])).toEqual([
      { packageName, version: undefined, lockIntegrity: undefined, packageDir: undefined },
      { packageName: 'missing-plugin', version: undefined, lockIntegrity: undefined, packageDir: undefined },
    ])
  })
})

describe('company manifest asset reader', () => {
  it('anchors the asset beside the module and reads or misses it', () => {
    const root = temporaryDirectory()
    const moduleUrl = pathToFileURL(join(root, 'lib', 'profile.js')).href
    const assetPath = companyManifestAssetPath('company-market/catalog-manifest.json', moduleUrl)
    expect(assetPath).toBe(join(root, 'lib', 'company-market', 'catalog-manifest.json'))
    expect(readCompanyManifestAsset(assetPath)).toBeUndefined()

    mkdirSync(dirname(assetPath), { recursive: true })
    writeFileSync(assetPath, signedManifestText([]))
    expect(readCompanyManifestAsset(assetPath)).toBe(signedManifestText([]))
  })

  it('rejects unsafe asset specifiers', () => {
    const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href
    expect(() => companyManifestAssetPath('/absolute/manifest.json', moduleUrl)).toThrow(
      'must stay inside the bundled module directory',
    )
    expect(() => companyManifestAssetPath('../escape.json', moduleUrl)).toThrow(
      'must stay inside the bundled module directory',
    )
    expect(() => companyManifestAssetPath('a\\b.json', moduleUrl)).toThrow(
      'without NUL or backslash',
    )
  })
})

describe('market settings receipt reader', () => {
  const contentPolicy = { companyCatalogOrigin: null, companyManifestUrl: 'company-market/catalog-manifest.json' }

  function writeSettings(home: string, document: unknown): string {
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, typeof document === 'string' ? document : JSON.stringify(document))
    return settingsPath
  }

  it('extracts only a well-formed receipt array from a parsed settings document', () => {
    expect(marketInstallReceiptsFromSettingsDocument(undefined)).toEqual([])
    expect(marketInstallReceiptsFromSettingsDocument('text')).toEqual([])
    expect(marketInstallReceiptsFromSettingsDocument({})).toEqual([])
    expect(marketInstallReceiptsFromSettingsDocument({ 'dsh-community-market': {} })).toEqual([])
    expect(marketInstallReceiptsFromSettingsDocument({
      'dsh-community-market': { installReceipts: 'nope' },
    })).toEqual([])
    expect(marketInstallReceiptsFromSettingsDocument({
      'dsh-community-market': { installReceipts: [marketV2Receipt(), 'junk'] },
    })).toEqual([marketV2Receipt()])
  })

  it('normalizes receipts from the settings document and never throws on damaged stores', () => {
    const home = temporaryDirectory()
    const settingsPath = writeSettings(home, {
      'dsh-community-market': {
        sources: [],
        installReceipts: [
          marketV2Receipt({ manifestSequence: 44 }),
          marketV2Receipt({ receiptId: 'broken', packageName: 7, manifestSequence: 9_999 }),
        ],
      },
    })
    expect(readDesktopBootReceiptsFromSettings(settingsPath)).toEqual([{
      packageName,
      version,
      manifestSequence: 44,
      keyId,
      rootDigest: 'ab'.repeat(32),
    }])

    expect(readDesktopBootReceiptsFromSettings(join(home, 'missing-settings.yaml'))).toEqual([])
    writeSettings(home, 'dsh-community-market: [broken\n')
    expect(readDesktopBootReceiptsFromSettings(join(home, 'settings.yaml'))).toEqual([])
  })

  it('assembles production inputs: content-mode bytes plus receipts, origin mode stays uncached', () => {
    const home = temporaryDirectory()
    const moduleUrl = pathToFileURL(join(home, 'lib', 'boot-verification.js')).href
    const assetPath = companyManifestAssetPath('company-market/catalog-manifest.json', moduleUrl)
    mkdirSync(dirname(assetPath), { recursive: true })
    const manifest = signedManifestText([packageEntry()])
    writeFileSync(assetPath, manifest)
    const settingsPath = writeSettings(home, {
      'dsh-community-market': { installReceipts: [marketV2Receipt()] },
    })

    const inputs = desktopBootVerificationInputsFromSettings(contentPolicy, settingsPath, moduleUrl)
    expect(inputs.manifestBytes).toBe(manifest)
    expect(inputs.receipts).toEqual([{
      packageName,
      version,
      manifestSequence,
      keyId,
      rootDigest: 'ab'.repeat(32),
    }])

    // Origin-mode deployments have no cached bytes here: boot verification
    // fails closed for third-party content by design.
    const originInputs = desktopBootVerificationInputsFromSettings(
      { companyCatalogOrigin: 'https://market.company.example', companyManifestUrl: 'https://market.company.example/catalog-manifest.json' },
      settingsPath,
      moduleUrl,
    )
    expect(originInputs.manifestBytes).toBeUndefined()
    expect(originInputs.receipts).toHaveLength(1)

    // Empty-receipt inputs still decide manifest-only for receiptless bundles;
    // the sequence floor stays at the default derived inside verification.
    const emptyHome = join(home, 'empty-home')
    mkdirSync(emptyHome, { recursive: true })
    const emptyInputs = desktopBootVerificationInputsFromSettings(
      contentPolicy,
      writeSettings(emptyHome, {}),
      moduleUrl,
    )
    expect(emptyInputs.receipts).toEqual([])
    const decision = verifyDesktopBootBundles(inputs.manifestBytes, [bundleInput()], {
      trustRoots,
      ...emptyInputs,
    })
    expect(decision.manifestTrusted).toBe(true)
    expect(decision.allowed).toEqual([{ packageName, evidence: 'manifest-only', manifestSequence, keyId }])
  })
})

describe('market manifest sequence ratchet floor (review P2)', () => {
  const contentPolicy = { companyCatalogOrigin: null, companyManifestUrl: 'company-market/catalog-manifest.json' }

  function writeSettings(home: string, market: unknown): string {
    const settingsPath = join(home, 'settings.yaml')
    mkdirSync(home, { recursive: true })
    writeFileSync(settingsPath, typeof market === 'string'
      ? market
      : JSON.stringify({ 'dsh-community-market': market }))
    return settingsPath
  }

  function ratchetRecord(sequence: number): Record<string, unknown> {
    return {
      sources: [],
      companyManifest: {
        sequence,
        keyId,
        verifiedAt: '2026-09-10T00:00:00.000Z',
        bytesSha256: 'cd'.repeat(32),
      },
    }
  }

  it('reads only a well-formed persisted ratchet sequence and never throws', () => {
    const home = temporaryDirectory()
    expect(marketManifestSequenceRatchetFromSettings(
      writeSettings(home, ratchetRecord(26)),
    )).toBe(26)
    // Absent, malformed, or non-positive records contribute nothing.
    expect(marketManifestSequenceRatchetFromSettings(writeSettings(home, { sources: [] }))).toBeUndefined()
    expect(marketManifestSequenceRatchetFromSettings(
      writeSettings(home, { companyManifest: { sequence: 'twenty-six' } }),
    )).toBeUndefined()
    expect(marketManifestSequenceRatchetFromSettings(
      writeSettings(home, { companyManifest: { sequence: 0 } }),
    )).toBeUndefined()
    expect(marketManifestSequenceRatchetFromSettings(
      writeSettings(home, 'dsh-community-market: [broken\n'),
    )).toBeUndefined()
    expect(marketManifestSequenceRatchetFromSettings(join(home, 'missing.yaml'))).toBeUndefined()
  })

  it('joins the ratchet with the receipt floor, taking the higher of the two', () => {
    const home = temporaryDirectory()
    const moduleUrl = pathToFileURL(join(home, 'lib', 'boot-verification.js')).href
    const assetPath = companyManifestAssetPath('company-market/catalog-manifest.json', moduleUrl)
    mkdirSync(dirname(assetPath), { recursive: true })
    writeFileSync(assetPath, signedManifestText([packageEntry()]))

    // Receipts above the ratchet: the receipt floor still wins.
    const receiptLed = writeSettings(home, {
      installReceipts: [marketV2Receipt({ manifestSequence: 44 })],
      companyManifest: ratchetRecord(26).companyManifest,
    })
    expect(desktopBootVerificationInputsFromSettings(contentPolicy, receiptLed, moduleUrl).lastSeenSequence).toBe(44)

    // Ratchet above the receipts: the persisted floor wins.
    const ratchetLed = writeSettings(home, {
      installReceipts: [marketV2Receipt({ manifestSequence: 20 })],
      companyManifest: ratchetRecord(26).companyManifest,
    })
    expect(desktopBootVerificationInputsFromSettings(contentPolicy, ratchetLed, moduleUrl).lastSeenSequence).toBe(26)

    // Neither present: no injected floor at all (the default inside
    // verification stays receipt-derived, which is zero here).
    const bare = writeSettings(home, { sources: [] })
    expect(desktopBootVerificationInputsFromSettings(contentPolicy, bare, moduleUrl).lastSeenSequence).toBeUndefined()
  })

  it('keeps the anti-rollback floor after the receipts were cleared (fresh-profile swap)', () => {
    const home = temporaryDirectory()
    const moduleUrl = pathToFileURL(join(home, 'lib', 'boot-verification.js')).href
    const assetPath = companyManifestAssetPath('company-market/catalog-manifest.json', moduleUrl)
    mkdirSync(dirname(assetPath), { recursive: true })
    // The manifest is a ROLLBACK relative to what this machine already saw.
    writeFileSync(assetPath, signedManifestText([packageEntry()], { sequence: manifestSequence }))

    // Before the swap: a receipt at 22 and the market scan ratchet at 22 both
    // sit in the settings document.
    const beforeSwap = writeSettings(join(home, 'before'), {
      installReceipts: [marketV2Receipt({ manifestSequence: 22 })],
      companyManifest: ratchetRecord(22).companyManifest,
    })
    const before = desktopBootVerificationInputsFromSettings(contentPolicy, beforeSwap, moduleUrl)
    expect(before.lastSeenSequence).toBe(22)
    expect(verifyDesktopBootBundles(before.manifestBytes, [bundleInput()], { trustRoots, ...before }).manifestFailure?.code)
      .toBe('stale-sequence')

    // After the swap: the ledger clear removed every receipt, the ratchet
    // survives in the same document — the floor must not reset to zero, or a
    // controlled origin replaying the older signed manifest would re-admit
    // revoked entries into the boot allow surface.
    const swapped = writeSettings(join(home, 'after'), ratchetRecord(22))
    const after = desktopBootVerificationInputsFromSettings(contentPolicy, swapped, moduleUrl)
    expect(after.receipts).toEqual([])
    expect(after.lastSeenSequence).toBe(22)
    const decision = verifyDesktopBootBundles(after.manifestBytes, [bundleInput()], { trustRoots, ...after })
    expect(decision.manifestTrusted).toBe(false)
    expect(decision.manifestFailure?.code).toBe('stale-sequence')
  })
})

describe('boot tree fingerprint cache', () => {
  it('returns the recorded digest on repeat boots without re-measuring the tree', () => {
    const packageDir = installedPackage(defaultFiles)
    const cachePath = join(temporaryDirectory(), DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME)
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, { measure })

    const first = cached(packageDir)
    expect(first).toBe(computeDesktopBootTreeRootDigest(packageDir))
    // Repeat boots with an unchanged tree skip the full content hash and
    // return the recorded digest (the cache-hit evidence).
    expect(cached(packageDir)).toBe(first)
    expect(cached(packageDir)).toBe(first)
    expect(measure).toHaveBeenCalledTimes(1)

    // The persisted document records the stat fingerprint with the digest.
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(persisted)).toEqual([packageDir])
    const entry = persisted[packageDir] as { mtime: number; size: number; digest: string }
    const fingerprint = desktopBootTreeStatFingerprint(packageDir)
    expect(entry).toEqual({
      mtime: fingerprint.mtime,
      size: fingerprint.size,
      digest: first,
    })
  })

  it('re-measures and rewrites the entry after any tree change', () => {
    const packageDir = installedPackage(defaultFiles)
    const cachePath = join(temporaryDirectory(), DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME)
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, { measure })

    const before = cached(packageDir)
    writeFileSync(join(packageDir, 'lib', 'payload.js'), 'export const marker = 22\n')
    // Pin the modification time explicitly: filesystems with coarse mtime
    // granularity could otherwise miss a same-millisecond rewrite.
    const touched = new Date('2027-06-01T00:00:00.000Z')
    utimesSync(join(packageDir, 'lib', 'payload.js'), touched, touched)
    const after = cached(packageDir)

    expect(after).toBe(computeDesktopBootTreeRootDigest(packageDir))
    expect(after).not.toBe(before)
    expect(measure).toHaveBeenCalledTimes(2)
    expect(cached(packageDir)).toBe(after)
    expect(measure).toHaveBeenCalledTimes(2)
  })

  it('ignores a corrupt cache document and rebuilds it', () => {
    const packageDir = installedPackage(defaultFiles)
    const cachePath = join(temporaryDirectory(), DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME)
    writeFileSync(cachePath, '{not a json document')
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, { measure })

    expect(cached(packageDir)).toBe(computeDesktopBootTreeRootDigest(packageDir))
    expect(measure).toHaveBeenCalledTimes(1)
    // The rebuild replaced the corrupt bytes with a valid document.
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { digest: string }>
    expect(persisted[packageDir]?.digest).toBe(measure.mock.results[0]!.value)
  })

  it('skips unreadable cache entries and tolerates a failed cache write', () => {
    const packageDir = installedPackage(defaultFiles)
    const cachePath = join(temporaryDirectory(), DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME)
    writeFileSync(cachePath, JSON.stringify({
      [packageDir]: { mtime: 'not a number', size: -1, digest: 'zz' },
      '': { mtime: 1, size: 1, digest: 'a'.repeat(64) },
    }))
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, {
      measure,
      writeFile: () => { throw new Error('disk full') },
    })

    // Neither malformed entry counts as a hit, and the failed persist is
    // skipped rather than failing the boot.
    expect(cached(packageDir)).toBe(computeDesktopBootTreeRootDigest(packageDir))
    expect(measure).toHaveBeenCalledTimes(1)
    expect(cached(packageDir)).toBe(measure.mock.results[0]!.value)
  })

  it('bounds the remembered directories', () => {
    const cacheRoot = temporaryDirectory()
    const cachePath = join(cacheRoot, DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME)
    const measure = vi.fn(computeDesktopBootTreeRootDigest)
    const cached = createCachedDesktopBootTreeRootDigestMeasure(cachePath, { measure, maxEntries: 2 })
    const dirs = [installedPackage(defaultFiles), installedPackage(defaultFiles), installedPackage(defaultFiles)]

    for (const dir of dirs) cached(dir)
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(persisted).sort()).toEqual([dirs[1]!, dirs[2]!].sort())
  })

  it('keeps the stat fingerprint sensitive to metadata-only tree changes', () => {
    const packageDir = installedPackage(defaultFiles)
    const before = desktopBootTreeStatFingerprint(packageDir)
    const touched = new Date('2027-01-01T00:00:00.000Z')
    utimesSync(join(packageDir, 'lib', 'payload.js'), touched, touched)

    const after = desktopBootTreeStatFingerprint(packageDir)
    expect(after.size).toBe(before.size)
    expect(after.mtime).not.toBe(before.mtime)
  })
})

describe('locked boot verification production inputs', () => {
  const originPolicy = {
    companyCatalogOrigin: 'https://market.company.example',
    companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
  }

  function settingsFixture(home: string): string {
    mkdirSync(home, { recursive: true })
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, JSON.stringify({
      'dsh-community-market': { installReceipts: [marketV2Receipt()] },
    }))
    return settingsPath
  }

  it('fetches origin-mode manifest bytes once before profile composition', async () => {
    const settingsPath = settingsFixture(join(temporaryDirectory(), 'home'))
    const manifest = signedManifestText([packageEntry()])
    const fetchManifestText = vi.fn(async () => manifest)
    const measureTreeRootDigest = vi.fn(computeDesktopBootTreeRootDigest)

    const inputs = await desktopBootVerificationInputs(
      originPolicy,
      settingsPath,
      pathToFileURL(import.meta.url).href,
      { fetchManifestText, measureTreeRootDigest },
    )

    expect(fetchManifestText).toHaveBeenCalledTimes(1)
    expect(fetchManifestText).toHaveBeenCalledWith(originPolicy)
    expect(inputs.manifestBytes).toBe(manifest)
    expect(inputs.receipts).toEqual([{
      packageName,
      version,
      manifestSequence,
      keyId,
      rootDigest: 'ab'.repeat(32),
    }])
    expect(inputs.measureTreeRootDigest).toBe(measureTreeRootDigest)
  })

  it('fails closed on origin fetch failures while content mode never fetches', async () => {
    const settingsPath = settingsFixture(join(temporaryDirectory(), 'home'))
    const fetchManifestText = vi.fn(async () => { throw new Error('unreachable') })

    const originInputs = await desktopBootVerificationInputs(
      originPolicy,
      settingsPath,
      pathToFileURL(import.meta.url).href,
      { fetchManifestText },
    )
    expect(originInputs.manifestBytes).toBeUndefined()
    expect(originInputs.receipts).toHaveLength(1)
    fetchManifestText.mockClear()

    const contentHome = temporaryDirectory()
    const contentModuleUrl = pathToFileURL(join(contentHome, 'lib', 'boot-verification.js')).href
    const assetPath = companyManifestAssetPath('company-market/catalog-manifest.json', contentModuleUrl)
    mkdirSync(dirname(assetPath), { recursive: true })
    writeFileSync(assetPath, signedManifestText([packageEntry()]))
    const contentInputs = await desktopBootVerificationInputs(
      { companyCatalogOrigin: null, companyManifestUrl: 'company-market/catalog-manifest.json' },
      settingsFixture(join(temporaryDirectory(), 'content-home')),
      contentModuleUrl,
      { fetchManifestText },
    )
    expect(contentInputs.manifestBytes).toBe(signedManifestText([packageEntry()]))
    expect(fetchManifestText).not.toHaveBeenCalled()
  })
})

describe('cross-implementation tree digest parity', () => {
  /**
   * The market package's public export face does not re-export the install
   * tree-digest helper, so — like the existing market integration spec — the
   * measurement is imported straight from the sibling workspace source.
   */
  async function marketTreeDigestModule(): Promise<{
    computeInstallTreeDigest: (packageDir: string) => Promise<{ rootDigest: string }>
  }> {
    // The indirection through a URL keeps the sibling workspace source out of
    // the desktop typecheck program, matching the market integration spec.
    const moduleUrl = new URL('../../dsh-community-market/src/install/tree-digest.js', import.meta.url).href
    return await import(moduleUrl) as never
  }

  it('measures the same tree with the same root digest as the market install path', async () => {
    const dir = installedPackage({
      'package.json': `{"name":"${packageName}","version":"${version}"}\n`,
      'cordis.patch.yml': '- insert:\n    - id: safe-marker\n      name: dsh-plugin-safe\n',
      'lib/payload.js': 'export const marker = 1\n',
      'lib/nested/deep/util.js': 'export const util = 1\n',
      'assets/data.json': '{"k":1}\n',
      'assets/empty-dir/.keep': '',
    })
    symlinkSync('./assets/data.json', join(dir, 'assets', 'link-to-data'))

    const market = await marketTreeDigestModule()
    const measured = await market.computeInstallTreeDigest(dir)

    expect(measured.rootDigest).toBe(computeDesktopBootTreeRootDigest(dir))
  })

  it('keeps both serializations 64 lowercase hex so a rule change on either side turns this red', async () => {
    const dir = installedPackage({ 'package.json': '{}\n', 'lib/a.js': 'a\n', 'lib/b/c.js': 'c\n' })
    const market = await marketTreeDigestModule()
    const marketDigest = (await market.computeInstallTreeDigest(dir)).rootDigest
    const desktopDigest = computeDesktopBootTreeRootDigest(dir)

    expect(marketDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(desktopDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(marketDigest).toBe(desktopDigest)
  })
})

describe('controlled tarball file: lock pins (P7 2c)', () => {
  const CATALOG_ORIGIN = 'https://gitlab.company.example'
  const TARBALL_BYTES = Buffer.from('boot verification tarball fixture bytes\n')
  const TARBALL_INTEGRITY = `sha512-${createHash('sha512').update(TARBALL_BYTES).digest('base64')}`

  function filePinLockfile(
    profileDir: string,
    options: {
      readonly integrity?: string
      readonly specifier?: string
      readonly resolutionSpelling?: string
      readonly importerPeerSuffix?: string
    } = {},
  ): string {
    const stagedPath = desktopMarketTarballStagingPath(profileDir, packageName, version)
    const relativeStaged = relative(profileDir, stagedPath).split(sep).join('/')
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      `      '${packageName}':`,
      `        specifier: '${options.specifier ?? `file:${stagedPath}`}'`,
      // When the profile tree already pins resolvable peers, pnpm records
      // the peer resolution as a `(@peer@version)` suffix on the importer's
      // `file:` version while the `packages:`/`snapshots:` entries keep the
      // bare spelling (the real-machine shape behind 32bfaf522d).
      `        version: '${options.resolutionSpelling ?? `file:${relativeStaged}`}${options.importerPeerSuffix ?? ''}'`,
      'packages:',
      `  '${packageName}@file:${options.resolutionSpelling ?? relativeStaged}':`,
      '    resolution:',
      `      integrity: '${options.integrity ?? TARBALL_INTEGRITY}'`,
      '    version: ' + `'${version}'`,
      'snapshots:',
      `  '${packageName}@file:${options.resolutionSpelling ?? relativeStaged}': {}`,
      '',
    ].join('\n'))
    return stagedPath
  }

  function writeStagedTarball(stagedPath: string, bytes: Buffer = TARBALL_BYTES): void {
    mkdirSync(dirname(stagedPath), { recursive: true })
    writeFileSync(stagedPath, bytes)
  }

  it('recognizes an intact controlled pin and returns the recorded tarball sha512', () => {
    const profileDir = temporaryDirectory()
    const stagedPath = filePinLockfile(profileDir)
    writeStagedTarball(stagedPath)
    const lockfile = readDesktopBootLockfile(profileDir)!
    expect(lockfile).toBeDefined()
    // Strict form: the exact deterministic staging path inside the profile.
    expect(desktopBootLockIntegrity(lockfile, packageName, version, { profileDir })).toBe(TARBALL_INTEGRITY)
    // Structural form (direct unit use without the profile directory).
    expect(desktopBootLockIntegrity(lockfile, packageName, version)).toBe(TARBALL_INTEGRITY)
    // A different package or version never matches this pin.
    expect(desktopBootLockIntegrity(lockfile, packageName, '9.9.9', { profileDir })).toBeUndefined()
    expect(desktopBootLockIntegrity(lockfile, 'other-plugin', version, { profileDir })).toBeUndefined()
  })

  it('tolerates a pnpm peer suffix on the importer file: resolution', () => {
    // The real-machine shape of a profile whose tree already pins a peer of
    // the staged tarball: the importer's recorded `file:` resolution carries
    // the `(@peer@version)` suffix while the `packages:` entry stays keyed
    // by the bare spelling — the pin still binds the exact staged bytes, so
    // the boot decision must recognize it instead of silently rejecting the
    // bundle as `no-lock-integrity`.
    const profileDir = temporaryDirectory()
    const stagedPath = filePinLockfile(profileDir, { importerPeerSuffix: '(@deepseek-ai/schemastery@3.18.2)' })
    writeStagedTarball(stagedPath)
    const lockfile = readDesktopBootLockfile(profileDir)!
    expect(lockfile).toBeDefined()
    // Strict form: the exact deterministic staging path inside the profile.
    expect(desktopBootLockIntegrity(lockfile, packageName, version, { profileDir })).toBe(TARBALL_INTEGRITY)
    // Structural form (direct unit use without the profile directory).
    expect(desktopBootLockIntegrity(lockfile, packageName, version)).toBe(TARBALL_INTEGRITY)
  })

  it('still refuses a peer-suffixed pin whose lockfile integrity truly diverges', () => {
    const profileDir = temporaryDirectory()
    const stagedPath = filePinLockfile(profileDir, {
      importerPeerSuffix: '(@deepseek-ai/schemastery@3.18.2)',
      // The suffix tolerance must not loosen the byte-for-byte binding: the
      // lockfile pins some other sha512, so the pin proves nothing.
      integrity: `sha512-${createHash('sha512').update(Buffer.from('some other staged bytes\n')).digest('base64')}`,
    })
    writeStagedTarball(stagedPath)
    const lockfile = readDesktopBootLockfile(profileDir)!
    expect(desktopBootLockIntegrity(lockfile, packageName, version, { profileDir })).toBeUndefined()
    expect(desktopBootControlledTarballPinProblem(lockfile, packageName, version, { profileDir })).toBeDefined()
  })

  it('returns nothing for a file: pin that is not the deterministic staged path', () => {
    const profileDir = temporaryDirectory()
    // A tarball path outside the staging directory entirely.
    const rogue = join(profileDir, 'rogue-plugin-1.2.3.tgz')
    writeFileSync(rogue, TARBALL_BYTES)
    const stagedPath = filePinLockfile(profileDir, { specifier: `file:${rogue}` })
    writeStagedTarball(stagedPath)
    const lockfile = readDesktopBootLockfile(profileDir)!
    expect(desktopBootLockIntegrity(lockfile, packageName, version, { profileDir })).toBeUndefined()
    expect(desktopBootControlledTarballPinProblem(lockfile, packageName, version, { profileDir })).toBeUndefined()

    // A staged-path basename for a different version, still inside the same
    // profile's staging directory and hashing to the pinned bytes, is
    // equally refused: the recognized pin is the deterministic path of
    // exactly this (packageName, version), never a same-directory sibling.
    const wrongVersionPath = desktopMarketTarballStagingPath(profileDir, packageName, '9.9.9')
    writeStagedTarball(wrongVersionPath)
    filePinLockfile(profileDir, {
      specifier: `file:${wrongVersionPath}`,
      resolutionSpelling: relative(profileDir, wrongVersionPath).split(sep).join('/'),
    })
    const wrongVersionLock = readDesktopBootLockfile(profileDir)!
    expect(desktopBootLockIntegrity(wrongVersionLock, packageName, version, { profileDir })).toBeUndefined()
    expect(desktopBootLockIntegrity(wrongVersionLock, packageName, version)).toBeUndefined()
    // Not a recognized pin of this version: the generic lockfile rejection
    // applies, never the controlled-channel repair reason.
    expect(desktopBootControlledTarballPinProblem(wrongVersionLock, packageName, version, { profileDir })).toBeUndefined()
  })

  it('fails the pin when the staged file is missing or no longer hashes to the pinned sha512', () => {
    const missing = temporaryDirectory()
    filePinLockfile(missing)
    const missingLock = readDesktopBootLockfile(missing)!
    expect(desktopBootLockIntegrity(missingLock, packageName, version, { profileDir: missing })).toBeUndefined()
    // The pointed repair reason names the controlled channel and the staged path.
    const problem = desktopBootControlledTarballPinProblem(missingLock, packageName, version, { profileDir: missing })
    expect(problem).toContain('controlled company tarball channel')
    expect(problem).toContain(desktopMarketTarballStagingPath(missing, packageName, version))
    expect(problem).toContain('reinstall the plugin from the company market')

    const tampered = temporaryDirectory()
    const stagedPath = filePinLockfile(tampered)
    writeStagedTarball(stagedPath, Buffer.from('tampered staged bytes\n'))
    const tamperedLock = readDesktopBootLockfile(tampered)!
    expect(desktopBootLockIntegrity(tamperedLock, packageName, version, { profileDir: tampered })).toBeUndefined()
    expect(desktopBootControlledTarballPinProblem(tamperedLock, packageName, version, { profileDir: tampered })).toBeDefined()
  })

  it('collects the pointed lock problem and rejects only that bundle, never the whole boot', () => {
    const profileDir = temporaryDirectory()
    filePinLockfile(profileDir)
    // The installed package exists and reports its version; only the staged
    // tarball is gone (the GC/loss negative).
    const packageDir = join(profileDir, 'node_modules', packageName)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), `{"name":"${packageName}","version":"${version}"}\n`)
    const [tarballBundle, npmBundle] = collectDesktopBootBundles(profileDir, [packageName, 'other-plugin'])
    expect(tarballBundle?.lockIntegrity).toBeUndefined()
    expect(tarballBundle?.lockProblem).toContain('reinstall the plugin from the company market')
    expect(npmBundle?.lockProblem).toBeUndefined()

    const manifest = signedManifestText([
      packageEntry({ integrity: TARBALL_INTEGRITY }),
      {
        packageName: 'other-plugin',
        version: '2.0.0',
        integrity: otherIntegrity,
        bundlePatch: './cordis.patch.yml',
        repository: { url: 'https://github.com/example/other-plugin' },
        revoked: false,
        runtime: { dshRuntimeVersion: '*' },
      },
    ])
    const otherDir = join(temporaryDirectory(), 'node_modules', 'other-plugin')
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, 'package.json'), '{"name":"other-plugin","version":"2.0.0"}\n')
    const result = verify(manifest, [
      tarballBundle!,
      { packageName: 'other-plugin', version: '2.0.0', lockIntegrity: otherIntegrity, packageDir: otherDir },
    ])
    expect(result.allowed).toEqual([
      { packageName: 'other-plugin', evidence: 'manifest-only', manifestSequence, keyId },
    ])
    expect(result.rejected).toEqual([{
      packageName,
      reason: expect.stringContaining('reinstall the plugin from the company market') as unknown as string,
      code: 'no-lock-integrity',
      installedVersion: version,
    }])
  })

  it('verifies a file:-pinned bundle end to end against the signed tree digest', () => {
    const profileDir = temporaryDirectory()
    const stagedPath = filePinLockfile(profileDir)
    writeStagedTarball(stagedPath)
    const packageDir = installedPackage(defaultFiles)
    const manifest = signedManifestText([
      packageEntry({
        integrity: TARBALL_INTEGRITY,
        treeDigest: computeDesktopBootTreeRootDigest(packageDir),
        source: { kind: 'tarball', url: `${CATALOG_ORIGIN}/p/${packageName}-${version}.tgz`, integrity: TARBALL_INTEGRITY },
      }),
    ])
    const bundle = bundleInput({
      lockIntegrity: desktopBootLockIntegrity(readDesktopBootLockfile(profileDir)!, packageName, version, { profileDir }),
      packageDir,
    })
    expect(bundle.lockIntegrity).toBe(TARBALL_INTEGRITY)
    const result = verify(manifest, [bundle], { companyCatalogOrigin: CATALOG_ORIGIN })
    expect(result.rejected).toEqual([])
    expect(result.allowed).toEqual([{ packageName, evidence: 'signed-tree', manifestSequence, keyId }])
  })
})
