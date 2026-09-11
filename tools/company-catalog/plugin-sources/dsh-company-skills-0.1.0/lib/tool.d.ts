/**
 * The model-facing company-skill tools (P6 batch 3/4).
 *
 * `company_skill_run` and `company_skill_read` are deliberately thin: they
 * validate the model's addressing arguments, resolve the session identity from
 * the execution context, and delegate every bound and every rejection to the
 * {@link ScriptExecutor}. The executor — not this layer — owns interpreter
 * selection, per-call materialization into the private staged directory,
 * output/read caps, and the timeout, so a tool definition cannot accidentally
 * bypass one of them.
 *
 * `company_skill_read` exists because the bundle is opaque: the upstream
 * consumer only renders the resourceBase hint, so the prose a skill depends on
 * (`reference/pptd.md`, `references/workflows.md`) is unreachable without a
 * text channel. The read tool addresses one carried entry by exact path and
 * returns its UTF-8 text.
 *
 * `presentCall` renders a card from the arguments alone (skill + path/script),
 * so a replayed call never needs the body.
 *
 * @module dsh-company-skills/tool
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ReadResourceResult, RunScriptResult, ScriptExecutor } from './execute.js';
/** Tool name the model sees. */
export declare const COMPANY_SKILL_RUN_TOOL_NAME = "company_skill_run";
/** The canonical value one successful call returns; also the model-facing shape. */
export interface CompanySkillRunValue {
    readonly skill: string;
    readonly script: string;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
}
/**
 * Project one settled run onto the canonical tool value. Truncation is
 * surfaced explicitly so the model knows the tail it sees is partial.
 * @param result - the executor's settled run.
 * @returns the lossless-JSON value declared by the tool's output schema.
 */
export declare function toRunValue(result: RunScriptResult): CompanySkillRunValue;
/**
 * Render the canonical value for the model. Only the script's own output is
 * echoed; the script source is never part of the rendering path.
 * @param value - the canonical run value.
 * @returns the plain-text tool result.
 */
export declare function renderRunValue(value: CompanySkillRunValue): string;
/** Tool name the model sees for resource reads. */
export declare const COMPANY_SKILL_READ_TOOL_NAME = "company_skill_read";
/** The canonical value one successful read returns; also the model-facing shape. */
export interface CompanySkillReadValue {
    readonly skill: string;
    readonly path: string;
    readonly text: string;
    readonly bytes: number;
}
/**
 * Project one decoded resource onto the canonical tool value.
 * @param result - the executor's decoded resource.
 * @returns the lossless-JSON value declared by the tool's output schema.
 */
export declare function toReadValue(result: ReadResourceResult): CompanySkillReadValue;
/**
 * Render the canonical read value for the model: a one-line header naming the
 * skill, resource, and byte length, then the text verbatim.
 * @param value - the canonical read value.
 * @returns the plain-text tool result.
 */
export declare function renderReadValue(value: CompanySkillReadValue): string;
/**
 * Build the `company_skill_read` definition for one executor.
 * @param executor - the catalog-backed script executor.
 * @returns a registry-ready tool definition.
 */
export declare function createCompanySkillReadTool(executor: ScriptExecutor): ToolDefinition;
/**
 * Build the `company_skill_run` definition for one executor.
 * @param executor - the catalog-backed script executor.
 * @returns a registry-ready tool definition.
 */
export declare function createCompanySkillRunTool(executor: ScriptExecutor): ToolDefinition;
