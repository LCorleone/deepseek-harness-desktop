/**
 * Client surfaces of the P8 agent browser (design §2/§5.4, B3): the
 * conversation banner that mirrors the browser window's live state and
 * carries the loopback claim/release actions, plus the compact tool result
 * cards for the browser tools.
 *
 * Everything here is plain React + same-origin fetch/EventSource over the
 * loopback routes — zero Node globals (the renderer-node-globals gate covers
 * this file), and the native browser window never uses it (it loads file://
 * and rides the preload bridge instead).
 *
 * @module dsh-plugin-desktop/client/agent-browser-ui
 */

import { useEffect, useState } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: brings the conversation + tool SlotMap merges into this program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { AgentBrowserEventFrame, AgentBrowserPhase } from '../agent-browser-contract.ts'
import {
  DESKTOP_AGENT_BROWSER_CLAIM_PATH,
  DESKTOP_AGENT_BROWSER_EVENTS_PATH,
  DESKTOP_AGENT_BROWSER_RELEASE_PATH,
  DESKTOP_AGENT_BROWSER_STATE_PATH,
} from '../agent-browser-contract.ts'

// ── Locale ─────────────────────────────────────────────────────────────────

/** Locale namespace owned by the agent-browser client surfaces. */
export const DESKTOP_AGENT_BROWSER_LOCALE_NAMESPACE = 'desktop.agentBrowser'

export const zh = {
  toolName: '内嵌浏览器',
  phaseIdle: '空闲',
  phaseObserving: '观察中',
  phaseActing: '操作中',
  phaseClaimed: '操作者已接管',
  takeOver: '接管',
  release: '释放',
  pending: '请求中…',
  toolOpen: '打开页面',
  toolNavigate: '跳转页面',
  toolSnapshot: '页面快照',
  toolScreenshot: '页面截图',
  running: '执行中…',
  failed: '失败',
  truncated: '（已截断）',
} as const

export type AgentBrowserLocaleKey = keyof typeof zh

export const en: Record<AgentBrowserLocaleKey, string> = {
  toolName: 'Agent browser',
  phaseIdle: 'idle',
  phaseObserving: 'observing',
  phaseActing: 'acting',
  phaseClaimed: 'operator has control',
  takeOver: 'Take over',
  release: 'Release',
  pending: 'Working…',
  toolOpen: 'Opened page',
  toolNavigate: 'Navigated to page',
  toolSnapshot: 'Page snapshot',
  toolScreenshot: 'Screenshot',
  running: 'Running…',
  failed: 'Failed',
  truncated: ' (truncated)',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent-browser banner and tool-card copy. */
    'desktop.agentBrowser': AgentBrowserLocaleKey
  }
}

type Translate = TranslateNS<'desktop.agentBrowser'>

function phaseLabel(phase: AgentBrowserPhase, t: Translate): string {
  switch (phase) {
    case 'idle': return t('phaseIdle')
    case 'observing': return t('phaseObserving')
    case 'acting': return t('phaseActing')
    case 'claimed': return t('phaseClaimed')
  }
}

// ── Same-origin loopback API ───────────────────────────────────────────────

