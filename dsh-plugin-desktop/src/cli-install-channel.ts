/**
 * Signed-catalog gate for built-in-terminal `dsh plugin add` in locked builds
 * (P2-5).
 *
 * The channel replaces the P1-5 blanket denial: one `dsh plugin add
 * <package>@<exact version>` command is allowed through exactly when the
 * company catalog manifest — verified by the market signing library against
 * the policy trust roots — carries a matching, unrevoked entry. Any failed
 * step (unreadable or unfetchable manifest, bad signature, expired manifest,
 * absent or revoked entry, non-exact spec) is fail-closed: the command is
 * rejected with a reason and the upstream DSH CLI is never imported.
 *
 * Acquisition modes: content-mode builds read the manifest asset embedded in
 * the application bundle synchronously (milliseconds, no network); origin-
 * mode builds fetch the manifest once over the shared restricted client with
 * the policy origin pinned, redirects refused, and a multi-second whole-
 * request bound (`company-manifest-origin.ts`). The verification chain after
 * acquisition is byte-identical for both modes.
 *
 * Anti-rollback: the sequence floor comes from the local receipts ratchet —
 * the caller derives `lastSeenSequence` from the highest manifest sequence
 * recorded in the market settings install receipts, so an allowed add
 * requires a strictly newer manifest than any that already allowed an
 * install on this machine. The manifest asset ships inside the application
 * bundle, but under a per-user Windows install that bundle directory is
 * user-writable, so the asset alone is not a rollback boundary; closing that
 * writable-asset window is deferred to P3. Freshness is still enforced
 * through the signed `expiresAt`. (The Market channel keeps its own
 * settings-backed sequence store; this terminal gate rides the receipts
 * ratchet instead.)
 *
 * Layered integrity: the gate authenticates catalog membership — package,
 * exact version, revocation state, and the manifest signature. The pinned
 * tarball integrity of the allowed entry is enforced downstream: the install
 * transaction resolves the exact version through pnpm's registry dist
 * integrity, and boot verification (P2-4) reconciles installed trees against
 * the same signed catalog on every start.
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchCompanyManifestText, type CompanyManifestFetchOptions } from './company-manifest-origin.ts'
import type { DesktopPolicy } from './desktop-policy.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/** Upper bound of the embedded catalog asset; the schema caps 10000 entries (~2.5 MiB). */
const MAX_MANIFEST_ASSET_BYTES = 4 * 1024 * 1024
/** Mirrors `packageName` in the market's `docs/schemas/company-manifest.schema.json`. */
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
/** Mirrors `version` in the market's `docs/schemas/company-manifest.schema.json`. */
const EXACT_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u
const MARKET_GUIDANCE = 'Install plugins from the company plugin market instead.'
/**
 * pnpm flag the launcher injects after an allow so the profile lockfile pins
 * the exact specifier; a user-typed copy directly after `add` is accepted and
 * never duplicated.
 */
export const SAVE_EXACT_FLAG = '--save-exact'

/** One `<package>@<exact version>` plugin-add target. */
export interface CliPluginAddPackage {
  readonly packageName: string
  readonly version: string
}

/** Fail-closed verdict of the locked terminal plugin-add gate. */
export type LockedPluginAddDecision =
  | { readonly allowed: true; readonly packages: readonly CliPluginAddPackage[] }
  | { readonly allowed: false; readonly reason: string }

/** Overrides for focused tests; production uses the embedded asset and wall clock. */
export interface LockedPluginAddOptions {
  /** Absolute path of the embedded manifest asset; defaults to the file bundled beside this module. */
  readonly assetPath?: string
  /**
   * Origin-mode manifest acquisition overrides (request boundary, timeout,
   * body bound); defaults to the shared restricted policy-pinned fetch.
   */
  readonly fetch?: CompanyManifestFetchOptions
  /**
   * Highest manifest sequence this machine has already verified through an
   * install (the receipts ratchet); the manifest must strictly exceed it. A
   * safe non-negative integer or omitted — anything else fails the upstream
   * argument validation.
   */
  readonly lastSeenSequence?: number
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
}

function denied(reason: string): LockedPluginAddDecision {
  return { allowed: false, reason: `dsh-desktop: ${reason}` }
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/**
 * Parse one `<package>@<exact version>` plugin-add spec. Tags, ranges,
 * prereleases, and bare package names are rejected: both patterns mirror the
 * signed manifest schema exactly, so anything that parses is byte-comparable
 * with a manifest entry.
 * @param spec - single positional argument after `plugin add`.
 * @returns the exact target, or undefined for every non-exact spelling.
 */
export function parseExactPluginAddSpec(spec: string): CliPluginAddPackage | undefined {
  const separator = spec.lastIndexOf('@')
  if (separator <= 0) return undefined
  const packageName = spec.slice(0, separator)
  const version = spec.slice(separator + 1)
  if (!PACKAGE_NAME_PATTERN.test(packageName) || !EXACT_VERSION_PATTERN.test(version)) return undefined
  return { packageName, version }
}

/**
 * Resolve the embedded company catalog manifest shipped beside a built module
 * inside `lib/`. `companyManifestUrl` is a relative bundled asset path in
 * catalog-as-content deployments; the policy parser already rejects absolute
 * paths, backslashes, and dot segments, and the same rules are re-enforced
 * here so hand-built policies fail loudly instead of escaping the bundle.
 */
export function companyManifestAssetPath(moduleUrl: string, companyManifestUrl: string): string {
  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) {
    throw new TypeError(`${BIN_NAME}: company manifest module URL must be a non-empty file URL`)
  }
  if (typeof companyManifestUrl !== 'string' || companyManifestUrl.length === 0
    || companyManifestUrl.includes('\0') || companyManifestUrl.includes('\\')
    || companyManifestUrl.startsWith('/')) {
    throw new TypeError(`${BIN_NAME}: company manifest URL must be a relative bundled asset path without NUL or backslash`)
  }
  const segments = companyManifestUrl.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`${BIN_NAME}: company manifest URL must not contain empty or dot path segments`)
  }
  return join(dirname(fileURLToPath(new URL(moduleUrl))), ...segments)
}

