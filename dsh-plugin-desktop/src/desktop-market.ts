/**
 * Machine-level Desktop Market provider selection and fail-safe state.
 * The effective provider is derived from the embedded desktop policy, never
 * from the user-writable request file alone.
 *
 * This module also owns the P7 dual-channel company-manifest surface: the
 * source-aware strict manifest verifier (`source: npm | tarball`), the
 * controlled tarball download/staging step, and the tarball install
 * orchestration that re-verifies the installed tree against the signed
 * `treeDigest`. See the dual-channel section below.
 */

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  type Dirent,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { validRange } from 'semver'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  canonicalJsonText,
  ed25519PublicKeyFingerprint,
  type CompanyManifestTrustRoot,
  type CompanyManifestVerificationCode,
} from 'dsh-community-market'
import { fetchUpdateChannelBytes, type UpdateChannelRequest } from './update-manifest.ts'
import {
  desktopMarketTarballStagingPath,
  DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY,
  type DesktopControlledMarketTarball,
  type DesktopPnpm,
  type DesktopPluginInstallRecovery,
} from './pnpm.ts'
import { readDesktopPolicy, type DesktopPolicy } from './desktop-policy.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const STATE_VERSION = 1
const STATE_DIRECTORY_NAME = 'desktop-market'
const STATE_FILENAME = 'state.json'
const STATE_DIRECTORY_MODE = 0o700
const STATE_FILE_MODE = 0o600
const MAX_STATE_BYTES = 4 * 1024

/** Market implementation selected for the next Desktop generation. */
export type DesktopMarketProvider = 'disabled' | 'community-market' | 'dsh-market'

/** Canonical Loader identities owned by the Desktop provider switch. */
export const DESKTOP_MARKET_IDENTITIES = Object.freeze({
  community: Object.freeze({
    provider: 'community-market' as const,
    rowId: 'community-market',
    packageName: 'dsh-community-market',
  }),
  dshMarket: Object.freeze({
    provider: 'dsh-market' as const,
    rowId: 'dsh-market',
    packageName: 'dshmarket',
  }),
})

/**
 * Persisted machine-level provider request. The user-writable state records the
 * request only; the effective provider is derived from the embedded policy.
 */
export interface DesktopMarketStateV1 {
  readonly version: 1
  readonly requested: DesktopMarketProvider
  readonly legacyDefaulted: false
}

/**
 * Immutable startup view. `requested` is a diagnostic record of the persisted
 * request; `effective` is derived from it and the desktop policy and stays the
 * company provider while the policy is locked.
 */
export interface DesktopMarketSnapshot {
  readonly requested: DesktopMarketProvider
  readonly effective: DesktopMarketProvider
  readonly legacyDefaulted: boolean
}

/**
 * The provider the desktop policy pins while the build is locked: this
 * repository's market shell, where the source lock and install target
 * authority are enforced. The upstream `dshmarket` bundle stays out of locked
 * builds because its install path is not policy-controlled.
 */
const COMPANY_PROVIDER: DesktopMarketProvider = DESKTOP_MARKET_IDENTITIES.community.provider

const DEFAULT_REQUESTED_PROVIDER: DesktopMarketProvider = 'disabled'

/** Derive the effective provider: policy lock wins over any persisted request. */
function effectiveProvider(
  requested: DesktopMarketProvider,
  policy: DesktopPolicy,
): DesktopMarketProvider {
  return policy.locked ? COMPANY_PROVIDER : requested
}

function snapshot(
  requested: DesktopMarketProvider,
  legacyDefaulted: boolean,
  policy: DesktopPolicy,
): DesktopMarketSnapshot {
  return Object.freeze({
    requested,
    effective: effectiveProvider(requested, policy),
    legacyDefaulted,
  })
}

/** Fail-safe view used when the persisted state is missing or unusable. */
function failSafeSnapshot(policy: DesktopPolicy): DesktopMarketSnapshot {
  return snapshot(DEFAULT_REQUESTED_PROVIDER, true, policy)
}

/** Preserve the explicit request while projecting a generation-local effective provider. */
export function desktopMarketSnapshotWithEffective(
  current: DesktopMarketSnapshot,
  effective: DesktopMarketProvider,
): DesktopMarketSnapshot {
  if (!isProvider(current.requested) || !isProvider(current.effective)
    || typeof current.legacyDefaulted !== 'boolean' || !isProvider(effective)) {
    throw new TypeError(`${BIN_NAME}: invalid Desktop Market snapshot`)
  }
  return Object.freeze({
    requested: current.requested,
    effective,
    legacyDefaulted: current.legacyDefaulted,
  })
}

/**
 * Raised when a provider selection is persisted while the policy locks the
 * build to the company provider. Locked builds keep the user-writable request
 * free of providers the composition layer would have to reject anyway.
 */
export class MarketProviderLockError extends Error {
  constructor() {
    super('desktop market provider selection is locked to the company provider by deployment policy')
    this.name = 'MarketProviderLockError'
  }
}

function isProvider(value: unknown): value is DesktopMarketProvider {
  return value === 'disabled' || value === 'community-market' || value === 'dsh-market'
}

function invalidState(message: string): Error {
  return new Error(`${BIN_NAME}: invalid Desktop Market state: ${message}`)
}

/** Validate a user-data directory and return its fixed machine-level state path. */
export function desktopMarketStatePath(userDataDir: string): string {
  if (typeof userDataDir !== 'string' || !isAbsolute(userDataDir)
    || userDataDir.includes('\0') || userDataDir.length === 0) {
    throw new TypeError(`${BIN_NAME}: Desktop Market user-data directory must be an absolute path without NUL`)
  }
  return join(userDataDir, STATE_DIRECTORY_NAME, STATE_FILENAME)
}

/** Validate an exact state path before reading or writing it. */
export function assertDesktopMarketStatePath(statePath: string): void {
  if (typeof statePath !== 'string' || !isAbsolute(statePath)
    || statePath.includes('\0') || basename(statePath) !== STATE_FILENAME
    || basename(dirname(statePath)) !== STATE_DIRECTORY_NAME) {
    throw new TypeError(`${BIN_NAME}: Desktop Market state path must be <userData>/${STATE_DIRECTORY_NAME}/${STATE_FILENAME}`)
  }
}