/** Banner-shaped surface state (the renderer-safe projection of `describe()`). */
export interface AgentBrowserSurfaceState {
  readonly open: boolean
  readonly url: string
  readonly title: string
  readonly phase: AgentBrowserPhase
  readonly generation: number
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPhase(value: unknown): value is AgentBrowserPhase {
  return value === 'idle' || value === 'observing' || value === 'acting' || value === 'claimed'
}

/** Validate the loopback state projection before it reaches React state. */
export function parseAgentBrowserSurfaceState(value: unknown): AgentBrowserSurfaceState {
  if (!isObject(value)
    || typeof value.open !== 'boolean'
    || typeof value.url !== 'string'
    || typeof value.title !== 'string'
    || !isPhase(value.phase)
    || typeof value.generation !== 'number') {
    throw new Error('dsh-plugin-desktop: invalid agent browser state response')
  }
  return Object.freeze({
    open: value.open,
    url: value.url,
    title: value.title,
    phase: value.phase,
    generation: value.generation,
  })
}

/** Validate one SSE frame payload. */
export function parseAgentBrowserFrame(value: unknown): AgentBrowserEventFrame {
  if (!isObject(value) || typeof value.kind !== 'string') {
    throw new Error('dsh-plugin-desktop: invalid agent browser frame')
  }
  if (value.kind === 'state') {
    return Object.freeze({
      kind: 'state',
      url: typeof value.url === 'string' ? value.url : '',
      title: typeof value.title === 'string' ? value.title : '',
      phase: isPhase(value.phase) ? value.phase : 'idle',
      generation: typeof value.generation === 'number' ? value.generation : 0,
    })
  }
  if (value.kind === 'navigation') {
    return Object.freeze({
      kind: 'navigation',
      url: typeof value.url === 'string' ? value.url : '',
      generation: typeof value.generation === 'number' ? value.generation : 0,
    })
  }
  if (value.kind === 'stale') {
    return Object.freeze({
      kind: 'stale',
      generation: typeof value.generation === 'number' ? value.generation : 0,
    })
  }
  throw new Error('dsh-plugin-desktop: invalid agent browser frame')
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`dsh-plugin-desktop: agent browser request failed (${String(response.status)})`)
  }
  try {
    return await response.json() as unknown
  } catch {
    throw new Error('dsh-plugin-desktop: agent browser response was not JSON')
  }
}

function post(fetcher: FetchLike, path: string, body: object): Promise<Response> {
  return fetcher(path, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Banner operations over the loopback routes (§5.4 entry 2). */
export interface AgentBrowserSurfaceApi {
  readState(): Promise<AgentBrowserSurfaceState>
  claim(reason?: string): Promise<void>
  release(): Promise<void>
}

/** Construct the same-origin banner API, with a fetch seam for focused tests. */
export function createAgentBrowserSurfaceApi(
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): AgentBrowserSurfaceApi {
  return Object.freeze({
    async readState() {
      const response = await fetcher(DESKTOP_AGENT_BROWSER_STATE_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      })
      return parseAgentBrowserSurfaceState(await readJson(response))
    },
    async claim(reason?: string) {
      const value = await readJson(await post(fetcher, DESKTOP_AGENT_BROWSER_CLAIM_PATH, {
        ...(reason === undefined || reason.length === 0 ? {} : { reason }),
      }))
      if (!isObject(value) || value.claimed !== true) {
        throw new Error('dsh-plugin-desktop: invalid agent browser claim response')
      }
    },
    async release() {
      const value = await readJson(await post(fetcher, DESKTOP_AGENT_BROWSER_RELEASE_PATH, {}))
      if (!isObject(value) || value.released !== true) {
        throw new Error('dsh-plugin-desktop: invalid agent browser release response')
      }
    },
  })
}

// ── SSE connection ─────────────────────────────────────────────────────────

/** Frame subscription seam (the EventSource adapter by default). */
export type AgentBrowserFrameConnection = (onFrame: (frame: AgentBrowserEventFrame) => void) => () => void

type EventSourceLike = {
  onmessage: ((event: MessageEvent) => unknown) | null
  close(): void
}

/**
 * The EventSource-backed connection: same-origin GET on the SSE route (a
 * CORS-mode request, so the origin gate always sees `Origin`). Malformed
 * payloads are dropped, never thrown — a bad frame must not kill the stream.
 */
export function createAgentBrowserEventConnection(
  path: string = DESKTOP_AGENT_BROWSER_EVENTS_PATH,
  open: (url: string) => EventSourceLike = url => new EventSource(url),
): AgentBrowserFrameConnection {
  return onFrame => {
    const source = open(path)
    source.onmessage = event => {
      try {
        onFrame(parseAgentBrowserFrame(JSON.parse(event.data) as unknown))
      } catch {
        // Ignore malformed frames; the next boundary re-syncs the banner.
      }
    }
    return () => { source.close() }
  }
}

/** Fold one frame into the banner state (pure, so the projection is testable). */
export function foldAgentBrowserFrame(
  current: AgentBrowserSurfaceState | undefined,
  frame: AgentBrowserEventFrame,
): AgentBrowserSurfaceState | undefined {
  if (frame.kind === 'state') {
    return {
      open: true,
      url: frame.url,
      title: frame.title,
      phase: frame.phase,
      generation: frame.generation,
    }
  }
  if (current === undefined) return current
  if (frame.kind === 'navigation') {
    return { ...current, url: frame.url, generation: frame.generation }
  }
  // A stale frame changes nothing the banner shows; receiving it proves the
  // stream is alive.
  return current
}

// ── Banner ─────────────────────────────────────────────────────────────────

/** Short display form of one URL: origin + path, bounded. */
function shortUrl(url: string): string {
  if (url.length === 0 || url === 'about:blank') return 'about:blank'
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    const short = `${parsed.host}${path}`
    return short.length > 60 ? `${short.slice(0, 57)}…` : short
  } catch {
    return url.length > 60 ? `${url.slice(0, 57)}…` : url
  }
}

