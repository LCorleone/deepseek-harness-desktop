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
 * On Windows the set-aside rename can be refused for seconds while any
 * process holds a handle inside the Profile (`EBUSY` and friends). The rename
 * therefore backs off over a fixed schedule; if it is still locked, the swap
 * does not fail: it returns a deferred result, the desktop writes a marker in
 * userData, keeps booting the existing Profile, and the next startup retries
 * the rename before it opens anything. The build-identity record stays
 * unwritten on that path, so the version change remains pending.
 *
 * @module dsh-plugin-desktop/fresh-profile
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
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
/**
 * Windows refuses a directory rename while any handle is open inside the
 * tree (`EBUSY`) or the ACL denies it (`EPERM`/`EACCES`); an antivirus or
 * indexer scan releases it within seconds. `ENOTEMPTY` is the same race
 * against a destination that appeared between the `existsSync` probe and the
 * rename. All four are transient by nature, so they back off instead of
 * failing the whole rebuild.
 */
const RETRYABLE_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'])
/** Six backoff steps (~6.3 s total) before a locked rename is declared deferred. */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1600, 3200]

/** Error code of the last rename refused by the OS after every retry. */
export type ProfileRenameLockedCode = 'EBUSY' | 'EPERM' | 'ENOTEMPTY' | 'EACCES'

/**
 * A set-aside rename the OS kept refusing (`EBUSY` and friends) through the
 * whole backoff schedule. The swap turns this into a deferred result instead
 * of a failure: the existing Profile keeps booting, the caller records a
 * marker, and the next startup retries the rename at its earliest point.
 */
export class ProfileRenameLockedError extends Error {
  readonly code: ProfileRenameLockedCode
  /** Attempts made, including the first one. */
  readonly attempts: number
  readonly profileDir: string

  constructor(profileDir: string, code: ProfileRenameLockedCode, attempts: number) {
    super(`${BIN_NAME}: could not set aside profile directory ${profileDir}: rename refused ${String(attempts)} times (last ${code})`)
    this.name = 'ProfileRenameLockedError'
    this.code = code
    this.attempts = attempts
    this.profileDir = profileDir
  }
}
/** Community-market settings namespace owning the install receipt ledger. */
const MARKET_SETTINGS_NAMESPACE = 'dsh-community-market'
const MARKET_RECEIPTS_KEY = 'installReceipts'
/** Read bound for the settings document carrying the market ledger. */
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024

/**
 * Product-version base of a build identity: `2.0.3+b75` → `2.0.3`. Records
 * written before the field existed are read back through this instead of a
 * schema bump, so an old record stays a valid record.
 */
export function buildVersionProductBase(appBuildVersion: string | undefined): string | undefined {
  return appBuildVersion === undefined ? undefined : appBuildVersion.replace(/\+b\d+$/u, '')
}

/** Persisted build identity of the last boot that managed the Profile. */
export interface ProfileGenerationState {
  readonly version: typeof PROFILE_GENERATION_VERSION
  /** Build-distinguishing identity (`2.0.3+b75`) of that boot. */
  readonly appBuildVersion: string
  /**
   * Product version (`2.0.3`) of that boot. The reset rule compares this when
   * `pluginResetOnVersionChange` is off, so a build-counter-only change does
   * not rebuild the Profile.
   */
  readonly appVersion: string
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
  // Records written before `appVersion` existed derive their product version
  // from the build identity, so they keep meaning the same thing.
  const appVersion = typeof record.appVersion === 'string' && record.appVersion.length > 0
    && !record.appVersion.includes('\0')
    ? record.appVersion
    : buildVersionProductBase(record.appBuildVersion) ?? record.appBuildVersion
  return {
    version: PROFILE_GENERATION_VERSION,
    appBuildVersion: record.appBuildVersion,
    appVersion,
    updatedAt: record.updatedAt,
  }
}

