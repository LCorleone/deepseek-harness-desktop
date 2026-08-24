import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_TRUST_ROOTS,
  ed25519RawKeyFingerprint,
  normalizeUpdateChannelTrustRoots,
  verifyDetachedUpdateSignature,
  warnSkippedUpdateSignatureVerification,
  type UpdateChannelTrustRoot,
} from '../src/update-verification.ts'
import {
  fetchUpdateChannelBytes,
  fetchVerifiedUpdateManifest,
  guardUpdateManifestSequence,
  MAX_UPDATE_MANIFEST_BYTES,
  parseUpdateManifestDocument,
  persistSeenUpdateSequence,
  readSeenUpdateSequence,
  UPDATE_SEQUENCE_STATE_VERSION,
  updateManifestSignatureUrl,
} from '../src/update-manifest.ts'

const temporaryRoots: string[] = []

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-verification-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface SigningKey {
  readonly privateKey: KeyObject
  readonly publicKeyBase64: string
  readonly trustRoot: UpdateChannelTrustRoot
}

function createSigningKey(keyId: string): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  const raw = Buffer.from(String(jwk.x), 'base64url')
  return {
    privateKey,
    publicKeyBase64: raw.toString('base64'),
    trustRoot: { keyId, fingerprint: createHash('sha256').update(raw).digest('hex') },
  }
}

function signContent(privateKey: KeyObject, content: Uint8Array): string {
  // Detached signatures are produced exactly as the release pipeline would:
  // crypto.sign over the original bytes, base64-encoded, published beside them.
  return cryptoSign(null, content, privateKey).toString('base64')
}

function textResponse(text: string, headers: HeadersInit = {}): Response {
  return new Response(text, { status: 200, headers })
}

function bytesResponse(bytes: Uint8Array, headers: HeadersInit = {}): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

function notFound(): Response {
  return new Response(null, { status: 404 })
}

/** Request stub that records every URL and serves canned route handlers. */
function routingRequest(routes: Readonly<Record<string, () => Response>>): {
  readonly request: (url: string, init: RequestInit) => Promise<Response>
  readonly calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    request: async (url, _init) => {
      calls.push(url)
      const route = routes[url]
      return route === undefined ? notFound() : route()
    },
  }
}

interface ManifestInput {
  readonly latest?: unknown
  readonly sequence?: unknown
  readonly keyId?: unknown
  readonly publicKey?: unknown
  readonly artifacts?: unknown
}

function manifestValue(key: SigningKey, overrides: ManifestInput = {}): Record<string, unknown> {
  return {
    latest: overrides.latest === undefined ? '2.10.0' : overrides.latest,
    sequence: overrides.sequence === undefined ? 42 : overrides.sequence,
    keyId: overrides.keyId === undefined ? key.trustRoot.keyId : overrides.keyId,
    publicKey: overrides.publicKey === undefined ? key.publicKeyBase64 : overrides.publicKey,
    artifacts: overrides.artifacts === undefined ? [{
      platform: 'darwin',
      url: 'https://updates.example.test/DSH-Desktop-2.10.0-mac.dmg',
      size: 1024,
      sha256: 'a'.repeat(64),
      keyId: key.trustRoot.keyId,
    }] : overrides.artifacts,
  }
}

function signedManifestFixture(
  key: SigningKey,
  overrides: ManifestInput = {},
): { readonly json: string; readonly bytes: Buffer; readonly signature: string } {
  const json = JSON.stringify(manifestValue(key, overrides))
  const bytes = Buffer.from(json, 'utf8')
  return { json, bytes, signature: signContent(key.privateKey, bytes) }
}

const MANIFEST_URL = 'https://updates.example.test/desktop/update-manifest.json'

