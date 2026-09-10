import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_PYTHON_ARCHIVE,
  BUNDLED_PYTHON_ARCHIVE_SHA256,
  BUNDLED_PYTHON_COMMAND_NAME,
  BUNDLED_PYTHON_DIGEST_MANIFEST_NAME,
  BUNDLED_PYTHON_DIST_ORIGIN,
  BUNDLED_PYTHON_PTH_MEMBER,
  BUNDLED_PYTHON_VERSION,
  type BundledPythonArchiveVerifier,
  bundledPythonArchiveUrl,
  bundledPythonTarget,
  collectBundledPythonFileDigests,
  downloadBundledPythonArchive,
  extractBundledPythonRuntime,
  prepareBundledPython,
  verifyBundledPythonArchive,
} from '../scripts/bundled-python.ts'
import { beforePack } from '../scripts/prepare-bundled-python.ts'
import {
  BUNDLED_PYTHON_DIGEST_MANIFEST_NAME as RUNTIME_MANIFEST_NAME,
  bundledPythonCommandName,
  bundledPythonDigestManifestPath,
  clearBundledPythonRuntimeVerificationCache,
  packagedBundledPythonDirectory,
  parseBundledPythonDigestManifest,
  resolveDesktopPythonExecutable,
} from '../src/desktop-python-runtime.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundled-python-'))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.DSH_BUNDLED_PYTHON_ARCHIVE
  clearBundledPythonRuntimeVerificationCache()
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Shipped `._pth` body staging must unlock. */
const SHIPPED_PTH = 'python312.zip\n.\n\n# Uncomment to run site.main() automatically\n#import site\n'

/** The same body after the staging unlock. */
const UNLOCKED_PTH = 'python312.zip\n.\n\n# Uncomment to run site.main() automatically\nimport site\n'

/** Members of one minimal but structurally faithful fake embeddable archive. */
function fakeEmbeddableMembers(): Record<string, string> {
  return {
    'LICENSE.txt': 'python license\n',
    [BUNDLED_PYTHON_COMMAND_NAME]: 'fake-python-exe\n',
    [BUNDLED_PYTHON_PTH_MEMBER]: SHIPPED_PTH,
    'python312.zip': 'fake-zipped-stdlib\n',
    'vcruntime140.dll': 'fake-runtime-dll\n',
  }
}

function fakeArchive(path: string, members: Record<string, string> = fakeEmbeddableMembers()): string {
  const zip = new AdmZip()
  for (const [name, contents] of Object.entries(members)) {
    zip.addFile(name, Buffer.from(contents, 'utf8'))
  }
  zip.writeZip(path)
  return path
}

/** Fake verifier that accepts exactly the archive bytes it was primed with. */
function acceptOnly(expected: Buffer): BundledPythonArchiveVerifier {
  return path => {
    if (!readFileSync(path).equals(expected)) {
      throw new Error(`dsh-plugin-desktop: bundled Python archive ${path} hashed to a mismatching digest`)
    }
  }
}

/** Extract a fake archive exactly like the production extractor. */
function extractFakeArchive(archivePath: string, stagingDirectory: string): void {
  new AdmZip(archivePath).extractAllTo(stagingDirectory, false)
}