/** Parse the strict version-one persisted state document. */
export function parseDesktopMarketState(value: unknown): DesktopMarketStateV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidState('root must be an object')
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.length !== 3 || keys[0] !== 'legacyDefaulted' || keys[1] !== 'requested' || keys[2] !== 'version') {
    throw invalidState('unexpected fields')
  }
  if (object.version !== STATE_VERSION) throw invalidState('unsupported version')
  if (!isProvider(object.requested)) throw invalidState('requested provider is invalid')
  if (object.legacyDefaulted !== false) throw invalidState('legacyDefaulted must be false')
  return Object.freeze({
    version: 1,
    requested: object.requested,
    legacyDefaulted: false,
  })
}

function readRawState(statePath: string): unknown {
  const pathInfo = lstatSync(statePath)
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw invalidState('state must be a regular file')
  }
  const descriptor = openSync(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size > MAX_STATE_BYTES) {
      throw invalidState('state must be a regular file within the size limit')
    }
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Read the state without ever writing a migration or repair marker. A missing
 * or corrupted state fails safe to the disabled request; the policy lock still
 * pins the effective provider. Policy resolution failures throw (fail-closed).
 */
export function readDesktopMarketState(
  statePath: string,
  policy: DesktopPolicy = readDesktopPolicy(),
): DesktopMarketSnapshot {
  assertDesktopMarketStatePath(statePath)
  try {
    return snapshot(parseDesktopMarketState(readRawState(statePath)).requested, false, policy)
  } catch {
    return failSafeSnapshot(policy)
  }
}

/** Read the state using the Electron user-data directory convention. */
export function readDesktopMarketStateForUserData(
  userDataDir: string,
  policy: DesktopPolicy = readDesktopPolicy(),
): DesktopMarketSnapshot {
  return readDesktopMarketState(desktopMarketStatePath(userDataDir), policy)
}

function assertRealStateDirectory(statePath: string): void {
  const directory = dirname(statePath)
  try {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${BIN_NAME}: Desktop Market state directory must be a real directory`)
    }
    chmodSync(directory, STATE_DIRECTORY_MODE)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(directory, { recursive: true, mode: STATE_DIRECTORY_MODE })
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${BIN_NAME}: Desktop Market state directory must be a real directory`)
      }
      chmodSync(directory, STATE_DIRECTORY_MODE)
      return
    }
    throw cause
  }
}

/**
 * Persist an explicit provider request with a locked, atomic replacement.
 * Locked builds accept only the pinned company provider: any other request
 * throws {@link MarketProviderLockError} without touching the state file, so
 * the persisted request can never describe a provider the policy disallows.
 * Writing it never changes the effective provider.
 */
export async function writeDesktopMarketSelection(
  statePath: string,
  provider: DesktopMarketProvider,
  policy: DesktopPolicy = readDesktopPolicy(),
): Promise<DesktopMarketSnapshot> {
  assertDesktopMarketStatePath(statePath)
  if (!isProvider(provider)) throw new TypeError(`${BIN_NAME}: invalid Desktop Market provider`)
  if (policy.locked && provider !== COMPANY_PROVIDER) throw new MarketProviderLockError()
  assertRealStateDirectory(statePath)
  const state: DesktopMarketStateV1 = Object.freeze({
    version: 1,
    requested: provider,
    legacyDefaulted: false,
  })
  const rendered = `${JSON.stringify(state)}\n`
  await withFileLock(statePath, async () => {
    assertRealStateDirectory(statePath)
    await writeFileAtomic(statePath, rendered, {
      mode: STATE_FILE_MODE,
      dirMode: STATE_DIRECTORY_MODE,
    })
  })
  return snapshot(provider, false, policy)
}

/**
 * Persist an explicit provider request using the fixed Electron user-data
 * path. Locked builds reject every provider except the pinned company
 * provider before any state is written; writing it never changes the
 * effective provider while the policy is locked.
 */
export async function selectDesktopMarketProvider(
  userDataDir: string,
  provider: DesktopMarketProvider,
  policy: DesktopPolicy = readDesktopPolicy(),
): Promise<DesktopMarketSnapshot> {
  return writeDesktopMarketSelection(desktopMarketStatePath(userDataDir), provider, policy)
}

export const desktopMarketStateConstants = Object.freeze({
  stateVersion: STATE_VERSION,
  stateDirectoryName: STATE_DIRECTORY_NAME,
  stateFilename: STATE_FILENAME,
  stateDirectoryMode: STATE_DIRECTORY_MODE,
  stateFileMode: STATE_FILE_MODE,
})

// ---------------------------------------------------------------------------
// P7 dual channel: source-aware company manifest + controlled tarball path.
//
// `verifyDesktopCompanyManifest` below is the verifier of every production
// consumer of the company manifest — boot verification
// (`boot-verification.ts`), the locked terminal add gate
// (`cli-install-channel.ts`), and the origin-mode catalog scan — and keeps
// rejecting unknown entry keys with `additionalProperties: false`
// semantics. Relative to the market library's `verifyCompanyManifest` it
// extends exactly one thing: entries may carry a signed `source` field
// selecting the install channel —
//
//   `source` absent or `{"kind":"npm"}`  → the public-registry channel (today's
//                                        behavior, byte-for-byte unchanged:
//                                        a manifest without `source` verifies
//                                        identically here and in the market
//                                        library)
//   `{"kind":"tarball","url":…,"integrity":…}` → the intranet-GitLab channel:
//                                        the client downloads the tarball from
//                                        the policy-pinned catalog origin,
//                                        verifies the signed sha512 over the
//                                        downloaded bytes, stages it inside the
//                                        profile's controlled staging area, and
//                                        installs it through the pnpm boundary's
//                                        one constructible tarball target.
//
// Field-unaware clients reject a `source`-carrying manifest whole (one
// unknown key). "Field-aware build" for the fleet publication gate (see
// tools/company-catalog/README.md, "Fleet upgrade ordering (publication
// gate)", and publish-local.mjs) therefore means concretely: a build in
// which BOTH boot verification and the locked terminal add gate verify
// through `verifyDesktopCompanyManifest` — the P7 batch-2 wiring. Carrying
// this verifier unused (batch 1) is not enough: boot and the terminal gate
// still rejected `source`-carrying manifests whole there. No `source`-
// carrying manifest may be published before the whole fleet runs builds at
// or beyond that switch.
// ---------------------------------------------------------------------------

/** The npm channel: install the exact public-registry version (the default). */
export interface DesktopCompanyEntrySourceNpm {
  readonly kind: 'npm'
}

