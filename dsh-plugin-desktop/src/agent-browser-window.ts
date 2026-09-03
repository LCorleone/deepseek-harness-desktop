/**
 * Agent-browser window: the sandboxed embedder BrowserWindow that hosts the
 * `<webview>` guest (design §1).
 *
 * Partition placement is the reviewed P0 decision: the WINDOW's
 * webPreferences carry no `partition` (a window-level partition would select
 * the embedder's own session, never the guest's) — the one-shot token rides
 * the `<webview partition="…">` attribute rendered from the pushed view
 * model, and the `will-attach-webview` guard re-asserts it so an unset
 * partition can never silently drop the guest into the app's DEFAULT
 * session. The same guard scrubs any preload/node flags, exactly like
 * Electron's security guidance.
 *
 * @module dsh-plugin-desktop/agent-browser-window
 */

import { BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import {
  DESKTOP_AGENT_BROWSER_CLAIM_CHANNEL,
  DESKTOP_AGENT_BROWSER_CLOSE_CHANNEL,
  DESKTOP_AGENT_BROWSER_RELEASE_CHANNEL,
  DESKTOP_AGENT_BROWSER_STATE_CHANNEL,
  type AgentBrowserViewModel,
} from './agent-browser-contract.ts'
import type { AgentBrowserGuestWebContents, AgentBrowserWindowHost } from './agent-browser-session.ts'

// loadFile requires a physical file; pin to the unpacked mirror (dev paths
// pass through unchanged) — see startup-recovery-window.ts for the rationale.
// The vite input lives at native-ui/agent-browser/agent-browser.html, so the
// built document keeps that nested name and references ../assets/ relative.
const AGENT_BROWSER_DOCUMENT = unpackedAsarPath(
  fileURLToPath(new URL('./native-ui/agent-browser/agent-browser.html', import.meta.url)),
)
const AGENT_BROWSER_PRELOAD = unpackedAsarPath(
  fileURLToPath(new URL('./agent-browser-preload.cjs', import.meta.url)),
)

const AGENT_BROWSER_WIDTH = 1_120
const AGENT_BROWSER_HEIGHT = 760
const AGENT_BROWSER_MIN_WIDTH = 720
const AGENT_BROWSER_MIN_HEIGHT = 540
const GUEST_ATTACH_TIMEOUT_MS = 30_000

/** Options of {@link DesktopAgentBrowserWindowHost}. */
export interface AgentBrowserWindowHostOptions {
  /** One-shot guest partition token (design §5.2). */
  readonly partition: string
  /** Called once the window closed (user close button, OS, or programmatic). */
  readonly onWindowClosed?: () => void
  /** Error log sink; renderer diagnostics land here, never secrets. */
  readonly logError?: (message: string) => void
}

/** webContents event surface the embedder window uses (sso-gate precedent). */
export interface AgentBrowserEmbedderWebContents {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: 'console-message', listener: (details: { readonly level: string, readonly message: string }) => void): unknown
  on(event: 'render-process-gone', listener: (details: { readonly reason: string, readonly exitCode: number }) => void): unknown
  on(event: 'did-finish-load', listener: () => void): unknown
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown
  on(event: 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): unknown
  on(event: 'will-attach-webview', listener: (
    event: { preventDefault(): void },
    webPreferences: Record<string, unknown>,
    params: Record<string, string>,
  ) => void): unknown
  on(event: 'did-attach-webview', listener: (event: unknown, webContents: AgentBrowserGuestWebContents) => void): unknown
  send(channel: string, ...args: unknown[]): void
}

/**
 * Re-assert the guest partition and scrub unsafe preferences.
 *
 * Pure and exported so the P0 acceptance asserts it directly: an unset or
 * mismatched `<webview>` partition is rewritten to the host-minted token,
 * and preload/node capabilities are deleted instead of trusted.
 */
export function guardAgentBrowserWebviewAttachment(
  webPreferences: Record<string, unknown>,
  params: Record<string, string>,
  partition: string,
): void {
  webPreferences.partition = partition
  delete webPreferences.preload
  delete webPreferences.preloadURL
  delete webPreferences.preloadPath
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  // The guest embeds no further webviews (v1 has no tab dimension anyway).
  webPreferences.webviewTag = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  params.partition = partition
  params.allowpopups = 'false'
}

/**
 * BrowserWindow construction of the agent-browser embedder.
 *
 * Exactly the §1 preference set — `webviewTag` for the guest, isolation and
 * sandbox for the embedder, and deliberately NO window-level `partition`.
 */
export function agentBrowserWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    title: 'DSH Agent Browser',
    width: AGENT_BROWSER_WIDTH,
    height: AGENT_BROWSER_HEIGHT,
    minWidth: AGENT_BROWSER_MIN_WIDTH,
    minHeight: AGENT_BROWSER_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#202124',
    webPreferences: {
      preload: AGENT_BROWSER_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
    },
  }
}

/**
 * One agent-browser window host. `open()` resolves with the guest
 * webContents obtained from `did-attach-webview` — the subscription happens
 * BEFORE the document loads because the event fires while the `<webview>`
 * element is parsed (day-1 spike finding, 2026-09-03).
 */
