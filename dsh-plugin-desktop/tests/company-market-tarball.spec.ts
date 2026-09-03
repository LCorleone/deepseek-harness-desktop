/**
 * P7 dual-channel company market (batch 1): source-aware manifest
 * verification, controlled tarball staging, the pnpm controlled-tarball
 * install target, post-install treeDigest re-verification, and the
 * allowlist→manifest generation of the `source` field in the publishing tool.
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  verifyCompanyManifest,
} from 'dsh-community-market'
import {
  desktopCompanyEntrySource,
  findDesktopCompanyManifestPackage,
  installCompanyMarketTarballPlugin,
  stageCompanyMarketTarball,
  verifyDesktopCompanyManifest,
  type DesktopCompanyTarballInstallEntry,
} from '../src/desktop-market.ts'
import {
  apply as applyDesktopPnpm,
  desktopMarketTarballStagingName,
  desktopMarketTarballStagingPath,
  inject as desktopPnpmInject,
  name as desktopPnpmName,
  DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY,
  type DesktopPnpm,
  type DesktopPnpmBootstrap,
  type DesktopControlledMarketTarball,
  type DesktopPluginInstallRecovery,
} from '../src/pnpm.ts'

const keyId = 'company-catalog-selftest'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustRoots = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const CATALOG_ORIGIN = 'https://gitlab.company.example'

const roots: string[] = []
function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-company-tarball-${label}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Deterministic fixture tarball bytes with their signed sha512. */
const TARBALL_BYTES = Buffer.from('company-hardened-plugin tarball fixture\n', 'utf8')
const TARBALL_INTEGRITY = `sha512-${createHash('sha512').update(TARBALL_BYTES).digest('base64')}`
const TARBALL_URL = `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/packages/company-hardened-plugin-2.1.0.tgz`
const TREE_DIGEST = 'ab'.repeat(32)
const INTEGRITY_ALTERNATE = `sha512-${createHash('sha512').update(Buffer.from('different bytes\n')).digest('base64')}`

function npmEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function tarballEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return npmEntry({
    packageName: 'company-hardened-plugin',
    version: '2.1.0',
    integrity: TARBALL_INTEGRITY,
    repository: { url: 'https://github.com/example/company-hardened-plugin' },
    treeDigest: TREE_DIGEST,
    source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
    ...overrides,
  })
}

/** Sign arbitrary manifest packages into canonical, verifiable bytes. */
function signedManifestText(
  packages: readonly Record<string, unknown>[],
  options: { sequence?: number; expiresInDays?: number } = {},
): string {
  const unsigned = {
    manifestVersion: '1.0.0',
    sequence: options.sequence ?? 42,
    expiresAt: new Date(Date.now() + (options.expiresInDays ?? 90) * 86_400_000).toISOString(),
    packages,
  }
  const signature = createCompanyManifestSignature(
    unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    privateKey,
    keyId,
  )
  return canonicalJsonText({ ...unsigned, signature })
}

/** Request boundary serving fixed bytes for every URL (the download double). */
function requestServing(bytes: Buffer, status = 200): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url, init) => {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return new Response(new Uint8Array(bytes), {
      status,
      statusText: status === 200 ? 'OK' : 'Boom',
      headers: { 'content-type': 'application/gzip' },
    })
  }
}

const failingRequest = async (): Promise<Response> => {
  throw new TypeError('network is unreachable')
}

// ---------------------------------------------------------------------------
// pnpm harness (the shape of tests/pnpm.spec.ts, trimmed to what this spec
// needs: a real DesktopPnpm service over a controlled subprocess).
// ---------------------------------------------------------------------------

interface ControlledSubprocess extends SubprocessHandle {
  resolveDone(outcome: SubprocessOutcome): void
  resolveTree(): void
}

function controlledSubprocess(): ControlledSubprocess {
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let resolveTree!: () => void
  const done = new Promise<SubprocessOutcome>(resolve => { resolveDone = resolve })
  const tree = new Promise<boolean>(resolve => { resolveTree = () => resolve(true) })
  return {
    pid: 43_120,
    stdin: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    collected: {},
    done,
    terminate: vi.fn(),
    waitForExit: vi.fn(() => tree),
    resolveDone: outcome => { resolveDone(outcome) },
    resolveTree: () => { resolveTree() },
  }
}

function bootstrap(root: string, profileDir: string): DesktopPnpmBootstrap {
  return {
    activeProfileName: 'web',
    activeProfileDir: profileDir,
    homeDir: join(root, 'home'),
    nodeExecutable: join(root, 'resources', 'node-runtime', 'node'),
    pnpmBinPath: join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    electronVersion: '43.4.0',
    nodeBinDir: join(root, 'private', 'node-bin'),
    nodeShimPath: join(root, 'private', 'node-bin', 'node'),
    dshBootstrapPath: join(root, 'app.asar', 'lib', 'desktop-cli.js'),
    installRecoveryStatePath: join(root, 'plugin-install-recovery', 'state.json'),
    generationId: 'company-tarball-generation-0001',
    externalMarketInstallEnabled: false,
  }
}

interface PnpmHarness {
  service: DesktopPnpm
  spawn: ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>>
  dispose(): Promise<void>
}

async function createPnpmHarness(
  spawn: ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>>,
  selectedBootstrap: DesktopPnpmBootstrap,
): Promise<PnpmHarness> {
  const ctx = new Context()
  ctx.provide('desktopPnpmBootstrap', selectedBootstrap)
  ctx.provide('subprocess', { spawn } as unknown as SubprocessRuntime)
  const fiber = ctx.plugin({ name: desktopPnpmName, inject: desktopPnpmInject, apply: applyDesktopPnpm })
  await fiber
  const service = ctx.get('desktopPnpm')
  if (service === undefined) throw new Error('desktop pnpm service did not mount')
  return { service, spawn, dispose: fiber.dispose }
}

