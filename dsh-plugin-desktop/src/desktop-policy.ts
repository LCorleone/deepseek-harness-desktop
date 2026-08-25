/** Build-time company policy source: embedded, read-only, and fail-closed. */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archivedAsarPath, isPackagedApplicationPath } from './packaged-runtime-path.ts'

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

/**
 * Resolve the policy asset shipped beside a built module inside `lib/`.
 *
 * Resolution prefers the in-archive copy: when this module was loaded from the
 * physical `app.asar.unpacked` tree (profile-fallback symlinks resolve package
 * exports there, even inside the Electron process), the returned path points
 * at the virtual `app.asar` entry instead of the user-writable physical file.
 * Only the Electron process can read that path, which is exactly the main
 * process — the only caller allowed to read the policy asset directly; the
 * bundled-Node CLI child receives the policy through the environment hand-off
 * below instead of re-reading any file.
 *
 * Advisory positioning: `lib/**` is dual-homed (in `app.asar` and physically
 * under `app.asar.unpacked`), and Electron serves in-archive reads of unpacked
 * entries from the physical file, so this pins the resolution to the packaged
 * layout rather than adding a new boundary — it removes the trivially
 * editable-JSON channel for main-process consumers and leaves the higher-cost
 * tampering surfaces (rewriting application code or the archive) to code
 * signing.
 * @param moduleUrl - URL of a module emitted below the package's `lib` directory.
 * @returns the policy asset path, in-archive when a packaged layout is detected.
 */
export function desktopPolicyAssetPath(moduleUrl: string): string {
  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) {
    throw new TypeError(`${BIN_NAME}: desktop policy module URL must be a non-empty file URL`)
  }
  return archivedAsarPath(join(
    dirname(fileURLToPath(new URL(moduleUrl))),
    POLICY_DIRECTORY_NAME,
    POLICY_FILENAME,
  ))
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

/**
 * Environment names of the policy hand-off the Electron launcher injects into
 * bundled-Node CLI children (P3 fix: the CLI process cannot read inside
 * `app.asar`, and the physical `app.asar.unpacked` policy copy is
 * user-writable, so the CLI must not re-read it).
 *
 * Format: four case-insensitive environment keys carrying a JSON-free
 * encoding of the policy — `1`/`0` for `locked`, the bare https origin or an
 * empty string for content mode, the manifest URL verbatim, and
 * comma-separated `keyId:fingerprint` trust-root pairs (both components are
 * constrained to alphabets without commas, colons inside keyIds, or any
 * quoting characters, so the values stay safe inside generated POSIX and
 * batch shims). The decoding side re-parses through the strict policy
 * parser, so any tampered or malformed hand-off fails closed.
 *
 * Advisory positioning: the parent that sets these variables is trusted, so an
 * actor who can rewrite the physical `desktop-cli.js` under
 * `app.asar.unpacked` can change how they are consumed — the same permission
 * as rewriting any shipped JavaScript. The hand-off removes the cheaper
 * channel of editing a plain JSON file with a text editor; the remaining
 * surface is code-level tampering, which the asar-integrity fuse and code
 * signing (release builds) address at their own advisory level.
 */
export const DESKTOP_POLICY_ENVIRONMENT = Object.freeze({
  locked: 'DSH_DESKTOP_POLICY_LOCKED',
  catalogOrigin: 'DSH_DESKTOP_POLICY_CATALOG_ORIGIN',
  manifestUrl: 'DSH_DESKTOP_POLICY_MANIFEST_URL',
  trustRoots: 'DSH_DESKTOP_POLICY_TRUST_ROOTS',
})

/** Decode one `keyId:fingerprint` trust-root pair of the environment hand-off. */
function parseTrustRootPair(pair: string): DesktopPolicyTrustRoot {
  const separator = pair.lastIndexOf(':')
  if (separator <= 0) {
    throw invalidPolicy(`trust-root environment pairs must be keyId:fingerprint (got ${JSON.stringify(pair)})`)
  }
  return { keyId: pair.slice(0, separator), fingerprint: pair.slice(separator + 1) }
}