describe('pinned bundled Python distribution', () => {
  it('pins one version and a checksum for the embeddable target', () => {
    expect(BUNDLED_PYTHON_VERSION).toMatch(/^3\.12\.\d+$/u)
    expect(bundledPythonCommandName()).toBe(BUNDLED_PYTHON_COMMAND_NAME)
    expect(BUNDLED_PYTHON_ARCHIVE).toBe(`python-${BUNDLED_PYTHON_VERSION}-embed-amd64.zip`)
    expect(BUNDLED_PYTHON_ARCHIVE_SHA256).toMatch(/^[0-9a-f]{64}$/u)
    expect(bundledPythonArchiveUrl()).toBe(
      `${BUNDLED_PYTHON_DIST_ORIGIN}/${BUNDLED_PYTHON_VERSION}/${BUNDLED_PYTHON_ARCHIVE}`,
    )
  })

  it('maps packaging identities onto the one pinned target', () => {
    expect(bundledPythonTarget('win32', 'x64')).toBe('win-x64')
    expect(() => bundledPythonTarget('darwin', 'arm64')).toThrow('no pinned Python distribution')
    expect(() => bundledPythonTarget('win32', 'arm64')).toThrow('no pinned Python distribution')
  })

  it('rejects archive bytes that do not match the pinned checksum', () => {
    const root = temporaryDirectory()
    const archivePath = join(root, BUNDLED_PYTHON_ARCHIVE)
    writeFileSync(archivePath, 'tampered bytes')

    expect(() => verifyBundledPythonArchive(archivePath)).toThrow('instead of the pinned')
    expect(createHash('sha256').update('tampered bytes').digest('hex')).not.toBe(BUNDLED_PYTHON_ARCHIVE_SHA256)
  })

  it('downloads once, reuses a verified cache entry, and replaces a tampered one', async () => {
    const root = temporaryDirectory()
    const archivePath = join(root, BUNDLED_PYTHON_ARCHIVE)
    const archiveBytes = Buffer.from(`python-archive-v${BUNDLED_PYTHON_VERSION}-embed-amd64`)
    const fetchArchive = vi.fn(async (url: string): Promise<Response> => {
      expect(url).toBe(bundledPythonArchiveUrl())
      return new Response(archiveBytes)
    })
    const verify = vi.fn(acceptOnly(archiveBytes))

    await downloadBundledPythonArchive(archivePath, fetchArchive, verify)
    expect(fetchArchive).toHaveBeenCalledOnce()
    expect(readFileSync(archivePath)).toEqual(archiveBytes)

    // The verified cache entry prevents a second download.
    await downloadBundledPythonArchive(archivePath, fetchArchive, verify)
    expect(fetchArchive).toHaveBeenCalledOnce()

    writeFileSync(archivePath, 'tampered')
    await downloadBundledPythonArchive(archivePath, fetchArchive, verify)
    expect(fetchArchive).toHaveBeenCalledTimes(2)
    expect(readFileSync(archivePath)).toEqual(archiveBytes)
  })

  it('rejects a non-OK download response', async () => {
    const root = temporaryDirectory()
    const archivePath = join(root, BUNDLED_PYTHON_ARCHIVE)

    await expect(downloadBundledPythonArchive(archivePath, async () => new Response('gone', { status: 404 })))
      .rejects.toThrow('failed with 404')
  })

  it('extracts the whole tree and unlocks the path configuration', () => {
    const root = temporaryDirectory()
    const archivePath = fakeArchive(join(root, BUNDLED_PYTHON_ARCHIVE))
    const stagingDirectory = join(root, 'python-runtime')

    const commandPath = extractBundledPythonRuntime(archivePath, stagingDirectory, extractFakeArchive)

    expect(commandPath).toBe(join(stagingDirectory, BUNDLED_PYTHON_COMMAND_NAME))
    expect(statSync(commandPath).isFile()).toBe(true)
    expect(readdirSync(stagingDirectory).sort()).toEqual([
      'LICENSE.txt',
      'python.exe',
      'python312._pth',
      'python312.zip',
      'vcruntime140.dll',
    ])
    expect(readFileSync(join(stagingDirectory, BUNDLED_PYTHON_PTH_MEMBER), 'utf8')).toBe(UNLOCKED_PTH)
  })

  it('fails loud when the archive lacks the command or the path configuration', () => {
    const root = temporaryDirectory()
    const withoutCommand = fakeEmbeddableMembers()
    delete withoutCommand[BUNDLED_PYTHON_COMMAND_NAME]
    expect(() => extractBundledPythonRuntime(
      fakeArchive(join(root, 'a.zip'), withoutCommand),
      join(root, 'staging-a'),
      extractFakeArchive,
    )).toThrow('did not provide python.exe')

    const withoutPth = fakeEmbeddableMembers()
    delete withoutPth[BUNDLED_PYTHON_PTH_MEMBER]
    expect(() => extractBundledPythonRuntime(
      fakeArchive(join(root, 'b.zip'), withoutPth),
      join(root, 'staging-b'),
      extractFakeArchive,
    )).toThrow(`did not provide ${BUNDLED_PYTHON_PTH_MEMBER}`)
  })

  it('collects per-file digests over nested trees with forward-slash keys', () => {
    const root = temporaryDirectory()
    const tree = join(root, 'tree')
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'python.exe'), 'exe\n')
    writeFileSync(join(tree, 'LICENSE.txt'), 'license\n')
    const dlls = join(tree, 'DLLs')
    mkdirSync(dlls, { recursive: true })
    writeFileSync(join(dlls, 'pyexpat.pyd'), 'pyd\n')
    writeFileSync(join(dlls, '_ssl.pyd'), 'ssl\n')

    const digests = collectBundledPythonFileDigests(tree)

    expect(Object.keys(digests)).toEqual(['DLLs/_ssl.pyd', 'DLLs/pyexpat.pyd', 'LICENSE.txt', 'python.exe'])
    expect(digests['python.exe']).toBe(createHash('sha256').update('exe\n').digest('hex'))
  })

  it('stages through the pinned archive override without any network access', async () => {
    const root = temporaryDirectory()
    const archivePath = fakeArchive(join(root, 'override-archive'))
    process.env.DSH_BUNDLED_PYTHON_ARCHIVE = archivePath
    const fetchArchive = vi.fn(async () => {
      throw new Error('network must not be used with an archive override')
    })

    // The fake archive does not match the real pinned checksum; the override
    // path is still checksum-verified, so staging must fail loud.
    await expect(prepareBundledPython({
      desktopRoot: root,
      platform: 'win32',
      arch: 'x64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory: join(root, 'cache'),
      fetchArchive: fetchArchive as unknown as typeof fetch,
    })).rejects.toThrow('instead of the pinned')
    expect(fetchArchive).not.toHaveBeenCalled()
  })

  it('stages unsupported platforms instead of guessing an embeddable layout', async () => {
    await expect(prepareBundledPython({
      desktopRoot: temporaryDirectory(),
      platform: 'darwin',
      arch: 'arm64',
    })).rejects.toThrow('no pinned Python distribution')
  })

  it('skips staging entirely for non-Windows beforePack runs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await beforePack({ appOutDir: '/out', electronPlatformName: 'darwin', arch: 3 })

    expect(log).toHaveBeenCalledWith('dsh-plugin-desktop: skipping the bundled Python runtime on darwin')
    log.mockRestore()
  })

  it('maps Electron Builder architectures and rejects unknown values', () => {
    // The fake override never matches the pinned checksum, so the mapped
    // runs fail loud before any network access.
    const root = temporaryDirectory()
    process.env.DSH_BUNDLED_PYTHON_ARCHIVE = fakeArchive(join(root, 'override-archive'))

    expect(beforePack({ appOutDir: '/out', electronPlatformName: 'win32', arch: 1 }))
      .rejects.toThrow('instead of the pinned')
    expect(beforePack({ appOutDir: '/out', electronPlatformName: 'win32' }))
      .rejects.toThrow('instead of the pinned')
    expect(beforePack({ appOutDir: '/out', electronPlatformName: 'win32', arch: 9 }))
      .rejects.toThrow('unknown architecture 9')
  })
})

