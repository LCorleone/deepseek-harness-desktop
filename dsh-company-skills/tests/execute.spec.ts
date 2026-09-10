/**
 * The P6 batch-3 execution channel: addressing, per-run materialization,
 * nothing-persists cleanup, bounds, concurrency, and cancellation.
 *
 * The load-bearing assertions are the materialization pair (a staged script
 * really runs from `<tmp>/scripts/…`, so `__file__` locates the skill root and
 * a Python sibling import resolves through `sys.path[0]`) and the residue pair
 * (the staged root is gone once the run settles, and no error message, warning,
 * or result ever carries a byte of the script body or skill body). The
 * addressing pair (an unknown skill or a script outside the bundle's own
 * `scripts[]` list rejects before anything spawns) stays from the stdin era.
 *
 * The integration cases run real `node` / `python` processes through
 * {@link localSpawn}; the unit cases inject a seam so timeout, concurrency, and
 * passthrough behaviour is deterministic without spawning anything.
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { pythonInterpreter, pythonResolution } from './python.js'
import { toolsCodec } from './tools.js'

/** The three canaries: the skill body, the script's own source, and a legit output line. */
const BODY_CANARY = 'SKILL-BODY-PLAINTEXT-CANARY'
const SCRIPT_CANARY = 'SCRIPT-SOURCE-CANARY'
const OUT_CANARY = 'RUNNER-STDOUT-CANARY-4242'
const ASSET_CANARY = 'ASSET-CONTENT-CANARY'

/** A demo script that proves it runs from disk: it reads its own file. */
const DEMO_SCRIPT = [
  `// ${SCRIPT_CANARY}: this source is staged for the run and removed after it.`,
  "import { readFileSync } from 'node:fs'",
  "import { dirname } from 'node:path'",
  "import { fileURLToPath } from 'node:url'",
  "const own = readFileSync(new URL(import.meta.url), 'utf8')",
  `console.log('${OUT_CANARY}')`,
  `console.log('OWN-SOURCE-READ=' + own.includes('${SCRIPT_CANARY}'))`,
  "console.log('SKILL-ROOT=' + dirname(dirname(fileURLToPath(import.meta.url))))",
  "console.error('RUNNER-STDERR-CANARY')",
].join('\n')

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
      exists: () => true,
    })).toEqual({ command: '/opt/dsh/node-runtime/node', env: {} })
    expect(resolveInterpreter('python', {
      environment: { PATH: '/usr/bin', [DESKTOP_PYTHON_EXECUTABLE_ENV]: 'C:/pyenv/Scripts/python.exe' },
      commandOnPath: probe,
      exists: () => true,
    })).toEqual({ command: 'C:/pyenv/Scripts/python.exe', env: {} })
  })

  it('ignores a stale injection that no longer exists and keeps falling back', () => {
    // A CLI host inherits the user's shell: an exported-but-deleted path must
    // not shadow a working PATH lookup.
    expect(resolveInterpreter('node', {
      environment: { PATH: '/usr/bin', [DESKTOP_NODE_EXECUTABLE_ENV]: '/gone/node' },
      commandOnPath: () => true,
      exists: () => false,
    })).toEqual({ command: 'node', env: {} })
    expect(resolveInterpreter('python', {
      environment: { [DESKTOP_PYTHON_EXECUTABLE_ENV]: 'C:/gone/python.exe' },
      commandOnPath: () => false,
      exists: () => false,
    })).toBeUndefined()
  })

  it('skips a .cmd shim on a Windows PATH: only native images can be spawned', () => {
    // The packaged desktop publishes .cmd shims on PATH; a shell-less spawn
    // cannot execute them, which is why the injected variable exists. A PATH
    // holding only node.cmd must NOT resolve to the bare name on Windows.
    expect(resolveInterpreter('node', {
      environment: { Path: 'C:\\shims' },
      platform: 'win32',
      execPath: 'C:/dsd/DSH Desktop.exe',
      exists: () => false,
    })).toEqual({
      command: 'C:/dsd/DSH Desktop.exe',
      env: { [ELECTRON_RUN_AS_NODE_ENV]: '1' },
    })
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

describe('running a declared script (real node, materialized)', () => {
  it('executes the staged script file and returns its output and exit code', async () => {
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf()),
      spawn: localSpawn,
      tempRoot,
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result).toMatchObject({ skill: 'runner-demo', script: 'scripts/demo.mjs', exitCode: 0 })
    expect(result.stdout.text).toContain(OUT_CANARY)
    // The script really ran from its staged file, not from a pipe.
    expect(result.stdout.text).toContain('OWN-SOURCE-READ=true')
    expect(result.stderr.text).toContain('RUNNER-STDERR-CANARY')
  })

  it('appends args after the materialized script path, verbatim', async () => {
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result.exitCode).toBe(3)
  })
})

