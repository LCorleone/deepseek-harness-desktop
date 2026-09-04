/** Private bootstrap for the packaged DeepSeek Harness CLI under the bundled Node. */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import {
  DESKTOP_INSTALL_RECOVERY_STATE_ENV,
  DesktopInstallRecoveryStore,
  desktopInstallRecoveryStatePath,
} from './install-recovery.ts'
import { authorizeLockedPluginAdd, SAVE_EXACT_FLAG } from './cli-install-channel.ts'
import { companyManifestFileRequest, DESKTOP_COMPANY_MANIFEST_FILE_ENV } from './company-manifest-origin.ts'
import {
  DESKTOP_COMPANY_TARBALL_HANDOFF_ENV,
  parseCompanyTarballHandoff,
} from './company-tarball-handoff.ts'
import { desktopPolicyFromEnvironment, DESKTOP_POLICY_ENVIRONMENT, readDesktopPolicy } from './desktop-policy.ts'
import { isPackagedApplicationPath, packagedDependencyPath, unpackedAsarPath } from './packaged-runtime-path.ts'
import { ensureProfilePnpmBuildApproval } from './profile-pnpm-policy.ts'
import { assertDesktopProfileName } from './profile-manager.ts'
import type { DesktopPolicy } from './desktop-policy.ts'

const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_HOME = 'DSH_HOME'
const DSH_ENTRY_URL = pathToFileURL(
  packagedDependencyPath(import.meta.url, '@deepseek-ai/dsh/lib/bin.js'),
).href

/**
 * Environment names of the locked CLI clamp: the upstream override the clamp
 * deletes and the process-local variable that feeds the clamp overlay's
 * company preset-root expression (set by this bootstrap, never persisted in
 * a shim).
 */
export const DESKTOP_CLI_CLAMP_ENVIRONMENT = Object.freeze({
  permissionMode: 'DSH_PERMISSION_MODE',
  presetRoot: 'DSH_DESKTOP_LOCK_PRESET_ROOT',
})

/** First argv tokens that print and exit without booting any composition. */
const NON_BOOTING_FIRST_ARGUMENTS: ReadonlySet<string> = new Set(['--help', '-h', '--version', '-V'])

/**
 * Apply the terminal-owned default without overriding global help or an explicit profile.
 * @param argv - arguments after the executable and bootstrap entry.
 * @param profileName - validated profile selected by the desktop launcher.
 * @returns argv accepted by the upstream DSH command parser.
 */
export function withDefaultDesktopProfile(argv: readonly string[], profileName: string): string[] {
  assertDesktopProfileName(profileName)
  if (argv.some(argument => argument === '--profile' || argument.startsWith('--profile='))) {
    return [...argv]
  }
  const first = argv[0]
  if (first === 'web' || first === '--help' || first === '-h' || first === '--version' || first === '-V') {
    return [...argv]
  }
  if (first === 'plugin') {
    return ['plugin', '--profile', profileName, ...argv.slice(1)]
  }
  return ['--profile', profileName, ...argv]
}

/** Resolve the shipped CLI clamp overlay beside this module (src and lib layouts match). */
export function desktopCliLockOverlayPath(moduleUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(new URL(moduleUrl))), 'cli-lock', 'desktop-cli-lock.patch.yml')
}

/**
 * Resolve the packaged company agent-preset directory for the clamp overlay.
 *
 * Same layout contract and same primitives as `companyPresetRoot` in
 * src/profile.ts (a module one level below the package root, mapped to the
 * physical `app.asar.unpacked` tree when packaged): the CLI child must name
 * the exact directory the locked GUI composes, and importing the whole
 * profile module into this bootstrap would drag the desktop composition
 * graph into every plugin-add child. tests/desktop-cli.spec.ts pins the two
 * resolutions equal so the layouts cannot drift.
 * @param moduleUrl - URL of a module emitted one level below the package root.
 * @returns the physical company preset root of the locked roster.
 */