/** Persist the build identity of the boot that just managed the Profile. */
export async function writeProfileGenerationState(statePath: string, state: ProfileGenerationState): Promise<void> {
  // Atomic replacement: a crash-truncated record would read as "no record",
  // which now means "rebuild the existing Profile" — a spurious swap.
  await writeFileAtomic(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

/** Persisted marker of a rebuild deferred by a locked set-aside rename. */
export const FRESH_PROFILE_PENDING_FILENAME = 'fresh-profile-pending.json'
/** Schema version of the deferred-rebuild marker (shared with its writer). */
export const FRESH_PROFILE_PENDING_VERSION = 1
const MAX_PENDING_STATE_BYTES = 4 * 1024

/** Which layer asked for the rebuild a marker still owes (client-event telemetry). */
export type FreshProfileSwapTrigger = 'version-change' | 'recovery-window'
/** Which automatic rule fired for a deferred rebuild; the manual window has none. */
export type FreshProfileSwapRule = 'forced' | 'version'

const PENDING_TRIGGERS: readonly FreshProfileSwapTrigger[] = ['version-change', 'recovery-window']
const PENDING_RULES: readonly FreshProfileSwapRule[] = ['forced', 'version']

/**
 * A rebuild the previous boot could not perform because Windows kept the
 * Profile directory locked. The marker lives in userData (not the Profile),
 * so the next startup can read it before it touches any Profile and retry the
 * rename at the earliest possible moment.
 */
export interface FreshProfilePendingState {
  readonly version: typeof FRESH_PROFILE_PENDING_VERSION
  /** Profile that must still be rebuilt; validated before any path use. */
  readonly profileName: string
  /** Build identity the deferred rebuild was for. */
  readonly appBuildVersion: string
  /** Last OS error code (`EBUSY`, …), for log-side forensics. */
  readonly reason: string
  /**
   * Layer that deferred (review P3-c): the next boot's retry reports this to
   * `plugin_reset` telemetry instead of a blind `version-change`. Markers
   * written before the field existed read as `version-change` — the behavior
   * every older marker already got.
   */
  readonly trigger?: FreshProfileSwapTrigger
  /** The automatic rule that fired for an automatic deferral; absent for the recovery window's manual action. */
  readonly rule?: FreshProfileSwapRule
}

/** Absolute path of the deferred-rebuild marker. */
export function freshProfilePendingStatePath(userDataDir: string): string {
  return join(userDataDir, FRESH_PROFILE_PENDING_FILENAME)
}

/**
 * Read the deferred-rebuild marker; any missing, oversized, malformed, or
 * path-escaping document reads as "no marker" so a corrupt file can never
 * block a boot.
 */
export function readFreshProfilePending(statePath: string): FreshProfilePendingState | undefined {
  let body: Buffer
  try {
    body = readFileSync(statePath)
  } catch {
    return undefined
  }
  if (body.byteLength > MAX_PENDING_STATE_BYTES) return undefined
  let document: unknown
  try {
    document = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  const record = document as Record<string, unknown>
  if (record.version !== FRESH_PROFILE_PENDING_VERSION) return undefined
  if (typeof record.profileName !== 'string' || record.profileName.length === 0) return undefined
  try {
    assertDesktopProfileName(record.profileName)
  } catch {
    return undefined
  }
  if (typeof record.appBuildVersion !== 'string' || record.appBuildVersion.length === 0
    || record.appBuildVersion.includes('\0')) return undefined
  if (typeof record.reason !== 'string' || record.reason.length === 0) return undefined
  // The telemetry fields (P3-c) are read tolerantly: absent in every marker
  // written before they existed, and an unrecognized literal reads as absent
  // rather than invalidating the marker — a bad telemetry value must never
  // block the rebuild it describes.
  const trigger = PENDING_TRIGGERS.includes(record.trigger as FreshProfileSwapTrigger)
    ? record.trigger as FreshProfileSwapTrigger
    : undefined
  const rule = PENDING_RULES.includes(record.rule as FreshProfileSwapRule)
    ? record.rule as FreshProfileSwapRule
    : undefined
  return {
    version: FRESH_PROFILE_PENDING_VERSION,
    profileName: record.profileName,
    appBuildVersion: record.appBuildVersion,
    reason: record.reason,
    ...(trigger === undefined ? {} : { trigger }),
    ...(rule === undefined ? {} : { rule }),
  }
}

/** Persist the deferred-rebuild marker (atomic; a torn write reads as absent). */
export async function writeFreshProfilePending(statePath: string, state: FreshProfilePendingState): Promise<void> {
  await writeFileAtomic(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

/** Drop the deferred-rebuild marker after the retry landed. */
export function clearFreshProfilePending(statePath: string): void {
  rmSync(statePath, { force: true })
}

/** What one boot does with a deferred-rebuild marker. */
export type FreshProfilePendingAction = 'retry' | 'keep' | 'drop'

/**
 * Decide the deferred marker's fate for this boot. The policy LOCK is the only
 * reason to drop a marker: an unlocked build can never perform the rebuild, so
 * the marker would otherwise sit there forever. The `pluginResetOnVersionChange`
 * switch is deliberately NOT part of this gate — with it off the automatic
 * layer still rebuilds on a product-version change, so the pending rebuild
 * stays meaningful and dropping it would lose it permanently. A marker naming
 * a Profile that is not active this boot is KEPT and the retry is simply
 * skipped — dropping it would lose the pending rebuild permanently, because
 * the deferred path never recorded the marked Profile's build identity and the
 * automatic layer records the current build for whichever Profile IS active;
 * returning to the marked Profile would then read as an unchanged version and
 * never rebuild.
 */
export function freshProfilePendingAction(options: {
  readonly markerProfileName: string
  readonly activeProfileName: string
  /** The policy lock is on, so a rebuild can still happen on some boot. */
  readonly policyLocked: boolean
}): FreshProfilePendingAction {
  if (options.policyLocked !== true) return 'drop'
  return options.markerProfileName === options.activeProfileName ? 'retry' : 'keep'
}

/** What one boot's build identity implies for the active Profile. */
export type FreshProfileResetDecision = 'unchanged' | 'record' | 'reset'

/**
 * Decide the automatic layer's action. An unlocked build is always inert, so
 * it keeps byte-identical behavior (not even the record is written). A locked
 * build compares identities by the policy's rule:
 *
 * - `pluginResetOnVersionChange` on (a build that carries a DSH-base upgrade)
 *   compares the full build identity, so every build counter bumps the
 *   Profile: one installer serves a fleet whose plugin sets can never
 *   straddle two builds, and a rollback lands on a clean tree too.
 * - off (the default) compares the product-version base only, so a build
 *   counter change (`2.0.3+b78` → `2.0.3+b79`) keeps the Profile and only a
 *   product version change (`2.0.3` → `2.0.4`) rebuilds it.
 *
 * An unchanged identity is a pure read. The rules differ on a missing
 * record, because only the forced rule ever wrote one for every build:
 *
 * - forced: a missing record with a Profile manifest is a straddle and
 *   resets; with no manifest it is a genuinely fresh install and only
 *   records.
 * - version: a missing record is a first observation — builds running with
 *   the switch off wrote no record before this one, so there is nothing to
 *   compare against — and only records; a RECORDED product version that
 *   differs resets.
 */
export function freshProfileResetDecision(options: {
  readonly locked: boolean
  readonly resetOnVersionChange: boolean
  readonly previousAppBuildVersion?: string | undefined
  readonly appBuildVersion: string
  /** Product-version base of the previous boot; derived from its build identity when absent. */
  readonly previousAppVersion?: string | undefined
  /** Product-version base of this boot; derived from its build identity when absent. */
  readonly appVersion?: string | undefined
  /** Whether the active Profile manifest already exists on disk. */
  readonly profileExists: boolean
}): FreshProfileResetDecision {
  if (options.locked !== true) return 'unchanged'
  if (options.resetOnVersionChange === true) {
    if (options.previousAppBuildVersion === options.appBuildVersion) return 'unchanged'
    if (options.previousAppBuildVersion === undefined && !options.profileExists) return 'record'
    return 'reset'
  }
  const previousAppVersion = options.previousAppVersion ?? buildVersionProductBase(options.previousAppBuildVersion)
  const appVersion = options.appVersion ?? buildVersionProductBase(options.appBuildVersion)
  if (previousAppVersion === appVersion) return 'unchanged'
  // The off rule never wrote a record before this build, so a missing record
  // is a first observation, not a straddle: record the identity and leave the
  // Profile alone. Only a RECORDED product version that differs rebuilds it
  // (even without a manifest — the record proves another build managed this
  // home).
  if (previousAppVersion === undefined) return 'record'
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

/**
 * Drop a Profile's residual market install receipts when a boot only RECORDS
 * its build identity for a manifest-less Profile.
 *
 * The record branch covers two shapes: a genuinely fresh install (no manifest
 * ever existed) and a Profile directory the user deleted by hand. In both, any
 * receipt still in the home ledger names a Profile that cannot prove an
 * installed bundle — the market would read an empty Profile and fail its whole
 * installed list, which no restart clears. The manifest fact is the gate,
 * never the decision string: the product-version rule also returns 'record'
 * for a Profile that still has its manifest and plugins, and clearing there
 * would hide real installs. Failures are logged and swallowed: a ledger that
 * could not be rewritten must never block the boot (the swap's own posture).
 *
 * The second gate is ordering, not fact: this clear runs before the Profile
 * preparation that may later restore a healthy checkpoint (package.json,
 * lockfile, and node_modules resurrected by materialization). A boot with a
 * restorable snapshot must keep the receipts — the restored plugins come back
 * installed, and without their receipts the market would treat them as
 * external and refuse a reinstall with a conflict.
 */
export async function clearFreshProfileRecordReceipts(options: {
  /** Whether the active Profile manifest already existed at boot. */
  readonly profileExists: boolean
  /**
   * Whether the Profile's health checkpoint holds a restorable snapshot this
   * boot. When true the receipts survive even a missing manifest, because a
   * later restore can still resurrect exactly the bundles they prove.
   */
  readonly restoreSnapshotExists?: boolean
  readonly settingsDocumentPath: string
  readonly profileName: string
  readonly logError?: (message: string) => void
}): Promise<number> {
  if (options.profileExists) return 0
  if (options.restoreSnapshotExists === true) return 0
  try {
    const cleared = await clearMarketInstallReceipts(options.settingsDocumentPath, options.profileName)
    if (cleared > 0) {
      options.logError?.(
        `cleared ${String(cleared)} stale market install receipt(s) for the fresh profile ${options.profileName}`,
      )
    }
    return cleared
  } catch (cause) {
    options.logError?.(
      `could not clear stale market install receipts for the fresh profile ${options.profileName}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
    return 0
  }
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
  /**
   * Backoff schedule for a rename the OS refuses with a transient lock code
   * (`EBUSY`/`EPERM`/`ENOTEMPTY`/`EACCES`). Tests inject a zeroed schedule or
   * a fake {@linkcode sleep} so the retry path is exercised without a real
   * lock or real waiting.
   */
  readonly renameRetryDelaysMs?: readonly number[] | undefined
  /** Sleep seam for {@linkcode renameRetryDelaysMs}; defaults to a real timer. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined
  /**
   * Rename seam for the set-aside step; defaults to `fs.renameSync`. Tests
   * inject a function that refuses with `EBUSY` so the Windows lock path is
   * exercised without holding a real handle.
   */
  readonly rename?: ((from: string, to: string) => void) | undefined
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
  /**
   * Present and true when the set-aside rename stayed locked through every
   * backoff step. Nothing was rebuilt and the existing Profile is untouched;
   * the caller writes a marker and retries on the next startup.
   */
  readonly deferred?: true
  /** Last refused rename code; present only on a deferred result. */
  readonly reasonCode?: ProfileRenameLockedCode
  /** Rename attempts made; present only on a deferred result. */
  readonly attempts?: number
}

/** Real timer used when the caller does not inject a sleep seam. */
const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Rename the existing Profile directory aside, returning the backup path.
 *
 * A transient OS lock (Windows keeps a directory un-renamable while any
 * handle inside it is open) is retried on a fixed backoff before giving up:
 * each refused attempt logs the attempt number and error code, and the last
 * refusal after the schedule raises {@linkcode ProfileRenameLockedError} so
 * the swap can defer instead of failing. Every other error is immediate.
 */
async function setAsideProfileDirectory(
  profileDir: string,
  epochMs: number,
  options: {
    readonly logError?: ((message: string) => void) | undefined
    readonly retryDelaysMs?: readonly number[] | undefined
    readonly sleep?: ((ms: number) => Promise<void>) | undefined
    readonly rename?: ((from: string, to: string) => void) | undefined
  } = {},
): Promise<string | undefined> {
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
  const delays = options.retryDelaysMs ?? RENAME_RETRY_DELAYS_MS
  const sleep = options.sleep ?? defaultSleep
  const rename = options.rename ?? renameSync
  for (let collision = 0; collision <= MAX_BACKUP_COLLISIONS; collision += 1) {
    const backup = collision === 0
      ? profileBackupPath(profileDir, epochMs)
      : `${profileBackupPath(profileDir, epochMs)}-${String(collision)}`
    if (existsSync(backup)) continue
    for (let attempt = 0; ; attempt += 1) {
      try {
        rename(profileDir, backup)
        return backup
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw cause
        // The destination appeared between the existsSync probe and the
        // rename (another swap won this stamp). Retrying the SAME target can
        // never succeed, so move to the next collision suffix instead of
        // spending the whole backoff schedule on a dead path.
        if (existsSync(backup)) break
        const delayMs = delays[attempt]
        if (delayMs === undefined) {
          throw new ProfileRenameLockedError(profileDir, code as ProfileRenameLockedCode, attempt + 1)
        }
        options.logError?.(
          `profile directory ${profileDir} -> ${backup} is locked (rename attempt ${String(attempt + 1)} of ${String(delays.length + 1)}: ${code}); retrying in ${String(delayMs)}ms`,
        )
        await sleep(delayMs)
      }
    }
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
  let backupDir: string | undefined
  try {
    backupDir = await setAsideProfileDirectory(profileDir, (options.now ?? Date.now)(), {
      ...(options.logError === undefined ? {} : { logError: options.logError }),
      ...(options.renameRetryDelaysMs === undefined ? {} : { retryDelaysMs: options.renameRetryDelaysMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.rename === undefined ? {} : { rename: options.rename }),
    })
  } catch (cause) {
    if (cause instanceof ProfileRenameLockedError) {
      // Windows held a handle inside the Profile for longer than the whole
      // backoff schedule. Nothing was renamed or rebuilt: the existing
      // Profile stays bootable, and the caller records a marker so the next
      // startup retries this exact rename before it opens anything.
      return {
        profileName: options.profileName,
        profileDir,
        materialized: false,
        receiptsCleared: 0,
        pruneBackups: Promise.resolve([]),
        deferred: true,
        reasonCode: cause.code,
        attempts: cause.attempts,
      }
    }
    throw cause
  }
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
