import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_PYTHON_WHEELS_LOCK_NAME,
  BUNDLED_PYTHON_WHEELS_LOCK_SCHEMA_VERSION,
  BUNDLED_PYTHON_WHEELS_ORIGIN,
  canonicalizeWheelProjectName,
  parseBundledPythonWheelsLock,
  prepareBundledPythonWheels,
  readBundledPythonWheelsLock,
  resolveBundledPythonWheelUrl,
  verifyBundledPythonWheelBytes,
  type BundledPythonWheelEntry,
  type BundledPythonWheelsMetadataFetcher,
} from '../scripts/bundled-python-wheels.ts'
import { beforePack } from '../scripts/prepare-bundled-python-wheels.ts'
import { packagedPythonWheelsDirectory } from '../src/desktop-python-runtime.ts'

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-python-wheels-'))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.DSH_BUNDLED_PYTHON_WHEELS_DIRECTORY
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Build one parser-consistent lock entry over deterministic bytes. */
function fakeEntry(name: string, version: string, payload: string): BundledPythonWheelEntry {
  const bytes = Buffer.from(payload, 'utf8')
  return {
    name,
    version,
    filename: `${name.replaceAll('-', '_')}-${version}-py3-none-any.whl`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  }
}

/** Serialize entries into a well-formed lock document. */
function lockDocument(entries: readonly BundledPythonWheelEntry[]): string {
  return `${JSON.stringify({
    version: BUNDLED_PYTHON_WHEELS_LOCK_SCHEMA_VERSION,
    python: '3.12',
    platform: 'win_amd64',
    distributions: entries,
  }, undefined, 2)}\n`
}

describe('the committed preinstall wheel lock (issue #043 batch C)', () => {
  /** The decision-D2 top levels every shared environment preinstalls (markitdown removed 2026-09-16). */
  const DECISION_TOP_LEVELS = [
    'requests', 'python-dotenv', 'tqdm', 'openpyxl', 'python-docx', 'python-pptx',
    'pypdf', 'reportlab', 'pdfplumber', 'aiohttp', 'pillow', 'pymupdf',
    'httpx', 'beautifulsoup4', 'lxml', 'pyyaml', 'chardet', 'rich', 'python-dateutil',
    // Skill-required XML parser (issue #043 review P1-a): every docx
    // scripts/office/* and helpers/* module top-level-imports defusedxml.minidom,
    // so the docx primary path dies without it — it is a pinned top level even
    // though no other locked distribution pulls it in.
    'defusedxml',
  ] as const

  it('exists beside the other repository assets and parses under the strict schema', () => {
    const lock = readBundledPythonWheelsLock(DESKTOP_ROOT)
    expect(lock.python).toBe('3.12')
    expect(lock.platform).toBe('win_amd64')
    // Exact set, not a floor: a missing or extra pin must fail the build here.
    expect(lock.distributions.length).toBe(48)
  })

  it('pins every decision-D2 top level plus its pre-resolved transitive closure', () => {
    const lock = readBundledPythonWheelsLock(DESKTOP_ROOT)
    const names = new Set(lock.distributions.map(entry => entry.name))
    for (const top of DECISION_TOP_LEVELS) expect(names.has(top)).toBe(true)
    // The heaviest known transitives of the locked tops must be pinned too —
    // pdfplumber's chain.
    for (const transitive of ['pdfminer-six', 'pypdfium2', 'cryptography']) {
      expect(names.has(transitive)).toBe(true)
    }
    // markitdown and its ~42 MiB magika/onnxruntime/numpy/sympy chain left the
    // preinstall set (July, 2026-09-16): no remaining top level needs any of
    // it, and the pptx skill self-installs markitdown via dsh-pip instead.
    for (const dropped of ['markitdown', 'magika', 'onnxruntime', 'numpy', 'sympy']) {
      expect(names.has(dropped)).toBe(false)
    }
  })

  it('stays canonical, sorted, unique, and inside the size budget the issue estimated', () => {
    const lock = readBundledPythonWheelsLock(DESKTOP_ROOT)
    const names = lock.distributions.map(entry => entry.name)
    expect(names).toEqual([...names].sort())
    expect(new Set(names).size).toBe(names.length)
    for (const entry of lock.distributions) {
      expect(canonicalizeWheelProjectName(entry.name)).toBe(entry.name)
      expect(entry.filename.startsWith(`${entry.name.replaceAll('-', '_')}-${entry.version}-`)).toBe(true)
    }
    const totalBytes = lock.distributions.reduce((sum, entry) => sum + entry.size, 0)
    // The issue's 60–90 MB estimate minus markitdown's ~42 MiB chain (the
    // 2026-09-16 removal decision): measured 51.98 MiB across 48 wheels
    // (the review P1-a defusedxml pin added 25,604 bytes to the 47-wheel set).
    expect(totalBytes).toBeGreaterThan(50 * 1024 * 1024)
    expect(totalBytes).toBeLessThan(90 * 1024 * 1024)
  })
})

