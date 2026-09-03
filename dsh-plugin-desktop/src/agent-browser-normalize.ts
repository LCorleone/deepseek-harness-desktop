/**
 * Action-argument normalizer of the agent-browser surface (design §4,
 * scout-cua lesson 1).
 *
 * A pure `normalizeBrowserArgs()` runs at the top of every argumented
 * browser tool's `execute`: the DECLARED schemas stay canonical, but the
 * normalizer accepts the class of model-hallucinated aliases cua validated —
 * `click_type`/`left_click`/`single_click` → `click` parameters,
 * `coordinate:[x,y]` → `x`/`y`, `element`/`ref_id` → `ref`, scheme-less
 * `url` → `https://…`, and stringified numbers for `generation`. The tool
 * never rejects a semantically correct call over spelling.
 *
 * Two contracts worth stating precisely:
 *
 * - The registry validates declared properties against the canonical schema
 *   BEFORE `execute` runs, so fields whose presence is enforced AFTER
 *   normalization (`ref`, `text`, `direction`, `amount`) are deliberately
 *   NOT schema-required — an alias-only call (`{ element: "e5" }`) must pass
 *   validation and reach this module, which maps it onto the canonical name.
 *   `browser_open`/`browser_navigate` keep `url` schema-required because the
 *   url aliases fix VALUES, not names.
 * - Coercion is scalar-only: strings holding numbers become numbers, a
 *   numeric `backendNodeId` becomes its `e<base36>` ref form, and non-scalar
 *   alias values are dropped (never stringified into nonsense).
 *
 * The output carries exactly the canonical fields — every unrecognized or
 * consumed alias key is dropped (never copied, never stringified), and the
 * input object is never mutated (frozen model arguments arrive here).
 *
 * @module dsh-plugin-desktop/agent-browser-normalize
 */

import { agentBrowserRef } from './agent-browser-session.ts'
import type {
  AgentBrowserMouseButton,
  AgentBrowserScrollDirection,
} from './agent-browser-contract.ts'

/** The argumented browser tools the normalizer knows. */
export type BrowserToolName =
  | 'browser_open'
  | 'browser_navigate'
  | 'browser_click'
  | 'browser_type'
  | 'browser_scroll'

/** Canonical `browser_open` arguments after normalization. */
export interface NormalizedBrowserOpenArgs {
  readonly tool: 'browser_open'
  readonly url: string
  readonly waitForLoad?: boolean
}

/** Canonical `browser_navigate` arguments after normalization. */
export interface NormalizedBrowserNavigateArgs {
  readonly tool: 'browser_navigate'
  readonly url: string
}

/**
 * Canonical `browser_click` arguments after normalization. `x`/`y` are the
 * documented coordinate fallback (design §3): carried, not enabled — the
 * executor rejects them with a ref-pointing correction.
 */
export interface NormalizedBrowserClickArgs {
  readonly tool: 'browser_click'
  readonly ref: string | undefined
  readonly generation?: number
  readonly button?: AgentBrowserMouseButton
  readonly clickCount?: number
  readonly x?: number
  readonly y?: number
}

/** Canonical `browser_type` arguments after normalization. */
export interface NormalizedBrowserTypeArgs {
  readonly tool: 'browser_type'
  readonly ref: string | undefined
  readonly text: string | undefined
  readonly generation?: number
  readonly clear?: boolean
  readonly submit?: boolean
}

/** Canonical `browser_scroll` arguments after normalization. */
export interface NormalizedBrowserScrollArgs {
  readonly tool: 'browser_scroll'
  readonly ref: string | undefined
  readonly direction: AgentBrowserScrollDirection | undefined
  readonly amount: number | undefined
  readonly generation?: number
}

/** Discriminated canonical arguments of every known browser tool. */
export type NormalizedBrowserArgs =
  | NormalizedBrowserOpenArgs
  | NormalizedBrowserNavigateArgs
  | NormalizedBrowserClickArgs
  | NormalizedBrowserTypeArgs
  | NormalizedBrowserScrollArgs

