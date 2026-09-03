/**
 * The reviewed allowlist: the only human-authored input of the pipeline.
 * Each entry names an exact npm package version plus the manifest data the
 * schema (`dsh-community-market/docs/schemas/company-manifest.schema.json`)
 * requires; the pipeline fetches the tarball integrity from the official
 * registry at build time, never from this file.
 *
 * Field rules mirror the schema so bad entries fail here, at review time,
 * with the same semantics the market verifier enforces on the manifest.
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** npm package name grammar accepted by the manifest schema. */
export const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
/** npm's package-name length bound, mirrored by the manifest schema's `maxLength: 214`. */
export const MAX_PACKAGE_NAME_LENGTH = 214
/** Exact stable semver — prerelease and build metadata are not signable. */
export const STABLE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
/** Characters the schema forbids inside bundlePatch (controls and bidi marks). */
const BUNDLE_PATCH_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u

const RUNTIME_RANGE_FIELDS = ['dshRuntimeVersion', 'cordisRuntimeVersion', 'nodeRuntimeVersion']
const ENTRY_FIELDS = ['approvedBuilds', 'bundlePatch', 'packageName', 'repository', 'revoked', 'runtime', 'source', 'treeDigest', 'version']
const SOURCE_KINDS = ['npm', 'tarball']
const TARBALL_SOURCE_FIELDS = ['integrity', 'kind', 'url']
const NPM_SOURCE_FIELDS = ['kind']

/** Lowercase hex SHA-256 shape of an expected installed-tree digest. */
export const TREE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u
/** Upper bound of one entry's signed build-approval list; mirrors the manifest schema. */
const MAX_APPROVED_BUILDS = 128

/** Standard-base64 SHA-512 integrity (64-byte digest), the value the manifest schema pins. */
export function isSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

/**
 * Options of {@link validateAllowlistEntry} and {@link loadAllowlist}: the
 * bare https origin every tarball `source.url` must live on. Tarball entries
 * are intranet-GitLab-hosted; the pipeline refuses to sign one whose url
 * leaves the deployment's pinned catalog origin, because the desktop would
 * refuse the whole manifest at verification (`companyCatalogOrigin`).
 */
export const CATALOG_ORIGIN_ENV = 'COMPANY_CATALOG_ORIGIN'

/** Validate a bare https origin (the deployment policy's `companyCatalogOrigin` spelling). */
export function validateCatalogOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('the company catalog origin must be a bare https origin like https://gitlab.company.example')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`the company catalog origin '${value}' is not a valid URL`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.origin !== value) {
    throw new Error(`the company catalog origin '${value}' must be a bare https origin (no path, credentials, or fragment)`)
  }
  return url.origin
}

/**
 * Validate and normalize one entry's `source` channel selection. `undefined`
 * and `{kind:'npm'}` both normalize to the npm channel with no `source` key —
 * existing allowlist entries keep their exact reviewed shape. A tarball
 * source must be exactly `{kind:'tarball', url, integrity}` with an https url
 * on the configured catalog origin and the sha512 of the tarball file
 * itself; npm entries must not carry a url.
 */
