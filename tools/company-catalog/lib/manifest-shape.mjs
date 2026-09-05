/**
 * Dual-channel company-manifest verification (P7): the strict schema mirror
 * of `dsh-community-market/docs/schemas/company-manifest.schema.json` plus the
 * one recognized extension — an optional per-entry `source` field selecting
 * the install channel:
 *
 *   `source` absent or {"kind":"npm"}            → the public npm channel
 *   {"kind":"tarball","url":…,"integrity":…}     → the intranet tarball channel
 *
 * The market library's `verifyCompanyManifest` stays the verifier for
 * `source`-free manifests (same accept/reject decisions — the shape rules
 * here mirror it key for key), but it rejects any `source`-carrying manifest
 * whole (`additionalProperties:false`), which is exactly the fleet gate the
 * publication runbook documents. This module is the tool-side verifier that
 * can sign and round-trip the extended form; the desktop's
 * `verifyDesktopCompanyManifest` (dsh-plugin-desktop/src/desktop-market.ts) is
 * the client-side twin — keep the two mirrors in sync. The beta channel
 * (P9) adds the same one-extension discipline on top: `channel: 'beta'`
 * admits an optional top-level `testers` roster (see lib/beta-roster.mjs);
 * the stable channel keeps the exact previous key set, so a
 * testers-carrying document never verifies as stable.
 *
 * Plain Node: canonical JSON and the ed25519 fingerprint come from the market
 * library, the node-semver grammar from the market workspace's own dependency
 * tree; everything else is Node built-ins.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

const MANIFEST_KEYS = ['expiresAt', 'manifestVersion', 'packages', 'sequence', 'signature']
/** The beta channel adds exactly one recognized top-level key: the `testers` roster (P9). */
const MANIFEST_BETA_KEYS = ['expiresAt', 'manifestVersion', 'packages', 'sequence', 'signature', 'testers']
const ENTRY_REQUIRED_KEYS = ['bundlePatch', 'integrity', 'packageName', 'repository', 'revoked', 'runtime', 'version']
const ENTRY_OPTIONAL_KEYS = ['approvedBuilds', 'source', 'treeDigest']
const SIGNATURE_KEYS = ['keyId', 'publicKey', 'value']
const RUNTIME_KEYS = ['cordisRuntimeVersion', 'dshRuntimeVersion', 'nodeRuntimeVersion']
const REPOSITORY_KEYS = ['subdirectory', 'url']
const TARBALL_SOURCE_KEYS = ['integrity', 'kind', 'url']
const NPM_SOURCE_KEYS = ['kind']

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const STABLE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u
const TREE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u
// `expiresAt` format gate: a faithful port of ajv-formats' full `date-time`
// (3.0.1) — the operative definition of the market schema's "RFC 3339"
// note — kept in sync with the desktop twin in
// dsh-plugin-desktop/src/desktop-market.ts. V8's lenient `Date.parse` alone
// admitted spellings the market verifier rejects (e.g. RFC-1123), so the
// publishing tool would have signed an expiresAt every field-unaware client
// rejects the whole manifest over.
const MARKET_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const MARKET_DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const MARKET_TIME_PATTERN = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2})(?::?(\d{2}))?)?$/iu

const isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

function isMarketDate(text) {
  const matches = MARKET_DATE_PATTERN.exec(text)
  if (matches === null) return false
  const year = Number(matches[1])
  const month = Number(matches[2])
  const day = Number(matches[3])
  return month >= 1 && month <= 12
    && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : MARKET_DAYS_IN_MONTH[month])
}

function isMarketStrictTime(text) {
  const matches = MARKET_TIME_PATTERN.exec(text)
  if (matches === null) return false
  const hour = Number(matches[1])
  const minute = Number(matches[2])
  const second = Number(matches[3])
  const zone = matches[4]
  const sign = matches[5] === '-' ? -1 : 1
  const zoneHours = Number(matches[6] ?? 0)
  const zoneMinutes = Number(matches[7] ?? 0)
  if (zoneHours > 23 || zoneMinutes > 59 || zone === undefined) return false
  if (hour <= 23 && minute <= 59 && second < 60) return true
  const utcMinute = minute - zoneMinutes * sign
  const utcHour = hour - zoneHours * sign - (utcMinute < 0 ? 1 : 0)
  return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1) && second < 61
}

