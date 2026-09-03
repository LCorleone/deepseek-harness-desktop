/**
 * Agent-browser loopback routes (§2/§5.4, B3): the banner state read, the
 * claim/release posts against the same executor the tools use, and the SSE
 * hanging response — projected over fake request/response objects, including
 * the origin gate's exact-Origin and same-origin-metadata branches.
 */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentBrowserEventFrame, AgentBrowserLiveState } from '../src/agent-browser-contract.ts'
import {
  AGENT_BROWSER_SSE_HEARTBEAT_MS,
  encodeAgentBrowserFrame,
  handleAgentBrowserClaimRequest,
  handleAgentBrowserEventsRequest,
  handleAgentBrowserReleaseRequest,
  handleAgentBrowserStateRequest,
  type AgentBrowserRouteExecutor,
} from '../src/agent-browser-route.ts'

const ORIGIN = 'http://127.0.0.1:43120'

function liveState(overrides: Partial<AgentBrowserLiveState> = {}): AgentBrowserLiveState {
  return {
    open: true,
    url: 'https://example.test/page',
    title: 'Example',
    phase: 'observing',
    generation: 4,
    ...overrides,
  }
}

function fakeExecutor(overrides: Partial<AgentBrowserRouteExecutor> = {}): AgentBrowserRouteExecutor {
  return {
    describe: () => liveState(),
    claimControl: vi.fn(),
    releaseControl: vi.fn(),
    subscribe: vi.fn((_listener: (frame: AgentBrowserEventFrame) => void) => () => {}),
    ...overrides,
  }
}

function request(
  method: string,
  options: { readonly body?: string, readonly headers?: Readonly<Record<string, string | undefined>>, readonly remoteAddress?: string } = {},
): IncomingMessage {
  const req = Readable.from(options.body === undefined ? [] : [options.body]) as IncomingMessage
  req.method = method
  req.headers = {
    host: '127.0.0.1:43120',
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...options.headers,
  }
  Object.defineProperty(req, 'socket', {
    configurable: true,
    value: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  })
  return req
}

interface JsonRes {
  body: unknown
  statusCode: number
  headers: Record<string, unknown>
  ended: boolean
}

function jsonResponse(): ServerResponse & JsonRes {
  const state: JsonRes = { body: undefined, statusCode: 0, headers: {}, ended: false }
  const res = {
    get statusCode() { return state.statusCode },
    set statusCode(value: number) { state.statusCode = value },
    get body() { return state.body },
    get headers() { return state.headers },
    get ended() { return state.ended },
    setHeader: vi.fn((name: string, value: unknown) => { state.headers[name] = value }),
    end: vi.fn((body?: string | (() => void)) => {
      state.ended = true
      state.body = typeof body === 'string' ? JSON.parse(body) : undefined
    }),
  }
  return res as unknown as ServerResponse & JsonRes
}

/** A hanging SSE-capable fake response. */
function hangingResponse(): ServerResponse & { chunks: string[], emitClose(): void } {
  const emitter = new EventEmitter()
  const chunks: string[] = []
  const res = {
    statusCode: 0,
    destroyed: false,
    writableEnded: false,
    setHeader: vi.fn(),
    write: vi.fn((chunk: string) => { chunks.push(chunk); return true }),
    end: vi.fn(),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    emitClose: () => {
      res.destroyed = true
      emitter.emit('close')
    },
    chunks,
  }
  return res as unknown as ServerResponse & { chunks: string[], emitClose(): void }
}