export function validateEntrySource(source, at, options = {}) {
  if (source === undefined) return { kind: 'npm' }
  if (!isPlainObject(source)) return { ok: false, reason: `${at}.source must be an object` }
  const kind = source.kind
  if (!SOURCE_KINDS.includes(kind)) {
    return { ok: false, reason: `${at}.source.kind must be 'npm' or 'tarball' (got ${JSON.stringify(kind)})` }
  }
  if (kind === 'npm') {
    const unknown = Object.keys(source).filter((key) => !NPM_SOURCE_FIELDS.includes(key))
    if (unknown.length > 0) {
      return { ok: false, reason: `${at}.source is the npm channel and must not carry ${unknown.join(', ')} — npm entries install from the pinned public registry` }
    }
    return { kind: 'npm' }
  }
  const unknown = Object.keys(source).filter((key) => !TARBALL_SOURCE_FIELDS.includes(key))
  if (unknown.length > 0) return { ok: false, reason: `${at}.source has unknown field(s) ${unknown.join(', ')}` }
  for (const field of ['url', 'integrity']) {
    if (typeof source[field] !== 'string' || source[field].length === 0) {
      return { ok: false, reason: `${at}.source.${field} is required for the tarball channel` }
    }
  }
  let url
  try {
    url = new URL(source.url)
  } catch {
    return { ok: false, reason: `${at}.source.url '${source.url}' is not a valid URL` }
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    return { ok: false, reason: `${at}.source.url must be a credential-free https URL without a fragment` }
  }
  const origin = options.companyCatalogOrigin
  if (origin === undefined) {
    return {
      ok: false,
      reason: `${at}.source is the tarball channel, which requires the company catalog origin — pass --catalog-origin or set ${CATALOG_ORIGIN_ENV}`,
    }
  }
  if (url.origin !== origin) {
    return { ok: false, reason: `${at}.source.url origin ${url.origin} is not the company catalog origin ${origin}` }
  }
  if (!isSha512Integrity(source.integrity)) {
    return { ok: false, reason: `${at}.source.integrity must be the base64 SHA-512 digest of the tarball file (sha512-…)` }
  }
  return { kind: 'tarball', url: source.url, integrity: source.integrity }
}

/** npm dependency name of an approved build, schema-shaped: the grammar plus the 214-character bound. */
const isValidBuildDependencyName = (name) =>
  typeof name === 'string' && PACKAGE_NAME_PATTERN.test(name) && name.length <= MAX_PACKAGE_NAME_LENGTH

