import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_NODE_DIGEST_MANIFEST_NAME,
  bundledNodeCommandName,
  bundledNodeDigestManifestPath,
  clearBundledNodeCommandVerificationCache,
  packagedBundledNodePath,
  parseBundledNodeDigestManifest,
  resolveDesktopNodeExecutable,
} from '../src/desktop-node-runtime.ts'

const PACKAGED_MODULE_URL = new URL('file:///Applications/DSH%20Desktop.app/Contents/Resources/app.asar/lib/desktop-node-runtime.js').href
const PACKAGED_UNPACKED_MODULE_URL = new URL('file:///Applications/DSH%20Desktop.app/Contents/Resources/app.asar.unpacked/lib/desktop-node-runtime.js').href
const WINDOWS_PACKAGED_MODULE_URL = new URL('file:///C:/Program%20Files/DSH%20Desktop/resources/app.asar.unpacked/lib/desktop-node-runtime.js').href

const PINNED_COMMAND_SHA256 = 'a'.repeat(64)
const OTHER_PINNED_COMMAND_SHA256 = '0123456789abcdef'.repeat(4)

/** One well-formed darwin digest manifest text. */
function darwinManifestText(commands: Record<string, string> = {
  'darwin-arm64': PINNED_COMMAND_SHA256,
  'darwin-x64': OTHER_PINNED_COMMAND_SHA256,
  'darwin-universal': 'b'.repeat(64),
}): string {
  return `${JSON.stringify({ version: '22.23.2', platform: 'darwin', commands }, undefined, 2)}\n`
}

/** Digest-manifest seams for one packaged-layout resolution. */
function manifestSeams(manifestText: string, digests: string[] = [PINNED_COMMAND_SHA256]) {
  return {
    readDigestManifest: vi.fn((filename: string) => {
      expect(filename).toBe(join(
        '/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib',
        BUNDLED_NODE_DIGEST_MANIFEST_NAME,
      ))
      return manifestText
    }),
    statCommand: vi.fn(() => ({ mtimeMs: 1_000, size: 80_000_000 })),
    digestCommand: vi.fn(() => digests[0] ?? PINNED_COMMAND_SHA256),
  }
}

afterEach(() => {
  clearBundledNodeCommandVerificationCache()
})

