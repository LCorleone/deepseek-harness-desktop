/**
 * Install whitelist backed by the last verified signed company manifest (P2-3).
 *
 * This is the only authority that may permit a Market install in a locked
 * deployment. A target is allowed exactly when the provider's last verified
 * company manifest carries a matching `(packageName, version)` entry that is
 * not revoked and whose signed npm dist integrity equals the integrity the
 * service resolved from the allowed registry: the service feeds the
 * registry-verified integrity into {@link canInstall}, so the signed-manifest
 * chain and the registry-metadata chain must converge on the same digest
 * before anything is installed.
 *
 * Decisions are synchronous and read only the provider's in-memory verified
 * manifest ({@link SignedManifestPackageSource.findSignedPackage}); install
 * time never refetches the manifest or performs any network I/O. Revoked
 * entries stay queryable (unlike the browsing candidate stream, which
 * excludes them) so the rejection reason can distinguish a revoked entry
 * from an absent one.
 *
 * Fail-closed propagation: the embedding Host reports every failed manifest
 * verification — any `CompanyCatalogUntrustedError` caught around catalog
 * scans — through {@link SignedManifestInstallTargetAuthority.reportUntrustedCatalog}.
 * From that moment every decision fails closed with the recorded cause until
 * the source verifies a manifest again: a strictly newer sequence re-arms
 * the authority, and so does a fresh same-sequence verification (byte-level
 * recovery — the static origin went back to serving verified bytes after
 * the untrusted observation; the pre-report verification state itself never
 * re-arms). A sequence below the recorded floor is a rollback and never
 * re-arms. A manifest whose signed `expiresAt` has passed (checked against
 * the injected clock) is equally untrusted. Before the first verified scan
 * there is nothing to consult and every decision fails closed as well.
 */

import type { CompanyCatalogVerification } from '../catalog/company-provider.js'
import type { CompanyManifestPackage } from '../signing/index.js'
import type { InstallTargetAuthority, InstallTargetEvidence } from './service.js'

/**
 * Narrow read-only view of the signed company manifest state the authority
 * consults. `CompanyCatalogProvider` satisfies this structurally; Hosts may
 * inject any equivalent in-memory view.
 */
export interface SignedManifestPackageSource {
  /** Signed entry of the last verified manifest, revoked entries included. */
  findSignedPackage(packageName: string, version: string): CompanyManifestPackage | undefined
  /**
   * Summary of the last successful manifest verification, or undefined before
   * the first verified scan. The observation must be one stable object between
   * scans and a fresh one after each successful scan: recovery detection in
   * the authority compares observations by identity.
   */
  verification(): CompanyCatalogVerification | undefined
}

/** Options for {@link createSignedManifestInstallTargetAuthority}. */
export interface SignedManifestInstallTargetAuthorityOptions {
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Signed-manifest install whitelist with the untrusted-state propagation hook. */
export interface SignedManifestInstallTargetAuthority extends InstallTargetAuthority {
  /**
   * Record one failed manifest verification observed by the embedding Host
   * (the propagation strategy: forward every `CompanyCatalogUntrustedError`
   * caught around catalog scans). Every decision fails closed with the
   * recorded cause until the source verifies a manifest again: a strictly
   * newer sequence re-arms, and so does a fresh same-sequence verification
   * (byte-level recovery). The cause is only rendered into bounded rejection
   * reasons and never influences an allow decision.
   */
  reportUntrustedCatalog(cause: unknown): void
}

/** Render any reported cause into a bounded, control-character-free reason fragment. */
function boundedReason(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause)).replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  return text.length === 0 ? 'manifest verification failed' : text.slice(0, 240)
}

/**
 * Build the signed-manifest install whitelist over one verified-manifest
 * source. The returned authority is fail-closed by construction: absent,
 * revoked, mismatched, expired, or untrusted manifest state can only produce
 * `{allowed: false}` with the specific reason.
 */
export function createSignedManifestInstallTargetAuthority(
  source: SignedManifestPackageSource,
  options: SignedManifestInstallTargetAuthorityOptions = {},
): SignedManifestInstallTargetAuthority {
  if (
    source === null
    || typeof source !== 'object'
    || typeof source.findSignedPackage !== 'function'
    || typeof source.verification !== 'function'
  ) {
    throw new TypeError('signed manifest authority requires findSignedPackage and verification functions')
  }
  const now = options.now ?? Date.now
  let untrusted:
    | {
      readonly reason: string
      readonly sequence: number
      /** Verification state observed when the failure was reported; re-arm requires a fresher one. */
      readonly observation: CompanyCatalogVerification | undefined
    }
    | undefined
  return {
    canInstall(candidate) {
      const verification = source.verification()
      if (verification === undefined) {
        return { allowed: false, reason: 'no verified company manifest is available yet' }
      }
      if (untrusted !== undefined) {
        // Re-arm only on byte-level recovery: the source replaces its
        // verification observation exclusively after a scan that fully
        // verified again, so a different observation with a sequence at or
        // above the recorded floor means verified bytes came back — the
        // equal-sequence case is the static-origin steady state after an
        // interposed hijack. The pre-report observation itself never re-arms
        // (that would void the fail-closed propagation), and a sequence
        // below the floor is a rollback that stays locked.
        const recovered = verification !== untrusted.observation
          && verification.sequence >= untrusted.sequence
        if (!recovered) {
          return { allowed: false, reason: `the company catalog is not trusted: ${untrusted.reason}` }
        }
        untrusted = undefined
      }
      const expiresAtMs = Date.parse(verification.expiresAt)
      if (Number.isFinite(expiresAtMs) && now() >= expiresAtMs) {
        return { allowed: false, reason: `the verified company manifest expired at ${verification.expiresAt}` }
      }
      const entry = source.findSignedPackage(candidate.packageName, candidate.version)
      if (entry === undefined) {
        return {
          allowed: false,
          reason: `${candidate.packageName}@${candidate.version} is not in the signed company manifest`,
        }
      }
      if (entry.revoked) {
        return {
          allowed: false,
          reason: `${candidate.packageName}@${candidate.version} is revoked in the signed company manifest`,
        }
      }
      if (entry.integrity !== candidate.integrity) {
        return {
          allowed: false,
          reason: `the signed company manifest pins ${candidate.packageName}@${candidate.version} to integrity ${entry.integrity}, but the registry resolved ${candidate.integrity}`,
        }
      }
      const evidence: InstallTargetEvidence = {
        manifestSequence: verification.sequence,
        keyId: verification.keyId,
        // The optional signed approval list rides with the evidence so the
        // service can hand it to the package-manager boundary; entries
        // without the field contribute no key at all (gradual enablement).
        ...(entry.approvedBuilds === undefined ? {} : { approvedBuildDependencies: [...entry.approvedBuilds] }),
      }
      return { allowed: true, evidence }
    },
    reportUntrustedCatalog(cause) {
      const observation = source.verification()
      untrusted = { reason: boundedReason(cause), sequence: observation?.sequence ?? 0, observation }
    },
  }
}
