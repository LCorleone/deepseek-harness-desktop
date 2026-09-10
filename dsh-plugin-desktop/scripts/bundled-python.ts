/**
 * Pinned Windows embeddable CPython distribution bundled beside the packaged
 * application.
 *
 * Company machines ship no Python, so the Windows package carries the
 * official `python-<version>-embed-amd64.zip` under `build/python-runtime`;
 * the `extraResources` mapping copies it to `resources/python-runtime`, and
 * the generated `python`/`python3`/`py` command aliases execute it. Because
 * the archive bytes cross the network, the single supported target is pinned
 * to an exact CPython patch release and SHA-256 checksum from python.org.
 *
 * The embeddable distribution ships without pip (and without the ensurepip
 * machinery `python -m venv` needs), so staging bootstraps it in place: a
 * sha256-pinned `get-pip.py` from bootstrap.pypa.io installs pip into the
 * staged tree, and pip then installs a pinned `virtualenv` from PyPI — the
 * interpreter replacement for `python -m venv`, which the workspace `.venv`
 * convention builds on. Strict staging order: extract and checksum-verify
 * the archive, unlock the `._pth` site machinery, bootstrap pip+virtualenv,
 * and only then generate the digest manifest — the manifest must cover the
 * final tree, bootstrap artifacts included.
 *
 * Unlike the bundled Node runtime (one command file), Python is a directory
 * tree, so the digest manifest pins every staged file: staging walks the
 * extracted tree and writes `lib/python-runtime-sha256.json` as a relative
 * path → sha256 table the packaged runtime verifies fail-closed.
 */

import { spawn } from 'node:child_process'

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

/** CPython release every supported target pins (last 3.12 with binary artifacts; later 3.12.x are source-only security releases). */
export const BUNDLED_PYTHON_VERSION = '3.12.10'

/** Trusted origin every pinned archive downloads from. */
export const BUNDLED_PYTHON_DIST_ORIGIN = 'https://www.python.org/ftp/python'

/** Filename of the pinned embeddable archive below {@link BUNDLED_PYTHON_DIST_ORIGIN}/<version>. */
export const BUNDLED_PYTHON_ARCHIVE = `python-${BUNDLED_PYTHON_VERSION}-embed-amd64.zip`

/** SHA-256 of the pinned archive bytes, computed from the python.org download. */
export const BUNDLED_PYTHON_ARCHIVE_SHA256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'

/** Trusted origin of the pinned pip bootstrap script. */
export const BUNDLED_PYTHON_GETPIP_ORIGIN = 'https://bootstrap.pypa.io'

/** URL of the pinned `get-pip.py`; the embeddable distribution ships no pip. */
export const BUNDLED_PYTHON_GETPIP_URL = `${BUNDLED_PYTHON_GETPIP_ORIGIN}/get-pip.py`

/**
 * SHA-256 of the pinned `get-pip.py` bytes (an embedded pip 26.2.1 payload).
 *
 * bootstrap.pypa.io serves the current release at this URL, so the pin both
 * freezes the bytes and fails loud the day upstream rotates the file: a
 * cache-miss download that no longer matches aborts packaging until someone
 * re-pins deliberately — the same trade the python.org archive pin makes.
 */
export const BUNDLED_PYTHON_GETPIP_SHA256 = 'fb24e693bab954209a063d90953621412ccad4a500905a726286e038f508ddf6'

/** Cache member name of the pinned bootstrap script below the archive cache. */
export const BUNDLED_PYTHON_GETPIP_CACHE_NAME = 'get-pip.py'

/**
 * virtualenv version staged beside pip. `python -m venv` cannot replace it:
 * the embeddable distribution has no ensurepip, so virtualenv creates the
 * workspace `.venv` environments the agent preset prescribes.
 */
export const BUNDLED_PYTHON_VIRTUALENV_VERSION = '21.7.9'

/** Marker file the pip bootstrap must leave in the staged tree. */
export const BUNDLED_PYTHON_PIP_PACKAGE_FILE = 'Lib/site-packages/pip/__init__.py'

