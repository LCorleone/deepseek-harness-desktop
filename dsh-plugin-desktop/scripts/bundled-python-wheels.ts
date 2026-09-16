/**
 * Pinned wheel set the Windows package ships for the shared desktop Python
 * environment (issue #043, decision D2).
 *
 * The shared environment under `%LOCALAPPDATA%\DSH Desktop\pyenv` is the
 * mutable Python surface the desktop publishes `python`/`dsh-pip` aliases
 * for: users and agents install their own packages into it (pandas and
 * matplotlib deliberately NOT among the preinstalls — the company skills'
 * SKILL.md direct users to `dsh-pip` for those). To make the first
 * provisioning productive without any network access at runtime, the
 * installer carries a pinned set of wheels as an extra resource beside the
 * bundled CPython tree, and the shared-environment bootstrap installs
 * whatever of that set is missing — locally, through `--no-index` and the
 * verified wheel files' absolute paths (never a directory scan) — with
 * ensure-present semantics: a name that is already
 * installed at ANY version is never touched, so a user's own newer (or
 * older) install always wins.
 *
 * The lock lives at `assets/python-wheels-lock.json` (name, version, exact
 * wheel filename, sha256, size per distribution — the full transitive
 * closure pre-resolved for CPython 3.12 / win_amd64, so runtime pip runs
 * with `--no-deps` and never resolves anything). This module stages the
 * locked wheels at `build/python-wheels` before `extraResources` copies
 * them to `resources/python-wheels`; every downloaded byte is verified
 * against the pinned sha256, exactly like the embeddable CPython archive.
 *
 * Why the packaged boot digest does NOT cover this directory: the digest
 * manifest (`lib/python-runtime-sha256.json`) pins the bundled interpreter
 * TREE because the desktop executes it directly and must refuse a swapped
 * byte. The wheels are build INPUTS to the mutable shared environment, not
 * a runtime integrity surface — pip consumes them exactly once per name at
 * first provisioning, and the shared environment has no exact-file-set
 * gate by design (users install into it). Each wheel's bytes are still
 * integrity-checked against the committed lock before pip ever sees them
 * (at staging here, and again at install time through the lockfile copied
 * beside the wheels), so a tampered wheel cannot execute code.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Filename of the committed lock this module stages from (`assets/`). */
export const BUNDLED_PYTHON_WHEELS_LOCK_NAME = 'python-wheels-lock.json'

/** Trusted origin serving the per-release metadata the download URLs come from. */
export const BUNDLED_PYTHON_WHEELS_ORIGIN = 'https://pypi.org'

/** Schema version of {@link BUNDLED_PYTHON_WHEELS_LOCK_NAME}; bumps invalidate staging. */
export const BUNDLED_PYTHON_WHEELS_LOCK_SCHEMA_VERSION = 1

/** Interpreter minor the locked wheels target (the shared environment's CPython). */
export const BUNDLED_PYTHON_WHEELS_PYTHON = '3.12'

/** Wheel platform tag the locked wheels target (the only packaged Python platform). */
export const BUNDLED_PYTHON_WHEELS_PLATFORM = 'win_amd64'

/** Hard ceiling for one wheel download, guarding hostile or broken responses. */
const MAX_WHEEL_BYTES = 256 * 1024 * 1024

/** Hard deadline for one wheel metadata fetch or download. */
const WHEEL_DOWNLOAD_TIMEOUT_MS = 300_000

/** Absolute repository location of this script's package. */
const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** One pinned distribution of the wheel lock. */
export interface BundledPythonWheelEntry {
  /** Canonical (PEP 503) distribution name, lowercase with single dashes. */
  readonly name: string
  /** Exact pinned version. */
  readonly version: string
  /** Exact wheel filename the pin resolves to (platform-tagged or pure). */
  readonly filename: string
  /** sha256 of the wheel bytes, computed from the PyPI artifact. */
  readonly sha256: string
  /** Wheel size in bytes, for build sanity and size accounting. */
  readonly size: number
}

/** Parsed contents of `assets/python-wheels-lock.json`. */
export interface BundledPythonWheelsLock {
  /** Schema version ({@link BUNDLED_PYTHON_WHEELS_LOCK_SCHEMA_VERSION}). */
  readonly version: number
  /** Interpreter minor the wheels target ({@link BUNDLED_PYTHON_WHEELS_PYTHON}). */
  readonly python: string
  /** Wheel platform tag ({@link BUNDLED_PYTHON_WHEELS_PLATFORM}). */
  readonly platform: string
  /** Every pinned distribution, sorted by canonical name. */
  readonly distributions: readonly BundledPythonWheelEntry[]
}