/** Alias keys the normalizer maps onto `ref` (scout-cua's `ref_id` class). */
const REF_ALIASES = ['element', 'ref_id', 'element_ref', 'target_ref', 'node_ref', 'node'] as const
/** Alias keys carrying a `[x, y]` (or `{x, y}`) coordinate pair. */
const COORDINATE_ALIASES = ['coordinate', 'coordinates', 'point', 'position'] as const
/** Alias keys mapping onto `text`. */
const TEXT_ALIASES = ['value', 'content', 'input', 'text_to_type', 'keys'] as const
/** Alias keys mapping onto `submit` (truthy → true). */
const SUBMIT_ALIASES = ['submit_form', 'press_enter', 'hit_enter', 'enter'] as const
/** Alias keys mapping onto `clear`. */
const CLEAR_ALIASES = ['clear_field', 'replace', 'overwrite'] as const
/** Alias keys mapping onto `generation`. */
const GENERATION_ALIASES = ['gen', 'snapshot_generation', 'generation_id'] as const
/** Alias keys mapping onto `amount` (scroll pixels). */
const AMOUNT_ALIASES = ['scroll_amount', 'pixels', 'px', 'delta', 'distance'] as const
/** Alias keys mapping onto `direction`. */
const DIRECTION_ALIASES = ['scroll_direction', 'dir', 'scroll_dir'] as const
/** Alias keys mapping onto `clickCount`. */
const CLICK_COUNT_ALIASES = ['click_count', 'clicks', 'count'] as const
/** Alias keys whose STRING VALUE names a mouse button or click style. */
const CLICK_STYLE_VALUE_KEYS = ['click_type', 'clickType', 'mouse_button', 'button_name'] as const
/** Boolean-true alias keys that ARE the click style themselves. */
const CLICK_STYLE_FLAG_KEYS = {
  left_click: 'left',
  single_click: 'left',
  double_click: 'double',
  triple_click: 'triple',
  right_click: 'right',
  middle_click: 'middle',
} as const

/** Read one scalar of the wanted primitive; anything else is absent. */
function scalar(value: unknown, kind: 'string' | 'number' | 'boolean'): unknown {
  if (kind === 'string') return typeof value === 'string' ? value : undefined
  if (kind === 'boolean') return typeof value === 'boolean' ? value : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A number from a number or a numeric string (`"3"` → 3); else undefined. */
function numberish(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** First alias value present as the wanted scalar kind. */
function takeAlias(
  source: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[],
  kind: 'string' | 'number' | 'boolean',
): unknown {
  const direct = scalar(source[canonical], kind)
  if (direct !== undefined) return direct
  for (const alias of aliases) {
    const found = scalar(source[alias], kind)
    if (found !== undefined) return found
  }
  return undefined
}

/** Normalize one ref-shaped value: `e…` string or numeric backendNodeId. */
function normalizeRefValue(value: unknown): string | undefined {
  if (typeof value === 'string' && /^e[0-9a-z]+$/u.test(value.trim())) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return agentBrowserRef(value)
  return undefined
}

/** The `e…` ref from the canonical key or any ref alias. */
function takeRef(source: Record<string, unknown>): string | undefined {
  const direct = normalizeRefValue(source.ref)
  if (direct !== undefined) return direct
  for (const alias of REF_ALIASES) {
    const found = normalizeRefValue(source[alias])
    if (found !== undefined) return found
  }
  return undefined
}

/** The coordinate pair from `coordinate`-class aliases (`[x,y]` or `{x,y}`). */
function takeCoordinate(source: Record<string, unknown>): { x: number, y: number } | undefined {
  for (const alias of COORDINATE_ALIASES) {
    const value = source[alias]
    const pair = Array.isArray(value) && value.length >= 2
      ? { x: numberish(value[0]), y: numberish(value[1]) }
      : value !== null && typeof value === 'object'
        ? { x: numberish((value as { x?: unknown }).x), y: numberish((value as { y?: unknown }).y) }
        : undefined
    if (pair !== undefined && pair.x !== undefined && pair.y !== undefined) return { x: pair.x, y: pair.y }
  }
  return undefined
}

/** Map a click-style string onto its canonical button/clickCount. */
function clickStyle(value: unknown): { button?: AgentBrowserMouseButton, clickCount?: number } {
  if (typeof value !== 'string') return {}
  const style = value.trim().toLowerCase().replaceAll(/[\s-]+/gu, '_')
  switch (style) {
    case 'left':
    case 'primary':
    case 'left_click':
    case 'single_click':
    case 'single':
    case 'click':
      return { button: 'left' }
    case 'right':
    case 'secondary':
    case 'context':
    case 'right_click':
      return { button: 'right' }
    case 'middle':
    case 'middle_click':
    case 'aux':
      return { button: 'middle' }
    case 'double':
    case 'double_click':
      return { button: 'left', clickCount: 2 }
    case 'triple':
    case 'triple_click':
      return { button: 'left', clickCount: 3 }
    default:
      return {}
  }
}

/** The `button` from the canonical key, alias keys, or click-style keys. */
function takeClickStyle(source: Record<string, unknown>): { button?: AgentBrowserMouseButton, clickCount?: number } {
  const canonical = clickStyle(source.button)
  if (canonical.button !== undefined) return canonical
  for (const key of CLICK_STYLE_VALUE_KEYS) {
    const mapped = clickStyle(source[key])
    if (mapped.button !== undefined || mapped.clickCount !== undefined) return mapped
  }
  for (const key of Object.keys(CLICK_STYLE_FLAG_KEYS) as Array<keyof typeof CLICK_STYLE_FLAG_KEYS>) {
    if (source[key] === true || (typeof source[key] === 'string' && source[key]!.trim().toLowerCase() === 'true')) {
      return clickStyle(CLICK_STYLE_FLAG_KEYS[key])
    }
  }
  return {}
}

/** Truthiness of one alias class: only explicit `true` (or "true") counts. */
function takeTruthy(source: Record<string, unknown>, canonical: string, aliases: readonly string[]): boolean | undefined {
  const read = (value: unknown): boolean | undefined => {
    if (value === true) return true
    if (typeof value === 'string' && value.trim().toLowerCase() === 'true') return true
    return undefined
  }
  const direct = read(source[canonical])
  if (direct !== undefined) return direct
  for (const alias of aliases) {
    const found = read(source[alias])
    if (found !== undefined) return found
  }
  return undefined
}

/** Prepend `https://` to a scheme-less url and lowercase the scheme. */
function normalizeUrlValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    const schemeEnd = trimmed.indexOf(':')
    return `${trimmed.slice(0, schemeEnd).toLowerCase()}${trimmed.slice(schemeEnd)}`
  }
  return `https://${trimmed}`
}

