import { describe, expect, it, vi } from 'vitest'
import {
  createGitHubPackageVerifier,
  githubPackageManifestUrl,
  githubPackageTarget,
} from '../src/install/github.js'

const source = {
  kind: 'github' as const,
  owner: 'example',
  repo: 'plugin',
  commit: '0123456789abcdef0123456789abcdef01234567',
  subdirectory: 'packages/plugin',
}

describe('GitHub package verification', () => {
  it('constructs a pinned target and raw manifest URL', () => {
    expect(githubPackageTarget(source)).toBe(
      'github:example/plugin#0123456789abcdef0123456789abcdef01234567&path:/packages/plugin',
    )
    expect(githubPackageManifestUrl(source)).toBe(
      'https://raw.githubusercontent.com/example/plugin/0123456789abcdef0123456789abcdef01234567/packages/plugin/package.json',
    )
  })

  it('verifies package identity, stable version, and DSH bundle metadata', async () => {
    const url = githubPackageManifestUrl(source)
    const http = {
      getJson: vi.fn(async () => ({
        finalUrl: url,
        value: {
          name: '@example/dsh-plugin',
          version: '1.2.3',
          dsh: { bundle: { patch: './patches/plugin.patch' } },
        },
      })),
    }
    await expect(createGitHubPackageVerifier(http).verify(source, new AbortController().signal)).resolves.toEqual({
      packageName: '@example/dsh-plugin',
      version: '1.2.3',
      bundlePatch: './patches/plugin.patch',
      source,
      requiresBuildApproval: false,
    })
    expect(http.getJson).toHaveBeenCalledWith(url, expect.any(AbortSignal), { allowedOrigin: 'https://raw.githubusercontent.com' })
  })

  it('reports pinned GitHub lifecycle scripts as requiring manual build approval', async () => {
    const url = githubPackageManifestUrl(source)
    const http = {
      getJson: vi.fn(async () => ({
        finalUrl: url,
        value: {
          name: '@example/dsh-plugin',
          version: '1.2.3',
          scripts: { prepare: 'node build.js' },
          dsh: { bundle: { patch: './patches/plugin.patch' } },
        },
      })),
    }

    await expect(createGitHubPackageVerifier(http).verify(source, new AbortController().signal))
      .resolves.toMatchObject({ requiresBuildApproval: true })
  })

  it.each([
    ['a redirect', { finalUrl: 'https://evil.example/package.json', value: {} }],
    ['an invalid package name', { value: { name: 'bad name', version: '1.2.3', dsh: { bundle: { patch: './plugin.patch' } } } }],
    ['an invalid version', { value: { name: 'plugin', version: 'latest', dsh: { bundle: { patch: './plugin.patch' } } } }],
    ['a missing bundle patch', { value: { name: 'plugin', version: '1.2.3', dsh: { bundle: {} } } }],
  ])('rejects %s', async (_label, response) => {
    const http = { getJson: vi.fn(async () => ({ finalUrl: githubPackageManifestUrl(source), ...response })) }
    await expect(createGitHubPackageVerifier(http).verify(source, new AbortController().signal)).rejects.toThrow(/GitHub package verification failed/u)
  })
})
