/**
 * The `company_skill_run` tool surface and its registration wiring.
 *
 * The wiring case mounts the real plugin on a real Cordis context with tiny
 * recording services for `tools` and `subprocess`, so the reactive
 * `ctx.inject(['tools', 'subprocess'], …)` seam, the spawn delegation, and
 * disposal are all exercised against real injection rather than a mock. The
 * recording subprocess delegates to the same real `node -` seam the executor
 * tests use, so this is a genuine end-to-end run: plugin → tool → executor →
 * child process → staged-asset cleanup.
 *
 * @module dsh-company-skills/tests/tool
 */

import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  ASSETS_ENV_VAR,
  type RunScriptRequest,
  type ScriptExecutor,
} from '../src/execute.js'
import * as CompanySkills from '../src/index.js'
import {
  COMPANY_SKILL_RUN_TOOL_NAME,
  createCompanySkillRunTool,
  renderRunValue,
  toRunValue,
} from '../src/tool.js'
import { localSpawn } from './local-spawn.js'
import { PACKAGE_ROOT } from './tools.js'

const HELLO_SCRIPT = readFileSync(
  join(fileURLToPath(PACKAGE_ROOT), 'fixtures', 'fixture-hello', 'scripts', 'hello.mjs'),
  'utf8',
)

/** A stub executor that records the request and returns a fixed run. */
function stubExecutor(): { executor: ScriptExecutor; requests: RunScriptRequest[] } {
  const requests: RunScriptRequest[] = []
  const executor: ScriptExecutor = {
    limits: { timeoutMs: 120_000, graceMs: 5_000, maxOutputBytes: 64 * 1024, maxConcurrentPerSession: 1 },
    run(request) {
      requests.push(request)
      return Promise.resolve({
        skill: request.skill,
        script: request.script,
        exitCode: 0,
        stdout: { text: 'OUT-LINE\n', truncated: false },
        stderr: { text: '', truncated: false },
      })
    },
  }
  return { executor, requests }
}

/** A minimal `tools` service whose registrations are observable. */
class RecordingTools extends Service {
  readonly registered: ToolDefinition[] = []
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(definition: ToolDefinition): () => void {
    this.registered.push(definition)
    return () => {
      const index = this.registered.indexOf(definition)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }
}

/** A minimal `subprocess` service that records specs and runs them for real. */
class RecordingSubprocess extends Service {
  readonly specs: SubprocessSpawnSpec[] = []
  constructor(ctx: Context) {
    super(ctx, 'subprocess')
  }
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    return localSpawn(spec)
  }
}

const recordingTools = (ctx: Context): RecordingTools => ctx.get('tools') as unknown as RecordingTools
const recordingSubprocess = (ctx: Context): RecordingSubprocess => ctx.get('subprocess') as unknown as RecordingSubprocess

describe('company_skill_run tool definition', () => {
  it('declares the addressing parameters, the output shape, and the tool-owned budget', () => {
    const { executor } = stubExecutor()
    const tool = createCompanySkillRunTool(executor)
    expect(tool.name).toBe(COMPANY_SKILL_RUN_TOOL_NAME)
    expect(tool.name).toBe('company_skill_run')
    expect(tool.timeoutMs).toBe(125_000)
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['skill', 'script'],
      properties: {
        skill: { type: 'string' },
        script: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
    })
    expect(tool.output.schema).toMatchObject({
      type: 'object',
      required: ['skill', 'script', 'exitCode', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated'],
    })
    expect(tool.presentCall?.({ skill: 'runner-demo', script: 'scripts/demo.mjs' })).toEqual({
      card: 'generic',
      kind: 'execute',
      title: 'Run runner-demo/scripts/demo.mjs',
      rawInput: 'scripts/demo.mjs',
    })
  })

  it('resolves cwd and session identity from the execution context', async () => {
    const { executor, requests } = stubExecutor()
    const tool = createCompanySkillRunTool(executor)
    const controller = new AbortController()
    const exec = {
      signal: controller.signal,
      agent: { id: 'session-7', session: { header: { cwd: '/workspace/seven' } } },
    } as unknown as ToolRunContext

    const value = await tool.execute({ skill: 'runner-demo', script: 'scripts/demo.mjs', args: ['--x'] }, exec)

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      args: ['--x'],
      cwd: '/workspace/seven',
      sessionKey: 'session-7',
      signal: controller.signal,
    })
    expect(value).toEqual({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      exitCode: 0,
      stdout: 'OUT-LINE\n',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    })
  })

  it('renders stdout and stderr, marking truncation', () => {
    const text = renderRunValue({
      skill: 'runner-demo',
      script: 'scripts/demo.mjs',
      exitCode: 2,
      stdout: 'out\n',
      stderr: 'err',
      stdoutTruncated: true,
      stderrTruncated: false,
    })
    expect(text).toContain('company skill "runner-demo" ran scripts/demo.mjs (exit code 2)')
    expect(text).toContain('--- stdout (truncated) ---\nout')
    expect(text).toContain('--- stderr ---\nerr')
    expect(toRunValue({
      skill: 's',
      script: 'scripts/s.mjs',
      exitCode: 0,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    })).toMatchObject({ skill: 's', exitCode: 0 })
  })
})

describe('registration wiring', () => {
  it('registers on the tools seam once tools and subprocess exist, and disposes with the plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(RecordingTools)
    await ctx.plugin(RecordingSubprocess)

    const app = await ctx.plugin(CompanySkills)
    const tools = recordingTools(ctx)
    expect(tools.registered.map((tool) => tool.name)).toEqual([COMPANY_SKILL_RUN_TOOL_NAME])

    await app.dispose()
    expect(tools.registered).toEqual([])
  })

  it('runs a bundled fixture script end to end and removes the staged assets', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(RecordingTools)
    await ctx.plugin(RecordingSubprocess)
    await ctx.plugin(CompanySkills)

    const tool = recordingTools(ctx).registered[0] as ToolDefinition
    const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
    const value = await tool.execute({ skill: 'fixture-hello', script: 'scripts/hello.mjs' }, exec) as {
      exitCode: number
      stdout: string
    }

    expect(value.exitCode).toBe(0)
    expect(value.stdout).toContain('fixture-hello would read assets/notes.md')

    const spec = recordingSubprocess(ctx).specs[0]
    // The source reached the child over stdin, byte for byte, and never a path.
    expect(spec?.argv).toEqual(['node', '-'])
    expect(spec?.stdio.stdin).toEqual({ data: HELLO_SCRIPT })

    const assetsDirectory = spec?.env?.[ASSETS_ENV_VAR]
    expect(typeof assetsDirectory).toBe('string')
    await expect(stat(assetsDirectory as string)).rejects.toThrow()
  })
})
