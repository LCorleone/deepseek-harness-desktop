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
  AUDITED_SNIPPET_FOCUS,
  AUDITED_SNIPPET_FOCUS_SELECT,
  AUDITED_SNIPPET_IS_SUBMIT_CONTROL,
  AUDITED_SNIPPET_SCROLL_INTO_VIEW,
  AgentBrowserError,
  AgentBrowserGenerationCounter,
  DesktopAgentBrowserSession,
  auditedExpressionDocumentScrollBy,
  auditedSnippetScrollBy,
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
  const detachListeners = new Set<(reason: string) => void>()
  const commands: Array<{ method: string, params?: unknown }> = []
  let attached = false
  let attachCount = 0
  const target: AgentBrowserDebuggerTarget = {
    attach: () => { attached = true; attachCount += 1 },
    detach: () => { attached = false },
    isAttached: () => attached,
    sendCommand: async (method, params) => {
      commands.push({ method, ...(params === undefined ? {} : { params }) })
      if (method in responses) {
        const scripted = (responses as Record<string, unknown>)[method]
        if (scripted !== null && typeof scripted === 'object' && '__reject' in (scripted as Record<string, unknown>)) {
          throw new Error(String((scripted as { __reject: string }).__reject))
        }
        if (typeof scripted === 'function') return scripted(params)
        return scripted
      }
      return {}
    },
    on: (event, listener) => {
      // Only message listeners forward; detach subscriptions are ignored so
      // event emission can never masquerade as a session teardown.
      if (event === 'message') {
        let entry = listeners.get('*')
        if (entry === undefined) {
          entry = new Set()
          listeners.set('*', entry)
        }
        entry.add(listener as never)
      } else {
        detachListeners.add(listener as never)
      }
    },
    off: (event, listener) => {
      if (event !== 'message') detachListeners.delete(listener as never)
    },
  }
  return {
    commands,
    attachCount: () => attachCount,
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
    /** Deliver a debugger detach exactly as Electron would. */
    emitDetach(reason: string): void {
      attached = false
      for (const listener of [...detachListeners]) (listener as unknown as (event: unknown, reason: string) => void)(undefined, reason)
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

/** Latest factory options, so tests can drive the toolbar claim seam. */
let lastFactoryOptions: Parameters<AgentBrowserWindowHostFactory>[0] | undefined

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
    lastFactoryOptions = hostOptions
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
  return {
    session,
    hosts,
    tokens,
    closed,
    /** Drive the toolbar buttons through the same callbacks the real host fires. */
    pressClaimButton: () => { lastFactoryOptions?.onHumanClaim() },
    pressReleaseButton: () => { lastFactoryOptions?.onHumanRelease() },
  }
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

/** Default act-phase responses: a resolvable ref with a centered box. */
const ACT_RESPONSES: Record<string, unknown> = {
  'DOM.getDocument': { root: { nodeId: 1, nodeType: 9, nodeName: '#document', children: [
    { nodeId: 2, nodeType: 1, nodeName: 'INPUT', localName: 'input', backendNodeId: 100 },
  ] } },
  'Page.getFrameTree': { frameTree: { frame: { id: 'main-frame' } } },
  'DOM.resolveNode': { object: { objectId: 'obj-1', type: 'node' } },
  'DOM.getBoxModel': { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } },
  'DOM.describeNode': { node: { nodeName: 'INPUT', localName: 'input', nodeType: 1, attributes: ['type', 'text', 'name', 'q'] } },
  'Page.createIsolatedWorld': { executionContextId: 7 },
  'Runtime.callFunctionOn': { result: { type: 'boolean', value: true } },
  'Runtime.evaluate': { result: { type: 'object', value: { before: 0, after: 300 } } },
  'Page.getLayoutMetrics': { cssVisualViewport: { x: 0, y: 0, clientWidth: 1120, clientHeight: 760, scale: 1 } },
}

/** The default content quad [10,20, 110,20, 110,60, 10,60] as a center. */
const BOX_CENTER = { x: 60, y: 40 }

describe('agent-browser claim state machine (§5.4)', () => {
  it('fails act tools and navigation fast while observation continues', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session, hosts } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })
    const commandsBefore = debugger_.commands.length

    session.claimControl('the operator pressed the claim button')

    expect(session.describe().phase).toBe('claimed')
    expect(hosts[0]!.states.at(-1)).toMatchObject({ phase: 'claimed', actionDescription: 'the operator pressed the claim button' })
    await expect(session.click({ ref: 'e2s' })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('OPERATOR_HAS_CONTROL')
      expect((error as Error).message).toContain('fail fast')
      return true
    })
    await expect(session.navigate('https://example.test/next')).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('OPERATOR_HAS_CONTROL')
      return true
    })
    // Claim never reached the transport: no act or navigation CDP work ran.
    expect(debugger_.commands.length).toBe(commandsBefore)
    // Observation stays available while the human holds control.
    const snapshot = await session.snapshot(undefined)
    expect(snapshot.generation).toBe(1)
  })

  it('aborts an in-flight act through the epoch signal at the next step', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    let releaseMouseMoved: (() => void) | undefined
    let mouseMovedInFlight = false
    const scriptedSend = debugger_.target.sendCommand.bind(debugger_.target)
    debugger_.target.sendCommand = async (method: string, params?: unknown) => {
      if (method === 'Input.dispatchMouseEvent' && (params as { type?: string }).type === 'mouseMoved' && !mouseMovedInFlight) {
        mouseMovedInFlight = true
        await new Promise<void>(resolve => { releaseMouseMoved = resolve })
        debugger_.commands.push({ method, ...(params === undefined ? {} : { params }) })
        return {}
      }
      return await scriptedSend(method, params)
    }
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const click = session.click({ ref: 'e2s' })
    while (!mouseMovedInFlight) await Promise.resolve()
    session.claimControl()
    const release = releaseMouseMoved
    releaseMouseMoved = undefined
    release?.()
    await expect(click).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('OPERATOR_HAS_CONTROL')
      // The epoch abort reason surfaces: the claim interrupted the flight.
      expect((error as Error).message).toContain('claimed control')
      return true
    })
    // The half-click stopped at the move: no press was ever dispatched.
    expect(debugger_.commands.filter(command => command.method === 'Input.dispatchMouseEvent')
      .map(command => (command.params as { type: string }).type)).toEqual(['mouseMoved'])
  })

  it('release bumps the generation once and restores acting', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    session.claimControl()
    session.releaseControl()

    expect(session.describe()).toMatchObject({ phase: 'observing', generation: 2 })
    const result = await session.click({ ref: 'e2s', generation: 2 })
    expect(result).toEqual({ generation: 2, performed: true })
    // The refs observed before the claim are stale by construction.
    await expect(session.click({ ref: 'e2s', generation: 1 })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('STALE_SNAPSHOT')
      return true
    })
  })

  it('wires the toolbar claim/release buttons through the window host seam', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session, hosts, pressClaimButton, pressReleaseButton } = createHarness({
      attachGuest: () => fakeGuest(debugger_.target),
    })
    await session.open('https://example.test/', { waitForLoad: false })

    pressClaimButton()
    expect(session.describe().phase).toBe('claimed')
    expect(hosts[0]!.states.at(-1)).toMatchObject({ phase: 'claimed' })

    pressReleaseButton()
    expect(session.describe()).toMatchObject({ phase: 'observing', generation: 2 })
  })
})