/**
 * The tarball channel: install the package from the intranet-hosted tarball.
 * `url` must live on the deployment policy's `companyCatalogOrigin` and
 * `integrity` is the signed sha512 of the tarball file itself — the same
 * value pnpm pins into the profile lockfile's `resolution.integrity` for a
 * `file:` install, which is why the entry's top-level `integrity` must equal
 * it (enforced below).
 */
export interface DesktopCompanyEntrySourceTarball {
  readonly kind: 'tarball'
  readonly url: string
  readonly integrity: string
}

/** Signed install-channel selection of one manifest entry. */
export type DesktopCompanyEntrySource = DesktopCompanyEntrySourceNpm | DesktopCompanyEntrySourceTarball

/** Runtime compatibility ranges of one signed entry. */
export interface DesktopCompanyManifestRuntimeRanges {
  readonly dshRuntimeVersion: string
  readonly cordisRuntimeVersion?: string
  readonly nodeRuntimeVersion?: string
}

/** Repository identity of one signed entry. */
export interface DesktopCompanyManifestRepository {
  readonly url: string
  readonly subdirectory?: string
}

/** One entry of a source-aware company manifest. */
export interface DesktopCompanyManifestPackage {
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly bundlePatch: string
  readonly repository: DesktopCompanyManifestRepository
  readonly revoked: boolean
  readonly runtime: DesktopCompanyManifestRuntimeRanges
  readonly treeDigest?: string
  readonly approvedBuilds?: readonly string[]
  readonly source?: DesktopCompanyEntrySource
}

/** A company manifest whose entries may carry the signed `source` channel. */
export interface DesktopCompanyManifest {
  readonly manifestVersion: '1.0.0'
  readonly sequence: number
  readonly expiresAt: string
  readonly packages: readonly DesktopCompanyManifestPackage[]
  readonly signature: {
    readonly keyId: string
    readonly publicKey: string
    readonly value: string
  }
}