/**
 * Presentational banner: the live browser surface (URL, generation, phase)
 * with the §5.4 take-over/release action. Pure and null when the surface is
 * closed — the seat renders nothing until the agent opens a browser window.
 */
export function AgentBrowserBannerView({
  state,
  busy,
  onClaim,
  onRelease,
  t,
}: {
  readonly state: AgentBrowserSurfaceState | undefined
  readonly busy: boolean
  readonly onClaim: () => void
  readonly onRelease: () => void
  readonly t: Translate
}): JSX.Element | null {
  if (state === undefined || !state.open) return null
  const claimed = state.phase === 'claimed'
  return (
    <div
      className="dshAgentBrowserBanner"
      data-phase={state.phase}
      role="status"
    >
      <span className="dshAgentBrowserBannerLabel">{t('toolName')}</span>
      <span className="dshAgentBrowserBannerUrl" title={state.url}>{shortUrl(state.url)}</span>
      <span className="dshAgentBrowserBannerMeta">
        {`G${String(state.generation)} · ${phaseLabel(state.phase, t)}`}
      </span>
      <button
        type="button"
        className="dshAgentBrowserBannerAction"
        disabled={busy}
        onClick={claimed ? onRelease : onClaim}
      >
        {busy ? t('pending') : claimed ? t('release') : t('takeOver')}
      </button>
    </div>
  )
}

/** Registration-side capability for the banner seat. */
export interface AgentBrowserBannerInjected {
  readonly api: AgentBrowserSurfaceApi
  readonly connect: AgentBrowserFrameConnection
}

export type AgentBrowserBannerProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'desktop.agentBrowser'>
  & InjectFace<AgentBrowserBannerInjected>

/**
 * Slot-registered banner (§5.4 entry 2): reads the loopback state once, then
 * follows the SSE stream; the take-over/release buttons POST the loopback
 * routes and drive the SAME claim state machine as the window toolbar button
 * and the model's `browser_claim_control` tool.
 */
export function AgentBrowserBanner({ api, connect, t }: AgentBrowserBannerProps): JSX.Element | null {
  const [state, setState] = useState<AgentBrowserSurfaceState | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void api.readState().then(value => {
      if (active && value.open) setState(value)
    }).catch(() => {})
    const disconnect = connect(frame => {
      if (!active) return
      setState(current => foldAgentBrowserFrame(current, frame))
    })
    return () => {
      active = false
      disconnect()
    }
  }, [api, connect])

  const act = (invoke: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    void invoke().catch(() => {}).finally(() => { setBusy(false) })
  }

  return (
    <AgentBrowserBannerView
      state={state}
      busy={busy}
      onClaim={() => { act(() => api.claim()) }}
      onRelease={() => { act(() => api.release()) }}
      t={t}
    />
  )
}

// ── Tool result cards ──────────────────────────────────────────────────────

/** Compact projection of one browser tool call for the chat card. */
export interface AgentBrowserToolCardData {
  readonly running: boolean
  readonly failed: boolean
  readonly url: string | undefined
  readonly generation: number | undefined
  /** One-line detail (snapshot size/truncation, screenshot dimensions). */
  readonly detail: string | undefined
}

const URL_ATTRIBUTE_PATTERN = /\burl="([^"]*)"/u
const GENERATION_ATTRIBUTE_PATTERN = /\bgeneration="(\d+)"/u