describe('update-channel trust roots', () => {
  it('keeps the build placeholder empty so development builds skip verification', () => {
    expect(ARTIFACT_TRUST_ROOTS).toEqual([])
  })

  it('accepts an overlapping rotation pair with unique keyIds and fingerprints', () => {
    const first = createSigningKey('update-2026a')
    const second = createSigningKey('update-2026b')
    const roots = normalizeUpdateChannelTrustRoots([first.trustRoot, second.trustRoot])
    expect(roots).toEqual([first.trustRoot, second.trustRoot])
    expect(Object.isFrozen(roots)).toBe(true)
  })

  it.each([
    ['a non-array', 'update-2026a'],
    ['a non-object entry', [firstTrustRoot(), 'update-2026b']],
    ['extra fields', [{ ...firstTrustRoot(), extra: true }]],
    ['an invalid keyId', [{ keyId: '-bad', fingerprint: 'a'.repeat(64) }]],
    ['an invalid fingerprint', [{ keyId: 'update-2026a', fingerprint: 'A'.repeat(64) }]],
    ['duplicate keyIds', [firstTrustRoot(), firstTrustRoot()]],
    ['duplicate fingerprints', [
      { keyId: 'update-2026a', fingerprint: 'a'.repeat(64) },
      { keyId: 'update-2026b', fingerprint: 'a'.repeat(64) },
    ]],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeUpdateChannelTrustRoots(value)).toThrow(TypeError)
  })

  it('fingerprints a raw ed25519 public key as 64 lowercase hex characters', () => {
    const key = createSigningKey('update-2026a')
    const raw = Buffer.from(key.publicKeyBase64, 'base64')
    expect(ed25519RawKeyFingerprint(raw)).toBe(key.trustRoot.fingerprint)
    expect(() => ed25519RawKeyFingerprint(raw.subarray(0, 31))).toThrow(TypeError)
  })
})

function firstTrustRoot(): UpdateChannelTrustRoot {
  return createSigningKey('update-2026a').trustRoot
}

describe('detached ed25519 signature verification', () => {
  const content = Buffer.from('DSH Desktop update artifact bytes', 'utf8')

  it('verifies a signature made with generateKeyPairSync and crypto.sign', () => {
    const key = createSigningKey('update-2026a')
    const verification = verifyDetachedUpdateSignature({
      content,
      signatureBase64: `${signContent(key.privateKey, content)}\n`,
      keyId: key.trustRoot.keyId,
      publicKeyBase64: key.publicKeyBase64,
      trustRoots: [key.trustRoot],
    })
    expect(verification).toEqual({
      ok: true,
      keyId: key.trustRoot.keyId,
      fingerprint: key.trustRoot.fingerprint,
    })
  })

  it('verifies through the second root of an overlapping rotation pair', () => {
    const oldKey = createSigningKey('update-2026a')
    const newKey = createSigningKey('update-2026b')
    const verification = verifyDetachedUpdateSignature({
      content,
      signatureBase64: signContent(newKey.privateKey, content),
      keyId: newKey.trustRoot.keyId,
      publicKeyBase64: newKey.publicKeyBase64,
      trustRoots: [oldKey.trustRoot, newKey.trustRoot],
    })
    expect(verification).toMatchObject({ ok: true, keyId: 'update-2026b' })
  })

  it('rejects tampered content', () => {
    const key = createSigningKey('update-2026a')
    const verification = verifyDetachedUpdateSignature({
      content: Buffer.concat([content, Buffer.from('x')]),
      signatureBase64: signContent(key.privateKey, content),
      keyId: key.trustRoot.keyId,
      publicKeyBase64: key.publicKeyBase64,
      trustRoots: [key.trustRoot],
    })
    expect(verification).toMatchObject({ ok: false, code: 'bad-signature' })
  })

  it('rejects a signature by the wrong key under a known keyId', () => {
    const honest = createSigningKey('update-2026a')
    const attacker = createSigningKey('ignored')
    const verification = verifyDetachedUpdateSignature({
      content,
      signatureBase64: signContent(attacker.privateKey, content),
      keyId: honest.trustRoot.keyId,
      publicKeyBase64: attacker.publicKeyBase64,
      trustRoots: [honest.trustRoot],
    })
    expect(verification).toMatchObject({ ok: false, code: 'key-mismatch' })
  })

  it('rejects an unknown keyId', () => {
    const key = createSigningKey('update-2026a')
    const verification = verifyDetachedUpdateSignature({
      content,
      signatureBase64: signContent(key.privateKey, content),
      keyId: 'update-unknown',
      publicKeyBase64: key.publicKeyBase64,
      trustRoots: [key.trustRoot],
    })
    expect(verification).toMatchObject({ ok: false, code: 'unknown-key' })
  })

  it.each([
    ['not base64', 'not base64!'],
    ['the wrong length', Buffer.alloc(63).toString('base64')],
  ])('rejects a signature that is %s', (_label, signatureBase64) => {
    const key = createSigningKey('update-2026a')
    const verification = verifyDetachedUpdateSignature({
      content,
      signatureBase64,
      keyId: key.trustRoot.keyId,
      publicKeyBase64: key.publicKeyBase64,
      trustRoots: [key.trustRoot],
    })
    expect(verification).toMatchObject({ ok: false, code: 'invalid-signature-encoding' })
  })

  it('rejects a public key that is not a raw 32-byte ed25519 key', () => {
    const key = createSigningKey('update-2026a')
    const verification = verifyDetachedUpdateSignature({
      content,
      signatureBase64: signContent(key.privateKey, content),
      keyId: key.trustRoot.keyId,
      publicKeyBase64: Buffer.alloc(16).toString('base64'),
      trustRoots: [key.trustRoot],
    })
    expect(verification).toMatchObject({ ok: false, code: 'invalid-public-key' })
  })
})

