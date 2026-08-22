import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  bundledNodeCommandName,
  packagedBundledNodePath,
  resolveDesktopNodeExecutable,
} from '../src/desktop-node-runtime.ts'

const PACKAGED_MODULE_URL = new URL('file:///Applications/DSH%20Desktop.app/Contents/Resources/app.asar/lib/desktop-node-runtime.js').href
const PACKAGED_UNPACKED_MODULE_URL = new URL('file:///Applications/DSH%20Desktop.app/Contents/Resources/app.asar.unpacked/lib/desktop-node-runtime.js').href

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

  it('prefers the bundled command in the packaged layout', () => {
    const bundled = packagedBundledNodePath(PACKAGED_MODULE_URL, 'darwin')

    expect(resolveDesktopNodeExecutable(PACKAGED_MODULE_URL, {
      platform: 'darwin',
      environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      exists: filename => filename === bundled,
    })).toBe(bundled)
  })

  it('falls back to the development PATH command when nothing is bundled', () => {
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
