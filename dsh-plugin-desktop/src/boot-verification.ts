/**
 * Startup verification of third-party profile bundles (P2-4).
 *
 * A locked deployment treats the signed company manifest as the only
 * authority that may load a third-party bundle. This module is the decision
 * function consumed by profile composition (`prepareDesktopProfile`): given
 * the signed manifest bytes, the deployment trust roots, and one record per
 * third-party bundle (installed version, lockfile-pinned npm dist integrity,
 * and the installed package directory), it returns the exact allowlist for
 * this boot plus an explicit rejection list with reasons.
 *
 * Verification chain per bundle, fail-closed at every step:
 *
 * 1. The manifest itself must verify (canonical JSON, trust-root binding,
 *    detached ed25519 signature, strictly increasing sequence, unexpired).
 *    A missing, untrusted, rolled-back, or expired manifest rejects EVERY
 *    third-party bundle while the upstream Web client keeps booting: boot
 *    verification never refuses the whole startup, only third-party content.
 * 2. The manifest must carry an entry for the exact (packageName, version).
 *    Absent entries, other-version pins, and revoked entries are rejected.
 * 3. The profile lockfile must pin the same npm dist integrity the manifest
 *    signed. A missing or diverging lockfile record is rejected.
 * 4. Installed-tree evidence. Which anchor the check uses is decided by the
 *    signed entry itself (gradual enablement):
 *
 *    - **Signed tree digest (the authority mode).** When the entry carries
 *      the optional `treeDigest`, that signed value is the authoritative
 *      expectation: the on-disk tree is measured (the same deterministic
 *      walk the receipts use) and must equal the signed digest or the bundle
 *      is refused. The market install receipt is demoted to an advisory
 *      cache with no decision power: deleting it cannot degrade the bundle
 *      to manifest-only, and forging it cannot legitimize tampered files,
 *      because the comparison target is the signed digest, never the
 *      receipt. A receipt whose rootDigest equals the signed digest must not
 *      skip the measurement either — the receipt lives in user-writable
 *      storage, so honoring it as a pass would reintroduce exactly the
 *      bypass this anchor removes (repeat-boot cost stays bounded by the
 *      persisted stat-fingerprint measure cache wired by the Host). The
 *      allow decision carries `evidence: 'signed-tree'`.
 *    - **Receipt anchor (entries without `treeDigest`).** With a usable
 *      receipt the measured `rootDigest` of the installed tree must equal
 *      `receipt.rootDigest` byte for byte, which is the tamper check for
 *      files already on disk. Without a usable receipt (absent, legacy v1,
 *      or malformed) the bundle degrades to "manifest-only": the signed
 *      entry and lock integrity still hold, the bundle stays loadable, and
 *      its allow decision carries `evidence: 'manifest-only'` so
 *      diagnostics can flag the missing receipt until the next install
 *      records one. This degradation is a recorded policy decision, not an
 *      oversight — see the dev-log manifest-authority card.
 *
 * Scope guarantee (the compatibility red line): the caller only submits
 * third-party bundle names — the upstream Web template bundles,
 * `dsh-plugin-desktop`, and both Market provider packages are never
 * verification targets and can therefore never be rejected here.
 *
 * Determinism: the installed-tree measurement mirrors the published rules of
 * the market package's `computeInstallTreeDigest` (P2-3) — package-relative
 * POSIX paths, SHA-256 over raw file bytes, symlink entries hashing the link
 * target text and never being followed, records sorted by path in UTF-16
 * code-unit order, and `rootDigest` = SHA-256 over the UTF-8 concatenation
 * of `sha256:<path>\n<digest>\n` lines. Desktop re-implements the rules
 * synchronously because profile composition is synchronous; both
 * implementations follow the same documented contract, so receipt digests
 * recorded by the market install path compare equal here.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import {
  findCompanyManifestPackage,
  verifyCompanyManifest,
  type CompanyManifest,
  type CompanyManifestTrustRoot,
  type CompanyManifestVerificationCode,
  type MarketInstallReceipt,
} from 'dsh-community-market'
import { fetchCompanyManifestText } from './company-manifest-origin.ts'
import { DESKTOP_MARKET_IDENTITIES } from './desktop-market.ts'
import { desktopPluginBundleMutable } from './desktop-plugins.ts'
import { resolveOverlayPackage } from './package-overlay.ts'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import type { DesktopPolicy } from './desktop-policy.ts'

/** Lowercase hex SHA-256 shape shared by root digests and trust-root fingerprints. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u
/** Read bound for one profile lockfile, mirroring the market install path. */
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024

/** Upper bound of measured files per installed tree; mirrors the market tree-digest contract. */
export const BOOT_TREE_MAX_FILES = 20_000
/** Upper bound of one measured relative path in characters; mirrors the market tree-digest contract. */
export const BOOT_TREE_MAX_PATH_LENGTH = 1024

