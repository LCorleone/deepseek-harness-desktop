/**
 * Desktop-owned package-manager capability for the active DSH profile.
 *
 * Install targets are constructed, never passed in: the recoverable install
 * boundary builds the exact npm `name@version` spec from the receipt, and the
 * P7 dual channel adds exactly one more constructible target — the controlled
 * market tarball ({@link DesktopControlledMarketTarball}), an in-process
 * descriptor whose path is confined to the deterministic staging location and
 * whose bytes are re-hashed against the signed sha512 before pnpm runs. User
 * arguments still reach pnpm only through the audited flag list, so a
 * CLI-typed tarball path is rejected on every surface.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, createReadStream, fstatSync, openSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  DesktopInstallRecoveryStore,
} from './install-recovery.ts'
import { ensureProfilePnpmBuildApproval } from './profile-pnpm-policy.ts'
import { assertDesktopProfileName } from './profile-manager.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'

/**
 * Enterprise TLS variables forwarded to pnpm installs so corporate MITM
 * proxies work. Pilot-era decision (no IT/CA path): when the user's
 * environment already sets NODE_TLS_REJECT_UNAUTHORIZED=0, forward it to
 * the install child so Market installs behave exactly like the DSH Terminal
 * CLI path (which inherits it). This is acceptable ONLY because install
 * integrity does not rest on TLS: the signed-manifest chain pins the exact
 * sha512 (verified over the Electron main-process fetcher, which trusts the
 * Windows store) and boot verification rejects any installed tree whose
 * lockfile integrity diverges — a MITM can at worst cause a failed or
 * refused install, never load substituted code. Revisit with a real CA.
 */
const PNPM_TLS_ENVIRONMENT_KEYS = [
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'npm_config_cafile',
  'npm_config_strict_ssl',
  'NODE_TLS_REJECT_UNAUTHORIZED',
] as const

/** Collect the enterprise TLS/proxy variables present in one environment. */
function pnpmTlsEnvironmentEntries(source: NodeJS.ProcessEnv): Record<string, string> {
  const entries: Record<string, string> = {}
  const seen = new Set<string>()
  const add = (name: string): void => {
    const upper = name.toUpperCase()
    if (seen.has(upper)) return
    for (const [key, value] of Object.entries(source)) {
      if (key.toUpperCase() !== upper || value === undefined || value.length === 0) continue
      entries[key] = value
      seen.add(upper)
      return
    }
  }
  for (const name of PNPM_TLS_ENVIRONMENT_KEYS) add(name)
  // npm/pnpm also honor the lowercase spellings of the proxy variables.
  for (const name of ['http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']) add(name)
  return entries
}
const TERMINATION_GRACE_MS = 3_000
const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const NPM_EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]{86}==$/u

/**
 * Staging directory inside the active profile where the Desktop market
 * pipeline parks verified plugin tarballs before installing them. Only files
 * at the deterministic path below this directory can ever become an install
 * target (see {@link desktopMarketTarballStagingPath}).
 */
export const DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY = '.dsh-market-tarballs'
/** Upper bound of one staged market tarball; the download and install gates share it. */
export const DESKTOP_MARKET_TARBALL_MAX_BYTES = 512 * 1024 * 1024

/** Whether a value is the standard base64 SHA-512 integrity spelling the signed catalog pins. */
function isSha512Integrity(value: string): boolean {
  if (!SHA512_INTEGRITY_PATTERN.test(value)) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

/**
 * Deterministic staged file name of one package version: `@scope/name` becomes
 * `scope+name` (`+` cannot appear in an npm name, so the encoding is
 * collision-free) and the exact version follows, always `.tgz`.
 */
export function desktopMarketTarballStagingName(packageName: string, version: string): string {
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName) || !NPM_EXACT_VERSION_PATTERN.test(version)) {
    throw new TypeError(`${BIN_NAME}: the market tarball staging name needs an exact npm package target`)
  }
  return `${packageName.replace(/^@/u, '').replace('/', '+')}-${version}.tgz`
}

/**
 * The one and only path a controlled market tarball for this exact package
 * version may be installed from: inside the profile's staging directory, with
 * the deterministic name above. The install boundary accepts no other path.
 */