function isMarketDateTimeFormat(text) {
  const parts = text.split(/t|\s/iu)
  if (parts.length !== 2) return false
  return isMarketDate(parts[0]) && isMarketStrictTime(parts[1])
}
const SIGNATURE_VALUE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u
const HTTPS_URI_PATTERN = /^https:\/\/(?![^/?#]*@)(?![^/?#]*:)[^#]+$/u
const BUNDLE_PATCH_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u
const REPOSITORY_SUBDIRECTORY_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/u

const MAX_PACKAGE_NAME_LENGTH = 214
const MAX_PACKAGES = 10_000
const MAX_APPROVED_BUILDS = 128
const MAX_URI_LENGTH = 2048
const MAX_SEQUENCE = 9_007_199_254_740_991
/** Email shape admitted to the beta `testers` roster (mirrors the desktop twin in desktop-market.ts). */
const BETA_TESTER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const MAX_BETA_TESTERS = 1_000
const MAX_BETA_TESTER_EMAIL_LENGTH = 254

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const unknownFields = (value, allowed) => Object.keys(value).filter((key) => !allowed.includes(key))

const isSha512Integrity = (value) => {
  if (typeof value !== 'string' || !SHA512_INTEGRITY_PATTERN.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

const isSafeBundlePatchPath = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (BUNDLE_PATCH_FORBIDDEN.test(value) || value.includes('\\')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

const isHttpsUri = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URI_LENGTH) return false
  if (!HTTPS_URI_PATTERN.test(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Validate one entry's `source` channel selection; every failure names the entry. */
function parseEntrySource(source, at, companyCatalogOrigin) {
  if (source === undefined) return { kind: 'npm' }
  if (!isPlainObject(source)) throw new Error(`${at}.source must be an object`)
  const kind = source.kind
  if (kind === 'npm') {
    const unknown = unknownFields(source, NPM_SOURCE_KEYS)
    if (unknown.length > 0) {
      throw new Error(`${at}.source is the npm channel and must not carry ${unknown.join(', ')}`)
    }
    return { kind: 'npm' }
  }
  if (kind !== 'tarball') throw new Error(`${at}.source.kind must be 'npm' or 'tarball'`)
  const unknown = unknownFields(source, TARBALL_SOURCE_KEYS)
  if (unknown.length > 0) throw new Error(`${at}.source has unknown field(s) ${unknown.join(', ')}`)
  if (!isHttpsUri(source.url)) throw new Error(`${at}.source.url must be a credential-free https URL without a fragment or an explicit port`)
  if (companyCatalogOrigin === undefined) {
    throw new Error(`${at}.source is the tarball channel, which requires the company catalog origin (--catalog-origin / ${'COMPANY_CATALOG_ORIGIN'})`)
  }
  let origin
  try {
    origin = new URL(source.url).origin
  } catch {
    throw new Error(`${at}.source.url is not a parseable URL`)
  }
  if (origin !== companyCatalogOrigin) {
    throw new Error(`${at}.source.url origin ${origin} is not the company catalog origin ${companyCatalogOrigin}`)
  }
  if (!isSha512Integrity(source.integrity)) {
    throw new Error(`${at}.source.integrity must be the base64 SHA-512 digest of the tarball file`)
  }
  return { kind: 'tarball', url: source.url, integrity: source.integrity }
}

/**
 * Validate a parsed value against the dual-channel schema mirror and return
 * the normalized manifest; anything outside the contract throws with the
 * offending path, so one unknown key rejects the whole manifest exactly like
 * the market verifier treats a `source`-free document.
 *
 * `channel: 'beta'` (P9) admits exactly one additional top-level key — the
 * optional `testers` roster — whose entries must be well-formed emails and
 * are normalized to lowercase (an uppercase entry is a spelling variant, not
 * a forgery); duplicates reject. The stable channel keeps the exact previous
 * key set, so a testers-carrying document never verifies as stable — the
 * same one-channel-one-schema rule as the desktop twin
 * (`verifyDesktopCompanyManifest`'s `channel` option). Keep the mirrors in
 * sync.
 */
export function validateCompanyManifestShapeWithSources(value, { companyCatalogOrigin, validRange, channel = 'stable' } = {}) {
  if (typeof validRange !== 'function') {
    throw new TypeError('validateCompanyManifestShapeWithSources requires the node-semver validRange checker (loadSemverRangeChecker)')
  }
  if (channel !== 'stable' && channel !== 'beta') {
    throw new TypeError(`the manifest channel must be 'stable' or 'beta' (got '${String(channel)}')`)
  }
  if (!isPlainObject(value)) throw new Error('the company manifest must be a JSON object')
  {
    const allowedKeys = channel === 'beta' ? MANIFEST_BETA_KEYS : MANIFEST_KEYS
    const unknown = unknownFields(value, allowedKeys)
    if (unknown.length > 0) throw new Error(`the company manifest has unknown field(s) ${unknown.join(', ')}`)
    for (const key of MANIFEST_KEYS) {
      if (!(key in value)) throw new Error(`the company manifest is missing ${key}`)
    }
  }
  let testers
  if (channel === 'beta' && value.testers !== undefined) {
    if (!Array.isArray(value.testers)) throw new Error('the beta company manifest testers must be an array of email addresses')
    if (value.testers.length > MAX_BETA_TESTERS) {
      throw new Error(`the beta company manifest testers must carry at most ${String(MAX_BETA_TESTERS)} entries`)
    }
    testers = []
    const seen = new Set()
    for (const entry of value.testers) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_BETA_TESTER_EMAIL_LENGTH
        || !BETA_TESTER_EMAIL_PATTERN.test(entry)) {
        throw new Error('the beta company manifest testers entries must be well-formed email addresses')
      }
      const lowered = entry.toLowerCase()
      if (seen.has(lowered)) throw new Error(`the beta company manifest testers must not repeat ${lowered}`)
      seen.add(lowered)
      testers.push(lowered)
    }
  }
  if (value.manifestVersion !== '1.0.0') throw new Error('the company manifest version must be 1.0.0')
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > MAX_SEQUENCE) {
    throw new Error('the company manifest sequence must be a safe positive integer')
  }
  if (typeof value.expiresAt !== 'string' || value.expiresAt.length < 20 || value.expiresAt.length > 64
    || !isMarketDateTimeFormat(value.expiresAt)
    || Number.isNaN(Date.parse(value.expiresAt))) {
    throw new Error('the company manifest expiresAt must be an RFC 3339 timestamp')
  }
  if (!Array.isArray(value.packages) || value.packages.length > MAX_PACKAGES) {
    throw new Error(`the company manifest packages must be an array of at most ${String(MAX_PACKAGES)} entries`)
  }
  if (!isPlainObject(value.signature)) throw new Error('the company manifest signature must be an object')
  {
    const unknown = unknownFields(value.signature, SIGNATURE_KEYS)
    if (unknown.length > 0) throw new Error(`the company manifest signature has unknown field(s) ${unknown.join(', ')}`)
    for (const key of SIGNATURE_KEYS) {
      if (!(key in value.signature)) throw new Error(`the company manifest signature is missing ${key}`)
    }
    if (typeof value.signature.keyId !== 'string' || !KEY_ID_PATTERN.test(value.signature.keyId)) {
      throw new Error('the company manifest signature keyId is invalid')
    }
    if (typeof value.signature.publicKey !== 'string' || !PUBLIC_KEY_PATTERN.test(value.signature.publicKey)) {
      throw new Error('the company manifest signature publicKey must be the base64 of a raw 32-byte ed25519 key')
    }
    if (typeof value.signature.value !== 'string' || !SIGNATURE_VALUE_PATTERN.test(value.signature.value)) {
      throw new Error('the company manifest signature value must be the base64 of a 64-byte ed25519 signature')
    }
  }
  const seen = new Set()
  const packages = []
  for (const [index, rawEntry] of value.packages.entries()) {
    const at = `packages[${String(index)}]`
    if (!isPlainObject(rawEntry)) throw new Error(`${at} must be an object`)
    const unknown = unknownFields(rawEntry, [...ENTRY_REQUIRED_KEYS, ...ENTRY_OPTIONAL_KEYS])
    if (unknown.length > 0) throw new Error(`${at} has unknown field(s) ${unknown.join(', ')} — the whole manifest is rejected`)
    for (const key of ENTRY_REQUIRED_KEYS) {
      if (!(key in rawEntry)) throw new Error(`${at} is missing ${key}`)
    }
    if (typeof rawEntry.packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(rawEntry.packageName)
      || rawEntry.packageName.length > MAX_PACKAGE_NAME_LENGTH) {
      throw new Error(`${at}.packageName must be an npm package name (scoped names allowed, lowercase)`)
    }
    if (typeof rawEntry.version !== 'string' || !STABLE_VERSION_PATTERN.test(rawEntry.version)) {
      throw new Error(`${at}.version must be an exact stable semver (X.Y.Z)`)
    }
    if (!isSha512Integrity(rawEntry.integrity)) {
      throw new Error(`${at}.integrity must be the base64 SHA-512 digest of the package tarball`)
    }
    if (typeof rawEntry.bundlePatch !== 'string' || !isSafeBundlePatchPath(rawEntry.bundlePatch)) {
      throw new Error(`${at}.bundlePatch must be a safe relative path inside the package`)
    }
    if (typeof rawEntry.revoked !== 'boolean') throw new Error(`${at}.revoked must be a boolean`)
    if (!isPlainObject(rawEntry.repository)) throw new Error(`${at}.repository must be an object`)
    {
      const repositoryUnknown = unknownFields(rawEntry.repository, REPOSITORY_KEYS)
      if (repositoryUnknown.length > 0) throw new Error(`${at}.repository has unknown field(s) ${repositoryUnknown.join(', ')}`)
      if (!isHttpsUri(rawEntry.repository.url)) throw new Error(`${at}.repository.url must be a credential-free https URL without a fragment or an explicit port`)
      if (rawEntry.repository.subdirectory !== undefined
        && (typeof rawEntry.repository.subdirectory !== 'string'
          || rawEntry.repository.subdirectory.length < 1 || rawEntry.repository.subdirectory.length > 240
          || !REPOSITORY_SUBDIRECTORY_PATTERN.test(rawEntry.repository.subdirectory))) {
        throw new Error(`${at}.repository.subdirectory is invalid`)
      }
    }
    if (!isPlainObject(rawEntry.runtime)) throw new Error(`${at}.runtime must be an object`)
    const runtime = {}
    {
      const runtimeUnknown = unknownFields(rawEntry.runtime, RUNTIME_KEYS)
      if (runtimeUnknown.length > 0) throw new Error(`${at}.runtime has unknown field(s) ${runtimeUnknown.join(', ')}`)
      for (const field of RUNTIME_KEYS) {
        const range = rawEntry.runtime[field]
        if (range === undefined) continue
        if (typeof range !== 'string' || range.length === 0 || range.length > 256 || validRange(range) === null) {
          throw new Error(`${at}.runtime.${field} is not a valid node-semver range`)
        }
        runtime[field] = range
      }
      if (typeof runtime.dshRuntimeVersion !== 'string') throw new Error(`${at}.runtime.dshRuntimeVersion is required`)
    }
    if (rawEntry.treeDigest !== undefined
      && (typeof rawEntry.treeDigest !== 'string' || !TREE_DIGEST_PATTERN.test(rawEntry.treeDigest))) {
      throw new Error(`${at}.treeDigest must be 64 lowercase hex characters`)
    }
    if (rawEntry.approvedBuilds !== undefined) {
      if (!Array.isArray(rawEntry.approvedBuilds) || rawEntry.approvedBuilds.length < 1
        || rawEntry.approvedBuilds.length > MAX_APPROVED_BUILDS) {
        throw new Error(`${at}.approvedBuilds must be a non-empty array of at most ${String(MAX_APPROVED_BUILDS)} names`)
      }
      const builds = new Set()
      for (const name of rawEntry.approvedBuilds) {
        if (typeof name !== 'string' || !PACKAGE_NAME_PATTERN.test(name) || name.length > MAX_PACKAGE_NAME_LENGTH) {
          throw new Error(`${at}.approvedBuilds entries must be npm dependency names`)
        }
        if (builds.has(name)) throw new Error(`${at}.approvedBuilds must not repeat ${name}`)
        builds.add(name)
      }
    }
    const source = parseEntrySource(rawEntry.source, at, companyCatalogOrigin)
    if (source.kind === 'tarball' && rawEntry.integrity !== source.integrity) {
      throw new Error(
        `${at} pins integrity ${String(rawEntry.integrity).slice(0, 24)}… but its tarball source pins ${source.integrity.slice(0, 24)}… — ` +
        "a tarball-channel entry must pin the tarball file's own sha512, because that is the integrity the profile lockfile records for a file: install",
      )
    }
    const identity = `${rawEntry.packageName}\0${rawEntry.version}`
    if (seen.has(identity)) throw new Error(`${at} duplicates the signed entry for ${rawEntry.packageName}@${rawEntry.version}`)
    seen.add(identity)
    packages.push({
      packageName: rawEntry.packageName,
      version: rawEntry.version,
      integrity: rawEntry.integrity,
      bundlePatch: rawEntry.bundlePatch,
      repository: rawEntry.repository,
      revoked: rawEntry.revoked,
      runtime,
      ...(rawEntry.treeDigest === undefined ? {} : { treeDigest: rawEntry.treeDigest }),
      ...(rawEntry.approvedBuilds === undefined ? {} : { approvedBuilds: rawEntry.approvedBuilds }),
      ...(rawEntry.source === undefined ? {} : { source }),
    })
  }
  return {
    manifestVersion: '1.0.0',
    sequence: value.sequence,
    expiresAt: value.expiresAt,
    packages,
    ...(testers === undefined ? {} : { testers }),
    signature: value.signature,
  }
}

/** DER SPKI prefix of a raw 32-byte ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/**
 * Verify the detached ed25519 signature over the canonical unsigned window of
 * an already-canonicalized manifest, under the given trust root. Mirrors the
 * market verifier's trust binding: the embedded keyId selects the root, and
 * the SHA-256 fingerprint of the embedded raw public key must equal the
 * root's pinned fingerprint.
 */
export function verifyManifestSignature(market, parsed, signature, trustRoot) {
  const rawKey = Buffer.from(signature.publicKey, 'base64')
  if (rawKey.byteLength !== 32) {
    return { ok: false, code: 'key-mismatch', reason: 'the manifest signing key is not a raw 32-byte ed25519 public key' }
  }
  const fingerprint = market.ed25519PublicKeyFingerprint(rawKey)
  if (fingerprint !== trustRoot.fingerprint) {
    return {
      ok: false,
      code: 'key-mismatch',
      reason: `manifest signing key fingerprint does not match the pinned fingerprint for keyId ${trustRoot.keyId}`,
    }
  }
  const unsigned = { ...parsed }
  delete unsigned.signature
  const signedBytes = Buffer.from(market.canonicalJsonText(unsigned), 'utf8')
  const signatureBytes = Buffer.from(signature.value, 'base64')
  if (signatureBytes.byteLength !== 64) {
    return { ok: false, code: 'bad-signature', reason: 'the detached ed25519 signature is not 64 bytes' }
  }
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]), format: 'der', type: 'spki' })
  if (!cryptoVerify(null, signedBytes, key, signatureBytes)) {
    return { ok: false, code: 'bad-signature', reason: 'ed25519 signature verification failed' }
  }
  return { ok: true, fingerprint }
}

/** Whether any entry of a parsed manifest carries a `source` key. */
export function manifestCarriesSource(parsed) {
  return Array.isArray(parsed?.packages) && parsed.packages.some((entry) => isPlainObject(entry) && entry.source !== undefined)
}