/** Canonicalize one distribution name the way PyPI normalizes project names. */
export function canonicalizeWheelProjectName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, '-')
}

/** Whether one string is a canonical (already-normalized) distribution name. */
function isCanonicalWheelProjectName(name: string): boolean {
  return canonicalizeWheelProjectName(name) === name && name.length > 0
}

/** Whether one string is a 64-character lowercase hex sha256. */
function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value)
}

/**
 * Strictly parse the wheel lock bytes. Staging and the afterPack gate call
 * this and let every schema drift fail the build loud; the runtime keeps its
 * own lenient copy (malformed input degrades to a skipped repair check, see
 * `src/desktop-shared-python-environment.ts`).
 * @param text - raw lockfile contents.
 * @returns the parsed lock.
 * @throws on any schema drift.
 */
export function parseBundledPythonWheelsLock(text: string): BundledPythonWheelsLock {
  const failure = (reason: string): Error =>
    new Error(`dsh-plugin-desktop: the bundled Python wheel lock is invalid: ${reason}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw failure(`not JSON (${cause instanceof Error ? cause.message : String(cause)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw failure('the document is not an object')
  }
  const document = parsed as Record<string, unknown>
  if (document.version !== BUNDLED_PYTHON_WHEELS_LOCK_SCHEMA_VERSION) {
    throw failure(`version ${JSON.stringify(document.version)} is not ${String(BUNDLED_PYTHON_WHEELS_LOCK_SCHEMA_VERSION)}`)
  }
  if (document.python !== BUNDLED_PYTHON_WHEELS_PYTHON) {
    throw failure(`python ${JSON.stringify(document.python)} is not ${JSON.stringify(BUNDLED_PYTHON_WHEELS_PYTHON)}`)
  }
  if (document.platform !== BUNDLED_PYTHON_WHEELS_PLATFORM) {
    throw failure(`platform ${JSON.stringify(document.platform)} is not ${JSON.stringify(BUNDLED_PYTHON_WHEELS_PLATFORM)}`)
  }
  if (!Array.isArray(document.distributions) || document.distributions.length === 0) {
    throw failure('distributions must be a non-empty array')
  }
  const seen = new Set<string>()
  let previousName = ''
  const distributions: BundledPythonWheelEntry[] = []
  for (const entry of document.distributions) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw failure('a distribution entry is not an object')
    }
    const { name, version, filename, sha256, size } = entry as Record<string, unknown>
    if (typeof name !== 'string' || !isCanonicalWheelProjectName(name)) {
      throw failure(`distribution name ${JSON.stringify(name)} is not canonical`)
    }
    if (typeof version !== 'string' || version.length === 0) {
      throw failure(`${name} carries no version`)
    }
    if (typeof filename !== 'string' || !filename.endsWith('.whl')
      || !filename.startsWith(`${name.replaceAll('-', '_')}-${version}-`)) {
      throw failure(`${name}==${version} pins the inconsistent wheel filename ${JSON.stringify(filename)}`)
    }
    if (typeof sha256 !== 'string' || !isSha256Hex(sha256)) {
      throw failure(`${name}==${version} pins a malformed sha256`)
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_WHEEL_BYTES) {
      throw failure(`${name}==${version} pins an implausible size ${String(size)}`)
    }
    if (seen.has(name)) {
      throw failure(`${name} is pinned more than once`)
    }
    if (name <= previousName) {
      throw failure(`distributions are not sorted by name at ${name}`)
    }
    seen.add(name)
    previousName = name
    distributions.push({ name, version, filename, sha256, size })
  }
  return { version: document.version, python: document.python, platform: document.platform, distributions }
}

/** Lockfile reader seam; production reads the committed repository asset. */
export type BundledPythonWheelsLockReader = () => string

/** Read the committed wheel lock below one desktop package root. */
export function readBundledPythonWheelsLock(
  desktopRoot: string,
  readFile: BundledPythonWheelsLockReader = () =>
    readFileSync(join(desktopRoot, 'assets', BUNDLED_PYTHON_WHEELS_LOCK_NAME), 'utf8'),
): BundledPythonWheelsLock {
  return parseBundledPythonWheelsLock(readFile())
}