/** Marker file the virtualenv install must leave in the staged tree. */
export const BUNDLED_PYTHON_VIRTUALENV_PACKAGE_FILE = 'Lib/site-packages/virtualenv/__init__.py'

/** Command the staged distribution installs as. */
export const BUNDLED_PYTHON_COMMAND_NAME = 'python.exe'

/**
 * Path-configuration member whose commented `import site` line staging
 * unlocks.
 *
 * The embeddable distribution isolates itself through `._pth`: while the file
 * exists, Python ignores `PYTHON*` environment path configuration and site
 * machinery. Staging replaces the shipped `#import site` comment with the
 * live `import site` line — the minimal upstream-supported unlock that keeps
 * the zipped standard library and prefix entries while letting `site.main()`
 * run (and, with it, later site-packages discovery). Standard library
 * completeness is guaranteed by shipping the whole tree, and `._pth`'s
 * ignoring of `PYTHONPATH` is kept deliberately so inherited machine state
 * cannot reshuffle the bundled interpreter's paths.
 */
export const BUNDLED_PYTHON_PTH_MEMBER = `python${BUNDLED_PYTHON_VERSION.split('.').slice(0, 2).join('')}._pth`

/** Filename of the digest manifest `beforePack` writes into `lib/`.
 *
 * The runtime counterpart lives in `src/desktop-python-runtime.ts`; both
 * sides treat the file as the pinned per-file digest table for the bundled
 * Python tree of one platform, generated at packaging time from the staged
 * tree — never hand-edited.
 */
export const BUNDLED_PYTHON_DIGEST_MANIFEST_NAME = 'python-runtime-sha256.json'

/** Largest archive accepted from the pinned origin, guarding decompression bombs. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** Hard deadline for one staged-python bootstrap command (get-pip or install). */
const BOOTSTRAP_COMMAND_TIMEOUT_MS = 300_000

/** Upper bound on bootstrap stderr retained for the failure message. */
const MAX_BOOTSTRAP_STDERR_BYTES = 64 * 1024

/** Absolute repository location of this script's package. */
const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The one platform-architecture target the Windows embeddable distribution serves. */
export type BundledPythonTarget = 'win-x64'

/** Map one packaging platform and architecture onto the pinned target. */
export function bundledPythonTarget(
  platform: NodeJS.Platform,
  arch: string,
): BundledPythonTarget {
  if (platform === 'win32' && arch === 'x64') return 'win-x64'
  throw new Error(`dsh-plugin-desktop: no pinned Python distribution for ${platform}-${arch}`)
}

/** Absolute download URL of the pinned archive. */
export function bundledPythonArchiveUrl(): string {
  return `${BUNDLED_PYTHON_DIST_ORIGIN}/${BUNDLED_PYTHON_VERSION}/${BUNDLED_PYTHON_ARCHIVE}`
}

/** sha256 of one file's bytes. */
function sha256File(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

/** Verify archive bytes against the pinned SHA-256 checksum. */
export function verifyBundledPythonArchive(
  archivePath: string,
  readFile: (filename: string) => Buffer = readFileSync,
): void {
  const digest = createHash('sha256').update(readFile(archivePath)).digest('hex')
  if (digest !== BUNDLED_PYTHON_ARCHIVE_SHA256) {
    throw new Error(
      `dsh-plugin-desktop: bundled Python archive ${archivePath} hashed to ${digest} instead of the pinned ${BUNDLED_PYTHON_ARCHIVE_SHA256}`,
    )
  }
}

/** Checksum verifier seam used by focused tests. */
export type BundledPythonArchiveVerifier = (archivePath: string) => void

/** Streams one HTTPS response body to a file while bounding its size. */
async function writeResponseToFile(
  response: Response,
  archivePath: string,
): Promise<void> {
  const body = response.body
  if (body === null) {
    throw new Error(`dsh-plugin-desktop: bundled Python download returned no body for ${archivePath}`)
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
          `dsh-plugin-desktop: bundled Python download exceeded ${String(MAX_ARCHIVE_BYTES)} bytes`,
        ))
      }
    })
    source.on('error', cause => { sink.destroy(); reject(cause) })
    sink.on('error', cause => reject(cause))
    sink.on('finish', () => resolveStream())
    source.pipe(sink)
  })
}

