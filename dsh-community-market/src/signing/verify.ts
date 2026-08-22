/**
 * ed25519 verification of company manifests over canonical JSON.
 *
 * The signature is detached: the signed bytes are the canonical JSON text of
 * the manifest without its `signature` block, and the block itself carries
 * the keyId plus the raw public key. Verification binds the embedded key to
 * the deployment policy trust roots: some root must declare the same keyId,
 * and the SHA-256 fingerprint of the embedded key must equal that root's
 * pinned fingerprint. With overlapping rotation roots, a manifest signed by
 * any still-trusted key verifies.
 */

import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import type { CompanyManifest, SignatureBlock } from '../contracts/generated/company-manifest.js'
import { canonicalJsonText } from './canonical-json.js'
import { validateCompanyManifestShape } from './company-manifest.js'
import {
  ed25519PublicKeyFingerprint,
  ed25519PublicKeyFromRaw,
  ed25519PublicKeyOf,
  isCompanyManifestKeyId,
  normalizeCompanyManifestTrustRoots,
  rawEd25519PublicKey,
  type CompanyManifestTrustRoot,
} from './keys.js'

/** Why a company manifest was rejected; every failure carries a human-readable reason. */
export type CompanyManifestVerificationCode =
  | 'malformed-json'
  | 'non-canonical'
  | 'invalid-manifest'
  | 'unknown-key'
  | 'key-mismatch'
  | 'bad-signature'
  | 'stale-sequence'
  | 'expired'

export type CompanyManifestVerification =
  | {
    readonly ok: true
    /** The fully validated manifest, safe to read entries from (including revoked ones). */
    readonly manifest: CompanyManifest
    /** keyId of the trust root whose key produced the verified signature. */
    readonly keyId: string
    /** Fingerprint of the verified signing key, matching the pinned trust root. */
    readonly fingerprint: string
    /** Epoch milliseconds of the injected clock used for the expiry decision. */
    readonly verifiedAt: number
  }
  | {
    readonly ok: false
    readonly code: CompanyManifestVerificationCode
    readonly reason: string
  }

export interface VerifyCompanyManifestOptions {
  /** Policy-pinned signing keys; a manifest signed by any listed key verifies. */
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  /** Highest sequence the caller has previously verified; the manifest must strictly exceed it. */
  readonly lastSeenSequence?: number
  /** Clock injection, defaults to `Date.now`; the manifest must not be expired at this instant. */
  readonly now?: () => number
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function failure(code: CompanyManifestVerificationCode, reason: string): CompanyManifestVerification {
  return { ok: false, code, reason }
}

/**
 * Verify raw company manifest bytes end to end: JSON parsing, canonical byte
 * equality, schema and semantic validation, trust-root key binding, detached
 * ed25519 signature, monotonic sequence, and expiry. Business failures are
 * returned as `{ok: false, code, reason}` values; only invalid call arguments
 * throw `TypeError`.
 */
export function verifyCompanyManifest(
  raw: string | Uint8Array,
  options: VerifyCompanyManifestOptions,
): CompanyManifestVerification {
  const trustRoots = normalizeCompanyManifestTrustRoots(options.trustRoots)
  const lastSeenSequence = options.lastSeenSequence ?? 0
  if (!Number.isSafeInteger(lastSeenSequence) || lastSeenSequence < 0) {
    throw new TypeError('lastSeenSequence must be a safe non-negative integer')
  }
  const now = options.now ?? Date.now
  const verifiedAt = now()
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt)) {
    throw new TypeError('now must return a finite epoch millisecond timestamp')
  }

  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return failure('malformed-json', `company manifest is not valid JSON: ${messageOf(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('malformed-json', 'company manifest must be a JSON object')
  }

  let canonical: string
  try {
    canonical = canonicalJsonText(parsed)
  } catch (error) {
    return failure('non-canonical', messageOf(error))
  }
  if (canonical !== text) {
    return failure('non-canonical', 'company manifest bytes are not the canonical JSON serialization of their parsed value')
  }

  const shape = validateCompanyManifestShape(parsed)
  if (!shape.ok) return failure('invalid-manifest', shape.reason)
  const manifest = shape.manifest
  const signature = manifest.signature

  const root = trustRoots.find(entry => entry.keyId === signature.keyId)
  if (root === undefined) {
    return failure('unknown-key', `manifest keyId ${signature.keyId} is not in the trusted roots`)
  }
  const rawKey = Buffer.from(signature.publicKey, 'base64')
  if (rawKey.byteLength !== 32) {
    return failure('key-mismatch', 'the manifest signing key is not a raw 32-byte ed25519 public key')
  }
  const fingerprint = ed25519PublicKeyFingerprint(rawKey)
  if (fingerprint !== root.fingerprint) {
    return failure('key-mismatch', `manifest signing key fingerprint does not match the pinned fingerprint for keyId ${root.keyId}`)
  }

  // The signed window is the manifest minus the detached signature block.
  const unsigned = { ...(parsed as Record<string, unknown>) }
  delete unsigned.signature
  const signedBytes = Buffer.from(canonicalJsonText(unsigned), 'utf8')
  const signatureBytes = Buffer.from(signature.value, 'base64')
  if (signatureBytes.byteLength !== 64) {
    return failure('bad-signature', 'the detached ed25519 signature is not 64 bytes')
  }
  // node:crypto requires a null algorithm for Ed25519; the key carries the designation.
  const signatureOk = cryptoVerify(null, signedBytes, ed25519PublicKeyFromRaw(rawKey), signatureBytes)
  if (!signatureOk) {
    return failure('bad-signature', 'ed25519 signature verification failed')
  }

  if (manifest.sequence <= lastSeenSequence) {
    return failure(
      'stale-sequence',
      `manifest sequence ${manifest.sequence} does not exceed the last seen sequence ${lastSeenSequence}`,
    )
  }
  const expiresAtMs = Date.parse(manifest.expiresAt)
  if (Number.isNaN(expiresAtMs)) {
    return failure('invalid-manifest', `expiresAt ${manifest.expiresAt} is not a parseable RFC 3339 timestamp`)
  }
  if (verifiedAt >= expiresAtMs) {
    return failure('expired', `company manifest expired at ${manifest.expiresAt}`)
  }

  return { ok: true, manifest, keyId: root.keyId, fingerprint, verifiedAt }
}

/**
 * Sign-side primitive for the publishing pipeline and round-trip tests: sign
 * the canonical detached window of an unsigned manifest and return its
 * signature block. The manifest is signed exactly as given; callers are
 * responsible for schema-validating their content first. Constructive errors
 * (non-ed25519 key, invalid keyId, non-canonicalizable content) throw
 * `TypeError`.
 */
export function createCompanyManifestSignature(
  manifest: Omit<CompanyManifest, 'signature'>,
  privateKey: KeyObject,
  keyId: string,
): SignatureBlock {
  if (!isCompanyManifestKeyId(keyId)) {
    throw new TypeError('keyId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
  }
  const publicKey = ed25519PublicKeyOf(privateKey)
  const signedBytes = Buffer.from(canonicalJsonText(manifest), 'utf8')
  const value = cryptoSign(null, signedBytes, privateKey)
  return { keyId, publicKey: rawEd25519PublicKey(publicKey).toString('base64'), value: value.toString('base64') }
}
