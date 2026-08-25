import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { FuseV1Options } from '@electron/fuses'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import {
  afterPack,
  BUNDLED_NODE_RESOURCE_DIRECTORY,
  REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES,
  REQUIRED_ELECTRON_FUSES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_RUN_AS_NODE_FUSE,
  REQUIRED_UNPACKED_PACKAGE_SPECIFIERS,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolveBundledNodeResourcePath,
  resolvePackagedAsarPath,
  resolvePackagedExecutablePath,
  resolvePackagedResourcesDirectory,
  resolvePackagedUnpackedRoot,
  readCompanyReleaseChecklistSources,
  readPackagedElectronFuses,
  readPackagedRunAsNodeFuse,
  smokePackagedDiagnosticWorker,
  UPDATE_TRUST_ROOTS_DEVELOPMENT_MARKER,
  verifyArchiveOnlyPartition,
  verifyBundledNodeRuntime,
  verifyCompanyReleaseChecklist,
  verifyElectronFuseStage,
  verifyElectronFuseWire,
  verifyPackagedFuseWire,
  verifyRunAsNodeFuseStage,
  verifyUnpackedArchiveMirror,
  verifyPackagedRuntime,
  type ArchiveLister,
  type CompanyReleaseChecklistSources,
  type FileProbe,
  type PackageResolver,
  type PackagedRuntimeContext,
  type PackagedDiagnosticWorkerLauncher,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_UNIVERSAL_ENTRIES } from '../scripts/mac-universal.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'DSH Desktop' } },
  }
}

/** Fuse wire bytes: `'0'` disabled, `'1'` enabled (see @electron/fuses). */
const FUSE_DISABLED = 0x30
const FUSE_ENABLED = 0x31
const FUSE_REMOVED = 0x72

/** Fuse wire a correctly staged binary carries, keyed by `FuseV1Options`. */
function requiredFuseWire(): Record<string, unknown> {
  return {
    version: '1',
    [FuseV1Options.RunAsNode]: FUSE_DISABLED,
    [FuseV1Options.EnableCookieEncryption]: FUSE_ENABLED,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FUSE_DISABLED,
    [FuseV1Options.EnableNodeCliInspectArguments]: FUSE_DISABLED,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FUSE_ENABLED,
    [FuseV1Options.OnlyLoadAppFromAsar]: FUSE_ENABLED,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: FUSE_DISABLED,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: FUSE_DISABLED,
  }
}

function completeArchiveEntries(separator = '/'): string[] {
  return [
    ...REQUIRED_PACKAGED_RUNTIME_ENTRIES,
    ...REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES,
  ].map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

function completePackageResolver(unpackedRoot: string): PackageResolver {
  return specifier => join(unpackedRoot, 'resolved', `${specifier.replaceAll('/', '-')}.js`)
}

/** File probe for success paths: everything physical except the archive-only assets. */
function completeFileProbe(unpackedRoot: string): FileProbe {
  return filename => !REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES
    .some(entry => filename === join(unpackedRoot, entry))
}

const catalogKeyId = 'company-catalog-2026.01'
const catalogKeys = generateKeyPairSync('ed25519')
const catalogTrustRoots = [{
  keyId: catalogKeyId,
  fingerprint: ed25519PublicKeyFingerprint(catalogKeys.publicKey),
}]

/** Real signed catalog manifest text for the checklist's embedded-asset gate. */
function signedCatalogManifest(overrides: Record<string, unknown> = {}): string {
  const manifest = {
    manifestVersion: '1.0.0',
    sequence: 7,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [{
      packageName: 'dsh-plugin-safe',
      version: '1.0.0',
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      bundlePatch: './cordis.patch.yml',
      repository: { url: 'https://github.com/example/dsh-plugin-safe' },
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    }],
    ...overrides,
  }
  const signature = createCompanyManifestSignature(
    manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    catalogKeys.privateKey,
    catalogKeyId,
  )
  return canonicalJsonText({ ...manifest, signature })
}

/** Fully provisioned release policy for checklist success fixtures. */
function provisionedReleasePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    locked: true,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    trustRoots: catalogTrustRoots,
    ...overrides,
  }
}

