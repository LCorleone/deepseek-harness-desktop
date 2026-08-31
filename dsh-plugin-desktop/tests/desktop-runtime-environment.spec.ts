import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter as pathDelimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
  type DesktopPnpmRuntimeOptions,
} from '../src/desktop-runtime-environment.ts'
import { desktopPolicyEnvironmentEntries } from '../src/desktop-policy.ts'
import type { DesktopPolicy } from '../src/desktop-policy.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

function options(
  stateDir: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): DesktopPnpmRuntimeOptions {
  return {
    platform,
    nodeExecutable: platform === 'win32'
      ? 'C:\\Program Files\\DSH 100% Desktop\\resources\\node-runtime\\node.exe'
      : "/Applications/DSH O'Brien.app/Contents/Resources/node-runtime/node",
    pnpmBinPath: platform === 'win32'
      ? 'C:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\pnpm\\bin\\pnpm.mjs'
      : "/Applications/DSH O'Brien.app/Contents/Resources/app.asar.unpacked/node_modules/pnpm/bin/pnpm.mjs",
    electronVersion: '43.4.0',
    stateDir,
    environment,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('desktop Host pnpm runtime', () => {
  it.each(['darwin', 'linux'] as const)('creates a pnpm-only public PATH on %s', (platform) => {
    const stateDir = join(temporaryDirectory(), 'runtime state')
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      KEEP: 'value',
      npm_config_runtime: 'inherited-runtime',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, platform, environment))

    expect(readdirSync(installation.pathDir)).toEqual(['pnpm'])
    expect(readdirSync(installation.nodeBinDir)).toEqual(['node'])
    if (process.platform !== 'win32') {
      expect(lstatSync(stateDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.pathDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.nodeBinDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.pnpmShimPath).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.nodeShimPath).mode & 0o777).toBe(0o700)
    }

    const pnpm = readFileSync(installation.pnpmShimPath, 'utf8')
    expect(pnpm).toContain(`PATH='${installation.nodeBinDir}':"\${PATH:-}"`)
    expect(pnpm).toContain(`NODE='${installation.nodeShimPath}'`)
    expect(pnpm).toContain('npm_config_runtime=electron')
    expect(pnpm).toContain("npm_config_target='43.4.0'")
    expect(pnpm).toContain("npm_config_disturl='https://electronjs.org/headers'")
    expect(pnpm).not.toContain('ELECTRON_RUN_AS_NODE')
    const node = readFileSync(installation.nodeShimPath, 'utf8')
    expect(node).toBe([
      '#!/bin/sh',
      `exec '/Applications/DSH O'"'"'Brien.app/Contents/Resources/node-runtime/node' "$@"`,
      '',
    ].join('\n'))
    expect(node).not.toContain('--import')
    expect(node).not.toContain('npm_config_')
    expect(node).not.toContain('--import')

    expect(environment).toEqual({
      ...original,
      PATH: `${installation.pathDir}:/usr/local/bin:/usr/bin:/bin`,
    })
    if (process.platform !== 'win32') {
      expect(spawnSync('/bin/sh', ['-n', installation.pnpmShimPath]).status).toBe(0)
      expect(spawnSync('/bin/sh', ['-n', installation.nodeShimPath]).status).toBe(0)
    }

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('keeps recovered login-shell PATH beneath the Desktop runtime PATH', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const recoveredPath = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin'
    const environment: NodeJS.ProcessEnv = {
      PATH: recoveredPath,
      KEEP: 'value',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(environment.PATH).toBe(`${installation.pathDir}:${recoveredPath}`)
    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('generates shims that never enable Electron node mode', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    for (const shim of [
      readFileSync(installation.pnpmShimPath, 'utf8'),
      readFileSync(installation.nodeShimPath, 'utf8'),
    ]) {
      expect(shim).not.toContain('ELECTRON_RUN_AS_NODE')
      expect(shim).not.toContain('electron_run_as_node')
      expect(shim).not.toContain('--import')
    }
    installation.dispose()
  })

  it('scopes Electron ABI settings to the pnpm process tree', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.json')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.argv[2], JSON.stringify({',
      "  runAsNode: Object.keys(process.env).filter(name => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE'),",
      '  runtime: process.env.npm_config_runtime,',
      '  target: process.env.npm_config_target,',
      '  disturl: process.env.npm_config_disturl,',
      '  node: process.env.NODE,',
      '  path: process.env.PATH,',
      '}))',
      '',
    ].join('\n'))
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    const installation = installDesktopPnpmRuntime({
      ...options(stateDir, platform, environment),
      nodeExecutable: process.execPath,
      pnpmBinPath: captureEntry,
    })

    const command = process.platform === 'win32'
      ? process.env.ComSpec ?? 'cmd.exe'
      : installation.pnpmShimPath
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', `""${installation.pnpmShimPath}" "${captureOutput}""`]
      : [captureOutput]
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: process.platform === 'win32',
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(JSON.parse(readFileSync(captureOutput, 'utf8'))).toEqual({
      runAsNode: [],
      runtime: 'electron',
      target: '43.4.0',
      disturl: 'https://electronjs.org/headers',
      node: installation.nodeShimPath,
      path: `${installation.nodeBinDir}${pathDelimiter}${environment.PATH ?? ''}`,
    })
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('npm_config_runtime')
    installation.dispose()
  })

  it('creates Windows batch shims without publishing the private Node directory', () => {
    const stateDir = join(temporaryDirectory(), 'runtime-state')
    const environment: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\System32;C:\\Windows',
      KEEP: 'value',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'win32', environment))

    expect(readdirSync(installation.pathDir)).toEqual(['pnpm.cmd'])
    expect(readdirSync(installation.nodeBinDir)).toEqual(['node.cmd'])
    const pnpm = readFileSync(installation.pnpmShimPath, 'utf8')
    expect(pnpm).toContain(`set "PATH=${installation.nodeBinDir};%PATH%"`)
    expect(pnpm).toContain(`set "NODE=${installation.nodeShimPath}"`)
    expect(pnpm).toContain('set "npm_config_runtime=electron"')
    expect(pnpm).toContain('set "npm_config_target=43.4.0"')
    expect(pnpm).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(pnpm).not.toContain('--import')
    const node = readFileSync(installation.nodeShimPath, 'utf8')
    expect(node).not.toContain('ELECTRON_RUN_AS_NODE')
    expect(node).not.toContain('--import')
    expect(node).not.toContain('npm_config_')

    expect(environment).toEqual({
      Path: `${installation.pathDir};C:\\Windows\\System32;C:\\Windows`,
      KEEP: 'value',
    })
    expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(environment).not.toHaveProperty('npm_config_runtime')

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('removes only its own PATH component when another owner changes PATH later', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const originalPath = process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin'
    const laterPath = process.platform === 'win32' ? 'C:\\later' : '/later/bin'
    const environment: NodeJS.ProcessEnv = { PATH: originalPath }
    const installation = installDesktopPnpmRuntime(options(stateDir, platform, environment))
    environment.PATH = `${laterPath}${pathDelimiter}${environment.PATH ?? ''}`

    installation.dispose()
    installation.dispose()

    expect(environment).toEqual({ PATH: `${laterPath}${pathDelimiter}${originalPath}` })
  })

  it('does not duplicate or later remove a PATH component another owner supplied', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const pathDir = join(stateDir, 'bin')
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const originalPath = process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin'
    const environment: NodeJS.ProcessEnv = { PATH: `${pathDir}${pathDelimiter}${originalPath}` }
    const installation = installDesktopPnpmRuntime(options(stateDir, platform, environment))

    expect(environment.PATH).toBe(`${pathDir}${pathDelimiter}${originalPath}`)
    installation.dispose()
    expect(environment.PATH).toBe(`${pathDir}${pathDelimiter}${originalPath}`)
  })

  it('rejects symlinked state directories before changing PATH', () => {
    const root = temporaryDirectory()
    const target = join(root, 'target')
    const stateDir = join(root, 'runtime')
    mkdirSync(target)
    symlinkSync(target, stateDir)
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    expect(() => installDesktopPnpmRuntime(options(stateDir, 'linux', environment)))
      .toThrow('not a private directory')
    expect(environment).toEqual({ PATH: '/usr/bin' })
  })

  it('rejects a symlinked generated file before changing PATH', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const pathDir = join(stateDir, 'bin')
    const privateDir = join(stateDir, 'private')
    const nodeBinDir = join(privateDir, 'node-bin')
    mkdirSync(pathDir, { recursive: true })
    mkdirSync(nodeBinDir, { recursive: true })
    const target = join(root, 'outside')
    writeFileSync(target, 'outside')
    symlinkSync(target, join(pathDir, 'pnpm'))
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    expect(() => installDesktopPnpmRuntime(options(stateDir, 'linux', environment)))
      .toThrow('not a regular file')
    expect(readFileSync(target, 'utf8')).toBe('outside')
    expect(environment).toEqual({ PATH: '/usr/bin' })
  })

  it('recovers from stray command files instead of failing startup', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const pathDir = join(stateDir, 'bin')
    const nodeBinDir = join(stateDir, 'private', 'node-bin')
    mkdirSync(pathDir, { recursive: true })
    mkdirSync(nodeBinDir, { recursive: true })
    writeFileSync(join(pathDir, 'dsh'), 'stray')
    writeFileSync(join(nodeBinDir, 'dsh'), 'stray')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(readdirSync(pathDir)).toEqual(['pnpm'])
    expect(readdirSync(nodeBinDir)).toEqual(['node'])
    expect(environment.PATH).toBe(`${pathDir}:/usr/bin`)
    expect(stderr).toHaveBeenCalledTimes(2)
    installation.dispose()
  })

  it('removes stray symlinks without touching their targets', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const pathDir = join(stateDir, 'bin')
    mkdirSync(pathDir, { recursive: true })
    const target = join(root, 'outside')
    writeFileSync(target, 'outside')
    symlinkSync(target, join(pathDir, 'dsh'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', { PATH: '/usr/bin' }))

    expect(readdirSync(pathDir)).toEqual(['pnpm'])
    expect(readFileSync(target, 'utf8')).toBe('outside')
    expect(stderr).toHaveBeenCalledOnce()
    installation.dispose()
  })

  it('refuses an unexpected directory in the public command directory', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const pathDir = join(stateDir, 'bin')
    mkdirSync(join(pathDir, 'dsh'), { recursive: true })
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    expect(() => installDesktopPnpmRuntime(options(stateDir, 'linux', environment)))
      .toThrow('contains an unexpected directory: dsh')
    expect(environment).toEqual({ PATH: '/usr/bin' })
  })

  it('removes only strictly named stale atomic files before validating commands', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const pathDir = join(stateDir, 'bin')
    mkdirSync(pathDir, { recursive: true })
    const stale = join(pathDir, '.pnpm.123.123e4567-e89b-12d3-a456-426614174000.tmp')
    writeFileSync(stale, 'partial')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(readdirSync(pathDir)).toEqual(['pnpm'])
    installation.dispose()
  })

  it('fails loud for unsupported platforms and unsafe generated values', () => {
    const root = temporaryDirectory()
    expect(() => installDesktopPnpmRuntime(options(join(root, 'runtime'), 'aix', { PATH: '/usr/bin' })))
      .toThrow('unsupported on aix')
    expect(() => installDesktopPnpmRuntime({
      ...options(join(root, 'newline-runtime'), 'linux', { PATH: '/usr/bin' }),
      electronVersion: '43.4.0\nmalicious',
    })).toThrow('must not contain NUL or newlines')
  })
})

