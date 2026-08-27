import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import {
  BOOT_TREE_MAX_PATH_LENGTH,
  createCachedDesktopBootTreeRootDigestMeasure,
  collectDesktopBootBundles,
  companyManifestAssetPath,
  computeDesktopBootTreeRootDigest,
  desktopBootBundleNames,
  desktopBootLockIntegrity,
  desktopBootReceipts,
  desktopBootTreeStatFingerprint,
  desktopBootVerificationInputs,
  desktopBootVerificationInputsFromSettings,
  DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME,
  marketInstallReceiptsFromSettingsDocument,
  readCompanyManifestAsset,
  readDesktopBootLockfile,
  readDesktopBootReceiptsFromSettings,
  verifyDesktopBootBundles,
  type DesktopBootBundle,
  type DesktopBootReceipt,
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
  options: { receipts?: readonly DesktopBootReceipt[]; lastSeenSequence?: number; now?: () => number } = {},
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
    }])
  })

  it('rejects a bundle whose tree cannot be measured', () => {
    const bundle = bundleInput({ packageDir: join(temporaryDirectory(), 'missing') })
    const result = verify(signedManifestText([packageEntry()]), [bundle], {
      receipts: [receiptFor({ ...bundle, packageDir: installedPackage(defaultFiles) })],
    })
    expect(result.rejected[0]?.reason).toContain('could not be measured')
  })

  it('rejects absent, misversioned, and revoked manifest entries', () => {
    const absent = verify(signedManifestText([]), [bundleInput()])
    expect(absent.rejected[0]?.reason).toBe(`${packageName}@${version} is not in the signed company manifest`)

    const otherVersion = verify(signedManifestText([packageEntry({ version: '2.0.0' })]), [bundleInput()])
    expect(otherVersion.rejected[0]?.reason).toBe(
      `the signed company manifest pins ${packageName}@2.0.0, but ${version} is installed`,
    )

    const revoked = verify(signedManifestText([packageEntry({ revoked: true })]), [bundleInput()])
    expect(revoked.rejected[0]?.reason).toBe(`${packageName}@${version} is revoked in the signed company manifest`)
  })

  it('rejects unresolvable bundles and missing or diverging lock integrity', () => {
    const unresolvable = verify(signedManifestText([packageEntry()]), [bundleInput({ packageDir: undefined, version: undefined })])
    expect(unresolvable.rejected[0]?.reason).toContain('cannot be resolved as an installed package')

    const unpinned = verify(signedManifestText([packageEntry()]), [bundleInput({ lockIntegrity: undefined })])
    expect(unpinned.rejected[0]?.reason).toContain('no exact pinned record in the profile lockfile')

    const diverging = verify(signedManifestText([packageEntry()]), [bundleInput({ lockIntegrity: otherIntegrity })])
    expect(diverging.rejected[0]?.reason).toBe(
      `the profile lockfile pins ${packageName}@${version} to integrity ${otherIntegrity}, but the signed company manifest pins ${signedIntegrity}`,
    )
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
        { packageName, reason: expect.stringContaining('manifest-missing') },
        { packageName: 'second-plugin', reason: expect.stringContaining('manifest-missing') },
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
    const floored = verify(signedManifestText([packageEntry()]), [bundle], { lastSeenSequence: manifestSequence })
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

describe('boot verification target selection', () => {
  it('exempts upstream, desktop, and market bundles from verification', () => {
    const declared = [
      ...(PROFILE_TEMPLATES.web ?? []),
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
