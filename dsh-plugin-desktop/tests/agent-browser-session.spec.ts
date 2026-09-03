/**
 * Agent-browser session state machine: the revised ref/generation
 * discipline, snapshot staleness, shallow re-fetch, waits, serialization,
 * and screenshot decode — all against fake window hosts and a fake
 * debugger transport (B1 acceptance).
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentBrowserGuestWebContents,
  AgentBrowserWindowHost,
} from '../src/agent-browser-session.ts'
import {
  AgentBrowserError,
  AgentBrowserGenerationCounter,
  DesktopAgentBrowserSession,
  type AgentBrowserWindowHostFactory,
} from '../src/agent-browser-session.ts'
import type { AgentBrowserDebuggerTarget } from '../src/agent-browser-cdp.ts'

describe('agent-browser generation counter (revised semantics)', () => {
  it('bumps on main-frame navigation only, never on mutation', () => {
    const counter = new AgentBrowserGenerationCounter()

    expect(counter.current).toBe(0)
    counter.markDirty()
    counter.markDirty()
    expect(counter.current).toBe(0)
    expect(counter.isDirty).toBe(true)

    counter.noteMainFrameNavigation()
    expect(counter.current).toBe(1)
    expect(counter.isDirty).toBe(false)
  })

  it('completes an open/navigate cycle with exactly one bump', () => {
    const counter = new AgentBrowserGenerationCounter()
    const since = counter.current

    // The navigation event fired while the operation was in flight.
    counter.noteMainFrameNavigation()
    counter.noteOperationCompletion(since)
    expect(counter.current).toBe(1)

    // A quiet navigation (no event observed yet) still bumps once on completion.
    const quiet = counter.current
    counter.noteOperationCompletion(quiet)
    expect(counter.current).toBe(2)
  })

  it('treats human release as a one-shot boundary and dirty as consumable', () => {
    const counter = new AgentBrowserGenerationCounter()
    counter.noteHumanRelease()
    expect(counter.current).toBe(1)

    counter.markDirty()
    expect(counter.consumeDirty()).toBe(true)
    expect(counter.consumeDirty()).toBe(false)
  })
})

/** Fake debugger with scripted responses and event emission. */
function fakeGuestDebugger(responses: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<(params: unknown) => void>>()
  const commands: Array<{ method: string, params?: unknown }> = []
  const target: AgentBrowserDebuggerTarget = {
    attach: () => {},
    detach: () => {},
    isAttached: () => false,
    sendCommand: async (method, params) => {
      commands.push({ method, ...(params === undefined ? {} : { params }) })
      if (method in responses) return (responses as Record<string, unknown>)[method]
      return {}
    },
    on: (event, listener) => {
      // Only message listeners forward; detach subscriptions are ignored so
      // event emission can never masquerade as a session teardown.
      if (event !== 'message') return
      let entry = listeners.get('*')
      if (entry === undefined) {
        entry = new Set()
        listeners.set('*', entry)
      }
      entry.add(listener as never)
    },
    off: () => {},
  }
  return {
    commands,
    emit(method: string, params: unknown): void {
      for (const listener of [...(listeners.get('*') ?? [])]) {
        (listener as unknown as (event: unknown, method: string, params: unknown, sessionId: string) => void)(
          undefined,
          method,
          params,
          '',
        )
      }
    },
    target,
  }
}

/** Fake guest webContents bound to the fake debugger. */
function fakeGuest(target: AgentBrowserDebuggerTarget, url = 'https://example.test/'): AgentBrowserGuestWebContents {
  return {
    debugger: target,
    getURL: () => url,
    getTitle: () => 'Example',
    setWindowOpenHandler: vi.fn(),
  }
}

/** Fake window host recording pushed view models; guest attach is scripted. */
interface FakeWindowHost extends AgentBrowserWindowHost {
  readonly states: Array<Record<string, unknown>>
  emitClosed(): void
}

