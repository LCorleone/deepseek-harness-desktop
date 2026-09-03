/**
 * P7 dual-channel company market (batch 1): source-aware manifest
 * verification, controlled tarball staging, the pnpm controlled-tarball
 * install target, post-install treeDigest re-verification, and the
 * allowlist→manifest generation of the `source` field in the publishing tool.
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  createCompanyCatalogProvider,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
  verifyCompanyManifest,
  type CompanyCatalogProviderView,
} from 'dsh-community-market'
import {
  cleanCompanyMarketStagingOrphans,
  desktopCompanyEntrySource,
  desktopCompanyManifestVerifierForMarket,
  findDesktopCompanyManifestPackage,
  installCompanyMarketTarballPlugin,
  stageCompanyMarketTarball,
  verifyDesktopCompanyManifest,
  type DesktopCompanyTarballInstallEntry,
} from '../src/desktop-market.ts'
import { readDesktopBootLockfile } from '../src/boot-verification.ts'
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
  return signedDocumentText(unsigned)
}

/** Sign an arbitrary manifest document (manifest-level corpus construction). */
function signedDocumentText(unsigned: Record<string, unknown>): string {
  const signature = createCompanyManifestSignature(
    unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
    privateKey,
    keyId,
  )
  return canonicalJsonText({ ...unsigned, signature })
}

/** Base unsigned document for manifest-level corpus cases. */
const unsignedDocument = (): Record<string, unknown> => ({
  manifestVersion: '1.0.0',
  sequence: 42,
  expiresAt: '2030-01-01T00:00:00Z',
  packages: [npmEntry()],
})

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
  validateCatalogOrigin(value: string): string
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
    ['url with an explicit port', tarballEntry({ source: { kind: 'tarball', url: 'https://gitlab.company.example:8443/packages/x.tgz', integrity: TARBALL_INTEGRITY } }), 'explicit port'],
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
      // Manifest-level cases (P7 2a review): the document-level decisions the
      // entry cases cannot reach. Non-object JSON shares the market verifier's
      // `malformed-json` code; bad `expiresAt` spellings pin the ajv-formats
      // `date-time` mirror in the desktop verifier — the space-separated
      // spelling is accepted by BOTH (ajv's full date-time splits on t/T or
      // whitespace, and V8 parses it), so the equivalence is locked in both
      // directions: neither verifier may drift wider or narrower.
      ['non-object JSON (array)', canonicalJsonText([])],
      ['non-object JSON (number)', canonicalJsonText(5)],
      ['non-object JSON (string)', canonicalJsonText('x')],
      ['unknown top-level key', signedDocumentText({ ...unsignedDocument(), futureField: 1 })],
      ['missing top-level key', signedDocumentText({
        manifestVersion: '1.0.0',
        expiresAt: '2030-01-01T00:00:00Z',
        packages: [npmEntry()],
      })],
      ['signature not an object', canonicalJsonText({ ...unsignedDocument(), signature: 5 })],
      ['signature missing value key', (() => {
        const signature = createCompanyManifestSignature(
          unsignedDocument() as unknown as Parameters<typeof createCompanyManifestSignature>[0],
          privateKey,
          keyId,
        )
        return canonicalJsonText({ ...unsignedDocument(), signature: { keyId: signature.keyId, publicKey: signature.publicKey } })
      })()],
      ['bad expiresAt (RFC-1123 spelling)', signedDocumentText({ ...unsignedDocument(), expiresAt: 'Wed, 01 Jan 2030 00:00:00 GMT' })],
      ['bad expiresAt (leap second, format-valid but unparseable)', signedDocumentText({ ...unsignedDocument(), expiresAt: '2030-12-31T23:59:60Z' })],
      ['bad expiresAt (non-string)', signedDocumentText({ ...unsignedDocument(), expiresAt: 20300101 })],
      ['space-separated expiresAt (both accept)', signedDocumentText({ ...unsignedDocument(), expiresAt: '2030-01-01 00:00:00Z' })],
      [`packages over-limit (${String(10_001)} entries)`, signedManifestText(
        Array.from({ length: 10_001 }, (_, index) => npmEntry({ packageName: `example-plugin-${String(index)}`, version: '1.0.0' })),
      )],
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
// P1 review fix: the locked market catalog provider verifies through the
// dual-channel verifier when the Desktop host injects it
// (`desktopCompanyManifestVerifierForMarket`, provided as the
// `desktopCompanyManifestVerifier` capability in main.ts). Without the
// injection the provider runs the field-unaware market verifier and a
// `source`-carrying manifest blacks out the whole market catalog scan.
// ---------------------------------------------------------------------------

