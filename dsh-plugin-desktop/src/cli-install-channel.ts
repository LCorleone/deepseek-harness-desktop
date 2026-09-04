/**
 * Signed-catalog gate for built-in-terminal `dsh plugin add` in locked builds
 * (P2-5).
 *
 * The channel replaces the P1-5 blanket denial: one `dsh plugin add
 * <package>@<exact version>` command is allowed through exactly when the
 * company catalog manifest — verified by the dual-channel verifier
 * (`verifyDesktopCompanyManifest`) against the policy trust roots — carries
 * a matching, unrevoked entry on the npm channel. Any failed step
 * (unreadable or unfetchable manifest, bad signature, expired manifest,
 * absent or revoked entry, non-exact spec) is fail-closed: the command is
 * rejected with a reason and the upstream DSH CLI is never imported.
 * Tarball-channel entries verify but are denied with market guidance: the
 * terminal resolves through the public registry, which can never satisfy a
 * tarball entry's signed integrity (see the deny site below).
 *
 * One exception to the blanket `file:` denial: a market-orchestrated
 * controlled tarball install. The Desktop market path installs verified
 * tarball-channel entries through this same packaged CLI child
 * (`dsh plugin add --save-exact --registry=… file:<staged path>`), so the
 * launcher hands the one allowed target across the process boundary in the
 * trusted tarball hand-off (`DSH_COMPANY_TARBALL_HANDOFF`, see
 * `company-tarball-handoff.ts` — the same trust model as the seven-key
 * policy hand-off and `DSH_COMPANY_MANIFEST_FILE`). The gate admits that
 * `file:` target only after double verification: the hand-off must name a
 * package@version the verified signed catalog carries on the tarball
 * channel with the entry's signed sha512 and the deterministic staged path
 * inside the profile being installed into, and a fresh hash of the staged
 * bytes must equal that signed sha512. Every other `file:` target — a
 * user-typed path, a hand-off naming different bytes, a mismatched spec —
 * stays denied, so the terminal red line is unchanged: without the
 * launcher's hand-off no `file:` argument ever reaches pnpm.
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
 * recorded in the market settings install receipts, and that floor is a
 * lower bound: an allowed add requires a manifest at least as new as any
 * that already allowed an install on this machine, so a rolled-back
 * manifest (sequence below the floor) is denied, while the same sequence —
 * re-installing from, or installing a second plugin out of, the catalog that
 * is already deployed — is the normal steady state and is allowed. The
 * manifest asset ships inside the application bundle, but under a per-user
 * Windows install that bundle directory is user-writable, so the asset
 * alone is not a rollback boundary; closing that writable-asset window is
 * deferred to P3. Freshness is still enforced through the signed
 * `expiresAt`. (The Market channel keeps its own settings-backed sequence
 * store; this terminal gate rides the receipts ratchet instead.)
 *
 * Layered integrity: the gate authenticates catalog membership — package,
 * exact version, revocation state, and the manifest signature. The pinned
 * tarball integrity of the allowed entry is enforced downstream: the install
 * transaction resolves the exact version through pnpm's registry dist
 * integrity, and boot verification (P2-4) reconciles installed trees against
 * the same signed catalog on every start. The allow decision also carries
 * the entry's signed `approvedBuilds` (when present) so the terminal
 * execution side can widen the profile's pnpm build approvals exactly like
 * the market install path.
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchCompanyManifestText, type CompanyManifestFetchOptions } from './company-manifest-origin.ts'
import {
  EXACT_VERSION_PATTERN,
  PACKAGE_NAME_PATTERN,
  desktopMarketTarballStagingPath,
  sha512OfStagedFile,
  stagedDigestMatchesIntegrity,
  type CompanyTarballHandoff,
} from './company-tarball-handoff.ts'
import type { DesktopPolicy } from './desktop-policy.ts'

const BIN_NAME = 'dsh-plugin-desktop'
/** Upper bound of the embedded catalog asset; the schema caps 10000 entries (~2.5 MiB). */
const MAX_MANIFEST_ASSET_BYTES = 4 * 1024 * 1024
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
  | {
      readonly allowed: true
      readonly packages: readonly CliPluginAddPackage[]
      /**
       * Signed `approvedBuilds` of the allowed entry, copied when it carries
       * the optional field; the terminal execution side merges it into the
       * profile's pnpm build approvals exactly like the market install path
       * (built-in triple ∪ signed list). Only the signed entry can widen the
       * approval list; entries without the field contribute no key.
       */
      readonly approvedBuildDependencies?: readonly string[]
    }
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
   * install (the receipts ratchet); the manifest must not regress below it —
   * the same sequence is a legitimate replay of the deployed catalog. A safe
   * non-negative integer or omitted — anything else fails the upstream
   * argument validation.
   */
  readonly lastSeenSequence?: number
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * The launcher's market-orchestrated tarball hand-off
   * (`DSH_COMPANY_TARBALL_HANDOFF`), already strictly parsed by the CLI
   * bootstrap. When present, the one package argument must be exactly the
   * hand-off's own `file:<staged path>` target, and that target is admitted
   * only after the double verification below. Without it, every `file:`
   * argument stays a non-exact-spec denial.
   */
  readonly tarballHandoff?: CompanyTarballHandoff
  /**
   * Directory of the profile the add targets — anchors the hand-off's
   * staged-path confinement (`desktopMarketTarballStagingPath`). Required
   * whenever a hand-off is offered; an absent directory fails the hand-off
   * closed instead of admitting an unconfined target.
   */
  readonly profileDir?: string
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
 * Decide whether one locked-build terminal plugin add may proceed. The
 * dual-channel verifier (`verifyDesktopCompanyManifest`) is imported lazily
 * through desktop-market.ts so every CLI invocation that is not a locked
 * plugin add keeps its startup free of the market bundle.
 * @param packageSpecs - positional arguments after `plugin add` (profile flags already removed).
 * @param policy - embedded company policy providing the trust roots and manifest location.
 * @param options - the manifest asset path, origin fetch overrides, the receipts sequence floor, the test clock, and — for a market-orchestrated install — the launcher's parsed tarball hand-off plus the profile directory confining its staged path.
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
  const handoff = options.tarballHandoff
  let target: CliPluginAddPackage
  if (spec.startsWith('file:')) {
    // The one admitted `file:` target is the launcher's own controlled
    // tarball install. Without the hand-off this is exactly the user-typed
    // case, and the denial below is the terminal red line unchanged.
    if (handoff === undefined) {
      return denied(`'${spec}' is not a <package>@<exact version> spec; tags and ranges like 'latest' or '^1.0.0' are not accepted in locked builds. ${MARKET_GUIDANCE}`)
    }
    if (options.profileDir === undefined) {
      return denied(`the controlled tarball hand-off for ${handoff.packageName}@${handoff.version} cannot be confined without the active profile directory. ${MARKET_GUIDANCE}`)
    }
    if (spec !== `file:${handoff.path}`) {
      return denied(`the controlled tarball hand-off pins the install target file:${handoff.path}, but the command asked for '${spec}'. ${MARKET_GUIDANCE}`)
    }
    // Path confinement mirrors the pnpm boundary: only the deterministic
    // staging path for this exact package version inside the profile being
    // installed into can ever be the target.
    const stagedPath = desktopMarketTarballStagingPath(options.profileDir, handoff.packageName, handoff.version)
    if (handoff.path !== stagedPath) {
      return denied(`a controlled market tarball may only install from the staged path ${stagedPath}. ${MARKET_GUIDANCE}`)
    }
    target = { packageName: handoff.packageName, version: handoff.version }
  } else {
    if (handoff !== undefined) {
      return denied(`the controlled tarball hand-off for ${handoff.packageName}@${handoff.version} is only valid for its own file: install target, but the command asked for '${spec}'. ${MARKET_GUIDANCE}`)
    }
    const parsed = parseExactPluginAddSpec(spec)
    if (parsed === undefined) {
      return denied(`'${spec}' is not a <package>@<exact version> spec; tags and ranges like 'latest' or '^1.0.0' are not accepted in locked builds. ${MARKET_GUIDANCE}`)
    }
    target = parsed
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
  const { findDesktopCompanyManifestPackage, verifyDesktopCompanyManifest } = await import('./desktop-market.ts')
  // The sequence floor rides the receipts ratchet (see module docs): a
  // rolled-back embedded asset cannot re-authorize a terminal add once a
  // newer manifest has allowed an install on this machine. The dual-channel
  // verifier keeps every `source`-free decision byte-identical to the
  // field-unaware market verifier that ran here before the P7 wiring; it
  // additionally recognizes a signed `source` channel per entry, which is
  // what makes this build "field-aware" for the fleet publication gate.
  const verification = verifyDesktopCompanyManifest(raw, {
    trustRoots: policy.trustRoots,
    companyCatalogOrigin: policy.companyCatalogOrigin,
    ...(options.lastSeenSequence === undefined ? {} : { lastSeenSequence: options.lastSeenSequence }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (!verification.ok) {
    return denied(`rejected the company catalog manifest (${verification.code}): ${verification.reason}`)
  }
  const entry = findDesktopCompanyManifestPackage(verification.manifest, target.packageName, target.version)
  if (entry === undefined) {
    return denied(`${target.packageName}@${target.version} is not in the signed company plugin catalog. ${MARKET_GUIDANCE}`)
  }
  if (entry.revoked) {
    return denied(`${target.packageName}@${target.version} is revoked in the signed company plugin catalog. ${MARKET_GUIDANCE}`)
  }
  const source = entry.source ?? { kind: 'npm' as const }
  if (source.kind === 'tarball') {
    if (handoff === undefined) {
      // The terminal `pnpm add <name>@<version>` resolves through the public
      // registry, but a tarball-channel entry's signed integrity is the
      // intranet tarball's sha512 — the registry path could never satisfy it
      // (and boot verification would refuse the mismatched tree). Controlled
      // tarball installs belong to the company market install path alone.
      return denied(
        `${target.packageName}@${target.version} is published on the tarball channel of the signed company plugin catalog and cannot be installed from the public registry. ${MARKET_GUIDANCE}`,
      )
    }
    // Market-orchestrated install — double verification (双验) before the
    // one `file:` target is admitted: the hand-off must carry exactly the
    // entry's signed sha512, and a fresh hash of the staged bytes must
    // equal that same signed integrity. A forged hand-off naming other
    // bytes, or a staged file that changed after staging, fails here.
    if (handoff.integrity !== entry.integrity) {
      return denied(
        `the controlled tarball hand-off for ${target.packageName}@${target.version} pins integrity ${handoff.integrity}, but the signed company plugin catalog pins ${entry.integrity}. ${MARKET_GUIDANCE}`,
      )
    }
    let digest: Buffer
    try {
      digest = await sha512OfStagedFile(handoff.path)
    } catch (cause) {
      return denied(
        `the staged tarball ${handoff.path} for ${target.packageName}@${target.version} is unusable: ${messageOf(cause)}. ${MARKET_GUIDANCE}`,
      )
    }
    if (!stagedDigestMatchesIntegrity(digest, entry.integrity)) {
      return denied(
        `the staged tarball ${handoff.path} for ${target.packageName}@${target.version} does not match the integrity pinned in the signed company plugin catalog. ${MARKET_GUIDANCE}`,
      )
    }
  } else if (handoff !== undefined) {
    // A `file:` target (the only shape a hand-off admits) is never valid for
    // an npm-channel entry: its signed integrity is the registry dist's, and
    // the controlled pipeline is not what the catalog signed for it.
    return denied(
      `${target.packageName}@${target.version} is not published on the tarball channel of the signed company plugin catalog — the controlled file: install target is not valid for it. ${MARKET_GUIDANCE}`,
    )
  }
  return {
    allowed: true,
    packages: [target],
    // The signed approval list rides with the allow decision so the
    // execution side can widen the workspace approvals before pnpm runs —
    // the same transport the market install path uses for its evidence.
    ...(entry.approvedBuilds === undefined ? {} : { approvedBuildDependencies: [...entry.approvedBuilds] }),
  }
}
