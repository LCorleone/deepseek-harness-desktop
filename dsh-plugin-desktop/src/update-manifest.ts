/**
 * Signed update-channel manifest (security plan P3-3): strict document shape,
 * detached-signature verification of the fetched bytes, and the sequence
 * anti-rollback state.
 *
 * The version manifest is a small JSON document published beside a detached
 * ed25519 signature. The signature covers the manifest bytes exactly as
 * fetched (no canonical serialization: the bytes that get parsed are the bytes
 * that were signed), and the document itself carries the `keyId` plus the raw
 * public key that produced the signature, bound to the embedded
 * `ARTIFACT_TRUST_ROOTS` fingerprints. One manifest is signed by one release
 * key, and every artifact entry must declare that same keyId.
 */

import { lstat, readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  verifyDetachedUpdateSignature,
  type UpdateChannelTrustRoot,
} from './update-verification.ts'

/** Desktop platforms selectable inside one manifest. */
export type UpdateManifestPlatform = 'darwin' | 'win32'

/** One signed installer entry of the version manifest. */
export interface UpdateManifestArtifact {
  /** Installer platform; unique within one manifest. */
  readonly platform: UpdateManifestPlatform
  /** Absolute https URL of the installer artifact. */
  readonly url: string
  /** Exact artifact size in bytes. */
  readonly size: number
  /** Lowercase SHA-256 digest (64 hex characters) of the artifact bytes. */
  readonly sha256: string
  /** Absolute https URL of the detached base64 signature; defaults to `${url}.sig`. */
  readonly signatureUrl?: string
  /** Signing key identifier; must equal the manifest-level keyId. */
  readonly keyId: string
}

/** Strictly parsed version manifest document. */
export interface UpdateManifestDocument {
  /** Latest release version; callers that own SemVer validate it. */
  readonly latest: string
  /** Monotonic publication counter; strictly older sequences are rollbacks. */
  readonly sequence: number
  /** keyId of the release key that signed this manifest. */
  readonly keyId: string
  /** Base64 raw 32-byte ed25519 public key of the release key. */
  readonly publicKey: string
  /** Installer entries, at least one, one per platform. */
  readonly artifacts: readonly UpdateManifestArtifact[]
}

/** Maximum accepted manifest response bytes. */
export const MAX_UPDATE_MANIFEST_BYTES = 64 * 1024

/** Maximum accepted manifest-signature response bytes (base64 of 64 bytes plus slack). */
export const MAX_UPDATE_MANIFEST_SIGNATURE_BYTES = 4 * 1024

/**
 * Maximum artifact size accepted inside a manifest. Mirrors
 * `MAX_UPDATE_DOWNLOAD_BYTES` in `update-download.ts`, which stays the
 * transport-side bound; this constant only bounds the declared metadata.
 */
export const MAX_MANIFEST_ARTIFACT_BYTES = 1024 * 1024 * 1024

/** Default companion URL of a detached signature published beside a signed resource. */
export function updateManifestSignatureUrl(url: string): string {
  return `${url}.sig`
}

/** Result of parsing manifest bytes into a document. */
export type UpdateManifestParseResult =
  | { readonly ok: true; readonly document: UpdateManifestDocument }
  | { readonly ok: false; readonly reason: string }

const DECIMAL_BYTES = /^(0|[1-9][0-9]*)$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SHA256_HEX = /^[0-9a-f]{64}$/u
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key)
}

function parseHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /\s/u.test(value)) {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  return value
}

/**
 * Parse and strictly validate one manifest document. `latest` stays an opaque
 * non-empty string: the callers that own SemVer (`update-checker.ts` and
 * `update-download.ts`) apply their canonical stable-version rules. Every
 * deviation is a `{ok: false, reason}` value, never a throw.
 */
