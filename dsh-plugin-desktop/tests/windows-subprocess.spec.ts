import { Buffer } from 'node:buffer'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import {
  adaptWindowsAclTerminalSpawn,
  desktopWindowsCommandPath,
  type WindowsAclTerminalAdaptation,
} from '../src/windows-subprocess.ts'
import {
  decodeWindowsAclRelay,
  encodeWindowsAclRelay,
  quotedWindowsRelayPath,
  removeWindowsAclRelayEnvironment,
  WINDOWS_ACL_RELAY_ELECTRON,
  WINDOWS_ACL_RELAY_PAYLOAD,
  WINDOWS_ACL_RELAY_TRAMPOLINE,
} from '../src/windows-acl-relay.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const commandPath = 'C:\\Windows\\System32\\cmd.exe'
const adaptation: WindowsAclTerminalAdaptation = {
  platform: 'win32',
  electron: true,
  execPath: 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
  upstreamRunner: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\runner.js',
  trampoline: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\windows-acl-runner.js',
  env: { SystemRoot: 'C:\\Windows' },
  isFile: path => path === commandPath,
}

function terminalSpec(argv: readonly string[], env?: Record<string, string>): SubprocessTerminalSpawnSpec {
  return {
    argv,
    cwd: 'C:\\工作区 & 100%!',
    env: env ?? { KEEP: 'value', electron_run_as_node: 'stale' },
    rows: 24,
    cols: 80,
    graceMs: 1_000,
  }
}

describe('Windows Electron persistent-terminal relay', () => {
  it('routes only the exact ACL runner through a cmd-owned ConPTY', () => {
    const args = [
      '--workspace',
      'C:\\工作区 & 100%!',
      '--',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '-NoLogo',
    ]
    const spec = terminalSpec([adaptation.execPath, adaptation.upstreamRunner, ...args])

    const result = adaptWindowsAclTerminalSpawn(spec, adaptation)

    expect(result).not.toBe(spec)
    expect(result.argv).toEqual([
      commandPath,
      '/d',
      '/q',
      '/v:off',
      '/s',
      '/c',
      `%${WINDOWS_ACL_RELAY_ELECTRON}%`,
      `%${WINDOWS_ACL_RELAY_TRAMPOLINE}%`,
    ])
    expect(result.argv.join(' ')).not.toContain('工作区')
    expect(result.argv.join(' ')).not.toContain('PowerShell')
    expect(result.env).toEqual(expect.objectContaining({
      KEEP: 'value',
      [RUN_AS_NODE]: '1',
      [WINDOWS_ACL_RELAY_ELECTRON]: `"${adaptation.execPath}"`,
      [WINDOWS_ACL_RELAY_TRAMPOLINE]: `"${adaptation.trampoline}"`,
    }))
    expect(result.env).not.toHaveProperty('electron_run_as_node')
    expect(decodeWindowsAclRelay(result.env?.[WINDOWS_ACL_RELAY_PAYLOAD] as string)).toEqual({
      version: 1,
      runner: adaptation.upstreamRunner,
      args,
    })
    expect(result.cwd).toBe(spec.cwd)
    expect(result.rows).toBe(spec.rows)
    expect(result.cols).toBe(spec.cols)
    expect(result.graceMs).toBe(spec.graceMs)
    expect(spec.env).toEqual({ KEEP: 'value', electron_run_as_node: 'stale' })
  })

  it.each([
    ['plain Node', { electron: false }, undefined],
    ['non-Windows', { platform: 'darwin' as const }, undefined],
    ['different Electron', { execPath: 'C:\\other\\electron.exe' }, undefined],
    ['different runner', { upstreamRunner: 'C:\\other\\runner.js' }, undefined],
    ['direct PowerShell', {}, ['powershell.exe', '-NoLogo']],
  ])('leaves a %s terminal spec unchanged', (_label, override, argv) => {
    const spec = terminalSpec(argv ?? [adaptation.execPath, adaptation.upstreamRunner, '--'])

    const result = adaptWindowsAclTerminalSpawn(spec, { ...adaptation, ...override })

    expect(result).toBe(spec)
  })

  it('removes inherited relay values case-insensitively before installing its own payload', () => {
    const spec = terminalSpec([adaptation.execPath, adaptation.upstreamRunner, '--', 'powershell.exe'], {
      dsh_desktop_acl_relay_v1: 'forged',
      Dsh_Desktop_Acl_Electron: 'forged',
      dsh_desktop_acl_trampoline: 'forged',
      electron_run_as_node: 'forged',
    })

    const result = adaptWindowsAclTerminalSpawn(spec, adaptation)

    expect(result.env).not.toHaveProperty('dsh_desktop_acl_relay_v1')
    expect(result.env).not.toHaveProperty('Dsh_Desktop_Acl_Electron')
    expect(result.env).not.toHaveProperty('dsh_desktop_acl_trampoline')
    expect(result.env).not.toHaveProperty('electron_run_as_node')
    expect(result.env?.[RUN_AS_NODE]).toBe('1')
    expect(decodeWindowsAclRelay(result.env?.[WINDOWS_ACL_RELAY_PAYLOAD] as string).args)
      .toEqual(['--', 'powershell.exe'])
  })
})

