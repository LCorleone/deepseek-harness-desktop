import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { prerelease, satisfies, valid } from 'semver'
import { parse as parseYaml } from 'yaml'
import type { MarketInstallableResponse, MarketInstallReceipt } from '../api-types.js'
import type { CatalogFullIndex } from '../catalog/service.js'
import type { MarketSettingsDocument } from '../catalog/source-store.js'
import { normalizeRepositoryIdentity } from '../contracts/identity.js'
import type { CatalogHttpClient, NormalizedRepositoryIdentity } from '../contracts/types.js'
import type { CatalogSnapshot } from '../contracts/index.js'
import { isCompanyManifestKeyId } from '../signing/keys.js'
import { manualInstallHints } from './manual.js'
import {
  computeInstallTreeDigest,
  MAX_INSTALL_TREE_DIGEST_FILES,
  MAX_INSTALL_TREE_PATH_LENGTH,
  type MarketInstallTreeDigest,
} from './tree-digest.js'

const DEFAULT_NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024
const INSTALL_INTENT_TTL_MS = 5 * 60 * 1000
const CANDIDATE_TTL_MS = 30 * 60 * 1000
const MAX_INTENTS = 256
const MAX_CANDIDATES = 10_000
const MAX_RECEIPTS = 512
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const
const BLOCKED_PRODUCT_PACKAGES = new Set(['dsh-plugin-desktop', 'dsh-community-market'])
const DSH_RUNTIME_VERSION = '0.1.2-rc.1'
const CORDIS_RUNTIME_VERSION = '4.0.2'
const NODE_RUNTIME_VERSION = '24.18.1'

export type { MarketInstallReceipt } from '../api-types.js'

export interface MarketDesktopProfile {
  readonly name: string
  readonly dir: string
}

export interface MarketDesktopPnpmOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export interface MarketDesktopPnpmHandle {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly done: Promise<MarketDesktopPnpmOutcome>
  cancel(): void
}

export interface MarketDesktopPnpm {
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): MarketDesktopPnpmHandle
  installPlugin(request: {
    readonly pnpmOptions?: readonly string[]
    readonly invokingDir: string
    readonly recovery: {
      readonly packageName: string
      readonly packageVersion: string
      readonly receiptId: string
    }
    /** Signed build-script approvals of the installed plugin's entry; see {@link InstallTargetEvidence}. */
    readonly approvedBuildDependencies?: readonly string[]
    readonly signal?: AbortSignal
  }): Promise<MarketDesktopPnpmHandle>
  recoveredInstallReceiptIds(): Promise<readonly string[]>
  acknowledgeRecoveredInstall(receiptId: string): Promise<void>
  rollbackPluginInstall(receiptId: string): Promise<boolean>
}

export interface MarketInstallPreview {
  readonly intent: string
  readonly action: 'install'
  readonly profileName: string
  readonly packageName: string
  readonly version: string
  readonly displayName: string
  readonly expiresAt: string
  /**
   * Installed version this install replaces (P10 update path): present only
   * when a verified market receipt still proves an older installed version
   * of the same package. The install itself is a controlled version
   * replacement — never an uninstall-then-install.
   */
  readonly replaces?: string
}

export interface MarketUninstallPreview {
  readonly intent: string
  readonly action: 'uninstall'
  readonly profileName: string
  readonly packageName: string
  readonly version: string
  readonly displayName: string
  readonly expiresAt: string
}

export interface MarketInstallResult {
  readonly receipt: MarketInstallReceipt
}

export interface MarketUninstallResult {
  readonly receiptId: string
  readonly packageName: string
}

export type MarketOperationResult =
  | ({ readonly action: 'install'; readonly restartToken: string } & MarketInstallResult)
  | ({ readonly action: 'uninstall'; readonly restartToken: string } & MarketUninstallResult)

export type MarketInstallErrorCode =
  | 'invalid-request'
  | 'not-available'
  | 'conflict'
  | 'intent-expired'
  | 'verification-failed'
  | 'operation-failed'
  | 'persistence-failed'

/** Failure codes whose messages are fixed first-party vocabulary (no stderr
 * tails or local paths are ever concatenated into them) — the only codes a
 * telemetry `reason` may carry. */
const REASON_SAFE_INSTALL_CODES: ReadonlySet<string> = new Set([
  'invalid-request', 'not-available', 'conflict', 'intent-expired',
  'verification-failed', 'persistence-failed',
])

/** Error whose message is safe to return through the loopback API. */
export class MarketInstallError extends Error {
  constructor(readonly code: MarketInstallErrorCode, message: string) {
    super(message)
    this.name = 'MarketInstallError'
  }
}

interface InstallCandidate {
  readonly key: string
  readonly sourceRecordId: string
  readonly providerId: string
  readonly itemId: string
  readonly displayName: string
  readonly packageName: string
  readonly version: string
  readonly repository: NormalizedRepositoryIdentity
  readonly savedAt: number
}

interface InstallIntent {
  readonly kind: 'install'
  readonly candidate: InstallCandidate
  readonly verification: MarketNpmPackageVerification
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
}

interface UninstallIntent {
  readonly kind: 'uninstall'
  readonly receipt: MarketInstallReceipt
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
}

type MarketIntent = InstallIntent | UninstallIntent

interface RestartIntent {
  readonly profile: MarketDesktopProfile
  readonly expiresAt: number
}

export interface MarketNpmPackageVerifier {
  verify(
    candidate: Pick<InstallCandidate, 'packageName' | 'version' | 'repository'>,
    signal: AbortSignal,
  ): Promise<MarketNpmPackageVerification>
}

export interface MarketNpmPackageVerification {
  readonly integrity: string
  readonly bundlePatch: string
  readonly tarball: string
}

/**
 * Host-provided verification for catalog entries the embedding deployment
 * publishes through a controlled tarball channel instead of the public npm
 * registry (P7 2c). The market library stays registry-generic: the Host
 * injects this seam through the `desktopMarketTarballEntryVerifier` context
 * capability, and `composeTarballAwareVerifier` consults it before the
 * registry verifier on every preview and execution verification.
 *
 * Contract for injected implementations:
 *
 * - returning `undefined` keeps the built-in registry path byte-for-byte —
 *   the exact behavior of an uninjected deployment for that candidate;
 * - returning a verification hands the signed tarball facts to the standard
 *   install flow unchanged: `integrity` is the signed sha512 of the tarball
 *   file (the value a `file:` install pins into the lockfile's
 *   `resolution.integrity`), `bundlePatch` the signed in-package patch, and
 *   `tarball` the controlled tarball URL (display/audit only);
 * - the seam never throws for business failures — an unverifiable manifest,
 *   an absent or revoked entry, or a transport failure returns `undefined`
 *   so the registry verifier produces the standard, already-localized
 *   verification failure instead of an opaque host error;
 * - the Host owns binding the entry to its own trust chain (signature,
 *   sequence floor, expiry) exactly like its other manifest consumers.
 */
export interface MarketTarballEntryVerifier {
  verifyTarballEntry(
    candidate: Pick<InstallCandidate, 'packageName' | 'version'>,
    signal: AbortSignal,
  ): Promise<MarketNpmPackageVerification | undefined>
}

/**
 * Compose the registry verifier with an optional Host tarball-channel seam:
 * tarball-channel candidates verify through the Host's signed facts, every
 * other candidate (and every deployment without the injection) keeps the
 * registry verifier's decisions byte-for-byte.
 */
export function composeTarballAwareVerifier(
  base: MarketNpmPackageVerifier,
  tarball: MarketTarballEntryVerifier,
): MarketNpmPackageVerifier {
  return {
    async verify(candidate, signal) {
      const verified = await tarball.verifyTarballEntry(candidate, signal)
      if (verified !== undefined) return verified
      return await base.verify(candidate, signal)
    },
  }
}

/** One npm install target already verified against the allowed registry. */
export interface InstallTargetCandidate {
  readonly packageName: string
  readonly version: string
  readonly integrity: string
}

/**
 * Signed-manifest provenance attached to an allow decision (P2-3). The
 * sequence and keyId are copied verbatim into the version-2 install receipt;
 * `approvedBuildDependencies` transports the entry's signed build-script
 * approval list to the package-manager boundary instead. The service treats
 * all of it as opaque provenance and never derives an allow decision from it.
 */
export interface InstallTargetEvidence {
  /** Sequence of the signed company manifest whose entry matched the target. */
  readonly manifestSequence: number
  /** keyId of the trust root whose key verified that manifest. */
  readonly keyId: string
  /**
   * Signed `approvedBuilds` of the matched entry, copied when the entry
   * carries the optional field; absent entries contribute nothing. Hosts use
   * it to extend (never replace) their built-in build-script approvals.
   */
  readonly approvedBuildDependencies?: readonly string[]
}

/** Whitelist decision for one verified npm install target. */
export interface InstallTargetDecision {
  readonly allowed: boolean
  readonly reason?: string
  /** Signed-manifest evidence carried into the install receipt; never affects the decision. */
  readonly evidence?: InstallTargetEvidence
}

/**
 * Host-owned install whitelist consulted after npm verification and before any
 * package-manager start. The default allows every verified target; locked
 * Desktop builds inject a reject-all authority until the signed company
 * manifest query lands (P2).
 */
