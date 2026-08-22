import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import {
  clearElectronRunAsNode,
  runDesktopDshCli,
  withDefaultDesktopProfile,
} from '../src/desktop-cli.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'
import type { DesktopPolicy } from '../src/desktop-policy.ts'
import {
  DESKTOP_INSTALL_RECOVERY_STATE_ENV,
  desktopInstallRecoveryStatePath,
} from '../src/install-recovery.ts'
import { packagedDependencyPath, unpackedAsarPath } from '../src/packaged-runtime-path.ts'

/** Build one policy fixture with the same schema as the embedded asset. */
function desktopPolicy(locked: boolean): DesktopPolicy {
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked,
    trustRoots: [],
  })
}

const catalogKeyId = 'company-catalog-2026.01'
const catalogKey = generateKeyPairSync('ed25519')
const catalogTrustRoots = [{
  keyId: catalogKeyId,
  fingerprint: ed25519PublicKeyFingerprint(catalogKey.publicKey),
}]

/** Locked policy whose trust roots match the catalog signing key fixture. */
function companyLockedPolicy(): DesktopPolicy {
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked: true,
    trustRoots: catalogTrustRoots,
  })
}

const asUnsignedCatalog = (manifest: Record<string, unknown>) =>
  manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0]

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: 'example-plugin',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    ...overrides,
  }
}

function unsignedCatalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [catalogEntry()],
    ...overrides,
  }
}

/** Sign and write one catalog manifest fixture; returns the asset path to inject. */
function writeCompanyCatalogAsset(root: string, manifest: Record<string, unknown>): string {
  const signature = createCompanyManifestSignature(asUnsignedCatalog(manifest), catalogKey.privateKey, catalogKeyId)
  const assetPath = join(root, 'company-market', 'catalog-manifest.json')
  mkdirSync(dirname(assetPath), { recursive: true })
  writeFileSync(assetPath, canonicalJsonText({ ...manifest, signature }))
  return assetPath
}

/** Full market receipt v2 fixture as the market settings document stores it. */
function marketReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receiptId: 'receipt:desktop-cli-ratchet-0001',
    profileName: 'desktop',
    packageName: 'example-plugin',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    sourceRecordId: 'company-catalog',
    providerId: 'com.deepseek.company-catalog',
    itemId: 'npm:example-plugin@1.0.0',
    displayName: 'Example Plugin',
    installedAt: '2026-09-01T00:00:00.000Z',
    receiptVersion: 2,
    manifestSequence: 42,
    keyId: catalogKeyId,
    treeDigest: { algorithm: 'sha256', files: [], rootDigest: 'ab'.repeat(32) },
    resolved: {
      registryIntegrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      treeRootDigest: 'ab'.repeat(32),
    },
    decided: { allowedBy: 'signed-company-manifest' },
    ...overrides,
  }
}