export function desktopMarketTarballStagingPath(profileDir: string, packageName: string, version: string): string {
  if (typeof profileDir !== 'string' || !isAbsolute(profileDir) || profileDir.includes('\0')) {
    throw new TypeError(`${BIN_NAME}: the market tarball staging profile directory must be absolute without NUL`)
  }
  return join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, desktopMarketTarballStagingName(packageName, version))
}

/**
 * One `file:` install spelling's path with its separators normalized to `/`.
 * The real pnpm records lockfile-relative spellings portably but preserves the
 * absolute specifier's native platform separators, so every consumer that
 * compares or parses a `file:` path from a profile lockfile first normalizes
 * it through this helper: the same staged path spelled with `\` or `/` is one
 * and the same pin on every platform, while nothing outside the deterministic
 * staging location becomes recognizable by the normalization.
 */
export function desktopMarketFileSpecPosixPath(path: string): string {
  return path.split('\\').join('/')
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
  /** Absolute staged path; must equal {@link desktopMarketTarballStagingPath} for the receipt. */
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
async function sha512OfStagedFile(path: string): Promise<Buffer> {
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

/** Launcher-resolved values used by the active desktop pnpm generation. */
export interface DesktopPnpmBootstrap {
  /** Profile selected for this immutable Cordis generation. */
  readonly activeProfileName: string
  /** Absolute directory containing the active profile manifest. */
  readonly activeProfileDir: string
  /** Harness home containing every managed profile. */
  readonly homeDir: string
  /** Bundled Node command that runs the packaged pnpm and DSH CLI entries. */
  readonly nodeExecutable: string
  /** Physical JavaScript entry for the packaged pnpm release. */
  readonly pnpmBinPath: string
  /** Electron version used when pnpm installs native dependencies. */
  readonly electronVersion: string
  /** Private directory containing the Node command used by pnpm lifecycle scripts. */
  readonly nodeBinDir: string
  /** Private Node command used by pnpm lifecycle scripts. */
  readonly nodeShimPath: string
  /** Desktop bootstrap that imports the packaged DSH CLI under the bundled Node. */
  readonly dshBootstrapPath: string
  /** Desktop-private install recovery WAL shared with the launcher and built-in terminal. */
  readonly installRecoveryStatePath: string
  /** Opaque identity shared by every install surface in this Electron generation. */
  readonly generationId: string
  /** Whether the selected Market provider may use the non-WAL external install boundary. */
  readonly externalMarketInstallEnabled: boolean
  /**
   * Launcher-injected policy environment hand-off for spawned desktop-cli
   * children (installs): the packaged CLI cannot read the in-archive policy
   * asset and fails closed without all four entries.
   */
  readonly cliPolicyEnvironment?: Readonly<Record<string, string>>
}

/** Exit facts for one desktop-owned package-manager operation. */
export interface DesktopPnpmOutcome {
  /** Process exit code, or `null` when a signal terminated the operation. */
  readonly exitCode: number | null
  /** Terminating signal, or `null` after a normal exit. */
  readonly signal: NodeJS.Signals | null
}

/** Streaming handle for one package-manager operation. */
export interface DesktopPnpmHandle {
  /** Standard output emitted by DSH and pnpm. */
  readonly stdout: Readable
  /** Standard error emitted by DSH and pnpm. */
  readonly stderr: Readable
  /** Settles only after the complete operation process tree has exited. */
  readonly done: Promise<DesktopPnpmOutcome>
  /** Begin termination of the complete operation process tree. */
  cancel(): void
}

/** Receipt identity tied to one recoverable plugin installation. */
export interface DesktopPluginInstallRecovery {
  readonly packageName: string
  readonly packageVersion: string
  /** Host-generated before installation so every crash window can reconcile the receipt. */
  readonly receiptId: string
}

/** Complete request for one Desktop-owned, recoverable plugin installation. */
export interface DesktopPluginInstallRequest {
  /** pnpm flags after the enforced `add` command and before the exact generated target; registry and npm-configuration flags are rejected. */
  readonly pnpmOptions?: readonly string[]
  /** Absolute caller directory used to anchor relative package specifications. */
  readonly invokingDir: string
  readonly recovery: DesktopPluginInstallRecovery
  /**
   * Signed build-script approvals of the installed plugin's catalog entry
   * (`approvedBuilds`), supplied by the market install boundary after the
   * signed allow decision. Unioned with the built-in triple inside the
   * workspace approval; absent entries approve the built-in list only.
   */
  readonly approvedBuildDependencies?: readonly string[]
  /**
   * Controlled market-pipeline tarball target (P7 dual channel). When present,
   * the install target becomes `file:<staged path>` instead of the npm
   * `name@version` spec. The descriptor is only ever constructed in-process
   * by the Desktop market path after the signed tarball integrity verified
   * over the downloaded bytes, and it is re-validated here (exact shape, exact
   * deterministic staging path for the receipt's package version, the
   * descriptor's own sha512 re-hashed over the staged file) — a user-supplied
   * path can never produce one because every user-facing argument surface
   * still audits against the npm-spec-only rules.
   */
  readonly marketTarball?: DesktopControlledMarketTarball
  readonly signal?: AbortSignal
}

/** Public package-operation interface for one immutable Desktop profile generation. */
export interface DesktopPnpm {
  run(args: readonly string[], signal?: AbortSignal): DesktopPnpmHandle
  runPlugin(args: readonly string[], invokingDir: string, signal?: AbortSignal): DesktopPnpmHandle  /**
   * Run the dsh-market add operation without its per-install WAL.
   * The launcher enables this boundary only for the selected dsh-market provider.
   */
  runExternalMarketPluginInstall(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandle
  /** @deprecated Use `installPlugin()` so Desktop constructs the exact package target. */
  runPluginInstall(
    args: readonly string[],
    invokingDir: string,
    recovery: DesktopPluginInstallRecovery,
    signal?: AbortSignal,
  ): Promise<DesktopPnpmHandle>
  installPlugin(request: DesktopPluginInstallRequest): Promise<DesktopPnpmHandle>
  recoveredInstallReceiptIds(): Promise<readonly string[]>
  acknowledgeRecoveredInstall(receiptId: string): Promise<void>
  rollbackPluginInstall(receiptId: string): Promise<boolean>
}

/**
 * Host-injected diversion of market install requests whose signed company
 * catalog entry is published on the tarball channel (P7 2c). The pnpm
 * boundary stays package-manager-generic: it hands one install request that
 * carries no controlled tarball descriptor to the channel before opening any
 * recovery transaction, and the channel either takes the request over —
 * downloading, staging, and installing through {@link installPlugin} with a
 * `marketTarball` descriptor, i.e. the one constructible controlled target —
 * or returns undefined and the registry path runs unchanged. The channel is
 * constructed in-process by the Desktop market path (`main.ts` provides the
 * `desktopCompanyMarketTarballInstall` capability); a user argument can
 * never reach it because every user-facing argument surface still audits
 * against the npm-spec-only rules.
 */
export interface DesktopPnpmCompanyMarketChannel {
  /**
   * Take over one install whose verified signed entry is a tarball entry, or
   * return undefined to keep the registry path. The returned handle follows
   * the {@link DesktopPnpmHandle} contract; failures surface as a settled
   * nonzero outcome with the readable reason on the handle's stderr.
   */
  divertCompanyTarballInstall(
    request: DesktopPluginInstallRequest,
    service: DesktopPnpm,
  ): Promise<DesktopPnpmHandle | undefined>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-private inputs from which the Host provider constructs the service. */
    desktopPnpmBootstrap: DesktopPnpmBootstrap
    /** Package-manager operations scoped to the active desktop profile generation. */
    desktopPnpm: DesktopPnpm
  }
}

interface ActiveOperation {
  child: SubprocessHandle
  done: Promise<DesktopPnpmOutcome>
  recoveryTransactionId?: string
}

/** Read PATH with Windows-compatible environment-name matching. */
function inheritedPath(): string {
  const exact = process.env.PATH
  if (exact !== undefined || process.platform !== 'win32') return exact ?? ''
  return Object.entries(process.env)
    .find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

/** Reject an unsafe or unresolved bootstrap path. */
function assertAbsolutePath(label: string, value: string): void {
  if (value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`${BIN_NAME}: desktop pnpm ${label} must be an absolute path without NUL`)
  }
}

/** Validate one argv list before it crosses the process boundary. */
function validatedArgs(args: readonly string[]): string[] {
  if (args.length === 0) {
    throw new Error(`${BIN_NAME}: desktop pnpm arguments must not be empty`)
  }
  if (args.some(argument => argument.includes('\0'))) {
    throw new Error(`${BIN_NAME}: desktop pnpm arguments must not contain NUL`)
  }
  return [...args]
}

/** Canonical npm registry URL the desktop install path pins; only its exact value passes the audit. */
const PINNED_NPM_REGISTRY = 'https://registry.npmjs.org/'

/** Single rejection message for every install option outside the allow-list. */
const REJECTED_INSTALL_OPTION_MESSAGE = `${BIN_NAME}: desktop pnpm install options are restricted to --save-exact, --reporter=ndjson, and registry flags pinned to ${PINNED_NPM_REGISTRY}`

function rejectedInstallOption(): Error {
  return new Error(REJECTED_INSTALL_OPTION_MESSAGE)
}

/**
 * Audit caller-supplied install options with an allow-list. Positional items
 * are rejected so no second install target can ride along, and every flag not
 * listed here is rejected: directory and workspace flags such as -C, --dir,
 * --prefix, or --filter would let pnpm resolve a different project-level
 * .npmrc, and configuration flags would redirect the registry. Registry flags
 * pass only in the `=` form with the exact pinned value; separated values
 * stay rejected because the bare flag and its value each fail the list.
 */
function auditInstallOptions(options: readonly string[]): void {
  for (const option of options) {
    if (option === '--save-exact' || option === '--reporter=ndjson') continue
    if (!option.startsWith('--')) throw rejectedInstallOption()
    const equals = option.indexOf('=')
    const name = equals === -1 ? option.slice(2) : option.slice(2, equals)
    const value = equals === -1 ? undefined : option.slice(equals + 1)
    const isRegistryFlag = name === 'registry' || name.endsWith(':registry')
    if (!isRegistryFlag || value !== PINNED_NPM_REGISTRY) throw rejectedInstallOption()
  }
}

/** Validate the narrow dsh-market command shape before it crosses the process boundary. */
function validateExternalMarketInstallArgs(args: readonly string[]): string[] {
  const resolvedArgs = validatedArgs(args)
  if (resolvedArgs[0] !== 'add' || resolvedArgs.length < 2) {
    throw new Error(`${BIN_NAME}: external Market plugin install requires add with one exact npm package target`)
  }
  const targets = resolvedArgs.slice(1).filter(argument => !argument.startsWith('-'))
  const target = targets[0]
  if (targets.length !== 1 || target === undefined) {
    throw new Error(`${BIN_NAME}: external Market plugin install accepts exactly one npm package target and flag options`)
  }
  const at = target.lastIndexOf('@')
  const packageName = at > 0 ? target.slice(0, at) : ''
  const packageVersion = at > 0 ? target.slice(at + 1) : ''
  if (
    !NPM_PACKAGE_NAME_PATTERN.test(packageName)
    || !NPM_EXACT_VERSION_PATTERN.test(packageVersion)
  ) {
    throw new Error(`${BIN_NAME}: external Market plugin install requires an exact npm package target`)
  }
  return resolvedArgs
}

/** Validate the immutable launcher values once, before the service is published. */
function validateBootstrap(bootstrap: DesktopPnpmBootstrap): void {
  assertDesktopProfileName(bootstrap.activeProfileName)
  if (typeof bootstrap.externalMarketInstallEnabled !== 'boolean') {
    throw new Error(`${BIN_NAME}: external Market install capability must be a boolean`)
  }
  for (const [label, value] of [
    ['active profile directory', bootstrap.activeProfileDir],
    ['Harness home', bootstrap.homeDir],
    ['bundled Node command', bootstrap.nodeExecutable],
    ['pnpm entry', bootstrap.pnpmBinPath],
    ['Node command directory', bootstrap.nodeBinDir],
    ['lifecycle Node command', bootstrap.nodeShimPath],
    ['DSH bootstrap', bootstrap.dshBootstrapPath],
    ['install recovery state', bootstrap.installRecoveryStatePath],
  ] as const) assertAbsolutePath(label, value)
  if (bootstrap.electronVersion.length === 0 || bootstrap.electronVersion.includes('\0')) {
    throw new Error(`${BIN_NAME}: desktop pnpm Electron version must not be empty or contain NUL`)
  }
  if (bootstrap.generationId.length < 8 || bootstrap.generationId.includes('\0')) {
    throw new Error(`${BIN_NAME}: desktop pnpm generation id is invalid`)
  }
}

/** Cordis adapter implementing the public Desktop package-operation interface. */
class DesktopPnpmService extends Service implements DesktopPnpm {
  private active: ActiveOperation | undefined
  private installPreparationActive = false
  private closed = false
  private readonly installRecovery: DesktopInstallRecoveryStore

  /**
   * Register the service for one immutable desktop profile generation.
   * @param ctx - Host context providing the managed subprocess capability.
   * @param bootstrap - launcher-resolved profile and packaged runtime paths.
   * @param companyMarketChannel - optional Host-injected tarball-channel
   * diversion for signed catalog entries (see {@link DesktopPnpmCompanyMarketChannel});
   * absent in standalone compositions and focused tests.
   */
  constructor(
    ctx: Context,
    private readonly bootstrap: DesktopPnpmBootstrap,
    private readonly companyMarketChannel?: DesktopPnpmCompanyMarketChannel,
  ) {
    validateBootstrap(bootstrap)
    super(ctx, 'desktopPnpm')
    this.installRecovery = new DesktopInstallRecoveryStore({
      statePath: bootstrap.installRecoveryStatePath,
      profileName: bootstrap.activeProfileName,
      profileDir: bootstrap.activeProfileDir,
      generationId: bootstrap.generationId,
    })
    ctx.effect(
      () => async () => {
        this.closed = true
        const active = this.active
        if (active === undefined) return
        active.child.terminate()
        await active.done.catch(() => {})
      },
      'dsh-plugin-desktop: active pnpm operation teardown',
    )
  }

  /**
   * Run packaged pnpm directly in the active profile.
   * @param args - pnpm arguments following the executable name.
   * @param signal - optional cancellation for this operation.
   * @returns live output streams, completion, and cancellation.
   */
  run(args: readonly string[], signal?: AbortSignal): DesktopPnpmHandle {
    const resolvedArgs = validatedArgs(args)
    return this.start({
      argv: [
        this.bootstrap.nodeExecutable,
        this.bootstrap.pnpmBinPath,
        ...resolvedArgs,
      ],
      cwd: this.bootstrap.activeProfileDir,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /**
   * Run the packaged `dsh plugin` command so upstream profile reconciliation remains authoritative.
   * @param args - pnpm arguments forwarded by `dsh plugin`.
   * @param invokingDir - absolute caller directory used to anchor relative package specifications.
   * @param signal - optional cancellation for this operation.
   * @returns live output streams, completion, and cancellation.
   */
  runPlugin(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandle {
    const resolvedArgs = validatedArgs(args)
    if (resolvedArgs[0] === 'add') {
      if (this.bootstrap.externalMarketInstallEnabled) {
        return this.runExternalMarketPluginInstall(resolvedArgs, invokingDir, signal)
      }
      throw new Error(`${BIN_NAME}: plugin add must use the recoverable install boundary`)
    }
    assertAbsolutePath('plugin invoking directory', invokingDir)
    // pnpm 11 fails a plugin operation whose dependency build scripts are
    // not pre-approved in the profile workspace, so start from an approved
    // one; without this an ordinary add (e.g. node-pty for the terminal
    // panel) derails on pnpm's build firewall instead of installing.
    ensureProfilePnpmBuildApproval(this.bootstrap.activeProfileDir)
    return this.start({
      argv: [
        this.bootstrap.nodeExecutable,
        '--expose-internals',
        this.bootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        this.bootstrap.activeProfileName,
        ...resolvedArgs,
      ],
      cwd: invokingDir,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /** Run one dsh-market install without creating a per-install recovery WAL. */
  runExternalMarketPluginInstall(
    args: readonly string[],
    invokingDir: string,
    signal?: AbortSignal,
  ): DesktopPnpmHandle {
    if (!this.bootstrap.externalMarketInstallEnabled) {
      throw new Error(`${BIN_NAME}: external Market plugin install is unavailable for the selected Market provider`)
    }
    const resolvedArgs = validateExternalMarketInstallArgs(args)
    assertAbsolutePath('plugin invoking directory', invokingDir)
    ensureProfilePnpmBuildApproval(this.bootstrap.activeProfileDir)
    return this.start({
      argv: [
        this.bootstrap.nodeExecutable,
        '--expose-internals',
        this.bootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        this.bootstrap.activeProfileName,
        ...resolvedArgs,
      ],
      cwd: invokingDir,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /** Preserve the v2.0.1 install surface without allowing callers to choose another target. */
  async runPluginInstall(
    args: readonly string[],
    invokingDir: string,
    recovery: DesktopPluginInstallRecovery,
    signal?: AbortSignal,
  ): Promise<DesktopPnpmHandle> {
    const resolvedArgs = validatedArgs(args)
    const expectedTarget = `${recovery.packageName}@${recovery.packageVersion}`
    if (
      resolvedArgs[0] !== 'add'
      || resolvedArgs.at(-1) !== expectedTarget
      || resolvedArgs.slice(1, -1).some(argument => !argument.startsWith('-'))
    ) {
      throw new Error(`${BIN_NAME}: recoverable plugin install requires the exact receipt target`)
    }
    return await this.installPlugin({
      pnpmOptions: resolvedArgs.slice(1, -1),
      invokingDir,
      recovery,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /**
   * Re-validate one controlled market tarball against the receipt before any
   * recovery transaction is opened. This boundary enforces two properties of
   * the descriptor itself — it is deliberately NOT a signature check:
   *
   * - **path confinement:** the descriptor's path must be the deterministic
   *   staging path for the receipt's exact package version inside the active
   *   profile, so no other file can become a `file:` install target; and
   * - **self-integrity:** the descriptor's integrity must be a well-formed
   *   sha512, and a fresh hash of the staged bytes must equal it, so the file
   *   cannot change between staging and install (it sits in user-writable
   *   storage).
   *
   * The integrity compared here is the descriptor's own value, not a signed
   * one: binding it to the signed manifest entry is the orchestration
   * layer's job — `installCompanyMarketTarballPlugin` refuses a descriptor
   * whose integrity diverges from the signed `entry.integrity`, and
   * `stageCompanyMarketTarball` (its only production constructor) stamps the
   * signed `source.integrity` into the descriptor. The composition test in
   * `company-market-tarball.spec.ts` locks that arrangement down.
   */
  private async assertControlledMarketTarball(
    tarball: DesktopControlledMarketTarball,
    recovery: DesktopPluginInstallRecovery,
  ): Promise<void> {
    if (tarball === null || typeof tarball !== 'object' || Array.isArray(tarball)) {
      throw new Error(`${BIN_NAME}: a controlled market tarball must be a descriptor object, never a path argument`)
    }
    const keys = Object.keys(tarball).sort()
    if (keys.length !== 3 || keys[0] !== 'integrity' || keys[1] !== 'kind' || keys[2] !== 'path') {
      throw new Error(`${BIN_NAME}: the controlled market tarball descriptor must carry exactly kind, path, and integrity`)
    }
    if (tarball.kind !== 'market-tarball' || typeof tarball.path !== 'string' || typeof tarball.integrity !== 'string') {
      throw new Error(`${BIN_NAME}: the controlled market tarball descriptor is invalid`)
    }
    if (!isSha512Integrity(tarball.integrity)) {
      throw new Error(`${BIN_NAME}: the controlled market tarball integrity must be a well-formed sha512 (sha512- plus standard base64) — its binding to the signed entry is checked by the install orchestration`)
    }
    const expectedPath = desktopMarketTarballStagingPath(
      this.bootstrap.activeProfileDir,
      recovery.packageName,
      recovery.packageVersion,
    )
    if (tarball.path !== expectedPath) {
      throw new Error(`${BIN_NAME}: a controlled market tarball may only install from the staged path ${expectedPath}`)
    }
    let digest: Buffer
    try {
      digest = await sha512OfStagedFile(tarball.path)
    } catch (cause) {
      throw new Error(`${BIN_NAME}: the staged market tarball ${tarball.path} is unusable: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const expected = Buffer.from(tarball.integrity.slice('sha512-'.length), 'base64')
    if (digest.byteLength !== expected.byteLength || !timingSafeEqual(digest, expected)) {
      throw new Error(`${BIN_NAME}: the staged market tarball ${tarball.path} does not match its pinned integrity — refusing the install`)
    }
  }

  /**
   * Snapshot the active profile before running one `dsh plugin add` operation.
   * The returned handle seals the post-install image before `done` resolves.
   */
  async installPlugin(request: DesktopPluginInstallRequest): Promise<DesktopPnpmHandle> {
    const resolvedOptions = request.pnpmOptions === undefined ? [] : [...request.pnpmOptions]
    if (resolvedOptions.some(argument => argument.includes('\0'))) {
      throw new Error(`${BIN_NAME}: desktop pnpm arguments must not contain NUL`)
    }
    auditInstallOptions(resolvedOptions)
    assertAbsolutePath('plugin invoking directory', request.invokingDir)
    // Tarball-channel diversion (P7 2c): a request without a controlled
    // tarball descriptor whose signed catalog entry is published as a
    // tarball is handed to the Host channel before the workspace approval
    // is widened or any recovery transaction is opened — the channel runs
    // the controlled pipeline (stage → install through the one
    // constructible `marketTarball` target → installed-bundle and signed
    // tree re-verification → rollback on divergence) and settles its own
    // handle. Every other request keeps the registry path below unchanged;
    // a request that already carries a descriptor (the channel's own
    // callback) always passes through.
    if (request.marketTarball === undefined && this.companyMarketChannel !== undefined) {
      const diverted = await this.companyMarketChannel.divertCompanyTarballInstall(request, this)
      if (diverted !== undefined) return diverted
    }
    // The controlled tarball target is validated before the workspace
    // approval is widened or any recovery transaction is opened, so a bad
    // descriptor leaves the profile untouched.
    if (request.marketTarball !== undefined) {
      await this.assertControlledMarketTarball(request.marketTarball, request.recovery)
    }
    const installTarget = request.marketTarball === undefined
      ? `${request.recovery.packageName}@${request.recovery.packageVersion}`
      : `file:${request.marketTarball.path}`
    // Approve the trusted builds before the recovery WAL snapshots the
    // profile, so a later rollback restores a workspace that still carries
    // the approval instead of stripping it from under the next install. The
    // signed entry's approvedBuilds (when the market supplied one) widen the
    // built-in triple for exactly this install's dependency tree.
    ensureProfilePnpmBuildApproval(
      this.bootstrap.activeProfileDir,
      request.approvedBuildDependencies === undefined
        ? {}
        : { approvedBuildDependencies: request.approvedBuildDependencies },
    )
    if (this.closed) throw new Error(`${BIN_NAME}: desktop pnpm generation is closed`)
    if (this.active !== undefined || this.installPreparationActive) {
      throw new Error(`${BIN_NAME}: another desktop pnpm operation is already running`)
    }
    request.signal?.throwIfAborted()
    this.installPreparationActive = true
    let transaction: Awaited<ReturnType<DesktopInstallRecoveryStore['begin']>> | undefined
    try {
      transaction = await this.installRecovery.begin(request.recovery)
      const handle = this.start({
        argv: [
          this.bootstrap.nodeExecutable,
          '--expose-internals',
          this.bootstrap.dshBootstrapPath,
          'plugin',
          '--profile',
          this.bootstrap.activeProfileName,
          'add',
          ...resolvedOptions,
          installTarget,
        ],
        cwd: request.invokingDir,
        recoveryTransactionId: transaction.transactionId,
        allowInstallPreparation: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      this.installPreparationActive = false
      return handle
    } catch (cause) {
      try {
        if (transaction !== undefined) await this.rollbackUnstartedInstall(transaction.transactionId)
      } finally {
        this.installPreparationActive = false
      }
      throw cause
    }
  }

  /** Return the exact rolled-back receipt id, if startup recovery still awaits Market cleanup. */
  async recoveredInstallReceiptIds(): Promise<readonly string[]> {
    const state = await this.installRecovery.read()
    return state?.phase === 'rolled-back' ? [state.receiptId] : []
  }

  /** Clear a rolled-back transaction only after its exact Market receipt has been removed. */
  async acknowledgeRecoveredInstall(receiptId: string): Promise<void> {
    const state = await this.installRecovery.read()
    if (state?.phase !== 'rolled-back' || state.receiptId !== receiptId) return
    await this.installRecovery.clear(state.transactionId)
  }

  /** Restore and clear the exact current-generation install when later Host validation fails. */
  async rollbackPluginInstall(receiptId: string): Promise<boolean> {
    const state = await this.installRecovery.read()
    if (state === undefined || state.receiptId !== receiptId) return false
    if (state.createdByGeneration !== this.bootstrap.generationId) {
      throw new Error(`${BIN_NAME}: plugin install recovery belongs to another generation`)
    }
    if (state.phase === 'rolled-back') {
      await this.installRecovery.clear(state.transactionId)
      return true
    }
    if (state.phase !== 'prepared' && state.phase !== 'awaiting-restart') {
      throw new Error(`${BIN_NAME}: plugin install recovery cannot roll back phase ${state.phase}`)
    }
    const result = await this.installRecovery.restoreCurrentInstall(state.transactionId, 'install-failed')
    if (result.status === 'manual-recovery-required') {
      throw new Error(`${BIN_NAME}: plugin install recovery requires manual repair`)
    }
    await this.installRecovery.clear(state.transactionId)
    return true
  }

  /** Start one managed child after applying the generation-wide gate. */
  private start(command: {
    argv: readonly string[]
    cwd: string
    signal?: AbortSignal
    recoveryTransactionId?: string
    allowInstallPreparation?: boolean
  }): DesktopPnpmHandle {
    if (this.closed) {
      throw new Error(`${BIN_NAME}: desktop pnpm generation is closed`)
    }
    if (this.active !== undefined || (this.installPreparationActive && command.allowInstallPreparation !== true)) {
      throw new Error(`${BIN_NAME}: another desktop pnpm operation is already running`)
    }
    command.signal?.throwIfAborted()
    const path = inheritedPath()
    const spec: SubprocessSpawnSpec = {
      argv: command.argv,
      cwd: command.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: TERMINATION_GRACE_MS,
      ...(command.signal === undefined ? {} : { signal: command.signal }),
      env: {
        PATH: path.length === 0
          ? this.bootstrap.nodeBinDir
          : `${this.bootstrap.nodeBinDir}${delimiter}${path}`,
        NODE: this.bootstrap.nodeShimPath,
        DSH_HOME: this.bootstrap.homeDir,
        CI: 'true',
        npm_config_runtime: 'electron',
        npm_config_target: this.bootstrap.electronVersion,
        npm_config_disturl: ELECTRON_HEADERS_URL,
        ...pnpmTlsEnvironmentEntries(process.env),
        ...(this.bootstrap.cliPolicyEnvironment ?? {}),
      },
    }
    const child = this.ctx.subprocess.spawn(spec)
    if (child.stdout === undefined || child.stderr === undefined) {
      child.terminate()
      throw new Error(`${BIN_NAME}: desktop pnpm subprocess did not expose piped output`)
    }
    const active: ActiveOperation = {
      child,
      done: Promise.resolve({ exitCode: null, signal: null }),
      ...(command.recoveryTransactionId === undefined
        ? {}
        : { recoveryTransactionId: command.recoveryTransactionId }),
    }
    active.done = this.settle(active)
    this.active = active
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      done: active.done,
      cancel: () => { child.terminate() },
    }
  }

  /** Keep the operation gate held until the complete process tree is gone. */
  private async settle(active: ActiveOperation): Promise<DesktopPnpmOutcome> {
    let outcome: SubprocessOutcome | undefined
    try {
      outcome = await active.child.done
      return { exitCode: outcome.exitCode, signal: outcome.signal }
    } finally {
      try {
        await active.child.waitForExit()
        if (active.recoveryTransactionId !== undefined) {
          if (outcome?.exitCode === 0 && outcome.signal === null) {
            await this.installRecovery.seal(active.recoveryTransactionId)
          } else {
            await this.rollbackUnstartedInstall(active.recoveryTransactionId)
          }
        }
      } finally {
        if (this.active === active) this.active = undefined
      }
    }
  }

  private async rollbackUnstartedInstall(transactionId: string): Promise<void> {
    const result = await this.installRecovery.restoreCurrentInstall(transactionId, 'install-failed')
    if (result.status !== 'manual-recovery-required') {
      await this.installRecovery.clear(transactionId)
    }
  }
}

/** Stable Cordis provider name. */
export const name = 'desktop-pnpm'

/** Launcher bootstrap and subprocess service required by this Host provider. */
export const inject = ['desktopPnpmBootstrap', 'subprocess']

/**
 * Provide the active generation's desktop package-manager capability.
 * @param ctx - Host context carrying launcher bootstrap values and subprocess ownership.
 */
export function apply(ctx: Context): void {
  new DesktopPnpmService(
    ctx,
    ctx.desktopPnpmBootstrap,
    // Host-injected tarball-channel diversion (P7 2c, main.ts). Absent in
    // standalone compositions; `undefined` there keeps the service generic.
    ctx.get('desktopCompanyMarketTarballInstall') as DesktopPnpmCompanyMarketChannel | undefined,
  )
}
