/**
 * Fresh-Profile swap (P14): the rebuild primitive behind the automatic
 * version-change reset and the recovery window's manual action.
 *
 * The automatic layer's red/green lives in {@link freshProfileResetDecision}
 * (version change triggers, unchanged does not, an opted-out or unlocked
 * build never does); the swap itself is exercised against a real temporary
 * Harness home with the shipped first-run creation (`ensureDesktopProfile`),
 * so the "backup exists + the rebuilt Profile carries no third-party plugin"
 * acceptance is proven on the real filesystem, not a mock.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDesktopProfile } from '../src/profile.ts'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import {
  clearMarketInstallReceipts,
  freshProfileResetDecision,
  freshProfileSwap,
  profileBackupPath,
  profileBackupStamp,
  profileGenerationStatePath,
  readProfileGenerationState,
  writeProfileGenerationState,
} from '../src/fresh-profile.ts'

const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-fresh-profile-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const THIRD_PARTY = 'dsh-better-sidebar'

/** A profile that looks like a real machine's: base bundles + one plugin. */
function seededProfile(home: string): string {
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(join(profileDir, 'node_modules', THIRD_PARTY), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { [THIRD_PARTY]: '0.15.2' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', THIRD_PARTY],
        patchReload: 'live',
      },
    },
  }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(profileDir, 'dsh.patch.yml'), '[]\n')
  return profileDir
}

function seededSettings(home: string): string {
  const settingsPath = join(home, 'settings.yaml')
  writeFileSync(settingsPath, [
    '# user settings survive the swap',
    'theme: dark',
    'dsh-community-market:',
    '  sources: []',
    '  installReceipts:',
    '    - receiptId: receipt-1',
    '      profileName: desktop',
    '      packageName: dsh-better-sidebar',
    '    - receiptId: receipt-2',
    '      profileName: desktop',
    '      packageName: dsh-free-search',
    '',
  ].join('\n'))
  return settingsPath
}

function bundlesOf(profileDir: string): string[] {
  const manifest = readProfileManifest('dsh-plugin-desktop', profileDir)
  return ((manifest.dsh?.profile as { bundles?: string[] } | undefined)?.bundles ?? [])
}

describe('fresh profile reset decision', () => {
  it('triggers on an upgrade and on a downgrade', () => {
    for (const appBuildVersion of ['2.0.3+b76', '2.0.3+b74']) {
      expect(freshProfileResetDecision({
        locked: true,
        resetOnVersionChange: true,
        previousAppBuildVersion: '2.0.3+b75',
        appBuildVersion,
      })).toBe('reset')
    }
  })

  it('does nothing while the build identity is unchanged', () => {
    expect(freshProfileResetDecision({
      locked: true,
      resetOnVersionChange: true,
      previousAppBuildVersion: '2.0.3+b75',
      appBuildVersion: '2.0.3+b75',
    })).toBe('unchanged')
  })

  it('records the first observed build identity instead of resetting', () => {
    expect(freshProfileResetDecision({
      locked: true,
      resetOnVersionChange: true,
      appBuildVersion: '2.0.3+b75',
    })).toBe('record')
  })

  it('stays inert when the policy switch is off or the build is unlocked', () => {
    for (const options of [
      { locked: true, resetOnVersionChange: false },
      { locked: false, resetOnVersionChange: true },
      { locked: false, resetOnVersionChange: false },
    ]) {
      expect(freshProfileResetDecision({
        ...options,
        previousAppBuildVersion: '2.0.3+b74',
        appBuildVersion: '2.0.3+b75',
      })).toBe('unchanged')
    }
  })
})

describe('profile generation record', () => {
  it('round-trips the build identity and reads back undefined for anything else', () => {
    const home = temporaryHome()
    const statePath = profileGenerationStatePath(home)
    expect(statePath).toBe(join(home, 'last-profile-generation.json'))
    expect(readProfileGenerationState(statePath)).toBeUndefined()

    writeProfileGenerationState(statePath, {
      version: 1,
      appBuildVersion: '2.0.3+b75',
      updatedAt: '2026-09-09T07:33:19.264Z',
    })

    expect(readProfileGenerationState(statePath)).toEqual({
      version: 1,
      appBuildVersion: '2.0.3+b75',
      updatedAt: '2026-09-09T07:33:19.264Z',
    })

    for (const body of ['{broken', '[]', '{"version":2,"appBuildVersion":"x","updatedAt":"y"}',
      '{"version":1,"appBuildVersion":"","updatedAt":"y"}', '{"version":1,"appBuildVersion":"x"}']) {
      writeFileSync(statePath, body)
      expect(readProfileGenerationState(statePath), body).toBeUndefined()
    }
  })
})

describe('profile backup naming', () => {
  it('uses a Windows-safe UTC stamp', () => {
    const stamp = profileBackupStamp(Date.parse('2026-09-09T07:33:19.264Z'))

    expect(stamp).toBe('20260909T073319264Z')
    expect(stamp).not.toContain(':')
    expect(profileBackupPath('/home/u/.dsh/profiles/desktop', 0)).toMatch(/\/desktop\.bak-\d{8}T\d{9}Z$/u)
  })
})

