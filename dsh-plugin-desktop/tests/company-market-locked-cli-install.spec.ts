/**
 * The locked-fleet tarball install regression (the free-search #48 fix),
 * fully offline: the REAL packaged `desktop-cli.js` child, REAL pinned pnpm,
 * REAL recovery WAL, and the REAL market channel — over a self-signed
 * catalog manifest and a locally packed fixture tarball (no network, no
 * GitLab, no embedded fleet assets).
 *
 * Three assertions, one composition:
 *
 * 1. **the fix** — under a locked company policy handed to the CLI child
 *    exactly like main.ts does (seven-key policy hand-off + staged manifest
 *    file), the market channel's controlled tarball install runs the real
 *    `dsh plugin add … file:<staged>` child end to end and exits 0: the
 *    launcher tarball hand-off (`DSH_COMPANY_TARBALL_HANDOFF`) admits
 *    exactly that one `file:` target through the locked add gate, and the
 *    profile ends with the `file:` pin, the declared bundle, and the
 *    installed package;
 * 2. **the terminal red line** — the same locked child, the same genuinely
 *    signed and genuinely staged tarball, but a user-typed `file:` argument
 *    and no hand-off: exit 1 with the exact-spec denial and market guidance
 *    (pnpm never runs);
 * 3. **the hand-off is unforgeable** — a user-crafted hand-off value naming
 *    the signed package@version still cannot admit other bytes: a diverging
 *    integrity and swapped staged bytes are both denied before pnpm runs.
 */

import { spawn as childSpawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessRuntime,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJsonText,
  createCompanyManifestSignature,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import { createDesktopCompanyMarketTarballInstallChannel } from '../src/company-market-install.ts'
import { DESKTOP_COMPANY_MANIFEST_FILE_ENV } from '../src/company-manifest-origin.ts'
import {
  DESKTOP_COMPANY_TARBALL_HANDOFF_ENV,
  desktopMarketTarballStagingPath,
  parseCompanyTarballHandoff,
} from '../src/company-tarball-handoff.ts'
import { computeDesktopBootTreeRootDigest } from '../src/boot-verification.ts'
import { desktopPolicyEnvironmentEntries, parseDesktopPolicy } from '../src/desktop-policy.ts'
import { installDesktopPnpmRuntime } from '../src/desktop-runtime-environment.ts'
import {
  apply as applyDesktopPnpm,
  inject as desktopPnpmInject,
  name as desktopPnpmName,
  type DesktopPnpm,
  type DesktopPnpmBootstrap,
} from '../src/pnpm.ts'
import { ensureProfilePnpmBuildApproval } from '../src/profile-pnpm-policy.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The workspace-pinned pnpm the desktop bundles (absent only before `corepack yarn install`). */
const PINNED_PNPM = join(HERE, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
/** The packaged CLI bootstrap the market install spawns (built by `corepack yarn build`). */
const BUILT_DESKTOP_CLI = join(HERE, '..', 'lib', 'desktop-cli.js')
const ELECTRON_VERSION = '43.4.0'

const CATALOG_ORIGIN = 'https://market.company.example'
const MANIFEST_URL = `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`
const TARBALL_URL = `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/packages/fixture.tgz`
const PACKAGE_NAME = 'company-free-search-fixture'
const PACKAGE_VERSION = '1.2.3'
const BUNDLE_PATCH = './cordis.patch.yml'

const keyId = 'company-catalog-locked-cli'
const { publicKey, privateKey } = generateKeyPairSync('ed25519')

const policy = parseDesktopPolicy({
  locked: true,
  managedModels: false,
  requireSso: false,
  companyCatalogOrigin: CATALOG_ORIGIN,
  companyManifestUrl: MANIFEST_URL,
  allowHomePatch: false,
  allowManualPluginAdd: false,
  trustRoots: [{ keyId, fingerprint: ed25519PublicKeyFingerprint(publicKey) }],
  usageReport: false,
  agentBrowser: { enabled: false, allowOrigins: [], allowPersistLogin: false },
})

// ---------------------------------------------------------------------------
// Offline fixture: a real `pnpm pack` tarball, its signed sha512, and the
// tree digest a real install of it materializes (measured over one
// throwaway real install, exactly like the generated-lockfile proofs in
// tests/company-market-install.spec.ts).
// ---------------------------------------------------------------------------

interface PackedFixture {
  readonly bytes: Buffer
  readonly integrity: string
  readonly treeDigest: string
}

const FIXTURE: PackedFixture = existsSync(PINNED_PNPM)
  ? (() => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-locked-cli-fixture-'))
    try {
    const sourceDir = join(root, 'src')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), `${JSON.stringify({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      dsh: { bundle: { patch: BUNDLE_PATCH } },
    })}\n`)
    writeFileSync(join(sourceDir, 'cordis.patch.yml'), '[]\n')
    const packed = spawnSync(process.execPath, [PINNED_PNPM, 'pack', '--pack-destination', root], {
      cwd: sourceDir,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CI: 'true', npm_config_store_dir: join(root, 'pnpm-store') },
    })
    expect(
      packed.status === 0,
      `real pnpm pack exited ${String(packed.status)}:\n${packed.stdout ?? ''}\n${packed.stderr ?? ''}`,
    ).toBe(true)
    const bytes = readFileSync(join(root, `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`))

    // Measure the tree a real install materializes: a scratch profile, a
    // real `add file:`, then the boot-verification digest walk over the
    // installed package directory.
    const scratchProfile = join(root, 'profiles', 'web')
    mkdirSync(scratchProfile, { recursive: true })
    writeFileSync(join(scratchProfile, 'package.json'), `${JSON.stringify({
      name: 'scratch-profile',
      private: true,
      dependencies: {},
    })}\n`)
    const staged = join(scratchProfile, '.dsh-market-tarballs', `${PACKAGE_NAME}-${PACKAGE_VERSION}.tgz`)
    mkdirSync(dirname(staged), { recursive: true })
    writeFileSync(staged, bytes)
    const added = spawnSync(process.execPath, [
      PINNED_PNPM, 'add', '--save-exact', '--registry=https://registry.npmjs.org/', `file:${staged}`,
    ], {
      cwd: scratchProfile,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, CI: 'true', npm_config_store_dir: join(root, 'pnpm-store') },
    })
    expect(
      added.status === 0,
      `real pnpm add exited ${String(added.status)}:\n${added.stdout ?? ''}\n${added.stderr ?? ''}`,
    ).toBe(true)
    return {
      bytes,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      treeDigest: computeDesktopBootTreeRootDigest(join(scratchProfile, 'node_modules', PACKAGE_NAME)),
    }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })()
  // Placeholder before `corepack yarn install` (the suite skips itself).
  : {
    bytes: Buffer.alloc(0),
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    treeDigest: 'ab'.repeat(32),
  }

