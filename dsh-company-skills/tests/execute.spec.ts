/**
 * The P6 batch-3 execution channel: addressing, stdin delivery, zero-disk
 * staging, bounds, concurrency, and cancellation.
 *
 * The load-bearing assertions are the zero-disk pair (the script's own source
 * text never appears under the temp root, and the staged assets directory is
 * gone once the run settles) and the addressing pair (an unknown skill or a
 * script outside the bundle's own `scripts[]` list rejects before anything
 * spawns). Both are mutation-killers: rewriting the body to a file, or
 * resolving `script` by path arithmetic, turns them red.
 *
 * The integration cases run a real `node -` process through
 * {@link localSpawn}; the unit cases inject a seam so timeout, concurrency, and
 * passthrough behaviour is deterministic without spawning anything.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadCatalogFromText } from '../src/catalog.js'
import {
  ASSETS_ENV_VAR,
  DESKTOP_NODE_EXECUTABLE_ENV,
  DESKTOP_PYTHON_EXECUTABLE_ENV,
  ELECTRON_RUN_AS_NODE_ENV,
  SkillRunError,
  createScriptExecutor,
  interpreterFor,
  resolveInterpreter,
  supportedScriptExtensions,
  type ScriptSpawn,
} from '../src/execute.js'
import { localSpawn } from './local-spawn.js'
import { toolsCodec } from './tools.js'

/** The three canaries: the skill body, the script's own source, and a legit output line. */
const BODY_CANARY = 'SKILL-BODY-PLAINTEXT-CANARY'
const SCRIPT_CANARY = 'SCRIPT-SOURCE-CANARY'
const OUT_CANARY = 'RUNNER-STDOUT-CANARY-4242'
const ASSET_CANARY = 'ASSET-CONTENT-CANARY'

/** A CommonJS/ESM-agnostic demo script (Node auto-detects stdin modules). */
const DEMO_SCRIPT = `// ${SCRIPT_CANARY}: this source must never be written to disk.
console.log('${OUT_CANARY}')
console.error('RUNNER-STDERR-CANARY')
`

interface EntrySpec { readonly path: string; readonly text?: string; readonly content?: string }
interface SkillSpec {
  readonly name?: string
  readonly body?: string
  readonly scripts?: readonly EntrySpec[]
  readonly assets?: readonly EntrySpec[]
}

/** Encode one base64 bundle entry. */
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/** Encode one declared entry, honoring a raw pre-encoded `content` override. */
const encodeEntry = (entry: EntrySpec): string => entry.content ?? b64(entry.text ?? '')

/** Build one raw skill bundle element. */
function bundleOf(spec: SkillSpec = {}): Record<string, unknown> {
  return {
    name: spec.name ?? 'runner-demo',
    description: 'Fixture skill used to exercise the batch-3 script executor.',
    body: spec.body ?? `# runner demo\n\n${BODY_CANARY}\n`,
    scripts: (spec.scripts ?? [{ path: 'scripts/demo.mjs', text: DEMO_SCRIPT }])
      .map((entry) => ({ path: entry.path, content: encodeEntry(entry) })),
    assets: (spec.assets ?? []).map((entry) => ({ path: entry.path, content: encodeEntry(entry) })),
  }
}

/** Load a one-skill (or N-skill) catalog from the in-memory container encoding. */
function catalogOf(...skills: readonly Record<string, unknown>[]) {
  return loadCatalogFromText(toolsCodec.encodeBundleBlob(JSON.stringify({ version: 1, skills })))
}

/** The default caller context every run shares. */
const callerSignal = (): AbortSignal => new AbortController().signal

let tempRoot: string
beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'company-skills-exec-'))
})
afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/** Build a handle whose `done` is caller-controlled and whose streams are fixed text. */
function handleWith(
  done: Promise<SubprocessOutcome>,
  output: { stdout?: string; stderr?: string; truncated?: boolean } = {},
): SubprocessHandle {
  const stream = (text: string) => ({
    readFrom: () => ({ text, nextOffset: text.length, lossy: output.truncated ?? false }),
  })
  return {
    pid: 4242,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      ...(output.stdout === undefined ? {} : { stdout: stream(output.stdout) }),
      ...(output.stderr === undefined ? {} : { stderr: stream(output.stderr) }),
    },
    done,
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
  } as unknown as SubprocessHandle
}