describe('bundled Python digest manifest', () => {
  it('writes the per-file digest manifest while staging', async () => {
    const root = temporaryDirectory()
    const override = fakeArchive(join(root, 'override-archive'))
    process.env.DSH_BUNDLED_PYTHON_ARCHIVE = override
    const desktopRoot = join(root, 'app')
    const fetchArchive = vi.fn(async () => {
      throw new Error('staging with an archive override must not reach the network')
    })

    const staged = await prepareBundledPython({
      desktopRoot,
      platform: 'win32',
      arch: 'x64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory: join(root, 'cache'),
      fetchArchive: fetchArchive as unknown as typeof fetch,
      verifyArchive: acceptOnly(readFileSync(override)),
      extractArchive: extractFakeArchive,
    })

    expect(staged.endsWith(BUNDLED_PYTHON_COMMAND_NAME)).toBe(true)
    const manifestPath = join(desktopRoot, 'lib', BUNDLED_PYTHON_DIGEST_MANIFEST_NAME)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: string
      platform: string
      files: Record<string, string>
    }
    expect(manifest.version).toBe(BUNDLED_PYTHON_VERSION)
    expect(manifest.platform).toBe('win32')
    expect(Object.keys(manifest.files)).toEqual([
      'LICENSE.txt',
      'python.exe',
      'python312._pth',
      'python312.zip',
      'vcruntime140.dll',
    ])
    // The unlock itself is pinned: the manifest hashes the rewritten _pth.
    expect(manifest.files[BUNDLED_PYTHON_PTH_MEMBER]).toBe(
      createHash('sha256').update(UNLOCKED_PTH).digest('hex'),
    )
    expect(manifest.files['python.exe']).toBe(
      createHash('sha256').update('fake-python-exe\n').digest('hex'),
    )
    expect(fetchArchive).not.toHaveBeenCalled()

    // Deterministic bytes: a second pass rewrites the identical manifest.
    const first = readFileSync(manifestPath, 'utf8')
    await prepareBundledPython({
      desktopRoot,
      platform: 'win32',
      arch: 'x64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory: join(root, 'cache'),
      fetchArchive: vi.fn(async () => {
        throw new Error('the verified archive cache must serve the second pass')
      }) as unknown as typeof fetch,
      verifyArchive: acceptOnly(readFileSync(override)),
      extractArchive: extractFakeArchive,
    })
    expect(readFileSync(manifestPath, 'utf8')).toBe(first)
  })
})

