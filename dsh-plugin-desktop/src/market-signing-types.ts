/**
 * Type-only facade for the `dsh-community-market` signing surface consumed by
 * desktop source and tests.
 *
 * Why this exists: the market package is a sibling workspace with its own
 * nested `node_modules/@deepseek-ai/*` copies. Importing its main entry from
 * desktop source pulls that second `@deepseek-ai/cordis` declaration graph
 * into the TypeScript program, which silently drops the `@deepseek-ai/dsh-settings`
 * module augmentation of `Context` and breaks typechecking of unrelated
 * desktop modules. `tsconfig.json` therefore maps the specifier to this
 * facade for typechecking only: bundlers, vitest, and the packaged runtime
 * keep resolving the real package by its exports map, and the specs exercise
 * the real runtime implementation. Keep the declarations structurally in
 * sync with `dsh-community-market/src/signing`, `src/api-types.ts`
 * (receipt v2), and the company catalog provider surface of
 * `src/catalog/company-provider.ts` + `src/contracts/types.ts`; the surface
 * here is exactly what desktop is allowed to consume over the public export
 * face.
 */

export interface CompanyManifestTrustRoot {
  /** Stable identifier selecting among overlapping rotation keys. */
  readonly keyId: string
  /** Lowercase SHA-256 fingerprint (64 hex characters) of the ed25519 public key. */
  readonly fingerprint: string
}

export type CompanyManifestVerificationCode =
  | 'malformed-json'
  | 'non-canonical'
  | 'invalid-manifest'
  | 'unknown-key'
  | 'key-mismatch'
  | 'bad-signature'
  | 'stale-sequence'
  | 'expired'

export interface CompanyManifestRuntimeRanges {
  readonly dshRuntimeVersion: string
  readonly cordisRuntimeVersion?: string
  readonly nodeRuntimeVersion?: string
}

export interface CompanyManifestPackage {
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly bundlePatch: string
  readonly revoked: boolean
  readonly runtime: CompanyManifestRuntimeRanges
  /** Optional signed expected root digest of the installed tree (64 lowercase hex); enables the signed-authority boot check. */
  readonly treeDigest?: string
  /** Optional signed dependency build-script approval list transported from the entry. */
  readonly approvedBuilds?: readonly string[]
}

export interface CompanyManifestSignature {
  readonly keyId: string
  readonly publicKey: string
  readonly value: string
}

export interface CompanyManifest {
  readonly manifestVersion: '1.0.0'
  readonly sequence: number
  readonly expiresAt: string
  readonly packages: readonly CompanyManifestPackage[]
  readonly signature: CompanyManifestSignature
}

export interface VerifyCompanyManifestOptions {
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  readonly lastSeenSequence?: number
  readonly now?: () => number
}

export type CompanyManifestVerification =
  | {
    readonly ok: true
    readonly manifest: CompanyManifest
    readonly keyId: string
    readonly fingerprint: string
    readonly verifiedAt: number
  }
  | {
    readonly ok: false
    readonly code: CompanyManifestVerificationCode
    readonly reason: string
  }

export interface MarketInstallTreeDigest {
  readonly algorithm: 'sha256'
  readonly files: readonly { readonly path: string; readonly digest: string }[]
  readonly rootDigest: string
}

export interface MarketInstallReceiptBase {
  readonly receiptId: string
  readonly profileName: string
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly bundlePatch: string
  readonly sourceRecordId: string
  readonly providerId: string
  readonly itemId: string
  readonly displayName: string
  readonly installedAt: string
}

export interface MarketInstallReceiptV1 extends MarketInstallReceiptBase {
  readonly receiptVersion?: 1
}

export interface MarketInstallReceiptV2 extends MarketInstallReceiptBase {
  readonly receiptVersion: 2
  readonly manifestSequence: number
  readonly keyId: string
  readonly treeDigest: MarketInstallTreeDigest
  readonly resolved: {
    readonly registryIntegrity: string
    readonly treeRootDigest: string
  }
  readonly decided: { readonly allowedBy: 'signed-company-manifest' }
}

export type MarketInstallReceipt = MarketInstallReceiptV1 | MarketInstallReceiptV2