function createHarness(options: {
  responses?: Record<string, unknown>
  attachGuest?: (host: FakeWindowHost) => AgentBrowserGuestWebContents
  now?: () => number
  settleQuietMs?: number
  pollMs?: number
} = {}) {
  const hosts: FakeWindowHost[] = []
  const tokens: string[] = []
  const closed: string[] = []
  const factory: AgentBrowserWindowHostFactory = hostOptions => {
    tokens.push(hostOptions.partition)
    const states: Array<Record<string, unknown>> = []
    const host: FakeWindowHost = {
      states,
      async open() {
        return options.attachGuest?.(host) ?? fakeGuest(fakeGuestDebugger(options.responses).target)
      },
      pushState: state => { states.push(state as unknown as Record<string, unknown>) },
      close() { closed.push(hostOptions.partition) },
      isClosed: () => false,
      emitClosed() { hostOptions.onWindowClosed() },
    }
    hosts.push(host)
    return host
  }
  const session = new DesktopAgentBrowserSession({
    createWindowHost: factory,
    mintPartitionToken: () => {
      const token = `dsh-agent-browser-test-${String(tokens.length + 1)}`
      return token
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.settleQuietMs === undefined ? {} : { settleQuietMs: options.settleQuietMs }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  })
  return { session, hosts, tokens, closed }
}

function documentResponse(children: number): unknown {
  return {
    root: {
      nodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: Array.from({ length: children }, (_, index) => ({
        nodeId: index + 2,
        nodeType: 1,
        nodeName: 'SPAN',
        localName: 'span',
        backendNodeId: index + 2,
      })),
    },
  }
}

describe('agent-browser session', () => {
  it('opens lazily with a one-shot partition token and bumps the generation once', async () => {
    const debugger_ = fakeGuestDebugger()
    let attachedGuest: AgentBrowserGuestWebContents | undefined
    const { session, hosts, tokens } = createHarness({
      attachGuest: () => {
        attachedGuest = fakeGuest(debugger_.target, 'https://example.test/opened')
        return attachedGuest
      },
    })

    expect(tokens).toEqual([])
    const info = await session.open('https://example.test/opened', { waitForLoad: false })

    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatch(/^dsh-agent-browser-test-\d+$/u)
    expect(info).toEqual({ url: 'https://example.test/opened', title: 'Example', generation: 1 })
    expect(hosts[0]!.states.at(-1)).toMatchObject({
      url: 'https://example.test/opened',
      partition: tokens[0],
      generation: 1,
    })
    // The startup command set matches the B1 CDP surface plus the main-frame
    // identity read (B1 review P2).
    expect(debugger_.commands.map(command => command.method)).toEqual([
      'Page.enable',
      'Page.setLifecycleEventsEnabled',
      'DOM.enable',
      'Page.getFrameTree',
      'Page.navigate',
    ])
  })

  it('ignores an iframe pushState and bumps only on the main frame', async () => {
    const debugger_ = fakeGuestDebugger({
      'Page.getFrameTree': { frameTree: { frame: { id: 'main-frame' } } },
    })
    const { session, hosts } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })
    expect(session.describe().generation).toBe(1)

    // An iframe's same-document navigation is NOT a main-frame boundary:
    // the generation must not churn (B1 review P2).
    debugger_.emit('Page.navigatedWithinDocument', {
      frameId: 'child-frame-1',
      url: 'https://embed.example.test/#step-2',
    })
    expect(session.describe().generation).toBe(1)
    expect(session.describe().url).toBe('https://example.test/')

    // The main frame's pushState still is one.
    debugger_.emit('Page.navigatedWithinDocument', {
      frameId: 'main-frame',
      url: 'https://example.test/#section-2',
    })
    const state = session.describe()
    expect(state.generation).toBe(2)
    // The pushed view model carries the same-document URL; describe() re-reads
    // the fake guest's static identity instead, so assert on the push.
    expect(hosts[0]!.states.at(-1)).toMatchObject({ url: 'https://example.test/#section-2', generation: 2 })
  })

  it('self-heals the main-frame identity from frameNavigated events', async () => {
    // getFrameTree returns nothing usable: the filter stays permissive until
    // the first parentless frameNavigated teaches the identity.
    const debugger_ = fakeGuestDebugger({ 'Page.getFrameTree': {} })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    debugger_.emit('Page.navigatedWithinDocument', { frameId: 'unknown-frame', url: 'https://example.test/#x' })
    expect(session.describe().generation).toBe(2)

    debugger_.emit('Page.frameNavigated', { frame: { id: 'learned-main', url: 'https://example.test/next' } })
    debugger_.emit('Page.navigatedWithinDocument', { frameId: 'unknown-frame', url: 'https://example.test/#y' })
    expect(session.describe().generation).toBe(3)
    debugger_.emit('Page.navigatedWithinDocument', { frameId: 'learned-main', url: 'https://example.test/#z' })
    expect(session.describe().generation).toBe(4)
  })

  it('bumps again on navigation but never on DOM mutation', async () => {
    const debugger_ = fakeGuestDebugger()
    const { session } = createHarness({
      attachGuest: () => fakeGuest(debugger_.target, 'https://example.test/first'),
    })
    await session.open('https://example.test/first', { waitForLoad: false })

    // Mutations mark dirty only.
    debugger_.emit('DOM.childNodeInserted', { parentNodeId: 3, previousNodeId: 0, node: { nodeId: 9 } })
    const dirtyState = session.describe()
    expect(dirtyState.generation).toBe(1)

    // A renderer-initiated main-frame navigation is a boundary.
    debugger_.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'https://example.test/second' } })
    expect(session.describe().generation).toBe(2)

    const navigation = session.navigate('https://example.test/third')
    // One microtask lets the operation subscribe its load listener before
    // the event fires, so the navigation completes without polling.
    await Promise.resolve()
    debugger_.emit('Page.loadEventFired', {})
    const navigated = await navigation
    expect(navigated.generation).toBe(3)
  })

  it('rejects a snapshot for a stale generation with corrective text', async () => {
    const debugger_ = fakeGuestDebugger({ 'DOM.getDocument': documentResponse(2) })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })
    debugger_.emit('Page.frameNavigated', { frame: { id: 'f1', url: 'https://example.test/page2' } })

    await expect(session.snapshot(1)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentBrowserError)
      expect((error as AgentBrowserError).code).toBe('STALE_SNAPSHOT')
      expect((error as Error).message).toContain('call browser_snapshot again')
      return true
    })
  })

  it('re-fetches shallow when the node budget overruns', async () => {
    const wide = { 'DOM.getDocument': documentResponse(6_000) }
    const debugger_ = fakeGuestDebugger(wide)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const snapshot = await session.snapshot(undefined)

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.tree).toContain('[snapshot truncated: node budget reached]')
    const documentCalls = debugger_.commands.filter(command => command.method === 'DOM.getDocument')
    expect(documentCalls.map(call => (call.params as { depth: number }).depth)).toEqual([14, 6])
  })

  it('caches a clean snapshot and invalidates it on mutation', async () => {
    const debugger_ = fakeGuestDebugger({ 'DOM.getDocument': documentResponse(3) })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const first = await session.snapshot(undefined)
    const second = await session.snapshot(undefined)
    expect(second).toBe(first)
    expect(debugger_.commands.filter(command => command.method === 'DOM.getDocument')).toHaveLength(1)

    debugger_.emit('DOM.setChildNodes', { parentId: 1, nodes: [] })
    await session.snapshot(undefined)
    expect(debugger_.commands.filter(command => command.method === 'DOM.getDocument')).toHaveLength(2)
  })

  it('refetches when a mutation lands while a snapshot build is in flight', async () => {
    // B1 review P3: the mutation races the getDocument round trip. The
    // event handler clears the cached snapshot, but the build that was in
    // flight then caches a tree computed before the mutation — consuming the
    // dirty flag and trusting that cache served the stale tree afterwards.
    const debugger_ = fakeGuestDebugger({ 'DOM.getDocument': documentResponse(3) })
    const scriptedSend = debugger_.target.sendCommand.bind(debugger_.target)
    let holdFirstFetch: Promise<void> | undefined
    let releaseHold: (() => void) | undefined
    let firstFetchInFlight = false
    debugger_.target.sendCommand = async (method: string, params?: unknown) => {
      if (method === 'DOM.getDocument' && holdFirstFetch !== undefined) {
        firstFetchInFlight = true
        const held = holdFirstFetch
        holdFirstFetch = undefined
        await held
        debugger_.commands.push({ method, ...(params === undefined ? {} : { params }) })
        return documentResponse(3)
      }
      return await scriptedSend(method, params)
    }
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    holdFirstFetch = new Promise<void>(resolve => { releaseHold = resolve })
    const firstSnapshot = session.snapshot(undefined)
    // Pump until the fetch itself is in flight — only then is a mutation a
    // mid-build race rather than a pre-build one.
    while (!firstFetchInFlight) await Promise.resolve()
    // The mutation lands AFTER the fetch started but BEFORE the build cached.
    debugger_.emit('DOM.childNodeInserted', { parentNodeId: 1, previousNodeId: 0, node: { nodeId: 9 } })
    const release = releaseHold
    releaseHold = undefined
    release?.()
    await firstSnapshot
    expect(debugger_.commands.filter(command => command.method === 'DOM.getDocument')).toHaveLength(1)

    // The stale in-flight cache must NOT be served: the dirty flag that was
    // set mid-build forces the refetch.
    await session.snapshot(undefined)
    expect(debugger_.commands.filter(command => command.method === 'DOM.getDocument')).toHaveLength(2)
  })

  it('fails fast when the window never opened', async () => {
    const { session } = createHarness()
    await expect(session.snapshot(undefined)).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('WINDOW_CLOSED')
      return true
    })
  })

  it('serializes concurrent operations through the per-window mutex', async () => {
    const order: string[] = []
    let releaseNavigate: (() => void) | undefined
    let navigateCalls = 0
    const debugger_ = fakeGuestDebugger({ 'DOM.getDocument': documentResponse(1) })
    const scriptedSend = debugger_.target.sendCommand.bind(debugger_.target)
    debugger_.target.sendCommand = async (method: string, params?: unknown) => {
      if (method === 'Page.navigate') {
        navigateCalls += 1
        order.push(`navigate-${navigateCalls}-start`)
        // The open-navigation passes through; the second navigation blocks.
        if (navigateCalls > 1) await new Promise<void>(resolve => { releaseNavigate = resolve })
        order.push(`navigate-${navigateCalls}-end`)
        return {}
      }
      return await scriptedSend(method, params)
    }
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/first', { waitForLoad: false })

    const navigation = session.navigate('https://example.test/slow')
    // Let the navigation subscribe its load listener and reach the blocked send.
    while (releaseNavigate === undefined) await Promise.resolve()
    // The load event is already pending, so the navigate completes immediately
    // after the send resolves instead of polling the timeout.
    debugger_.emit('Page.loadEventFired', {})
    releaseNavigate()
    const snapshot = session.snapshot(undefined)
    await navigation
    await snapshot

    expect(order).toEqual(['navigate-1-start', 'navigate-1-end', 'navigate-2-start', 'navigate-2-end'])
  })

  it('waits for a quiet settle window and reports the dwell', async () => {
    let clock = 0
    const debugger_ = fakeGuestDebugger({ 'DOM.getDocument': documentResponse(1) })
    const { session } = createHarness({
      attachGuest: () => fakeGuest(debugger_.target),
      now: () => clock,
      settleQuietMs: 500,
      pollMs: 50,
    })
    await session.open('https://example.test/', { waitForLoad: false })

    // Drive the fake clock alongside the real (50 ms) poll sleeps.
    const waiting = session.wait({ until: 'settle', timeoutMs: 5_000 })
    const advance = (async () => {
      for (let index = 0; index < 30; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
        clock += 100
      }
    })()
    const outcome = await waiting
    await advance

    expect(outcome.generation).toBe(1)
    expect(outcome.waited).toBeGreaterThanOrEqual(500)
  })

  it('decodes the screenshot payload without Node globals and reports scaled dimensions', async () => {
    // 'aGVsbG8=' is base64 for 'hello'.
    const debugger_ = fakeGuestDebugger({
      'Page.getLayoutMetrics': { cssVisualViewport: { x: 0, y: 0, clientWidth: 2560, clientHeight: 800, scale: 1 } },
      'Page.captureScreenshot': { data: 'aGVsbG8=' },
    })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const shot = await session.captureScreenshot()
    expect(Array.from(shot.data)).toEqual([104, 101, 108, 108, 111])
    expect(shot.width).toBe(1280)
    expect(shot.height).toBe(400)
  })

  it('closes the window host and resets the surface', async () => {
    const debugger_ = fakeGuestDebugger()
    const { session, closed } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await session.close()
    expect(closed).toHaveLength(1)
    expect(session.describe()).toMatchObject({ open: false, url: 'about:blank', generation: 1 })
    await expect(session.snapshot(undefined)).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('WINDOW_CLOSED')
      return true
    })
  })
})