describe('desktop Host dsh runtime', () => {
  it('bakes the policy environment hand-off into the generated dsh command', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    // Built exactly like production (main.ts): a content-mode policy encoded
    // through desktopPolicyEnvironmentEntries, so the absent-origin sentinel
    // — not a raw empty string, which a Windows `set "VAR="` line deletes —
    // is what reaches the batch shim.
    const contentModePolicy: DesktopPolicy = {
      locked: true,
      managedModels: true,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
      allowHomePatch: false,
      allowManualPluginAdd: false,
      trustRoots: [{
        keyId: 'company-2026-a',
        fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }],
    }

    const installation = installDesktopDshRuntime({
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\DSH Desktop\\resources\\node-runtime\\node.exe',
      dshBootstrapPath: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\lib\\desktop-cli.js',
      cliPolicyEnvironment: desktopPolicyEnvironmentEntries(contentModePolicy),
      profileName: 'desktop',
      homeDir: join(root, 'home'),
      installRecoveryStatePath: join(root, 'state.json'),
      stateDir,
      environment: { PATH: '/usr/bin' },
    })

    const shim = readFileSync(installation.dshShimPath, 'utf8')
    expect(shim).toContain('set "DSH_DESKTOP_POLICY_LOCKED=1"')
    expect(shim).toContain('set "DSH_DESKTOP_POLICY_MANAGED_MODELS=1"')
    // The sentinel survives the batch `set` line (an empty value would delete
    // the variable and leave the CLI child without its policy hand-off).
    expect(shim).toContain('set "DSH_DESKTOP_POLICY_CATALOG_ORIGIN=-"')
    expect(shim).toContain('set "DSH_DESKTOP_POLICY_MANIFEST_URL=company-market/catalog-manifest.json"')
    expect(shim).toContain(
      'set "DSH_DESKTOP_POLICY_TRUST_ROOTS=company-2026-a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    )
    // Values the batch escaper rejects fail loud instead of reaching the shim.
    expect(() => installDesktopDshRuntime({
      platform: 'win32',
      nodeExecutable: 'C:\\node.exe',
      dshBootstrapPath: 'C:\\desktop-cli.js',
      cliPolicyEnvironment: { DSH_DESKTOP_POLICY_LOCKED: '"injected"' },
      profileName: 'desktop',
      homeDir: join(root, 'home'),
      installRecoveryStatePath: join(root, 'state.json'),
      stateDir: join(root, 'unsafe'),
      environment: { PATH: '/usr/bin' },
    })).toThrow('must not contain quotes or newlines')
  })

  it.runIf(process.platform === 'win32')('makes the active profile available to Host plugin child processes', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.json')
    const homeDir = join(root, 'Harness home')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.argv[2], JSON.stringify({',
      '  args: process.argv.slice(3),',
      '  defaultProfile: process.env.DSH_DESKTOP_DEFAULT_PROFILE,',
      '  home: process.env.DSH_HOME,',
      '  installRecoveryStatePath: process.env.DSH_DESKTOP_INSTALL_RECOVERY_STATE_PATH,',
      '}))',
      '',
    ].join('\n'))
    const environment: NodeJS.ProcessEnv = { Path: process.env.PATH }
    const original = { ...environment }

    const installation = installDesktopDshRuntime({
      platform: 'win32',
      nodeExecutable: process.execPath,
      dshBootstrapPath: captureEntry,
      profileName: 'web',
      homeDir,
      installRecoveryStatePath: join(root, 'plugin-install-recovery', 'state.json'),
      stateDir,
      environment,
    })
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `dsh "${captureOutput}" --probe`,
    ], {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: true,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readdirSync(installation.pathDir)).toEqual(['dsh.cmd'])
    expect(JSON.parse(readFileSync(captureOutput, 'utf8'))).toEqual({
      args: ['--probe'],
      defaultProfile: 'web',
      home: homeDir,
      installRecoveryStatePath: join(root, 'plugin-install-recovery', 'state.json'),
    })
    expect(environment.Path).toBe(`${installation.pathDir};${original.Path ?? ''}`)

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })
})
