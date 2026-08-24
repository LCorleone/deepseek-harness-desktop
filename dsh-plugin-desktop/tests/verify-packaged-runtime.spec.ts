import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import {
  afterPack,
  BUNDLED_NODE_RESOURCE_DIRECTORY,
  REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES,
  REQUIRED_ELECTRON_FUSES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_RUN_AS_NODE_FUSE,
  REQUIRED_UNPACKED_PACKAGE_SPECIFIERS,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolveBundledNodeResourcePath,
  resolvePackagedAsarPath,
  resolvePackagedResourcesDirectory,
  resolvePackagedUnpackedRoot,
  readPackagedElectronFuses,
  readPackagedRunAsNodeFuse,
  smokePackagedDiagnosticWorker,
  verifyArchiveOnlyPartition,
  verifyBundledNodeRuntime,
  verifyElectronFuseStage,
  verifyRunAsNodeFuseStage,
  verifyUnpackedArchiveMirror,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type PackageResolver,
  type PackagedRuntimeContext,
  type PackagedDiagnosticWorkerLauncher,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_UNIVERSAL_ENTRIES } from '../scripts/mac-universal.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'DSH Desktop' } },
  }
}

function completeArchiveEntries(separator = '/'): string[] {
  return [
    ...REQUIRED_PACKAGED_RUNTIME_ENTRIES,
    ...REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES,
  ].map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

function completePackageResolver(unpackedRoot: string): PackageResolver {
  return specifier => join(unpackedRoot, 'resolved', `${specifier.replaceAll('/', '-')}.js`)
}

/** File probe for success paths: everything physical except the archive-only assets. */
function completeFileProbe(unpackedRoot: string): FileProbe {
  return filename => !REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES
    .some(entry => filename === join(unpackedRoot, entry))
}

describe('packaged desktop runtime verification', () => {
  it('fails the diagnostic Worker smoke when its archive omits the crash dump', async () => {
    const unpackedRoot = resolvePackagedUnpackedRoot(context('/build', 'win32'))
    const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (_workerPath, workerData) => {
      const outDir = join(workerData.userDataDir, 'diagnostics')
      mkdirSync(outDir)
      const output = join(outDir, 'diagnostics-smoke.zip')
      const zip = new AdmZip()
      zip.addFile('system-info.txt', Buffer.from('no dump\n'))
      zip.writeZip(output)
      return output
    })

    await expect(smokePackagedDiagnosticWorker(unpackedRoot, launch))
      .rejects.toThrow('packaged diagnostic worker omitted crash-dumps/pending/packaged-smoke.dmp')
  })

  it.each(['darwin', 'win32'])(
    'targets the physical diagnostic Worker in the %s unpacked layout and removes smoke files',
    async (platform) => {
      const unpackedRoot = resolvePackagedUnpackedRoot(context('/build', platform))
      let smokeRoot: string | undefined
      const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (workerPath, workerData) => {
        smokeRoot = join(workerData.logsDir, '..')
        expect(workerPath).toBe(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'))
        expect(readFileSync(join(workerData.logsDir, 'dsh-2000-01-01.log'), 'utf8'))
          .toBe('packaged worker smoke\n')
        expect(workerData.appVersion).toBe('packaged-smoke')
        expect(workerData.maxEvidenceBytes).toBe(1024)
        const crashDump = readFileSync(join(workerData.crashDumpsDir, 'pending', 'packaged-smoke.dmp'))
        expect(crashDump.toString('utf8')).toBe('packaged crash dump smoke\n')
        const outDir = join(workerData.userDataDir, 'diagnostics')
        mkdirSync(outDir)
        const output = join(outDir, 'diagnostics-smoke.zip')
        const zip = new AdmZip()
        zip.addFile('crash-dumps/pending/packaged-smoke.dmp', crashDump)
        zip.writeZip(output)
        return output
      })

      await smokePackagedDiagnosticWorker(unpackedRoot, launch)

      expect(launch).toHaveBeenCalledOnce()
      expect(smokeRoot).toBeDefined()
      expect(existsSync(smokeRoot as string)).toBe(false)
    },
  )

  it('runs the static, bundled-Node, and fuse gates before the diagnostic Worker smoke', async () => {
    const runtimeContext = context('/build', 'win32')
    const calls: string[] = []

    await afterPack(
      runtimeContext,
      () => { calls.push('static') },
      async (unpackedRoot) => { calls.push(unpackedRoot) },
      {
        exists: filename => {
          calls.push(filename)
          return true
        },
        readFuses: () => {
          calls.push('fuse')
          return REQUIRED_ELECTRON_FUSES
        },
      },
    )

    expect(calls).toEqual([
      'static',
      join('/build', 'resources', BUNDLED_NODE_RESOURCE_DIRECTORY, 'node.exe'),
      'fuse',
      resolvePackagedUnpackedRoot(runtimeContext),
    ])
  })

  it('requires the bundled Node command beside the packaged app.asar', () => {
    const runtimeContext = context('/build', 'win32')
    const nodePath = resolveBundledNodeResourcePath(runtimeContext)

    expect(nodePath).toBe(join('/build', 'resources', 'node-runtime', 'node.exe'))
    expect(resolveBundledNodeResourcePath(context('/build', 'darwin')))
      .toBe(join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'node-runtime', 'node'))
    expect(resolvePackagedResourcesDirectory(runtimeContext)).toBe(join('/build', 'resources'))
    expect(() => verifyBundledNodeRuntime(runtimeContext, () => false))
      .toThrow(`missing the bundled Node command: ${nodePath}`)
    expect(verifyBundledNodeRuntime(runtimeContext, filename => filename === nodePath)).toBe(nodePath)
  })

  it('reads and enforces the staged Electron fuse map', () => {
    expect(REQUIRED_ELECTRON_FUSES).toEqual({
      runAsNode: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    })
    expect(REQUIRED_RUN_AS_NODE_FUSE).toBe(false)
    expect(() => verifyElectronFuseStage(REQUIRED_ELECTRON_FUSES)).not.toThrow()
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, runAsNode: true }))
      .toThrow('requires electronFuses.runAsNode=false')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, enableEmbeddedAsarIntegrityValidation: false }))
      .toThrow('requires electronFuses.enableEmbeddedAsarIntegrityValidation=true')
    expect(() => verifyElectronFuseStage({ ...REQUIRED_ELECTRON_FUSES, onlyLoadAppFromAsar: false }))
      .toThrow('requires electronFuses.onlyLoadAppFromAsar=true')
    // The P3-1 single-fuse verifier keeps its contract for direct callers.
    expect(() => verifyRunAsNodeFuseStage(REQUIRED_RUN_AS_NODE_FUSE)).not.toThrow()
    expect(() => verifyRunAsNodeFuseStage(!REQUIRED_RUN_AS_NODE_FUSE))
      .toThrow(`requires electronFuses.runAsNode=${String(REQUIRED_RUN_AS_NODE_FUSE)}`)

    // The live Electron Builder configuration wins over the repository manifest.
    const configured = { runAsNode: true, onlyLoadAppFromAsar: false }
    expect(readPackagedElectronFuses({
      appInfo: { productFilename: 'DSH Desktop' },
      config: { electronFuses: configured },
    })).toEqual(configured)
    expect(readPackagedRunAsNodeFuse({
      appInfo: { productFilename: 'DSH Desktop' },
      config: { electronFuses: configured },
    })).toBe(true)

    // Without a live configuration the repository manifest is the fallback.
    const root = mkdtempSync(join(tmpdir(), 'dsh-fuse-stage-'))
    try {
      const manifestPath = join(root, 'package.json')
      writeFileSync(
        manifestPath,
        JSON.stringify({ build: { electronFuses: REQUIRED_ELECTRON_FUSES } }),
      )
      const readManifest = () => readFileSync(manifestPath, 'utf8')
      expect(readPackagedElectronFuses(
        { appInfo: { productFilename: 'DSH Desktop' } },
        readManifest,
      )).toEqual(REQUIRED_ELECTRON_FUSES)
      expect(readPackagedRunAsNodeFuse(
        { appInfo: { productFilename: 'DSH Desktop' } },
        readManifest,
      )).toBe(REQUIRED_RUN_AS_NODE_FUSE)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tracks the ConPTY-only native surface shipped by node-pty 1.2', () => {
    expect(REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES).toEqual([
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    ])
  })

  it.each([
    [
      'darwin',
      join('/build', 'DSH Desktop.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries(platform === 'win32' ? '\\' : '/'))

    const unpackedRoot = `${expectedPath}.unpacked`
    const exists = vi.fn<FileProbe>(completeFileProbe(unpackedRoot))
    const resolvePackage = vi.fn<PackageResolver>(completePackageResolver(unpackedRoot))

    verifyPackagedRuntime(context('/build', platform), list, exists, resolvePackage)

    expect(resolvePackagedAsarPath(context('/build', platform))).toBe(expectedPath)
    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(unpackedRoot)
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + (platform === 'win32' ? REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES.length : 0)
        + REQUIRED_PACKAGED_RUNTIME_ENTRIES.length
        + REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES.length,
    )
    expect(resolvePackage.mock.calls.map(([specifier]) => specifier))
      .toEqual(REQUIRED_UNPACKED_PACKAGE_SPECIFIERS)
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('requires both CPU variants from a universal macOS runtime', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missing = 'node_modules/@vscode/ripgrep-darwin-x64/bin/rg'

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== join(unpackedRoot, missing),
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)

    const exists = vi.fn<FileProbe>(filename => !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
      .some(entry => filename === join(unpackedRoot, entry))
      && !REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES
        .some(entry => filename === join(unpackedRoot, entry)))
    verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      exists,
      completePackageResolver(unpackedRoot),
    )
    expect(exists).toHaveBeenCalledTimes(
      REQUIRED_UNPACKED_RUNTIME_ENTRIES.length
        + REQUIRED_MACOS_UNIVERSAL_ENTRIES.length
        + FORBIDDEN_MACOS_UNIVERSAL_ENTRIES.length
        + REQUIRED_PACKAGED_RUNTIME_ENTRIES.length
        + REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES.length,
    )
  })

  it('rejects any ASAR-declared unpacked dependency missing from the physical tree', () => {
    const unpackedRoot = join('/build', 'resources', 'app.asar.unpacked')
    const missing = 'node_modules/yaml/dist/index.js'

    expect(() => verifyUnpackedArchiveMirror(
      new Set(['lib/main.js', missing, 'node_modules/zod/index.js']),
      unpackedRoot,
      filename => filename !== join(unpackedRoot, missing),
    )).toThrow(`missing ASAR-declared physical entries: ${missing}`)
  })

  it('keeps archive-only build assets out of the physical mirror requirement', () => {
    const unpackedRoot = join('/build', 'resources', 'app.asar.unpacked')

    // build/** entries — including the bare `build` directory header entry —
    // are in-archive only; the mirror must not demand them physically, and
    // the partition must reject a leaked physical copy.
    expect(() => verifyUnpackedArchiveMirror(
      new Set(['build', 'build/app-icon.png', 'build/tray-iconTemplate.png', 'lib/main.js']),
      unpackedRoot,
      filename => filename === join(unpackedRoot, 'lib', 'main.js'),
    )).not.toThrow()

    expect(() => verifyArchiveOnlyPartition(
      unpackedRoot,
      filename => filename === join(unpackedRoot, 'build', 'app-icon.png'),
    )).toThrow('archive-only runtime entries leaked into the physical tree')
  })

  it('rejects a shrunk archive-only asset that reappears inside app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const leaked = REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES[0]

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, leaked)
        || !REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES
          .some(entry => filename === join(unpackedRoot, entry)),
      completePackageResolver(unpackedRoot),
    )).toThrow(`archive-only runtime entries leaked into the physical tree at ${unpackedRoot}: ${leaked}`)
  })

  it('rejects a host-architecture node-pty build from a universal app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const forbidden = FORBIDDEN_MACOS_UNIVERSAL_ENTRIES[0]

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, forbidden)
        || !FORBIDDEN_MACOS_UNIVERSAL_ENTRIES
          .some(entry => filename === join(unpackedRoot, entry)),
      completePackageResolver(unpackedRoot),
    )).toThrow(`contains host-architecture build output: ${forbidden}`)
  })

  it.each([
    'lib/client.js',
    'lib/desktop-runtime-environment.js',
    'lib/profile-service.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/pnpm.js',
    'lib/update-download.js',
    'lib/windows-agent-presets.js',
  ])('fails loud when required runtime entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it.each([...REQUIRED_ARCHIVE_ONLY_RUNTIME_ENTRIES])(
    'fails loud when archive-only entry %s is absent from app.asar',
    (missing) => {
      const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

      expect(() => verifyPackagedRuntime(context('/build', 'win32'), () => entries, () => false))
        .toThrow(`missing required ASAR entries: ${missing}`)
    },
  )

  it.each([
    'package.json',
    'lib/terminal.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/update-download.js',
    'lib/windows-agent-presets.js',
    'node_modules/@deepseek-ai/dsh/lib/bin.js',
    'node_modules/pnpm/bin/pnpm.mjs',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  ])('fails loud when physical runtime entry %s is absent from app.asar.unpacked', (missing) => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const missingPath = join(unpackedRoot, missing)

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename !== missingPath,
      completePackageResolver(unpackedRoot),
    )).toThrow(`missing required physical entries: ${missing}`)
  })

  it('requires the physical Cordis preset and its bundled skills', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const requiredPresetEntries = [
      'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/agent.cordis.yml',
      'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/cordis-plugin-development/SKILL.md',
      'node_modules/@deepseek-ai/dsh/config/agent-presets/cordis/skills/editing-cordis-compositions/SKILL.md',
    ]

    for (const missing of requiredPresetEntries) {
      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => completeArchiveEntries(),
        filename => filename !== join(unpackedRoot, missing),
        completePackageResolver(unpackedRoot),
      )).toThrow(`missing required physical entries: ${missing}`)
    }
  })

  it('fails loud when a required package export cannot resolve from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === 'dsh-plugin-desktop/profiles') {
        throw new Error('missing export')
      }
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      completeFileProbe(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export dsh-plugin-desktop/profiles`,
    )
  })

  it('fails loud when schemastery is absent from app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const specifier = '@deepseek-ai/schemastery/package.json'
    const resolvePackage = vi.fn<PackageResolver>((requested) => {
      if (requested === specifier) throw new Error('missing package')
      return completePackageResolver(unpackedRoot)(requested)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      completeFileProbe(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `packaged runtime at ${unpackedRoot} cannot resolve required package export ${specifier}`,
    )
  })

  it('fails loud when a required package export escapes app.asar.unpacked', () => {
    const runtimeContext = context('/build', 'win32')
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const escapedPath = join('/workspace', 'node_modules', '@deepseek-ai', 'dsh-base', 'lib', 'index.js')
    const resolvePackage = vi.fn<PackageResolver>((specifier) => {
      if (specifier === '@deepseek-ai/dsh-base/package.json') return escapedPath
      return completePackageResolver(unpackedRoot)(specifier)
    })

    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      completeFileProbe(unpackedRoot),
      resolvePackage,
    )).toThrow(
      `required package export @deepseek-ai/dsh-base/package.json resolved outside ${unpackedRoot}: ${escapedPath}`,
    )
  })
})
