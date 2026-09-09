/**
 * Fresh-Profile swap (P14): the one rebuild primitive behind the automatic
 * version-change reset and the recovery window's manual action.
 *
 * Mechanism (decided 2026-09-09): the active Profile directory is renamed
 * aside to `profiles/<name>.bak-<stamp>` — kept for forensics and manual
 * rollback — and the Profile is then recreated through the shipped first-run
 * mechanism (`initProfile` + the launcher module fallback) plus one
 * dependency synchronization. No package-manager surgery runs: `pnpm remove`
 * on a damaged tree is exactly the fragile path (a missing tarball aborts it
 * with ENOENT) this module exists to avoid.
 *
 * What a swap does NOT touch: everything outside the Profile directory —
 * conversations, settings, the SSO session, and the disclaimer
 * acknowledgement all live under the Harness home root, and the company
 * market itself is launcher-owned. The market install ledger (the home
 * `settings.yaml` receipt array) IS cleared — but only for the swapped
 * Profile's own receipts, because the ledger is shared across Profiles and
 * a receipt names the Profile it belongs to; clearing a sibling Profile's
 * receipts would degrade its installed bundles to manifest-only and drop
 * its sequence ratchet. Clearing the swapped Profile's receipts is what
 * returns its catalog entries to the installable state.
 *
 * Set-aside directories are bounded: a swap moves a full Profile (including
 * `node_modules`) aside, so only the newest {@link MAX_PROFILE_BACKUPS} per
 * Profile are retained and older ones are removed best-effort by a task
 * detached from the swap (a multi-hundred-megabyte removal must never block
 * the startup path it was spawned by). The active
 * Profile's health checkpoint is invalidated after the rebuild, because the
 * checkpoint is keyed by the Profile *path* (unchanged by a swap) and would
 * otherwise restore the pre-swap composition into the rebuilt tree when the
 * next boot fails before its first healthy capture.
 *
 * @module dsh-plugin-desktop/fresh-profile
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { isMap, isSeq, parseDocument } from 'yaml'
import { PROFILE_BACKUP_INFIX, assertDesktopProfileName } from './profile-manager.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/** Persisted build-identity record name inside the Desktop user-data directory. */
export const PROFILE_GENERATION_FILENAME = 'last-profile-generation.json'
const PROFILE_GENERATION_VERSION = 1
const MAX_GENERATION_STATE_BYTES = 4 * 1024
/** Set-aside directories retained per Profile; older ones are removed. */
const MAX_PROFILE_BACKUPS = 2
/** Collision bound for two swaps inside the same millisecond. */
const MAX_BACKUP_COLLISIONS = 100
/** Community-market settings namespace owning the install receipt ledger. */
const MARKET_SETTINGS_NAMESPACE = 'dsh-community-market'
const MARKET_RECEIPTS_KEY = 'installReceipts'
/** Read bound for the settings document carrying the market ledger. */
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024

/** Persisted build identity of the last boot that managed the Profile. */
export interface ProfileGenerationState {
  readonly version: typeof PROFILE_GENERATION_VERSION
  /** Build-distinguishing identity (`2.0.3+b75`) of that boot. */
  readonly appBuildVersion: string
  /** ISO timestamp of the write, for log-side forensics. */
  readonly updatedAt: string
}

/** Absolute path of the build-identity record. */
export function profileGenerationStatePath(userDataDir: string): string {
  return join(userDataDir, PROFILE_GENERATION_FILENAME)
}

/**
 * Read the build-identity record; any missing, oversized, or malformed
 * document reads as "no record" so a corrupt file can never block a boot.
 */