/** Options of {@link verifyDesktopCompanyManifest}. */
export interface DesktopCompanyManifestVerificationOptions {
  /** Policy-pinned signing keys; a manifest signed by any listed key verifies. */
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  /**
   * Origin every tarball `source.url` must live on. `null` (content-mode
   * policies) rejects every tarball entry: without a pinned origin there is
   * no host the desktop would download a plugin tarball from.
   */
  readonly companyCatalogOrigin: string | null
  /** Anti-rollback floor; an equal sequence replays, a lower one is stale. */
  readonly lastSeenSequence?: number
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Result of verifying company manifest bytes with the dual-channel schema. */
export type DesktopCompanyManifestVerification =
  | {
    readonly ok: true
    readonly manifest: DesktopCompanyManifest
    readonly keyId: string
    readonly fingerprint: string
    readonly verifiedAt: number
  }
  | {
    readonly ok: false
    readonly code: CompanyManifestVerificationCode
    readonly reason: string
  }

const COMPANY_MANIFEST_KEYS = ['expiresAt', 'manifestVersion', 'packages', 'sequence', 'signature'] as const
const COMPANY_ENTRY_REQUIRED_KEYS = ['bundlePatch', 'integrity', 'packageName', 'repository', 'revoked', 'runtime', 'version'] as const
const COMPANY_ENTRY_OPTIONAL_KEYS = ['approvedBuilds', 'source', 'treeDigest'] as const
const COMPANY_SIGNATURE_KEYS = ['keyId', 'publicKey', 'value'] as const
const COMPANY_RUNTIME_KEYS = ['cordisRuntimeVersion', 'dshRuntimeVersion', 'nodeRuntimeVersion'] as const
const COMPANY_REPOSITORY_KEYS = ['subdirectory', 'url'] as const
const COMPANY_NPM_SOURCE_KEYS = ['kind'] as const
const COMPANY_TARBALL_SOURCE_KEYS = ['integrity', 'kind', 'url'] as const
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const EXACT_STABLE_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u
const TREE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u
const SIGNATURE_VALUE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u
const BUNDLE_PATCH_FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u
const REPOSITORY_SUBDIRECTORY_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/u
const MAX_PACKAGES = 10_000
const MAX_PACKAGE_NAME_LENGTH = 214
const MAX_APPROVED_BUILDS = 128
const MAX_TARBALL_URL_LENGTH = 2048
const MAX_SEQUENCE = 9_007_199_254_740_991

const unknownFields = (value: Record<string, unknown>, allowed: readonly string[]): readonly string[] =>
  Object.keys(value).filter(key => !allowed.includes(key))

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Standard-base64 sha512 shape with a decodable 64-byte digest, mirroring the market verifier. */
function isSha512Integrity(value: unknown): value is string {
  if (typeof value !== 'string' || !SHA512_INTEGRITY_PATTERN.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

/** Safe relative in-package path, mirroring the market verifier's guard. */
function isSafeBundlePatchPath(value: string): boolean {
  if (value.includes('\\') || BUNDLE_PATCH_FORBIDDEN.test(value) || value.length === 0 || value.length > 512) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

/** The schema's https URI grammar: https, credential-free, standard-port host spelling, no fragment. */
function isHttpsUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TARBALL_URL_LENGTH) return false
  if (!/^https:\/\/(?![^/?#]*@)(?![^/?#]*:)[^#]+$/u.test(value)) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Validate and parse one entry's `source` channel selection (strict: unknown keys reject the manifest). */
function parseEntrySource(
  value: unknown,
  at: string,
  companyCatalogOrigin: string | null,
): DesktopCompanyEntrySource {
  if (value === undefined) return { kind: 'npm' }
  if (!isPlainObject(value)) throw new Error(`${at}.source must be an object`)
  const kind = value.kind
  if (kind === 'npm') {
    const unknown = unknownFields(value, COMPANY_NPM_SOURCE_KEYS)
    if (unknown.length > 0) {
      throw new Error(`${at}.source is the npm channel and must not carry ${unknown.join(', ')}`)
    }
    return { kind: 'npm' }
  }
  if (kind !== 'tarball') throw new Error(`${at}.source.kind must be 'npm' or 'tarball'`)
  const unknown = unknownFields(value, COMPANY_TARBALL_SOURCE_KEYS)
  if (unknown.length > 0) throw new Error(`${at}.source has unknown field(s) ${unknown.join(', ')}`)
  const url = value.url
  const integrity = value.integrity
  if (!isHttpsUri(url)) throw new Error(`${at}.source.url must be a credential-free https URL without a fragment or an explicit port`)
  if (companyCatalogOrigin === null) {
    throw new Error(`${at}.source is the tarball channel, which requires an origin-mode catalog policy (companyCatalogOrigin is null)`)
  }
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    throw new Error(`${at}.source.url is not a parseable URL`)
  }
  if (origin !== companyCatalogOrigin) {
    throw new Error(`${at}.source.url must stay inside the pinned catalog origin ${companyCatalogOrigin} (got ${origin})`)
  }
  if (!isSha512Integrity(integrity)) {
    throw new Error(`${at}.source.integrity must be the base64 SHA-512 digest of the tarball file`)
  }
  return { kind: 'tarball', url, integrity }
}

/** Validate one parsed manifest value against the dual-channel schema mirror and normalize it. */
function parseDesktopCompanyManifestValue(
  value: unknown,
  companyCatalogOrigin: string | null,
): DesktopCompanyManifest {
  if (!isPlainObject(value)) throw new Error('the company manifest must be a JSON object')
  {
    const unknown = unknownFields(value, COMPANY_MANIFEST_KEYS)
    if (unknown.length > 0) throw new Error(`the company manifest has unknown field(s) ${unknown.join(', ')}`)
    for (const key of COMPANY_MANIFEST_KEYS) {
      if (!(key in value)) throw new Error(`the company manifest is missing ${key}`)
    }
  }
  if (value.manifestVersion !== '1.0.0') throw new Error('the company manifest version must be 1.0.0')
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || (value.sequence as number) > MAX_SEQUENCE) {
    throw new Error('the company manifest sequence must be a safe positive integer')
  }
  if (typeof value.expiresAt !== 'string' || value.expiresAt.length < 20 || value.expiresAt.length > 64
    || Number.isNaN(Date.parse(value.expiresAt))) {
    throw new Error('the company manifest expiresAt must be an RFC 3339 timestamp')
  }
  if (!Array.isArray(value.packages) || value.packages.length > MAX_PACKAGES) {
    throw new Error(`the company manifest packages must be an array of at most ${String(MAX_PACKAGES)} entries`)
  }
  if (!isPlainObject(value.signature)) throw new Error('the company manifest signature must be an object')
  {
    const unknown = unknownFields(value.signature, COMPANY_SIGNATURE_KEYS)
    if (unknown.length > 0) throw new Error(`the company manifest signature has unknown field(s) ${unknown.join(', ')}`)
    for (const key of COMPANY_SIGNATURE_KEYS) {
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
  const seen = new Set<string>()
  const packages: DesktopCompanyManifestPackage[] = []
  for (const [index, rawEntry] of value.packages.entries()) {
    const at = `packages[${String(index)}]`
    if (!isPlainObject(rawEntry)) throw new Error(`${at} must be an object`)
    const unknown = unknownFields(rawEntry, [...COMPANY_ENTRY_REQUIRED_KEYS, ...COMPANY_ENTRY_OPTIONAL_KEYS])
    if (unknown.length > 0) throw new Error(`${at} has unknown field(s) ${unknown.join(', ')} — the whole manifest is rejected`)
    for (const key of COMPANY_ENTRY_REQUIRED_KEYS) {
      if (!(key in rawEntry)) throw new Error(`${at} is missing ${key}`)
    }
    if (typeof rawEntry.packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(rawEntry.packageName)
      || rawEntry.packageName.length > MAX_PACKAGE_NAME_LENGTH) {
      throw new Error(`${at}.packageName must be an npm package name (scoped names allowed, lowercase)`)
    }
    if (typeof rawEntry.version !== 'string' || !EXACT_STABLE_VERSION_PATTERN.test(rawEntry.version)) {
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
      const repositoryUnknown = unknownFields(rawEntry.repository, COMPANY_REPOSITORY_KEYS)
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
    let dshRuntimeVersion: string | undefined
    let cordisRuntimeVersion: string | undefined
    let nodeRuntimeVersion: string | undefined
    {
      const runtimeUnknown = unknownFields(rawEntry.runtime, COMPANY_RUNTIME_KEYS)
      if (runtimeUnknown.length > 0) throw new Error(`${at}.runtime has unknown field(s) ${runtimeUnknown.join(', ')}`)
      for (const field of COMPANY_RUNTIME_KEYS) {
        const range = rawEntry.runtime[field]
        if (range === undefined) continue
        if (typeof range !== 'string' || range.length === 0 || range.length > 256 || validRange(range) === null) {
          throw new Error(`${at}.runtime.${field} is not a valid node-semver range`)
        }
        if (field === 'dshRuntimeVersion') dshRuntimeVersion = range
        else if (field === 'cordisRuntimeVersion') cordisRuntimeVersion = range
        else nodeRuntimeVersion = range
      }
      if (dshRuntimeVersion === undefined) {
        throw new Error(`${at}.runtime.dshRuntimeVersion is required`)
      }
    }
    const runtime: DesktopCompanyManifestRuntimeRanges = {
      dshRuntimeVersion,
      ...(cordisRuntimeVersion === undefined ? {} : { cordisRuntimeVersion }),
      ...(nodeRuntimeVersion === undefined ? {} : { nodeRuntimeVersion }),
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
      const builds = new Set<string>()
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
        `${at} pins integrity ${String(rawEntry.integrity).slice(0, 24)}… but its tarball source pins ${source.integrity.slice(0, 24)}… — `
          + 'a tarball-channel entry must pin the tarball file\'s own sha512, because that is the integrity the profile lockfile records for a file: install',
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
      repository: {
        url: rawEntry.repository.url,
        ...(rawEntry.repository.subdirectory === undefined ? {} : { subdirectory: rawEntry.repository.subdirectory }),
      },
      revoked: rawEntry.revoked,
      runtime,
      ...(rawEntry.treeDigest === undefined ? {} : { treeDigest: rawEntry.treeDigest }),
      ...(rawEntry.approvedBuilds === undefined ? {} : { approvedBuilds: [...rawEntry.approvedBuilds as string[]] }),
      ...(rawEntry.source === undefined ? {} : { source }),
    })
  }
  return {
    manifestVersion: '1.0.0',
    sequence: value.sequence as number,
    expiresAt: value.expiresAt,
    packages,
    signature: {
      keyId: value.signature.keyId as string,
      publicKey: value.signature.publicKey as string,
      value: value.signature.value as string,
    },
  }
}

/** DER SPKI prefix of a raw 32-byte ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** Import a raw 32-byte ed25519 public key as a verify-capable KeyObject. */
function ed25519PublicKeyFromRaw(raw: Buffer): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

/**
 * Verify company manifest bytes end to end under the dual-channel schema:
 * canonical JSON byte equality, the strict shape above (every unknown key
 * rejects the whole manifest — `source` is the one recognized extension),
 * trust-root binding, the detached ed25519 signature over the canonical
 * unsigned window, the anti-rollback sequence floor, and expiry. For
 * manifests without `source` the decisions are byte-for-byte those of the
 * market library's verifier; `source`-carrying manifests verify only here.
 */
export function verifyDesktopCompanyManifest(
  raw: string | Uint8Array,
  options: DesktopCompanyManifestVerificationOptions,
): DesktopCompanyManifestVerification {
  if (options === null || typeof options !== 'object' || !Array.isArray(options.trustRoots)) {
    throw new TypeError(`${BIN_NAME}: company manifest verification requires trust roots`)
  }
  if (options.companyCatalogOrigin !== null && (
    typeof options.companyCatalogOrigin !== 'string' || options.companyCatalogOrigin.length === 0
  )) {
    throw new TypeError(`${BIN_NAME}: companyCatalogOrigin must be a non-empty https origin or null`)
  }
  const lastSeenSequence = options.lastSeenSequence ?? 0
  if (!Number.isSafeInteger(lastSeenSequence) || lastSeenSequence < 0) {
    throw new TypeError(`${BIN_NAME}: lastSeenSequence must be a safe non-negative integer`)
  }
  const now = options.now ?? Date.now
  const verifiedAt = now()
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt)) {
    throw new TypeError(`${BIN_NAME}: now must return a finite epoch millisecond timestamp`)
  }
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 'malformed-json', reason: 'company manifest is not valid JSON' }
  }
  let canonical: string
  try {
    canonical = canonicalJsonText(parsed)
  } catch (cause) {
    return { ok: false, code: 'non-canonical', reason: cause instanceof Error ? cause.message : String(cause) }
  }
  if (canonical !== text) {
    return { ok: false, code: 'non-canonical', reason: 'company manifest bytes are not the canonical JSON serialization of their parsed value' }
  }
  let manifest: DesktopCompanyManifest
  try {
    manifest = parseDesktopCompanyManifestValue(parsed, options.companyCatalogOrigin)
  } catch (cause) {
    return { ok: false, code: 'invalid-manifest', reason: cause instanceof Error ? cause.message : String(cause) }
  }
  const root = options.trustRoots.find(candidate => candidate.keyId === manifest.signature.keyId)
  if (root === undefined) {
    return { ok: false, code: 'unknown-key', reason: `manifest keyId ${manifest.signature.keyId} is not in the trusted roots` }
  }
  const rawKey = Buffer.from(manifest.signature.publicKey, 'base64')
  if (rawKey.byteLength !== 32) {
    return { ok: false, code: 'key-mismatch', reason: 'the manifest signing key is not a raw 32-byte ed25519 public key' }
  }
  const fingerprint = ed25519PublicKeyFingerprint(rawKey)
  if (fingerprint !== root.fingerprint) {
    return { ok: false, code: 'key-mismatch', reason: `manifest signing key fingerprint does not match the pinned fingerprint for keyId ${root.keyId}` }
  }
  const unsigned = { ...(parsed as Record<string, unknown>) }
  delete unsigned.signature
  const signedBytes = Buffer.from(canonicalJsonText(unsigned), 'utf8')
  const signatureBytes = Buffer.from(manifest.signature.value, 'base64')
  if (signatureBytes.byteLength !== 64) {
    return { ok: false, code: 'bad-signature', reason: 'the detached ed25519 signature is not 64 bytes' }
  }
  let signatureOk: boolean
  try {
    signatureOk = cryptoVerify(null, signedBytes, ed25519PublicKeyFromRaw(rawKey), signatureBytes)
  } catch {
    return { ok: false, code: 'bad-signature', reason: 'ed25519 signature verification failed' }
  }
  if (!signatureOk) {
    return { ok: false, code: 'bad-signature', reason: 'ed25519 signature verification failed' }
  }
  if (manifest.sequence < lastSeenSequence) {
    return {
      ok: false,
      code: 'stale-sequence',
      reason: `manifest sequence ${String(manifest.sequence)} regressed below the last seen sequence ${String(lastSeenSequence)}`,
    }
  }
  const expiresAtMs = Date.parse(manifest.expiresAt)
  if (verifiedAt >= expiresAtMs) {
    return { ok: false, code: 'expired', reason: `company manifest expired at ${manifest.expiresAt}` }
  }
  return { ok: true, manifest, keyId: root.keyId, fingerprint, verifiedAt }
}

/** Look up one exact (packageName, version) entry; revoked entries stay findable. */
export function findDesktopCompanyManifestPackage(
  manifest: DesktopCompanyManifest,
  packageName: string,
  version: string,
): DesktopCompanyManifestPackage | undefined {
  return manifest.packages.find(entry => entry.packageName === packageName && entry.version === version)
}

/** The signed install channel of one entry; an absent `source` is the npm channel. */
export function desktopCompanyEntrySource(
  entry: Pick<DesktopCompanyManifestPackage, 'source'>,
): DesktopCompanyEntrySource {
  return entry.source ?? { kind: 'npm' }
}

/** Default whole-request bound of one company tarball download. */
export const COMPANY_TARBALL_FETCH_TIMEOUT_MS = 120_000
/** Default body bound of one company tarball download. */
export const COMPANY_TARBALL_MAX_BYTES = 512 * 1024 * 1024
/** Staging directory mode; the staged file itself is written 0o600. */
const STAGING_DIRECTORY_MODE = 0o700
const STAGING_FILE_MODE = 0o600

/** Options of {@link stageCompanyMarketTarball}. */
export interface DesktopCompanyTarballStageOptions {
  /** Deployment policy; `companyCatalogOrigin` pins the only origin a tarball may come from. */
  readonly policy: Pick<DesktopPolicy, 'companyCatalogOrigin'>
  /** The signed tarball source of a verified manifest entry. */
  readonly source: DesktopCompanyEntrySourceTarball
  readonly packageName: string
  readonly version: string
  /** Active profile directory; the staging area lives inside it. */
  readonly profileDir: string
  /** Fetch-compatible boundary; defaults to `globalThis.fetch` (the Electron composition injects `net.fetch`). */
  readonly request?: UpdateChannelRequest
  /** Whole-request bound of the download; enforced through an abort signal composed with `signal`. */
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

/** A verified, staged company tarball ready for the controlled install target. */
export interface DesktopCompanyTarballStaged {
  readonly tarball: DesktopControlledMarketTarball
  readonly stagedPath: string
  readonly bytes: number
  readonly integrity: string
}

/** Best-effort removal of one staged file; a missing file is fine. */
function removeStagedFile(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // a staging file that cannot be removed cannot be installed either — the
    // install-time hash gate still refuses it; nothing else to do here
  }
}

/**
 * Synchronously hash the currently staged file (if any) through a private
 * descriptor opened without following symlinks, mirroring the install
 * boundary's walk. An unreadable, symlinked, non-regular, empty, or
 * oversized file yields undefined — the caller decides what that means.
 */
function sha512OfStagedFile(path: string): Buffer | undefined {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size <= 0 || info.size > COMPANY_TARBALL_MAX_BYTES) return undefined
    const hash = createHash('sha512')
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let read: number
    while ((read = readSync(descriptor, chunk, 0, chunk.byteLength, null)) > 0) {
      hash.update(chunk.subarray(0, read))
    }
    return hash.digest()
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/**
 * Failure-path keepalive for the staged tarball: a failed re-staging must
 * not strand the profile lockfile, whose `file:` dependency still resolves
 * against the staged path of an earlier successful install. The staged file
 * is kept only while it still hashes to the signed integrity — those bytes
 * are exactly what a successful download would have written, so keeping
 * them is idempotent — and removed otherwise, so nothing unverifiable is
 * ever left behind for a later install attempt.
 */
function removeStagedFileUnlessIntact(stagedPath: string, integrity: string): void {
  const expected = Buffer.from(integrity.slice('sha512-'.length), 'base64')
  const digest = sha512OfStagedFile(stagedPath)
  if (digest !== undefined && digest.byteLength === expected.byteLength && timingSafeEqual(digest, expected)) return
  removeStagedFile(stagedPath)
}

/**
 * Commit the verified tarball bytes to the staged path atomically: an
 * exclusively created random-suffix sibling (never following a planted file)
 * receives the bytes, then one rename replaces the staged path, so readers
 * observe either the previous or the new complete tarball. The sibling is
 * written with a random suffix under the caller's file lock, mirroring the
 * atomic-write discipline the text state files use.
 */
async function writeStagedTarballBytes(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, STAGING_FILE_MODE)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
    }
  } catch (cause) {
    closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw cause
  }
  closeSync(descriptor)
  try {
    renameSync(temporary, path)
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
}

