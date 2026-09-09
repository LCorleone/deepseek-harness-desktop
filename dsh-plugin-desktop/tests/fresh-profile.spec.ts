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
  readdirSync,
  renameSync,
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
  FRESH_PROFILE_PENDING_FILENAME,
  clearFreshProfilePending,
  clearMarketInstallReceipts,
  freshProfilePendingStatePath,
  freshProfileResetDecision,
  freshProfileSwap,
  profileBackupPath,
  profileBackupStamp,
  profileGenerationStatePath,
  pruneProfileBackups,
  readFreshProfilePending,
  readProfileGenerationState,
  writeFreshProfilePending,
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
    '    - receiptId: receipt-3',
    '      profileName: work',
    '      packageName: dsh-work-plugin',
    '',
  ].join('\n'))
  return settingsPath
}

function bundlesOf(profileDir: string): string[] {
  const manifest = readProfileManifest('dsh-plugin-desktop', profileDir)
  return ((manifest.dsh?.profile as { bundles?: string[] } | undefined)?.bundles ?? [])
}

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

describe('fresh profile reset decision', () => {
  it('triggers on an upgrade and on a downgrade', () => {
    for (const appBuildVersion of ['2.0.3+b76', '2.0.3+b74']) {
      expect(freshProfileResetDecision({
        locked: true,
        resetOnVersionChange: true,
        previousAppBuildVersion: '2.0.3+b75',
        appBuildVersion,
        profileExists: true,
      })).toBe('reset')
    }
  })

  it('does nothing while the build identity is unchanged', () => {
    expect(freshProfileResetDecision({
      locked: true,
      resetOnVersionChange: true,
      previousAppBuildVersion: '2.0.3+b75',
      appBuildVersion: '2.0.3+b75',
      profileExists: true,
    })).toBe('unchanged')
  })

  it('treats a missing record as a version change and rebuilds an existing Profile', () => {
    expect(freshProfileResetDecision({
      locked: true,
      resetOnVersionChange: true,
      appBuildVersion: '2.0.3+b76',
      profileExists: true,
    })).toBe('reset')
  })

  it('only records the first identity when no Profile exists (a genuinely fresh install)', () => {
    expect(freshProfileResetDecision({
      locked: true,
      resetOnVersionChange: true,
      appBuildVersion: '2.0.3+b76',
      profileExists: false,
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
        profileExists: true,
      })).toBe('unchanged')
    }
  })
})

