/**
 * Company catalog provider (P2-2): the deployment-locked catalog source whose
 * only input is a signed `CompanyManifest` verified by the P2-1 signing
 * library. The provider is policy-injected with exactly one acquisition mode:
 *
 * - **origin mode** fetches the manifest bytes from team static hosting over
 *   the restricted catalog HTTP client with the registered origin pinned; and
 * - **content mode** (catalog-as-content) receives the manifest bytes directly
 *   from the embedding Host, e.g. a manifest bundled with the application. The
 *   provider is agnostic to where the host obtained the bytes.
 *
 * Every scan is fail-closed. A manifest that fails any verification step
 * (canonical form, trust-root binding, signature, monotonic sequence, expiry)
 * rejects the whole scan with {@link CompanyCatalogUntrustedError}: no partial
 * candidate list is ever produced and the provider never falls back to another
 * source. The catalog service keeps serving its last successful scan cache
 * until that cache expires, after which the catalog fails with the same
 * explicit untrusted error instead of showing anything newer or older.
 *
 * Anti-rollback is cross-process: after a successful verification the manifest
 * sequence is persisted through the injected {@link CompanyManifestSequenceStore}
 * (settings-backed in Desktop) *before* any catalog state is derived from the
 * manifest, so a later manifest whose sequence regresses below the persisted
 * value is rejected as `stale-sequence` in every future process. The persisted
 * sequence is a floor, not a strict-increase ratchet: replaying the same
 * sequence is the normal steady state of a catalog that has not been
 * republished, and is admitted when the verified bytes match the persisted
 * digest (see the replay rule in `scanCatalog`).
 *
 * Security semantics of the persisted digest: the content authority is the
 * signature chain — bytes that verify against a pinned trust root at a
 * sequence that does not regress are the catalog, whatever a local record
 * claims. The digest is only a local observation cache for replay detection,
 * and it can be wrong: a merge-mode settings write once deep-merged sequence
 * records across acquisition-mode eras and left a stale `bytesSha256` under a
 * newer sequence, which made every later scan fail as `stale-sequence` with no
 * path to recovery — a denial of service by stale local state, not by an
 * attacker. So a same-sequence digest mismatch is now a loud warning plus a
 * record refresh (the scan continues on the freshly verified bytes and the
 * save below rewrites the record atomically), never a rejection; an operator
 * re-signing the same sequence gets a loud warning instead of a bricked
 * catalog. The hard lines stay hard: a strictly lower sequence is rejected
 * here and inside verification, and every signature/expiry/canonical-form
 * failure still fails the whole scan closed.
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CatalogQuery } from '../contracts/generated/catalog-query.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'
import type { CatalogAdapter, CatalogFetchContext, LocalSourceRecord } from '../contracts/types.js'
import {
  canonicalJsonText,
  verifyCompanyManifest,
  type CompanyManifest,
  type CompanyManifestPackage,
  type CompanyManifestRuntimeRanges,
  type CompanyManifestTrustRoot,
  type CompanyManifestVerification,
  type CompanyManifestVerificationCode,
  type VerifyCompanyManifestOptions,
} from '../signing/index.js'
import { isCompanyManifestKeyId, normalizeCompanyManifestTrustRoots } from '../signing/keys.js'
import type { MarketCompanyManifestRecord, MarketSettingsMutatingScope } from './source-store.js'

/** Adapter identity of the signed company catalog in the local registry. */
export const COMPANY_CATALOG_ADAPTER_ID = 'market.company-manifest-v1'
/** Default provider identity claimed by the built-in company source record. */
export const COMPANY_CATALOG_PROVIDER_ID = 'com.deepseek.company-catalog'
/** Built-in provider key of the company source record (`builtInProviderKey`). */
export const COMPANY_CATALOG_BUILT_IN_KEY = 'company-catalog'

/**
 * Content mode has no network origin, while the snapshot wire contract
 * requires an HTTPS `finalUrl`. Content-mode snapshots carry this reserved,
 * never-resolvable placeholder (RFC 2606 `.invalid` TLD) so no real host is
 * ever implied for manifest bytes injected by the embedding Host.
 */
export const COMPANY_CATALOG_CONTENT_FINAL_URL = 'https://company-catalog.invalid/manifest.json'

const COMPANY_CATALOG_PAGE_SIZE = 100
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u
const MAX_ITEM_ID_LENGTH = 160
const MAX_NAME_LENGTH = 160
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_VERSION_LENGTH = 64

