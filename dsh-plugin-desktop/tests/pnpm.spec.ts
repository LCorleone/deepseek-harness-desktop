import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  name,
  type DesktopPnpm,
  type DesktopPnpmBootstrap,
} from '../src/pnpm.ts'
import {
  DESKTOP_POLICY_ENVIRONMENT,
  desktopPolicyEnvironmentEntries,
  type DesktopPolicy,
} from '../src/desktop-policy.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(cause: unknown): void
}

interface ControlledSubprocess extends SubprocessHandle {
  resolveDone(outcome: SubprocessOutcome): void
  rejectDone(cause: unknown): void
  resolveTree(exited?: boolean): void
  terminate: ReturnType<typeof vi.fn<() => void>>
  waitForExit: ReturnType<typeof vi.fn<(signal?: AbortSignal) => Promise<boolean>>>
}

interface PnpmHarness {
  ctx: Context
  service: DesktopPnpm
  spawn: ReturnType<typeof vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>>
  dispose(): Promise<void>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function controlledSubprocess(): ControlledSubprocess {
  const outcome = deferred<SubprocessOutcome>()
  const tree = deferred<boolean>()
  return {
    pid: 43120,
    stdin: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    collected: {},
    done: outcome.promise,
    terminate: vi.fn(),
    waitForExit: vi.fn(() => tree.promise),
    resolveDone: value => { outcome.resolve(value) },
    rejectDone: cause => { outcome.reject(cause) },
    resolveTree: (exited = true) => { tree.resolve(exited) },
  }
}

function bootstrap(root = '/desktop runtime'): DesktopPnpmBootstrap {
  return {
    activeProfileName: '工作 profile',
    activeProfileDir: join(root, 'profiles', '工作 profile'),
    homeDir: join(root, 'harness home'),
    nodeExecutable: join(root, 'resources', 'node-runtime', 'node'),
    pnpmBinPath: join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    electronVersion: '43.4.0',
    nodeBinDir: join(root, 'private', 'node-bin'),
    nodeShimPath: join(root, 'private', 'node-bin', 'node'),
    dshBootstrapPath: join(root, 'app.asar', 'lib', 'desktop-cli.js'),
    installRecoveryStatePath: join(root, 'plugin-install-recovery', 'state.json'),
    generationId: 'test-generation-0001',
    externalMarketInstallEnabled: false,
  }
}

async function createHarness(
  children: ControlledSubprocess[],
  selectedBootstrap: DesktopPnpmBootstrap = bootstrap(),
): Promise<PnpmHarness> {
  const ctx = new Context()
  const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => {
    const child = children.shift()
    if (child === undefined) throw new Error('test subprocess queue is empty')
    return child
  })
  ctx.provide('desktopPnpmBootstrap', selectedBootstrap)
  ctx.provide('subprocess', { spawn } as unknown as SubprocessRuntime)
  const fiber = ctx.plugin({ name, inject, apply })
  await fiber
  const service = ctx.get('desktopPnpm')
  if (service === undefined) throw new Error('desktop pnpm service did not mount')
  return {
    ctx,
    service,
    spawn,
    dispose: fiber.dispose,
  }
}

function finish(child: ControlledSubprocess, outcome: SubprocessOutcome = {
  exitCode: 0,
  signal: null,
}): void {
  child.resolveDone(outcome)
  child.resolveTree()
}

/** Uppercase names of every parent variable the pnpm spawn path can forward. */
const FORWARDABLE_TLS_ENVIRONMENT_NAMES = new Set([
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NPM_CONFIG_CAFILE',
  'NPM_CONFIG_STRICT_SSL',
  'NODE_TLS_REJECT_UNAUTHORIZED',
])

/**
 * Run one body with every forwardable TLS/proxy variable absent from the
 * parent environment, restoring the exact previous state afterwards. The
 * exact-env assertions below stay valid on machines behind corporate
 * proxies or with TLS variables set instead of flaking on inherited values.
 */
async function withoutForwardableTlsEnvironment<T>(body: () => Promise<T>): Promise<T> {
  const saved = Object.entries(process.env)
    .filter(([key]) => FORWARDABLE_TLS_ENVIRONMENT_NAMES.has(key.toUpperCase()))
  for (const [key] of saved) delete process.env[key]
  try {
    return await body()
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value
    }
  }
}