export function desktopCliCompanyPresetRoot(moduleUrl: string = import.meta.url): string {
  return unpackedAsarPath(fileURLToPath(new URL('../agent-presets', moduleUrl)))
}

/** Delete every case-insensitive spelling of one environment variable. */
function removeEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === name) delete environment[key]
  }
}

/** Peek (without consuming) the locked flag of the launcher policy hand-off. */
function environmentHandoffLocked(environment: NodeJS.ProcessEnv): boolean | undefined {
  let value: string | undefined
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === DESKTOP_POLICY_ENVIRONMENT.locked) value ??= environment[key]
  }
  return value === undefined ? undefined : value !== '0'
}

/**
 * Decide whether this CLI child must run under the locked clamp.
 *
 * Three signals, in trust order:
 *
 * - an injected `policy` (tests and embedders) decides outright;
 * - the launcher's six-key environment hand-off, peeked case-insensitively
 *   and never consumed here (the plugin-add branch below still owns the
 *   hand-off lifecycle through `desktopPolicyFromEnvironment`): `0` is a
 *   trusted unlocked launcher, anything else — including malformed values —
 *   clamps (fail closed);
 * - no hand-off at all in a packaged layout (`app.asar` beside this module)
 *   also clamps: a hand-run `desktop-cli.js` without the launcher's
 *   environment is treated as locked rather than trusted. Only an unpackaged
 *   development checkout stays clamp-free, keeping the dev CLI shape
 *   byte-identical with today's.
 *
 * @param environment - process environment inherited from the shim or shell.
 * @param policy - explicitly injected policy, when a caller owns the decision.
 * @param moduleUrl - URL of the module deciding the packaged-layout check.
 * @returns whether the locked clamp applies to this child.
 */
export function desktopCliClampLocked(
  environment: NodeJS.ProcessEnv,
  policy: DesktopPolicy | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (policy !== undefined) return policy.locked
  const handoff = environmentHandoffLocked(environment)
  if (handoff !== undefined) return handoff
  return isPackagedApplicationPath(fileURLToPath(new URL(moduleUrl)))
}

/** Whether one first CLI argument boots a composition the clamp must shape. */
function lockedClampApplies(first: string | undefined): boolean {
  return first !== 'plugin' && (first === undefined || !NON_BOOTING_FIRST_ARGUMENTS.has(first))
}

/**
 * Prepend the locked clamp overlay to one boot-shaped argv window.
 *
 * Branching mirrors {@link withDefaultDesktopProfile}'s command forms:
 *
 * - `plugin` subcommands take none of the parent `--patch` (upstream args.ts
 *   rejects it), and the plugin-add branch keeps its own policy authorization
 *   path — no overlay is injected there;
 * - `--help`/`--version` print and exit without booting, so they stay
 *   untouched (the e2e `--version` sentinel rides this);
 * - `web` owns a `--patch` flag on its subcommand parser, so the overlay
 *   follows the `web` token;
 * - every other first token (including none) is the default boot form, where
 *   the overlay leads the launcher flags.
 *
 * A user-typed `--patch` still stacks after the clamp overlay in argv order —
 * the same user-writable permission the home layer already grants, and part
 * of the clamp's documented soft-barrier boundary. `--dump-default-config`
 * deliberately refuses to run with any `--patch`, so under the clamp it
 * errors instead of printing an unclamped tree: fail-closed by upstream
 * design, not a silent skip that could misdetect app arguments.
 * @param argv - arguments after the executable and bootstrap entry.
 * @param overlayPath - shipped clamp overlay resolved by {@link desktopCliLockOverlayPath}.
 * @returns argv with the clamp overlay prepended for boot forms, verbatim otherwise.
 */
export function withLockedClampOverlay(argv: readonly string[], overlayPath: string): string[] {
  if (!lockedClampApplies(argv[0])) return [...argv]
  return argv[0] === 'web'
    ? ['web', '--patch', overlayPath, ...argv.slice(1)]
    : ['--patch', overlayPath, ...argv]
}

