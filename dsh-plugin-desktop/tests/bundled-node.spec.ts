import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_NODE_DISTRIBUTIONS,
  BUNDLED_NODE_DIST_ORIGIN,
  BUNDLED_NODE_VERSION,
  type BundledNodeArchiveVerifier,
  type BundledNodeTarget,
  bundledNodeArchiveUrl,
  bundledNodeTarget,
  downloadBundledNodeArchive,
  extractBundledNodeCommand,
  prepareBundledNode,
  verifyBundledNodeArchive,
} from '../scripts/bundled-node.ts'
import { beforePack, bundledNodeArchitecture } from '../scripts/prepare-bundled-node.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundled-node-'))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.DSH_BUNDLED_NODE_ARCHIVE
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Host target the extraction seams exercise: zip on Windows, tar elsewhere. */
const HOST_TARGET: BundledNodeTarget = process.platform === 'win32' ? 'win-x64' : 'linux-x64'

function fakeArchive(target: BundledNodeTarget, path: string, contents = 'fake-node\n'): string {
  const zip = new AdmZip()
  zip.addFile(BUNDLED_NODE_DISTRIBUTIONS[target].member, Buffer.from(contents, 'utf8'))
  zip.addFile('node.lib', Buffer.from('not the command', 'utf8'))
  zip.writeZip(path)
  return path
}

/** Fake verifier that accepts exactly the archive bytes it was primed with. */
function acceptOnly(expected: Buffer): BundledNodeArchiveVerifier {
  return (_target, path) => {
    if (!readFileSync(path).equals(expected)) {
      throw new Error(`dsh-plugin-desktop: bundled Node archive ${path} hashed to a mismatching digest`)
    }
  }
}

