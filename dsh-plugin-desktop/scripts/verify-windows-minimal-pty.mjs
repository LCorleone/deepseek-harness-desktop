/** Real Windows smoke for the Desktop ACL runner over a cmd-owned ConPTY. */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { desktopWindowsPwshPath } from '../lib/windows-pwsh-sandbox.js'
import { adaptWindowsAclTerminalSpawn } from '../lib/windows-subprocess.js'

const WORKER_FLAG = '--worker'
const SUCCESS = JSON.stringify({ ok: true })
const PROMPT = '__DSH_PERSISTENT_PWSH_PROMPT__ '
const PROMPT_SETUP = `function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); '${PROMPT}' }`

function deadline(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${label} timed out after ${timeoutMs}ms`)) }, timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

async function worker() {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const electron = join(packageRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  const trampoline = join(packageRoot, 'lib', 'windows-acl-runner.js')
  const runner = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
  const pwsh = desktopWindowsPwshPath(process.env, process.platform)
  if (pwsh === undefined) throw new Error('Windows minimal PTY smoke could not resolve PowerShell')

  const context = new Context()
  const runtime = new LocalSubprocessRuntime(context)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined))
  const spec = adaptWindowsAclTerminalSpawn({
    argv: [
      electron,
      runner,
      '--workspace',
      packageRoot,
      '--temp',
      tmpdir(),
      '--mode',
      'read-only',
      '--',
      pwsh,
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
    ],
    cwd: packageRoot,
    env: environment,
    rows: 30,
    cols: 120,
    graceMs: 3_000,
  }, {
    platform: 'win32',
    electron: true,
    execPath: electron,
    upstreamRunner: runner,
    trampoline,
    env: process.env,
  })

  const terminal = await runtime.spawnTerminal(spec)
  let output = ''
  terminal.output.on('data', chunk => { output += chunk.toString() })
  const visibleOutput = () => output
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  const waitFor = async (pattern, label) => {
    try {
      await deadline(new Promise((resolve, reject) => {
        const inspect = () => {
          if (pattern.test(visibleOutput())) {
            cleanup()
            resolve()
          }
        }
        const exited = () => {
          cleanup()
          reject(new Error(`${label} exited before matching ${String(pattern)}`))
        }
        const cleanup = () => {
          terminal.output.off('data', inspect)
          terminal.output.off('end', exited)
        }
        terminal.output.on('data', inspect)
        terminal.output.on('end', exited)
        inspect()
      }), 20_000, label)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`${detail}; PTY output: ${JSON.stringify(output)}`)
    }
  }

  try {
    await waitFor(/untrusted publisher|PS(?: [^\r\n>]*)?>/iu, 'initial PowerShell prompt')
    if (/untrusted publisher/iu.test(visibleOutput())) {
      output = ''
      await terminal.write('D\r')
      await waitFor(/PS(?: [^\r\n>]*)?>/u, 'PowerShell prompt after publisher rejection')
    }
    output = ''
    await terminal.write(`${PROMPT_SETUP}; prompt\r`)
    await waitFor(/\r?\n__DSH_PERSISTENT_PWSH_PROMPT__ \r?\n/u, 'PowerShell prompt initialization')
    output = ''
    await terminal.write('$global:DshDesktopRelayState = 41; Write-Output ([int]$global:DshDesktopRelayState + 1)\r')
    await waitFor(/42\r?\n/u, 'first persistent PowerShell command')
    output = ''
    await terminal.write('Write-Output ([int]$global:DshDesktopRelayState * 2)\r')
    await waitFor(/82\r?\n/u, 'second persistent PowerShell command')
    await terminal.write('exit 7\r')
    const outcome = await deadline(terminal.done, 10_000, 'PowerShell relay exit')
    if (outcome.exitCode !== 7) {
      throw new Error(`Windows minimal PTY smoke expected exit code 7, received ${JSON.stringify(outcome)}`)
    }
  } finally {
    await terminal.terminate()
    await context.fiber.dispose()
  }
}

async function parent() {
  const script = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [script, WORKER_FLAG], {
    cwd: dirname(script),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await deadline(new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  }), 30_000, 'Windows minimal PTY smoke worker').catch(error => {
    child.kill()
    throw error
  })
  if (exitCode !== 0 || stdout.trim() !== SUCCESS || stderr.length > 0) {
    throw new Error(`Windows minimal PTY smoke leaked host output or failed: ${JSON.stringify({ exitCode, stdout, stderr })}`)
  }
}

async function main() {
  if (process.platform !== 'win32') return
  if (process.argv.includes(WORKER_FLAG)) {
    await worker()
    await new Promise(resolve => { process.stdout.write(`${SUCCESS}\n`, resolve) })
    process.exit(0)
  }
  await parent()
}

void main().catch(cause => {
  const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  process.stderr.write(`verify-windows-minimal-pty: ${detail}\n`)
  process.exitCode = 1
})
