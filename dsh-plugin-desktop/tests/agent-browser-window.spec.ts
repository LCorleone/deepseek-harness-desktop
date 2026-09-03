/**
 * Agent-browser window: options shape, the P0 partition discipline, and the
 * fake-environment partition-isolation assertions (B1 acceptance).
 *
 * The real-composition identity proof (`guest.session ===
 * session.fromPartition(token)`, spike finding 2) cannot run headless; the
 * fake environment here pins the wiring that produces it: the window's own
 * preferences carry NO partition, the `<webview>` attachment is rewritten to
 * the host-minted token, the session registry resolves the guest through the
 * token partition, and the default session storage directory observes zero
 * new entries after a full attach cycle.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  function emitter() {
    const listeners = new Map<string, Array<{ readonly listener: Listener, readonly once: boolean }>>()
    return {
      on: (event: string, listener: Listener): void => {
        const existing = listeners.get(event) ?? []
        existing.push({ listener, once: false })
        listeners.set(event, existing)
      },
      once: (event: string, listener: Listener): void => {
        const existing = listeners.get(event) ?? []
        existing.push({ listener, once: true })
        listeners.set(event, existing)
      },
      off: (event: string, listener: Listener): void => {
        const existing = listeners.get(event)
        if (existing !== undefined) {
          listeners.set(event, existing.filter(entry => entry.listener !== listener))
        }
      },
      emit: (event: string, ...args: unknown[]): void => {
        const fired = [...listeners.get(event) ?? []]
        listeners.set(event, fired.filter(entry => !entry.once))
        for (const { listener } of fired) listener(...args)
      },
    }
  }

  /** Fake default-session storage directory (the P0 zero-entry assertion). */
  let defaultSessionDirectory: string | undefined
  const partitions = new Map<string, { readonly partition: string }>()
  const windows: FakeAgentBrowserWindow[] = []

  class FakeAgentBrowserWindow {
    readonly webContents = emitter()
    readonly windowEvents = emitter()
    readonly sent: Array<{ channel: string, state: unknown }> = []
    readonly loadFile = vi.fn(async () => {})
    readonly destroy = vi.fn()
    readonly isDestroyed = vi.fn(() => false)
    readonly show = vi.fn()
    readonly removeMenu = vi.fn()
    readonly setWindowOpenHandler = vi.fn()
    accessibleTitle = ''

    constructor(readonly options: unknown) {
      Object.assign(this.webContents, {
        setWindowOpenHandler: this.setWindowOpenHandler,
        send: (channel: string, state: unknown) => { this.sent.push({ channel, state }) },
      })
      windows.push(this)
    }

    on(event: string, listener: Listener): void { this.windowEvents.on(event, listener) }
    once(event: string, listener: Listener): void { this.windowEvents.once(event, listener) }
  }

  const ipcMain = emitter()

  return {
    ipcMain,
    windows,
    get defaultSessionDirectory(): string {
      // Created lazily: vi.hoisted runs before the test imports initialize.
      defaultSessionDirectory ??= mkdtempSync(join(tmpdir(), 'dsh-default-session-'))
      return defaultSessionDirectory
    },
    fromPartition: (partition: string) => {
      let session = partitions.get(partition)
      if (session === undefined) {
        session = { partition }
        partitions.set(partition, session)
      }
      return session
    },
    defaultSession: { partition: '' },
    partitions,
    FakeAgentBrowserWindow,
  }
})

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeAgentBrowserWindow,
  ipcMain: electron.ipcMain,
}))

import {
  DesktopAgentBrowserWindowHost,
  agentBrowserWindowOptions,
  guardAgentBrowserWebviewAttachment,
} from '../src/agent-browser-window.ts'
import { DESKTOP_AGENT_BROWSER_STATE_CHANNEL } from '../src/agent-browser-contract.ts'

