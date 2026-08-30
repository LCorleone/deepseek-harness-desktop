import { mkdirSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries, initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import {
  companyPresetRoot,
  DESKTOP_PACKAGE_NAME,
  desktopShellModeFromSettings,
  desktopStartupSettingsFromSettings,
  desktopBundleList,
  ensureDesktopProfile,
  prepareDesktopProfile,
  readDesktopShellMode,
  shippedPresetRoot,
  validateDshMarketBundlePatches,
} from '../src/profile.ts'
import { DESKTOP_MARKET_IDENTITIES } from '../src/desktop-market.ts'
import { parseDesktopPolicy, type DesktopPolicy } from '../src/desktop-policy.ts'
import {
  computeDesktopBootTreeRootDigest,
  type DesktopBootReceipt,
  type DesktopBootVerificationInputs,
} from '../src/boot-verification.ts'

const homes: string[] = []

/** Build a strict policy fixture through the real parser, locked or not. */
function injectedDesktopPolicy(locked: boolean): DesktopPolicy {
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked,
    trustRoots: [],
  })
}

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  homes.push(home)
  return home
}

function installWebClient(
  home: string,
  packageName: string,
  manifest: Record<string, unknown> = {},
): string {
  const webDir = join(home, 'profiles', 'web')
  const bundles = PROFILE_TEMPLATES.web
  if (bundles === undefined) throw new Error('test requires the shipped Web template')
  initProfile(webDir, bundles)
  const packageDir = join(webDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.0.0',
    type: 'module',
    dsh: { client: { platform: 'web' } },
    ...manifest,
  }) + '\n')
  writeFileSync(join(packageDir, 'index.js'), 'export default {}\n')
  return webDir
}