/** Download the pinned archive unless the cache already holds its exact bytes. */
export async function downloadBundledPythonArchive(
  archivePath: string,
  fetchArchive: (url: string) => Promise<Response> = fetch,
  verify: BundledPythonArchiveVerifier = path => verifyBundledPythonArchive(path),
): Promise<void> {
  if (existsSync(archivePath)) {
    try {
      verify(archivePath)
      return
    } catch {
      // A partial or tampered cache entry is replaced, never reused.
    }
  }
  const url = bundledPythonArchiveUrl()
  const response = await fetchArchive(url)
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: bundled Python download ${url} failed with ${String(response.status)}`)
  }
  mkdirSync(dirname(archivePath), { recursive: true })
  await writeResponseToFile(response, archivePath)
  verify(archivePath)
}

/** Verify bootstrap-script bytes against the pinned SHA-256 checksum. */
export function verifyBundledPythonGetPip(
  getpipPath: string,
  readFile: (filename: string) => Buffer = readFileSync,
): void {
  const digest = createHash('sha256').update(readFile(getpipPath)).digest('hex')
  if (digest !== BUNDLED_PYTHON_GETPIP_SHA256) {
    throw new Error(
      `dsh-plugin-desktop: bundled Python bootstrap script ${getpipPath} hashed to ${digest} instead of the pinned ${BUNDLED_PYTHON_GETPIP_SHA256}`,
    )
  }
}

/** Checksum verifier seam for the bootstrap script, mirroring the archive one. */
export type BundledPythonGetPipVerifier = (getpipPath: string) => void

/** Download the pinned bootstrap script unless the cache already holds its exact bytes. */
export async function downloadBundledPythonGetPip(
  getpipPath: string,
  fetchGetPip: (url: string) => Promise<Response> = fetch,
  verify: BundledPythonGetPipVerifier = path => verifyBundledPythonGetPip(path),
): Promise<void> {
  if (existsSync(getpipPath)) {
    try {
      verify(getpipPath)
      return
    } catch {
      // A partial or tampered cache entry is replaced, never reused.
    }
  }
  const response = await fetchGetPip(BUNDLED_PYTHON_GETPIP_URL)
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: bundled Python bootstrap download ${BUNDLED_PYTHON_GETPIP_URL} failed with ${String(response.status)}`)
  }
  mkdirSync(dirname(getpipPath), { recursive: true })
  await writeResponseToFile(response, getpipPath)
  verify(getpipPath)
}

/** Staged-python command seam used by focused tests; production spawns the staged interpreter. */
export type BundledPythonBootstrapRunner = (commandPath: string, args: readonly string[]) => Promise<void>

/** Run one staged-python bootstrap command to success, or reject with its stderr tail. */
function runStagedPythonCommand(commandPath: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawn(commandPath, [...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let settled = false
    let failure: Error | undefined
    let exitCode: number | null = null
    let stderrBytes = 0
    let stderrTail = ''
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure !== undefined) rejectCommand(failure)
      else if (exitCode === 0) resolveCommand()
      else rejectCommand(new Error(
        `exited with ${exitCode === null ? 'no exit code' : String(exitCode)}${stderrTail.length > 0 ? `: ${stderrTail}` : ''}`,
      ))
    }
    const timer = setTimeout(() => {
      // A hung bootstrap must not hold packaging hostage; the kill is best-effort.
      failure = new Error(`timed out after ${String(BOOTSTRAP_COMMAND_TIMEOUT_MS)}ms`)
      try {
        child.kill()
      } catch {
        // An already-dead child needs no further cleanup.
      }
      settle()
    }, BOOTSTRAP_COMMAND_TIMEOUT_MS)
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-MAX_BOOTSTRAP_STDERR_BYTES)
        if (stderrBytes > MAX_BOOTSTRAP_STDERR_BYTES) child.stderr?.destroy()
      })
    }
    child.once('error', cause => {
      failure = cause
      settle()
    })
    child.once('close', code => {
      exitCode = code
      settle()
    })
  })
}