describe('agent-browser state route', () => {
  it('serves the renderer-safe live projection', () => {
    const res = jsonResponse()
    handleAgentBrowserStateRequest(request('GET'), res, ORIGIN, fakeExecutor())
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(liveState())
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('rejects other methods and non-loopback origins', () => {
    const method = jsonResponse()
    handleAgentBrowserStateRequest(request('POST', { body: '' }), method, ORIGIN, fakeExecutor())
    expect(method.statusCode).toBe(405)

    const offsite = jsonResponse()
    handleAgentBrowserStateRequest(
      request('GET', { headers: { origin: 'https://evil.example' } }),
      offsite,
      ORIGIN,
      fakeExecutor(),
    )
    expect(offsite.statusCode).toBe(403)

    const remote = jsonResponse()
    handleAgentBrowserStateRequest(request('GET', { remoteAddress: '10.0.0.8' }), remote, ORIGIN, fakeExecutor())
    expect(remote.statusCode).toBe(403)
  })

  it('admits a browser GET without an Origin through same-origin fetch metadata', () => {
    const res = jsonResponse()
    handleAgentBrowserStateRequest(
      request('GET', { headers: { origin: undefined, referer: `${ORIGIN}/workspace` } }),
      res,
      ORIGIN,
      fakeExecutor(),
    )
    expect(res.statusCode).toBe(200)
  })
})

describe('agent-browser claim/release routes (§5.4 entries)', () => {
  it('claims through the executor with the banner reason', async () => {
    const claimControl = vi.fn()
    const executor = fakeExecutor({ claimControl, describe: () => liveState({ phase: 'claimed' }) })
    const res = jsonResponse()
    await handleAgentBrowserClaimRequest(
      request('POST', { body: JSON.stringify({ reason: 'please log in' }) }),
      res,
      ORIGIN,
      executor,
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ claimed: true, phase: 'claimed' })
    expect(claimControl).toHaveBeenCalledExactlyOnceWith('the operator claimed control from the web client banner: please log in')
  })

  it('accepts an empty claim body and rejects malformed ones', async () => {
    const executor = fakeExecutor()
    const empty = jsonResponse()
    await handleAgentBrowserClaimRequest(request('POST', { body: '' }), empty, ORIGIN, executor)
    expect(empty.statusCode).toBe(200)
    expect(executor.claimControl).toHaveBeenCalledExactlyOnceWith(undefined)

    const bad = jsonResponse()
    await handleAgentBrowserClaimRequest(
      request('POST', { body: JSON.stringify({ reason: 7 }) }),
      bad,
      ORIGIN,
      executor,
    )
    expect(bad.statusCode).toBe(400)

    const notJson = jsonResponse()
    await handleAgentBrowserClaimRequest(request('POST', { body: 'not-json', headers: {} }), notJson, ORIGIN, executor)
    expect(notJson.statusCode).toBe(400)
  })

  it('releases through the executor and reports the bumped generation', () => {
    const releaseControl = vi.fn()
    const executor = fakeExecutor({ releaseControl, describe: () => liveState({ phase: 'observing', generation: 5 }) })
    const res = jsonResponse()
    handleAgentBrowserReleaseRequest(request('POST', { body: '' }), res, ORIGIN, executor)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ released: true, phase: 'observing', generation: 5 })
    expect(releaseControl).toHaveBeenCalledExactlyOnceWith()
  })

  it('refuses mutating posts without the exact origin', async () => {
    const executor = fakeExecutor()
    const claim = jsonResponse()
    await handleAgentBrowserClaimRequest(
      request('POST', { body: '', headers: { origin: undefined, referer: `${ORIGIN}/x` } }),
      claim,
      ORIGIN,
      executor,
    )
    expect(claim.statusCode).toBe(403)
    expect(executor.claimControl).not.toHaveBeenCalled()

    const release = jsonResponse()
    handleAgentBrowserReleaseRequest(
      request('POST', { body: '', headers: { origin: 'https://evil.example' } }),
      release,
      ORIGIN,
      executor,
    )
    expect(release.statusCode).toBe(403)
    expect(executor.releaseControl).not.toHaveBeenCalled()
  })
})