const WINDOWS_PACKAGED_MODULE_URL = new URL(
  'file:///C:/Program%20Files/DSH%20Desktop/resources/app.asar.unpacked/lib/desktop-python-runtime.js',
).href

const PINNED_DIGEST = 'a'.repeat(64)
const TAMPERED_DIGEST = 'f'.repeat(64)

/** One well-formed Windows per-file digest manifest text. */
function windowsManifestText(files: Record<string, string> = {
  'LICENSE.txt': 'b'.repeat(64),
  'python.exe': PINNED_DIGEST,
  'python312._pth': 'c'.repeat(64),
  'python312.zip': 'd'.repeat(64),
}): string {
  return `${JSON.stringify({ version: BUNDLED_PYTHON_VERSION, platform: 'win32', files }, undefined, 2)}\n`
}

/** Resolution seams for one packaged-layout Python resolution. */
function packagedSeams(overrides: Partial<{
  manifestText: string
  listed: readonly string[]
  digest: (filename: string) => string
}> = {}) {
  const files = JSON.parse(overrides.manifestText ?? windowsManifestText()) as { files: Record<string, string> }
  const digests = files.files
  return {
    readDigestManifest: vi.fn(() => overrides.manifestText ?? windowsManifestText()),
    listRuntimeFiles: vi.fn(() => overrides.listed ?? Object.keys(digests).sort()),
    statFile: vi.fn(() => ({ mtimeMs: 1_000, size: 11_000_000 })),
    digestFile: vi.fn((filename: string) =>
      overrides.digest?.(filename) ?? digests[basename(filename)] ?? TAMPERED_DIGEST),
    exists: vi.fn((filename: string) => filename.endsWith(BUNDLED_PYTHON_COMMAND_NAME)),
  }
}

