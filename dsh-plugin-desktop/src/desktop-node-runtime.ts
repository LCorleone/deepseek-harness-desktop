/** Resolution of the Node command bundled beside the packaged application. */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archivedAsarPath, isPackagedApplicationPath } from './packaged-runtime-path.ts'

/** Directory extraResources places the pinned Node distribution into. */
const BUNDLED_NODE_DIRECTORY = 'node-runtime'

/**
 * Build-time digest manifest shipped at `lib/node-runtime-sha256.json`.
 *
 * `beforePack` generates it from the pinned archives (see
 * `scripts/bundled-node.ts`), so the digests are deterministic per pinned Node
 * version. The manifest is dual-homed like every `lib/**` asset, and the
 * runtime reads it through the in-archive path, which only the Electron
 * process can serve.
 */
export const BUNDLED_NODE_DIGEST_MANIFEST_NAME = 'node-runtime-sha256.json'

/** Parsed contents of `lib/node-runtime-sha256.json`. */
export interface BundledNodeDigestManifest {
  /** Pinned Node version the digests were computed from. */
  readonly version: string
  /** Packaging platform (`darwin`, `win32`, `linux`) the manifest covers. */
  readonly platform: string
  /** sha256 digests of every Node command variant this platform ships. */
  readonly commands: Readonly<Record<string, string>>
}

/** Return the command name the bundled Node distribution installs as. */
export function bundledNodeCommandName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node'
}

/** Inputs controlling one Node-command resolution. */
export interface DesktopNodeRuntimeInputs {
  /** Host platform selecting the packaged command name and PATH dialect. */
  readonly platform: NodeJS.Platform
  /** Environment whose PATH is searched in the unpackaged development state. */
  readonly environment?: NodeJS.ProcessEnv
  /** Regular-file probe; production uses `statSync`. */
  readonly exists?: (filename: string) => boolean
  /** Digest-manifest reader; production reads the archive-side manifest. */
  readonly readDigestManifest?: (filename: string) => string
  /** Stat seam backing the verified-command cache; production uses `statSync`. */
  readonly statCommand?: (filename: string) => { readonly mtimeMs: number, readonly size: number }
  /** sha256 seam over one command file; production hashes with node:crypto. */
  readonly digestCommand?: (filename: string) => string
}

function isRegularFile(filename: string): boolean {
  try {
    return statSync(filename).isFile()
  } catch {
    return false
  }
}

