import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJsonText } from '../src/signing/canonical-json.js'
import {
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  findCompanyManifestPackage,
  verifyCompanyManifest,
  type CompanyManifestTrustRoot,
  type VerifyCompanyManifestOptions,
} from '../src/signing/index.js'

const keyId = 'company-catalog-2026.01'
const rotationKeyId = 'company-catalog-2026.02'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const { publicKey: rotationPublicKey, privateKey: rotationPrivateKey } = generateKeyPairSync('ed25519')
const { privateKey: strangerPrivateKey } = generateKeyPairSync('ed25519')
const fingerprint = ed25519PublicKeyFingerprint(publicKey)
const rotationFingerprint = ed25519PublicKeyFingerprint(rotationPublicKey)
const verifiedAt = Date.parse('2026-09-01T00:00:00.000Z')
const trustRoots: readonly CompanyManifestTrustRoot[] = [{ keyId, fingerprint }]
const asUnsigned = (manifest: Record<string, unknown>) =>
  manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0]

function packageEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: 'dsh-plugin-safe',
    version: '1.2.3',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    ...overrides,
  }
}

function unsignedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [packageEntry()],
    ...overrides,
  }
}

function omit(value: Record<string, unknown>, ...keys: readonly string[]): Record<string, unknown> {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

function signedText(
  manifest: Record<string, unknown> = unsignedManifest(),
  signingKey: KeyObject = privateKey,
  signingKeyId: string = keyId,
): string {
  const signature = createCompanyManifestSignature(asUnsigned(manifest), signingKey, signingKeyId)
  return canonicalJsonText({ ...manifest, signature })
}

function verify(raw: string | Uint8Array, options: Partial<VerifyCompanyManifestOptions> = {}) {
  return verifyCompanyManifest(raw, { trustRoots, now: () => verifiedAt, ...options })
}

describe('canonical JSON serialization', () => {
  it('sorts object keys and emits no whitespace', () => {
    expect(canonicalJsonText({ b: 'x', a: null, c: [true, {}] })).toBe('{"a":null,"b":"x","c":[true,{}]}')
  })

  it('keeps non-ASCII characters literal', () => {
    expect(canonicalJsonText({ 名称: '中文插件' })).toBe('{"名称":"中文插件"}')
  })

  it('round-trips its own output byte for byte', () => {
    const text = '{"a":1,"b":[null,"z"]}'
    expect(canonicalJsonText(JSON.parse(text))).toBe(text)
  })

  it('rejects values outside the canonical grammar', () => {
    expect(() => canonicalJsonText({ v: 1.5 })).toThrow(TypeError)
    expect(() => canonicalJsonText({ v: 2 ** 53 })).toThrow(TypeError)
    expect(() => canonicalJsonText({ v: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJsonText({ v: undefined })).toThrow(TypeError)
    expect(() => canonicalJsonText([1n])).toThrow(TypeError)
    expect(() => canonicalJsonText({ v: () => 'x' })).toThrow(TypeError)
  })
})

describe('ed25519 public key fingerprints', () => {
  it('is the lowercase SHA-256 hex of the raw public key', () => {
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
    const raw = Buffer.from(jwk.x, 'base64url')
    const expected = createHash('sha256').update(raw).digest('hex')
    expect(ed25519PublicKeyFingerprint(publicKey)).toBe(expected)
    expect(ed25519PublicKeyFingerprint(new Uint8Array(raw))).toBe(expected)
    expect(ed25519PublicKeyFingerprint(rotationPublicKey)).not.toBe(expected)
  })

  it('rejects non-ed25519 keys', () => {
    const { publicKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    expect(() => ed25519PublicKeyFingerprint(ecKey)).toThrow(TypeError)
  })
})

describe('company manifest verification', () => {
  it('accepts a correctly signed manifest', () => {
    const result = verify(signedText())
    expect(result).toMatchObject({
      ok: true,
      keyId,
      fingerprint,
      verifiedAt,
      manifest: { sequence: 42, expiresAt: '2030-01-01T00:00:00Z' },
    })
    if (result.ok) {
      const entry = findCompanyManifestPackage(result.manifest, 'dsh-plugin-safe', '1.2.3')
      expect(entry).toMatchObject({ revoked: false, runtime: { dshRuntimeVersion: '^0.1.1-rc.2' } })
      expect(findCompanyManifestPackage(result.manifest, 'dsh-plugin-safe', '9.9.9')).toBeUndefined()
    }
  })

  it('accepts raw bytes input', () => {
    expect(verify(Buffer.from(signedText(), 'utf8')).ok).toBe(true)
  })

  it('rejects a tampered payload even when it stays canonical', () => {
    const tampered = JSON.parse(signedText()) as Record<string, unknown>
    const packages = tampered.packages as { version: string }[]
    packages[0]!.version = '9.9.9'
    const result = verify(canonicalJsonText(tampered))
    expect(result).toMatchObject({ ok: false, code: 'bad-signature' })
  })

  it('rejects a valid signature made with the wrong key', () => {
    const result = verify(signedText(unsignedManifest(), strangerPrivateKey, keyId))
    expect(result).toMatchObject({ ok: false, code: 'key-mismatch' })
  })

  it('accepts manifests signed by either overlapping rotation key', () => {
    const options: Partial<VerifyCompanyManifestOptions> = {
      trustRoots: [trustRoots[0]!, { keyId: rotationKeyId, fingerprint: rotationFingerprint }],
    }
    const oldKeyResult = verify(signedText(), options)
    const newKeyResult = verify(
      signedText(unsignedManifest({ sequence: 43 }), rotationPrivateKey, rotationKeyId),
      options,
    )
    expect(oldKeyResult).toMatchObject({ ok: true, keyId, fingerprint })
    expect(newKeyResult).toMatchObject({ ok: true, keyId: rotationKeyId, fingerprint: rotationFingerprint })
  })

  it('rejects a stranger key claiming a trusted keyId', () => {
    const overlapping: readonly CompanyManifestTrustRoot[] = [
      { keyId, fingerprint },
      { keyId: rotationKeyId, fingerprint: rotationFingerprint },
    ]
    expect(verify(signedText(unsignedManifest(), strangerPrivateKey, keyId), { trustRoots: overlapping }))
      .toMatchObject({ ok: false, code: 'key-mismatch' })
    expect(verify(signedText(unsignedManifest(), strangerPrivateKey, rotationKeyId), { trustRoots: overlapping }))
      .toMatchObject({ ok: false, code: 'key-mismatch' })
  })

  it('rejects sequence rollback including an equal sequence', () => {
    expect(verify(signedText(), { lastSeenSequence: 42 })).toMatchObject({ ok: false, code: 'stale-sequence' })
    expect(verify(signedText(), { lastSeenSequence: 100 })).toMatchObject({ ok: false, code: 'stale-sequence' })
    expect(verify(signedText(), { lastSeenSequence: 41 }).ok).toBe(true)
  })

  it('rejects an expired manifest', () => {
    const expired = signedText(unsignedManifest({ expiresAt: '2026-08-31T23:59:59Z' }))
    expect(verify(expired)).toMatchObject({ ok: false, code: 'expired' })
    const expiringExactlyNow = signedText(unsignedManifest({ expiresAt: '2026-09-01T00:00:00.000Z' }))
    expect(verify(expiringExactlyNow)).toMatchObject({ ok: false, code: 'expired' })
    const stillValid = signedText(unsignedManifest({ expiresAt: '2026-09-01T00:00:00.001Z' }))
    expect(verify(stillValid).ok).toBe(true)
  })

  it('rejects documents whose bytes are not canonical JSON', () => {
    const signed = JSON.parse(signedText()) as Record<string, unknown>
    expect(verify(JSON.stringify(signed, null, 2))).toMatchObject({ ok: false, code: 'non-canonical' })
    const reordered = {
      signature: signed.signature,
      sequence: signed.sequence,
      packages: signed.packages,
      manifestVersion: signed.manifestVersion,
      expiresAt: signed.expiresAt,
    }
    expect(verify(JSON.stringify(reordered))).toMatchObject({ ok: false, code: 'non-canonical' })
    expect(verify(`${signedText()}\n`)).toMatchObject({ ok: false, code: 'non-canonical' })
    const escaped = signedText().replace('"1.2.3"', '"\\u0031.2.3"')
    expect(verify(escaped)).toMatchObject({ ok: false, code: 'non-canonical' })
    const exponentSpelling = signedText().replace('"sequence":42', '"sequence":4.2e1')
    expect(verify(exponentSpelling)).toMatchObject({ ok: false, code: 'non-canonical' })
  })

  it('rejects an unknown keyId', () => {
    const result = verify(signedText(unsignedManifest(), privateKey, 'unlisted-key'))
    expect(result).toMatchObject({ ok: false, code: 'unknown-key' })
  })

  it('keeps revoked entries verifiable and readable', () => {
    const revokedEntry = packageEntry({ packageName: 'dsh-plugin-retired', revoked: true })
    const result = verify(signedText(unsignedManifest({ packages: [packageEntry(), revokedEntry] })))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(findCompanyManifestPackage(result.manifest, 'dsh-plugin-retired', '1.2.3')).toMatchObject({ revoked: true })
    }
  })

  it('rejects malformed JSON', () => {
    expect(verify('not json')).toMatchObject({ ok: false, code: 'malformed-json' })
    expect(verify('[]')).toMatchObject({ ok: false, code: 'malformed-json' })
  })

  it('rejects schema-invalid manifests', () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['unknown top-level field', unsignedManifest({ extra: 'x' })],
      ['zero sequence', unsignedManifest({ sequence: 0 })],
      ['sequence as string', unsignedManifest({ sequence: '42' })],
      ['missing packages', omit(unsignedManifest(), 'packages')],
      ['prerelease version', unsignedManifest({ packages: [packageEntry({ version: '1.2.3-rc.1' })] })],
      ['missing revoked flag', unsignedManifest({ packages: [omit(packageEntry(), 'revoked')] })],
      ['wrong integrity algorithm', unsignedManifest({ packages: [packageEntry({ integrity: 'sha1-abc' })] })],
      ['short integrity digest', unsignedManifest({ packages: [packageEntry({ integrity: 'sha512-abc=' })] })],
      ['missing dshRuntimeVersion', unsignedManifest({ packages: [packageEntry({ runtime: {} })] })],
      ['unknown runtime field', unsignedManifest({ packages: [packageEntry({ runtime: { dshRuntimeVersion: '^0.1.0', gpu: '*' } })] })],
    ]
    for (const [label, manifest] of cases) {
      expect(verify(signedText(manifest)), label).toMatchObject({ ok: false, code: 'invalid-manifest' })
    }
  })

  it('rejects semantic violations the schema cannot express', () => {
    const cases: readonly [string, Record<string, unknown>][] = [
      ['escaping bundle patch path', unsignedManifest({ packages: [packageEntry({ bundlePatch: '../escape.yml' })] })],
      ['absolute bundle patch path', unsignedManifest({ packages: [packageEntry({ bundlePatch: '/etc/passwd' })] })],
      ['invalid semver range', unsignedManifest({ packages: [packageEntry({ runtime: { dshRuntimeVersion: 'not a range' } })] })],
      [
        'duplicate package identity',
        unsignedManifest({ packages: [packageEntry(), packageEntry({ revoked: true })] }),
      ],
    ]
    for (const [label, manifest] of cases) {
      expect(verify(signedText(manifest)), label).toMatchObject({ ok: false, code: 'invalid-manifest' })
    }
  })

  it('throws TypeError only for invalid call arguments', () => {
    expect(() => verify(signedText(), { trustRoots: 'nope' as unknown as readonly CompanyManifestTrustRoot[] })).toThrow(TypeError)
    expect(() => verify(signedText(), { trustRoots: [{ keyId, fingerprint: 'ZZ' }] })).toThrow(TypeError)
    expect(() => verify(signedText(), { trustRoots: [trustRoots[0]!, trustRoots[0]!] })).toThrow(TypeError)
    expect(() => verify(signedText(), { lastSeenSequence: -1 })).toThrow(TypeError)
    expect(() => verify(signedText(), { lastSeenSequence: 1.5 })).toThrow(TypeError)
    expect(() => verify(signedText(), { now: () => Number.NaN })).toThrow(TypeError)
    expect(() => createCompanyManifestSignature(asUnsigned(unsignedManifest()), privateKey, 'bad key id')).toThrow(TypeError)
    const { privateKey: ecPrivate } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    expect(() => createCompanyManifestSignature(asUnsigned(unsignedManifest()), ecPrivate, keyId)).toThrow(TypeError)
  })
})
