/** Fail-loud verification of the runtime entries sealed into Electron's app.asar. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { listPackage } from '@electron/asar'
import { getCurrentFuseWire, flipFuses, FuseV1Options, FuseVersion, type FuseConfig } from '@electron/fuses'
import AdmZip from 'adm-zip'
import { verifyCompanyManifest } from 'dsh-community-market'
import {
  FORBIDDEN_MACOS_UNIVERSAL_ENTRIES,
  MACOS_UNIVERSAL_NATIVE_ENTRIES,
} from './mac-universal.ts'

/** AfterPack fields consumed without importing Electron Builder's incomplete declaration graph. */
export interface PackagedRuntimeContext {
  /** Completed platform application directory. */
  readonly appOutDir: string
  /** Electron Builder target architecture (`4` is its stable universal enum value). */
  readonly arch?: number
  /** Electron target platform selected by the packager. */
  readonly electronPlatformName: string
  /** Product metadata used to locate the macOS application bundle. */
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string
      /** Sanitized package name; the Linux executable name defaults to it. */
      readonly sanitizedName?: string
    }
    /** Effective Electron Builder configuration; the packaged manifest omits `build`. */
    readonly config?: {
      readonly electronFuses?: { readonly [fuse: string]: unknown }
    }
  }
}

/** Exact archive entries required by the desktop launcher on every supported platform. */
export const REQUIRED_PACKAGED_RUNTIME_ENTRIES = [
  'package.json',
  'lib/main.js',
  'lib/client.js',
  // The in-archive policy entry the Electron main process reads through the
  // virtual path (P3 fix): policy resolution prefers the archive copy, and the
  // CLI child receives locked state and trust roots through the launcher's
  // environment hand-off instead of re-reading any file.
  'lib/policy/desktop-policy.json',
  // Build-time digest manifest the packaged runtime verifies the bundled Node
  // command against (`beforePack` generates it from the pinned archives).
  'lib/node-runtime-sha256.json',
  // The locked CLI clamp overlay the bundled-Node bootstrap appends as a
  // `--patch` flag: dual-homed like the policy asset so the in-archive copy
  // pins the shipped bytes while the CLI child reads the physical mirror
  // (plain Node cannot read inside app.asar).
  'lib/cli-lock/desktop-cli-lock.patch.yml',
  'lib/native-ui/profile-create.html',
  'lib/native-ui/recovery.html',
  // The SSO startup gate window's local document (locked requireSso builds
  // load it from the unpacked mirror before any Host boot).
  'lib/native-ui/sso-gate.html',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/diagnostics.js',
  'lib/diagnostic-export-worker.js',
  'lib/desktop-cli.js',
  'lib/desktop-node-runtime.js',
  'lib/desktop-runtime-environment.js',
  'lib/desktop-terminal.js',
  'lib/terminal.js',
  'lib/update-checker.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-agent-presets.js',
  'lib/company-agent-presets.js',
  'lib/windows-pwsh-sandbox.js',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/pnpm/bin/pnpm.mjs',
] as const

/** Physical entries required because profile fallback symlinks cannot target ASAR paths. */
export const REQUIRED_UNPACKED_RUNTIME_ENTRIES = [
  'package.json',
  'cordis.patch.yml',
  'lib/main.js',
  'lib/client.js',
  // The physical policy mirror ships because `lib/**` stays dual-homed
  // (P3-2): the unpacked tree is what profile-fallback consumers load, and the
  // packaged-policy checklist below asserts its bytes equal the release
  // variant. No runtime consumer may trust it as policy — the main process
  // reads the in-archive entry and the CLI reads its environment hand-off.
  'lib/policy/desktop-policy.json',
  // The CLI clamp overlay must be physical: the bundled-Node child reads it
  // through `--patch` before any composition, and no Electron process owns
  // the read.
  'lib/cli-lock/desktop-cli-lock.patch.yml',
  'lib/native-ui/profile-create.html',
  'lib/native-ui/recovery.html',
  'lib/native-ui/sso-gate.html',
  'lib/index.js',
  'lib/profile.js',
  'lib/profile-manager.js',
  'lib/profile-service.js',
  'lib/pnpm.js',
  'lib/profiles.js',
  'lib/diagnostics.js',
  'lib/diagnostic-export-worker.js',
  'lib/terminal.js',
  'lib/update-download.js',
  'lib/updates.js',
  'lib/windows-agent-presets.js',
  'lib/company-agent-presets.js',
  'lib/windows-pwsh-sandbox.js',
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/agent.cordis.yml',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
  'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md',
  'agent-presets/deloitte-standard/agent.cordis.yml',
  'agent-presets/deloitte-standard/preset.yml',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/pnpm/bin/pnpm.mjs',
] as const

/** Prebuilt Node-API modules required when the Windows package skips native source rebuilds. */
export const REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES = [
  'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
  'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
] as const

/**
 * Application files that must live inside app.asar with no physical mirror.
 *
 * P3-2 moved the build-time icon assets out of `asarUnpack`: only the
 * Electron main process reads them (`nativeImage.createFromPath` and the
 * window/tray code), and it reads virtual ASAR paths transparently.
 */
export const REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES = [
  'build/app-icon.png',
  'build/app-icon-mac.png',
  'build/tray-iconTemplate.png',
  'build/tray-icon-blue.png',
] as const

/** Archive-only prefixes that must never grow a physical `app.asar.unpacked` mirror. */
const ARCHIVE_ONLY_PREFIXES = ['build/'] as const

