/**
 * The shared controlled-tarball contract between the Electron launcher and
 * the packaged CLI child (P7 fix for the free-search real-device install).
 *
 * The desktop pnpm boundary ({@linkcode DesktopPnpmService.installPlugin})
 * installs a verified market tarball through the packaged `desktop-cli.js`
 * child as `dsh plugin add … file:<staged path>`. In locked builds that
 * child's terminal add gate (`cli-install-channel.ts`) must keep rejecting
 * every user-typed `file:` target, so the launcher hands the one allowed
 * target across the process boundary through a dedicated environment
 * entry — the same trust model as the seven-key policy hand-off and
 * `DSH_COMPANY_MANIFEST_FILE`: the value is constructed by the trusted
 * Electron main process, and the CLI child treats it as launcher input but
 * never trusts it alone — the gate re-binds it to the signed catalog entry
 * and re-hashes the staged bytes before the target is admitted (双验).
 *
 * A user argument cannot forge the hand-off into admitting arbitrary bytes:
 * the value must name a package@version the signed catalog carries on the
 * tarball channel, its integrity must equal that entry's signed sha512, its
 * path must be the entry's deterministic staging path inside the profile
 * being installed into, and a fresh hash of the staged file must equal the
 * signed sha512 — content the company signed, or nothing.
 *
 * This module stays dependency-free (Node builtins only): the CLI bootstrap
 * imports it eagerly, so it must never drag the market bundle, Cordis, or
 * any other desktop composition graph into a CLI child's startup. It also
 * owns the staging-path layout and the staged-file hashing both sides share.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, createReadStream, fstatSync, openSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const BIN_NAME = 'dsh-plugin-desktop'

/**
 * Environment key carrying one market-orchestrated controlled tarball
 * install from the launcher to the packaged CLI child. Injected per spawn by
 * `DesktopPnpmService.installPlugin` (never part of the generation-wide
 * policy hand-off, never persisted in a terminal shim) and consumed —
 * removed from the environment — by `runDesktopDshCli` before the upstream
 * CLI import, so pnpm children never inherit it.
 */
export const DESKTOP_COMPANY_TARBALL_HANDOFF_ENV = 'DSH_COMPANY_TARBALL_HANDOFF'

/** Upper bound of the hand-off value: four bounded fields in canonical JSON. */
export const COMPANY_TARBALL_HANDOFF_MAX_BYTES = 4_096

/**
 * npm package-name grammar mirrored by the signed manifest schema, the pnpm
 * boundary's audits, and the staging-name encoding below.
 */
export const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
/** Exact npm version spelling the pnpm boundary accepts (prerelease and build metadata included). */
export const NPM_EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
/**
 * Strict exact version spelling of the signed manifest schema (plain
 * semantic versions only). Anything that matches is byte-comparable with a
 * manifest entry; the tarball hand-off uses this form because its target
 * must resolve to a catalog entry.
 */
export const EXACT_VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u

const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u

/** Whether a value is the standard base64 SHA-512 integrity spelling the signed catalog pins. */
export function isSha512Integrity(value: string): boolean {
  if (!SHA512_INTEGRITY_PATTERN.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

/**
 * Staging directory inside the active profile where the Desktop market
 * pipeline parks verified plugin tarballs before installing them. Only files
 * at the deterministic path below this directory can ever become an install
 * target (see {@linkcode desktopMarketTarballStagingPath}).
 */
export const DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY = '.dsh-market-tarballs'
/** Upper bound of one staged market tarball; the download and install gates share it. */
export const DESKTOP_MARKET_TARBALL_MAX_BYTES = 512 * 1024 * 1024

/**
 * Deterministic staged file name of one package version: `@scope/name` becomes
 * `scope+name` (`+` cannot appear in an npm name, so the encoding is
 * collision-free) and the exact version follows, always `.tgz`.
 */
export function desktopMarketTarballStagingName(packageName: string, version: string): string {
  if (!PACKAGE_NAME_PATTERN.test(packageName) || !NPM_EXACT_VERSION_PATTERN.test(version)) {
    throw new TypeError(`${BIN_NAME}: the market tarball staging name needs an exact npm package target`)
  }
  return `${packageName.replace(/^@/u, '').replace('/', '+')}-${version}.tgz`
}

/**
 * The one and only path a controlled market tarball for this exact package
 * version may be installed from: inside the profile's staging directory, with
 * the deterministic name above. Both process boundaries — the pnpm
 * boundary's descriptor re-validation and the CLI child's hand-off gate —
 * accept no other path.
 */
export function desktopMarketTarballStagingPath(profileDir: string, packageName: string, version: string): string {
  if (typeof profileDir !== 'string' || !isAbsolute(profileDir) || profileDir.includes('\0')) {
    throw new TypeError(`${BIN_NAME}: the market tarball staging profile directory must be absolute without NUL`)
  }
  return join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, desktopMarketTarballStagingName(packageName, version))
}

/**
 * The market pipeline's controlled tarball install target (P7). This
 * descriptor is constructed in-process by the Desktop market path after the
 * signed manifest entry's `source.integrity` has been verified over the
 * downloaded bytes; it never crosses a CLI or Renderer boundary, so a user
 * argument can never produce one. The install boundary re-validates it from
 * scratch: exact descriptor shape, the descriptor's own sha512 claim, and
 * the deterministic staging path for the receipt's exact package version —
 * plus a fresh hash of the staged bytes so the file cannot change between
 * staging and install (the signature binding to the signed entry happens in
 * the install orchestration, `installCompanyMarketTarballPlugin`).
 */
export interface DesktopControlledMarketTarball {
  readonly kind: 'market-tarball'
  /** Absolute staged path; must equal {@linkcode desktopMarketTarballStagingPath} for the receipt. */
  readonly path: string
  /** sha512 integrity of the tarball bytes (`sha512-` + standard base64); the orchestration binds it to the signed entry. */
  readonly integrity: string
}

/**
 * Hash one staged tarball through a private descriptor opened without
 * following symlinks, so the bytes that are hashed are exactly the bytes the
 * opened file descriptor pins. An empty, oversized, or non-regular file
 * throws.
 */
export async function sha512OfStagedFile(path: string): Promise<Buffer> {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile()) throw new Error(`${BIN_NAME}: the staged market tarball must be a regular file`)
    if (info.size <= 0 || info.size > DESKTOP_MARKET_TARBALL_MAX_BYTES) {
      throw new Error(`${BIN_NAME}: the staged market tarball is empty or exceeds ${String(DESKTOP_MARKET_TARBALL_MAX_BYTES)} bytes`)
    }
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(path, { fd: descriptor, autoClose: false })) {
      hash.update(chunk as Buffer)
    }
    return hash.digest()
  } finally {
    closeSync(descriptor)
  }
}