/** One third-party bundle as installed in the active profile. */
export interface DesktopBootBundle {
  /** Declared npm package name from `dsh.profile.bundles`. */
  readonly packageName: string
  /** Version read from the installed package.json; undefined when unreadable or mismatched. */
  readonly version: string | undefined
  /** npm dist integrity pinned for the exact version in the profile lockfile; undefined when unpinned. */
  readonly lockIntegrity: string | undefined
  /** Installed package directory to measure; undefined when the package cannot be resolved. */
  readonly packageDir: string | undefined
}

/** Receipt evidence for one exact installed bundle (market install receipt v2, narrowed). */
export interface DesktopBootReceipt {
  readonly packageName: string
  readonly version: string
  /** Sequence of the signed manifest that allowed the recorded install. */
  readonly manifestSequence: number
  /** keyId of the trust root that verified the manifest allowing the install. */
  readonly keyId: string
  /** Recorded `treeDigest.rootDigest` of the post-install measurement. */
  readonly rootDigest: string
}

/** Injectable inputs for locked-build boot verification. */
export interface DesktopBootVerificationInputs {
  /**
   * Signed manifest bytes. Defaults to the embedded content-mode asset when
   * the policy pins one; origin-mode deployments fetch through
   * {@link desktopBootVerificationInputs} (profile composition itself never
   * performs network I/O).
   */
  readonly manifestBytes?: string | Uint8Array
  /** Market install receipts; absent receipts degrade matching bundles to manifest-only. */
  readonly receipts?: readonly DesktopBootReceipt[]
  /**
   * Anti-rollback sequence floor passed straight to manifest verification
   * (strictly greater wins). Defaults to one below the highest receipt
   * sequence, so the same embedded manifest that allowed an install
   * re-verifies at boot while anything older is stale.
   */
  readonly lastSeenSequence?: number
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Installed-tree measurement override for focused tests and the persisted
   * fingerprint cache (see {@link createCachedDesktopBootTreeRootDigestMeasure});
   * defaults to the full synchronous measurement.
   */
  readonly measureTreeRootDigest?: (packageDir: string) => string
}

export interface DesktopBootVerificationOptions {
  /** Policy-pinned signing keys; a manifest signed by any listed key verifies. */
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  /** Receipts keyed by exact (packageName, version); unusable receipts are ignored. */
  readonly receipts?: readonly DesktopBootReceipt[]
  /** Anti-rollback floor; see {@link DesktopBootVerificationInputs.lastSeenSequence}. */
  readonly lastSeenSequence?: number
  /** Clock injection for manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /** Installed-tree measurement override for focused tests. */
  readonly measureTreeRootDigest?: (packageDir: string) => string
}

/** How much evidence allowed a bundle to load. */
export type DesktopBootEvidence = 'receipt' | 'manifest-only' | 'signed-tree'

/** One bundle cleared for this boot. */
export interface DesktopBootAllowedBundle {
  readonly packageName: string
  readonly evidence: DesktopBootEvidence
  /** Sequence of the verified manifest that allowed this boot decision. */
  readonly manifestSequence: number
  /** keyId of the trust root that verified the manifest for this boot. */
  readonly keyId: string
}

/** One bundle refused for this boot, with the first failing check as the reason. */
export interface DesktopBootRejectedBundle {
  readonly packageName: string
  readonly reason: string
}

/** Why the signed manifest itself was not trusted for this boot. */
export type DesktopBootManifestFailureCode = 'manifest-missing' | CompanyManifestVerificationCode

export interface DesktopBootManifestFailure {
  readonly code: DesktopBootManifestFailureCode
  readonly reason: string
}

/** Complete boot decision for the submitted third-party bundles. */
export interface DesktopBootVerification {
  /** Whether the signed company manifest verified for this boot. */
  readonly manifestTrusted: boolean
  /** Verified manifest sequence, or undefined when the manifest was not trusted. */
  readonly manifestSequence: number | undefined
  /** keyId that verified the manifest, or undefined when the manifest was not trusted. */
  readonly keyId: string | undefined
  /** First manifest-level failure; undefined after a successful verification. */
  readonly manifestFailure: DesktopBootManifestFailure | undefined
  /** Bundles cleared to load, in submission order. */
  readonly allowed: readonly DesktopBootAllowedBundle[]
  /** Bundles refused for this boot, in submission order. */
  readonly rejected: readonly DesktopBootRejectedBundle[]
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

interface BootTreeRecord {
  readonly path: string
  readonly digest: string
}

const byPath = (left: BootTreeRecord, right: BootTreeRecord): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0

function collectBootTreeRecords(dir: string, prefix: string, records: BootTreeRecord[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (path.length > BOOT_TREE_MAX_PATH_LENGTH) {
      throw new Error('installed tree digest exceeded the path length limit')
    }
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectBootTreeRecords(child, path, records)
    } else if (entry.isFile()) {
      records.push({ path, digest: sha256Hex(readFileSync(child)) })
    } else if (entry.isSymbolicLink()) {
      records.push({ path, digest: sha256Hex(Buffer.from(readlinkSync(child), 'utf8')) })
    } else {
      throw new Error(`installed tree entry ${path} is not a file, directory, or symbolic link`)
    }
    if (records.length > BOOT_TREE_MAX_FILES) {
      throw new Error('installed tree digest exceeded the file limit')
    }
  }
}