/** Whether one archive entry is intentionally stored in-archive without a physical mirror. */
export function isArchiveOnlyRuntimeEntry(entry: string): boolean {
  const normalized = entry.replaceAll('\\', '/')
  return ARCHIVE_ONLY_PREFIXES.some(prefix =>
    normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

/**
 * Fuse stage the packaged application must ship (P3-1, P3-2, P3-4).
 *
 * P3-4 completes the set to every fuse Electron Builder 26 exposes
 * (verified against `FuseOptionsV1` in `app-builder-lib`): `runAsNode` false
 * with the bundled Node runtime (P3-1), the ASAR hardening pair (P3-2), plus
 * the Minke-verified hardening trio — encrypted cookie store,
 * `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS` ignored, `--inspect` and `SIGUSR1`
 * inspector activation ignored. `loadBrowserProcessSpecificV8Snapshot` stays
 * explicitly false (the application ships no browser-specific V8 snapshot;
 * pinning the default keeps the map complete) and
 * `grantFileProtocolExtraPrivileges` is false: the only `file://` documents
 * are the sandboxed profile-create and recovery windows, whose CSP is
 * `connect-src 'none'` with no service workers or nested frames.
 *
 * Development/release distinction: Electron Builder has no per-mode fuse
 * profiles, and fuses only apply to packaged binaries. `yarn dev` runs the
 * unpackaged Electron distribution, where inspector arguments keep working,
 * so this single map is both the development and the release posture — every
 * packaged artifact (local `--dir` smoke included) is a release candidate.
 * Packaged builds cannot use `--inspect`/`--inspect-brk`; debug them through
 * logs, the diagnostics export, or an unpackaged dev run. Advisory
 * positioning: without Authenticode or a Developer ID signature the fuse
 * wire itself can be flipped back by a determined actor, so these fuses
 * raise the cost of tampering rather than preventing it.
 */
export const REQUIRED_ELECTRON_FUSES = Object.freeze({
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false,
})

/** Back-compatible alias for the P3-1 runAsNode stage constant. */
export const REQUIRED_RUN_AS_NODE_FUSE = REQUIRED_ELECTRON_FUSES.runAsNode

/** Directory `extraResources` places the bundled Node distribution into. */
export const BUNDLED_NODE_RESOURCE_DIRECTORY = 'node-runtime'

/** CPU-specific runtime assets that must coexist in a universal macOS application. */
export const REQUIRED_MACOS_UNIVERSAL_ENTRIES = [
  ...MACOS_UNIVERSAL_NATIVE_ENTRIES.map(entry => entry.path),
] as const

/** Package exports that profile fallback links must resolve from the physical application tree. */
export const REQUIRED_UNPACKED_PACKAGE_SPECIFIERS = [
  'dsh-plugin-desktop',
  'dsh-plugin-desktop/profile',
  'dsh-plugin-desktop/client',
  'dsh-plugin-desktop/terminal',
  'dsh-plugin-desktop/pnpm',
  'dsh-plugin-desktop/profile-service',
  'dsh-plugin-desktop/profiles',
  'dsh-plugin-desktop/diagnostics',
  'dsh-plugin-desktop/notifications',
  'dsh-plugin-desktop/model-usage-reporter',
  'dsh-plugin-desktop/updates',
  'dsh-plugin-desktop/windows-agent-presets',
  'dsh-plugin-desktop/company-agent-presets',
  'dsh-plugin-desktop/windows-pwsh-sandbox',
  'dsh-plugin-desktop/package.json',
  '@deepseek-ai/dsh-base/package.json',
  '@deepseek-ai/schemastery/package.json',
  '@deepseek-ai/dsh-web-app/package.json',
] as const

/** Injectable archive listing seam used by focused tests. */
export type ArchiveLister = (archivePath: string, options: { isPack: boolean }) => readonly string[]

/** Injectable physical-file probe used by focused tests. */
export type FileProbe = (filename: string) => boolean

/** Injectable Node package resolver used by focused tests. */
export type PackageResolver = (specifier: string) => string

/** Inputs understood by the bundled diagnostics Worker. */
export interface PackagedDiagnosticWorkerData {
  readonly logsDir: string
  readonly userDataDir: string
  readonly appVersion: string
  readonly maxEvidenceBytes: number
  readonly crashDumpsDir: string
}

/** Injectable packaged Worker launcher used by focused tests. */
export type PackagedDiagnosticWorkerLauncher = (
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
) => Promise<string>

/** Injectable smoke seam used to verify afterPack ordering. */
export type PackagedDiagnosticWorkerSmoke = (unpackedRoot: string) => Promise<void>

/** Result posted by the bundled diagnostics Worker. */
type PackagedDiagnosticWorkerResult =
  | { readonly ok: true, readonly path: string }
  | { readonly ok: false, readonly error: string }

const PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS = 30_000

/** Start the physical packaged diagnostics Worker and wait for its terminal result. */
async function launchPackagedDiagnosticWorker(
  workerPath: string,
  workerData: PackagedDiagnosticWorkerData,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      name: 'dsh-packaged-diagnostic-smoke',
      workerData,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker timed out after ${String(PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)}ms`,
      ))
    }, PACKAGED_DIAGNOSTIC_WORKER_TIMEOUT_MS)
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      void worker.terminate()
      complete()
    }
    worker.once('message', (result: PackagedDiagnosticWorkerResult) => {
      if (result.ok) settle(() => resolve(result.path))
      else settle(() => reject(new Error(result.error)))
    })
    worker.once('error', cause => settle(() => reject(cause)))
    worker.once('exit', (code) => {
      settle(() => reject(new Error(
        `dsh-plugin-desktop: packaged diagnostic worker exited with code ${String(code)}`,
      )))
    })
  })
}

/** Exercise the physical Worker emitted beside app.asar with a minimal archive. */
export async function smokePackagedDiagnosticWorker(
  unpackedRoot: string,
  launch: PackagedDiagnosticWorkerLauncher = launchPackagedDiagnosticWorker,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-diagnostics-'))
  const logsDir = join(root, 'logs')
  const userDataDir = join(root, 'user-data')
  const crashDumpsDir = join(root, 'Crashpad')
  mkdirSync(logsDir)
  mkdirSync(userDataDir)
  mkdirSync(join(crashDumpsDir, 'pending'), { recursive: true })
  writeFileSync(join(logsDir, 'dsh-2000-01-01.log'), 'packaged worker smoke\n')
  writeFileSync(join(crashDumpsDir, 'pending', 'packaged-smoke.dmp'), 'packaged crash dump smoke\n')
  try {
    const output = await launch(
      join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'),
      { logsDir, userDataDir, appVersion: 'packaged-smoke', maxEvidenceBytes: 1024, crashDumpsDir },
    )
    if (!existsSync(output)) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker produced no archive at ${output}`)
    }
    const crashEntry = 'crash-dumps/pending/packaged-smoke.dmp'
    if (new AdmZip(output).getEntry(crashEntry) === null) {
      throw new Error(`dsh-plugin-desktop: packaged diagnostic worker omitted ${crashEntry}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Resolve the platform-specific archive produced by Electron Builder.
 * @param context - completed application directory and target platform.
 * @returns absolute path to the packaged app.asar.
 */
export function resolvePackagedAsarPath(context: PackagedRuntimeContext): string {
  if (context.electronPlatformName === 'darwin') {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'app.asar',
    )
  }
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') {
    return join(context.appOutDir, 'resources', 'app.asar')
  }
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/**
 * Resolve the physical dependency tree emitted beside app.asar.
 * @param context - completed application directory and target platform.
 * @returns absolute path to app.asar.unpacked.
 */
export function resolvePackagedUnpackedRoot(context: PackagedRuntimeContext): string {
  return `${resolvePackagedAsarPath(context)}.unpacked`
}

/** Resolve the resources directory holding both app.asar and extraResources. */
export function resolvePackagedResourcesDirectory(context: PackagedRuntimeContext): string {
  return dirname(resolvePackagedAsarPath(context))
}

/**
 * Resolve the bundled Node command shipped beside app.asar.
 * @param context - completed application directory and target platform.
 * @returns the packaged `node-runtime` command path for the target platform.
 */
export function resolveBundledNodeResourcePath(context: PackagedRuntimeContext): string {
  const commandName = context.electronPlatformName === 'win32' ? 'node.exe' : 'node'
  return join(resolvePackagedResourcesDirectory(context), BUNDLED_NODE_RESOURCE_DIRECTORY, commandName)
}

/**
 * Verify the bundled Node command shipped beside app.asar.
 * @param context - completed application directory and target platform.
 * @param exists - physical-file probe for the packaged application tree.
 * @returns the verified bundled Node command path.
 */
export function verifyBundledNodeRuntime(
  context: PackagedRuntimeContext,
  exists: FileProbe = existsSync,
): string {
  const nodePath = resolveBundledNodeResourcePath(context)
  if (!exists(nodePath)) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${resolvePackagedResourcesDirectory(context)} is missing the bundled Node command: ${nodePath}`,
    )
  }
  return nodePath
}

