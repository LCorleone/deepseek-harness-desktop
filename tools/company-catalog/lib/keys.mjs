/**
 * Signing key handling. The private key exists only in the environment: it
 * is never read from a file path and never written to disk. The accepted
 * encoding is a single line of standard base64 holding the PKCS#8 DER
 * encoding of an ed25519 private key — exactly what `keygen` prints and what
 * secret managers hand to CI as COMPANY_CATALOG_SIGNING_KEY.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'

export const SIGNING_KEY_ENV = 'COMPANY_CATALOG_SIGNING_KEY'
export const KEY_ID_ENV = 'COMPANY_CATALOG_KEY_ID'
export const FINGERPRINT_ENV = 'COMPANY_CATALOG_KEY_FINGERPRINT'

export const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u

/** Decode one line of canonical standard base64; anything else is rejected. */
export function decodeBase64Strict(value, what) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\n') || value.includes(' ')) {
    throw new Error(`${what} must be a single line of standard base64`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error(`${what} is not standard base64`)
  const buffer = Buffer.from(value, 'base64')
  if (buffer.byteLength === 0 || buffer.toString('base64') !== value) {
    throw new Error(`${what} is not canonical standard base64`)
  }
  return buffer
}

/** Import the base64 PKCS#8 DER ed25519 private key carried by an environment variable. */
export function privateKeyFromBase64Pkcs8(encoded, what) {
  const der = decodeBase64Strict(encoded, what)
  let key
  try {
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } catch (error) {
    throw new Error(`${what} is not a base64 PKCS#8 DER private key (${error.message}); expected the value printed by 'keygen'`)
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${what} is a ${key.asymmetricKeyType ?? 'non-ed25519'} key; the catalog is signed with ed25519`)
  }
  return key
}

/**
 * Load signing material from the environment. `expectedFingerprint` is
 * present only when COMPANY_CATALOG_KEY_FINGERPRINT pins the deployment
 * trust root; when given, it must match the key or publishing aborts.
 */
export function loadSigningKeyFromEnv(env = process.env) {
  const encoded = env[SIGNING_KEY_ENV]
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error(
      `missing ${SIGNING_KEY_ENV}: set it to the base64 PKCS#8 DER ed25519 private key printed by 'keygen' ` +
      '(read from the environment only — the pipeline never reads key files and never writes keys to disk)',
    )
  }
  const keyId = env[KEY_ID_ENV]
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`missing or invalid ${KEY_ID_ENV}: keyId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`)
  }
  const fingerprint = env[FINGERPRINT_ENV]
  if (fingerprint !== undefined && !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error(`${FINGERPRINT_ENV} must be 64 lowercase hex characters (the keygen trust-root fingerprint)`)
  }
  const privateKey = privateKeyFromBase64Pkcs8(encoded, SIGNING_KEY_ENV)
  // Check the pin before any network or signing work: a wrong environment key
  // must abort immediately. The pipeline re-checks after signing as defense in depth.
  if (fingerprint !== undefined) {
    const derived = fingerprintOfRawPublicKey(rawPublicKeyBytes(createPublicKey(privateKey)))
    if (derived !== fingerprint) {
      throw new Error(
        `signing key fingerprint ${derived} does not match the pinned ${fingerprint} — ` +
        'the environment key is not the deployment trust root; publishing aborted',
      )
    }
  }
  return {
    privateKey,
    keyId,
    expectedFingerprint: fingerprint,
  }
}

/** Raw 32-byte public key of an ed25519 KeyObject. */
export function rawPublicKeyBytes(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('the ed25519 public key could not be exported')
  return Buffer.from(jwk.x, 'base64url')
}

/** SHA-256 fingerprint of a raw ed25519 public key: 64 lowercase hex characters. */
export function fingerprintOfRawPublicKey(raw) {
  if (raw.byteLength !== 32) throw new TypeError('a raw ed25519 public key is exactly 32 bytes')
  return createHash('sha256').update(raw).digest('hex')
}

/** Ephemeral key for selftest runs; exists only in memory for the process. */
export function createEphemeralKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey }
}

/** Fresh operator key pair plus every value the pipeline environment needs. */
export function generateSigningMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  const raw = rawPublicKeyBytes(publicKey)
  const now = new Date()
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1
  return {
    signingKey: der.toString('base64'),
    publicKey: raw.toString('base64'),
    fingerprint: fingerprintOfRawPublicKey(raw),
    suggestedKeyId: `company-catalog-${String(now.getUTCFullYear())}-q${String(quarter)}`,
  }
}
