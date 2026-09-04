/**
 * P7 batch 2c: the market UI's real install route wired onto the tarball
 * channel. The community-market plugin is composed exactly like the Electron
 * host composes it (capabilities provided by the launcher), with the real
 * DesktopPnpmService under it and the real desktop channel in between; the
 * package-manager child is a controlled double that mutates the profile like
 * a real `dsh plugin add file:<tarball>`. Everything else — the market's
 * preview/execute flow, the signed-manifest authority, the controlled staging
 * download and sha512 gate, the install orchestration's bundle and tree
 * re-verification, the `file:` lockfile pin, the receipt, and boot
 * re-verification over the same signed manifest — runs for real.
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import { createDesktopCompanyMarketTarballInstallChannel } from '../src/company-market-install.ts'
import { desktopCompanyManifestVerifierForMarket } from '../src/desktop-market.ts'
import {
  collectDesktopBootBundles,
  computeDesktopBootTreeRootDigest,
  readDesktopBootLockfile,
  verifyDesktopBootBundles,
} from '../src/boot-verification.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'
import {
  apply as applyDesktopPnpm,
  desktopMarketTarballStagingPath,
  inject as desktopPnpmInject,
  name as desktopPnpmName,
  DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY,
  type DesktopPnpm,
  type DesktopPnpmBootstrap,
} from '../src/pnpm.ts'

/** The real market host plugin, imported by URL exactly like market-pnpm-integration.spec.ts. */
interface CommunityMarketModule {
  readonly name: string
  readonly inject: string[]
  readonly apply: (ctx: import('@deepseek-ai/cordis').Context) => void
  readonly marketRoutes: {
    readonly installable: string
    readonly operationPreview: string
    readonly operationExecute: string
  }
}

const market: CommunityMarketModule = await import(
  new URL('../../dsh-community-market/src/index.js', import.meta.url).href
) as CommunityMarketModule

// ---------------------------------------------------------------------------
// Fixtures: signing, policy, manifest, tarball bytes.
// ---------------------------------------------------------------------------

const keyId = 'company-catalog-selftest'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trustRoots = [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }]
const CATALOG_ORIGIN = 'https://gitlab.company.example'
const MANIFEST_URL = `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`
const PACKAGE_NAME = 'company-hardened-plugin'
const PACKAGE_VERSION = '2.1.0'

const policy = parseDesktopPolicy({
  locked: true,
  managedModels: false,
  requireSso: false,
  companyCatalogOrigin: CATALOG_ORIGIN,
  companyManifestUrl: MANIFEST_URL,
  allowHomePatch: false,
  allowManualPluginAdd: false,
  trustRoots,
  usageReport: false,
  agentBrowser: { enabled: false, allowOrigins: [], allowPersistLogin: false },
})

const TARBALL_BYTES = Buffer.from('company-hardened-plugin tarball fixture\n', 'utf8')
const TARBALL_INTEGRITY = `sha512-${createHash('sha512').update(TARBALL_BYTES).digest('base64')}`
const TARBALL_URL = `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/packages/${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`

const BUNDLE_PATCH = './cordis.patch.yml'