/** A recording seam that settles `done` immediately with the supplied exit facts. */
function immediateSpawn(exitCode = 0, output: { stdout?: string; stderr?: string; truncated?: boolean } = {}) {
  const specs: SubprocessSpawnSpec[] = []
  const spawn: ScriptSpawn = (spec) => {
    specs.push(spec)
    return handleWith(Promise.resolve({ exitCode, signal: null }), output)
  }
  return { spawn, specs }
}

/** A recording seam that resolves `done` with signal-termination facts when the run's signal aborts. */
function abortTerminatedSpawn() {
  const specs: SubprocessSpawnSpec[] = []
  const spawn: ScriptSpawn = (spec) => {
    specs.push(spec)
    const done = new Promise<SubprocessOutcome>((resolve) => {
      const settle = (): void => { resolve({ exitCode: null, signal: 'SIGKILL' }) }
      if (spec.signal?.aborted === true) settle()
      else spec.signal?.addEventListener('abort', settle, { once: true })
    })
    return handleWith(done)
  }
  return { spawn, specs }
}

describe('interpreter selection', () => {
  it('maps the supported extensions and rejects everything else', () => {
    expect(interpreterFor('scripts/run.mjs')).toBe('node')
    expect(interpreterFor('scripts/run.js')).toBe('node')
    expect(interpreterFor('scripts/RUN.PY')).toBe('python')
    expect(interpreterFor('scripts/run.sh')).toBeUndefined()
    expect(interpreterFor('scripts/run')).toBeUndefined()
    expect(supportedScriptExtensions()).toEqual(['.mjs', '.js', '.py'])
  })
})

describe('interpreter resolution', () => {
  it('prefers the desktop-published absolute command over a PATH lookup', () => {
    const probe = (): boolean => { throw new Error('PATH must not be probed when a command was injected') }
    expect(resolveInterpreter('node', {
      environment: { PATH: '/usr/bin', [DESKTOP_NODE_EXECUTABLE_ENV]: '/opt/dsh/node-runtime/node' },
      commandOnPath: probe,
    })).toEqual({ command: '/opt/dsh/node-runtime/node', env: {} })
    expect(resolveInterpreter('python', {
      environment: { PATH: '/usr/bin', [DESKTOP_PYTHON_EXECUTABLE_ENV]: 'C:/pyenv/Scripts/python.exe' },
      commandOnPath: probe,
    })).toEqual({ command: 'C:/pyenv/Scripts/python.exe', env: {} })
  })

  it('falls back to the bare family name when it is executable on PATH', () => {
    expect(resolveInterpreter('node', { environment: { PATH: '/usr/bin' }, commandOnPath: () => true }))
      .toEqual({ command: 'node', env: {} })
    expect(resolveInterpreter('python', { environment: {}, commandOnPath: () => true }))
      .toEqual({ command: 'python', env: {} })
  })

  it('falls back to the host executable as Node, and rejects an unresolvable Python', () => {
    expect(resolveInterpreter('node', {
      environment: {},
      execPath: '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
      commandOnPath: () => false,
    })).toEqual({
      command: '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
      env: { [ELECTRON_RUN_AS_NODE_ENV]: '1' },
    })
    expect(resolveInterpreter('python', { environment: {}, commandOnPath: () => false })).toBeUndefined()
  })
})

describe('running a declared script (real node over stdin)', () => {
  it('executes the script from the bundle and returns its output and exit code', async () => {
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf()),
      spawn: localSpawn,
      tempRoot,
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result).toMatchObject({ skill: 'runner-demo', script: 'scripts/demo.mjs', exitCode: 0 })
    expect(result.stdout.text).toContain(OUT_CANARY)
    expect(result.stderr.text).toContain('RUNNER-STDERR-CANARY')
  })

  it('appends args after the interpreter script marker, verbatim', async () => {
    const argvScript = "console.log('ARGV:' + process.argv.slice(2).join(','))\n"
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ name: 'runner-argv', scripts: [{ path: 'scripts/argv.mjs', text: argvScript }] })),
      spawn: localSpawn,
      tempRoot,
    })
    const result = await executor.run({
      skill: 'runner-argv',
      script: 'scripts/argv.mjs',
      args: ['--flag', 'value with spaces'],
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result.stdout.text).toContain('ARGV:--flag,value with spaces')
  })

  it('surfaces a non-zero exit code instead of throwing', async () => {
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ scripts: [{ path: 'scripts/fail.mjs', text: 'process.exit(3)\n' }] })),
      spawn: localSpawn,
      tempRoot,
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/fail.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result.exitCode).toBe(3)
  })
})