describe('packaged desktop runtime verification', () => {
  it('fails the diagnostic Worker smoke when its archive omits the crash dump', async () => {
    const unpackedRoot = resolvePackagedUnpackedRoot(context('/build', 'win32'))
    const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (_workerPath, workerData) => {
      const outDir = join(workerData.userDataDir, 'diagnostics')
      mkdirSync(outDir)
      const output = join(outDir, 'diagnostics-smoke.zip')
      const zip = new AdmZip()
      zip.addFile('system-info.txt', Buffer.from('no dump\n'))
      zip.writeZip(output)
      return output
    })

    await expect(smokePackagedDiagnosticWorker(unpackedRoot, launch))
      .rejects.toThrow('packaged diagnostic worker omitted crash-dumps/pending/packaged-smoke.dmp')
  })

  it.each(['darwin', 'win32'])(
    'targets the physical diagnostic Worker in the %s unpacked layout and removes smoke files',
    async (platform) => {
      const unpackedRoot = resolvePackagedUnpackedRoot(context('/build', platform))
      let smokeRoot: string | undefined
      const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (workerPath, workerData) => {
        smokeRoot = join(workerData.logsDir, '..')
        expect(workerPath).toBe(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'))
        expect(readFileSync(join(workerData.logsDir, 'dsh-2000-01-01.log'), 'utf8'))
          .toBe('packaged worker smoke\n')
        expect(workerData.appVersion).toBe('packaged-smoke')
        expect(workerData.maxEvidenceBytes).toBe(1024)
        const crashDump = readFileSync(join(workerData.crashDumpsDir, 'pending', 'packaged-smoke.dmp'))
        expect(crashDump.toString('utf8')).toBe('packaged crash dump smoke\n')
        const outDir = join(workerData.userDataDir, 'diagnostics')
        mkdirSync(outDir)
        const output = join(outDir, 'diagnostics-smoke.zip')
        const zip = new AdmZip()
        zip.addFile('crash-dumps/pending/packaged-smoke.dmp', crashDump)
        zip.writeZip(output)
        return output
      })

      await smokePackagedDiagnosticWorker(unpackedRoot, launch)

      expect(launch).toHaveBeenCalledOnce()
      expect(smokeRoot).toBeDefined()
      expect(existsSync(smokeRoot as string)).toBe(false)
    },
  )

  it('runs the static, bundled-Node, fuse, and release-checklist gates before the diagnostic Worker smoke', async () => {
    const runtimeContext = context('/build', 'win32')
    const calls: string[] = []

    await afterPack(
      runtimeContext,
      () => { calls.push('static') },
      async (unpackedRoot) => { calls.push(unpackedRoot) },
      {
        exists: filename => {
          calls.push(filename)
          return true
        },
        readFuses: () => {
          calls.push('fuse')
          return REQUIRED_ELECTRON_FUSES
        },
        readFuseWire: async executablePath => {
          calls.push(`wire:${executablePath}`)
          return requiredFuseWire()
        },
        flipFuseWire: async executablePath => {
          calls.push(`flip:${executablePath}`)
          return 0
        },
      },
      () => { calls.push('checklist') },
    )

    expect(calls).toEqual([
      'static',
      join('/build', 'resources', BUNDLED_NODE_RESOURCE_DIRECTORY, 'node.exe'),
      'fuse',
      `flip:${join('/build', 'DSH Desktop.exe')}`,
      `wire:${join('/build', 'DSH Desktop.exe')}`,
      'checklist',
      resolvePackagedUnpackedRoot(runtimeContext),
    ])
  })

  it('rejects the package when the company release checklist fails', async () => {
    const runtimeContext = context('/build', 'win32')
    const failing = () => { throw new Error('checklist rejected this build') }

    await expect(afterPack(
      runtimeContext,
      () => {},
      async () => {},
      { exists: () => true, readFuses: () => REQUIRED_ELECTRON_FUSES, flipFuseWire: async () => 0, readFuseWire: async () => requiredFuseWire() },
      failing,
    )).rejects.toThrow('checklist rejected this build')
  })

  it('rejects the package when the binary fuse wire deviates from the release posture', async () => {
    const runtimeContext = context('/build', 'win32')

    await expect(afterPack(
      runtimeContext,
      () => {},
      async () => {},
      {
        exists: () => true,
        readFuses: () => REQUIRED_ELECTRON_FUSES,
        flipFuseWire: async () => 0,
        readFuseWire: async () => ({
          ...requiredFuseWire(),
          [FuseV1Options.RunAsNode]: FUSE_ENABLED,
        }),
      },
      () => {},
    )).rejects.toThrow('runAsNode: binary=ENABLE required=false')
  })

  it('reads and verifies the fuse wire of the packaged application binary', async () => {
    expect(resolvePackagedExecutablePath(context('/build', 'darwin'))).toBe(
      join('/build', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop'),
    )
    expect(resolvePackagedExecutablePath(context('/build', 'win32'))).toBe(
      join('/build', 'DSH Desktop.exe'),
    )
    expect(resolvePackagedExecutablePath(context('/build', 'linux'))).toBe(
      join('/build', 'dsh-plugin-desktop'),
    )

    expect(() => verifyElectronFuseWire(requiredFuseWire())).not.toThrow()
    expect(() => verifyElectronFuseWire({
      ...requiredFuseWire(),
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FUSE_DISABLED,
    })).toThrow('enableEmbeddedAsarIntegrityValidation: binary=DISABLE required=true')
    // REMOVED and INHERIT are not acceptable wire states either.
    expect(() => verifyElectronFuseWire({
      ...requiredFuseWire(),
      [FuseV1Options.OnlyLoadAppFromAsar]: FUSE_REMOVED,
    })).toThrow('onlyLoadAppFromAsar: binary=REMOVED required=true')
    expect(() => verifyElectronFuseWire({ ...requiredFuseWire(), version: '2' }))
      .toThrow('fuse wire version')

    // The hook stages the required wire itself (Electron Builder flips only
    // after custom afterPack hooks) and then reads it back.
    const flip = vi.fn(async () => 0)
    const read = vi.fn(async () => requiredFuseWire())
    await verifyPackagedFuseWire(context('/build', 'win32'), read, flip)
    expect(flip).toHaveBeenCalledWith(join('/build', 'DSH Desktop.exe'))
    expect(read).toHaveBeenCalledWith(join('/build', 'DSH Desktop.exe'))

    await expect(verifyPackagedFuseWire(context('/build', 'win32'), async () => {
      throw new Error('sentinel missing')
    }, async () => 0)).rejects.toThrow('failed to read the fuse wire')
    await expect(verifyPackagedFuseWire(context('/build', 'win32'), async () => requiredFuseWire(), async () => {
      throw new Error('readonly filesystem')
    })).rejects.toThrow('failed to stage the required fuse wire')
  })

  it('requires the bundled Node command beside the packaged app.asar', () => {
    const runtimeContext = context('/build', 'win32')
    const nodePath = resolveBundledNodeResourcePath(runtimeContext)

    expect(nodePath).toBe(join('/build', 'resources', 'node-runtime', 'node.exe'))
    expect(resolveBundledNodeResourcePath(context('/build', 'darwin')))
      .toBe(join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'node-runtime', 'node'))
    expect(resolvePackagedResourcesDirectory(runtimeContext)).toBe(join('/build', 'resources'))
    expect(() => verifyBundledNodeRuntime(runtimeContext, () => false))
      .toThrow(`missing the bundled Node command: ${nodePath}`)
    expect(verifyBundledNodeRuntime(runtimeContext, filename => filename === nodePath)).toBe(nodePath)
  })

  it('reads and enforces the staged Electron fuse map', () => {
    expect(REQUIRED_ELECTRON_FUSES).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    })
    expect(REQUIRED_RUN_AS_NODE_FUSE).toBe(false)
    expect(() => verifyElectronFuseStage(REQUIRED_ELECTRON_FUSES)).not.toThrow()
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, runAsNode: true }))
      .toThrow('requires electronFuses.runAsNode=false')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, enableCookieEncryption: false }))
      .toThrow('requires electronFuses.enableCookieEncryption=true')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, enableNodeOptionsEnvironmentVariable: true }))
      .toThrow('requires electronFuses.enableNodeOptionsEnvironmentVariable=false')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, enableNodeCliInspectArguments: true }))
      .toThrow('requires electronFuses.enableNodeCliInspectArguments=false')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, enableEmbeddedAsarIntegrityValidation: false }))
      .toThrow('requires electronFuses.enableEmbeddedAsarIntegrityValidation=true')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, onlyLoadAppFromAsar: false }))
      .toThrow('requires electronFuses.onlyLoadAppFromAsar=true')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, loadBrowserProcessSpecificV8Snapshot: true }))
      .toThrow('requires electronFuses.loadBrowserProcessSpecificV8Snapshot=false')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, grantFileProtocolExtraPrivileges: true }))
      .toThrow('requires electronFuses.grantFileProtocolExtraPrivileges=false')
    // The P3-1 single-fuse verifier keeps its contract for direct callers.
    expect(() => verifyRunAsNodeFuseStage(REQUIRED_RUN_AS_NODE_FUSE)).not.toThrow()
    expect(() => verifyRunAsNodeFuseStage(!REQUIRED_RUN_AS_NODE_FUSE))
      .toThrow(`requires electronFuses.runAsNode=${String(REQUIRED_RUN_AS_NODE_FUSE)}`)

    // The live Electron Builder configuration wins over the repository manifest.
    const configured = { runAsNode: true, onlyLoadAppFromAsar: false }
    expect(readPackagedElectronFuses({
      appInfo: { productFilename: 'DSH Desktop' },
      config: { electronFuses: configured },
    })).toEqual(configured)
    expect(readPackagedRunAsNodeFuse({
      appInfo: { productFilename: 'DSH Desktop' },
      config: { electronFuses: configured },
    })).toBe(true)

    // Without a live configuration the repository manifest is the fallback.
    const root = mkdtempSync(join(tmpdir(), 'dsh-fuse-stage-'))
    try {
      const manifestPath = join(root, 'package.json')
      writeFileSync(
        manifestPath,
        JSON.stringify({ build: { electronFuses: REQUIRED_ELECTRON_FUSES } }),
      )
      const readManifest = () => readFileSync(manifestPath, 'utf8')
      expect(readPackagedElectronFuses(
        { appInfo: { productFilename: 'DSH Desktop' } },
        readManifest,
      )).toEqual(REQUIRED_ELECTRON_FUSES)
      expect(readPackagedRunAsNodeFuse(
        { appInfo: { productFilename: 'DSH Desktop' } },
        readManifest,
      )).toBe(REQUIRED_RUN_AS_NODE_FUSE)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a provisioned-roots build that omits the packaged catalog manifest asset', () => {
    const runtimeContext = context('/build', 'win32')
    const readPackagedFile = (filename: string) => {
      if (filename === join(resolvePackagedUnpackedRoot(runtimeContext), 'lib', 'policy', 'desktop-policy.json')) {
        return readFileSync(new URL('../src/policy/desktop-policy.release.json', import.meta.url), 'utf8')
      }
      throw new Error(`unexpected packaged read: ${filename}`)
    }

    // The release policy now ships the pinned company trust root, so the L2
    // checklist advances past key provisioning and stops at the next gap:
    // content-mode builds must package the signed manifest asset.
    expect(() => verifyCompanyReleaseChecklist(
      readCompanyReleaseChecklistSources(runtimeContext, undefined, readPackagedFile),
    )).toThrow('content-mode release builds must embed the company catalog manifest')
  })

  it('accepts a provisioned repository as a company release candidate', () => {
    const manifestText = signedCatalogManifest()

    expect(() => verifyCompanyReleaseChecklist({
      manifestFuses: REQUIRED_ELECTRON_FUSES,
      releasePolicy: provisionedReleasePolicy(),
      packagedPolicy: provisionedReleasePolicy(),
      packagedManifestText: manifestText,
      updateVerificationSource: `export const ARTIFACT_TRUST_ROOTS: readonly UpdateChannelTrustRoot[] = [{ keyId: 'release-2026', fingerprint: '${'a'.repeat(64)}' }]`,
      electronRuntimeSource: [
        "get sequenceStatePath() { return desktopUpdateSequenceStatePath(app.getPath('userData')) }",
        'verification: { sequenceStatePath },',
      ].join('\n'),
      updateLifecycleSource: 'updateChannel: { sequenceStatePath: this.options.adapter.sequenceStatePath },',
    })).not.toThrow()
  })

  it('reads the checklist sources from injectable repository and packaged files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-release-checklist-'))
    try {
      mkdirSync(join(root, 'src', 'policy'), { recursive: true })
      mkdirSync(join(root, 'app.asar.unpacked', 'lib', 'policy'), { recursive: true })
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ build: { electronFuses: REQUIRED_ELECTRON_FUSES } }),
      )
      const releasePolicyText = `${JSON.stringify({ locked: true, trustRoots: [] })}\n`
      writeFileSync(join(root, 'src', 'policy', 'desktop-policy.release.json'), releasePolicyText)
      writeFileSync(
        join(root, 'app.asar.unpacked', 'lib', 'policy', 'desktop-policy.json'),
        releasePolicyText,
      )
      writeFileSync(join(root, 'src', 'update-verification.ts'), '// placeholder source\n')
      writeFileSync(join(root, 'src', 'electron-runtime.ts'), '// placeholder source\n')
      writeFileSync(join(root, 'src', 'update-lifecycle.ts'), '// placeholder source\n')
      const read = (relativePath: string) => readFileSync(join(root, relativePath), 'utf8')
      const packagedPolicyPath = join(root, 'app.asar.unpacked', 'lib', 'policy', 'desktop-policy.json')
      const readPackagedFile = (filename: string) => {
        expect(filename).toBe(join('/build', 'resources', 'app.asar.unpacked', 'lib', 'policy', 'desktop-policy.json'))
        return readFileSync(packagedPolicyPath, 'utf8')
      }

      const sources = readCompanyReleaseChecklistSources(
        context('/build', 'win32'),
        read,
        readPackagedFile,
      )
      expect(sources.manifestFuses).toEqual(REQUIRED_ELECTRON_FUSES)
      expect(sources.releasePolicy).toEqual({ locked: true, trustRoots: [] })
      expect(sources.packagedPolicy).toEqual({ locked: true, trustRoots: [] })
      expect(sources.packagedManifestText).toBeUndefined()
      expect(sources.updateVerificationSource).toBe('// placeholder source\n')
      expect(sources.electronRuntimeSource).toBe('// placeholder source\n')
      expect(sources.updateLifecycleSource).toBe('// placeholder source\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the packaged company manifest for content-mode release policies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-release-checklist-manifest-'))
    try {
      const manifestText = signedCatalogManifest()
      mkdirSync(join(root, 'src', 'policy'), { recursive: true })
      mkdirSync(join(root, 'app.asar.unpacked', 'lib', 'company-market'), { recursive: true })
      writeFileSync(
        join(root, 'app.asar.unpacked', 'lib', 'company-market', 'catalog-manifest.json'),
        manifestText,
      )
      writeFileSync(
        join(root, 'src', 'policy', 'desktop-policy.release.json'),
        `${JSON.stringify(provisionedReleasePolicy())}\n`,
      )
      writeFileSync(join(root, 'src', 'update-verification.ts'), '// placeholder source\n')
      writeFileSync(join(root, 'src', 'electron-runtime.ts'), '// placeholder source\n')
      writeFileSync(join(root, 'src', 'update-lifecycle.ts'), '// placeholder source\n')
      const sources = readCompanyReleaseChecklistSources(
        context('/build', 'win32'),
        relativePath => readFileSync(join(root, relativePath), 'utf8'),
        filename => {
          if (filename === join('/build', 'resources', 'app.asar.unpacked', 'lib', 'company-market', 'catalog-manifest.json')) {
            return manifestText
          }
          if (filename === join('/build', 'resources', 'app.asar.unpacked', 'lib', 'policy', 'desktop-policy.json')) {
            return `${JSON.stringify(provisionedReleasePolicy())}\n`
          }
          throw new Error(`unexpected packaged read: ${filename}`)
        },
      )
      expect(sources.packagedManifestText).toBe(manifestText)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('enforces every company release checklist item', () => {
    const wiredRuntimeSource = [
      "get sequenceStatePath() { return desktopUpdateSequenceStatePath(app.getPath('userData')) }",
      'verification: { sequenceStatePath },',
    ].join('\n')
    const wiredLifecycleSource = [
      'return await checkForStableUpdate({',
      'updateChannel: { sequenceStatePath: this.options.adapter.sequenceStatePath },',
      '})',
    ].join('\n')
    const markedTrustRootsSource = [
      '/** doc */',
      'export const ARTIFACT_TRUST_ROOTS: readonly UpdateChannelTrustRoot[] = [] // development placeholder',
    ].join('\n')
    const complete = (): CompanyReleaseChecklistSources => ({
      manifestFuses: { ...REQUIRED_ELECTRON_FUSES },
      releasePolicy: provisionedReleasePolicy(),
      packagedPolicy: provisionedReleasePolicy(),
      packagedManifestText: signedCatalogManifest(),
      updateVerificationSource: markedTrustRootsSource,
      electronRuntimeSource: wiredRuntimeSource,
      updateLifecycleSource: wiredLifecycleSource,
    })

    expect(() => verifyCompanyReleaseChecklist(complete())).not.toThrow()

    // Pinned (non-empty) trust roots pass without the development marker.
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      updateVerificationSource: 'export const ARTIFACT_TRUST_ROOTS: readonly UpdateChannelTrustRoot[] = [{ keyId: \'release-2026\', fingerprint: \'a\'.repeat(64) }]',
    })).not.toThrow()

    // A multi-line pinned array passes, and a multi-line empty array without
    // the marker fails — the declaration matcher must cross line boundaries.
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      updateVerificationSource: [
        '/** doc */',
        'export const ARTIFACT_TRUST_ROOTS: readonly UpdateChannelTrustRoot[] = [',
        "  { keyId: 'release-2026', fingerprint: 'a'.repeat(64) },",
        ']',
      ].join('\n'),
    })).not.toThrow()
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      updateVerificationSource: [
        'export const ARTIFACT_TRUST_ROOTS: readonly UpdateChannelTrustRoot[] = [',
        '] as const',
      ].join('\n'),
    })).toThrow(`must carry the explicit "${UPDATE_TRUST_ROOTS_DEVELOPMENT_MARKER}" marker`)

    // A mistyped or missing fuse key fails even when every staged value matches.
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      manifestFuses: { ...REQUIRED_ELECTRON_FUSES, enableCookieEncrypton: true },
    })).toThrow('unexpected: enableCookieEncrypton; missing: none')
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      manifestFuses: { runAsNode: REQUIRED_ELECTRON_FUSES.runAsNode },
    })).toThrow('missing: enableCookieEncryption')

    expect(() => verifyCompanyReleaseChecklist({ ...complete(), releasePolicy: { locked: false } }))
      .toThrow('desktop-policy.release.json must exist with locked=true')
    expect(() => verifyCompanyReleaseChecklist({ ...complete(), releasePolicy: null }))
      .toThrow('desktop-policy.release.json must exist with locked=true')

    // The packaged tree must carry the same locked release policy (P3 fix).
    expect(() => verifyCompanyReleaseChecklist({ ...complete(), packagedPolicy: { locked: false } }))
      .toThrow('app.asar.unpacked/lib/policy/desktop-policy.json must exist with locked=true')
    expect(() => verifyCompanyReleaseChecklist({ ...complete(), packagedPolicy: null }))
      .toThrow('app.asar.unpacked/lib/policy/desktop-policy.json must exist with locked=true')
    // Empty placeholder roots now fail: a locked market without catalog
    // trust roots would browse a placeholder and reject every install.
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      releasePolicy: provisionedReleasePolicy({ trustRoots: [] }),
      packagedPolicy: provisionedReleasePolicy({ trustRoots: [] }),
    })).toThrow('must provision at least one catalog trust root')
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      releasePolicy: { locked: true, trustRoots: [{ keyId: 'company-2026', fingerprint: 'a'.repeat(64) }] },
      packagedPolicy: { locked: true, trustRoots: [] },
    })).toThrow('the packaged policy asset differs from src/policy/desktop-policy.release.json')

    // The catalog chain must be provisioned and verifiable (L2 / P0②).
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      releasePolicy: provisionedReleasePolicy({ trustRoots: [] }),
      packagedPolicy: provisionedReleasePolicy({ trustRoots: [] }),
    })).toThrow('must provision at least one catalog trust root')
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      releasePolicy: provisionedReleasePolicy({ trustRoots: 'nope' }),
      packagedPolicy: provisionedReleasePolicy({ trustRoots: 'nope' }),
    })).toThrow('must declare a trustRoots array')
    expect(() => verifyCompanyReleaseChecklist({ ...complete(), packagedManifestText: undefined }))
      .toThrow('content-mode release builds must embed the company catalog manifest at app.asar.unpacked/lib/company-market/catalog-manifest.json')
    expect(() => verifyCompanyReleaseChecklist({ ...complete(), packagedManifestText: 'not a manifest' }))
      .toThrow('did not verify against the policy trust roots (malformed-json)')
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      packagedManifestText: signedCatalogManifest({ expiresAt: '2026-01-01T00:00:00Z' }),
    })).toThrow('did not verify against the policy trust roots (expired)')
    // Origin-mode policies need no embedded asset, but still need the roots.
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      releasePolicy: provisionedReleasePolicy({
        companyCatalogOrigin: 'https://catalog.company.example',
        companyManifestUrl: 'https://catalog.company.example/manifest.json',
      }),
      packagedPolicy: provisionedReleasePolicy({
        companyCatalogOrigin: 'https://catalog.company.example',
        companyManifestUrl: 'https://catalog.company.example/manifest.json',
      }),
      packagedManifestText: undefined,
    })).not.toThrow()

    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      updateVerificationSource: 'export const ARTIFACT_TRUST_ROOTS: readonly UpdateChannelTrustRoot[] = []',
    })).toThrow(`must carry the explicit "${UPDATE_TRUST_ROOTS_DEVELOPMENT_MARKER}" marker`)
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      updateVerificationSource: 'export const OTHER = []',
    })).toThrow('no longer declares ARTIFACT_TRUST_ROOTS')

    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      electronRuntimeSource: 'get statePath() { return join(app.getPath(\'userData\'), \'updates/state.json\') }',
    })).toThrow('sequence state file must stay wired')
    expect(() => verifyCompanyReleaseChecklist({
      ...complete(),
      updateLifecycleSource: 'return await checkForStableUpdate({ currentVersion })',
    })).toThrow('sequence state file must stay wired')
  })

  it('tracks the ConPTY-only native surface shipped by node-pty 1.2', () => {
    expect(REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES).toEqual([
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    ])
  })

  it.each([
    [
      'darwin',
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries(platform === 'win32' ? '\\' : '/'))

    const unpackedRoot = `${expectedPath}.unpacked`
    const exists = vi.fn<FileProbe>(completeFileProbe(unpackedRoot))
    const resolvePackage = vi.fn<PackageResolver>(completePackageResolver(unpackedRoot))

    verifyPackagedRuntime(context('/build', platform), list, exists, resolvePackage)

    expect(resolvePackagedAsarPath(context('/build', platform))).toBe(expectedPath)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(unpackedRoot)
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + (platform === 'win32' ? REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES.length : 0)
        + REQUIRED_PACKAGED_RUNTIME_ENTRIES.length
        + REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES.length,
    )
    expect(resolvePackage.mock.calls.map(([specifier]) => specifier))
      .toEqual(REQUIRED_UNPACKED_PACKAGE_SPECIFIERS)
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('requires both CPU variants from a universal macOS runtime', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missing = 'node_modules/@vscode/ripgrep-darwin-x64/bin/rg'

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== join(unpackedRoot, missing),
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)

    const exists = vi.fn<FileProbe>(filename => !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .some(entry => filename === join(unpackedRoot, entry))
      && !REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES
        .some(entry => filename === join(unpackedRoot, entry)))
    verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      exists,
      completePackageResolver(unpackedRoot),
    )
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + REQUIRED_MACOS_UNIVERSAL_ENTRIES.length
        + FORBIDDEN_MACOS_UNIVERSAL_ENTRIES.length
        + REQUIRED_PACKAGED_RUNTIME_ENTRIES.length
        + REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES.length,
    )
  })

  it('rejects any ASAR-declared unpacked dependency missing from the physical tree', () => {
    const unpackedRoot = join('/build', 'resources', 'app.asar.unpacked')
    const missing = 'node_modules/yaml/dist/index.js'

    expect(() => verifyUnpackedArchiveMirror(
      new Set(['lib/main.js', missing, 'node_modules/zod/index.js']),
      unpackedRoot,
      filename => filename !== join(unpackedRoot, missing),
    )).toThrow(`missing ASAR-declared physical entries: ${missing}`)
  })

  it('keeps archive-only build assets out of the physical mirror requirement', () => {
    const unpackedRoot = join('/build', 'resources', 'app.asar.unpacked')

    // build/** entries — including the bare `build` directory header entry —
    // are in-archive only; the mirror must not demand them physically, and
    // the partition must reject a leaked physical copy.
    expect(() => verifyUnpackedArchiveMirror(
      new Set(['build', 'build/app-icon.png', 'build/tray-iconTemplate.png', 'lib/main.js']),
      unpackedRoot,
      filename => filename === join(unpackedRoot, 'lib', 'main.js'),
    )).not.toThrow()

    expect(() => verifyArchiveOnlyPartition(
      unpackedRoot,
      filename => filename === join(unpackedRoot, 'build', 'app-icon.png'),
    )).toThrow('archive-only runtime entries leaked into the physical tree')
  })

  it('rejects a shrunk archive-only asset that reappears inside app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const leaked = REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES[0]

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, leaked)
        || !REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES
          .some(entry => filename === join(unpackedRoot, entry)),
      completePackageResolver(unpackedRoot),
    )).toThrow(`archive-only runtime entries leaked into the physical tree at ${unpackedRoot}: ${leaked}`)
  })

  it('rejects a host-architecture node-pty build from a universal app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES[0]

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, forbidden)
        || !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
          .some(entry => filename === join(unpackedRoot, entry)),
      completePackageResolver(unpackedRoot),
    )).toThrow(`contains host-architecture build output: ${forbidden}`)
  })

  it.each([
    'lib/client.js',
    'lib/desktop-runtime-environment.js',
    'lib/policy/desktop-policy.json',
    'lib/node-runtime-sha256.json',
    'lib/profile-service.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/pnpm.js',
    'lib/update-download.js',
    'lib/windows-agent-presets.js',
  ])('fails loud when required runtime entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it.each([...REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES])(
    'fails loud when archive-only entry %s is absent from app.asar',
    (missing) => {
      const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

      expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => false))
        .toThrow(`missing required ASAR entries: ${missing}`)
    },
  )

  it.each([
    'package.json',
    'lib/terminal.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/update-download.js',
    'lib/windows-agent-presets.js',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/pnpm/bin/pnpm.mjs',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ])('fails loud when physical runtime entry %s is absent from app.asar.unpacked', (missing) => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missingPath = join(unpackedRoot, missing)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== missingPath,
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)
  })

  it('requires the physical Cordis preset and its bundled skills', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const requiredPresetEntries = [
      'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/agent.cordis.yml',
      'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
      'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md',
    ]

    for (const missing of requiredPresetEntries) {
      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => completeArchiveEntries(),
        filename => filename !== join(unpackedRoot, missing),
        completePackageResolver(unpackedRoot),
      )).toThrow(`missing required physical entries: ${missing}`)
    }
  })

  it('fails loud when a required package export cannot resolve from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === 'dsh-plugin-desktop/profiles') {
        throw new Error('missing export')
      }
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      completeFileProbe(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export dsh-plugin-desktop/profiles`,
    )
  })

  it('fails loud when schemastery is absent from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const specifier = '@deepseek-ai/schemastery/package.json'
    const resolvePackage = vi.fn<PackageResolver>((requested) => {
      if (requested === specifier) throw new Error('missing package')
      return completePackageResolver(unpackedRoot)(requested)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      completeFileProbe(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export ${specifier}`,
    )
  })

  it('fails loud when a required package export escapes app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const escapedPath = join('/workspace', 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js')
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === '@deepseek-ai/dsh-base/package.json') return escapedPath
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      completeFileProbe(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `required package export @deepseek-ai/dsh-base/package.json resolved outside ${unpackedRoot}: ${escapedPath}`,
    )
  })
})