/**
 * Bootstrap pip and the pinned virtualenv into the staged tree.
 *
 * Both commands run with `--no-compile`: bytecode caches embed source mtimes,
 * and the extracted tree's mtimes vary per machine, so skipping compilation
 * keeps repeat digests reproducible. pip resolves virtualenv's dependencies
 * from PyPI at packaging time (public-network Windows builders); the pinned
 * top levels stay frozen while transitive dependencies float inside their
 * allowed ranges, which is why the digest manifest is regenerated on every
 * pack instead of diffed across packs.
 */
export async function bootstrapBundledPythonPackages(
  commandPath: string,
  getpipPath: string,
  runCommand: BundledPythonBootstrapRunner = runStagedPythonCommand,
): Promise<void> {
  await runCommand(commandPath, [getpipPath, '--no-warn-script-location', '--no-compile'])
  await runCommand(commandPath, [
    '-m',
    'pip',
    'install',
    `virtualenv==${BUNDLED_PYTHON_VIRTUALENV_VERSION}`,
    '--no-warn-script-location',
    '--no-compile',
  ])
}

/**
 * Confirm the bootstrap actually populated the staged tree and strip the
 * generated `Scripts` launchers.
 *
 * The marker checks turn a silently no-op bootstrap (for example an executor
 * that swallows failures) into a loud packaging failure. `pip install` also
 * drops `pip.exe`-style launchers into `Scripts/`, and those embed the build
 * host's absolute python path in their shebang — dead weight in the shipped
 * tree, where users reach pip as `python -m pip`. The sweep removes them so
 * the manifest pins only files that work everywhere.
 */
export function confirmBundledPythonBootstrap(stagingDirectory: string): void {
  for (const marker of [BUNDLED_PYTHON_PIP_PACKAGE_FILE, BUNDLED_PYTHON_VIRTUALENV_PACKAGE_FILE]) {
    if (!isRegularStagedFile(join(stagingDirectory, marker))) {
      throw new Error(
        `dsh-plugin-desktop: the bundled Python bootstrap did not leave ${marker} in the staged tree ${stagingDirectory}`,
      )
    }
  }
  rmSync(join(stagingDirectory, 'Scripts'), { recursive: true, force: true })
}

/** Replace the shipped `#import site` comment with the live import line. */
function unlockBundledPythonPathConfiguration(pthPath: string): void {
  const shipped = readFileSync(pthPath, 'utf8')
  if (!shipped.includes('#import site')) {
    throw new Error(
      `dsh-plugin-desktop: bundled Python path configuration ${pthPath} no longer carries the expected commented site import; refusing to guess the upstream layout change`,
    )
  }
  writeFileSync(pthPath, shipped.replace('#import site', 'import site'), 'utf8')
}

/** Whole-archive extraction seam used by focused tests; production uses adm-zip. */
export type BundledPythonArchiveExtractor = (archivePath: string, stagingDirectory: string) => void

/** Whether one staged path is a regular file; a missing path is not. */
function isRegularStagedFile(filename: string): boolean {
  try {
    return statSync(filename).isFile()
  } catch {
    return false
  }
}

/** Extract the whole embeddable tree into a freshly prepared staging directory. */
export function extractBundledPythonRuntime(
  archivePath: string,
  stagingDirectory: string,
  extractArchive: BundledPythonArchiveExtractor = runZipExtraction,
): string {
  rmSync(stagingDirectory, { recursive: true, force: true })
  mkdirSync(stagingDirectory, { recursive: true })
  extractArchive(archivePath, stagingDirectory)
  const commandPath = join(stagingDirectory, BUNDLED_PYTHON_COMMAND_NAME)
  const pthPath = join(stagingDirectory, BUNDLED_PYTHON_PTH_MEMBER)
  if (!isRegularStagedFile(commandPath)) {
    throw new Error(
      `dsh-plugin-desktop: bundled Python archive ${archivePath} did not provide ${BUNDLED_PYTHON_COMMAND_NAME}`,
    )
  }
  if (!isRegularStagedFile(pthPath)) {
    throw new Error(
      `dsh-plugin-desktop: bundled Python archive ${archivePath} did not provide ${BUNDLED_PYTHON_PTH_MEMBER}`,
    )
  }
  unlockBundledPythonPathConfiguration(pthPath)
  return commandPath
}

