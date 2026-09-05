/**
 * Manifest assembly, signing, verification, and publication state. The
 * market signing library owns every crypto decision; this module only
 * sequences the flow: assemble → sign → fingerprint check → canonical
 * serialize → full round-trip verification → write manifest → bump state.
 * Nothing is written until the signed manifest verifies end to end.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { entryKey } from './allowlist.mjs'
import { fingerprintOfRawPublicKey } from './keys.mjs'
import { loadSemverRangeChecker } from './market.mjs'
import {
  manifestCarriesSource,
  validateCompanyManifestShapeWithSources,
  verifyManifestSignature,
} from './manifest-shape.mjs'

export const MANIFEST_VERSION = '1.0.0'
export const STATE_FILE_NAME = 'last-sequence.json'
const DAY_MS = 86_400_000

/** Size and time bounds for reading a deployed manifest as the sequence source. */
export const DEPLOYED_MANIFEST_MAX_BYTES = 1_048_576
export const DEPLOYED_MANIFEST_TIMEOUT_MS = 15_000

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

const isHttpUrl = (value) => {
  try {
    return new URL(value).protocol === 'http:' || new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Read a manifest body to a string under a hard byte cap; cancels the stream on overrun. */
async function readBodyWithLimit(response, maxBytes, label) {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number.parseInt(declared, 10) > maxBytes) {
    throw new Error(`${label} declares ${declared} bytes, over the ${String(maxBytes)}-byte bound — refusing to read it as a sequence source`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    throw new Error(`${label} returned no body`)
  }
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error(`${label} exceeds the ${String(maxBytes)}-byte bound for a sequence source`)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
    await reader.cancel().catch(() => undefined)
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.byteLength === 0) throw new Error(`${label} returned an empty body`)
  return bytes.toString('utf8')
}

/** Validate the parsed deployed manifest and extract its sequence; anything else is a hard error. */
function sequenceFromParsedManifest(parsed, label) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} is not a manifest object carrying a sequence`)
  }
  const sequence = parsed.sequence
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`${label} carries no safe non-negative integer sequence — the sequence must never be guessed`)
  }
  return sequence
}

/**
 * Read the currently deployed manifest — text, parsed object, sequence — from
 * an https URL (the GitLab raw file) or a local file (selftest/offline
 * stand-in), under a hard timeout and byte bound in the spirit of the
 * desktop's fetchUpdateChannelBytes. Returns `{ sequence, text, manifest,
 * source }`; every failure is a thrown, descriptive error — a sequence source
 * that cannot be read must abort the build, not fall back silently to a
 * stale local guess.
 */
export async function fetchDeployedManifest(source, options = {}) {
  const maxBytes = options.maxBytes ?? DEPLOYED_MANIFEST_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEPLOYED_MANIFEST_TIMEOUT_MS
  let text
  if (isHttpUrl(source)) {
    let response
    try {
      response = await fetch(source, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'follow',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(`the deployed manifest at ${source} could not be fetched within ${String(timeoutMs)} ms (${error.message})`)
    }
    if (response.status !== 200) {
      throw new Error(`the deployed manifest at ${source} answered HTTP ${String(response.status)}`)
    }
    text = await readBodyWithLimit(response, maxBytes, `the deployed manifest at ${source}`)
  } else {
    let stat
    try {
      stat = statSync(source)
    } catch (error) {
      throw new Error(`the sequence source ${source} is not readable (${error.code ?? error.message})`)
    }
    if (!stat.isFile()) throw new Error(`the sequence source ${source} is not a file`)
    if (stat.size > maxBytes) {
      throw new Error(`the sequence source ${source} is ${String(stat.size)} bytes, over the ${String(maxBytes)}-byte bound`)
    }
    try {
      text = readFileSync(source, 'utf8')
    } catch (error) {
      throw new Error(`the sequence source ${source} could not be read (${error.code ?? error.message})`)
    }
    if (text.length === 0) throw new Error(`the sequence source ${source} is empty`)
  }
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Error(`the deployed manifest at ${source} is not valid JSON (${error.message}) — the sequence must never be guessed`)
  }
  const sequence = sequenceFromParsedManifest(manifest, `the deployed manifest at ${source}`)
  return { sequence, text, manifest, source }
}

/**
 * Read only the currently deployed manifest's sequence (sequence-source
 * callers that need nothing else); see fetchDeployedManifest for the bounds
 * and the fail-closed contract. Returns `{ sequence, source }`.
 */
export async function readDeployedSequence(source, options = {}) {
  const { sequence, source: resolvedSource } = await fetchDeployedManifest(source, options)
  return { sequence, source: resolvedSource }
}

/**
 * Compose the next sequence from every known floor: the deployed manifest
 * (`--sequence-from`) takes precedence as the source of truth, the local state
 * file remains the fallback when no remote is given, and the effective floor is
 * the maximum of the two so a locally-ahead state can never publish a sequence
 * clients may already have seen. An explicit `--sequence` must still strictly
 * exceed that floor. Returns `{ sequence, floor, source }` with a human-readable
 * `source` the CLI prints so operators always see which sequence source won.
 */
export function nextSequenceFromSources({ explicit, deployedSequence, deployedSource, persistedSequence }) {
  const known = []
  if (deployedSequence !== undefined) {
    known.push({ value: deployedSequence, label: `the deployed manifest at ${deployedSource} (sequence ${String(deployedSequence)})` })
  }
  if (persistedSequence !== undefined) {
    known.push({ value: persistedSequence, label: `the local state file (sequence ${String(persistedSequence)})` })
  }
  const floor = known.length === 0 ? 0 : Math.max(...known.map((entry) => entry.value))
  const source = known.length === 0
    ? 'no deployed manifest and no local state (fresh start)'
    : known.length === 1
      ? known[0].label
      : known.map((entry) => entry.label).join(' + ') + ` — using the higher floor ${String(floor)}`
  const sequence = resolveSequence(explicit, floor)
  return { sequence, floor, source }
}

/**
 * Assemble the unsigned manifest from allowlist entries and their registry
 * dist values. Entries are sorted by (packageName, version) so output is
 * deterministic for reviewing and diffing.
 *
 * Two install channels coexist (P7): npm entries (no `source`) resolve their
 * integrity and repository identity from the official registry exactly as
 * before; tarball entries (`source.kind === 'tarball'`) skip the registry —
 * the intranet tarball is the artifact, so its own sha512 (reviewed in as
 * `source.integrity`) is signed as the entry integrity, and the repository
 * identity must come from the allowlist override because the modified
 * package has no trustworthy public-registry metadata to derive it from.
 * npm entries keep their exact previous signed shape: no `source` key is
 * ever added for them.
 *
 * Every entry's repository identity is resolved here and signed: an explicit
 * allowlist `repository` wins; otherwise the identity is derived from the
 * same registry response that produced the integrity (string or object
 * packument form, `directory` → `subdirectory`). An entry with neither is
 * rejected — packages without a verifiable repository identity can never
 * pass the install-time back-link check, so they must not be listed.
 *
 * Every resolved identity — override or derived — is then run through the
 * market's `normalizeRepositoryIdentity`, the exact contract the desktop
 * verifier applies when re-normalizing the signed row: a URL the market
 * would refuse (query, fragment, empty path, a github URL that is not a bare
 * owner/repository pair, …) aborts the build right here. A lax entry that
 * slipped through would otherwise sign, verify as a manifest, then brick
 * the whole catalog at `assertRepresentableEntry` on every desktop.
 */
export function assembleUnsignedManifest({ market, sequence, expiresAt, entries, dists, channel = 'stable', testers }) {
  if (market === null || typeof market !== 'object' || typeof market.normalizeRepositoryIdentity !== 'function') {
    throw new TypeError('assembleUnsignedManifest requires the market library (normalizeRepositoryIdentity) — load it with loadMarketLibrary()')
  }
  if (channel !== 'stable' && channel !== 'beta') {
    throw new TypeError(`the manifest channel must be 'stable' or 'beta' (got '${String(channel)}')`)
  }
  let normalizedTesters
  if (channel === 'beta') {
    // Defense in depth at sign time: every roster source (the state loader,
    // the roster changer, a verified beta manifest) already normalizes, but
    // the signed bytes must never carry an uppercase or malformed entry —
    // normalize and shape-check here too, exactly like the desktop verifier.
    const list = testers ?? []
    if (!Array.isArray(list)) throw new TypeError('the beta testers roster must be an array of email addresses')
    const seen = new Set()
    normalizedTesters = list.map((entry) => {
      const lowered = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
      if (lowered.length === 0 || lowered.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(lowered)) {
        throw new Error(`the beta testers roster entry ${JSON.stringify(entry)} is not a usable email address — refusing to sign`)
      }
      if (seen.has(lowered)) throw new Error(`the beta testers roster must not repeat ${lowered}`)
      seen.add(lowered)
      return lowered
    })
  }
  // Publication channel (P9): a beta-flagged allowlist entry is held back
  // from every stable manifest and rides the beta manifest (a superset —
  // the desktop's client-side merge rule is additive-only, so a beta
  // manifest that repeats every stable entry byte-identically is a no-op on
  // roster machines and invisible on everyone else's). Promote flips the
  // allowlist flag, which is why the same assembly produces byte-identical
  // entries across both channels.
  const published = entries.filter((entry) => channel !== 'stable' || entry.channel !== 'beta')
  const packages = [...published]
    .sort((a, b) => (a.packageName === b.packageName
      ? (a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
      : (a.packageName < b.packageName ? -1 : 1)))
    .map((entry) => {
      const tarballSource = entry.source !== undefined && entry.source.kind === 'tarball' ? entry.source : undefined
      let integrity
      let rawRepository
      if (tarballSource !== undefined) {
        // Tarball channel: the staged tarball is the artifact. Its reviewed
        // sha512 is signed as the entry integrity — the exact value the
        // desktop's profile lockfile pins for a `file:` install — and the
        // repository identity must be an explicit allowlist override.
        if (tarballSource.integrity === undefined) {
          throw new Error(
            `${entryKey(entry)} carries the pack-artifact source form (path) with no resolved integrity — ` +
            'resolveTarballArtifacts must run before assembly (the CLI build path does; direct pipeline callers must too)',
          )
        }
        integrity = tarballSource.integrity
        rawRepository = entry.repository !== undefined ? { url: entry.repository } : undefined
        if (rawRepository === undefined) {
          throw new Error(
            `${entryKey(entry)} uses the tarball channel and has no repository override — ` +
            'the intranet tarball has no public-registry metadata to derive the identity from, so the allowlist must pin repository explicitly',
          )
        }
      } else {
        const dist = dists.get(entryKey(entry))
        if (dist === undefined) {
          throw new Error(`no registry dist was resolved for ${entryKey(entry)}`)
        }
        integrity = dist.integrity
        rawRepository = entry.repository !== undefined ? { url: entry.repository } : dist.repository
      }
      if (rawRepository === undefined) {
        throw new Error(
          `${entryKey(entry)} has no resolvable repository identity: set repository in the allowlist ` +
          'or publish the package with an https repository field — packages without one cannot be listed',
        )
      }
      let repository
      try {
        repository = market.normalizeRepositoryIdentity(rawRepository)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `${entryKey(entry)} repository ${rawRepository.url} is rejected by the market identity contract ` +
          `(${detail}) — fix the allowlist repository override or the npm repository metadata; the build aborts`,
        )
      }
      return {
        packageName: entry.packageName,
        version: entry.version,
        integrity,
        bundlePatch: entry.bundlePatch,
        repository,
        revoked: entry.revoked,
        runtime: entry.runtime,
        // Optional authority fields, signed verbatim when the reviewed
        // allowlist carries them and omitted otherwise (gradual enablement):
        // `treeDigest` is the expected installed-tree root digest measured in
        // a clean reference environment — the pipeline has no such
        // environment (the digest depends on the pnpm layout), so it never
        // guesses the value — and `approvedBuilds` is the signed build-script
        // approval list desktop merges into its workspace approvals.
        ...(entry.treeDigest === undefined ? {} : { treeDigest: entry.treeDigest }),
        ...(entry.approvedBuilds === undefined ? {} : { approvedBuilds: [...entry.approvedBuilds] }),
        // The signed install channel (P7): only tarball entries carry it —
        // npm entries keep the exact previous shape with no `source` key.
        ...(tarballSource === undefined ? {} : {
          source: { kind: 'tarball', url: tarballSource.url, integrity: tarballSource.integrity },
        }),
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
    ...(channel === 'beta'
      ? { testers: normalizedTesters }
      : {}),
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
 * Verify manifest bytes the way clients do, with the given trust root,
 * anti-rollback floor, and clock — extended for the dual channel (P7):
 *
 * - the strict dual-channel shape mirror validates the document (every
 *   unknown key rejects the whole manifest; `source` is the one recognized
 *   extension, and tarball sources must stay on `companyCatalogOrigin` when
 *   one is given);
 * - canonical byte equality, trust-root binding, the detached ed25519
 *   signature, the sequence floor, and expiry mirror the market verifier;
 * - a manifest that carries no `source` anywhere must in addition verify with
 *   the market library's own `verifyCompanyManifest` — the published bytes
 *   stay verifiable by every field-unaware client, so the tool can never
 *   silently ship a legacy-incompatible source-free manifest;
 * - a manifest that carries `source` cannot verify there by design (one
 *   unknown key rejects it whole — the fleet-upgrade publication gate), so
 *   the dual-channel mirror is its only verifier on this side. The beta
 *   channel (`channel: 'beta'`, P9) is in the same position: its top-level
 *   `testers` roster is a key the market verifier rejects whole, and that is
 *   correct — the beta manifest is served at a URL only field-aware builds
 *   ever fetch, so no legacy-invariant applies to it.
 */
export async function verifyManifestText(market, text, { fingerprint, keyId, lastSeenSequence = 0, now, companyCatalogOrigin, channel = 'stable' }) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: 'malformed-json', reason: 'manifest text is empty' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, code: 'malformed-json', reason: `company manifest is not valid JSON: ${error.message}` }
  }
  let canonical
  try {
    canonical = market.canonicalJsonText(parsed)
  } catch (error) {
    return { ok: false, code: 'non-canonical', reason: error.message }
  }
  if (canonical !== text) {
    return { ok: false, code: 'non-canonical', reason: 'company manifest bytes are not the canonical JSON serialization of their parsed value' }
  }
  const validRange = await loadSemverRangeChecker()
  let manifest
  try {
    manifest = validateCompanyManifestShapeWithSources(parsed, {
      ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
      validRange,
      channel,
    })
  } catch (error) {
    return { ok: false, code: 'invalid-manifest', reason: error.message }
  }
  if (manifest.signature.keyId !== keyId) {
    return { ok: false, code: 'unknown-key', reason: `manifest keyId ${manifest.signature.keyId} is not the expected ${keyId}` }
  }
  const signature = verifyManifestSignature(market, parsed, manifest.signature, { keyId, fingerprint })
  if (!signature.ok) return signature
  if (manifest.sequence < lastSeenSequence) {
    return {
      ok: false,
      code: 'stale-sequence',
      reason: `manifest sequence ${String(manifest.sequence)} regressed below the last seen sequence ${String(lastSeenSequence)}`,
    }
  }
  const verifiedAt = now === undefined ? Date.now() : now()
  const expiresAtMs = Date.parse(manifest.expiresAt)
  if (Number.isNaN(expiresAtMs)) {
    return { ok: false, code: 'invalid-manifest', reason: `expiresAt ${manifest.expiresAt} is not a parseable RFC 3339 timestamp` }
  }
  if (verifiedAt >= expiresAtMs) {
    return { ok: false, code: 'expired', reason: `company manifest expired at ${manifest.expiresAt}` }
  }
  if (!manifestCarriesSource(parsed) && channel !== 'beta') {
    const legacy = market.verifyCompanyManifest(text, {
      trustRoots: [{ keyId, fingerprint }],
      lastSeenSequence,
      ...(now === undefined ? {} : { now }),
    })
    if (!legacy.ok) {
      throw new Error(
        `internal inconsistency: the dual-channel mirror accepted a source-free manifest the market verifier rejects (${legacy.code}: ${legacy.reason}) — ` +
        'the mirrors have diverged; refuse to publish',
      )
    }
  }
  return {
    ok: true,
    manifest,
    keyId,
    fingerprint: signature.fingerprint,
    verifiedAt,
  }
}

/**
 * Publish: sign, verify the full chain (canonical bytes, schema, semantics,
 * trust root, signature, strict sequence increase, expiry), then write the
 * manifest and bump the persisted sequence. Throws before writing anything
 * if any step fails.
 */
export async function publishManifest({
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
  companyCatalogOrigin,
  channel = 'stable',
  testers,
}) {
  const unsigned = assembleUnsignedManifest({ market, sequence, expiresAt, entries, dists, channel, testers })
  return await writeVerifiedManifest({
    market,
    unsigned,
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence,
    outPath,
    stateDir,
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
    channel,
  })
}

/**
 * Assemble the unsigned re-sign document from verbatim signed entries
 * (P9): the entry list is only re-sorted, never re-derived, so the re-signed
 * bytes preserve every entry field exactly (the shared body of
 * {@link republishManifestPackages} and promote's prepare-then-commit path).
 */
export function assembleRepublishPackages({
  packages,
  sequence,
  expiresAt,
  channel = 'stable',
  testers,
}) {
  if (channel === 'beta' && testers === undefined) {
    throw new TypeError('a beta-channel re-sign requires the testers roster')
  }
  if (typeof expiresAt === 'string' ? Number.isNaN(Date.parse(expiresAt)) : !(expiresAt instanceof Date)) {
    throw new TypeError('expiresAt must be a Date or an RFC 3339 string')
  }
  // Same sign-time roster normalization as assembly: the signed bytes never
  // carry an uppercase or malformed entry, whatever the caller handed over.
  const normalizedTesters = channel === 'beta'
    ? [...testers].map((entry) => {
      const lowered = typeof entry === 'string' ? entry.trim().toLowerCase() : ''
      if (lowered.length === 0 || lowered.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(lowered)) {
        throw new Error(`the beta testers roster entry ${JSON.stringify(entry)} is not a usable email address — refusing to sign`)
      }
      return lowered
    })
    : undefined
  return {
    manifestVersion: MANIFEST_VERSION,
    sequence,
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
    packages: [...packages].sort(byPackageIdentity),
    ...(channel === 'beta' ? { testers: normalizedTesters } : {}),
  }
}

/**
 * Sign and fully verify one assembled unsigned manifest WITHOUT touching the
 * disk or the sequence state (P9 review fix): the two-file operations
 * (`promote`) prepare EVERY artifact first and commit them — and the
 * allowlist flip — only after each one verified end to end, so a failure
 * anywhere in the re-sign path leaves zero repository residue. The wrong-key
 * signing failure surfaces here, before any caller state changes.
 */
export async function prepareVerifiedManifest({
  market,
  unsigned,
  privateKey,
  keyId,
  expectedFingerprint,
  lastSeenSequence,
  companyCatalogOrigin,
  channel,
}) {
  const { manifest, text, fingerprint } = signUnsignedManifest(market, unsigned, privateKey, keyId, expectedFingerprint)
  const verification = await verifyManifestText(market, text, { fingerprint, keyId, lastSeenSequence, companyCatalogOrigin, channel })
  if (!verification.ok) {
    throw new Error(`verification failed before publish (${verification.code}): ${verification.reason}`)
  }
  return { manifest, text, fingerprint, verification }
}

/** Commit one prepared, fully verified manifest: write the bytes, ratchet the shared sequence. */
export function commitVerifiedManifest({ prepared, outPath, stateDir }) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, prepared.text, 'utf8')
  writeLastSequence(stateDir, prepared.manifest.sequence)
  return prepared
}

/** Sign, fully verify, write, and ratchet one already-assembled unsigned manifest. */
async function writeVerifiedManifest({
  market,
  unsigned,
  privateKey,
  keyId,
  expectedFingerprint,
  lastSeenSequence,
  outPath,
  stateDir,
  companyCatalogOrigin,
  channel,
}) {
  const prepared = await prepareVerifiedManifest({
    market,
    unsigned,
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence,
    companyCatalogOrigin,
    channel,
  })
  return commitVerifiedManifest({ prepared, outPath, stateDir })
}

/** Deterministic manifest package order: (packageName, version), the assembly sort. */
const byPackageIdentity = (left, right) => left.packageName === right.packageName
  ? (left.version < right.version ? -1 : left.version > right.version ? 1 : 0)
  : (left.packageName < right.packageName ? -1 : 1)

/**
 * Re-sign a manifest from verbatim signed entries (P9): `promote` merges a
 * beta entry into the stable manifest and `beta-roster` swaps the roster —
 * both must preserve the entries byte-for-byte (same digests, same fields;
 * only the sequence and expiry move), so they re-sign the entries the
 * current verified manifests already carry instead of re-deriving them
 * from the allowlist and the registry. Zero re-verification of upstream
 * facts by design: the signed bytes are the authority.
 */
export async function republishManifestPackages({
  market,
  packages,
  sequence,
  expiresAt,
  privateKey,
  keyId,
  expectedFingerprint,
  lastSeenSequence,
  outPath,
  stateDir,
  companyCatalogOrigin,
  channel = 'stable',
  testers,
}) {
  const unsigned = assembleRepublishPackages({ packages, sequence, expiresAt, channel, testers })
  return await writeVerifiedManifest({
    market,
    unsigned,
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence,
    outPath,
    stateDir,
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
    channel,
  })
}
