import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_DOWNLOAD_URLS,
  MAX_UPDATE_DOWNLOAD_BYTES,
  UpdateDownloadError,
  desktopUpdateFilename,
  desktopUpdateSequenceStatePath,
  downloadDesktopUpdate,
  pendingDesktopUpdateArtifact,
  recordDesktopUpdateArtifact,
  resolveDesktopUpdateArtifact,
  type DesktopDownloadPlatform,
  type UpdateArtifactRequest,
  type UpdateVerificationOptions,
} from '../src/update-download.ts'
import { persistSeenUpdateSequence } from '../src/update-manifest.ts'
import type { UpdateChannelTrustRoot } from '../src/update-verification.ts'

const temporaryRoots: string[] = []

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-download-'))
  temporaryRoots.push(root)
  return root
}

function destinationPath(root: string, platform: DesktopDownloadPlatform, version: string): string {
  return join(root, desktopUpdateFilename(platform, version))
}

function dmgArtifact(): Uint8Array {
  const artifact = Buffer.alloc(1024, 0x5a)
  artifact.write('koly', artifact.byteLength - 512, 'ascii')
  return artifact
}

function windowsArtifact(): Uint8Array {
  const artifact = Buffer.alloc(512, 0)
  artifact.write('MZ', 0, 'ascii')
  artifact.writeUInt32LE(0x80, 0x3c)
  artifact.set([0x50, 0x45, 0x00, 0x00], 0x80)
  return artifact
}

function chunkedResponse(chunks: readonly Uint8Array[], headers: HeadersInit = {}): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  }), { status: 200, headers })
}

async function expectFailure(
  promise: Promise<unknown>,
  code: UpdateDownloadError['code'],
): Promise<UpdateDownloadError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateDownloadError)
    expect(error).toMatchObject({ code })
    return error as UpdateDownloadError
  }
  throw new Error('Expected update download to fail.')
}

async function expectNoPartialFiles(directory: string): Promise<void> {
  const entries = await readdir(directory)
  expect(entries.filter(entry => entry.endsWith('.partial'))).toEqual([])
}