function installBundle(home: string, packageName: string, patch: string, version = '1.0.0'): string {
  const bundleDir = join(home, 'profiles', 'desktop', 'node_modules', packageName)
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }) + '\n')
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), patch)
  return bundleDir
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('desktop profile composition', {
  timeout: process.platform === 'win32' ? 10_000 : 5_000,
}, () => {
  it('reads packaged Cordis skills from the physical unpacked preset root', () => {
    const home = temporaryHome()
    const resources = join(home, 'resources')
    const archivedDsh = join(resources, 'app.asar', 'node_modules', '@deepseek-ai', 'dsh')
    const physicalPresetRoot = join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'config',
      'agent-presets',
    )
    const skillPath = join(
      physicalPresetRoot,
      'cordis',
      'skills',
      'cordis-plugin-development',
      'SKILL.md',
    )
    mkdirSync(join(resources, 'app.asar', 'lib'), { recursive: true })
    mkdirSync(archivedDsh, { recursive: true })
    mkdirSync(dirname(skillPath), { recursive: true })
    writeFileSync(join(archivedDsh, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      exports: { './package.json': './package.json' },
    }) + '\n')
    writeFileSync(skillPath, '# Cordis plugin development\n')

    const moduleUrl = pathToFileURL(join(resources, 'app.asar', 'lib', 'profile.js')).href
    const resolvedRoot = shippedPresetRoot(moduleUrl)

    expect(resolvedRoot).toBe(realpathSync(physicalPresetRoot))
    expect(readFileSync(join(
      resolvedRoot,
      'cordis',
      'skills',
      'cordis-plugin-development',
      'SKILL.md',
    ), 'utf8')).toBe('# Cordis plugin development\n')
  })

  it('adds the Web surface before third-party bundles and removes the launcher bundle duplicate', () => {
    expect(desktopBundleList([
      '@deepseek-ai/dsh-base',
      'third-party-one',
      DESKTOP_PACKAGE_NAME,
      'third-party-two',
    ])).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-one',
      'third-party-two',
    ])
  })

  it('repairs a base-only CLI profile without replacing dependencies', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dependencies: { 'third-party-plugin': '^1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'third-party-plugin'] } },
      custom: { preserved: true },
    }, undefined, 2) + '\n')

    ensureDesktopProfile(home)
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
      custom: { preserved: boolean }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'third-party-plugin',
    ])
    expect(repaired.dependencies).toEqual({ 'third-party-plugin': '^1.2.3' })
    expect(repaired.custom.preserved).toBe(true)
  })

  it('migrates the obsolete Desktop bundle before loading a historical profile', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({
      ...manifest,
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            '@deepseek-ai/dsh-desktop-app',
          ],
        },
      },
    }, undefined, 2) + '\n')

    expect(() => prepareDesktopProfile(undefined, home, 'win32')).not.toThrow()
    const repaired = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(repaired.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])
  })

  it('rejects malformed persistent bundle metadata', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const path = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...manifest, dsh: { profile: { bundles: 'not-an-array' } } }) + '\n')
    expect(() => ensureDesktopProfile(home)).toThrow('dsh.profile.bundles must be an array')
  })

  it('assembles the Host shell without replacing the upstream client shell', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const patches = prepared.patches as Array<Record<string, unknown>>
    const inserted = patches.flatMap((patch) => {
      const rows = patch.insert
      return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
    })
    expect(inserted).toContainEqual(expect.objectContaining({
      name: DESKTOP_PACKAGE_NAME,
      config: { mode: 'compatibility' },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'webserver',
      name: '@deepseek-ai/dsh-host-webserver',
      disabled: true,
    }))
    expect(inserted).toContainEqual(expect.objectContaining({
      id: 'desktop-webserver',
      name: 'dsh-plugin-desktop/webserver',
      config: { host: '127.0.0.1', port: 43_120 },
    }))
    expect(patches).toContainEqual(expect.objectContaining({
      id: 'agent-presets',
      config: expect.objectContaining({ roots: [expect.objectContaining({ trust: 'system' })] }),
    }))
    expect(readFileSync(prepared.rootConfig, 'utf8')).toBe('[]\n')
    expect(prepared.homeDir).toBe(home)
    expect(fileURLToPath(prepared.bareModuleBaseUrl)).toBe(join(prepared.profile.dir, 'package.json'))
    expect(prepared.mode).toBe('compatibility')

    const rows = composeEntries([prepared.patches])
    for (const [id, name] of [
      ['ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
      ['ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar'],
      ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
    ] as const) {
      const matching = rows.filter(row => row.id === id)
      expect(matching).toHaveLength(1)
      expect(matching[0]).toEqual(expect.objectContaining({ name }))
      expect(matching[0]?.disabled).toBeFalsy()
    }
    expect(rows.find(row => row.id === 'directory-picker')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    }))
    expect(rows.find(row => row.id === 'directory-picker')?.disabled).toBeFalsy()
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-host')
    expect(rows.map(row => row.id)).not.toContain('desktop-directory-picker-browse-surface')
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'agent-presets')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-presets',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-agent-presets')
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
    expect(rows.find(row => row.id === 'desktop-terminal')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/terminal',
      disabled: { __jsExpr: "process.platform === 'linux'" },
    }))
    expect(rows.find(row => row.id === 'desktop-pnpm')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/pnpm',
    }))
    expect(rows.find(row => row.id === 'desktop-updates')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/updates',
    }))
    expect(rows.find(row => row.id === 'desktop-notifications')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/notifications',
    }))
    expect(rows.find(row => row.id === 'desktop-profiles')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/profiles',
    }))
  })

  it('keeps both Market providers absent until the user explicitly enables one', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.market).toEqual({
      requested: 'disabled',
      effective: 'disabled',
      legacyDefaulted: true,
    })
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId
      || row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
  })

  it('inserts the community Market as one canonical row only after explicit selection', () => {
    const home = temporaryHome()
    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'community-market',
      effective: 'community-market',
      legacyDefaulted: false,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('community-market')
    expect(rows.filter(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId)).toEqual([{
      id: DESKTOP_MARKET_IDENTITIES.community.rowId,
      name: DESKTOP_MARKET_IDENTITIES.community.packageName,
    }])
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
  })

  it('loads the exact dshmarket dependency as a direct bundle only after explicit selection', () => {
    const home = temporaryHome()
    const profileMarketDir = installBundle(home, DESKTOP_MARKET_IDENTITIES.dshMarket.packageName, [
      '- insert:',
      '    - id: dsh-market',
      '      name: dshmarket',
      '',
    ].join('\n'), '99.0.0')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    writeFileSync(profileManifestPath, JSON.stringify(profileManifest) + '\n')
    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'dsh-market',
      effective: 'dsh-market',
      legacyDefaulted: false,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('dsh-market')
    expect(prepared.profile.layers.find(layer =>
      layer.packageName === DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)?.packageDir,
    ).toBe(profileMarketDir)
    expect(rows.filter(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toEqual([{
      id: DESKTOP_MARKET_IDENTITIES.dshMarket.rowId,
      name: DESKTOP_MARKET_IDENTITIES.dshMarket.packageName,
    }])
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId)).toBe(false)
  })

  it('composes the locked company provider over a persisted dsh-market request', () => {
    const home = temporaryHome()
    installBundle(home, DESKTOP_MARKET_IDENTITIES.dshMarket.packageName, [
      '- insert:',
      '    - id: dsh-market',
      '      name: dshmarket',
      '',
    ].join('\n'), '99.0.0')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    writeFileSync(profileManifestPath, JSON.stringify(profileManifest) + '\n')

    const prepared = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      { requested: 'dsh-market', effective: 'community-market', legacyDefaulted: false },
      undefined,
      {},
      injectedDesktopPolicy(true),
    )
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.requested).toBe('dsh-market')
    expect(prepared.market.effective).toBe('community-market')
    expect(prepared.marketFailure).toBeUndefined()
    expect(rows.filter(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId)).toEqual([{
      id: DESKTOP_MARKET_IDENTITIES.community.rowId,
      name: DESKTOP_MARKET_IDENTITIES.community.packageName,
    }])
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
  })

  it('keeps the newer Desktop dshmarket when a Profile copy is older', () => {
    const home = temporaryHome()
    const oldProfileMarketDir = installBundle(home, DESKTOP_MARKET_IDENTITIES.dshMarket.packageName, [
      '- insert:',
      '    - id: dsh-market',
      '      name: dshmarket',
      '',
    ].join('\n'), '0.1.0')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    writeFileSync(profileManifestPath, `${JSON.stringify(profileManifest)}\n`)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'dsh-market',
      effective: 'dsh-market',
      legacyDefaulted: false,
    })
    const selected = prepared.profile.layers.find(layer =>
      layer.packageName === DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    expect(selected?.packageDir).not.toBe(oldProfileMarketDir)
    expect(JSON.parse(readFileSync(join(selected!.packageDir, 'package.json'), 'utf8'))).toMatchObject({
      name: 'dshmarket',
      version: '1.17.1',
    })
  })

  it('does not let community-management disables suppress a third-party market', () => {
    const home = temporaryHome()
    const packageName = 'third-party-plugin'
    installBundle(home, packageName, '- insert:\n    - id: third-party-marker\n      name: cordis:example\n')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(packageName)
    writeFileSync(profileManifestPath, JSON.stringify(profileManifest) + '\n')
    const managementStatePath = join(home, 'user-data', 'plugin-management', 'state.json')
    const recoveryStatePath = join(home, 'user-data', 'startup-recovery', 'state.json')
    mkdirSync(dirname(managementStatePath), { recursive: true })
    writeFileSync(managementStatePath, JSON.stringify({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: [packageName] }],
    }) + '\n')

    const external = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      managementStatePath,
      { requested: 'dsh-market', effective: 'dsh-market', legacyDefaulted: false },
      recoveryStatePath,
    )
    expect(composeEntries([external.patches])).toContainEqual(expect.objectContaining({
      id: 'third-party-marker',
    }))

    const community = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      managementStatePath,
      { requested: 'community-market', effective: 'community-market', legacyDefaulted: false },
      recoveryStatePath,
    )
    expect(composeEntries([community.patches])).not.toContainEqual(expect.objectContaining({
      id: 'third-party-marker',
    }))
  })

  it('keeps a startup-recovery disable effective for every market provider', () => {
    const home = temporaryHome()
    const packageName = 'third-party-plugin'
    installBundle(home, packageName, '- insert:\n    - id: third-party-marker\n      name: cordis:example\n')
    const profileManifestPath = join(ensureDesktopProfile(home), 'package.json')
    const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dsh.profile.bundles.push(packageName)
    writeFileSync(profileManifestPath, JSON.stringify(profileManifest) + '\n')
    const managementStatePath = join(home, 'user-data', 'plugin-management', 'state.json')
    const recoveryStatePath = join(home, 'user-data', 'startup-recovery', 'state.json')
    mkdirSync(dirname(recoveryStatePath), { recursive: true })
    writeFileSync(recoveryStatePath, JSON.stringify({
      version: 1,
      profiles: [{ profileName: 'desktop', disabledBundles: [packageName] }],
    }) + '\n')

    const prepared = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      managementStatePath,
      { requested: 'dsh-market', effective: 'dsh-market', legacyDefaulted: false },
      recoveryStatePath,
    )
    expect(composeEntries([prepared.patches])).not.toContainEqual(expect.objectContaining({
      id: 'third-party-marker',
    }))
  })

  it('filters an unselected dshmarket bundle before resolving or parsing its patch', () => {
    const home = temporaryHome()
    const dir = ensureDesktopProfile(home)
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dsh.profile.bundles.push(DESKTOP_MARKET_IDENTITIES.dshMarket.packageName)
    writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
    installBundle(home, DESKTOP_MARKET_IDENTITIES.dshMarket.packageName, 'not: [valid yaml')

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('disabled')
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
  })

  it('fails a conflicting provider identity closed without blocking the core profile', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), `- insert:\n    - id: community-market\n      name: dsh-community-market\n`)

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'desktop', undefined, {
      requested: 'community-market',
      effective: 'community-market',
      legacyDefaulted: false,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('disabled')
    expect(prepared.marketFailure).toContain('conflicting Market provider Loader identity')
    expect(rows.some(row => row.id === DESKTOP_MARKET_IDENTITIES.community.rowId
      || row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toBe(false)
    expect(rows.some(row => row.id === 'webserver')).toBe(true)
  })

  it('rejects a non-canonical dshmarket bundle patch before it reaches the Loader', () => {
    expect(() => validateDshMarketBundlePatches([{
      insert: [{ id: 'dsh-market', name: 'unexpected-market' }],
    }])).toThrow('must insert exactly the canonical dsh-market row')
  })

  it('boots a selected Web profile without overriding its compatibility UI rows', () => {
    const home = temporaryHome()
    const webDir = join(home, 'profiles', 'web')
    const bundles = PROFILE_TEMPLATES.web
    if (bundles === undefined) throw new Error('test requires the shipped Web template')
    initProfile(webDir, bundles)
    writeFileSync(join(webDir, 'cordis.patch.yml'), [
      '- id: ui-layout',
      "  name: '@deepseek-ai/dsh-client-ui-layout'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-layout',
      "      name: 'third-party-layout'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin', 'web')
    const rows = composeEntries([prepared.patches])

    expect(prepared.profile.name).toBe('web')
    expect(rows.find(row => row.id === 'ui-layout')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-client-ui-layout',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'third-party-layout')).toEqual({
      id: 'third-party-layout',
      name: 'third-party-layout',
    })
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop',
      config: expect.objectContaining({ mode: 'compatibility' }),
    }))
  })

  it('projects YAML startup settings into the Host, Web server, and client Loader rows', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\n  port: 43189\n')

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    const rows = composeEntries([prepared.patches])

    expect(prepared.mode).toBe('advanced')
    expect(prepared.port).toBe(43_189)
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      disabled: false,
      config: expect.objectContaining({ mode: 'advanced', port: 43_189 }),
    }))
    expect(rows.find(row => row.id === 'webserver')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-webserver',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'desktop-webserver')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/webserver',
      config: { host: '127.0.0.1', port: 43_189 },
    }))
    expect(rows.find(row => row.id === 'settings')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ dshHome: home }),
    }))
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-sidebar')?.disabled).toBe(false)
    expect(rows.find(row => row.id === 'ui-conversation')?.disabled).toBe(false)
  })

  it('pins the compatibility shell over a persisted advanced request in a locked build', () => {
    const home = temporaryHome()
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, 'dsh-desktop:\n  mode: advanced\n  port: 43189\n')

    const prepared = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(true),
    )
    const rows = composeEntries([prepared.patches])

    expect(prepared.mode).toBe('compatibility')
    expect(rows.find(row => row.id === 'desktop-shell')).toEqual(expect.objectContaining({
      config: expect.objectContaining({ mode: 'compatibility', port: 43_189 }),
    }))
    expect(rows.find(row => row.id === 'ui-layout')?.disabled).toBeUndefined()
    // The user's persisted choice stays on disk for an unlocked build to read.
    expect(readFileSync(settingsPath, 'utf8')).toContain('mode: advanced')
  })

  it('reads JSON settings and defaults an absent desktop namespace to compatibility', () => {
    const home = temporaryHome()
    const path = join(home, 'desktop-settings.json')
    writeFileSync(path, JSON.stringify({ 'dsh-desktop': { mode: 'advanced' } }))

    expect(readDesktopShellMode({ path })).toBe('advanced')
    expect(desktopStartupSettingsFromSettings({ 'dsh-desktop': { mode: 'advanced', port: 43_189 } })).toEqual({
      mode: 'advanced',
      port: 43_189,
    })
    expect(desktopStartupSettingsFromSettings({ 'dsh-desktop': { mode: 'advanced' } })).toEqual({
      mode: 'advanced',
      port: 43_120,
    })
    expect(desktopShellModeFromSettings({ unrelated: { enabled: true } })).toBe('compatibility')
  })

  it('rejects invalid settings roots, sections, modes, and YAML', () => {
    expect(() => desktopShellModeFromSettings([])).toThrow('must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': true })).toThrow('settings must be a map')
    expect(() => desktopShellModeFromSettings({ 'dsh-desktop': { mode: 'glass' } })).toThrow(
      'must be "compatibility" or "advanced"',
    )
    for (const port of [-1, 1.5, 65_536, '43189']) {
      expect(() => desktopStartupSettingsFromSettings({ 'dsh-desktop': { port } })).toThrow(
        'port must be an integer from 0 through 65535',
      )
    }

    const home = temporaryHome()
    const path = join(home, 'invalid.yaml')
    writeFileSync(path, 'dsh-desktop: [\n')
    expect(() => readDesktopShellMode({ path })).toThrow('invalid settings document')
  })

  it('treats an empty machine-wide patch file as no desktop patches', () => {
    for (const content of ['', '# no machine-wide patches\n']) {
      const home = temporaryHome()
      writeFileSync(join(home, 'cordis.patch.yml'), content)

      expect(() => prepareDesktopProfile(undefined, home, 'win32')).not.toThrow()
    }

    const invalidHome = temporaryHome()
    writeFileSync(join(invalidHome, 'cordis.patch.yml'), 'not: a patch list\n')
    expect(() => prepareDesktopProfile(undefined, invalidHome, 'win32')).toThrow(
      'must be a top-level YAML array of loader patch entries',
    )
  })

  it('rejects a home-level patch file in a locked build before loading it', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: home-marker',
      "      name: 'cordis:example'",
      '',
    ].join('\n'))

    expect(() => prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(true),
    )).toThrow('locked build forbids the home-level patch file')
  })

  it('rejects a home-level patch file in a locked build even when it is empty', () => {
    const home = temporaryHome()
    const patchPath = join(home, 'cordis.patch.yml')
    writeFileSync(patchPath, '# no machine-wide patches\n')

    expect(() => prepareDesktopProfile(
      undefined,
      home,
      'win32',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(true),
    )).toThrow(`locked build forbids the home-level patch file ${patchPath}`)
  })

  it('keeps a locked build bootable when no home-level patch file exists', () => {
    const home = temporaryHome()

    const prepared = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(true),
    )
    const rows = composeEntries([prepared.patches])

    expect(prepared.market.effective).toBe('disabled')
    expect(rows.some(row => row.id === 'webserver')).toBe(true)
  })

  it('composes a home-level patch identically for unlocked and omitted policies', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: home-marker',
      "      name: 'cordis:example'",
      '',
    ].join('\n'))

    const unlocked = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(false),
    )
    const omitted = prepareDesktopProfile(undefined, home, 'darwin')

    expect(unlocked.patches).toEqual(omitted.patches)
    expect(unlocked.skippedOptionalEntries).toEqual(omitted.skippedOptionalEntries)
    expect(composeEntries([unlocked.patches])).toContainEqual({
      id: 'home-marker',
      name: 'cordis:example',
    })
  })

  it('removes only the danger-full-access entry from a locked permission table', () => {
    const home = temporaryHome()
    // A profile-level patch restates the table with one extra passthrough key,
    // proving the locked deletion composes over user config instead of
    // replacing it. Unlocked builds never load this patch's key set.
    writeFileSync(join(ensureDesktopProfile(home), 'cordis.patch.yml'), [
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '        approval: ask',
      '      workspace-write:',
      '        sandbox: workspace-write',
      '        approval: ask',
      '      danger-full-access:',
      '        sandbox: danger-full-access',
      '        approval: never',
      '    defaultPreset: workspace-write',
      '',
    ].join('\n'))

    const locked = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(true),
    )
    const permission = composeEntries([locked.patches]).find(row => row.id === 'permission')

    expect(permission).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-permission-presets',
    }))
    expect(permission?.config).toEqual({
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      },
      defaultPreset: 'workspace-write',
    })
  })

  it('keeps the composed permission table for unlocked and omitted policies', () => {
    const home = temporaryHome()
    const unlocked = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(false),
    )
    const omitted = prepareDesktopProfile(undefined, home, 'darwin')

    expect(unlocked.patches).toEqual(omitted.patches)
    const permission = composeEntries([omitted.patches]).find(row => row.id === 'permission')
    expect(permission?.config).toEqual({
      presets: {
        'read-only': { sandbox: 'read-only', approval: 'ask' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
      },
    })
  })

  it('fails a locked build closed when the permission row loses its presets table', () => {
    const home = temporaryHome()
    writeFileSync(join(ensureDesktopProfile(home), 'cordis.patch.yml'), [
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config: {}',
      '',
    ].join('\n'))

    expect(() => prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(true),
    )).toThrow('locked build requires the permission presets table to be a map')
  })

  it('pins a locked build to the company agent preset roster on every platform', () => {
    const home = temporaryHome()
    for (const platform of ['darwin', 'win32'] as const) {
      const prepared = prepareDesktopProfile(
        undefined,
        home,
        platform,
        'desktop',
        undefined,
        undefined,
        undefined,
        {},
        injectedDesktopPolicy(true),
      )
      const rows = composeEntries([prepared.patches])

      expect(rows.find(row => row.id === 'agent-presets')).toEqual(expect.objectContaining({
        name: '@deepseek-ai/dsh-agent-presets',
        disabled: true,
      }))
      expect(rows.find(row => row.id === 'desktop-company-agent-presets')).toEqual({
        id: 'desktop-company-agent-presets',
        name: 'dsh-plugin-desktop/company-agent-presets',
        config: {
          default: 'deloitte-standard',
          roots: [{ path: companyPresetRoot(), trust: 'system' }],
        },
      })
      expect(rows.map(row => row.id), platform).not.toContain('desktop-windows-agent-presets')
    }
    expect(existsSync(join(companyPresetRoot(), 'deloitte-standard', 'agent.cordis.yml'))).toBe(true)
  })

  it('keeps the upstream agent preset roster for unlocked and omitted policies', () => {
    const home = temporaryHome()
    const unlocked = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      injectedDesktopPolicy(false),
    )
    const omitted = prepareDesktopProfile(undefined, home, 'darwin')

    expect(unlocked.patches).toEqual(omitted.patches)
    const rows = composeEntries([omitted.patches])
    expect(rows.find(row => row.id === 'agent-presets')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-presets',
      config: expect.objectContaining({
        default: 'standard',
        roots: [{ path: shippedPresetRoot(), trust: 'system' }],
      }),
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-company-agent-presets')
  })

  it('keeps the Windows browse panel and desktop pwsh provider without replacing process boundaries', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  config:',
      "    cwd: 'C:\\workspace'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])
    const picker = rows.find(row => row.id === 'directory-picker')

    expect(picker).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-browse-host',
      name: '@deepseek-ai/dsh-host-directory-picker-browse',
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-directory-picker-browse-surface',
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    }))
    expect(rows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-host-directory-picker-native')
    expect(rows.map(row => row.name)).not.toContain('@deepseek-ai/dsh-client-ui-directory-picker-native')
    expect(rows.find(row => row.id === 'subprocess')).toEqual({
      id: 'subprocess',
      name: '@deepseek-ai/dsh-subprocess-local',
    })
    expect(rows.find(row => row.id === 'sandbox')).toEqual({
      id: 'sandbox',
      name: '@deepseek-ai/dsh-sandbox-local',
    })
    expect(rows.find(row => row.id === 'agent-presets')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-agent-presets',
      disabled: true,
    }))
    expect(rows.find(row => row.id === 'desktop-windows-agent-presets')).toEqual(expect.objectContaining({
      name: 'dsh-plugin-desktop/windows-agent-presets',
    }))
    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'desktop-windows-pwsh-sandbox',
      name: 'dsh-plugin-desktop/windows-pwsh-sandbox',
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { cwd: 'C:\\workspace' },
    }))
  })

  it('rejects a bundle and user patch that register the same loader entry id', () => {
    const home = temporaryHome()
    const packageName = 'dsh-usage-stats'
    const bundlePatch = [
      '- insert:',
      '    - id: usage-stats',
      `      name: '${packageName}'`,
      '',
    ].join('\n')
    installBundle(home, packageName, bundlePatch)
    const profileDir = join(home, 'profiles', 'desktop')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName] } },
    }) + '\n')
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: usage-stats',
      `      name: '${packageName}'`,
      '',
    ].join('\n'))

    expect(() => prepareDesktopProfile(undefined, home, 'win32')).toThrow(
      'duplicate loader entry id "usage-stats" in the composed profile',
    )
  })

  it('keeps a Web Client in its owning profile and omits it from desktop', () => {
    const home = temporaryHome()
    const packageName = '@linxin666/dsh-client-ui-skin-whale-song'
    installWebClient(home, packageName, { exports: { '.': { import: './index.js' } } })
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: missing-skin',
      `      name: '${packageName}'`,
      '    - id: third-party-host',
      "      name: 'third-party-host-plugin'",
      '',
    ].join('\n'))

    const desktop = prepareDesktopProfile(undefined, home, 'darwin')
    const desktopRows = composeEntries([desktop.patches])

    expect(desktopRows.map(row => row.id)).not.toContain('missing-skin')
    expect(desktopRows).toContainEqual({
      id: 'third-party-host',
      name: 'third-party-host-plugin',
    })
    expect(desktop.skippedOptionalEntries).toEqual([{
      id: 'missing-skin',
      name: packageName,
    }])

    const web = prepareDesktopProfile(undefined, home, 'darwin', 'web')
    const webRows = composeEntries([web.patches])
    expect(webRows).toContainEqual({ id: 'missing-skin', name: packageName })
    expect(web.skippedOptionalEntries).toEqual([])
  })

  it('keeps unresolved non-UI package entries fail-loud', () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: optional-theme',
      `      name: '${packageName}'`,
      '',
    ].join('\n'))

    const desktop = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([desktop.patches])).toContainEqual({ id: 'optional-theme', name: packageName })
    expect(desktop.skippedOptionalEntries).toEqual([])
  })

  it('does not treat ordinary array config as nested Loader entries', () => {
    const home = temporaryHome()
    const packageName = '@example/whale-song-theme'
    installWebClient(home, packageName)
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: config-holder',
      "      name: 'third-party-host-plugin'",
      '      config:',
      `        - name: '${packageName}'`,
      '          enabled: true',
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'config-holder',
      name: 'third-party-host-plugin',
      config: [{ name: packageName, enabled: true }],
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('leaves non-package Loader specifiers unchanged', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: builtin-plugin',
      "      name: 'cordis:example'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'darwin')
    expect(composeEntries([prepared.patches])).toContainEqual({
      id: 'builtin-plugin',
      name: 'cordis:example',
    })
    expect(prepared.skippedOptionalEntries).toEqual([])
  })

  it('preserves an explicitly disabled upstream pwsh provider and a third-party replacement', () => {
    const home = temporaryHome()
    writeFileSync(join(home, 'cordis.patch.yml'), [
      '- id: pwsh-sandbox',
      "  name: '@deepseek-ai/dsh-pwsh-sandbox'",
      '  disabled: true',
      '- insert:',
      '    - id: third-party-pwsh-sandbox',
      "      name: 'third-party-pwsh-sandbox'",
      '',
    ].join('\n'))

    const prepared = prepareDesktopProfile(undefined, home, 'win32')
    const rows = composeEntries([prepared.patches])

    expect(rows.find(row => row.id === 'pwsh-sandbox')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      disabled: true,
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: 'third-party-pwsh-sandbox',
      name: 'third-party-pwsh-sandbox',
    }))
    expect(rows.map(row => row.id)).not.toContain('desktop-windows-pwsh-sandbox')
  })
})