describe('zero plaintext on disk', () => {
  it('keeps the script source off disk and removes staged assets after the run', async () => {
    const scanScript = [
      "const { readdirSync, readFileSync } = require('node:fs')",
      "const { join } = require('node:path')",
      "const { tmpdir } = require('node:os')",
      `const canary = '${SCRIPT_CANARY}'`,
      'const root = process.argv[2]',
      'let hits = 0',
      'const walk = (dir) => {',
      '  for (const entry of readdirSync(dir, { withFileTypes: true })) {',
      '    const path = join(dir, entry.name)',
      '    if (entry.isDirectory()) walk(path)',
      "    else if (readFileSync(path, 'utf8').includes(canary)) hits += 1",
      '  }',
      '}',
      'walk(root)',
      // The default temp root is scanned at its top level too, so a mutant
      // that materializes the body directly in `os.tmpdir()` (rather than
      // below the injected root) also turns this test red.
      'for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {',
      "  if (!entry.isFile()) continue",
      "  try { if (readFileSync(join(tmpdir(), entry.name), 'utf8').includes(canary)) hits += 1 } catch {}",
      '}',
      "console.log('SCRIPT-SOURCE-HITS=' + hits)",
      `console.log('ASSET-READ=' + require('node:fs').readFileSync(process.env.${ASSETS_ENV_VAR} + '/assets/notes.md', 'utf8').trim())`,
    ].join('\n')
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({
        assets: [{ path: 'assets/notes.md', text: `${ASSET_CANARY}\n` }],
        scripts: [{ path: 'scripts/scan.mjs', text: scanScript }],
      })),
      spawn: localSpawn,
      tempRoot,
    })

    // Pin TMPDIR so `os.tmpdir()` — used by the executor's default temp root
    // and by the scan script — is a small, test-owned directory instead of a
    // shared machine-wide one. The child inherits it through the spawn spec.
    const defaultTempRoot = await mkdtemp(join(tmpdir(), 'company-skills-default-'))
    const previousTmpdir = process.env.TMPDIR
    const runScan = async () => {
      process.env.TMPDIR = defaultTempRoot
      try {
        return await executor.run({
          skill: 'runner-demo',
          script: 'scripts/scan.mjs',
          args: [tempRoot],
          cwd: tempRoot,
          sessionKey: 'session-a',
          signal: callerSignal(),
        })
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previousTmpdir
        await rm(defaultTempRoot, { recursive: true, force: true })
      }
    }
    const result = await runScan()

    // The source was piped, never materialized: the script's own walk of the
    // temp root (plus the top level of the default temp root) finds zero
    // copies of its own canary while it runs.
    expect(result.stdout.text).toContain('SCRIPT-SOURCE-HITS=0')
    // The asset was staged and readable through DSH_SKILL_ASSETS.
    expect(result.stdout.text).toContain(`ASSET-READ=${ASSET_CANARY}`)
    // And the staged directory is gone once the run settles.
    await expect(readdir(tempRoot)).resolves.toEqual([])

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SCRIPT_CANARY)
    expect(serialized).not.toContain(BODY_CANARY)
  })

  it('does not stage assets for a skill that has none, and never sets the env var', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf()),
      spawn,
      tempRoot,
      interpreterResolution: { commandOnPath: () => true },
    })
    await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs).toHaveLength(1)
    expect(specs[0]?.env).toBeUndefined()
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('returns the settled result even when staged-asset cleanup fails', async () => {
    const { spawn, specs } = immediateSpawn(0, { stdout: 'ok' })
    const warnings: string[] = []
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({
        assets: [{ path: 'assets/notes.md', text: `${ASSET_CANARY}\n` }],
      })),
      spawn,
      tempRoot,
      removeStagedAssets: () => Promise.reject(new Error('EPERM: directory not empty')),
      logWarning: message => { warnings.push(message) },
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs).toHaveLength(1)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok')
    // The failure is reported as a warning and never as the run's outcome.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not remove the staged assets')
    expect(warnings[0]).not.toContain(SCRIPT_CANARY)
  })
})

