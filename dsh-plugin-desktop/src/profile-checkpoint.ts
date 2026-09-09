/**
 * A small, profile-scoped last-known-good checkpoint for Desktop startup.
 *
 * This module deliberately only restores the declarative profile files (plus
 * the profile's staged market tarballs — see {@linkcode
 * DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY}). It does not run pnpm and it
 * never copies `node_modules` (or any other hot runtime state).
 */

import { createHash, randomUUID } from 'node:crypto'
import { DESKTOP_MARKET_TARBALL_MAX_BYTES } from './company-tarball-handoff.ts'
import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY } from './company-tarball-handoff.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const VERSION = 1
const SNAPSHOT_ROOT = 'health-snapshots'
const LATEST_DIRECTORY = 'latest'
const MANIFEST_FILENAME = 'manifest.json'
const MARKER_FILENAME = 'restore-marker.json'
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700
const CHECK_POSIX_MODE = process.platform !== 'win32'
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const ID_PATTERN = /^[A-Za-z0-9._:@/-]{1,256}$/u
/**
 * Staged market tarball and staged beta-manifest names the checkpoint admits
 * (`scope+name-1.2.3.tgz` and `catalog-manifest.beta.json`): flat, lowercase,
 * no path separators, so a record can never escape the staging directory.
 */
const TARBALL_NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,200}\.(?:tgz|json)$/u
const MAX_CHECKPOINT_TARBALLS = 512
// Caps mirror the install gate (DESKTOP_MARKET_TARBALL_MAX_BYTES): anything
// the market could legally stage must fit, or every healthy capture would
// degrade (see readCurrentTarballRecords — violations skip tarball
// checkpointing with a logged warning instead of freezing the checkpoint).
const DEFAULT_MAX_TARBALL_BYTES = DESKTOP_MARKET_TARBALL_MAX_BYTES
const DEFAULT_MAX_TARBALL_TOTAL_BYTES = 2 * DESKTOP_MARKET_TARBALL_MAX_BYTES

/** Files that can be checkpointed. The market state is optional. */
export const DESKTOP_PROFILE_CHECKPOINT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  '.dsh-market/state.json',
] as const

export type DesktopProfileCheckpointFilename = typeof DESKTOP_PROFILE_CHECKPOINT_FILES[number]

const FILE_LIMITS: Record<DesktopProfileCheckpointFilename, number> = {
  'package.json': 1 * 1024 * 1024,
  'pnpm-lock.yaml': 32 * 1024 * 1024,
  'pnpm-workspace.yaml': 1 * 1024 * 1024,
  'cordis.patch.yml': 1 * 1024 * 1024,
  '.dsh-market/state.json': 1 * 1024 * 1024,
}

export interface ProfileCheckpointOptions {
  /** Electron's userData directory. */
  readonly userDataDir?: string
  /** Alias accepted by callers that use the Electron name. */
  readonly userData?: string
  /** Absolute profile directory. */
  readonly profileDir?: string
  /** Alias accepted by profile services. */
  readonly profilePath?: string
  /** Stable identity supplied by the profile owner. */
  readonly profileIdentity?: string
  /** Human-readable profile name persisted in the manifest. */
  readonly profileName?: string
  /** Market/provider identity persisted in the manifest. */
  readonly provider?: string
  /** Override per-file limits in tests or an embedding product. */
  readonly maxFileBytes?: Partial<Record<DesktopProfileCheckpointFilename, number>>
  /** Warning sink for degraded (skipped) tarball checkpointing; defaults silent. */
  readonly logWarning?: (message: string) => void
  /** Override the per-tarball staging size limit in tests or an embedding product. */
  readonly maxTarballBytes?: number
  /** Override the total staged-tarball size limit in tests or an embedding product. */
  readonly maxTarballTotalBytes?: number
  /** Clock injection for deterministic tests. */
  readonly now?: () => number
}

export interface ProfileCheckpointFileRecord {
  readonly name: DesktopProfileCheckpointFilename
  readonly present: boolean
  readonly sha256?: string
  readonly size?: number
  readonly mode?: number
}

/** One staged market tarball captured for restore (non-trusted, re-verifiable bytes). */
export interface ProfileCheckpointTarballRecord {
  /** Flat staging file name inside the profile's market tarball staging directory. */
  readonly name: string
  readonly sha256: string
  readonly size: number
}