/** Read the Electron fuse values the shipped application configures. */
export function readPackagedElectronFuses(
  packager: PackagedRuntimeContext['packager'],
  readRepositoryManifest: (filename: string) => string = filename => readFileSync(filename, 'utf8'),
): Readonly<Record<string, unknown>> {
  // Electron Builder prunes the `build` section from the packaged manifest,
  // so the effective build configuration is authoritative and the repository
  // manifest is the fallback for contexts without it.
  const configured = packager.config?.electronFuses
  if (configured !== undefined) return configured
  const manifest = JSON.parse(readRepositoryManifest(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
  )) as { build?: { electronFuses?: Record<string, unknown> } }
  return manifest.build?.electronFuses ?? {}
}

/** Read only the `runAsNode` fuse (P3-1 compatibility wrapper). */
export function readPackagedRunAsNodeFuse(
  packager: PackagedRuntimeContext['packager'],
  readRepositoryManifest: (filename: string) => string = filename => readFileSync(filename, 'utf8'),
): unknown {
  return readPackagedElectronFuses(packager, readRepositoryManifest).runAsNode
}

/** Require every staged fuse to match {@link REQUIRED_ELECTRON_FUSES}. */
export function verifyElectronFuseStage(
  fuses: Readonly<Record<string, unknown>>,
  required: Readonly<Record<string, unknown>> = REQUIRED_ELECTRON_FUSES,
): void {
  const mismatched = Object.entries(required).filter(([fuse, value]) => fuses[fuse] !== value)
  if (mismatched.length > 0) {
    const detail = mismatched
      .map(([fuse, value]) => `electronFuses.${fuse}=${String(value)}`)
      .join(', ')
    throw new Error(
      `dsh-plugin-desktop: packaged runtime requires ${detail} but the application manifest declares ${JSON.stringify(fuses)}`,
    )
  }
}