describe('bundled Node command resolution', () => {
  it('names the command per platform', () => {
    expect(bundledNodeCommandName('win32')).toBe('node.exe')
    expect(bundledNodeCommandName('darwin')).toBe('node')
    expect(bundledNodeCommandName('linux')).toBe('node')
  })

  it('maps both packaged module paths onto the resources node-runtime directory', () => {
    expect(packagedBundledNodePath(PACKAGED_MODULE_URL, 'darwin')).toBe(
      '/Applications/DSH Desktop.app/Contents/Resources/node-runtime/node',
    )
    expect(packagedBundledNodePath(PACKAGED_UNPACKED_MODULE_URL, 'darwin')).toBe(
      '/Applications/DSH Desktop.app/Contents/Resources/node-runtime/node',
    )
    expect(basename(packagedBundledNodePath(PACKAGED_MODULE_URL, 'win32'))).toBe('node.exe')
  })

  it('prefers the in-archive digest manifest path in both packaged layouts', () => {
    expect(bundledNodeDigestManifestPath(PACKAGED_MODULE_URL)).toBe(
      '/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/node-runtime-sha256.json',
    )
    expect(bundledNodeDigestManifestPath(PACKAGED_UNPACKED_MODULE_URL)).toBe(
      '/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/node-runtime-sha256.json',
    )
    expect(bundledNodeDigestManifestPath(new URL('file:///workspace/dsh-plugin-desktop/lib/desktop-node-runtime.js').href)).toBe(
      '/workspace/dsh-plugin-desktop/lib/node-runtime-sha256.json',
    )
  })

  it('resolves the verified bundled command in the packaged layout', () => {
    const bundled = packagedBundledNodePath(PACKAGED_MODULE_URL, 'darwin')
    const seams = manifestSeams(darwinManifestText())

    expect(resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, {
      platform: 'darwin',
      environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      exists: filename => filename === bundled,
      ...seams,
    })).toBe(bundled)
    expect(seams.readDigestManifest).toHaveBeenCalledOnce()
    expect(seams.digestCommand).toHaveBeenCalledOnce()
  })

  it('rejects a tampered bundled command against the packaged digest manifest', () => {
    const bundled = packagedBundledNodePath(PACKAGED_UNPACKED_MODULE_URL, 'darwin')
    const seams = manifestSeams(darwinManifestText())
    const digestCommand = vi.fn(() => 'f'.repeat(64))

    expect(() => resolveDesktopNodeExecutable(PACKAGED_UNPACKED_MODULE_URL, {
      platform: 'darwin',
      environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      exists: filename => filename === bundled,
      ...seams,
      digestCommand,
    })).toThrow(`hashed to ${'f'.repeat(64)}, which the packaged digest manifest`)
    expect(digestCommand).toHaveBeenCalledOnce()
  })

  it('rejects an unreadable packaged digest manifest instead of trusting the command', () => {
    expect(() => resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, {
      platform: 'darwin',
      exists: () => true,
      readDigestManifest: () => {
        throw new Error('ENOENT')
      },
      statCommand: () => ({ mtimeMs: 1, size: 1 }),
      digestCommand: () => PINNED_COMMAND_SHA256,
    })).toThrow('the packaged digest manifest is unreadable')
  })

  it('rejects a digest manifest covering another platform', () => {
    const linuxManifest = `${JSON.stringify({
      version: '22.23.2',
      platform: 'linux',
      commands: { 'linux-x64': PINNED_COMMAND_SHA256 },
    })}\n`

    expect(() => resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, {
      platform: 'darwin',
      exists: () => true,
      ...manifestSeams(linuxManifest),
    })).toThrow('covers platform "linux" but this application runs on darwin')
  })

  it('reuses one verification while the command file is unchanged', () => {
    const bundled = packagedBundledNodePath(PACKAGED_MODULE_URL, 'darwin')
    const seams = manifestSeams(darwinManifestText())

    for (let invocation = 0; invocation < 3; invocation += 1) {
      expect(resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, {
        platform: 'darwin',
        environment: { PATH: '/usr/bin' },
        exists: filename => filename === bundled,
        ...seams,
      })).toBe(bundled)
    }

    expect(seams.digestCommand).toHaveBeenCalledOnce()
    expect(seams.statCommand).toHaveBeenCalledTimes(3)
    expect(seams.readDigestManifest).toHaveBeenCalledTimes(3)
  })

  it('re-verifies after the command file changes on disk', () => {
    const bundled = packagedBundledNodePath(PACKAGED_MODULE_URL, 'darwin')
    let mtimeMs = 1_000
    const seams = manifestSeams(darwinManifestText())
    const statCommand = vi.fn(() => ({ mtimeMs, size: 80_000_000 }))

    const inputs = {
      platform: 'darwin' as const,
      environment: { PATH: '/usr/bin' },
      exists: (filename: string) => filename === bundled,
      readDigestManifest: seams.readDigestManifest,
      statCommand,
      digestCommand: seams.digestCommand,
    }
    resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, inputs)
    mtimeMs = 2_000
    resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, inputs)

    expect(seams.digestCommand).toHaveBeenCalledTimes(2)
  })

  it('accepts any digest pinned for the packaging platform, including the universal merge', () => {
    const bundled = packagedBundledNodePath(PACKAGED_MODULE_URL, 'darwin')
    const seams = manifestSeams(darwinManifestText())
    seams.digestCommand.mockReturnValue('b'.repeat(64))

    expect(resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, {
      platform: 'darwin',
      environment: { PATH: '/usr/bin' },
      exists: filename => filename === bundled,
      ...seams,
    })).toBe(bundled)
  })

  it('throws without a PATH fallback when the packaged bundled command is missing', () => {
    const exists = vi.fn(() => false)

    expect(() => resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, {
      platform: 'darwin',
      environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      exists,
    })).toThrow(`missing its bundled Node command at ${
      '/Applications/DSH Desktop.app/Contents/Resources/node-runtime/node'}`)
    expect(() => resolveDesktopNodeExecutable(WINDOWS_PACKAGED_MODULE_URL, {
      platform: 'win32',
      environment: { PATH: 'C:\\tools\\node' },
      exists,
    })).toThrow('missing its bundled Node command')
    // A packaged layout never probes PATH, even with a development node present.
    expect(exists).not.toHaveBeenCalledWith(join('/usr/local/bin', 'node'))
  })

  it('falls back to the development PATH command in an unpackaged checkout', () => {
    const devModuleUrl = new URL('file:///workspace/dsh-plugin-desktop/lib/desktop-node-runtime.js').href
    const developmentNode = join('/usr/local/bin', 'node')

    expect(resolveDesktopNodeExecutable(devModuleUrl, {
      platform: 'darwin',
      environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      exists: filename => filename === developmentNode,
    })).toBe(developmentNode)
  })

  it('resolves the Windows PATH key case-insensitively and strips quoted entries', () => {
    const devModuleUrl = new URL('file:///workspace/dsh-plugin-desktop/lib/desktop-node-runtime.js').href
    const developmentNode = join('C:\\tools\\node', 'node.exe')

    expect(resolveDesktopNodeExecutable(devModuleUrl, {
      platform: 'win32',
      environment: { Path: '"C:\\empty";C:\\tools\\node;C:\\Windows' },
      exists: filename => filename === developmentNode,
    })).toBe(developmentNode)
  })

  it('fails loud when no bundled command and no PATH command exist', () => {
    const devModuleUrl = new URL('file:///workspace/dsh-plugin-desktop/lib/desktop-node-runtime.js').href

    expect(() => resolveDesktopNodeExecutable(devModuleUrl, {
      platform: 'linux',
      environment: { PATH: '/usr/bin' },
      exists: () => false,
    })).toThrow('no Node command is available')
  })

  it('resolves through the real development checkout without a bundled distribution', () => {
    // This module runs from src/ in the test tree, so the packaged candidate
    // does not exist and the running Node command comes from PATH.
    const resolved = resolveDesktopNodeExecutable(import.meta.url, {
      platform: process.platform,
      environment: process.env,
    })

    expect(resolved.endsWith(bundledNodeCommandName(process.platform))).toBe(true)
    expect(dirname(fileURLToPath(import.meta.url))).not.toBe(dirname(resolved))
  })
})