/** Verify one wheel's bytes against its pinned size and sha256. */
export function verifyBundledPythonWheelBytes(
  entry: BundledPythonWheelEntry,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength !== entry.size) {
    throw new Error(
      `dsh-plugin-desktop: bundled Python wheel ${entry.filename} is ${String(bytes.byteLength)} bytes instead of the pinned ${String(entry.size)}`,
    )
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== entry.sha256) {
    throw new Error(
      `dsh-plugin-desktop: bundled Python wheel ${entry.filename} hashed to ${digest} instead of the pinned ${entry.sha256}`,
    )
  }
}

/** sha256 of one file's bytes; the cache and override paths share it with staging. */
function sha256File(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex')
}

/** Per-release metadata seam used by focused tests; production fetches the pinned origin. */
export type BundledPythonWheelsMetadataFetcher = (url: string) => Promise<unknown>

/** Wheel-bytes fetch seam used by focused tests; production fetches the URL the metadata names. */
export type BundledPythonWheelFetcher = (url: string) => Promise<Uint8Array>

/** Read one bounded HTTP body fully into memory, refusing responses past the ceiling. */
async function fetchWheelBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(WHEEL_DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: bundled Python wheel download ${url} failed with ${String(response.status)}`)
  }
  const body = await response.arrayBuffer()
  const bytes = new Uint8Array(body)
  if (bytes.byteLength > MAX_WHEEL_BYTES) {
    throw new Error(`dsh-plugin-desktop: bundled Python wheel download ${url} exceeded ${String(MAX_WHEEL_BYTES)} bytes`)
  }
  return bytes
}

/**
 * Resolve the pinned download URL of one wheel from the per-release PyPI
 * metadata: the lock pins the exact filename, and the release metadata maps
 * that filename onto its `files.pythonhosted.org` URL — a filename the
 * release no longer serves (upstream deleted the artifact) fails the build
 * loud instead of silently resolving a different wheel.
 */
export async function resolveBundledPythonWheelUrl(
  entry: BundledPythonWheelEntry,
  fetchMetadata: BundledPythonWheelsMetadataFetcher,
): Promise<string> {
  const url = `${BUNDLED_PYTHON_WHEELS_ORIGIN}/pypi/${entry.name}/${entry.version}/json`
  const metadata = await fetchMetadata(url)
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error(`dsh-plugin-desktop: bundled Python wheel metadata for ${entry.name}==${entry.version} is not an object`)
  }
  const urls = (metadata as Record<string, unknown>).urls
  if (!Array.isArray(urls)) {
    throw new Error(`dsh-plugin-desktop: bundled Python wheel metadata for ${entry.name}==${entry.version} carries no urls array`)
  }
  for (const candidate of urls) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    if (record.filename === entry.filename) {
      const downloadUrl = record.url
      if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) {
        throw new Error(`dsh-plugin-desktop: bundled Python wheel ${entry.filename} has no download URL in its release metadata`)
      }
      return downloadUrl
    }
  }
  throw new Error(
    `dsh-plugin-desktop: the PyPI release of ${entry.name}==${entry.version} no longer serves the pinned wheel ${entry.filename}`,
  )
}

/** Inputs controlling one wheel-staging run. */
export interface BundledPythonWheelsPreparationOptions {
  /** Desktop package root containing `assets/` and `build/`. */
  readonly desktopRoot: string
  /** Download cache; defaults to `build/python-wheels-cache`. */
  readonly cacheDirectory?: string
  /** Staging directory `extraResources` copies; defaults to `build/python-wheels`. */
  readonly stagingDirectory?: string
  /** Lockfile reader seam; defaults to the committed repository asset. */
  readonly readLock?: BundledPythonWheelsLockReader
  /** Per-release metadata fetch seam; defaults to the pinned PyPI origin. */
  readonly fetchMetadata?: BundledPythonWheelsMetadataFetcher
  /** Wheel-bytes fetch seam; defaults to the URL the release metadata names. */
  readonly fetchWheel?: BundledPythonWheelFetcher
  /** Progress reporter. */
  readonly log?: (message: string) => void
}

/**
 * Stage the pinned wheel set for the Windows package.
 *
 * `DSH_BUNDLED_PYTHON_WHEELS_DIRECTORY` may point at a pre-populated wheel
 * directory (an offline or proxied builder); its files are still verified
 * against the pinned sha256s and copied, and no network is touched.
 *
 * Staging writes each verified wheel below the staging directory, then the
 * lockfile itself beside them (`resources/python-wheels/<lock>` is what the
 * runtime reads at first provisioning), and finally asserts the staged set
 * is EXACTLY the locked set — a partial download or a stray file fails the
 * build instead of shipping a wheel set pip cannot fully satisfy.
 * @param options - staging locations and injectable seams.
 * @returns the staging directory `extraResources` maps from.
 */
export async function prepareBundledPythonWheels(
  options: BundledPythonWheelsPreparationOptions,
): Promise<string> {
  const lock = readBundledPythonWheelsLock(
    options.desktopRoot,
    options.readLock,
  )
  const cacheDirectory = options.cacheDirectory ?? join(options.desktopRoot, 'build', 'python-wheels-cache')
  const stagingDirectory = options.stagingDirectory ?? join(options.desktopRoot, 'build', 'python-wheels')
  const fetchMetadata = options.fetchMetadata
    ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(WHEEL_DOWNLOAD_TIMEOUT_MS) })
      .then(async response => {
        if (!response.ok) {
          throw new Error(`dsh-plugin-desktop: bundled Python wheel metadata ${url} failed with ${String(response.status)}`)
        }
        return await response.json() as unknown
      }))
  const fetchWheel = options.fetchWheel ?? fetchWheelBytes
  rmSync(stagingDirectory, { recursive: true, force: true })
  mkdirSync(stagingDirectory, { recursive: true })
  const override = process.env.DSH_BUNDLED_PYTHON_WHEELS_DIRECTORY
  const overrideDirectory = override !== undefined && override.length > 0 ? override : undefined
  if (overrideDirectory !== undefined) {
    options.log?.(
      `dsh-plugin-desktop: staging the bundled Python wheel set (${String(lock.distributions.length)} wheels) from the override directory ${overrideDirectory}`,
    )
  } else {
    options.log?.(
      `dsh-plugin-desktop: staging the bundled Python wheel set (${String(lock.distributions.length)} wheels) for CPython ${BUNDLED_PYTHON_WHEELS_PYTHON} / ${BUNDLED_PYTHON_WHEELS_PLATFORM}`,
    )
  }
  for (const entry of lock.distributions) {
    const stagedPath = join(stagingDirectory, entry.filename)
    if (overrideDirectory !== undefined) {
      const overridePath = join(overrideDirectory, entry.filename)
      if (!existsSync(overridePath) || sha256File(overridePath) !== entry.sha256) {
        throw new Error(
          `dsh-plugin-desktop: the wheel override directory ${overrideDirectory} does not carry the pinned bytes of ${entry.filename}`,
        )
      }
      copyFileSync(overridePath, stagedPath)
      continue
    }
    const cachePath = join(cacheDirectory, entry.filename)
    if (existsSync(cachePath) && sha256File(cachePath) === entry.sha256) {
      copyFileSync(cachePath, stagedPath)
      continue
    }
    const downloadUrl = await resolveBundledPythonWheelUrl(entry, fetchMetadata)
    const bytes = await fetchWheel(downloadUrl)
    verifyBundledPythonWheelBytes(entry, bytes)
    mkdirSync(cacheDirectory, { recursive: true })
    writeFileSync(cachePath, bytes)
    copyFileSync(cachePath, stagedPath)
  }
  writeFileSync(
    join(stagingDirectory, BUNDLED_PYTHON_WHEELS_LOCK_NAME),
    JSON.stringify(lock, undefined, 2) + '\n',
  )
  const staged = readdirSync(stagingDirectory).sort()
  const expected = [...lock.distributions.map(entry => entry.filename), BUNDLED_PYTHON_WHEELS_LOCK_NAME].sort()
  if (staged.length !== expected.length || staged.some((filename, index) => filename !== expected[index])) {
    throw new Error(
      `dsh-plugin-desktop: the staged wheel directory ${stagingDirectory} does not hold exactly the locked wheel set (staged ${staged.join(', ')})`,
    )
  }
  const totalBytes = lock.distributions.reduce((sum, entry) => sum + entry.size, 0)
  options.log?.(
    `dsh-plugin-desktop: staged ${String(lock.distributions.length)} bundled Python wheels (${totalBytes} bytes) at ${stagingDirectory}`,
  )
  return stagingDirectory
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const stagedDirectory = await prepareBundledPythonWheels({
      desktopRoot: DESKTOP_ROOT,
      log: message => console.log(message),
    })
    console.log(stagedDirectory)
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