/**
 * Measure one installed package directory tree synchronously and return its
 * deterministic root digest. The serialization contract is documented at the
 * top of this module and matches the market install receipts byte for byte.
 * Unmeasurable trees (foreign entry types, limit overruns, I/O failures)
 * throw; callers treat a thrown measurement as a rejection of that bundle.
 */
export function computeDesktopBootTreeRootDigest(packageDir: string): string {
  const records: BootTreeRecord[] = []
  collectBootTreeRecords(packageDir, '', records)
  records.sort(byPath)
  const root = createHash('sha256')
  for (const record of records) root.update(`sha256:${record.path}\n${record.digest}\n`, 'utf8')
  return root.digest('hex')
}

/** Persisted fingerprint of one measured package directory (L2 P1④). */
export interface DesktopBootTreeFingerprintEntry {
  /** Aggregate modification-time fingerprint over the sorted tree entries. */
  readonly mtime: number
  /** Aggregate size fingerprint over the sorted tree entries. */
  readonly size: number
  /** Full `rootDigest` measured when the stat fingerprint was recorded. */
  readonly digest: string
}

/** Persisted cache document: absolute package directory to its fingerprint entry. */
export type DesktopBootTreeFingerprintDocument = Record<string, DesktopBootTreeFingerprintEntry>

/** Filename of the persisted boot tree fingerprint cache inside `<userData>`. */
export const DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME = 'boot-tree-fingerprints.json'

const SHA256_HEX_ENTRY_PATTERN = /^[0-9a-f]{64}$/u
const MAX_BOOT_TREE_FINGERPRINT_ENTRIES = 64

/** Aggregated stat fingerprint of one installed tree (no file content is read). */
export interface DesktopBootTreeStatFingerprint {
  readonly mtime: number
  readonly size: number
}

const byName = (left: { readonly name: string }, right: { readonly name: string }): number =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0

function collectBootTreeStatFingerprint(
  dir: string,
  aggregate: { mtime: number; size: number; entries: number },
): void {
  // Same traversal shape as the digest walk (sorted names, symlinks never
  // followed, foreign entry types refused), but reading only stat data: the
  // aggregate is the cheap change detector for the fingerprint cache below.
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const stats = lstatSync(join(dir, entry.name))
    aggregate.mtime += stats.mtimeMs
    aggregate.size += stats.size
    aggregate.entries += 1
    if (aggregate.entries > BOOT_TREE_MAX_FILES) {
      throw new Error('installed tree digest exceeded the file limit')
    }
    if (entry.isDirectory()) {
      collectBootTreeStatFingerprint(join(dir, entry.name), aggregate)
    } else if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(`installed tree entry ${entry.name} is not a file, directory, or symbolic link`)
    }
  }
}

/**
 * Compute the stat-level change fingerprint of one installed package tree.
 * Reads directory entries and metadata only — never file content — and throws
 * on the same unmeasurable trees the full digest rejects.
 */
export function desktopBootTreeStatFingerprint(packageDir: string): DesktopBootTreeStatFingerprint {
  const aggregate = { mtime: 0, size: 0, entries: 0 }
  collectBootTreeStatFingerprint(packageDir, aggregate)
  return { mtime: aggregate.mtime, size: aggregate.size }
}

function validFingerprintEntry(value: unknown): value is DesktopBootTreeFingerprintEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.mtime === 'number' && Number.isFinite(entry.mtime)
    && typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0
    && typeof entry.digest === 'string' && SHA256_HEX_ENTRY_PATTERN.test(entry.digest)
}

/** Injectable file seams for focused tests of the fingerprint cache. */
export interface CachedBootTreeDigestMeasureOptions {
  /** Full measurement; defaults to {@link computeDesktopBootTreeRootDigest}. */
  readonly measure?: (packageDir: string) => string
  /** Cache file reader; defaults to `readFileSync(utf8)`. */
  readonly readFile?: (path: string) => string
  /** Cache file writer; defaults to `writeFileSync`. */
  readonly writeFile?: (path: string, body: string) => void
  /** Remembered package directories; defaults to 64. */
  readonly maxEntries?: number
}

