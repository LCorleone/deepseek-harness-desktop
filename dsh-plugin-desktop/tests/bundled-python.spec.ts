import { createHash } from 'node:crypto'
import { existsSync as pathExistsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_PYTHON_ARCHIVE,
  BUNDLED_PYTHON_ARCHIVE_SHA256,
  BUNDLED_PYTHON_COMMAND_NAME,
  BUNDLED_PYTHON_DIGEST_MANIFEST_NAME,
  BUNDLED_PYTHON_DIST_ORIGIN,
  BUNDLED_PYTHON_GETPIP_CACHE_NAME,
  BUNDLED_PYTHON_GETPIP_SHA256,
  BUNDLED_PYTHON_GETPIP_URL,
  BUNDLED_PYTHON_PIP_PACKAGE_FILE,
  BUNDLED_PYTHON_PTH_MEMBER,
  BUNDLED_PYTHON_VIRTUALENV_PACKAGE_FILE,
  BUNDLED_PYTHON_VIRTUALENV_VERSION,
  BUNDLED_PYTHON_VERSION,
  type BundledPythonArchiveVerifier,
  bundledPythonArchiveUrl,
  bundledPythonTarget,
  bootstrapBundledPythonPackages,
  collectBundledPythonFileDigests,
  confirmBundledPythonBootstrap,
  downloadBundledPythonArchive,
  downloadBundledPythonGetPip,
  extractBundledPythonRuntime,
  listBundledPythonFiles,
  prepareBundledPython,
  verifyBundledPythonArchive,
  verifyBundledPythonGetPip,
} from '../scripts/bundled-python.ts'
import { beforePack } from '../scripts/prepare-bundled-python.ts'
import {
  BUNDLED_PYTHON_DIGEST_MANIFEST_NAME as RUNTIME_MANIFEST_NAME,
  bundledPythonCommandName,
  bundledPythonDigestManifestPath,
  clearBundledPythonRuntimeVerificationCache,
  packagedBundledPythonDirectory,
  parseBundledPythonDigestManifest,
  pipAvailabilityFromBundledPythonManifest,
  pythonPipAvailable,
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
  delete process.env.DSH_BUNDLED_PYTHON_GETPIP_ARCHIVE
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

/** Marker files a faithful fake bootstrap leaves, mirroring the real pip layout. */
function fakeBootstrapArtifacts(stagingDirectory: string): void {
  const sitePackages = join(stagingDirectory, 'Lib', 'site-packages')
  for (const [directory, file, contents] of [
    ['pip', '__init__.py', 'pip package\n'],
    ['pip-26.2.1.dist-info', 'METADATA', 'pip metadata\n'],
    ['virtualenv', '__init__.py', 'virtualenv package\n'],
    [`virtualenv-${BUNDLED_PYTHON_VIRTUALENV_VERSION}.dist-info`, 'METADATA', 'virtualenv metadata\n'],
  ] as const) {
    mkdirSync(join(sitePackages, directory), { recursive: true })
    writeFileSync(join(sitePackages, directory, file), contents)
  }
  // The real bootstrap also drops a launcher whose shebang embeds the build
  // host's python path; the post-bootstrap sweep must remove it.
  mkdirSync(join(stagingDirectory, 'Scripts'), { recursive: true })
  writeFileSync(join(stagingDirectory, 'Scripts', 'pip.exe'), 'fake launcher\n')
}

/** Fake bootstrap runner that records its calls and populates the staged tree. */
function fakeBootstrapRunner(events?: string[]) {
  return vi.fn(async (commandPath: string, args: readonly string[]) => {
    events?.push(`bootstrap:${args[0] === '-m' ? 'pip-install' : 'get-pip'}`)
    // The bootstrap depends on the unlocked site machinery: it must observe
    // the live `import site` line, not the shipped comment.
    expect(readFileSync(join(dirname(commandPath), BUNDLED_PYTHON_PTH_MEMBER), 'utf8')).toBe(UNLOCKED_PTH)
    fakeBootstrapArtifacts(dirname(commandPath))
  })
}

/** get-pip fetch and verifier seams primed with one payload's exact bytes. */
function fakeGetPipSeams(payload: Buffer<ArrayBuffer>) {
  return {
    fetchGetPip: vi.fn(async (url: string): Promise<Response> => {
      expect(url).toBe(BUNDLED_PYTHON_GETPIP_URL)
      return new Response(payload)
    }),
    verifyGetPip: acceptOnly(payload),
  }
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
    const getPip = fakeGetPipSeams(Buffer.from('fake-get-pip-payload'))
    const bootstrap = fakeBootstrapRunner()

    const staged = await prepareBundledPython({
      desktopRoot,
      platform: 'win32',
      arch: 'x64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory: join(root, 'cache'),
      fetchArchive: fetchArchive as unknown as typeof fetch,
      verifyArchive: acceptOnly(readFileSync(override)),
      extractArchive: extractFakeArchive,
      ...getPip,
      runBootstrapCommand: bootstrap,
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
      `Lib/site-packages/pip-26.2.1.dist-info/METADATA`,
      `Lib/site-packages/pip/__init__.py`,
      `Lib/site-packages/virtualenv-${BUNDLED_PYTHON_VIRTUALENV_VERSION}.dist-info/METADATA`,
      `Lib/site-packages/virtualenv/__init__.py`,
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
    // The bootstrap artifacts are pinned as part of the shipped tree, and the
    // generated Scripts launchers are swept away before digesting.
    expect(manifest.files[BUNDLED_PYTHON_PIP_PACKAGE_FILE]).toBe(
      createHash('sha256').update('pip package\n').digest('hex'),
    )
    expect(manifest.files[BUNDLED_PYTHON_VIRTUALENV_PACKAGE_FILE]).toBe(
      createHash('sha256').update('virtualenv package\n').digest('hex'),
    )
    expect(pathExistsSync(join(root, 'staging', 'Scripts'))).toBe(false)
    expect(fetchArchive).not.toHaveBeenCalled()
    expect(getPip.fetchGetPip).toHaveBeenCalledOnce()
    expect(bootstrap).toHaveBeenCalledTimes(2)

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
      fetchGetPip: vi.fn(async () => {
        throw new Error('the verified bootstrap-script cache must serve the second pass')
      }) as unknown as typeof fetch,
      verifyGetPip: acceptOnly(Buffer.from('fake-get-pip-payload')),
      runBootstrapCommand: fakeBootstrapRunner(),
    })
    expect(readFileSync(manifestPath, 'utf8')).toBe(first)
  })
})