/** Keys the normalizer consumed; removed from the canonical output. */
const CONSUMED_ALIAS_KEYS: readonly string[] = [
  ...REF_ALIASES,
  ...COORDINATE_ALIASES,
  ...TEXT_ALIASES,
  ...SUBMIT_ALIASES,
  ...CLEAR_ALIASES,
  ...GENERATION_ALIASES,
  ...AMOUNT_ALIASES,
  ...DIRECTION_ALIASES,
  ...CLICK_COUNT_ALIASES,
  ...CLICK_STYLE_VALUE_KEYS,
  ...Object.keys(CLICK_STYLE_FLAG_KEYS),
]

/**
 * Normalize one raw argument record onto the canonical shape of `tool`.
 *
 * Pure: builds a fresh output object carrying exactly the canonical fields
 * (unrecognized and consumed alias keys are dropped), never mutates the
 * input, and returns an empty canonical shell for non-object inputs.
 */
export function normalizeBrowserArgs<T extends BrowserToolName>(
  tool: T,
  args: unknown,
): Extract<NormalizedBrowserArgs, { readonly tool: T }> {
  // The builder returns the union; this cast narrows to the caller's literal
  // so every call site gets its exact canonical shape.
  return buildNormalizedBrowserArgs(tool, args) as Extract<NormalizedBrowserArgs, { readonly tool: T }>
}

function buildNormalizedBrowserArgs(tool: BrowserToolName, args: unknown): NormalizedBrowserArgs {
  const source: Record<string, unknown> = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? { ...(args as Record<string, unknown>) }
    : {}
  const generation = numberish(source.generation)
    ?? numberish(source.gen)
    ?? numberish(source.snapshot_generation)
    ?? numberish(source.generation_id)
  const ref = takeRef(source)
  switch (tool) {
    case 'browser_open': {
      const waitForLoad = takeTruthy(source, 'waitForLoad', ['wait_for_load'])
      return {
        tool,
        url: normalizeUrlValue(source.url) ?? '',
        ...(waitForLoad === undefined ? {} : { waitForLoad }),
      }
    }
    case 'browser_navigate':
      return { tool, url: normalizeUrlValue(source.url) ?? '' }
    case 'browser_click': {
      const coordinate = takeCoordinate(source)
      const style = takeClickStyle(source)
      const clickCount = numberish(source.clickCount)
        ?? numberish(source.click_count)
        ?? numberish(source.clicks)
        ?? numberish(source.count)
        ?? style.clickCount
      return {
        tool,
        ref,
        ...(generation === undefined ? {} : { generation }),
        ...(style.button === undefined ? {} : { button: style.button }),
        ...(clickCount === undefined ? {} : { clickCount }),
        ...(coordinate === undefined ? {} : { x: coordinate.x, y: coordinate.y }),
      }
    }
    case 'browser_type': {
      const text = takeAlias(source, 'text', TEXT_ALIASES, 'string') as string | undefined
      const clear = takeTruthy(source, 'clear', CLEAR_ALIASES)
      const submit = takeTruthy(source, 'submit', SUBMIT_ALIASES)
      return {
        tool,
        ref,
        text,
        ...(generation === undefined ? {} : { generation }),
        ...(clear === undefined ? {} : { clear }),
        ...(submit === undefined ? {} : { submit }),
      }
    }
    case 'browser_scroll': {
      const directionValue = takeAlias(source, 'direction', DIRECTION_ALIASES, 'string') as string | undefined
      const direction = directionValue === 'up' || directionValue === 'down'
        ? directionValue
        : directionValue === 'upward' ? 'up' : directionValue === 'downward' ? 'down' : undefined
      const amount = numberish(source.amount)
        ?? numberish(source.scroll_amount)
        ?? numberish(source.pixels)
        ?? numberish(source.px)
        ?? numberish(source.delta)
        ?? numberish(source.distance)
      return {
        tool,
        ref,
        direction,
        amount,
        ...(generation === undefined ? {} : { generation }),
      }
    }
  }
}

/** Alias keys this module recognizes (the spec matrix documents them). */
export const NORMALIZED_ALIAS_KEYS: readonly string[] = CONSUMED_ALIAS_KEYS