/** Require the shipped `runAsNode` fuse stage to match {@link REQUIRED_RUN_AS_NODE_FUSE}. */
export function verifyRunAsNodeFuseStage(
  fuse: unknown,
  required: boolean = REQUIRED_RUN_AS_NODE_FUSE,
): void {
  if (fuse !== required) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime requires electronFuses.runAsNode=${String(required)} but the application manifest declares ${JSON.stringify(fuse)}`,
    )
  }
}

/**
 * Resolve the platform application binary Electron Builder produced.
 *
 * The fuse wire and the embedded ASAR-integrity hash live inside this binary,
 * so the binary-level checks below read it directly instead of trusting the
 * build configuration.
 * @param context - completed application directory and target platform.
 * @returns the absolute path of the packaged application executable.
 */
export function resolvePackagedExecutablePath(context: PackagedRuntimeContext): string {
  const productFilename = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    return join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
  }
  if (context.electronPlatformName === 'win32') {
    return join(context.appOutDir, `${productFilename}.exe`)
  }
  if (context.electronPlatformName === 'linux') {
    // Electron Builder's LinuxPackager names the executable after the sanitized
    // package name when no explicit executableName is configured.
    return join(context.appOutDir, context.packager.appInfo.sanitizedName ?? 'dsh-plugin-desktop')
  }
  throw new Error(
    `dsh-plugin-desktop: unsupported Electron afterPack platform ${JSON.stringify(context.electronPlatformName)}`,
  )
}

/** camelCase fuse names in `FuseV1Options` wire order. */
const FUSE_WIRE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
] as const satisfies readonly (keyof typeof REQUIRED_ELECTRON_FUSES)[]

/**
 * Fuse wire state bytes Electron writes into the binary sentinel, mirroring
 * the wire format of `@electron/fuses` (the package does not export its
 * `FuseState` enum): `'0'` disabled, `'1'` enabled, `'r'` removed, and the
 * inherit marker.
 */
const FUSE_WIRE_STATE = Object.freeze({
  disable: 0x30,
  enable: 0x31,
  removed: 0x72,
  inherit: 0x90,
})

/** Human-readable state names for fuse-wire mismatch messages. */
const FUSE_WIRE_STATE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [FUSE_WIRE_STATE.disable]: 'DISABLE',
  [FUSE_WIRE_STATE.enable]: 'ENABLE',
  [FUSE_WIRE_STATE.removed]: 'REMOVED',
  [FUSE_WIRE_STATE.inherit]: 'INHERIT',
})

/** Fuse wire read from the packaged application binary, keyed by `FuseV1Options`. */
export type PackagedFuseWire = Readonly<Record<string, unknown>>

/** Fuse-wire reader seam used by focused tests; production reads the binary. */
export type PackagedFuseWireReader = (
  executablePath: string,
) => Promise<PackagedFuseWire>

/** Fuse-wire flipper seam used by focused tests; production flips via `@electron/fuses`. */
export type PackagedFuseFlipper = (executablePath: string) => Promise<number>

/** Translate the required fuse map into the `@electron/fuses` flip configuration. */
function requiredFuseFlipConfig(): FuseConfig {
  return {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: REQUIRED_ELECTRON_FUSES.runAsNode,
    [FuseV1Options.EnableCookieEncryption]: REQUIRED_ELECTRON_FUSES.enableCookieEncryption,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: REQUIRED_ELECTRON_FUSES.enableNodeOptionsEnvironmentVariable,
    [FuseV1Options.EnableNodeCliInspectArguments]: REQUIRED_ELECTRON_FUSES.enableNodeCliInspectArguments,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: REQUIRED_ELECTRON_FUSES.enableEmbeddedAsarIntegrityValidation,
    [FuseV1Options.OnlyLoadAppFromAsar]: REQUIRED_ELECTRON_FUSES.onlyLoadAppFromAsar,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: REQUIRED_ELECTRON_FUSES.loadBrowserProcessSpecificV8Snapshot,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: REQUIRED_ELECTRON_FUSES.grantFileProtocolExtraPrivileges,
  }
}

/**
 * Require the fuse wire fused into the packaged application binary to match
 * {@link REQUIRED_ELECTRON_FUSES} exactly (P3 fix).
 *
 * The configuration comparison above stays as the fast pre-check — it catches
 * a mistyped fuse key Electron Builder would silently ignore — while this
 * readback proves the shipped binary itself carries the release posture: a
 * packaging regression or a post-pack flip fails here, before signing.
 * `REMOVED` and `INHERIT` wire states count as mismatches.
 * @param wire - fuse states decoded from the application binary.
 * @param required - required release fuse map.
 */
export function verifyElectronFuseWire(
  wire: PackagedFuseWire,
  required: Readonly<Record<string, unknown>> = REQUIRED_ELECTRON_FUSES,
): void {
  if (wire.version !== '1') {
    throw new Error(
      `dsh-plugin-desktop: packaged application binary carries fuse wire version ${JSON.stringify(wire.version)} instead of V1`,
    )
  }
  const mismatched = FUSE_WIRE_NAMES
    .map((name, index) => {
      const expected = required[name]
      const expectedState = expected === true
        ? FUSE_WIRE_STATE.enable
        : expected === false ? FUSE_WIRE_STATE.disable : undefined
      if (expectedState === undefined) {
        return `${name}: required=${String(expected)} is not a boolean fuse stage`
      }
      const actual = wire[String(index)]
      return actual === expectedState
        ? undefined
        : `${name}: binary=${FUSE_WIRE_STATE_NAMES[actual as number] ?? JSON.stringify(actual)} required=${String(expected)}`
    })
    .filter((entry): entry is string => entry !== undefined)
  if (mismatched.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: the packaged application binary does not carry the required fuse stage: ${mismatched.join(', ')}`,
    )
  }
}

/**
 * Read and verify the fuse wire fused into the packaged application binary.
 *
 * Electron Builder flips the configured fuses only after every custom
 * `afterPack` hook has run (`platformPackager.doPack`: `emitAfterPack` →
 * framework.afterPack → `doAddElectronFuses` → signing), so a hook that only
 * read the wire would always see the untouched distribution defaults. This
 * hook therefore applies the required fuse configuration itself and reads it
 * back; the builder's own later flip rewrites the identical states (a no-op
 * once the values match), and the configuration check above has already
 * pinned the builder's map to the same posture.
 * @param context - Electron Builder's afterPack context.
 * @param read - fuse-wire reader seam; defaults to `@electron/fuses`.
 * @param flip - fuse-wire flipper seam; defaults to `@electron/fuses`.
 */