describe('bundled Python pip and virtualenv bootstrap', () => {
  it('pins the bootstrap script URL and checksum, and the virtualenv version', () => {
    expect(BUNDLED_PYTHON_GETPIP_URL).toBe('https://bootstrap.pypa.io/get-pip.py')
    expect(BUNDLED_PYTHON_GETPIP_SHA256).toMatch(/^[0-9a-f]{64}$/u)
    expect(BUNDLED_PYTHON_VIRTUALENV_VERSION).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  it('rejects bootstrap bytes that do not match the pinned checksum', () => {
    const root = temporaryDirectory()
    const getpipPath = join(root, BUNDLED_PYTHON_GETPIP_CACHE_NAME)
    writeFileSync(getpipPath, 'tampered bytes')

    expect(() => verifyBundledPythonGetPip(getpipPath)).toThrow('instead of the pinned')
    expect(createHash('sha256').update('tampered bytes').digest('hex')).not.toBe(BUNDLED_PYTHON_GETPIP_SHA256)
  })

  it('downloads the pinned bootstrap script once, reuses a verified cache entry, and replaces a tampered one', async () => {
    const root = temporaryDirectory()
    const getpipPath = join(root, BUNDLED_PYTHON_GETPIP_CACHE_NAME)
    const payload = Buffer.from('fake-get-pip-payload')
    const getPip = fakeGetPipSeams(payload)

    await downloadBundledPythonGetPip(getpipPath, getPip.fetchGetPip, getPip.verifyGetPip)
    expect(readFileSync(getpipPath)).toEqual(payload)

    await downloadBundledPythonGetPip(getpipPath, getPip.fetchGetPip, getPip.verifyGetPip)
    expect(getPip.fetchGetPip).toHaveBeenCalledOnce()

    writeFileSync(getpipPath, 'tampered')
    await downloadBundledPythonGetPip(getpipPath, getPip.fetchGetPip, getPip.verifyGetPip)
    expect(getPip.fetchGetPip).toHaveBeenCalledTimes(2)
    expect(readFileSync(getpipPath)).toEqual(payload)
  })

  it('rejects a non-OK bootstrap download response', async () => {
    const root = temporaryDirectory()

    await expect(downloadBundledPythonGetPip(
      join(root, BUNDLED_PYTHON_GETPIP_CACHE_NAME),
      async () => new Response('gone', { status: 503 }),
    )).rejects.toThrow('failed with 503')
  })

  it('runs get-pip then the pinned virtualenv install with the staged command', async () => {
    const root = temporaryDirectory()
    const commandPath = join(root, 'python.exe')
    const getpipPath = join(root, 'get-pip.py')
    const calls: Array<readonly string[]> = []
    await bootstrapBundledPythonPackages(commandPath, getpipPath, async (_command, args) => {
      calls.push(args)
    })

    expect(calls).toEqual([
      [getpipPath, '--no-warn-script-location', '--no-compile'],
      ['-m', 'pip', 'install', `virtualenv==${BUNDLED_PYTHON_VIRTUALENV_VERSION}`, '--no-warn-script-location', '--no-compile'],
    ])
  })

  it('propagates a failing bootstrap command out of staging', async () => {
    await expect(bootstrapBundledPythonPackages(
      join('staging', 'python.exe'),
      join('staging', 'get-pip.py'),
      async () => { throw new Error('exited with 1: no pip') },
    )).rejects.toThrow('exited with 1: no pip')
  })

  it('fails loud when the bootstrap left no pip or virtualenv in the staged tree', () => {
    const root = temporaryDirectory()
    expect(() => confirmBundledPythonBootstrap(root)).toThrow(
      `did not leave ${BUNDLED_PYTHON_PIP_PACKAGE_FILE}`,
    )

    const halfDone = join(root, 'half')
    fakeBootstrapArtifacts(halfDone)
    rmSync(join(halfDone, 'Lib', 'site-packages', 'virtualenv'), { recursive: true, force: true })
    expect(() => confirmBundledPythonBootstrap(halfDone)).toThrow(
      `did not leave ${BUNDLED_PYTHON_VIRTUALENV_PACKAGE_FILE}`,
    )
  })

  it('generates the digest manifest only after the bootstrap populated the tree', async () => {
    const root = temporaryDirectory()
    const override = fakeArchive(join(root, 'override-archive'))
    process.env.DSH_BUNDLED_PYTHON_ARCHIVE = override
    const events: string[] = []
    const stagingDirectory = join(root, 'staging')
    const listFiles = vi.fn((directory: string) => {
      events.push('collect-digests')
      return listBundledPythonFiles(directory)
    })

    await prepareBundledPython({
      desktopRoot: join(root, 'app'),
      platform: 'win32',
      arch: 'x64',
      stagingDirectory,
      cacheDirectory: join(root, 'cache'),
      fetchArchive: vi.fn(async () => { throw new Error('the archive override must not reach the network') }) as unknown as typeof fetch,
      verifyArchive: acceptOnly(readFileSync(override)),
      extractArchive: extractFakeArchive,
      ...fakeGetPipSeams(Buffer.from('fake-get-pip-payload')),
      runBootstrapCommand: fakeBootstrapRunner(events),
      listFiles,
    })

    // A manifest generated before the bootstrap would flip this order — and
    // its file table would miss every site-packages entry.
    expect(events).toEqual(['bootstrap:get-pip', 'bootstrap:pip-install', 'collect-digests'])
    const manifest = JSON.parse(readFileSync(
      join(root, 'app', 'lib', BUNDLED_PYTHON_DIGEST_MANIFEST_NAME),
      'utf8',
    )) as { files: Record<string, string> }
    expect(Object.keys(manifest.files)).toContain(BUNDLED_PYTHON_PIP_PACKAGE_FILE)
    expect(Object.keys(manifest.files)).toContain(BUNDLED_PYTHON_VIRTUALENV_PACKAGE_FILE)
  })

  it('bootstraps through the get-pip override without any network access, seeding the cache', async () => {
    const root = temporaryDirectory()
    const override = fakeArchive(join(root, 'override-archive'))
    process.env.DSH_BUNDLED_PYTHON_ARCHIVE = override
    const getpipOverride = join(root, 'override-get-pip')
    const payload = Buffer.from('fake-get-pip-payload')
    writeFileSync(getpipOverride, payload)
    process.env.DSH_BUNDLED_PYTHON_GETPIP_ARCHIVE = getpipOverride
    const cacheDirectory = join(root, 'cache')

    await prepareBundledPython({
      desktopRoot: join(root, 'app'),
      platform: 'win32',
      arch: 'x64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory,
      fetchArchive: vi.fn(async () => { throw new Error('overrides must not reach the network') }) as unknown as typeof fetch,
      fetchGetPip: vi.fn(async () => { throw new Error('overrides must not reach the network') }) as unknown as typeof fetch,
      verifyArchive: acceptOnly(readFileSync(override)),
      verifyGetPip: acceptOnly(payload),
      extractArchive: extractFakeArchive,
      runBootstrapCommand: fakeBootstrapRunner(),
    })

    expect(readFileSync(join(cacheDirectory, BUNDLED_PYTHON_GETPIP_CACHE_NAME))).toEqual(payload)
  })

  it('rejects a get-pip override whose bytes do not match the pinned checksum', async () => {
    const root = temporaryDirectory()
    const override = fakeArchive(join(root, 'override-archive'))
    process.env.DSH_BUNDLED_PYTHON_ARCHIVE = override
    process.env.DSH_BUNDLED_PYTHON_GETPIP_ARCHIVE = join(root, 'tampered-get-pip')
    writeFileSync(join(root, 'tampered-get-pip'), 'tampered bytes')

    await expect(prepareBundledPython({
      desktopRoot: join(root, 'app'),
      platform: 'win32',
      arch: 'x64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory: join(root, 'cache'),
      fetchArchive: vi.fn(async () => { throw new Error('must not reach the network') }) as unknown as typeof fetch,
      verifyArchive: acceptOnly(readFileSync(override)),
      extractArchive: extractFakeArchive,
      runBootstrapCommand: fakeBootstrapRunner(),
    })).rejects.toThrow('instead of the pinned')
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

/** Manifest file table of a tree whose bootstrap populated pip and virtualenv. */
const BOOTSTRAPPED_MANIFEST_FILES: Record<string, string> = {
  'LICENSE.txt': 'b'.repeat(64),
  'Lib/site-packages/pip-26.2.1.dist-info/METADATA': 'e'.repeat(64),
  'Lib/site-packages/pip/__init__.py': PINNED_DIGEST,
  'Lib/site-packages/virtualenv-21.7.9.dist-info/METADATA': 'f'.repeat(64),
  'Lib/site-packages/virtualenv/__init__.py': '0'.repeat(64),
  'python.exe': '1'.repeat(64),
  'python312._pth': 'c'.repeat(64),
  'python312.zip': 'd'.repeat(64),
}

describe('bundled Python pip availability probe', () => {
  it('derives availability and versions from a manifest with bootstrap artifacts', () => {
    const manifest = parseBundledPythonDigestManifest(JSON.parse(windowsManifestText(BOOTSTRAPPED_MANIFEST_FILES)))

    expect(pipAvailabilityFromBundledPythonManifest(manifest)).toEqual({
      pythonVersion: BUNDLED_PYTHON_VERSION,
      pipAvailable: true,
      virtualenvAvailable: true,
      pipVersion: '26.2.1',
      virtualenvVersion: BUNDLED_PYTHON_VIRTUALENV_VERSION,
    })
  })

  it('reports a bare interpreter tree as carrying neither pip nor virtualenv', () => {
    const manifest = parseBundledPythonDigestManifest(JSON.parse(windowsManifestText()))

    expect(pipAvailabilityFromBundledPythonManifest(manifest)).toEqual({
      pythonVersion: BUNDLED_PYTHON_VERSION,
      pipAvailable: false,
      virtualenvAvailable: false,
      pipVersion: undefined,
      virtualenvVersion: undefined,
    })
  })

  it('answers the packaged probe from the archive-side manifest without spawning python', () => {
    const readDigestManifest = vi.fn(() => windowsManifestText(BOOTSTRAPPED_MANIFEST_FILES))

    expect(pythonPipAvailable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      readDigestManifest,
    })).toEqual({
      pythonVersion: BUNDLED_PYTHON_VERSION,
      pipAvailable: true,
      virtualenvAvailable: true,
      pipVersion: '26.2.1',
      virtualenvVersion: BUNDLED_PYTHON_VIRTUALENV_VERSION,
    })
    expect(readDigestManifest).toHaveBeenCalledOnce()
  })

  it('answers unavailable for an unreadable manifest instead of throwing', () => {
    expect(pythonPipAvailable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\Windows' },
      readDigestManifest: () => { throw new Error('ENOENT') },
    })).toEqual({
      pythonVersion: undefined,
      pipAvailable: false,
      virtualenvAvailable: false,
      pipVersion: undefined,
      virtualenvVersion: undefined,
    })
  })

  it('never consults the bundled manifest outside a packaged application', () => {
    const readDigestManifest = vi.fn(() => windowsManifestText(BOOTSTRAPPED_MANIFEST_FILES))

    expect(pythonPipAvailable(new URL(
      'file:///workspace/dsh-plugin-desktop/lib/desktop-python-runtime.js',
    ).href, {
      platform: 'win32',
      environment: { PATH: 'C:\\Python312' },
      readDigestManifest,
    })).toEqual({
      pythonVersion: undefined,
      pipAvailable: false,
      virtualenvAvailable: false,
      pipVersion: undefined,
      virtualenvVersion: undefined,
    })
    expect(readDigestManifest).not.toHaveBeenCalled()
  })
})

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
