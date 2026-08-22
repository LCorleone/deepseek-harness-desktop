/**
 * Pinned Node distributions bundled beside the packaged application.
 *
 * The desktop application never reuses its Electron executable as Node: the
 * packaging step stages a real Node command under `build/node-runtime`, the
 * `extraResources` mapping copies it to `resources/node-runtime`, and every
 * package-manager or CLI child runs it instead of enabling Electron's
 * RunAsNode mode. Because the archive bytes cross the network, each target is
 * pinned to an exact version and SHA-256 checksum from nodejs.org.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

/** Node release every supported target pins. */
export const BUNDLED_NODE_VERSION = '22.23.2'

/** Trusted origin every pinned archive downloads from. */
export const BUNDLED_NODE_DIST_ORIGIN = 'https://nodejs.org/dist'

/** Platform-architecture targets the desktop application packages. */
export type BundledNodeTarget
  = 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'win-x64'

/** One pinned distribution archive. */
export interface BundledNodeDistribution {
  /** Archive filename below {@link BUNDLED_NODE_DIST_ORIGIN}/v<version>. */
  readonly archive: string
  /** SHA-256 of the archive bytes, from the release SHASUMS256.txt. */
  readonly sha256: string
  /** Archive member carrying the Node command. */
  readonly member: string
}

/** Pinned archives for every supported packaging target. */
export const BUNDLED_NODE_DISTRIBUTIONS = {
  'darwin-arm64': {
    archive: `node-v${BUNDLED_NODE_VERSION}-darwin-arm64.tar.gz`,
    sha256: '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
    member: `node-v${BUNDLED_NODE_VERSION}-darwin-arm64/bin/node`,
  },
  'darwin-x64': {
    archive: `node-v${BUNDLED_NODE_VERSION}-darwin-x64.tar.gz`,
    sha256: '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
    member: `node-v${BUNDLED_NODE_VERSION}-darwin-x64/bin/node`,
  },
  'linux-x64': {
    archive: `node-v${BUNDLED_NODE_VERSION}-linux-x64.tar.gz`,
    sha256: 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a',
    member: `node-v${BUNDLED_NODE_VERSION}-linux-x64/bin/node`,
  },
  'win-x64': {
    archive: `node-v${BUNDLED_NODE_VERSION}-win-x64.zip`,
    sha256: '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97',
    member: 'node.exe',
  },
} as const satisfies Record<BundledNodeTarget, BundledNodeDistribution>

/** Largest archive accepted from the pinned origin, guarding decompression bombs. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** Mode applied to the staged Node command. */
const NODE_COMMAND_MODE = 0o755

/** Absolute repository location of this script's package. */
const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Map one packaging platform and architecture onto a pinned target. */
export function bundledNodeTarget(
  platform: NodeJS.Platform,
  arch: string,
): BundledNodeTarget {
  const target = `${platform === 'win32' ? 'win' : platform}-${arch}`
  if (target in BUNDLED_NODE_DISTRIBUTIONS) return target as BundledNodeTarget
  throw new Error(`dsh-plugin-desktop: no pinned Node distribution for ${target}`)
}

/** Absolute download URL of one pinned archive. */
export function bundledNodeArchiveUrl(target: BundledNodeTarget): string {
  return `${BUNDLED_NODE_DIST_ORIGIN}/v${BUNDLED_NODE_VERSION}/${BUNDLED_NODE_DISTRIBUTIONS[target].archive}`
}

/** Verify archive bytes against the pinned SHA-256 checksum. */
export function verifyBundledNodeArchive(
  target: BundledNodeTarget,
  archivePath: string,
  readFile: (filename: string) => Buffer = readFileSync,
): void {
  const pinned = BUNDLED_NODE_DISTRIBUTIONS[target]
  const digest = createHash('sha256').update(readFile(archivePath)).digest('hex')
  if (digest !== pinned.sha256) {
    throw new Error(
      `dsh-plugin-desktop: bundled Node archive ${archivePath} hashed to ${digest} instead of the pinned ${pinned.sha256}`,
    )
  }
}

/** Checksum verifier seam used by focused tests. */
export type BundledNodeArchiveVerifier = (
  target: BundledNodeTarget,
  archivePath: string,
) => void

/** Streams one HTTPS response body to a file while bounding its size. */
async function writeResponseToFile(
  response: Response,
  archivePath: string,
): Promise<void> {
  const body = response.body
  if (body === null) {
    throw new Error(`dsh-plugin-desktop: bundled Node download returned no body for ${archivePath}`)
  }
  const source = Readable.fromWeb(body as unknown as NodeWebReadableStream)
  await new Promise<void>((resolveStream, reject) => {
    const sink = createWriteStream(archivePath)
    let written = 0
    source.on('data', (chunk: Buffer) => {
      written += chunk.byteLength
      if (written > MAX_ARCHIVE_BYTES) {
        source.destroy()
        sink.destroy()
        reject(new Error(
          `dsh-plugin-desktop: bundled Node download exceeded ${String(MAX_ARCHIVE_BYTES)} bytes`,
        ))
      }
    })
    source.on('error', cause => { sink.destroy(); reject(cause) })
    sink.on('error', cause => reject(cause))
    sink.on('finish', () => resolveStream())
    source.pipe(sink)
  })
}