/**
 * Verification of the company manifest failed, so the entire catalog is
 * untrusted for this scan. `code` mirrors {@link CompanyManifestVerificationCode}.
 */
export class CompanyCatalogUntrustedError extends Error {
  constructor(
    readonly code: CompanyManifestVerificationCode,
    reason: string,
  ) {
    super(`company catalog is not trusted (${code}): ${reason}`)
    this.name = 'CompanyCatalogUntrustedError'
  }
}

/**
 * One installable entry of the last verified company manifest. The signed
 * npm dist `integrity`, the in-package `bundlePatch` path, and the runtime
 * compatibility ranges are carried verbatim for the install-time signature
 * check (P2-3); this card only transports them and never evaluates them.
 */
export interface CompanyCatalogCandidate {
  /** Snapshot item ID (`npm:<packageName>@<version>`) correlating catalog rows with signed entries. */
  readonly itemId: string
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly bundlePatch: string
  readonly runtime: CompanyManifestRuntimeRanges
}

/** Summary of the last successful manifest verification. */
export interface CompanyCatalogVerification {
  readonly mode: 'origin' | 'content'
  /** Verified manifest sequence; already persisted through the sequence store. */
  readonly sequence: number
  /** keyId of the trust root whose key produced the verified signature. */
  readonly keyId: string
  readonly fingerprint: string
  readonly verifiedAt: string
  readonly expiresAt: string
}

/**
 * Narrow injectable persistence for the anti-rollback sequence. Implementations
 * must durably keep the highest verified sequence across processes.
 */
export interface CompanyManifestSequenceStore {
  load(): Promise<MarketCompanyManifestRecord | undefined>
  save(record: MarketCompanyManifestRecord): Promise<void>
}

/** Host-injected manifest bytes for content mode; may be async. */
export type CompanyManifestContentProvider = () => string | Uint8Array | Promise<string | Uint8Array>

/**
 * Manifest verification over the provider's raw bytes, as an injectable
 * override of the market library's field-unaware `verifyCompanyManifest`.
 * The embedding Host injects a field-aware verifier when its manifests may
 * carry entry fields beyond the market schema — Desktop's signed `source`
 * install channel — so the catalog scan keeps verifying those manifests
 * instead of rejecting them whole over one unknown key. Contract for
 * injected verifiers: `source`-free manifests decide exactly like
 * `verifyCompanyManifest` (same trust outcome, same failure codes), any
 * recognized extension fields are verified under the same fail-closed
 * rules, and a verified manifest carries the market-known projection of
 * every entry — the provider reads only those fields; extension fields
 * ride through `findSignedPackage` untouched.
 */
export type CompanyManifestVerifier = (
  raw: string | Uint8Array,
  options: VerifyCompanyManifestOptions,
) => CompanyManifestVerification

/**
 * Host-resolved beta-channel overlay (P9): the already-verified,
 * already-roster-filtered signed entries of the deployment's beta catalog
 * manifest, plus the beta manifest's own sequence. The embedding Host owns
 * every beta decision — fetching `catalog-manifest.beta.json` from the
 * policy-pinned origin, verifying it under the same trust roots (the
 * field-aware verifier carrying the optional top-level `testers` roster),
 * and matching the local SSO identity against the signed roster — and
 * returns `undefined` for every other outcome, which keeps the provider's
 * scan byte-for-byte on the stable manifest alone (a non-roster machine, a
 * missing or unverified beta file, an unresolved identity). The provider
 * only merges what arrives: beta entries are additive — a `name@version`
 * the stable manifest already pins with identical signed fields changes
 * nothing, a divergent or new one wins — and a beta sequence below the
 * stable sequence is a stale overlay the provider ignores. The stable
 * manifest's verification view (sequence, keyId, expiresAt) stays the
 * catalog's identity, so receipts and the anti-rollback ratchet keep
 * tracking the stable channel exactly as before.
 */
export interface CompanyBetaCatalogOverlay {
  /** Signed entries of the verified beta manifest, revoked entries included. */
  readonly packages: readonly CompanyManifestPackage[]
  /** Sequence of the verified beta manifest; must not regress below the stable sequence. */
  readonly sequence: number
}

/** Host-provided beta overlay resolution (see {@link CompanyBetaCatalogOverlay}). */
export type CompanyBetaCatalogOverlayProvider = (
  signal?: AbortSignal,
) => Promise<CompanyBetaCatalogOverlay | undefined>