export function parseUpdateManifestDocument(raw: Uint8Array | string): UpdateManifestParseResult {
  const invalid = (reason: string): UpdateManifestParseResult => ({ ok: false, reason })
  let text: string
  if (typeof raw === 'string') {
    text = raw
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch {
      return invalid('the update manifest is not valid UTF-8')
    }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return invalid('the update manifest is not valid JSON')
  }
  if (!isRecord(value) || !hasExactKeys(value, ['artifacts', 'keyId', 'latest', 'publicKey', 'sequence'])) {
    return invalid('the update manifest has unexpected fields')
  }
  if (typeof value.latest !== 'string' || value.latest.length === 0 || value.latest.includes('\0')) {
    return invalid('the update manifest latest version is invalid')
  }
  if (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    return invalid('the update manifest sequence must be a safe positive integer')
  }
  if (typeof value.keyId !== 'string' || !KEY_ID_PATTERN.test(value.keyId)) {
    return invalid('the update manifest keyId is invalid')
  }
  if (typeof value.publicKey !== 'string' || !BASE64_PATTERN.test(value.publicKey)
    || Buffer.from(value.publicKey, 'base64').byteLength !== 32) {
    return invalid('the update manifest public key is not a raw 32-byte ed25519 key')
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) {
    return invalid('the update manifest must list at least one artifact')
  }
  const artifacts: UpdateManifestArtifact[] = []
  const platforms = new Set<string>()
  for (const entry of value.artifacts) {
    if (!isRecord(entry)) return invalid('update manifest artifacts must be objects')
    const withSignatureUrl = hasExactKeys(entry, ['keyId', 'platform', 'sha256', 'signatureUrl', 'size', 'url'])
    if (!withSignatureUrl && !hasExactKeys(entry, ['keyId', 'platform', 'sha256', 'size', 'url'])) {
      return invalid('an update manifest artifact has unexpected fields')
    }
    if (entry.platform !== 'darwin' && entry.platform !== 'win32') {
      return invalid('an update manifest artifact has an unsupported platform')
    }
    if (platforms.has(entry.platform)) {
      return invalid(`the update manifest lists platform ${entry.platform} more than once`)
    }
    platforms.add(entry.platform)
    if (entry.keyId !== value.keyId) {
      return invalid('an update manifest artifact keyId does not match the manifest keyId')
    }
    const url = parseHttpsUrl(entry.url)
    if (url === undefined) {
      return invalid('an update manifest artifact URL must be an absolute https URL')
    }
    const signatureUrl = withSignatureUrl ? parseHttpsUrl(entry.signatureUrl) : undefined
    if (withSignatureUrl && signatureUrl === undefined) {
      return invalid('an update manifest artifact signature URL must be an absolute https URL')
    }
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size)
      || entry.size < 1 || entry.size > MAX_MANIFEST_ARTIFACT_BYTES) {
      return invalid('an update manifest artifact size is out of range')
    }
    if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256)) {
      return invalid('an update manifest artifact digest must be 64 lowercase hex characters')
    }
    artifacts.push(signatureUrl === undefined
      ? { platform: entry.platform, url, size: entry.size, sha256: entry.sha256, keyId: value.keyId }
      : {
        platform: entry.platform,
        url,
        size: entry.size,
        sha256: entry.sha256,
        signatureUrl,
        keyId: value.keyId,
      })
  }
  return {
    ok: true,
    document: Object.freeze({
      latest: value.latest,
      sequence: value.sequence,
      keyId: value.keyId,
      publicKey: value.publicKey,
      artifacts: Object.freeze(artifacts),
    }),
  }
}

/** Transport-level failure codes shared by manifest and signature requests. */
export type UpdateChannelBodyCode = 'network' | 'http-status' | 'empty-body' | 'response-too-large'

/** Result of one bounded update-channel body request. */
export type UpdateChannelBodyResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | {
    readonly ok: false
    readonly code: UpdateChannelBodyCode
    readonly reason: string
    readonly status: number | undefined
  }

/** Fetch-compatible request boundary used for update-channel metadata. */
export type UpdateChannelRequest = (url: string, init: RequestInit) => Promise<Response>

function isAbortFailure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'name' in value && value.name === 'AbortError'
}

function bodyFailure(code: UpdateChannelBodyCode, reason: string, status?: number): UpdateChannelBodyResult {
  return { ok: false, code, reason, status }
}

/**
 * Fetch one bounded update-channel body. Transport failures are result values;
 * only caller cancellation throws (rethrown as the original abort failure so
 * callers map it on their own error surface).
 */