describe('update manifest document parsing', () => {
  const key = createSigningKey('update-2026a')

  function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      platform: 'darwin',
      url: 'https://updates.example.test/mac.dmg',
      size: 1024,
      sha256: 'a'.repeat(64),
      keyId: key.trustRoot.keyId,
      ...overrides,
    }
  }

  function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...manifestValue(key), artifacts: [artifact()], ...overrides }
  }

  it('parses a complete two-platform document', () => {
    const result = parseUpdateManifestDocument(JSON.stringify(document({
      artifacts: [
        artifact({
          signatureUrl: 'https://updates.example.test/mac.dmg.sig',
        }),
        artifact({
          platform: 'win32',
          url: 'https://updates.example.test/win.exe',
          size: 4096,
          sha256: '1'.repeat(64),
        }),
      ],
    })))
    expect(result).toEqual({
      ok: true,
      document: {
        latest: '2.10.0',
        sequence: 42,
        keyId: key.trustRoot.keyId,
        publicKey: key.publicKeyBase64,
        artifacts: [
          {
            platform: 'darwin',
            url: 'https://updates.example.test/mac.dmg',
            size: 1024,
            sha256: 'a'.repeat(64),
            signatureUrl: 'https://updates.example.test/mac.dmg.sig',
            keyId: key.trustRoot.keyId,
          },
          {
            platform: 'win32',
            url: 'https://updates.example.test/win.exe',
            size: 4096,
            sha256: '1'.repeat(64),
            keyId: key.trustRoot.keyId,
          },
        ],
      },
    })
  })

  it.each([
    ['malformed JSON', '{'],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd])],
    ['unexpected root fields', JSON.stringify({ ...document(), extra: 1 })],
    ['a missing root field', JSON.stringify({ ...document(), sequence: undefined })],
    ['an empty latest version', JSON.stringify(document({ latest: '' }))],
    ['a zero sequence', JSON.stringify(document({ sequence: 0 }))],
    ['a fractional sequence', JSON.stringify(document({ sequence: 1.5 }))],
    ['an invalid keyId', JSON.stringify(document({ keyId: '-nope' }))],
    ['a public key of the wrong length', JSON.stringify(document({ publicKey: Buffer.alloc(31).toString('base64') }))],
    ['an empty artifacts list', JSON.stringify(document({ artifacts: [] }))],
    ['a duplicate platform', JSON.stringify(document({ artifacts: [artifact(), artifact()] }))],
    ['an unsupported platform', JSON.stringify(document({ artifacts: [artifact({ platform: 'linux' })] }))],
    ['an artifact keyId mismatch', JSON.stringify(document({
      artifacts: [artifact({ keyId: 'other-key' })],
    }))],
    ['a plain-http artifact URL', JSON.stringify(document({
      artifacts: [artifact({ url: 'http://updates.example.test/mac.dmg' })],
    }))],
    ['a non-hex artifact digest', JSON.stringify(document({
      artifacts: [artifact({ sha256: 'A'.repeat(64) })],
    }))],
    ['a zero artifact size', JSON.stringify(document({ artifacts: [artifact({ size: 0 })] }))],
    ['an artifact size above 1 GiB', JSON.stringify(document({
      artifacts: [artifact({ size: 1024 * 1024 * 1024 + 1 })],
    }))],
    ['an artifact with unexpected fields', JSON.stringify(document({
      artifacts: [artifact({ extra: true })],
    }))],
    ['an artifact with an invalid signature URL', JSON.stringify(document({
      artifacts: [artifact({ signatureUrl: 'http://updates.example.test/mac.dmg.sig' })],
    }))],
  ])('rejects %s', (_label, value) => {
    expect(parseUpdateManifestDocument(value)).toMatchObject({ ok: false })
  })
})

