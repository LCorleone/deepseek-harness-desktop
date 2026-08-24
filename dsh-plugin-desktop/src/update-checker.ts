/** Headless version checks against the public DSH Desktop release service. */

import {
  ARTIFACT_TRUST_ROOTS,
  normalizeUpdateChannelTrustRoots,
  warnSkippedUpdateSignatureVerification,
  type UpdateChannelTrustRoot,
} from './update-verification.ts'
import { fetchVerifiedUpdateManifest, guardUpdateManifestSequence } from './update-manifest.ts'

/** Public endpoint returning the latest stable DSH Desktop version. */
export const DESKTOP_VERSION_ENDPOINT = 'https://www.dshdesktop.cn/api/desktop/version'

/**
 * Pinned endpoint of the signed update manifest (P3-3), accompanied by its
 * detached signature at `${DESKTOP_UPDATE_MANIFEST_ENDPOINT}.sig`. Only
 * builds with non-empty `ARTIFACT_TRUST_ROOTS` use it; development builds
 * keep using the unsigned legacy version endpoint above.
 */
export const DESKTOP_UPDATE_MANIFEST_ENDPOINT = 'https://www.dshdesktop.cn/api/desktop/update-manifest'

/** Maximum response body bytes accepted from the version service. */
export const MAX_VERSION_RESPONSE_BYTES = 4 * 1024

/** Strictly parsed SemVer components. Numeric components remain strings to avoid overflow. */
export interface ParsedSemVer {
  /** Canonical version without the optional leading `v`. */
  readonly version: string
  /** Major numeric identifier. */
  readonly major: string
  /** Minor numeric identifier. */
  readonly minor: string
  /** Patch numeric identifier. */
  readonly patch: string
  /** Ordered prerelease identifiers, or an empty list for a stable version. */
  readonly prerelease: readonly string[]
  /** Build identifiers, ignored for version precedence. */
  readonly build: readonly string[]
}

/** Fetch-compatible request function used by the headless checker. */
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one stable version check. */
export interface UpdateCheckOptions {
  /** Installed application version, expressed as canonical stable SemVer. */
  readonly currentVersion: string
  /** Caller-owned cancellation signal; the checker does not create its own timeout. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: UpdateRequest
  /** Optional legacy version-endpoint override for tests; defaults to the pinned constant. */
  readonly versionUrl?: string
  /** Signed update-channel inputs; defaults select the pinned manifest endpoint and embedded trust roots. */
  readonly updateChannel?: UpdateChannelCheckOptions
}

/** Strict-mode update channel inputs for one version check. */
export interface UpdateChannelCheckOptions {
  /** Signed version-manifest endpoint; defaults to the pinned build constant. */
  readonly manifestUrl?: string
  /** Trusted update signing keys; defaults to the embedded `ARTIFACT_TRUST_ROOTS`. */
  readonly trustRoots?: readonly UpdateChannelTrustRoot[]
  /** Highest sequence accepted without a persisted state file; defaults to 0. */
  readonly lastSeenSequence?: number
  /** Optional private file persisting the highest verified sequence (anti-rollback). */
  readonly sequenceStatePath?: string
}

/** Successful comparison returned by the stable version service. */
export type UpdateCheckResult = {
  /** Whether the service reports a version newer than the installed application. */
  readonly status: 'up-to-date' | 'update-available'
  /** Canonical installed stable version. */
  readonly currentVersion: string
  /** Canonical latest stable version returned by the service. */
  readonly latestVersion: string
  /** Present when the signed update manifest channel produced this result. */
  readonly updateChannel?: { readonly manifestSequence: number; readonly keyId: string }
}

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/**
 * Parse strict SemVer with an optional lowercase `v` prefix.
 * @param input - complete version or release tag.
 * @returns parsed identifiers, or null when the input is not valid SemVer.
 */
export function parseSemVer(input: string): ParsedSemVer | null {
  const version = input.startsWith('v') ? input.slice(1) : input
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) return null

  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => isNumeric(identifier) && hasLeadingZero(identifier))) return null

  return {
    version,
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
    build: match[5]?.split('.') ?? [],
  }
}

/**
 * Compare two strict SemVer strings without numeric overflow.
 * @param left - first strict SemVer value.
 * @param right - second strict SemVer value.
 * @returns negative, zero, or positive precedence, or null when either value is invalid.
 */