/**
 * Wrap the full tree measurement with the persisted stat-fingerprint cache
 * (`<userData>/boot-tree-fingerprints.json`). Per package directory the cache
 * records `{mtime, size, digest}`: two aggregates over the sorted stat walk
 * plus the root digest measured when they were recorded. A repeat boot whose
 * stat fingerprint still matches skips the full content hash and returns the
 * recorded digest — which the receipt comparison then accepts exactly when
 * the receipt still pins that digest; any divergence keeps rejecting. A
 * changed tree (different sizes or modification times anywhere in it)
 * recomputes the full digest and rewrites the entry. A corrupt or unreadable
 * cache file is ignored and rebuilt; a failed write is skipped (the next boot
 * simply re-measures).
 *
 * Advisory positioning: the cache lives in user-writable `<userData>` and
 * trades the repeat-boot content hash for stat-level change detection — a
 * pre-existing, documented tradeoff (L2 P1④) of the measurement seam itself.
 * It never decides what a boot expects: the expectation comes from the
 * signed manifest entry (`treeDigest`, when present) or, for entries without
 * it, from the user-writable receipt store as before, so a tampered or
 * removed cache file can only cost a full re-measurement.
 */
export function createCachedDesktopBootTreeRootDigestMeasure(
  cachePath: string,
  options: CachedBootTreeDigestMeasureOptions = {},
): (packageDir: string) => string {
  const measure = options.measure ?? computeDesktopBootTreeRootDigest
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const writeFile = options.writeFile ?? ((path: string, body: string) => { writeFileSync(path, body) })
  const maxEntries = options.maxEntries ?? MAX_BOOT_TREE_FINGERPRINT_ENTRIES
  let records: Map<string, DesktopBootTreeFingerprintEntry> | undefined
  const load = (): Map<string, DesktopBootTreeFingerprintEntry> => {
    if (records !== undefined) return records
    records = new Map()
    try {
      const parsed: unknown = JSON.parse(readFile(cachePath))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [packageDir, entry] of Object.entries(parsed as Record<string, unknown>)) {
          if (packageDir.length > 0 && validFingerprintEntry(entry)) {
            records.set(packageDir, entry)
          }
        }
      }
    } catch {
      // A corrupt or missing cache is not a boot failure: rebuild from empty.
    }
    return records
  }
  const persist = (): void => {
    try {
      writeFile(cachePath, `${JSON.stringify(Object.fromEntries(load()), null, 2)}\n`)
    } catch {
      // A failed write only costs the next boot a full measurement.
    }
  }
  return (packageDir: string) => {
    const cache = load()
    const fingerprint = desktopBootTreeStatFingerprint(packageDir)
    const cached = cache.get(packageDir)
    if (cached !== undefined
      && cached.mtime === fingerprint.mtime
      && cached.size === fingerprint.size) {
      return cached.digest
    }
    const digest = measure(packageDir)
    cache.set(packageDir, { mtime: fingerprint.mtime, size: fingerprint.size, digest })
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    persist()
    return digest
  }
}

/**
 * Resolve the bundled company manifest asset path for content-mode policies.
 * The policy parser already confines `companyManifestUrl` to a safe relative
 * path; the same constraints are re-asserted here for direct callers.
 */
export function companyManifestAssetPath(companyManifestUrl: string, moduleUrl: string = import.meta.url): string {
  if (typeof companyManifestUrl !== 'string' || companyManifestUrl.length === 0
    || companyManifestUrl.includes('\0') || companyManifestUrl.includes('\\')) {
    throw new TypeError('company manifest asset path must be a non-empty relative path without NUL or backslash')
  }
  const segments = companyManifestUrl.split('/')
  if (companyManifestUrl.startsWith('/')
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError('company manifest asset path must stay inside the bundled module directory')
  }
  return join(dirname(fileURLToPath(new URL(moduleUrl))), ...segments)
}

/**
 * Read bundled manifest bytes. Any read failure — a missing asset included —
 * returns undefined so locked boots degrade to "all third-party rejected"
 * instead of failing the whole startup.
 */