export interface CompanyCatalogProviderOptions {
  /** Origin mode: credential-free HTTPS URL of the signed manifest on team static hosting. */
  readonly companyManifestUrl?: string
  /** Content mode: manifest bytes supplied by the embedding Host. */
  readonly manifestContentProvider?: CompanyManifestContentProvider
  /** Deployment-policy pinned signing keys; at least one root is required. */
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  /** Persists the highest verified sequence; defaults to no persistence. */
  readonly sequenceStore?: CompanyManifestSequenceStore
  /** Clock injection, defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Injectable manifest verification (see {@link CompanyManifestVerifier});
   * defaults to the market library's field-unaware `verifyCompanyManifest`,
   * so standalone deployments and Hosts that do not inject stay byte-for-
   * byte on the library verifier.
   */
  readonly manifestVerifier?: CompanyManifestVerifier
  /**
   * Host-resolved beta overlay (P9, see {@link CompanyBetaCatalogOverlayProvider}).
   * Every failure inside the provider — a thrown resolution, a stale beta
   * sequence, an unrepresentable beta entry — drops the overlay and keeps the
   * scan on the stable manifest alone; the stable scan itself never fails
   * because of beta content. Standalone deployments stay overlay-free.
   */
  readonly betaOverlayProvider?: CompanyBetaCatalogOverlayProvider
  /**
   * Host logger for the loud same-sequence digest-mismatch warning on the
   * self-heal path in `scanCatalog` (see the module security note); the
   * embedding Host delivers it from its apply context so `--export-diagnostics`
   * file logs explain the heal. Diagnostic sink only, never a behavior gate.
   */
  readonly logger?: Pick<Context['logger'], 'warn'>
}

function validCompanyManifestRecord(value: unknown): value is MarketCompanyManifestRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (!(Number.isSafeInteger(record.sequence) && (record.sequence as number) >= 1
    && isCompanyManifestKeyId(record.keyId)
    && typeof record.verifiedAt === 'string'
    && !Number.isNaN(Date.parse(record.verifiedAt as string)))) {
    return false
  }
  // A corrupted bytes digest would make every same-sequence scan fail with a
  // misleading stale-sequence; treat it like the other invalid state and let
  // the caller's loud-invalid path surface it instead.
  if (record.bytesSha256 !== undefined
    && !/^[0-9a-f]{64}$/u.test(record.bytesSha256 as string)) {
    throw new Error('company manifest anti-rollback state is invalid: bytesSha256 must be lowercase sha256 hex')
  }
  return true
}

/**
 * Settings-backed anti-rollback state. The highest verified sequence lives in
 * the market settings document next to the source registry and install
 * receipts, so rollback protection survives process restarts.
 */
export class SettingsCompanyManifestSequenceStore implements CompanyManifestSequenceStore {
  constructor(private readonly scope: MarketSettingsMutatingScope) {}

  async load(): Promise<MarketCompanyManifestRecord | undefined> {
    const record = this.scope.get().companyManifest
    if (record === undefined) return undefined
    // A corrupted or forged ratchet must brick the catalog loudly, never
    // silently restart the sequence count from zero.
    if (!validCompanyManifestRecord(record)) {
      throw new Error('company manifest anti-rollback state is invalid')
    }
    return record
  }

  async save(record: MarketCompanyManifestRecord): Promise<void> {
    if (!validCompanyManifestRecord(record)) {
      throw new TypeError('invalid company manifest sequence record')
    }
    // Atomic subtree replacement, never a merge. `scope.update` merges the
    // patch recursively into the stored section, so a record saved without
    // `bytesSha256` (the origin-mode shape before digest persistence) would
    // resurrect the previous record's digest under the new sequence — the
    // field incident that left every later scan mismatching a stale digest
    // with no write path left to correct it. The path-addressed `set` op
    // swaps the whole `companyManifest` subtree in one queued write, leaving
    // sibling fields untouched and the read-back exactly the saved record.
    const mutate = this.scope.mutate
    if (mutate !== undefined) {
      await mutate.call(this.scope, [{ op: 'set', path: ['companyManifest'], value: record }])
      return
    }
    // Fallback for scopes without path mutation: replace the section
    // wholesale with the current resolved document and the record swapped
    // in, preserving sibling fields (sources, receipts, cache).
    await this.scope.replace({ ...this.scope.get(), companyManifest: record })
  }
}