/**
 * The launcher side of one market-orchestrated controlled tarball install:
 * the receipt's package and version, the signed sha512 the orchestration
 * already verified over the staged bytes, and the deterministic staged path.
 * Encoded as {@linkcode DESKTOP_COMPANY_TARBALL_HANDOFF_ENV}; every field is
 * strictly re-validated on the CLI side, so only the shape crosses the
 * process boundary, never trust.
 */
export interface CompanyTarballHandoff {
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly path: string
}

/**
 * Encode one hand-off as canonical JSON: sorted keys, no whitespace, minimal
 * string escaping — for this flat, string-only document the explicit
 * construction below is exactly the market library's `canonicalJsonText`
 * serialization. The CLI side re-parses and re-validates every field against
 * the strict patterns, so a non-canonical spelling of the same values could
 * never widen what the gate admits.
 * @param handoff - the descriptor of the controlled install being launched.
 * @returns the environment value for {@linkcode DESKTOP_COMPANY_TARBALL_HANDOFF_ENV}.
 */
export function companyTarballHandoffText(handoff: CompanyTarballHandoff): string {
  return JSON.stringify({
    integrity: handoff.integrity,
    packageName: handoff.packageName,
    path: handoff.path,
    version: handoff.version,
  })
}

/**
 * Strictly parse one hand-off environment value: length-bounded canonical
 * JSON with exactly the four expected keys, the strict catalog name and
 * plain-version grammars, a well-formed sha512, and an absolute path without
 * NUL. Anything else is undefined — callers fail closed on it.
 * @param value - raw environment value of {@linkcode DESKTOP_COMPANY_TARBALL_HANDOFF_ENV}.
 * @returns the validated hand-off, or undefined for every non-matching spelling.
 */
export function parseCompanyTarballHandoff(value: string): CompanyTarballHandoff | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > COMPANY_TARBALL_HANDOFF_MAX_BYTES) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const keys = Object.keys(parsed).sort()
  if (keys.length !== 4 || keys[0] !== 'integrity' || keys[1] !== 'packageName' || keys[2] !== 'path' || keys[3] !== 'version') {
    return undefined
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.integrity !== 'string' || !isSha512Integrity(record.integrity)) return undefined
  if (typeof record.packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(record.packageName)) return undefined
  if (typeof record.path !== 'string' || !isAbsolute(record.path) || record.path.includes('\0')) return undefined
  if (typeof record.version !== 'string' || !EXACT_VERSION_PATTERN.test(record.version)) return undefined
  return { packageName: record.packageName, version: record.version, integrity: record.integrity, path: record.path }
}

/**
 * Whether a staged file's fresh sha512 equals one pinned integrity, in
 * constant time over the digest comparison. Both process boundaries end
 * their staged-byte verification with this comparison.
 * @param digest - freshly hashed staged bytes.
 * @param integrity - the pinned `sha512-` integrity spelling.
 */
export function stagedDigestMatchesIntegrity(digest: Buffer, integrity: string): boolean {
  const expected = Buffer.from(integrity.slice('sha512-'.length), 'base64')
  return digest.byteLength === expected.byteLength && timingSafeEqual(digest, expected)
}