/** Remove and return the case-insensitive terminal default-profile marker. */
function takeDefaultProfile(environment: NodeJS.ProcessEnv): string | undefined {
  let profileName: string | undefined
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() !== DEFAULT_PROFILE) continue
    const value = environment[key]
    if (value !== undefined && profileName !== undefined && value !== profileName) {
      throw new Error('dsh-desktop: conflicting default profile environment values')
    }
    profileName ??= value
    delete environment[key]
  }
  return profileName
}

/** Remove and return one case-insensitive Desktop-owned environment hand-off. */
function takeEnvironmentValue(environment: NodeJS.ProcessEnv, expectedName: string): string | undefined {
  let result: string | undefined
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() !== expectedName) continue
    const value = environment[key]
    if (value !== undefined && result !== undefined && value !== result) {
      throw new Error(`dsh-desktop: conflicting ${expectedName} environment values`)
    }
    result ??= value
    delete environment[key]
  }
  return result
}

/** The profile and package arguments of one built-in-terminal plugin-add command. */
interface PluginAddCommand {
  readonly profileName: string
  readonly packageSpecs: readonly string[]
  /** Index of the `add` command inside the scanned `argv.slice(2)` window. */
  readonly addIndex: number
}

/** Resolve the exact profile and package targets mutated by one built-in-terminal plugin-add command. */
function pluginAddCommand(argv: readonly string[]): PluginAddCommand | undefined {
  if (argv[0] !== 'plugin') return undefined
  const forwarded: string[] = []
  let profileName: string | undefined
  let addIndex: number | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--profile') {
      const value = argv[index + 1]
      if (value === undefined) return undefined
      if (profileName !== undefined && profileName !== value) {
        throw new Error('dsh-desktop: conflicting plugin profile arguments')
      }
      profileName = value
      index += 1
      continue
    }
    if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length)
      if (profileName !== undefined && profileName !== value) {
        throw new Error('dsh-desktop: conflicting plugin profile arguments')
      }
      profileName = value
      continue
    }
    forwarded.push(argument)
    addIndex ??= index
  }
  if (forwarded[0] !== 'add' || profileName === undefined) return undefined
  assertDesktopProfileName(profileName)
  return { profileName, packageSpecs: forwarded.slice(1), addIndex: addIndex! }
}

/** Width in argv tokens of a launcher-owned profile flag, or 0 for any other token. */
function profileFlagLength(argument: string, hasNext: boolean): number {
  if (argument === '--profile') return hasNext ? 2 : 0
  return argument.startsWith('--profile=') ? 1 : 0
}

/**
 * Keep an allowed locked plugin add exact in the profile lockfile: pnpm's
 * default caret save-prefix would write `^<version>`, which boot
 * verification rejects as a non-exact specifier. The flag is injected before
 * the first package argument (profile flags may legally sit between `add`
 * and it), so the package spec stays the positional argument; a user-typed
 * copy in the same slot wins and is never duplicated.
 */
function injectSaveExactFlag(argv: string[], addIndex: number): void {
  let index = addIndex + 1
  while (index < argv.length) {
    const width = profileFlagLength(argv[index]!, index + 1 < argv.length)
    if (width === 0) break
    index += width
  }
  if (argv[index] === SAVE_EXACT_FLAG) return
  argv.splice(index, 0, SAVE_EXACT_FLAG)
}

/** Highest market receipt manifest sequence in the shared settings document, or undefined without receipts. */
async function lockedPluginAddSequenceFloor(homeDir: string | undefined): Promise<number | undefined> {
  if (homeDir === undefined) return undefined
  // Lazy like the channel's market import: ordinary CLI startups stay free of
  // the market bundle that boot-verification transitively pulls in.
  const { readDesktopBootReceiptsFromSettings } = await import('./boot-verification.ts')
  let highest: number | undefined
  for (const receipt of readDesktopBootReceiptsFromSettings(join(homeDir, 'settings.yaml'))) {
    if (highest === undefined || receipt.manifestSequence > highest) highest = receipt.manifestSequence
  }
  return highest
}