/** Spawn mock serving a fixed queue of controlled children (the pnpm.spec shape). */
function queuedSpawn(children: ControlledSubprocess[]): ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>> {
  return vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => {
    const child = children.shift()
    if (child === undefined) throw new Error('test subprocess queue is empty')
    return child
  })
}

/**
 * Spawn mock whose child mutates the profile exactly like a real
 * `dsh plugin add file:<tarball>` and then exits zero. The mutation runs when
 * pnpm is spawned — that is, after the recovery WAL has snapshotted the
 * pre-install profile — which is the ordering a real install guarantees.
 */
function installSimulatingSpawn(effect: () => void): ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>> {
  return vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => {
    const child = controlledSubprocess()
    void Promise.resolve().then(() => {
      effect()
      child.resolveDone({ exitCode: 0, signal: null })
      child.resolveTree()
    })
    return child
  })
}

/** What a real `dsh plugin add file:<tarball>` leaves behind in the profile. */
function simulateSuccessfulPnpmTarballInstall(profileDir: string, entry: { packageName: string; version: string; bundlePatch: string }, stagedPath: string): void {
  const segments = entry.packageName.startsWith('@') ? entry.packageName.split('/') : [entry.packageName]
  const packageDir = join(profileDir, 'node_modules', ...segments)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: entry.packageName,
    version: entry.version,
    dsh: { bundle: { patch: entry.bundlePatch } },
  }))
  writeFileSync(join(packageDir, entry.bundlePatch.replace(/^\.\//u, '')), '[]\n')
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
  manifest.dependencies = { ...(manifest.dependencies as Record<string, string> ?? {}), [entry.packageName]: `file:${stagedPath}` }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
    'lockfileVersion: \'9.0\'',
    'importers:',
    '  .:',
    '    dependencies:',
    `      ${entry.packageName}:`,
    `        specifier: file:${stagedPath}`,
    `        version: file:${join(DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, entry.packageName.replace(/^@/u, '').replace('/', '+'))}-${entry.version}.tgz`,
    'packages:',
    '',
    `  ${entry.packageName}@file:${join(DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, entry.packageName.replace(/^@/u, '').replace('/', '+'))}-${entry.version}.tgz:`,
    `    resolution: {integrity: ${TARBALL_INTEGRITY}}`,
    '',
  ].join('\n'))
}

// ---------------------------------------------------------------------------
// Tool-side dynamic imports (plain .mjs modules, typed through local shapes).
// ---------------------------------------------------------------------------

interface AllowlistValidation {
  ok: boolean
  value?: Record<string, unknown>
  reason?: string
}

interface AllowlistModule {
  validateAllowlistEntry(entry: unknown, at: string, options?: { companyCatalogOrigin?: string }): AllowlistValidation
}

interface PipelineModule {
  assembleUnsignedManifest(options: {
    market: unknown
    sequence: number
    expiresAt: Date
    entries: readonly Record<string, unknown>[]
    dists: Map<string, { integrity: string }>
  }): { packages: readonly Record<string, unknown>[] }
  verifyManifestText(
    market: unknown,
    text: string,
    options: { fingerprint: string; keyId: string; lastSeenSequence?: number; companyCatalogOrigin?: string },
  ): Promise<{ ok: true; manifest: { packages: readonly Record<string, unknown>[] } } | { ok: false; code: string; reason: string }>
}

const importUrl = (relative: string): Promise<AllowlistModule & PipelineModule> =>
  import(new URL(relative, import.meta.url).href) as Promise<AllowlistModule & PipelineModule>

let toolModulesPromise: Promise<AllowlistModule & PipelineModule> | undefined
async function tools(): Promise<AllowlistModule & PipelineModule> {
  toolModulesPromise ??= (async () => ({
    ...(await importUrl('../../tools/company-catalog/lib/allowlist.mjs')),
    ...(await importUrl('../../tools/company-catalog/lib/pipeline.mjs')),
  }))()
  return await toolModulesPromise
}

// ---------------------------------------------------------------------------
// Manifest verification (dual-channel schema).
// ---------------------------------------------------------------------------