describe('addressing is validation, never path arithmetic', () => {
  it('rejects an unknown skill before spawning', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot })
    const failure = executor.run({
      skill: 'not-a-company-skill',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    await expect(failure).rejects.toThrow(SkillRunError)
    await expect(failure).rejects.toThrow(/unknown company skill/)
    let error: Error | undefined
    await failure.catch((cause: unknown) => { error = cause as Error })
    expect(error?.message).not.toContain(BODY_CANARY)
    expect(error?.message).not.toContain(SCRIPT_CANARY)
    expect(specs).toHaveLength(0)
  })

  it('rejects a script outside the bundle, including traversal attempts, before spawning', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot })
    for (const script of ['scripts/missing.mjs', 'scripts/../evil.mjs', '../evil.mjs', '/etc/passwd', 'assets/notes.md']) {
      await expect(executor.run({
        skill: 'runner-demo',
        script,
        cwd: tempRoot,
        sessionKey: 'session-a',
        signal: callerSignal(),
      })).rejects.toThrow(/carries no script/)
    }
    expect(specs).toHaveLength(0)
  })

  it('rejects a script whose extension has no interpreter', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ scripts: [{ path: 'scripts/legacy.sh', text: 'echo hi\n' }] })),
      spawn,
      tempRoot,
    })
    await expect(executor.run({
      skill: 'runner-demo',
      script: 'scripts/legacy.sh',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })).rejects.toThrow(/no supported interpreter/)
    expect(specs).toHaveLength(0)
  })
})

describe('script text decoding', () => {
  it('rejects a body that is not valid UTF-8 instead of decoding it lossily', async () => {
    const { spawn, specs } = immediateSpawn()
    const invalid = Buffer.from([0x70, 0x72, 0x69, 0x6e, 0x74, 0xff, 0xfe, 0x29]).toString('base64')
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ scripts: [{ path: 'scripts/bad.mjs', content: invalid }] })),
      spawn,
      tempRoot,
    })
    const failure = executor.run({
      skill: 'runner-demo',
      script: 'scripts/bad.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    await expect(failure).rejects.toThrow(SkillRunError)
    await expect(failure).rejects.toThrow(/is not valid UTF-8 text/)
    let error: Error | undefined
    await failure.catch((cause: unknown) => { error = cause as Error })
    expect(error?.message).not.toContain('print')
    expect(specs).toHaveLength(0)
  })
})

describe('interpreter resolution through the seam', () => {
  it('launches the desktop-published command in preference to a PATH name', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf()),
      spawn,
      tempRoot,
      interpreterResolution: {
        environment: { [DESKTOP_NODE_EXECUTABLE_ENV]: '/opt/dsh/node-runtime/node' },
        commandOnPath: () => { throw new Error('PATH must not be probed for an injected command') },
      },
    })
    await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs[0]?.argv[0]).toBe('/opt/dsh/node-runtime/node')
    expect(specs[0]?.env).toBeUndefined()
  })

  it('falls back to the host executable as Node, publishing ELECTRON_RUN_AS_NODE', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf()),
      spawn,
      tempRoot,
      interpreterResolution: {
        environment: {},
        execPath: '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
        commandOnPath: () => false,
      },
    })
    await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs[0]?.argv[0]).toBe('/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop')
    expect(specs[0]?.env).toEqual({ [ELECTRON_RUN_AS_NODE_ENV]: '1' })
  })

  it('rejects an unresolvable Python script without spawning', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ scripts: [{ path: 'scripts/report.py', text: "print('ok')\n" }] })),
      spawn,
      tempRoot,
      interpreterResolution: { environment: {}, commandOnPath: () => false },
    })
    const failure = executor.run({
      skill: 'runner-demo',
      script: 'scripts/report.py',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    await expect(failure).rejects.toThrow(SkillRunError)
    await expect(failure).rejects.toThrow(/no python interpreter was found/)
    expect(specs).toHaveLength(0)
  })
})