class CapturedDesktopCliExit {
  constructor(readonly code: number) {}
}

/** Fallback banner printed whenever a failed terminal plugin add is rolled back. */
const INSTALL_RESTORED_NOTICE = 'dsh-desktop: the plugin install failed and the profile was restored to its previous state; the package manager error above explains why\n'

/** Run one built-in-terminal add inside the same durable recovery boundary as Market installs. */
async function loadWithInstallRecovery(
  load: (url: string) => Promise<unknown>,
  store: DesktopInstallRecoveryStore,
): Promise<void> {
  const transaction = await store.begin({
    packageName: 'manual-plugin-install',
    packageVersion: 'unresolved',
    receiptId: `manual:${randomUUID()}`,
  })
  const originalExit = process.exit
  let capturedExitCode: number | undefined
  let failure: unknown
  process.exit = ((code?: string | number | null): never => {
    const normalized = typeof code === 'number'
      ? code
      : code === undefined || code === null
        ? process.exitCode ?? 0
        : Number(code)
    throw new CapturedDesktopCliExit(
      typeof normalized === 'number' && Number.isSafeInteger(normalized) ? normalized : 1,
    )
  }) as typeof process.exit
  try {
    await load(DSH_ENTRY_URL)
  } catch (cause) {
    if (cause instanceof CapturedDesktopCliExit) capturedExitCode = cause.code
    else failure = cause
  } finally {
    process.exit = originalExit
  }

  const effectiveExitCode = capturedExitCode ?? process.exitCode
  const commandSucceeded = failure === undefined && (effectiveExitCode === undefined || effectiveExitCode === 0)
  if (commandSucceeded) {
    try {
      await store.seal(transaction.transactionId)
    } catch (cause) {
      const restored = await store.restoreCurrentInstall(transaction.transactionId, 'install-failed')
      if (restored.status !== 'manual-recovery-required') {
        await store.clear(transaction.transactionId)
        process.stderr.write(INSTALL_RESTORED_NOTICE)
      }
      throw cause
    }
  } else {
    const restored = await store.restoreCurrentInstall(transaction.transactionId, 'install-failed')
    if (restored.status !== 'manual-recovery-required') {
      await store.clear(transaction.transactionId)
      process.stderr.write(INSTALL_RESTORED_NOTICE)
    }
  }
  if (failure !== undefined) throw failure
  if (capturedExitCode !== undefined) process.exitCode = capturedExitCode
}

/**
 * Enter the packaged DSH CLI under the bundled Node runtime.
 *
 * Locked children additionally clamp the invocation before the import (see
 * {@link desktopCliClampLocked} for the decision and {@link withLockedClampOverlay}
 * for the command-form branching): boot-shaped argv gains the shipped clamp
 * overlay and the environment loses every spelling of the upstream
 * permission-mode override. Unlocked and development runs keep today's CLI
 * shape byte-for-byte.
 *
 * @param environment - process environment inherited from the generated shim;
 * besides the policy hand-off it may carry the launcher's market tarball
 * hand-off (`DSH_COMPANY_TARBALL_HANDOFF`), which the locked add gate
 * re-binds to the signed catalog before admitting its one `file:` target.
 * @param load - ESM loader used by the executable and focused tests.
 * @param argv - mutable process arguments presented to the upstream CLI.
 * @param policy - embedded company policy gating terminal plugin adds; defaults to the shipped asset.
 * @param manifestAssetPath - company catalog manifest location for locked plugin adds; defaults to the embedded asset.
 * @returns once the imported CLI entry completes its top-level work.
 */