export function readCompanyManifestAsset(assetPath: string): string | undefined {
  try {
    return readFileSync(assetPath, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Normalize market install receipts into boot receipt evidence. Only receipt
 * v2 records carry a tree measurement; legacy v1 receipts contribute nothing
 * (matching bundles degrade to manifest-only) and never influence sequences.
 * The receipt store lives in the user-writable settings document, so every
 * v2 record is shape-checked before it is trusted: a malformed record — a
 * missing or non-object tree digest, wrong field types, an out-of-range
 * sequence — is skipped exactly like a legacy one, because one corrupted
 * line must never throw through profile composition and refuse the whole
 * startup (the module contract).
 */
export function desktopBootReceipts(receipts: readonly MarketInstallReceipt[]): readonly DesktopBootReceipt[] {
  const evidence: DesktopBootReceipt[] = []
  for (const receipt of receipts) {
    if (record(receipt) === undefined) continue
    if (receipt.receiptVersion !== 2) continue
    if (typeof receipt.packageName !== 'string' || receipt.packageName.length === 0) continue
    if (typeof receipt.version !== 'string' || receipt.version.length === 0) continue
    if (!Number.isSafeInteger(receipt.manifestSequence) || receipt.manifestSequence < 1) continue
    if (typeof receipt.keyId !== 'string' || receipt.keyId.length === 0) continue
    const treeDigest = record(receipt.treeDigest)
    if (treeDigest === undefined || typeof treeDigest.rootDigest !== 'string'
      || !SHA256_HEX_PATTERN.test(treeDigest.rootDigest)) continue
    evidence.push({
      packageName: receipt.packageName,
      version: receipt.version,
      manifestSequence: receipt.manifestSequence,
      keyId: receipt.keyId,
      rootDigest: treeDigest.rootDigest,
    })
  }
  return evidence
}

/** Settings namespace that owns the community market's persisted document. */
const MARKET_SETTINGS_NAMESPACE = 'dsh-community-market'
/** Read bound for the settings document carrying market install receipts. */
const MAX_MARKET_SETTINGS_BYTES = 8 * 1024 * 1024

/**
 * Extract the community market's raw install receipts from one parsed
 * settings document. The document is user-writable, so anything but a
 * well-formed `installReceipts` array contributes nothing; record-level
 * shape problems are skipped later by {@link desktopBootReceipts}.
 */
export function marketInstallReceiptsFromSettingsDocument(document: unknown): readonly MarketInstallReceipt[] {
  const receipts = record(record(document)?.[MARKET_SETTINGS_NAMESPACE])?.installReceipts
  if (!Array.isArray(receipts)) return []
  return receipts.filter(value => record(value) !== undefined) as MarketInstallReceipt[]
}

/**
 * Read normalized boot receipt evidence from the shared settings document
 * (`<home>/settings.yaml`, the file the market's settings provider owns).
 * Missing, unreadable, oversized, or malformed documents yield no evidence —
 * matching bundles then degrade to manifest-only and the sequence ratchet
 * stays at zero. This reader never throws: receipt reconciliation must not be
 * able to refuse a startup.
 */
export function readDesktopBootReceiptsFromSettings(settingsPath: string): readonly DesktopBootReceipt[] {
  try {
    const body = readFileSync(settingsPath)
    if (body.byteLength > MAX_MARKET_SETTINGS_BYTES) return []
    const parsed = parseDocument(body.toString('utf8'), { prettyErrors: true })
    if (parsed.errors.length > 0) return []
    return desktopBootReceipts(marketInstallReceiptsFromSettingsDocument(parsed.toJS() ?? {}))
  } catch {
    return []
  }
}

/**
 * Assemble the settings-derived slice of the production inputs for a locked
 * boot: normalized install receipts from the shared market settings document,
 * plus the embedded manifest bytes for content-mode policies. Origin-mode
 * policies contribute no bytes here — the async {@link desktopBootVerificationInputs}
 * adds the one pre-composition fetch. The sequence floor is intentionally
 * left to the receipt-derived default inside {@link verifyDesktopBootBundles}.
 */
export function desktopBootVerificationInputsFromSettings(
  policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  settingsDocumentPath: string,
  moduleUrl: string = import.meta.url,
): DesktopBootVerificationInputs {
  const manifestBytes = policy.companyCatalogOrigin !== null
    ? undefined
    : readCompanyManifestAsset(companyManifestAssetPath(policy.companyManifestUrl, moduleUrl))
  return {
    receipts: readDesktopBootReceiptsFromSettings(settingsDocumentPath),
    ...(manifestBytes === undefined ? {} : { manifestBytes }),
  }
}

/** Options for {@link desktopBootVerificationInputs}. */
export interface DesktopBootVerificationInputOptions {
  /**
   * Origin-mode manifest acquisition boundary; defaults to the shared
   * restricted policy-pinned fetch with its multi-second timeout.
   */
  readonly fetchManifestText?: (
    policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  ) => Promise<string>
  /** Installed-tree measurement override (the persisted fingerprint cache). */
  readonly measureTreeRootDigest?: (packageDir: string) => string
}

/**
 * Assemble the production inputs for a locked boot (L2): the settings-derived
 * receipts and content-mode asset bytes of
 * {@link desktopBootVerificationInputsFromSettings}, plus the origin-mode
 * manifest fetch profile composition itself must never perform. The fetch
 * runs once, before composition; any failure leaves the bytes unset so boot
 * verification fails closed for third-party content while the upstream
 * client keeps booting. The receipt-derived sequence floor stays with the
 * default inside {@link verifyDesktopBootBundles}.
 */
export async function desktopBootVerificationInputs(
  policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  settingsDocumentPath: string,
  moduleUrl: string = import.meta.url,
  options: DesktopBootVerificationInputOptions = {},
): Promise<DesktopBootVerificationInputs> {
  const inputs = desktopBootVerificationInputsFromSettings(policy, settingsDocumentPath, moduleUrl)
  let manifestBytes = inputs.manifestBytes
  if (manifestBytes === undefined && policy.companyCatalogOrigin !== null) {
    try {
      manifestBytes = await (options.fetchManifestText ?? fetchCompanyManifestText)(policy)
    } catch {
      manifestBytes = undefined
    }
  }
  return {
    ...inputs,
    ...(manifestBytes === undefined ? {} : { manifestBytes }),
    ...(options.measureTreeRootDigest === undefined
      ? {}
      : { measureTreeRootDigest: options.measureTreeRootDigest }),
  }
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function own(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function supportedLockfileVersion(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const match = /^(\d+)(?:\.\d+)?$/u.exec(String(value))
  return match !== null && (match[1] === '9' || match[1] === '11')
}

/** Accept only an exact resolution, optionally carrying a pnpm peer suffix. */
function exactLockResolution(value: unknown, version: string): value is string {
  return typeof value === 'string' && (value === version || value.startsWith(`${version}(`))
}

function lockEntry(packages: UnknownRecord, keys: readonly string[]): UnknownRecord | undefined {
  for (const key of keys) {
    if (!own(packages, key)) continue
    return record(packages[key])
  }
  return undefined
}

/**
 * Read and parse the profile `pnpm-lock.yaml`. Missing, unparseable, or
 * unsupported lockfiles return undefined: every bundle then fails its
 * lock-integrity check (fail-closed for third-party content only).
 */
export function readDesktopBootLockfile(profileDir: string): UnknownRecord | undefined {
  const path = join(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(path)) return undefined
  let body: Buffer
  try {
    body = readFileSync(path)
  } catch {
    return undefined
  }
  if (body.byteLength > MAX_LOCKFILE_BYTES) return undefined
  let parsed: ReturnType<typeof parseDocument>
  try {
    parsed = parseDocument(body.toString('utf8'), { prettyErrors: true })
  } catch {
    return undefined
  }
  if (parsed.errors.length > 0) return undefined
  const lockfile = record(parsed.toJS() ?? {})
  if (lockfile === undefined || !supportedLockfileVersion(lockfile.lockfileVersion)) return undefined
  return lockfile
}

/**
 * Resolve the npm dist integrity the profile lockfile pins for one exact
 * (packageName, version), mirroring the reader of the market install path:
 * the root importer must declare the exact specifier and resolution, and the
 * matching package entry must carry the signed resolution integrity.
 * Returns undefined whenever any link of that chain is absent.
 */
export function desktopBootLockIntegrity(
  lockfile: UnknownRecord,
  packageName: string,
  version: string,
): string | undefined {
  const importer = record(record(lockfile.importers)?.['.'])
  const dependencies = record(importer?.dependencies)
  const dependency = dependencies !== undefined && own(dependencies, packageName)
    ? record(dependencies[packageName])
    : undefined
  if (dependency === undefined
    || dependency.specifier !== version
    || !exactLockResolution(dependency.version, version)) {
    return undefined
  }
  const resolvedVersion = dependency.version
  const baseKey = `${packageName}@${version}`
  const resolvedKey = `${packageName}@${resolvedVersion}`
  const packageKeys = [...new Set([baseKey, `/${baseKey}`, resolvedKey, `/${resolvedKey}`])]
  const packages = record(lockfile.packages) ?? {}
  const resolution = record(lockEntry(packages, packageKeys)?.resolution)
  return typeof resolution?.integrity === 'string' ? resolution.integrity : undefined
}

function usableReceipt(
  receipts: readonly DesktopBootReceipt[],
  packageName: string,
  version: string,
): DesktopBootReceipt | undefined {
  return receipts.find(receipt => receipt.packageName === packageName
    && receipt.version === version
    && Number.isSafeInteger(receipt.manifestSequence)
    && receipt.manifestSequence >= 1
    && typeof receipt.keyId === 'string'
    && receipt.keyId.length > 0
    && typeof receipt.rootDigest === 'string'
    && SHA256_HEX_PATTERN.test(receipt.rootDigest))
}

/**
 * Anti-rollback floor derived from receipts: the manifest must be at least
 * as new as every recorded install, so the strict-increase floor sits one
 * below the highest receipt sequence. The same embedded manifest that
 * allowed an install therefore re-verifies at boot, while an older manifest
 * than one that already allowed an install is rejected as stale.
 */
function receiptSequenceFloor(receipts: readonly DesktopBootReceipt[]): number {
  let highest = 0
  for (const receipt of receipts) {
    if (Number.isSafeInteger(receipt.manifestSequence) && receipt.manifestSequence > highest) {
      highest = receipt.manifestSequence
    }
  }
  return Math.max(0, highest - 1)
}

/**
 * Resolve the default manifest bytes for a locked boot: injected bytes win,
 * content-mode policies read the embedded asset beside this module, and
 * origin-mode policies without injected cache bytes stay undefined (boot
 * verification never performs network I/O), which rejects all third-party
 * bundles while the upstream client keeps booting.
 */
export function defaultDesktopBootManifestBytes(
  policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  inputs: DesktopBootVerificationInputs | undefined,
): string | Uint8Array | undefined {
  if (inputs?.manifestBytes !== undefined) return inputs.manifestBytes
  if (policy.companyCatalogOrigin !== null) return undefined
  return readCompanyManifestAsset(companyManifestAssetPath(policy.companyManifestUrl))
}

/**
 * Select the boot-verification targets from a profile's declared bundles.
 * The compatibility red line lives here: upstream Web template bundles,
 * `dsh-plugin-desktop`, and both Market provider packages are exempt, so the
 * default upstream client can always start regardless of manifest state.
 */
export function desktopBootBundleNames(declaredBundles: readonly string[]): readonly string[] {
  const marketPackages: ReadonlySet<string> = new Set([
    DESKTOP_MARKET_IDENTITIES.community.packageName,
    DESKTOP_MARKET_IDENTITIES.dshMarket.packageName,
  ])
  return declaredBundles.filter(packageName =>
    desktopPluginBundleMutable(packageName) && !marketPackages.has(packageName))
}

/** Desktop installation anchor used for the same overlay resolution composition loads. */
const BOOT_INSTALL_ANCHOR = unpackedAsarPath(fileURLToPath(new URL('../package.json', import.meta.url)))

/**
 * Collect one boot record per third-party bundle: resolve the same package
 * directory profile composition would load, read its installed version, and
 * pin the lockfile integrity for that exact version. Unresolvable packages
 * still produce a record (with undefined fields) so they are rejected by
 * name instead of failing the whole startup.
 */
export function collectDesktopBootBundles(
  profileDir: string,
  packageNames: readonly string[],
): readonly DesktopBootBundle[] {
  const lockfile = readDesktopBootLockfile(profileDir)
  const installPackageUrl = pathToFileURL(BOOT_INSTALL_ANCHOR).href
  const profilePackageUrl = pathToFileURL(join(profileDir, 'package.json')).href
  return packageNames.map(packageName => {
    let packageDir: string | undefined
    try {
      packageDir = resolveOverlayPackage(packageName, {
        installPackageUrl,
        profilePackageUrl,
      }).selected.packageDir
    } catch {
      packageDir = undefined
    }
    let version: string | undefined
    if (packageDir !== undefined) {
      try {
        const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (manifest.name === packageName
          && typeof manifest.version === 'string'
          && manifest.version.length > 0) {
          version = manifest.version
        }
      } catch {
        version = undefined
      }
    }
    const lockIntegrity = lockfile !== undefined && version !== undefined
      ? desktopBootLockIntegrity(lockfile, packageName, version)
      : undefined
    return {
      packageName,
      version,
      lockIntegrity,
      packageDir,
    }
  })
}

/**
 * Decide which third-party bundles may load for this boot. See the module
 * documentation for the per-bundle chain and the failure semantics; the
 * function never throws for business failures — an untrusted manifest
 * rejects all submitted bundles and returns the failure code instead.
 */
export function verifyDesktopBootBundles(
  manifestBytes: string | Uint8Array | undefined,
  bundles: readonly DesktopBootBundle[],
  options: DesktopBootVerificationOptions,
): DesktopBootVerification {
  const receipts = options.receipts ?? []
  // A malformed injected floor falls back to the receipt-derived one: boot
  // verification must degrade to fail-closed rejections, never throw.
  const receiptFloor = receiptSequenceFloor(receipts)
  const injectedFloor = options.lastSeenSequence
  const lastSeenSequence = Number.isSafeInteger(injectedFloor) && (injectedFloor as number) >= 0
    ? injectedFloor as number
    : receiptFloor

  let verified: { readonly manifest: CompanyManifest; readonly keyId: string } | undefined
  let manifestFailure: DesktopBootManifestFailure | undefined
  if (manifestBytes === undefined) {
    manifestFailure = {
      code: 'manifest-missing',
      reason: 'no signed company manifest bytes are available for this boot',
    }
  } else {
    const verification = verifyCompanyManifest(manifestBytes, {
      trustRoots: options.trustRoots,
      lastSeenSequence,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (verification.ok) {
      verified = { manifest: verification.manifest, keyId: verification.keyId }
    } else {
      manifestFailure = { code: verification.code, reason: verification.reason }
    }
  }

  const seen = new Set<string>()
  const uniqueBundles: DesktopBootBundle[] = []
  for (const bundle of bundles) {
    if (typeof bundle.packageName !== 'string' || bundle.packageName.length === 0) continue
    if (seen.has(bundle.packageName)) continue
    seen.add(bundle.packageName)
    uniqueBundles.push(bundle)
  }

  if (verified === undefined) {
    const failure = manifestFailure!
    const reason = `the company manifest is not trusted (${failure.code}): ${failure.reason}`
    return {
      manifestTrusted: false,
      manifestSequence: undefined,
      keyId: undefined,
      manifestFailure: failure,
      allowed: [],
      rejected: uniqueBundles.map(bundle => ({ packageName: bundle.packageName, reason })),
    }
  }

  const { manifest, keyId } = verified
  const measure = options.measureTreeRootDigest ?? computeDesktopBootTreeRootDigest
  const allowed: DesktopBootAllowedBundle[] = []
  const rejected: DesktopBootRejectedBundle[] = []
  for (const bundle of uniqueBundles) {
    const reject = (reason: string): void => {
      rejected.push({ packageName: bundle.packageName, reason })
    }
    if (bundle.packageDir === undefined || bundle.version === undefined) {
      reject(`${bundle.packageName} cannot be resolved as an installed package in the active profile`)
      continue
    }
    const entry = findCompanyManifestPackage(manifest, bundle.packageName, bundle.version)
    if (entry === undefined) {
      const pinned = manifest.packages.find(candidate => candidate.packageName === bundle.packageName)
      reject(pinned === undefined
        ? `${bundle.packageName}@${bundle.version} is not in the signed company manifest`
        : `the signed company manifest pins ${bundle.packageName}@${pinned.version}, but ${bundle.version} is installed`)
      continue
    }
    if (entry.revoked) {
      reject(`${bundle.packageName}@${bundle.version} is revoked in the signed company manifest`)
      continue
    }
    if (bundle.lockIntegrity === undefined) {
      reject(`${bundle.packageName}@${bundle.version} has no exact pinned record in the profile lockfile`)
      continue
    }
    if (bundle.lockIntegrity !== entry.integrity) {
      reject(`the profile lockfile pins ${bundle.packageName}@${bundle.version} to integrity ${bundle.lockIntegrity}, but the signed company manifest pins ${entry.integrity}`)
      continue
    }
    if (entry.treeDigest !== undefined) {
      // Authority mode: the signed digest is the expectation. The receipt is
      // advisory only — see step 4 of the module documentation — so the disk
      // tree is measured and compared against the signed value whether or
      // not a receipt exists and whatever it says.
      let measured: string
      try {
        measured = measure(bundle.packageDir)
      } catch (cause) {
        reject(`the installed tree of ${bundle.packageName} could not be measured: ${messageOf(cause)}`)
        continue
      }
      if (measured !== entry.treeDigest) {
        reject(`the installed files of ${bundle.packageName}@${bundle.version} differ from the tree digest pinned in the signed company manifest`)
        continue
      }
      allowed.push({
        packageName: bundle.packageName,
        evidence: 'signed-tree',
        manifestSequence: manifest.sequence,
        keyId,
      })
      continue
    }
    const receipt = usableReceipt(receipts, bundle.packageName, bundle.version)
    if (receipt === undefined) {
      // No recorded measurement exists to compare against; the signed entry
      // and lock integrity remain the binding evidence (see module docs).
      allowed.push({
        packageName: bundle.packageName,
        evidence: 'manifest-only',
        manifestSequence: manifest.sequence,
        keyId,
      })
      continue
    }
    let measured: string
    try {
      measured = measure(bundle.packageDir)
    } catch (cause) {
      reject(`the installed tree of ${bundle.packageName} could not be measured: ${messageOf(cause)}`)
      continue
    }
    if (measured !== receipt.rootDigest) {
      reject(`the installed files of ${bundle.packageName}@${bundle.version} differ from the tree recorded in its install receipt`)
      continue
    }
    allowed.push({
      packageName: bundle.packageName,
      evidence: 'receipt',
      manifestSequence: manifest.sequence,
      keyId,
    })
  }
  return {
    manifestTrusted: true,
    manifestSequence: manifest.sequence,
    keyId,
    manifestFailure: undefined,
    allowed,
    rejected,
  }
}