/** Read PATH with Windows-compatible environment-name matching. */
function inheritedPathValue(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return environment.PATH ?? ''
  return Object.entries(environment)
    .find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

/**
 * Resolve the Node command bundled beside this module's packaged tree.
 *
 * A packaged module lives at `<resources>/app.asar.unpacked/lib/<name>.js`, so
 * the physical bundle is `<resources>/node-runtime/<command>`; in an unpackaged
 * checkout the same computation points at a directory that does not exist and
 * callers fall back to the development PATH lookup below.
 * @param moduleUrl - URL of a module emitted below the package's `lib` directory.
 * @param platform - host platform selecting the packaged command name.
 * @returns the bundled Node command path for this application layout.
 */
export function packagedBundledNodePath(moduleUrl: string, platform: NodeJS.Platform): string {
  const moduleDirectory = dirname(fileURLToPath(new URL(moduleUrl)))
  return join(
    dirname(dirname(moduleDirectory)),
    BUNDLED_NODE_DIRECTORY,
    bundledNodeCommandName(platform),
  )
}

/**
 * Resolve the in-archive digest manifest beside a built module inside `lib/`.
 *
 * The manifest is read through the virtual `app.asar` path: only the Electron
 * process — the sole caller of {@link resolveDesktopNodeExecutable} — can
 * serve it, and the archive-side copy is the one the packaged-runtime gate
 * pins. Outside a package the path simply points at the development `lib/`.
 * @param moduleUrl - URL of a module emitted below the package's `lib` directory.
 * @returns the digest-manifest path for this application layout.
 */
export function bundledNodeDigestManifestPath(moduleUrl: string): string {
  return join(
    dirname(archivedAsarPath(fileURLToPath(new URL(moduleUrl)))),
    BUNDLED_NODE_DIGEST_MANIFEST_NAME,
  )
}

/** Whether one module URL belongs to a packaged application tree. */
export function isPackagedModuleUrl(moduleUrl: string): boolean {
  return isPackagedApplicationPath(fileURLToPath(new URL(moduleUrl)))
}

/** Strictly parse one digest manifest document; every deviation throws. */
export function parseBundledNodeDigestManifest(value: unknown): BundledNodeDigestManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('dsh-plugin-desktop: bundled Node digest manifest must be an object')
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.length !== 3 || keys[0] !== 'commands' || keys[1] !== 'platform' || keys[2] !== 'version') {
    throw new Error('dsh-plugin-desktop: bundled Node digest manifest has unexpected fields')
  }
  if (typeof object.version !== 'string' || object.version.length === 0) {
    throw new Error('dsh-plugin-desktop: bundled Node digest manifest version must be a non-empty string')
  }
  if (typeof object.platform !== 'string' || object.platform.length === 0) {
    throw new Error('dsh-plugin-desktop: bundled Node digest manifest platform must be a non-empty string')
  }
  const commands = object.commands
  if (commands === null || typeof commands !== 'object' || Array.isArray(commands)) {
    throw new Error('dsh-plugin-desktop: bundled Node digest manifest commands must be an object')
  }
  const entries = Object.entries(commands as Record<string, unknown>)
  if (entries.length === 0) {
    throw new Error('dsh-plugin-desktop: bundled Node digest manifest commands must not be empty')
  }
  const parsed: Record<string, string> = {}
  for (const [target, digest] of entries) {
    if (target.length === 0 || typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error(
        `dsh-plugin-desktop: bundled Node digest manifest entry ${JSON.stringify(target)} must pin a sha256 hex digest`,
      )
    }
    parsed[target] = digest
  }
  return Object.freeze({ version: object.version, platform: object.platform, commands: Object.freeze(parsed) })
}

