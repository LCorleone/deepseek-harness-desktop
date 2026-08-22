/**
 * Manifest assembly, signing, verification, and publication state. The
 * market signing library owns every crypto decision; this module only
 * sequences the flow: assemble → sign → fingerprint check → canonical
 * serialize → full round-trip verification → write manifest → bump state.
 * Nothing is written until the signed manifest verifies end to end.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { entryKey } from './allowlist.mjs'
import { fingerprintOfRawPublicKey } from './keys.mjs'

export const MANIFEST_VERSION = '1.0.0'
export const STATE_FILE_NAME = 'last-sequence.json'
const DAY_MS = 86_400_000

/** Read the persisted highest published sequence; a missing state starts at 0. */
export function readLastSequence(stateDir) {
  const file = join(stateDir, STATE_FILE_NAME)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${error.message}) — the sequence must never be guessed; restore or explicitly reset the state`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must be an object with an integer lastSequence`)
  }
  const value = parsed.lastSequence
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${file}: lastSequence must be a safe non-negative integer`)
  }
  return value
}

/** Persist the new highest sequence after a verified publication. */
export function writeLastSequence(stateDir, sequence) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, STATE_FILE_NAME),
    `${JSON.stringify({ lastSequence: sequence, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

/** Resolve the sequence to publish: explicit or persisted+1, strictly monotonic. */
export function resolveSequence(explicit, lastSequence) {
  const sequence = explicit ?? lastSequence + 1
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`sequence must be a positive safe integer (got ${String(explicit)})`)
  }
  if (sequence <= lastSequence) {
    throw new Error(`sequence ${String(sequence)} does not exceed the persisted last sequence ${String(lastSequence)}; monotonicity is mandatory`)
  }
  return sequence
}

/** expiresAt instant for a horizon in days (default 90). */
export function expiryFromDays(days = 90) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new Error(`expires days must be an integer between 1 and 3650 (got ${String(days)})`)
  }
  return new Date(Date.now() + days * DAY_MS)
}

/**
 * Assemble the unsigned manifest from allowlist entries and their registry
 * dist values. Entries are sorted by (packageName, version) so output is
 * deterministic for reviewing and diffing.
 */
export function assembleUnsignedManifest({ sequence, expiresAt, entries, dists }) {
  const packages = [...entries]
    .sort((a, b) => (a.packageName === b.packageName
      ? (a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
      : (a.packageName < b.packageName ? -1 : 1)))
    .map((entry) => {
      const dist = dists.get(entryKey(entry))
      if (dist === undefined) {
        throw new Error(`no registry dist was resolved for ${entryKey(entry)}`)
      }
      return {
        packageName: entry.packageName,
        version: entry.version,
        integrity: dist.integrity,
        bundlePatch: entry.bundlePatch,
        revoked: entry.revoked,
        runtime: entry.runtime,
      }
    })
  if (typeof expiresAt === 'string' ? Number.isNaN(Date.parse(expiresAt)) : !(expiresAt instanceof Date)) {
    throw new TypeError('expiresAt must be a Date or an RFC 3339 string')
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    sequence,
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
    packages,
  }
}

/**
 * Sign the unsigned manifest and check the optional pinned fingerprint.
 * Returns the signed manifest, its canonical bytes (no trailing newline —
 * verification requires byte-exact canonical form), and the key fingerprint.
 */
export function signUnsignedManifest(market, unsigned, privateKey, keyId, expectedFingerprint) {
  const signature = market.createCompanyManifestSignature(unsigned, privateKey, keyId)
  const fingerprint = market.ed25519PublicKeyFingerprint(Buffer.from(signature.publicKey, 'base64'))
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    throw new Error(
      `signing key fingerprint ${fingerprint} does not match the pinned ${expectedFingerprint} — ` +
      'the environment key is not the deployment trust root; publishing aborted',
    )
  }
  const manifest = { ...unsigned, signature }
  return { manifest, text: market.canonicalJsonText(manifest), fingerprint }
}

/**
 * Verify manifest bytes exactly the way clients do, with the given trust
 * root, anti-rollback floor, and clock.
 */
export function verifyManifestText(market, text, { fingerprint, keyId, lastSeenSequence = 0, now }) {
  return market.verifyCompanyManifest(text, {
    trustRoots: [{ keyId, fingerprint }],
    lastSeenSequence,
    ...(now === undefined ? {} : { now }),
  })
}

/**
 * Publish: sign, verify the full chain (canonical bytes, schema, semantics,
 * trust root, signature, strict sequence increase, expiry), then write the
 * manifest and bump the persisted sequence. Throws before writing anything
 * if any step fails.
 */
export function publishManifest({
  market,
  entries,
  dists,
  sequence,
  expiresAt,
  privateKey,
  keyId,
  expectedFingerprint,
  lastSeenSequence,
  outPath,
  stateDir,
}) {
  const unsigned = assembleUnsignedManifest({ sequence, expiresAt, entries, dists })
  const { manifest, text, fingerprint } = signUnsignedManifest(market, unsigned, privateKey, keyId, expectedFingerprint)
  const verification = verifyManifestText(market, text, { fingerprint, keyId, lastSeenSequence })
  if (!verification.ok) {
    throw new Error(`verification failed before publish (${verification.code}): ${verification.reason}`)
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, text, 'utf8')
  writeLastSequence(stateDir, sequence)
  return { manifest, text, fingerprint, verification }
}