describe('Windows ACL relay protocol', () => {
  it('round-trips Unicode and shell metacharacters without command interpolation', () => {
    const encoded = encodeWindowsAclRelay('C:\\程序\\runner.js', [
      'C:\\space & percent% bang! caret^\\目录',
      'single\'quote',
      '',
    ])

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(decodeWindowsAclRelay(encoded)).toEqual({
      version: 1,
      runner: 'C:\\程序\\runner.js',
      args: ['C:\\space & percent% bang! caret^\\目录', 'single\'quote', ''],
    })
  })

  it.each([
    ['', 'canonical Base64URL'],
    ['***', 'canonical Base64URL'],
    [Buffer.from('{', 'utf8').toString('base64url'), 'valid JSON'],
    [Buffer.from(JSON.stringify({ version: 2, runner: 'runner.js', args: [] }), 'utf8').toString('base64url'), 'unsupported shape or version'],
    [Buffer.from(JSON.stringify({ version: 1, runner: '', args: [] }), 'utf8').toString('base64url'), 'non-empty NUL-free string'],
    [Buffer.from(JSON.stringify({ version: 1, runner: 'runner.js', args: [1] }), 'utf8').toString('base64url'), 'NUL-free string'],
  ])('rejects invalid payload %#', (encoded, message) => {
    expect(() => decodeWindowsAclRelay(encoded)).toThrow(message)
  })

  it('validates relay paths before quoting them', () => {
    expect(quotedWindowsRelayPath('C:\\Program Files\\DSH\\app.exe', 'app'))
      .toBe('"C:\\Program Files\\DSH\\app.exe"')
    expect(() => quotedWindowsRelayPath('relative\\app.exe', 'app')).toThrow('absolute Windows path')
    expect(() => quotedWindowsRelayPath('C:\\bad"path\\app.exe', 'app')).toThrow('without quotes')
    expect(() => quotedWindowsRelayPath('C:\\bad\npath\\app.exe', 'app')).toThrow('control characters')
  })

  it('removes every relay environment key case-insensitively', () => {
    const env = {
      dsh_desktop_acl_relay_v1: 'payload',
      Dsh_Desktop_Acl_Electron: 'electron',
      dsh_desktop_acl_trampoline: 'trampoline',
      KEEP: 'value',
    }

    removeWindowsAclRelayEnvironment(env)

    expect(env).toEqual({ KEEP: 'value' })
  })
})

describe('Windows cmd.exe resolution', () => {
  it('resolves only the regular System32 command interpreter', () => {
    expect(desktopWindowsCommandPath({ systemroot: 'C:\\Windows', ComSpec: 'D:\\fake.cmd' }, 'win32', path => path === commandPath))
      .toBe(commandPath)
  })

  it('does not resolve cmd.exe off Windows', () => {
    expect(desktopWindowsCommandPath({}, 'darwin', () => true)).toBeUndefined()
  })

  it.each([
    [{}, 'requires SystemRoot'],
    [{ SystemRoot: 'relative' }, 'absolute Windows path'],
    [{ SystemRoot: 'C:\\bad"root' }, 'without quotes'],
    [{ SystemRoot: 'C:\\missing' }, 'not a regular file'],
  ])('fails closed for an invalid system root %#', (env, message) => {
    expect(() => desktopWindowsCommandPath(env, 'win32', () => false)).toThrow(message)
  })
})
