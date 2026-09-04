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
 * The CLI red line is untouched: a user argument can never produce a
 * controlled tarball descriptor (the pnpm boundary still rejects every
 * user-argument tarball path), and the locked terminal add gate still denies
 * tarball entries with market guidance — only this in-process channel, bound
 * to a manifest it verified itself, can divert an install onto the tarball
 * target.
 */

import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import {
  companyManifestAssetPath,
} from './cli-install-channel.ts'
import {
  fetchCompanyManifestText,
} from './company-manifest-origin.ts'
import {
  findDesktopCompanyManifestPackage,
  installCompanyMarketTarballPlugin,
  stageCompanyMarketTarball,
  verifyDesktopCompanyManifest,
  type DesktopCompanyManifest,
  type DesktopCompanyManifestPackage,
} from './desktop-market.ts'
import type { DesktopPolicy } from './desktop-policy.ts'
import type {
  DesktopPnpmCompanyMarketChannel,
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
  /** Origin-mode manifest acquisition override (the Electron `net.fetch` composition); defaults to the shared restricted fetch. */
  readonly fetchManifestText?: typeof fetchCompanyManifestText
  /** Tarball download boundary; defaults to `globalThis.fetch` (the Electron composition injects `net.fetch`). */
  readonly request?: UpdateChannelRequest
  /** Diagnostic sink for staging keepalive warnings; defaults to silence. */
  readonly warn?: (message: string) => void
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
    return verification.manifest
  }

  const findTarballEntry = (
    manifest: DesktopCompanyManifest,
    packageName: string,
    version: string,
  ): DesktopCompanyManifestPackage | undefined => {
    const entry = findDesktopCompanyManifestPackage(manifest, packageName, version)
    if (entry === undefined) return undefined
    const source = entry.source ?? { kind: 'npm' as const }
    return source.kind === 'tarball' ? entry : undefined
  }

  return {
    async verifyTarballEntry(candidate, signal) {
      signal.throwIfAborted()
      const manifest = await acquireManifest(signal)
      if (manifest === undefined) return undefined
      const entry = findTarballEntry(manifest, candidate.packageName, candidate.version)
      if (entry === undefined || entry.revoked) return undefined
      const source = entry.source
      if (source === undefined || source.kind !== 'tarball') return undefined
      return {
        integrity: entry.integrity,
        bundlePatch: entry.bundlePatch,
        tarball: source.url,
      }
    },

    async divertCompanyTarballInstall(request, service) {
      // Only a request the channel itself can ground in a manifest it
      // verified is divertible; anything else keeps the registry path.
      if (request.marketTarball !== undefined) return undefined
      const manifest = verified?.manifest
      if (manifest === undefined) return undefined
      const { packageName, packageVersion } = request.recovery
      const entry = findTarballEntry(manifest, packageName, packageVersion)
      if (entry === undefined) return undefined
      const source = entry.source
      if (source === undefined || source.kind !== 'tarball') return undefined
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
            signal,
          })
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