/**
 * Encode one policy as the environment hand-off injected into CLI children.
 * @param policy - the policy the Electron main process already read and parsed.
 * @returns environment entries safe for POSIX assignments and batch `set` lines.
 */
/** Sentinel for an absent value: Windows `set "VAR="` deletes the variable, so empty strings cannot survive the batch shim. */
const ENVIRONMENT_ABSENT = '-'

export function desktopPolicyEnvironmentEntries(
  policy: DesktopPolicy,
): Record<string, string> {
  return {
    [DESKTOP_POLICY_ENVIRONMENT.locked]: policy.locked ? '1' : '0',
    // A real origin is always a bare https URL, so `-` can never collide.
    [DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]: policy.companyCatalogOrigin ?? ENVIRONMENT_ABSENT,
    [DESKTOP_POLICY_ENVIRONMENT.manifestUrl]: policy.companyManifestUrl,
    // Real entries are `keyId:fingerprint` pairs; `-` cannot collide either.
    [DESKTOP_POLICY_ENVIRONMENT.trustRoots]: policy.trustRoots.length === 0
      ? ENVIRONMENT_ABSENT
      : policy.trustRoots
        .map(trustRoot => `${trustRoot.keyId}:${trustRoot.fingerprint}`)
        .join(','),
  }
}

/** Remove and return one case-insensitive environment hand-off value. */
function takeEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  let result: string | undefined
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() !== name) continue
    const value = environment[key]
    if (value !== undefined && result !== undefined && value !== result) {
      throw invalidPolicy(`conflicting ${name} environment values`)
    }
    result ??= value
    delete environment[key]
  }
  return result
}

/**
 * Consume the launcher-injected policy hand-off and decode it strictly.
 *
 * The four hand-off keys are removed from the environment so the upstream CLI
 * and its children never inherit Desktop-owned policy markers. Behavior by
 * layout:
 *
 * - hand-off present — decoded and strictly re-parsed; any malformed value
 *   throws (fail closed, never a silent downgrade);
 * - hand-off absent in a packaged layout (`app.asar` beside this module) —
 *   throws instead of falling back to the user-writable physical asset;
 * - hand-off absent in an unpackaged development checkout — returns
 *   `undefined` so the caller keeps reading the shipped `lib/` asset.
 *
 * @param environment - mutable process environment of the CLI child.
 * @param moduleUrl - URL of the module deciding the packaged-layout check.
 * @returns the decoded policy, or undefined when a dev run must fall back to the asset.
 */
export function desktopPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
  moduleUrl: string = import.meta.url,
): DesktopPolicy | undefined {
  const locked = takeEnvironmentValue(environment, DESKTOP_POLICY_ENVIRONMENT.locked)
  const catalogOrigin = takeEnvironmentValue(environment, DESKTOP_POLICY_ENVIRONMENT.catalogOrigin)
  const manifestUrl = takeEnvironmentValue(environment, DESKTOP_POLICY_ENVIRONMENT.manifestUrl)
  const trustRoots = takeEnvironmentValue(environment, DESKTOP_POLICY_ENVIRONMENT.trustRoots)
  const present = [locked, catalogOrigin, manifestUrl, trustRoots].filter(value => value !== undefined)
  if (present.length === 0) {
    if (isPackagedApplicationPath(fileURLToPath(new URL(moduleUrl)))) {
      throw invalidPolicy(
        'the desktop launcher did not inject the policy environment hand-off;'
        + ' a packaged CLI child refuses to read the user-writable policy asset',
      )
    }
    return undefined
  }
  if (present.length !== 4) {
    throw invalidPolicy('the policy environment hand-off must carry all four entries')
  }
  const trustRootPairs = trustRoots === ENVIRONMENT_ABSENT
    ? []
    : trustRoots!.split(',')
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: catalogOrigin === ENVIRONMENT_ABSENT ? null : catalogOrigin,
    companyManifestUrl: manifestUrl!,
    locked: locked === '1' ? true : locked === '0' ? false : undefined,
    trustRoots: trustRootPairs.map(pair => parseTrustRootPair(pair)),
  })
}