describe('dual-channel company manifest verification', () => {
  it('accepts a manifest mixing npm and tarball entries and parses both channels', () => {
    const text = signedManifestText([npmEntry(), tarballEntry()])
    const verification = verifyDesktopCompanyManifest(text, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN })
    expect(verification).toMatchObject({ ok: true, keyId })
    if (!verification.ok) return
    const npm = findDesktopCompanyManifestPackage(verification.manifest, 'example-plugin', '1.0.0')
    const tarball = findDesktopCompanyManifestPackage(verification.manifest, 'company-hardened-plugin', '2.1.0')
    expect(npm).toBeDefined()
    expect(tarball).toBeDefined()
    expect(desktopCompanyEntrySource(npm!)).toEqual({ kind: 'npm' })
    expect(desktopCompanyEntrySource(tarball!)).toEqual({ kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY })
    expect(npm!.source).toBeUndefined()
    expect(verification.manifest.sequence).toBe(42)
  })

  it('accepts an explicit npm source object', () => {
    const text = signedManifestText([tarballEntry(), npmEntry({ source: { kind: 'npm' } })])
    const verification = verifyDesktopCompanyManifest(text, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN })
    expect(verification.ok).toBe(true)
    if (!verification.ok) return
    expect(desktopCompanyEntrySource(
      findDesktopCompanyManifestPackage(verification.manifest, 'example-plugin', '1.0.0')!,
    )).toEqual({ kind: 'npm' })
  })

  it.each([
    ['url on another origin', tarballEntry({ source: { kind: 'tarball', url: 'https://evil.example/packages/company-hardened-plugin-2.1.0.tgz', integrity: TARBALL_INTEGRITY } }), 'must stay inside the pinned catalog origin'],
    ['non-https url', tarballEntry({ source: { kind: 'tarball', url: `http://${CATALOG_ORIGIN.slice('https://'.length)}/packages/x.tgz`, integrity: TARBALL_INTEGRITY } }), 'https'],
    ['url with credentials', tarballEntry({ source: { kind: 'tarball', url: 'https://user@gitlab.company.example/packages/x.tgz', integrity: TARBALL_INTEGRITY } }), 'https'],
    ['url with a fragment', tarballEntry({ source: { kind: 'tarball', url: `${TARBALL_URL}#x`, integrity: TARBALL_INTEGRITY } }), 'https'],
    ['malformed integrity', tarballEntry({ source: { kind: 'tarball', url: TARBALL_URL, integrity: 'sha512-not-base64-at-all' } }), 'SHA-512'],
    ['unknown source kind', tarballEntry({ source: { kind: 'git', url: TARBALL_URL } }), "'npm' or 'tarball'"],
    ['unknown key inside source', tarballEntry({ source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY, checksum: 'x' } }), 'unknown field'],
    ['url on an npm entry', npmEntry({ source: { kind: 'npm', url: TARBALL_URL } }), 'must not carry url'],
    ['unknown key on an entry', tarballEntry({ distribution: 'any' }), 'unknown field'],
    ['top-level integrity diverging from the tarball source integrity', tarballEntry({ integrity: INTEGRITY_ALTERNATE }), 'tarball-channel entry must pin the tarball file'],
    ['invalid runtime range', tarballEntry({ runtime: { dshRuntimeVersion: 'not a range ^^' } }), 'node-semver'],
    ['invalid treeDigest', tarballEntry({ treeDigest: 'ZZ'.repeat(32) }), '64 lowercase hex'],
  ])('rejects the whole manifest for %s', (_label, mutatedEntry, fragment) => {
    const text = signedManifestText([npmEntry(), mutatedEntry as Record<string, unknown>])
    const verification = verifyDesktopCompanyManifest(text, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN })
    expect(verification).toMatchObject({ ok: false, code: 'invalid-manifest' })
    if (verification.ok) return
    expect(verification.reason).toContain(fragment)
  })

  it('rejects the whole manifest for an unknown root key and for duplicate entries', () => {
    const rootKeyText = signedManifestText([tarballEntry()]).replace(
      '"manifestVersion":"1.0.0"',
      '"manifestVersion":"1.0.0","experiment":true',
    )
    // Re-sign is impossible over mutated canonical bytes without redoing the
    // signature; instead parse-and-resign the extended document so only the
    // unknown key decides the outcome.
    const parsed = JSON.parse(signedManifestText([tarballEntry()])) as Record<string, unknown>
    const withUnknownKey = canonicalJsonText({ ...parsed, experiment: true, signature: parsed.signature })
    expect(verifyDesktopCompanyManifest(withUnknownKey, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN }))
      .toMatchObject({ ok: false, code: 'invalid-manifest' })
    expect(rootKeyText.length).toBeGreaterThan(0)
    const duplicateText = signedManifestText([tarballEntry(), tarballEntry()])
    const duplicate = verifyDesktopCompanyManifest(duplicateText, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN })
    expect(duplicate).toMatchObject({ ok: false, code: 'invalid-manifest' })
    if (duplicate.ok) return
    expect(duplicate.reason).toContain('duplicates the signed entry')
  })

  it('rejects a tarball entry under a content-mode policy (no catalog origin)', () => {
    const text = signedManifestText([tarballEntry()])
    const verification = verifyDesktopCompanyManifest(text, { trustRoots, companyCatalogOrigin: null })
    expect(verification).toMatchObject({ ok: false, code: 'invalid-manifest' })
    if (verification.ok) return
    expect(verification.reason).toContain('requires an origin-mode catalog policy')
  })

  it('rejects signature, trust-root, sequence, and expiry failures with the market codes', () => {
    const valid = signedManifestText([tarballEntry()])
    const otherKey = generateKeyPairSync('ed25519')
    const unsigned = JSON.parse(valid) as { signature: unknown }
    const tampered = canonicalJsonText({ ...unsigned, packages: [tarballEntry({ version: '9.9.9' })], signature: unsigned.signature })
    expect(verifyDesktopCompanyManifest(tampered, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN }))
      .toMatchObject({ ok: false, code: 'bad-signature' })
    expect(verifyDesktopCompanyManifest(valid, {
      trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(otherKey.publicKey) }],
      companyCatalogOrigin: CATALOG_ORIGIN,
    })).toMatchObject({ ok: false, code: 'key-mismatch' })
    expect(verifyDesktopCompanyManifest(valid, {
      trustRoots: [{ keyId: 'other-key', fingerprint: trustRoots[0]!.fingerprint }],
      companyCatalogOrigin: CATALOG_ORIGIN,
    })).toMatchObject({ ok: false, code: 'unknown-key' })
    expect(verifyDesktopCompanyManifest(valid, {
      trustRoots,
      companyCatalogOrigin: CATALOG_ORIGIN,
      lastSeenSequence: 43,
    })).toMatchObject({ ok: false, code: 'stale-sequence' })
    expect(verifyDesktopCompanyManifest(signedManifestText([tarballEntry()], { expiresInDays: -1 }), {
      trustRoots,
      companyCatalogOrigin: CATALOG_ORIGIN,
    })).toMatchObject({ ok: false, code: 'expired' })
    expect(verifyDesktopCompanyManifest(`${valid} `, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN }))
      .toMatchObject({ ok: false, code: 'non-canonical' })
    expect(verifyDesktopCompanyManifest('{broken', { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN }))
      .toMatchObject({ ok: false, code: 'malformed-json' })
  })

  it('decides source-free manifests exactly like the market verifier (byte-identical legacy behavior)', () => {
    const valid = signedManifestText([npmEntry()])
    const corpus: readonly [string, string][] = [
      ['valid', valid],
      ['entry unknown key', signedManifestText([npmEntry({ extra: 1 })])],
      ['non-canonical bytes', JSON.stringify(JSON.parse(valid))],
      ['bad integrity shape', signedManifestText([npmEntry({ integrity: 'sha512-nope' })])],
      ['bad bundlePatch escape', signedManifestText([npmEntry({ bundlePatch: '../escape.yml' })])],
      ['bad repository url', signedManifestText([npmEntry({ repository: { url: 'http://insecure.example/r' } })])],
      ['repository subdirectory escape', signedManifestText([npmEntry({ repository: { url: 'https://github.com/example/example-plugin', subdirectory: '../up' } })])],
      ['bad runtime range', signedManifestText([npmEntry({ runtime: { dshRuntimeVersion: 'bogus range' } })])],
      ['missing dshRuntimeVersion', signedManifestText([npmEntry({ runtime: {} })])],
      ['bad approvedBuilds entry', signedManifestText([npmEntry({ approvedBuilds: ['not valid!'] })])],
      ['duplicate treeDigest shape', signedManifestText([npmEntry({ treeDigest: 'xyz' })])],
      ['revoked non-boolean', signedManifestText([npmEntry({ revoked: 'yes' })])],
      ['bad version', signedManifestText([npmEntry({ version: '1.0.0-rc.1' })])],
    ]
    for (const [label, text] of corpus) {
      const desktop = verifyDesktopCompanyManifest(text, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN })
      const market = verifyCompanyManifest(text, { trustRoots })
      expect(desktop.ok, label).toBe(market.ok)
      if (!desktop.ok && !market.ok) {
        expect(desktop.code, label).toBe(market.code)
      }
    }
    const desktopManifest = verifyDesktopCompanyManifest(valid, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN })
    const marketManifest = verifyCompanyManifest(valid, { trustRoots })
    expect(desktopManifest.ok).toBe(true)
    expect(marketManifest.ok).toBe(true)
    if (desktopManifest.ok && marketManifest.ok) {
      // Key order is irrelevant: compare through the canonical serialization
      // both sides pin, and field by field for the verified metadata.
      expect(canonicalJsonText(desktopManifest.manifest)).toBe(canonicalJsonText(marketManifest.manifest))
      expect(desktopManifest.keyId).toBe(marketManifest.keyId)
      expect(desktopManifest.fingerprint).toBe(marketManifest.fingerprint)
    }
  })
})

