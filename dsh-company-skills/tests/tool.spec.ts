/**
 * The `company_skill_run` tool surface and its registration wiring.
 *
 * The wiring case mounts the real plugin on a real Cordis context with tiny
 * recording services for `tools` and `subprocess`, so the reactive
 * `ctx.inject(['tools', 'subprocess'], …)` seam, the spawn delegation, and
 * disposal are all exercised against real injection rather than a mock. The
 * recording subprocess delegates to the same real child-process seam the
 * executor tests use, so this is a genuine end-to-end run: plugin → tool →
 * executor → staged skill directory → child process → cleanup.
 *
 * @module dsh-company-skills/tests/tool
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  ASSETS_ENV_VAR,
  DESKTOP_PYTHON_EXECUTABLE_ENV,
  type ReadResourceRequest,
  type RunScriptRequest,
  type ScriptExecutor,
} from '../src/execute.js'
import * as CompanySkills from '../src/index.js'
import {
  COMPANY_SKILL_READ_TOOL_NAME,
  COMPANY_SKILL_RUN_TOOL_NAME,
  createCompanySkillReadTool,
  createCompanySkillRunTool,
  renderRunValue,
  toRunValue,
} from '../src/tool.js'
import { localSpawn } from './local-spawn.js'
import { pythonInterpreter } from './python.js'

/** A stub executor that records the request and returns a fixed run/read. */
function stubExecutor(): { executor: ScriptExecutor; requests: RunScriptRequest[]; reads: ReadResourceRequest[] } {
  const requests: RunScriptRequest[] = []
  const reads: ReadResourceRequest[] = []
  const executor: ScriptExecutor = {
    limits: {
      timeoutMs: 120_000,
      graceMs: 5_000,
      maxOutputBytes: 64 * 1024,
      maxConcurrentPerSession: 1,
      maxReadBytes: 256 * 1024,
    },
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
    read(request) {
      reads.push(request)
      return Promise.resolve({ skill: request.skill, path: request.path, text: 'READ-LINE\n', bytes: 10 })
    },
  }
  return { executor, requests, reads }
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

  it('resolves session identity from the execution context', async () => {
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
      sessionKey: 'session-7',
      signal: controller.signal,
    })
    expect(requests[0]).not.toHaveProperty('cwd')
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

describe('company_skill_read tool definition', () => {
  it('declares the addressing parameters and the output shape, and delegates the read', async () => {
    const { executor, reads } = stubExecutor()
    const tool = createCompanySkillReadTool(executor)
    expect(tool.name).toBe(COMPANY_SKILL_READ_TOOL_NAME)
    expect(tool.name).toBe('company_skill_read')
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['skill', 'path'],
      properties: {
        skill: { type: 'string' },
        path: { type: 'string' },
        maxBytes: { type: 'integer' },
      },
    })
    expect(tool.output.schema).toMatchObject({
      type: 'object',
      required: ['skill', 'path', 'text', 'bytes'],
    })
    expect(tool.presentCall?.({ skill: 'ppt-designer', path: 'reference/pptd.md' })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'Read ppt-designer/reference/pptd.md',
      rawInput: 'reference/pptd.md',
    })

    const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
    const value = await tool.execute(
      { skill: 'ppt-designer', path: 'reference/pptd.md', maxBytes: 1024 },
      exec,
    )
    expect(reads).toEqual([{ skill: 'ppt-designer', path: 'reference/pptd.md', maxBytes: 1024 }])
    expect(value).toEqual({ skill: 'ppt-designer', path: 'reference/pptd.md', text: 'READ-LINE\n', bytes: 10 })
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
    expect(tools.registered.map((tool) => tool.name)).toEqual([
      COMPANY_SKILL_RUN_TOOL_NAME,
      COMPANY_SKILL_READ_TOOL_NAME,
    ])

    await app.dispose()
    expect(tools.registered).toEqual([])
  })

  it.skipIf(pythonInterpreter === undefined)('runs a shipped company skill script end to end and removes the staged skill root', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(RecordingTools)
    await ctx.plugin(RecordingSubprocess)
    await ctx.plugin(CompanySkills)

    const tool = recordingTools(ctx).registered[0] as ToolDefinition
    const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
    // A real collected script, run for real: skill-creator's initializer writes
    // its template skill into an absolute workspace directory (the skill's own
    // documented usage), proving addressing, staging, args, the Python
    // interpreter, and cleanup all work on shipped content.
    const workspace = await mkdtemp(join(tmpdir(), 'company-skills-e2e-'))
    const previous = process.env[DESKTOP_PYTHON_EXECUTABLE_ENV]
    // CI runners ship `python3`, not the bare `python` the PATH fallback looks
    // for; publish the absolute interpreter the desktop would publish.
    process.env[DESKTOP_PYTHON_EXECUTABLE_ENV] = pythonInterpreter as string
    try {
      const value = await tool.execute({
        skill: 'skill-creator',
        script: 'scripts/init_skill.py',
        args: ['collected-e2e-skill', '--path', workspace],
      }, exec) as { exitCode: number; stdout: string }

      expect(value.exitCode).toBe(0)
      expect(value.stdout).toContain('Created SKILL.md')
      const created = join(workspace, 'collected-e2e-skill', 'SKILL.md')
      expect(existsSync(created)).toBe(true)
      expect(readFileSync(created, 'utf8')).toContain('name: collected-e2e-skill')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      if (previous === undefined) delete process.env[DESKTOP_PYTHON_EXECUTABLE_ENV]
      else process.env[DESKTOP_PYTHON_EXECUTABLE_ENV] = previous
    }

    const spec = recordingSubprocess(ctx).specs[0]
    // The interpreter was pointed at the materialized script file — never a
    // stdin pipe — with the staged root as cwd and stdin closed.
    expect(spec?.argv[0]).toBe(pythonInterpreter)
    expect((spec?.argv[1] as string).endsWith(join('scripts', 'init_skill.py'))).toBe(true)
    expect(spec?.stdio.stdin).toBe('ignore')

    const stagedRoot = spec?.env?.[ASSETS_ENV_VAR]
    expect(typeof stagedRoot).toBe('string')
    expect(spec?.cwd).toBe(stagedRoot)
    await expect(stat(stagedRoot as string)).rejects.toThrow()
  })
})
