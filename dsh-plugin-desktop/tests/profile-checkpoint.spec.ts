import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopMarketTarballStagingPath } from '../src/company-tarball-handoff.ts'
import { desktopBootLockIntegrity, readDesktopBootLockfile } from '../src/boot-verification.ts'
import {
  DesktopProfileCheckpoint,
  clearDesktopProfileCheckpoint,
  type ProfileCheckpointOptions,
} from '../src/profile-checkpoint.ts'

const roots: string[] = []

function fixture(options: Partial<ProfileCheckpointOptions> = {}): {
  root: string
  profile: string
  userData: string
  checkpoint: DesktopProfileCheckpoint
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-checkpoint-'))
  roots.push(root)
  const profile = join(root, 'profile')
  const userData = join(root, 'user-data')
  mkdirSync(profile)
  mkdirSync(userData)
  writeFileSync(join(profile, 'package.json'), '{"name":"healthy"}\n')
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), 'patch: []\n')
  const checkpoint = new DesktopProfileCheckpoint({
    userDataDir: userData,
    profileDir: profile,
    profileIdentity: 'profile-identity',
    profileName: 'work',
    provider: 'dsh-market',
    ...options,
  })
  return { root, profile, userData, checkpoint }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop profile health checkpoint', () => {
  it('captures required files and records an absent optional market state', () => {
    const target = fixture()
    const result = target.checkpoint.captureHealthy()
    expect(result.snapshotExists).toBe(true)
    expect(result.manifest.files).toEqual(expect.arrayContaining([
      { name: '.dsh-market/state.json', present: false },
    ]))
    expect(target.checkpoint.inspectRestore()).toMatchObject({
      snapshotExists: true,
      currentDiffers: false,
      restoreAttempted: false,
    })
  })

  it('requires package.json while recording absent declarative files', () => {
    const target = fixture()
    unlinkSync(join(target.profile, 'package.json'))
    expect(() => target.checkpoint.captureHealthy()).toThrow('package.json is unavailable')

    const missingLock = fixture()
    unlinkSync(join(missingLock.profile, 'pnpm-lock.yaml'))
    expect(() => missingLock.checkpoint.captureHealthy()).not.toThrow()

    const optional = fixture()
    expect(() => optional.checkpoint.captureHealthy()).not.toThrow()
  })

  it('rejects a symlink and an oversized allowlisted file', () => {
    const symlink = fixture()
    unlinkSync(join(symlink.profile, 'cordis.patch.yml'))
    writeFileSync(join(symlink.root, 'outside.yml'), 'outside\n')
    symlinkSync(join(symlink.root, 'outside.yml'), join(symlink.profile, 'cordis.patch.yml'))
    expect(() => symlink.checkpoint.captureHealthy()).toThrow('regular file')

    const oversized = fixture({ maxFileBytes: { 'package.json': 4 } })
    expect(() => oversized.checkpoint.captureHealthy()).toThrow('too large')
  })

  it('publishes a complete atomic snapshot and deduplicates an unchanged healthy boot', () => {
    const target = fixture()
    const first = target.checkpoint.captureHealthy()
    const second = target.checkpoint.captureHealthy()
    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(readdirSync(join(target.userData, 'health-snapshots'))).toHaveLength(1)
    expect(readdirSync(target.checkpoint.snapshotDirectory)).not.toEqual(expect.arrayContaining([
      expect.stringContaining('.tmp'),
      expect.stringContaining('.staging'),
    ]))
    if (process.platform !== 'win32') {
      expect(lstatSync(join(target.checkpoint.snapshotDirectory, 'manifest.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('restores drift, removes files absent from the healthy image, and marks one failed generation', () => {
    const target = fixture()
    target.checkpoint.captureHealthy()
    writeFileSync(join(target.profile, 'package.json'), '{"name":"broken"}\n')
    mkdirSync(join(target.profile, '.dsh-market'))
    writeFileSync(join(target.profile, '.dsh-market', 'state.json'), '{}\n', { flag: 'w' })
    const inspection = target.checkpoint.inspectRestore()
    expect(inspection.currentDiffers).toBe(true)
    expect(inspection.changedFiles).toContain('package.json')
    expect(inspection.changedFiles).toContain('.dsh-market/state.json')

    const restored = target.checkpoint.restoreLatest('generation-1')
    expect(restored.status).toBe('restored')
    expect(restored.changedFiles).toContain('package.json')
    expect(readFileSync(join(target.profile, 'package.json'), 'utf8')).toBe('{"name":"healthy"}\n')
    expect(existsSync(join(target.profile, '.dsh-market', 'state.json'))).toBe(false)
    expect(target.checkpoint.inspectRestore()).toMatchObject({
      currentDiffers: false,
      restoreAttempted: true,
      failureGeneration: 'generation-1',
    })
    const repeated = target.checkpoint.restoreLatest('generation-1')
    expect(repeated.status).toBe('already-attempted')
    target.checkpoint.captureHealthy()
    expect(target.checkpoint.inspectRestore().restoreAttempted).toBe(false)
  })
})

describe('Desktop profile checkpoint market tarballs (#73 defect C)', () => {
  const TARBALL = Buffer.from('staged market tarball fixture bytes\n')
  const TARBALL_SHA512 = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`

  function writeStagedTarball(profile: string, packageName: string, version: string, bytes: Buffer = TARBALL): string {
    const path = desktopMarketTarballStagingPath(profile, packageName, version)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
    return path
  }

  /** pnpm lockfile shape that pins the staged tarball through `file:` (P7 2c). */
  function writeFilePinLockfile(profile: string, packageName: string, version: string, stagedPath: string): void {
    const relativeStaged = relative(profile, stagedPath).split(sep).join('/')
    writeFileSync(join(profile, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      `      '${packageName}':`,
      `        specifier: 'file:${stagedPath}'`,
      `        version: 'file:${relativeStaged}'`,
      'packages:',
      `  '${packageName}@file:${relativeStaged}':`,
      '    resolution:',
      `      integrity: '${TARBALL_SHA512}'`,
      `    version: '${version}'`,
      'snapshots:',
      `  '${packageName}@file:${relativeStaged}': {}`,
      '',
    ].join('\n'))
  }

  it('revives the staged tarballs after the whole profile directory is deleted, keeping file: lock pins verifiable', () => {
    const target = fixture()
    const stagedPath = writeStagedTarball(target.profile, 'third-party-plugin', '1.4.0')
    writeFilePinLockfile(target.profile, 'third-party-plugin', '1.4.0', stagedPath)
    const manifest = target.checkpoint.captureHealthy().manifest
    expect(manifest.tarballs).toEqual([
      { name: 'third-party-plugin-1.4.0.tgz', sha256: createHash('sha256').update(TARBALL).digest('hex'), size: TARBALL.byteLength },
    ])
    // The receipt ledger lives in the DSH home settings document, never in
    // the profile checkpoint: no receipt data is captured, so a restore can
    // never rebuild install authority (the market shows "Installed another
    // way" until the user reinstalls).
    expect(JSON.stringify(manifest)).not.toContain('receipt')

    // The incident: the user deletes the entire profile directory.
    rmSync(target.profile, { recursive: true })
    mkdirSync(target.profile)
    const restored = target.checkpoint.restoreLatest('generation-73')
    expect(restored.status).toBe('restored')
    expect(readFileSync(stagedPath, 'utf8')).toBe(TARBALL.toString('utf8'))
    expect(readFileSync(join(target.profile, 'pnpm-lock.yaml'), 'utf8')).toContain('file:')
    // The restored tarball makes the controlled `file:` pin verifiable for
    // boot verification again — the exact state the destroyed profile lost.
    const lockfile = readDesktopBootLockfile(target.profile)!
    expect(desktopBootLockIntegrity(lockfile, 'third-party-plugin', '1.4.0', { profileDir: target.profile }))
      .toBe(TARBALL_SHA512)
  })

  it('restores staged tarballs add-only: a rollback never deletes one the snapshot lacks', () => {
    const target = fixture()
    target.checkpoint.captureHealthy()
    // A tarball the healthy snapshot never saw (for example a newer install
    // whose first boot failed) stays on disk through the rollback: deleting
    // it could break a `file:` lock pin this very restore just wrote back.
    const unSnapshotTarball = writeStagedTarball(target.profile, 'new-plugin', '2.0.0')
    writeFileSync(join(target.profile, 'package.json'), '{"name":"broken"}\n')
    const restored = target.checkpoint.restoreLatest('generation-1')
    expect(restored.status).toBe('restored')
    expect(existsSync(unSnapshotTarball)).toBe(true)

    // The checkpoint rolls with every healthy boot: the next capture records
    // the tarball, so a later destroyed-profile restore revives it too.
    const manifest = target.checkpoint.captureHealthy().manifest
    expect(manifest.tarballs?.map(record => record.name)).toEqual(['new-plugin-2.0.0.tgz'])
    rmSync(target.profile, { recursive: true })
    mkdirSync(target.profile)
    expect(target.checkpoint.restoreLatest('generation-2').status).toBe('restored')
    expect(readFileSync(unSnapshotTarball, 'utf8')).toBe(TARBALL.toString('utf8'))
  })

  it('degrades the capture on unsafe or over-limit staging entries — files snapshot still refreshes (review P1)', () => {
    // Tarball violations must never freeze the checkpoint: the rescue
    // mechanism depends on every healthy boot refreshing the snapshot.
    const symlinkWarnings: string[] = []
    const symlinkTarget = fixture({ logWarning: message => { symlinkWarnings.push(message) } })
    writeStagedTarball(symlinkTarget.profile, 'third-party-plugin', '1.4.0')
    const outside = join(symlinkTarget.root, 'outside.tgz')
    writeFileSync(outside, TARBALL)
    symlinkSync(outside, join(symlinkTarget.profile, '.dsh-market-tarballs', 'linked-plugin-1.0.0.tgz'))
    const symlinkResult = symlinkTarget.checkpoint.captureHealthy()
    expect(symlinkResult.deduplicated).toBe(false)
    expect(symlinkResult.manifest.tarballs).toBeUndefined()
    expect(symlinkWarnings.join('\n')).toContain('regular file')

    const unrecognizedWarnings: string[] = []
    const unrecognized = fixture({ logWarning: message => { unrecognizedWarnings.push(message) } })
    writeStagedTarball(unrecognized.profile, 'third-party-plugin', '1.4.0')
    writeFileSync(join(unrecognized.profile, '.dsh-market-tarballs', 'EVIL-NAME.tgz'), TARBALL)
    const unrecognizedResult = unrecognized.checkpoint.captureHealthy()
    expect(unrecognizedResult.manifest.tarballs).toBeUndefined()
    expect(unrecognizedWarnings.join('\n')).toContain('unrecognized name')

    const oversizedWarnings: string[] = []
    const oversized = fixture({ maxTarballBytes: 4, logWarning: message => { oversizedWarnings.push(message) } })
    writeStagedTarball(oversized.profile, 'third-party-plugin', '1.4.0')
    const oversizedResult = oversized.checkpoint.captureHealthy()
    expect(oversizedResult.manifest.tarballs).toBeUndefined()
    expect(oversizedWarnings.join('\n')).toContain('too large')
    // The files snapshot still landed: a second capture dedupes against it.
    expect(oversized.checkpoint.captureHealthy().deduplicated).toBe(true)
  })

  it('records and clears the pending dependency-sync flag on the restore marker', () => {
    const target = fixture()
    target.checkpoint.captureHealthy()
    expect(target.checkpoint.dependencySyncPending()).toBe(false)
    target.checkpoint.restoreLatest('generation-1')
    target.checkpoint.setDependencySyncPending(true)
    expect(target.checkpoint.dependencySyncPending()).toBe(true)
    // The marker keeps its restore-attempt semantics while the sync is owed.
    expect(target.checkpoint.inspectRestore()).toMatchObject({
      restoreAttempted: true,
      failureGeneration: 'generation-1',
    })
    target.checkpoint.setDependencySyncPending(false)
    expect(target.checkpoint.dependencySyncPending()).toBe(false)

    // Without a restore attempt there is nothing that could owe a sync, and
    // a marker-less checkpoint never reports one.
    const fresh = fixture()
    fresh.checkpoint.captureHealthy()
    expect(() => fresh.checkpoint.setDependencySyncPending(true)).toThrow('no restore attempt is available to mark')
    expect(fresh.checkpoint.dependencySyncPending()).toBe(false)
  })

  it('clears a crashed-capture .old- sibling so a failed boot cannot revive the pre-swap snapshot', () => {
    const target = fixture()
    // clearDesktopProfileCheckpoint derives the snapshot key from the Profile
    // path, so the checkpoint must carry that same identity.
    const checkpoint = new DesktopProfileCheckpoint({
      userDataDir: target.userData,
      profileDir: target.profile,
      profileName: 'work',
      provider: 'dsh-market',
    })
    const captured = checkpoint.captureHealthy()
    // A capture that died between its two renames: `latest` was moved aside
    // and the staged replacement never landed.
    renameSync(captured.snapshotDirectory, `${captured.snapshotDirectory}.old-deadbeef`)
    // The Profile was rebuilt since the capture (post-swap composition).
    writeFileSync(join(target.profile, 'package.json'), '{"name":"post-swap"}\n')

    clearDesktopProfileCheckpoint(target.userData, target.profile)

    // Without the sibling cleanup, recoverOrphanedLatest would promote the
    // pre-swap snapshot back to `latest` and restore it into the rebuilt tree.
    expect(checkpoint.inspectRestore()).toMatchObject({ snapshotExists: false })
    expect(() => checkpoint.restoreLatest('generation-1')).toThrow('no healthy profile checkpoint exists')
    expect(readFileSync(join(target.profile, 'package.json'), 'utf8')).toBe('{"name":"post-swap"}\n')
  })
})