interface CompanyCatalogScan {
  readonly verification: CompanyCatalogVerification
  readonly candidates: readonly CompanyCatalogCandidate[]
  /** Signed entries of the last verified manifest, revoked entries included (P2-3 install-time query). */
  readonly signedPackages: readonly CompanyManifestPackage[]
  readonly snapshots: readonly CatalogSnapshot[]
}

type CatalogItem = CatalogSnapshot['items'][number]

/** Snapshot item ID of one manifest entry; unique per exact package version. */
export function companyCatalogItemId(entry: Pick<CompanyManifestPackage, 'packageName' | 'version'>): string {
  return `npm:${entry.packageName}@${entry.version}`
}

/** Signed-entry identity key of one exact package version. */
const companyEntryIdentity = (entry: Pick<CompanyManifestPackage, 'packageName' | 'version'>): string =>
  `${entry.packageName}\0${entry.version}`

/**
 * Merge a host-resolved beta overlay into the stable manifest's entries
 * (P9). Beta is additive-only visibility: entries the stable manifest does
 * not pin are appended, and a `name@version` both manifests pin replaces the
 * stable entry exactly when the signed fields diverge (a byte-identical
 * entry — the post-promote steady state — changes nothing, so promotion is
 * invisible to roster machines and non-roster machines never see beta
 * content at all). One field never flips back: revocation is sticky — a
 * `name@version` the stable manifest pins as revoked:true stays revoked in
 * the merge even when a stale beta entry still says false, so a pre-
 * revocation beta publication can never resurrect a revoked entry on a
 * roster machine (the client-side half of the pipeline's sign-time
 * alignment). Every beta entry must be representable in the v1 catalog
 * contract before it may enter the merge: one that cannot be is a publish
 * fault, and the caller drops the whole overlay rather than partially
 * adopting signed content. The merged list keeps the pipeline's
 * `(packageName, version)` sort so scans stay deterministic.
 */
export function mergeCompanyBetaPackages(
  stablePackages: readonly CompanyManifestPackage[],
  betaPackages: readonly CompanyManifestPackage[],
): readonly CompanyManifestPackage[] {
  const merged = new Map<string, CompanyManifestPackage>()
  for (const entry of stablePackages) {
    merged.set(companyEntryIdentity(entry), entry)
  }
  for (const entry of betaPackages) {
    // The same representability gate the stable scan applies per entry;
    // running it here keeps a publish fault from failing the whole scan
    // downstream — the caller treats the throw as "overlay unusable".
    assertRepresentableEntry(entry)
    const stable = merged.get(companyEntryIdentity(entry))
    merged.set(
      companyEntryIdentity(entry),
      stable?.revoked === true && entry.revoked !== true ? { ...entry, revoked: true } : entry,
    )
  }
  return [...merged.values()].sort((left, right) =>
    left.packageName === right.packageName
      ? (left.version < right.version ? -1 : left.version > right.version ? 1 : 0)
      : (left.packageName < right.packageName ? -1 : 1))
}

/**
 * Guard the v1 snapshot contract limits the manifest schema cannot express
 * (identifier grammar, name and version lengths). A company manifest entry
 * that cannot be represented faithfully fails the whole scan instead of being
 * silently hidden from the catalog.
 */