describe('profile generation record', () => {
  it('round-trips the build identity and reads back undefined for anything else', async () => {
    const home = temporaryHome()
    const statePath = profileGenerationStatePath(home)
    expect(statePath).toBe(join(home, 'last-profile-generation.json'))
    expect(readProfileGenerationState(statePath)).toBeUndefined()

    await writeProfileGenerationState(statePath, {
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
  it('drops only this Profile\'s receipts, keeps every other setting and comment, and is idempotent', async () => {
    const home = temporaryHome()
    const settingsPath = seededSettings(home)

    expect(await clearMarketInstallReceipts(settingsPath, 'desktop')).toBe(2)
    const cleared = readFileSync(settingsPath, 'utf8')
    expect(cleared).not.toContain('receipt-1')
    expect(cleared).not.toContain('receipt-2')
    // The sibling Profile's receipt is home-shared state and must survive.
    expect(cleared).toContain('receipt-3')
    expect(cleared).toContain('profileName: work')
    expect(cleared).toContain('# user settings survive the swap')
    expect(cleared).toContain('theme: dark')
    expect(cleared).toContain('sources: []')

    expect(await clearMarketInstallReceipts(settingsPath, 'desktop')).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toBe(cleared)

    expect(await clearMarketInstallReceipts(settingsPath, 'work')).toBe(1)
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('installReceipts')
  })

  it('reads a missing document, missing key, or shapeless ledger as nothing to clear', async () => {
    const home = temporaryHome()
    expect(await clearMarketInstallReceipts(join(home, 'absent.yaml'), 'desktop')).toBe(0)

    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, 'theme: dark\n')
    expect(await clearMarketInstallReceipts(settingsPath, 'desktop')).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).toBe('theme: dark\n')

    writeFileSync(settingsPath, 'dsh-community-market:\n  installReceipts: nope\n')
    expect(await clearMarketInstallReceipts(settingsPath, 'desktop')).toBe(0)
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('installReceipts')
  })

  it('refuses to rewrite an unparseable document', async () => {
    const home = temporaryHome()
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, 'a: [b\n')

    await expect(clearMarketInstallReceipts(settingsPath, 'desktop')).rejects.toThrow('is not parseable YAML')
    expect(readFileSync(settingsPath, 'utf8')).toBe('a: [b\n')
  })

  it('reads under the document owner\'s writer lock so a concurrent commit is never overwritten', async () => {
    const home = temporaryHome()
    const settingsPath = seededSettings(home)
    // Hold the same cross-process writer lock `settings-file` takes.
    writeFileSync(`${settingsPath}.lock`, `${process.pid}\n`)
    let settled = false
    const clearing = clearMarketInstallReceipts(settingsPath, 'desktop').finally(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    // Blocked on the lock: nothing was read or rewritten yet.
    expect(settled).toBe(false)
    expect(readFileSync(settingsPath, 'utf8')).toContain('receipt-1')
    // The owner commits another Profile's receipt while the lock is held, then
    // releases it. The clear must read after acquiring the lock, so that
    // receipt survives instead of being clobbered by our rename.
    const held = readFileSync(settingsPath, 'utf8')
    const committed = held.replace(
      '      packageName: dsh-work-plugin\n',
      '      packageName: dsh-work-plugin\n    - receiptId: receipt-4\n      profileName: work\n      packageName: dsh-work-two\n',
    )
    expect(committed).not.toBe(held)
    writeFileSync(settingsPath, committed)
    rmSync(`${settingsPath}.lock`, { force: true })

    expect(await clearing).toBe(2)
    const after = readFileSync(settingsPath, 'utf8')
    expect(after).toContain('receipt-4')
    expect(after).not.toContain('receipt-1')
    expect(after).not.toContain('receipt-2')
  })
})

describe('profile backup retention', () => {
  it('keeps only the newest set-aside directories and leaves lookalikes alone', async () => {
    const home = temporaryHome()
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    const stamps = [
      '20260909T073319264Z',
      '20260910T073319264Z',
      '20260911T073319264Z',
      '20260912T073319264Z',
    ]
    for (const stamp of stamps) mkdirSync(`${profileDir}.bak-${stamp}`, { recursive: true })
    // Not a swap stamp: never pruned by the retention bound.
    mkdirSync(`${profileDir}.bak-notes`, { recursive: true })

    const removed = [...await pruneProfileBackups(profileDir)].sort()

    expect(removed).toEqual([`desktop.bak-${stamps[0]}`, `desktop.bak-${stamps[1]}`])
    for (const stamp of stamps.slice(0, 2)) expect(existsSync(`${profileDir}.bak-${stamp}`)).toBe(false)
    for (const stamp of stamps.slice(2)) expect(existsSync(`${profileDir}.bak-${stamp}`)).toBe(true)
    expect(existsSync(`${profileDir}.bak-notes`)).toBe(true)
  })

  it('prunes the oldest backup after a swap so the fleet cannot accumulate one per upgrade', async () => {
    const home = temporaryHome()
    seededProfile(home)
    seededSettings(home)

    const first = await freshProfileSwap(swapOptions(home))
    const second = await freshProfileSwap(swapOptions(home, {
      now: () => Date.parse('2026-09-10T07:33:19.264Z'),
    }))
    const third = await freshProfileSwap(swapOptions(home, { now: () => Date.parse('2026-09-11T07:33:19.264Z') }))
    await Promise.all([first.pruneBackups, second.pruneBackups, third.pruneBackups])

    expect(second.backupDir).toBe(join(home, 'profiles', 'desktop.bak-20260910T073319264Z'))
    expect(readdirSync(join(home, 'profiles')).filter(name => name.includes('.bak-')).sort()).toEqual([
      'desktop.bak-20260910T073319264Z',
      'desktop.bak-20260911T073319264Z',
    ])
  })

  it('returns from the swap before the recursive backup removal runs', async () => {
    const home = temporaryHome()
    const profileDir = seededProfile(home)
    seededSettings(home)
    for (const stamp of ['20260905T073319264Z', '20260906T073319264Z', '20260907T073319264Z']) {
      mkdirSync(`${profileDir}.bak-${stamp}`, { recursive: true })
    }

    const result = await freshProfileSwap(swapOptions(home))

    // Detached: the swap already returned while the recursive removal is
    // still in flight, so a multi-hundred-megabyte prune never blocks the
    // startup path that spawned it.
    expect(existsSync(`${profileDir}.bak-20260905T073319264Z`)).toBe(true)
    expect(await result.pruneBackups).toEqual(expect.arrayContaining([
      'desktop.bak-20260905T073319264Z',
      'desktop.bak-20260906T073319264Z',
    ]))
    expect(existsSync(`${profileDir}.bak-20260905T073319264Z`)).toBe(false)
    expect(existsSync(`${profileDir}.bak-20260906T073319264Z`)).toBe(false)
    expect(existsSync(`${profileDir}.bak-20260907T073319264Z`)).toBe(true)
  })
})

describe('fresh profile swap', () => {
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
      pruneBackups: expect.any(Promise),
    })
    // The old Profile is preserved for forensics/rollback, byte for byte.
    expect(bundlesOf(result.backupDir!)).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', THIRD_PARTY,
    ])
    expect(existsSync(join(result.backupDir!, 'node_modules', THIRD_PARTY))).toBe(true)
    // The rebuilt Profile is the shipped first-run composition: zero
    // third-party plugins, and no receipt of this Profile left to claim
    // otherwise — while the sibling Profile's receipt survives.
    expect(bundlesOf(profileDir)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(existsSync(join(profileDir, 'node_modules', THIRD_PARTY))).toBe(false)
    const settings = readFileSync(settingsPath, 'utf8')
    expect(settings).not.toContain('receipt-1')
    expect(settings).toContain('receipt-3')
  })

  it('invalidates the Profile health checkpoint once the rebuild succeeded', async () => {
    const home = temporaryHome()
    seededProfile(home)
    seededSettings(home)
    const clearCheckpoint = vi.fn()

    await freshProfileSwap(swapOptions(home, { clearCheckpoint }))

    expect(clearCheckpoint).toHaveBeenCalledTimes(1)
  })

  it('does not touch the checkpoint when the Profile could not be created', async () => {
    const home = temporaryHome()
    seededProfile(home)
    const clearCheckpoint = vi.fn()

    await expect(freshProfileSwap(swapOptions(home, {
      clearCheckpoint,
      createProfile: () => { throw new Error('create failed') },
    }))).rejects.toThrow('create failed')
    expect(clearCheckpoint).not.toHaveBeenCalled()
  })

  it('reports a checkpoint invalidation failure without failing the rebuild', async () => {
    const home = temporaryHome()
    seededProfile(home)
    seededSettings(home)
    const logError = vi.fn()

    const result = await freshProfileSwap(swapOptions(home, {
      clearCheckpoint: () => { throw new Error('checkpoint locked') },
      logError,
    }))

    expect(result.materialized).toBe(true)
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('could not clear the health checkpoint'))
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

/** The Windows refusal the whole retry schedule exists for. */
function busyError(): NodeJS.ErrnoException {
  const error = new Error('EBUSY: resource busy or locked') as NodeJS.ErrnoException
  error.code = 'EBUSY'
  return error
}

describe('locked set-aside rename (Windows EBUSY)', () => {
  it('retries with backoff and completes once the handle is released', async () => {
    const home = temporaryHome()
    const profileDir = seededProfile(home)
    seededSettings(home)
    const logError = vi.fn()
    const slept: number[] = []
    let refusals = 2
    const rename = vi.fn((from: string, to: string) => {
      if (refusals > 0) {
        refusals -= 1
        throw busyError()
      }
      renameSync(from, to)
    })

    const result = await freshProfileSwap(swapOptions(home, {
      logError,
      rename,
      sleep: async (ms: number) => { slept.push(ms) },
    }))

    expect(result.deferred).toBeUndefined()
    expect(result.backupDir).toBe(`${profileDir}.bak-20260909T073319264Z`)
    expect(result.materialized).toBe(true)
    // 100/200: the first two backoff steps, and the third attempt landed.
    expect(slept).toEqual([100, 200])
    expect(logError).toHaveBeenCalledTimes(2)
    expect(logError.mock.calls[0]![0]).toContain('rename attempt 1 of 7: EBUSY')
    expect(logError.mock.calls[1]![0]).toContain('rename attempt 2 of 7: EBUSY')
  })

  it('defers instead of failing when every rename retry stays locked, leaving the old Profile bootable', async () => {
    const home = temporaryHome()
    const profileDir = seededProfile(home)
    const logError = vi.fn()
    const slept: number[] = []
    const createProfile = vi.fn()

    const result = await freshProfileSwap(swapOptions(home, {
      logError,
      createProfile,
      rename: () => { throw busyError() },
      sleep: async (ms: number) => { slept.push(ms) },
    }))

    expect(result).toMatchObject({
      profileName: 'desktop',
      profileDir,
      deferred: true,
      reasonCode: 'EBUSY',
      attempts: 7,
      materialized: false,
      receiptsCleared: 0,
    })
    expect(result.backupDir).toBeUndefined()
    expect(slept).toEqual([100, 200, 400, 800, 1600, 3200])
    expect(logError).toHaveBeenCalledTimes(6)
    expect(createProfile).not.toHaveBeenCalled()
    // Nothing was renamed or rebuilt: the same Profile is still on disk, whole.
    expect(bundlesOf(profileDir)).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', THIRD_PARTY])
    expect(readdirSync(join(home, 'profiles')).some(name => name.includes('.bak-'))).toBe(false)
  })

  it('fails immediately on a rename error that is not a transient lock', async () => {
    const home = temporaryHome()
    seededProfile(home)
    const sleep = vi.fn()
    const rename = vi.fn(() => {
      const error = new Error('EXDEV: cross-device link') as NodeJS.ErrnoException
      error.code = 'EXDEV'
      throw error
    })

    await expect(freshProfileSwap(swapOptions(home, { rename, sleep }))).rejects.toThrow('EXDEV')
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('deferred rebuild marker', () => {
  it('round-trips, ignores malformed or path-escaping documents, and clears', async () => {
    const userData = temporaryHome()
    const statePath = freshProfilePendingStatePath(userData)

    expect(statePath).toBe(join(userData, FRESH_PROFILE_PENDING_FILENAME))
    expect(readFreshProfilePending(statePath)).toBeUndefined()

    await writeFreshProfilePending(statePath, {
      version: 1,
      profileName: 'desktop',
      appBuildVersion: '2.0.3+b77',
      reason: 'EBUSY',
    })
    expect(readFreshProfilePending(statePath)).toEqual({
      version: 1,
      profileName: 'desktop',
      appBuildVersion: '2.0.3+b77',
      reason: 'EBUSY',
    })

    for (const body of [
      '{broken',
      '[]',
      '{"version":2,"profileName":"desktop","appBuildVersion":"x","reason":"EBUSY"}',
      '{"version":1,"profileName":"../escape","appBuildVersion":"x","reason":"EBUSY"}',
      '{"version":1,"profileName":"desktop","appBuildVersion":"","reason":"EBUSY"}',
      '{"version":1,"profileName":"desktop","appBuildVersion":"x"}',
    ]) {
      writeFileSync(statePath, body)
      expect(readFreshProfilePending(statePath), body).toBeUndefined()
    }

    await writeFreshProfilePending(statePath, {
      version: 1,
      profileName: 'desktop',
      appBuildVersion: '2.0.3+b77',
      reason: 'EBUSY',
    })
    clearFreshProfilePending(statePath)
    expect(readFreshProfilePending(statePath)).toBeUndefined()
    // Clearing an absent marker is a no-op, not a throw.
    clearFreshProfilePending(statePath)
  })

  it('lets the next boot read the marker, land the retry, and clear it', async () => {
    const home = temporaryHome()
    const userData = temporaryHome()
    seededProfile(home)
    seededSettings(home)
    const statePath = freshProfilePendingStatePath(userData)

    // First boot: the rename stays locked, so the swap defers and the boot
    // records a marker instead of failing.
    const deferred = await freshProfileSwap(swapOptions(home, {
      rename: () => { throw busyError() },
      sleep: async () => {},
    }))
    expect(deferred.deferred).toBe(true)
    await writeFreshProfilePending(statePath, {
      version: 1,
      profileName: deferred.profileName,
      appBuildVersion: '2.0.3+b77',
      reason: deferred.reasonCode ?? 'EBUSY',
    })

    // Next boot: the marker is read first and the lock is gone, so the retry
    // lands and the marker is cleared.
    const pending = readFreshProfilePending(statePath)
    expect(pending?.profileName).toBe('desktop')
    const retried = await freshProfileSwap(swapOptions(home))
    expect(retried.deferred).toBeUndefined()
    expect(retried.materialized).toBe(true)
    clearFreshProfilePending(statePath)
    expect(readFreshProfilePending(statePath)).toBeUndefined()
    expect(bundlesOf(join(home, 'profiles', 'desktop'))).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })
})