/** File identity of one verified bundled Node command. */
interface VerifiedCommandFingerprint {
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Verified-command cache: `(mtime, size)` per command path. Hashing the
 * roughly 80–120 MiB distribution on every child spawn would dominate the
 * launch path, so an unchanged file is trusted after its first verification.
 */
const verifiedBundledNodeCommands = new Map<string, VerifiedCommandFingerprint>()

/** Reset the verified-command cache; used by focused tests. */
export function clearBundledNodeCommandVerificationCache(): void {
  verifiedBundledNodeCommands.clear()
}

function readDigestManifestFile(filename: string): string {
  return readFileSync(filename, 'utf8')
}

function statCommandFile(filename: string): { readonly mtimeMs: number, readonly size: number } {
  const stats = statSync(filename)
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

function digestCommandFile(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

/**
 * Verify one bundled Node command against the packaged digest manifest.
 *
 * Advisory positioning (P3 fix): the manifest raises the cost of tampering
 * with the user-writable `resources/node-runtime` command — a swapped binary
 * must now be accompanied by a consistent rewrite of the shipped manifest
 * inside the application tree, which is a far more conspicuous edit than
 * replacing one file in `resources`. It is not a boundary: an actor who can
 * rewrite both files has the same permission as rewriting application
 * JavaScript, and a binding guarantee needs platform code signing.
 * @param moduleUrl - module URL locating the archive-side manifest.
 * @param commandPath - bundled Node command the caller resolved.
 * @param inputs - injectable manifest, stat, and digest seams.
 */
function verifyBundledNodeCommandIntegrity(
  moduleUrl: string,
  commandPath: string,
  inputs: DesktopNodeRuntimeInputs,
): void {
  const manifestPath = bundledNodeDigestManifestPath(moduleUrl)
  let manifestText: string
  try {
    manifestText = (inputs.readDigestManifest ?? readDigestManifestFile)(manifestPath)
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: the packaged digest manifest is unreadable at ${manifestPath}: `
      + `${cause instanceof Error ? cause.message : String(cause)}; packaged applications ship `
      + `${BUNDLED_NODE_DIGEST_MANIFEST_NAME} beside lib/, so reinstall DSH Desktop`,
    )
  }
  let manifest: BundledNodeDigestManifest
  try {
    manifest = parseBundledNodeDigestManifest(JSON.parse(manifestText) as unknown)
  } catch (cause) {
    throw new Error(
      `dsh-plugin-desktop: invalid bundled Node digest manifest at ${manifestPath}: `
      + `${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (manifest.platform !== inputs.platform) {
    throw new Error(
      `dsh-plugin-desktop: bundled Node digest manifest at ${manifestPath} covers platform `
      + `${JSON.stringify(manifest.platform)} but this application runs on ${inputs.platform}`,
    )
  }
  const stat = inputs.statCommand ?? statCommandFile
  const identity = stat(commandPath)
  const verified = verifiedBundledNodeCommands.get(commandPath)
  if (verified !== undefined && verified.mtimeMs === identity.mtimeMs && verified.size === identity.size) {
    return
  }
  const digest = (inputs.digestCommand ?? digestCommandFile)(commandPath)
  if (!Object.values(manifest.commands).includes(digest)) {
    throw new Error(
      `dsh-plugin-desktop: the bundled Node command ${commandPath} hashed to ${digest}, which the `
      + `packaged digest manifest at ${manifestPath} does not pin (Node v${manifest.version}); `
      + 'refusing to execute it — reinstall DSH Desktop',
    )
  }
  verifiedBundledNodeCommands.set(commandPath, { mtimeMs: identity.mtimeMs, size: identity.size })
}

/** Find one command name on PATH without trusting a command interpreter. */
function commandOnPath(
  command: string,
  inputs: DesktopNodeRuntimeInputs,
  exists: (filename: string) => boolean,
): string | undefined {
  const environment = inputs.environment ?? process.env
  const delimiter = inputs.platform === 'win32' ? ';' : ':'
  for (const rawDirectory of inheritedPathValue(environment, inputs.platform).split(delimiter)) {
    const directory = inputs.platform === 'win32'
      && rawDirectory.startsWith('"')
      && rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory
    if (directory.length === 0) continue
    const candidate = join(directory, command)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the Node command this application runs package-manager and CLI
 * children with.
 *
 * The packaged application always uses the Node distribution bundled under
 * `resources/node-runtime` and fail-loud verifies it against the packaged
 * digest manifest before handing it to a child; a packaged build whose
 * bundled command is missing refuses to run instead of quietly falling back
 * to an uncontrolled PATH lookup. An unpackaged development checkout instead
 * reuses the Node command its environment already provides, matching the
 * dual-state resolution `packaged-runtime-path.ts` applies to packaged
 * dependencies.
 * @param moduleUrl - URL of a module emitted below the package's `lib` directory.
 * @param inputs - platform, environment, and file-probe seams.
 * @returns an absolute Node command path; never a PATH-resolved bare name.
 */
export function resolveDesktopNodeExecutable(
  moduleUrl: string,
  inputs: DesktopNodeRuntimeInputs,
): string {
  const exists = inputs.exists ?? isRegularFile
  if (isPackagedModuleUrl(moduleUrl)) {
    const packaged = packagedBundledNodePath(moduleUrl, inputs.platform)
    if (!exists(packaged)) {
      throw new Error(
        `dsh-plugin-desktop: the packaged application is missing its bundled Node command at `
        + `${packaged}; reinstall DSH Desktop`,
      )
    }
    verifyBundledNodeCommandIntegrity(moduleUrl, packaged, inputs)
    return packaged
  }
  const development = commandOnPath(bundledNodeCommandName(inputs.platform), inputs, exists)
  if (development !== undefined) return development
  throw new Error(
    'dsh-plugin-desktop: no Node command is available; packaged applications bundle one under '
    + `resources/${BUNDLED_NODE_DIRECTORY}, and an unpackaged development run needs node on PATH`,
  )
}