export class DesktopAgentBrowserWindowHost implements AgentBrowserWindowHost {
  private window: BrowserWindow | undefined
  private latestState: AgentBrowserViewModel | undefined
  private closed = false
  private readonly partition: string

  constructor(private readonly options: AgentBrowserWindowHostOptions) {
    this.partition = options.partition
  }

  /** Open the window and resolve once the guest webContents attached. */
  async open(): Promise<AgentBrowserGuestWebContents> {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      throw new Error('dsh-plugin-desktop: the agent-browser window is already open')
    }
    const window = new BrowserWindow(agentBrowserWindowOptions())
    this.window = window
    this.closed = false
    window.accessibleTitle = 'DSH Agent Browser'
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    const embedder = window.webContents as unknown as AgentBrowserEmbedderWebContents
    const logError = this.options.logError
    if (logError !== undefined) {
      embedder.on('console-message', details => {
        logError(`dsh-plugin-desktop: agent browser renderer console (${details.level}): ${details.message}`)
      })
      embedder.on('render-process-gone', details => {
        logError(`dsh-plugin-desktop: agent browser renderer gone (reason: ${details.reason}, exitCode: ${String(details.exitCode)})`)
      })
    }
    // The embedder document never navigates: its only job is the toolbar and
    // the webview host, so every navigation is refused outright.
    embedder.on('will-navigate', (event, url) => {
      event.preventDefault()
      logError?.(`dsh-plugin-desktop: agent browser embedder navigation refused (${url})`)
    })
    embedder.on('will-redirect', (event, url) => {
      event.preventDefault()
      logError?.(`dsh-plugin-desktop: agent browser embedder redirect refused (${url})`)
    })
    // P0 guard: the partition belongs to the GUEST, re-asserted here.
    embedder.on('will-attach-webview', (event, webPreferences, params) => {
      void event
      guardAgentBrowserWebviewAttachment(webPreferences, params, this.partition)
    })

    const guest = await new Promise<AgentBrowserGuestWebContents>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('dsh-plugin-desktop: the agent-browser guest webContents did not attach'))
      }, GUEST_ATTACH_TIMEOUT_MS)
      embedder.on('did-attach-webview', (_event, webContents) => {
        clearTimeout(timer)
        resolve(webContents)
      })
      // The renderer mounts the <webview> only after the first view model
      // arrives, and the first push can precede its `onState` subscription —
      // so re-push the latest model when the document finishes loading.
      // This subscription must precede `loadFile`: the webview element is
      // created by the renderer script, so did-attach-webview can never fire
      // before the renderer learned the partition token.
      embedder.on('did-finish-load', () => { this.pushLatest() })
      void window.loadFile(AGENT_BROWSER_DOCUMENT).catch(cause => {
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      })
    })

    window.once('ready-to-show', () => {
      if (this.window === window && !window.isDestroyed()) window.show()
    })
    window.on('closed', () => {
      if (this.window === window) this.window = undefined
      this.finishClosed()
    })
    this.registerToolbarChannels()
    return guest
  }

  /** Toolbar→main channels; sender-checked against this window's renderer. */
  private registerToolbarChannels(): void {
    const isOwn = (sender: unknown): boolean => {
      const window = this.window
      return window !== undefined && !window.isDestroyed()
        && sender === (window.webContents as unknown)
    }
    const claim = (event: { sender: unknown }): void => {
      if (!isOwn(event.sender)) return
      // The claim state machine lands in B2; the channel contract is final.
    }
    const release = (event: { sender: unknown }): void => {
      if (!isOwn(event.sender)) return
    }
    const close = (event: { sender: unknown }): void => {
      if (!isOwn(event.sender)) return
      this.close()
    }
    ipcMain.on(DESKTOP_AGENT_BROWSER_CLAIM_CHANNEL, claim)
    ipcMain.on(DESKTOP_AGENT_BROWSER_RELEASE_CHANNEL, release)
    ipcMain.on(DESKTOP_AGENT_BROWSER_CLOSE_CHANNEL, close)
    this.channelDisposers = [
      () => { ipcMain.off(DESKTOP_AGENT_BROWSER_CLAIM_CHANNEL, claim) },
      () => { ipcMain.off(DESKTOP_AGENT_BROWSER_RELEASE_CHANNEL, release) },
      () => { ipcMain.off(DESKTOP_AGENT_BROWSER_CLOSE_CHANNEL, close) },
    ]
  }

  private channelDisposers: Array<() => void> = []

  /** Whether this window is gone. */
  isClosed(): boolean {
    return this.closed
  }

  /** Push one view-model snapshot into the window document. */
  pushState(state: AgentBrowserViewModel): void {
    this.latestState = state
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    window.webContents.send(DESKTOP_AGENT_BROWSER_STATE_CHANNEL, state)
  }

  private pushLatest(): void {
    if (this.latestState === undefined) return
    this.pushState(this.latestState)
  }

  /** Close the window (idempotent). */
  close(): void {
    const window = this.window
    this.window = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
    this.finishClosed()
  }

  private finishClosed(): void {
    for (const dispose of this.channelDisposers.splice(0)) dispose()
    if (this.closed) return
    this.closed = true
    this.options.onWindowClosed?.()
  }
}