/**
 * Download one signed tarball from the policy-pinned catalog origin, verify
 * the signed sha512 over the downloaded bytes, and stage them inside the
 * profile's controlled staging area under the deterministic name for this
 * exact package version. Any failure — transport, status, size, timeout,
 * caller abort, or an integrity mismatch — refuses the install and runs the
 * failure-path keepalive over the staging location (see {@link
 * removeStagedFileUnlessIntact}): a previously staged file that still hashes
 * to the signed integrity stays (the profile lockfile's `file:` dependency
 * keeps resolving against it), anything else is removed so nothing
 * unverifiable is ever left behind for a later install attempt. A
 * successful staging overwrites an earlier one idempotently (the staged
 * file is kept after installation: the profile lockfile's `file:` dependency
 * keeps resolving against it).
 */
export async function stageCompanyMarketTarball(
  options: DesktopCompanyTarballStageOptions,
): Promise<DesktopCompanyTarballStaged> {
  const origin = options.policy.companyCatalogOrigin
  const stagedPath = desktopMarketTarballStagingPath(options.profileDir, options.packageName, options.version)
  const clean = (): void => removeStagedFileUnlessIntact(stagedPath, options.source.integrity)
  if (origin === null) {
    clean()
    throw new Error(`${BIN_NAME}: the tarball channel requires an origin-mode catalog policy`)
  }
  let url: URL
  try {
    url = new URL(options.source.url)
  } catch {
    clean()
    throw new Error(`${BIN_NAME}: the company tarball URL ${options.source.url} is not a valid URL`)
  }
  if (url.protocol !== 'https:' || url.origin !== origin) {
    clean()
    throw new Error(`${BIN_NAME}: the company tarball URL must stay inside the pinned https catalog origin ${origin}`)
  }
  if (!isSha512Integrity(options.source.integrity)) {
    clean()
    throw new Error(`${BIN_NAME}: the company tarball integrity must be the signed sha512 of the tarball`)
  }
  const timeoutMs = options.timeoutMs ?? COMPANY_TARBALL_FETCH_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`${BIN_NAME}: the company tarball download timeout must be a safe positive millisecond bound`)
  }
  options.signal?.throwIfAborted()
  // The whole-request bound is enforced through the abort signal composed
  // with the caller's: whichever fires first (caller cancellation or the
  // timeout) aborts the download. The timeout timer never keeps the event
  // loop alive (Node unrefs it internally).
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal])
  let result: Awaited<ReturnType<typeof fetchUpdateChannelBytes>>
  try {
    result = await fetchUpdateChannelBytes({
      request: options.request ?? ((url, init) => globalThis.fetch(url, init)),
      url: url.href,
      label: 'company market plugin tarball',
      maxBytes: options.maxBytes ?? COMPANY_TARBALL_MAX_BYTES,
      redirect: 'error',
      signal,
    })
  } catch (cause) {
    // Abort failures rethrown by the fetch boundary (caller cancellation or
    // the timeout bound above) get the same keepalive cleanup every other
    // failure path applies — aborting must never strand a still-valid
    // staged file on the deletion path either.
    clean()
    if (!options.signal?.aborted && timeoutSignal.aborted) {
      throw new Error(`${BIN_NAME}: the company tarball for ${options.packageName}@${options.version} exceeded the ${String(timeoutMs)} ms whole-request download bound`)
    }
    throw cause
  }
  if (!result.ok) {
    clean()
    throw new Error(`${BIN_NAME}: the company tarball for ${options.packageName}@${options.version} could not be downloaded (${result.code}: ${result.reason})`)
  }
  const digest = createHash('sha512').update(result.bytes).digest()
  const expected = Buffer.from(options.source.integrity.slice('sha512-'.length), 'base64')
  if (digest.byteLength !== expected.byteLength || !timingSafeEqual(digest, expected)) {
    clean()
    throw new Error(`${BIN_NAME}: the downloaded tarball for ${options.packageName}@${options.version} does not match the signed integrity — refusing the install`)
  }
  const stagingDirectory = dirname(stagedPath)
  try {
    const info = lstatSync(stagingDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${BIN_NAME}: the market tarball staging directory must be a real directory`)
    }
    chmodSync(stagingDirectory, STAGING_DIRECTORY_MODE)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(stagingDirectory, { recursive: true, mode: STAGING_DIRECTORY_MODE })
    } else {
      clean()
      throw cause
    }
  }
  await withFileLock(stagedPath, async () => {
    await writeStagedTarballBytes(stagedPath, result.bytes)
  })
  return {
    tarball: { kind: 'market-tarball', path: stagedPath, integrity: options.source.integrity },
    stagedPath,
    bytes: result.bytes.byteLength,
    integrity: options.source.integrity,
  }
}

/** The deterministic staged-file name prefix of one package name (`@scope/name` → `scope+name`). */
function desktopMarketTarballStagingPrefix(packageName: string): string {
  return packageName.replace(/^@/u, '').replace('/', '+')
}

/** Parse `<prefix>-<X.Y.Z>.tgz` staging names of exactly this package; other names (including same-prefix siblings) are rejected. */
function parseStagedVersionForPackage(fileName: string, packageName: string): string | undefined {
  const prefix = `${desktopMarketTarballStagingPrefix(packageName)}-`
  if (!fileName.startsWith(prefix)) return undefined
  const version = fileName.slice(prefix.length)
  return /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.tgz$/u.test(version)
    ? version.slice(0, -'.tgz'.length)
    : undefined
}

/**
 * Best-effort GC of superseded staged tarballs of one package: the version
 * the profile lockfile still references through its `file:` dependency
 * stays, every other staged file of the same package name is removed —
 * orphaned older versions left behind by upgrades. Files of other package
 * names are never touched (another package's staging may be in flight or
 * belong to a different lockfile state), and nothing is removed when the
 * lockfile is unreadable or does not reference the package: the GC is a
 * disk-space courtesy, never an authority. Never throws.
 */
export async function cleanCompanyMarketStagingOrphans(
  profileDir: string,
  packageName: string,
): Promise<readonly string[]> {
  const { readDesktopBootLockfile } = await import('./boot-verification.ts')
  const stagingDirectory = join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY)
  let entries: readonly Dirent[]
  try {
    entries = readdirSync(stagingDirectory, { withFileTypes: true })
  } catch {
    return []
  }
  const stagedVersions = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue
    const version = parseStagedVersionForPackage(entry.name, packageName)
    if (version !== undefined) stagedVersions.set(version, join(stagingDirectory, entry.name))
  }
  if (stagedVersions.size === 0) return []
  const referencedVersion = referencedStagedVersion(readDesktopBootLockfile(profileDir), packageName)
  if (referencedVersion === undefined || !stagedVersions.has(referencedVersion)) return []
  const removed: string[] = []
  for (const [version, path] of stagedVersions) {
    if (version === referencedVersion) continue
    removeStagedFile(path)
    removed.push(path)
  }
  return removed
}

/** Extract the lockfile's referenced staged version of one package from its `file:` dependency specifier. */
function referencedStagedVersion(lockfile: Record<string, unknown> | undefined, packageName: string): string | undefined {
  if (lockfile === undefined) return undefined
  const importers = lockfile.importers
  const root = importers !== null && typeof importers === 'object' && !Array.isArray(importers)
    ? (importers as Record<string, unknown>)['.']
    : undefined
  const dependencies = root !== null && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, unknown>).dependencies
    : undefined
  const dependency = dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
    ? (dependencies as Record<string, unknown>)[packageName]
    : undefined
  const specifier = dependency !== null && typeof dependency === 'object' && !Array.isArray(dependency)
    ? (dependency as Record<string, unknown>).specifier
    : undefined
  if (typeof specifier !== 'string' || !specifier.startsWith('file:')) return undefined
  return parseStagedVersionForPackage(basename(specifier), packageName)
}

/** One verified manifest entry as the tarball install orchestration consumes it. */
export interface DesktopCompanyTarballInstallEntry {
  readonly packageName: string
  readonly version: string
  /** Signed top-level integrity; for a tarball entry this equals `source.integrity`. */
  readonly integrity: string
  readonly bundlePatch: string
  readonly revoked: boolean
  /**
   * Signed expected root digest of the installed tree. The tarball channel is
   * tree-anchored: an entry without it cannot be installed, because there
   * would be no signed post-install expectation to re-verify against.
   */
  readonly treeDigest: string
  readonly approvedBuilds?: readonly string[]
}

/** Request of {@link installCompanyMarketTarballPlugin}. */
export interface DesktopCompanyTarballInstallRequest {
  /** Market-owned package-manager boundary; the real DesktopPnpm service. */
  readonly service: Pick<DesktopPnpm, 'installPlugin' | 'rollbackPluginInstall'>
  /** The verified signed entry to install (from {@link verifyDesktopCompanyManifest}). */
  readonly entry: DesktopCompanyTarballInstallEntry
  /** Staged tarball descriptor from {@link stageCompanyMarketTarball}. */
  readonly tarball: DesktopControlledMarketTarball
  readonly recovery: DesktopPluginInstallRecovery
  /** Active profile directory (installed-tree asserts and rollback checks). */
  readonly profileDir: string
  /** Absolute caller directory anchoring the install command. */
  readonly invokingDir: string
  readonly signal?: AbortSignal
  /** Installed-tree measurement override for focused tests; defaults to the boot-verification digest walk. */
  readonly measureTreeRootDigest?: (packageDir: string) => string
}

/** Result of one completed, re-verified tarball-channel install. */
export interface DesktopCompanyTarballInstallResult {
  readonly receiptId: string
  readonly packageName: string
  readonly version: string
  /** Measured installed-tree root digest (equal to the signed `treeDigest`). */
  readonly treeDigest: string
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

function packageSegments(packageName: string): readonly string[] {
  return packageName.startsWith('@') ? packageName.split('/') : [packageName]
}

function containedPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path))
}

interface JsonManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: unknown
  readonly dsh?: unknown
}

function readJsonManifest(path: string): JsonManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as JsonManifest
}

function profileBundles(manifest: JsonManifest): readonly string[] {
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) return []
  const profile = (manifest.dsh as Record<string, unknown>).profile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return []
  const bundles = (profile as Record<string, unknown>).bundles
  return Array.isArray(bundles) && bundles.every(value => typeof value === 'string') ? bundles : []
}

/** Whether the profile manifest still references the plugin (dependency pin or declared bundle). */
function profileReferencesPlugin(profileDir: string, packageName: string): boolean {
  try {
    const manifest = readJsonManifest(join(profileDir, 'package.json'))
    const dependencies = manifest.dependencies === null || typeof manifest.dependencies !== 'object'
      || Array.isArray(manifest.dependencies)
      ? undefined
      : (manifest.dependencies as Record<string, unknown>)[packageName]
    return dependencies !== undefined || profileBundles(manifest).includes(packageName)
  } catch {
    return true // an unreadable profile cannot be asserted clean — treat as still referenced
  }
}

/**
 * Assert the installed bundle matches the signed entry: the package resolved
 * inside the profile's node_modules, the exact name and version, and the
 * signed in-package bundle patch present. Mirrors the market install path's
 * post-install assert for the desktop-owned tarball channel.
 */
function assertCompanyTarballInstalledBundle(
  request: Pick<DesktopCompanyTarballInstallRequest, 'entry' | 'profileDir'>,
): string {
  const nodeModules = resolve(request.profileDir, 'node_modules')
  const packageDir = join(nodeModules, ...packageSegments(request.entry.packageName))
  let resolvedPackageDir: string
  try {
    resolvedPackageDir = resolve(packageDir)
    if (!containedPath(nodeModules, resolvedPackageDir)) throw new Error('the package escaped the profile')
    const manifest = readJsonManifest(join(resolvedPackageDir, 'package.json'))
    if (manifest.name !== request.entry.packageName || manifest.version !== request.entry.version) {
      throw new Error(`installed ${String(manifest.name)}@${String(manifest.version)} instead of ${request.entry.packageName}@${request.entry.version}`)
    }
    const patchPath = resolve(resolvedPackageDir, request.entry.bundlePatch)
    if (!containedPath(resolvedPackageDir, patchPath)) throw new Error('the bundle patch path escapes the package')
    lstatSync(patchPath)
  } catch (cause) {
    throw new Error(`${BIN_NAME}: the tarball install of ${request.entry.packageName}@${request.entry.version} did not produce a valid installed bundle: ${messageOf(cause)}`)
  }
  return resolvedPackageDir
}

/**
 * Run one tarball-channel company plugin install end to end:
 *
 * 1. refuse revoked entries and entries without a signed `treeDigest` (the
 *    channel is tree-anchored — no signed expectation, no install);
 * 2. install through the pnpm boundary's controlled tarball target (which
 *    re-validates the descriptor and re-hashes the staged bytes against the
 *    signed sha512, and rolls the profile back through the recovery WAL when
 *    the package manager exits nonzero);
 * 3. assert the installed bundle matches the signed entry;
 * 4. re-verify the installed tree with the boot-verification digest walk —
 *    the same measurement every later boot applies — against the signed
 *    `treeDigest`; any divergence rolls the install back and refuses it.
 */
export async function installCompanyMarketTarballPlugin(
  request: DesktopCompanyTarballInstallRequest,
): Promise<DesktopCompanyTarballInstallResult> {
  const { entry, recovery } = request
  if (recovery.packageName !== entry.packageName || recovery.packageVersion !== entry.version) {
    throw new Error(`${BIN_NAME}: the install receipt targets ${recovery.packageName}@${recovery.packageVersion}, but the signed entry pins ${entry.packageName}@${entry.version}`)
  }
  if (entry.revoked) {
    throw new Error(`${BIN_NAME}: ${entry.packageName}@${entry.version} is revoked in the signed company catalog`)
  }
  if (!/^[0-9a-f]{64}$/u.test(entry.treeDigest)) {
    throw new Error(`${BIN_NAME}: ${entry.packageName}@${entry.version} carries no signed treeDigest — the tarball channel installs only tree-anchored entries`)
  }
  if (request.tarball === null || typeof request.tarball !== 'object' || request.tarball.kind !== 'market-tarball') {
    throw new Error(`${BIN_NAME}: the tarball install requires a controlled market tarball descriptor`)
  }
  if (request.tarball.integrity !== entry.integrity) {
    throw new Error(`${BIN_NAME}: the staged tarball integrity does not match the signed entry integrity for ${entry.packageName}@${entry.version}`)
  }
  const handle = await request.service.installPlugin({
    invokingDir: request.invokingDir,
    recovery,
    marketTarball: request.tarball,
    ...(entry.approvedBuilds === undefined ? {} : { approvedBuildDependencies: [...entry.approvedBuilds] }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })
  const outcome = await handle.done
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    throw new Error(`${BIN_NAME}: the package manager failed installing the staged tarball for ${entry.packageName}@${entry.version} (exit ${String(outcome.exitCode)}, signal ${String(outcome.signal)}) — the recovery WAL restored the profile`)
  }
  request.signal?.throwIfAborted()
  let packageDir: string
  try {
    packageDir = assertCompanyTarballInstalledBundle(request)
  } catch (cause) {
    await request.service.rollbackPluginInstall(recovery.receiptId)
    throw new Error(`${messageOf(cause)} — the installation was rolled back`)
  }
  const measure = request.measureTreeRootDigest
    ?? ((await import('./boot-verification.ts')).computeDesktopBootTreeRootDigest)
  let measured: string
  try {
    measured = measure(packageDir)
  } catch (cause) {
    await request.service.rollbackPluginInstall(recovery.receiptId)
    throw new Error(`${BIN_NAME}: the installed tree of ${entry.packageName} could not be measured: ${messageOf(cause)} — the installation was rolled back`)
  }
  if (measured !== entry.treeDigest) {
    await request.service.rollbackPluginInstall(recovery.receiptId)
    if (profileReferencesPlugin(request.profileDir, entry.packageName)) {
      throw new Error(`${BIN_NAME}: the installed files of ${entry.packageName}@${entry.version} differ from the tree digest pinned in the signed company manifest and the rollback left profile references behind — use the saved recovery state before another plugin change`)
    }
    throw new Error(`${BIN_NAME}: the installed files of ${entry.packageName}@${entry.version} differ from the tree digest pinned in the signed company manifest — the installation was rolled back and refused`)
  }
  // Best-effort staging GC: the lockfile now references exactly this
  // version's staged file, so superseded versions of the same package are
  // inert. Never fails a verified install (see the function contract).
  await cleanCompanyMarketStagingOrphans(request.profileDir, entry.packageName)
  return {
    receiptId: recovery.receiptId,
    packageName: entry.packageName,
    version: entry.version,
    treeDigest: measured,
  }
}