export interface ProfileCheckpointManifest {
  readonly version: 1
  readonly snapshotId: string
  readonly capturedAt: string
  readonly profileIdentity: string
  readonly profileName: string
  readonly provider: string
  readonly files: readonly ProfileCheckpointFileRecord[]
  /**
   * Staged market tarballs of the last healthy boot. Omitted when the staging
   * directory was empty (older snapshots predate the field and read as empty).
   * These bytes are never trusted: every consumer re-verifies them against the
   * signed catalog, so restoring them repairs the `file:` lock pins without
   * minting any install authority. Market install receipts are deliberately
   * NOT checkpointed — they are the install-authority ledger in the DSH home
   * settings document and must never be rebuilt from a restore.
   */
  readonly tarballs?: readonly ProfileCheckpointTarballRecord[]
}

export interface CaptureHealthyResult {
  readonly snapshotExists: true
  readonly deduplicated: boolean
  readonly snapshotDirectory: string
  readonly manifest: ProfileCheckpointManifest
}

export interface RestoreInspection {
  readonly snapshotExists: boolean
  readonly currentDiffers: boolean
  readonly restoreAttempted: boolean
  readonly failureGeneration?: string
  readonly changedFiles: readonly DesktopProfileCheckpointFilename[]
  readonly manifest?: ProfileCheckpointManifest
}

export type RestoreResult =
  | {
      readonly status: 'restored'
      readonly changedFiles: readonly DesktopProfileCheckpointFilename[]
      readonly snapshotDirectory: string
      readonly failureGeneration: string
    }
  | {
      readonly status: 'already-attempted'
      readonly changedFiles: readonly DesktopProfileCheckpointFilename[]
      readonly snapshotDirectory: string
      readonly failureGeneration: string
    }

interface RestoreMarker {
  readonly version: 1
  readonly failureGeneration: string
  readonly attemptedAt: string
  /**
   * True while a restore completed declaratively but its package-manager
   * dependency synchronization still owes a retry (the #73 half-chain fix):
   * the next generation re-attempts the sync before the Host boots.
   */
  readonly dependencySyncPending?: boolean
}

interface FileImage {
  readonly present: boolean
  readonly sha256?: string
  readonly size?: number
  readonly mode?: number
}

function fail(message: string): never {
  throw new Error(`${BIN_NAME}: ${message}`)
}

function assertAbsolute(label: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || value.includes('\0')) {
    fail(`${label} must be an absolute path without NUL`)
  }
  return resolve(value)
}

function assertIdentifier(label: string, value: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.includes('\\')) {
    fail(`invalid ${label}`)
  }
  return value
}

function assertProfileName(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255
    || value.includes('/') || value.includes('\\') || /[\0\r\n]/u.test(value)) {
    fail('invalid profile name')
  }
  return value
}