/** The self-signed catalog: exactly one tarball-channel entry for the fixture. */
const manifestText = (() => {
  const unsigned = {
    manifestVersion: '1.0.0',
    sequence: 42,
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    packages: [{
      packageName: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      integrity: FIXTURE.integrity,
      bundlePatch: BUNDLE_PATCH,
      repository: { url: 'https://gitlab.company.example/julu/dsh-free-search-fixture' },
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
      treeDigest: FIXTURE.treeDigest,
      source: { kind: 'tarball', url: TARBALL_URL, integrity: FIXTURE.integrity },
    }],
  }
  return canonicalJsonText({
    ...unsigned,
    signature: createCompanyManifestSignature(
      unsigned as unknown as Parameters<typeof createCompanyManifestSignature>[0],
      privateKey,
      keyId,
    ),
  })
})()

// ---------------------------------------------------------------------------
// The composition: real subprocess runtime, real generated shims, real
// channel, real pnpm service — only the catalog origin and tarball download
// are in-memory doubles.
// ---------------------------------------------------------------------------

const roots: string[] = []
function temporaryDirectory(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-locked-cli-${label}-`))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface CapturedChild {
  readonly argv: readonly string[]
  readonly env: Record<string, string | undefined>
  stderr: string
  stdout: string
}

/** A REAL subprocess runtime: plain child_process behind the package's seams, with an isolated pnpm store. */
function realSubprocessRuntime(
  storeDir: string,
  captured: CapturedChild[],
): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      const record: CapturedChild = { argv: [...spec.argv], env: { ...spec.env }, stderr: '', stdout: '' }
      captured.push(record)
      const child = childSpawn(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: {
          ...scrubbedParentEnv(),
          npm_config_store_dir: storeDir,
          ...spec.env,
        },
        stdio: [
          typeof spec.stdio.stdin === 'string' ? spec.stdio.stdin : 'ignore',
          typeof spec.stdio.stdout === 'string' ? spec.stdio.stdout : 'ignore',
          typeof spec.stdio.stderr === 'string' ? spec.stdio.stderr : 'ignore',
        ],
        detached: process.platform !== 'win32',
      })
      const done = new Promise<SubprocessOutcome>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
      })
      void done.catch(() => {})
      child.stdout?.on('data', (chunk: Buffer) => { record.stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { record.stderr += chunk.toString('utf8') })
      return {
        pid: child.pid ?? -1,
        stdin: child.stdin ?? undefined,
        stdout: child.stdout ?? undefined,
        stderr: child.stderr ?? undefined,
        collected: {},
        done,
        terminate: () => {
          try {
            if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
            else child.kill('SIGTERM')
          } catch { /* already gone */ }
        },
        waitForExit: () => done.then(() => true).catch(() => true),
      }
    },
  } as unknown as SubprocessRuntime
}

interface Composition {
  service: DesktopPnpm
  channel: ReturnType<typeof createDesktopCompanyMarketTarballInstallChannel>
  profileDir: string
  homeDir: string
  cliPolicyEnvironment: Record<string, string>
  captured: CapturedChild[]
  dispose(): Promise<void>
}

/** Compose the production pieces over one fresh device-shaped profile, exactly like main.ts. */
async function composeLockedDesktop(label: string): Promise<Composition> {
  const root = temporaryDirectory(label)
  const homeDir = join(root, 'home')
  const profileDir = join(homeDir, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  // The real device profile shape: upstream web template + desktop approvals.
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)
  ensureProfilePnpmBuildApproval(profileDir)

  // The real generated pnpm/node shims the runtime composes.
  const runtime = installDesktopPnpmRuntime({
    platform: process.platform,
    nodeExecutable: process.execPath,
    pnpmBinPath: PINNED_PNPM,
    electronVersion: ELECTRON_VERSION,
    stateDir: join(root, 'host-commands', 'web'),
  })

  // The launcher's CLI-child hand-off for a locked origin-mode fleet.
  const stagedManifestFile = join(root, 'staged-company-manifest.json')
  writeFileSync(stagedManifestFile, manifestText)
  const cliPolicyEnvironment: Record<string, string> = {
    ...desktopPolicyEnvironmentEntries(policy),
    [DESKTOP_COMPANY_MANIFEST_FILE_ENV]: stagedManifestFile,
  }

  const bootstrap: DesktopPnpmBootstrap = {
    activeProfileName: 'web',
    activeProfileDir: profileDir,
    homeDir,
    nodeExecutable: process.execPath,
    pnpmBinPath: PINNED_PNPM,
    electronVersion: ELECTRON_VERSION,
    nodeBinDir: runtime.nodeBinDir,
    nodeShimPath: runtime.nodeShimPath,
    dshBootstrapPath: BUILT_DESKTOP_CLI,
    installRecoveryStatePath: join(root, 'plugin-install-recovery', 'state.json'),
    generationId: `locked-cli-${label}-generation-0001`,
    externalMarketInstallEnabled: false,
    cliPolicyEnvironment,
  }

  const channel = createDesktopCompanyMarketTarballInstallChannel({
    policy,
    profileDir,
    fetchManifestText: async () => manifestText,
    request: async (url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      if (url === TARBALL_URL) {
        return new Response(new Uint8Array(FIXTURE.bytes), {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })

  const captured: CapturedChild[] = []
  const ctx = new Context()
  ctx.provide('desktopPnpmBootstrap', bootstrap)
  ctx.provide('subprocess', realSubprocessRuntime(join(root, 'pnpm-store'), captured))
  ctx.provide('desktopCompanyMarketTarballInstall', channel)
  const fiber = ctx.plugin({ name: desktopPnpmName, inject: desktopPnpmInject, apply: applyDesktopPnpm })
  await fiber
  const service = ctx.get('desktopPnpm')
  if (service === undefined) throw new Error('desktop pnpm service did not mount')
  return {
    service: service as DesktopPnpm,
    channel,
    profileDir,
    homeDir,
    cliPolicyEnvironment,
    captured,
    dispose: async () => {
      await fiber.dispose()
      runtime.dispose()
    },
  }
}

/** The market's execute step: preview-verified entry, audited flags, receipt. */
async function marketExecute(composition: Composition, receiptId: string) {
  const verification = await composition.channel.verifyTarballEntry(
    { packageName: PACKAGE_NAME, version: PACKAGE_VERSION },
    new AbortController().signal,
  )
  expect(verification?.integrity).toBe(FIXTURE.integrity)
  const handle = await composition.service.installPlugin({
    pnpmOptions: ['--save-exact', '--registry=https://registry.npmjs.org/'],
    invokingDir: composition.profileDir,
    recovery: { packageName: PACKAGE_NAME, packageVersion: PACKAGE_VERSION, receiptId },
  })
  let stderrText = ''
  handle.stderr.on('data', (chunk: Buffer) => { stderrText += chunk.toString('utf8') })
  handle.stdout.resume()
  const outcome = await handle.done
  return { outcome, stderrText, verification }
}

/** Run the REAL packaged CLI child directly, exactly like a user command in the built-in terminal. */
function runPackagedCli(
  root: string,
  argv: readonly string[],
  extraEnvironment: Record<string, string> = {},
): { status: number | null; stderr: string; stdout: string } {
  const stagedManifestFile = join(root, 'staged-company-manifest.json')
  writeFileSync(stagedManifestFile, manifestText)
  const probe = spawnSync(process.execPath, ['--expose-internals', BUILT_DESKTOP_CLI, ...argv], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...scrubbedParentEnv(),
      npm_config_store_dir: join(root, 'pnpm-store'),
      CI: 'true',
      DSH_HOME: join(root, 'home'),
      // The seven-key locked policy hand-off plus the staged manifest file —
      // the #48 device state. The tarball hand-off is deliberately NOT here.
      ...desktopPolicyEnvironmentEntries(policy),
      [DESKTOP_COMPANY_MANIFEST_FILE_ENV]: stagedManifestFile,
      ...extraEnvironment,
    },
  })
  return { status: probe.status, stderr: probe.stderr ?? '', stdout: probe.stdout ?? '' }
}

describe.skipIf(!existsSync(PINNED_PNPM) || !existsSync(BUILT_DESKTOP_CLI))(
  'locked-fleet market tarball install through the real packaged CLI',
  () => {
    it('the fix: the market channel installs the signed tarball end to end under the locked policy', async () => {
      const composition = await composeLockedDesktop('install')
      const stagedPath = desktopMarketTarballStagingPath(composition.profileDir, PACKAGE_NAME, PACKAGE_VERSION)
      try {
        const { outcome, stderrText } = await marketExecute(composition, 'receipt:locked-cli-install-0001')
        expect(stderrText).not.toContain('is not a <package>@<exact version> spec')
        expect(outcome.exitCode).toBe(0)
        expect(outcome.signal).toBe(null)

        // The spawned child was the packaged desktop-cli with the controlled
        // target, the audited flags, and the launcher tarball hand-off.
        const child = composition.captured.at(-1)
        expect(child).toBeDefined()
        const argv = child!.argv
        expect(argv[3]).toBe('plugin')
        expect(argv.slice(argv.indexOf('add'))).toEqual([
          'add', '--save-exact', '--registry=https://registry.npmjs.org/', `file:${stagedPath}`,
        ])
        const handoff = parseCompanyTarballHandoff(
          child!.env[DESKTOP_COMPANY_TARBALL_HANDOFF_ENV] ?? '',
        )
        expect(handoff).toEqual({
          packageName: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          integrity: FIXTURE.integrity,
          path: stagedPath,
        })
        // No gate denial reached the child's own stderr; the real install ran.
        expect(child!.stderr).not.toContain('dsh-desktop:')
        expect(readFileSync(stagedPath)).toEqual(FIXTURE.bytes)

        // The profile now carries the file: pin, the declared bundle, and
        // the installed package with its bundle patch.
        const manifest = JSON.parse(readFileSync(join(composition.profileDir, 'package.json'), 'utf8')) as {
          dependencies: Record<string, string>
          dsh?: { profile?: { bundles?: string[] } }
        }
        expect(manifest.dependencies[PACKAGE_NAME]).toBe(`file:${stagedPath}`)
        expect(manifest.dsh?.profile?.bundles).toContain(PACKAGE_NAME)
        const installed = JSON.parse(readFileSync(
          join(composition.profileDir, 'node_modules', PACKAGE_NAME, 'package.json'),
          'utf8',
        )) as { name: string, version: string }
        expect(installed).toMatchObject({ name: PACKAGE_NAME, version: PACKAGE_VERSION })
        expect(existsSync(join(composition.profileDir, 'node_modules', PACKAGE_NAME, 'cordis.patch.yml'))).toBe(true)
        // The sealed install left nothing for startup recovery.
        await expect(composition.service.recoveredInstallReceiptIds()).resolves.toEqual([])
      } finally {
        await composition.dispose()
      }
    }, 300_000)

    it('the red line: a user-typed file: target is denied even against the genuinely signed, staged tarball', async () => {
      const root = temporaryDirectory('red-line')
      const homeDir = join(root, 'home')
      const profileDir = join(homeDir, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} })}\n`)
      // The genuine signed tarball, genuinely staged: without the launcher's
      // hand-off the gate must still refuse the user's file: argument.
      const stagedPath = desktopMarketTarballStagingPath(profileDir, PACKAGE_NAME, PACKAGE_VERSION)
      mkdirSync(dirname(stagedPath), { recursive: true })
      writeFileSync(stagedPath, FIXTURE.bytes)
      writeFileSync(join(root, 'staged-company-manifest.json'), manifestText)

      const probe = runPackagedCli(root, ['plugin', '--profile', 'web', 'add', '--save-exact', `file:${stagedPath}`])

      expect(probe.status).toBe(1)
      expect(probe.stderr).toContain('is not a <package>@<exact version> spec')
      expect(probe.stderr).toContain('Install plugins from the company plugin market instead.')
      // Nothing was installed and the profile is untouched.
      expect(existsSync(join(profileDir, 'node_modules'))).toBe(false)
    }, 120_000)

    it('the hand-off is unforgeable: a crafted value cannot admit other bytes', async () => {
      const root = temporaryDirectory('forged')
      const homeDir = join(root, 'home')
      const profileDir = join(homeDir, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} })}\n`)
      const stagedPath = desktopMarketTarballStagingPath(profileDir, PACKAGE_NAME, PACKAGE_VERSION)
      mkdirSync(dirname(stagedPath), { recursive: true })
      writeFileSync(join(root, 'staged-company-manifest.json'), manifestText)

      // A user knowing the catalog's public facts still needs staged bytes
      // that hash to the signed sha512: claim a different integrity and the
      // signed entry disagrees; swap the staged bytes and the fresh hash
      // disagrees. Both are refused before pnpm ever runs.
      const otherIntegrity = `sha512-${createHash('sha512').update('other bytes').digest('base64')}`
      const divergingIntegrity = runPackagedCli(
        root,
        ['plugin', '--profile', 'web', 'add', '--save-exact', `file:${stagedPath}`],
        {
          [DESKTOP_COMPANY_TARBALL_HANDOFF_ENV]: JSON.stringify({
            integrity: otherIntegrity,
            packageName: PACKAGE_NAME,
            path: stagedPath,
            version: PACKAGE_VERSION,
          }),
        },
      )
      expect(divergingIntegrity.status).toBe(1)
      expect(divergingIntegrity.stderr).toContain('pins integrity')

      writeFileSync(stagedPath, Buffer.from('swapped after staging\n', 'utf8'))
      const swappedBytes = runPackagedCli(
        root,
        ['plugin', '--profile', 'web', 'add', '--save-exact', `file:${stagedPath}`],
        {
          [DESKTOP_COMPANY_TARBALL_HANDOFF_ENV]: JSON.stringify({
            integrity: FIXTURE.integrity,
            packageName: PACKAGE_NAME,
            path: stagedPath,
            version: PACKAGE_VERSION,
          }),
        },
      )
      expect(swappedBytes.status).toBe(1)
      expect(swappedBytes.stderr).toContain('does not match the integrity pinned in the signed company plugin catalog')
      expect(existsSync(join(profileDir, 'node_modules'))).toBe(false)
    }, 120_000)
  },
)
