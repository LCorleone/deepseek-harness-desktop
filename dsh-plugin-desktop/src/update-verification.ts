/**
 * Detached ed25519 verification primitives and trust roots for the DSH
 * Desktop update channel (security plan P3-3).
 *
 * The update channel is signed by keys that are completely independent from
 * the company catalog keys pinned in `DesktopPolicy.trustRoots` (P2-7
 * decision): compromising one channel never weakens the other. Both channels
 * share the same trust-root shape — `{keyId, fingerprint}`, where the
 * fingerprint is the SHA-256 of the raw 32-byte ed25519 public key — so the
 * same dual-key rotation procedure applies and a future migration of the
 * private keys into KMS/HSM needs zero client changes (the client only pins
 * public-key fingerprints).
 *
 * Signatures are detached ed25519 over the original bytes. Update artifacts
 * are binaries and manifest bytes are verified exactly as fetched, so no
 * canonical serialization exists anywhere in this channel.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** One trusted update-channel signing key; structurally identical to a catalog trust root. */
export interface UpdateChannelTrustRoot {
  /** Stable identifier selecting among overlapping rotation keys. */
  readonly keyId: string
  /** Lowercase SHA-256 fingerprint (64 hex characters) of the raw ed25519 public key. */
  readonly fingerprint: string
}

/**
 * Update-channel trust roots embedded at build time.
 *
 * Placeholder: empty in development builds. An empty array makes every update
 * operation skip signature verification and log a warning; a non-empty array
 * is strictly fail-closed (any verification failure rejects the update).
 * Company release builds replace this constant with their pinned keys — the
 * P3-4 release gate owns that swap, and `tests/update-verification.spec.ts`
 * exercises the strict path by injecting roots instead.
 *
 * Rotation is dual-key overlap, exactly like the catalog channel: append the
 * new `{keyId, fingerprint}` while the old key still signs releases, publish
 * manifests under the new key, then remove the old root in a later release.
 * `fingerprints` must stay unique so one key can never hide under two ids.
 */
export const ARTIFACT_TRUST_ROOTS: readonly UpdateChannelTrustRoot[] = [] // development placeholder — company release builds replace this array (P3-4 gate marker)

/** Detached ed25519 signatures are exactly 64 bytes. */
export const UPDATE_CHANNEL_SIGNATURE_BYTES = 64

/** Raw ed25519 public keys are exactly 32 bytes. */
export const UPDATE_CHANNEL_PUBLIC_KEY_BYTES = 32

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

/** Why a detached update-channel signature was rejected. */
export type UpdateSignatureFailureCode =
  | 'unknown-key'
  | 'invalid-public-key'
  | 'key-mismatch'
  | 'invalid-signature-encoding'
  | 'bad-signature'

/** Result of verifying one detached update-channel signature. */
export type UpdateSignatureVerification =
  | {
    readonly ok: true
    /** keyId of the trust root whose pinned fingerprint matched the verified key. */
    readonly keyId: string
    /** Fingerprint of the verified key, equal to the pinned root fingerprint. */
    readonly fingerprint: string
  }
  | {
    readonly ok: false
    readonly code: UpdateSignatureFailureCode
    readonly reason: string
  }

/** Whether a keyId matches the update-channel trust-root identifier grammar. */
export function isUpdateChannelKeyId(keyId: unknown): keyId is string {
  return typeof keyId === 'string' && KEY_ID_PATTERN.test(keyId)
}

/**
 * Validate and freeze update-channel trust roots. Mirrors the strict catalog
 * parsers: entries are `{keyId, fingerprint}` objects only, with unique keyIds
 * and unique fingerprints; every deviation is a constructive `TypeError`.
 */
export function normalizeUpdateChannelTrustRoots(value: unknown): readonly UpdateChannelTrustRoot[] {
  if (!Array.isArray(value)) {
    throw new TypeError('update trust roots must be an array of {keyId, fingerprint} entries')
  }
  const trustRoots: UpdateChannelTrustRoot[] = []
  const keyIds = new Set<string>()
  const fingerprints = new Set<string>()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('update trust roots must be objects')
    }
    const object = entry as Record<string, unknown>
    const keys = Object.keys(object).sort()
    if (keys.length !== 2 || keys[0] !== 'fingerprint' || keys[1] !== 'keyId') {
      throw new TypeError('update trust roots must have exactly keyId and fingerprint fields')
    }
    const { keyId, fingerprint } = object
    if (!isUpdateChannelKeyId(keyId)) {
      throw new TypeError('update trust root keyId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
    }
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new TypeError('update trust root fingerprint must be 64 lowercase hex characters')
    }
    if (keyIds.has(keyId)) throw new TypeError(`duplicate update trust root keyId ${keyId}`)
    if (fingerprints.has(fingerprint)) throw new TypeError('duplicate update trust root fingerprint')
    keyIds.add(keyId)
    fingerprints.add(fingerprint)
    trustRoots.push(Object.freeze({ keyId, fingerprint }))
  }
  return Object.freeze(trustRoots)
}

