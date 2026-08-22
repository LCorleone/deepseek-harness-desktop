/** Electron adapter for terminal processes confined by the upstream Windows ACL sandbox. */

import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { win32 } from 'node:path'
import type {
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { WindowsAclAdaptation } from './windows-pwsh-sandbox.ts'
import {
  encodeWindowsAclRelay,
  quotedWindowsRelayPath,
  removeWindowsAclRelayEnvironment,
  WINDOWS_ACL_RELAY_ELECTRON,
  WINDOWS_ACL_RELAY_PAYLOAD,
  WINDOWS_ACL_RELAY_TRAMPOLINE,
} from './windows-acl-relay.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const UPSTREAM_RUNNER = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
const DESKTOP_TRAMPOLINE = fileURLToPath(new URL('./windows-acl-runner.js', import.meta.url))
const CMD_VARIABLE_ELECTRON = `%${WINDOWS_ACL_RELAY_ELECTRON}%`
const CMD_VARIABLE_TRAMPOLINE = `%${WINDOWS_ACL_RELAY_TRAMPOLINE}%`

/** Additional host inputs needed to resolve the trusted cmd.exe relay. */
export interface WindowsAclTerminalAdaptation extends WindowsAclAdaptation {
  env: NodeJS.ProcessEnv
  isFile?: (path: string) => boolean
}

function removeEnvironmentKey(env: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name) delete env[key]
  }
}

/** Resolve cmd.exe without consulting PATH or the caller-controlled ComSpec value. */
export function desktopWindowsCommandPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (path: string) => boolean = path => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
): string | undefined {
  if (platform !== 'win32') return undefined
  const systemRoot = Object.entries(env)
    .find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1]
  if (systemRoot === undefined || systemRoot.length === 0) {
    throw new Error('dsh-plugin-desktop: Windows ACL terminal relay requires SystemRoot')
  }
  quotedWindowsRelayPath(systemRoot, 'SystemRoot')
  const command = win32.join(systemRoot, 'System32', 'cmd.exe')
  quotedWindowsRelayPath(command, 'cmd.exe')
  if (!isFile(command)) {
    throw new Error(`dsh-plugin-desktop: Windows ACL terminal relay cmd.exe is not a regular file: ${command}`)
  }
  return command
}

/** Adapt one persistent-terminal spawn while preserving every non-runner spec unchanged. */
export function adaptWindowsAclTerminalSpawn(
  spec: SubprocessTerminalSpawnSpec,
  adaptation: WindowsAclTerminalAdaptation,
): SubprocessTerminalSpawnSpec {
  const [program, runner, ...args] = spec.argv
  if (adaptation.platform !== 'win32'
    || !adaptation.electron
    || program !== adaptation.execPath
    || runner !== adaptation.upstreamRunner) {
    return spec
  }

  const command = desktopWindowsCommandPath(adaptation.env, adaptation.platform, adaptation.isFile)
  if (command === undefined) throw new Error('dsh-plugin-desktop: Windows ACL terminal relay has no cmd.exe')
  const env = { ...spec.env }
  removeWindowsAclRelayEnvironment(env)
  removeEnvironmentKey(env, RUN_AS_NODE)
  env[RUN_AS_NODE] = '1'
  env[WINDOWS_ACL_RELAY_PAYLOAD] = encodeWindowsAclRelay(runner, args)
  env[WINDOWS_ACL_RELAY_ELECTRON] = quotedWindowsRelayPath(adaptation.execPath, 'Electron executable')
  env[WINDOWS_ACL_RELAY_TRAMPOLINE] = quotedWindowsRelayPath(adaptation.trampoline, 'trampoline')
  return {
    ...spec,
    env,
    argv: [
      command,
      '/d',
      '/q',
      '/v:off',
      '/s',
      '/c',
      CMD_VARIABLE_ELECTRON,
      CMD_VARIABLE_TRAMPOLINE,
    ],
  }
}

/** Official local subprocess provider with the Electron ACL terminal launch repaired through cmd-owned ConPTY. */
export class DesktopWindowsSubprocess extends LocalSubprocessRuntime {
  override spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return super.spawnTerminal(adaptWindowsAclTerminalSpawn(spec, {
      platform: process.platform,
      electron: process.versions.electron !== undefined,
      execPath: process.execPath,
      upstreamRunner: UPSTREAM_RUNNER,
      trampoline: DESKTOP_TRAMPOLINE,
      env: process.env,
    }))
  }
}

export default DesktopWindowsSubprocess
