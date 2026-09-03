/**
 * Strict loopback handlers for the agent-browser web-client surface (design
 * §2/§5.4, B3): the banner's same-origin state read, claim/release posts,
 * and the SSE event stream.
 *
 * The native browser window cannot use these routes (it loads `file://`); it
 * rides the preload bridge instead (`agent-browser-preload.ts`). Origin
 * checking follows the loopback precedents: a mutating request carries the
 * exact `Origin` (directory-picker precedent); a read may instead present
 * the standard same-origin fetch metadata (settings GET precedent) because
 * browsers commonly omit `Origin` on same-origin GETs — while `EventSource`
 * requests are CORS-mode and always carry it.
 *
 * @module dsh-plugin-desktop/agent-browser-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentBrowserEventFrame, AgentBrowserLiveState } from './agent-browser-contract.ts'

/** Executor surface the loopback routes consume (the session implements it). */
export interface AgentBrowserRouteExecutor {
  describe(): AgentBrowserLiveState
  claimControl(reason?: string): void
  releaseControl(): void
  subscribe(listener: (frame: AgentBrowserEventFrame) => void): () => void
}

const MAX_CLAIM_BODY_BYTES = 4 * 1024
/** SSE heartbeat cadence; keeps proxies from timing the stream out. */
export const AGENT_BROWSER_SSE_HEARTBEAT_MS = 15_000
/** Reconnect hint sent to EventSource clients on connect. */
const SSE_RETRY_MS = 3_000

function finishJson(res: ServerResponse, statusCode: number, value: object, allow?: 'GET' | 'POST'): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]'
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1' || address === '127.0.0.1') return true
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length).startsWith('127.')
  }
  return address.startsWith('127.')
}

function exactHeaderOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.origin === value ? value : undefined
  } catch {
    return undefined
  }
}

function referrerOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * Same-origin loopback gate shared by every agent-browser route: the socket
 * is loopback, the Host matches, and a mutating request carries the exact
 * Origin while a read may present same-origin fetch metadata instead.
 */
function isSameOriginLoopbackRequest(
  req: IncomingMessage,
  expectedOrigin: string,
  mutating: boolean,
): boolean {
  let expected: URL
  try {
    expected = new URL(expectedOrigin)
  } catch {
    return false
  }
  if (expected.origin !== expectedOrigin || expected.protocol !== 'http:'
    || !isLoopbackHostname(expected.hostname)) return false
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  if (req.headers.host?.toLowerCase() !== expected.host.toLowerCase()) return false
  if (exactHeaderOrigin(req.headers.origin) === expected.origin) {
    return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin'
  }
  if (mutating) return false
  return req.headers['sec-fetch-site'] === 'same-origin'
    && referrerOrigin(req.headers.referer) === expected.origin
}

/** Read one bounded JSON body (claim accepts `{ reason?: string }`). */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const encoder = new TextEncoder()
  let size = 0
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? encoder.encode(chunk) : chunk as Uint8Array
    size += buffer.byteLength
    if (size > MAX_CLAIM_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(new Uint8Array(buffer))
  }
  const text = new TextDecoder().decode(concatenate(chunks))
  return text.trim().length === 0 ? {} : JSON.parse(text) as unknown
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** The banner's state read: the renderer-safe live projection. */
export function handleAgentBrowserStateRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  executor: AgentBrowserRouteExecutor,
): void {
  if (req.method !== 'GET') return finishJson(res, 405, { error: 'method not allowed' }, 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  finishJson(res, 200, executor.describe())
}

/** §5.4 entry 2: the web-client banner claims control. */
export async function handleAgentBrowserClaimRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  executor: AgentBrowserRouteExecutor,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' }, 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  let reason: string | undefined
  try {
    const body = await readJson(req) as Record<string, unknown>
    if (body.reason !== undefined) {
      if (typeof body.reason !== 'string' || body.reason.length > 200) {
        return finishJson(res, 400, { error: 'invalid claim request' })
      }
      reason = `the operator claimed control from the web client banner: ${body.reason}`
    }
  } catch {
    return finishJson(res, 400, { error: 'invalid claim request' })
  }
  executor.claimControl(reason)
  finishJson(res, 200, { claimed: true, phase: executor.describe().phase })
}

/** §5.4: the web-client banner releases control (generation bumps). */
export function handleAgentBrowserReleaseRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  executor: AgentBrowserRouteExecutor,
): void {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' }, 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  executor.releaseControl()
  const state = executor.describe()
  finishJson(res, 200, { released: true, phase: state.phase, generation: state.generation })
}

/** Encode one SSE frame in the wire format. */
export function encodeAgentBrowserFrame(frame: AgentBrowserEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/**
 * The hanging SSE response (§2): the WebServer route contract supports
 * handlers that own the full response lifecycle, so this handler returns
 * once the stream is armed and the response stays open until the client
 * disconnects. An initial `state` frame primes the client before any push.
 */
export function handleAgentBrowserEventsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  executor: AgentBrowserRouteExecutor,
  options: { readonly heartbeatMs?: number } = {},
): void {
  if (req.method !== 'GET') return finishJson(res, 405, { error: 'method not allowed' }, 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    return finishJson(res, 403, { error: 'forbidden' })
  }
  const heartbeatMs = options.heartbeatMs ?? AGENT_BROWSER_SSE_HEARTBEAT_MS
  res.statusCode = 200
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.write(`retry: ${String(SSE_RETRY_MS)}\n\n`)
  const live = executor.describe()
  if (live.open) {
    res.write(encodeAgentBrowserFrame({
      kind: 'state',
      url: live.url,
      title: live.title,
      phase: live.phase,
      generation: live.generation,
    }))
  }
  const unsubscribe = executor.subscribe(frame => {
    if (res.destroyed || res.writableEnded) return
    res.write(encodeAgentBrowserFrame(frame))
  })
  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return
    res.write(': ping\n\n')
  }, heartbeatMs)
  const finish = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  res.once('close', finish)
  // The handler returns with the response open — the WebServer route
  // contract explicitly supports held responses (SSE).
}
