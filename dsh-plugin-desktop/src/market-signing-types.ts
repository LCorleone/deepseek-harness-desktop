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
 * sync with `dsh-community-market/src/signing` and `src/api-types.ts`
 * (receipt v2); the surface here is exactly what desktop is allowed to
 * consume over the public export face.
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