export function readProfileGenerationState(statePath: string): ProfileGenerationState | undefined {
  let body: Buffer
  try {
    body = readFileSync(statePath)
  } catch {
    return undefined
  }
  if (body.byteLength > MAX_GENERATION_STATE_BYTES) return undefined
  let document: unknown
  try {
    document = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  const record = document as Record<string, unknown>
  if (record.version !== PROFILE_GENERATION_VERSION) return undefined
  if (typeof record.appBuildVersion !== 'string' || record.appBuildVersion.length === 0
    || record.appBuildVersion.includes('\0')) return undefined
  if (typeof record.updatedAt !== 'string') return undefined
  return { version: PROFILE_GENERATION_VERSION, appBuildVersion: record.appBuildVersion, updatedAt: record.updatedAt }
}

/** Persist the build identity of the boot that just managed the Profile. */
export async function writeProfileGenerationState(statePath: string, state: ProfileGenerationState): Promise<void> {
  // Atomic replacement: a crash-truncated record would read as "no record",
  // which now means "rebuild the existing Profile" — a spurious swap.
  await writeFileAtomic(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

/** What one boot's build identity implies for the active Profile. */
export type FreshProfileResetDecision = 'unchanged' | 'record' | 'reset'

/**
 * Decide the automatic layer's action. The switch is inert unless the build
 * is locked AND the policy enables it, so an unlocked or opted-out build
 * keeps byte-identical behavior (not even the record is written). An
 * unchanged identity is a pure read. A missing record is treated as a
 * version change — the Profile was built by a build this one has never
 * recorded, which is exactly the straddle the reset exists to end — except
 * when no Profile manifest exists at all: a genuinely fresh install has no
 * third-party composition to strip, so it only records (no set-aside
 * directory, no redundant dependency synchronization).
 */
export function freshProfileResetDecision(options: {
  readonly locked: boolean
  readonly resetOnVersionChange: boolean
  readonly previousAppBuildVersion?: string | undefined
  readonly appBuildVersion: string
  /** Whether the active Profile manifest already exists on disk. */
  readonly profileExists: boolean
}): FreshProfileResetDecision {
  if (options.locked !== true || options.resetOnVersionChange !== true) return 'unchanged'
  if (options.previousAppBuildVersion === options.appBuildVersion) return 'unchanged'
  // A missing record plus no manifest is a genuinely first boot: there is no
  // recorded build to straddle and no third-party composition to strip, so a
  // version change records the identity instead of swapping. A missing record
  // WITH a manifest is a straddle and resets; a recorded build that differs
  // resets even without a manifest, because the record proves this home was
  // managed by another build.
  if (options.previousAppBuildVersion === undefined && !options.profileExists) return 'record'
  return 'reset'
}

/** Filesystem-safe UTC stamp: `20260909T073319264Z`. */
export function profileBackupStamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/[-:]/gu, '').replace(/\.(\d{3})Z$/u, '$1Z')
}

/** The set-aside directory one swap would use for a profile. */
export function profileBackupPath(profileDir: string, epochMs: number): string {
  return `${profileDir}${PROFILE_BACKUP_INFIX}${profileBackupStamp(epochMs)}`
}

/**
 * Remove one Profile's market install receipts from the shared settings
 * document and report how many were dropped. Receipts belonging to other
 * Profiles are left untouched: the ledger is home-wide, and a swap of
 * Profile A must never degrade Profile B's installed bundles to
 * manifest-only. Idempotent: an absent namespace, key, or file, or a ledger
 * with no receipt of this Profile, writes nothing and returns 0. Comments
 * and every other setting survive the round trip because the document is
 * edited as a YAML AST. The whole read-modify-write runs under the document
 * owner's (`settings-file`) cross-process writer lock, and the commit is the
 * same atomic replace, so a concurrent writer's receipt cannot be lost to our
 * rename and a crash cannot truncate the user's settings.
 */
export async function clearMarketInstallReceipts(settingsPath: string, profileName: string): Promise<number> {
  // An absent document is a no-op: skip creating its directory or a lock file
  // for it. The read below happens under the lock, so a document that appears
  // in the meantime is still seen.
  if (!existsSync(settingsPath)) return 0
  // The writer lock is a sibling file, so its parent must exist before
  // `withFileLock` can create it — the owner (`settings-file`) does the same.
  // 0700: the harness home holds user-private documents.
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 })
  return await withFileLock(settingsPath, async () => {
    let text: string
    try {
      text = readFileSync(settingsPath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw cause
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) {
      throw new Error(`${BIN_NAME}: settings document ${settingsPath} exceeds ${String(MAX_SETTINGS_BYTES)} bytes`)
    }
    const document = parseDocument(text, { prettyErrors: true })
    if (document.errors.length > 0) {
      throw new Error(`${BIN_NAME}: settings document ${settingsPath} is not parseable YAML`)
    }
    const receipts = document.getIn([MARKET_SETTINGS_NAMESPACE, MARKET_RECEIPTS_KEY])
    if (receipts === undefined || receipts === null) return 0
    if (!isSeq(receipts)) {
      // A shapeless ledger is unusable for every Profile; drop the key.
      document.deleteIn([MARKET_SETTINGS_NAMESPACE, MARKET_RECEIPTS_KEY])
      await writeFileAtomic(settingsPath, document.toString(), { mode: 0o600, dirMode: 0o700 })
      return 0
    }
    const kept = receipts.items.filter(item => !(isMap(item) && item.get('profileName') === profileName))
    const cleared = receipts.items.length - kept.length
    if (cleared === 0) return 0
    if (kept.length === 0) document.deleteIn([MARKET_SETTINGS_NAMESPACE, MARKET_RECEIPTS_KEY])
    else receipts.items = kept
    await writeFileAtomic(settingsPath, document.toString(), { mode: 0o600, dirMode: 0o700 })
    return cleared
  })
}