/** The pinned npm registry flag value the market install path injects (mirrors pnpm.ts). */
const PINNED_NPM_REGISTRY = 'https://registry.npmjs.org/'

/**
 * Whether one argument is a pinned registry flag the market install path
 * injects (mirrors the pnpm option audit): `--registry=`/`--<scope>:registry=`
 * with exactly the official npm origin as the value. `--save-exact` is
 * handled separately (single occurrence).
 */
function isAcceptedRegistryFlag(argument: string): boolean {
  if (!argument.startsWith('--')) return false
  const equals = argument.indexOf('=')
  if (equals === -1) return false
  const name = argument.slice(2, equals)
  const value = argument.slice(equals + 1)
  return (name === 'registry' || name.endsWith(':registry')) && value === PINNED_NPM_REGISTRY
}

/**
 * Decide whether one locked-build terminal plugin add may proceed. The market
 * signing library is imported lazily so every CLI invocation that is not a
 * locked plugin add keeps its startup free of the market bundle.
 * @param packageSpecs - positional arguments after `plugin add` (profile flags already removed).
 * @param policy - embedded company policy providing the trust roots and manifest location.
 * @param options - the manifest asset path, origin fetch overrides, the receipts sequence floor, and test clock overrides.
 * @returns the allow decision with the resolved targets, or the denial reason.
 */
export async function authorizeLockedPluginAdd(
  packageSpecs: readonly string[],
  policy: DesktopPolicy,
  options: LockedPluginAddOptions = {},
): Promise<LockedPluginAddDecision> {
  // The launcher injects `--save-exact` after an allow and the Market install
  // path forwards its pinned registry flags, so those exact flags are
  // accepted and consumed here (each at most once); every other flag-looking
  // argument still fails the exact-spec parse.
  const packageArguments: string[] = []
  let saveExactSeen = false
  let registryFlagsSeen = 0
  for (const argument of packageSpecs) {
    if (argument === SAVE_EXACT_FLAG && !saveExactSeen) {
      saveExactSeen = true
      continue
    }
    if (isAcceptedRegistryFlag(argument) && registryFlagsSeen < 2) {
      registryFlagsSeen += 1
      continue
    }
    packageArguments.push(argument)
  }
  if (packageArguments.length !== 1) {
    return denied(`locked builds accept 'dsh plugin add <package>@<exact version>' with exactly one package argument (got ${String(packageArguments.length)}). ${MARKET_GUIDANCE}`)
  }
  const spec = packageArguments[0]!
  const target = parseExactPluginAddSpec(spec)
  if (target === undefined) {
    return denied(`'${spec}' is not a <package>@<exact version> spec; tags and ranges like 'latest' or '^1.0.0' are not accepted in locked builds. ${MARKET_GUIDANCE}`)
  }
  let raw: string
  if (policy.companyCatalogOrigin === null) {
    const assetPath = options.assetPath ?? companyManifestAssetPath(import.meta.url, policy.companyManifestUrl)
    if (typeof assetPath !== 'string' || !isAbsolute(assetPath) || assetPath.includes('\0')) {
      throw new TypeError(`${BIN_NAME}: company manifest asset path must be absolute without NUL`)
    }
    try {
      raw = readFileSync(assetPath, 'utf8')
    } catch (cause) {
      return denied(`unreadable company catalog manifest asset ${assetPath}: ${messageOf(cause)}`)
    }
  } else {
    // Origin mode: one restricted fetch of the pinned manifest URL; any
    // transport failure denies the command without importing the CLI.
    try {
      raw = await fetchCompanyManifestText(policy, options.fetch)
    } catch (cause) {
      return denied(`the company catalog manifest could not be fetched from ${policy.companyCatalogOrigin}: ${messageOf(cause)}. ${MARKET_GUIDANCE}`)
    }
  }
  if (raw.length > MAX_MANIFEST_ASSET_BYTES) {
    return denied(`the company catalog manifest exceeds ${String(MAX_MANIFEST_ASSET_BYTES)} bytes`)
  }
  const { findCompanyManifestPackage, verifyCompanyManifest } = await import('dsh-community-market')
  // The sequence floor rides the receipts ratchet (see module docs): a
  // rolled-back embedded asset cannot re-authorize a terminal add once a
  // newer manifest has allowed an install on this machine.
  const verification = verifyCompanyManifest(raw, {
    trustRoots: policy.trustRoots,
    ...(options.lastSeenSequence === undefined ? {} : { lastSeenSequence: options.lastSeenSequence }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (!verification.ok) {
    return denied(`rejected the company catalog manifest (${verification.code}): ${verification.reason}`)
  }
  const entry = findCompanyManifestPackage(verification.manifest, target.packageName, target.version)
  if (entry === undefined) {
    return denied(`${target.packageName}@${target.version} is not in the signed company plugin catalog. ${MARKET_GUIDANCE}`)
  }
  if (entry.revoked) {
    return denied(`${target.packageName}@${target.version} is revoked in the signed company plugin catalog. ${MARKET_GUIDANCE}`)
  }
  return { allowed: true, packages: [target] }
}