beforeEach(() => {
  // Development builds skip signature verification with a warning; keep the
  // legacy-endpoint suites quiet while the dedicated tests assert the warning.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop update installer download', () => {
  it('streams a macOS DMG from only the fixed endpoint and atomically completes it', async () => {
    const directory = await temporaryDirectory()
    const artifact = dmgArtifact()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const request: UpdateArtifactRequest = async (url, init) => {
      calls.push({ url, init })
      return chunkedResponse([artifact.subarray(0, 333), artifact.subarray(333)])
    }

    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.1.0',
      destinationPath: destinationPath(directory, 'darwin', '2.1.0'),
      request,
    })

    expect(result).toBe(join(directory, 'DSH-Desktop-2.1.0-mac.dmg'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_DOWNLOAD_URLS.darwin)
    expect(calls[0]?.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'follow' })
    await expectNoPartialFiles(directory)
  })

  it('accepts a Windows executable only when it has both MZ and PE signatures', async () => {
    const directory = await temporaryDirectory()
    const artifact = windowsArtifact()
    const result = await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.2.0',
      destinationPath: destinationPath(directory, 'win32', '2.2.0'),
      request: async (url) => {
        expect(url).toBe(DESKTOP_DOWNLOAD_URLS.win32)
        return chunkedResponse([artifact])
      },
    })

    expect(result).toBe(join(directory, 'DSH-Desktop-2.2.0-windows.exe'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    await expectNoPartialFiles(directory)
  })

  it('accepts canonical stable SemVer build metadata in the private artifact path', async () => {
    const directory = await temporaryDirectory()
    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.8.0+build',
      destinationPath: destinationPath(directory, 'darwin', '2.8.0+build'),
      request: async () => chunkedResponse([dmgArtifact()]),
    })

    expect(result).toBe(join(
      directory,
      'DSH-Desktop-2.8.0+build-mac.dmg',
    ))
  })

  it.each([
    ['darwin', new Uint8Array(1024)],
    ['win32', Object.assign(windowsArtifact(), { 0: 0 })],
    ['win32', Object.assign(windowsArtifact(), { 0x80: 0 })],
  ] as const)('rejects and removes an invalid %s artifact', async (platform, artifact) => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform,
      version: '2.3.0',
      destinationPath: destinationPath(directory, platform, '2.3.0'),
      request: async () => chunkedResponse([artifact]),
    }), 'invalid-artifact')
    await expectNoPartialFiles(directory)
    expect(await readdir(directory)).toEqual([])
  })

  it('keeps an existing destination until its validated replacement is ready', async () => {
    const directory = await temporaryDirectory()
    const path = destinationPath(directory, 'win32', '2.3.1')
    const existing = Buffer.from('existing installer')
    await writeFile(path, existing)

    await expectFailure(downloadDesktopUpdate({
      platform: 'win32',
      version: '2.3.1',
      destinationPath: path,
      request: async () => chunkedResponse([Buffer.alloc(128)]),
    }), 'invalid-artifact')
    expect(await readFile(path)).toEqual(existing)

    const replacement = windowsArtifact()
    await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.3.1',
      destinationPath: path,
      request: async () => chunkedResponse([replacement]),
    })
    expect(await readFile(path)).toEqual(Buffer.from(replacement))
    await expectNoPartialFiles(directory)
  })

  it.each([
    ['an unsuccessful response', async () => new Response(null, { status: 503 }), 'http-status'],
    ['a missing response body', async () => new Response(null, { status: 200 }), 'empty-body'],
    ['a zero-byte response body', async () => chunkedResponse([]), 'empty-body'],
  ] as const)('rejects %s without leaving a partial file', async (_label, request, code) => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.4.0',
      destinationPath: destinationPath(directory, 'darwin', '2.4.0'),
      request,
    }), code)
    await expectNoPartialFiles(directory)
  })

  it('rejects a declared body above the fixed 1 GiB limit before writing it', async () => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.5.0',
      destinationPath: destinationPath(directory, 'darwin', '2.5.0'),
      request: async () => chunkedResponse(
        [dmgArtifact()],
        { 'content-length': String(MAX_UPDATE_DOWNLOAD_BYTES + 1) },
      ),
    }), 'response-too-large')
    await expectNoPartialFiles(directory)
  })

  it('passes the caller signal and removes a partial file when aborted during streaming', async () => {
    const directory = await temporaryDirectory()
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    const request: UpdateArtifactRequest = async (_url, init) => {
      requestSignal = init.signal
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          stream.enqueue(dmgArtifact().subarray(0, 128))
          controller.abort(new DOMException('stop', 'AbortError'))
        },
      }))
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.6.0',
      destinationPath: destinationPath(directory, 'darwin', '2.6.0'),
      request,
      signal: controller.signal,
    }), 'aborted')
    expect(requestSignal).toBe(controller.signal)
    await expectNoPartialFiles(directory)
  })

  it('normalizes request aborts and transport failures without creating an artifact', async () => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.0',
      destinationPath: destinationPath(directory, 'darwin', '2.7.0'),
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    }), 'aborted')
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.1',
      destinationPath: destinationPath(directory, 'darwin', '2.7.1'),
      request: async () => { throw new Error('offline') },
    }), 'network')
    await expectNoPartialFiles(directory)
  })

  it.each([
    ['linux', '2.8.0'],
    ['darwin', '../2.8.0'],
    ['win32', 'v2.8.0'],
    ['win32', '2.8.0-rc.1'],
  ])('rejects platform %s and version %s before requesting', async (platform, version) => {
    const directory = await temporaryDirectory()
    let requested = false
    await expectFailure(downloadDesktopUpdate({
      platform: platform as DesktopDownloadPlatform,
      version,
      destinationPath: join(directory, 'installer.dmg'),
      request: async () => {
        requested = true
        return chunkedResponse([dmgArtifact()])
      },
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a relative destination path before requesting', async () => {
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      destinationPath: 'relative.dmg',
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a linked destination directory before requesting', async () => {
    const directory = await temporaryDirectory()
    const linked = `${directory}-link`
    temporaryRoots.push(linked)
    await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir')
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      destinationPath: join(linked, 'installer.dmg'),
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })
})

describe('desktop update artifact cleanup', () => {
  it('rejects malformed cleanup state with a typed failure', async () => {
    const userDataPath = await temporaryDirectory()
    const updates = join(userDataPath, 'updates')
    await mkdir(updates)
    await writeFile(join(updates, 'pending-installer.json'), '{}')

    await expectFailure(
      pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'win32'),
      'invalid-options',
    )
  })

  it('offers a recorded artifact only after the installed version reaches the update', async () => {
    const userDataPath = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const path = destinationPath(downloads, 'win32', '2.1.0')
    await writeFile(path, windowsArtifact())

    await recordDesktopUpdateArtifact(userDataPath, {
      platform: 'win32',
      version: '2.1.0',
      path,
    })

    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.0.1', 'win32')).resolves.toBeUndefined()
    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'win32')).resolves.toEqual({
      platform: 'win32',
      version: '2.1.0',
      path,
    })
  })

  it.each([false, true])('resolves one cleanup choice with remove=%s', async (remove) => {
    const userDataPath = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const artifact = {
      platform: 'darwin' as const,
      version: '2.1.0',
      path: destinationPath(downloads, 'darwin', '2.1.0'),
    }
    await writeFile(artifact.path, dmgArtifact())
    await recordDesktopUpdateArtifact(userDataPath, artifact)

    await resolveDesktopUpdateArtifact(userDataPath, artifact, remove)

    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'darwin')).resolves.toBeUndefined()
    if (remove) await expect(access(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    else await expect(access(artifact.path)).resolves.toBeUndefined()
  })
})

