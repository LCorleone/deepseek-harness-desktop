import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_UPDATE_MANIFEST_ENDPOINT,
  DESKTOP_VERSION_ENDPOINT,
  MAX_VERSION_RESPONSE_BYTES,
  checkForStableUpdate,
  compareSemVerVersions,
  parseSemVer,
  type UpdateRequest,
} from '../src/update-checker.ts'
import type { UpdateChannelTrustRoot } from '../src/update-verification.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

beforeEach(() => {
  // Development builds fall back to the unsigned legacy endpoint with a
  // warning; keep the legacy suites quiet while dedicated tests assert it.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

function versionResponse(version: unknown, init: ResponseInit = {}): Response {
  return Response.json({ version }, init)
}

describe('strict SemVer parsing', () => {
  it('accepts a three-part version, optional lowercase v, prerelease, and build metadata', () => {
    expect(parseSemVer('v2.10.3-alpha.1+mac.arm64')).toEqual({
      version: '2.10.3-alpha.1+mac.arm64',
      major: '2',
      minor: '10',
      patch: '3',
      prerelease: ['alpha', '1'],
      build: ['mac', 'arm64'],
    })
    expect(parseSemVer('0.0.0')).not.toBeNull()
  })

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    'V1.2.3',
    ' 1.2.3',
  ])('rejects invalid SemVer %s', version => {
    expect(parseSemVer(version)).toBeNull()
  })

  it('compares strict versions without numeric overflow', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(compareSemVerVersions(
      '10000000000000000.0.0',
      '9007199254740992.0.0',
    )).toBeGreaterThan(0)
  })
})