export async function verifyPackagedFuseWire(
  context: PackagedRuntimeContext,
  read: PackagedFuseWireReader = path => getCurrentFuseWire(path),
  flip: PackagedFuseFlipper = path => flipFuses(path, requiredFuseFlipConfig()),
): Promise<void> {
  const executablePath = resolvePackagedExecutablePath(context)
  try {
    await flip(executablePath)
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: failed to stage the required fuse wire into the packaged application binary at ${executablePath}`,
      { cause },
    )
  }
  let wire: PackagedFuseWire
  try {
    wire = await read(executablePath)
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: failed to read the fuse wire of the packaged application binary at ${executablePath}`,
      { cause },
    )
  }
  verifyElectronFuseWire(wire)
}

/**
 * Inline marker that must accompany the empty update-channel trust-root
 * placeholder (P3-4 release gate). Company release builds replace the array
 * with pinned keys and drop the marker; until then the explicit marker keeps
 * the empty development placeholder an affirmative decision instead of a
 * silent omission.
 */
export const UPDATE_TRUST_ROOTS_DEVELOPMENT_MARKER = 'development placeholder' as const

/** Repository sources the company release checklist asserts against. */
export interface CompanyReleaseChecklistSources {
  /** Effective `build.electronFuses` map of the application manifest. */
  readonly manifestFuses: Readonly<Record<string, unknown>>
  /** Parsed `src/policy/desktop-policy.release.json`. */
  readonly releasePolicy: unknown
  /**
   * Parsed `lib/policy/desktop-policy.json` from the packaged tree
   * (`app.asar.unpacked/lib/policy/desktop-policy.json`).
   */
  readonly packagedPolicy: unknown
  /**
   * Text of the packaged company catalog manifest
   * (`app.asar.unpacked/lib/<companyManifestUrl>`) for content-mode policies;
   * undefined when absent or when the policy serves the catalog from an
   * origin. Verified against the policy trust roots by the checklist.
   */
  readonly packagedManifestText: string | undefined
  /** Text of `src/update-verification.ts`. */
  readonly updateVerificationSource: string
  /** Text of `src/electron-runtime.ts`. */
  readonly electronRuntimeSource: string
  /** Text of `src/update-lifecycle.ts`. */
  readonly updateLifecycleSource: string
}

/** Read one file from the desktop package root beside this script. */
function readRepositorySourceFile(relativePath: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', relativePath), 'utf8')
}

/** Canonical JSON text with recursively sorted keys, for value comparison. */
function canonicalJsonText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJsonText((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Read the checklist sources from the repository and packaged trees.
 *
 * The packaged policy is read from the physical `app.asar.unpacked` mirror:
 * this verifier is a plain Node script without Electron's patched filesystem,
 * and byte-for-byte equality with the in-archive entry is guaranteed by the
 * dual-homing gate (`verifyUnpackedArchiveMirror`) plus the asar header the
 * integrity fuse pins — the minimal-tooling choice over linking an asar reader.
 * @param context - completed application directory and target platform.
 * @param readRepositoryFile - repository-file reader seam used by tests.
 * @param readPackagedFile - packaged-tree file reader seam used by tests.
 * @returns the parsed and textual sources the checklist asserts against.
 */
export function readCompanyReleaseChecklistSources(
  context: PackagedRuntimeContext,
  readRepositoryFile: (relativePath: string) => string = readRepositorySourceFile,
  readPackagedFile: (filename: string) => string = filename => readFileSync(filename, 'utf8'),
): CompanyReleaseChecklistSources {
  const releasePolicy = JSON.parse(readRepositoryFile('src/policy/desktop-policy.release.json'))
  return {
    manifestFuses: readPackagedElectronFuses(context.packager),
    releasePolicy,
    packagedPolicy: JSON.parse(readPackagedFile(join(
      resolvePackagedUnpackedRoot(context),
      'lib',
      'policy',
      'desktop-policy.json',
    ))),
    packagedManifestText: readPackagedCompanyManifestText(releasePolicy, context, readPackagedFile),
    updateVerificationSource: readRepositoryFile('src/update-verification.ts'),
    electronRuntimeSource: readRepositoryFile('src/electron-runtime.ts'),
    updateLifecycleSource: readRepositoryFile('src/update-lifecycle.ts'),
  }
}

/**
 * Read the packaged company catalog manifest for a content-mode release
 * policy. A missing asset reads as undefined — the checklist turns that into
 * the build failure; origin-mode policies never read a packaged asset.
 */
function readPackagedCompanyManifestText(
  releasePolicy: unknown,
  context: PackagedRuntimeContext,
  readPackagedFile: (filename: string) => string,
): string | undefined {
  if (typeof releasePolicy !== 'object' || releasePolicy === null || Array.isArray(releasePolicy)) {
    return undefined
  }
  const origin = (releasePolicy as Record<string, unknown>).companyCatalogOrigin
  const companyManifestUrl = (releasePolicy as Record<string, unknown>).companyManifestUrl
  if (origin !== null || typeof companyManifestUrl !== 'string') return undefined
  try {
    return readPackagedFile(join(resolvePackagedUnpackedRoot(context), 'lib', ...companyManifestUrl.split('/')))
  } catch {
    return undefined
  }
}

/** Catalog-relevant slice of a release policy document. */
interface ChecklistCatalogPolicy {
  readonly trustRoots: readonly { readonly keyId: string; readonly fingerprint: string }[]
  readonly companyCatalogOrigin: string | null
  readonly companyManifestUrl: string
}

/** Validate the catalog fields the checklist gates on; malformed policies fail loud. */
function checklistCatalogPolicy(policy: unknown, label: string): ChecklistCatalogPolicy {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new Error(`dsh-plugin-desktop: ${label} must be an object`)
  }
  const object = policy as Record<string, unknown>
  if (!Array.isArray(object.trustRoots)) {
    throw new Error(`dsh-plugin-desktop: ${label} must declare a trustRoots array`)
  }
  const trustRoots = object.trustRoots.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`dsh-plugin-desktop: ${label} trust roots must be objects`)
    }
    const { keyId, fingerprint } = entry as Record<string, unknown>
    if (typeof keyId !== 'string' || typeof fingerprint !== 'string') {
      throw new Error(`dsh-plugin-desktop: ${label} trust roots must carry keyId and fingerprint strings`)
    }
    return { keyId, fingerprint }
  })
  const companyCatalogOrigin = object.companyCatalogOrigin
  if (companyCatalogOrigin !== null && typeof companyCatalogOrigin !== 'string') {
    throw new Error(`dsh-plugin-desktop: ${label} companyCatalogOrigin must be a bare https origin or null`)
  }
  const companyManifestUrl = object.companyManifestUrl
  if (typeof companyManifestUrl !== 'string' || companyManifestUrl.length === 0
    || companyManifestUrl.includes('\0') || companyManifestUrl.includes('\\')) {
    throw new Error(`dsh-plugin-desktop: ${label} companyManifestUrl must be a non-empty string without NUL or backslash`)
  }
  return { trustRoots, companyCatalogOrigin, companyManifestUrl }
}

