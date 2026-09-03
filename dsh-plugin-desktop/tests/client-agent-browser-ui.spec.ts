/**
 * Agent-browser client surfaces (B3): the banner API over a fake fetch, the
 * SSE frame folding, the presentational banner/tool-card views, and the
 * client registration. Zero Node globals in the module under test — the
 * renderer-node-globals machine gate covers it separately.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  AgentBrowserBannerView,
  AgentBrowserToolCardView,
  agentBrowserToolLabel,
  createAgentBrowserEventConnection,
  createAgentBrowserSurfaceApi,
  foldAgentBrowserFrame,
  parseAgentBrowserFrame,
  parseAgentBrowserSurfaceState,
  projectAgentBrowserToolCard,
  en,
  zh,
  type AgentBrowserSurfaceState,
} from '../src/client/agent-browser-ui.tsx'

type Translate = TranslateNS<'desktop.agentBrowser'>

function translate(dict: Record<string, string>): Translate {
  return key => dict[key as keyof typeof dict] ?? key
}

const t = translate(en)

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const OPEN_STATE: AgentBrowserSurfaceState = {
  open: true,
  url: 'https://docs.example.test/guide/login',
  title: 'Guide',
  phase: 'observing',
  generation: 7,
}

describe('agent-browser banner API (fake fetch)', () => {
  it('reads state over the loopback GET route and validates it', async () => {
    const fetcher = vi.fn(async () => json({
      open: true,
      url: 'https://example.test/',
      title: 'Example',
      phase: 'acting',
      generation: 3,
    }))
    const api = createAgentBrowserSurfaceApi(fetcher)

    await expect(api.readState()).resolves.toEqual({
      open: true,
      url: 'https://example.test/',
      title: 'Example',
      phase: 'acting',
      generation: 3,
    })
    expect(fetcher.mock.calls[0]!.slice(0, 2)).toEqual(['/_dsh/desktop/agent-browser/state', {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }])
    expect(() => parseAgentBrowserSurfaceState({ open: true, url: 7 })).toThrow('invalid agent browser state response')
  })

  it('claims and release through the loopback POST routes', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/_dsh/desktop/agent-browser/claim') return json({ claimed: true, phase: 'claimed' })
      return json({ released: true, phase: 'observing', generation: 8 })
    })
    const api = createAgentBrowserSurfaceApi(fetcher)

    await expect(api.claim('please sign in')).resolves.toBeUndefined()
    await expect(api.release()).resolves.toBeUndefined()

    expect(fetcher.mock.calls[0]!.slice(0, 2)).toEqual(['/_dsh/desktop/agent-browser/claim', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'please sign in' }),
    }])
    expect(fetcher.mock.calls[1]!.slice(0, 2)).toEqual(['/_dsh/desktop/agent-browser/release', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }])

    const rejecting = vi.fn(async () => json({ claimed: false }))
    await expect(createAgentBrowserSurfaceApi(rejecting).claim()).rejects.toThrow('invalid agent browser claim response')
  })

  it('does not surface a failed POST body beyond the status code', async () => {
    const fetcher = vi.fn(async () => json({ error: '/Users/private/thing' }, 403))
    await expect(createAgentBrowserSurfaceApi(fetcher).claim()).rejects.toThrow('agent browser request failed (403)')
    await expect(createAgentBrowserSurfaceApi(fetcher).claim()).rejects.not.toThrow('/Users/private')
  })
})

describe('agent-browser SSE connection and frame folding', () => {
  it('parses frames, drops malformed payloads, and closes the source on unsubscribe', () => {
    let handler: ((event: MessageEvent) => unknown) | null = null
    const close = vi.fn()
    const connect = createAgentBrowserEventConnection('/_dsh/desktop/agent-browser/events', () => ({
      get onmessage() { return handler },
      set onmessage(value: ((event: MessageEvent) => unknown) | null) { handler = value },
      close,
    }))

    const seen: string[] = []
    const disconnect = connect(frame => { seen.push(frame.kind) })
    expect(handler).toBeTypeOf('function')
    const deliver = (payload: string): void => {
      ;(handler as (event: { readonly data: string }) => void)({ data: payload })
    }

    deliver(JSON.stringify({ kind: 'state', url: 'https://a.test/', title: 'A', phase: 'claimed', generation: 1 }))
    deliver('not-json')
    deliver(JSON.stringify({ kind: 'navigation', url: 'https://b.test/', generation: 2 }))
    deliver(JSON.stringify({ kind: 'stale', generation: 2 }))
    deliver(JSON.stringify({ kind: 'nonsense' }))
    expect(seen).toEqual(['state', 'navigation', 'stale'])

    disconnect()
    expect(close).toHaveBeenCalledOnce()
  })

  it('folds frames into the banner state', () => {
    const base = { ...OPEN_STATE }
    const claimed = foldAgentBrowserFrame(base, {
      kind: 'state', url: 'https://docs.example.test/guide/login', title: 'Guide', phase: 'claimed', generation: 7,
    })
    expect(claimed).toEqual({ ...base, phase: 'claimed' })

    const navigated = foldAgentBrowserFrame(claimed, { kind: 'navigation', url: 'https://other.example.test/x', generation: 8 })
    expect(navigated).toEqual({ ...claimed, url: 'https://other.example.test/x', generation: 8 })

    // Stale frames change nothing the banner shows.
    expect(foldAgentBrowserFrame(navigated, { kind: 'stale', generation: 8 })).toBe(navigated)
    // A state frame opens a banner that had no state yet.
    const fresh = foldAgentBrowserFrame(undefined, {
      kind: 'state', url: 'https://a.test/', title: 'A', phase: 'observing', generation: 1,
    })
    expect(fresh).toEqual({ open: true, url: 'https://a.test/', title: 'A', phase: 'observing', generation: 1 })
    expect(() => parseAgentBrowserFrame({ kind: 'wat' })).toThrow('invalid agent browser frame')
  })
})

describe('agent-browser banner view', () => {
  it('renders the surface state with the take-over action while the agent drives', () => {
    const markup = renderToStaticMarkup(createElement(AgentBrowserBannerView, {
      state: OPEN_STATE,
      busy: false,
      onClaim: () => {},
      onRelease: () => {},
      t,
    }))
    expect(markup).toContain('docs.example.test/guide/login')
    expect(markup).toContain('G7')
    expect(markup).toContain('observing')
    expect(markup).toContain('Take over')
    expect(markup).not.toContain('Release')
  })

  it('renders the release action while the operator holds control', () => {
    const markup = renderToStaticMarkup(createElement(AgentBrowserBannerView, {
      state: { ...OPEN_STATE, phase: 'claimed' },
      busy: false,
      onClaim: () => {},
      onRelease: () => {},
      t,
    }))
    expect(markup).toContain('Release')
    expect(markup).not.toContain('Take over')
    expect(markup).toContain('operator has control')
    expect(markup).toContain('data-phase="claimed"')
  })

  it('renders nothing while the surface is closed, and follows the bound locale', () => {
    expect(renderToStaticMarkup(createElement(AgentBrowserBannerView, {
      state: undefined,
      busy: false,
      onClaim: () => {},
      onRelease: () => {},
      t,
    }))).toBe('')
    expect(renderToStaticMarkup(createElement(AgentBrowserBannerView, {
      state: { ...OPEN_STATE, open: false, phase: 'idle' },
      busy: false,
      onClaim: () => {},
      onRelease: () => {},
      t,
    }))).toBe('')
    expect(renderToStaticMarkup(createElement(AgentBrowserBannerView, {
      state: OPEN_STATE,
      busy: false,
      onClaim: () => {},
      onRelease: () => {},
      t: translate(zh),
    }))).toContain('接管')
  })
})

describe('agent-browser tool cards', () => {
  it('projects running calls from their arguments', () => {
    const data = projectAgentBrowserToolCard({
      callId: 'call-1',
      name: 'browser_open',
      argsRaw: '{"url":"https://docs.example.test/"}',
      turn: 1,
      step: 1,
      time: 0,
      callView: null,
      subCalls: [],
    }, t)
    expect(data).toEqual({
      running: true,
      failed: false,
      url: 'https://docs.example.test/',
      generation: undefined,
      detail: undefined,
    })
  })

  it('projects the open envelope (url + generation)', () => {
    const data = projectAgentBrowserToolCard({
      kind: 'tool-result',
      seq: 2,
      time: 0,
      callId: 'call-2',
      call: { name: 'browser_open', argsRaw: '{}' },
      callTime: null,
      content: [{ type: 'text', text: '<browser url="https://docs.example.test/" title="Docs" generation="3" />' }],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ToolCallBlock, t)
    expect(data).toEqual({
      running: false,
      failed: false,
      url: 'https://docs.example.test/',
      generation: 3,
      detail: undefined,
    })
  })

  it('projects the snapshot with a line count and truncation marker', () => {
    const tree = ['<browser url="https://docs.example.test/" generation="4">', 'html', '  body', '  button #e1s', '</browser>'].join('\n')
    const data = projectAgentBrowserToolCard({
      kind: 'tool-result',
      seq: 3,
      time: 0,
      callId: 'call-3',
      call: { name: 'browser_snapshot', argsRaw: '{}' },
      callTime: null,
      content: [{ type: 'text', text: tree }],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ToolCallBlock, t)
    expect(data.detail).toBe('3 lines')
    expect(data.generation).toBe(4)
    expect(data.url).toBe('https://docs.example.test/')

    // The marker rides inside the envelope before </browser> (renderSnapshot).
    const truncatedText = tree.replace('\n</browser>', '\n[snapshot truncated: node budget reached]\n</browser>')
    const truncated = projectAgentBrowserToolCard({
      kind: 'tool-result',
      seq: 4,
      time: 0,
      callId: 'call-4',
      call: { name: 'browser_snapshot', argsRaw: '{}' },
      callTime: null,
      content: [{ type: 'text', text: truncatedText }],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ToolCallBlock, t)
    expect(truncated.detail).toBe('4 lines (truncated)')
  })

  it('projects the screenshot dimensions and failures', () => {
    const shot = projectAgentBrowserToolCard({
      kind: 'tool-result',
      seq: 5,
      time: 0,
      callId: 'call-5',
      call: { name: 'browser_screenshot', argsRaw: '{}' },
      callTime: null,
      content: [{
        type: 'text',
        text: '<browser url="https://docs.example.test/" generation="2">\nimage/jpeg image, 1280x400 px, 20480 bytes\n</browser>',
      }],
      isError: false,
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ToolCallBlock, t)
    expect(shot.detail).toBe('1280x400 px')

    const failed = projectAgentBrowserToolCard({
      kind: 'tool-result',
      seq: 6,
      time: 0,
      callId: 'call-6',
      call: { name: 'browser_click', argsRaw: '{}' },
      callTime: null,
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
      error: { name: 'Error', code: 'STALE_SNAPSHOT' },
      callView: null,
      resultView: null,
      subCalls: [],
    } as unknown as ToolCallBlock, t)
    expect(failed.failed).toBe(true)
    expect(failed.detail).toBeUndefined()
  })

  it('renders the compact card and labels the browser tools', () => {
    const markup = renderToStaticMarkup(createElement(AgentBrowserToolCardView, {
      label: agentBrowserToolLabel('browser_snapshot', t),
      data: {
        running: false,
        failed: false,
        url: 'https://docs.example.test/',
        generation: 4,
        detail: '3 lines',
      },
      t,
    }))
    expect(markup).toContain('Page snapshot')
    expect(markup).toContain('G4')
    expect(markup).toContain('docs.example.test')
    expect(markup).toContain('3 lines')
    expect(agentBrowserToolLabel('browser_open', t)).toBe('Opened page')
    expect(agentBrowserToolLabel('browser_something_new', t)).toBe('browser_something_new')
  })
})