export async function fetchUpdateChannelBytes(options: {
  readonly request: UpdateChannelRequest
  readonly url: string
  readonly label: string
  readonly maxBytes: number
  readonly redirect?: 'error' | 'follow'
  readonly signal?: AbortSignal
}): Promise<UpdateChannelBodyResult> {
  let response: Response
  try {
    response = await options.request(options.url, {
      method: 'GET',
      cache: 'no-store',
      redirect: options.redirect ?? 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortFailure(cause)) throw cause
    return bodyFailure('network', `the ${options.label} could not be downloaded`)
  }
  if (response.status !== 200) {
    return bodyFailure('http-status', `the ${options.label} service returned HTTP ${String(response.status)}`, response.status)
  }
  if (response.body === null) {
    return bodyFailure('empty-body', `the ${options.label} service returned an empty body`)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && DECIMAL_BYTES.test(declared) && BigInt(declared) > BigInt(options.maxBytes)) {
    return bodyFailure('response-too-large', `the ${options.label} exceeds ${String(options.maxBytes)} bytes`)
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      if (options.signal?.aborted === true) {
        await reader.cancel().catch(() => undefined)
        throw new DOMException('aborted', 'AbortError')
      }
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > options.maxBytes) {
        await reader.cancel().catch(() => undefined)
        return bodyFailure('response-too-large', `the ${options.label} exceeds ${String(options.maxBytes)} bytes`)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortFailure(cause)) throw cause
    return bodyFailure('network', `the ${options.label} could not be downloaded`)
  } finally {
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.byteLength === 0) {
    return bodyFailure('empty-body', `the ${options.label} service returned an empty body`)
  }
  return { ok: true, bytes }
}

/** Why a signed manifest fetch was rejected, including transport failures. */
export type UpdateManifestFetchCode = UpdateChannelBodyCode | 'invalid-manifest' | 'invalid-signature'

/** Result of fetching and verifying one signed manifest. */
export type VerifiedUpdateManifest =
  | {
    readonly ok: true
    readonly document: UpdateManifestDocument
    /** Verified manifest sequence, also `document.sequence`. */
    readonly sequence: number
    /** keyId of the trust root whose key produced the verified signature. */
    readonly keyId: string
    /** Fingerprint of the verified key, matching the pinned trust root. */
    readonly fingerprint: string
  }
  | { readonly ok: false; readonly code: UpdateManifestFetchCode; readonly reason: string; readonly status: number | undefined }

/**
 * Fetch one signed version manifest and verify it end to end: bounded
 * manifest and detached-signature requests, strict document parsing, trust
 * root binding, and ed25519 verification over the exact fetched bytes.
 * Business failures are result values; only caller cancellation throws.
 */