/** Download one pinned archive unless the cache already holds its exact bytes. */
export async function downloadBundledNodeArchive(
  target: BundledNodeTarget,
  archivePath: string,
  fetchArchive: (url: string) => Promise<Response> = fetch,
  verify: BundledNodeArchiveVerifier = (selectedTarget, path) => verifyBundledNodeArchive(selectedTarget, path),
): Promise<void> {
  if (existsSync(archivePath)) {
    try {
      verify(target, archivePath)
      return
    } catch {
      // A partial or tampered cache entry is replaced, never reused.
    }
  }
  const url = bundledNodeArchiveUrl(target)
  const response = await fetchArchive(url)
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: bundled Node download ${url} failed with ${String(response.status)}`)
  }
  mkdirSync(dirname(archivePath), { recursive: true })
  await writeResponseToFile(response, archivePath)
  verify(target, archivePath)
}

/** Extract only the pinned Node command into a freshly prepared staging directory. */
export function extractBundledNodeCommand(
  target: BundledNodeTarget,
  archivePath: string,
  stagingDirectory: string,
  runTar: (archivePath: string, stagingDirectory: string, member: string) => void = runTarExtraction,
): string {
  const pinned = BUNDLED_NODE_DISTRIBUTIONS[target]
  rmSync(stagingDirectory, { recursive: true, force: true })
  mkdirSync(stagingDirectory, { recursive: true })
  if (target === 'win-x64') {
    new AdmZip(archivePath).extractEntryTo(pinned.member, stagingDirectory, false, true)
  } else {
    runTar(archivePath, stagingDirectory, pinned.member)
  }
  const commandName = target === 'win-x64' ? 'node.exe' : 'node'
  const commandPath = join(stagingDirectory, commandName)
  if (!statSync(commandPath).isFile()) {
    throw new Error(`dsh-plugin-desktop: bundled Node archive ${archivePath} did not provide ${commandName}`)
  }
  chmodSync(commandPath, NODE_COMMAND_MODE)
  return commandPath
}

/** Extract one tar member below its `bin/` directory using the system tar. */
function runTarExtraction(archivePath: string, stagingDirectory: string, member: string): void {
  const result = spawnSync('tar', [
    '-xzf',
    archivePath,
    '-C',
    stagingDirectory,
    '--strip-components',
    '2',
    member,
  ])
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`dsh-plugin-desktop: tar extraction of ${archivePath} exited ${String(result.status)}`)
  }
}

/** Inputs controlling one staging run. */
export interface BundledNodePreparationOptions {
  /** Desktop package root containing `build/`. */
  readonly desktopRoot: string
  /** Electron Builder platform name. */
  readonly platform: NodeJS.Platform
  /** Packaging architecture name. */
  readonly arch: string
  /** Download cache; defaults to `build/node-runtime-cache`. */
  readonly cacheDirectory?: string
  /** Staging directory `extraResources` copies; defaults to `build/node-runtime`. */
  readonly stagingDirectory?: string
  /** Fetch seam used by focused tests. */
  readonly fetchArchive?: (url: string) => Promise<Response>
  /** Checksum verifier seam used by focused tests. */
  readonly verifyArchive?: BundledNodeArchiveVerifier
  /** tar seam used by focused tests. */
  readonly runTar?: (archivePath: string, stagingDirectory: string, member: string) => void
  /** Progress reporter. */
  readonly log?: (message: string) => void
}

/**
 * Stage the pinned Node command for one packaging target.
 *
 * `DSH_BUNDLED_NODE_ARCHIVE` may point at a pre-downloaded archive for the
 * requested target; its bytes still have to match the pinned checksum.
 * @param options - target identity and injectable filesystem/network seams.
 * @returns the staged Node command path inside the staging directory.
 */
export async function prepareBundledNode(
  options: BundledNodePreparationOptions,
): Promise<string> {
  const target = bundledNodeTarget(options.platform, options.arch)
  const cacheDirectory = options.cacheDirectory ?? join(options.desktopRoot, 'build', 'node-runtime-cache')
  const stagingDirectory = options.stagingDirectory ?? join(options.desktopRoot, 'build', 'node-runtime')
  const pinned = BUNDLED_NODE_DISTRIBUTIONS[target]
  const override = process.env.DSH_BUNDLED_NODE_ARCHIVE
  const archivePath = override !== undefined && override.length > 0
    ? override
    : join(cacheDirectory, pinned.archive)
  const verify = options.verifyArchive
    ?? ((selectedTarget: BundledNodeTarget, path: string) => verifyBundledNodeArchive(selectedTarget, path))
  options.log?.(`dsh-plugin-desktop: staging bundled Node v${BUNDLED_NODE_VERSION} for ${target}`)
  if (override === undefined || override.length === 0) {
    await downloadBundledNodeArchive(
      target,
      archivePath,
      options.fetchArchive ?? fetch,
      verify,
    )
  } else {
    verify(target, archivePath)
  }
  return extractBundledNodeCommand(
    target,
    archivePath,
    stagingDirectory,
    options.runTar,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const platformArgument = process.argv.find(argument => argument.startsWith('--platform='))
    const archArgument = process.argv.find(argument => argument.startsWith('--arch='))
    const staged = await prepareBundledNode({
      desktopRoot: DESKTOP_ROOT,
      platform: (platformArgument === undefined ? process.platform : platformArgument.slice('--platform='.length)) as NodeJS.Platform,
      arch: archArgument === undefined ? process.arch : archArgument.slice('--arch='.length),
      log: message => console.log(message),
    })
    console.log(staged)
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