describe('locked boot verification of third-party bundles (P2-4)', {
  timeout: process.platform === 'win32' ? 20_000 : 10_000,
}, () => {
  const bootKeyId = 'company-catalog-2026.01'
  const bootKeys = generateKeyPairSync('ed25519')
  const bootTrustRoots = [{
    keyId: bootKeyId,
    fingerprint: ed25519PublicKeyFingerprint(bootKeys.publicKey),
  }]
  const firstPlugin = 'third-party-plugin'
  const secondPlugin = 'third-party-plugin-two'
  const firstVersion = '1.4.0'
  const secondVersion = '2.1.0'
  const bootIntegrity = (seed: number): string => `sha512-${Buffer.alloc(64, seed).toString('base64')}`
  const firstIntegrity = bootIntegrity(11)
  const secondIntegrity = bootIntegrity(12)

  /** Locked content-mode policy fixture pinned to the test signing key. */
  function bootPolicy(locked: boolean): DesktopPolicy {
    return parseDesktopPolicy({
      allowHomePatch: false,
      allowManualPluginAdd: false,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
      locked,
      trustRoots: bootTrustRoots,
    })
  }

  function manifestEntry(
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
      runtime: { dshRuntimeVersion: '*' },
      ...overrides,
    }
  }

  function manifestText(
    packages: readonly Record<string, unknown>[],
    options: { sequence?: number; expiresAt?: string } = {},
  ): string {
    const unsigned = {
      manifestVersion: '1.0.0',
      sequence: options.sequence ?? 7,
      expiresAt: options.expiresAt ?? '2030-01-01T00:00:00Z',
      packages,
    }
    const signature = createCompanyManifestSignature(
      unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
      bootKeys.privateKey,
      bootKeyId,
    )
    return canonicalJsonText({ ...unsigned, signature })
  }

  const markerId = (packageName: string): string => `${packageName.split('/').pop()}-marker`

  /** Install one third-party bundle into the desktop profile, external-CLI style. */
  function installThirdPartyBundle(
    home: string,
    packageName: string,
    options: {
      version?: string
      bundlePatchField?: boolean
      files?: Record<string, string>
    } = {},
  ): string {
    const version = options.version ?? '1.0.0'
    const dir = join(home, 'profiles', 'desktop', 'node_modules', ...packageName.split('/'))
    mkdirSync(dir, { recursive: true })
    const manifest: Record<string, unknown> = { name: packageName, version }
    if (options.bundlePatchField !== false) {
      manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
      writeFileSync(
        join(dir, 'cordis.patch.yml'),
        `- insert:\n    - id: ${markerId(packageName)}\n      name: ${packageName}\n`,
      )
    }
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest)}\n`)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'payload.js'), 'export const marker = 1\n')
    for (const [name, content] of Object.entries(options.files ?? {})) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), content)
    }
    return dir
  }

  function writeProfileLock(
    home: string,
    entries: readonly { packageName: string; version: string; integrity: string }[],
  ): void {
    const lines = ["lockfileVersion: '9.0'", 'importers:', '  .:', '    dependencies:']
    for (const entry of entries) {
      lines.push(`      '${entry.packageName}':`)
      lines.push(`        specifier: '${entry.version}'`)
      lines.push(`        version: '${entry.version}'`)
    }
    lines.push('packages:')
    for (const entry of entries) {
      lines.push(`  '${entry.packageName}@${entry.version}':`)
      lines.push('    resolution:')
      lines.push(`      integrity: '${entry.integrity}'`)
    }
    writeFileSync(join(home, 'profiles', 'desktop', 'pnpm-lock.yaml'), `${lines.join('\n')}\n`)
  }

  function declareProfileBundles(home: string, packageNames: readonly string[]): void {
    const path = join(ensureDesktopProfile(home), 'package.json')
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dsh.profile.bundles.push(...packageNames)
    writeFileSync(path, `${JSON.stringify(manifest)}\n`)
  }

  function bootReceipt(dir: string, packageName: string, version: string): DesktopBootReceipt {
    return {
      packageName,
      version,
      manifestSequence: 7,
      keyId: bootKeyId,
      rootDigest: computeDesktopBootTreeRootDigest(dir),
    }
  }

  function prepareLocked(
    home: string,
    inputs: DesktopBootVerificationInputs | undefined,
    options: { policy?: DesktopPolicy } = {},
  ) {
    return prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      undefined,
      undefined,
      {},
      options.policy ?? bootPolicy(true),
      inputs,
    )
  }

  /** Home with two signed third-party bundles installed, locked, and receipted. */
  function verifiedThirdPartyHome(): {
    home: string
    firstDir: string
    secondDir: string
    manifest: string
    receipts: DesktopBootReceipt[]
  } {
    const home = temporaryHome()
    const firstDir = installThirdPartyBundle(home, firstPlugin, {
      version: firstVersion,
      files: { 'lib/extra.js': 'export const extra = 2\n' },
    })
    const secondDir = installThirdPartyBundle(home, secondPlugin, { version: secondVersion })
    declareProfileBundles(home, [firstPlugin, secondPlugin])
    writeProfileLock(home, [
      { packageName: firstPlugin, version: firstVersion, integrity: firstIntegrity },
      { packageName: secondPlugin, version: secondVersion, integrity: secondIntegrity },
    ])
    return {
      home,
      firstDir,
      secondDir,
      manifest: manifestText([
        manifestEntry(firstPlugin, firstVersion, firstIntegrity),
        manifestEntry(secondPlugin, secondVersion, secondIntegrity),
      ]),
      receipts: [
        bootReceipt(firstDir, firstPlugin, firstVersion),
        bootReceipt(secondDir, secondPlugin, secondVersion),
      ],
    }
  }

  it('keeps every verified third-party bundle with receipt evidence', () => {
    const fixture = verifiedThirdPartyHome()
    const prepared = prepareLocked(fixture.home, {
      manifestBytes: fixture.manifest,
      receipts: fixture.receipts,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.bootVerification).toEqual({
      manifestTrusted: true,
      manifestSequence: 7,
      keyId: bootKeyId,
      manifestFailure: undefined,
      allowed: [
        { packageName: firstPlugin, evidence: 'receipt', manifestSequence: 7, keyId: bootKeyId },
        { packageName: secondPlugin, evidence: 'receipt', manifestSequence: 7, keyId: bootKeyId },
      ],
      rejected: [],
    })
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([
      markerId(firstPlugin),
      markerId(secondPlugin),
    ]))
    // The upstream Web client rows stay composed alongside third-party content.
    expect(rows.find(row => row.id === 'webserver')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-webserver',
    }))
    expect(rows.find(row => row.id === 'ui-layout')?.name).toBe('@deepseek-ai/dsh-client-ui-layout')
  })

  it('rejects a tampered installed bundle while its peers and the upstream rows stay up', () => {
    const fixture = verifiedThirdPartyHome()
    writeFileSync(join(fixture.firstDir, 'lib', 'extra.js'), 'export const tampered = true\n')
    const prepared = prepareLocked(fixture.home, {
      manifestBytes: fixture.manifest,
      receipts: fixture.receipts,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.bootVerification?.rejected).toEqual([{
      packageName: firstPlugin,
      reason: `the installed files of ${firstPlugin}@${firstVersion} differ from the tree recorded in its install receipt`,
    }])
    expect(prepared.bootVerification?.allowed.map(entry => entry.packageName)).toEqual([secondPlugin])
    expect(rows.map(row => row.id)).not.toContain(markerId(firstPlugin))
    expect(rows.map(row => row.id)).toContain(markerId(secondPlugin))
    expect(rows.find(row => row.id === 'webserver')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-webserver',
    }))
  })

  it('rejects a bundle whose lockfile integrity diverges from the signed manifest', () => {
    const fixture = verifiedThirdPartyHome()
    writeProfileLock(fixture.home, [
      { packageName: firstPlugin, version: firstVersion, integrity: bootIntegrity(99) },
      { packageName: secondPlugin, version: secondVersion, integrity: secondIntegrity },
    ])
    const prepared = prepareLocked(fixture.home, {
      manifestBytes: fixture.manifest,
      receipts: fixture.receipts,
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.bootVerification?.rejected.map(entry => entry.packageName)).toEqual([firstPlugin])
    expect(prepared.bootVerification?.rejected[0]?.reason).toContain('profile lockfile pins')
    expect(rows.map(row => row.id)).not.toContain(markerId(firstPlugin))
    expect(rows.map(row => row.id)).toContain(markerId(secondPlugin))
    expect(rows.some(row => row.id === 'webserver')).toBe(true)
  })

  it('downgrades receiptless bundles to manifest-only evidence instead of rejecting them', () => {
    const fixture = verifiedThirdPartyHome()
    const prepared = prepareLocked(fixture.home, { manifestBytes: fixture.manifest })
    const rows = composeEntries([prepared.patches])

    expect(prepared.bootVerification?.rejected).toEqual([])
    expect(prepared.bootVerification?.allowed).toEqual([
      { packageName: firstPlugin, evidence: 'manifest-only', manifestSequence: 7, keyId: bootKeyId },
      { packageName: secondPlugin, evidence: 'manifest-only', manifestSequence: 7, keyId: bootKeyId },
    ])
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([
      markerId(firstPlugin),
      markerId(secondPlugin),
    ]))
  })

  it('rejects a bundle whose receipt records a different tree than measured', () => {
    const fixture = verifiedThirdPartyHome()
    const forged = fixture.receipts.map(receipt => receipt.packageName === firstPlugin
      ? { ...receipt, rootDigest: 'cd'.repeat(32) }
      : receipt)
    const prepared = prepareLocked(fixture.home, {
      manifestBytes: fixture.manifest,
      receipts: forged,
    })

    expect(prepared.bootVerification?.rejected.map(entry => entry.packageName)).toEqual([firstPlugin])
    expect(composeEntries([prepared.patches]).map(row => row.id)).not.toContain(markerId(firstPlugin))
  })

  it('rejects every third-party bundle but never the boot for manifest failures', () => {
    for (const [label, inputs, code] of [
      ['missing asset', { receipts: [] as DesktopBootReceipt[] }, 'manifest-missing'],
      ['expired manifest', {
        manifestBytes: manifestText(
          [manifestEntry(firstPlugin, firstVersion, firstIntegrity)],
          { expiresAt: '2020-01-01T00:00:00Z' },
        ),
        receipts: [],
      }, 'expired'],
      ['tampered signature', {
        manifestBytes: manifestText([manifestEntry(firstPlugin, firstVersion, firstIntegrity)])
          .replace(/"value":"[^"]{20}/u, '"value":"AAAA'),
        receipts: [],
      }, undefined],
    ] as const) {
      const fixture = verifiedThirdPartyHome()
      const prepared = prepareLocked(fixture.home, inputs as DesktopBootVerificationInputs)
      const rows = composeEntries([prepared.patches])

      expect(prepared.bootVerification?.manifestTrusted).toBe(false)
      if (code !== undefined) {
        expect(prepared.bootVerification?.manifestFailure?.code, label).toBe(code)
      }
      expect(prepared.bootVerification?.allowed, label).toEqual([])
      expect(prepared.bootVerification?.rejected.map(entry => entry.packageName).sort(), label)
        .toEqual([firstPlugin, secondPlugin])
      expect(rows.map(row => row.id)).not.toContain(markerId(firstPlugin))
      expect(rows.map(row => row.id)).not.toContain(markerId(secondPlugin))
      expect(rows.find(row => row.id === 'webserver'), label).toEqual(expect.objectContaining({
        name: '@deepseek-ai/dsh-host-webserver',
      }))
      expect(rows.find(row => row.id === 'desktop-shell')?.name).toBe(DESKTOP_PACKAGE_NAME)
    }
  })

  it('rejects a package installed by an external CLI bypassing the signed catalog', () => {
    const home = temporaryHome()
    const rogue = 'rogue-external-plugin'
    // A real external npm package: no dsh.bundle section, no manifest entry.
    installThirdPartyBundle(home, rogue, { version: '0.9.0', bundlePatchField: false })
    declareProfileBundles(home, [rogue])
    writeProfileLock(home, [{ packageName: rogue, version: '0.9.0', integrity: bootIntegrity(77) }])

    const prepared = prepareLocked(home, {
      manifestBytes: manifestText([]),
      receipts: [],
    })
    const rows = composeEntries([prepared.patches])

    expect(prepared.bootVerification?.rejected.map(entry => entry.packageName)).toEqual([rogue])
    expect(prepared.bootVerification?.rejected[0]?.reason).toContain(
      'is not in the signed company manifest',
    )
    expect(rows.map(row => row.id)).not.toContain(markerId(rogue))
    expect(rows.find(row => row.id === 'webserver')).toEqual(expect.objectContaining({
      name: '@deepseek-ai/dsh-host-webserver',
    }))
  })

  it('leaves unlocked builds completely unchanged', () => {
    const fixture = verifiedThirdPartyHome()
    const unlocked = prepareLocked(fixture.home, undefined, { policy: bootPolicy(false) })
    const rows = composeEntries([unlocked.patches])

    expect(unlocked.bootVerification).toBeUndefined()
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining([
      markerId(firstPlugin),
      markerId(secondPlugin),
    ]))

    const omittedPolicy = prepareDesktopProfile(undefined, fixture.home, 'darwin')
    expect(omittedPolicy.bootVerification).toBeUndefined()
    expect(composeEntries([omittedPolicy.patches]).map(row => row.id))
      .toContain(markerId(firstPlugin))
  })

  it('never rejects upstream, desktop, or market bundles (compatibility red line)', () => {
    const home = temporaryHome()
    const rogue = 'unsigned-third-party'
    installThirdPartyBundle(home, rogue)
    declareProfileBundles(home, [
      DESKTOP_MARKET_IDENTITIES.dshMarket.packageName,
      rogue,
    ])
    writeProfileLock(home, [{ packageName: rogue, version: '1.0.0', integrity: bootIntegrity(55) }])

    const prepared = prepareDesktopProfile(
      undefined,
      home,
      'darwin',
      'desktop',
      undefined,
      { requested: 'dsh-market', effective: 'dsh-market', legacyDefaulted: false },
      undefined,
      {},
      bootPolicy(true),
      { manifestBytes: manifestText([]), receipts: [] },
    )
    const rows = composeEntries([prepared.patches])
    const rejectedNames = prepared.bootVerification?.rejected.map(entry => entry.packageName)

    expect(rejectedNames).toEqual([rogue])
    expect(rejectedNames).not.toEqual(expect.arrayContaining([
      ...(PROFILE_TEMPLATES.web ?? []),
      DESKTOP_PACKAGE_NAME,
      DESKTOP_MARKET_IDENTITIES.community.packageName,
      DESKTOP_MARKET_IDENTITIES.dshMarket.packageName,
    ]))
    // The upstream default client and the selected market provider both stay bootable.
    for (const rowId of ['webserver', 'ui-layout', 'subprocess', 'sandbox']) {
      expect(rows.some(row => row.id === rowId), rowId).toBe(true)
    }
    expect(rows.filter(row => row.id === DESKTOP_MARKET_IDENTITIES.dshMarket.rowId)).toEqual([{
      id: DESKTOP_MARKET_IDENTITIES.dshMarket.rowId,
      name: DESKTOP_MARKET_IDENTITIES.dshMarket.packageName,
    }])
  })
})