/** Inputs the caller (Electron main) owns; this module stays Electron-free. */
export interface FreshProfileSwapOptions {
  /** Harness home containing the shared `profiles/` directory. */
  readonly home: string
  /** Active Profile name; validated before it crosses any path boundary. */
  readonly profileName: string
  /** Shared `settings.yaml` owning the market install receipt ledger. */
  readonly settingsDocumentPath: string
  /** Recreate the Profile through the shipped first-run mechanism. */
  readonly createProfile: () => void
  /** Dependency synchronization (the fixed `pnpm install --frozen-lockfile`). */
  readonly materialize?: (() => Promise<boolean>) | undefined
  /** Clock seam for the backup stamp. */
  readonly now?: (() => number) | undefined
  /**
   * Invalidate the active Profile's health checkpoint after the rebuild. The
   * checkpoint is keyed by Profile path, which a swap does not change, so a
   * stale snapshot would otherwise be restored into the rebuilt tree by the
   * next failed startup and silently undo the swap.
   */
  readonly clearCheckpoint?: (() => void | Promise<void>) | undefined
  /** Receives a one-line warning when the market ledger cannot be cleared. */
  readonly logError?: ((message: string) => void) | undefined
}

/** What one swap did, for logging and telemetry. */
export interface FreshProfileSwapResult {
  readonly profileName: string
  readonly profileDir: string
  /** Set-aside previous Profile directory; absent when none existed. */
  readonly backupDir?: string
  /** Whether the dependency synchronization completed. */
  readonly materialized: boolean
  /** Market install receipts dropped by the ledger clear. */
  readonly receiptsCleared: number
  /**
   * Retention of the Profile's older set-aside directories. Detached from the
   * swap on purpose so a multi-hundred-megabyte removal never delays the boot
   * that spawned the swap; failures are logged and never surface. Await it in
   * tests (and in any caller that needs the removal finished).
   */
  readonly pruneBackups: Promise<readonly string[]>
}

