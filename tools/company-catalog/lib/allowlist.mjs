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

import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
const TARBALL_SOURCE_FIELDS = ['integrity', 'kind', 'path', 'url']
const NPM_SOURCE_FIELDS = ['kind']

/** Lowercase hex SHA-256 shape of an expected installed-tree digest. */
export const TREE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u
/** Upper bound of one entry's signed build-approval list; mirrors the manifest schema. */
const MAX_APPROVED_BUILDS = 128
/** Hard byte bound of one hosted tarball artifact; mirrors lib/tarball.mjs. */
export const TARBALL_MAX_BYTES = 128 * 1024 * 1024

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
  // Port alignment: the manifest schema's https URL grammar (manifest-shape.mjs
  // and the desktop's dual-channel verifier) forbids an explicit port on
  // `source.url`/`repository.url`, so an origin carrying one could never host
  // a verifiable tarball entry — refuse it here, at configuration time, with
  // the reason instead of letting every signed entry fail downstream.
  if (/^https:\/\/[^/?#@]*:\d+$/u.test(value)) {
    throw new Error(
      `the company catalog origin '${value}' must not carry a port: the manifest schema's https URL grammar ` +
      'forbids an explicit port on source and repository urls, so a ported origin can never host a verifiable ' +
      'tarball entry — serve the catalog origin on the standard https port (443)',
    )
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
 * source is `{kind:'tarball', url, integrity}` (the reviewed-integrity form,
 * signed as-is) or `{kind:'tarball', url, path}` (the pack-artifact form: the
 * pipeline computes the sha512 from the packed file at build time, exactly
 * like it fetches the npm channel's integrity from the registry — never
 * trusting a local reviewed value); carrying both `path` and `integrity` is
 * refused so there is never a second place the truth could diverge. The url
 * must be an https url on the configured catalog origin in both forms; npm
 * entries must not carry a url.
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
  for (const field of ['url']) {
    if (typeof source[field] !== 'string' || source[field].length === 0) {
      return { ok: false, reason: `${at}.source.${field} is required for the tarball channel` }
    }
  }
  const hasIntegrity = source.integrity !== undefined
  const hasPath = source.path !== undefined
  if (hasIntegrity && hasPath) {
    return {
      ok: false,
      reason: `${at}.source carries both path and integrity — the pack-artifact form computes the integrity from the packed file at build time (run pack-tarball), the reviewed form pins it inline; exactly one place may hold the truth`,
    }
  }
  if (!hasIntegrity && !hasPath) {
    return { ok: false, reason: `${at}.source requires either path (the pack-tarball artifact) or integrity (the reviewed sha512)` }
  }
  if (hasPath && (typeof source.path !== 'string' || !isSafePackArtifactPath(source.path))) {
    return {
      ok: false,
      reason: `${at}.source.path must be the pack-tarball artifact as a repository-relative POSIX path ending in .tgz (no absolute paths, dot segments, or backslashes)`,
    }
  }
  let url
  try {
    url = new URL(source.url)
  } catch {
    return { ok: false, reason: `${at}.source.url '${source.url}' is not a valid URL` }
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    return { ok: false, reason: `${at}.source.url must be a credential-free https URL without a fragment or an explicit port` }
  }
  // Port alignment with the manifest schema's https URL grammar: an explicit
  // port (including a redundant :443) is rejected here, at review time —
  // the signed manifest verifier refuses such urls whole, and the catalog
  // origin itself cannot carry one (validateCatalogOrigin).
  const authority = source.url.split('/')[2] ?? ''
  if (/:[0-9]+$/u.test(authority)) {
    return {
      ok: false,
      reason: `${at}.source.url must not carry an explicit port — the manifest schema's https URL grammar (and the desktop verifier) forbids it; serve the tarball on the standard https port (443)`,
    }
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
  if (hasIntegrity && !isSha512Integrity(source.integrity)) {
    return { ok: false, reason: `${at}.source.integrity must be the base64 SHA-512 digest of the tarball file (sha512-…)` }
  }
  return hasPath
    ? { kind: 'tarball', url: source.url, path: source.path }
    : { kind: 'tarball', url: source.url, integrity: source.integrity }
}

/**
 * Repository-relative POSIX path of a packed tarball artifact: the shape the
 * allowlist `source.path` form accepts (resolved against the repository root
 * by resolveTarballArtifacts, so the reviewed value stays portable across
 * machines and CI checkouts). Mirrors the bundlePatch safety grammar plus the
 * .tgz suffix of the hosting layout.
 */
function isSafePackArtifactPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (BUNDLE_PATCH_FORBIDDEN.test(value) || value.includes('\\')) return false
  if (!value.endsWith('.tgz')) return false
  return !value.startsWith('/')
    && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
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
  // One package name never straddles both install channels (P7 2b): a name
  // served over the npm channel and the tarball channel at the same time would
  // let the caller pick the channel per version, and the desktop's per-row
  // install-time resolution has no single answer for which artifact a profile
  // should pin. The rule is enforced here, at the allowlist boundary, where the
  // whole reviewed set is in view — the same place the duplicate-by-version
  // refusal lives.
  const channelByName = new Map()
  for (const [index, entry] of parsed.entries()) {
    const result = validateAllowlistEntry(entry, `entry[${index}]`, options)
    if (!result.ok) throw new Error(`allowlist ${path}: ${result.reason}`)
    const identity = entryKey(result.value)
    if (seen.has(identity)) throw new Error(`allowlist ${path}: duplicate entry ${identity}`)
    seen.add(identity)
    const value = result.value
    const channel = value.source !== undefined && value.source.kind === 'tarball' ? 'tarball' : 'npm'
    const existingChannel = channelByName.get(value.packageName)
    if (existingChannel !== undefined && existingChannel !== channel) {
      throw new Error(
        `allowlist ${path}: ${value.packageName} appears on both the npm and the tarball channel ` +
        '(one package name must never straddle two install channels) — pick one channel per name',
      )
    }
    channelByName.set(value.packageName, channel)
    entries.push(value)
  }
  return entries
}

/** Persist entries back to the allowlist file in the reviewed shape. */
export function saveAllowlist(path, entries) {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
}

/**
 * Resolve the pack-artifact (`source.path`) form of every tarball-channel
 * entry into the signable `{kind, url, integrity}` shape: the sha512 is
 * computed from the packed file's actual bytes at build time — the same
 * never-trust-a-local-value discipline the npm channel applies to the
 * registry dist — and the url's last path segment must equal the artifact's
 * filename, because publish-local derives the hosted repo path
 * (`packages/<filename>`) from that url. Reviewed-integrity entries pass
 * through untouched. Returns `{ entries, resolved, passthrough }`; every
 * failure names the entry and the fix.
 */
export function resolveTarballArtifacts(entries, { repoRoot }) {
  const resolved = []
  const passthrough = []
  const updated = entries.map((entry) => {
    if (entry.source?.kind !== 'tarball') return entry
    if (entry.source.integrity !== undefined) {
      passthrough.push(entryKey(entry))
      return entry
    }
    const artifactPath = resolve(repoRoot, ...entry.source.path.split('/'))
    let stat
    try {
      stat = statSync(artifactPath)
    } catch (error) {
      throw new Error(
        `${entryKey(entry)} pins source.path ${entry.source.path} but ${artifactPath} is not readable (${error.code ?? error.message}) — ` +
        'run pack-tarball to produce the artifact before building (the path form resolves the integrity from the packed file)',
      )
    }
    if (!stat.isFile()) throw new Error(`${entryKey(entry)} source.path ${entry.source.path} is not a file`)
    if (stat.size > TARBALL_MAX_BYTES) {
      throw new Error(`${entryKey(entry)} source.path ${entry.source.path} is ${String(stat.size)} bytes, over the ${String(TARBALL_MAX_BYTES)}-byte bound`)
    }
    const bytes = readFileSync(artifactPath)
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const filename = entry.source.path.split('/').pop()
    const urlBasename = entry.source.url.split('/').pop()
    if (urlBasename !== filename) {
      throw new Error(
        `${entryKey(entry)} source.url ends with '${urlBasename}' but the packed artifact is '${filename}' — ` +
        'the hosting layout pins the url basename to the artifact filename (publish-local pushes packages/<filename> and derives the path from the url)',
      )
    }
    resolved.push({
      packageName: entry.packageName,
      version: entry.version,
      filename,
      path: entry.source.path,
      url: entry.source.url,
      integrity,
      sizeBytes: bytes.byteLength,
    })
    return { ...entry, source: { kind: 'tarball', url: entry.source.url, integrity } }
  })
  return { entries: updated, resolved, passthrough }
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