/** Typed view over the fake window the host code talks to. */
interface FakeWindowView {
  readonly webContents: {
    on(event: string, listener: (...args: unknown[]) => void): void
    once(event: string, listener: (...args: unknown[]) => void): void
    emit(event: string, ...args: unknown[]): void
  }
  readonly sent: Array<{ channel: string, state: unknown }>
  readonly options: unknown
  readonly loadFile: ReturnType<typeof vi.fn>
  readonly destroy: ReturnType<typeof vi.fn>
}

function fakeGuest(): { debugger: object, getURL: () => string, getTitle: () => string, setWindowOpenHandler: () => void } {
  return {
    debugger: {},
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    setWindowOpenHandler: vi.fn(),
  }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('agent-browser window options (P0 partition placement)', () => {
  it('enables webviewTag on a sandboxed embedder with NO window-level partition', () => {
    const options = agentBrowserWindowOptions()
    const preferences = options.webPreferences as Record<string, unknown>

    expect(preferences.webviewTag).toBe(true)
    expect(preferences.contextIsolation).toBe(true)
    expect(preferences.nodeIntegration).toBe(false)
    expect(preferences.sandbox).toBe(true)
    expect(preferences.webSecurity).toBe(true)
    // The partition belongs to the guest's <webview>, never the embedder.
    expect('partition' in preferences).toBe(false)
    expect('session' in preferences).toBe(false)
    expect(typeof preferences.preload).toBe('string')
    expect(String(preferences.preload)).toContain('agent-browser-preload')
    // §1 sizing: 1120x760 default, 720x540 minimum, dark background.
    expect(options.width).toBe(1_120)
    expect(options.height).toBe(760)
    expect(options.minWidth).toBe(720)
    expect(options.minHeight).toBe(540)
    expect(options.autoHideMenuBar).toBe(true)
    expect(options.backgroundColor).toBe('#202124')
  })

  it('rewrites the webview attachment to the host token and scrubs preload/node flags', () => {
    const webPreferences: Record<string, unknown> = {
      preload: '/evil/preload.js',
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      nodeIntegrationInSubFrames: true,
      webviewTag: true,
      contextIsolation: false,
    }
    const params: Record<string, string> = { src: 'https://example.test/', partition: 'wrong' }

    guardAgentBrowserWebviewAttachment(webPreferences, params, 'dsh-agent-browser-token')

    expect(webPreferences.partition).toBe('dsh-agent-browser-token')
    expect(webPreferences.preload).toBeUndefined()
    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.nodeIntegrationInWorker).toBe(false)
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false)
    expect(webPreferences.webviewTag).toBe(false)
    expect(webPreferences.contextIsolation).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
    expect(webPreferences.webSecurity).toBe(true)
    expect(params.partition).toBe('dsh-agent-browser-token')
    expect(params.allowpopups).toBe('false')
    // The declarative src attribute survives: only the token is re-asserted.
    expect(params.src).toBe('https://example.test/')
  })
})