/**
 * SHA-256 fingerprint of a raw ed25519 public key: 64 lowercase hex characters
 * over the raw 32-byte encoding, identical to the catalog channel fingerprints.
 */
export function ed25519RawKeyFingerprint(raw: Uint8Array): string {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== UPDATE_CHANNEL_PUBLIC_KEY_BYTES) {
    throw new TypeError('a raw ed25519 public key is exactly 32 bytes')
  }
  return createHash('sha256').update(raw).digest('hex')
}

function decodeStrictBase64(text: string, expectedBytes: number): Buffer | undefined {
  const trimmed = text.trim()
  if (!BASE64_PATTERN.test(trimmed)) return undefined
  const bytes = Buffer.from(trimmed, 'base64')
  if (bytes.byteLength !== expectedBytes) return undefined
  return bytes
}

/**
 * Verify one detached ed25519 signature over the original content bytes.
 *
 * The keyId selects a trust root, the SHA-256 fingerprint of the delivered
 * public key must equal that root's pinned fingerprint, and only then does
 * the ed25519 verification run. With overlapping rotation roots, content
 * signed by any still-trusted key verifies. Business failures are result
 * values; only invalid call arguments throw.
 */
export function verifyDetachedUpdateSignature(input: {
  /** Original bytes that were signed. */
  readonly content: Uint8Array
  /** Base64 detached signature, optionally surrounded by ASCII whitespace. */
  readonly signatureBase64: string
  /** keyId declared by the signed channel material. */
  readonly keyId: string
  /** Base64 raw 32-byte ed25519 public key delivered by the signed channel material. */
  readonly publicKeyBase64: string
  /** Pinned trust roots; the keyId must select one of them. */
  readonly trustRoots: readonly UpdateChannelTrustRoot[]
}): UpdateSignatureVerification {
  const trustRoots = normalizeUpdateChannelTrustRoots(input.trustRoots)
  if (!isUpdateChannelKeyId(input.keyId)) {
    return { ok: false, code: 'unknown-key', reason: `update keyId ${String(input.keyId)} is not valid` }
  }
  const root = trustRoots.find(entry => entry.keyId === input.keyId)
  if (root === undefined) {
    return { ok: false, code: 'unknown-key', reason: `update keyId ${input.keyId} is not in the trusted roots` }
  }
  if (typeof input.publicKeyBase64 !== 'string') {
    return { ok: false, code: 'invalid-public-key', reason: 'the update signing key is not base64 text' }
  }
  const rawKey = decodeStrictBase64(input.publicKeyBase64, UPDATE_CHANNEL_PUBLIC_KEY_BYTES)
  if (rawKey === undefined) {
    return {
      ok: false,
      code: 'invalid-public-key',
      reason: 'the update signing key is not a raw 32-byte ed25519 public key',
    }
  }
  const fingerprint = ed25519RawKeyFingerprint(rawKey)
  if (fingerprint !== root.fingerprint) {
    return {
      ok: false,
      code: 'key-mismatch',
      reason: `the update signing key fingerprint does not match the pinned fingerprint for keyId ${root.keyId}`,
    }
  }
  if (typeof input.signatureBase64 !== 'string') {
    return { ok: false, code: 'invalid-signature-encoding', reason: 'the detached signature is not base64 text' }
  }
  const signatureBytes = decodeStrictBase64(input.signatureBase64, UPDATE_CHANNEL_SIGNATURE_BYTES)
  if (signatureBytes === undefined) {
    return { ok: false, code: 'invalid-signature-encoding', reason: 'the detached ed25519 signature is not 64 bytes' }
  }
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') },
    format: 'jwk',
  })
  // node:crypto requires a null algorithm for Ed25519; the key carries the designation.
  const verified = cryptoVerify(null, Buffer.from(input.content), publicKey, signatureBytes)
  if (!verified) {
    return { ok: false, code: 'bad-signature', reason: 'ed25519 signature verification failed' }
  }
  return { ok: true, keyId: root.keyId, fingerprint }
}

/**
 * Warn that one update operation is running without signature verification
 * because no update-channel trust roots are embedded (development build).
 * Company release builds replace `ARTIFACT_TRUST_ROOTS` (P3-4 release gate).
 * @param operation - short description of the skipping operation.
 */
export function warnSkippedUpdateSignatureVerification(operation: string): void {
  console.warn(
    `dsh-plugin-desktop: ${operation} runs without signature verification`
      + ' because ARTIFACT_TRUST_ROOTS is empty (development build);'
      + ' embed update-channel trust roots in release builds (P3-4).',
  )
}
