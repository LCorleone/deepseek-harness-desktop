/**
 * The model-facing `company_skill_run` tool (P6 batch 3).
 *
 * The definition is deliberately thin: it validates the model's addressing
 * arguments, resolves the session identity from the execution context, and
 * delegates every bound and every rejection to the {@link ScriptExecutor}.
 * The executor — not this layer — owns interpreter selection, per-run
 * materialization into the private staged directory, output caps, and the
 * timeout, so the tool definition cannot accidentally bypass one of them.
 *
 * `presentCall` renders a card from the arguments alone (skill + script), so a
 * replayed call never needs the body.
 *
 * @module dsh-company-skills/tool
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ScriptExecutor, RunScriptResult } from './execute.js'

/** Tool name the model sees. */
export const COMPANY_SKILL_RUN_TOOL_NAME = 'company_skill_run'

/** The canonical value one successful call returns; also the model-facing shape. */
export interface CompanySkillRunValue {
  readonly skill: string
  readonly script: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

/**
 * Project one settled run onto the canonical tool value. Truncation is
 * surfaced explicitly so the model knows the tail it sees is partial.
 * @param result - the executor's settled run.
 * @returns the lossless-JSON value declared by the tool's output schema.
 */
export function toRunValue(result: RunScriptResult): CompanySkillRunValue {
  return {
    skill: result.skill,
    script: result.script,
    exitCode: result.exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    stdoutTruncated: result.stdout.truncated,
    stderrTruncated: result.stderr.truncated,
  }
}

/** One labelled output section; an empty stream is rendered explicitly, never omitted ambiguously. */
function section(label: string, text: string, truncated: boolean): string {
  const body = text.length === 0 ? '(empty)' : text.replace(/\n$/u, '')
  return `--- ${label}${truncated ? ' (truncated)' : ''} ---\n${body}`
}

/**
 * Render the canonical value for the model. Only the script's own output is
 * echoed; the script source is never part of the rendering path.
 * @param value - the canonical run value.
 * @returns the plain-text tool result.
 */
export function renderRunValue(value: CompanySkillRunValue): string {
  return [
    `company skill "${value.skill}" ran ${value.script} (exit code ${String(value.exitCode)})`,
    section('stdout', value.stdout, value.stdoutTruncated),
    section('stderr', value.stderr, value.stderrTruncated),
  ].join('\n\n')
}

/**
 * Build the `company_skill_run` definition for one executor.
 * @param executor - the catalog-backed script executor.
 * @returns a registry-ready tool definition.
 */
export function createCompanySkillRunTool(executor: ScriptExecutor): ToolDefinition {
  return defineTool({
    name: COMPANY_SKILL_RUN_TOOL_NAME,
    description:
      'Run one script that ships inside a company skill. The skill is materialized into a private '
      + '0600 temp directory for the duration of the run and removed the moment it settles, so the files never '
      + 'persist and this tool is the only way to run those scripts; a workspace `bash` or `read` cannot see them. '
      + '`skill` must be a company skill name from the skill catalog and `script` must be one of that skill\'s own '
      + 'declared script paths (for example "scripts/report.mjs"), passed exactly as the skill declares it. The '
      + 'script runs with the staged skill root as its working directory, so bundle-relative reads such as '
      + '`assets/data.json` resolve as written and `__file__` locates the skill root. `args` is appended to the '
      + 'interpreter argv verbatim. Returns the exit code plus stdout and stderr, each capped at '
      + `${String(Math.round(executor.limits.maxOutputBytes / 1024))} KiB (overflow keeps the tail and is reported as truncated). `
      + `A run is limited to ${String(executor.limits.maxConcurrentPerSession)} in flight per session and to a `
      + `${String(Math.round(executor.limits.timeoutMs / 1000))} s deadline.`,
    parameters: {
      skill: {
        type: 'string',
        required: true,
        description: 'Company skill name exactly as the skill catalog lists it.',
      },
      script: {
        type: 'string',
        required: true,
        description: 'Bundle-relative script path exactly as the skill declares it, e.g. "scripts/report.mjs". Must be one of that skill\'s own scripts.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra argv appended after the script path; passed to the interpreter verbatim.',
      },
    },
    // Our own executor deadline fires first; this host-side budget is the
    // backstop that aborts `exec.signal` if the timer is wedged.
    timeoutMs: executor.limits.timeoutMs + executor.limits.graceMs,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', required: true },
          script: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          stdoutTruncated: { type: 'boolean', required: true },
          stderrTruncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRunValue(value) }],
    },
    async execute(args, exec) {
      const result = await executor.run({
        skill: args.skill,
        script: args.script,
        ...(args.args === undefined ? {} : { args: args.args }),
        // The executor stages the skill and runs the child with the staged root
        // as its working directory; only session identity is resolved here.
        // One in-flight run per session; an unscoped call shares one slot.
        sessionKey: exec.agent?.id ?? 'unscoped',
        signal: exec.signal,
      })
      return toRunValue(result)
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'execute',
      title: `Run ${args.skill}/${args.script}`,
      rawInput: args.args === undefined || args.args.length === 0 ? args.script : args.args.join(' '),
    }),
  })
}