describe('materialized execution (the code-runtime-python paradigm)', () => {
  it('lets __file__ locate the skill root: parent.parent is the staged root', async () => {
    // The collected ppt-designer skill computes SKILL_DIR exactly this way
    // (export_pptx.py:38); the staged layout must keep that working.
    const rootScript = [
      "import { dirname } from 'node:path'",
      "import { fileURLToPath } from 'node:url'",
      "const root = dirname(dirname(fileURLToPath(import.meta.url)))",
      "console.log('SKILL-ROOT=' + root)",
      "console.log('SKILL-ROOT-ENV-MATCH=' + (root === process.env.DSH_SKILL_ASSETS))",
      "console.log('SKILL-ROOT-CWD-MATCH=' + (root === process.cwd()))",
    ].join('\n')
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({ scripts: [{ path: 'scripts/locate.mjs', text: rootScript }] })),
      spawn: localSpawn,
      tempRoot,
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/locate.mjs',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    const root = result.stdout.text.match(/SKILL-ROOT=(.*)/u)?.[1] ?? ''
    expect(root.startsWith(join(tempRoot, 'dsh-skill-assets-'))).toBe(true)
    expect(result.stdout.text).toContain('SKILL-ROOT-ENV-MATCH=true')
    expect(result.stdout.text).toContain('SKILL-ROOT-CWD-MATCH=true')
  })

  it.skipIf(pythonInterpreter === undefined)('lets a Python script import a sibling module from the same scripts directory', async () => {
    const peer = 'PEER_VALUE = "SIBLING-IMPORT-WORKS-1337"\n'
    const usesPeer = [
      'from peer_module import PEER_VALUE',
      'import os',
      'print("PEER=" + PEER_VALUE)',
      'print("PEER-SCRIPT-DIR-OK=" + str("scripts" in os.path.dirname(os.path.abspath(__file__))))',
    ].join('\n')
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({
        scripts: [
          { path: 'scripts/peer_module.py', text: peer },
          { path: 'scripts/uses_peer.py', text: usesPeer },
        ],
      })),
      spawn: localSpawn,
      tempRoot,
      // CI runners ship `python3`, not the bare `python` the PATH fallback
      // looks for; inject the absolute interpreter instead of depending on it.
      ...(pythonResolution === undefined ? {} : { interpreterResolution: pythonResolution }),
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/uses_peer.py',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toContain('PEER=SIBLING-IMPORT-WORKS-1337')
    expect(result.stdout.text).toContain('PEER-SCRIPT-DIR-OK=True')
  })

  it('runs with the staged root as cwd, so bundle-relative asset reads resolve', async () => {
    const reader = [
      "import { readFileSync } from 'node:fs'",
      "console.log('ASSET-READ=' + readFileSync('assets/notes.md', 'utf8').trim())",
    ].join('\n')
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({
        name: 'runner-assets',
        scripts: [{ path: 'scripts/read.mjs', text: reader }],
        assets: [{ path: 'assets/notes.md', text: `${ASSET_CANARY}\n` }],
      })),
      spawn: localSpawn,
      tempRoot,
    })
    const result = await executor.run({
      skill: 'runner-assets',
      script: 'scripts/read.mjs',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result.stdout.text).toContain(`ASSET-READ=${ASSET_CANARY}`)
  })
})

