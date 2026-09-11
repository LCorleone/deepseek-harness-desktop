/**
 * The market UI's tarball install orchestration (P7 batch 2c).
 *
 * `stageCompanyMarketTarball` and `installCompanyMarketTarballPlugin`
 * (desktop-market.ts) implement the controlled tarball pipeline — download
 * from the policy-pinned catalog origin, verify the signed sha512 over the
 * downloaded bytes, stage inside the profile's controlled staging area,
 * install through the pnpm boundary's one constructible `file:` target, then
 * re-verify the installed bundle and the signed `treeDigest` with rollback
 * on divergence. Until this module they had no production caller: the market
 * UI's install flow resolved every catalog entry through the public npm
 * registry, which can never satisfy a tarball entry's signed sha512.
 *
 * This module is that wiring, delivered through two context capabilities the
 * embedding Host provides (main.ts):
 *
 * - `desktopMarketTarballEntryVerifier` — the market library's injected
 *   verification seam (`MarketTarballEntryVerifier`). For one catalog
 *   candidate it fetches and verifies the company manifest through the same
 *   dual-channel verifier as boot, the locked terminal add gate, and the
 *   locked catalog scan, and returns the signed tarball facts when the entry
 *   is published on the tarball channel — or undefined for every other
 *   outcome, which keeps the registry path byte-for-byte. The verified facts
 *   then ride the market's standard flow: the signed-manifest authority
 *   allows the exact signed sha512, the install request reaches the desktop
 *   pnpm boundary, and the post-install assert accepts the `file:` pin whose
 *   recorded integrity is that same signed sha512.
 *
 * - `desktopCompanyMarketTarballInstall` — the pnpm boundary's diversion
 *   hook (`DesktopPnpmCompanyMarketChannel`). When the market's install
 *   request arrives (a receipt-bound `name@version` target with npm flags),
 *   the channel recognizes the entry it just verified at execution time and
 *   takes the request over: stage → controlled install → re-verification →
 *   rollback, exactly `installCompanyMarketTarballPlugin`'s contract. Every
 *   failure — transport, sha512 mismatch over the downloaded bytes, a
 *   revoked or tree-anchor-less entry, a diverging installed tree, a package
 *   manager exit — settles the synthesized handle with a nonzero outcome and
 *   the readable reason on its stderr, which is the tail the market surfaces
 *   to the UI as the operation's error detail.
 *
 * The CLI red line is preserved by construction: a user argument can never
 * produce a controlled tarball descriptor (the pnpm boundary still rejects
 * every user-argument tarball path), and the locked terminal add gate still
 * denies a user-typed `file:` target with market guidance. The market
 * install's own `file:` target crosses that gate through the launcher's
 * trusted tarball hand-off (`DSH_COMPANY_TARBALL_HANDOFF`, injected by the
 * pnpm boundary for exactly these spawns), which the gate admits only after
 * re-binding it to the signed catalog entry and re-hashing the staged bytes
 * — see `company-tarball-handoff.ts` and `cli-install-channel.ts`.
 * When the resolved entry is beta-pinned (#59/#60) — a roster machine's
 * verified beta overlay carries it and the stable manifest does not — the
 * channel additionally stages the exact verified beta manifest bytes at the
 * profile's deterministic staging path and rides them, with their sequence,
 * in the same hand-off, so the child's gate can re-verify them and widen its
 * lookup to stable ∪ beta instead of denying the beta-only target. A
 * beta-pinned npm-channel entry has no tarball at all: the channel stages the
 * same bytes and takes the request over as the plain registry install
 * carrying the beta-only hand-off, so the target stays the `name@version`
 * spec the catalog signed for the npm channel. Only this in-process channel,
 * bound to a manifest it verified itself, can divert an install onto the
 * tarball target or attach the staged beta manifest to a registry install.
 */

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  companyManifestAssetPath,
} from './cli-install-channel.ts'
import {
  fetchCompanyManifestText,
} from './company-manifest-origin.ts'
import type { DesktopBetaChannelOverlay } from './beta-channel.ts'
import { desktopBetaManifestHandoffStagingPath } from './company-tarball-handoff.ts'
import {
  findDesktopCompanyManifestPackageWithBeta,
  installCompanyMarketTarballPlugin,
  stageCompanyMarketTarball,
  verifyDesktopCompanyManifest,
  type DesktopCompanyManifest,
  type DesktopCompanyManifestPackage,
} from './desktop-market.ts'
import type { DesktopPolicy } from './desktop-policy.ts'
import type {
  DesktopPnpmCompanyMarketChannel,
  DesktopPnpmHandle,
  DesktopPnpmOutcome,
} from './pnpm.ts'
import type { UpdateChannelRequest } from './update-manifest.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** Verification the market library's tarball seam expects (structural mirror of `MarketNpmPackageVerification`). */
export interface DesktopMarketTarballVerification {
  /** Signed sha512 of the tarball file — equals the lockfile `resolution.integrity` of the `file:` install. */
  readonly integrity: string
  /** Signed in-package bundle patch path. */
  readonly bundlePatch: string
  /** Controlled tarball URL of the signed entry (audit/display only). */
  readonly tarball: string
}