/**
 * Company release-build checklist (security plan P3-4, catalog items L2).
 *
 * One static assertion group over the repository, run by `afterPack` for
 * every packaged artifact so local `--dir` smoke builds fail exactly like a
 * release build would:
 *
 * 1. the manifest fuse map is exactly the release posture — every key of
 *    {@link REQUIRED_ELECTRON_FUSES} with the required value and no extra
 *    keys (a mistyped fuse name is silently ignored by Electron Builder, so
 *    only an exact key-set comparison catches it);
 * 2. the release policy asset exists and stays locked (P1-1), and the copy
 *    packaged into the application tree is the exact same locked document —
 *    a dev-variant or hand-edited policy inside the artifact fails here;
 * 3. the policy pins at least one catalog trust root: an empty `trustRoots`
 *    array cannot construct the signed company catalog at runtime, so the
 *    locked market would browse a placeholder and reject every install —
 *    the gate fails the build instead of shipping that silent placeholder;
 * 4. a content-mode policy must embed the company catalog manifest inside
 *    the packaged tree (`lib/<companyManifestUrl>`), and that exact file must
 *    verify against the policy trust roots through the market signing
 *    library (expired or badly signed assets fail; the sequence ratchet is
 *    intentionally not consulted because build time has no persisted
 *    state) — a hand-copied manifest is a verified build step, not a hope;
 * 5. the update-channel trust roots are either pinned (non-empty) or carry
 *    the explicit {@link UPDATE_TRUST_ROOTS_DEVELOPMENT_MARKER};
 * 6. the P3-3 anti-rollback state file is wired into both Electron call
 *    sites (version check through the adapter, installer download through
 *    the verification options).
 *
 * @param sources - repository sources to assert against.
 * @returns Nothing; failure throws before the application is signed.
 */