/** Extract the tool envelope attributes the host renderer emits. */
function envelopeAttributes(text: string | undefined): { url: string | undefined, generation: number | undefined } {
  if (text === undefined) return { url: undefined, generation: undefined }
  const url = URL_ATTRIBUTE_PATTERN.exec(text)?.[1]
  const generation = GENERATION_ATTRIBUTE_PATTERN.exec(text)?.[1]
  return {
    url,
    generation: generation === undefined ? undefined : Number.parseInt(generation, 10),
  }
}

function firstText(blocks: ReadonlyArray<{ readonly type: string, readonly text?: unknown }>): string | undefined {
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}

/** Count tree lines of one snapshot envelope body. */
function snapshotDetail(text: string | undefined, t: Translate): string | undefined {
  if (text === undefined) return undefined
  const body = /<browser[^>]*>\n?([\s\S]*?)\n<\/browser>/u.exec(text)?.[1]
  if (body === undefined) return undefined
  const lines = body.split('\n').filter(line => line.trim().length > 0).length
  return `${String(lines)} lines${text.includes('[snapshot truncated') ? t('truncated') : ''}`
}

/** Extract the screenshot dimensions line from the tool envelope. */
function screenshotDetail(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return /(\d+)x(\d+) px/u.exec(text)?.[0]
}

/**
 * Project one browser tool call block into the compact card data: running
 * calls show the target URL from the arguments; settled calls read the host
 * renderer's `<browser …/>` envelope for URL/generation plus one detail line.
 */
export function projectAgentBrowserToolCard(block: ToolCallBlock, t: Translate): AgentBrowserToolCardData {
  if (!('kind' in block)) {
    let url: string | undefined
    try {
      const args = JSON.parse(block.argsRaw) as Record<string, unknown>
      if (typeof args.url === 'string') url = args.url
    } catch {
      // Unparsed arguments render without a URL.
    }
    return {
      running: true,
      failed: false,
      url,
      generation: undefined,
      detail: undefined,
    }
  }
  const text = firstText(block.content)
  const attributes = envelopeAttributes(text)
  const detail = block.isError
    ? undefined
    : text?.includes('image/jpeg') === true
      ? screenshotDetail(text)
      : snapshotDetail(text, t)
  return {
    running: false,
    failed: block.isError,
    url: attributes.url,
    generation: attributes.generation,
    detail,
  }
}

/** Presentational tool card: one compact row, never the raw tree. */
export function AgentBrowserToolCardView({
  label,
  data,
  t,
}: {
  readonly label: string
  readonly data: AgentBrowserToolCardData
  readonly t: Translate
}): JSX.Element {
  return (
    <div className="dshAgentBrowserToolCard" data-failed={data.failed ? 'true' : undefined}>
      <span className="dshAgentBrowserToolCardLabel">
        {label}
        {data.generation !== undefined && ` · G${String(data.generation)}`}
      </span>
      {data.url !== undefined && (
        <span className="dshAgentBrowserToolCardUrl" title={data.url}>{shortUrl(data.url)}</span>
      )}
      <span className="dshAgentBrowserToolCardDetail">
        {data.running ? t('running') : data.failed ? t('failed') : data.detail}
      </span>
    </div>
  )
}

/** Label for one browser tool name (falls back to the raw name). */
export function agentBrowserToolLabel(toolName: string, t: Translate): string {
  switch (toolName) {
    case 'browser_open': return t('toolOpen')
    case 'browser_navigate': return t('toolNavigate')
    case 'browser_snapshot': return t('toolSnapshot')
    case 'browser_screenshot': return t('toolScreenshot')
    default: return toolName
  }
}

export type AgentBrowserToolCardProps =
  PropsRuntime<'tool.call.toolview'>
  & PropsLocale<'desktop.agentBrowser'>

/**
 * Slot-registered compact card for one browser tool call (the keyed
 * `tool.call.toolview` seat): `browser_open`, `browser_navigate`,
 * `browser_snapshot`, and `browser_screenshot` — the OBSERVE primitive's
 * tree and the screenshot never dump raw into the conversation flow.
 */
export function AgentBrowserToolCard({ toolName, block, t }: AgentBrowserToolCardProps): JSX.Element {
  return (
    <AgentBrowserToolCardView
      label={agentBrowserToolLabel(toolName, t)}
      data={projectAgentBrowserToolCard(block, t)}
      t={t}
    />
  )
}