/** One (packageName, version) target the seam is asked about. */
export interface DesktopMarketTarballCandidate {
  readonly packageName: string
  readonly version: string
}

/** Options of {@link createDesktopCompanyMarketTarballInstallChannel}. */
export interface DesktopCompanyMarketTarballInstallOptions {
  /** Embedded company policy: trust roots, catalog origin, and content-mode manifest asset. */
  readonly policy: DesktopPolicy
  /** Active profile directory; the staging area lives inside it. */
  readonly profileDir: string
  /**
   * Anti-rollback floor supplier — the highest manifest sequence this
   * machine has already verified through an install (the receipts ratchet).
   * The main process derives it from the shared market settings document;
   * focused tests inject a constant.
   */
  readonly lastSeenSequence?: () => number | undefined
  /**
   * Absolute path of the launcher's generation-scoped stable manifest
   * staging file (`DSH_COMPANY_MANIFEST_FILE`), present only when the boot
   * path staged one for this generation. When set, every manifest this
   * channel verifies is re-written here (atomically, `0o600`) so a CLI child
   * spawned for the same market operation reads a current snapshot: the
   * boot-time bytes age as the catalog advances, and a snapshot below the
   * child's receipts ratchet would deny the install — the child's own
   * network retry being exactly the corporate-CA path the staging exists to
   * bypass. `undefined` (content mode, a boot staging failure, or a
   * non-origin generation) writes nothing; an absent file is never created.
   */
  readonly stableManifestStagingFile?: string
  /** Origin-mode manifest acquisition override (the Electron `net.fetch` composition); defaults to the shared restricted fetch. */
  readonly fetchManifestText?: typeof fetchCompanyManifestText
  /**
   * Beta overlay resolver (P9): resolves the verified, roster-admitted beta
   * entries next to the stable manifest (the host's shared beta resolver —
   * same trust roots, same SSO session). A beta entry the stable manifest
   * does not pin resolves through this overlay: a tarball entry verifies
   * through the market seam instead of failing the registry cross-check, and
   * an npm entry diverts to the registry install carrying the staged beta
   * manifest (#60). `undefined` (non-roster machines, beta unverified) keeps
   * the channel on the stable manifest alone.
   */
  readonly betaOverlay?: () => Promise<DesktopBetaChannelOverlay | undefined>
  /** Tarball download boundary; defaults to `globalThis.fetch` (the Electron composition injects `net.fetch`). */
  readonly request?: UpdateChannelRequest
  /** Diagnostic sink for staging keepalive warnings; defaults to silence. */
  readonly warn?: (message: string) => void
  /**
   * Desktop log sink for post-install assertion failures (bundle identity,
   * bundle patch, signed tree digest); rides the install orchestration, so
   * the desktop log file keeps the assertion name and expected-vs-actual
   * detail even when the market UI shows only the one-line reason. Defaults
   * to silence.
   */
  readonly logError?: (message: string) => void
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
}

