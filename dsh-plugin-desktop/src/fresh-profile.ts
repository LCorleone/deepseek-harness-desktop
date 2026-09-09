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
 * `settings.yaml` receipt array) IS cleared, because the receipts describe
 * packages that no longer exist in the rebuilt Profile; clearing it is what
 * returns every catalog entry to the installable state and resets the
 * sequence ratchet to its receipt-derived floor.
 *
 * @module dsh-plugin-desktop/fresh-profile
 */

import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { isSeq, parseDocument } from 'yaml'
import { assertDesktopProfileName } from './profile-manager.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/** Persisted build-identity record name inside the Desktop user-data directory. */
export const PROFILE_GENERATION_FILENAME = 'last-profile-generation.json'
const PROFILE_GENERATION_VERSION = 1
const MAX_GENERATION_STATE_BYTES = 4 * 1024
/** Set-aside directory infix: `profiles/desktop.bak-20260909T073319264Z`. */
const PROFILE_BACKUP_INFIX = '.bak-'
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
export function writeProfileGenerationState(statePath: string, state: ProfileGenerationState): void {
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** What one boot's build identity implies for the active Profile. */
export type FreshProfileResetDecision = 'unchanged' | 'record' | 'reset'

/**
 * Decide the automatic layer's action. The switch is inert unless the build
 * is locked AND the policy enables it, so an unlocked or opted-out build
 * keeps byte-identical behavior (not even the record is written). A first
 * record with no history cannot reset — there is nothing to rebuild from —
 * and an unchanged identity is a pure read.
 */
export function freshProfileResetDecision(options: {
  readonly locked: boolean
  readonly resetOnVersionChange: boolean
  readonly previousAppBuildVersion?: string | undefined
  readonly appBuildVersion: string
}): FreshProfileResetDecision {
  if (options.locked !== true || options.resetOnVersionChange !== true) return 'unchanged'
  if (options.previousAppBuildVersion === undefined) return 'record'
  return options.previousAppBuildVersion === options.appBuildVersion ? 'unchanged' : 'reset'
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
 * Remove the market install receipt ledger from the shared settings document
 * and report how many receipts were dropped. Idempotent: an absent namespace,
 * key, or file writes nothing and returns 0. Comments and every other setting
 * survive the round trip because the document is edited as a YAML AST.
 */
export function clearMarketInstallReceipts(settingsPath: string): number {
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
  const count = isSeq(receipts) ? receipts.items.length : 0
  document.deleteIn([MARKET_SETTINGS_NAMESPACE, MARKET_RECEIPTS_KEY])
  writeFileSync(settingsPath, document.toString(), { encoding: 'utf8', mode: 0o600 })
  return count
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
 * Rebuild the active Profile from scratch. Ordered so every crash window
 * leaves a usable state: the previous Profile is set aside first (never
 * deleted), then the fresh Profile is created, then the market ledger is
 * cleared, then dependencies are synchronized. A failure before the create
 * step leaves the set-aside Profile recoverable by hand; a failure after it
 * leaves a bootable fresh Profile. Callers decide whether a failure blocks
 * the boot — the desktop degrades to the existing Profile instead.
 */
export async function freshProfileSwap(options: FreshProfileSwapOptions): Promise<FreshProfileSwapResult> {
  assertDesktopProfileName(options.profileName)
  const profileDir = resolveProfileDir(options.profileName, options.home)
  const backupDir = setAsideProfileDirectory(profileDir, (options.now ?? Date.now)())
  options.createProfile()
  let receiptsCleared = 0
  try {
    receiptsCleared = clearMarketInstallReceipts(options.settingsDocumentPath)
  } catch (cause) {
    options.logError?.(
      `could not clear the market install receipts after rebuilding profile ${options.profileName}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    )
  }
  const materialized = options.materialize === undefined ? false : await options.materialize()
  return {
    profileName: options.profileName,
    profileDir,
    ...(backupDir === undefined ? {} : { backupDir }),
    materialized,
    receiptsCleared,
  }
}