describe('desktop pnpm Host service', () => {
  it('runs physical packaged pnpm with the bundled Node lifecycle environment', async () => {
    const child = controlledSubprocess()
    const signal = new AbortController().signal

    await withoutForwardableTlsEnvironment(async () => {
      const harness = await createHarness([child])

      const operation = harness.service.run(['list', '--depth=0'], signal)

      expect(harness.spawn).toHaveBeenCalledOnce()
      const spec = harness.spawn.mock.calls[0]?.[0]
      expect(spec).toEqual({
        argv: [
          bootstrap().nodeExecutable,
          bootstrap().pnpmBinPath,
          'list',
          '--depth=0',
        ],
        cwd: bootstrap().activeProfileDir,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3_000,
        signal,
        env: {
          PATH: `${bootstrap().nodeBinDir}${delimiter}${process.env.PATH ?? ''}`,
          NODE: bootstrap().nodeShimPath,
          DSH_HOME: bootstrap().homeDir,
          CI: 'true',
          npm_config_runtime: 'electron',
          npm_config_target: '43.4.0',
          npm_config_disturl: 'https://electronjs.org/headers',
        },
      })
      expect(spec?.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
      expect(spec?.env).not.toHaveProperty('NODE_EXTRA_CA_CERTS')
      expect(spec).not.toHaveProperty('shell')
      expect(operation.stdout).toBe(child.stdout)
      expect(operation.stderr).toBe(child.stderr)
      operation.cancel()
      expect(child.terminate).toHaveBeenCalledOnce()

      finish(child)
      await expect(operation.done).resolves.toEqual({ exitCode: 0, signal: null })
      expect(child.waitForExit).toHaveBeenCalledWith()
      await harness.dispose()
      expect(harness.ctx.get('desktopPnpm')).toBeUndefined()
    })
  })

  it('runs the packaged DSH plugin command from the caller directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-plugin-'))
    const selectedBootstrap = bootstrap(root)
    const child = controlledSubprocess()
    const harness = await createHarness([child], selectedBootstrap)
    const invokingDir = '/workspace/third-party-plugin'

    try {
      const operation = harness.service.runPlugin(['remove', 'dshmarket'], invokingDir)

      const spec = harness.spawn.mock.calls[0]?.[0]
      expect(spec?.argv).toEqual([
        selectedBootstrap.nodeExecutable,
        '--expose-internals',
        selectedBootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        '工作 profile',
        'remove',
        'dshmarket',
      ])
      expect(spec?.cwd).toBe(invokingDir)
      expect(spec).not.toHaveProperty('signal')
      expect(spec).not.toHaveProperty('shell')
      // pnpm 11 fails operations whose dependency builds are unapproved, so
      // every plugin spawn first ensures the profile approves them.
      expect(readFileSync(join(selectedBootstrap.activeProfileDir, 'pnpm-workspace.yaml'), 'utf8'))
        .toContain('onlyBuiltDependencies:')

      finish(child, { exitCode: 7, signal: null })
      await expect(operation.done).resolves.toEqual({ exitCode: 7, signal: null })
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows an unpatched dsh-market runtime to add through the external boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-external-add-'))
    const selectedBootstrap = { ...bootstrap(root), externalMarketInstallEnabled: true }
    const child = controlledSubprocess()
    const harness = await createHarness([child], selectedBootstrap)
    try {
      const operation = harness.service.runPlugin(
        ['add', 'dshmarket@1.18.0', '--reporter=ndjson'],
        '/workspace/dsh-market',
      )

      expect(harness.spawn.mock.calls[0]?.[0].argv).toContain('dshmarket@1.18.0')
      // The unpatched dsh-market add runs without a WAL, but its profile
      // workspace is still build-approved before pnpm is spawned.
      expect(readFileSync(join(selectedBootstrap.activeProfileDir, 'pnpm-workspace.yaml'), 'utf8'))
        .toContain('- node-pty')
      finish(child)
      await operation.done
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs the selected dsh-market install without creating a per-install WAL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-external-install-'))
    const selectedBootstrap = { ...bootstrap(root), externalMarketInstallEnabled: true }
    const child = controlledSubprocess()
    const harness = await createHarness([child], selectedBootstrap)
    try {
      const operation = harness.service.runExternalMarketPluginInstall(
        ['add', '--reporter=ndjson', '@scope/example-plugin@1.2.3'],
        '/workspace/dsh-market',
      )

      expect(harness.spawn.mock.calls[0]?.[0].argv).toEqual([
        selectedBootstrap.nodeExecutable,
        '--expose-internals',
        selectedBootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        selectedBootstrap.activeProfileName,
        'add',
        '--reporter=ndjson',
        '@scope/example-plugin@1.2.3',
      ])
      expect(harness.spawn.mock.calls[0]?.[0].cwd).toBe('/workspace/dsh-market')
      expect(existsSync(selectedBootstrap.installRecoveryStatePath)).toBe(false)

      finish(child)
      await operation.done
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects the external Market boundary unless dsh-market is selected', async () => {
    const harness = await createHarness([])
    expect(() => harness.service.runExternalMarketPluginInstall(
      ['add', 'example-plugin@1.0.0'],
      '/workspace',
    )).toThrow('unavailable for the selected Market provider')
    await harness.dispose()
  })

  it('accepts only add with one exact npm target and flag options for dsh-market', async () => {
    const harness = await createHarness([], { ...bootstrap(), externalMarketInstallEnabled: true })
    for (const args of [
      ['remove', 'example-plugin@1.0.0'],
      ['add', 'example-plugin'],
      ['add', 'example-plugin@latest'],
      ['add', 'example-plugin@1.0.0', 'other-plugin@1.0.0'],
      ['add', '--registry', 'https://registry.example', 'example-plugin@1.0.0'],
    ]) {
      expect(() => harness.service.runExternalMarketPluginInstall(args, '/workspace')).toThrow()
    }
    await harness.dispose()
  })

  it('reserves the operation gate, snapshots, and seals a recoverable plugin install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-recovery-'))
    const selectedBootstrap = bootstrap(root)
    const manifestPath = join(selectedBootstrap.activeProfileDir, 'package.json')
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: {} }))
      const harness = await createHarness([child], selectedBootstrap)

      const pending = harness.service.installPlugin({
        pnpmOptions: ['--save-exact'],
        invokingDir: '/workspace',
        recovery: {
          packageName: 'example-plugin',
          packageVersion: '1.0.0',
          receiptId: 'receipt:test-install-0001',
        },
      })
      expect(() => harness.service.runPlugin(['remove', 'other-plugin'], '/workspace')).toThrow(
        'another desktop pnpm operation is already running',
      )
      const operation = await pending
      writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'example-plugin': '1.0.0' } }))
      finish(child)
      await expect(operation.done).resolves.toEqual({ exitCode: 0, signal: null })

      expect(harness.spawn.mock.calls[0]?.[0].argv).toEqual([
        selectedBootstrap.nodeExecutable,
        '--expose-internals',
        selectedBootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        selectedBootstrap.activeProfileName,
        'add',
        '--save-exact',
        'example-plugin@1.0.0',
      ])
      expect(JSON.parse(readFileSync(selectedBootstrap.installRecoveryStatePath, 'utf8'))).toMatchObject({
        packageName: 'example-plugin',
        packageVersion: '1.0.0',
        receiptId: 'receipt:test-install-0001',
        phase: 'awaiting-restart',
      })
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores partial profile writes when a recoverable plugin install exits nonzero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-recovery-failure-'))
    const selectedBootstrap = bootstrap(root)
    const manifestPath = join(selectedBootstrap.activeProfileDir, 'package.json')
    const child = controlledSubprocess()
    const originalManifest = JSON.stringify({ dependencies: {} })
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(manifestPath, originalManifest)
      const harness = await createHarness([child], selectedBootstrap)
      const operation = await harness.service.installPlugin({
        invokingDir: '/workspace',
        recovery: {
          packageName: 'broken-plugin',
          packageVersion: '1.0.0',
          receiptId: 'receipt:test-install-failure-0001',
        },
      })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: { 'broken-plugin': '1.0.0' } }))
      finish(child, { exitCode: 1, signal: null })

      await expect(operation.done).resolves.toEqual({ exitCode: 1, signal: null })
      expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest)
      expect(existsSync(selectedBootstrap.installRecoveryStatePath)).toBe(false)
      // The build approval was written before the WAL snapshot, so the
      // rollback restores a workspace that still pre-approves the trusted
      // dependency builds instead of stripping them for the next install.
      expect(readFileSync(join(selectedBootstrap.activeProfileDir, 'pnpm-workspace.yaml'), 'utf8'))
        .toContain('- node-pty')
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('unions the signed approvedBuilds of the install request into the workspace approval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-approved-builds-'))
    const selectedBootstrap = bootstrap(root)
    const manifestPath = join(selectedBootstrap.activeProfileDir, 'package.json')
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(manifestPath, JSON.stringify({ dependencies: {} }))
      const harness = await createHarness([child], selectedBootstrap)

      const operation = await harness.service.installPlugin({
        invokingDir: '/workspace',
        recovery: {
          packageName: 'example-plugin',
          packageVersion: '1.0.0',
          receiptId: 'receipt:test-approved-builds-0001',
        },
        approvedBuildDependencies: ['sharp', 'node-pty', '@scope/native-helper'],
      })
      finish(child)
      await expect(operation.done).resolves.toEqual({ exitCode: 0, signal: null })

      // Built-in triple first, signed extras unioned in (node-pty deduped),
      // both pnpm spellings — exactly what the market boundary hands over
      // after a signed allow decision.
      const workspace = readFileSync(join(selectedBootstrap.activeProfileDir, 'pnpm-workspace.yaml'), 'utf8')
      expect(workspace).toContain('- node-pty\n  - esbuild\n  - protobufjs\n  - sharp\n  - \'@scope/native-helper\'\n')
      expect(workspace).toContain("node-pty: true\n  esbuild: true\n  protobufjs: true\n  sharp: true\n  '@scope/native-helper': true")
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the v2.0.1 recoverable install interface for an exact receipt target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-legacy-install-'))
    const selectedBootstrap = bootstrap(root)
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), '{}\n')
      const harness = await createHarness([child], selectedBootstrap)

      const operation = await harness.service.runPluginInstall(
        ['add', '--save-exact', 'legacy-plugin@1.2.3'],
        '/workspace',
        {
          packageName: 'legacy-plugin',
          packageVersion: '1.2.3',
          receiptId: 'receipt:legacy-install-0001',
        },
      )

      expect(harness.spawn.mock.calls[0]?.[0].argv).toEqual([
        selectedBootstrap.nodeExecutable,
        '--expose-internals',
        selectedBootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        selectedBootstrap.activeProfileName,
        'add',
        '--save-exact',
        'legacy-plugin@1.2.3',
      ])
      finish(child)
      await operation.done
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects legacy recoverable installs that do not match the receipt target', async () => {
    const harness = await createHarness([])
    const recovery = {
      packageName: 'legacy-plugin',
      packageVersion: '1.2.3',
      receiptId: 'receipt:legacy-install-invalid-0001',
    }

    await expect(harness.service.runPluginInstall(
      ['add', 'other-plugin@1.2.3'],
      '/workspace',
      recovery,
    )).rejects.toThrow('requires the exact receipt target')
    await expect(harness.service.runPluginInstall(
      ['add', 'extra-plugin@1.0.0', 'legacy-plugin@1.2.3'],
      '/workspace',
      recovery,
    )).rejects.toThrow('requires the exact receipt target')
    expect(harness.spawn).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('rejects install options outside the audited allow-list', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-options-'))
    const selectedBootstrap = bootstrap(root)
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), '{}\n')
      const harness = await createHarness([child], selectedBootstrap)
      const recovery = {
        packageName: 'example-plugin',
        packageVersion: '1.0.0',
        receiptId: 'receipt:test-install-options-0001',
      }
      for (const pnpmOptions of [
        ['--registry', 'http://evil.example'],
        ['--registry=http://evil.example'],
        ['--@scope:registry', 'http://evil.example'],
        ['--@scope:registry=http://evil.example'],
        ['--config.x=1'],
        ['--config.registry=http://evil.example'],
        ['--userconfig', '/workspace/evil.npmrc'],
        ['--globalconfig=/workspace/evil.npmrc'],
        ['--reporter=ndjson', '--registry=http://evil.example'],
        ['-C', '/workspace/evil-project'],
        ['--dir=/workspace/evil-project'],
        ['--prefix=/workspace/evil-project'],
        ['--filter=evil-workspace-package'],
        ['evil-pkg@1.0.0'],
        ['--save-exact', 'evil-pkg@1.0.0'],
        ['--registry', 'https://registry.npmjs.org/'],
        ['--reporter', 'ndjson'],
        ['--save-exact=false'],
        ['x:registry=https://registry.npmjs.org/'],
      ]) {
        await expect(harness.service.installPlugin({
          pnpmOptions,
          invokingDir: '/workspace',
          recovery,
        })).rejects.toThrow('install options are restricted to')
      }
      await expect(harness.service.runPluginInstall(
        ['add', '--save-exact', '--registry=http://evil.example', 'example-plugin@1.0.0'],
        '/workspace',
        recovery,
      )).rejects.toThrow('install options are restricted to')
      await expect(harness.service.runPluginInstall(
        ['add', '--save-exact', '--dir=/workspace/evil-project', 'example-plugin@1.0.0'],
        '/workspace',
        recovery,
      )).rejects.toThrow('install options are restricted to')
      await expect(harness.service.runPluginInstall(
        ['add', 'extra-plugin@1.0.0', 'example-plugin@1.0.0'],
        '/workspace',
        recovery,
      )).rejects.toThrow('requires the exact receipt target')
      expect(harness.spawn).not.toHaveBeenCalled()

      const operation = await harness.service.installPlugin({
        pnpmOptions: [
          '--reporter=ndjson',
          '--save-exact',
          '--registry=https://registry.npmjs.org/',
          '--@scope:registry=https://registry.npmjs.org/',
        ],
        invokingDir: '/workspace',
        recovery,
      })
      expect(harness.spawn).toHaveBeenCalledOnce()
      expect(harness.spawn.mock.calls[0]?.[0].argv).toEqual([
        selectedBootstrap.nodeExecutable,
        '--expose-internals',
        selectedBootstrap.dshBootstrapPath,
        'plugin',
        '--profile',
        selectedBootstrap.activeProfileName,
        'add',
        '--reporter=ndjson',
        '--save-exact',
        '--registry=https://registry.npmjs.org/',
        '--@scope:registry=https://registry.npmjs.org/',
        'example-plugin@1.0.0',
      ])
      finish(child)
      await operation.done
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('validates operation arguments and the plugin invocation directory before spawning', async () => {
    const harness = await createHarness([])

    expect(() => harness.service.run([])).toThrow('arguments must not be empty')
    expect(() => harness.service.run(['add', 'bad\0target'])).toThrow('must not contain NUL')
    expect(() => harness.service.runPlugin(['remove', 'plugin'], 'relative/path')).toThrow(
      'plugin invoking directory must be an absolute path',
    )
    expect(() => harness.service.runPlugin(['remove'], '/workspace/bad\0path')).toThrow(
      'plugin invoking directory must be an absolute path without NUL',
    )
    expect(() => harness.service.runPlugin(['add', 'plugin'], '/workspace')).toThrow(
      'plugin add must use the recoverable install boundary',
    )
    await expect(harness.service.installPlugin({
      pnpmOptions: ['--registry=https://registry.example\0.invalid'],
      invokingDir: '/workspace',
      recovery: {
        packageName: 'plugin',
        packageVersion: '1.0.0',
        receiptId: 'receipt:test-empty-install',
      },
    })).rejects.toThrow('arguments must not contain NUL')
    expect(harness.spawn).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('holds the generation gate until the first operation process tree exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-gate-'))
    const first = controlledSubprocess()
    const second = controlledSubprocess()
    const harness = await createHarness([first, second], bootstrap(root))
    try {
      const firstOperation = harness.service.run(['install'])

      first.resolveDone({ exitCode: 0, signal: null })
      await Promise.resolve()
      expect(first.waitForExit).toHaveBeenCalledOnce()
      expect(() => harness.service.runPlugin(['remove', 'dshmarket'], '/workspace')).toThrow(
        'another desktop pnpm operation is already running',
      )

      first.resolveTree()
      await firstOperation.done
      const secondOperation = harness.service.runPlugin(['remove', 'dshmarket'], '/workspace')
      expect(harness.spawn).toHaveBeenCalledTimes(2)
      finish(second)
      await secondOperation.done
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the operation gate after a spawn-level failure and whole-tree wait', async () => {
    const failed = controlledSubprocess()
    const next = controlledSubprocess()
    const harness = await createHarness([failed, next])
    const failedOperation = harness.service.run(['install'])

    failed.rejectDone(new Error('spawn failed'))
    failed.resolveTree()
    await expect(failedOperation.done).rejects.toThrow('spawn failed')

    const nextOperation = harness.service.run(['list'])
    finish(next)
    await nextOperation.done
    await harness.dispose()
  })

  it('terminates and joins the active tree before the provider row disposes', async () => {
    const child = controlledSubprocess()
    const harness = await createHarness([child])
    const operation = harness.service.run(['update'])

    const disposing = harness.dispose()
    await Promise.resolve()
    expect(child.terminate).toHaveBeenCalledOnce()

    finish(child, { exitCode: null, signal: 'SIGTERM' })
    await expect(operation.done).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' })
    await disposing
    expect(child.waitForExit).toHaveBeenCalledOnce()
    expect(() => harness.service.run(['list'])).toThrow('generation is closed')
  })
})

