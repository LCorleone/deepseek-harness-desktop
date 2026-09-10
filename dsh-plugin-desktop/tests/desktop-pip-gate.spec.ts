import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  DSH_PIP_DENIED_EXIT,
  DSH_PIP_EXECUTABLE_ENV,
  DSH_PIP_PYTHON_ENV,
  isSandboxConfinedEnvironment,
  isSandboxPrivateTempDirectory,
  runDshPipGate,
  type DshPipSpawn,
} from '../src/desktop-pip-gate.ts'

interface SpawnHarness {
  spawn: DshPipSpawn
  calls: Array<{ command: string, args: readonly string[], options: SpawnOptions }>
  emitExit: (code: number | null) => void
  emitError: (cause: Error) => void
}

/** Spawn seam that records the invocation and lets the test settle it. */
function spawnHarness(): SpawnHarness {
  const calls: SpawnHarness['calls'] = []
  const emitter = new EventEmitter()
  const spawn: DshPipSpawn = (command, args, options) => {
    calls.push({ command, args, options })
    return emitter as unknown as ChildProcess
  }
  return {
    spawn,
    calls,
    emitExit: code => { emitter.emit('exit', code) },
    emitError: cause => { emitter.emit('error', cause) },
  }
}

/** The runner's private-temp spelling (`mkdtempSync(join(tmpdir(), 'dsh-'))`). */
const CONFINED_TEMP = 'C:\\Users\\Example\\AppData\\Local\\Temp\\dsh-a1B2c3'

describe('dsh-pip sandbox criterion', () => {
  it('recognizes the runner private-temp component', () => {
    expect(isSandboxPrivateTempDirectory(CONFINED_TEMP)).toBe(true)
    expect(isSandboxPrivateTempDirectory('/tmp/dsh-a1B2c3')).toBe(true)
    expect(isSandboxPrivateTempDirectory('C:\\Temp\\dsh-a1B2c3\\')).toBe(true)
  })

  it('rejects ambient temp paths and near misses', () => {
    expect(isSandboxPrivateTempDirectory('C:\\Users\\Example\\AppData\\Local\\Temp')).toBe(false)
    expect(isSandboxPrivateTempDirectory('/tmp')).toBe(false)
    // Only the exact mkdtemp shape counts: a real directory that merely
    // starts with `dsh-` (or a different suffix length) is not the marker.
    expect(isSandboxPrivateTempDirectory('C:\\Temp\\dsh-toolchain')).toBe(false)
    expect(isSandboxPrivateTempDirectory('C:\\Temp\\dsh-abc12')).toBe(false)
    expect(isSandboxPrivateTempDirectory('C:\\Temp\\dsh-abc1234')).toBe(false)
    expect(isSandboxPrivateTempDirectory(undefined)).toBe(false)
    expect(isSandboxPrivateTempDirectory('')).toBe(false)
  })

  it('classifies TEMP or TMP, case-insensitively', () => {
    expect(isSandboxConfinedEnvironment({ TEMP: CONFINED_TEMP })).toBe(true)
    expect(isSandboxConfinedEnvironment({ TMP: CONFINED_TEMP })).toBe(true)
    expect(isSandboxConfinedEnvironment({ temp: CONFINED_TEMP })).toBe(true)
    expect(isSandboxConfinedEnvironment({ TEMP: 'C:\\Temp' })).toBe(false)
    expect(isSandboxConfinedEnvironment({})).toBe(false)
  })
})

describe('dsh-pip gate', () => {
  const normalEnvironment: NodeJS.ProcessEnv = {
    TEMP: 'C:\\Users\\Example\\AppData\\Local\\Temp',
    [DSH_PIP_EXECUTABLE_ENV]: 'C:\\pyenv\\Scripts\\pip.exe',
    [DSH_PIP_PYTHON_ENV]: 'C:\\pyenv\\Scripts\\python.exe',
  }

  it('denies immediately inside the sandbox without spawning pip', async () => {
    const harness = spawnHarness()
    const errors: string[] = []

    const exitCode = await runDshPipGate({
      argv: ['install', 'requests'],
      environment: { ...normalEnvironment, TEMP: CONFINED_TEMP },
      stderr: text => errors.push(text),
      spawn: harness.spawn,
    })

    expect(exitCode).toBe(DSH_PIP_DENIED_EXIT)
    expect(harness.calls).toHaveLength(0)
    const denial = errors.join('')
    // The upstream windows-acl denial dialect, so classifyDenial marks the run denied.
    expect(denial.toLowerCase()).toContain('access is denied')
    expect(denial).toContain('retry the exact same dsh-pip command in the foreground')
  })

  it('passes argv, exit code, and stdio through to the real pip outside the sandbox', async () => {
    const harness = spawnHarness()
    const errors: string[] = []

    const pending = runDshPipGate({
      argv: ['install', 'requests'],
      environment: normalEnvironment,
      stderr: text => errors.push(text),
      spawn: harness.spawn,
    })

    expect(harness.calls).toHaveLength(1)
    expect(harness.calls[0]?.command).toBe('C:\\pyenv\\Scripts\\pip.exe')
    expect(harness.calls[0]?.args).toEqual(['install', 'requests'])
    expect(harness.calls[0]?.options.stdio).toBe('inherit')
    expect(harness.calls[0]?.options.env).toBe(normalEnvironment)
    harness.emitExit(0)
    await expect(pending).resolves.toBe(0)
    expect(errors).toEqual([])
  })

  it('mirrors a non-zero pip exit code', async () => {
    const harness = spawnHarness()
    const pending = runDshPipGate({
      argv: ['install', 'does-not-exist'],
      environment: normalEnvironment,
      stderr: () => {},
      spawn: harness.spawn,
    })
    harness.emitExit(2)
    await expect(pending).resolves.toBe(2)
  })

  it('falls back to `python -m pip` when no pip launcher is published', async () => {
    const harness = spawnHarness()
    const pending = runDshPipGate({
      argv: ['install', 'requests'],
      environment: {
        TEMP: 'C:\\Users\\Example\\AppData\\Local\\Temp',
        [DSH_PIP_PYTHON_ENV]: 'C:\\pyenv\\Scripts\\python.exe',
      },
      stderr: () => {},
      spawn: harness.spawn,
    })

    expect(harness.calls[0]?.command).toBe('C:\\pyenv\\Scripts\\python.exe')
    expect(harness.calls[0]?.args).toEqual(['-m', 'pip', 'install', 'requests'])
    harness.emitExit(0)
    await expect(pending).resolves.toBe(0)
  })

  it('reports a missing pip command instead of hanging', async () => {
    const harness = spawnHarness()
    const errors: string[] = []

    const exitCode = await runDshPipGate({
      argv: ['install', 'requests'],
      environment: { TEMP: 'C:\\Users\\Example\\AppData\\Local\\Temp' },
      stderr: text => errors.push(text),
      spawn: harness.spawn,
    })

    expect(exitCode).toBe(DSH_PIP_DENIED_EXIT)
    expect(harness.calls).toHaveLength(0)
    expect(errors.join('')).toContain('no pip executable is published')
  })

  it('reports a spawn failure as a non-zero exit instead of throwing', async () => {
    const harness = spawnHarness()
    const errors: string[] = []
    const pending = runDshPipGate({
      argv: ['install', 'requests'],
      environment: normalEnvironment,
      stderr: text => errors.push(text),
      spawn: harness.spawn,
    })
    harness.emitError(new Error('ENOENT'))
    await expect(pending).resolves.toBe(DSH_PIP_DENIED_EXIT)
    expect(errors.join('')).toContain('ENOENT')
  })
})
