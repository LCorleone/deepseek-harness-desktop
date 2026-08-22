/** Build-time company policy source: embedded, read-only, and fail-closed. */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN_NAME = 'dsh-plugin-desktop'
const POLICY_DIRECTORY_NAME = 'policy'
const POLICY_FILENAME = 'desktop-policy.json'
const MAX_POLICY_BYTES = 64 * 1024
const TRUST_ROOT_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const TRUST_ROOT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u

/** One ed25519 key trusted to sign company catalog manifests. */
export interface DesktopPolicyTrustRoot {
  /** Stable identifier selecting among overlapping rotation keys. */
  readonly keyId: string
  /** Lowercase SHA-256 fingerprint (64 hex characters) of the ed25519 public key. */
  readonly fingerprint: string
}

/** Immutable company policy embedded into the application at build time. */
export interface DesktopPolicy {
  /** Whether this build enforces the company policy. */
  readonly locked: boolean
  /** Company catalog network origin; null selects catalog-as-content mode. */
  readonly companyCatalogOrigin: string | null
  /** Manifest URL inside the catalog origin, or the bundled asset path in content mode. */
  readonly companyManifestUrl: string
  /** Home-directory patching is not implemented and must stay false. */
  readonly allowHomePatch: false
  /** Manual plugin installation is not implemented and must stay false. */
  readonly allowManualPluginAdd: false
  /** Trusted manifest signing keys; empty until company keys are finalized. */
  readonly trustRoots: readonly DesktopPolicyTrustRoot[]
}

function invalidPolicy(message: string): Error {
  return new Error(`${BIN_NAME}: invalid desktop policy: ${message}`)
}

function unreadablePolicy(assetPath: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${BIN_NAME}: unreadable desktop policy asset ${assetPath}: ${detail}`)
}

function parseCompanyCatalogOrigin(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw invalidPolicy('companyCatalogOrigin must be a bare https origin or null')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidPolicy('companyCatalogOrigin must be a bare https origin or null')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || (url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    throw invalidPolicy('companyCatalogOrigin must be a bare https origin or null')
  }
  return url.origin
}

function parseCompanyManifestUrl(value: unknown, companyCatalogOrigin: string | null): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || value.includes('\\')) {
    throw invalidPolicy('companyManifestUrl must be a non-empty path without NUL or backslash')
  }
  if (companyCatalogOrigin === null) {
    const segments = value.split('/')
    if (value.startsWith('/')
      || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
      throw invalidPolicy(
        'companyManifestUrl must be a relative bundled asset path when companyCatalogOrigin is null',
      )
    }
    return value
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidPolicy('companyManifestUrl must be an absolute https URL')
  }
  if (url.protocol !== 'https:') {
    throw invalidPolicy('companyManifestUrl must be an absolute https URL')
  }
  if (url.origin !== companyCatalogOrigin) {
    throw invalidPolicy('companyManifestUrl must stay inside companyCatalogOrigin')
  }
  return url.href
}

function parseTrustRoots(value: unknown): readonly DesktopPolicyTrustRoot[] {
  if (!Array.isArray(value)) throw invalidPolicy('trustRoots must be an array')
  const trustRoots: DesktopPolicyTrustRoot[] = []
  const keyIds = new Set<string>()
  const fingerprints = new Set<string>()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidPolicy('trust roots must be objects')
    }
    const object = entry as Record<string, unknown>
    const keys = Object.keys(object).sort()
    if (keys.length !== 2 || keys[0] !== 'fingerprint' || keys[1] !== 'keyId') {
      throw invalidPolicy('trust roots have unexpected fields')
    }
    const { keyId, fingerprint } = object
    if (typeof keyId !== 'string' || !TRUST_ROOT_KEY_ID_PATTERN.test(keyId)) {
      throw invalidPolicy('trust root keyId is invalid')
    }
    if (typeof fingerprint !== 'string' || !TRUST_ROOT_FINGERPRINT_PATTERN.test(fingerprint)) {
      throw invalidPolicy('trust root fingerprint must be 64 lowercase hex characters')
    }
    if (keyIds.has(keyId)) throw invalidPolicy('duplicate trust root keyId')
    if (fingerprints.has(fingerprint)) throw invalidPolicy('duplicate trust root fingerprint')
    keyIds.add(keyId)
    fingerprints.add(fingerprint)
    trustRoots.push(Object.freeze({ keyId, fingerprint }))
  }
  return Object.freeze(trustRoots)
}

/** Parse the strict desktop policy document; every deviation throws. */
export function parseDesktopPolicy(value: unknown): DesktopPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidPolicy('root must be an object')
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.length !== 6 || keys[0] !== 'allowHomePatch' || keys[1] !== 'allowManualPluginAdd'
    || keys[2] !== 'companyCatalogOrigin' || keys[3] !== 'companyManifestUrl'
    || keys[4] !== 'locked' || keys[5] !== 'trustRoots') {
    throw invalidPolicy('unexpected fields')
  }
  if (typeof object.locked !== 'boolean') throw invalidPolicy('locked must be a boolean')
  if (object.allowHomePatch !== false) throw invalidPolicy('allowHomePatch must be false')
  if (object.allowManualPluginAdd !== false) throw invalidPolicy('allowManualPluginAdd must be false')
  const companyCatalogOrigin = parseCompanyCatalogOrigin(object.companyCatalogOrigin)
  const companyManifestUrl = parseCompanyManifestUrl(object.companyManifestUrl, companyCatalogOrigin)
  return Object.freeze({
    locked: object.locked,
    companyCatalogOrigin,
    companyManifestUrl,
    allowHomePatch: false,
    allowManualPluginAdd: false,
    trustRoots: parseTrustRoots(object.trustRoots),
  })
}

/** Resolve the policy asset shipped beside a built module inside `lib/`. */
export function desktopPolicyAssetPath(moduleUrl: string): string {
  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) {
    throw new TypeError(`${BIN_NAME}: desktop policy module URL must be a non-empty file URL`)
  }
  return join(
    dirname(fileURLToPath(new URL(moduleUrl))),
    POLICY_DIRECTORY_NAME,
    POLICY_FILENAME,
  )
}

/** Read and strictly parse one policy asset; failures throw instead of degrading. */
export function readDesktopPolicy(assetPath?: string): DesktopPolicy {
  const path = assetPath ?? desktopPolicyAssetPath(import.meta.url)
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new TypeError(`${BIN_NAME}: desktop policy asset path must be absolute without NUL`)
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw unreadablePolicy(path, cause)
  }
  if (text.length > MAX_POLICY_BYTES) {
    throw invalidPolicy(`policy exceeds ${String(MAX_POLICY_BYTES)} bytes`)
  }
  let document: unknown
  try {
    document = JSON.parse(text) as unknown
  } catch (cause) {
    throw unreadablePolicy(path, cause)
  }
  return parseDesktopPolicy(document)
}

/** Fixed names and limits of the embedded desktop policy asset. */
export const desktopPolicyConstants = Object.freeze({
  policyDirectoryName: POLICY_DIRECTORY_NAME,
  policyFilename: POLICY_FILENAME,
  policyRelativeAssetPath: `${POLICY_DIRECTORY_NAME}/${POLICY_FILENAME}`,
  maxPolicyBytes: MAX_POLICY_BYTES,
})
