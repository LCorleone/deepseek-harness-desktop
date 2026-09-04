import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  verifyCompanyManifest,
} from 'dsh-community-market'
import {
  authorizeLockedPluginAdd,
  companyManifestAssetPath,
  parseExactPluginAddSpec,
} from '../src/cli-install-channel.ts'
import {
  companyTarballHandoffText,
  desktopMarketTarballStagingPath,
  parseCompanyTarballHandoff,
  type CompanyTarballHandoff,
} from '../src/company-tarball-handoff.ts'
import { companyManifestFileRequest, fetchCompanyManifestText } from '../src/company-manifest-origin.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'
import type { DesktopPolicy } from '../src/desktop-policy.ts'

const keyId = 'company-catalog-2026.01'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')

function lockedCatalogPolicy(overrides: Record<string, unknown> = {}): DesktopPolicy {
  return parseDesktopPolicy({
    agentBrowser: { allowOrigins: [], allowPersistLogin: false, enabled: false },
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked: true,
    managedModels: false,
    requireSso: false,
    trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
    usageReport: false,
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

  it('decides source-free manifests exactly like the field-unaware market verifier through the locked gate', async () => {
    // The locked gate verifies through `verifyDesktopCompanyManifest` since
    // the P7 wiring; for manifests without `source` every decision must stay
    // byte-identical to the field-unaware market verifier that ran here
    // before — verified over the same 13-case corpus the dual-channel
    // verifier itself is pinned to.
    const corpus: readonly [string, Record<string, unknown>][] = [
      ['valid entry', catalogEntry()],
      ['entry unknown key', catalogEntry({ extra: 1 })],
      ['bad integrity shape', catalogEntry({ integrity: 'sha512-nope' })],
      ['bad bundlePatch escape', catalogEntry({ bundlePatch: '../escape.yml' })],
      ['bad repository url', catalogEntry({ repository: { url: 'http://insecure.example/r' } })],
      ['repository subdirectory escape', catalogEntry({ repository: { url: 'https://github.com/example/example-plugin', subdirectory: '../up' } })],
      ['bad runtime range', catalogEntry({ runtime: { dshRuntimeVersion: 'bogus range' } })],
      ['missing dshRuntimeVersion', catalogEntry({ runtime: {} })],
      ['bad approvedBuilds entry', catalogEntry({ approvedBuilds: ['not valid!'] })],
      ['bad treeDigest shape', catalogEntry({ treeDigest: 'xyz' })],
      ['revoked non-boolean', catalogEntry({ revoked: 'yes' })],
      ['bad version', catalogEntry({ version: '2.0.0-rc.1' })],
      ['duplicate entries', catalogEntry()],
    ]
    const policy = lockedCatalogPolicy()
    for (const [label, entry] of corpus) {
      const packages = label === 'duplicate entries' ? [entry, { ...entry }] : [entry]
      const assetPath = writeCatalog(unsignedCatalog({ packages }))
      const market = verifyCompanyManifest(readFileSync(assetPath, 'utf8'), { trustRoots: policy.trustRoots })
      // The queried target stays the exact pinned spec so only the manifest
      // decision (not spec parsing) decides the comparison.
      const decision = await authorizeLockedPluginAdd(['example-plugin@1.0.0'], policy, { assetPath })
      expect(decision.allowed, label).toBe(market.ok)
      if (!market.ok && !decision.allowed) {
        expect(decision.reason, label).toContain(`rejected the company catalog manifest (${String(market.code)})`)
      }
    }
    // Non-canonical bytes deny with the shared code: same parsed value in a
    // non-sorted key order is not the canonical serialization, which is
    // itself part of what is signed.
    const assetPath = writeCatalog(unsignedCatalog())
    const parsed = JSON.parse(readFileSync(assetPath, 'utf8')) as Record<string, unknown>
    writeFileSync(assetPath, JSON.stringify({
      signature: parsed.signature,
      packages: parsed.packages,
      sequence: parsed.sequence,
      manifestVersion: parsed.manifestVersion,
      expiresAt: parsed.expiresAt,
    }))
    const nonCanonical = await authorizeLockedPluginAdd(['example-plugin@1.0.0'], policy, { assetPath })
    expect(nonCanonical.allowed).toBe(false)
    if (!nonCanonical.allowed) expect(nonCanonical.reason).toContain('non-canonical')
  })

  it('decides manifest-level corpus cases exactly like the field-unaware market verifier', async () => {
    // Document-level decisions the entry corpus cannot reach (P7 2a
    // review): non-object JSON, unknown/missing top-level keys, signature
    // shape, bad `expiresAt` spellings, and the packages bound. The
    // bad-expiresAt cases pin the ajv-formats `date-time` mirror of the
    // desktop verifier; the space-separated spelling is ACCEPTED by both
    // verifiers (ajv's full date-time splits on t/T or whitespace, V8
    // parses it), so the equivalence is locked in both directions.
    const policy = lockedCatalogPolicy()
    const signedDocument = (document: Record<string, unknown>): string => canonicalJsonText({
      ...document,
      signature: createCompanyManifestSignature(asUnsigned(document), privateKey, keyId),
    })
    const unsignedDocument = (): Record<string, unknown> => ({
      manifestVersion: '1.0.0',
      sequence: 42,
      expiresAt: '2030-01-01T00:00:00Z',
      packages: [catalogEntry()],
    })
    const signatureBlock = createCompanyManifestSignature(
      asUnsigned(unsignedDocument()), privateKey, keyId,
    ) as unknown as Record<string, unknown>
    const corpus: readonly [string, string][] = [
      ['non-object JSON (array)', canonicalJsonText([])],
      ['non-object JSON (number)', canonicalJsonText(5)],
      ['non-object JSON (string)', canonicalJsonText('x')],
      ['unknown top-level key', signedDocument({ ...unsignedDocument(), futureField: 1 })],
      ['missing top-level key', signedDocument({
        manifestVersion: '1.0.0',
        expiresAt: '2030-01-01T00:00:00Z',
        packages: [catalogEntry()],
      })],
      ['signature not an object', canonicalJsonText({ ...unsignedDocument(), signature: 5 })],
      ['signature missing value key', canonicalJsonText({
        ...unsignedDocument(),
        signature: { keyId: signatureBlock.keyId, publicKey: signatureBlock.publicKey },
      })],
      ['bad expiresAt (RFC-1123 spelling)', signedDocument({ ...unsignedDocument(), expiresAt: 'Wed, 01 Jan 2030 00:00:00 GMT' })],
      ['bad expiresAt (leap second, format-valid but unparseable)', signedDocument({ ...unsignedDocument(), expiresAt: '2030-12-31T23:59:60Z' })],
      ['bad expiresAt (non-string)', signedDocument({ ...unsignedDocument(), expiresAt: 20300101 })],
      ['space-separated expiresAt (both accept)', signedDocument({ ...unsignedDocument(), expiresAt: '2030-01-01 00:00:00Z' })],
      [`packages over-limit (${String(10_001)} entries)`, signedDocument({
        ...unsignedDocument(),
        packages: Array.from({ length: 10_001 }, (_, index) =>
          catalogEntry({ packageName: `example-plugin-${String(index)}` })),
      })],
    ]
    for (const [label, text] of corpus) {
      const assetPath = join(roots, 'company-market', `corpus-${label.replace(/[^a-z0-9]+/gu, '-')}.json`)
      mkdirSync(dirname(assetPath), { recursive: true })
      writeFileSync(assetPath, text)
      const market = verifyCompanyManifest(text, { trustRoots: policy.trustRoots })
      const decision = await authorizeLockedPluginAdd(['example-plugin@1.0.0'], policy, { assetPath })
      expect(decision.allowed, label).toBe(market.ok)
      if (!market.ok && !decision.allowed) {
        expect(decision.reason, label).toContain(`rejected the company catalog manifest (${String(market.code)})`)
      }
    }
  })

  it('allows an explicit npm source and denies tarball-channel entries with market guidance', async () => {
    const hardenedIntegrity = `sha512-${Buffer.alloc(64, 5).toString('base64')}`
    const hardenedUrl = 'https://gitlab.company.example/julu/dsh-desktop-config/-/packages/company-hardened-plugin-2.1.0.tgz'
    const manifestText = readFileSync(writeCatalog(unsignedCatalog({
      packages: [
        catalogEntry({ source: { kind: 'npm' } }),
        catalogEntry({
          packageName: 'company-hardened-plugin',
          version: '2.1.0',
          integrity: hardenedIntegrity,
          treeDigest: 'ab'.repeat(32),
          source: { kind: 'tarball', url: hardenedUrl, integrity: hardenedIntegrity },
        }),
      ],
    })), 'utf8')
    const policy = lockedCatalogPolicy({
      companyCatalogOrigin: 'https://gitlab.company.example',
      companyManifestUrl: 'https://gitlab.company.example/company-market/catalog-manifest.json',
    })
    const request = async () => new Response(manifestText)

    // The manifest verifies under the origin-mode policy (field-aware), and
    // an explicit npm source stays the npm channel byte for byte.
    const npm = await authorizeLockedPluginAdd(['example-plugin@1.0.0'], policy, { fetch: { request } })
    expect(npm).toEqual({ allowed: true, packages: [{ packageName: 'example-plugin', version: '1.0.0' }] })

    // The tarball channel cannot be served by a public-registry terminal
    // add: its signed integrity is the intranet tarball's sha512, which the
    // registry path can never pin — deny with the market guidance instead
    // of allowing a doomed, boot-rejected install.
    const tarball = await authorizeLockedPluginAdd(['company-hardened-plugin@2.1.0'], policy, { fetch: { request } })
    expect(tarball.allowed).toBe(false)
    if (!tarball.allowed) {
      expect(tarball.reason).toContain('published on the tarball channel')
      expect(tarball.reason).toContain('Install plugins from the company plugin market')
    }

    // Fleet gate cross-check: the field-unaware market verifier still
    // rejects the whole manifest, and a content-mode policy (no origin)
    // rejects it through the dual verifier as well.
    expect(verifyCompanyManifest(manifestText, { trustRoots: policy.trustRoots }).ok).toBe(false)
    const contentMode = lockedCatalogPolicy()
    const contentAsset = writeCatalog(unsignedCatalog({
      packages: [catalogEntry({ source: { kind: 'tarball', url: hardenedUrl, integrity: hardenedIntegrity } })],
    }))
    const refused = await authorizeLockedPluginAdd(['example-plugin@1.0.0'], contentMode, { assetPath: contentAsset })
    expect(refused.allowed).toBe(false)
    if (!refused.allowed) expect(refused.reason).toContain('invalid-manifest')
  })
})

// ---------------------------------------------------------------------------
// The launcher's market-orchestrated tarball hand-off (P7 fix): the one
// admitted `file:` target through the locked gate, and every forgery shape
// that must stay denied.
// ---------------------------------------------------------------------------

describe('locked plugin-add controlled tarball hand-off', () => {
  const roots = mkdtempSync(join(tmpdir(), 'dsh-desktop-cli-install-channel-handoff-'))
  // Tarball-channel entries only verify under an origin-mode policy (the
  // dual-channel verifier rejects `source` entries in content mode), so this
  // suite serves every catalog through the origin fetch seam.
  const policy = lockedCatalogPolicy({
    companyCatalogOrigin: 'https://market.company.example',
    companyManifestUrl: 'https://market.company.example/company-market/catalog-manifest.json',
  })
  const stagedBytes = Buffer.from('market tarball fixture bytes\n', 'utf8')
  const stagedIntegrity = `sha512-${createHash('sha512').update(stagedBytes).digest('base64')}`
  const tamperedBytes = Buffer.from('tampered replacement bytes\n', 'utf8')
  const otherIntegrity = `sha512-${createHash('sha512').update(tamperedBytes).digest('base64')}`
  const hardenedUrl = 'https://market.company.example/julu/dsh-desktop-config/-/packages/company-hardened-plugin-2.1.0.tgz'

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

  /** One tarball-channel catalog whose signed sha512 is the staged fixture's. */
  function writeTarballCatalog(overrides: Record<string, unknown> = {}): string {
    return writeCatalog(unsignedCatalog({
      packages: [catalogEntry({
        packageName: 'company-hardened-plugin',
        version: '2.1.0',
        integrity: stagedIntegrity,
        treeDigest: 'ab'.repeat(32),
        repository: { url: 'https://github.com/example/company-hardened-plugin' },
        approvedBuilds: ['@company/signed-builder'],
        source: { kind: 'tarball', url: hardenedUrl, integrity: stagedIntegrity },
        ...overrides,
      })],
    }))
  }

  /** The staged fixture at its deterministic path inside one profile. */
  function stageFixture(profileDir: string, bytes: Buffer = stagedBytes): string {
    const stagedPath = desktopMarketTarballStagingPath(profileDir, 'company-hardened-plugin', '2.1.0')
    mkdirSync(dirname(stagedPath), { recursive: true })
    writeFileSync(stagedPath, bytes)
    return stagedPath
  }

  it('round-trips the hand-off document canonically and rejects every malformed spelling', () => {
    const handoff: CompanyTarballHandoff = {
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      integrity: stagedIntegrity,
      path: join('/tmp', 'profile', '.dsh-market-tarballs', 'company-hardened-plugin-2.1.0.tgz'),
    }
    const text = companyTarballHandoffText(handoff)
    // Fixed sorted key order, no whitespace — the canonical serialization.
    expect(text).toBe(JSON.stringify({
      integrity: handoff.integrity,
      packageName: handoff.packageName,
      path: handoff.path,
      version: handoff.version,
    }))
    expect(parseCompanyTarballHandoff(text)).toEqual(handoff)

    expect(parseCompanyTarballHandoff('')).toBeUndefined()
    expect(parseCompanyTarballHandoff('not json')).toBeUndefined()
    expect(parseCompanyTarballHandoff('[]')).toBeUndefined()
    expect(parseCompanyTarballHandoff(JSON.stringify({ ...handoff, extra: 1 }))).toBeUndefined()
    expect(parseCompanyTarballHandoff(JSON.stringify({
      integrity: handoff.integrity,
      packageName: handoff.packageName,
      path: handoff.path,
    }))).toBeUndefined()
    expect(parseCompanyTarballHandoff(JSON.stringify({ ...handoff, version: '2.1' }))).toBeUndefined()
    expect(parseCompanyTarballHandoff(JSON.stringify({ ...handoff, version: '2.1.0-rc.1' }))).toBeUndefined()
    expect(parseCompanyTarballHandoff(JSON.stringify({ ...handoff, packageName: 'Not-A-Name' }))).toBeUndefined()
    expect(parseCompanyTarballHandoff(JSON.stringify({ ...handoff, integrity: 'sha512-nope' }))).toBeUndefined()
    expect(parseCompanyTarballHandoff(JSON.stringify({ ...handoff, path: 'relative/path.tgz' }))).toBeUndefined()
    expect(parseCompanyTarballHandoff(`${JSON.stringify({ ...handoff, path: `${'x'.repeat(4_096)}.tgz` })}`)).toBeUndefined()
  })

  /** Serve one written catalog asset through the origin fetch seam. */
  const serveCatalog = (assetPath: string) => async () => new Response(readFileSync(assetPath, 'utf8'))

  it('admits the launcher hand-off file: target after the signed-entry and staged-byte double check', async () => {
    const assetPath = writeTarballCatalog()
    const profileDir = join(roots, 'profiles', 'web')
    const stagedPath = stageFixture(profileDir)
    const handoff: CompanyTarballHandoff = {
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      integrity: stagedIntegrity,
      path: stagedPath,
    }

    const decision = await authorizeLockedPluginAdd(
      ['--save-exact', '--registry=https://registry.npmjs.org/', `file:${stagedPath}`],
      policy,
      { fetch: { request: serveCatalog(assetPath) }, tarballHandoff: handoff, profileDir },
    )

    expect(decision).toEqual({
      allowed: true,
      packages: [{ packageName: 'company-hardened-plugin', version: '2.1.0' }],
      approvedBuildDependencies: ['@company/signed-builder'],
    })
  })

  it('still denies the same file: target without the hand-off (the terminal red line)', async () => {
    const assetPath = writeTarballCatalog()
    const profileDir = join(roots, 'profiles', 'web')
    const stagedPath = stageFixture(profileDir)

    const decision = await authorizeLockedPluginAdd(
      ['--save-exact', `file:${stagedPath}`],
      policy,
      { fetch: { request: serveCatalog(assetPath) }, profileDir },
    )

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('is not a <package>@<exact version> spec')
      expect(decision.reason).toContain('Install plugins from the company plugin market instead.')
    }
  })

  it.each([
    ['npm-form spec instead of the file: target', async (assetPath: string, profileDir: string, stagedPath: string) => {
      const decision = await authorizeLockedPluginAdd(
        ['company-hardened-plugin@2.1.0'],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: stagedPath },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('is only valid for its own file: install target')
    }],
    ['file: target other than the hand-off path', async (assetPath: string, profileDir: string, _stagedPath: string) => {
      const other = stageFixture(join(profileDir, 'other'))
      const decision = await authorizeLockedPluginAdd(
        [`file:${other}`],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: join(profileDir, '.dsh-market-tarballs', 'company-hardened-plugin-2.1.0.tgz') },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('pins the install target file:')
    }],
    ['hand-off path outside the deterministic staging location', async (assetPath: string, profileDir: string, _stagedPath: string) => {
      const planted = join(profileDir, 'planted.tgz')
      writeFileSync(planted, stagedBytes)
      const decision = await authorizeLockedPluginAdd(
        [`file:${planted}`],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: planted },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('may only install from the staged path')
    }],
    ['hand-off integrity diverging from the signed entry', async (assetPath: string, profileDir: string, stagedPath: string) => {
      const decision = await authorizeLockedPluginAdd(
        [`file:${stagedPath}`],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: otherIntegrity, path: stagedPath },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('pins integrity')
    }],
    ['staged bytes swapped after staging', async (assetPath: string, profileDir: string, stagedPath: string) => {
      writeFileSync(stagedPath, tamperedBytes)
      const decision = await authorizeLockedPluginAdd(
        [`file:${stagedPath}`],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: stagedPath },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('does not match the integrity pinned in the signed company plugin catalog')
    }],
    ['staged file missing entirely', async (assetPath: string, profileDir: string, stagedPath: string) => {
      rmSync(stagedPath, { force: true })
      const decision = await authorizeLockedPluginAdd(
        [`file:${stagedPath}`],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: stagedPath },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('is unusable')
    }],
    ['npm-channel entry behind the hand-off file: target', async (assetPath: string, profileDir: string, stagedPath: string) => {
      const decision = await authorizeLockedPluginAdd(
        [`file:${stagedPath}`],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: stagedPath },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('is not published on the tarball channel')
    }],
    ['revoked tarball entry behind the hand-off', async (assetPath: string, profileDir: string, stagedPath: string) => {
      const decision = await authorizeLockedPluginAdd(
        [`file:${stagedPath}`],
        policy,
        {
          fetch: { request: serveCatalog(assetPath) },
          profileDir,
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: stagedPath },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('revoked in the signed company plugin catalog')
    }],
    ['no profile directory to confine the staged path', async (assetPath: string, _profileDir: string, stagedPath: string) => {
      const decision = await authorizeLockedPluginAdd(
        [`file:${stagedPath}`],
        lockedCatalogPolicy(),
        {
          fetch: { request: serveCatalog(assetPath) },
          tarballHandoff: { packageName: 'company-hardened-plugin', version: '2.1.0', integrity: stagedIntegrity, path: stagedPath },
        },
      )
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) expect(decision.reason).toContain('cannot be confined without the active profile directory')
    }],
  ])('denies the hand-off shape: %s', async (_label, run) => {
    const assetPath = writeTarballCatalog(
      _label === 'npm-channel entry behind the hand-off file: target'
        ? { source: { kind: 'npm' } }
        : _label === 'revoked tarball entry behind the hand-off'
          ? { revoked: true }
          : {},
    )
    const profileDir = join(roots, 'profiles', 'deny')
    const stagedPath = stageFixture(profileDir)
    await run(assetPath, profileDir, stagedPath)
  })
})