const MANIFEST_URL = 'https://catalog.company.example/manifest.json'

/** Content-mode scan context: no fetch may happen. */
function contentScanContext(): Parameters<CompanyCatalogProviderView['scanCatalog']>[1] {
  return {
    signal: new AbortController().signal,
    http: {
      getJson: async () => {
        throw new Error('content mode must not fetch')
      },
    },
    source: {
      sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac130001',
      registrationKind: 'built-in',
      adapterId: 'market.company-manifest-v1',
      providerId: 'com.deepseek.company-catalog',
      builtInProviderKey: 'company-catalog',
      enabled: true,
      order: 0,
    },
  }
}

describe('market catalog provider verifier injection (P7 review fix)', () => {
  it('catalogs a source-carrying manifest through the origin-mode provider with the injected desktop verifier', async () => {
    const text = signedManifestText([npmEntry(), tarballEntry()])
    const provider = createCompanyCatalogProvider({
      companyManifestUrl: MANIFEST_URL,
      trustRoots,
      manifestVerifier: desktopCompanyManifestVerifierForMarket({ companyCatalogOrigin: CATALOG_ORIGIN }),
    })
    const context = {
      ...contentScanContext(),
      http: {
        getJson: async (url: string) => {
          expect(url).toBe(MANIFEST_URL)
          return { value: JSON.parse(text) as unknown, finalUrl: url }
        },
      },
    }

    const snapshots = await provider.scanCatalog({}, context)

    // The market UI's catalog rows light up for both channels.
    expect(snapshots.flatMap(snapshot => snapshot.items.map(item => item.id))).toEqual([
      'npm:example-plugin@1.0.0',
      'npm:company-hardened-plugin@2.1.0',
    ])
    expect(provider.verifiedPackages()).toEqual([
      expect.objectContaining({ packageName: 'example-plugin', integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}` }),
      expect.objectContaining({ packageName: 'company-hardened-plugin', integrity: TARBALL_INTEGRITY }),
    ])
    // The signed install channel rides through the provider untouched —
    // the same projection the install authority and the (future) tarball
    // orchestration consume through findSignedPackage.
    const signed = provider.findSignedPackage('company-hardened-plugin', '2.1.0')
    expect((signed as { readonly source?: unknown } | undefined)?.source)
      .toEqual({ kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY })
    expect(provider.verification()).toMatchObject({ mode: 'origin', sequence: 42, keyId })
  })

  it('catalogs an npm-source manifest through the content-mode provider with the injected desktop verifier', async () => {
    const text = signedManifestText([npmEntry({ source: { kind: 'npm' } })])
    const provider = createCompanyCatalogProvider({
      manifestContentProvider: () => text,
      trustRoots,
      // Content-mode policy: the injected verifier receives the same null
      // origin the production composition derives from the policy.
      manifestVerifier: desktopCompanyManifestVerifierForMarket({ companyCatalogOrigin: null }),
    })

    const snapshots = await provider.scanCatalog({}, contentScanContext())

    expect(snapshots.flatMap(snapshot => snapshot.items.map(item => item.id)))
      .toEqual(['npm:example-plugin@1.0.0'])
    expect(provider.verification()).toMatchObject({ mode: 'content', sequence: 42, keyId })
  })

  it('rejects a source-carrying manifest whole without the injection — the field-unaware default', async () => {
    const text = signedManifestText([tarballEntry()])
    const provider = createCompanyCatalogProvider({
      manifestContentProvider: () => text,
      trustRoots,
    })

    // The provider's fail-closed rejection (market `CompanyCatalogUntrustedError`;
    // the facade stays type-only, so the shape is asserted field by field).
    const rejection = await provider.scanCatalog({}, contentScanContext())
      .then(() => undefined, (cause: unknown) => cause)
    expect(rejection).toMatchObject({ name: 'CompanyCatalogUntrustedError', code: 'invalid-manifest' })
    expect((rejection as Error).message).toContain('company catalog is not trusted (invalid-manifest)')
    expect(provider.verifiedPackages()).toEqual([])
    expect(provider.verification()).toBeUndefined()
    // Fleet cross-validation semantics stay intact: the field-unaware market
    // verifier rejects the same manifest whole — the pinned fact the
    // publication gate's --confirm-fleet-upgraded acknowledgment rests on.
    expect(verifyCompanyManifest(text, { trustRoots }))
      .toMatchObject({ ok: false, code: 'invalid-manifest' })
  })

  it('keeps source-free provider scans identical between the default and the injected verifier', async () => {
    const text = signedManifestText([npmEntry()])
    // Fixed clock: the two scans run in sequence and must not differ by a
    // wall-clock tick — only the verifier identity differs.
    const fixedNow = Date.parse('2026-09-01T00:00:00.000Z')
    const scanWith = async (manifestVerifier?: ReturnType<typeof desktopCompanyManifestVerifierForMarket>) => {
      const provider = createCompanyCatalogProvider({
        manifestContentProvider: () => text,
        trustRoots,
        now: () => fixedNow,
        ...(manifestVerifier === undefined ? {} : { manifestVerifier }),
      })
      await provider.scanCatalog({}, contentScanContext())
      return provider
    }
    const [plain, injected] = await Promise.all([
      scanWith(),
      scanWith(desktopCompanyManifestVerifierForMarket({ companyCatalogOrigin: CATALOG_ORIGIN })),
    ])
    expect(injected.verification()).toEqual(plain.verification())
    expect(injected.verifiedPackages()).toEqual(plain.verifiedPackages())
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

  it('refuses timeout bounds beyond the AbortSignal 32-bit range before any download starts', async () => {
    const root = temporaryDirectory('stage-timeout-bound')
    const profileDir = join(root, 'profiles', 'web')
    const options = {
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball' as const, url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: requestServing(TARBALL_BYTES),
    }
    // 2^31 ms and beyond do not throw inside `AbortSignal.timeout` — Node
    // fires the timer after ~1 ms with a `TimeoutOverflowWarning`, so a live
    // download would die mid-flight with a misleading "exceeded N ms" error.
    // The staging step must refuse the bound up front instead.
    await expect(stageCompanyMarketTarball({ ...options, timeoutMs: 2_147_483_648 }))
      .rejects.toThrow('must be a safe positive millisecond bound of at most 2147483647')
    await expect(stageCompanyMarketTarball({ ...options, timeoutMs: 2 ** 53 }))
      .rejects.toThrow(TypeError)
    // The boundary itself is accepted (validation only; the stub answers at once).
    const staged = await stageCompanyMarketTarball({ ...options, timeoutMs: 2_147_483_647 })
    expect(readFileSync(staged.stagedPath)).toEqual(TARBALL_BYTES)
  })

  it('bounds a hanging download with the whole-request timeout and cleans the staging location', async () => {
    const root = temporaryDirectory('stage-timeout')
    const profileDir = join(root, 'profiles', 'web')
    const stagedPath = desktopMarketTarballStagingPath(profileDir, 'company-hardened-plugin', '2.1.0')
    // A leftover that no longer matches the signed sha512 must not survive
    // the timeout refusal either, and no `.tmp` sibling may be left behind.
    mkdirSync(dirname(stagedPath), { recursive: true })
    writeFileSync(stagedPath, Buffer.from('stale bytes'))
    const neverCompletes = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })
    await expect(stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: neverCompletes,
      timeoutMs: 25,
    })).rejects.toThrow('exceeded the 25 ms whole-request download bound')
    expect(existsSync(stagedPath)).toBe(false)
    expect(readdirSync(dirname(stagedPath))).toEqual([])
  })

  it('rethrows a caller abort through the composed signal while the keepalive keeps verified staging', async () => {
    const root = temporaryDirectory('stage-abort')
    const profileDir = join(root, 'profiles', 'web')
    const stagedPath = desktopMarketTarballStagingPath(profileDir, 'company-hardened-plugin', '2.1.0')
    mkdirSync(dirname(stagedPath), { recursive: true })
    writeFileSync(stagedPath, TARBALL_BYTES)
    const controller = new AbortController()
    const neverCompletes = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })
    const pending = stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: neverCompletes,
      timeoutMs: 120_000,
      signal: controller.signal,
    })
    controller.abort(new Error('user canceled'))
    await expect(pending).rejects.toThrow('user canceled')
    // The still-verified staged bytes survive the abort.
    expect(readFileSync(stagedPath)).toEqual(TARBALL_BYTES)
  })

  it('keeps the installed, lockfile-referenced staged tarball when a re-staging attempt fails', async () => {
    const root = temporaryDirectory('stage-keepalive')
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
    const stageOptions = {
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball' as const, url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
    }
    const staged = await stageCompanyMarketTarball({ ...stageOptions, request: requestServing(TARBALL_BYTES) })
    // What a successful install leaves behind: a profile whose lockfile
    // resolves the plugin against the staged `file:` tarball.
    simulateSuccessfulPnpmTarballInstall(
      profileDir,
      { packageName: 'company-hardened-plugin', version: '2.1.0', bundlePatch: './cordis.patch.yml' },
      staged.stagedPath,
    )
    // A network failure mid re-staging must not strand that lockfile.
    await expect(stageCompanyMarketTarball({ ...stageOptions, request: failingRequest }))
      .rejects.toThrow('could not be downloaded')
    expect(readFileSync(staged.stagedPath)).toEqual(TARBALL_BYTES)
    // Freshly downloaded bytes that fail the signed sha512 keep it too: the
    // old bytes still hash to the signed integrity, so they are exactly
    // what a successful staging would have written.
    await expect(stageCompanyMarketTarball({ ...stageOptions, request: requestServing(Buffer.from('tampered bytes\n')) }))
      .rejects.toThrow('does not match the signed integrity')
    expect(readFileSync(staged.stagedPath)).toEqual(TARBALL_BYTES)
    // The lockfile still parses and still resolves the plugin against the
    // staged file — the profile remains installable/repairable as-is.
    const lockfile = readDesktopBootLockfile(profileDir)
    expect(lockfile).toBeDefined()
    const importer = (lockfile?.importers as Record<string, unknown> | undefined)?.['.'] as
      { dependencies?: Record<string, { specifier?: unknown }> } | undefined
    expect(importer?.dependencies?.['company-hardened-plugin']?.specifier).toBe(`file:${staged.stagedPath}`)
  })
})

describe('staged tarball directory GC', () => {
  it('keeps the lockfile-referenced version and removes only same-package orphans', async () => {
    const root = temporaryDirectory('gc-orphans')
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
    const staged = await stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: requestServing(TARBALL_BYTES),
    })
    simulateSuccessfulPnpmTarballInstall(
      profileDir,
      { packageName: 'company-hardened-plugin', version: '2.1.0', bundlePatch: './cordis.patch.yml' },
      staged.stagedPath,
    )
    const stagingDirectory = join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY)
    const superseded = join(stagingDirectory, 'company-hardened-plugin-2.0.0.tgz')
    writeFileSync(superseded, Buffer.from('superseded bytes'))
    // A different package whose staging name shares the prefix stays: its
    // lifecycle belongs to its own lockfile reference, not this package's GC.
    const otherPackage = join(stagingDirectory, 'company-hardened-plugin-extra-1.0.0.tgz')
    writeFileSync(otherPackage, Buffer.from('another package entirely'))
    const removed = await cleanCompanyMarketStagingOrphans(profileDir, 'company-hardened-plugin')
    expect(removed).toEqual([superseded])
    expect(existsSync(superseded)).toBe(false)
    expect(readFileSync(staged.stagedPath)).toEqual(TARBALL_BYTES)
    expect(existsSync(otherPackage)).toBe(true)
  })

  it('keeps everything when the lockfile does not reference the package', async () => {
    const root = temporaryDirectory('gc-unreferenced')
    const profileDir = join(root, 'profiles', 'web')
    const stagingDirectory = join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY)
    mkdirSync(stagingDirectory, { recursive: true })
    const staged = join(stagingDirectory, 'company-hardened-plugin-2.1.0.tgz')
    writeFileSync(staged, TARBALL_BYTES)
    const removed = await cleanCompanyMarketStagingOrphans(profileDir, 'company-hardened-plugin')
    expect(removed).toEqual([])
    expect(existsSync(staged)).toBe(true)
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
      await stagedFixture(root, Buffer.from('swapped bytes\n')), 'does not match its pinned integrity'],
    ['a descriptor with an extra field', async (root: string) => ({
      ...await stagedFixture(root),
      extra: 'nope',
    }), 'must carry exactly kind, path, and integrity'],
    ['a descriptor with a malformed integrity', async (root: string) => ({
      kind: 'market-tarball',
      path: (await stagedFixture(root)).path,
      integrity: 'sha512-malformed',
    }), 'well-formed sha512'],
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
      // A superseded staged version of the same package: the successful
      // install's GC sweep must collect it once the lockfile references
      // exactly the installed version.
      const superseded = join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, 'company-hardened-plugin-2.0.0.tgz')
      writeFileSync(superseded, Buffer.from('superseded bytes'))
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
      expect(existsSync(superseded)).toBe(false)
      expect(readFileSync(staged.stagedPath)).toEqual(TARBALL_BYTES)
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

  it('aligns the catalog-origin grammar with the manifest schema: no explicit ports, clear reason', async () => {
    const { validateCatalogOrigin } = await tools()
    expect(validateCatalogOrigin(CATALOG_ORIGIN)).toBe(CATALOG_ORIGIN)
    for (const ported of ['https://gitlab.company.example:8443', 'https://gitlab.company.example:443']) {
      expect(() => validateCatalogOrigin(ported), ported).toThrow(/must not carry a port/)
      try {
        validateCatalogOrigin(ported)
        throw new Error('expected a rejection')
      } catch (error) {
        // The error must explain the cross-check that makes ports
        // unverifiable, not just state the rule.
        expect((error as Error).message).toContain('source and repository urls')
      }
    }
    expect(() => validateCatalogOrigin('http://gitlab.company.example')).toThrow(/bare https origin/)
    expect(() => validateCatalogOrigin('https://gitlab.company.example/path')).toThrow(/bare https origin/)
  })

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
      [{ kind: 'tarball', url: `${origin}:8443/x.tgz`, integrity: TARBALL_INTEGRITY }, { companyCatalogOrigin: origin }, 'explicit port'],
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

// ---------------------------------------------------------------------------
// Composition invariance: who may construct a marketTarball descriptor, and
// where the signature binding happens. Locked as a structural source test
// because the property is cross-module (pnpm.ts validates the descriptor's
// own claims; desktop-market.ts constructs it and binds it to the signed
// entry) — a runtime unit on one module cannot see the whole arrangement.
// ---------------------------------------------------------------------------

describe('composition invariance: the controlled marketTarball descriptor', () => {
  const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  // A construction is an object-literal property `kind: 'market-tarball'`
  // in any quote style (single, double, template), plus the computed-key
  // spelling `{['kind']: 'market-tarball'}`; the pnpm.ts interface's
  // `readonly kind:` declaration is the one sanctioned non-construction
  // spelling, and `=== 'market-tarball'` comparisons carry no colon.
  const constructionPattern = /(?<!readonly )kind\s*:\s*(['"`])market-tarball\1/gu
  const computedConstructionPattern = /\[\s*(['"`]?)kind\1\s*\]\s*:\s*(['"`])market-tarball\2/gu

  /** Recursive TypeScript source list under src/ (subdirectories included). */
  function sourceFiles(directory: string, collected: string[] = []): string[] {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) sourceFiles(path, collected)
      else if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(path)
    }
    return collected
  }

  it('is constructed in exactly one production site — the staging step — which stamps the signed source integrity', () => {
    // The scan covers every TypeScript source under src/, not just the top
    // level: the property is cross-module, so a construction hidden in a
    // nested module (client/, native-ui/, cli-lock/, policy/) is just as
    // real. Statically invisible spellings — variable-named computed keys,
    // spreads of foreign objects, runtime-built strings — cannot be caught
    // by a source scan at all; they are covered by the layered runtime
    // backstops: the pnpm boundary re-validates every descriptor claim
    // (integrity shape, deterministic staging path, re-hash of the staged
    // bytes against the descriptor's own integrity) and the install
    // orchestration re-binds the descriptor integrity to the signed entry
    // before anything is spawned.
    const files = sourceFiles(sourceDirectory)
    expect(files.length).toBeGreaterThan(100)
    const sites: string[] = []
    for (const path of files) {
      const text = readFileSync(path, 'utf8')
      for (const _match of text.matchAll(constructionPattern)) sites.push(relative(sourceDirectory, path))
      for (const _match of text.matchAll(computedConstructionPattern)) sites.push(relative(sourceDirectory, path))
    }
    expect(sites).toEqual(['desktop-market.ts'])
    const desktopMarket = readFileSync(join(sourceDirectory, 'desktop-market.ts'), 'utf8')
    const stagingBody = bodyOf(desktopMarket, 'export async function stageCompanyMarketTarball')
    expect([...stagingBody.matchAll(constructionPattern)]).toHaveLength(1)
    // The single construction stamps the SIGNED tarball sha512 — not caller
    // bytes, not a re-measured digest — so the descriptor's integrity claim
    // is the manifest entry's `source.integrity` by construction.
    expect(stagingBody).toContain("kind: 'market-tarball'")
    expect(stagingBody).toContain('integrity: options.source.integrity')
  })

  it('binds the descriptor to the signed entry inside the install orchestration, before anything is spawned', () => {
    const desktopMarket = readFileSync(join(sourceDirectory, 'desktop-market.ts'), 'utf8')
    const orchestration = bodyOf(desktopMarket, 'export async function installCompanyMarketTarballPlugin')
    // The binding check: descriptor integrity must equal the signed
    // `entry.integrity`, refusing the install before the service is called.
    expect(orchestration).toContain('request.tarball.integrity !== entry.integrity')
    expect(orchestration).toContain('does not match the signed entry integrity')
    const serviceCallIndex = orchestration.indexOf('request.service.installPlugin')
    const bindingIndex = orchestration.indexOf('request.tarball.integrity !== entry.integrity')
    expect(serviceCallIndex).toBeGreaterThan(0)
    expect(bindingIndex).toBeGreaterThan(-1)
    expect(bindingIndex).toBeLessThan(serviceCallIndex)
  })

  it('keeps the pnpm boundary validating the descriptor itself, never a signature', () => {
    const pnpm = readFileSync(join(sourceDirectory, 'pnpm.ts'), 'utf8')
    const boundary = bodyOf(pnpm, 'private async assertControlledMarketTarball')
    // The boundary's comparisons are against the descriptor's own integrity
    // claim and the deterministic staging path — the words that would claim
    // signature authority at this layer must not appear in its checks.
    expect(boundary).toContain('tarball.integrity.slice')
    expect(boundary).toContain('desktopMarketTarballStagingPath')
    expect(boundary).not.toContain('entry.integrity')
    // And it constructs nothing: no construction spelling (any quote style,
    // computed keys included) exists outside desktop-market.ts — the
    // interface declaration (`readonly kind:`) is excluded by the pattern.
    expect([...pnpm.matchAll(constructionPattern)]).toHaveLength(0)
    expect([...pnpm.matchAll(computedConstructionPattern)]).toHaveLength(0)
  })
})

/** Slice one top-level `export … function name(…)` body out of a module's text. */
function bodyOf(text: string, signatureStart: string): string {
  const start = text.indexOf(signatureStart)
  expect(start, `signature not found: ${signatureStart}`).toBeGreaterThan(-1)
  const end = text.indexOf('\nexport ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

// Keep the tool imports' structural types local to this spec; the modules
// themselves are plain ESM without type declarations.