describe('nothing persists and no plaintext leaks', () => {
  it('removes the staged skill root when the run settles, keeping only the output', async () => {
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf({
        assets: [{ path: 'assets/notes.md', text: `${ASSET_CANARY}\n` }],
      })),
      spawn: localSpawn,
      tempRoot,
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    // While running, the script read its own source from disk (see above);
    // once settled, the whole staged root is gone and the temp root is empty.
    expect(result.stdout.text).toContain('OWN-SOURCE-READ=true')
    const staged = result.stdout.text.match(/SKILL-ROOT=(.*)/u)?.[1] ?? undefined
    if (staged !== undefined) await expect(stat(staged)).rejects.toThrow()
    await expect(readdir(tempRoot)).resolves.toEqual([])

    // The settled result carries output lines but never the skill body.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(BODY_CANARY)
  })

  it('always stages under the injected root and always publishes the env var', async () => {
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs).toHaveLength(1)
    const spec = specs[0] as SubprocessSpawnSpec
    // The staged root is under the injected temp root, is the child's cwd, and
    // is exactly what the env var publishes.
    expect(spec.argv[1]).toBe(join(spec.cwd as string, 'scripts/demo.mjs'))
    expect((spec.cwd as string).startsWith(join(tempRoot, 'dsh-skill-assets-'))).toBe(true)
    expect(spec.env?.[ASSETS_ENV_VAR]).toBe(spec.cwd)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('returns the settled result even when staged-directory cleanup fails', async () => {
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs).toHaveLength(1)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok')
    // The failure is reported as a warning and never as the run's outcome.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not remove the staged skill files')
    expect(warnings[0]).not.toContain(SCRIPT_CANARY)
  })

  it('keeps the settled result even when the cleanup warning sink itself throws', async () => {
    const { spawn } = immediateSpawn(0, { stdout: 'ok' })
    const executor = createScriptExecutor({
      catalog: catalogOf(bundleOf()),
      spawn,
      tempRoot,
      removeStagedAssets: () => Promise.reject(new Error('EPERM: directory not empty')),
      logWarning: () => { throw new Error('the warning sink is broken') },
    })
    const result = await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    // A throwing warning sink must not replace the already-settled result.
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok')
  })

  it('keeps the script body out of every rejection message', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot })
    const rejections = [
      executor.run({ skill: 'not-a-company-skill', script: 'scripts/demo.mjs', sessionKey: 's', signal: callerSignal() }),
      executor.run({ skill: 'runner-demo', script: 'scripts/missing.mjs', sessionKey: 's', signal: callerSignal() }),
      executor.run({ skill: 'runner-demo', script: 'scripts/../evil.mjs', sessionKey: 's', signal: callerSignal() }),
    ]
    for (const rejection of rejections) {
      await expect(rejection).rejects.toThrow(SkillRunError)
      let error: Error | undefined
      await rejection.catch((cause: unknown) => { error = cause as Error })
      expect(error?.message).not.toContain(SCRIPT_CANARY)
      expect(error?.message).not.toContain(BODY_CANARY)
    }
    expect(specs).toHaveLength(0)
  })
})

describe('addressing is validation, never path arithmetic', () => {
  it('rejects an unknown skill before spawning', async () => {
    const { spawn, specs } = immediateSpawn()
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot })
    const failure = executor.run({
      skill: 'not-a-company-skill',
      script: 'scripts/demo.mjs',
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    await expect(failure).rejects.toThrow(SkillRunError)
    await expect(failure).rejects.toThrow(/is not valid UTF-8 text/)
    let error: Error | undefined
    await failure.catch((cause: unknown) => { error = cause as Error })
    expect(error?.message).not.toContain('print')
    expect(specs).toHaveLength(0)
    // The rejected run leaves no partial staging behind.
    await expect(readdir(tempRoot)).resolves.toEqual([])
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
        exists: () => true,
      },
    })
    await executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs[0]?.argv[0]).toBe('/opt/dsh/node-runtime/node')
    // Only the staged-root variable rides along; no interpreter env is needed.
    expect(specs[0]?.env).toEqual({ [ASSETS_ENV_VAR]: expect.any(String) })
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(specs[0]?.argv[0]).toBe('/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop')
    expect(specs[0]?.env).toEqual({
      [ELECTRON_RUN_AS_NODE_ENV]: '1',
      [ASSETS_ENV_VAR]: expect.any(String),
    })
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    await expect(failure).rejects.toThrow(SkillRunError)
    await expect(failure).rejects.toThrow(/no python interpreter was found/)
    expect(specs).toHaveLength(0)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })
})

