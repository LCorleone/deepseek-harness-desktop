/** ed25519 trust-root helpers for company manifest verification. */

import { createHash, createPublicKey, type KeyObject } from 'node:crypto'

/**
 * One trusted manifest signing key. Structurally identical to the desktop
 * deployment policy trust root so locked builds can pass their pinned roots
 * straight through; this package never imports the desktop definition.
 */
export interface CompanyManifestTrustRoot {
  /** Stable identifier selecting among overlapping rotation keys. */
  readonly keyId: string
  /** Lowercase SHA-256 fingerprint (64 hex characters) of the raw ed25519 public key. */
  readonly fingerprint: string
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u

/** Whether a keyId matches the deployment policy trust-root identifier grammar. */
export function isCompanyManifestKeyId(keyId: unknown): keyId is string {
  return typeof keyId === 'string' && KEY_ID_PATTERN.test(keyId)
}

/** Extract the raw 32-byte ed25519 public key from a KeyObject. */
export function rawEd25519PublicKey(publicKey: KeyObject): Buffer {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('an ed25519 public KeyObject is required')
  }
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  if (typeof jwk.x !== 'string') {
    throw new TypeError('the ed25519 public key could not be exported')
  }
  return Buffer.from(jwk.x, 'base64url')
}

/** Rebuild an ed25519 public KeyObject from its raw 32-byte encoding. */
export function ed25519PublicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== 32) {
    throw new TypeError('a raw ed25519 public key is exactly 32 bytes')
  }
  const buffer = Buffer.from(raw)
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: buffer.toString('base64url') }, format: 'jwk' })
}

/** Derive the ed25519 public key of an ed25519 private KeyObject. */
export function ed25519PublicKeyOf(privateKey: KeyObject): KeyObject {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('an ed25519 private KeyObject is required')
  }
  return createPublicKey(privateKey)
}

/**
 * SHA-256 fingerprint of an ed25519 public key: 64 lowercase hex characters
 * over the raw 32-byte key encoding. Accepts a KeyObject or the raw bytes.
 */
export function ed25519PublicKeyFingerprint(publicKey: KeyObject | Uint8Array): string {
  const raw = publicKey instanceof Uint8Array ? Buffer.from(publicKey) : rawEd25519PublicKey(publicKey)
  if (raw.byteLength !== 32) {
    throw new TypeError('a raw ed25519 public key is exactly 32 bytes')
  }
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Validate and freeze trust roots. Mirrors the strict desktop policy parser:
 * entries are `{keyId, fingerprint}` objects only, with unique keyIds and
 * unique fingerprints; every deviation is a constructive `TypeError`.
 */
export function normalizeCompanyManifestTrustRoots(value: unknown): readonly CompanyManifestTrustRoot[] {
  if (!Array.isArray(value)) {
    throw new TypeError('trustRoots must be an array of {keyId, fingerprint} entries')
  }
  const trustRoots: CompanyManifestTrustRoot[] = []
  const keyIds = new Set<string>()
  const fingerprints = new Set<string>()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('trust roots must be objects')
    }
    const object = entry as Record<string, unknown>
    const keys = Object.keys(object).sort()
    if (keys.length !== 2 || keys[0] !== 'fingerprint' || keys[1] !== 'keyId') {
      throw new TypeError('trust roots must have exactly keyId and fingerprint fields')
    }
    const { keyId, fingerprint } = object
    if (!isCompanyManifestKeyId(keyId)) {
      throw new TypeError('trust root keyId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
    }
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new TypeError('trust root fingerprint must be 64 lowercase hex characters')
    }
    if (keyIds.has(keyId)) throw new TypeError(`duplicate trust root keyId ${keyId}`)
    if (fingerprints.has(fingerprint)) throw new TypeError('duplicate trust root fingerprint')
    keyIds.add(keyId)
    fingerprints.add(fingerprint)
    trustRoots.push(Object.freeze({ keyId, fingerprint }))
  }
  return Object.freeze(trustRoots)
}