/** Extract one embeddable archive flat into the staging directory. */
function runZipExtraction(archivePath: string, stagingDirectory: string): void {
  new AdmZip(archivePath).extractAllTo(stagingDirectory, false)
}

/** Relative staged-file walker seam used by focused tests. */
export type BundledPythonFileLister = (directory: string) => readonly string[]

/** List every staged file below one directory as sorted forward-slash-relative paths. */
export function listBundledPythonFiles(directory: string): readonly string[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(relative(directory, full).replaceAll('\\', '/'))
    }
  }
  walk(directory)
  return files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

/**
 * Collect the pinned sha256 digest of every staged file.
 *
 * The digests are computed from the staging tree after the archive checksum
 * verified its bytes and the pip+virtualenv bootstrap populated it, so the
 * manifest always pins exactly what `extraResources` ships — including the
 * path-configuration unlock and the bootstrap-installed packages.
 */
export function collectBundledPythonFileDigests(
  stagingDirectory: string,
  listFiles: BundledPythonFileLister = listBundledPythonFiles,
): Record<string, string> {
  const digests: Record<string, string> = {}
  for (const relativePath of listFiles(stagingDirectory)) {
    digests[relativePath] = sha256File(join(stagingDirectory, relativePath))
  }
  return digests
}

/**
 * Write the platform-scoped digest manifest the packaged runtime verifies
 * against. Deterministic in field order and key order so repeat packs emit
 * identical bytes.
 */
export function writeBundledPythonDigestManifest(
  desktopRoot: string,
  platform: NodeJS.Platform,
  files: Readonly<Record<string, string>>,
): string {
  const manifest = {
    version: BUNDLED_PYTHON_VERSION,
    platform,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)),
  }
  const manifestPath = join(desktopRoot, 'lib', BUNDLED_PYTHON_DIGEST_MANIFEST_NAME)
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  return manifestPath
}

/** Inputs controlling one staging run. */
export interface BundledPythonPreparationOptions {
  /** Desktop package root containing `build/`. */
  readonly desktopRoot: string
  /** Electron Builder platform name. */
  readonly platform: NodeJS.Platform
  /** Packaging architecture name. */
  readonly arch: string
  /** Download cache; defaults to `build/python-runtime-cache`. */
  readonly cacheDirectory?: string
  /** Staging directory `extraResources` copies; defaults to `build/python-runtime`. */
  readonly stagingDirectory?: string
  /** Fetch seam used by focused tests. */
  readonly fetchArchive?: (url: string) => Promise<Response>
  /** Checksum verifier seam used by focused tests. */
  readonly verifyArchive?: BundledPythonArchiveVerifier
  /** Fetch seam for the pinned get-pip.py, mirroring {@link fetchArchive}. */
  readonly fetchGetPip?: (url: string) => Promise<Response>
  /** Checksum verifier seam for the bootstrap script, mirroring {@link verifyArchive}. */
  readonly verifyGetPip?: BundledPythonGetPipVerifier
  /** Staged-python command seam used by focused tests. */
  readonly runBootstrapCommand?: BundledPythonBootstrapRunner
  /** Whole-archive extraction seam used by focused tests. */
  readonly extractArchive?: BundledPythonArchiveExtractor
  /** Relative staged-file walker seam used by focused tests. */
  readonly listFiles?: BundledPythonFileLister
  /** Progress reporter. */
  readonly log?: (message: string) => void
}