/** Canonical JSON serialization: sorted keys, no insignificant whitespace, literal non-ASCII. */
export declare function canonicalJsonText(value: unknown): string

/** Look up one exact (packageName, version) entry; revoked entries stay findable. */
export declare function findCompanyManifestPackage(
  manifest: CompanyManifest,
  packageName: string,
  version: string,
): CompanyManifestPackage | undefined

/** SHA-256 fingerprint (64 lowercase hex) of an ed25519 public key or raw 32-byte encoding. */
export declare function ed25519PublicKeyFingerprint(
  publicKey: import('node:crypto').KeyObject | Uint8Array,
): string

/** Sign the canonical detached window of an unsigned manifest (tests and publishing only). */
export declare function createCompanyManifestSignature(
  manifest: Omit<CompanyManifest, 'signature'>,
  privateKey: import('node:crypto').KeyObject,
  keyId: string,
): CompanyManifestSignature

/** Verify raw company manifest bytes end to end; business failures are result values. */
export declare function verifyCompanyManifest(
  raw: string | Uint8Array,
  options: VerifyCompanyManifestOptions,
): CompanyManifestVerification

// ---------------------------------------------------------------------------
// Company catalog provider surface (market `src/catalog/company-provider.ts`
// and `src/contracts/types.ts`). Desktop consumes it to compose the locked
// market's origin-mode catalog scan in tests with the Electron-boundary HTTP
// client injected through the `desktopCompanyCatalogHttp` host capability.
// ---------------------------------------------------------------------------

/** Structural mirror of the market's `CatalogHttpRequestPolicy`. */
export interface MarketCatalogHttpRequestPolicy {
  /** Reject a cross-origin redirect before the destination is contacted. */
  readonly allowedOrigin?: string
  /** Bypass and replace any completed or in-flight catalog response cache entry. */
  readonly cacheMode?: 'default' | 'reload'
}

/** Structural mirror of the market's `CatalogHttpResponse`. */
export interface MarketCatalogHttpResponse {
  readonly value: unknown
  readonly finalUrl: string
}

/** Structural mirror of the market's `CatalogHttpClient` host-injection contract. */
export interface MarketCatalogHttpClient {
  getJson(
    url: string,
    signal: AbortSignal,
    policy?: MarketCatalogHttpRequestPolicy,
  ): Promise<MarketCatalogHttpResponse>
}

/** Persisted anti-rollback record of the highest verified manifest sequence. */
export interface MarketCompanyManifestSequenceRecord {
  readonly sequence: number
  readonly keyId: string
  readonly verifiedAt: string
  readonly bytesSha256?: string
}

/** Narrow injectable persistence for the anti-rollback sequence. */
export interface MarketCompanyManifestSequenceStore {
  load(): Promise<MarketCompanyManifestSequenceRecord | undefined>
  save(record: MarketCompanyManifestSequenceRecord): Promise<void>
}

/** Structural mirror of the provider options the Desktop composition uses. */
export interface CompanyCatalogProviderOptionsView {
  /** Origin mode: credential-free HTTPS URL of the signed manifest. */
  readonly companyManifestUrl?: string
  /** Content mode: manifest bytes supplied by the embedding Host. */
  readonly manifestContentProvider?: () => string | Uint8Array | Promise<string | Uint8Array>
  /** Deployment-policy pinned signing keys; at least one root is required. */
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  /** Persists the highest verified sequence. */
  readonly sequenceStore?: MarketCompanyManifestSequenceStore
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Structural mirror of the company catalog provider's public query surface. */
export interface CompanyCatalogProviderView {
  scanCatalog(
    query: Record<string, unknown>,
    context: {
      readonly signal: AbortSignal
      readonly http: MarketCatalogHttpClient
      readonly source: Record<string, unknown>
    },
  ): Promise<readonly { readonly items: readonly { readonly id: string }[] }[]>
  verification(): {
    readonly mode: 'origin' | 'content'
    readonly sequence: number
    readonly keyId: string
    readonly fingerprint: string
    readonly verifiedAt: string
    readonly expiresAt: string
  } | undefined
}

/** Build a company catalog provider from deployment-policy injection. */
export declare function createCompanyCatalogProvider(
  options: CompanyCatalogProviderOptionsView,
): CompanyCatalogProviderView
