import type { CatalogSnapshot } from './contracts/generated/catalog-snapshot.js'
import type { CatalogSourceManifest } from './contracts/generated/catalog-source.js'
import type { LocalSourceRecord } from './contracts/types.js'
import type { MarketInstallTreeDigest, MarketInstallTreeDigestFile } from './install/tree-digest.js'

export type { MarketInstallTreeDigest, MarketInstallTreeDigestFile }

export interface MarketBuiltInProvider {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly providerId: string
  readonly adapterId: string
  readonly endpoint: string
  readonly attribution: {
    readonly name: string
    readonly url: string
    readonly notice?: string
  }
  readonly partnership: boolean
}

export interface MarketSourceView extends LocalSourceRecord {
  readonly name: string
  readonly description?: string
  readonly endpoint: string
  readonly homepage?: string
  readonly attribution?: {
    readonly name: string
    readonly url: string
    readonly notice?: string
  }
  readonly partnership: boolean
}

export interface MarketStateResponse {
  readonly sources: readonly MarketSourceView[]
  readonly builtIns: readonly MarketBuiltInProvider[]
  readonly desktopActions: {
    readonly openTerminal: boolean
    readonly requestRestart: boolean
  }
}

/** Display-only instruction reconstructed by the Host from normalized identity. */
export interface MarketManualInstallHint {
  readonly sourceRecordId: string
  readonly providerId: string
  readonly itemId: string
  readonly kind: 'npm' | 'github'
  /** GitHub instructions resolve a moving repository HEAD; exact npm targets do not. */
  readonly mutable: boolean
  readonly desktopVerification: 'not-verified'
  readonly displayCommand: string
}

export interface MarketCatalogSourceResult {
  readonly source: MarketSourceView
  readonly snapshot?: CatalogSnapshot
  readonly error?: string
  readonly stale: boolean
}

export interface MarketCatalogResponse {
  readonly query: Record<string, unknown>
  readonly results: readonly MarketCatalogSourceResult[]
  /** Categories derived from the complete active-source index, not only this page. */
  readonly categories: readonly string[]
  /** Display-only hints for items in this response page; never executable targets. */
  readonly manualInstall: readonly MarketManualInstallHint[]
  readonly metadata?: MarketCatalogMetadata
  readonly fetchedAt: string
}

/** Bounded catalog failure identity returned by the Host without upstream details. */
export type MarketCatalogErrorCode =
  | 'catalog-timeout'
  | 'catalog-invalid-response'
  | 'catalog-unavailable'

export interface MarketCatalogMetadata {
  readonly scannedAt: string
  readonly expiresAt: string
  readonly providerRevision?: string
  readonly cacheStatus: 'fresh' | 'cached'
}

export interface MarketSourceManifestResponse {
  readonly source: CatalogSourceManifest
}

export type MarketSourceMutation =
  | { readonly action: 'add-builtin'; readonly key: string }
  | { readonly action: 'add-standard'; readonly manifestUrl: string }
  | { readonly action: 'select'; readonly sourceRecordId: string }
  | { readonly action: 'move'; readonly sourceRecordId: string; readonly direction: 'up' | 'down' }
  | { readonly action: 'remove'; readonly sourceRecordId: string }

/** Durable proof that the Market installed one exact npm package into one profile. */
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

/**
 * Legacy receipt written before the signed-manifest install chain (P2-3) and
 * still written by deployments without a signed install authority. A v1
 * receipt is usable for uninstall reconciliation and display, but it carries
 * no signed evidence and never participates in an install decision.
 */
export interface MarketInstallReceiptV1 extends MarketInstallReceiptBase {
  /** Absent in receipts written before P2-3; `1` marks the same legacy shape explicitly. */
  readonly receiptVersion?: 1
}

/**
 * Evidence-class vocabulary mirrored from `dsh-community-fabric` RFC 0004
 * "Provenance, Validation, Diagnostics, and the Effect Ledger" §4. The fabric
 * package is documentation-only and exports no types, so the class names are
 * defined locally with this source annotation and must not drift from the RFC.
 */
export type MarketEvidenceClass = 'declared' | 'resolved' | 'decided' | 'observed' | 'tested' | 'attested'

/**
 * RFC 0004 evidence class `resolved` of {@link MarketEvidenceClass}: digests
 * derived from immutable inputs by a resolver or verifier. Both values must
 * equal the corresponding top-level receipt fields.
 */
export interface MarketInstallResolvedEvidence {
  /** npm dist SHA-512 integrity resolved from the allowed registry metadata chain. */
  readonly registryIntegrity: string
  /** Root digest of the installed package tree measured after installation. */
  readonly treeRootDigest: string
}