/**
 * Stage the pinned Python tree for the packaging target.
 *
 * `DSH_BUNDLED_PYTHON_ARCHIVE` may point at a pre-downloaded archive and
 * `DSH_BUNDLED_PYTHON_GETPIP_ARCHIVE` at a pre-downloaded bootstrap script;
 * their bytes still have to match the pinned checksums.
 *
 * Staging runs in strict order — extract and checksum-verify the archive,
 * unlock the `._pth` site machinery, bootstrap pip+virtualenv into the tree,
 * then generate the digest manifest — so `lib/${BUNDLED_PYTHON_DIGEST_MANIFEST_NAME}`
 * pins every staged file of the final tree, bootstrap artifacts included, and
 * the packaged runtime can refuse a swapped tree.
 * @param options - target identity and injectable filesystem/network seams.
 * @returns the staged Python command path inside the staging directory.
 */
export async function prepareBundledPython(
  options: BundledPythonPreparationOptions,
): Promise<string> {
  bundledPythonTarget(options.platform, options.arch)
  const cacheDirectory = options.cacheDirectory ?? join(options.desktopRoot, 'build', 'python-runtime-cache')
  const stagingDirectory = options.stagingDirectory ?? join(options.desktopRoot, 'build', 'python-runtime')
  const verify = options.verifyArchive ?? ((path: string) => verifyBundledPythonArchive(path))
  const verifyGetPip = options.verifyGetPip ?? ((path: string) => verifyBundledPythonGetPip(path))
  const override = process.env.DSH_BUNDLED_PYTHON_ARCHIVE
  const archivePath = override !== undefined && override.length > 0
    ? override
    : join(cacheDirectory, BUNDLED_PYTHON_ARCHIVE)
  options.log?.(`dsh-plugin-desktop: staging bundled Python v${BUNDLED_PYTHON_VERSION} for ${options.platform}-${options.arch}`)
  if (override === undefined || override.length === 0) {
    await downloadBundledPythonArchive(
      archivePath,
      options.fetchArchive ?? fetch,
      verify,
    )
  } else {
    verify(archivePath)
    // A verified override also seeds the shared archive cache.
    mkdirSync(cacheDirectory, { recursive: true })
    copyFileSync(archivePath, join(cacheDirectory, BUNDLED_PYTHON_ARCHIVE))
  }
  const stagedCommandPath = extractBundledPythonRuntime(
    archivePath,
    stagingDirectory,
    options.extractArchive,
  )

  // Bootstrap pip and the pinned virtualenv into the freshly extracted tree —
  // before any digest is taken, so the manifest below covers the final tree.
  const getpipOverride = process.env.DSH_BUNDLED_PYTHON_GETPIP_ARCHIVE
  const getpipPath = getpipOverride !== undefined && getpipOverride.length > 0
    ? getpipOverride
    : join(cacheDirectory, BUNDLED_PYTHON_GETPIP_CACHE_NAME)
  if (getpipOverride === undefined || getpipOverride.length === 0) {
    await downloadBundledPythonGetPip(getpipPath, options.fetchGetPip ?? fetch, verifyGetPip)
  } else {
    verifyGetPip(getpipPath)
    // A verified override also seeds the shared bootstrap-script cache.
    mkdirSync(cacheDirectory, { recursive: true })
    copyFileSync(getpipPath, join(cacheDirectory, BUNDLED_PYTHON_GETPIP_CACHE_NAME))
  }
  options.log?.(`dsh-plugin-desktop: bootstrapping pip and virtualenv ${BUNDLED_PYTHON_VIRTUALENV_VERSION} into the staged bundled Python tree`)
  await bootstrapBundledPythonPackages(
    stagedCommandPath,
    getpipPath,
    options.runBootstrapCommand,
  )
  confirmBundledPythonBootstrap(stagingDirectory)

  const digests = collectBundledPythonFileDigests(stagingDirectory, options.listFiles)
  const manifestPath = writeBundledPythonDigestManifest(options.desktopRoot, options.platform, digests)
  options.log?.(`dsh-plugin-desktop: pinned bundled Python digests (${String(Object.keys(digests).length)} files) at ${manifestPath}`)
  return stagedCommandPath
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const platformArgument = process.argv.find(argument => argument.startsWith('--platform='))
    const archArgument = process.argv.find(argument => argument.startsWith('--arch='))
    const staged = await prepareBundledPython({
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
