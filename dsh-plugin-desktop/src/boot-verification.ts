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
 * 1. The manifest itself must verify through the dual-channel verifier
 *    (`verifyDesktopCompanyManifest`: canonical JSON, trust-root binding,
 *    detached ed25519 signature, an anti-rollback sequence floor — strictly
 *    lower is stale, an equal sequence replays — unexpired). For manifests
 *    without the optional `source` field the decisions are byte-for-byte
 *    those of the field-unaware market verifier that ran here before the
 *    P7 wiring; `source`-carrying manifests verify only on origin-mode
 *    policies (`options.companyCatalogOrigin`), which is what makes this
 *    build "field-aware" for the fleet publication gate.
 *    A missing, untrusted, rolled-back, or expired manifest rejects EVERY
 *    third-party bundle while the upstream Web client keeps booting: boot
 *    verification never refuses the whole startup, only third-party content.
 * 2. The manifest must carry an entry for the exact (packageName, version).
 *    Absent entries, other-version pins, and revoked entries are rejected.
 * 3. The profile lockfile must pin the same integrity the manifest signed —
 *    for a registry install the exact specifier plus the npm dist
 *    integrity, for a controlled-tarball install (P7 2c) pnpm's `file:` pin
 *    of the deterministic staged path whose recorded sha512 is the signed
 *    tarball integrity and whose staged file is still present and still
 *    hashes to it. A missing or diverging lockfile record is rejected; a
 *    broken controlled-tarball pin (typically a deleted or tampered staged
 *    tarball) is rejected with a reason pointing at the reinstall repair
 *    path. Either way only that bundle is refused — never the whole boot.
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
 *      bypass this anchor removes. The authority measurement is always a
 *      full read of the file contents: it never consults the persisted
 *      stat-fingerprint measure cache, because that cache also lives in
 *      user-writable storage and a cache hit would return a recorded value
 *      instead of the measured one (see
 *      {@link createCachedDesktopBootTreeRootDigestMeasure}).
 *      The allow decision carries `evidence: 'signed-tree'`.
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
 * 5. Runtime-aware update classification and the deferred window (P15
 *    phase 1, absorbing P12). The manifest may pin several versions of one
 *    package, each entry carrying its own `runtime.dshRuntimeVersion` range
 *    (the catalog compatibility window). For every installed bundle the
 *    candidate set is every entry of the same package name (a beta overlay
 *    wholly replaces the stable entries of a name it carries — the same
 *    per-name merge rule as the market catalog); an entry is a local
 *    candidate when its range accepts the DSH runtime version this desktop
 *    build pins ({@link DESKTOP_BOOT_DSH_RUNTIME_VERSION} — the same value
 *    the market install gate compares against, judged with the identical
 *    `satisfies` semantics). The installed version itself is still verified
 *    exactly as before — runtime ranges never gate what loads, only what is
 *    advertised:
 *
 *    - **Update available.** When the newest local candidate is newer than
 *      the installed version, that candidate is the update target: an
 *      allowed bundle carries `updateVersion` (the P10 prompt surface) and a
 *      missing installed entry classifies `not-pinned-newer-pinned` against
 *      it. The old single-pin `.find(name)` classification always picked the
 *      first (lowest) same-name entry, so a mixed fleet was told to update
 *      to versions its runtime cannot even install; the code and the prompt
 *      semantics are unchanged, only the target is now chosen by
 *      runtime-compatibility and maximum version.
 *    - **Deferred window (`client-update-required`).** When the installed
 *      version's entry has left the manifest and no same-name entry accepts
 *      the local runtime (only other runtime lines remain), the machine
 *      cannot update until the desktop client upgrades. Refusing the
 *      installed bundle here would brick every mixed-fleet machine for
 *      wanting nothing — so the bundle is NOT refused: it loads enforced by
 *      the market install receipt's `treeDigest` (the receipt-anchored
 *      comparison of step 4 — measured tree must equal `receipt.rootDigest`,
 *      the exact same code path, never a second verifier). The trust
 *      semantics are deliberately narrower than a live manifest entry: the
 *      bytes were verified (signature, integrity, tree digest) by the
 *      manifest that allowed the original install, and the receipt records
 *      that decision; without a usable receipt the deferral fails closed
 *      with the `client-update-required` rejection. The decision lists the
 *      bundle in `deferredUpdates` (package name, waiting version, required
 *      runtime) so telemetry and the P10 prompt can say "upgrade the client
 *      to update this plugin". Two refusals still bite: a `revoked:true`
 *      entry of the package is a security kill the deferral never forgives,
 *      and a tampered installed tree fails the receipt comparison exactly
 *      like step 4.
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

import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMap, parseDocument } from 'yaml'
import { compare, satisfies } from 'semver'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  type CompanyManifestTrustRoot,
  type CompanyManifestVerificationCode,
  type MarketInstallReceipt,
} from 'dsh-community-market'
import { fetchCompanyManifestText } from './company-manifest-origin.ts'
import type { DesktopBetaChannelOverlay } from './beta-channel.ts'
import {
  COMPANY_TARBALL_MAX_BYTES,
  DESKTOP_MARKET_IDENTITIES,
  findDesktopCompanyManifestPackageWithBeta,
  type DesktopCompanyManifestPackage,
  verifyDesktopCompanyManifest,
  type DesktopCompanyManifest,
} from './desktop-market.ts'
import {
  DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY,
  desktopMarketFileSpecPosixPath,
  desktopMarketTarballStagingName,
  desktopMarketTarballStagingPath,
} from './pnpm.ts'
import { desktopPluginBundleMutable } from './desktop-plugins.ts'
import { resolveOverlayPackage } from './package-overlay.ts'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import type { DesktopPolicy } from './desktop-policy.ts'

/** Lowercase hex SHA-256 shape shared by root digests and trust-root fingerprints. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u
/** Read bound for one profile lockfile, mirroring the market install path. */
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024

/**
 * The DSH runtime version this desktop build pins (P15 phase 1) — the same
 * value the market install gate compares plugin ranges against
 * (`DSH_RUNTIME_VERSION` in `dsh-community-market/src/install/service.ts`).
 * The two are one pin in two places, and their equality is enforced
 * mechanically by `scripts/dsh-runtime-version-parity.test.mjs`
 * (`yarn check:layout` — see dev-log/2026-09-08-dshmarket-1.17.1-compat-012.md
 * for the release discipline); a runtime bump updates both in the same
 * change or CI goes red. The install gate re-checks every install against
 * its own copy, so a drift here can only mis-classify update prompts —
 * never what loads. Injectable through
 * {@link DesktopBootVerificationOptions.dshRuntimeVersion} so tests can
 * simulate mixed-fleet machines on older runtimes.
 */