/** Mirror of the market's safeBundlePatchPath guard plus the schema character class. */
export function isSafeBundlePatchPath(value) {
  if (typeof value !== 'string' || value.length === 0 || BUNDLE_PATCH_FORBIDDEN.test(value)) return false
  if (value.includes('\\')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Normalize one repository URL into the https form the manifest signs and the
 * market verifier back-links against live npm metadata: strip the npm `git+`
 * transport prefix and the trailing `.git` suffix, then require a
 * credential-free https URL. Returns the normalized string or undefined when
 * the value is unusable.
 */
export function normalizeRepositoryUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const stripped = value.startsWith('git+') ? value.slice(4) : value
  if (!stripped.startsWith('https://')) return undefined
  let url
  try {
    url = new URL(stripped)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined
  return stripped.replace(/\.git$/u, '')
}

/**
 * Parse an npm packument `repository` field into the raw identity shape the
 * manifest signs: the dominant object form
 * (`{"url":"https://github.com/o/r","type":"git","directory":"packages/r"}`)
 * as well as the legacy bare-string spelling. Semantics mirror the market
 * installer's `npmRepository()`: the `git+` transport prefix and trailing
 * `.git` suffix are stripped, a credential-free https URL is required, and an
 * object `directory` (monorepo packages) maps to `subdirectory`. Returns
 * `{url, subdirectory?}` or undefined when the value cannot yield a usable
 * https URL; whether the parsed identity is representable in the market
 * contract is decided later, by the build (never silently dropped).
 */
export function repositoryFromPackument(value) {
  const repository = typeof value === 'string'
    ? { url: value }
    : isPlainObject(value)
      ? value
      : undefined
  if (repository === undefined || typeof repository.url !== 'string') return undefined
  const url = normalizeRepositoryUrl(repository.url)
  if (url === undefined) return undefined
  return {
    url,
    ...(typeof repository.directory === 'string' && repository.directory.length > 0
      ? { subdirectory: repository.directory }
      : {}),
  }
}

/**
 * Validate and normalize one allowlist entry. Returns
 * `{ok: true, value: {packageName, version, bundlePatch, repository?, revoked, runtime, treeDigest?, approvedBuilds?}}`
 * or `{ok: false, reason}`. Optional runtime ranges are kept only when
 * present; their node-semver validity is enforced later by the market
 * verifier, which owns the semver grammar. The optional `repository` override
 * pins the VCS identity to sign; when absent the build derives it from the
 * registry metadata (tarball-channel entries have no registry metadata, so
 * they must carry the override — the build enforces that). The optional
 * `treeDigest` and `approvedBuilds` are passthrough authority fields: the
 * pipeline cannot derive them (the tree digest depends on the installing
 * environment's package-manager layout, so it is measured in a clean
 * reference environment and reviewed in), so they are validated here and
 * signed verbatim when — and only when — present. The optional `source`
 * selects the install channel (P7): absent or `{kind:'npm'}` keeps the public
 * npm channel with no signed `source` key, `{kind:'tarball', url, integrity}`
 * signs the intranet tarball channel.
 */
export function validateAllowlistEntry(entry, at, options = {}) {
  if (!isPlainObject(entry)) return { ok: false, reason: `${at} must be an object` }
  const unknown = Object.keys(entry).filter((key) => !ENTRY_FIELDS.includes(key))
  if (unknown.length > 0) return { ok: false, reason: `${at} has unknown field(s) ${unknown.join(', ')}` }

  const { packageName, version, bundlePatch, runtime } = entry
  if (typeof packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(packageName)) {
    return { ok: false, reason: `${at}.packageName must be an npm package name (scoped names allowed, lowercase)` }
  }
  if (packageName.length > MAX_PACKAGE_NAME_LENGTH) {
    return { ok: false, reason: `${at}.packageName must be at most ${String(MAX_PACKAGE_NAME_LENGTH)} characters long (npm's bound, mirrored by the manifest schema)` }
  }
  if (typeof version !== 'string' || !STABLE_VERSION_PATTERN.test(version)) {
    return { ok: false, reason: `${at}.version must be an exact stable semver (X.Y.Z, no prerelease or build metadata)` }
  }
  if (!isSafeBundlePatchPath(bundlePatch)) {
    return { ok: false, reason: `${at}.bundlePatch must be a relative path inside the package without dot segments, backslashes, or drive letters` }
  }
  const revoked = entry.revoked ?? false
  if (typeof revoked !== 'boolean') return { ok: false, reason: `${at}.revoked must be a boolean` }
  const repository = entry.repository === undefined ? undefined : normalizeRepositoryUrl(entry.repository)
  if (entry.repository !== undefined && repository === undefined) {
    return { ok: false, reason: `${at}.repository must be a credential-free https URL (npm git+https://…git spellings accepted)` }
  }
  if (!isPlainObject(runtime)) return { ok: false, reason: `${at}.runtime must be an object` }
  const runtimeUnknown = Object.keys(runtime).filter((key) => !RUNTIME_RANGE_FIELDS.includes(key))
  if (runtimeUnknown.length > 0) {
    return { ok: false, reason: `${at}.runtime has unknown field(s) ${runtimeUnknown.join(', ')}` }
  }
  const normalizedRuntime = {}
  for (const field of RUNTIME_RANGE_FIELDS) {
    const range = runtime[field]
    if (range === undefined) continue
    if (typeof range !== 'string' || range.length === 0) {
      return { ok: false, reason: `${at}.runtime.${field} must be a non-empty node-semver range string` }
    }
    normalizedRuntime[field] = range
  }
  if (typeof normalizedRuntime.dshRuntimeVersion !== 'string') {
    return { ok: false, reason: `${at}.runtime.dshRuntimeVersion is required` }
  }
  const treeDigest = entry.treeDigest
  if (treeDigest !== undefined
    && (typeof treeDigest !== 'string' || !TREE_DIGEST_PATTERN.test(treeDigest))) {
    return {
      ok: false,
      reason: `${at}.treeDigest must be the expected installed-tree root digest as 64 lowercase hex characters (measured in a clean reference environment; omit the field until then)`,
    }
  }
  const approvedBuilds = entry.approvedBuilds
  if (approvedBuilds !== undefined) {
    if (!Array.isArray(approvedBuilds) || approvedBuilds.length === 0) {
      return { ok: false, reason: `${at}.approvedBuilds must be a non-empty array of dependency names (omit the field instead of signing an empty list)` }
    }
    if (approvedBuilds.length > MAX_APPROVED_BUILDS) {
      return { ok: false, reason: `${at}.approvedBuilds must list at most ${String(MAX_APPROVED_BUILDS)} dependency names` }
    }
    const seenBuilds = new Set()
    for (const name of approvedBuilds) {
      if (!isValidBuildDependencyName(name)) {
        return { ok: false, reason: `${at}.approvedBuilds entries must be npm dependency names (scoped names allowed, lowercase, at most ${String(MAX_PACKAGE_NAME_LENGTH)} characters)` }
      }
      if (seenBuilds.has(name)) {
        return { ok: false, reason: `${at}.approvedBuilds must not repeat ${name}` }
      }
      seenBuilds.add(name)
    }
  }
  const source = validateEntrySource(entry.source, at, options)
  if (source.ok === false) return { ok: false, reason: source.reason }
  return {
    ok: true,
    value: {
      packageName,
      version,
      bundlePatch,
      ...(repository === undefined ? {} : { repository }),
      revoked,
      runtime: normalizedRuntime,
      ...(treeDigest === undefined ? {} : { treeDigest }),
      ...(approvedBuilds === undefined ? {} : { approvedBuilds }),
      ...(source.kind === 'tarball' ? { source } : {}),
    },
  }
}

/** Stable identity key of an entry across allowlist, dist, and manifest maps. */
export const entryKey = (entry) => `${entry.packageName}@${entry.version}`

/**
 * Read and validate a measured-tree-digest file
 * (`[{"packageName","version","treeDigest"}, …]`, the measure script's output).
 * Shape errors are hard errors: a digest the pipeline cannot trust must never
 * reach the signed manifest.
 */
export function loadTreeDigestFile(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`digest file ${path} is not readable JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`digest file ${path} must be a JSON array of {packageName, version, treeDigest} records`)
  }
  const digests = []
  const seen = new Set()
  for (const [index, record] of parsed.entries()) {
    if (!isPlainObject(record)) {
      throw new Error(`digest file ${path}: record ${String(index)} must be an object`)
    }
    const unknown = Object.keys(record).filter((key) => key !== 'packageName' && key !== 'version' && key !== 'treeDigest')
    if (unknown.length > 0) {
      throw new Error(`digest file ${path}: record ${String(index)} has unknown field(s) ${unknown.join(', ')}`)
    }
    const { packageName, version, treeDigest } = record
    if (typeof packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(packageName)) {
      throw new Error(`digest file ${path}: record ${String(index)}.packageName must be an npm package name`)
    }
    if (typeof version !== 'string' || !STABLE_VERSION_PATTERN.test(version)) {
      throw new Error(`digest file ${path}: record ${String(index)}.version must be an exact stable semver (X.Y.Z)`)
    }
    if (typeof treeDigest !== 'string' || !TREE_DIGEST_PATTERN.test(treeDigest)) {
      throw new Error(`digest file ${path}: record ${String(index)}.treeDigest must be 64 lowercase hex characters`)
    }
    const identity = entryKey(record)
    if (seen.has(identity)) throw new Error(`digest file ${path}: duplicate record ${identity}`)
    seen.add(identity)
    digests.push({ packageName, version, treeDigest })
  }
  return digests
}

/**
 * Apply measured tree digests to a copy of the allowlist entries — the runtime
 * copy `measure-and-publish` signs. Matching is by (packageName, version):
 *
 *   - an entry without a treeDigest gains the measured value (`filled`);
 *   - an entry whose reviewed treeDigest already equals the measured value is
 *     kept verbatim (`unchanged`) — remeasuring is idempotent;
 *   - an entry whose reviewed treeDigest differs aborts: review pinned a
 *     different expectation than the reference environment measured, and that
 *     disagreement must be resolved by humans, never silently overwritten;
 *   - a digest record matching no allowlist entry aborts, listing every
 *     unmatched record — the pipeline never signs authority for entries review
 *     did not approve.
 *
 * Entries the digest file does not cover stay without a treeDigest (gradual
 * enablement remains an explicit reviewed state); the caller reports them.
 */
export function applyTreeDigests(entries, digests) {
  const byIdentity = new Map(digests.map((digest) => [entryKey(digest), digest]))
  const matched = new Set()
  const filled = []
  const unchanged = []
  const updated = entries.map((entry) => {
    const digest = byIdentity.get(entryKey(entry))
    if (digest === undefined) return entry
    matched.add(entryKey(entry))
    if (entry.treeDigest === digest.treeDigest) {
      unchanged.push(entryKey(entry))
      return entry
    }
    if (entry.treeDigest !== undefined) {
      throw new Error(
        `${entryKey(entry)} already pins treeDigest ${entry.treeDigest} but the digest file measured ${digest.treeDigest} — ` +
        'resolve the disagreement in review; the pipeline never overwrites a reviewed digest',
      )
    }
    filled.push(entryKey(entry))
    return { ...entry, treeDigest: digest.treeDigest }
  })
  const unmatched = [...byIdentity.keys()].filter((identity) => !matched.has(identity))
  if (unmatched.length > 0) {
    throw new Error(
      `digest file records with no allowlist entry: ${unmatched.join(', ')} — ` +
      'the pipeline signs authority only for entries review approved',
    )
  }
  const missing = updated.filter((entry) => entry.treeDigest === undefined).map(entryKey)
  return { entries: updated, filled, unchanged, missing }
}

/** Read and validate an allowlist file into normalized entries (unique by package and version). */
export function loadAllowlist(path, options = {}) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`allowlist ${path} is not readable JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`allowlist ${path} must be a non-empty JSON array of entries`)
  }
  const entries = []
  const seen = new Set()
  for (const [index, entry] of parsed.entries()) {
    const result = validateAllowlistEntry(entry, `entry[${index}]`, options)
    if (!result.ok) throw new Error(`allowlist ${path}: ${result.reason}`)
    const identity = entryKey(result.value)
    if (seen.has(identity)) throw new Error(`allowlist ${path}: duplicate entry ${identity}`)
    seen.add(identity)
    entries.push(result.value)
  }
  return entries
}