// ---------------------------------------------------------------------------
// Staging: download → sha512 → controlled staging area.
// ---------------------------------------------------------------------------

describe('company market tarball staging', () => {
  it('downloads, verifies, and stages the tarball at the controlled path', async () => {
    const root = temporaryDirectory('stage-ok')
    const profileDir = join(root, 'profiles', 'web')
    const staged = await stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: requestServing(TARBALL_BYTES),
    })
    const expectedPath = join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, 'company-hardened-plugin-2.1.0.tgz')
    expect(staged.stagedPath).toBe(expectedPath)
    expect(staged.tarball).toEqual({ kind: 'market-tarball', path: expectedPath, integrity: TARBALL_INTEGRITY })
    expect(readFileSync(expectedPath)).toEqual(TARBALL_BYTES)
    if (process.platform !== 'win32') {
      expect(statSync(expectedPath).mode & 0o777).toBe(0o600)
    }
  })

  it('encodes scoped package names collision-free into the staging file name', () => {
    expect(desktopMarketTarballStagingName('@company/scoped-plugin', '0.9.0')).toBe('company+scoped-plugin-0.9.0.tgz')
    expect(() => desktopMarketTarballStagingName('Not A Name', '1.0.0')).toThrow()
    expect(() => desktopMarketTarballStagingName('plugin', '1.x.0')).toThrow()
    expect(desktopMarketTarballStagingPath('/profiles/web', '@company/scoped-plugin', '0.9.0'))
      .toBe(join('/profiles/web', DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, 'company+scoped-plugin-0.9.0.tgz'))
    expect(() => desktopMarketTarballStagingPath('relative', 'plugin', '1.0.0')).toThrow()
  })

  it('refuses a sha512 mismatch and cleans the staging location', async () => {
    const root = temporaryDirectory('stage-mismatch')
    const profileDir = join(root, 'profiles', 'web')
    // A stale staged file from an earlier attempt must not survive the refusal.
    const stalePath = desktopMarketTarballStagingPath(profileDir, 'company-hardened-plugin', '2.1.0')
    mkdirSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY), { recursive: true })
    writeFileSync(stalePath, Buffer.from('stale bytes'))
    await expect(stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: requestServing(Buffer.from('tampered bytes\n')),
    })).rejects.toThrow('does not match the signed integrity')
    expect(existsSync(stalePath)).toBe(false)
  })

  it.each([
    ['network failure', failingRequest, 'could not be downloaded'],
    ['non-200 status', requestServing(TARBALL_BYTES, 500), 'could not be downloaded'],
  ])('refuses a %s without leaving staging behind', async (_label, request, fragment) => {
    const root = temporaryDirectory('stage-failure')
    const profileDir = join(root, 'profiles', 'web')
    await expect(stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request,
    })).rejects.toThrow(fragment)
    expect(existsSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, 'company-hardened-plugin-2.1.0.tgz'))).toBe(false)
  })

  it('refuses a tarball url outside the pinned origin even when called directly', async () => {
    const root = temporaryDirectory('stage-origin')
    const profileDir = join(root, 'profiles', 'web')
    await expect(stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: 'https://evil.example/packages/x.tgz', integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: requestServing(TARBALL_BYTES),
    })).rejects.toThrow('must stay inside the pinned https catalog origin')
    await expect(stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: null },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: requestServing(TARBALL_BYTES),
    })).rejects.toThrow('requires an origin-mode catalog policy')
  })

  it('re-stages idempotently over an earlier verified staging', async () => {
    const root = temporaryDirectory('stage-retry')
    const profileDir = join(root, 'profiles', 'web')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const staged = await stageCompanyMarketTarball({
        policy: { companyCatalogOrigin: CATALOG_ORIGIN },
        source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
        packageName: 'company-hardened-plugin',
        version: '2.1.0',
        profileDir,
        request: requestServing(TARBALL_BYTES),
      })
      expect(readFileSync(staged.stagedPath)).toEqual(TARBALL_BYTES)
    }
  })
})