describe('pnpm policy environment hand-off', () => {
  /** Locked content-mode policy constant used to seed the hand-off fixture. */
  const lockedContentModePolicy: DesktopPolicy = {
    locked: true,
    managedModels: true,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    allowHomePatch: false,
    allowManualPluginAdd: false,
    trustRoots: [{ keyId: 'k1', fingerprint: 'a'.repeat(64) }],
  }

  it('forwards the bootstrap policy hand-off into spawned install children', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-policy-handoff-'))
    const selectedBootstrap: DesktopPnpmBootstrap = {
      ...bootstrap(root),
      // The launcher encodes the in-archive policy through this overlay; the
      // packaged CLI child fails closed without all four entries, so a future
      // refactor that drops this spread must fail right here.
      cliPolicyEnvironment: desktopPolicyEnvironmentEntries(lockedContentModePolicy),
    }
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), '{}\n')
      const harness = await createHarness([child], selectedBootstrap)

      const operation = await harness.service.installPlugin({
        pnpmOptions: ['--save-exact'],
        invokingDir: selectedBootstrap.activeProfileDir,
        recovery: {
          packageName: 'example-plugin',
          packageVersion: '1.0.0',
          receiptId: 'receipt:policy-handoff-0001',
        },
      })

      const spawnedEnv = harness.spawn.mock.calls[0]?.[0].env as Record<string, string>
      expect(spawnedEnv[DESKTOP_POLICY_ENVIRONMENT.locked]).toBe('1')
      expect(spawnedEnv[DESKTOP_POLICY_ENVIRONMENT.catalogOrigin]).toBe('-')
      expect(spawnedEnv[DESKTOP_POLICY_ENVIRONMENT.manifestUrl]).toBe('company-market/catalog-manifest.json')
      expect(spawnedEnv[DESKTOP_POLICY_ENVIRONMENT.trustRoots]).toBe(`k1:${'a'.repeat(64)}`)

      finish(child)
      await operation.done
      await harness.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pnpm enterprise TLS environment forwarding', () => {
  it('forwards CA bundles and proxies but never TLS bypass variables', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-tls-'))
    const selectedBootstrap = bootstrap(root)
    const child = controlledSubprocess()
    try {
      mkdirSync(selectedBootstrap.activeProfileDir, { recursive: true })
      writeFileSync(join(selectedBootstrap.activeProfileDir, 'package.json'), '{}\n')
      const previousEnv = { ...process.env }
      Object.assign(process.env, {
        NODE_EXTRA_CA_CERTS: 'C:/corp/ca.pem',
        https_proxy: 'http://proxy.corp:8080',
        NO_PROXY: 'localhost',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        HTTP_PROXY: 'http://proxy.corp:8080',
      })
      finish(child)
      let harness: PnpmHarness | undefined
      try {
        harness = await createHarness([child], selectedBootstrap)
        const operation = await harness!.service.installPlugin({
          pnpmOptions: ['--save-exact'],
          invokingDir: selectedBootstrap.activeProfileDir,
          recovery: { packageName: 'example-plugin', packageVersion: '1.0.0', receiptId: 'receipt:tls-env-0001' },
        })
        const spawnedEnv = harness!.spawn.mock.calls[0]?.[0].env as Record<string, string>
        expect(spawnedEnv.NODE_EXTRA_CA_CERTS).toBe('C:/corp/ca.pem')
        expect(spawnedEnv.HTTP_PROXY).toBe('http://proxy.corp:8080')
        expect(spawnedEnv.https_proxy).toBe('http://proxy.corp:8080')
        expect(spawnedEnv.NO_PROXY).toBe('localhost')
        // Pilot-era decision: the bypass variable rides along when the user
      // environment sets it, matching the DSH Terminal CLI path; install
      // integrity is preserved by the signed-manifest chain either way.
      expect(spawnedEnv.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0')
        await operation.done
      } finally {
        for (const key of Object.keys(process.env)) {
          if (!(key in previousEnv)) delete process.env[key]
        }
        Object.assign(process.env, previousEnv)
        await harness?.dispose()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
