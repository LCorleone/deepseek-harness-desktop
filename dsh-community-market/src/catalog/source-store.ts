import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { MarketInstallReceipt } from '../api-types.js'
import type { CatalogSnapshot } from '../contracts/generated/catalog-snapshot.js'
import { validateLocalSourceRecords } from '../contracts/validate.js'
import type { CatalogSourceStore, LocalSourceRecord } from '../contracts/types.js'

export interface MarketCatalogCache {
  readonly version: 1
  readonly sourceRecordId: string
  readonly locale: string
  readonly savedAt: string
  readonly snapshot: CatalogSnapshot
  readonly categories: readonly string[]
  readonly scannedAt: string
  readonly expiresAt: string
  readonly providerRevision?: string
}

/**
 * Persisted anti-rollback state of the company manifest chain: the highest
 * sequence this installation has verified plus the trust-root key that
 * verified it. Written only after a fully successful P2-1 verification.
 */
export interface MarketCompanyManifestRecord {
  readonly sequence: number
  readonly keyId: string
  readonly verifiedAt: string
  /** sha256 of the verified canonical bytes; content-mode replay detection. */
  readonly bytesSha256?: string
}

export interface MarketSettingsDocument {
  readonly sources: readonly LocalSourceRecord[]
  readonly installReceipts?: readonly MarketInstallReceipt[]
  readonly catalogCache?: MarketCatalogCache
  readonly companyManifest?: MarketCompanyManifestRecord
}

/**
 * Reconcile legacy multi-enabled settings into the single active-source model.
 * The first enabled record by user order wins. An all-disabled registry keeps
 * its explicit no-selection state.
 */
export function normalizeActiveSourceRecords(
  records: readonly LocalSourceRecord[],
): readonly LocalSourceRecord[] {
  const ordered = [...records].sort((left, right) => left.order - right.order)
  const activeSourceRecordId = ordered.find(record => record.enabled)?.sourceRecordId
  return ordered.map(record => ({
    ...record,
    enabled: record.sourceRecordId === activeSourceRecordId,
  }))
}

/**
 * Host-injected catalog source lock. Locked deployments pin the catalog to
 * one built-in company source and reject every source registry mutation.
 * Injected through options by the embedding Host; this package never
 * imports the policy definition itself.
 */
export interface CatalogSourceLockOptions {
  readonly locked: boolean
  /** Built-in company source served as the only catalog source while locked. */
  readonly companySource: LocalSourceRecord
}

/** Raised when a source registry mutation is attempted while it is locked. */
export class MarketSourceLockError extends Error {
  constructor() {
    super('market catalog sources are locked by deployment policy')
    this.name = 'MarketSourceLockError'
  }
}

function lockedCompanyRecords(companySource: LocalSourceRecord): readonly LocalSourceRecord[] {
  const records = [{ ...companySource, enabled: true }]
  validateLocalSourceRecords(records)
  return records
}

export class SettingsCatalogSourceStore implements CatalogSourceStore {
  constructor(
    private readonly scope: SettingsScope<MarketSettingsDocument>,
    private readonly lock?: CatalogSourceLockOptions,
  ) {}

  async load(): Promise<readonly LocalSourceRecord[]> {
    if (this.lock?.locked) return lockedCompanyRecords(this.lock.companySource)
    const records = [...this.scope.get().sources]
    validateLocalSourceRecords(records)
    return normalizeActiveSourceRecords(records)
  }

  async save(records: readonly LocalSourceRecord[]): Promise<void> {
    if (this.lock?.locked) throw new MarketSourceLockError()
    const normalized = normalizeActiveSourceRecords(records)
    validateLocalSourceRecords(normalized)
    await this.scope.update({ sources: normalized })
  }
}

export class MemoryCatalogSourceStore implements CatalogSourceStore {
  private records: readonly LocalSourceRecord[] = []

  async load(): Promise<readonly LocalSourceRecord[]> {
    return this.records
  }

  async save(records: readonly LocalSourceRecord[]): Promise<void> {
    const normalized = normalizeActiveSourceRecords(records)
    validateLocalSourceRecords(normalized)
    this.records = normalized.map(record => ({ ...record }))
  }
}