// ---------------------------------------------------------------------------
// pnpm controlled tarball target + red lines.
// ---------------------------------------------------------------------------

async function stagedFixture(root: string, bytes: Buffer = TARBALL_BYTES): Promise<DesktopControlledMarketTarball> {
  const profileDir = join(root, 'profiles', 'web')
  const stagedPath = desktopMarketTarballStagingPath(profileDir, 'company-hardened-plugin', '2.1.0')
  mkdirSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY), { recursive: true })
  writeFileSync(stagedPath, bytes)
  return { kind: 'market-tarball', path: stagedPath, integrity: TARBALL_INTEGRITY }
}

const installRecovery: DesktopPluginInstallRecovery = {
  packageName: 'company-hardened-plugin',
  packageVersion: '2.1.0',
  receiptId: 'receipt:company-tarball-0001',
}

describe('pnpm controlled market tarball install target', () => {
  it('installs from the staged path as a file: target with the receipt identity', async () => {
    const root = temporaryDirectory('pnpm-controlled')
    const selectedBootstrap = bootstrap(root, join(root, 'profiles', 'web'))
    mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
    writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const tarball = await stagedFixture(root)
    const child = controlledSubprocess()
    const harness = await createPnpmHarness(queuedSpawn([child]), selectedBootstrap)
    try {
      const operation = await harness.service.installPlugin({
        invokingDir: '/workspace',
        recovery: installRecovery,
        marketTarball: tarball,
        approvedBuildDependencies: ['sharp'],
      })
      const argv = harness.spawn.mock.calls[0]?.[0].argv as string[]
      expect(argv.slice(-1)[0]).toBe(`file:${tarball.path}`)
      expect(argv).toContain('add')
      expect(argv).not.toContain('company-hardened-plugin@2.1.0')
      const workspace = readFileSync(join(selectedBootstrap.activeProfileDir, 'pnpm-workspace.yaml'), 'utf8')
      expect(workspace).toContain('- sharp')
      child.resolveDone({ exitCode: 0, signal: null })
      child.resolveTree()
      await operation.done
    } finally {
      await harness.dispose()
    }
  })

  it.each([
    ['a path outside the staging area', async (root: string) => {
      const rogue = join(root, 'rogue-plugin-2.1.0.tgz')
      writeFileSync(rogue, TARBALL_BYTES)
      return { kind: 'market-tarball', path: rogue, integrity: TARBALL_INTEGRITY } as const
    }, 'may only install from the staged path'],
    ['a wrong basename inside the staging area', async (root: string) => {
      const profileDir = join(root, 'profiles', 'web')
      const staged = join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, 'renamed.tgz')
      mkdirSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY), { recursive: true })
      writeFileSync(staged, TARBALL_BYTES)
      return { kind: 'market-tarball', path: staged, integrity: TARBALL_INTEGRITY } as const
    }, 'may only install from the staged path'],
    ['staged bytes that do not match the signed integrity', async (root: string) =>
      await stagedFixture(root, Buffer.from('swapped bytes\n')), 'does not match the signed integrity'],
    ['a descriptor with an extra field', async (root: string) => ({
      ...await stagedFixture(root),
      extra: 'nope',
    }), 'must carry exactly kind, path, and integrity'],
    ['a descriptor with a malformed integrity', async (root: string) => ({
      kind: 'market-tarball',
      path: (await stagedFixture(root)).path,
      integrity: 'sha512-malformed',
    }), 'signed sha512'],
    ['a missing staged file', async (root: string) => ({
      kind: 'market-tarball',
      path: desktopMarketTarballStagingPath(join(root, 'profiles', 'web'), 'company-hardened-plugin', '2.1.0'),
      integrity: TARBALL_INTEGRITY,
    }), 'unusable'],
  ])('rejects %s before any subprocess runs', async (_label, forge, fragment) => {
    const root = temporaryDirectory('pnpm-refuse')
    const selectedBootstrap = bootstrap(root, join(root, 'profiles', 'web'))
    mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
    writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const tarball = await forge(root)
    const harness = await createPnpmHarness(queuedSpawn([]), selectedBootstrap)
    try {
      await expect(harness.service.installPlugin({
        invokingDir: '/workspace',
        recovery: installRecovery,
        marketTarball: tarball as DesktopControlledMarketTarball,
      })).rejects.toThrow(fragment)
      expect(harness.spawn).not.toHaveBeenCalled()
      expect(existsSync(selectedBootstrap.installRecoveryStatePath)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a symlink planted at the staged path', async () => {
    const root = temporaryDirectory('pnpm-symlink')
    const selectedBootstrap = bootstrap(root, join(root, 'profiles', 'web'))
    mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
    writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const target = join(root, 'outside.tgz')
    writeFileSync(target, TARBALL_BYTES)
    const stagedPath = desktopMarketTarballStagingPath(selectedBootstrap.activeProfileDir, 'company-hardened-plugin', '2.1.0')
    mkdirSync(join(selectedBootstrap.activeProfileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY), { recursive: true })
    try {
      symlinkSync(target, stagedPath)
    } catch {
      return // symlink creation unavailable on this host
    }
    const harness = await createPnpmHarness(queuedSpawn([]), selectedBootstrap)
    try {
      await expect(harness.service.installPlugin({
        invokingDir: '/workspace',
        recovery: installRecovery,
        marketTarball: { kind: 'market-tarball', path: stagedPath, integrity: TARBALL_INTEGRITY },
      })).rejects.toThrow('unusable')
      expect(harness.spawn).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('still rejects every user-argument tarball path (the CLI red line)', async () => {
    const root = temporaryDirectory('pnpm-redline')
    const selectedBootstrap = bootstrap(root, join(root, 'profiles', 'web'))
    mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
    writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), JSON.stringify({ dependencies: {} }))
    const rogue = join(root, 'rogue.tgz')
    writeFileSync(rogue, TARBALL_BYTES)
    const harness = await createPnpmHarness(queuedSpawn([]), selectedBootstrap)
    try {
      expect(() => harness.service.runPlugin(['add', rogue], '/workspace')).toThrow(
        'plugin add must use the recoverable install boundary',
      )
      await expect(harness.service.runPluginInstall(
        ['add', '--save-exact', `file:${rogue}`],
        '/workspace',
        installRecovery,
      )).rejects.toThrow('requires the exact receipt target')
      await expect(harness.service.runPluginInstall(
        ['add', '--save-exact', rogue],
        '/workspace',
        installRecovery,
      )).rejects.toThrow('requires the exact receipt target')
      await expect(harness.service.installPlugin({
        pnpmOptions: ['--save-exact', rogue],
        invokingDir: '/workspace',
        recovery: installRecovery,
      })).rejects.toThrow('install options are restricted')
      await expect(harness.service.installPlugin({
        pnpmOptions: ['--save-exact', `file:${rogue}`],
        invokingDir: '/workspace',
        recovery: installRecovery,
      })).rejects.toThrow('install options are restricted')
      expect(harness.spawn).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('keeps rejecting non-npm targets on the external market boundary', async () => {
    const root = temporaryDirectory('pnpm-external-redline')
    const harness = await createPnpmHarness(queuedSpawn([]), { ...bootstrap(root, join(root, 'profiles', 'web')), externalMarketInstallEnabled: true })
    try {
      const rogue = join(root, 'rogue.tgz')
      writeFileSync(rogue, TARBALL_BYTES)
      expect(() => harness.service.runExternalMarketPluginInstall(['add', rogue], '/workspace')).toThrow(
        'requires an exact npm package target',
      )
      expect(() => harness.service.runExternalMarketPluginInstall(['add', `file:${rogue}`], '/workspace')).toThrow(
        'requires an exact npm package target',
      )
      expect(() => harness.service.runExternalMarketPluginInstall(
        ['add', 'company-hardened-plugin@2.1.0.0'],
        '/workspace',
      )).toThrow('requires an exact npm package target')
      expect(harness.spawn).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Full tarball install chain with post-install treeDigest re-verification.
// ---------------------------------------------------------------------------

describe('company tarball install orchestration', () => {
  it('runs download → install → installed-bundle assert → signed treeDigest re-verification', async () => {
    const root = temporaryDirectory('orchestrate-ok')
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
    const selectedBootstrap = bootstrap(root, profileDir)
    const text = signedManifestText([npmEntry(), tarballEntry()])
    const verification = verifyDesktopCompanyManifest(text, { trustRoots, companyCatalogOrigin: CATALOG_ORIGIN })
    if (!verification.ok) throw new Error(`fixture manifest failed to verify: ${verification.reason}`)
    const entry = findDesktopCompanyManifestPackage(verification.manifest, 'company-hardened-plugin', '2.1.0')!
    expect(desktopCompanyEntrySource(entry).kind).toBe('tarball')
    const staged = await stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: desktopCompanyEntrySource(entry) as { kind: 'tarball'; url: string; integrity: string },
      packageName: entry.packageName,
      version: entry.version,
      profileDir,
      request: requestServing(TARBALL_BYTES),
    })
    const harness = await createPnpmHarness(
      installSimulatingSpawn(() => simulateSuccessfulPnpmTarballInstall(profileDir, entry, staged.stagedPath)),
      selectedBootstrap,
    )
    try {
      const result = await installCompanyMarketTarballPlugin({
        service: harness.service,
        entry: entry as DesktopCompanyTarballInstallEntry,
        tarball: staged.tarball,
        recovery: installRecovery,
        profileDir,
        invokingDir: profileDir,
        measureTreeRootDigest: packageDir => {
          expect(packageDir).toBe(join(profileDir, 'node_modules', 'company-hardened-plugin'))
          return TREE_DIGEST
        },
      })
      expect(result).toEqual({
        receiptId: 'receipt:company-tarball-0001',
        packageName: 'company-hardened-plugin',
        version: '2.1.0',
        treeDigest: TREE_DIGEST,
      })
      const argv = harness.spawn.mock.calls[0]?.[0].argv as string[]
      expect(argv.slice(-1)[0]).toBe(`file:${staged.stagedPath}`)
      const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
      }
      expect(profileManifest.dependencies['company-hardened-plugin']).toBe(`file:${staged.stagedPath}`)
      const recoveryState = JSON.parse(readFileSync(selectedBootstrap.installRecoveryStatePath, 'utf8')) as { phase: string }
      expect(recoveryState.phase).toBe('awaiting-restart')
    } finally {
      await harness.dispose()
    }
  })

  it('rolls the install back and refuses it when the measured tree diverges from the signed treeDigest', async () => {
    const root = temporaryDirectory('orchestrate-mismatch')
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const originalManifest = JSON.stringify({ name: 'profile', dependencies: {} })
    writeFileSync(join(profileDir, 'package.json'), originalManifest)
    const selectedBootstrap = bootstrap(root, profileDir)
    const tarball = await stagedFixture(root)
    const harness = await createPnpmHarness(
      installSimulatingSpawn(() => simulateSuccessfulPnpmTarballInstall(
        profileDir,
        { packageName: 'company-hardened-plugin', version: '2.1.0', bundlePatch: './cordis.patch.yml' },
        tarball.path,
      )),
      selectedBootstrap,
    )
    try {
      await expect(installCompanyMarketTarballPlugin({
        service: harness.service,
        entry: {
          packageName: 'company-hardened-plugin',
          version: '2.1.0',
          integrity: TARBALL_INTEGRITY,
          bundlePatch: './cordis.patch.yml',
          revoked: false,
          treeDigest: TREE_DIGEST,
        },
        tarball,
        recovery: installRecovery,
        profileDir,
        invokingDir: profileDir,
        measureTreeRootDigest: () => 'f'.repeat(64),
      })).rejects.toThrow('differ from the tree digest pinned in the signed company manifest')
      // The rollback restored the pre-install declarative profile state and
      // cleared the recovery WAL: the refused install leaves nothing behind.
      expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(originalManifest)
      expect(existsSync(selectedBootstrap.installRecoveryStatePath)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses package-manager failures without measuring the tree', async () => {
    const root = temporaryDirectory('orchestrate-failure')
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
    const selectedBootstrap = bootstrap(root, profileDir)
    const tarball = await stagedFixture(root)
    const child = controlledSubprocess()
    const harness = await createPnpmHarness(queuedSpawn([child]), selectedBootstrap)
    try {
      const pending = installCompanyMarketTarballPlugin({
        service: harness.service,
        entry: {
          packageName: 'company-hardened-plugin',
          version: '2.1.0',
          integrity: TARBALL_INTEGRITY,
          bundlePatch: './cordis.patch.yml',
          revoked: false,
          treeDigest: TREE_DIGEST,
        },
        tarball,
        recovery: installRecovery,
        profileDir,
        invokingDir: profileDir,
        measureTreeRootDigest: () => {
          throw new Error('must not be reached')
        },
      })
      child.resolveDone({ exitCode: 1, signal: null })
      child.resolveTree()
      await expect(pending).rejects.toThrow('the package manager failed installing the staged tarball')
      expect(existsSync(selectedBootstrap.installRecoveryStatePath)).toBe(false)
    } finally {
      await harness.dispose()
    }
  })

  it.each([
    ['a revoked entry', { revoked: true }, 'revoked'],
    ['an entry without a signed treeDigest', { treeDigest: undefined }, 'no signed treeDigest'],
  ])('refuses %s before anything is spawned', async (_label, overrides, fragment) => {
    const root = temporaryDirectory('orchestrate-refuse')
    const profileDir = join(root, 'profiles', 'web')
    const tarball = await stagedFixture(root)
    const harness = await createPnpmHarness(queuedSpawn([]), bootstrap(root, profileDir))
    try {
      await expect(installCompanyMarketTarballPlugin({
        service: harness.service,
        entry: {
          packageName: 'company-hardened-plugin',
          version: '2.1.0',
          integrity: TARBALL_INTEGRITY,
          bundlePatch: './cordis.patch.yml',
          revoked: false,
          treeDigest: TREE_DIGEST,
          ...overrides,
        } as DesktopCompanyTarballInstallEntry,
        tarball,
        recovery: installRecovery,
        profileDir,
        invokingDir: profileDir,
      })).rejects.toThrow(fragment)
      expect(harness.spawn).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a descriptor whose integrity diverges from the signed entry', async () => {
    const root = temporaryDirectory('orchestrate-integrity')
    const profileDir = join(root, 'profiles', 'web')
    const harness = await createPnpmHarness(queuedSpawn([]), bootstrap(root, profileDir))
    try {
      await expect(installCompanyMarketTarballPlugin({
        service: harness.service,
        entry: {
          packageName: 'company-hardened-plugin',
          version: '2.1.0',
          integrity: INTEGRITY_ALTERNATE,
          bundlePatch: './cordis.patch.yml',
          revoked: false,
          treeDigest: TREE_DIGEST,
        },
        tarball: await stagedFixture(root),
        recovery: installRecovery,
        profileDir,
        invokingDir: profileDir,
      })).rejects.toThrow('does not match the signed entry integrity')
      expect(harness.spawn).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Publishing tool: allowlist `source` validation and manifest generation.
// ---------------------------------------------------------------------------

describe('company-catalog allowlist source generation', () => {
  const origin = CATALOG_ORIGIN

  it('normalizes npm entries without adding a source key, explicitly or implicitly', async () => {
    const { validateAllowlistEntry } = await tools()
    const base = {
      packageName: 'example-company-plugin',
      version: '1.4.2',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/example-company-plugin',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    }
    for (const entry of [base, { ...base, source: { kind: 'npm' } }]) {
      const result = validateAllowlistEntry(entry, 'entry[0]', { companyCatalogOrigin: origin })
      expect(result.ok).toBe(true)
      expect(result.value).not.toHaveProperty('source')
    }
  })

  it('validates tarball sources: origin-pinned https url plus the tarball sha512', async () => {
    const { validateAllowlistEntry } = await tools()
    const entry = {
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/company-hardened-plugin',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
      treeDigest: TREE_DIGEST,
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
    }
    const result = validateAllowlistEntry(entry, 'entry[0]', { companyCatalogOrigin: origin })
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
    })
    for (const [source, options, fragment] of [
      [{ kind: 'npm', url: TARBALL_URL }, {}, 'must not carry url'],
      [{ kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY }, {}, 'requires the company catalog origin'],
      [{ kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY }, { companyCatalogOrigin: 'https://other.company.example' }, 'not the company catalog origin'],
      [{ kind: 'tarball', url: `http://${origin.slice('https://'.length)}/x.tgz`, integrity: TARBALL_INTEGRITY }, { companyCatalogOrigin: origin }, 'credential-free https'],
      [{ kind: 'tarball', url: TARBALL_URL, integrity: 'sha512-short' }, { companyCatalogOrigin: origin }, 'SHA-512'],
      [{ kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY, extra: true }, { companyCatalogOrigin: origin }, 'unknown field'],
    ] as const) {
      const rejected = validateAllowlistEntry({ ...entry, source }, 'entry[0]', options)
      expect(rejected.ok, JSON.stringify(source)).toBe(false)
      expect((rejected as { reason: string }).reason).toContain(fragment)
    }
  })

  it('signs the tarball sha512 as the entry integrity and carries source verbatim; npm entries stay key-identical', async () => {
    const { assembleUnsignedManifest } = await tools()
    const market = await import('dsh-community-market')
    const npmAllowlistEntry = {
      packageName: 'example-plugin',
      version: '1.0.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/example-plugin',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    }
    const tarballAllowlistEntry = {
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/company-hardened-plugin',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
      treeDigest: TREE_DIGEST,
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
    }
    const dists = new Map([['example-plugin@1.0.0', { integrity: `sha512-${Buffer.alloc(64, 3).toString('base64')}` }]])
    const unsigned = assembleUnsignedManifest({
      market,
      sequence: 11,
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
      entries: [tarballAllowlistEntry, npmAllowlistEntry],
      dists,
    })
    expect(unsigned.packages).toHaveLength(2)
    // Sorted by package name: company-hardened-plugin first.
    expect(unsigned.packages[0]).toEqual({
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      integrity: TARBALL_INTEGRITY,
      bundlePatch: './cordis.patch.yml',
      repository: { url: 'https://github.com/example/company-hardened-plugin' },
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
      treeDigest: TREE_DIGEST,
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
    })
    expect(unsigned.packages[1]).not.toHaveProperty('source')
    expect(unsigned.packages[1]).toMatchObject({ packageName: 'example-plugin' })
    // A tarball entry without a repository override aborts the assembly.
    expect(() => assembleUnsignedManifest({
      market,
      sequence: 11,
      expiresAt: new Date(Date.now() + 86_400_000),
      entries: [{ ...tarballAllowlistEntry, repository: undefined }],
      dists,
    })).toThrow('tarball channel')
  })

  it('round-trips a signed dual-channel manifest through the tool verifier, and the market verifier alone rejects it (fleet gate)', async () => {
    const { assembleUnsignedManifest, verifyManifestText } = await tools()
    const market = await import('dsh-community-market')
    const unsigned = assembleUnsignedManifest({
      market,
      sequence: 11,
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
      entries: [{
        packageName: 'company-hardened-plugin',
        version: '2.1.0',
        bundlePatch: './cordis.patch.yml',
        repository: 'https://github.com/example/company-hardened-plugin',
        revoked: false,
        runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
        treeDigest: TREE_DIGEST,
        source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      }],
      dists: new Map(),
    })
    const signature = createCompanyManifestSignature(
      unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
      privateKey,
      keyId,
    )
    const text = canonicalJsonText({ ...unsigned, signature })
    const fingerprint = trustRoots[0]!.fingerprint
    const verified = await verifyManifestText(market, text, { fingerprint, keyId, companyCatalogOrigin: CATALOG_ORIGIN })
    expect(verified.ok).toBe(true)
    const wrongOrigin = await verifyManifestText(market, text, { fingerprint, keyId, companyCatalogOrigin: 'https://elsewhere.example' })
    expect(wrongOrigin).toMatchObject({ ok: false, code: 'invalid-manifest' })
    // The field-unaware market verifier rejects the whole manifest — this is
    // the fleet-upgrade publication gate, not a bug.
    expect(market.verifyCompanyManifest(text, { trustRoots })).toMatchObject({ ok: false, code: 'invalid-manifest' })
    // A source-free manifest keeps verifying through both verifiers.
    const legacyText = signedManifestText([npmEntry()])
    const legacyVerified = await verifyManifestText(market, legacyText, { fingerprint, keyId })
    expect(legacyVerified.ok).toBe(true)
    expect(market.verifyCompanyManifest(legacyText, { trustRoots }).ok).toBe(true)
  })
})

// Keep the tool imports' structural types local to this spec; the modules
// themselves are plain ESM without type declarations.