describe('signed update manifest fetch', () => {
  it('verifies the exact fetched manifest bytes against the derived .sig companion', async () => {
    const key = createSigningKey('update-2026a')
    const fixture = signedManifestFixture(key)
    const router = routingRequest({
      [MANIFEST_URL]: () => bytesResponse(fixture.bytes),
      [updateManifestSignatureUrl(MANIFEST_URL)]: () => textResponse(`${fixture.signature}\n`),
    })

    const manifest = await fetchVerifiedUpdateManifest({
      request: router.request,
      url: MANIFEST_URL,
      trustRoots: [key.trustRoot],
    })

    expect(manifest).toMatchObject({
      ok: true,
      sequence: 42,
      keyId: key.trustRoot.keyId,
      fingerprint: key.trustRoot.fingerprint,
    })
    expect(router.calls).toEqual([MANIFEST_URL, updateManifestSignatureUrl(MANIFEST_URL)])
  })

  it('honors an explicit signature URL from the manifest channel input', async () => {
    const key = createSigningKey('update-2026a')
    const fixture = signedManifestFixture(key)
    const signatureUrl = 'https://mirror.example.test/update-manifest.signature'
    const router = routingRequest({
      [MANIFEST_URL]: () => bytesResponse(fixture.bytes),
      [signatureUrl]: () => textResponse(fixture.signature),
    })

    const manifest = await fetchVerifiedUpdateManifest({
      request: router.request,
      url: MANIFEST_URL,
      trustRoots: [key.trustRoot],
      signatureUrl,
    })

    expect(manifest).toMatchObject({ ok: true })
    expect(router.calls).toEqual([MANIFEST_URL, signatureUrl])
  })

  it('rejects manifest bytes modified after signing', async () => {
    const key = createSigningKey('update-2026a')
    const fixture = signedManifestFixture(key)
    const tampered = Buffer.from(
      JSON.stringify({ ...manifestValue(key), sequence: 43 }),
      'utf8',
    )
    const manifest = await fetchVerifiedUpdateManifest({
      request: routingRequest({
        [MANIFEST_URL]: () => bytesResponse(tampered),
        [updateManifestSignatureUrl(MANIFEST_URL)]: () => textResponse(fixture.signature),
      }).request,
      url: MANIFEST_URL,
      trustRoots: [key.trustRoot],
    })
    expect(manifest).toMatchObject({ ok: false, code: 'invalid-signature' })
  })

  it('rejects a manifest signed by a key that is not pinned', async () => {
    const attacker = createSigningKey('update-2026a')
    const pinned = createSigningKey('update-2026a')
    const fixture = signedManifestFixture(attacker)
    const manifest = await fetchVerifiedUpdateManifest({
      request: routingRequest({
        [MANIFEST_URL]: () => bytesResponse(fixture.bytes),
        [updateManifestSignatureUrl(MANIFEST_URL)]: () => textResponse(fixture.signature),
      }).request,
      url: MANIFEST_URL,
      trustRoots: [pinned.trustRoot],
    })
    expect(manifest).toMatchObject({ ok: false, code: 'invalid-signature' })
  })

  it('rejects a structurally invalid manifest regardless of signature', async () => {
    const key = createSigningKey('update-2026a')
    const bytes = Buffer.from('{', 'utf8')
    const manifest = await fetchVerifiedUpdateManifest({
      request: routingRequest({
        [MANIFEST_URL]: () => bytesResponse(bytes),
        [updateManifestSignatureUrl(MANIFEST_URL)]: () => textResponse(signContent(key.privateKey, bytes)),
      }).request,
      url: MANIFEST_URL,
      trustRoots: [key.trustRoot],
    })
    expect(manifest).toMatchObject({ ok: false, code: 'invalid-manifest' })
  })

  it.each([
    'manifest',
    'signature',
  ])('reports an HTTP failure of the %s request with its status', async (which) => {
    const key = createSigningKey('update-2026a')
    const fixture = signedManifestFixture(key)
    const routes: Record<string, () => Response> = {
      [MANIFEST_URL]: () => bytesResponse(fixture.bytes),
      [updateManifestSignatureUrl(MANIFEST_URL)]: () => textResponse(fixture.signature),
    }
    const failingUrl = which === 'manifest' ? MANIFEST_URL : updateManifestSignatureUrl(MANIFEST_URL)
    routes[failingUrl] = () => new Response(null, { status: 503 })
    const manifest = await fetchVerifiedUpdateManifest({
      request: routingRequest(routes).request,
      url: MANIFEST_URL,
      trustRoots: [key.trustRoot],
    })
    expect(manifest).toMatchObject({ ok: false, code: 'http-status', status: 503 })
  })

  it('rejects an oversized declared manifest body before reading it', async () => {
    const key = createSigningKey('update-2026a')
    const fixture = signedManifestFixture(key)
    const manifest = await fetchVerifiedUpdateManifest({
      request: routingRequest({
        [MANIFEST_URL]: () => bytesResponse(fixture.bytes, {
          'content-length': String(MAX_UPDATE_MANIFEST_BYTES + 1),
        }),
        [updateManifestSignatureUrl(MANIFEST_URL)]: () => textResponse(fixture.signature),
      }).request,
      url: MANIFEST_URL,
      trustRoots: [key.trustRoot],
    })
    expect(manifest).toMatchObject({ ok: false, code: 'response-too-large' })
  })

  it('reports an empty manifest body as a transport failure', async () => {
    const key = createSigningKey('update-2026a')
    const manifest = await fetchVerifiedUpdateManifest({
      request: routingRequest({
        [MANIFEST_URL]: () => new Response(null, { status: 200 }),
      }).request,
      url: MANIFEST_URL,
      trustRoots: [key.trustRoot],
    })
    expect(manifest).toMatchObject({ ok: false, code: 'empty-body' })
  })
})