export interface InstallTargetAuthority {
  canInstall(candidate: InstallTargetCandidate): InstallTargetDecision
}

/** Default authority used when no whitelist is injected; every verified target is allowed. */
export const allowAllInstallTargetAuthority: InstallTargetAuthority = {
  canInstall: () => ({ allowed: true }),
}

/** Fail-closed authority active until the signed company manifest query lands (P2). */
export const rejectAllInstallTargetAuthority: InstallTargetAuthority = {
  canInstall: () => ({ allowed: false, reason: 'no signed install manifest is trusted yet' }),
}

/** Terminal outcome of one market install attempt (client event telemetry). */
export type MarketInstallEventOutcome = 'installed' | 'updated-in-place' | 'uninstalled' | 'rolled-back' | 'failed'

/**
 * One install attempt's reportable facts (client event telemetry,
 * 2026-09-07). Categorical metadata only: identity, outcome, the signed
 * manifest sequence that allowed the install, and a bounded failure
 * category. The library never attaches stderr tails, paths, or free error
 * text — the optional `reason` is the already-bounded message fragment the
 * embedding Host may further clip.
 */
export interface MarketInstallEvent {
  readonly packageName: string
  readonly version: string
  readonly outcome: MarketInstallEventOutcome
  /** Sequence of the signed company manifest that allowed the install; absent for unsigned deployments. */
  readonly manifestSequence?: number
  /** Failure category (a {@link MarketInstallErrorCode}); present on failures. */
  readonly reasonCode?: string
  /** Optional one-line failure reason; bounded by the embedding Host. */
  readonly reason?: string
}

/**
 * Host-injected install telemetry seam (the `desktopClientEventReporter`
 * context capability): the market library reports every install attempt,
 * the Desktop main process forwards it to the company event database. The
 * default is a no-op, so standalone deployments and Hosts without the
 * injection keep byte-for-byte behavior. Implementations must never throw —
 * a telemetry failure must never fail an install.
 */
export interface MarketInstallEventSink {
  reportInstallEvent(event: MarketInstallEvent): void
}

/** Default no-op sink used when no telemetry seam is injected. */
export const noopMarketInstallEventSink: MarketInstallEventSink = {
  reportInstallEvent() {},
}

export interface MarketInstallServiceOptions {
  readonly now?: () => number
  readonly intentTtlMs?: number
  readonly candidateTtlMs?: number
  readonly maxIntents?: number
  readonly maxCandidates?: number
  /** Host-owned policy state; Renderer values must never reach this callback. */
  readonly disabledPackageNames?: () => readonly string[]
  /** Registry origin permitted for verification and install flags; defaults to the official npm registry. */
  readonly allowedRegistryOrigin?: string
  /** Host-owned install whitelist; defaults to {@link allowAllInstallTargetAuthority}. */
  readonly installTargetAuthority?: InstallTargetAuthority
  /** Host-injected install telemetry sink; defaults to a no-op. */
  readonly installEventSink?: MarketInstallEventSink
  /**
   * Host logger for operator-visible degradation notices. The default is
   * `console.warn`, which the packaged Desktop GUI never shows (its stdout
   * and stderr are not wired to any log exporter) — hosts that run inside a
   * GUI must inject their cordis logger so degrades reach the persistent
   * logs. Same injection rule as {@link installEventSink}: the cordis
   * `Context['logger']` type only, never a Desktop import.
   */
  readonly logger?: Pick<Context['logger'], 'warn'>
}

function stableExactVersion(value: unknown): value is string {
  return typeof value === 'string'
    && valid(value, { loose: false }) === value
    && prerelease(value, { loose: false }) === null
}

function safePackageName(value: unknown): value is string {
  return typeof value === 'string' && PACKAGE_NAME_PATTERN.test(value)
}

function marketManagedPackage(value: string): boolean {
  return !BLOCKED_PRODUCT_PACKAGES.has(value)
}

function candidateKey(sourceRecordId: string, itemId: string): string {
  return `${sourceRecordId}\0${itemId}`
}

/**
 * Upper bound for any inlined cause text: a surfaced refusal must never carry
 * an unbounded error payload (a pathological cause message, a pnpm stderr
 * tail) into the UI display and log pipeline.
 */
const MAX_CAUSE_DETAIL_LENGTH = 2_000

