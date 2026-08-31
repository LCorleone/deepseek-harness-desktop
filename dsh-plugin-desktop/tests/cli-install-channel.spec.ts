import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import {
  authorizeLockedPluginAdd,
  companyManifestAssetPath,
  parseExactPluginAddSpec,
} from '../src/cli-install-channel.ts'
import { companyManifestFileRequest, fetchCompanyManifestText } from '../src/company-manifest-origin.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'
import type { DesktopPolicy } from '../src/desktop-policy.ts'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')

function lockedCatalogPolicy(overrides: Record<string, unknown> = {}): DesktopPolicy {
  return parseDesktopPolicy({
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked: true,
    managedModels: false,
    trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
    ...overrides,
  })
}

const asUnsigned = (manifest: Record<string, unknown>) =>
  manifest as unknown as Parameters<typeof createCompanyManifestSignature>[0]

function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: 'example-plugin',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    bundlePatch: './cordis.patch.yml',
    repository: { url: 'https://github.com/example/example-plugin' },
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    ...overrides,
  }
}

function unsignedCatalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: '2030-01-01T00:00:00Z',
    packages: [catalogEntry()],
    ...overrides,
  }
}

describe('locked plugin-add spec parsing', () => {
  it.each([
    ['example-plugin@1.0.0', { packageName: 'example-plugin', version: '1.0.0' }],
    ['@scope/example-plugin@20.3.4', { packageName: '@scope/example-plugin', version: '20.3.4' }],
  ])('accepts the exact form %s', (spec, expected) => {
    expect(parseExactPluginAddSpec(spec)).toEqual(expected)
  })

  it.each([
    ['bare package name', 'example-plugin'],
    ['dist tag', 'example-plugin@latest'],
    ['caret range', 'example-plugin@^1.0.0'],
    ['gte range', 'example-plugin@>=1.0.0 <2.0.0'],
    ['prerelease', 'example-plugin@1.0.0-beta.1'],
    ['build metadata', 'example-plugin@1.0.0+build.7'],
    ['leading v', 'example-plugin@v1.0.0'],
    ['leading zero', 'example-plugin@01.0.0'],
    ['missing patch', 'example-plugin@1.0'],
    ['empty spec', ''],
    ['scoped name without version', '@scope/example-plugin'],
    ['at only', '@'],
    ['uppercase package name', 'Example-Plugin@1.0.0'],
  ])('rejects the non-exact form %s', (_label, spec) => {
    expect(parseExactPluginAddSpec(spec)).toBeUndefined()
  })
})

describe('company manifest asset path', () => {
  it('resolves the policy manifest URL beside a built module', () => {
    const moduleUrl = pathToFileURL('/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/desktop-cli.js').href
    expect(companyManifestAssetPath(moduleUrl, 'company-market/catalog-manifest.json'))
      .toBe('/Applications/DSH Desktop.app/Contents/Resources/app.asar/lib/company-market/catalog-manifest.json')
  })

  it.each([
    ['empty module URL', ''],
    ['non-string module URL', undefined],
  ])('rejects %s', (_label, moduleUrl) => {
    expect(() => companyManifestAssetPath(moduleUrl as string, 'company-market/catalog-manifest.json'))
      .toThrow('non-empty file URL')
  })

  it.each([
    ['absolute path', '/etc/company/catalog-manifest.json'],
    ['parent escape', '../company-market/catalog-manifest.json'],
    ['dot segment', './company-market/catalog-manifest.json'],
    ['empty segment', 'company-market//catalog-manifest.json'],
    ['backslash', 'company-market\\catalog-manifest.json'],
    ['NUL byte', 'company-market/catalog-manifest.json\0'],
    ['empty URL', ''],
  ])('rejects the manifest URL %s', (_label, companyManifestUrl) => {
    const moduleUrl = pathToFileURL('/app/lib/desktop-cli.js').href
    expect(() => companyManifestAssetPath(moduleUrl, companyManifestUrl))
      .toThrow('company manifest URL')
  })
})