export function verifyCompanyReleaseChecklist(sources: CompanyReleaseChecklistSources): void {
  const fuseKeys = Object.keys(sources.manifestFuses).sort()
  const requiredKeys = Object.keys(REQUIRED_ELECTRON_FUSES).sort()
  const unexpected = fuseKeys.filter(key => !requiredKeys.includes(key))
  const absent = requiredKeys.filter(key => !fuseKeys.includes(key))
  if (unexpected.length > 0 || absent.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: the release fuse stage must declare exactly ${requiredKeys.join(', ')}; unexpected: ${unexpected.join(', ') || 'none'}; missing: ${absent.join(', ') || 'none'}`,
    )
  }
  verifyElectronFuseStage(sources.manifestFuses)

  const policy = sources.releasePolicy
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)
    || (policy as { locked?: unknown }).locked !== true) {
    throw new Error(
      'dsh-plugin-desktop: src/policy/desktop-policy.release.json must exist with locked=true for release builds',
    )
  }

  // P3 fix: the checklist no longer takes the repository variant on faith — it
  // asserts the document actually packaged into the application tree is the
  // same locked release policy (read from the physical mirror; see
  // readCompanyReleaseChecklistSources for why that is sufficient).
  const packagedPolicy = sources.packagedPolicy
  if (typeof packagedPolicy !== 'object' || packagedPolicy === null || Array.isArray(packagedPolicy)
    || (packagedPolicy as { locked?: unknown }).locked !== true) {
    throw new Error(
      'dsh-plugin-desktop: app.asar.unpacked/lib/policy/desktop-policy.json must exist with locked=true for release builds',
    )
  }
  if (canonicalJsonText(packagedPolicy) !== canonicalJsonText(policy)) {
    throw new Error(
      'dsh-plugin-desktop: the packaged policy asset differs from src/policy/desktop-policy.release.json; a release build must embed the locked release variant',
    )
  }

  // The signed company catalog must be constructible: empty policy trust
  // roots leave the locked market browsing a placeholder with every install
  // rejected, so an unprovisioned release candidate fails here (P0②).
  const catalogPolicy = checklistCatalogPolicy(
    policy,
    'src/policy/desktop-policy.release.json',
  )
  if (catalogPolicy.trustRoots.length === 0) {
    throw new Error(
      'dsh-plugin-desktop: src/policy/desktop-policy.release.json must provision at least one catalog trust root; empty trustRoots leave the locked market unusable',
    )
  }
  if (catalogPolicy.companyCatalogOrigin === null) {
    const segments = catalogPolicy.companyManifestUrl.split('/')
    if (catalogPolicy.companyManifestUrl.startsWith('/')
      || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new Error(
        'dsh-plugin-desktop: content-mode release policies must pin companyManifestUrl to a relative bundled asset path',
      )
    }
    const relativeAsset = `lib/${catalogPolicy.companyManifestUrl}`
    if (sources.packagedManifestText === undefined) {
      throw new Error(
        `dsh-plugin-desktop: content-mode release builds must embed the company catalog manifest at app.asar.unpacked/${relativeAsset}`,
      )
    }
    // Verify the embedded manifest against the policy roots through the
    // market signing library: expiry and signature failures fail the build;
    // the sequence ratchet is build-time stateless and stays unchecked.
    const verification = verifyCompanyManifest(sources.packagedManifestText, {
      trustRoots: catalogPolicy.trustRoots,
    })
    if (!verification.ok) {
      throw new Error(
        `dsh-plugin-desktop: the packaged company catalog manifest (${relativeAsset}) did not verify against the policy trust roots (${verification.code}): ${verification.reason}`,
      )
    }
  }

  // The declaration may span multiple lines: capture from the `=` up to the
  // first closing bracket (the type annotation's `[]` is skipped by requiring
  // the assignment first) plus the rest of that line, so a multi-line
  // `ARTIFACT_TRUST_ROOTS` array cannot slip past the empty-placeholder marker
  // check on a line-boundary technicality.
  const trustRootsDeclaration
    = /^export const ARTIFACT_TRUST_ROOTS\b[^\n=]*=[\s\S]*?\][^\n]*$/mu.exec(sources.updateVerificationSource)?.[0]
  if (trustRootsDeclaration === undefined) {
    throw new Error(
      'dsh-plugin-desktop: src/update-verification.ts no longer declares ARTIFACT_TRUST_ROOTS',
    )
  }
  const emptyTrustRoots = /=\s*\[\s*\]/u.test(trustRootsDeclaration)
  if (emptyTrustRoots && !trustRootsDeclaration.includes(UPDATE_TRUST_ROOTS_DEVELOPMENT_MARKER)) {
    throw new Error(
      `dsh-plugin-desktop: the empty ARTIFACT_TRUST_ROOTS placeholder must carry the explicit "${UPDATE_TRUST_ROOTS_DEVELOPMENT_MARKER}" marker or pinned release keys`,
    )
  }

  const sequenceAdapterWired = sources.electronRuntimeSource.includes('get sequenceStatePath()')
    && sources.electronRuntimeSource.includes("desktopUpdateSequenceStatePath(app.getPath('userData'))")
    && sources.electronRuntimeSource.includes('verification: { sequenceStatePath }')
  const sequenceCheckWired = sources.updateLifecycleSource
    .includes('updateChannel: { sequenceStatePath: this.options.adapter.sequenceStatePath }')
  if (!sequenceAdapterWired || !sequenceCheckWired) {
    throw new Error(
      'dsh-plugin-desktop: the update-manifest sequence state file must stay wired into the Electron adapter and both update call sites',
    )
  }
}

/** Normalize the host-specific separators emitted by the ASAR reader. */
function normalizeArchiveEntry(entry: string): string {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * Inspect one archive and reject an incomplete packaged runtime.
 * @param archivePath - resolved app.asar path.
 * @param list - ASAR listing implementation.
 * @returns The normalized archive entry set for physical mirror verification.
 */
export function verifyPackagedAsar(
  archivePath: string,
  list: ArchiveLister = listPackage,
): ReadonlySet<string> {
  let entries: readonly string[]
  try {
    entries = list(archivePath, { isPack: false })
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: failed to inspect packaged runtime at ${archivePath}`,
      { cause },
    )
  }

  const present = new Set(entries.map(normalizeArchiveEntry))
  const required = [
    ...REQUIRED_PACKAGED_RUNTIME_ENTRIES,
    ...REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES,
  ]
  const missing = required.filter(entry => !present.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${archivePath} is missing required ASAR entries: ${missing.join(', ')}`,
    )
  }
  return present
}

/**
 * Require the exact P3-2 partition between the ASAR archive and its physical
 * unpacked mirror.
 *
 * Every archive entry under the application runtime (`lib/`, `node_modules/`,
 * the root manifest, and the Cordis patch) must also exist physically under
 * `app.asar.unpacked`: profile-fallback symlinks and the bundled-Node
 * subprocess entries (`dsh` bootstrap, pnpm, the diagnostics Worker) cannot
 * read virtual ASAR paths, and `process.dlopen` needs real native files.
 * Checking the complete header closes the gap left by a curated entry list:
 * a collector regression cannot silently omit transitive packages such as
 * yaml, zod, or typebox from app.asar.unpacked.
 *
 * The inverse direction is pinned by {@link verifyArchiveOnlyPartition}:
 * archive-only prefixes (`build/`) must never grow a physical mirror.
 */
export function verifyUnpackedArchiveMirror(
  archiveEntries: ReadonlySet<string>,
  unpackedRoot: string,
  exists: FileProbe = existsSync,
): void {
  const missing = [...archiveEntries]
    .filter(entry => entry.length > 0
      && !isArchiveOnlyRuntimeEntry(entry)
      && !exists(join(unpackedRoot, entry)))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: unpacked runtime at ${unpackedRoot} is missing ASAR-declared physical entries: ${missing.join(', ')}`,
    )
  }
}

/**
 * Pin the shrunk side of the P3-2 partition: the archive-only entries must
 * exist inside app.asar and must not exist as physical unpacked files. A
 * regression that reintroduces `build/**` into `asarUnpack` fails here
 * instead of silently widening the plaintext surface.
 */