describe('packaged dsh bootstrap', () => {
  it('removes every Windows casing of Electron Node mode', () => {
    const environment = {
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: 'inherited',
      Path: 'C:\\Windows',
    }

    clearElectronRunAsNode(environment)

    expect(environment).toEqual({ Path: 'C:\\Windows' })
  })

  it('clears Node mode before loading the fixed packaged CLI entry', async () => {
    const environment = {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
      KEEP: 'value',
    }
    const argv = ['/Applications/DSH Desktop', '/app.asar/lib/desktop-cli.js', '--dump-config']
    const load = vi.fn(async (url: string) => {
      expect(environment).toEqual({ KEEP: 'value' })
      expect(argv).toEqual([
        '/Applications/DSH Desktop',
        '/app.asar/lib/desktop-cli.js',
        '--profile',
        'desktop',
        '--dump-config',
      ])
      expect(url).toMatch(/\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/u)
    })

    await runDesktopDshCli(environment, load, argv)

    expect(load).toHaveBeenCalledOnce()
  })

  it('defaults profile and plugin commands without overriding explicit or global modes', () => {
    expect(withDefaultDesktopProfile([], 'desktop')).toEqual(['--profile', 'desktop'])
    expect(withDefaultDesktopProfile(['--dump-config'], 'desktop')).toEqual([
      '--profile',
      'desktop',
      '--dump-config',
    ])
    expect(withDefaultDesktopProfile(['plugin', 'add', 'third-party'], 'desktop')).toEqual([
      'plugin',
      '--profile',
      'desktop',
      'add',
      'third-party',
    ])
    expect(withDefaultDesktopProfile(['--profile', 'web'], 'desktop')).toEqual(['--profile', 'web'])
    expect(withDefaultDesktopProfile(['--profile=web'], 'desktop')).toEqual(['--profile=web'])
    expect(withDefaultDesktopProfile(['web'], 'desktop')).toEqual(['web'])
    expect(withDefaultDesktopProfile(['--help'], 'desktop')).toEqual(['--help'])
    expect(withDefaultDesktopProfile(['--version'], 'desktop')).toEqual(['--version'])
    expect(withDefaultDesktopProfile(['plugin', 'update'], '工作 profile')).toEqual([
      'plugin',
      '--profile',
      '工作 profile',
      'update',
    ])
    expect(() => withDefaultDesktopProfile([], '../desktop')).toThrow('invalid desktop profile name')
  })

  it('snapshots plugin installs launched from the built-in DSH Terminal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-recovery-'))
    const homeDir = join(root, 'home')
    const profileDir = join(homeDir, 'profiles', 'desktop')
    const userDataDir = join(root, 'user-data')
    const statePath = desktopInstallRecoveryStatePath(userDataDir)
    const manifestPath = join(profileDir, 'package.json')
    const originalExitCode = process.exitCode
    try {
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: {} }))
      const environment = {
        DSH_HOME: homeDir,
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: statePath,
      }
      const argv = [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin']

      await runDesktopDshCli(environment, async () => {
        writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'example-plugin': '1.0.0' } }))
        process.exit(0)
      }, argv, desktopPolicy(false))

      expect(environment).toEqual({ DSH_HOME: homeDir })
      expect(argv.slice(2)).toEqual(['plugin', '--profile', 'desktop', 'add', 'example-plugin'])
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        profileName: 'desktop',
        packageName: 'manual-plugin-install',
        phase: 'awaiting-restart',
      })
    } finally {
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds a built-in terminal snapshot to an explicitly selected profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-explicit-profile-'))
    const homeDir = join(root, 'home')
    const desktopDir = join(homeDir, 'profiles', 'desktop')
    const webDir = join(homeDir, 'profiles', 'web')
    const statePath = desktopInstallRecoveryStatePath(join(root, 'user-data'))
    const desktopManifest = join(desktopDir, 'package.json')
    const webManifest = join(webDir, 'package.json')
    const originalExitCode = process.exitCode
    try {
      mkdirSync(desktopDir, { recursive: true })
      mkdirSync(webDir, { recursive: true })
      writeFileSync(desktopManifest, JSON.stringify({ name: 'desktop-profile' }))
      writeFileSync(webManifest, JSON.stringify({ name: 'web-profile', dependencies: {} }))

      await runDesktopDshCli({
        DSH_HOME: homeDir,
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: statePath,
      }, async () => {
        writeFileSync(webManifest, JSON.stringify({
          name: 'web-profile',
          dependencies: { 'example-plugin': '1.0.0' },
        }))
        process.exit(0)
      }, [process.execPath, '/app/desktop-cli.js', 'plugin', '--profile', 'web', 'add', 'example-plugin'], desktopPolicy(false))

      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        profileName: 'web',
        phase: 'awaiting-restart',
      })
      expect(JSON.parse(readFileSync(desktopManifest, 'utf8'))).toEqual({ name: 'desktop-profile' })
    } finally {
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores and clears a built-in terminal snapshot when plugin add fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-recovery-failure-'))
    const homeDir = join(root, 'home')
    const profileDir = join(homeDir, 'profiles', 'desktop')
    const statePath = desktopInstallRecoveryStatePath(join(root, 'user-data'))
    const manifestPath = join(profileDir, 'package.json')
    const originalExitCode = process.exitCode
    try {
      mkdirSync(profileDir, { recursive: true })
      const originalManifest = JSON.stringify({ dependencies: {} })
      writeFileSync(manifestPath, originalManifest)
      await runDesktopDshCli({
        DSH_HOME: homeDir,
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: statePath,
      }, async () => {
        writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'broken-plugin': '0.0.0' } }))
        process.exit(1)
      }, [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'broken-plugin'], desktopPolicy(false))

      expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest)
      expect(existsSync(statePath)).toBe(false)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a terminal plugin add in a locked build when the embedded manifest asset is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-missing-catalog-'))
    const homeDir = join(root, 'home')
    const profileDir = join(homeDir, 'profiles', 'desktop')
    const statePath = desktopInstallRecoveryStatePath(join(root, 'user-data'))
    const manifestPath = join(profileDir, 'package.json')
    const originalExitCode = process.exitCode
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: {} }))
      const load = vi.fn(async () => undefined)

      await runDesktopDshCli({
        DSH_HOME: homeDir,
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: statePath,
      }, load, [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0'],
      companyLockedPolicy(), join(root, 'company-market', 'catalog-manifest.json'))

      expect(load).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(existsSync(statePath)).toBe(false)
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({ dependencies: {} })
      const stderr = stderrWrite.mock.calls.flat().join('')
      expect(stderr).toContain('unreadable company catalog manifest asset')
      expect(stderr).toContain('company-market/catalog-manifest.json')
    } finally {
      stderrWrite.mockRestore()
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows a signed terminal plugin add into the install recovery transaction in a locked build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-signed-add-'))
    const homeDir = join(root, 'home')
    const profileDir = join(homeDir, 'profiles', 'desktop')
    const statePath = desktopInstallRecoveryStatePath(join(root, 'user-data'))
    const manifestPath = join(profileDir, 'package.json')
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog())
    const originalExitCode = process.exitCode
    try {
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: {} }))
      const load = vi.fn(async () => {
        writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'example-plugin': '1.0.0' } }))
        process.exit(0)
      })
      const argv = [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0']

      await runDesktopDshCli({
        DSH_HOME: homeDir,
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: statePath,
      }, load, argv, companyLockedPolicy(), assetPath)

      expect(load).toHaveBeenCalledOnce()
      expect(load).toHaveBeenCalledWith(expect.stringMatching(/@deepseek-ai\/dsh\/lib\/bin\.js$/u))
      // The allowed add must pin the exact specifier: pnpm's default caret
      // save-prefix would break boot verification's lockfile check.
      expect(argv.slice(2)).toEqual([
        'plugin', '--profile', 'desktop', 'add', '--save-exact', 'example-plugin@1.0.0',
      ])
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        profileName: 'desktop',
        packageName: 'manual-plugin-install',
        phase: 'awaiting-restart',
      })
    } finally {
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a user-typed --save-exact and injects it before an explicitly selected profile flag', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-save-exact-'))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog())
    const originalExitCode = process.exitCode
    try {
      const typedLoad = vi.fn(async () => undefined)
      const typedArgv = [process.execPath, '/app/desktop-cli.js', 'plugin', 'add',
        '--save-exact', 'example-plugin@1.0.0']

      await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, typedLoad,
        typedArgv, companyLockedPolicy(), assetPath)

      expect(typedLoad).toHaveBeenCalledOnce()
      expect(typedArgv.slice(2)).toEqual([
        'plugin', '--profile', 'desktop', 'add', '--save-exact', 'example-plugin@1.0.0',
      ])

      // Profile flags may legally sit between `add` and the package spec; the
      // injected flag still lands directly before the positional package.
      const profiledLoad = vi.fn(async () => undefined)
      const profiledArgv = [process.execPath, '/app/desktop-cli.js', 'plugin', 'add',
        '--profile', 'web', 'example-plugin@1.0.0']

      await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, profiledLoad,
        profiledArgv, companyLockedPolicy(), assetPath)

      expect(profiledLoad).toHaveBeenCalledOnce()
      expect(profiledArgv.slice(2)).toEqual([
        'plugin', 'add', '--profile', 'web', '--save-exact', 'example-plugin@1.0.0',
      ])
    } finally {
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('denies a locked terminal add whose manifest is not newer than the receipts ratchet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-sequence-ratchet-'))
    const homeDir = join(root, 'home')
    mkdirSync(join(homeDir, 'profiles', 'desktop'), { recursive: true })
    // The catalog fixture carries sequence 42; a receipt recorded at 42 means
    // a manifest of that sequence already allowed an install here, so the
    // terminal gate must refuse to re-authorize adds under it.
    writeFileSync(join(homeDir, 'settings.yaml'), JSON.stringify({
      'dsh-community-market': { installReceipts: [marketReceipt({ manifestSequence: 42 })] },
    }))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog())
    const originalExitCode = process.exitCode
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const load = vi.fn(async () => undefined)

      await runDesktopDshCli({
        DSH_HOME: homeDir,
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
      }, load, [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0'],
      companyLockedPolicy(), assetPath)

      expect(load).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(stderrWrite.mock.calls.flat().join('')).toContain('stale-sequence')
    } finally {
      stderrWrite.mockRestore()
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows a locked terminal add above the receipts ratchet and ignores unusable receipts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-sequence-floor-'))
    const homeDir = join(root, 'home')
    mkdirSync(join(homeDir, 'profiles', 'desktop'), { recursive: true })
    // Sequence 41 is below the catalog's 42, and the malformed peer record
    // contributes nothing, so the add stays allowed.
    writeFileSync(join(homeDir, 'settings.yaml'), JSON.stringify({
      'dsh-community-market': {
        installReceipts: [
          marketReceipt({ manifestSequence: 41 }),
          { receiptId: 'broken', receiptVersion: 2, packageName: 7 },
        ],
      },
    }))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog())
    const originalExitCode = process.exitCode
    try {
      const load = vi.fn(async () => undefined)
      const argv = [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0']

      await runDesktopDshCli({
        DSH_HOME: homeDir,
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
      }, load, argv, companyLockedPolicy(), assetPath)

      expect(load).toHaveBeenCalledOnce()
      expect(argv.slice(2)).toEqual([
        'plugin', '--profile', 'desktop', 'add', '--save-exact', 'example-plugin@1.0.0',
      ])
    } finally {
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a locked terminal plugin add that is not in the signed catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-unsigned-add-'))
    const statePath = desktopInstallRecoveryStatePath(join(root, 'user-data'))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog())
    const originalExitCode = process.exitCode
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const load = vi.fn(async () => undefined)

      await runDesktopDshCli({
        DSH_HOME: join(root, 'home'),
        DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: statePath,
      }, load, [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'unapproved-plugin@1.0.0'],
      companyLockedPolicy(), assetPath)

      expect(load).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(existsSync(statePath)).toBe(false)
      const stderr = stderrWrite.mock.calls.flat().join('')
      expect(stderr).toContain('not in the signed company plugin catalog')
      expect(stderr).toContain('Install plugins from the company plugin market instead.')
    } finally {
      stderrWrite.mockRestore()
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a locked terminal plugin add for a revoked catalog entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-revoked-add-'))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog({
      packages: [catalogEntry({ revoked: true })],
    }))
    const originalExitCode = process.exitCode
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const load = vi.fn(async () => undefined)

      await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, load,
        [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0'],
        companyLockedPolicy(), assetPath)

      expect(load).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(stderrWrite.mock.calls.flat().join('')).toContain('revoked in the signed company plugin catalog')
    } finally {
      stderrWrite.mockRestore()
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a locked terminal plugin add when the catalog manifest is expired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-expired-catalog-'))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog({ expiresAt: '2020-01-01T00:00:00Z' }))
    const originalExitCode = process.exitCode
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const load = vi.fn(async () => undefined)

      await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, load,
        [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0'],
        companyLockedPolicy(), assetPath)

      expect(load).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      const stderr = stderrWrite.mock.calls.flat().join('')
      expect(stderr).toContain('expired')
      expect(stderr).toContain('2020-01-01T00:00:00Z')
    } finally {
      stderrWrite.mockRestore()
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a locked terminal plugin add when the catalog manifest bytes are tampered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-tampered-catalog-'))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog())
    writeFileSync(assetPath, readFileSync(assetPath, 'utf8').replace('"sequence":42', '"sequence":43'))
    const originalExitCode = process.exitCode
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const load = vi.fn(async () => undefined)

      await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, load,
        [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0'],
        companyLockedPolicy(), assetPath)

      expect(load).not.toHaveBeenCalled()
      expect(process.exitCode).toBe(1)
      expect(stderrWrite.mock.calls.flat().join('')).toContain('bad-signature')
    } finally {
      stderrWrite.mockRestore()
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects locked terminal plugin adds that are not exact <package>@<version> specs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-terminal-locked-inexact-add-'))
    const assetPath = writeCompanyCatalogAsset(root, unsignedCatalog())
    const originalExitCode = process.exitCode
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      for (const spec of ['example-plugin@latest', 'example-plugin']) {
        const load = vi.fn(async () => undefined)
        stderrWrite.mockClear()

        await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, load,
          [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', spec],
          companyLockedPolicy(), assetPath)

        expect(load, `spec ${spec}`).not.toHaveBeenCalled()
        expect(process.exitCode, `spec ${spec}`).toBe(1)
        const stderr = stderrWrite.mock.calls.flat().join('')
        expect(stderr, `spec ${spec}`).toContain('<exact version>')
        expect(stderr, `spec ${spec}`).toContain('Install plugins from the company plugin market instead.')
      }
    } finally {
      stderrWrite.mockRestore()
      process.exitCode = originalExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps terminal plugin adds working in an unlocked build', async () => {
    const load = vi.fn(async () => undefined)
    const argv = [process.execPath, '/app/desktop-cli.js', 'plugin', 'add', 'example-plugin@1.0.0']

    await runDesktopDshCli(
      { DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' },
      load,
      argv,
      desktopPolicy(false),
    )

    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith(expect.stringMatching(/@deepseek-ai\/dsh\/lib\/bin\.js$/u))
    expect(argv.slice(2)).toEqual(['plugin', '--profile', 'desktop', 'add', 'example-plugin@1.0.0'])
  })

  it('keeps non-add commands working in a locked build', async () => {
    const removeArgv = [process.execPath, '/app/desktop-cli.js', 'plugin', 'remove', 'example-plugin']
    const removeLoad = vi.fn(async () => undefined)

    await runDesktopDshCli(
      { DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' },
      removeLoad,
      removeArgv,
      desktopPolicy(true),
    )

    expect(removeLoad).toHaveBeenCalledOnce()
    expect(removeLoad).toHaveBeenCalledWith(expect.stringMatching(/@deepseek-ai\/dsh\/lib\/bin\.js$/u))
    expect(removeArgv.slice(2)).toEqual(['plugin', '--profile', 'desktop', 'remove', 'example-plugin'])

    const dumpLoad = vi.fn(async () => undefined)
    await runDesktopDshCli({ DSH_DESKTOP_DEFAULT_PROFILE: 'desktop' }, dumpLoad,
      [process.execPath, '/app/desktop-cli.js', '--dump-config'], desktopPolicy(true))
    expect(dumpLoad).toHaveBeenCalledOnce()
  })

  it('uses the physical unpacked dependency tree only inside an Electron package', () => {
    expect(unpackedAsarPath('/Applications/DSH Desktop.app/Contents/Resources/app.asar/node_modules/pkg'))
      .toBe('/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/pkg')
    expect(unpackedAsarPath('C:\\Program Files\\DSH Desktop\\resources\\app.asar\\node_modules\\pkg'))
      .toBe('C:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\pkg')
    expect(unpackedAsarPath('/Applications/DSH Desktop.app/Contents/Resources/app.asar/package.json'))
      .toBe('/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/package.json')
    expect(unpackedAsarPath('/workspace/node_modules/pkg')).toBe('/workspace/node_modules/pkg')
    expect(() => packagedDependencyPath(import.meta.url, '../outside.js'))
      .toThrow('relative POSIX path')
  })

  it('maps a resolved ASAR dependency to its physical unpacked path', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-asar-profile-'))
    const desktopLib = join(root, 'app.asar', 'lib')
    const dshPackage = join(root, 'app.asar', 'node_modules', '@deepseek-ai', 'dsh')
    try {
      mkdirSync(desktopLib, { recursive: true })
      mkdirSync(join(dshPackage, 'lib'), { recursive: true })
      writeFileSync(join(dshPackage, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        type: 'module',
      }))
      writeFileSync(join(dshPackage, 'lib', 'bin.js'), '')

      const moduleUrl = pathToFileURL(join(desktopLib, 'desktop-cli.js')).href
      expect(packagedDependencyPath(moduleUrl, '@deepseek-ai/dsh/lib/bin.js')).toBe(join(
        realpathSync(root),
        'app.asar.unpacked',
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'lib',
        'bin.js',
      ))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the DSH entry from a pnpm profile with flat package dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-flat-profile-'))
    const desktopLib = join(root, 'node_modules', 'dsh-plugin-desktop', 'lib')
    const dshPackage = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    const dshEntry = join(dshPackage, 'lib', 'bin.js')
    const pnpmPackage = join(root, 'node_modules', 'pnpm')
    const pnpmEntry = join(pnpmPackage, 'bin', 'pnpm.mjs')
    try {
      mkdirSync(desktopLib, { recursive: true })
      mkdirSync(join(dshPackage, 'lib'), { recursive: true })
      mkdirSync(join(pnpmPackage, 'bin'), { recursive: true })
      writeFileSync(join(dshPackage, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        type: 'module',
      }))
      writeFileSync(dshEntry, '')
      writeFileSync(join(pnpmPackage, 'package.json'), JSON.stringify({
        name: 'pnpm',
        exports: { '.': './package.json' },
      }))
      writeFileSync(pnpmEntry, '')

      const moduleUrl = pathToFileURL(join(desktopLib, 'desktop-cli.js')).href
      expect(packagedDependencyPath(moduleUrl, '@deepseek-ai/dsh/lib/bin.js'))
        .toBe(join(realpathSync(root), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      expect(packagedDependencyPath(moduleUrl, 'pnpm/bin/pnpm.mjs'))
        .toBe(join(realpathSync(root), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