describe('public Desktop version check', () => {
  it('uses only the fixed no-cache version endpoint and reports a newer stable version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return versionResponse('2.10.0')
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_VERSION_ENDPOINT)
    expect(calls[0]?.url).not.toContain('/api/downloads/')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.has('if-none-match')).toBe(false)
    expect(headers.has('x-github-api-version')).toBe(false)
  })

  it.each([
    ['2.0.0', '2.0.0'],
    ['2.0.1', '2.0.0'],
    ['2.0.0+installed', '2.0.0+release'],
  ])('reports no update for installed %s and service %s', async (currentVersion, latestVersion) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => versionResponse(latestVersion),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    })
  })

  it('compares service versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      request: async () => versionResponse('10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it.each([
    ['leading v', { version: 'v2.1.0' }],
    ['prerelease', { version: '2.1.0-rc.1' }],
    ['invalid SemVer', { version: '2.01.0' }],
    ['missing version', {}],
    ['non-string version', { version: 2 }],
    ['array response', ['2.1.0']],
  ])('silently ignores a service response with %s', async (_case, value) => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('silently ignores network failure and caller cancellation', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_VERSION_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_VERSION_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each(['2.0', 'v2.0.0', '2.0.0-rc.1'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => versionResponse('2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

interface CheckerSigningKey {
  readonly privateKey: KeyObject
  readonly publicKeyBase64: string
  readonly trustRoots: readonly UpdateChannelTrustRoot[]
}

function createCheckerSigningKey(keyId: string): CheckerSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  const raw = Buffer.from(String(jwk.x), 'base64url')
  return {
    privateKey,
    publicKeyBase64: raw.toString('base64'),
    trustRoots: [{ keyId, fingerprint: createHash('sha256').update(raw).digest('hex') }],
  }
}

function signCheckerBytes(privateKey: KeyObject, content: Uint8Array): string {
  return cryptoSign(null, content, privateKey).toString('base64')
}

interface SignedManifestInput {
  readonly latest?: unknown
  readonly sequence?: number
  readonly key?: CheckerSigningKey
  readonly signer?: CheckerSigningKey
}

/** Serve one signed manifest document plus its `.sig` companion from a stub. */
function signedManifestRequest(
  options: SignedManifestInput = {},
): { readonly request: UpdateRequest; readonly calls: string[]; readonly url: string } {
  const key = options.key ?? createCheckerSigningKey('update-test-2026a')
  const signer = options.signer ?? key
  const url = 'https://updates.example.test/desktop/update-manifest.json'
  const document = {
    latest: options.latest === undefined ? '2.10.0' : options.latest,
    sequence: options.sequence === undefined ? 42 : options.sequence,
    keyId: key.trustRoots[0]!.keyId,
    publicKey: key.publicKeyBase64,
    artifacts: [{
      platform: 'darwin',
      url: 'https://updates.example.test/downloads/mac.dmg',
      size: 1024,
      sha256: 'a'.repeat(64),
      keyId: key.trustRoots[0]!.keyId,
    }],
  }
  const manifestBytes = Buffer.from(JSON.stringify(document), 'utf8')
  const calls: string[] = []
  const request: UpdateRequest = async (requestedUrl, init) => {
    calls.push(requestedUrl)
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' })
    if (requestedUrl === url) return new Response(new Uint8Array(manifestBytes), { status: 200 })
    if (requestedUrl === `${url}.sig`) {
      return new Response(`${signCheckerBytes(signer.privateKey, manifestBytes)}\n`, { status: 200 })
    }
    return new Response(null, { status: 404 })
  }
  return { request, calls, url }
}

describe('signed update manifest channel', () => {
  it('verifies a signed manifest and reports a newer stable version with its sequence', async () => {
    const key = createCheckerSigningKey('update-test-2026a')
    const stub = signedManifestRequest({ key, sequence: 42 })

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: stub.request,
      updateChannel: { manifestUrl: stub.url, trustRoots: key.trustRoots },
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
      updateChannel: { manifestSequence: 42, keyId: 'update-test-2026a' },
    })

    expect(stub.calls).toEqual([stub.url, `${stub.url}.sig`])
    expect(stub.calls).not.toContain(DESKTOP_VERSION_ENDPOINT)
  })

  it('uses the pinned manifest endpoint constant when no URL is injected', async () => {
    const key = createCheckerSigningKey('update-test-2026a')
    const manifestBytes = Buffer.from(JSON.stringify({
      latest: '2.0.0',
      sequence: 7,
      keyId: key.trustRoots[0]!.keyId,
      publicKey: key.publicKeyBase64,
      artifacts: [{
        platform: 'darwin',
        url: 'https://updates.example.test/downloads/mac.dmg',
        size: 1024,
        sha256: 'a'.repeat(64),
        keyId: key.trustRoots[0]!.keyId,
      }],
    }), 'utf8')
    const signature = signCheckerBytes(key.privateKey, manifestBytes)
    const calls: string[] = []
    const request: UpdateRequest = async url => {
      calls.push(url)
      if (url === DESKTOP_UPDATE_MANIFEST_ENDPOINT) {
        return new Response(new Uint8Array(manifestBytes), { status: 200 })
      }
      if (url === `${DESKTOP_UPDATE_MANIFEST_ENDPOINT}.sig`) {
        return new Response(`${signature}\n`, { status: 200 })
      }
      return new Response(null, { status: 404 })
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request,
      updateChannel: { trustRoots: key.trustRoots },
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
      updateChannel: { manifestSequence: 7, keyId: 'update-test-2026a' },
    })
    expect(calls).toEqual([DESKTOP_UPDATE_MANIFEST_ENDPOINT, `${DESKTOP_UPDATE_MANIFEST_ENDPOINT}.sig`])
  })

  it('silently rejects a manifest whose bytes were modified after signing', async () => {
    const key = createCheckerSigningKey('update-test-2026a')
    const honest = signedManifestRequest({ key })
    const tamperedBytes = Buffer.from(JSON.stringify({
      latest: '9.9.9',
      sequence: 43,
      keyId: key.trustRoots[0]!.keyId,
      publicKey: key.publicKeyBase64,
      artifacts: [],
    }))
    const signature = signCheckerBytes(
      key.privateKey,
      Buffer.from(JSON.stringify({
        latest: '2.10.0',
        sequence: 42,
        keyId: key.trustRoots[0]!.keyId,
        publicKey: key.publicKeyBase64,
        artifacts: [],
      })),
    )
    const request: UpdateRequest = async url => {
      if (url === honest.url) return new Response(new Uint8Array(tamperedBytes), { status: 200 })
      if (url === `${honest.url}.sig`) return new Response(signature, { status: 200 })
      return new Response(null, { status: 404 })
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request,
      updateChannel: { manifestUrl: honest.url, trustRoots: key.trustRoots },
    })).resolves.toBeNull()
  })

  it('silently rejects a manifest signed by a key that is not pinned', async () => {
    const pinned = createCheckerSigningKey('update-test-2026a')
    const attacker = createCheckerSigningKey('update-test-2026a')
    const stub = signedManifestRequest({ key: attacker })

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: stub.request,
      updateChannel: { manifestUrl: stub.url, trustRoots: pinned.trustRoots },
    })).resolves.toBeNull()
  })

  it('silently rejects a rollback manifest against the in-memory sequence floor', async () => {
    const key = createCheckerSigningKey('update-test-2026a')
    const stub = signedManifestRequest({ key, sequence: 41 })

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: stub.request,
      updateChannel: { manifestUrl: stub.url, trustRoots: key.trustRoots, lastSeenSequence: 42 },
    })).resolves.toBeNull()
  })

  it('persists the verified sequence and rejects an older manifest on the next check', async () => {
    const key = createCheckerSigningKey('update-test-2026a')
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-checker-'))
    temporaryRoots.push(root)
    const statePath = join(root, 'manifest-sequence.json')
    const first = signedManifestRequest({ key, sequence: 42 })
    const rollback = signedManifestRequest({ key, sequence: 41 })

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: first.request,
      updateChannel: {
        manifestUrl: first.url,
        trustRoots: key.trustRoots,
        sequenceStatePath: statePath,
      },
    })).resolves.toMatchObject({ updateChannel: { manifestSequence: 42 } })
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ stateVersion: 1, sequence: 42 })

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: rollback.request,
      updateChannel: {
        manifestUrl: rollback.url,
        trustRoots: key.trustRoots,
        sequenceStatePath: statePath,
      },
    })).resolves.toBeNull()
  })

  it('silently rejects a verified manifest whose latest version is not canonical stable SemVer', async () => {
    const key = createCheckerSigningKey('update-test-2026a')
    const stub = signedManifestRequest({ key, latest: '2.10.0-rc.1' })

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: stub.request,
      updateChannel: { manifestUrl: stub.url, trustRoots: key.trustRoots },
    })).resolves.toBeNull()
  })

  it('silently ignores transport failures of the manifest channel', async () => {
    const key = createCheckerSigningKey('update-test-2026a')
    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: async () => new Response(null, { status: 503 }),
      updateChannel: { trustRoots: key.trustRoots },
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      request: async () => { throw new TypeError('offline') },
      updateChannel: { trustRoots: key.trustRoots },
    })).resolves.toBeNull()
  })

  it('falls back to the unsigned legacy endpoint with a warning when no trust roots are embedded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(checkForStableUpdate({
        currentVersion: '2.9.9',
        request: async () => versionResponse('2.10.0'),
      })).resolves.toEqual({
        status: 'update-available',
        currentVersion: '2.9.9',
        latestVersion: '2.10.0',
      })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('ARTIFACT_TRUST_ROOTS')
    } finally {
      warn.mockRestore()
    }

    const key = createCheckerSigningKey('update-test-2026a')
    const strictWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const stub = signedManifestRequest({ key })
      await expect(checkForStableUpdate({
        currentVersion: '2.9.9',
        request: stub.request,
        updateChannel: { manifestUrl: stub.url, trustRoots: key.trustRoots },
      })).resolves.toMatchObject({ status: 'update-available' })
      expect(strictWarn).not.toHaveBeenCalled()
    } finally {
      strictWarn.mockRestore()
    }
  })
})