/** The combined channel: the market's verification seam plus the pnpm boundary's diversion hook. */
export interface DesktopCompanyMarketTarballInstallChannel extends DesktopPnpmCompanyMarketChannel {
  /** The market library's `MarketTarballEntryVerifier` view (see the module documentation). */
  verifyTarballEntry(
    candidate: DesktopMarketTarballCandidate,
    signal: AbortSignal,
  ): Promise<DesktopMarketTarballVerification | undefined>
}

const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/**
 * Build the tarball install channel over one immutable profile generation.
 * The channel keeps the last manifest it verified itself; the diversion hook
 * consults exactly that state, so an install can only ever be diverted onto
 * an entry the channel verified through the deployment trust roots within
 * this generation.
 */
export function createDesktopCompanyMarketTarballInstallChannel(
  options: DesktopCompanyMarketTarballInstallOptions,
): DesktopCompanyMarketTarballInstallChannel {
  const policy = options.policy
  let verified: { readonly manifest: DesktopCompanyManifest } | undefined
  let verifiedBeta: {
    readonly packages: readonly DesktopCompanyManifestPackage[]
    readonly sequence: number
    readonly manifestText: string
  } | undefined

  const acquireManifest = async (signal: AbortSignal): Promise<DesktopCompanyManifest | undefined> => {
    // Unlocked policies and policies without trust roots have no signed
    // channel to consult; the seam stays silent (registry path unchanged).
    if (policy.locked !== true || policy.trustRoots.length === 0) return undefined
    let raw: string
    try {
      raw = policy.companyCatalogOrigin === null
        // Content mode: the embedded asset beside this module, read
        // synchronously exactly like the locked terminal add gate does.
        ? readFileSync(companyManifestAssetPath(import.meta.url, policy.companyManifestUrl), 'utf8')
        : await (options.fetchManifestText ?? fetchCompanyManifestText)(policy)
    } catch {
      // Any acquisition failure keeps the seam silent: the registry verifier
      // produces the standard, already-localized verification failure.
      return undefined
    }
    if (signal.aborted) return undefined
    const floor = options.lastSeenSequence?.()
    const verification = verifyDesktopCompanyManifest(raw, {
      trustRoots: policy.trustRoots,
      companyCatalogOrigin: policy.companyCatalogOrigin,
      ...(floor === undefined ? {} : { lastSeenSequence: floor }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    if (!verification.ok) return undefined
    verified = { manifest: verification.manifest }
    // Re-stage the stable snapshot for the CLI children (方案D): the boot
    // path staged the manifest once at startup, so those bytes age as the
    // catalog advances while the market scan keeps raising the child's
    // anti-rollback floor — a stale snapshot then denies every install until
    // the client restarts, and the child's own network retry is the
    // corporate-CA transport the staging exists to avoid. This operation just
    // verified fresh bytes through the Electron network stack, so refresh the
    // same file the children read (`DSH_COMPANY_MANIFEST_FILE`) with exactly
    // those bytes. Origin mode only (content mode has no boot-staged file),
    // and best-effort: a failed write must never fail the operation, since
    // the child keeps its restricted network fallback. The child re-verifies
    // the signature over whatever bytes it reads, so this carries freshness,
    // never trust.
    if (policy.companyCatalogOrigin !== null && options.stableManifestStagingFile !== undefined) {
      try {
        await writeFileAtomic(options.stableManifestStagingFile, raw, { mode: 0o600, dirMode: 0o700 })
      } catch (cause) {
        options.warn?.(`refreshing the staged company catalog manifest for CLI children failed: ${messageOf(cause)}`)
      }
    }
    // Beta overlay (P9): resolved after the stable manifest verifies, so its
    // staleness floor is the just-verified stable sequence; every overlay
    // outcome except an admitted package list keeps the channel stable-only.
    if (options.betaOverlay !== undefined) {
      try {
        const overlay = await options.betaOverlay()
        if (overlay !== undefined && overlay.sequence >= verification.manifest.sequence) {
          verifiedBeta = { packages: overlay.packages, sequence: overlay.sequence, manifestText: overlay.manifestText }
        }
      } catch {
        verifiedBeta = undefined
      }
    }
    return verification.manifest
  }

  /** One resolved catalog entry (stable ∪ beta) and whether the beta overlay supplied it (#59/#60). */
  interface ResolvedCatalogEntry {
    readonly entry: DesktopCompanyManifestPackage
    readonly fromBeta: boolean
  }

  const findCatalogEntry = (
    manifest: DesktopCompanyManifest,
    packageName: string,
    version: string,
  ): ResolvedCatalogEntry | undefined => {
    // Beta first (P9): a roster-admitted beta entry wins over the stable
    // manifest's entry for the same name@version — the market catalog's
    // merge rule — and beta-only entries resolve here too.
    const entry = findDesktopCompanyManifestPackageWithBeta(manifest, verifiedBeta?.packages, packageName, version)
    if (entry === undefined) return undefined
    // The winning entry came from the beta overlay exactly when the overlay
    // carries this name@version (revocation stickiness may still mark it
    // revoked through the stable manifest — that flag refuses the install
    // below regardless of which channel supplied the other fields).
    return {
      entry,
      fromBeta: verifiedBeta?.packages.some(
        candidate => candidate.packageName === packageName && candidate.version === version,
      ) === true,
    }
  }

  return {
    async verifyTarballEntry(candidate, signal) {
      signal.throwIfAborted()
      const manifest = await acquireManifest(signal)
      if (manifest === undefined) return undefined
      const resolved = findCatalogEntry(manifest, candidate.packageName, candidate.version)
      if (resolved === undefined || resolved.entry.revoked) return undefined
      const source = resolved.entry.source
      if (source === undefined || source.kind !== 'tarball') return undefined
      return {
        integrity: resolved.entry.integrity,
        bundlePatch: resolved.entry.bundlePatch,
        tarball: source.url,
      }
    },

    async divertCompanyMarketInstall(request, service) {
      // Only a request the channel itself can ground in a manifest it
      // verified is divertible; anything else keeps the registry path.
      if (request.marketTarball !== undefined) return undefined
      const manifest = verified?.manifest
      if (manifest === undefined) return undefined
      const { packageName, packageVersion } = request.recovery
      const resolved = findCatalogEntry(manifest, packageName, packageVersion)
      if (resolved === undefined) return undefined
      const { entry, fromBeta } = resolved
      const source = entry.source ?? { kind: 'npm' as const }
      // npm-channel beta target (#60): the registry install is exactly what
      // the catalog signed for it — no tarball is staged and no controlled
      // target exists — but the packaged CLI child's gate consults the
      // stable manifest alone unless the staged beta manifest rides the
      // hand-off. Stage the exact bytes this channel verified and
      // roster-admitted, hand the registry install the pair through the
      // boundary (which injects the beta-only hand-off), and remove the
      // staged file — the roster in cleartext — as soon as that install
      // settles. A stable-resolving npm target, a revoked entry, or a
      // non-roster machine keeps the registry path byte-for-byte.
      if (source.kind !== 'tarball') {
        if (!fromBeta || verifiedBeta === undefined || entry.revoked) return undefined
        const betaManifestPath = desktopBetaManifestHandoffStagingPath(options.profileDir)
        await writeFileAtomic(betaManifestPath, verifiedBeta.manifestText, { mode: 0o600, dirMode: 0o700 })
        let handle: DesktopPnpmHandle
        try {
          handle = await service.installPlugin({
            ...request,
            betaManifest: { path: betaManifestPath, sequence: verifiedBeta.sequence },
          })
        } catch (cause) {
          await rm(betaManifestPath, { force: true }).catch(() => {})
          throw cause
        }
        const installed = handle.done
        return {
          stdout: handle.stdout,
          stderr: handle.stderr,
          cancel: () => { handle.cancel() },
          done: (async (): Promise<DesktopPnpmOutcome> => {
            try {
              return await installed
            } finally {
              await rm(betaManifestPath, { force: true }).catch(() => {})
            }
          })(),
        }
      }
      const cancel = new AbortController()
      const signal = request.signal === undefined
        ? cancel.signal
        : AbortSignal.any([request.signal, cancel.signal])
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let settled = false
      const emit = (line: string): void => {
        if (!settled) stderr.write(`${line}\n`)
      }
      const outcome = (async (): Promise<DesktopPnpmOutcome> => {
        try {
          request.signal?.throwIfAborted()
          // Refusals that need no download first: a revoked entry, and an
          // entry without the signed tree anchor the channel is built on
          // (the orchestration re-checks both; failing early saves the
          // download of an install that can never be accepted).
          if (entry.revoked) {
            throw new Error(`${BIN_NAME}: ${packageName}@${packageVersion} is revoked in the signed company catalog`)
          }
          if (typeof entry.treeDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.treeDigest)) {
            throw new Error(`${BIN_NAME}: ${packageName}@${packageVersion} carries no signed treeDigest — the tarball channel installs only tree-anchored entries`)
          }
          const staged = await stageCompanyMarketTarball({
            policy,
            source,
            packageName,
            version: packageVersion,
            profileDir: options.profileDir,
            ...(options.request === undefined ? {} : { request: options.request }),
            ...(options.warn === undefined ? {} : { warn: options.warn }),
            signal,
          })
          request.signal?.throwIfAborted()
          // Beta-pinned target (#59): stage the exact verified beta manifest
          // bytes for the packaged CLI child's gate. The child's own catalog
          // (the embedded asset or its own origin fetch) is stable-only, so
          // without these bytes its gate would deny the beta-only target the
          // market just resolved — the #59 real-device failure. The bytes are
          // what this channel verified after the roster admission, at the one
          // deterministic staging path the child accepts; the child re-verifies
          // the signature, the origin binding, and the sequence binding before
          // its lookup widens, so this staging carries location, never trust.
          let betaManifest: { readonly path: string; readonly sequence: number } | undefined
          if (fromBeta && verifiedBeta !== undefined) {
            const betaManifestPath = desktopBetaManifestHandoffStagingPath(options.profileDir)
            await writeFileAtomic(betaManifestPath, verifiedBeta.manifestText, { mode: 0o600, dirMode: 0o700 })
            betaManifest = { path: betaManifestPath, sequence: verifiedBeta.sequence }
          }
          // Hygiene (review P3): the staged beta manifest carries the testers
          // roster in cleartext. It must exist exactly for the child gate's
          // window — remove it when the install settles either way, so the
          // roster never lingers in a user-readable profile path (diagnostics
          // bundles and backups would otherwise carry it).
          try {
          await installCompanyMarketTarballPlugin({
            service,
            entry: {
              packageName,
              version: packageVersion,
              integrity: entry.integrity,
              bundlePatch: entry.bundlePatch,
              revoked: entry.revoked,
              treeDigest: entry.treeDigest,
              ...(entry.approvedBuilds === undefined ? {} : { approvedBuilds: [...entry.approvedBuilds] }),
            },
            tarball: staged.tarball,
            recovery: request.recovery,
            profileDir: options.profileDir,
            invokingDir: request.invokingDir,
            // The diverted request's audited flags ride along, so the
            // controlled tarball install runs with exactly the options its
            // registry twin would (the boundary re-audits them).
            ...(request.pnpmOptions === undefined ? {} : { pnpmOptions: [...request.pnpmOptions] }),
            // The desktop log sink rides along, so every post-install
            // assertion failure (bundle identity, patch application, signed
            // tree digest) reaches the desktop log file with its assertion
            // name and expected-vs-actual detail.
            ...(options.logError === undefined ? {} : { logError: options.logError }),
            ...(betaManifest === undefined ? {} : { betaManifest }),
            // Bridge the package-manager child's stderr into this channel's
            // stderr while the install runs, so the real failure reason — a
            // CLI gate denial, a pnpm error — reaches the market UI's error
            // detail live instead of a generic exit-code line.
            forwardStderr: chunk => { stderr.write(chunk) },
            signal,
          })
          } finally {
            if (betaManifest !== undefined) {
              await rm(betaManifest.path, { force: true }).catch(() => {})
            }
          }
          return { exitCode: 0, signal: null }
        } catch (cause) {
          emit(messageOf(cause))
          return { exitCode: 1, signal: null }
        } finally {
          settled = true
          stdout.end()
          stderr.end()
        }
      })()
      return {
        stdout,
        stderr,
        done: outcome,
        cancel: () => { cancel.abort() },
      }
    },
  }
}