/** Rename the existing Profile directory aside, returning the backup path. */
function setAsideProfileDirectory(profileDir: string, epochMs: number): string | undefined {
  let item
  try {
    item = lstatSync(profileDir)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  if (item.isSymbolicLink() || !item.isDirectory()) {
    throw new Error(`${BIN_NAME}: profile directory ${profileDir} is not a real directory`)
  }
  for (let collision = 0; collision <= MAX_BACKUP_COLLISIONS; collision += 1) {
    const backup = collision === 0
      ? profileBackupPath(profileDir, epochMs)
      : `${profileBackupPath(profileDir, epochMs)}-${String(collision)}`
    if (existsSync(backup)) continue
    renameSync(profileDir, backup)
    return backup
  }
  throw new Error(`${BIN_NAME}: could not set aside profile directory ${profileDir}: too many backups share this stamp`)
}

/**
 * Bound the set-aside directories one Profile keeps. Every swap moves a full
 * Profile (including `node_modules`) aside, so without a bound a fleet would
 * accumulate one copy per upgrade. The newest `keep` directories survive
 * (lexicographic order of the fixed-width stamp; same-millisecond collision
 * suffixes are equivalent); removal is best-effort and never fatal.
 *
 * Removal is asynchronous on purpose: a set-aside Profile can be hundreds of
 * megabytes, and the swap that spawns this runs on the startup path, so the
 * recursive removal must not block the boot it was spawned by.
 * @returns Names of the directories removed.
 */
export async function pruneProfileBackups(
  profileDir: string,
  keep: number = MAX_PROFILE_BACKUPS,
  logError?: ((message: string) => void) | undefined,
): Promise<readonly string[]> {
  const parent = dirname(profileDir)
  const prefix = `${basename(profileDir)}${PROFILE_BACKUP_INFIX}`
  let entries: string[]
  try {
    entries = readdirSync(parent).filter(entry => entry.startsWith(prefix)
      && /^\d{8}T\d{9}Z(?:-\d+)?$/u.test(entry.slice(prefix.length)))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    logError?.(`could not list profile backups beside ${profileDir}: ${cause instanceof Error ? cause.message : String(cause)}`)
    return []
  }
  const removed: string[] = []
  for (const entry of entries.sort().reverse().slice(keep)) {
    const target = join(parent, entry)
    try {
      const item = lstatSync(target)
      if (item.isSymbolicLink() || !item.isDirectory()) continue
      await rm(target, { recursive: true, force: true })
      removed.push(entry)
    } catch (cause) {
      logError?.(`could not remove the old profile backup ${target}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  return removed
}

/**
 * Rebuild the active Profile from scratch. Ordered so every crash window
 * leaves a usable state: the previous Profile is set aside first (never
 * deleted; older set-asides beyond the retention bound are pruned by a task
 * detached from the swap), then the fresh Profile is created, then its stale
 * health checkpoint is invalidated, then its market receipts are cleared, then
 * dependencies are synchronized. A failure before the create step leaves the
 * set-aside Profile recoverable by hand; a failure after it leaves a bootable
 * fresh Profile. Callers decide whether a failure blocks the boot — the
 * desktop degrades to the existing Profile instead.
 */
export async function freshProfileSwap(options: FreshProfileSwapOptions): Promise<FreshProfileSwapResult> {
  assertDesktopProfileName(options.profileName)
  const profileDir = resolveProfileDir(options.profileName, options.home)
  const backupDir = setAsideProfileDirectory(profileDir, (options.now ?? Date.now)())
  options.createProfile()
  if (options.clearCheckpoint !== undefined) {
    try {
      await options.clearCheckpoint()
    } catch (cause) {
      // Accepted surface: a checkpoint that survives this clear can still be
      // restored by the next failed startup and undo the swap (the checkpoint
      // is keyed by the Profile path a swap does not change). The rebuilt
      // Profile is still the better state, so this is logged, not fatal.
      options.logError?.(
        `could not clear the health checkpoint after rebuilding profile ${options.profileName}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      )
    }
  }
  let receiptsCleared = 0
  try {
    receiptsCleared = await clearMarketInstallReceipts(options.settingsDocumentPath, options.profileName)
  } catch (cause) {
    options.logError?.(
      `could not clear the market install receipts after rebuilding profile ${options.profileName}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
  const materialized = options.materialize === undefined ? false : await options.materialize()
  // Retention runs detached, after the rebuild: awaiting the recursive removal
  // of a set-aside Profile (hundreds of megabytes including `node_modules`)
  // here would stall the very startup path the swap exists to rescue.
  const pruneBackups = pruneProfileBackups(profileDir, MAX_PROFILE_BACKUPS, options.logError)
  return {
    profileName: options.profileName,
    profileDir,
    ...(backupDir === undefined ? {} : { backupDir }),
    materialized,
    receiptsCleared,
    pruneBackups,
  }
}