/**
 * RFC 0004 evidence class `decided` of {@link MarketEvidenceClass}: the Host
 * policy outcome that permitted the install.
 */
export interface MarketInstallDecidedEvidence {
  /** The only decision source that may permit a Market install in a locked deployment. */
  readonly allowedBy: 'signed-company-manifest'
}

/**
 * Receipt written when a signed company manifest entry allowed the install
 * (P2-3). Records the signed decision (manifest sequence and trust-root
 * key), the measured installed tree, and the RFC 0004 evidence classes. A
 * receipt is a cache hint and an uninstall reconciliation credential only:
 * install permission is always decided again from the signed manifest, the
 * registry metadata, and the post-install measurement — never from a stored
 * receipt, whatever its version.
 */
export interface MarketInstallReceiptV2 extends MarketInstallReceiptBase {
  readonly receiptVersion: 2
  /** Sequence of the signed company manifest whose entry allowed this install. */
  readonly manifestSequence: number
  /** keyId of the trust root whose key verified the manifest that allowed this install. */
  readonly keyId: string
  /** Post-install measurement of the installed package tree. */
  readonly treeDigest: MarketInstallTreeDigest
  readonly resolved: MarketInstallResolvedEvidence
  readonly decided: MarketInstallDecidedEvidence
}

/**
 * Durable proof that the Market installed one exact npm package into one
 * profile. `receiptVersion` discriminates the legacy v1 shape (absent or `1`)
 * from the signed-evidence v2 shape.
 */
export type MarketInstallReceipt = MarketInstallReceiptV1 | MarketInstallReceiptV2

export type MarketInstallationView =
  | {
      readonly kind: 'managed'
      readonly status: 'active' | 'disabled'
      readonly action: 'uninstall'
      /** An active mutable bundle can be disabled without surrendering uninstall ownership. */
      readonly disableBundleId?: string
      /** A disabled mutable bundle can be enabled without surrendering uninstall ownership. */
      readonly enableBundleId?: string
      readonly receipt: MarketInstallReceipt
    }
  | {
      readonly kind: 'external'
      readonly status: 'active'
      readonly action: 'disable'
      /** Generation-scoped Host capability; never a path or package argument. */
      readonly bundleId: string
      readonly packageName: string
    }
  | {
      readonly kind: 'external'
      readonly status: 'disabled'
      readonly action: 'enable'
      /** Generation-scoped Host capability; never a path or package argument. */
      readonly bundleId: string
      readonly packageName: string
    }
  | {
      readonly kind: 'immutable'
      readonly status: 'active' | 'disabled'
      readonly action: 'none'
      readonly packageName: string
    }

export interface MarketInstallationsResponse {
  /** Host-reconciled direct bundles for the active profile. */
  readonly installations: readonly MarketInstallationView[]
}

/** Complete Host-derived structural subset; local install state never changes catalog membership. */
export interface MarketInstallableResponse {
  readonly source: MarketSourceView
  readonly items: CatalogSnapshot['items']
  readonly manualInstall: readonly MarketManualInstallHint[]
  readonly metadata: MarketCatalogMetadata
}

/** Renderer input for the non-mutating verification stage. */
export type MarketOperationPreviewRequest =
  | {
      readonly action: 'install'
      readonly sourceRecordId: string
      readonly itemId: string
    }
  | {
      readonly action: 'uninstall'
      readonly receiptId: string
    }
  | {
      readonly action: 'disable'
      /** Opaque exact target obtained from the current Host inventory. */
      readonly bundleId: string
    }
  | {
      readonly action: 'enable'
      /** Opaque exact target obtained from the current Host inventory. */
      readonly bundleId: string
    }

/** Host-verified facts shown before the user confirms a package mutation. */
export interface MarketOperationPreviewResponse {
  readonly action: 'install' | 'uninstall' | 'disable' | 'enable'
  readonly profileName: string
  readonly packageName: string
  readonly version?: string
  readonly displayName: string
  readonly expiresAt: string
  readonly previewId: string
}

export type MarketOperationExecuteResponse =
  | {
      readonly action: 'install'
      readonly receipt: MarketInstallReceipt
      readonly restartToken: string
    }
  | {
      readonly action: 'uninstall'
      readonly receiptId: string
      readonly packageName: string
      readonly restartToken: string
    }
  | {
      readonly action: 'disable'
      readonly packageName: string
      readonly restartToken: string
    }
  | {
      readonly action: 'enable'
      readonly packageName: string
      readonly restartToken: string
    }

export interface MarketDesktopActionResponse {
  readonly ok: true
}