interface ChannelSigningKey {
  readonly privateKey: KeyObject
  readonly publicKeyBase64: string
  readonly trustRoots: readonly UpdateChannelTrustRoot[]
}

function createChannelSigningKey(keyId: string): ChannelSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  const raw = Buffer.from(String(jwk.x), 'base64url')
  return {
    privateKey,
    publicKeyBase64: raw.toString('base64'),
    trustRoots: [{ keyId, fingerprint: createHash('sha256').update(raw).digest('hex') }],
  }
}

function signChannelBytes(privateKey: KeyObject, content: Uint8Array): string {
  return cryptoSign(null, content, privateKey).toString('base64')
}

interface SignedChannelFixture {
  readonly manifestUrl: string
  readonly artifactUrl: string
  readonly verification: UpdateVerificationOptions
  readonly request: UpdateArtifactRequest
  readonly calls: string[]
  readonly artifact: Buffer
  readonly sequence: number
}

function platformArtifact(platform: DesktopDownloadPlatform): Buffer {
  return Buffer.from(platform === 'darwin' ? dmgArtifact() : windowsArtifact())
}

/**
 * Build one fully signed update channel: a manifest document signed over its
 * exact JSON bytes, published beside `.sig` companions, served by a routing
 * request stub that records every requested URL.
 */
function buildSignedChannel(options: {
  readonly platform: DesktopDownloadPlatform
  readonly version?: string
  readonly sequence?: number
  readonly key?: ChannelSigningKey
  readonly artifactSigner?: ChannelSigningKey
  readonly artifactTransform?: (artifact: Buffer) => Buffer
  readonly artifactHeaders?: HeadersInit
  readonly manifestArtifacts?: unknown
}): SignedChannelFixture {
  const key = options.key ?? createChannelSigningKey('update-test-2026a')
  const signer = options.artifactSigner ?? key
  const version = options.version ?? '2.10.0'
  const sequence = options.sequence ?? 42
  const manifestUrl = 'https://updates.example.test/desktop/update-manifest.json'
  const artifact = options.artifactTransform === undefined
    ? platformArtifact(options.platform)
    : options.artifactTransform(platformArtifact(options.platform))
  const artifactUrl = `https://updates.example.test/downloads/DSH-Desktop-${version}-${options.platform}.installer`
  const artifactEntry = {
    platform: options.platform,
    url: artifactUrl,
    size: platformArtifact(options.platform).byteLength,
    sha256: createHash('sha256').update(platformArtifact(options.platform)).digest('hex'),
    keyId: key.trustRoots[0]!.keyId,
  }
  const document = {
    latest: version,
    sequence,
    keyId: key.trustRoots[0]!.keyId,
    publicKey: key.publicKeyBase64,
    artifacts: options.manifestArtifacts === undefined
      ? [artifactEntry, {
        ...artifactEntry,
        platform: options.platform === 'darwin' ? 'win32' : 'darwin',
        url: `${artifactUrl}.other`,
      }]
      : options.manifestArtifacts,
  }
  const manifestBytes = Buffer.from(JSON.stringify(document), 'utf8')

  const calls: string[] = []
  const request: UpdateArtifactRequest = async (url, init) => {
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store' })
    calls.push(url)
    if (url === manifestUrl) return new Response(new Uint8Array(manifestBytes), { status: 200 })
    if (url === `${manifestUrl}.sig`) {
      return new Response(`${signChannelBytes(key.privateKey, manifestBytes)}\n`, { status: 200 })
    }
    if (url === artifactUrl) {
      return chunkedResponse([artifact], options.artifactHeaders ?? {})
    }
    if (url === `${artifactUrl}.sig`) {
      return new Response(signChannelBytes(signer.privateKey, artifact), { status: 200 })
    }
    return new Response(null, { status: 404 })
  }

  return {
    manifestUrl,
    artifactUrl,
    verification: { trustRoots: key.trustRoots, manifestUrl },
    request,
    calls,
    artifact,
    sequence,
  }
}