describe('agent-browser act loop', () => {
  it('clicks the box-model center with trusted press/release input', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session, hosts } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const result = await session.click({ ref: 'e2s' })
    expect(result).toEqual({ generation: 1, performed: true })

    const input = debugger_.commands.filter(command => command.method === 'Input.dispatchMouseEvent')
    expect(input.map(command => (command.params as { type: string }).type)).toEqual([
      'mouseMoved', 'mousePressed', 'mouseReleased',
    ])
    expect(input[0]!.params).toEqual({ type: 'mouseMoved', x: BOX_CENTER.x, y: BOX_CENTER.y })
    expect(input[1]!.params).toEqual({
      type: 'mousePressed', x: BOX_CENTER.x, y: BOX_CENTER.y, button: 'left', clickCount: 1,
    })
    // The ref resolved through the backendNodeId path (e2s = 100 base36) in
    // the ISOLATED world (B2 review P2): executionContextId rides the resolve.
    expect(debugger_.commands.find(command => command.method === 'DOM.resolveNode')?.params)
      .toEqual({ backendNodeId: 100, executionContextId: 7 })
    // The act-phase isolated world was created for the helper snippets.
    expect(debugger_.commands.find(command => command.method === 'Page.createIsolatedWorld')).toBeDefined()
    // The overlay learned the click point for the zero-injection layer.
    const overlayState = hosts[0]!.states.map(state => state.overlay).find(overlay => overlay !== undefined)
    expect(overlayState).toMatchObject({ cursor: BOX_CENTER, click: BOX_CENTER })
    expect(typeof (overlayState as { clickedAt?: number }).clickedAt).toBe('number')
  })

  it('honors button and clickCount and the generation guard', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const result = await session.click({ ref: 'e2s', generation: 1, button: 'right', clickCount: 2 })
    expect(result.performed).toBe(true)
    const press = debugger_.commands
      .filter(command => command.method === 'Input.dispatchMouseEvent')
      .find(command => (command.params as { type: string }).type === 'mousePressed')
    expect(press!.params).toMatchObject({ button: 'right', clickCount: 2 })

    // A generation mismatch fails BEFORE any CDP work.
    const commandsBefore = debugger_.commands.length
    await expect(session.click({ ref: 'e2s', generation: 0 })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('STALE_SNAPSHOT')
      expect((error as Error).message).toContain('browser_snapshot')
      return true
    })
    expect(debugger_.commands.length).toBe(commandsBefore)
  })

  it('reports REF_NOT_FOUND with corrective text when the ref died', async () => {
    const debugger_ = fakeGuestDebugger({ ...ACT_RESPONSES, 'DOM.resolveNode': { __reject: 'No node with given id' } })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await expect(session.click({ ref: 'e2s' })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('REF_NOT_FOUND')
      expect((error as Error).message).toContain('died with its document')
      return true
    })
    await expect(session.click({ ref: 'not-a-ref' })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('REF_NOT_FOUND')
      return true
    })
  })

  it('scrolls an off-screen element into view before clicking', async () => {
    // First read: the center sits below the 760 px viewport; the re-read
    // after scrollIntoView returns the in-view position.
    let boxReads = 0
    const debugger_ = fakeGuestDebugger({
      ...ACT_RESPONSES,
      'DOM.getBoxModel': () => {
        boxReads += 1
        return { model: { content: boxReads === 1
          ? [10, 800, 110, 800, 110, 840, 10, 840]
          : [10, 300, 110, 300, 110, 340, 10, 340] } }
      },
    })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await session.click({ ref: 'e2s' })

    const scrollIntoView = debugger_.commands
      .filter(command => command.method === 'Runtime.callFunctionOn')
      .map(command => (command.params as { functionDeclaration: string }).functionDeclaration)
    expect(scrollIntoView).toEqual([AUDITED_SNIPPET_SCROLL_INTO_VIEW])
    // The box was re-read after the scroll (two getBoxModel calls).
    expect(debugger_.commands.filter(command => command.method === 'DOM.getBoxModel')).toHaveLength(2)
    // The final click targeted the in-view center, not the off-screen one.
    const press = debugger_.commands
      .filter(command => command.method === 'Input.dispatchMouseEvent')
      .find(command => (command.params as { type: string }).type === 'mousePressed')
    expect(press!.params).toMatchObject({ x: 60, y: 320 })
  })

  it('refuses password targets with the claimControl pointer and types nothing', async () => {
    const debugger_ = fakeGuestDebugger({
      ...ACT_RESPONSES,
      'DOM.describeNode': { node: { nodeName: 'INPUT', localName: 'input', nodeType: 1, attributes: ['type', 'password', 'name', 'pass'] } },
    })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await expect(session.type({ ref: 'e2s', text: 'hunter2' })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('DENIED_BY_POLICY')
      expect((error as Error).message).toContain('claimControl')
      expect((error as Error).message).not.toContain('hunter2')
      return true
    })
    // Nothing reached the input path: no isolated world, no focus, no insert.
    const methods = debugger_.commands.map(command => command.method)
    expect(methods).not.toContain('Input.insertText')
    expect(methods).not.toContain('Page.createIsolatedWorld')
  })

  it('focuses through the isolated world, inserts text, and submits with Enter', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const result = await session.type({ ref: 'e2s', text: 'hello world', submit: true })
    expect(result).toEqual({ generation: 1, performed: true })

    // The world is created on the main frame learned at start (default {} here
    // means getFrameTree fails, so the act path re-learns it — send a tree).
    const world = debugger_.commands.find(command => command.method === 'Page.createIsolatedWorld')
    expect(world).toBeDefined()
    // The focus helper runs in the isolated world over the resolved object.
    const focus = debugger_.commands.find(command => command.method === 'Runtime.callFunctionOn')
    expect(focus!.params).toMatchObject({
      objectId: 'obj-1',
      functionDeclaration: AUDITED_SNIPPET_FOCUS,
      returnByValue: true,
    })
    // The trusted click into the field precedes the insert: a guest render
    // widget without OS-level focus drops Input.insertText (B2 smoke finding).
    const mice = debugger_.commands
      .filter(command => command.method === 'Input.dispatchMouseEvent')
      .map(command => (command.params as { type: string }).type)
    expect(mice).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(debugger_.commands.find(command => command.method === 'Input.insertText')?.params)
      .toEqual({ text: 'hello world' })
    const keys = debugger_.commands
      .filter(command => command.method === 'Input.dispatchKeyEvent')
      .map(command => command.params)
    expect(keys).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    ])
  })

  it('clears through select + trusted Backspace when the text is empty', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await session.type({ ref: 'e2s', text: '', clear: true })

    const focus = debugger_.commands.find(command => command.method === 'Runtime.callFunctionOn')
    expect(focus!.params).toMatchObject({ functionDeclaration: AUDITED_SNIPPET_FOCUS_SELECT })
    const methods = debugger_.commands.map(command => command.method)
    expect(methods).not.toContain('Input.insertText')
    expect(debugger_.commands.filter(command => command.method === 'Input.dispatchKeyEvent').length).toBe(2)
  })

  it('scrolls a ref with the isolated scrollBy and skips the wheel when it moved', async () => {
    const debugger_ = fakeGuestDebugger({
      ...ACT_RESPONSES,
      'Runtime.callFunctionOn': { result: { type: 'object', value: { before: 0, after: 300 } } },
    })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const result = await session.scroll({ ref: 'e2s', direction: 'down', amount: 300 })
    expect(result).toEqual({ generation: 1, performed: true })

    const scroll = debugger_.commands.find(command => command.method === 'Runtime.callFunctionOn')
    expect(scroll!.params).toMatchObject({
      objectId: 'obj-1',
      // Only the validated integer is interpolated into the audited snippet.
      functionDeclaration: auditedSnippetScrollBy(300),
    })
    // The scroll target resolved in the isolated world (B2 review P2).
    expect(debugger_.commands.find(command => command.method === 'DOM.resolveNode')?.params)
      .toEqual({ backendNodeId: 100, executionContextId: 7 })
    expect(debugger_.commands.some(command => command.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('classifies a submit-control ref through the isolated world (B2 review P1)', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    expect(await session.isSubmitControl('e2s')).toBe(true)

    const classify = debugger_.commands.find(command => command.method === 'Runtime.callFunctionOn')
    expect(classify!.params).toMatchObject({
      objectId: 'obj-1',
      functionDeclaration: AUDITED_SNIPPET_IS_SUBMIT_CONTROL,
      returnByValue: true,
    })
    // The classification resolved the ref in the isolated world.
    expect(debugger_.commands.find(command => command.method === 'DOM.resolveNode')?.params)
      .toEqual({ backendNodeId: 100, executionContextId: 7 })
  })

  it('reports a dead submit-control classification as false instead of throwing', async () => {
    const debugger_ = fakeGuestDebugger({ ...ACT_RESPONSES, 'DOM.resolveNode': { __reject: 'No node with given id' } })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    expect(await session.isSubmitControl('e2s')).toBe(false)
  })

  it('returns false for a non-submit control through the classification plumbing', async () => {
    const debugger_ = fakeGuestDebugger({
      ...ACT_RESPONSES,
      'Runtime.callFunctionOn': { result: { type: 'boolean', value: false } },
    })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    expect(await session.isSubmitControl('e2s')).toBe(false)
  })

  it('falls back to the wheel at the element center when scrollBy did not move', async () => {
    const debugger_ = fakeGuestDebugger({
      ...ACT_RESPONSES,
      'Runtime.callFunctionOn': { result: { type: 'object', value: { before: 5, after: 5 } } },
    })
    const { session, hosts } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await session.scroll({ ref: 'e2s', direction: 'up', amount: 400 })

    const wheel = debugger_.commands
      .filter(command => command.method === 'Input.dispatchMouseEvent')
      .map(command => command.params)
    expect(wheel).toEqual([{ type: 'wheel', x: BOX_CENTER.x, y: BOX_CENTER.y, deltaX: 0, deltaY: -400 }])
    expect(hosts[0]!.states.map(state => state.overlay).find(overlay => overlay !== undefined))
      .toMatchObject({ cursor: BOX_CENTER })
  })

  it('scrolls the document through the isolated world when no ref is given', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await session.scroll({ direction: 'down', amount: 250 })

    const evaluate = debugger_.commands.find(command => command.method === 'Runtime.evaluate')
    expect(evaluate!.params).toMatchObject({
      contextId: 7,
      expression: auditedExpressionDocumentScrollBy(250),
      returnByValue: true,
    })
    expect(debugger_.commands.some(command => command.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('retries a transient target-busy failure and completes the act', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    let dispatchAttempts = 0
    const scriptedSend = debugger_.target.sendCommand.bind(debugger_.target)
    debugger_.target.sendCommand = async (method: string, params?: unknown) => {
      if (method === 'Input.dispatchMouseEvent') {
        dispatchAttempts += 1
        if (dispatchAttempts === 1) throw new Error('target busy; try again')
      }
      return await scriptedSend(method, params)
    }
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    const result = await session.click({ ref: 'e2s' })
    expect(result.performed).toBe(true)
    expect(dispatchAttempts).toBeGreaterThanOrEqual(2)
  })

  it('re-attaches once after a DevTools takeover and retries', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })
    expect(debugger_.attachCount()).toBe(1)

    // The human opens guest DevTools: our session detaches mid-act.
    debugger_.emitDetach('DevTools was opened')

    const result = await session.click({ ref: 'e2s' })
    expect(result.performed).toBe(true)
    // Exactly one re-attach happened, and the click completed.
    expect(debugger_.attachCount()).toBe(2)
    expect(debugger_.commands.filter(command => command.method === 'Input.dispatchMouseEvent'))
      .toHaveLength(3)
  })

  it('marks the page dirty after an act so VERIFY never serves the cache', async () => {
    const debugger_ = fakeGuestDebugger(ACT_RESPONSES)
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })
    await session.snapshot(undefined)
    const documentCallsBefore = debugger_.commands
      .filter(command => command.method === 'DOM.getDocument').length

    await session.click({ ref: 'e2s' })
    // No mutation event fired, but the act changed the page (attribute edits
    // emit no subscribed mutation event): the cached tree must not be served.
    await session.snapshot(undefined)
    expect(debugger_.commands.filter(command => command.method === 'DOM.getDocument').length)
      .toBeGreaterThan(documentCallsBefore)
  })

  it('surfaces persistent CDP failures as CDP_UNAVAILABLE after the retry budget', async () => {
    const debugger_ = fakeGuestDebugger({
      ...ACT_RESPONSES,
      'Input.dispatchMouseEvent': { __reject: 'target busy; try again' },
    })
    const { session } = createHarness({ attachGuest: () => fakeGuest(debugger_.target) })
    await session.open('https://example.test/', { waitForLoad: false })

    await expect(session.click({ ref: 'e2s' })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('CDP_UNAVAILABLE')
      expect((error as Error).message).toContain('retry the action')
      return true
    })
    // ≤3 tries: exactly three dispatch attempts, not a storm.
    expect(debugger_.commands.filter(command => command.method === 'Input.dispatchMouseEvent')).toHaveLength(3)
  })
})