export async function fetchVerifiedUpdateManifest(options: {
  readonly request: UpdateChannelRequest
  /** Pinned manifest endpoint; callers pass their build constant or test URL. */
  readonly url: string
  readonly trustRoots: readonly UpdateChannelTrustRoot[]
  /** Detached-signature companion URL; defaults to `${url}.sig`. */
  readonly signatureUrl?: string
  readonly signal?: AbortSignal
}): Promise<VerifiedUpdateManifest> {
  const failure = (code: UpdateManifestFetchCode, reason: string, status?: number): VerifiedUpdateManifest =>
    status === undefined ? { ok: false, code, reason, status: undefined } : { ok: false, code, reason, status }

  const manifestBody = await fetchUpdateChannelBytes({
    request: options.request,
    url: options.url,
    label: 'update manifest',
    maxBytes: MAX_UPDATE_MANIFEST_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!manifestBody.ok) {
    return failure(manifestBody.code, manifestBody.reason, manifestBody.status)
  }
  const signatureBody = await fetchUpdateChannelBytes({
    request: options.request,
    url: options.signatureUrl ?? updateManifestSignatureUrl(options.url),
    label: 'update manifest signature',
    maxBytes: MAX_UPDATE_MANIFEST_SIGNATURE_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!signatureBody.ok) {
    return failure(signatureBody.code, signatureBody.reason, signatureBody.status)
  }
  const signatureText = signatureBody.bytes.toString('utf8').trim()
  if (signatureText.length === 0) {
    return failure('empty-body', 'the update manifest signature is empty')
  }

  const parsed = parseUpdateManifestDocument(manifestBody.bytes)
  if (!parsed.ok) return failure('invalid-manifest', parsed.reason)
  const verification = verifyDetachedUpdateSignature({
    content: manifestBody.bytes,
    signatureBase64: signatureText,
    keyId: parsed.document.keyId,
    publicKeyBase64: parsed.document.publicKey,
    trustRoots: options.trustRoots,
  })
  if (!verification.ok) {
    return failure('invalid-signature', `${verification.code}: ${verification.reason}`)
  }
  return {
    ok: true,
    document: parsed.document,
    sequence: parsed.document.sequence,
    keyId: verification.keyId,
    fingerprint: verification.fingerprint,
  }
}

export const UPDATE_SEQUENCE_STATE_VERSION = 1

/** Maximum accepted anti-rollback state bytes. */
export const MAX_UPDATE_SEQUENCE_STATE_BYTES = 4 * 1024

/**
 * Read the highest sequence previously persisted for this client.
 *
 * Semantics (P3-3): the state file lives under `app.getPath('userData')` and
 * is user-writable by design. It is trusted only to *restrict* — a missing,
 * corrupt, truncated, or tampered file reads as 0, which merely removes
 * downgrade protection for later checks. It can never make untrusted content
 * pass: every manifest must still carry a detached ed25519 signature from
 * `ARTIFACT_TRUST_ROOTS` regardless of this value. Inflating the value can
 * only stall update offers (an availability nuisance for the local user, who
 * already controls the machine).
 */
export async function readSeenUpdateSequence(statePath: string): Promise<number> {
  let text: string
  try {
    const stat = await lstat(statePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_UPDATE_SEQUENCE_STATE_BYTES) return 0
    text = await readFile(statePath, 'utf8')
  } catch {
    return 0
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return 0
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ['sequence', 'stateVersion'])
    || value.stateVersion !== UPDATE_SEQUENCE_STATE_VERSION
    || typeof value.sequence !== 'number'
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0) {
    return 0
  }
  return value.sequence
}

/**
 * Persist the highest verified sequence. Best-effort by callers: write
 * failures must not fail an update that already passed verification, because
 * the file only feeds the reject-older decision.
 */
export async function persistSeenUpdateSequence(statePath: string, sequence: number): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('the persisted update sequence must be a safe positive integer')
  }
  await writeFileAtomic(statePath, `${JSON.stringify({ stateVersion: UPDATE_SEQUENCE_STATE_VERSION, sequence })}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
}

/** Inputs of the monotonic-sequence anti-rollback decision. */
export interface UpdateManifestSequenceOptions {
  /** Sequence of the freshly verified manifest; safe positive integer. */
  readonly sequence: number
  /** Optional state file persisting the highest verified sequence. */
  readonly statePath?: string
  /** Optional in-memory floor for callers without a state file. */
  readonly lastSeenSequence?: number
}

/** Result of the anti-rollback decision. */
export type UpdateSequenceGuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * Enforce the manifest anti-rollback rule: a sequence strictly older than the
 * highest seen one is a rollback and is rejected. An equal sequence is
 * accepted — retrying the check or download of the same release is
 * legitimate, and the manifest content at one sequence is bound by its
 * signature. On success the sequence is persisted best-effort so later runs
 * reject anything older; persistence failures never fail the guard.
 */
export async function guardUpdateManifestSequence(
  options: UpdateManifestSequenceOptions,
): Promise<UpdateSequenceGuardResult> {
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) {
    throw new TypeError('the update manifest sequence must be a safe positive integer')
  }
  if (options.lastSeenSequence !== undefined
    && (!Number.isSafeInteger(options.lastSeenSequence) || options.lastSeenSequence < 0)) {
    throw new TypeError('lastSeenSequence must be a safe non-negative integer')
  }
  const persisted = options.statePath === undefined ? 0 : await readSeenUpdateSequence(options.statePath)
  const floor = Math.max(persisted, options.lastSeenSequence ?? 0)
  if (options.sequence < floor) {
    return {
      ok: false,
      reason: `update manifest sequence ${String(options.sequence)} is older than the last seen sequence ${String(floor)}`,
    }
  }
  if (options.statePath !== undefined && options.sequence > persisted) {
    try {
      await persistSeenUpdateSequence(options.statePath, options.sequence)
    } catch {
      // Best-effort bookkeeping: a failed write only weakens future
      // rollback protection and must not fail an already-verified manifest.
    }
  }
  return { ok: true }
}