describe('pinned bundled Node distributions', () => {
  it('pins one version and a checksum for every supported target', () => {
    expect(BUNDLED_NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(Object.keys(BUNDLED_NODE_DISTRIBUTIONS).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win-x64',
    ])
    for (const [target, distribution] of Object.entries(BUNDLED_NODE_DISTRIBUTIONS)) {
      expect(distribution.archive, target).toContain(`v${BUNDLED_NODE_VERSION}`)
      expect(distribution.sha256, target).toMatch(/^[0-9a-f]{64}$/u)
      expect(bundledNodeArchiveUrl(target as BundledNodeTarget))
        .toBe(`${BUNDLED_NODE_DIST_ORIGIN}/v${BUNDLED_NODE_VERSION}/${distribution.archive}`)
    }
  })

  it('maps packaging identities onto pinned targets', () => {
    expect(bundledNodeTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(bundledNodeTarget('win32', 'x64')).toBe('win-x64')
    expect(bundledNodeTarget('linux', 'x64')).toBe('linux-x64')
    expect(() => bundledNodeTarget('linux', 'arm64')).toThrow('no pinned Node distribution')
  })

  it('rejects archive bytes that do not match the pinned checksum', () => {
    const root = temporaryDirectory()
    const archivePath = join(root, 'archive.tar.gz')
    writeFileSync(archivePath, 'tampered bytes')

    expect(() => verifyBundledNodeArchive('linux-x64', archivePath))
      .toThrow('instead of the pinned')
    expect(createHash('sha256').update('tampered bytes').digest('hex')).not.toBe(
      BUNDLED_NODE_DISTRIBUTIONS['linux-x64'].sha256,
    )
  })

  it('downloads once, reuses a verified cache entry, and replaces a tampered one', async () => {
    const root = temporaryDirectory()
    const target = 'linux-x64' as const
    const archivePath = join(root, BUNDLED_NODE_DISTRIBUTIONS[target].archive)
    const archiveBytes = Buffer.from(`node-archive-v${BUNDLED_NODE_VERSION}-linux-x64`)
    const fetchArchive = vi.fn(async (url: string): Promise<Response> => {
      expect(url).toBe(bundledNodeArchiveUrl(target))
      return new Response(archiveBytes)
    })
    const verify = vi.fn(acceptOnly(archiveBytes))

    await downloadBundledNodeArchive(target, archivePath, fetchArchive, verify)
    expect(fetchArchive).toHaveBeenCalledOnce()
    expect(readFileSync(archivePath)).toEqual(archiveBytes)

    // The verified cache entry prevents a second download.
    await downloadBundledNodeArchive(target, archivePath, fetchArchive, verify)
    expect(fetchArchive).toHaveBeenCalledOnce()

    writeFileSync(archivePath, 'tampered')
    await downloadBundledNodeArchive(target, archivePath, fetchArchive, verify)
    expect(fetchArchive).toHaveBeenCalledTimes(2)
    expect(readFileSync(archivePath)).toEqual(archiveBytes)
  })

  it('rejects a non-OK download response', async () => {
    const root = temporaryDirectory()
    const archivePath = join(root, BUNDLED_NODE_DISTRIBUTIONS['linux-x64'].archive)

    await expect(downloadBundledNodeArchive('linux-x64', archivePath, async () => new Response('gone', { status: 404 })))
      .rejects.toThrow('failed with 404')
  })

  it('extracts only the Node command and marks it executable', () => {
    const root = temporaryDirectory()
    const archivePath = fakeArchive(HOST_TARGET, join(root, BUNDLED_NODE_DISTRIBUTIONS[HOST_TARGET].archive))
    const stagingDirectory = join(root, 'node-runtime')

    const commandPath = extractBundledNodeCommand(
      HOST_TARGET,
      archivePath,
      stagingDirectory,
      (source, destination) => {
        const zip = new AdmZip(source)
        zip.extractEntryTo(BUNDLED_NODE_DISTRIBUTIONS[HOST_TARGET].member, destination, false, true)
      },
    )

    expect(commandPath.endsWith(HOST_TARGET === 'win-x64' ? 'node.exe' : 'node')).toBe(true)
    expect(readFileSync(commandPath, 'utf8')).toBe('fake-node\n')
    expect(statSync(commandPath).mode & 0o777).toBe(0o755)
  })

  it('stages through the pinned archive override without any network access', async () => {
    const root = temporaryDirectory()
    const archivePath = fakeArchive(HOST_TARGET, join(root, 'override-archive'))
    process.env.DSH_BUNDLED_NODE_ARCHIVE = archivePath
    const stagingDirectory = join(root, 'staging')
    const fetchArchive = vi.fn(async () => {
      throw new Error('network must not be used with an archive override')
    })

    // The fake archive does not match the real pinned checksum; the override
    // path is still checksum-verified, so staging must fail loud.
    await expect(prepareBundledNode({
      desktopRoot: root,
      platform: process.platform,
      arch: process.arch,
      stagingDirectory,
      cacheDirectory: join(root, 'cache'),
      fetchArchive: fetchArchive as unknown as typeof fetch,
    })).rejects.toThrow('instead of the pinned')
    expect(fetchArchive).not.toHaveBeenCalled()
  })

  it('maps Electron Builder architectures onto staging architectures', () => {
    expect(bundledNodeArchitecture({ appOutDir: '/out', electronPlatformName: 'win32', arch: 1 }))
      .toBe('x64')
    expect(bundledNodeArchitecture({ appOutDir: '/out', electronPlatformName: 'darwin', arch: 3 }))
      .toBe('arm64')
    expect(bundledNodeArchitecture(
      { appOutDir: '/out', electronPlatformName: 'darwin', arch: 4 },
      'arm64',
    )).toBe('arm64')
    expect(bundledNodeArchitecture({ appOutDir: '/out', electronPlatformName: 'win32' }, 'x64'))
      .toBe('x64')
    expect(() => bundledNodeArchitecture({ appOutDir: '/out', electronPlatformName: 'win32', arch: 9 }))
      .toThrow('unknown architecture 9')
  })

  it('rejects a beforePack platform without a pinned distribution', async () => {
    await expect(beforePack({ appOutDir: '/out', electronPlatformName: 'freebsd', arch: 1 }))
      .rejects.toThrow('no pinned Node distribution')
  })
})

describe('staged development bundle', () => {
  const stagedCommand = join(
    fileURLToPath(new URL('..', import.meta.url)),
    'build',
    'node-runtime',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )

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

describe('bundled Node digest manifest', () => {
  it('writes the platform-scoped digest manifest while staging a single-arch target', async () => {
    const root = temporaryDirectory()
    const override = fakeArchive(HOST_TARGET, join(root, 'override-archive'), 'staged-node\n')
    process.env.DSH_BUNDLED_NODE_ARCHIVE = override
    const desktopRoot = join(root, 'app')
    const fetchArchive = vi.fn(async () => {
      throw new Error('staging a single-arch target must not reach the network beyond the override')
    })
    const zipExtract = (source: string, destination: string, member: string) => {
      new AdmZip(source).extractEntryTo(member, destination, false, true)
    }

    const staged = await prepareBundledNode({
      desktopRoot,
      platform: process.platform,
      arch: process.arch,
      stagingDirectory: join(root, 'staging'),
      cacheDirectory: join(root, 'cache'),
      fetchArchive: fetchArchive as unknown as typeof fetch,
      verifyArchive: acceptOnly(readFileSync(override)),
      runTar: zipExtract,
    })

    expect(staged.endsWith(HOST_TARGET === 'win-x64' ? 'node.exe' : 'node')).toBe(true)
    const manifestPath = join(desktopRoot, 'lib', 'node-runtime-sha256.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: string
      platform: string
      commands: Record<string, string>
    }
    expect(manifest.version).toBe(BUNDLED_NODE_VERSION)
    expect(manifest.platform).toBe(process.platform)
    expect(Object.keys(manifest.commands)).toEqual([HOST_TARGET])
    expect(manifest.commands[HOST_TARGET]).toBe(
      createHash('sha256').update('staged-node\n').digest('hex'),
    )
    expect(fetchArchive).not.toHaveBeenCalled()
  })

  it('pins the universal merge digest for macOS targets', async () => {
    const root = temporaryDirectory()
    const desktopRoot = join(root, 'app')
    const cacheDirectory = join(root, 'cache')
    const zipExtract = (source: string, destination: string, member: string) => {
      new AdmZip(source).extractEntryTo(member, destination, false, true)
    }
    const runLipo = vi.fn((x64: string, arm64: string, output: string) => {
      writeFileSync(output, Buffer.concat([
        readFileSync(x64),
        readFileSync(arm64),
      ]))
    })
    const verifier = vi.fn((_target: BundledNodeTarget, _path: string) => {})

    await prepareBundledNode({
      desktopRoot,
      platform: 'darwin',
      arch: 'arm64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory,
      fetchArchive: vi.fn(async (url: string) => {
        const target = url.includes('darwin-x64') ? 'darwin-x64' : 'darwin-arm64'
        const archive = fakeArchive(target, join(root, `${target}.zip`), `node-${target}\n`)
        return new Response(readFileSync(archive))
      }) as unknown as typeof fetch,
      verifyArchive: verifier,
      runTar: zipExtract,
      runLipo,
    })

    const manifest = JSON.parse(readFileSync(
      join(desktopRoot, 'lib', 'node-runtime-sha256.json'),
      'utf8',
    )) as { platform: string, commands: Record<string, string> }
    expect(manifest.platform).toBe('darwin')
    expect(Object.keys(manifest.commands)).toEqual(['darwin-arm64', 'darwin-universal', 'darwin-x64'])
    expect(manifest.commands['darwin-arm64']).toBe(
      createHash('sha256').update('node-darwin-arm64\n').digest('hex'),
    )
    expect(manifest.commands['darwin-x64']).toBe(
      createHash('sha256').update('node-darwin-x64\n').digest('hex'),
    )
    expect(manifest.commands['darwin-universal']).toBe(
      createHash('sha256')
        .update(Buffer.concat([Buffer.from('node-darwin-x64\n'), Buffer.from('node-darwin-arm64\n')]))
        .digest('hex'),
    )
    expect(runLipo).toHaveBeenCalledOnce()
    // Deterministic bytes: a second pass rewrites the identical manifest.
    const first = readFileSync(join(desktopRoot, 'lib', 'node-runtime-sha256.json'), 'utf8')
    await prepareBundledNode({
      desktopRoot,
      platform: 'darwin',
      arch: 'x64',
      stagingDirectory: join(root, 'staging'),
      cacheDirectory,
      fetchArchive: vi.fn(async () => {
        throw new Error('the verified archive cache must serve the second pass')
      }) as unknown as typeof fetch,
      verifyArchive: verifier,
      runTar: zipExtract,
      runLipo,
    })
    expect(readFileSync(join(desktopRoot, 'lib', 'node-runtime-sha256.json'), 'utf8')).toBe(first)
  })
})