describe('locked plugin-add authorization', () => {
  const roots = mkdtempSync(join(tmpdir(), 'dsh-desktop-cli-install-channel-'))

  afterEach(() => {
    rmSync(roots, { recursive: true, force: true })
  })

  function writeCatalog(manifest: Record<string, unknown>, directory = roots): string {
    const signature = createCompanyManifestSignature(asUnsigned(manifest), privateKey, keyId)
    const assetPath = join(directory, 'company-market', 'catalog-manifest.json')
    mkdirSync(join(directory, 'company-market'), { recursive: true })
    writeFileSync(assetPath, canonicalJsonText({ ...manifest, signature }))
    return assetPath
  }

  it('allows an exact target with a verified unrevoked entry', async () => {
    const assetPath = writeCatalog(unsignedCatalog())

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision).toEqual({
      allowed: true,
      packages: [{ packageName: 'example-plugin', version: '1.0.0' }],
    })
  })

  it('accepts a leading --save-exact but no other flag before the package spec', async () => {
    const assetPath = writeCatalog(unsignedCatalog())

    const exact = await authorizeLockedPluginAdd(
      ['--save-exact', 'example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )
    expect(exact).toEqual({
      allowed: true,
      packages: [{ packageName: 'example-plugin', version: '1.0.0' }],
    })

    // The Market install path forwards its pinned registry flags through the
    // spawned desktop-cli; the locked channel consumes exactly those.
    const marketShaped = await authorizeLockedPluginAdd(
      ['--save-exact', '--registry=https://registry.npmjs.org/', 'example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )
    expect(marketShaped).toEqual({
      allowed: true,
      packages: [{ packageName: 'example-plugin', version: '1.0.0' }],
    })
    const scopedMarketShaped = await authorizeLockedPluginAdd(
      ['--save-exact', '--registry=https://registry.npmjs.org/', '--@scope:registry=https://registry.npmjs.org/', 'example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )
    expect(scopedMarketShaped.allowed).toBe(true)

    const hostileRegistry = await authorizeLockedPluginAdd(
      ['--registry=https://evil.example/', 'example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )
    expect(hostileRegistry.allowed).toBe(false)

    const thirdRegistryFlag = await authorizeLockedPluginAdd(
      [
        '--registry=https://registry.npmjs.org/',
        '--@scope:registry=https://registry.npmjs.org/',
        '--@other:registry=https://registry.npmjs.org/',
        'example-plugin@1.0.0',
      ],
      lockedCatalogPolicy(),
      { assetPath },
    )
    expect(thirdRegistryFlag.allowed).toBe(false)
    if (!thirdRegistryFlag.allowed) {
      expect(thirdRegistryFlag.reason).toContain('exactly one package argument')
    }

    const otherFlag = await authorizeLockedPluginAdd(
      ['--save-dev', 'example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )
    expect(otherFlag.allowed).toBe(false)
    if (!otherFlag.allowed) {
      expect(otherFlag.reason).toContain('<exact version>')
      expect(otherFlag.reason).toContain('company plugin market')
    }

    const doubled = await authorizeLockedPluginAdd(
      ['--save-exact', '--save-exact', 'example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )
    expect(doubled.allowed).toBe(false)
    if (!doubled.allowed) expect(doubled.reason).toContain('exactly one package argument')
  })

  it('treats the receipts sequence floor as a lower bound: equal passes, older is stale', async () => {
    const assetPath = writeCatalog(unsignedCatalog())

    // The same sequence is the normal steady state: re-installing from, or
    // installing a second plugin out of, the catalog that already allowed an
    // install must not demand an operator sequence bump.
    const replayed = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath, lastSeenSequence: 42 },
    )
    expect(replayed).toEqual({
      allowed: true,
      packages: [{ packageName: 'example-plugin', version: '1.0.0' }],
    })

    const stale = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath, lastSeenSequence: 43 },
    )
    expect(stale.allowed).toBe(false)
    if (!stale.allowed) {
      expect(stale.reason).toContain('stale-sequence')
      expect(stale.reason).toContain('regressed below the last seen sequence 43')
    }

    const newer = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath, lastSeenSequence: 41 },
    )
    expect(newer.allowed).toBe(true)
  })

  it('denies spec counts other than exactly one package argument', async () => {
    const decision = await authorizeLockedPluginAdd([], lockedCatalogPolicy())

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('exactly one package argument')
  })

  it('denies non-exact specs before touching the manifest asset', async () => {
    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@latest'],
      lockedCatalogPolicy(),
      { assetPath: join(roots, 'missing-asset.json') },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('<exact version>')
      expect(decision.reason).toContain('company plugin market')
    }
  })

  it('allows an exact target fetched from the policy-pinned origin', async () => {
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })
    const manifestText = readFileSync(writeCatalog(unsignedCatalog()), 'utf8')
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://market.company.example/catalog-manifest.json')
      expect(init.redirect).toBe('error')
      return new Response(manifestText)
    })

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: (url, init) => request(url, init) } },
    )

    expect(request).toHaveBeenCalledTimes(1)
    expect(decision).toEqual({
      allowed: true,
      packages: [{ packageName: 'example-plugin', version: '1.0.0' }],
    })
  })

  it('denies the plugin add when the origin fetch fails', async () => {
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: async () => new Response('gone', { status: 503 }) } },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('could not be fetched from https://market.company.example')
      expect(decision.reason).toContain('company plugin market')
    }
  })

  it('allows an exact target from launcher-staged bytes without touching the network', async () => {
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })
    const stagedFile = writeCatalog(unsignedCatalog(), join(roots, 'staged'))
    const network = vi.fn(async () => new Response('never read', { status: 503 }))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: companyManifestFileRequest(stagedFile, network) } },
    )

    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.packages).toEqual([{ packageName: 'example-plugin', version: '1.0.0' }])
    }
    expect(network).not.toHaveBeenCalled()
  })

  it('falls back to the restricted network fetch when the staged file is missing or empty', async () => {
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })
    const manifestText = readFileSync(writeCatalog(unsignedCatalog()), 'utf8')
    const network = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://market.company.example/catalog-manifest.json')
      expect(init.redirect).toBe('error')
      return new Response(manifestText)
    })

    const missing = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: companyManifestFileRequest(join(roots, 'gone', 'company-manifest.json'), network) } },
    )
    expect(missing.allowed).toBe(true)

    const emptyFile = join(roots, 'staged-empty', 'company-manifest.json')
    mkdirSync(dirname(emptyFile), { recursive: true })
    writeFileSync(emptyFile, '')
    const empty = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: companyManifestFileRequest(emptyFile, network) } },
    )
    expect(empty.allowed).toBe(true)
    expect(network).toHaveBeenCalledTimes(2)
  })

  it('denies staged bytes that fail the signature gate without any network fallback', async () => {
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })
    const tamperedFile = writeCatalog(unsignedCatalog(), join(roots, 'staged-tampered'))
    writeFileSync(tamperedFile, 'not json at all')
    const network = vi.fn(async () => new Response('never read'))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: companyManifestFileRequest(tamperedFile, network) } },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('rejected the company catalog manifest')
    }
    expect(network).not.toHaveBeenCalled()
  })

  it('rejects non-absolute staged manifest paths loudly', () => {
    expect(() => companyManifestFileRequest('company-market/catalog-manifest.json'))
      .toThrow('must be absolute without NUL')
    expect(() => companyManifestFileRequest('/tmp/manifest\0.json'))
      .toThrow('must be absolute without NUL')
  })

  it.skipIf(process.platform === 'win32')('falls back to the network boundary when the staged path is not a regular file', async () => {
    // A planted device node (or any non-regular file) must never stream into
    // the manifest boundary: `fstat` rejects it and the request degrades to
    // the restricted network fetch. `/dev/zero` is a real character device
    // this container serves, so the guard is exercised against the kernel.
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })
    const manifestText = readFileSync(writeCatalog(unsignedCatalog()), 'utf8')
    const network = vi.fn(async () => new Response(manifestText))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: companyManifestFileRequest('/dev/zero', network) } },
    )

    expect(decision.allowed).toBe(true)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('falls back to the network boundary when the staged file exceeds the manifest body bound', async () => {
    // A huge sparse file (5 MiB against the 4 MiB cap) is refused by `fstat`
    // before a byte is read — an unbounded staging file is unusable, not a
    // manifest — and the request degrades to the network fetch.
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })
    const manifestText = readFileSync(writeCatalog(unsignedCatalog()), 'utf8')
    const network = vi.fn(async () => new Response(manifestText))
    const oversized = join(roots, 'staged-oversized', 'company-manifest.json')
    mkdirSync(dirname(oversized), { recursive: true })
    writeFileSync(oversized, 'x')
    truncateSync(oversized, 4 * 1024 * 1024 + 1)

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: companyManifestFileRequest(oversized, network) } },
    )

    expect(decision.allowed).toBe(true)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('falls back to the network boundary when the staged path is a symlink', async () => {
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://market.company.example/catalog-manifest.json',
    })
    const manifestText = readFileSync(writeCatalog(unsignedCatalog()), 'utf8')
    const network = vi.fn(async () => new Response(manifestText))
    const target = writeCatalog(unsignedCatalog(), join(roots, 'staged-target'))
    const link = join(roots, 'staged-link', 'company-manifest.json')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      policy,
      { fetch: { request: companyManifestFileRequest(link, network) } },
    )

    expect(decision.allowed).toBe(true)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('stops a stalled staged read at the whole-request bound instead of hanging', async () => {
    // A FIFO with no writer stalls the open forever; the staged read must
    // stay bounded by the caller's whole-request abort signal (the same
    // bound capping the network fetch) and the cancellation must propagate
    // — the network fallback is not attempted for a torn-down request.
    const fifo = join(roots, 'stalled-fifo', 'company-manifest.json')
    mkdirSync(dirname(fifo), { recursive: true })
    spawnSync('mkfifo', [fifo])
    const network = vi.fn(async () => new Response('never read'))
    const boundary = companyManifestFileRequest(fifo, network)

    await expect(boundary('https://market.company.example/catalog-manifest.json', {
      redirect: 'error',
      signal: AbortSignal.timeout(150),
    })).rejects.toThrow()
    expect(network).not.toHaveBeenCalled()
  })

  it('denies origin policies whose manifest URL escapes the pinned origin before any request', async () => {
    // The strict policy parser refuses such documents itself; this guards
    // the shared fetch helper against non-parsed callers (defense in depth).
    const request = vi.fn(async () => new Response('never read'))
    const policy = {
      companyCatalogOrigin: 'https://market.company.example',
      companyManifestUrl: 'https://evil.example/catalog-manifest.json',
    } as const

    await expect(fetchCompanyManifestText(policy, { request })).rejects.toThrow(
      'must stay inside the pinned https catalog origin',
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('denies an unreadable manifest asset', async () => {
    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath: join(roots, 'absent', 'catalog-manifest.json') },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('unreadable company catalog manifest asset')
  })

  it('denies a tampered manifest with the verification code', async () => {
    const assetPath = writeCatalog(unsignedCatalog())
    writeFileSync(assetPath, 'not json at all')

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('malformed-json')
  })

  it('denies an expired manifest against the injected clock', async () => {
    const assetPath = writeCatalog(unsignedCatalog({ expiresAt: '2026-01-01T00:00:00Z' }))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath, now: () => Date.parse('2026-06-01T00:00:00.000Z') },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('expired')
      expect(decision.reason).toContain('2026-01-01T00:00:00Z')
    }
  })

  it('denies packages the signed catalog does not contain', async () => {
    const assetPath = writeCatalog(unsignedCatalog())

    const decision = await authorizeLockedPluginAdd(
      ['unapproved-plugin@9.9.9'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('not in the signed company plugin catalog')
  })

  it('denies revoked entries while keeping the audit trail readable', async () => {
    const assetPath = writeCatalog(unsignedCatalog({
      packages: [catalogEntry({ revoked: true })],
    }))

    const decision = await authorizeLockedPluginAdd(
      ['example-plugin@1.0.0'],
      lockedCatalogPolicy(),
      { assetPath },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain('revoked in the signed company plugin catalog')
  })
})