/** Persist entries back to the allowlist file in the reviewed shape. */
export function saveAllowlist(path, entries) {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

/**
 * Parse a revocation spec: `name`, `name@version`, `@scope/name`, or
 * `@scope/name@version`. Returns `{packageName, version?}`.
 */
export function parseRevocationSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) throw new Error('revocation spec must be <package>[@<version>]')
  const at = spec.lastIndexOf('@')
  const packageName = at > 0 ? spec.slice(0, at) : spec
  const version = at > 0 ? spec.slice(at + 1) : undefined
  if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error(`'${packageName}' is not a valid package name`)
  if (version !== undefined && !STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`'${version}' is not an exact stable version (revocation targets are pinned, not ranged)`)
  }
  return { packageName, version }
}

/**
 * Mark every matching entry revoked and return the updated copy. Revocation
 * is a state change, not a deletion: entries stay in the allowlist and in
 * every reissued manifest for the signed audit trail.
 */
export function applyRevocation(entries, spec) {
  const { packageName, version } = parseRevocationSpec(spec)
  const matches = []
  const updated = entries.map((entry) => {
    if (entry.packageName !== packageName) return entry
    if (version !== undefined && entry.version !== version) return entry
    matches.push(entry)
    return entry.revoked ? entry : { ...entry, revoked: true }
  })
  if (matches.length === 0) {
    throw new Error(`no allowlist entry matches ${spec}${version === undefined ? ' (no version pinned: every version of the package would match)' : ''}`)
  }
  const alreadyRevoked = matches.filter((entry) => entry.revoked).length
  if (alreadyRevoked === matches.length) {
    throw new Error(`${spec} is already revoked in the allowlist (revocation is idempotent; nothing to reissue)`)
  }
  return { entries: updated, matches: matches.map(entryKey) }
}