describe('agent-browser SSE events route', () => {
  function decode(chunk: string): AgentBrowserEventFrame | { readonly retry: number } {
    if (chunk.startsWith('retry:')) return { retry: Number.parseInt(chunk.slice('retry:'.length), 10) }
    if (chunk.startsWith(':')) return { retry: -1 }
    expect(chunk.startsWith('data: ')).toBe(true)
    expect(chunk.endsWith('\n\n')).toBe(true)
    return JSON.parse(chunk.slice('data: '.length, -2)) as AgentBrowserEventFrame
  }

  it('streams the initial state, pushed frames carrying phase, and unsubscribes on close', () => {
    const listeners = new Set<(frame: AgentBrowserEventFrame) => void>()
    const unsubscribe = vi.fn(() => { listeners.clear() })
    const executor = fakeExecutor({
      subscribe: vi.fn((listener: (frame: AgentBrowserEventFrame) => void) => {
        listeners.add(listener)
        return unsubscribe
      }),
    })
    const res = hangingResponse()

    handleAgentBrowserEventsRequest(request('GET'), res, ORIGIN, executor, { heartbeatMs: 60_000 })

    // Headers + retry + priming state frame (the surface is open).
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'text/event-stream; charset=utf-8')
    expect(decode((res as unknown as { chunks: string[] }).chunks[0]!)).toEqual({ retry: 3000 })
    expect(decode((res as unknown as { chunks: string[] }).chunks[1]!)).toEqual({
      kind: 'state',
      url: 'https://example.test/page',
      title: 'Example',
      phase: 'observing',
      generation: 4,
    })
    expect((res as unknown as { write: ReturnType<typeof vi.fn> }).write).toHaveBeenCalledTimes(2)
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(listeners).toHaveLength(1)

    // A pushed state frame (the claim transition) lands on the wire with the
    // phase — the B2 leftover closure (§6 B3).
    for (const listener of listeners) {
      listener({ kind: 'state', url: 'https://example.test/page', title: 'Example', phase: 'claimed', generation: 4 })
    }
    const chunks = (res as unknown as { chunks: string[] }).chunks
    expect(chunks).toHaveLength(3)
    expect(decode(chunks[2]!)).toEqual({
      kind: 'state',
      url: 'https://example.test/page',
      title: 'Example',
      phase: 'claimed',
      generation: 4,
    })

    // Client disconnect: heartbeat cleared and subscription removed.
    ;(res as unknown as { emitClose(): void }).emitClose()
    expect(unsubscribe).toHaveBeenCalledExactlyOnceWith()
    expect(listeners).toHaveLength(0)
  })

  it('does not prime a state frame for a closed surface, but keeps streaming', () => {
    const executor = fakeExecutor({ describe: () => liveState({ open: false, phase: 'idle' }) })
    const res = hangingResponse()
    handleAgentBrowserEventsRequest(request('GET'), res, ORIGIN, executor)
    const chunks = (res as unknown as { chunks: string[] }).chunks
    expect(chunks).toHaveLength(1)
    expect(decode(chunks[0]!)).toEqual({ retry: 3000 })
  })

  it('skips frames after the response died', () => {
    const listeners = new Set<(frame: AgentBrowserEventFrame) => void>()
    const executor = fakeExecutor({
      subscribe: vi.fn((listener: (frame: AgentBrowserEventFrame) => void) => {
        listeners.add(listener)
        return () => { listeners.clear() }
      }),
      describe: () => liveState({ open: false, phase: 'idle' }),
    })
    const res = hangingResponse()
    handleAgentBrowserEventsRequest(request('GET'), res, ORIGIN, executor)
    const chunks = (res as unknown as { chunks: string[] }).chunks
    const before = chunks.length
    ;(res as unknown as { emitClose(): void }).emitClose()
    for (const listener of listeners) {
      listener({ kind: 'navigation', url: 'https://example.test/next', generation: 6 })
    }
    expect(chunks).toHaveLength(before)
  })

  it('rejects non-GET and non-loopback requests without holding the response', () => {
    const method = hangingResponse()
    handleAgentBrowserEventsRequest(request('POST', { body: '' }), method, ORIGIN, fakeExecutor())
    expect(method.statusCode).toBe(405)
    expect((method as unknown as { chunks: string[] }).chunks).toHaveLength(0)

    const offsite = hangingResponse()
    handleAgentBrowserEventsRequest(
      request('GET', { headers: { origin: 'https://evil.example' } }),
      offsite,
      ORIGIN,
      fakeExecutor(),
    )
    expect(offsite.statusCode).toBe(403)
  })

  it('encodes frames in the SSE data format and exports the heartbeat cadence', () => {
    expect(encodeAgentBrowserFrame({ kind: 'stale', generation: 2 }))
      .toBe('data: {"kind":"stale","generation":2}\n\n')
    expect(AGENT_BROWSER_SSE_HEARTBEAT_MS).toBeGreaterThanOrEqual(10_000)
  })
})
