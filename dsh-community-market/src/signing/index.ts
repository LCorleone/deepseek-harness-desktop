/**
 * Signing and verification primitives for the company catalog manifest
 * (`docs/schemas/company-manifest.schema.json`). Pure functions only: node
 * `crypto` ed25519 over canonical JSON, trust-root key binding, monotonic
 * sequence and expiry freshness, and result-style failures that never throw
 * for business rejections.
 */

export { canonicalJsonText } from './canonical-json.js'
export {
  findCompanyManifestPackage,
  validateCompanyManifestShape,
  type CompanyManifestShape,
} from './company-manifest.js'
export {
  ed25519PublicKeyFingerprint,
  type CompanyManifestTrustRoot,
} from './keys.js'
export {
  createCompanyManifestSignature,
  verifyCompanyManifest,
  type CompanyManifestVerification,
  type CompanyManifestVerificationCode,
  type VerifyCompanyManifestOptions,
} from './verify.js'
export type {
  CompanyManifest,
  PackageEntry as CompanyManifestPackage,
  RuntimeRanges as CompanyManifestRuntimeRanges,
  SignatureBlock as CompanyManifestSignature,
} from '../contracts/generated/company-manifest.js'