export async function runDesktopDshCli(
  environment: NodeJS.ProcessEnv = process.env,
  load: (url: string) => Promise<unknown> = url => import(url),
  argv: string[] = process.argv,
  policy?: DesktopPolicy,
  manifestAssetPath?: string,
): Promise<void> {
  const profileName = takeDefaultProfile(environment)
  const installRecoveryStatePath = takeEnvironmentValue(
    environment,
    DESKTOP_INSTALL_RECOVERY_STATE_ENV,
  )
  // Origin-mode byte hand-off: when the trusted Electron launcher staged the
  // manifest bytes (it can reach corporate-CA origins through the Chromium
  // network stack; this Node process cannot), prefer that file and keep the
  // restricted network fetch only as the fallback. The bytes still pass the
  // same signature gate below either way.
  const companyManifestFile = takeEnvironmentValue(
    environment,
    DESKTOP_COMPANY_MANIFEST_FILE_ENV,
  )
  // Market-orchestrated tarball hand-off (P7 fix): when the trusted launcher
  // spawns this child for a controlled market tarball install, it names the
  // one `file:` target the locked add gate may admit. Consumed here so the
  // upstream CLI and its pnpm children never inherit it; strictly parsed
  // below — a present-but-malformed value fails the add closed.
  const companyTarballHandoffRaw = takeEnvironmentValue(
    environment,
    DESKTOP_COMPANY_TARBALL_HANDOFF_ENV,
  )
  if (profileName !== undefined) {
    argv.splice(2, argv.length - 2, ...withDefaultDesktopProfile(argv.slice(2), profileName))
  }
  // Executor-side hard clamp (scout verdict: the bundled-Node CLI child is
  // an unlocked-composition bypass of the GUI's in-memory locked profile —
  // the on-disk bundle layers are the upstream base + web-app pair). Before
  // the upstream import below, a locked child rewrites argv and environment
  // in full: every spelling of the upstream permission-mode override is
  // deleted, and boot-shaped invocations gain the shipped clamp overlay
  // (`--patch`), whose literal restatement pins the sandbox/approval pair,
  // removes the full-access permission preset, and swaps the agent-preset
  // roster to the company row pinned at the packaged company root.
  //
  // Honest boundary: the clamp covers only CLI children launched or led by
  // DSH Desktop (the built-in terminal shim, the install children, and a
  // hand-run packaged bootstrap without the launcher hand-off, which the
  // fail-closed decision above treats as locked). A user running the
  // upstream `bin.js` under their own Node is equivalent to the shell access
  // they already hold, and the user-writable home layer plus any later
  // user-typed `--patch` overlay stack above the clamp — a soft barrier by
  // construction, matching the accepted sign-off.
  if (desktopCliClampLocked(environment, policy)) {
    removeEnvironmentVariable(environment, DESKTOP_CLI_CLAMP_ENVIRONMENT.permissionMode)
    if (lockedClampApplies(argv[2])) {
      environment[DESKTOP_CLI_CLAMP_ENVIRONMENT.presetRoot] = desktopCliCompanyPresetRoot()
      argv.splice(2, argv.length - 2, ...withLockedClampOverlay(argv.slice(2), desktopCliLockOverlayPath()))
    }
  }
  const homeDir = environment[DSH_HOME]
  const installCommand = pluginAddCommand(argv.slice(2))
  if (installCommand !== undefined) {
    // Signed approvals the locked channel may allow for this add: the
    // entry's `approvedBuilds`, widened into the workspace below. Unlocked
    // (and denied) adds keep undefined — the built-in triple only — so only
    // a signed catalog entry can ever extend the approval list.
    let approvedBuildDependencies: readonly string[] | undefined
    // Locked state and trust roots arrive through the launcher-injected
    // environment hand-off: this process runs under the bundled Node binary,
    // which cannot read inside app.asar, and the physical policy copy under
    // app.asar.unpacked is user-writable. A packaged launch without the
    // hand-off fails closed inside `desktopPolicyFromEnvironment`; only an
    // unpackaged development checkout falls back to the shipped asset.
    const effectivePolicy = policy
      ?? desktopPolicyFromEnvironment(environment)
      ?? readDesktopPolicy()
    if (effectivePolicy.locked) {
      // Signed-catalog channel (P2-5): only a verified, unrevoked, exact
      // `<package>@<version>` entry may proceed; every denial stays here.
      // The sequence floor rides the receipts ratchet boot verification also
      // reconciles against (see cli-install-channel.ts for the rationale).
      //
      // A launcher tarball hand-off, when present, is strictly parsed first:
      // the launcher only ever injects the canonical four-field document, so
      // anything else is a malformed (or hostile) value and fails closed
      // before the manifest is even consulted.
      let tarballHandoff: ReturnType<typeof parseCompanyTarballHandoff> = undefined
      if (companyTarballHandoffRaw !== undefined) {
        tarballHandoff = parseCompanyTarballHandoff(companyTarballHandoffRaw)
        if (tarballHandoff === undefined) {
          process.stderr.write(`dsh-desktop: the launcher tarball hand-off is malformed and the plugin add was refused\n`)
          process.exitCode = 1
          return
        }
      }
      const lastSeenSequence = await lockedPluginAddSequenceFloor(homeDir)
      const decision = await authorizeLockedPluginAdd(
        installCommand.packageSpecs,
        effectivePolicy,
        {
          ...(manifestAssetPath === undefined ? {} : { assetPath: manifestAssetPath }),
          ...(companyManifestFile === undefined
            ? {}
            : { fetch: { request: companyManifestFileRequest(companyManifestFile) } }),
          ...(lastSeenSequence === undefined ? {} : { lastSeenSequence }),
          ...(tarballHandoff === undefined ? {} : { tarballHandoff }),
          ...(homeDir === undefined
            ? {}
            : { profileDir: resolveProfileDir(installCommand.profileName, homeDir) }),
        },
      )
      if (!decision.allowed) {
        process.stderr.write(`${decision.reason}\n`)
        process.exitCode = 1
        return
      }
      approvedBuildDependencies = decision.approvedBuildDependencies
      // `addIndex` counts inside the `argv.slice(2)` window, so the absolute
      // argv position of `add` is two further in.
      injectSaveExactFlag(argv, installCommand.addIndex + 2)
    }
    if (homeDir !== undefined) {
      // pnpm 11 fails the whole `dsh plugin add` when any dependency's build
      // script is not pre-approved in the profile's pnpm-workspace.yaml, and
      // the upstream profile template ships no approval list. Desktop's
      // trusted builders must be allow-listed before the upstream CLI spawns
      // pnpm (this path does not go through desktopPnpm). A signed entry's
      // `approvedBuilds` widen the built-in triple for this add, matching the
      // market install path's merge.
      ensureProfilePnpmBuildApproval(
        resolveProfileDir(installCommand.profileName, homeDir),
        approvedBuildDependencies === undefined ? {} : { approvedBuildDependencies },
      )
    }
  }
  if (
    installRecoveryStatePath !== undefined
    && installCommand !== undefined
    && homeDir !== undefined
  ) {
    const store = new DesktopInstallRecoveryStore({
      statePath: desktopInstallRecoveryStatePath('/', {
        [DESKTOP_INSTALL_RECOVERY_STATE_ENV]: installRecoveryStatePath,
      }),
      profileName: installCommand.profileName,
      profileDir: resolveProfileDir(installCommand.profileName, homeDir),
      generationId: `terminal:${randomUUID()}`,
    })
    await loadWithInstallRecovery(load, store)
    return
  }
  await load(DSH_ENTRY_URL)
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  void runDesktopDshCli().catch((cause: unknown) => {
    process.stderr.write(`dsh-desktop: failed to start packaged dsh: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}
