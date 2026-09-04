/**
 * Shared headless harness for agent-browser session specs: a fake guest
 * debugger transport, a fake guest webContents, and the fake window-host
 * factory `createHarness` binds into `DesktopAgentBrowserSession` (the
 * day-1 spike shapes, reused by the session/claim/overlay specs).
 *
 * Test-only module — never shipped; imports mirror the spec files' needs.
 */

import { vi } from 'vitest'
import type {
  AgentBrowserGuestWebContents,
  AgentBrowserWindowHost,
  AgentBrowserSessionOptions,
  AgentBrowserWindowHostFactory,
} from '../src/agent-browser-session.ts'
import { DesktopAgentBrowserSession } from '../src/agent-browser-session.ts'
import type { AgentBrowserDebuggerTarget } from '../src/agent-browser-cdp.ts'
/** Fake debugger with scripted responses and event emission. */
export function fakeGuestDebugger(responses: Record<string, unknown> = {}) {
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
export function fakeGuest(target: AgentBrowserDebuggerTarget, url = 'https://example.test/'): AgentBrowserGuestWebContents {
  return {
    debugger: target,
    getURL: () => url,
    getTitle: () => 'Example',
    setWindowOpenHandler: vi.fn(),
  }
}

/**
 * Guard-aware fake guest (B4 §5.5/§5.1): the guest seams the session's
 * policy enforcement installs on, plus emitters that replay the exact
 * Electron event shape. Each emitter reports whether the listener called
 * `preventDefault` (the deny signal); the download emitter reports the
 * `cancel()` call through the fake item.
 */
export function guardedFakeGuest(
  target: AgentBrowserDebuggerTarget,
  url = 'https://example.test/',
): {
  readonly guest: AgentBrowserGuestWebContents
  /** Replay one renderer-initiated main-frame navigation; true when denied. */
  emitWillNavigate(url: string): boolean
  /** Replay one server-side redirect hop; true when the chain was broken. */
  emitWillRedirect(url: string): boolean
  /** Replay one page-initiated download; true when it was cancelled. */
  emitWillDownload(url: string, filename?: string): boolean
} {
  const willNavigate = new Set<(event: { preventDefault(): void }, url: string) => void>()
  const willRedirect = new Set<(event: { preventDefault(): void }, url: string) => void>()
  const willDownload = new Set<(event: unknown, item: { cancel(): void, getURL(): string, getFilename(): string }) => void>()
  type GuardListener = (event: { preventDefault(): void }, url: string) => void
  const guest: AgentBrowserGuestWebContents = {
    debugger: target,
    getURL: () => url,
    getTitle: () => 'Example',
    setWindowOpenHandler: vi.fn(),
    on: (event: 'will-navigate' | 'will-redirect', listener: GuardListener) => {
      (event === 'will-navigate' ? willNavigate : willRedirect).add(listener)
      return () => { (event === 'will-navigate' ? willNavigate : willRedirect).delete(listener) }
    },
    session: {
      // Real-Electron shape (probed under the pinned 43.4.0): `on` returns
      // the emitter itself, not a disposer — removal goes through the Node
      // `removeListener` seam, which is what the session's unwind closure uses.
      on: (event: 'will-download', listener: (event: unknown, item: { cancel(): void, getURL(): string, getFilename(): string }) => void) => {
        if (event !== 'will-download') return undefined
        willDownload.add(listener)
        return undefined
      },
      removeListener: (
        event: 'will-download',
        listener: (event: unknown, item: { cancel(): void, getURL(): string, getFilename(): string }) => void,
      ) => {
        if (event === 'will-download') willDownload.delete(listener)
      },
    },
  }
  const emitGuard = (
    listeners: ReadonlySet<(event: { preventDefault(): void }, url: string) => void>,
    targetUrl: string,
  ): boolean => {
    let prevented = false
    for (const listener of [...listeners]) {
      listener({ preventDefault: () => { prevented = true } }, targetUrl)
    }
    return prevented
  }
  return {
    guest,
    emitWillNavigate: targetUrl => emitGuard(willNavigate, targetUrl),
    emitWillRedirect: targetUrl => emitGuard(willRedirect, targetUrl),
    emitWillDownload: (targetUrl, filename = 'payload.bin') => {
      let cancelled = false
      for (const listener of [...willDownload]) {
        listener(undefined, {
          cancel: () => { cancelled = true },
          getURL: () => targetUrl,
          getFilename: () => filename,
        })
      }
      return cancelled
    },
  }
}

/** Fake window host recording pushed view models; guest attach is scripted. */
export interface FakeWindowHost extends AgentBrowserWindowHost {
  readonly states: Array<Record<string, unknown>>
  emitClosed(): void
}

export type AgentBrowserWindowHostFactoryOptions = Parameters<
  NonNullable<AgentBrowserSessionOptions['createWindowHost']>
>[0]

/** Latest factory options, so tests can drive the toolbar claim seam. */
let lastFactoryOptionsValue: AgentBrowserWindowHostFactoryOptions | undefined

/** The latest window-host factory options (the toolbar button seams). */
export function lastFactoryOptions(): AgentBrowserWindowHostFactoryOptions | undefined {
  return lastFactoryOptionsValue
}

/** Record the latest window-host factory options (called by createHarness). */
export function noteFactoryOptions(options: AgentBrowserWindowHostFactoryOptions): void {
  lastFactoryOptionsValue = options
}

export function createHarness(options: {
  responses?: Record<string, unknown>
  attachGuest?: (host: FakeWindowHost) => AgentBrowserGuestWebContents
  now?: () => number
  settleQuietMs?: number
  pollMs?: number
  login?: AgentBrowserSessionOptions['login']
  navigationPolicy?: AgentBrowserSessionOptions['navigationPolicy']
  logError?: (message: string) => void
} = {}) {
  const hosts: FakeWindowHost[] = []
  const tokens: string[] = []
  const closed: string[] = []
  const factory: AgentBrowserWindowHostFactory = hostOptions => {
    lastFactoryOptionsValue = hostOptions
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
    ...(options.login === undefined ? {} : { login: options.login }),
    ...(options.navigationPolicy === undefined ? {} : { navigationPolicy: options.navigationPolicy }),
    ...(options.logError === undefined ? {} : { logError: options.logError }),
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
    pressClaimButton: () => { lastFactoryOptionsValue?.onHumanClaim() },
    pressReleaseButton: () => { lastFactoryOptionsValue?.onHumanRelease() },
  }
}