export function compareSemVerVersions(left: string, right: string): number | null {
  const leftVersion = parseSemVer(left)
  const rightVersion = parseSemVer(right)
  if (leftVersion === null || rightVersion === null) return null
  return compareParsedSemVer(leftVersion, rightVersion)
}

/**
 * Check for a newer stable DSH Desktop release.
 *
 * Builds with embedded update-channel trust roots use the signed manifest
 * channel: the pinned manifest endpoint plus its detached signature, trust
 * root binding, and the sequence anti-rollback gate. Builds without trust
 * roots (development placeholder) fall back to the unsigned legacy version
 * endpoint after logging a warning. Any request or validation failure
 * returns null.
 *
 * @param options - installed version, caller-owned signal, and optional request adapter.
 * @returns a successful comparison, or null when any request or validation step fails.
 */
export async function checkForStableUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const current = parseCanonicalStableVersion(options.currentVersion)
  if (current === null) return null

  const trustRoots = normalizeUpdateChannelTrustRoots(
    options.updateChannel === undefined || options.updateChannel.trustRoots === undefined
      ? ARTIFACT_TRUST_ROOTS
      : options.updateChannel.trustRoots,
  )
  if (trustRoots.length === 0) {
    warnSkippedUpdateSignatureVerification('the update version check')
    return checkUnsignedVersionService(options, current, options.versionUrl ?? DESKTOP_VERSION_ENDPOINT)
  }
  return checkSignedUpdateManifest(options, current, {
    url: options.updateChannel?.manifestUrl ?? DESKTOP_UPDATE_MANIFEST_ENDPOINT,
    trustRoots,
    lastSeenSequence: options.updateChannel?.lastSeenSequence,
    sequenceStatePath: options.updateChannel?.sequenceStatePath,
  })
}

async function checkUnsignedVersionService(
  options: UpdateCheckOptions,
  current: ParsedSemVer,
  endpoint: string,
): Promise<UpdateCheckResult | null> {
  const init: RequestInit = {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const request = options.request ?? defaultRequest

  let response: Response
  try {
    response = await request(endpoint, init)
  } catch {
    return null
  }
  if (response.status !== 200) return null

  let body: string
  try {
    body = await readLimitedBody(response)
  } catch {
    return null
  }

  const latest = parseVersionResponse(body)
  if (latest === null) return null
  return {
    status: compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date',
    currentVersion: current.version,
    latestVersion: latest.version,
  }
}

interface SignedChannelInputs {
  readonly url: string
  readonly trustRoots: readonly UpdateChannelTrustRoot[]
  readonly lastSeenSequence: number | undefined
  readonly sequenceStatePath: string | undefined
}

async function checkSignedUpdateManifest(
  options: UpdateCheckOptions,
  current: ParsedSemVer,
  channel: SignedChannelInputs,
): Promise<UpdateCheckResult | null> {
  let manifest: Awaited<ReturnType<typeof fetchVerifiedUpdateManifest>>
  try {
    manifest = await fetchVerifiedUpdateManifest({
      request: options.request ?? defaultRequest,
      url: channel.url,
      trustRoots: channel.trustRoots,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch {
    // Cancellation and transport surprises stay silent, like every other check failure.
    return null
  }
  if (!manifest.ok) return null

  const latest = parseCanonicalStableVersion(manifest.document.latest)
  if (latest === null) return null
  try {
    const guard = await guardUpdateManifestSequence({
      sequence: manifest.sequence,
      ...(channel.lastSeenSequence === undefined ? {} : { lastSeenSequence: channel.lastSeenSequence }),
      ...(channel.sequenceStatePath === undefined ? {} : { statePath: channel.sequenceStatePath }),
    })
    if (!guard.ok) return null
  } catch {
    return null
  }
  return {
    status: compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date',
    currentVersion: current.version,
    latestVersion: latest.version,
    updateChannel: { manifestSequence: manifest.sequence, keyId: manifest.keyId },
  }
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(MAX_VERSION_RESPONSE_BYTES)) {
    throw new Error('version response is too large')
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > MAX_VERSION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('version response is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseVersionResponse(body: string): ParsedSemVer | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.version !== 'string') return null
  return parseCanonicalStableVersion(value.version)
}

function parseCanonicalStableVersion(input: string): ParsedSemVer | null {
  const parsed = parseSemVer(input)
  return parsed !== null && parsed.prerelease.length === 0 && parsed.version === input
    ? parsed
    : null
}

function compareParsedSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumeric(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = isNumeric(leftIdentifier)
    const rightNumeric = isNumeric(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/u.test(identifier)
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