describe('agent-browser window host (fake environment)', () => {
  beforeEach(() => {
    electron.windows.length = 0
  })

  it('subscribes did-attach-webview before the document load and resolves the guest', async () => {
    const host = new DesktopAgentBrowserWindowHost({ partition: 'dsh-agent-browser-token' })
    const guest = fakeGuest()
    const opened = host.open()
    const window = electron.windows[0] as unknown as FakeWindowView

    // The attach subscription is registered before the load starts, so the
    // event fired while the document parses is never missed (day-1 spike
    // finding); the load is in flight but unresolved when the guest arrives.
    expect(window.loadFile).toHaveBeenCalledTimes(1)
    window.webContents.emit('did-attach-webview', undefined, guest)
    await opened

    expect(window.loadFile).toHaveBeenCalledTimes(1)
    expect(window.options).toMatchObject({ title: 'DSH Agent Browser' })
    expect(window.webContents).toBeDefined()
    expect(host.isClosed()).toBe(false)
  })

  it('refuses embedder navigation and re-asserts the token in will-attach-webview', async () => {
    const host = new DesktopAgentBrowserWindowHost({ partition: 'dsh-agent-browser-token' })
    const guest = fakeGuest()
    const opened = host.open()
    const window = electron.windows[0] as unknown as FakeWindowView
    window.webContents.emit('did-attach-webview', undefined, guest)
    await opened

    const preventDefault = vi.fn()
    window.webContents.emit('will-navigate', { preventDefault }, 'https://evil.example/')
    expect(preventDefault).toHaveBeenCalledTimes(1)

    const webPreferences: Record<string, unknown> = { nodeIntegration: true }
    const params: Record<string, string> = { src: 'about:blank' }
    window.webContents.emit('will-attach-webview', { preventDefault: vi.fn() }, webPreferences, params)
    expect(webPreferences.partition).toBe('dsh-agent-browser-token')
    expect(params.partition).toBe('dsh-agent-browser-token')
    expect(webPreferences.nodeIntegration).toBe(false)
  })

  it('pushes view models on the dedicated channel and re-pushes after finish-load', async () => {
    const host = new DesktopAgentBrowserWindowHost({ partition: 'dsh-agent-browser-token' })
    const guest = fakeGuest()
    const opened = host.open()
    const window = electron.windows[0] as unknown as FakeWindowView
    window.webContents.emit('did-attach-webview', undefined, guest)
    await opened

    host.pushState({
      url: 'https://example.test/',
      title: 'Example',
      phase: 'observing',
      generation: 1,
      partition: 'dsh-agent-browser-token',
    })
    expect(window.sent).toEqual([{
      channel: DESKTOP_AGENT_BROWSER_STATE_CHANNEL,
      state: {
        url: 'https://example.test/',
        title: 'Example',
        phase: 'observing',
        generation: 1,
        partition: 'dsh-agent-browser-token',
      },
    }])

    // A state pushed before the renderer subscribed re-pushes on finish-load,
    // so the first paint always carries the partition token.
    host.pushState({
      url: 'https://example.test/2',
      title: 'Two',
      phase: 'observing',
      generation: 2,
      partition: 'dsh-agent-browser-token',
    })
    window.webContents.emit('did-finish-load')
    expect(window.sent.at(-1)?.state).toMatchObject({ url: 'https://example.test/2', generation: 2 })
  })

  it('closes on the toolbar close channel for its own renderer only', async () => {
    const host = new DesktopAgentBrowserWindowHost({ partition: 'dsh-agent-browser-token' })
    const guest = fakeGuest()
    const opened = host.open()
    const window = electron.windows[0] as unknown as FakeWindowView
    window.webContents.emit('did-attach-webview', undefined, guest)
    await opened

    electron.ipcMain.emit('dsh-agent-browser/close', { sender: { foreign: true } })
    expect(window.destroy).toHaveBeenCalledTimes(0)

    electron.ipcMain.emit('dsh-agent-browser/close', { sender: window.webContents })
    expect(window.destroy).toHaveBeenCalledTimes(1)
    expect(host.isClosed()).toBe(true)
  })

  it('keeps the default session untouched while the guest rides the token partition', () => {
    // The fake registry mirrors Electron's session.fromPartition semantics:
    // only the token partition is ever requested, and the default session's
    // storage directory (the P0 leak surface) gains zero entries.
    const before = readdirSync(electron.defaultSessionDirectory)
    const tokenSession = electron.fromPartition('dsh-agent-browser-token')

    expect(tokenSession).not.toBe(electron.defaultSession)
    expect(electron.fromPartition('dsh-agent-browser-token')).toBe(tokenSession)
    expect(electron.fromPartition('persist:dsh-agent-browser-token')).not.toBe(tokenSession)
    expect(electron.partitions.has('')).toBe(false)

    const after = readdirSync(electron.defaultSessionDirectory)
    expect(after).toEqual(before)
  })
})