/** Bound one free-form cause text, marking the cut when it happens. */
function boundedCauseText(text: string): string {
  return text.length <= MAX_CAUSE_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_CAUSE_DETAIL_LENGTH)}… [truncated, ${text.length - MAX_CAUSE_DETAIL_LENGTH} more characters]`
}

/** Inline a caught cause's message so a refusal text never hides the actual reason (bounded). */
function causeDetail(cause: unknown): string {
  return cause instanceof Error ? ` ${boundedCauseText(cause.message)}` : ''
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function own(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function sha512Integrity(value: unknown): value is string {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

function safeBundlePatch(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\0')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

function npmRepository(value: unknown): NormalizedRepositoryIdentity | undefined {
  const repository = typeof value === 'string'
    ? { url: value }
    : value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  if (repository === undefined || typeof repository.url !== 'string') return undefined
  const rawUrl = repository.url.startsWith('git+') ? repository.url.slice(4) : repository.url
  if (!rawUrl.startsWith('https://')) return undefined
  try {
    return normalizeRepositoryIdentity({
      url: rawUrl,
      ...(typeof repository.directory === 'string' ? { subdirectory: repository.directory } : {}),
    })
  } catch {
    return undefined
  }
}

function assertRuntimeCompatibility(manifest: Record<string, unknown>): void {
  const accepts = (version: string, range: unknown): boolean => {
    if (typeof range !== 'string') return false
    try { return satisfies(version, range, { includePrerelease: true }) }
    catch { return false }
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    const dependencies = manifest[field]
    if (dependencies === undefined) continue
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new MarketInstallError('verification-failed', 'The npm package dependency metadata was invalid.')
    }
    const declaresScopedCordis
      = ['dependencies', 'peerDependencies', 'optionalDependencies']
        .some(scope => {
          const entries = manifest[scope]
          return entries !== null && typeof entries === 'object' && !Array.isArray(entries)
            && (entries as Record<string, unknown>)['@deepseek-ai/cordis'] !== undefined
        })
    for (const [name, range] of Object.entries(dependencies)) {
      if (name === 'cordis') {
        // Pilot-era relaxation (dev-log 2026-08-24): a bare `cordis` entry
        // alongside the scoped `@deepseek-ai/cordis` host is tolerated as a
        // leftover declaration; a bare-only host is still rejected as legacy.
        if (!declaresScopedCordis) {
          throw new MarketInstallError(
            'verification-failed',
            'The plugin package depends on the legacy Cordis runtime and is not compatible with DSH Desktop.',
          )
        }
        continue
      }
      const runtimeVersion = name === '@deepseek-ai/cordis'
        ? CORDIS_RUNTIME_VERSION
        : name.startsWith('@deepseek-ai/dsh')
          ? DSH_RUNTIME_VERSION
          : undefined
      if (runtimeVersion === undefined) continue
      if (!accepts(runtimeVersion, range)) {
        throw new MarketInstallError(
          'verification-failed',
          'The plugin package is not compatible with this DSH Desktop runtime.',
        )
      }
    }
  }
  const engines = manifest.engines
  if (engines === undefined) return
  if (engines === null || typeof engines !== 'object' || Array.isArray(engines)) {
    throw new MarketInstallError('verification-failed', 'The npm package engine metadata was invalid.')
  }
  const nodeRange = (engines as Record<string, unknown>).node
  if (nodeRange !== undefined && !accepts(NODE_RUNTIME_VERSION, nodeRange)) {
    throw new MarketInstallError(
      'verification-failed',
      'The plugin package does not support the Node.js runtime bundled with DSH Desktop.',
    )
  }
}

function officialNpmTarball(value: unknown, allowedRegistryOrigin: string): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.origin === allowedRegistryOrigin
      && url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.hash
      && url.pathname.endsWith('.tgz')
  } catch {
    return false
  }
}

/** Validate one bare https origin supplied as the allowed npm registry. */
function allowedNpmRegistryOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) }
  catch { throw new TypeError('allowed npm registry origin must be a bare https origin') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.origin !== value) {
    throw new TypeError('allowed npm registry origin must be a bare https origin')
  }
  return url.origin
}

/** Options for {@link createNpmRegistryVerifier}. */
export interface MarketNpmRegistryVerifierOptions {
  /** Registry origin accepted for npm verification; defaults to the official npm registry. */
  readonly allowedRegistryOrigin?: string
}

/** Build the exact-version npm registry verifier used by the Host preview and execution paths. */
export function createNpmRegistryVerifier(
  http: CatalogHttpClient,
  options: MarketNpmRegistryVerifierOptions = {},
): MarketNpmPackageVerifier {
  const allowedRegistryOrigin = allowedNpmRegistryOrigin(options.allowedRegistryOrigin ?? DEFAULT_NPM_REGISTRY_ORIGIN)
  return {
    async verify(candidate, signal) {
      if (
        !safePackageName(candidate.packageName)
        || !marketManagedPackage(candidate.packageName)
        || !stableExactVersion(candidate.version)
      ) {
        throw new MarketInstallError('verification-failed', 'The plugin package target is invalid.')
      }
      const url = `${allowedRegistryOrigin}/${encodeURIComponent(candidate.packageName)}/${encodeURIComponent(candidate.version)}`
      let response
      try {
        response = await http.getJson(url, signal, { allowedOrigin: allowedRegistryOrigin })
      } catch {
        throw new MarketInstallError('verification-failed', 'The plugin package could not be verified with npm.')
      }
      let finalOrigin: string
      try { finalOrigin = new URL(response.finalUrl).origin }
      catch { throw new MarketInstallError('verification-failed', 'The npm verification response was invalid.') }
      const metadata = response.value
      if (
        finalOrigin !== allowedRegistryOrigin
        || metadata === null
        || typeof metadata !== 'object'
        || Array.isArray(metadata)
      ) {
        throw new MarketInstallError('verification-failed', 'The npm verification response was invalid.')
      }
      const manifest = metadata as Record<string, unknown>
      if (manifest.name !== candidate.packageName || manifest.version !== candidate.version) {
        throw new MarketInstallError('verification-failed', 'The npm package identity did not match the catalog.')
      }
      assertRuntimeCompatibility(manifest)
      if (own(manifest, 'deprecated')) {
        throw new MarketInstallError('verification-failed', 'Deprecated plugin packages cannot be installed from the market.')
      }
      const scripts = manifest.scripts
      if (scripts !== undefined && (
        scripts === null
        || typeof scripts !== 'object'
        || Array.isArray(scripts)
        || LIFECYCLE_SCRIPTS.some(script => own(scripts, script))
      )) {
        throw new MarketInstallError('verification-failed', 'Plugin packages with install lifecycle scripts are not supported.')
      }
      const repository = npmRepository(manifest.repository)
      if (
        repository === undefined
        || repository.url !== candidate.repository.url
        || repository.subdirectory !== candidate.repository.subdirectory
      ) {
        throw new MarketInstallError('verification-failed', 'The npm package repository did not match the catalog.')
      }
      const dist = manifest.dist
      const dsh = manifest.dsh
      const bundle = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
        ? (dsh as Record<string, unknown>).bundle
        : undefined
      const patch = bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle)
        ? (bundle as Record<string, unknown>).patch
        : undefined
      const integrity = dist !== null && typeof dist === 'object' && !Array.isArray(dist)
        ? (dist as Record<string, unknown>).integrity
        : undefined
      const tarball = dist !== null && typeof dist === 'object' && !Array.isArray(dist)
        ? (dist as Record<string, unknown>).tarball
        : undefined
      if (!sha512Integrity(integrity) || !officialNpmTarball(tarball, allowedRegistryOrigin) || !safeBundlePatch(patch)) {
        throw new MarketInstallError('verification-failed', 'The npm package is missing a verifiable DSH bundle artifact.')
      }
      return { integrity, bundlePatch: patch, tarball }
    },
  }
}

interface JsonManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dependencies?: unknown
  readonly dsh?: unknown
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

async function readManifest(path: string): Promise<JsonManifest> {
  const body = await readFile(path)
  if (body.byteLength > MAX_MANIFEST_BYTES) throw new Error('manifest too large')
  const value = JSON.parse(body.toString('utf8')) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest')
  return value as JsonManifest
}

function profileDependency(manifest: JsonManifest, packageName: string): string | undefined {
  if (manifest.dependencies === null || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
    return undefined
  }
  const value = (manifest.dependencies as Record<string, unknown>)[packageName]
  return typeof value === 'string' ? value : undefined
}

function profileBundles(manifest: JsonManifest): readonly string[] {
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) return []
  const profile = (manifest.dsh as Record<string, unknown>).profile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return []
  const bundles = (profile as Record<string, unknown>).bundles
  return Array.isArray(bundles) && bundles.every(value => typeof value === 'string') ? bundles : []
}

function profileReferencesPlugin(manifest: JsonManifest, packageName: string): boolean {
  return profileDependency(manifest, packageName) !== undefined || profileBundles(manifest).includes(packageName)
}

async function profileHasPluginReference(profile: MarketDesktopProfile, packageName: string): Promise<boolean> {
  return profileReferencesPlugin(await readManifest(join(profile.dir, 'package.json')), packageName)
}

function bundlePatch(manifest: JsonManifest): string | undefined {
  if (manifest.dsh === null || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) return undefined
  const bundle = (manifest.dsh as Record<string, unknown>).bundle
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) return undefined
  const patch = (bundle as Record<string, unknown>).patch
  return typeof patch === 'string' && patch.length > 0 ? patch : undefined
}

function packageSegments(packageName: string): readonly string[] {
  return packageName.startsWith('@') ? packageName.split('/') : [packageName]
}

function containedPath(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

function supportedLockfileVersion(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  const match = /^(\d+)(?:\.\d+)?$/u.exec(String(value))
  return match !== null && (match[1] === '9' || match[1] === '11')
}

function exactLockResolution(value: unknown, version: string): value is string {
  return typeof value === 'string' && (value === version || value.startsWith(`${version}(`))
}

function lockEntry(recordValue: UnknownRecord, keys: readonly string[]): UnknownRecord | undefined {
  for (const key of keys) {
    if (!own(recordValue, key)) continue
    return record(recordValue[key])
  }
  return undefined
}

async function readProfileLock(profile: MarketDesktopProfile): Promise<UnknownRecord> {
  const body = await readFile(join(profile.dir, 'pnpm-lock.yaml'))
  if (body.byteLength > MAX_LOCKFILE_BYTES) throw new Error('lockfile too large')
  const lockfile = record(parseYaml(body.toString('utf8')))
  if (lockfile === undefined || !supportedLockfileVersion(lockfile.lockfileVersion)) {
    throw new Error('unsupported lockfile')
  }
  return lockfile
}

/**
 * The lockfile pin shape of a controlled `file:` dependency (the tarball
 * channel, P7 2c): the importer records a `file:` specifier and a `file:`
 * resolution spelling. The market library treats this shape generically — it
 * never interprets the path — while the binding check stays the recorded
 * `resolution.integrity` compared against the verified expectation.
 */
function isFileDependencyPin(dependency: UnknownRecord | undefined): dependency is UnknownRecord {
  if (dependency === undefined) return false
  return typeof dependency.specifier === 'string' && dependency.specifier.startsWith('file:')
    && typeof dependency.version === 'string' && dependency.version.startsWith('file:')
}

function assertProfileLockRecord(
  lockfile: UnknownRecord,
  packageName: string,
  version: string,
  expectedIntegrity: string,
): void {
  const importer = record(record(lockfile.importers)?.['.'])
  const dependencies = record(importer?.dependencies)
  const dependency = dependencies !== undefined && own(dependencies, packageName)
    ? record(dependencies[packageName])
    : undefined
  // Registry channel: the exact specifier a `--save-exact` add produces.
  // Tarball channel: the controlled `file:` pin whose recorded integrity is
  // checked below — the same value the verified entry signed over the
  // tarball bytes, so the record still pins the exact expected bytes.
  const registryPinned = dependency !== undefined
    && dependency.specifier === version
    && exactLockResolution(dependency.version, version)
  if (!registryPinned && !isFileDependencyPin(dependency)) {
    throw new Error('lockfile dependency mismatch')
  }

  // Both accepted pins verify `dependency.version` is a string; `String()`
  // only restores that narrowing for the probing below.
  const resolvedVersion = String(dependency.version)
  const baseKey = `${packageName}@${version}`
  const resolvedKey = `${packageName}@${resolvedVersion}`
  // When the profile tree already pins resolvable peers, pnpm records the
  // peer resolution as a `(@peer@version, …)` suffix on the importer's
  // `file:` version while the lockfile sections keep the bare spelling — the
  // same drift the registry channel tolerates through `exactLockResolution`.
  // The lookup probes both spellings; the integrity comparison below still
  // binds the exact expected bytes whichever entry answers.
  const peerSuffixIndex = resolvedVersion.indexOf('(')
  const fileKeys = [...new Set([
    peerSuffixIndex === -1 ? resolvedKey : `${packageName}@${resolvedVersion.slice(0, peerSuffixIndex)}`,
    resolvedKey,
  ])]
  // A `file:` pin resolves to its own lockfile key (`name@file:…`), never a
  // registry version key, so only the registry channel consults the
  // version-spelled keys.
  const packageKeys = registryPinned
    ? [...new Set([baseKey, `/${baseKey}`, resolvedKey, `/${resolvedKey}`])]
    : fileKeys
  const packageSnapshot = lockEntry(record(lockfile.packages) ?? {}, packageKeys)
  const resolution = record(packageSnapshot?.resolution)
  if (resolution?.integrity !== expectedIntegrity) throw new Error('lockfile integrity mismatch')

  const snapshot = lockEntry(record(lockfile.snapshots) ?? {}, registryPinned ? [resolvedKey, `/${resolvedKey}`] : fileKeys)
  if (snapshot === undefined) throw new Error('lockfile snapshot missing')
}

interface InstalledProfileSnapshot {
  readonly manifest: JsonManifest
  readonly lockfile: UnknownRecord
  readonly nodeModules: string
  readonly resolvedNodeModules: string
}

async function loadInstalledProfileSnapshot(profile: MarketDesktopProfile): Promise<InstalledProfileSnapshot> {
  const nodeModules = resolve(profile.dir, 'node_modules')
  const [manifest, lockfile, resolvedNodeModules] = await Promise.all([
    readManifest(join(profile.dir, 'package.json')),
    readProfileLock(profile),
    realpath(nodeModules),
  ])
  return { manifest, lockfile, nodeModules, resolvedNodeModules }
}

async function assertInstalledBundleFromSnapshot(
  snapshot: InstalledProfileSnapshot,
  packageName: string,
  version: string,
  expectedPatch: string,
  expectedIntegrity: string,
): Promise<string> {
  // Registry channel pins the exact version; the tarball channel (P7 2c)
  // pins the controlled `file:` tarball — the lockfile record below binds the
  // exact expected bytes either way.
  const dependencyValue = profileDependency(snapshot.manifest, packageName)
  if (dependencyValue !== version && !dependencyValue?.startsWith('file:')) {
    throw new Error('dependency mismatch')
  }
  if (!profileBundles(snapshot.manifest).includes(packageName)) throw new Error('bundle missing')
  const packageDir = join(snapshot.nodeModules, ...packageSegments(packageName))
  const resolvedPackageDir = await realpath(packageDir)
  if (!containedPath(snapshot.resolvedNodeModules, resolvedPackageDir)) throw new Error('package escaped profile')
  const manifest = await readManifest(join(resolvedPackageDir, 'package.json'))
  if (manifest.name !== packageName || manifest.version !== version) throw new Error('installed package mismatch')
  const patch = bundlePatch(manifest)
  if (patch === undefined || !safeBundlePatch(patch) || patch !== expectedPatch) {
    // Spelled with both values on purpose: `safeBundlePatch` normalizes an
    // optional leading './' before validating, so a bare 'cordis.patch.yml'
    // package declaration and a './cordis.patch.yml' signed entry are each
    // individually valid yet never equal — the exact prefix drift that rolled
    // back real-machine installs while the bare catch below hid the reason.
    throw new Error(
      `bundle patch mismatch: the installed package declares ${patch === undefined ? 'no dsh.bundle.patch' : JSON.stringify(patch)}, `
      + `the verified target expects ${JSON.stringify(expectedPatch)}`,
    )
  }
  const patchPath = resolve(resolvedPackageDir, patch)
  if (!containedPath(resolvedPackageDir, patchPath)) throw new Error('bundle patch invalid')
  const resolvedPatchPath = await realpath(patchPath)
  if (!containedPath(resolvedPackageDir, resolvedPatchPath) || !(await stat(resolvedPatchPath)).isFile()) {
    throw new Error('bundle patch invalid')
  }
  assertProfileLockRecord(snapshot.lockfile, packageName, version, expectedIntegrity)
  return resolvedPackageDir
}

async function assertInstalledBundle(
  profile: MarketDesktopProfile,
  packageName: string,
  version: string,
  expectedPatch: string,
  expectedIntegrity: string,
): Promise<string> {
  return await assertInstalledBundleFromSnapshot(
    await loadInstalledProfileSnapshot(profile),
    packageName,
    version,
    expectedPatch,
    expectedIntegrity,
  )
}

/** Overlay decision for one install target: what a candidate replaces, and what the ledger owes. */
interface InstallOverlayDecision {
  /** Receipt the candidate replaces; undefined keeps the fresh-install path. */
  readonly replaces: MarketInstallReceipt | undefined
  /**
   * Receipt proven stale (review P1-a): the profile no longer references the
   * package and the receipt no longer verifies against the disk state, so the
   * caller must drop it from the ledger before installing fresh.
   */
  readonly staleReceipt?: MarketInstallReceipt
}

/**
 * The install-target overlay state (P10 update path). A fresh install — the
 * profile does not reference the package and owns no receipt for it —
 * returns undefined. A version replacement returns the receipt that still
 * proves the installed version the candidate replaces: the profile
 * references the package, the market owns it, the receipt pins a different
 * version than the candidate, and the installed bundle still verifies
 * against that receipt (installed package, bundle patch, and lockfile
 * integrity — registry or controlled `file:` pin alike). Everything else
 * conflicts exactly like a fresh-install-only market: the same version
 * already installed, an install the market does not own, or a receipt that
 * no longer proves the disk state. The market never takes over an install
 * it cannot reconcile.
 *
 * One residual case is NOT a conflict: a receipt the profile no longer
 * references and that no longer verifies on disk (review P1-a — a profile
 * emptied or rebuilt by hand around a leftover receipt). The UI already
 * degrades that shape to "not installed" (the installed list drops receipts
 * that cannot verify), so the install path must offer the same way out:
 * verification failure marks the receipt stale — the caller clears it from
 * the ledger, the same posture as the P14 swap's receipt clear — and the
 * install proceeds on the fresh path. Only a receipt that still verifies
 * conflicts. The distinction follows `loadInstalledProfileSnapshot`
 * semantics: a wholly unreadable snapshot means nothing is installed (any
 * receipt for it is stale), while a readable snapshot that lacks the package
 * makes exactly that receipt stale.
 */
async function assertInstallOverlay(
  profile: MarketDesktopProfile,
  packageName: string,
  candidateVersion: string,
  receipts: readonly MarketInstallReceipt[],
): Promise<InstallOverlayDecision> {
  const owned = receipts.find(receipt => receipt.profileName === profile.name && receipt.packageName === packageName)
  const referenced = profileReferencesPlugin(await readManifest(join(profile.dir, 'package.json')), packageName)
  if (!referenced) {
    if (owned === undefined) return { replaces: undefined }
    try {
      await assertInstalledBundle(profile, owned.packageName, owned.version, owned.bundlePatch, owned.integrity)
    } catch {
      return { replaces: undefined, staleReceipt: owned }
    }
    throw new MarketInstallError('conflict', 'This plugin already has a market install receipt in the active profile.')
  }
  if (owned === undefined) {
    throw new MarketInstallError('conflict', 'This plugin is already managed by the active profile.')
  }
  if (owned.version === candidateVersion) {
    throw new MarketInstallError('conflict', 'This plugin is already installed at the selected version.')
  }
  try {
    await assertInstalledBundle(profile, owned.packageName, owned.version, owned.bundlePatch, owned.integrity)
  } catch (cause) {
    throw new MarketInstallError('conflict', `The installed plugin no longer matches its market receipt.${causeDetail(cause)}`)
  }
  return { replaces: owned }
}

async function assertRemoved(profile: MarketDesktopProfile, packageName: string): Promise<void> {
  const profileManifest = await readManifest(join(profile.dir, 'package.json'))
  if (profileReferencesPlugin(profileManifest, packageName)) {
    throw new Error('plugin remains in profile')
  }
}

function validReceipt(value: unknown): value is MarketInstallReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  if (!(typeof receipt.receiptId === 'string' && receipt.receiptId.length >= 16 && receipt.receiptId.length <= 128
    && typeof receipt.profileName === 'string' && receipt.profileName.length >= 1 && receipt.profileName.length <= 120
    && safePackageName(receipt.packageName)
    && marketManagedPackage(receipt.packageName)
    && stableExactVersion(receipt.version)
    && sha512Integrity(receipt.integrity)
    && safeBundlePatch(receipt.bundlePatch)
    && typeof receipt.sourceRecordId === 'string' && receipt.sourceRecordId.length >= 1 && receipt.sourceRecordId.length <= 200
    && typeof receipt.providerId === 'string' && receipt.providerId.length >= 1 && receipt.providerId.length <= 200
    && typeof receipt.itemId === 'string' && receipt.itemId.length >= 1 && receipt.itemId.length <= 200
    && typeof receipt.displayName === 'string' && receipt.displayName.length >= 1 && receipt.displayName.length <= 240
    && typeof receipt.installedAt === 'string' && !Number.isNaN(Date.parse(receipt.installedAt)))) return false
  // Legacy v1 receipts (written before the signed-manifest chain, P2-3) stay
  // valid for uninstall reconciliation and display; they carry no signed
  // evidence and are never a basis for any allow decision.
  if (receipt.receiptVersion === undefined || receipt.receiptVersion === 1) return true
  if (receipt.receiptVersion !== 2) return false
  // v2 receipts are validated strictly: signed decision identity, measured
  // tree, and the RFC 0004 evidence fields must all be present and consistent.
  if (!Number.isSafeInteger(receipt.manifestSequence) || (receipt.manifestSequence as number) < 1) return false
  if (!isCompanyManifestKeyId(receipt.keyId)) return false
  if (!validInstallTreeDigest(receipt.treeDigest)) return false
  const resolved = record(receipt.resolved)
  if (
    resolved === undefined
    || !sha512Integrity(resolved.registryIntegrity)
    || typeof resolved.treeRootDigest !== 'string'
    || !SHA256_HEX.test(resolved.treeRootDigest)
    || resolved.registryIntegrity !== receipt.integrity
    || resolved.treeRootDigest !== (receipt.treeDigest as MarketInstallTreeDigest).rootDigest
  ) return false
  const decided = record(receipt.decided)
  return decided !== undefined && decided.allowedBy === 'signed-company-manifest'
}

const SHA256_HEX = /^[0-9a-f]{64}$/u

/** Relative POSIX tree path guard aligned with the tree-digest determinism rules. */
function validTreePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INSTALL_TREE_PATH_LENGTH) return false
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

function validInstallTreeDigest(value: unknown): value is MarketInstallTreeDigest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const digest = value as Record<string, unknown>
  if (digest.algorithm !== 'sha256') return false
  if (typeof digest.rootDigest !== 'string' || !SHA256_HEX.test(digest.rootDigest)) return false
  if (!Array.isArray(digest.files) || digest.files.length > MAX_INSTALL_TREE_DIGEST_FILES) return false
  let previous: string | undefined
  for (const entry of digest.files) {
    const file = record(entry)
    if (file === undefined || !validTreePath(file.path)) return false
    if (typeof file.digest !== 'string' || !SHA256_HEX.test(file.digest)) return false
    // Records are unique and sorted by path in ascending UTF-16 code-unit order.
    if (previous !== undefined && !(previous < file.path)) return false
    previous = file.path
  }
  return true
}

/** Host-owned install workflow. No provider command or Renderer package spec crosses this boundary. */
export class MarketInstallService {
  private readonly candidates = new Map<string, InstallCandidate>()
  private readonly intents = new Map<string, MarketIntent>()
  private readonly restartIntents = new Map<string, RestartIntent>()
  private readonly now: () => number
  private readonly intentTtlMs: number
  private readonly candidateTtlMs: number
  private readonly maxIntents: number
  private readonly maxCandidates: number
  private readonly disabledPackageNames: () => readonly string[]
  private readonly allowedRegistryOrigin: string
  private readonly installTargetAuthority: InstallTargetAuthority
  private readonly installEvents: MarketInstallEventSink
  private readonly logger: Pick<Context['logger'], 'warn'>
  private readonly generation = new AbortController()
  private recoveryReconciliation: Promise<void> | undefined
  private operationActive = false
  private closed = false

  constructor(
    private readonly scope: SettingsScope<MarketSettingsDocument>,
    private readonly currentProfile: () => MarketDesktopProfile,
    private readonly pnpm: MarketDesktopPnpm,
    private readonly verifier: MarketNpmPackageVerifier,
    options: MarketInstallServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.intentTtlMs = options.intentTtlMs ?? INSTALL_INTENT_TTL_MS
    this.candidateTtlMs = options.candidateTtlMs ?? CANDIDATE_TTL_MS
    this.maxIntents = options.maxIntents ?? MAX_INTENTS
    this.maxCandidates = options.maxCandidates ?? MAX_CANDIDATES
    this.disabledPackageNames = options.disabledPackageNames ?? (() => [])
    this.allowedRegistryOrigin = allowedNpmRegistryOrigin(
      options.allowedRegistryOrigin ?? DEFAULT_NPM_REGISTRY_ORIGIN,
    )
    this.installTargetAuthority = options.installTargetAuthority ?? allowAllInstallTargetAuthority
    this.installEvents = options.installEventSink ?? noopMarketInstallEventSink
    // `console` structurally satisfies the picked logger shape; holding the
    // object (not the unbound method) keeps `console.warn` correctly bound.
    this.logger = options.logger ?? console
    if (typeof this.installTargetAuthority.canInstall !== 'function') {
      throw new TypeError('invalid market install target authority')
    }
    if (typeof this.installEvents.reportInstallEvent !== 'function') {
      throw new TypeError('invalid market install event sink')
    }
    for (const [label, value] of [
      ['intent TTL', this.intentTtlMs],
      ['candidate TTL', this.candidateTtlMs],
      ['intent limit', this.maxIntents],
      ['candidate limit', this.maxCandidates],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid market install ${label}`)
    }
  }

  observeCatalog(snapshot: CatalogSnapshot): void {
    if (this.closed) return
    this.purge()
    for (const item of snapshot.items) {
      const key = candidateKey(snapshot.source.sourceRecordId, item.id)
      this.candidates.delete(key)
      if (
        item.provenance.sourceRecordId !== snapshot.source.sourceRecordId
        || item.provenance.providerId !== snapshot.source.providerId
        || item.provenance.itemId !== item.id
        || item.package?.registry !== 'npm'
        || !safePackageName(item.package.name)
        || !marketManagedPackage(item.package.name)
        || !stableExactVersion(item.latestVersion)
        || item.repository === undefined
      ) {
        continue
      }
      let repository: NormalizedRepositoryIdentity
      try { repository = normalizeRepositoryIdentity(item.repository) }
      catch {
        continue
      }
      const candidate: InstallCandidate = {
        key,
        sourceRecordId: snapshot.source.sourceRecordId,
        providerId: snapshot.source.providerId,
        itemId: item.id,
        displayName: item.displayName,
        packageName: item.package.name,
        version: item.latestVersion,
        repository,
        savedAt: this.now(),
      }
      this.candidates.set(key, candidate)
      this.trim(this.candidates, this.maxCandidates)
    }
  }

  invalidateSource(sourceRecordId: string): void {
    for (const [key, candidate] of this.candidates) {
      if (candidate.sourceRecordId === sourceRecordId) {
        this.candidates.delete(key)
      }
    }
    for (const [token, intent] of this.intents) {
      if (intent.kind === 'install' && intent.candidate.sourceRecordId === sourceRecordId) this.intents.delete(token)
    }
  }

  async listReceipts(): Promise<readonly MarketInstallReceipt[]> {
    this.assertOpen()
    await this.ensureRecoveredInstallReconciled()
    const profile = this.profile()
    return this.receipts().filter(receipt => receipt.profileName === profile.name)
  }

  /** Receipts that still prove one exact installed bundle in the active profile. */
  async listVerifiedReceipts(signal: AbortSignal = this.generation.signal): Promise<readonly MarketInstallReceipt[]> {
    const operationSignal = this.operationSignal(signal)
    await this.ensureRecoveredInstallReconciled()
    operationSignal.throwIfAborted()
    const profile = this.profile()
    const receipts = this.receipts().filter(receipt => receipt.profileName === profile.name)
    if (receipts.length === 0) return []
    let snapshot: InstalledProfileSnapshot
    try { snapshot = await loadInstalledProfileSnapshot(profile) }
    catch (cause) {
      operationSignal.throwIfAborted()
      // A receipt outlives the profile it was written for: a profile the user
      // deleted by hand, or one whose first materialization never wrote its
      // lockfile, cannot prove any installed bundle. Degrade to "nothing
      // installed" instead of failing the whole list — a residual receipt
      // must never pin the market's installed view to an error, which no
      // restart can clear. The host logger (injected by Desktop) carries the
      // degrade into the persistent logs; the console fallback keeps
      // standalone deployments observable on a terminal.
      this.logger.warn(
        `dsh-community-market: could not read the active desktop profile ${JSON.stringify(profile.name)} `
        + `for installed-plugin verification (${cause instanceof Error ? cause.message : String(cause)}); `
        + 'reporting no installed plugins',
      )
      return []
    }
    const verified: MarketInstallReceipt[] = []
    for (const receipt of receipts) {
      try {
        await assertInstalledBundleFromSnapshot(
          snapshot,
          receipt.packageName,
          receipt.version,
          receipt.bundlePatch,
          receipt.integrity,
        )
        operationSignal.throwIfAborted()
        verified.push(receipt)
      } catch {
        operationSignal.throwIfAborted()
      }
    }
    return verified
  }

  async listInstallable(
    index: CatalogFullIndex,
    signal: AbortSignal,
  ): Promise<MarketInstallableResponse> {
    const operationSignal = this.operationSignal(signal)
    operationSignal.throwIfAborted()
    this.purge()
    const currentKeys = new Set(index.snapshots.flatMap(snapshot => (
      snapshot.items.map(item => candidateKey(index.source.sourceRecordId, item.id))
    )))
    for (const [key, candidate] of this.candidates) {
      if (candidate.sourceRecordId === index.source.sourceRecordId && !currentKeys.has(key)) {
        this.candidates.delete(key)
      }
    }
    for (const snapshot of index.snapshots) this.observeCatalog(snapshot)
    operationSignal.throwIfAborted()
    const items = index.snapshots.flatMap(snapshot => snapshot.items).filter(item => {
      const candidate = this.candidates.get(candidateKey(index.source.sourceRecordId, item.id))
      return candidate !== undefined
        && candidate.providerId === item.provenance.providerId
    })
    return {
      source: index.source,
      items,
      manualInstall: manualInstallHints(items),
      metadata: {
        scannedAt: index.scannedAt,
        expiresAt: index.expiresAt,
        ...(index.providerRevision === undefined ? {} : { providerRevision: index.providerRevision }),
        cacheStatus: index.cacheStatus,
      },
    }
  }

  async previewInstall(
    sourceRecordId: string,
    itemId: string,
    signal: AbortSignal,
  ): Promise<MarketInstallPreview> {
    const operationSignal = this.operationSignal(signal)
    await this.ensureRecoveredInstallReconciled()
    operationSignal.throwIfAborted()
    this.purge()
    const key = candidateKey(sourceRecordId, itemId)
    const candidate = this.candidates.get(key)
    if (candidate === undefined) {
      throw new MarketInstallError('not-available', 'This catalog item has no verified install target. Refresh the active source and try again.')
    }
    if (this.disabledPackages().has(candidate.packageName)) {
      throw new MarketInstallError('conflict', 'This plugin is disabled in the active desktop profile.')
    }
    const profile = this.profile()
    const replaces = await this.decideInstallOverlay(profile, candidate.packageName, candidate.version)
    let verification: MarketNpmPackageVerification
    try { verification = await this.verifier.verify(candidate, operationSignal) }
    catch (cause) {
      operationSignal.throwIfAborted()
      throw cause
    }
    operationSignal.throwIfAborted()
    this.assertOpen()
    if (this.candidates.get(key) !== candidate) {
      throw new MarketInstallError('not-available', 'The catalog source changed during verification. Refresh it and try again.')
    }
    this.assertInstallTargetAllowed(candidate, verification)
    const token = this.issueIntent({
      kind: 'install',
      candidate,
      verification,
      profile,
      expiresAt: this.now() + this.intentTtlMs,
    })
    return {
      intent: token,
      action: 'install',
      profileName: profile.name,
      packageName: candidate.packageName,
      version: candidate.version,
      displayName: candidate.displayName,
      expiresAt: new Date(this.now() + this.intentTtlMs).toISOString(),
      ...(replaces === undefined ? {} : { replaces: replaces.version }),
    }
  }

  async executeInstall(token: string, signal: AbortSignal): Promise<MarketInstallResult> {
    return await this.runExclusive(async () => {
      const operationSignal = this.operationSignal(signal)
      const intent = this.consumeIntent(token, 'install')
      const profile = this.sameProfile(intent.profile)
      const candidate = intent.candidate
      // Install telemetry (2026-09-07): exactly one categorical event per
      // attempt that got as far as knowing its target. Refusals before the
      // intent is consumed (expired confirmations, foreign profiles) carry
      // no install facts and report nothing; everything after reports the
      // terminal outcome — a fresh install, an in-place update, a failure
      // that rolled the profile back, or a plain refusal.
      let allowedSequence: number | undefined
      let rolledBack = false
      const reportInstall = (outcome: MarketInstallEventOutcome, cause?: unknown): void => {
        try {
          this.installEvents.reportInstallEvent({
            packageName: candidate.packageName,
            version: candidate.version,
            outcome,
            ...(allowedSequence === undefined ? {} : { manifestSequence: allowedSequence }),
            ...(cause === undefined ? {} : {
              ...(cause instanceof MarketInstallError ? { reasonCode: cause.code } : {}),
              // Privacy line: a free-form Error message may inline a pnpm stderr
              // tail or local paths. Only codes whose messages are our own fixed
              // vocabulary may carry a reason; every other failure reports the
              // code alone (the desktop projection masks again, belt and braces).
              ...(cause instanceof MarketInstallError && REASON_SAFE_INSTALL_CODES.has(cause.code)
                ? { reason: cause.message }
                : {}),
            }),
          })
        } catch {
          // A telemetry failure must never fail (or alter) an install.
        }
      }
      try {
        const disabledPackages = this.disabledPackages()
        if (disabledPackages.has(candidate.packageName)) {
          throw new MarketInstallError('conflict', 'This plugin is disabled in the active desktop profile.')
        }
        if (this.candidates.get(candidate.key) !== candidate) {
          throw new MarketInstallError('not-available', 'The verified catalog item is no longer available.')
        }
        // The overlay is re-decided under the exclusive lock: a replacement
        // remembers the receipt it must supersede (and restore on rollback);
        // undefined keeps the fresh-install path. The re-run keeps preview and
        // execute honest about drift between the two calls.
        const replaceReceipt = await this.decideInstallOverlay(
          profile,
          candidate.packageName,
          candidate.version,
        )
        let verification: MarketNpmPackageVerification
        try { verification = await this.verifier.verify(candidate, operationSignal) }
        catch (cause) {
          operationSignal.throwIfAborted()
          throw cause
        }
        operationSignal.throwIfAborted()
        if (
          verification.integrity !== intent.verification.integrity
          || verification.bundlePatch !== intent.verification.bundlePatch
          || verification.tarball !== intent.verification.tarball
        ) {
          throw new MarketInstallError('verification-failed', 'The npm package changed after preview. Preview the install again.')
        }
        const decision = this.assertInstallTargetAllowed(candidate, verification)
        allowedSequence = decision.evidence?.manifestSequence
        const overlayAtExecute = await this.decideInstallOverlay(
          profile,
          candidate.packageName,
          candidate.version,
        )
        if (overlayAtExecute?.receiptId !== replaceReceipt?.receiptId) {
          throw new MarketInstallError('conflict', 'The installed plugin changed before installation.')
        }
        if (this.candidates.get(candidate.key) !== candidate) {
          throw new MarketInstallError('not-available', 'The catalog source changed before installation.')
        }
        if (disabledPackages.has(candidate.packageName)) {
          throw new MarketInstallError('conflict', 'This plugin is disabled in the active desktop profile.')
        }
        const receiptId = randomUUID()
        try {
          await this.runPlugin(
            this.installOptions(candidate.packageName),
            profile,
            operationSignal,
            true,
            {
              packageName: candidate.packageName,
              packageVersion: candidate.version,
              receiptId,
            },
            // The signed entry's build-script approvals ride along so the
            // package-manager boundary can widen its workspace approval list
            // before pnpm materializes the dependency tree.
            decision.evidence?.approvedBuildDependencies,
          )
        } catch (cause) {
          if (!await this.installMayHaveMutatedProfile(profile, candidate.packageName)) throw cause
          await this.rollbackInstall(profile, candidate.packageName, receiptId, replaceReceipt)
          rolledBack = true
          // The cause is runPlugin's MarketInstallError, whose message already
          // carries the captured pnpm stderr tail; inline it so this branch
          // does not swallow the actual failure reason behind a generic text.
          throw new MarketInstallError(
            'operation-failed',
            `The package manager failed after changing the active profile, so the partial installation was rolled back.${causeDetail(cause)}`,
          )
        }
        let installedDir: string
        try {
          installedDir = await assertInstalledBundle(
            profile,
            candidate.packageName,
            candidate.version,
            verification.bundlePatch,
            verification.integrity,
          )
          operationSignal.throwIfAborted()
        } catch (cause) {
          await this.rollbackInstall(profile, candidate.packageName, receiptId, replaceReceipt)
          rolledBack = true
          // The cause is the post-install assertion's own error (bundle
          // identity, bundle patch, lockfile provenance) — inlining it keeps
          // the refusal honest instead of swallowing the reason behind a
          // generic text (the failure mode that hid the 0.4.181 prefix drift).
          throw new MarketInstallError(
            'operation-failed',
            `The package manager finished, but the plugin bundle was invalid, so the installation was rolled back.${causeDetail(cause)}`,
          )
        }
        // Post-install measurement (P2-3): the receipt records what is actually
        // on disk for installs a signed manifest allowed. Unlocked deployments
        // without signed evidence keep the legacy v1 receipt shape.
        let treeDigest: MarketInstallTreeDigest | undefined
        if (decision.evidence !== undefined) {
          try {
            treeDigest = await computeInstallTreeDigest(installedDir)
            operationSignal.throwIfAborted()
          } catch (cause) {
            await this.rollbackInstall(profile, candidate.packageName, receiptId, replaceReceipt)
            rolledBack = true
            throw new MarketInstallError(
              'operation-failed',
              `The package manager finished, but the installed plugin tree could not be measured, so the installation was rolled back.${causeDetail(cause)}`,
            )
          }
        }
        const receipt: MarketInstallReceipt = this.buildInstallReceipt(
          candidate,
          verification,
          profile,
          receiptId,
          new Date(this.now()).toISOString(),
          decision,
          treeDigest,
        )
        try {
          // A replacement supersedes the receipt of the version it replaces —
          // the store owns one receipt per (profile, package), and after a
          // successful version replacement the new version is the one install
          // the receipt must prove.
          await this.saveReceipts([
            ...this.receipts().filter(current => current.receiptId !== replaceReceipt?.receiptId),
            receipt,
          ])
        } catch {
          await this.rollbackInstall(profile, candidate.packageName, receiptId, replaceReceipt)
          rolledBack = true
          throw new MarketInstallError('persistence-failed', 'The install receipt could not be saved, so the installation was rolled back.')
        }
        reportInstall(replaceReceipt === undefined ? 'installed' : 'updated-in-place')
        return { receipt }
      } catch (cause) {
        reportInstall(rolledBack ? 'rolled-back' : 'failed', cause)
        throw cause
      }
    })
  }

  async executePreview(token: string, signal: AbortSignal): Promise<MarketOperationResult> {
    this.assertOpen()
    this.purge()
    const intent = this.intents.get(token)
    if (intent === undefined) {
      throw new MarketInstallError('intent-expired', 'The confirmation expired or was already used. Preview the operation again.')
    }
    const result: MarketOperationResult = intent.kind === 'install'
      ? { action: 'install', ...await this.executeInstall(token, signal), restartToken: this.issueRestartToken() }
      : { action: 'uninstall', ...await this.executeUninstall(token, signal), restartToken: this.issueRestartToken() }
    return result
  }

  /** Consume one short-lived restart grant issued only after a completed mutation. */
  consumeRestartToken(token: string): void {
    this.assertOpen()
    this.purge()
    const intent = this.restartIntents.get(token)
    if (intent === undefined) {
      throw new MarketInstallError('intent-expired', 'The restart confirmation expired or was already used.')
    }
    this.restartIntents.delete(token)
    this.sameProfile(intent.profile)
  }

  async previewUninstall(receiptId: string, signal: AbortSignal): Promise<MarketUninstallPreview> {
    const operationSignal = this.operationSignal(signal)
    await this.ensureRecoveredInstallReconciled()
    operationSignal.throwIfAborted()
    const profile = this.profile()
    const receipt = this.receipts().find(value => value.receiptId === receiptId && value.profileName === profile.name)
    if (receipt === undefined) {
      throw new MarketInstallError('not-available', 'This plugin is not owned by a market install receipt in the active profile.')
    }
    try {
      await assertInstalledBundle(profile, receipt.packageName, receipt.version, receipt.bundlePatch, receipt.integrity)
      operationSignal.throwIfAborted()
    }
    catch {
      operationSignal.throwIfAborted()
      // A receipt that cannot be proven against the disk (review P1-a — a
      // profile emptied or rebuilt by hand) is stale, not a conflict: the
      // installed list already reports the plugin as absent, so an uninstall
      // preview must answer "not installed" and clear the receipt instead of
      // dead-ending the user. Same `loadInstalledProfileSnapshot` semantics as
      // the install path: a wholly unreadable snapshot means nothing is
      // installed, and a readable snapshot without the package means exactly
      // this receipt is stale.
      await this.saveReceipts(this.receipts().filter(value => value.receiptId !== receipt.receiptId))
      this.logger.warn(
        `dsh-community-market: cleared a stale market install receipt for ${JSON.stringify(receipt.packageName)} `
          + `in profile ${JSON.stringify(receipt.profileName)} on uninstall preview (the receipt no longer verifies `
          + 'on disk); the plugin is not installed',
      )
      throw new MarketInstallError(
        'not-available',
        'This plugin is not installed in the active desktop profile; its stale market receipt was removed.',
      )
    }
    const expiresAt = this.now() + this.intentTtlMs
    const token = this.issueIntent({ kind: 'uninstall', receipt, profile, expiresAt })
    return {
      intent: token,
      action: 'uninstall',
      profileName: profile.name,
      packageName: receipt.packageName,
      version: receipt.version,
      displayName: receipt.displayName,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  async executeUninstall(token: string, signal: AbortSignal): Promise<MarketUninstallResult> {
    return await this.runExclusive(async () => {
      const operationSignal = this.operationSignal(signal)
      const intent = this.consumeIntent(token, 'uninstall')
      const profile = this.sameProfile(intent.profile)
      const currentReceipt = this.receipts().find(receipt => receipt.receiptId === intent.receipt.receiptId)
      if (currentReceipt === undefined || JSON.stringify(currentReceipt) !== JSON.stringify(intent.receipt)) {
        throw new MarketInstallError('conflict', 'The market install receipt changed before uninstall.')
      }
      try {
        await assertInstalledBundle(
          profile,
          currentReceipt.packageName,
          currentReceipt.version,
          currentReceipt.bundlePatch,
          currentReceipt.integrity,
        )
        operationSignal.throwIfAborted()
      }
      catch (cause) {
        throw new MarketInstallError('conflict', `The installed plugin no longer matches its market receipt.${causeDetail(cause)}`)
      }
      await this.runPlugin(['remove', currentReceipt.packageName], profile, operationSignal)
      try { await assertRemoved(profile, currentReceipt.packageName) }
      catch (cause) {
        throw new MarketInstallError(
          'operation-failed',
          `The package manager finished, but the plugin remains in the active profile.${causeDetail(cause)}`,
        )
      }
      try {
        await this.saveReceipts(this.receipts().filter(receipt => receipt.receiptId !== currentReceipt.receiptId))
      } catch {
        throw new MarketInstallError('persistence-failed', 'The plugin was removed, but its market receipt could not be updated.')
      }
      // Client event telemetry: a completed uninstall is fleet-visible churn
      // (the "who left" signal); categorical identity only, same as installs.
      this.reportUninstallEvent(currentReceipt.packageName, currentReceipt.version)
      return { receiptId: currentReceipt.receiptId, packageName: currentReceipt.packageName }
    })
  }

  /** Fire-and-forget uninstall event (throw-guarded like every sink call). */
  private reportUninstallEvent(packageName: string, version: string): void {
    try {
      this.installEvents.reportInstallEvent({ packageName, version, outcome: 'uninstalled' })
    } catch {
      // Telemetry must never fail an uninstall; drop the row silently.
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.generation.abort(new DOMException('Market install service was disposed', 'AbortError'))
    this.candidates.clear()
    this.intents.clear()
    this.restartIntents.clear()
  }

  private profile(): MarketDesktopProfile {
    const profile = this.currentProfile()
    if (!profile.name || !isAbsolute(profile.dir) || profile.dir.includes('\0')) {
      throw new MarketInstallError('operation-failed', 'The active desktop profile is unavailable.')
    }
    return Object.freeze({ name: profile.name, dir: resolve(profile.dir) })
  }

  private sameProfile(expected: MarketDesktopProfile): MarketDesktopProfile {
    const current = this.profile()
    if (current.name !== expected.name || current.dir !== expected.dir) {
      throw new MarketInstallError('conflict', 'The active desktop profile changed after preview.')
    }
    return current
  }

  /**
   * Decide the install overlay and reconcile a receipt proven stale into the
   * ledger (review P1-a): a receipt the profile no longer references and that
   * no longer verifies against the disk is deleted — persisted, the same
   * posture as the P14 swap's receipt clear — so the install continues on the
   * fresh path instead of dead-ending a healthy machine whose profile was
   * emptied by hand around a leftover receipt.
   */
  private async decideInstallOverlay(
    profile: MarketDesktopProfile,
    packageName: string,
    candidateVersion: string,
  ): Promise<MarketInstallReceipt | undefined> {
    const decision = await assertInstallOverlay(profile, packageName, candidateVersion, this.receipts())
    const stale = decision.staleReceipt
    if (stale !== undefined) {
      await this.saveReceipts(this.receipts().filter(receipt => receipt.receiptId !== stale.receiptId))
      this.logger.warn(
        `dsh-community-market: cleared a stale market install receipt for ${JSON.stringify(stale.packageName)} `
          + `in profile ${JSON.stringify(stale.profileName)} (the profile no longer references the package and the `
          + 'receipt no longer verifies on disk); reinstalling from scratch',
      )
    }
    return decision.replaces
  }

  private receipts(): readonly MarketInstallReceipt[] {
    const value = this.scope.get().installReceipts ?? []
    if (!Array.isArray(value) || value.length > MAX_RECEIPTS || !value.every(validReceipt)) {
      throw new MarketInstallError('persistence-failed', 'The market install receipt store is invalid.')
    }
    const ids = new Set(value.map(receipt => receipt.receiptId))
    const ownedPackages = new Set(value.map(receipt => `${receipt.profileName}\0${receipt.packageName}`))
    if (ids.size !== value.length || ownedPackages.size !== value.length) {
      throw new MarketInstallError('persistence-failed', 'The market install receipt store is invalid.')
    }
    return value
  }

  private disabledPackages(): ReadonlySet<string> {
    let names: readonly string[]
    try { names = this.disabledPackageNames() }
    catch (cause) {
      if (cause instanceof MarketInstallError) throw cause
      throw new MarketInstallError('operation-failed', 'Desktop plugin policy state is unavailable.')
    }
    if (!Array.isArray(names) || names.length > 10_000 || !names.every(safePackageName)) {
      throw new MarketInstallError('operation-failed', 'Desktop plugin policy state is invalid.')
    }
    return new Set(names)
  }

  private async saveReceipts(receipts: readonly MarketInstallReceipt[]): Promise<void> {
    if (receipts.length > MAX_RECEIPTS || !receipts.every(validReceipt)) throw new Error('invalid receipts')
    await this.scope.update({ installReceipts: receipts })
  }

  private async ensureRecoveredInstallReconciled(): Promise<void> {
    const existing = this.recoveryReconciliation
    if (existing !== undefined) return await existing
    const operation = this.reconcileRecoveredInstall()
    this.recoveryReconciliation = operation
    try {
      await operation
    } catch (cause) {
      if (this.recoveryReconciliation === operation) this.recoveryReconciliation = undefined
      throw cause
    }
  }

  private async reconcileRecoveredInstall(): Promise<void> {
    const receiptIds = await this.pnpm.recoveredInstallReceiptIds()
    if (receiptIds.length === 0) return
    const uniqueIds = new Set(receiptIds)
    const current = this.receipts()
    const retained = current.filter(receipt => !uniqueIds.has(receipt.receiptId))
    if (retained.length !== current.length) await this.saveReceipts(retained)
    for (const receiptId of uniqueIds) await this.pnpm.acknowledgeRecoveredInstall(receiptId)
  }

  private issueIntent(intent: MarketIntent): string {
    this.assertOpen()
    this.purge()
    let token = opaqueToken()
    while (this.intents.has(token)) token = opaqueToken()
    this.intents.set(token, intent)
    this.trim(this.intents, this.maxIntents)
    return token
  }

  private issueRestartToken(): string {
    this.assertOpen()
    this.purge()
    let token = opaqueToken()
    while (this.restartIntents.has(token)) token = opaqueToken()
    this.restartIntents.set(token, {
      profile: this.profile(),
      expiresAt: this.now() + this.intentTtlMs,
    })
    this.trim(this.restartIntents, this.maxIntents)
    return token
  }

  private consumeIntent<K extends MarketIntent['kind']>(token: string, kind: K): Extract<MarketIntent, { kind: K }> {
    this.purge()
    const intent = this.intents.get(token)
    if (intent === undefined || intent.kind !== kind) {
      throw new MarketInstallError('intent-expired', 'The confirmation expired or was already used. Preview the operation again.')
    }
    this.intents.delete(token)
    return intent as Extract<MarketIntent, { kind: K }>
  }

  private purge(): void {
    const now = this.now()
    for (const [key, candidate] of this.candidates) {
      if (now - candidate.savedAt >= this.candidateTtlMs) {
        this.candidates.delete(key)
      }
    }
    for (const [token, intent] of this.intents) {
      if (now >= intent.expiresAt) this.intents.delete(token)
    }
    for (const [token, intent] of this.restartIntents) {
      if (now >= intent.expiresAt) this.restartIntents.delete(token)
    }
  }

  private trim<T>(map: Map<string, T>, limit: number): void {
    while (map.size > limit) {
      const oldest = map.keys().next().value as string | undefined
      if (oldest === undefined) return
      map.delete(oldest)
    }
  }

  private async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.assertOpen()
    if (this.operationActive) throw new MarketInstallError('conflict', 'Another market package operation is already running.')
    this.operationActive = true
    try {
      return await task()
    } finally {
      this.operationActive = false
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new MarketInstallError('operation-failed', 'The market install service is unavailable.')
  }

  private operationSignal(signal: AbortSignal): AbortSignal {
    signal.throwIfAborted()
    this.assertOpen()
    return AbortSignal.any([signal, this.generation.signal])
  }

  private async installMayHaveMutatedProfile(profile: MarketDesktopProfile, packageName: string): Promise<boolean> {
    try { return await profileHasPluginReference(profile, packageName) }
    catch { return true }
  }

  private async runPlugin(
    args: readonly string[],
    profile: MarketDesktopProfile,
    signal: AbortSignal,
    includeGeneration = true,
    installRecovery?: {
      readonly packageName: string
      readonly packageVersion: string
      readonly receiptId: string
    },
    approvedBuildDependencies?: readonly string[],
  ): Promise<void> {
    const combinedSignal = includeGeneration ? AbortSignal.any([signal, this.generation.signal]) : signal
    combinedSignal.throwIfAborted()
    let handle: MarketDesktopPnpmHandle
    try {
      handle = installRecovery === undefined
        ? this.pnpm.runPlugin(args, profile.dir, combinedSignal)
        : await this.pnpm.installPlugin({
            pnpmOptions: args,
            invokingDir: profile.dir,
            recovery: installRecovery,
            ...(approvedBuildDependencies === undefined ? {} : { approvedBuildDependencies }),
            signal: combinedSignal,
          })
    }
    // Deliberately keep surfacing the start failure's own reason (e.g. the
    // desktop pnpm gate still held by a previous operation) instead of a
    // bare "could not start": the text flows through the same UI display and
    // log redaction pipeline as every other surfaced detail below.
    catch (cause) {
      throw new MarketInstallError(
        'operation-failed',
        'The desktop package manager could not start: '
          + boundedCauseText(cause instanceof Error ? cause.message : String(cause)),
      )
    }
    // Keep the tail of the package manager's stderr so failures carry the
    // actual pnpm error (TLS, registry, peer conflicts) into the surfaced
    // MarketInstallError instead of a generic "did not complete".
    const stderrTail: string[] = []
    handle.stderr.on('data', (chunk: Buffer) => {
      stderrTail.push(chunk.toString('utf8'))
      const overflow = stderrTail.join('').length - 8_000
      if (overflow > 0) {
        let remaining = overflow
        while (remaining > 0 && stderrTail.length > 1) {
          remaining -= stderrTail[0]!.length
          stderrTail.shift()
        }
      }
    })
    handle.stdout.resume()
    const cancel = () => handle.cancel()
    combinedSignal.addEventListener('abort', cancel, { once: true })
    let outcome: MarketDesktopPnpmOutcome
    try { outcome = await handle.done }
    catch {
      combinedSignal.throwIfAborted()
      throw new MarketInstallError('operation-failed', 'The desktop package manager failed.')
    }
    finally { combinedSignal.removeEventListener('abort', cancel) }
    combinedSignal.throwIfAborted()
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      const detail = stderrTail.join('').trim().split(/\r?\n/u).filter(line => line.length > 0).slice(-6).join(' | ')
      throw new MarketInstallError(
        'operation-failed',
        detail.length === 0
          ? 'The desktop package manager did not complete successfully.'
          : `The desktop package manager did not complete successfully: ${detail}`,
      )
    }
  }

  /** Fail closed with the verification surface unless the whitelist allows the verified target. */
  private assertInstallTargetAllowed(
    candidate: InstallCandidate,
    verification: MarketNpmPackageVerification,
  ): InstallTargetDecision {
    let decision: InstallTargetDecision
    try {
      decision = this.installTargetAuthority.canInstall({
        packageName: candidate.packageName,
        version: candidate.version,
        integrity: verification.integrity,
      })
    } catch (cause) {
      if (cause instanceof MarketInstallError) throw cause
      throw new MarketInstallError('verification-failed', 'The trusted install whitelist could not be evaluated.')
    }
    if (decision.allowed === true) return decision
    throw new MarketInstallError(
      'verification-failed',
      decision.reason === undefined
        ? 'The plugin package is not in the trusted install whitelist.'
        : `The plugin package is not in the trusted install whitelist: ${decision.reason}`,
    )
  }

  private installOptions(packageName: string): readonly string[] {
    const registry = `${this.allowedRegistryOrigin}/`
    const scope = packageName.startsWith('@') ? packageName.split('/', 1)[0] : undefined
    return [
      '--save-exact',
      `--registry=${registry}`,
      ...(scope === undefined ? [] : [`--${scope}:registry=${registry}`]),
    ]
  }

  /**
   * Assemble the persisted receipt: version 2 with the signed-manifest
   * evidence and the measured tree when the authority supplied evidence,
   * otherwise the legacy v1 shape for deployments without a signed chain.
   */
  private buildInstallReceipt(
    candidate: InstallCandidate,
    verification: MarketNpmPackageVerification,
    profile: MarketDesktopProfile,
    receiptId: string,
    installedAt: string,
    decision: InstallTargetDecision,
    treeDigest: MarketInstallTreeDigest | undefined,
  ): MarketInstallReceipt {
    const base = {
      receiptId,
      profileName: profile.name,
      packageName: candidate.packageName,
      version: candidate.version,
      integrity: verification.integrity,
      bundlePatch: verification.bundlePatch,
      sourceRecordId: candidate.sourceRecordId,
      providerId: candidate.providerId,
      itemId: candidate.itemId,
      displayName: candidate.displayName,
      installedAt,
    }
    const evidence = decision.evidence
    if (evidence === undefined || treeDigest === undefined) return base
    return {
      ...base,
      receiptVersion: 2,
      manifestSequence: evidence.manifestSequence,
      keyId: evidence.keyId,
      treeDigest,
      resolved: {
        registryIntegrity: verification.integrity,
        treeRootDigest: treeDigest.rootDigest,
      },
      decided: { allowedBy: 'signed-company-manifest' },
    }
  }

  /**
   * Restore the profile from the install-recovery snapshot. A fresh install
   * must leave the profile without the plugin; a replacement (P10) must
   * leave the replaced version installed again — the snapshot predates the
   * replacement, so the rollback target is the old version, not absence.
   */
  private async rollbackInstall(
    profile: MarketDesktopProfile,
    packageName: string,
    receiptId: string,
    replaceReceipt?: MarketInstallReceipt,
  ): Promise<void> {
    try {
      await this.pnpm.rollbackPluginInstall(receiptId)
      if (replaceReceipt === undefined) {
        await assertRemoved(profile, packageName)
      } else {
        await assertInstalledBundle(
          profile,
          replaceReceipt.packageName,
          replaceReceipt.version,
          replaceReceipt.bundlePatch,
          replaceReceipt.integrity,
        )
      }
    } catch {
      throw new MarketInstallError(
        'persistence-failed',
        'The failed installation could not be restored safely. Use the saved recovery state before another plugin change.',
      )
    }
  }
}