export const DESKTOP_BOOT_DSH_RUNTIME_VERSION = '0.1.2-rc.1'

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
  /**
   * Pointed repair reason set when the lockfile pins this bundle through the
   * controlled tarball channel but that pin no longer verifies (the staged
   * tarball is gone or no longer hashes to the pinned sha512); undefined
   * otherwise. Only read when {@link lockIntegrity} is undefined.
   */
  readonly lockProblem?: string
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
   * (a lower sequence is stale; an equal one replays). Defaults to the
   * highest receipt sequence joined with the market's persisted STABLE scan
   * ratchet (review P2; per-channel since review P3 — the beta channel's
   * ratchet never raises this stable floor), so the same embedded manifest
   * that allowed an install re-verifies at boot while anything older is
   * stale — and a legitimate receipt clear (a fresh-profile swap) cannot
   * reset the floor to zero.
   */
  readonly lastSeenSequence?: number
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Installed-tree measurement override for focused tests and the persisted
   * fingerprint cache (see {@link createCachedDesktopBootTreeRootDigestMeasure});
   * defaults to the full synchronous measurement. Receives the anchor the
   * measurement serves so cache-backed implementations can bypass the cache
   * for {@link DesktopBootTreeMeasurePurpose} `'signed-tree'`.
   */
  readonly measureTreeRootDigest?: (packageDir: string, purpose: DesktopBootTreeMeasurePurpose) => string
  /**
   * Verified, roster-admitted beta entries (P9): the host resolves the beta
   * manifest next to the stable fetch (same trust roots, the signed
   * `testers` roster already matched against the local SSO identity), and
   * boot verification consults them for a `name@version` the stable
   * manifest does not pin — a tester's installed beta plugin must not be
   * rejected by the very manifest that allowed its install. The beta
   * sequence must not regress below the verified stable sequence (a stale
   * overlay is ignored); the stable manifest stays the boot's identity, so
   * `manifestSequence`/`keyId` in the decision keep tracking stable.
   */
  readonly betaPackages?: readonly DesktopCompanyManifestPackage[]
  /** Sequence of the beta manifest {@link DesktopBootVerificationOptions.betaPackages} came from. */
  readonly betaSequence?: number
}

export interface DesktopBootVerificationOptions {
  /** Policy-pinned signing keys; a manifest signed by any listed key verifies. */
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  /**
   * Origin every tarball `source.url` must live on (`policy.companyCatalogOrigin`).
   * Omitted behaves like `null` (content mode): a `source`-carrying manifest
   * is rejected whole — exactly what the field-unaware verifier did — because
   * without a pinned origin there is no host the desktop would download a
   * plugin tarball from. Manifests without `source` verify identically either
   * way (byte-for-byte the field-unaware decisions).
   */
  readonly companyCatalogOrigin?: string | null
  /** Receipts keyed by exact (packageName, version); unusable receipts are ignored. */
  readonly receipts?: readonly DesktopBootReceipt[]
  /** Anti-rollback floor; see {@link DesktopBootVerificationInputs.lastSeenSequence}. */
  readonly lastSeenSequence?: number
  /** Clock injection for manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /** Installed-tree measurement override for focused tests; see {@link DesktopBootVerificationInputs.measureTreeRootDigest}. */
  readonly measureTreeRootDigest?: (packageDir: string, purpose: DesktopBootTreeMeasurePurpose) => string
  /** Verified, roster-admitted beta entries; see {@link DesktopBootVerificationInputs.betaPackages}. */
  readonly betaPackages?: readonly DesktopCompanyManifestPackage[]
  /** Sequence of the beta manifest the beta entries came from. */
  readonly betaSequence?: number
  /**
   * DSH runtime version the update classification evaluates ranges against
   * (P15); defaults to {@link DESKTOP_BOOT_DSH_RUNTIME_VERSION}, the value
   * pinned at build time and shared with the market install gate. The value
   * never gates what loads — only update targets and the deferred
   * `client-update-required` window.
   */
  readonly dshRuntimeVersion?: string
}

/** How much evidence allowed a bundle to load. */
export type DesktopBootEvidence = 'receipt' | 'manifest-only' | 'signed-tree'

/**
 * Which boot anchor one installed-tree measurement serves: `'signed-tree'`
 * for entries whose signed `treeDigest` is the authoritative expectation,
 * `'receipt'` for the receipt-anchored comparison. The persisted
 * stat-fingerprint cache serves `'receipt'` only — authority measurements
 * must always read the tree contents (see
 * {@link createCachedDesktopBootTreeRootDigestMeasure}).
 */
export type DesktopBootTreeMeasurePurpose = 'signed-tree' | 'receipt'

/** One bundle cleared for this boot. */
export interface DesktopBootAllowedBundle {
  readonly packageName: string
  readonly evidence: DesktopBootEvidence
  /** Sequence of the verified manifest that allowed this boot decision. */
  readonly manifestSequence: number
  /** keyId of the trust root that verified the manifest for this boot. */
  readonly keyId: string
  /**
   * Update target (P15): the newest manifest entry of this package whose
   * `runtime.dshRuntimeVersion` accepts this build and whose version is
   * newer than the installed one. Present only on allowed bundles — the
   * same fact on a refused bundle is the `not-pinned-newer-pinned`
   * classification — and never set for deferred (`client-update-required`)
   * loads, whose waiting update needs a client upgrade instead (see
   * {@link DesktopBootVerification.deferredUpdates}).
   */
  readonly updateVersion?: string
  /** Installed version; always present when {@link updateVersion} is (the prompt's from→to pair). */
  readonly installedVersion?: string
}

/**
 * Structured classification of one boot rejection (P10). The update prompt
 * consumes exactly `'not-pinned-newer-pinned'` (class a: the signed company
 * manifest pins a version other than the installed one, so a newer
 * publication is waiting); every other code stays log-only. `'client-update-required'` (P15, absorbing P12) is the deferred-window code:
 * the installed version left the manifest's runtime compatibility window
 * and only other runtime lines remain — the bundle defers onto its install
 * receipt instead of refusing, and the code rides a rejection only when
 * that deferral fails closed (no usable receipt). The code is pure metadata
 * beside the unchanged reason strings — no rejection decision reads it
 * back, and branches without an explicit classification fall back to
 * `'other'` so a rejected entry always carries a code.
 */
export type DesktopBootRejectionCode =
  | 'not-pinned-newer-pinned'
  | 'not-in-manifest'
  | 'revoked'
  | 'integrity-mismatch'
  | 'tree-mismatch'
  | 'unresolved'
  | 'no-lock-integrity'
  | 'client-update-required'
  | 'other'