function assertRepresentableEntry(entry: CompanyManifestPackage): void {
  const itemId = companyCatalogItemId(entry)
  if (
    itemId.length > MAX_ITEM_ID_LENGTH
    || !ITEM_ID_PATTERN.test(itemId)
    || entry.packageName.length > MAX_NAME_LENGTH
    || entry.packageName.length > MAX_DISPLAY_NAME_LENGTH
    || entry.version.length > MAX_VERSION_LENGTH
  ) {
    throw new Error(
      `company manifest entry ${entry.packageName}@${entry.version} cannot be represented in the v1 catalog contract`,
    )
  }
  // The v1 candidate contract requires a repository identity on every
  // installable row: observeCatalog drops rows without one, and previewInstall
  // back-links that identity against the live npm package metadata. The signed
  // schema pins `repository` on every entry; an identity that still fails to
  // normalize would surface as a row without an install path, so it fails the
  // scan like any other unrepresentable entry.
  try {
    normalizeRepositoryIdentity(entry.repository)
  } catch (cause) {
    throw new Error(
      `company manifest entry ${entry.packageName}@${entry.version} carries a repository identity that cannot be represented in the v1 catalog contract (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }
}

function catalogItem(entry: CompanyManifestPackage, source: LocalSourceRecord): CatalogItem {
  const itemId = companyCatalogItemId(entry)
  return {
    id: itemId,
    name: entry.packageName,
    displayName: entry.packageName,
    summary: `Company signed catalog entry ${entry.packageName}@${entry.version}`,
    package: { registry: 'npm', name: entry.packageName },
    latestVersion: entry.version,
    // observeCatalog requires a repository identity before an item becomes an
    // install candidate, and install-time verification back-links it against
    // the live npm metadata. The manifest signs each entry's true VCS
    // repository, so the signed identity is carried through verbatim (already
    // proven normalizable by assertRepresentableEntry).
    repository: normalizeRepositoryIdentity(entry.repository),
    provenance: {
      sourceRecordId: source.sourceRecordId,
      providerId: source.providerId,
      itemId,
    },
  }
}

function buildScan(
  packages: readonly CompanyManifestPackage[],
  providerRevision: string,
  source: LocalSourceRecord,
  verification: Omit<CompanyCatalogVerification, 'sequence' | 'expiresAt'> & { readonly finalUrl: string },
  manifest: Pick<CompanyManifest, 'sequence' | 'expiresAt'>,
): CompanyCatalogScan {
  const items: CatalogItem[] = []
  const candidates: CompanyCatalogCandidate[] = []
  for (const entry of packages) {
    // Revoked entries keep their signed audit trail inside the manifest but
    // never enter the catalog: no browse row, no install candidate. Exclusion
    // (instead of an "uninstallable" flag) matches the v1 candidate contract,
    // which has no way to mark a row uninstallable. The signed entries stay
    // queryable through findSignedPackage so the install-time authority
    // (P2-3) can distinguish a revoked entry from an absent one.
    if (entry.revoked) continue
    assertRepresentableEntry(entry)
    items.push(catalogItem(entry, source))
    candidates.push({
      itemId: companyCatalogItemId(entry),
      packageName: entry.packageName,
      version: entry.version,
      integrity: entry.integrity,
      bundlePatch: entry.bundlePatch,
      runtime: entry.runtime,
    })
  }

  const fetchedAt = new Date(verification.verifiedAt).toISOString()
  const { finalUrl, ...verificationView } = verification
  const snapshots: CatalogSnapshot[] = []
  for (let offset = 0; offset < items.length; offset += COMPANY_CATALOG_PAGE_SIZE) {
    snapshots.push(parseCatalogSnapshot({
      schemaVersion: '1.0.0',
      source: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        adapterId: source.adapterId,
        registrationKind: source.registrationKind,
        fetchedAt,
        finalUrl,
        providerRevision,
      },
      items: items.slice(offset, offset + COMPANY_CATALOG_PAGE_SIZE),
      page: { total: items.length },
    }))
  }
  if (snapshots.length === 0) {
    snapshots.push(parseCatalogSnapshot({
      schemaVersion: '1.0.0',
      source: {
        sourceRecordId: source.sourceRecordId,
        providerId: source.providerId,
        adapterId: source.adapterId,
        registrationKind: source.registrationKind,
        fetchedAt,
        finalUrl,
        providerRevision,
      },
      items: [],
      page: { total: 0 },
    }))
  }

  return {
    verification: {
      ...verificationView,
      sequence: manifest.sequence,
      expiresAt: manifest.expiresAt,
    },
    candidates,
    signedPackages: [...packages],
    snapshots,
  }
}

function querySnapshot(query: CatalogQuery, snapshots: readonly CatalogSnapshot[]): CatalogSnapshot {
  const first = snapshots[0]
  if (first === undefined) throw new Error('company catalog scan did not produce a snapshot')
  const search = query.q?.toLocaleLowerCase('en-US')
  const categories = query.category === undefined ? undefined : new Set(query.category)
  const hasUnsupportedCapabilities = (query.capability?.length ?? 0) > 0
  let items = snapshots.flatMap(snapshot => snapshot.items).filter(item => {
    if (hasUnsupportedCapabilities) return false
    if (categories !== undefined && categories.size > 0 && item.categories?.some(category => categories.has(category)) !== true) return false
    if (search === undefined) return true
    return [
      item.id,
      item.name,
      item.displayName,
      item.summary,
      item.description ?? '',
      ...(item.keywords ?? []),
    ].join('\n').toLocaleLowerCase('en-US').includes(search)
  })
  if (query.sort === 'name') {
    items = [...items].sort((left, right) => left.displayName.localeCompare(
      right.displayName,
      query.locale ?? 'en',
      { sensitivity: 'base' },
    ))
  } else if (query.sort === 'updated') {
    items = [...items].sort((left, right) =>
      (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0))
  }

  const rawCursor = query.cursor ?? '0'
  if (!/^\d+$/u.test(rawCursor)) throw new Error('company catalog cursor is invalid')
  const offset = Number(rawCursor)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) {
    throw new Error('company catalog cursor is invalid')
  }
  const limit = Math.min(query.limit ?? 50, COMPANY_CATALOG_PAGE_SIZE)
  const end = Math.min(offset + limit, items.length)
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: first.source,
    items: items.slice(offset, end),
    page: {
      total: items.length,
      ...(end < items.length ? { nextCursor: String(end) } : {}),
    },
  })
}

function safeCompanyManifestUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('company manifest URL is not a valid URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new TypeError('company manifest URL must use credential-free standard HTTPS port 443 without a fragment')
  }
  return url
}

/**
 * The signed company catalog as a {@link CatalogAdapter}. The adapter layer is
 * deliberately thin: it verifies bytes, converts verified entries into the
 * normalized v1 candidate stream, and exposes the signed per-package metadata
 * (integrity, bundle patch, runtime ranges) for the install-time signature
 * check through {@link verifiedPackages}, {@link findVerifiedPackage}, and
 * {@link findSignedPackage}.
 */
export class CompanyCatalogProvider implements CatalogAdapter {
  readonly adapterId = COMPANY_CATALOG_ADAPTER_ID

  private readonly mode: 'origin' | 'content'
  private readonly manifestUrl: URL | undefined
  private readonly manifestContentProvider: CompanyManifestContentProvider | undefined
  private readonly trustRoots: readonly CompanyManifestTrustRoot[]
  private readonly sequenceStore: CompanyManifestSequenceStore | undefined
  private readonly now: () => number
  private readonly verifyManifest: CompanyManifestVerifier
  private readonly betaOverlayProvider: CompanyBetaCatalogOverlayProvider | undefined
  private readonly logger: Pick<Context['logger'], 'warn'> | undefined
  private scan: CompanyCatalogScan | undefined

  constructor(options: CompanyCatalogProviderOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('company catalog provider options are required')
    }
    const hasUrl = options.companyManifestUrl !== undefined
    const hasContent = options.manifestContentProvider !== undefined
    if (hasUrl === hasContent) {
      throw new TypeError('company catalog provider takes exactly one of companyManifestUrl or manifestContentProvider')
    }
    if (hasContent && typeof options.manifestContentProvider !== 'function') {
      throw new TypeError('manifestContentProvider must be a function')
    }
    if (options.manifestVerifier !== undefined && typeof options.manifestVerifier !== 'function') {
      throw new TypeError('manifestVerifier must be a function')
    }
    if (options.betaOverlayProvider !== undefined && typeof options.betaOverlayProvider !== 'function') {
      throw new TypeError('betaOverlayProvider must be a function')
    }
    const trustRoots = normalizeCompanyManifestTrustRoots(options.trustRoots)
    if (trustRoots.length === 0) {
      throw new TypeError('company catalog provider requires at least one pinned trust root')
    }
    this.mode = hasUrl ? 'origin' : 'content'
    this.manifestUrl = hasUrl ? safeCompanyManifestUrl(options.companyManifestUrl!) : undefined
    this.manifestContentProvider = hasContent ? options.manifestContentProvider : undefined
    this.trustRoots = trustRoots
    this.sequenceStore = options.sequenceStore
    this.now = options.now ?? Date.now
    this.verifyManifest = options.manifestVerifier ?? verifyCompanyManifest
    this.betaOverlayProvider = options.betaOverlayProvider
    this.logger = options.logger
  }

  async fetch(query: CatalogQuery, context: CatalogFetchContext): Promise<CatalogSnapshot> {
    return querySnapshot(query, await this.scanCatalog(query, context))
  }

  async scanCatalog(_query: CatalogQuery, context: CatalogFetchContext): Promise<readonly CatalogSnapshot[]> {
    context.signal.throwIfAborted()
    const loaded = await this.loadManifestBytes(context)
    context.signal.throwIfAborted()
    const previous = await this.sequenceStore?.load()
    let verifiedBytesSha256: string | undefined
    context.signal.throwIfAborted()
    if (previous !== undefined && !validCompanyManifestRecord(previous)) {
      // Defense in depth: never let a corrupt injected store silently reset
      // the anti-rollback ratchet.
      throw new Error('company manifest anti-rollback state is invalid')
    }
    // Both modes share one replay rule. A strictly lower sequence is a
    // rollback: origin mode rejects it inside verification through the
    // persisted floor passed as `lastSeenSequence`, and content mode rejects
    // it in the explicit check below. The same sequence is a replay, which is
    // the normal steady state — a statically hosted origin serves the same
    // manifest bytes on every scan, and the embedded asset is unchanged — so
    // it is admitted when the verified bytes are identical to the last
    // verified ones (byte digests match, or the persisted record predates
    // digest persistence and has none to compare). The same sequence with
    // different bytes is not a rejection: the content authority is the
    // signature chain (these bytes just verified against a pinned trust
    // root, and the sequence did not regress), while the persisted digest is
    // a local observation cache that partial writes have corrupted before —
    // hard-rejecting on it once bricked the catalog with no recovery path.
    // It warns loudly instead, and the save below refreshes the record with
    // the just-verified digest; the rollback floor above stays hard.
    const verification = this.verifyManifest(loaded.raw, {
      trustRoots: this.trustRoots,
      ...(this.mode === 'origin' && previous !== undefined
        ? { lastSeenSequence: previous.sequence }
        : {}),
      now: this.now,
    })
    // Verification in either mode persists the verified bytes digest: a
    // regressed or mutated same-sequence re-observation is rejected on the
    // very first comparison (not only from the second scan onward).
    if (verification.ok) {
      const bytesSha256 = createHash('sha256').update(
        typeof loaded.raw === 'string' ? Buffer.from(loaded.raw, 'utf8') : Buffer.from(loaded.raw),
      ).digest('hex')
      const sameSequence = previous?.sequence === verification.manifest.sequence
      if (this.mode === 'content' && previous !== undefined && verification.manifest.sequence < previous.sequence) {
        throw new CompanyCatalogUntrustedError(
          'stale-sequence',
          `embedded manifest sequence ${verification.manifest.sequence} regressed below the persisted ratchet ${previous.sequence}`,
        )
      }
      if (
        sameSequence
        && previous?.bytesSha256 !== undefined
        && previous.bytesSha256 !== bytesSha256
      ) {
        // Self-heal, not reject (see the module security note): the recorded
        // digest disagrees with bytes that just passed full ed25519
        // verification at a non-regressing sequence. Either the record is
        // polluted local state (the historical merge-mode partial write) or
        // an operator re-issued the same sequence — both are served by
        // continuing on the verified bytes while the warning makes the
        // divergence loud for operators; the refresh below re-pins the
        // digest through the atomic store save.
        this.logger?.warn(
          `dsh-community-market: ${this.mode === 'origin' ? 'fetched' : 'embedded'} manifest re-observed at sequence ${verification.manifest.sequence} with different bytes (recorded digest ${previous.bytesSha256}, computed digest ${bytesSha256}); `
          + `the bytes just passed full ed25519 verification against trust root ${verification.keyId}, so the local digest record is treated as stale (historical partial write or same-sequence re-issue) and refreshed — a lower sequence still rejects as rollback`,
        )
      }
      verifiedBytesSha256 = bytesSha256
    }
    if (!verification.ok) {
      // Verification failure discards the entire catalog for this scan. The
      // last verified scan state below is intentionally kept: it remains the
      // only content the install path may consult, and nothing newer is ever
      // partially adopted.
      throw new CompanyCatalogUntrustedError(verification.code, verification.reason)
    }
    const verifiedAt = new Date(verification.verifiedAt).toISOString()
    // Anti-rollback ratchet: persist the verified sequence before any catalog
    // state is derived from the manifest. A persistence failure fails the
    // whole scan rather than admitting an unpersisted sequence.
    await this.sequenceStore?.save({
      sequence: verification.manifest.sequence,
      keyId: verification.keyId,
      verifiedAt,
      ...(verifiedBytesSha256 === undefined ? {} : { bytesSha256: verifiedBytesSha256 }),
    })
    context.signal.throwIfAborted()
    // Beta overlay (P9): the Host resolves the beta manifest and the roster
    // decision; the provider only merges. Every overlay outcome except a
    // usable package list — no provider configured, undefined (the Host's
    // own fail-closed decision for a non-roster machine or an unverified
    // beta file), a thrown resolution, a beta sequence below the just-
    // verified stable sequence (stale overlay), or an unrepresentable beta
    // entry — keeps this scan on the stable manifest alone. The overlay
    // never fails the stable scan and never touches the ratchet above: the
    // persisted sequence floor stays the stable channel's, so a beta
    // manifest published ahead of stable cannot brick the catalog.
    let packages: readonly CompanyManifestPackage[] = verification.manifest.packages
    let betaApplied = false
    if (this.betaOverlayProvider !== undefined) {
      try {
        const overlay = await this.betaOverlayProvider(context.signal)
        if (overlay !== undefined && overlay.sequence >= verification.manifest.sequence) {
          packages = mergeCompanyBetaPackages(verification.manifest.packages, overlay.packages)
          betaApplied = true
        } else if (overlay !== undefined) {
          this.logger?.warn(
            `dsh-community-market: ignoring the beta catalog overlay at sequence ${String(overlay.sequence)} — below the verified stable sequence ${String(verification.manifest.sequence)} (stale beta publication)`,
          )
        }
      } catch (cause) {
        this.logger?.warn(
          `dsh-community-market: ignoring the beta catalog overlay — resolution or merge failed (${cause instanceof Error ? cause.message : String(cause)})`,
        )
      }
    }
    const scan = buildScan(
      packages,
      `company-manifest-${String(verification.manifest.sequence)}${betaApplied ? '+beta' : ''}`,
      context.source,
      {
        mode: this.mode,
        keyId: verification.keyId,
        fingerprint: verification.fingerprint,
        verifiedAt,
        finalUrl: loaded.finalUrl,
      },
      verification.manifest,
    )
    this.scan = scan
    return scan.snapshots
  }

  /**
   * Installable entries of the last verified manifest: signed integrity,
   * bundle patch, and runtime ranges included, revoked entries excluded.
   */
  verifiedPackages(): readonly CompanyCatalogCandidate[] {
    return this.scan?.candidates ?? []
  }

  /**
   * Install-time lookup of one exact signed entry. Revoked entries are absent
   * by construction, so a hit is installable metadata and a miss is not.
   */
  findVerifiedPackage(packageName: string, version: string): CompanyCatalogCandidate | undefined {
    return this.verifiedPackages().find(candidate =>
      candidate.packageName === packageName && candidate.version === version)
  }

  /**
   * Signed entry of the last verified manifest, revoked entries included.
   * Narrow install-time query (P2-3): the signed-manifest install authority
   * must tell a revoked entry from an absent one, while the browsing
   * candidate stream above excludes revoked entries by design.
   */
  findSignedPackage(packageName: string, version: string): CompanyManifestPackage | undefined {
    return this.scan?.signedPackages.find(entry =>
      entry.packageName === packageName && entry.version === version)
  }

  /** Last successful verification, or undefined before the first verified scan. */
  verification(): CompanyCatalogVerification | undefined {
    return this.scan?.verification
  }

  private async loadManifestBytes(
    context: CatalogFetchContext,
  ): Promise<{ readonly raw: string | Uint8Array; readonly finalUrl: string }> {
    if (this.manifestContentProvider !== undefined) {
      const raw = await this.manifestContentProvider()
      if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) {
        throw new TypeError('manifestContentProvider must return manifest bytes')
      }
      return { raw, finalUrl: COMPANY_CATALOG_CONTENT_FINAL_URL }
    }
    const url = this.manifestUrl!
    const response = await context.http.getJson(url.href, context.signal, { allowedOrigin: url.origin })
    let finalUrl: URL
    try {
      finalUrl = new URL(response.finalUrl)
    } catch {
      throw new Error('company manifest response reported an invalid final URL')
    }
    if (finalUrl.origin !== url.origin) {
      throw new Error('company manifest response changed the pinned origin')
    }
    // The catalog HTTP client hands over a parsed JSON value, so the wire
    // bytes are no longer observable here. Re-serializing the parsed value
    // canonically feeds the verifier the exact bytes the signature is checked
    // against; values that cannot be canonicalized (floats, unsafe integers)
    // are rejected as non-canonical. Content mode keeps the full raw-byte
    // canonical equality check.
    let text: string
    try {
      text = canonicalJsonText(response.value)
    } catch (cause) {
      throw new CompanyCatalogUntrustedError(
        'non-canonical',
        cause instanceof Error ? cause.message : String(cause),
      )
    }
    return { raw: text, finalUrl: finalUrl.href }
  }
}

/** Build a company catalog provider from deployment-policy injection. */
export function createCompanyCatalogProvider(options: CompanyCatalogProviderOptions): CompanyCatalogProvider {
  return new CompanyCatalogProvider(options)
}