describe('update manifest sequence anti-rollback', () => {
  it('accepts the first sequence and persists the maximum seen value', async () => {
    const statePath = join(await temporaryDirectory(), 'updates', 'manifest-sequence.json')

    await expect(guardUpdateManifestSequence({ sequence: 42, statePath })).resolves.toEqual({ ok: true })
    await expect(readSeenUpdateSequence(statePath)).resolves.toBe(42)
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      stateVersion: UPDATE_SEQUENCE_STATE_VERSION,
      sequence: 42,
    })

    await expect(guardUpdateManifestSequence({ sequence: 43, statePath })).resolves.toEqual({ ok: true })
    await expect(readSeenUpdateSequence(statePath)).resolves.toBe(43)
  })

  it('accepts an equal sequence so the same release can be re-checked and re-downloaded', async () => {
    const statePath = join(await temporaryDirectory(), 'manifest-sequence.json')
    await persistSeenUpdateSequence(statePath, 42)

    await expect(guardUpdateManifestSequence({ sequence: 42, statePath })).resolves.toEqual({ ok: true })
    await expect(readSeenUpdateSequence(statePath)).resolves.toBe(42)
  })

  it('rejects an older sequence from both the persisted state and the in-memory floor', async () => {
    const statePath = join(await temporaryDirectory(), 'manifest-sequence.json')
    await persistSeenUpdateSequence(statePath, 42)

    await expect(guardUpdateManifestSequence({ sequence: 41, statePath })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('older than the last seen sequence 42') as unknown,
    })
    await expect(guardUpdateManifestSequence({ sequence: 41, lastSeenSequence: 42 })).resolves.toMatchObject({
      ok: false,
    })
  })

  it('treats a missing or corrupt user-writable state file as sequence 0', async () => {
    const directory = await temporaryDirectory()
    const absent = join(directory, 'absent.json')
    await expect(readSeenUpdateSequence(absent)).resolves.toBe(0)

    const corrupt = join(directory, 'corrupt.json')
    await writeFile(corrupt, '{"stateVersion":1,"sequence":"not-a-number"}\n')
    await expect(readSeenUpdateSequence(corrupt)).resolves.toBe(0)

    await expect(guardUpdateManifestSequence({ sequence: 7, statePath: corrupt })).resolves.toEqual({ ok: true })
    await expect(readSeenUpdateSequence(corrupt)).resolves.toBe(7)
  })

  it('never writes state when no state path is given', async () => {
    const directory = await temporaryDirectory()
    await expect(guardUpdateManifestSequence({ sequence: 42 })).resolves.toEqual({ ok: true })
    expect((await import('node:fs/promises')).readdir(directory)).resolves.toEqual([])
  })

  it('rejects invalid guard inputs constructively', async () => {
    await expect(guardUpdateManifestSequence({ sequence: 0 })).rejects.toThrow(TypeError)
    await expect(guardUpdateManifestSequence({ sequence: 1, lastSeenSequence: -1 })).rejects.toThrow(TypeError)
  })
})

describe('development-build verification skip warning', () => {
  it('names the missing trust roots whenever verification is skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      warnSkippedUpdateSignatureVerification('the update version check')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('ARTIFACT_TRUST_ROOTS')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('bounded update-channel body request', () => {
  it('rejects a streamed body above the limit while reading it', async () => {
    const result = await fetchUpdateChannelBytes({
      request: async () => new Response('x'.repeat(MAX_UPDATE_MANIFEST_BYTES + 1)),
      url: MANIFEST_URL,
      label: 'update manifest',
      maxBytes: MAX_UPDATE_MANIFEST_BYTES,
    })
    expect(result).toMatchObject({ ok: false, code: 'response-too-large' })
  })

  it('rethrows caller cancellation instead of mapping it to a failure', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(fetchUpdateChannelBytes({
      request: async () => {
        throw new DOMException('cancelled', 'AbortError')
      },
      url: MANIFEST_URL,
      label: 'update manifest',
      maxBytes: MAX_UPDATE_MANIFEST_BYTES,
      ...(controller.signal === undefined ? {} : { signal: controller.signal }),
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