/** One bundle refused for this boot, with the first failing check as the reason. */
export interface DesktopBootRejectedBundle {
  readonly packageName: string
  readonly reason: string
  /** Classification of {@link reason}; unclassified branches fall back to `'other'`. */
  readonly code: DesktopBootRejectionCode
  /** Installed version of the refused bundle; class-a entries always carry it. */
  readonly installedVersion?: string
  /** Version the signed company manifest pins; class-a entries always carry it. */
  readonly pinnedVersion?: string
}

/**
 * One deferred update of a `client-update-required` bundle (P15, absorbing
 * P12): the installed version loaded on its install receipt because the
 * manifest only pins versions for other DSH runtime lines. The waiting
 * update becomes installable after the desktop client upgrades — that
 * fact, not the bundle itself, is what the P10 prompt and the boot_verify
 * telemetry surface.
 */
export interface DesktopBootDeferredUpdate {
  readonly packageName: string
  /** Version still installed and loaded on receipt evidence. */
  readonly installedVersion: string
  /** Newest manifest version of the package (the waiting update). */
  readonly availableVersion: string
  /** `runtime.dshRuntimeVersion` range of {@link availableVersion}'s entry. */
  readonly requiredRuntime: string
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
  /**
   * Deferred `client-update-required` bundles of this boot (P15): loaded on
   * receipt evidence while their update waits on a desktop client upgrade.
   * Present only when at least one bundle deferred — a healthy boot carries
   * no key (the same optional-field discipline as the per-entry versions).
   */
  readonly deferredUpdates?: readonly DesktopBootDeferredUpdate[]
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
 * Security positioning, stated honestly: the cache file lives in
 * user-writable `<userData>`, and a hit returns the recorded digest instead
 * of reading the tree contents — so a forged cache entry can present any
 * digest as a "measurement". The cache therefore serves receipt-mode
 * entries only (purpose `'receipt'`, including the omitted-purpose default
 * of direct callers): there the comparison target is the equally
 * user-writable receipt, so the cache only accelerates a comparison between
 * two user-writable values and cannot weaken a signed expectation. Authority
 * entries (purpose `'signed-tree'`) bypass the cache entirely — no read, no
 * write — and always get the full content measurement, because trusting a
 * recorded digest there would let a tampered tree boot forever after one
 * forged cache line. A removed or damaged cache file only costs a full
 * re-measurement.
 */
export function createCachedDesktopBootTreeRootDigestMeasure(
  cachePath: string,
  options: CachedBootTreeDigestMeasureOptions = {},
): (packageDir: string, purpose?: DesktopBootTreeMeasurePurpose) => string {
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
  return (packageDir, purpose = 'receipt') => {
    if (purpose === 'signed-tree') {
      // Authority entries never touch the user-writable cache: the signed
      // treeDigest is the expectation and only a full content measurement
      // may answer for the disk tree. The cache is neither read nor updated
      // on this path.
      return measure(packageDir)
    }
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
 * Read the market's persisted anti-rollback ratchet — the highest manifest
 * sequence its own catalog scans verified (`companyManifest.sequence` in the
 * same settings document the receipts live in) — as a boot floor candidate.
 *
 * Review P2: the receipt-derived floor alone drops to zero whenever the
 * ledger is legitimately cleared (a fresh-profile swap clears every receipt
 * of the rebuilt profile), while the market's scan ratchet survives that
 * clear in the same user-writable document. A well-formed record pins a
 * sequence a full market verification observed under the same trust roots,
 * so it is exactly as strong a floor as a receipt. Anything else — a
 * missing document, a missing record, a malformed or non-integer sequence —
 * contributes nothing (the floor falls back to the receipts alone, never
 * fails the boot): this reader cannot refuse a startup either, and deleting
 * the record is no worse than the already-signed-off user-writable-ratchet
 * residual (R3).
 */
export function marketManifestSequenceRatchetFromSettings(settingsPath: string): number | undefined {
  try {
    const body = readFileSync(settingsPath)
    if (body.byteLength > MAX_MARKET_SETTINGS_BYTES) return undefined
    const parsed = parseDocument(body.toString('utf8'), { prettyErrors: true })
    if (parsed.errors.length > 0) return undefined
    const sequence = record(record(record(parsed.toJS() ?? {})?.[MARKET_SETTINGS_NAMESPACE])?.companyManifest)?.sequence
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return undefined
    return sequence as number
  } catch {
    return undefined
  }
}

/** Settings key of the per-channel ratchet split inside the market namespace. */
const MARKET_MANIFEST_CHANNELS_KEY = 'companyManifestChannels'

/**
 * Per-channel anti-rollback ratchets derived from the shared market settings
 * document (review P3 — the floor that gated a stable staged manifest must
 * never be raised by the beta channel's publications).
 *
 * `stable` is the high-water mark of what the STABLE catalog channel reached
 * on this machine; `beta` is the same for the beta overlay channel. Each
 * verification path compares bytes against its own channel's floor only —
 * stable staged bytes against `stable`, the beta hand-off against `beta` —
 * because the two channels share one publishing sequence space but not one
 * publication cadence: a beta overlay at 29 with stable still at 27 is the
 * normal tester steady state, and comparing stable's 27 against a
 * beta-raised 29 denied every gated install until stable caught up.
 */
export interface DesktopMarketManifestChannelRatchets {
  readonly stable: number | undefined
  readonly beta: number | undefined
}

/** Read one channel value of the persisted per-channel ratchet record; malformed values contribute nothing. */
function channelRatchetValue(channels: unknown, channel: 'stable' | 'beta'): number | undefined {
  const sequence = record(channels)?.[channel]
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return undefined
  return sequence as number
}

/**
 * Read the per-channel anti-rollback ratchets, migrating the legacy single
 * value on the fly (review P3).
 *
 * Persistence layout in the shared market settings document: the market
 * provider keeps writing its stable-channel scan ratchet where it always
 * did (`companyManifest.sequence` — that writer records only the sequence of
 * the STABLE manifest a full market verification observed), and this desktop
 * owns one new record, `companyManifestChannels: { stable?, beta? }`. The
 * desktop writes only the `beta` entry (after a beta overlay verifies); the
 * `stable` entry exists so a reader never needs the migration guess below
 * once an explicit split value is present, but no desktop writer ever lowers
 * or duplicates the market's stable record into it.
 *
 * Migration from a document that still carries only the legacy single value
 * is explicit and per the fail-closed invariants: neither channel's floor
 * may ever decrease.
 *
 * - `betaRatchet = existingRatchet` when beta was ever applied, else the
 *   stable value. The only durable evidence that beta was ever applied is
 *   the desktop-written `companyManifestChannels.beta` record itself; a
 *   legacy-only document predates the split, so its fallback is the else
 *   branch and the beta floor starts at the stable mark — exactly the
 *   online rule every beta consumer already enforces (a beta publication
 *   must ride at or above the verified stable sequence).
 * - `stableRatchet = min(existingRatchet, currentAppliedStableSequence)`,
 *   applied ONLY when beta evidence exists. Lowering stable's floor to the
 *   true stable high-water mark does not weaken anti-rollback: the stable
 *   floor defends signed-stable-manifest replay, and a value above every
 *   stable-channel observation on a machine that durably applied beta was
 *   never legitimately reached by the stable channel — the shared writer
 *   could have been the beta overlay. Clamping to the provable stable mark
 *   (the highest install-receipt sequence, each receipt copying the stable
 *   verification evidence that allowed its install) restores the
 *   channel-correct bound instead of weakening it. Without beta evidence
 *   the legacy value is pure stable history and is kept intact, so no
 *   machine's floor decreases through the migration (a stable-only machine
 *   whose scans ran ahead of its installs keeps the scan ratchet).
 *
 * Anything malformed contributes nothing per channel (the floor falls back
 * per channel, never fails the boot); this reader cannot refuse a startup.
 */
export function marketManifestChannelRatchetsFromSettings(
  settingsPath: string,
): DesktopMarketManifestChannelRatchets {
  let document: unknown
  try {
    const body = readFileSync(settingsPath)
    if (body.byteLength > MAX_MARKET_SETTINGS_BYTES) return { stable: undefined, beta: undefined }
    const parsed = parseDocument(body.toString('utf8'), { prettyErrors: true })
    if (parsed.errors.length > 0) return { stable: undefined, beta: undefined }
    document = parsed.toJS() ?? {}
  } catch {
    return { stable: undefined, beta: undefined }
  }
  const marketNamespace = record(document)?.[MARKET_SETTINGS_NAMESPACE]
  const splitStable = channelRatchetValue(record(marketNamespace)?.[MARKET_MANIFEST_CHANNELS_KEY], 'stable')
  const splitBeta = channelRatchetValue(record(marketNamespace)?.[MARKET_MANIFEST_CHANNELS_KEY], 'beta')
  const legacySequence = record(record(marketNamespace)?.companyManifest)?.sequence
  const legacy = Number.isSafeInteger(legacySequence) && (legacySequence as number) >= 1
    ? legacySequence as number
    : undefined
  if (legacy === undefined) {
    // No legacy ratchet: the split record alone speaks, per channel.
    return { stable: splitStable, beta: splitBeta }
  }
  // "Beta was ever applied" — the only durable, channel-attributed evidence
  // this host can write. A legacy-only document takes the else branch.
  const betaEverApplied = splitBeta !== undefined
  const currentAppliedStableSequence = receiptSequenceFloor(
    desktopBootReceipts(marketInstallReceiptsFromSettingsDocument(document)),
  )
  const stableRatchet = splitStable ?? (betaEverApplied
    ? Math.min(legacy, currentAppliedStableSequence > 0 ? currentAppliedStableSequence : legacy)
    : legacy)
  const betaRatchet = splitBeta ?? (betaEverApplied ? legacy : stableRatchet)
  return { stable: stableRatchet, beta: betaRatchet }
}

/**
 * Raise the persisted beta-channel ratchet (review P3). Never lowers: the
 * write is `max(recorded, sequence)`, so neither channel's floor can regress
 * through normal operation. The edit is the same YAML-AST, locked,
 * atomically-committed discipline the receipts ledger clear uses
 * (`fresh-profile.ts`): comments and every sibling record — the market
 * provider's own `companyManifest` stable ratchet included — survive the
 * round trip, and a concurrent writer's value cannot be lost to the rename.
 *
 * @throws on an unreadable, oversized, or unparseable document, or when the
 * existing `companyManifestChannels` record is not a map — the caller decides
 * whether that failure is loud (a write path may) and never lets it fail the
 * operation the ratchet serves.
 */
export async function raiseMarketBetaManifestRatchet(settingsPath: string, sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('the beta manifest ratchet sequence must be a safe positive integer')
  }
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 })
  await withFileLock(settingsPath, async () => {
    let text: string
    try {
      text = readFileSync(settingsPath, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      text = ''
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_MARKET_SETTINGS_BYTES) {
      throw new Error(`settings document ${settingsPath} exceeds ${String(MAX_MARKET_SETTINGS_BYTES)} bytes`)
    }
    const document = parseDocument(text.length === 0 ? '{}' : text, { prettyErrors: true })
    if (document.errors.length > 0) {
      throw new Error(`settings document ${settingsPath} is not parseable YAML`)
    }
    const channels = document.getIn([MARKET_SETTINGS_NAMESPACE, MARKET_MANIFEST_CHANNELS_KEY], true)
    if (!isMap(channels)) {
      // Absent, null, or a shapeless non-map where the per-channel record
      // should be: (re)create the map. A malformed previous value can never
      // lower a floor — the write below still records `sequence`, which the
      // verification that called this just observed as a valid one.
      document.setIn([MARKET_SETTINGS_NAMESPACE, MARKET_MANIFEST_CHANNELS_KEY], document.createNode({}))
    }
    const existing = document.getIn([MARKET_SETTINGS_NAMESPACE, MARKET_MANIFEST_CHANNELS_KEY, 'beta'])
    // Never lower: a sequence at or above the recorded one is the replay
    // steady state (nothing to persist), and only a strictly newer beta
    // publication raises the ratchet.
    if (typeof existing === 'number' && Number.isSafeInteger(existing) && existing >= sequence) return
    document.setIn([MARKET_SETTINGS_NAMESPACE, MARKET_MANIFEST_CHANNELS_KEY, 'beta'], sequence)
    await writeFileAtomic(settingsPath, document.toString(), { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Assemble the settings-derived slice of the production inputs for a locked
 * boot: normalized install receipts from the shared market settings document,
 * plus the embedded manifest bytes for content-mode policies. Origin-mode
 * policies contribute no bytes here — the async {@link desktopBootVerificationInputs}
 * adds the one pre-composition fetch. The sequence floor joins the highest
 * receipt sequence with the market's persisted stable-channel scan ratchet
 * (review P2; per-channel since review P3), so a
 * legitimate receipt clear — a fresh-profile swap — cannot reset the
 * anti-rollback floor to zero.
 */
export function desktopBootVerificationInputsFromSettings(
  policy: Pick<DesktopPolicy, 'companyCatalogOrigin' | 'companyManifestUrl'>,
  settingsDocumentPath: string,
  moduleUrl: string = import.meta.url,
): DesktopBootVerificationInputs {
  const manifestBytes = policy.companyCatalogOrigin !== null
    ? undefined
    : readCompanyManifestAsset(companyManifestAssetPath(policy.companyManifestUrl, moduleUrl))
  const receipts = readDesktopBootReceiptsFromSettings(settingsDocumentPath)
  // Review P3: the boot's stable-manifest floor joins the receipts with the
  // STABLE channel's ratchet only — the beta channel's high-water mark (which
  // legitimately runs ahead of stable on tester machines) must never deny the
  // stable bytes boot verification is about to check.
  const ratchet = marketManifestChannelRatchetsFromSettings(settingsDocumentPath).stable
  const receiptFloor = receiptSequenceFloor(receipts)
  const lastSeenSequence = Math.max(receiptFloor, ratchet ?? 0)
  return {
    receipts,
    ...(lastSeenSequence > 0 ? { lastSeenSequence } : {}),
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
  readonly measureTreeRootDigest?: (packageDir: string, purpose: DesktopBootTreeMeasurePurpose) => string
  /**
   * Pre-resolved beta overlay (P9): the host resolves it concurrently with
   * the stable fetch (same SSO session, same trust roots) and passes the
   * result through to {@link verifyDesktopBootBundles}; `undefined` (the
   * default, and the value for every non-roster machine) keeps boot
   * verification on the stable manifest alone.
   */
  readonly betaOverlay?: DesktopBetaChannelOverlay
}

/**
 * Assemble the production inputs for a locked boot (L2): the settings-derived
 * receipts and content-mode asset bytes of
 * {@link desktopBootVerificationInputsFromSettings}, plus the origin-mode
 * manifest fetch profile composition itself must never perform. The fetch
 * runs once, before composition; any failure leaves the bytes unset so boot
 * verification fails closed for third-party content while the upstream
 * client keeps booting. The sequence floor is assembled by
 * {@link desktopBootVerificationInputsFromSettings}: the highest receipt
 * sequence joined with the market's persisted scan ratchet.
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
    ...(options.betaOverlay === undefined ? {} : {
      betaPackages: options.betaOverlay.packages,
      betaSequence: options.betaOverlay.sequence,
    }),
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

/** Standard base64 SHA-512 integrity spelling the catalog and lockfile pin. */
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u

/** Options of {@link desktopBootLockIntegrity}. */
export interface DesktopBootLockIntegrityOptions {
  /**
   * Active profile directory. When present, a controlled-tarball `file:`
   * specifier must equal the exact deterministic staging path inside this
   * directory; without it the specifier is matched structurally (absolute,
   * inside the staging directory, exact deterministic file name).
   */
  readonly profileDir?: string
}

/**
 * Resolve the npm dist integrity the profile lockfile pins for one exact
 * (packageName, version), mirroring the reader of the market install path:
 * the root importer must declare the exact specifier and resolution, and the
 * matching package entry must carry the signed resolution integrity.
 * Returns undefined whenever any link of that chain is absent.
 *
 * Controlled-tarball pins (P7 2c): a dependency the market UI installed
 * through the tarball channel records pnpm's `file:` form — the specifier is
 * `file:<deterministic staged path>` for this exact (packageName, version)
 * and the package entry `name@file:…` pins the sha512 of the tarball bytes,
 * which is exactly the manifest's signed `integrity`. The semantics of a
 * recognized pin are therefore "installed by the controlled tarball channel,
 * the staged file is still there, and it still hashes to the pinned sha512":
 * the staged file is re-hashed synchronously here, so a GC'd, deleted, or
 * tampered staged tarball fails this step exactly like a diverging registry
 * pin — the bundle is rejected by name while the rest of the boot continues.
 */
export function desktopBootLockIntegrity(
  lockfile: UnknownRecord,
  packageName: string,
  version: string,
  options: DesktopBootLockIntegrityOptions = {},
): string | undefined {
  const importer = record(record(lockfile.importers)?.['.'])
  const dependencies = record(importer?.dependencies)
  const dependency = dependencies !== undefined && own(dependencies, packageName)
    ? record(dependencies[packageName])
    : undefined
  if (dependency === undefined) return undefined
  if (dependency.specifier === version && exactLockResolution(dependency.version, version)) {
    const resolvedVersion = dependency.version
    const baseKey = `${packageName}@${version}`
    const resolvedKey = `${packageName}@${resolvedVersion}`
    const packageKeys = [...new Set([baseKey, `/${baseKey}`, resolvedKey, `/${resolvedKey}`])]
    const packages = record(lockfile.packages) ?? {}
    const resolution = record(lockEntry(packages, packageKeys)?.resolution)
    return typeof resolution?.integrity === 'string' ? resolution.integrity : undefined
  }
  return desktopBootTarballLockIntegrity(lockfile, dependency, packageName, version, options)
}

/** The staged path a controlled-tarball `file:` specifier must pin for this exact package version, or undefined. */
function controlledTarballSpecifierStagedPath(
  specifier: unknown,
  packageName: string,
  version: string,
  profileDir: string | undefined,
): string | undefined {
  if (typeof specifier !== 'string' || !specifier.startsWith('file:')) return undefined
  // Real pnpm preserves the absolute specifier's native platform separators
  // (Windows `\`) while the lockfile-relative spellings are portable, so the
  // comparison runs in one separator-normalized form: the same staged path
  // written with either separator is the same recognized pin, and the
  // normalization cannot make a path outside the deterministic staging
  // location match it.
  const stagedPath = desktopMarketFileSpecPosixPath(specifier.slice('file:'.length))
  try {
    // With the profile directory the pin must be the exact deterministic
    // staging path inside it; without one (direct unit use) the structural
    // shape — absolute, inside the staging directory, exact deterministic
    // file name for this (packageName, version) — still has to match.
    if (profileDir !== undefined) {
      const expected = desktopMarketFileSpecPosixPath(
        desktopMarketTarballStagingPath(profileDir, packageName, version),
      )
      return stagedPath === expected ? stagedPath : undefined
    }
    if (!isAbsolute(stagedPath) || basename(dirname(stagedPath)) !== DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY) {
      return undefined
    }
    return basename(stagedPath) === desktopMarketTarballStagingName(packageName, version) ? stagedPath : undefined
  } catch {
    return undefined
  }
}

/** Root-importer dependency record of one package, if the lockfile pins it at all. */
function lockfileDependency(lockfile: UnknownRecord, packageName: string): UnknownRecord | undefined {
  const importer = record(record(lockfile.importers)?.['.'])
  const dependencies = record(importer?.dependencies)
  return dependencies !== undefined && own(dependencies, packageName)
    ? record(dependencies[packageName])
    : undefined
}

/**
 * Synchronously hash the staged tarball through a private descriptor opened
 * without following symlinks — the same read discipline the staging keepalive
 * uses (desktop-market.ts). An absent path, a planted symlink, or a
 * non-regular, empty, or oversized file yields undefined: not intact. Any
 * other open/read failure is not "intact" either for boot purposes — the
 * bytes cannot be proven, and the bundle fails this step by name instead of
 * bricking the whole startup.
 */
function sha512OfStagedTarball(path: string): Buffer | undefined {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size <= 0 || info.size > COMPANY_TARBALL_MAX_BYTES) return undefined
    const hash = createHash('sha512')
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let read: number
    while ((read = readSync(descriptor, chunk, 0, chunk.byteLength, null)) > 0) {
      hash.update(chunk.subarray(0, read))
    }
    return hash.digest()
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/**
 * The lock-integrity decision for one controlled-tarball `file:` pin: the
 * specifier must be the deterministic staged path of this exact (packageName,
 * version), the package entry `name@file:…` must pin a well-formed sha512,
 * the pnpm-relative resolution spelling must point back at the same staged
 * file, and the staged file must still hash to that pinned value. Returns the
 * pinned integrity (the value the signed manifest entry must carry) or
 * undefined.
 */
function desktopBootTarballLockIntegrity(
  lockfile: UnknownRecord,
  dependency: UnknownRecord,
  packageName: string,
  version: string,
  options: DesktopBootLockIntegrityOptions,
): string | undefined {
  const stagedPath = controlledTarballSpecifierStagedPath(dependency.specifier, packageName, version, options.profileDir)
  if (stagedPath === undefined) return undefined
  const resolvedSpelling = typeof dependency.version === 'string' ? dependency.version : undefined
  if (resolvedSpelling === undefined || !resolvedSpelling.startsWith('file:')) return undefined
  // When the profile tree already pins resolvable peers, pnpm records the
  // peer resolution as a `(@peer@version, …)` suffix on the importer's
  // `file:` version while the staged spelling stays bare — the same drift
  // the registry channel tolerates through `exactLockResolution` and the
  // market install path already fixed (32bfaf522d). The suffix always ends
  // the string with `)` and can never be part of the deterministic staged
  // name (safe package names and versions exclude parentheses), so any
  // spelling containing `(` truncates at the first `(` — identical to the
  // market install path's indexOf('(') — and every other spelling is its
  // own bare form.
  const bareSpelling = resolvedSpelling.includes('(')
    ? resolvedSpelling.slice(0, resolvedSpelling.indexOf('('))
    : resolvedSpelling
  // The pnpm-relative resolution spelling points back at the same staged
  // file; it is resolved in the normalized form so a native-separator
  // spelling still lands on the normalized staged path above.
  if (options.profileDir !== undefined
    && desktopMarketFileSpecPosixPath(
      resolve(options.profileDir, desktopMarketFileSpecPosixPath(bareSpelling.slice('file:'.length))),
    ) !== stagedPath) {
    return undefined
  }
  const packages = record(lockfile.packages) ?? {}
  // The packages section keys the bare spelling while a hypothetical future
  // pnpm could keep the suffixed one, so both are probed; whichever entry
  // answers, the sha512 below still binds the exact staged bytes.
  const fileKeys = [...new Set([`${packageName}@${bareSpelling}`, `${packageName}@${resolvedSpelling}`])]
  const integrity = record(lockEntry(packages, fileKeys)?.resolution)?.integrity
  if (typeof integrity !== 'string' || !SHA512_INTEGRITY_PATTERN.test(integrity)) return undefined
  const digest = sha512OfStagedTarball(stagedPath)
  if (digest === undefined) return undefined
  const expected = Buffer.from(integrity.slice('sha512-'.length), 'base64')
  if (digest.byteLength !== expected.byteLength || !timingSafeEqual(digest, expected)) return undefined
  return integrity
}

/**
 * Pointed repair reason for one bundle whose controlled-tarball pin no longer
 * verifies — the lockfile still pins the deterministic staged path of this
 * exact (packageName, version), but the full chain of {@link
 * desktopBootLockIntegrity} failed for it (typically the staged tarball was
 * deleted or no longer hashes to the pinned sha512). Undefined for every
 * other unpinned shape, which keeps the generic lockfile rejection reason.
 */
export function desktopBootControlledTarballPinProblem(
  lockfile: UnknownRecord,
  packageName: string,
  version: string,
  options: DesktopBootLockIntegrityOptions = {},
): string | undefined {
  const dependency = lockfileDependency(lockfile, packageName)
  if (dependency === undefined) return undefined
  const stagedPath = controlledTarballSpecifierStagedPath(dependency.specifier, packageName, version, options.profileDir)
  if (stagedPath === undefined) return undefined
  return `${packageName}@${version} was installed through the controlled company tarball channel, but its staged tarball ${stagedPath} is missing or no longer matches the sha512 pinned in the profile lockfile — reinstall the plugin from the company market (or uninstall it) to repair the profile`
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
 * as new as every recorded install. Verification treats the floor as a
 * lower bound (an equal sequence replays the same manifest, a lower one is
 * stale), so the floor is exactly the highest receipt sequence: the same
 * manifest that allowed an install re-verifies at boot, while anything
 * older than a manifest that already allowed an install is rejected.
 */
function receiptSequenceFloor(receipts: readonly DesktopBootReceipt[]): number {
  let highest = 0
  for (const receipt of receipts) {
    if (Number.isSafeInteger(receipt.manifestSequence) && receipt.manifestSequence > highest) {
      highest = receipt.manifestSequence
    }
  }
  return highest
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
      ? desktopBootLockIntegrity(lockfile, packageName, version, { profileDir })
      : undefined
    // A recognized controlled-tarball pin that no longer verifies gets the
    // pointed repair reason; every other unpinned shape keeps the generic
    // rejection text (see verifyDesktopBootBundles).
    const lockProblem = lockIntegrity === undefined && lockfile !== undefined && version !== undefined
      ? desktopBootControlledTarballPinProblem(lockfile, packageName, version, { profileDir })
      : undefined
    return {
      packageName,
      version,
      lockIntegrity,
      packageDir,
      ...(lockProblem === undefined ? {} : { lockProblem }),
    }
  })
}

/**
 * All signed entries the boot classification may consider for one package
 * name (P15): when a verified beta overlay carries the name, its entries
 * wholly replace the stable ones — the same per-name merge rule the market
 * catalog applies — with revocation sticky by name, so a stale beta
 * publication can never resurrect a package any stable entry revoked.
 */
function bootClassificationCandidates(
  manifest: DesktopCompanyManifest,
  betaPackages: readonly DesktopCompanyManifestPackage[] | undefined,
  packageName: string,
): readonly DesktopCompanyManifestPackage[] {
  const beta = betaPackages?.filter(entry => entry.packageName === packageName) ?? []
  if (beta.length === 0) {
    return manifest.packages.filter(entry => entry.packageName === packageName)
  }
  const stableRevoked = manifest.packages.some(
    entry => entry.packageName === packageName && entry.revoked === true,
  )
  return stableRevoked
    ? beta.map(entry => entry.revoked ? entry : { ...entry, revoked: true })
    : beta
}

/**
 * Whether one entry's signed `runtime.dshRuntimeVersion` range accepts the
 * given DSH runtime version — the exact comparator the market install gate
 * uses (`satisfies` with `includePrerelease`); a range the comparator
 * refuses is simply incompatible, never a boot failure.
 */
function entryAcceptsDshRuntime(entry: DesktopCompanyManifestPackage, runtimeVersion: string): boolean {
  try {
    return satisfies(runtimeVersion, entry.runtime.dshRuntimeVersion, { includePrerelease: true })
  } catch {
    return false
  }
}

/** `candidate > installed` under node-semver; an unparseable pair is "not newer" — the comparison is advisory, never an enforcement point. */
function semverNewer(candidate: string, installed: string): boolean {
  try {
    return compare(candidate, installed) > 0
  } catch {
    return false
  }
}

/** The entry with the highest version under node-semver (first wins ties); entry versions are schema-validated semver. */
function newestEntry(entries: readonly DesktopCompanyManifestPackage[]): DesktopCompanyManifestPackage | undefined {
  let newest: DesktopCompanyManifestPackage | undefined
  for (const entry of entries) {
    if (newest === undefined) {
      newest = entry
      continue
    }
    try {
      if (compare(entry.version, newest.version) > 0) newest = entry
    } catch {
      // A non-parsing version cannot outrank the current pick.
    }
  }
  return newest
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

  let verified: { readonly manifest: DesktopCompanyManifest; readonly keyId: string } | undefined
  let manifestFailure: DesktopBootManifestFailure | undefined
  if (manifestBytes === undefined) {
    manifestFailure = {
      code: 'manifest-missing',
      reason: 'no signed company manifest bytes are available for this boot',
    }
  } else {
    // The dual-channel verifier (P7): same canonical-byte, trust-root,
    // signature, sequence, and expiry decisions as the field-unaware market
    // verifier for `source`-free manifests, plus the one recognized
    // extension — entries may carry a signed `source` install channel. This
    // switch is what makes a build "field-aware" for the fleet publication
    // gate (see the dual-channel section of desktop-market.ts): before it,
    // boot verification rejected any `source`-carrying manifest whole.
    const verification = verifyDesktopCompanyManifest(manifestBytes, {
      trustRoots: options.trustRoots,
      companyCatalogOrigin: options.companyCatalogOrigin ?? null,
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
      // No per-bundle check ran, so there is no per-bundle classification;
      // these rejections are the manifest-level failure and fall back to
      // 'other' (never the update prompt: an untrusted manifest must not
      // look like "a newer version is waiting").
      rejected: uniqueBundles.map(bundle => ({ packageName: bundle.packageName, reason, code: 'other' })),
    }
  }

  const { manifest, keyId } = verified
  // Beta overlay floor (P9): a beta sequence below the verified stable
  // sequence is a stale publication — ignore the overlay entirely rather
  // than letting an older beta view of the catalog shadow a newer stable
  // one. An overlay at or above stable rides only the per-entry lookup.
  const betaPackages = options.betaPackages !== undefined
    && Number.isSafeInteger(options.betaSequence)
    && (options.betaSequence as number) >= manifest.sequence
    ? options.betaPackages
    : undefined
  const measure: (packageDir: string, purpose: DesktopBootTreeMeasurePurpose) => string =
    options.measureTreeRootDigest ?? computeDesktopBootTreeRootDigest
  // The DSH runtime version the update classification evaluates against
  // (P15): the build's pinned value unless a test simulates another
  // mixed-fleet machine. It never gates what loads — only update targets
  // and the deferred client-update window.
  const dshRuntimeVersion = options.dshRuntimeVersion ?? DESKTOP_BOOT_DSH_RUNTIME_VERSION
  const allowed: DesktopBootAllowedBundle[] = []
  const rejected: DesktopBootRejectedBundle[] = []
  const deferredUpdates: DesktopBootDeferredUpdate[] = []
  for (const bundle of uniqueBundles) {
    // Every rejected entry carries a classification: branches that pass no
    // code fall back to 'other', so a future rejection branch can never
    // produce an unclassified entry (the P10 completeness guarantee).
    const reject = (
      reason: string,
      code: DesktopBootRejectionCode = 'other',
      versions?: { readonly installedVersion?: string; readonly pinnedVersion?: string },
    ): void => {
      rejected.push({
        packageName: bundle.packageName,
        reason,
        code,
        ...(versions === undefined ? {} : versions),
      })
    }
    if (bundle.packageDir === undefined || bundle.version === undefined) {
      reject(`${bundle.packageName} cannot be resolved as an installed package in the active profile`, 'unresolved')
      continue
    }
    const entry = findDesktopCompanyManifestPackageWithBeta(manifest, betaPackages, bundle.packageName, bundle.version)
    // Runtime-aware update classification (P15): the candidates are every
    // same-name entry (beta wholly replacing stable for a carried name),
    // narrowed to the ones this build's runtime may install — and to entries
    // that are not revoked, because the market install gate refuses a
    // revoked pin, so advertising one would prompt an update the gate must
    // then reject (the P15 phase 1 review dead-loop). The update target is
    // the newest of what survives. The installed version's own checks below
    // are untouched — a runtime range never decides what loads — and the
    // deferred-window revocation kill below still reads the full candidate
    // set, so the security refusal keeps biting.
    const candidates = bootClassificationCandidates(manifest, betaPackages, bundle.packageName)
    const runtimeCandidates = candidates.filter(candidate =>
      !candidate.revoked && entryAcceptsDshRuntime(candidate, dshRuntimeVersion))
    const updateTarget = newestEntry(runtimeCandidates)
    const updateVersion = updateTarget !== undefined && semverNewer(updateTarget.version, bundle.version)
      ? updateTarget.version
      : undefined
    if (entry === undefined) {
      if (candidates.length === 0) {
        reject(`${bundle.packageName}@${bundle.version} is not in the signed company manifest`, 'not-in-manifest')
        continue
      }
      const revokedCandidate = candidates.find(candidate => candidate.revoked)
      const pinned = updateTarget
      if (pinned !== undefined) {
        // Class a (update available): the manifest pins this package at
        // another version this machine's runtime can install — for a
        // market-managed install always a newer publication, because
        // install authority only ever allows the pinned version. P15 keeps
        // the class and its prompt semantics; the target is now the newest
        // live runtime-compatible pin instead of the first same-name entry.
        reject(
          `the signed company manifest pins ${bundle.packageName}@${pinned.version}, but ${bundle.version} is installed`,
          'not-pinned-newer-pinned',
          { installedVersion: bundle.version, pinnedVersion: pinned.version },
        )
        continue
      }
      // Deferred window (P15, absorbing P12): the installed version left
      // the manifest and every remaining same-name pin needs a different
      // DSH runtime line, so this machine cannot update until the desktop
      // client upgrades. Refusing here would brick mixed-fleet machines for
      // wanting nothing, so the bundle defers onto its install receipt —
      // the same receipt-anchored comparison of step 4, never a second
      // verifier. Two refusals still bite first: a revoked pin is a
      // security kill the deferral never forgives, and a missing lockfile
      // pin keeps the generic no-lock-integrity refusal.
      if (revokedCandidate !== undefined) {
        reject(
          `${bundle.packageName}@${revokedCandidate.version} is revoked in the signed company manifest, and the runtime deferral never forgives a revocation (installed ${bundle.packageName}@${bundle.version})`,
          'revoked',
        )
        continue
      }
      if (bundle.lockIntegrity === undefined) {
        reject(bundle.lockProblem
          ?? `${bundle.packageName}@${bundle.version} has no exact pinned record in the profile lockfile`, 'no-lock-integrity', { installedVersion: bundle.version })
        continue
      }
      // The waiting update: the newest remaining pin (all on other runtime
      // lines). Candidates are non-empty here — the empty case exited as
      // not-in-manifest above — so the pick is always defined.
      const waiting = newestEntry(candidates)
      if (waiting === undefined) {
        reject(`${bundle.packageName}@${bundle.version} is not in the signed company manifest`, 'not-in-manifest')
        continue
      }
      const receipt = usableReceipt(receipts, bundle.packageName, bundle.version)
      if (receipt === undefined) {
        // No recorded measurement anchors the tree, so the narrower-than-
        // manifest trust of the deferral fails closed: the plugin stays
        // refused until the client upgrade (or a reinstall that records a
        // receipt) resolves it.
        reject(
          `the signed company manifest no longer pins ${bundle.packageName}@${bundle.version} for this desktop runtime (newest pin ${bundle.packageName}@${waiting.version} requires dsh runtime ${waiting.runtime.dshRuntimeVersion}, this build pins ${dshRuntimeVersion}), and no install receipt exists to load the installed version — upgrade the desktop client`,
          'client-update-required',
          { installedVersion: bundle.version, pinnedVersion: waiting.version },
        )
        continue
      }
      let deferredMeasured: string
      try {
        deferredMeasured = measure(bundle.packageDir, 'receipt')
      } catch (cause) {
        reject(`the installed tree of ${bundle.packageName} could not be measured: ${messageOf(cause)}`)
        continue
      }
      if (deferredMeasured !== receipt.rootDigest) {
        reject(`the installed files of ${bundle.packageName}@${bundle.version} differ from the tree recorded in its install receipt`, 'tree-mismatch')
        continue
      }
      allowed.push({
        packageName: bundle.packageName,
        evidence: 'receipt',
        manifestSequence: manifest.sequence,
        keyId,
      })
      deferredUpdates.push({
        packageName: bundle.packageName,
        installedVersion: bundle.version,
        availableVersion: waiting.version,
        requiredRuntime: waiting.runtime.dshRuntimeVersion,
      })
      continue
    }
    if (entry.revoked) {
      reject(`${bundle.packageName}@${bundle.version} is revoked in the signed company manifest`, 'revoked')
      continue
    }
    if (bundle.lockIntegrity === undefined) {
      reject(bundle.lockProblem
        ?? `${bundle.packageName}@${bundle.version} has no exact pinned record in the profile lockfile`, 'no-lock-integrity', { installedVersion: bundle.version })
      continue
    }
    if (bundle.lockIntegrity !== entry.integrity) {
      reject(`the profile lockfile pins ${bundle.packageName}@${bundle.version} to integrity ${bundle.lockIntegrity}, but the signed company manifest pins ${entry.integrity}`, 'integrity-mismatch')
      continue
    }
    if (entry.treeDigest !== undefined) {
      // Authority mode: the signed digest is the expectation. The receipt is
      // advisory only — see step 4 of the module documentation — so the disk
      // tree is measured and compared against the signed value whether or
      // not a receipt exists and whatever it says. The measurement is
      // requested with the `'signed-tree'` purpose so cache-backed
      // implementations bypass the user-writable fingerprint cache and
      // always read the tree contents.
      let measured: string
      try {
        measured = measure(bundle.packageDir, 'signed-tree')
      } catch (cause) {
        reject(`the installed tree of ${bundle.packageName} could not be measured: ${messageOf(cause)}`)
        continue
      }
      if (measured !== entry.treeDigest) {
        reject(`the installed files of ${bundle.packageName}@${bundle.version} differ from the tree digest pinned in the signed company manifest`, 'tree-mismatch')
        continue
      }
      allowed.push({
        packageName: bundle.packageName,
        evidence: 'signed-tree',
        manifestSequence: manifest.sequence,
        keyId,
        ...(updateVersion === undefined ? {} : { updateVersion, installedVersion: bundle.version }),
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
        ...(updateVersion === undefined ? {} : { updateVersion, installedVersion: bundle.version }),
      })
      continue
    }
    let measured: string
    try {
      measured = measure(bundle.packageDir, 'receipt')
    } catch (cause) {
      reject(`the installed tree of ${bundle.packageName} could not be measured: ${messageOf(cause)}`)
      continue
    }
    if (measured !== receipt.rootDigest) {
      reject(`the installed files of ${bundle.packageName}@${bundle.version} differ from the tree recorded in its install receipt`, 'tree-mismatch')
      continue
    }
    allowed.push({
      packageName: bundle.packageName,
      evidence: 'receipt',
      manifestSequence: manifest.sequence,
      keyId,
      ...(updateVersion === undefined ? {} : { updateVersion, installedVersion: bundle.version }),
    })
  }
  return {
    manifestTrusted: true,
    manifestSequence: manifest.sequence,
    keyId,
    manifestFailure: undefined,
    allowed,
    rejected,
    ...(deferredUpdates.length === 0 ? {} : { deferredUpdates }),
  }
}