describe('timeout, truncation, and cancellation', () => {
  it('fails a run that outlives its deadline, terminates it, and removes the staged root', async () => {
    const { spawn, specs } = abortTerminatedSpawn()
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot, timeoutMs: 25, graceMs: 10 })
    const failure = executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    await expect(failure).rejects.toThrow(/timed out after 25 ms/)
    let timeoutError: Error | undefined
    await failure.catch((cause: unknown) => { timeoutError = cause as Error })
    expect(timeoutError?.message).not.toContain(SCRIPT_CANARY)
    expect(specs[0]?.signal?.aborted).toBe(true)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('removes the staged root when the launch itself throws', async () => {
    const spawn: ScriptSpawn = () => { throw new Error('EACCES: launch refused') }
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot })
    await expect(executor.run({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toHaveLength(512)
    expect(result.stdout.text).not.toContain('HEAD')
    expect(result.stderr.truncated).toBe(true)
    expect(result.stderr.text).toHaveLength(512)
  })

  it('classifies a caller cancellation as cancelled and removes the staged root', async () => {
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
      sessionKey: 'session-a',
      signal: controller.signal,
    })
    controller.abort()
    await expect(run).rejects.toThrow(/was cancelled/)
    expect(specs[0]?.signal?.aborted).toBe(true)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })
})