describe('market install receipt clearing', () => {
  it('drops the ledger, keeps every other setting and comment, and is idempotent', () => {
    const home = temporaryHome()
    const settingsPath = seededSettings(home)

    expect(clearMarketInstallReceipts(settingsPath)).toBe(2)
    const cleared = readFileSync(settingsPath, 'utf8')
    expect(cleared).not.toContain('installReceipts')
    expect(cleared).not.toContain('receipt-1')
    expect(cleared).toContain('# user settings survive the swap')
    expect(cleared).toContain('theme: dark')
    expect(cleared).toContain('sources: []')

    expect(clearMarketInstallReceipts(settingsPath)).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toBe(cleared)
  })

  it('reads a missing document, missing key, or shapeless ledger as nothing to clear', () => {
    const home = temporaryHome()
    expect(clearMarketInstallReceipts(join(home, 'absent.yaml'))).toBe(0)

    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, 'theme: dark\n')
    expect(clearMarketInstallReceipts(settingsPath)).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toBe('theme: dark\n')

    writeFileSync(settingsPath, 'dsh-community-market:\n  installReceipts: nope\n')
    expect(clearMarketInstallReceipts(settingsPath)).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('installReceipts')
  })

  it('refuses to rewrite an unparseable document', () => {
    const home = temporaryHome()
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, 'a: [b\n')

    expect(() => clearMarketInstallReceipts(settingsPath)).toThrow('is not parseable YAML')
    expect(readFileSync(settingsPath, 'utf8')).toBe('a: [b\n')
  })
})

describe('fresh profile swap', () => {
  function swapOptions(home: string, overrides: Record<string, unknown> = {}) {
    return {
      home,
      profileName: 'desktop',
      settingsDocumentPath: join(home, 'settings.yaml'),
      createProfile: () => { ensureDesktopProfile(home) },
      materialize: async () => true,
      now: () => Date.parse('2026-09-09T07:33:19.264Z'),
      ...overrides,
    }
  }

  it('sets the old Profile aside and rebuilds a Profile with no third-party plugin', async () => {
    const home = temporaryHome()
    const profileDir = seededProfile(home)
    const settingsPath = seededSettings(home)

    const result = await freshProfileSwap(swapOptions(home))

    expect(result).toEqual({
      profileName: 'desktop',
      profileDir,
      backupDir: `${profileDir}.bak-20260909T073319264Z`,
      materialized: true,
      receiptsCleared: 2,
    })
    // The old Profile is preserved for forensics/rollback, byte for byte.
    expect(bundlesOf(result.backupDir!)).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', THIRD_PARTY,
    ])
    expect(existsSync(join(result.backupDir!, 'node_modules', THIRD_PARTY))).toBe(true)
    // The rebuilt Profile is the shipped first-run composition: zero
    // third-party plugins, and no market ledger left to claim otherwise.
    expect(bundlesOf(profileDir)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(existsSync(join(profileDir, 'node_modules', THIRD_PARTY))).toBe(false)
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('installReceipts')
  })

  it('is idempotent: a second swap rebuilds again and clears nothing', async () => {
    const home = temporaryHome()
    seededProfile(home)
    const settingsPath = seededSettings(home)

    await freshProfileSwap(swapOptions(home))
    const afterFirst = readFileSync(settingsPath, 'utf8')
    const second = await freshProfileSwap(swapOptions(home))

    expect(second.backupDir).toBe(join(home, 'profiles', 'desktop.bak-20260909T073319264Z-1'))
    expect(second.receiptsCleared).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toBe(afterFirst)
    expect(bundlesOf(join(home, 'profiles', 'desktop'))).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
    ])
  })

  it('rebuilds without a backup when no Profile directory exists', async () => {
    const home = temporaryHome()

    const result = await freshProfileSwap(swapOptions(home, { materialize: undefined }))

    expect(result.backupDir).toBeUndefined()
    expect(result.materialized).toBe(false)
    expect(existsSync(join(result.profileDir, 'package.json'))).toBe(true)
  })

  it('never renames a Profile directory that is not a real directory', async () => {
    const home = temporaryHome()
    const profiles = join(home, 'profiles')
    mkdirSync(profiles, { recursive: true })
    symlinkSync(temporaryHome(), join(profiles, 'desktop'))

    await expect(freshProfileSwap(swapOptions(home))).rejects.toThrow('is not a real directory')
  })

  it('completes the rebuild even when the market ledger cannot be cleared', async () => {
    const home = temporaryHome()
    seededProfile(home)
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, 'a: [b\n')
    const logError = vi.fn()

    const result = await freshProfileSwap(swapOptions(home, { logError }))

    expect(result.receiptsCleared).toBe(0)
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('could not clear the market install receipts'))
    expect(bundlesOf(result.profileDir)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })

  it('rejects a profile name that must not cross the path boundary', async () => {
    const home = temporaryHome()

    await expect(freshProfileSwap(swapOptions(home, { profileName: '../escape' })))
      .rejects.toThrow('invalid desktop profile name')
  })
})