describe('timeout, truncation, and cancellation', () => {
  const assetBundle = (): ReturnType<typeof bundleOf> => bundleOf({
    assets: [{ path: 'assets/notes.md', text: `${ASSET_CANARY}\n` }],
  })

  it('fails a run that outlives its deadline, terminates it, and removes staged assets', async () => {
    const { spawn, specs } = abortTerminatedSpawn()
    const executor = createScriptExecutor({ catalog: catalogOf(assetBundle()), spawn, tempRoot, timeoutMs: 25, graceMs: 10 })
    await expect(executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })).rejects.toThrow(/timed out after 25 ms/)
    expect(specs[0]?.signal?.aborted).toBe(true)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('removes staged assets when the launch itself throws', async () => {
    const spawn: ScriptSpawn = () => { throw new Error('EACCES: launch refused') }
    const executor = createScriptExecutor({ catalog: catalogOf(assetBundle()), spawn, tempRoot })
    await expect(executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })).rejects.toThrow(/could not start/)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('reports truncation when a stream overflows its cap, keeping the tail', async () => {
    const noisy = [
      "process.stdout.write('HEAD' + 'x'.repeat(4095))",
      "process.stderr.write('y'.repeat(2048))",
    ].join('\n')
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ scripts: [{ path: 'scripts/noisy.mjs', text: noisy }] })),
      spawn: localSpawn,
      tempRoot,
      maxOutputBytes: 512,
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/noisy.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toHaveLength(512)
    expect(result.stdout.text).not.toContain('HEAD')
    expect(result.stderr.truncated).toBe(true)
    expect(result.stderr.text).toHaveLength(512)
  })

  it('classifies a caller cancellation as cancelled and removes staged assets', async () => {
    const { spawn, specs } = abortTerminatedSpawn()
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ assets: [{ path: 'assets/notes.md', text: `${ASSET_CANARY}\n` }] })),
      spawn,
      tempRoot,
    })
    const controller = new AbortController()
    const run = executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      cwd: tempRoot,
      sessionKey: 'session-a',
      signal: controller.signal,
    })
    controller.abort()
    await expect(run).rejects.toThrow(/was cancelled/)
    expect(specs[0]?.signal?.aborted).toBe(true)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })
})

describe('session concurrency bound', () => {
  it('allows one in-flight run per session and releases the slot when it settles', async () => {
    const pending: (() => void)[] = []
    const spawn: ScriptSpawn = () => {
      const done = new Promise<SubprocessOutcome>((resolve) => {
        pending.push(() => { resolve({ exitCode: 0, signal: null }) })
      })
      return handleWith(done, { stdout: '' })
    }
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot })

    const first = executor.run({ skill: 'runner-demo', script: 'scripts/demo.mjs', cwd: tempRoot, sessionKey: 's1', signal: callerSignal() })
    await Promise.resolve()
    await expect(executor.run({
      skill: 'runner-demo', script: 'scripts/demo.mjs', cwd: tempRoot, sessionKey: 's1', signal: callerSignal(),
    })).rejects.toThrow(/already running/)

    // A different session has its own slot.
    const other = executor.run({ skill: 'runner-demo', script: 'scripts/demo.mjs', cwd: tempRoot, sessionKey: 's2', signal: callerSignal() })
    await Promise.resolve()
    expect(pending).toHaveLength(2)
    pending[1]?.()
    await expect(other).resolves.toMatchObject({ exitCode: 0 })

    pending[0]?.()
    await expect(first).resolves.toMatchObject({ exitCode: 0 })

    // The slot is free again after settlement.
    const reused = executor.run({ skill: 'runner-demo', script: 'scripts/demo.mjs', cwd: tempRoot, sessionKey: 's1', signal: callerSignal() })
    await Promise.resolve()
    pending[2]?.()
    await expect(reused).resolves.toMatchObject({ exitCode: 0 })
  })
})

describe('seam passthrough', () => {
  it('hands the seam the interpreter argv, stdin body, cwd, and grace', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf()),
      spawn,
      tempRoot,
      graceMs: 1234,
      interpreterResolution: { commandOnPath: () => true },
    })
    await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      args: ['--alpha'],
      cwd: '/some/workspace',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    const spec = specs[0]
    expect(spec?.argv).toEqual(['node', '-', '--alpha'])
    expect(spec?.cwd).toBe('/some/workspace')
    expect(spec?.graceMs).toBe(1234)
    expect(spec?.stdio.stdin).toEqual({ data: DEMO_SCRIPT })
    expect(spec?.signal).toBeInstanceOf(AbortSignal)
  })
})