/** The exact installed-package tree a real tarball install materializes. */
function writeInstalledPackage(packageDir: string): void {
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    dsh: { bundle: { patch: BUNDLE_PATCH } },
  })}\n`)
  writeFileSync(join(packageDir, 'cordis.patch.yml'), '[]\n')
}

// The signed treeDigest is the real measurement of the deterministic
// installed tree, so boot verification's authority check compares real
// digests end to end.
const TREE_DIGEST = (() => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-company-tree-digest-'))
  try {
    writeInstalledPackage(scratch)
    return computeDesktopBootTreeRootDigest(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})()

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
    packageName: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    integrity: TARBALL_INTEGRITY,
    repository: { url: 'https://github.com/example/company-hardened-plugin' },
    treeDigest: TREE_DIGEST,
    source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
    ...overrides,
  })
}

/** Sign fixture manifest bytes with the test key. */
function signedManifestText(
  packages: readonly Record<string, unknown>[] = [tarballEntry()],
  sequence = 42,
): string {
  const unsigned = {
    manifestVersion: '1.0.0',
    sequence,
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    packages,
  }
  return canonicalJsonText({
    ...unsigned,
    signature: createCompanyManifestSignature(
      unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
      privateKey,
      keyId,
    ),
  })
}

const roots: string[] = []
function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-company-install-${label}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Manifest/tarball serving doubles — fully offline, no sockets. */
function servingDoubles(manifestText: string, tarballBytes: Buffer) {
  return {
    fetchManifestText: vi.fn(async () => manifestText),
    request: vi.fn(async (url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if (url === TARBALL_URL) {
        return new Response(new Uint8Array(tarballBytes), {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        })
      }
      return new Response('not found', { status: 404 })
    }),
  }
}

// ---------------------------------------------------------------------------
// pnpm harness (the tests/pnpm.spec.ts shape over a controlled subprocess).
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
    generationId: 'company-install-generation-0001',
    externalMarketInstallEnabled: false,
  }
}

/** What a real `dsh plugin add file:<tarball>` leaves behind (the pnpm 11 lockfile spelling included). */
function simulateSuccessfulTarballInstall(profileDir: string, stagedPath: string): void {
  writeInstalledPackage(join(profileDir, 'node_modules', PACKAGE_NAME))
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as Record<string, unknown>
  manifest.dependencies = { ...(manifest.dependencies as Record<string, string> ?? {}), [PACKAGE_NAME]: `file:${stagedPath}` }
  manifest.dsh = { profile: { bundles: [PACKAGE_NAME] } }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest))
  const relativeStaged = stagedPath.slice(profileDir.length + 1)
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
    lockfileVersion: '9.0',
    importers: {
      '.': {
        dependencies: {
          [PACKAGE_NAME]: { specifier: `file:${stagedPath}`, version: `file:${relativeStaged}` },
        },
      },
    },
    packages: {
      [`${PACKAGE_NAME}@file:${relativeStaged}`]: {
        resolution: { integrity: TARBALL_INTEGRITY, tarball: `file:${relativeStaged}` },
        version: PACKAGE_VERSION,
      },
    },
    snapshots: { [`${PACKAGE_NAME}@file:${relativeStaged}`]: {} },
  }))
}

type SpawnMock = ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>>

/** Spawn double whose child mutates the profile exactly like the real add, then exits zero. */
function installSimulatingSpawn(effect: () => void): SpawnMock {
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

/** A spawn mock resolving zero without touching anything (the npm target double). */
function idleSpawn(): SpawnMock {
  return vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => {
    const child = controlledSubprocess()
    void Promise.resolve().then(() => {
      child.resolveDone({ exitCode: 0, signal: null })
      child.resolveTree()
    })
    return child
  })
}

// ---------------------------------------------------------------------------
// Loopback web server double (the market-pnpm-integration.spec.ts shape).
// ---------------------------------------------------------------------------

async function createWebServer() {
  type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  const handlers = new Map<string, Handler>()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const handler = handlers.get(path)
    if (handler === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.writableEnded) {
        response.statusCode = 500
        response.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture web server did not bind TCP')
  const origin = `http://127.0.0.1:${address.port}`
  return {
    service: {
      port: address.port,
      register(route: { path: string; handler: Handler }) {
        handlers.set(route.path, route.handler)
        return () => { handlers.delete(route.path) }
      },
    },
    async post(path: string, body: unknown) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    async get(path: string) {
      const response = await fetch(`${origin}${path}`, {
        headers: { origin, 'sec-fetch-site': 'same-origin' },
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close(error => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

// ---------------------------------------------------------------------------
// The full composition: market plugin + pnpm service + channel, like main.ts.
// ---------------------------------------------------------------------------

interface CompositionOptions {
  readonly manifestText: string
  readonly tarballBytes?: Buffer
  readonly spawn: SpawnMock
  readonly withChannel?: boolean
}

interface Composition {
  installable(): Promise<{ status: number; body: Record<string, unknown> }>
  preview(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  execute(body: unknown): Promise<{ status: number; body: Record<string, unknown> }>
  spawn: SpawnMock
  service: DesktopPnpm
  dispose(): Promise<void>
}

async function composeMarketDesktop(root: string, options: CompositionOptions): Promise<Composition> {
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
  const selectedBootstrap = bootstrap(root, profileDir)
  const webServer = await createWebServer()
  const settingsPath = join(root, 'settings.yaml')
  const doubles = servingDoubles(options.manifestText, options.tarballBytes ?? TARBALL_BYTES)
  const ctx = new Context()
  ctx.provide('webServer', webServer.service as never)
  ctx.provide('desktopProfiles', { current: { name: 'web', dir: profileDir } })
  ctx.provide('desktopPnpmBootstrap', selectedBootstrap)
  ctx.provide('subprocess', { spawn: options.spawn } as unknown as SubprocessRuntime)
  ctx.provide('desktopPolicy', {
    locked: true,
    trustRoots: policy.trustRoots,
    companyCatalogOrigin: CATALOG_ORIGIN,
    companyManifestUrl: MANIFEST_URL,
  })
  ctx.provide('desktopCompanyManifestVerifier', desktopCompanyManifestVerifierForMarket(policy))
  // The origin-mode catalog client serves the same manifest bytes the channel
  // fetches — one signed document behind every consumer.
  ctx.provide('desktopCompanyCatalogHttp', {
    getJson: async (url: string) => ({ value: JSON.parse(options.manifestText) as unknown, finalUrl: url }),
  })
  ctx.provide('desktopPlugins', { list: () => [], disabledPackageNames: () => [] })
  if (options.withChannel !== false) {
    const channel = createDesktopCompanyMarketTarballInstallChannel({
      policy,
      profileDir,
      fetchManifestText: doubles.fetchManifestText,
      request: doubles.request,
    })
    ctx.provide('desktopMarketTarballEntryVerifier', channel)
    ctx.provide('desktopCompanyMarketTarballInstall', channel)
  }
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  await ctx.plugin({ name: desktopPnpmName, inject: desktopPnpmInject, apply: applyDesktopPnpm })
  await ctx.plugin({ name: market.name, inject: market.inject, apply: market.apply })
  const service = ctx.get('desktopPnpm')
  if (service === undefined) throw new Error('desktop pnpm service did not mount')
  return {
    service: service as DesktopPnpm,
    spawn: options.spawn,
    installable: () => webServer.get(`${market.marketRoutes.installable}?refresh=1`),
    preview: body => webServer.post(market.marketRoutes.operationPreview, body),
    execute: body => webServer.post(market.marketRoutes.operationExecute, body),
    dispose: async () => {
      await ctx.fiber.dispose()
      await webServer.close()
    },
  }
}

/** The locked company source's fixed record id (the market synthesizes it, never user-created). */
const COMPANY_SOURCE_ID = '018f1f77-a5c4-7b73-a9ae-0242ac130001'
const ITEM_ID = `npm:${PACKAGE_NAME}@${PACKAGE_VERSION}`

describe('market UI tarball install orchestration (P7 2c)', () => {
  it('runs manifest scan → preview → controlled tarball install → file: pin → boot re-verification', async () => {
    const root = temporaryDirectory('full-chain')
    const profileDir = join(root, 'profiles', 'web')
    const stagedPath = desktopMarketTarballStagingPath(profileDir, PACKAGE_NAME, PACKAGE_VERSION)
    const manifestText = signedManifestText()
    // A superseded staged version: the verified install's GC must collect it.
    mkdirSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY), { recursive: true })
    writeFileSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, `${PACKAGE_NAME}-2.0.0.tgz`), 'superseded')
    const composition = await composeMarketDesktop(root, {
      manifestText,
      spawn: installSimulatingSpawn(() => { simulateSuccessfulTarballInstall(profileDir, stagedPath) }),
    })
    try {
      // 1. The catalog scan lights up the tarball entry as an installable row.
      const installable = await composition.installable()
      expect(installable.status).toBe(200)
      expect((installable.body as { items?: Array<{ id?: string }> }).items?.map(item => item.id)).toEqual([ITEM_ID])

      // 2. Preview through the injected verifier: the signed tarball facts,
      // never a registry resolution.
      const preview = await composition.preview({ action: 'install', sourceRecordId: COMPANY_SOURCE_ID, itemId: ITEM_ID })
      expect(preview.status).toBe(200)
      expect(preview.body).toMatchObject({ action: 'install', packageName: PACKAGE_NAME, version: PACKAGE_VERSION })

      // 3. Execute installs through the controlled channel: the spawned
      // target is the staged tarball's file: path, never an npm spec.
      const executed = await composition.execute({ previewId: preview.body.previewId })
      expect(executed.status).toBe(200)
      const receipt = (executed.body as { receipt?: Record<string, unknown> }).receipt
      expect(receipt).toMatchObject({
        packageName: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        integrity: TARBALL_INTEGRITY,
        manifestSequence: 42,
        resolved: { registryIntegrity: TARBALL_INTEGRITY },
      })
      const argv = composition.spawn.mock.calls[0]?.[0].argv as string[]
      expect(argv.slice(-1)[0]).toBe(`file:${stagedPath}`)
      expect(readFileSync(stagedPath)).toEqual(TARBALL_BYTES)
      expect(existsSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY, `${PACKAGE_NAME}-2.0.0.tgz`))).toBe(false)
      const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
      }
      expect(profileManifest.dependencies[PACKAGE_NAME]).toBe(`file:${stagedPath}`)

      // 4. Boot re-verification over the same signed manifest: the file: pin
      // resolves the lock integrity (staged file present, sha512 intact) and
      // the signed tree digest anchors the installed tree.
      const lockfile = readDesktopBootLockfile(profileDir)
      expect(lockfile).toBeDefined()
      const bundles = collectDesktopBootBundles(profileDir, [PACKAGE_NAME])
      expect(bundles[0]?.lockIntegrity).toBe(TARBALL_INTEGRITY)
      expect(bundles[0]?.lockProblem).toBeUndefined()
      const verdict = verifyDesktopBootBundles(manifestText, bundles, {
        trustRoots: policy.trustRoots,
        companyCatalogOrigin: CATALOG_ORIGIN,
      })
      expect(verdict.rejected).toEqual([])
      expect(verdict.allowed).toEqual([
        { packageName: PACKAGE_NAME, evidence: 'signed-tree', manifestSequence: 42, keyId },
      ])
    } finally {
      await composition.dispose()
    }
  })

  it('surfaces a readable error and leaves the profile untouched when the download fails the signed sha512', async () => {
    const root = temporaryDirectory('sha-mismatch')
    const profileDir = join(root, 'profiles', 'web')
    const composition = await composeMarketDesktop(root, {
      manifestText: signedManifestText(),
      // The origin serves different bytes than the manifest signed.
      tarballBytes: Buffer.from('tampered bytes\n'),
      spawn: idleSpawn(),
    })
    const originalManifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    try {
      await expect(composition.installable()).resolves.toMatchObject({ status: 200 })
      const preview = await composition.preview({ action: 'install', sourceRecordId: COMPANY_SOURCE_ID, itemId: ITEM_ID })
      expect(preview.status).toBe(200)
      const executed = await composition.execute({ previewId: preview.body.previewId })
      expect(executed.status).toBe(502)
      expect(executed.body).toMatchObject({ code: 'operation-failed' })
      expect((executed.body as { error?: string }).error).toContain('does not match the signed integrity')
      // Nothing changed: no staged file, no dependency, no spawn, no receipt.
      expect(composition.spawn).not.toHaveBeenCalled()
      expect(existsSync(join(profileDir, DESKTOP_MARKET_TARBALL_STAGING_DIRECTORY))).toBe(false)
      expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(originalManifest)
      expect(await composition.service.recoveredInstallReceiptIds()).toEqual([])
    } finally {
      await composition.dispose()
    }
  })

  it('rolls the install back and surfaces the readable reason when the installed tree diverges from the signed treeDigest', async () => {
    const root = temporaryDirectory('tree-mismatch')
    const profileDir = join(root, 'profiles', 'web')
    const stagedPath = desktopMarketTarballStagingPath(profileDir, PACKAGE_NAME, PACKAGE_VERSION)
    // A signed entry whose treeDigest is the measurement of *different*
    // content: the deterministic installed tree can never match it.
    const divergingScratch = join(root, 'diverging')
    writeInstalledPackage(divergingScratch)
    writeFileSync(join(divergingScratch, 'extra-divergence.txt'), 'divergence\n')
    const manifestText = signedManifestText([tarballEntry({
      treeDigest: computeDesktopBootTreeRootDigest(divergingScratch),
    })])
    const composition = await composeMarketDesktop(root, {
      manifestText,
      spawn: installSimulatingSpawn(() => { simulateSuccessfulTarballInstall(profileDir, stagedPath) }),
    })
    const originalManifest = readFileSync(join(profileDir, 'package.json'), 'utf8')
    try {
      await expect(composition.installable()).resolves.toMatchObject({ status: 200 })
      const preview = await composition.preview({ action: 'install', sourceRecordId: COMPANY_SOURCE_ID, itemId: ITEM_ID })
      expect(preview.status).toBe(200)
      const executed = await composition.execute({ previewId: preview.body.previewId })
      expect(executed.status).toBe(502)
      expect((executed.body as { error?: string }).error ?? '').toContain('differ from the tree digest pinned in the signed company manifest')
      // The rollback restored the profile and left no receipt.
      expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(originalManifest)
      expect(await composition.service.recoveredInstallReceiptIds()).toEqual([])
    } finally {
      await composition.dispose()
    }
  })

  it('uninstalls the tarball plugin through the standard market flow and clears its receipt', async () => {
    const root = temporaryDirectory('uninstall')
    const profileDir = join(root, 'profiles', 'web')
    const stagedPath = desktopMarketTarballStagingPath(profileDir, PACKAGE_NAME, PACKAGE_VERSION)
    const manifestText = signedManifestText()
    const composition = await composeMarketDesktop(root, {
      manifestText,
      spawn: installSimulatingSpawn(() => { simulateSuccessfulTarballInstall(profileDir, stagedPath) }),
    })
    try {
      await expect(composition.installable()).resolves.toMatchObject({ status: 200 })
      const preview = await composition.preview({ action: 'install', sourceRecordId: COMPANY_SOURCE_ID, itemId: ITEM_ID })
      const installed = await composition.execute({ previewId: preview.body.previewId })
      expect(installed.status).toBe(200)
      const receiptId = (installed.body as { receipt?: { receiptId?: string } }).receipt?.receiptId
      expect(typeof receiptId).toBe('string')
      expect(readFileSync(join(root, 'settings.yaml'), 'utf8')).toContain(receiptId!)

      // Uninstall reconciles the file: pin like any installed bundle and
      // runs the standard remove flow.
      const uninstallPreview = await composition.preview({ action: 'uninstall', receiptId })
      expect(uninstallPreview.status).toBe(200)
      expect(uninstallPreview.body).toMatchObject({ action: 'uninstall', packageName: PACKAGE_NAME })
      // The remove child drops the file: dependency and its lockfile record
      // when it runs (what a real `dsh plugin remove` does).
      composition.spawn.mockImplementation(() => {
        const removeChild = controlledSubprocess()
        void Promise.resolve().then(() => {
          rmSync(join(profileDir, 'node_modules', PACKAGE_NAME), { recursive: true, force: true })
          writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
          writeFileSync(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
            lockfileVersion: '9.0',
            importers: { '.': {} },
            packages: {},
            snapshots: {},
          }))
          removeChild.resolveDone({ exitCode: 0, signal: null })
          removeChild.resolveTree()
        })
        return removeChild
      })
      const uninstalled = await composition.execute({ previewId: uninstallPreview.body.previewId })
      expect(uninstalled.status).toBe(200)
      expect(uninstalled.body).toMatchObject({ action: 'uninstall', packageName: PACKAGE_NAME })
      expect(readFileSync(join(root, 'settings.yaml'), 'utf8')).not.toContain(receiptId!)
    } finally {
      await composition.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// npm-channel regression: the install request stays byte-identical.
// ---------------------------------------------------------------------------

async function pnpmHarness(
  root: string,
  spawn: SpawnMock,
  withChannel: { readonly manifestText: string } | undefined,
): Promise<{ service: DesktopPnpm; spawn: SpawnMock; dispose(): Promise<void> }> {
  const profileDir = join(root, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
  const ctx = new Context()
  ctx.provide('desktopPnpmBootstrap', bootstrap(root, profileDir))
  ctx.provide('subprocess', { spawn } as unknown as SubprocessRuntime)
  if (withChannel !== undefined) {
    const doubles = servingDoubles(withChannel.manifestText, TARBALL_BYTES)
    const channel = createDesktopCompanyMarketTarballInstallChannel({
      policy,
      profileDir,
      fetchManifestText: doubles.fetchManifestText,
      request: doubles.request,
    })
    ctx.provide('desktopCompanyMarketTarballInstall', channel)
    // Prime the channel exactly the way the market's execution verification
    // does: the npm entry verifies through the manifest and the channel
    // declines the diversion.
    await expect(channel.verifyTarballEntry(
      { packageName: 'example-plugin', version: '1.0.0' },
      new AbortController().signal,
    )).resolves.toBeUndefined()
  }
  const fiber = ctx.plugin({ name: desktopPnpmName, inject: desktopPnpmInject, apply: applyDesktopPnpm })
  await fiber
  const service = ctx.get('desktopPnpm')
  if (service === undefined) throw new Error('desktop pnpm service did not mount')
  return {
    service: service as DesktopPnpm,
    spawn,
    dispose: async () => { await fiber.dispose() },
  }
}

describe('npm-channel install path stays byte-identical', () => {
  const npmRequest = {
    pnpmOptions: ['--save-exact', '--registry=https://registry.npmjs.org/'],
    invokingDir: '/workspace',
    recovery: { packageName: 'example-plugin', packageVersion: '1.0.0', receiptId: 'receipt:npm-0001' },
  }

  it('spawns the exact same argv with and without the channel for an npm-channel entry', async () => {
    const manifestWithNpmEntry = signedManifestText([tarballEntry(), npmEntry()])
    const baseline = await pnpmHarness(temporaryDirectory('npm-baseline'), idleSpawn(), undefined)
    const channeled = await pnpmHarness(temporaryDirectory('npm-channel'), idleSpawn(), {
      manifestText: manifestWithNpmEntry,
    })
    try {
      const baselineOperation = await baseline.service.installPlugin(npmRequest)
      const channeledOperation = await channeled.service.installPlugin(npmRequest)
      await expect(baselineOperation.done).resolves.toMatchObject({ exitCode: 0 })
      await expect(channeledOperation.done).resolves.toMatchObject({ exitCode: 0 })
      const baselineArgv = baseline.spawn.mock.calls[0]?.[0].argv as string[]
      const channeledArgv = channeled.spawn.mock.calls[0]?.[0].argv as string[]
      // Byte-identical apart from each harness's own temp-root prefix in the
      // node/bootstrap argv positions.
      const suffix = (argv: readonly string[]): readonly string[] =>
        argv.slice(argv.indexOf('plugin'))
      expect(suffix(channeledArgv)).toEqual(suffix(baselineArgv))
      expect(baselineArgv.slice(-1)[0]).toBe('example-plugin@1.0.0')
      expect(suffix(baselineArgv)).toEqual([
        'plugin',
        '--profile',
        'web',
        'add',
        '--save-exact',
        '--registry=https://registry.npmjs.org/',
        'example-plugin@1.0.0',
      ])
    } finally {
      await baseline.dispose()
      await channeled.dispose()
    }
  })

  it('still rejects user-argument tarball paths at the pnpm boundary (the CLI red line)', async () => {
    const manifestText = signedManifestText([tarballEntry()])
    const harness = await pnpmHarness(temporaryDirectory('red-line'), idleSpawn(), { manifestText })
    try {
      // Attempt the red-line spelling: a user-style tarball argument in the
      // options must still fail the audit before any spawn.
      await expect(harness.service.installPlugin({
        invokingDir: '/workspace',
        recovery: { packageName: PACKAGE_NAME, packageVersion: PACKAGE_VERSION, receiptId: 'receipt:red-line-0001' },
        pnpmOptions: [`file:${join('/tmp', `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`)}`],
      })).rejects.toThrow('desktop pnpm install options are restricted')
      expect(harness.spawn).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })
})
