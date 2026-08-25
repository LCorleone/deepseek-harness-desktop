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
 * manifest, so a later manifest whose sequence does not strictly exceed the
 * persisted value is rejected as `stale-sequence` in every future process.
 */

import { createHash } from 'node:crypto'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
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
  type CompanyManifestVerificationCode,
} from '../signing/index.js'
import { isCompanyManifestKeyId, normalizeCompanyManifestTrustRoots } from '../signing/keys.js'
import type { MarketCompanyManifestRecord, MarketSettingsDocument } from './source-store.js'

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
  constructor(private readonly scope: SettingsScope<MarketSettingsDocument>) {}

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
    await this.scope.update({ companyManifest: record })
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
    // install candidate; npm packages resolve to the registry package page.
    repository: normalizeRepositoryIdentity({
      url: `https://registry.npmjs.org/${entry.packageName}`,
    }),
    provenance: {
      sourceRecordId: source.sourceRecordId,
      providerId: source.providerId,
      itemId,
    },
  }
}

function buildScan(
  manifest: CompanyManifest,
  source: LocalSourceRecord,
  verification: Omit<CompanyCatalogVerification, 'sequence' | 'expiresAt'> & { readonly finalUrl: string },
): CompanyCatalogScan {
  const items: CatalogItem[] = []
  const candidates: CompanyCatalogCandidate[] = []
  for (const entry of manifest.packages) {
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
  const providerRevision = `company-manifest-${manifest.sequence}`
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
    signedPackages: [...manifest.packages],
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
    // Origin mode keeps the strict-increase ratchet: fetched manifests
    // must always advance past the persisted sequence. Content mode treats a
    // same-sequence re-observation as a normal replay only when the verified
    // bytes are identical (the embedded asset is unchanged); the same
    // sequence with different bytes, or any lower sequence, is rejected as a
    // rollback/replay attempt.
    const verification = verifyCompanyManifest(loaded.raw, {
      trustRoots: this.trustRoots,
      ...(this.mode === 'origin' && previous !== undefined
        ? { lastSeenSequence: previous.sequence }
        : {}),
      now: this.now,
    })
    // Content-mode verification always persists the verified bytes digest:
    // a regressed or mutated same-sequence re-observation is rejected on the
    // very first comparison (not only from the second scan onward).
    if (this.mode === 'content' && verification.ok) {
      const bytesSha256 = createHash('sha256').update(
        typeof loaded.raw === 'string' ? Buffer.from(loaded.raw, 'utf8') : Buffer.from(loaded.raw),
      ).digest('hex')
      const sameSequence = previous?.sequence === verification.manifest.sequence
      if (previous !== undefined && verification.manifest.sequence < previous.sequence) {
        throw new CompanyCatalogUntrustedError(
          'stale-sequence',
          `embedded manifest sequence ${verification.manifest.sequence} regressed below the persisted ratchet ${previous.sequence}`,
        )
      }
      if (
        sameSequence
        && previous.bytesSha256 !== undefined
        && previous.bytesSha256 !== bytesSha256
      ) {
        throw new CompanyCatalogUntrustedError(
          'stale-sequence',
          `embedded manifest re-observed at sequence ${previous.sequence} with different bytes`,
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
    const scan = buildScan(verification.manifest, context.source, {
      mode: this.mode,
      keyId: verification.keyId,
      fingerprint: verification.fingerprint,
      verifiedAt,
      finalUrl: loaded.finalUrl,
    })
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