describe('bundled Node digest manifest parsing', () => {
  it('accepts a complete manifest and freezes the parsed shape', () => {
    const manifest = parseBundledNodeDigestManifest(JSON.parse(darwinManifestText()))

    expect(manifest).toEqual({
      version: '22.23.2',
      platform: 'darwin',
      commands: {
        'darwin-arm64': PINNED_COMMAND_SHA256,
        'darwin-x64': OTHER_PINNED_COMMAND_SHA256,
        'darwin-universal': 'b'.repeat(64),
      },
    })
    expect(Object.isFrozen(manifest)).toBe(true)
    expect(Object.isFrozen(manifest.commands)).toBe(true)
  })

  it.each([
    ['a non-object root', '[]', 'must be an object'],
    ['unexpected fields', '{"version":"1","platform":"darwin","commands":{},"extra":1}', 'unexpected fields'],
    ['an empty version', '{"version":"","platform":"darwin","commands":{"darwin-x64":"' + 'a'.repeat(64) + '"}}', 'non-empty string'],
    ['non-object commands', '{"version":"1","platform":"darwin","commands":[]}', 'commands must be an object'],
    ['empty commands', '{"version":"1","platform":"darwin","commands":{}}', 'must not be empty'],
    ['a non-hex digest', '{"version":"1","platform":"darwin","commands":{"darwin-x64":"xyz"}}', 'sha256 hex digest'],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseBundledNodeDigestManifest(JSON.parse(text))).toThrow(message)
  })
})