describe('bundled Python runtime resolution', () => {
  it('maps packaged module paths onto the resources python-runtime directory', () => {
    expect(packagedBundledPythonDirectory(WINDOWS_PACKAGED_MODULE_URL)
      .endsWith(join('resources', 'python-runtime'))).toBe(true)
    expect(basename(packagedBundledPythonDirectory(WINDOWS_PACKAGED_MODULE_URL))).toBe('python-runtime')
    expect(bundledPythonDigestManifestPath(WINDOWS_PACKAGED_MODULE_URL)
      .endsWith(join('app.asar', 'lib', RUNTIME_MANIFEST_NAME))).toBe(true)
    expect(bundledPythonDigestManifestPath(new URL(
      'file:///workspace/dsh-plugin-desktop/lib/desktop-python-runtime.js',
    ).href)).toBe(`/workspace/dsh-plugin-desktop/lib/${RUNTIME_MANIFEST_NAME}`)
  })

  it('strictly parses per-file digest manifests', () => {
    const manifest = parseBundledPythonDigestManifest(JSON.parse(windowsManifestText()))
    expect(manifest.version).toBe(BUNDLED_PYTHON_VERSION)
    expect(manifest.platform).toBe('win32')
    expect(Object.keys(manifest.files)).toEqual(['LICENSE.txt', 'python.exe', 'python312._pth', 'python312.zip'])

    expect(() => parseBundledPythonDigestManifest(JSON.parse(
      windowsManifestText({ 'python.exe': PINNED_DIGEST, '../escape.exe': 'b'.repeat(64) }),
    ))).toThrow('safe relative path')
    expect(() => parseBundledPythonDigestManifest(JSON.parse(
      windowsManifestText({ 'C:/evil.exe': 'b'.repeat(64) }),
    ))).toThrow('safe relative path')
    expect(() => parseBundledPythonDigestManifest(JSON.parse(
      windowsManifestText({ 'python.exe': 'not-a-digest' }),
    ))).toThrow('safe relative path')
    expect(() => parseBundledPythonDigestManifest({ version: '3.12.10', platform: 'win32' }))
      .toThrow('unexpected fields')
    expect(() => parseBundledPythonDigestManifest({
      version: '3.12.10',
      platform: 'win32',
      files: {},
    })).toThrow('must not be empty')
  })

  it('resolves the fully verified bundled command in the packaged layout', () => {
    const seams = packagedSeams()
    const expected = join(packagedBundledPythonDirectory(WINDOWS_PACKAGED_MODULE_URL), 'python.exe')

    expect(resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows\\System32' },
      ...seams,
    })).toBe(expected)
    expect(seams.digestFile).toHaveBeenCalledTimes(4)
  })

  it('trusts an unchanged fingerprint instead of re-hashing within one process', () => {
    const seams = packagedSeams()

    resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      ...seams,
    })
    resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      ...seams,
    })

    expect(seams.statFile).toHaveBeenCalled()
    expect(seams.digestFile).toHaveBeenCalledTimes(4)
  })

  it('rejects a tampered bundled file against the packaged digest manifest', () => {
    const seams = packagedSeams({ digest: () => TAMPERED_DIGEST })

    expect(() => resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      ...seams,
    })).toThrow(`hashed to ${TAMPERED_DIGEST} instead of the pinned`)
  })

  it('rejects a tree missing a pinned file or carrying an unexpected file', () => {
    expect(() => resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      ...packagedSeams({ listed: ['LICENSE.txt', 'python.exe', 'python312._pth'] }),
    })).toThrow('missing pinned files: python312.zip')

    expect(() => resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      ...packagedSeams({ listed: ['LICENSE.txt', 'python.exe', 'python312.zip', 'sitecustomize.py'] }),
    })).toThrow('unexpected files: sitecustomize.py')
  })

  it('rejects an unreadable digest manifest instead of trusting the command', () => {
    expect(() => resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      exists: () => true,
      readDigestManifest: () => {
        throw new Error('ENOENT')
      },
      listRuntimeFiles: () => ['python.exe'],
      statFile: () => ({ mtimeMs: 1, size: 1 }),
      digestFile: () => PINNED_DIGEST,
    })).toThrow('the packaged digest manifest is unreadable')
  })

  it('rejects a digest manifest covering another platform', () => {
    const foreign = `${JSON.stringify({
      version: BUNDLED_PYTHON_VERSION,
      platform: 'darwin',
      files: { 'python.exe': PINNED_DIGEST },
    }, undefined, 2)}\n`

    expect(() => resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      ...packagedSeams({ manifestText: foreign }),
    })).toThrow('covers platform "darwin"')
  })

  it('refuses the surface when the packaged command itself is missing', () => {
    expect(() => resolveDesktopPythonExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      ...packagedSeams(),
      exists: () => false,
    })).toThrow('missing its bundled Python command')
  })

  it('reuses the development PATH command in an unpackaged checkout', () => {
    const directory = 'C:\\Python312'
    const development = join(directory, 'python.exe')

    expect(resolveDesktopPythonExecutable(new URL(
      'file:///workspace/dsh-plugin-desktop/lib/desktop-python-runtime.js',
    ).href, {
      platform: 'win32',
      environment: { PATH: `C:\\Windows;${directory}` },
      exists: filename => filename === development,
    })).toBe(development)

    expect(() => resolveDesktopPythonExecutable(new URL(
      'file:///workspace/dsh-plugin-desktop/lib/desktop-python-runtime.js',
    ).href, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      exists: () => false,
    })).toThrow('no Python command is available')

    expect(() => resolveDesktopPythonExecutable(new URL(
      'file:///workspace/dsh-plugin-desktop/lib/desktop-python-runtime.js',
    ).href, {
      platform: 'darwin',
      environment: { PATH: '/usr/bin' },
    })).toThrow('unsupported on darwin')
  })

  it('skips the WindowsApps store stub while scanning the development PATH', () => {
    const stubDirectory = 'C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps'
    const stub = join(stubDirectory, 'python.exe')
    const realDirectory = 'C:\\Python312'
    const real = join(realDirectory, 'python.exe')
    const moduleUrl = new URL(
      'file:///workspace/dsh-plugin-desktop/lib/desktop-python-runtime.js',
    ).href
    const probe = (filename: string): boolean => filename === stub || filename === real

    // The WindowsApps execution alias exists on disk (that is how the store
    // stub works) and shadows any later real install, so the scan must pass
    // it over and select the real interpreter further down PATH.
    expect(resolveDesktopPythonExecutable(moduleUrl, {
      platform: 'win32',
      environment: { PATH: `C:\\Windows;${stubDirectory};${realDirectory}` },
      exists: probe,
    })).toBe(real)

    // A stub-only PATH fails loud instead of handing the terminal a dead
    // alias that opens the Microsoft Store.
    expect(() => resolveDesktopPythonExecutable(moduleUrl, {
      platform: 'win32',
      environment: { PATH: `C:\\Windows;${stubDirectory}` },
      exists: probe,
    })).toThrow('no Python command is available')

    // The exclusion is segment-wise and case-insensitive: localized and
    // lowercased alias directories are skipped too, while a directory merely
    // containing the substring is not.
    expect(resolveDesktopPythonExecutable(moduleUrl, {
      platform: 'win32',
      environment: { PATH: `c:\\users\\example\\appdata\\local\\microsoft\\windowsapps;${realDirectory}` },
      exists: probe,
    })).toBe(real)
    const windowsappsTools = 'C:\\Tools\\windowsapps-scripts'
    const substringInterpreter = join(windowsappsTools, 'python.exe')
    expect(resolveDesktopPythonExecutable(moduleUrl, {
      platform: 'win32',
      environment: { PATH: windowsappsTools },
      exists: filename => filename === substringInterpreter,
    })).toBe(substringInterpreter)
  })
})

describe('staged development bundle', () => {
  const stagedCommand = join(
    fileURLToPath(new URL('..', import.meta.url)),
    'build',
    'python-runtime',
    BUNDLED_PYTHON_COMMAND_NAME,
  )

  // This probe is inherently win32-only, mirroring the bundled-Node staged
  // probe precedent: the embeddable CPython distribution is staged by
  // `beforePack` for Windows packages only, so on a linux/macOS checkout
  // `build/python-runtime/python.exe` never exists and `it.runIf` skips it —
  // the skip below is that expected behavior, not a broken gate.
  it.runIf(existsFileSync(stagedCommand))('holds a real staged command for this host', () => {
    expect(statSync(stagedCommand).isFile()).toBe(true)
    expect(readFileSync(stagedCommand).byteLength).toBeGreaterThan(1_000_000)
  })
})

function existsFileSync(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