describe('reading a carried resource', () => {
  /** A no-spawn seam: a read must never launch a process. */
  const noSpawn: ScriptSpawn = () => { throw new Error('a read must never spawn') }

  const readCatalog = () => catalogOf(bundleOf({
    name: 'runner-read',
    assets: [
      { path: 'reference/notes.md', text: `# Notes\n\n${ASSET_CANARY}\n` },
      { path: 'editor/neo-ppt/index.html', text: '<p>editor</p>\n' },
      { path: 'editor/blob.bin', content: Buffer.from([0x00, 0xff, 0xfe, 0x01]).toString('base64') },
    ],
  }))

  it('returns the UTF-8 text of a nested carried entry', async () => {
    const executor = createScriptExecutor({ catalog: readCatalog(), spawn: noSpawn, tempRoot })
    const result = await executor.read({ skill: 'runner-read', path: 'reference/notes.md' })
    expect(result.skill).toBe('runner-read')
    expect(result.path).toBe('reference/notes.md')
    expect(result.text).toContain(ASSET_CANARY)
    expect(result.bytes).toBe(Buffer.byteLength(result.text))
    // The materialized copy is removed the moment the read settles.
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('reads a carried entry under scripts/ too (the index is also text)', async () => {
    const executor = createScriptExecutor({ catalog: readCatalog(), spawn: noSpawn, tempRoot })
    const result = await executor.read({ skill: 'runner-read', path: 'scripts/demo.mjs' })
    expect(result.text).toContain(SCRIPT_CANARY)
  })

  it('materializes exactly one entry into a private directory and deletes it in a finally block', async () => {
    const seen: string[] = []
    const executor = createScriptExecutor({
      catalog: readCatalog(),
      spawn: noSpawn,
      tempRoot,
      removeStagedAssets: (directory) => {
        seen.push(directory)
        return rm(directory, { recursive: true, force: true })
      },
    })
    await executor.read({ skill: 'runner-read', path: 'editor/neo-ppt/index.html' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.startsWith(join(tempRoot, 'dsh-skill-assets-'))).toBe(true)
    await expect(stat(seen[0] as string)).rejects.toThrow()
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('rejects an unknown path or unknown skill without staging anything', async () => {
    const executor = createScriptExecutor({ catalog: readCatalog(), spawn: noSpawn, tempRoot })
    for (const path of ['reference/missing.md', 'reference/../SKILL.md', '../SKILL.md', '/etc/passwd', 'editor']) {
      await expect(executor.read({ skill: 'runner-read', path })).rejects.toThrow(/carries no resource/)
    }
    await expect(executor.read({ skill: 'nope', path: 'reference/notes.md' })).rejects.toThrow(/cannot read from company skill/)
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })

  it('refuses an entry over the read bound instead of truncating it', async () => {
    const executor = createScriptExecutor({ catalog: readCatalog(), spawn: noSpawn, tempRoot })
    const failure = executor.read({ skill: 'runner-read', path: 'reference/notes.md', maxBytes: 4 })
    await expect(failure).rejects.toThrow(SkillRunError)
    await expect(failure).rejects.toThrow(/over the 4-byte read bound/)
    let error: Error | undefined
    await failure.catch((cause: unknown) => { error = cause as Error })
    expect(error?.message).not.toContain(ASSET_CANARY)
    await expect(readdir(tempRoot)).resolves.toEqual([])
    // A malformed bound is refused before anything is read.
    await expect(executor.read({ skill: 'runner-read', path: 'reference/notes.md', maxBytes: 0 }))
      .rejects.toThrow(/positive integer/)
  })

  it('refuses a binary entry and never leaks its bytes', async () => {
    const executor = createScriptExecutor({ catalog: readCatalog(), spawn: noSpawn, tempRoot })
    const failure = executor.read({ skill: 'runner-read', path: 'editor/blob.bin' })
    await expect(failure).rejects.toThrow(SkillRunError)
    await expect(failure).rejects.toThrow(/not UTF-8 text/)
    let error: Error | undefined
    await failure.catch((cause: unknown) => { error = cause as Error })
    expect(error?.message).not.toContain('\u0000')
    expect(error?.message).not.toContain('blob.bin\u0000')
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })
})

describe('session concurrency bound', () => {
  /** Let staging (mkdtemp + writes) finish so the seam spawn callbacks land. */
  const waitForSpawns = async (pending: (() => void)[], count: number): Promise<void> => {
    for (let round = 0; round < 200 && pending.length < count; round += 1) {
      await new Promise((resolve) => { setImmediate(resolve) })
    }
  }

  it('allows one in-flight run per session and releases the slot when it settles', async () => {
    const pending: (() => void)[] = []
    const spawn: ScriptSpawn = () => {
      const done = new Promise<SubprocessOutcome>((resolve) => {
        pending.push(() => { resolve({ exitCode: 0, signal: null }) })
      })
      return handleWith(done, { stdout: '' })
    }
    const executor = createScriptExecutor({ catalog: catalogOf(bundleOf()), spawn, tempRoot })

    const first = executor.run({ skill: 'runner-demo', script: 'scripts/demo.mjs', sessionKey: 's1', signal: callerSignal() })
    await waitForSpawns(pending, 1)
    await expect(executor.run({
      skill: 'runner-demo', script: 'scripts/demo.mjs', sessionKey: 's1', signal: callerSignal(),
    })).rejects.toThrow(/already running/)

    // A different session has its own slot.
    const other = executor.run({ skill: 'runner-demo', script: 'scripts/demo.mjs', sessionKey: 's2', signal: callerSignal() })
    await waitForSpawns(pending, 2)
    pending[1]?.()
    await expect(other).resolves.toMatchObject({ exitCode: 0 })

    pending[0]?.()
    await expect(first).resolves.toMatchObject({ exitCode: 0 })

    // The slot is free again after settlement.
    const reused = executor.run({ skill: 'runner-demo', script: 'scripts/demo.mjs', sessionKey: 's1', signal: callerSignal() })
    await waitForSpawns(pending, 3)
    pending[2]?.()
    await expect(reused).resolves.toMatchObject({ exitCode: 0 })
    await expect(readdir(tempRoot)).resolves.toEqual([])
  })
})

describe('seam passthrough', () => {
  it('hands the seam the materialized argv, staged cwd, env, and grace', async () => {
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
      sessionKey: 'session-a',
      signal: callerSignal(),
    })
    const spec = specs[0]
    expect(spec?.argv[0]).toBe('node')
    expect((spec?.argv[1] as string).endsWith(join('scripts', 'demo.mjs'))).toBe(true)
    expect(spec?.argv.slice(2)).toEqual(['--alpha'])
    // cwd is the staged skill root — the parent of the script's own directory.
    expect(spec?.cwd).toBe(dirname(dirname(spec?.argv[1] as string)))
    expect(spec?.graceMs).toBe(1234)
    expect(spec?.stdio.stdin).toBe('ignore')
    expect(spec?.env?.[ASSETS_ENV_VAR]).toBe(spec?.cwd)
    expect(spec?.signal).toBeInstanceOf(AbortSignal)
  })
})