function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isENOENT(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Require a real, non-symlink directory and return its canonical path. */
function realDirectory(label: string, path: string): string {
  const absolute = assertAbsolute(label, path)
  let item
  try {
    item = lstatSync(absolute)
  } catch (cause) {
    fail(`${label} is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!item.isDirectory() || item.isSymbolicLink()) fail(`${label} must be a real directory`)
  // `realpathSync` confirms the directory is reachable. Do not compare its
  // spelling with the input: macOS commonly exposes /var through /private/var
  // even when neither of the caller-owned directory entries is a symlink.
  realpathSync(absolute)
  return absolute
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIRECTORY_MODE })
  const item = lstatSync(path)
  if (!item.isDirectory() || item.isSymbolicLink()) fail(`checkpoint directory is not a real directory: ${path}`)
  // chmod is intentional: an existing directory may have inherited a wider mode.
  if (CHECK_POSIX_MODE && (item.mode & 0o777) !== DIRECTORY_MODE) {
    // The caller owns this private directory; narrowing it is safe and avoids
    // exposing a checkpoint through a permissive umask/previous installation.
    chmodSync(path, DIRECTORY_MODE)
  }
}

function writeDurable(path: string, bytes: Uint8Array, mode = FILE_MODE): void {
  ensureDirectory(dirname(path))
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', mode)
    writeSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    // A directory fsync is supported on Unix. Windows may reject opening a
    // directory, but the rename itself remains atomic and durable enough for
    // the supported filesystem there.
    try {
      const directoryFd = openSync(dirname(path), 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } catch { /* platform/filesystem without directory fsync */ }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* already renamed */ }
  }
}

function readJson(path: string): unknown {
  const item = lstatSync(path)
  if (!item.isFile() || item.isSymbolicLink() || (CHECK_POSIX_MODE && (item.mode & 0o777) !== FILE_MODE)) {
    fail(`checkpoint file has unsafe type or mode: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

function fileEqual(left: FileImage, right: FileImage): boolean {
  return left.present === right.present && (!left.present
    || left.sha256 === right.sha256 && left.size === right.size && left.mode === right.mode)
}

function filePath(root: string, name: DesktopProfileCheckpointFilename): string {
  const path = join(root, ...name.split('/'))
  const expected = resolve(root, ...name.split('/'))
  if (path !== expected || relative(root, path).startsWith('..')) fail('checkpoint filename escaped its root')
  return path
}

/** Staged-tarball path inside one root's staging directory; the flat grammar-checked name cannot escape it. */
function tarballPath(root: string, name: string): string {
  if (typeof name !== 'string' || !TARBALL_NAME_PATTERN.test(name)) fail(`checkpoint tarball name is invalid: ${String(name)}`)
  const path = join(root, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, name)
  const expected = resolve(root, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, name)
  if (path !== expected || relative(root, path).startsWith('..')) fail('checkpoint tarball name escaped its root')
  return path
}

function sameTarballRecords(
  left: readonly ProfileCheckpointTarballRecord[],
  right: readonly ProfileCheckpointTarballRecord[],
): boolean {
  return left.length === right.length && left.every((record, index) =>
    record.name === right[index]!.name && record.sha256 === right[index]!.sha256 && record.size === right[index]!.size)
}

function assertProfileFileParent(profileDir: string, name: DesktopProfileCheckpointFilename): void {
  const parent = dirname(filePath(profileDir, name))
  try {
    const item = lstatSync(parent)
    if (item.isSymbolicLink() || !item.isDirectory()) fail(`profile checkpoint parent must be a real directory: ${name}`)
    realpathSync(parent)
  } catch (cause) {
    if (!isENOENT(cause)) throw cause
  }
}

/** Profile-scoped latest healthy snapshot manager. */
export class DesktopProfileCheckpoint {
  readonly userDataDir: string
  readonly profileDir: string
  readonly profileIdentity: string
  readonly profileName: string
  readonly provider: string
  readonly snapshotDirectory: string

  private readonly limits: Record<DesktopProfileCheckpointFilename, number>
  private readonly maxTarballBytes: number
  private readonly maxTarballTotalBytes: number
  private readonly logWarning: (message: string) => void
  private readonly now: () => number

  constructor(options: ProfileCheckpointOptions) {
    const userData = options.userDataDir ?? options.userData
    const profile = options.profileDir ?? options.profilePath
    if (userData === undefined || profile === undefined) fail('userDataDir and profileDir are required')
    this.userDataDir = realDirectory('userDataDir', userData)
    this.profileDir = realDirectory('profileDir', profile)
    this.profileIdentity = assertIdentifier('profile identity', options.profileIdentity ?? hash(this.profileDir))
    this.profileName = assertProfileName(options.profileName ?? 'desktop')
    this.provider = assertIdentifier('provider', options.provider ?? 'unknown')
    this.now = options.now ?? Date.now
    this.limits = { ...FILE_LIMITS, ...(options.maxFileBytes ?? {}) }
    this.maxTarballBytes = options.maxTarballBytes ?? DEFAULT_MAX_TARBALL_BYTES
    this.maxTarballTotalBytes = options.maxTarballTotalBytes ?? DEFAULT_MAX_TARBALL_TOTAL_BYTES
    this.logWarning = options.logWarning ?? (() => {})
    for (const name of DESKTOP_PROFILE_CHECKPOINT_FILES) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 0) fail(`invalid size limit for ${name}`)
    }
    if (!Number.isSafeInteger(this.maxTarballBytes) || this.maxTarballBytes < 0
      || !Number.isSafeInteger(this.maxTarballTotalBytes) || this.maxTarballTotalBytes < 0) {
      fail('invalid tarball size limit')
    }
    const profileKey = hash(this.profileIdentity)
    const root = join(this.userDataDir, SNAPSHOT_ROOT)
    ensureDirectory(root)
    this.snapshotDirectory = join(root, profileKey, LATEST_DIRECTORY)
  }

  /** Capture the current healthy declarative profile state. */
  captureHealthy(): CaptureHealthyResult {
    this.recoverOrphanedLatest()
    ensureDirectory(dirname(this.snapshotDirectory))
    const current = this.readCurrentImages(true)
    const currentTarballs = this.readCurrentTarballRecords()
    const existing = this.readSnapshot(false)
    if (existing !== undefined && existing.manifest.profileIdentity === this.profileIdentity
      && existing.manifest.profileName === this.profileName && existing.manifest.provider === this.provider
      && existing.manifest.files.every((record, index) => fileEqual(record, current[index]!))
      && sameTarballRecords(existing.manifest.tarballs ?? [], currentTarballs)) {
      // A successful generation starts a fresh recovery window. Retaining a
      // previous failed-generation marker would make inspectRestore report a
      // stale attempt and could incorrectly suppress the next failure.
      try { unlinkSync(join(existing.directory, MARKER_FILENAME)) } catch (cause) {
        if (!isENOENT(cause)) throw cause
      }
      return { snapshotExists: true, deduplicated: true, snapshotDirectory: this.snapshotDirectory, manifest: existing.manifest }
    }

    const snapshotId = randomUUID()
    const staging = join(dirname(this.snapshotDirectory), `.staging-${process.pid}-${snapshotId}`)
    ensureDirectory(staging)
    try {
      const records: ProfileCheckpointFileRecord[] = []
      for (let index = 0; index < DESKTOP_PROFILE_CHECKPOINT_FILES.length; index += 1) {
        const name = DESKTOP_PROFILE_CHECKPOINT_FILES[index]!
        const image = current[index]!
        records.push({ name, ...image })
        if (image.present) {
          const source = filePath(this.profileDir, name)
          const destination = filePath(staging, name)
          ensureDirectory(dirname(destination))
          const bytes = readFileSync(source)
          writeDurable(destination, bytes)
        }
      }
      // The staged market tarballs are copied as bytes only: they carry no
      // trust (every consumer re-verifies them against the signed catalog),
      // so the checkpoint can safely revive them after a destroyed profile.
      for (const record of currentTarballs) {
        const destination = tarballPath(staging, record.name)
        ensureDirectory(dirname(destination))
        const bytes = readFileSync(tarballPath(this.profileDir, record.name))
        writeDurable(destination, bytes)
      }
      const manifest: ProfileCheckpointManifest = {
        version: VERSION,
        snapshotId,
        capturedAt: new Date(this.now()).toISOString(),
        profileIdentity: this.profileIdentity,
        profileName: this.profileName,
        provider: this.provider,
        files: records,
        ...(currentTarballs.length === 0 ? {} : { tarballs: currentTarballs }),
      }
      writeDurable(join(staging, MANIFEST_FILENAME), Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'))
      if (existsSync(this.snapshotDirectory)) {
        const old = `${this.snapshotDirectory}.old-${randomUUID()}`
        renameSync(this.snapshotDirectory, old)
        try { renameSync(staging, this.snapshotDirectory) } catch (cause) {
          renameSync(old, this.snapshotDirectory)
          throw cause
        }
        rmSync(old, { recursive: true, force: true })
      } else {
        renameSync(staging, this.snapshotDirectory)
      }
      return { snapshotExists: true, deduplicated: false, snapshotDirectory: this.snapshotDirectory, manifest }
    } catch (cause) {
      rmSync(staging, { recursive: true, force: true })
      throw cause
    }
  }

  /** Inspect drift without changing either the profile or the checkpoint. */
  inspectRestore(failureGeneration?: string): RestoreInspection {
    this.recoverOrphanedLatest()
    const requestedGeneration = failureGeneration === undefined
      ? undefined
      : assertIdentifier('failure generation', failureGeneration)
    const snapshot = this.readSnapshot(false)
    if (snapshot === undefined) return { snapshotExists: false, currentDiffers: false, restoreAttempted: false, changedFiles: [] }
    const current = this.readCurrentImages(false)
    const changedFiles = DESKTOP_PROFILE_CHECKPOINT_FILES.filter((_, index) => !fileEqual(snapshot.manifest.files[index]!, current[index]!))
    const marker = this.readMarker(snapshot.directory)
    return {
      snapshotExists: true,
      currentDiffers: changedFiles.length > 0,
      restoreAttempted: marker !== undefined
        && (requestedGeneration === undefined || marker.failureGeneration === requestedGeneration),
      ...(marker === undefined ? {} : { failureGeneration: marker.failureGeneration }),
      changedFiles,
      manifest: snapshot.manifest,
    }
  }

  /** Restore the latest complete snapshot once for one failed startup generation. */
  restoreLatest(failureGeneration: string): RestoreResult {
    this.recoverOrphanedLatest()
    const generation = assertIdentifier('failure generation', failureGeneration)
    const snapshot = this.readSnapshot(true)
    if (snapshot === undefined) fail('no healthy profile checkpoint exists')
    const current = this.readCurrentImages(false)
    const changedFiles = DESKTOP_PROFILE_CHECKPOINT_FILES.filter((_, index) => !fileEqual(snapshot.manifest.files[index]!, current[index]!))
    const marker = this.readMarker(snapshot.directory)
    if (marker?.failureGeneration === generation) {
      return { status: 'already-attempted', changedFiles, snapshotDirectory: this.snapshotDirectory, failureGeneration: generation }
    }

    // Mark before touching the profile. If the process crashes during restore,
    // a retrying startup cannot loop forever; an explicit user request can use
    // a fresh generation token.
    writeDurable(join(snapshot.directory, MARKER_FILENAME), Buffer.from(`${JSON.stringify({
      version: VERSION,
      failureGeneration: generation,
      attemptedAt: new Date(this.now()).toISOString(),
    } satisfies RestoreMarker)}\n`, 'utf8'))
    for (let index = 0; index < DESKTOP_PROFILE_CHECKPOINT_FILES.length; index += 1) {
      const name = DESKTOP_PROFILE_CHECKPOINT_FILES[index]!
      const record = snapshot.manifest.files[index]!
      assertProfileFileParent(this.profileDir, name)
      const target = filePath(this.profileDir, name)
      if (record.present) {
        const backup = filePath(snapshot.directory, name)
        const bytes = readFileSync(backup)
        // The complete-backup validation already checked this, but verify at
        // the point of use as well in case the filesystem changed in between.
        if (hash(bytes) !== record.sha256 || bytes.byteLength !== record.size) fail(`checkpoint changed during restore: ${name}`)
        writeDurable(target, bytes, record.mode)
      } else {
        try {
          const item = lstatSync(target)
          if (item.isSymbolicLink() || !item.isFile()) fail(`cannot remove unsafe profile entry: ${name}`)
          unlinkSync(target)
        } catch (cause) {
          if (!isENOENT(cause)) throw cause
        }
      }
    }
    // Staged market tarballs restore add-only. They are non-trusted bytes —
    // every consumer re-verifies them against the signed catalog — so a
    // deleted one is simply re-materialized and one the snapshot lacks is
    // left alone: deleting it could break the very `file:` lock pin this
    // restore just wrote back, and a tarball absent from the last healthy
    // capture can never revive an uninstalled plugin through this path.
    for (const record of snapshot.manifest.tarballs ?? []) {
      const target = tarballPath(this.profileDir, record.name)
      let currentMatches = false
      try {
        const item = lstatSync(target)
        if (item.isFile() && !item.isSymbolicLink() && item.size === record.size) {
          currentMatches = hash(readFileSync(target)) === record.sha256
        }
      } catch (cause) {
        if (!isENOENT(cause)) throw cause
      }
      if (currentMatches) continue
      const backup = tarballPath(snapshot.directory, record.name)
      const bytes = readFileSync(backup)
      // Point-of-use re-verification, exactly like the declarative files.
      if (hash(bytes) !== record.sha256 || bytes.byteLength !== record.size) {
        fail(`checkpoint changed during restore: ${record.name}`)
      }
      writeDurable(target, bytes)
    }
    return { status: 'restored', changedFiles, snapshotDirectory: this.snapshotDirectory, failureGeneration: generation }
  }

  /** Whether the latest restore marker still owes a dependency re-synchronization. */
  dependencySyncPending(): boolean {
    this.recoverOrphanedLatest()
    const snapshot = this.readSnapshot(false)
    if (snapshot === undefined) return false
    return this.readMarker(snapshot.directory)?.dependencySyncPending === true
  }

  /**
   * Record (or clear) the pending dependency re-synchronization on the latest
   * restore marker. Setting the flag requires an existing marker — only a
   * restore attempt can owe a sync; clearing without one is a no-op.
   */
  setDependencySyncPending(pending: boolean): void {
    this.recoverOrphanedLatest()
    const snapshot = this.readSnapshot(false)
    if (snapshot === undefined) fail('no healthy profile checkpoint exists')
    const marker = this.readMarker(snapshot.directory)
    if (marker === undefined) {
      if (pending) fail('no restore attempt is available to mark')
      return
    }
    if (marker.dependencySyncPending === pending) return
    writeDurable(join(snapshot.directory, MARKER_FILENAME), Buffer.from(`${JSON.stringify({
      version: VERSION,
      failureGeneration: marker.failureGeneration,
      attemptedAt: marker.attemptedAt,
      ...(pending ? { dependencySyncPending: true } : {}),
    } satisfies RestoreMarker)}\n`, 'utf8'))
  }

  private readCurrentImages(requirePackage: boolean): FileImage[] {
    return DESKTOP_PROFILE_CHECKPOINT_FILES.map(name => {
      assertProfileFileParent(this.profileDir, name)
      const path = filePath(this.profileDir, name)
      let item
      try { item = lstatSync(path) } catch (cause) {
        if (isENOENT(cause)) {
          if (requirePackage && name === 'package.json') fail('healthy profile package.json is unavailable')
          return { present: false }
        }
        throw cause
      }
      if (item.isSymbolicLink() || !item.isFile()) fail(`profile checkpoint entry must be a regular file: ${name}`)
      const size = item.size
      if (size > this.limits[name]) fail(`profile checkpoint file is too large: ${name}`)
      const bytes = readFileSync(path)
      return { present: true, sha256: hash(bytes), size: bytes.byteLength, mode: item.mode & 0o777 }
    })
  }

  /**
   * Image the profile's staged market tarballs: a missing staging directory is
   * an empty set; anything unexpected inside it (foreign entry types,
   * unrecognized names, over-limit sizes or counts) fails the capture so the
   * previous snapshot survives instead of silently dropping restorability.
   */
  /**
   * Tarball staging snapshots degrade instead of failing (review P1 on the
   * #73 fix): any structural or budget violation skips tarball checkpointing
   * for this capture with a logged warning — a violated budget must never
   * stop the FILES snapshot from refreshing, or last-known-good silently
   * freezes and the rescue mechanism dies with it. The staged bytes carry
   * no trust, so skipping them only narrows what a restore can revive.
   */
  private readCurrentTarballRecords(): ProfileCheckpointTarballRecord[] {
    const degrade = (reason: string): ProfileCheckpointTarballRecord[] => {
      this.logWarning(`profile checkpoint degraded — market tarballs skipped this capture: ${reason}`)
      return []
    }
    const directory = join(this.profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY)
    let item
    try {
      item = lstatSync(directory)
    } catch (cause) {
      if (isENOENT(cause)) return []
      throw cause
    }
    if (!item.isDirectory() || item.isSymbolicLink()) {
      return degrade('staging directory is not a real directory')
    }
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    if (entries.length > MAX_CHECKPOINT_TARBALLS) {
      return degrade(`staging directory holds too many files (${String(entries.length)})`)
    }
    const records: ProfileCheckpointTarballRecord[] = []
    let total = 0
    for (const entry of entries) {
      if (!entry.isFile()) {
        return degrade(`staging entry is not a regular file: ${entry.name}`)
      }
      if (!TARBALL_NAME_PATTERN.test(entry.name)) {
        return degrade(`staging entry has an unrecognized name: ${entry.name}`)
      }
      const path = join(directory, entry.name)
      const size = lstatSync(path).size
      if (size > this.maxTarballBytes) {
        return degrade(`staged tarball is too large: ${entry.name}`)
      }
      total += size
      if (total > this.maxTarballTotalBytes) {
        return degrade('staged tarballs exceed the checkpoint size budget')
      }
      records.push({ name: entry.name, sha256: hash(readFileSync(path)), size })
    }
    return records
  }

  /** Recover the previous generation if a process died between directory renames. */
  private recoverOrphanedLatest(): void {
    if (existsSync(this.snapshotDirectory)) return
    const parent = dirname(this.snapshotDirectory)
    let candidates: string[]
    try {
      candidates = readdirSync(parent).filter(name => name.startsWith(`${LATEST_DIRECTORY}.old-`)).sort().reverse()
    } catch (cause) {
      if (isENOENT(cause)) return
      throw cause
    }
    for (const name of candidates) {
      const candidate = join(parent, name)
      try {
        const item = lstatSync(candidate)
        if (!item.isDirectory() || item.isSymbolicLink()
          || (CHECK_POSIX_MODE && (item.mode & 0o777) !== DIRECTORY_MODE)) continue
        renameSync(candidate, this.snapshotDirectory)
        return
      } catch (cause) {
        if (!isENOENT(cause)) throw cause
      }
    }
  }

  private readMarker(directory: string): RestoreMarker | undefined {
    const path = join(directory, MARKER_FILENAME)
    try {
      const value = readJson(path)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('restore marker is invalid')
      const marker = value as Record<string, unknown>
      if (marker.version !== VERSION || typeof marker.failureGeneration !== 'string'
        || !ID_PATTERN.test(marker.failureGeneration) || typeof marker.attemptedAt !== 'string'
        || (marker.dependencySyncPending !== undefined && typeof marker.dependencySyncPending !== 'boolean')) fail('restore marker is invalid')
      return marker as unknown as RestoreMarker
    } catch (cause) {
      if (isENOENT(cause)) return undefined
      throw cause
    }
  }

  private readSnapshot(requireComplete: boolean): { readonly directory: string; readonly manifest: ProfileCheckpointManifest } | undefined {
    try {
      const directoryItem = lstatSync(this.snapshotDirectory)
      if (!directoryItem.isDirectory() || directoryItem.isSymbolicLink()
        || (CHECK_POSIX_MODE && (directoryItem.mode & 0o777) !== DIRECTORY_MODE)) {
        fail('latest checkpoint directory has unsafe type or mode')
      }
      const value = readJson(join(this.snapshotDirectory, MANIFEST_FILENAME))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('checkpoint manifest is invalid')
      const object = value as Record<string, unknown>
      const files = object.files
      if (object.version !== VERSION || typeof object.snapshotId !== 'string' || !ID_PATTERN.test(object.snapshotId)
        || typeof object.capturedAt !== 'string' || object.profileIdentity !== this.profileIdentity
        || object.profileName !== this.profileName || object.provider !== this.provider
        || !Array.isArray(files) || files.length !== DESKTOP_PROFILE_CHECKPOINT_FILES.length) fail('checkpoint manifest is invalid')
      for (let index = 0; index < DESKTOP_PROFILE_CHECKPOINT_FILES.length; index += 1) {
        const record = files[index]
        const expected = DESKTOP_PROFILE_CHECKPOINT_FILES[index]!
        if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('checkpoint manifest is invalid')
        const item = record as Record<string, unknown>
        if (item.name !== expected || typeof item.present !== 'boolean') fail('checkpoint manifest is invalid')
        if (item.present && (typeof item.sha256 !== 'string' || !HASH_PATTERN.test(item.sha256)
          || !Number.isSafeInteger(item.size) || (item.size as number) < 0 || (item.size as number) > this.limits[expected]
          || !Number.isSafeInteger(item.mode) || (item.mode as number) < 0 || (item.mode as number) > 0o777)) fail('checkpoint manifest is invalid')
        const backup = filePath(this.snapshotDirectory, expected)
        if (item.present) {
          const backupItem = lstatSync(backup)
          if (!backupItem.isFile() || backupItem.isSymbolicLink()
            || (CHECK_POSIX_MODE && (backupItem.mode & 0o777) !== FILE_MODE)) fail(`checkpoint backup is unsafe: ${expected}`)
          const bytes = readFileSync(backup)
          if (bytes.byteLength !== item.size || hash(bytes) !== item.sha256) fail(`checkpoint backup is incomplete: ${expected}`)
        } else if (existsSync(backup)) {
          fail(`checkpoint contains an unexpected backup: ${expected}`)
        }
      }
      const tarballs = object.tarballs
      if (tarballs !== undefined) {
        if (!Array.isArray(tarballs) || tarballs.length > MAX_CHECKPOINT_TARBALLS) fail('checkpoint manifest is invalid')
        const names = new Set<string>()
        let total = 0
        for (const record of tarballs) {
          if (record === null || typeof record !== 'object' || Array.isArray(record)) fail('checkpoint manifest is invalid')
          const item = record as Record<string, unknown>
          if (typeof item.name !== 'string' || !TARBALL_NAME_PATTERN.test(item.name) || names.has(item.name)
            || typeof item.sha256 !== 'string' || !HASH_PATTERN.test(item.sha256)
            || !Number.isSafeInteger(item.size) || (item.size as number) < 0
            || (item.size as number) > this.maxTarballBytes) fail('checkpoint manifest is invalid')
          names.add(item.name)
          total += item.size as number
          if (total > this.maxTarballTotalBytes) fail('checkpoint manifest is invalid')
          const backup = tarballPath(this.snapshotDirectory, item.name)
          const backupItem = lstatSync(backup)
          if (!backupItem.isFile() || backupItem.isSymbolicLink()
            || (CHECK_POSIX_MODE && (backupItem.mode & 0o777) !== FILE_MODE)) fail(`checkpoint tarball backup is unsafe: ${item.name}`)
          const bytes = readFileSync(backup)
          if (bytes.byteLength !== item.size || hash(bytes) !== item.sha256) fail(`checkpoint tarball backup is incomplete: ${item.name}`)
        }
      }
      if (requireComplete && !files.some((record: Record<string, unknown>) => record.present === true)) {
        fail('checkpoint contains no restorable files')
      }
      return { directory: this.snapshotDirectory, manifest: value as unknown as ProfileCheckpointManifest }
    } catch (cause) {
      if (isENOENT(cause)) {
        try {
          lstatSync(this.snapshotDirectory)
        } catch (directoryCause) {
          if (isENOENT(directoryCause)) return undefined
        }
      }
      throw cause
    }
  }
}

/** Factory spelling used by profile services. */
export function createDesktopProfileCheckpoint(options: ProfileCheckpointOptions): DesktopProfileCheckpoint {
  return new DesktopProfileCheckpoint(options)
}

/**
 * Remove the health checkpoint for one profile without touching others.
 *
 * The whole per-profile key directory goes, not just `latest`: a capture that
 * died between its two renames leaves a `latest.old-<id>` sibling, and
 * {@link DesktopProfileCheckpoint} promotes exactly that sibling back to
 * `latest` when `latest` is missing (see `recoverOrphanedLatest`). Deleting
 * only `latest` would therefore let the next failed startup restore the
 * pre-swap composition this clear exists to invalidate.
 */
export function clearDesktopProfileCheckpoint(userDataDir: string, profileDir: string): void {
  const userData = realDirectory('userDataDir', userDataDir)
  const profile = assertAbsolute('profileDir', profileDir)
  const profileIdentity = hash(profile)
  const checkpointDirectory = join(userData, SNAPSHOT_ROOT, hash(profileIdentity))
  let item
  try {
    item = lstatSync(checkpointDirectory)
  } catch (cause) {
    if (isENOENT(cause)) return
    throw cause
  }
  if (item.isSymbolicLink() || !item.isDirectory()) {
    fail('profile checkpoint directory has unsafe type')
  }
  rmSync(checkpointDirectory, { recursive: true, force: false })
}

/** Compatibility aliases for embedders that call this a health checkpoint. */
export { DesktopProfileCheckpoint as HealthProfileCheckpoint, DesktopProfileCheckpoint as ProfileHealthCheckpoint }