describe('bundled Python wheel lock parsing', () => {
  it('accepts a well-formed document and rejects every schema drift loudly', () => {
    const good = fakeEntry('requests', '2.34.2', 'requests-wheel-bytes')
    expect(parseBundledPythonWheelsLock(lockDocument([good])).distributions).toEqual([good])

    const malformed: ReadonlyArray<[string, string]> = [
      ['not json', '{'],
      ['not an object', '[]'],
      ['wrong schema version', lockDocument([good]).replace('"version": 1', '"version": 2')],
      ['wrong python', lockDocument([good]).replace('"3.12"', '"3.13"')],
      ['wrong platform', lockDocument([good]).replace('"win_amd64"', '"manylinux2014_x86_64"')],
      ['empty distributions', lockDocument([])],
      ['non-canonical name', lockDocument([{ ...good, name: 'Python_DocX' }])],
      ['inconsistent filename', lockDocument([{ ...good, filename: 'other-1.0-py3-none-any.whl' }])],
      ['non-hex sha256', lockDocument([{ ...good, sha256: 'z'.repeat(64) }])],
      ['short sha256', lockDocument([{ ...good, sha256: 'a'.repeat(63) }])],
      ['implausible size', lockDocument([{ ...good, size: -1 }])],
      ['duplicate name', lockDocument([good, { ...good, version: '2.35.0', filename: 'requests-2.35.0-py3-none-any.whl' }])],
      ['unsorted names', lockDocument([fakeEntry('zeta', '1.0', 'z'), good])],
    ]
    for (const [reason, text] of malformed) {
      expect(() => parseBundledPythonWheelsLock(text), reason).toThrow()
    }
  })

  it('verifies wheel bytes against the pinned size and sha256', () => {
    const entry = fakeEntry('tqdm', '4.70.1', 'tqdm-wheel-bytes')
    expect(() => verifyBundledPythonWheelBytes(entry, Buffer.from('tqdm-wheel-bytes'))).not.toThrow()
    // Same length, different bytes: only the hash check can catch it.
    expect(() => verifyBundledPythonWheelBytes(entry, Buffer.from('Tqdm-wheel-bytes'))).toThrow(/hashed to/)
    expect(() => verifyBundledPythonWheelBytes(entry, Buffer.from('x'))).toThrow(/bytes instead of/)
  })
})

describe('bundled Python wheel URL resolution', () => {
  const entry = fakeEntry('rich', '15.0.0', 'rich-wheel-bytes')

  it('resolves the pinned filename onto its download URL from the release metadata', async () => {
    const fetchMetadata: BundledPythonWheelsMetadataFetcher = async url => {
      expect(url).toBe(`${BUNDLED_PYTHON_WHEELS_ORIGIN}/pypi/rich/15.0.0/json`)
      return { urls: [{ filename: 'rich-14.0.0-py3-none-any.whl', url: 'https://files.example/old' }, { filename: entry.filename, url: 'https://files.example/pinned' }] }
    }
    await expect(resolveBundledPythonWheelUrl(entry, fetchMetadata)).resolves.toBe('https://files.example/pinned')
  })

  it('fails loud when the release no longer serves the pinned wheel', async () => {
    await expect(resolveBundledPythonWheelUrl(entry, async () => ({ urls: [] }))).rejects.toThrow(/no longer serves the pinned wheel/)
    await expect(resolveBundledPythonWheelUrl(entry, async () => ({}))).rejects.toThrow(/carries no urls array/)
  })
})