describe('signed update channel downloads', () => {
  it('downloads a fully signed installer through the verified manifest chain', async () => {
    const directory = await temporaryDirectory()
    const channel = buildSignedChannel({ platform: 'darwin' })

    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'darwin', '2.10.0'),
      request: channel.request,
      verification: channel.verification,
    })

    expect(result).toBe(join(directory, 'DSH-Desktop-2.10.0-mac.dmg'))
    expect(await readFile(result)).toEqual(channel.artifact)
    expect(channel.calls).toEqual([
      channel.manifestUrl,
      `${channel.manifestUrl}.sig`,
      channel.artifactUrl,
      `${channel.artifactUrl}.sig`,
    ])
    expect(channel.calls).not.toContain(DESKTOP_DOWNLOAD_URLS.darwin)
    await expectNoPartialFiles(directory)
  })

  it('downloads a signed Windows installer and repeats at the same manifest sequence', async () => {
    const directory = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const sequenceStatePath = desktopUpdateSequenceStatePath(downloads)
    const channel = buildSignedChannel({ platform: 'win32', sequence: 43 })
    const download = (): Promise<string> => downloadDesktopUpdate({
      platform: 'win32',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'win32', '2.10.0'),
      request: channel.request,
      verification: { ...channel.verification, sequenceStatePath },
    })

    expect(await readFile(await download())).toEqual(platformArtifact('win32'))
    expect(await readFile(await download())).toEqual(platformArtifact('win32'))
    await expectNoPartialFiles(directory)
  })

  it('rejects a tampered installer without writing it or a partial file to disk', async () => {
    const directory = await temporaryDirectory()
    const channel = buildSignedChannel({
      platform: 'darwin',
      artifactTransform: artifact => {
        const tampered = Buffer.from(artifact)
        tampered[0] = tampered[0]! ^ 0x20
        return tampered
      },
    })

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'darwin', '2.10.0'),
      request: channel.request,
      verification: channel.verification,
    }), 'invalid-artifact')

    expect(await readdir(directory)).toEqual([])
  })

  it('rejects an installer signature from the wrong key without writing it to disk', async () => {
    const directory = await temporaryDirectory()
    const attacker = createChannelSigningKey('update-test-2026a')
    const channel = buildSignedChannel({ platform: 'win32', artifactSigner: attacker })

    await expectFailure(downloadDesktopUpdate({
      platform: 'win32',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'win32', '2.10.0'),
      request: channel.request,
      verification: channel.verification,
    }), 'invalid-artifact')

    expect(await readdir(directory)).toEqual([])
  })

  it('rejects a manifest signed by a key that is not pinned, before any installer bytes move', async () => {
    const directory = await temporaryDirectory()
    const attacker = createChannelSigningKey('update-test-2026a')
    const pinned = createChannelSigningKey('update-test-2026a')
    const channel = buildSignedChannel({ platform: 'darwin', key: attacker })

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'darwin', '2.10.0'),
      request: channel.request,
      verification: { trustRoots: pinned.trustRoots, manifestUrl: channel.manifestUrl },
    }), 'invalid-artifact')

    expect(channel.calls).toEqual([channel.manifestUrl, `${channel.manifestUrl}.sig`])
    expect(await readdir(directory)).toEqual([])
  })

  it('rejects a rollback manifest sequence before downloading the installer', async () => {
    const directory = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const sequenceStatePath = desktopUpdateSequenceStatePath(downloads)
    await persistSeenUpdateSequence(sequenceStatePath, 50)
    const channel = buildSignedChannel({ platform: 'darwin', sequence: 42 })

    const error = await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'darwin', '2.10.0'),
      request: channel.request,
      verification: { ...channel.verification, sequenceStatePath },
    }), 'invalid-artifact')

    expect(error.message).toContain('older than the last seen sequence 50')
    expect(channel.calls).toEqual([channel.manifestUrl, `${channel.manifestUrl}.sig`])
    expect(await readdir(directory)).toEqual([])
  })

  it.each([
    ['a version other than the confirmed one', '2.9.9'],
    ['a build-metadata mismatch', '2.10.0+build'],
  ])('rejects a manifest for %s', async (_label, version) => {
    const directory = await temporaryDirectory()
    const channel = buildSignedChannel({ platform: 'darwin' })

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version,
      destinationPath: destinationPath(directory, 'darwin', version),
      request: channel.request,
      verification: channel.verification,
    }), 'invalid-artifact')
    expect(channel.calls).toEqual([channel.manifestUrl, `${channel.manifestUrl}.sig`])
  })

  it('rejects a manifest without an artifact for the requested platform', async () => {
    const directory = await temporaryDirectory()
    const key = createChannelSigningKey('update-test-2026a')
    const channel = buildSignedChannel({
      platform: 'darwin',
      key,
      manifestArtifacts: [{
        platform: 'win32',
        url: 'https://updates.example.test/downloads/win.exe',
        size: 512,
        sha256: 'b'.repeat(64),
        keyId: key.trustRoots[0]!.keyId,
      }],
    })

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'darwin', '2.10.0'),
      request: channel.request,
      verification: channel.verification,
    }), 'invalid-artifact')
    expect(channel.calls).toEqual([channel.manifestUrl, `${channel.manifestUrl}.sig`])
  })

  it('rejects an installer whose declared size disagrees with the signed manifest', async () => {
    const directory = await temporaryDirectory()
    const channel = buildSignedChannel({
      platform: 'darwin',
      artifactHeaders: { 'content-length': String(dmgArtifact().length + 1) },
    })

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'darwin', '2.10.0'),
      request: channel.request,
      verification: channel.verification,
    }), 'invalid-artifact')
    expect(channel.calls).toEqual([
      channel.manifestUrl,
      `${channel.manifestUrl}.sig`,
      channel.artifactUrl,
    ])
    await expectNoPartialFiles(directory)
  })

  it('keeps an existing destination untouched when the signed channel rejects the replacement', async () => {
    const directory = await temporaryDirectory()
    const path = destinationPath(directory, 'darwin', '2.10.0')
    const existing = Buffer.from('existing installer')
    await writeFile(path, existing)
    const channel = buildSignedChannel({
      platform: 'darwin',
      artifactTransform: artifact => {
        const tampered = Buffer.from(artifact)
        tampered[0] = tampered[0]! ^ 0x20
        return tampered
      },
    })

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: path,
      request: channel.request,
      verification: channel.verification,
    }), 'invalid-artifact')

    expect(await readFile(path)).toEqual(existing)
    await expectNoPartialFiles(directory)
  })

  it('skips verification with a warning while no trust roots are embedded (dev build)', async () => {
    const directory = await temporaryDirectory()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await downloadDesktopUpdate({
        platform: 'darwin',
        version: '2.11.0',
        destinationPath: destinationPath(directory, 'darwin', '2.11.0'),
        request: async url => {
          expect(url).toBe(DESKTOP_DOWNLOAD_URLS.darwin)
          return chunkedResponse([dmgArtifact()])
        },
      })
      expect(await readFile(result)).toEqual(Buffer.from(dmgArtifact()))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('ARTIFACT_TRUST_ROOTS')
    } finally {
      warn.mockRestore()
    }
    await expectNoPartialFiles(directory)
  })

  it('rejects invalid injected trust roots as an options failure', async () => {
    const directory = await temporaryDirectory()
    let requested = false
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.10.0',
      destinationPath: destinationPath(directory, 'darwin', '2.10.0'),
      request: async () => {
        requested = true
        return chunkedResponse([dmgArtifact()])
      },
      verification: { trustRoots: [{ keyId: 'bad key', fingerprint: 'nope' }] },
    }), 'invalid-options')
    expect(requested).toBe(false)
  })
})