export function verifyArchiveOnlyPartition(
  unpackedRoot: string,
  exists: FileProbe = existsSync,
  entries: readonly string[] = REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES,
): void {
  const leaked = entries.filter(entry => exists(join(unpackedRoot, entry)))
  if (leaked.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: archive-only runtime entries leaked into the physical tree at ${unpackedRoot}: ${leaked.join(', ')}`,
    )
  }
}

/**
 * Verify package exports resolve through the physical tree instead of the build workspace.
 * @param unpackedRoot - absolute path to app.asar.unpacked.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects missing exports and paths outside app.asar.unpacked.
 */
export function verifyUnpackedPackageResolution(
  unpackedRoot: string,
  resolvePackage: PackageResolver = createRequire(join(unpackedRoot, 'package.json')).resolve,
): void {
  for (const specifier of REQUIRED_UNPACKED_PACKAGE_SPECIFIERS) {
    let resolvedPath: string
    try {
      resolvedPath = resolvePackage(specifier)
    } catch (cause) {
      throw new Error(
        `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} cannot resolve required package export ${specifier}`,
        { cause },
      )
    }

    const relativePath = relative(unpackedRoot, resolvedPath)
    if (
      !isAbsolute(resolvedPath)
      || relativePath === '..'
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      throw new Error(
        `dsh-plugin-desktop: required package export ${specifier} resolved outside ${unpackedRoot}: ${resolvedPath}`,
      )
    }
  }
}

/**
 * Verify Electron Builder's completed application before signing begins.
 * @param context - Electron Builder's afterPack context.
 * @param list - ASAR listing implementation.
 * @param exists - physical-file probe for the unpacked CLI dependency tree.
 * @param resolvePackage - package resolver anchored at the physical root manifest.
 * @returns Nothing; failure rejects the package before signing.
 */
export function verifyPackagedRuntime(
  context: PackagedRuntimeContext,
  list: ArchiveLister = listPackage,
  exists: FileProbe = existsSync,
  resolvePackage?: PackageResolver,
): void {
  const archiveEntries = verifyPackagedAsar(resolvePackagedAsarPath(context), list)
  const unpackedRoot = resolvePackagedUnpackedRoot(context)
  const requiredPhysicalEntries = context.electronPlatformName === 'win32'
    ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES]
    : context.electronPlatformName === 'darwin' && context.arch === 4
      ? [...REQUIRED_UNPACKED_RUNTIME_ENTRIES, ...REQUIRED_MACOS_UNIVERSAL_ENTRIES]
      : REQUIRED_UNPACKED_RUNTIME_ENTRIES
  const missing = requiredPhysicalEntries.filter(entry => !exists(join(unpackedRoot, entry)))
  if (missing.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: packaged runtime at ${unpackedRoot} is missing required physical entries: ${missing.join(', ')}`,
    )
  }
  if (context.electronPlatformName === 'darwin' && context.arch === 4) {
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .filter(entry => exists(join(unpackedRoot, entry)))
    if (forbidden.length > 0) {
      throw new Error(
        `dsh-plugin-desktop: universal macOS runtime at ${unpackedRoot} contains host-architecture build output: ${forbidden.join(', ')}`,
      )
    }
  }
  verifyUnpackedArchiveMirror(archiveEntries, unpackedRoot, exists)
  verifyArchiveOnlyPartition(unpackedRoot, exists)
  verifyUnpackedPackageResolution(unpackedRoot, resolvePackage)
}

/** Injectable seams for the packaged application probes afterPack runs. */
export interface PackagedRuntimeProbe {
  /** Physical-file probe for the bundled Node command; defaults to `existsSync`. */
  readonly exists?: FileProbe
  /** Fuse map the shipped application configures; defaults to the build configuration. */
  readonly readFuses?: () => Readonly<Record<string, unknown>>
  /** Fuse-wire reader for the packaged application binary; defaults to `@electron/fuses`. */
  readonly readFuseWire?: PackagedFuseWireReader
  /** Fuse-wire flipper for the packaged application binary; defaults to `@electron/fuses`. */
  readonly flipFuseWire?: PackagedFuseFlipper
}

/** Run the company release checklist against the repository and packaged trees. */
function defaultCompanyReleaseChecklist(
  context: PackagedRuntimeContext,
): () => void {
  return () => {
    verifyCompanyReleaseChecklist(readCompanyReleaseChecklistSources(context))
  }
}

/**
 * Run the static packaged-runtime check as Electron Builder's afterPack hook.
 * @param context - Electron Builder's afterPack context.
 * @param verify - static archive and physical-tree verifier.
 * @param smoke - diagnostic Worker smoke launcher.
 * @param probe - injectable seams for the bundled-Node and fuse-stage checks.
 * @param checklist - company release-build checklist; defaults to the repository and packaged sources.
 * @returns A promise that rejects before signing when the runtime is incomplete.
 */
export async function afterPack(
  context: PackagedRuntimeContext,
  verify: typeof verifyPackagedRuntime = verifyPackagedRuntime,
  smoke: PackagedDiagnosticWorkerSmoke = smokePackagedDiagnosticWorker,
  probe: PackagedRuntimeProbe = {},
  checklist: () => void = defaultCompanyReleaseChecklist(context),
): Promise<void> {
  verify(context)
  verifyBundledNodeRuntime(context, probe.exists ?? existsSync)
  verifyElectronFuseStage(
    (probe.readFuses ?? (() => readPackagedElectronFuses(context.packager)))(),
  )
  // Configuration check above, then the hook stages the required wire itself
  // (Electron Builder flips only after custom hooks) and reads the shipped
  // executable back before signing begins.
  await verifyPackagedFuseWire(context, probe.readFuseWire, probe.flipFuseWire)
  checklist()
  await smoke(resolvePackagedUnpackedRoot(context))
}

export default afterPack