describe('bundled Python wheel staging', () => {
  /** Staging inputs with an in-memory network over deterministic wheel bytes. */
  function stagingFixture(entries: readonly BundledPythonWheelEntry[]) {
    const root = temporaryDirectory()
    const cacheDirectory = join(root, 'cache')
    const stagingDirectory = join(root, 'staging')
    const payload = (name: string): Buffer => Buffer.from(`${name}-wheel-bytes`, 'utf8')
    const fetchMetadata: BundledPythonWheelsMetadataFetcher = async url => {
      const match = /\/pypi\/([^/]+)\/([^/]+)\/json$/u.exec(url)
      const name = match?.[1] ?? ''
      const version = match?.[2] ?? ''
      const entry = entries.find(candidate => candidate.name === name && candidate.version === version)
      return { urls: [{ filename: entry?.filename ?? 'unknown.whl', url: `https://files.example/${name}` }] }
    }
    return { root, cacheDirectory, stagingDirectory, payload, fetchMetadata }
  }

  it('downloads, verifies, and stages exactly the locked set with the lockfile beside it', async () => {
    const entries = [fakeEntry('aiohttp', '3.14.3', 'aiohttp-wheel-bytes'), fakeEntry('pypdf', '6.18.1', 'pypdf-wheel-bytes')]
    const { root, cacheDirectory, stagingDirectory, payload, fetchMetadata } = stagingFixture(entries)

    const staged = await prepareBundledPythonWheels({
      desktopRoot: root,
      cacheDirectory,
      stagingDirectory,
      readLock: () => lockDocument(entries),
      fetchMetadata,
      fetchWheel: async url => payload(/https:\/\/files\.example\/(.+)$/u.exec(url)?.[1] ?? ''),
    })

    expect(staged).toBe(stagingDirectory)
    for (const entry of entries) {
      expect(readFileSync(join(stagingDirectory, entry.filename)).toString('utf8'))
        .toBe(payload(entry.name).toString('utf8'))
    }
    const stagedLock = parseBundledPythonWheelsLock(
      readFileSync(join(stagingDirectory, BUNDLED_PYTHON_WHEELS_LOCK_NAME), 'utf8'),
    )
    expect(stagedLock.distributions.map(entry => entry.name)).toEqual(entries.map(entry => entry.name))
  })

  it('aborts the build when downloaded bytes fail the pinned checksum', async () => {
    const entries = [fakeEntry('pillow', '12.3.0', 'pillow-wheel-bytes')]
    const { root, cacheDirectory, stagingDirectory, fetchMetadata } = stagingFixture(entries)
    await expect(prepareBundledPythonWheels({
      desktopRoot: root,
      cacheDirectory,
      stagingDirectory,
      readLock: () => lockDocument(entries),
      fetchMetadata,
      fetchWheel: async () => Buffer.from('Pillow-wheel-bytes'),
    })).rejects.toThrow(/hashed to/)
    expect(existsSync(join(stagingDirectory, BUNDLED_PYTHON_WHEELS_LOCK_NAME))).toBe(false)
  })

  it('reuses a verified cache entry without touching the network', async () => {
    const entries = [fakeEntry('lxml', '6.1.3', 'lxml-wheel-bytes')]
    const { root, cacheDirectory, stagingDirectory, payload } = stagingFixture(entries)
    mkdirSync(cacheDirectory, { recursive: true })
    for (const entry of entries) {
      writeFileSync(join(cacheDirectory, entry.filename), payload(entry.name))
    }
    await prepareBundledPythonWheels({
      desktopRoot: root,
      cacheDirectory,
      stagingDirectory,
      readLock: () => lockDocument(entries),
      fetchMetadata: async () => { throw new Error('network must not be touched from a verified cache') },
      fetchWheel: async () => { throw new Error('network must not be touched from a verified cache') },
    })
    expect(existsSync(join(stagingDirectory, entries[0]?.filename ?? ''))).toBe(true)
  })

  it('refuses an unverified staged set: a stray wheel file fails the build', async () => {
    const entries = [fakeEntry('pypdfium2', '5.13.0', 'pypdfium2-wheel-bytes')]
    const { root, cacheDirectory, stagingDirectory, payload, fetchMetadata } = stagingFixture(entries)
    let strayWritten = false
    await expect(prepareBundledPythonWheels({
      desktopRoot: root,
      cacheDirectory,
      stagingDirectory,
      readLock: () => lockDocument(entries),
      fetchMetadata,
      fetchWheel: async url => {
        // Simulate a partial/stray staging artifact landing beside the set
        // after staging prepared the directory.
        if (!strayWritten) {
          strayWritten = true
          writeFileSync(join(stagingDirectory, 'stray-1.0-py3-none-any.whl'), 'stray')
        }
        return payload(/https:\/\/files\.example\/(.+)$/u.exec(url)?.[1] ?? '')
      },
    })).rejects.toThrow(/does not hold exactly the locked wheel set/)
  })

  it('stages from the offline override directory with verification and no network', async () => {
    const entries = [fakeEntry('pyyaml', '6.0.3', 'pyyaml-wheel-bytes')]
    const { root, cacheDirectory, stagingDirectory, payload } = stagingFixture(entries)
    const overrideDirectory = join(root, 'override')
    mkdirSync(overrideDirectory, { recursive: true })
    for (const entry of entries) {
      writeFileSync(join(overrideDirectory, entry.filename), payload(entry.name))
    }
    process.env.DSH_BUNDLED_PYTHON_WHEELS_DIRECTORY = overrideDirectory
    await prepareBundledPythonWheels({
      desktopRoot: root,
      cacheDirectory,
      stagingDirectory,
      readLock: () => lockDocument(entries),
      fetchMetadata: async () => { throw new Error('the override directory must not touch the network') },
      fetchWheel: async () => { throw new Error('the override directory must not touch the network') },
    })
    expect(existsSync(join(stagingDirectory, entries[0]?.filename ?? ''))).toBe(true)
    // An override missing the pinned bytes fails loud instead of staging partials.
    writeFileSync(join(overrideDirectory, entries[0]?.filename ?? ''), 'tampered')
    await expect(prepareBundledPythonWheels({
      desktopRoot: root,
      cacheDirectory: join(root, 'cache2'),
      stagingDirectory: join(root, 'staging2'),
      readLock: () => lockDocument(entries),
    })).rejects.toThrow(/does not carry the pinned bytes/)
  })
})

describe('bundled Python wheels beforePack hook', () => {
  it('skips staging entirely for non-Windows beforePack runs', async () => {
    await expect(beforePack({ appOutDir: '/build', electronPlatformName: 'darwin', arch: 1 }))
      .resolves.toBeUndefined()
  })

  it('maps Electron Builder architectures and rejects unknown values', async () => {
    await expect(beforePack({ appOutDir: '/build', electronPlatformName: 'win32', arch: 99 }))
      .rejects.toThrow(/unknown architecture 99/)
  })
})

describe('packaged wheel-set directory resolution', () => {
  it('maps packaged module paths onto the resources python-wheels directory', () => {
    // The runtime mirror of the bundled-python layout test: a packaged module
    // lives at <resources>/app.asar.unpacked/lib/<name>.js, so the wheel set
    // is its sibling resource directory.
    const packaged = packagedPythonWheelsDirectory('file:///C:/install/resources/app.asar.unpacked/lib/main.js')
    expect(packaged.endsWith(join('resources', 'python-wheels'))).toBe(true)
    expect(packagedPythonWheelsDirectory(new URL('file:///workspace/lib/main.js').href)
      .endsWith(join('python-wheels'))).toBe(true)
  })
})
