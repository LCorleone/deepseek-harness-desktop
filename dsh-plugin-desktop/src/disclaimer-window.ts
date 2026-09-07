/**
 * Disclaimer window host: the native surface the beta disclaimer gate
 * (`disclaimer-gate.ts`) opens when {@link needsDisclaimer} says this boot
 * must ask.
 *
 * The window is the SSO gate's shape (see `sso-gate-window.ts`): a sandboxed
 * BrowserWindow loading a local, script-isolated document from the unpacked
 * native-ui mirror, navigation pinned to one custom scheme, one view-model
 * rendered from the main process — but its state machine is a single
 * two-way decision. The renderer offers exactly 「不同意」 and 「同意」; each
 * settles `run()` immediately, and closing the window settles as a refusal
 * (not agreeing is the refusal — the same stance the SSO gate takes for a
 * close). The statement copy itself travels in the view model, so the
 * displayed text and the acknowledged hash are the same bytes by
 * construction.
 *
 * @module dsh-plugin-desktop/disclaimer-window
 */

import { fileURLToPath } from 'node:url'
import { BrowserWindow, app, ipcMain } from 'electron'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import { formatDesktopExitCode } from './desktop-logger.ts'
import { DISCLAIMER_ITEMS, DISCLAIMER_TITLE } from './disclaimer-text.ts'
import { applicationNeedsReveal, revealApplication } from './electron-reveal.ts'
import { DESKTOP_DISCLAIMER_DECIDE_CHANNEL } from './disclaimer-preload.ts'

const DISCLAIMER_SCHEME = 'dsh-disclaimer:'
// loadFile requires a physical file; pin to the unpacked mirror (dev paths
// pass through unchanged) — see startup-recovery-window.ts for the rationale.
const DISCLAIMER_DOCUMENT = unpackedAsarPath(fileURLToPath(new URL('./native-ui/disclaimer.html', import.meta.url)))
const DISCLAIMER_WIDTH = 680
const DISCLAIMER_HEIGHT = 640

/** View-model serialized into the local document's query state. */
export interface DisclaimerViewModel {
  readonly title: string
  readonly items: readonly string[]
}

/** Outcome of {@link DesktopDisclaimerWindow.run}: the user's decision. */
export type DisclaimerResult = 'agree' | 'disagree'

/** webContents event surface the window observes (structural subset of `Electron.WebContents`). */
export interface DisclaimerWebContentsObserver {
  on(event: 'console-message', listener: (details: { readonly level: string, readonly message: string }) => void): unknown
  on(event: 'render-process-gone', listener: (
    event: unknown,
    details: { readonly reason: string, readonly exitCode: number },
  ) => void): unknown
  on(event: 'did-fail-load', listener: (
    event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean,
  ) => void): unknown
  on(event: 'unresponsive', listener: () => void): unknown
}

/** One renderer-console line; a failed React render leaves its stack here. */
export function disclaimerConsoleLine(level: string, message: string): string {
  return `dsh-plugin-desktop: disclaimer window renderer console (${level}): ${message}`
}

/** One renderer-loss line (the legacy `crashed` event is deprecated in favor of this). */
export function disclaimerRendererGoneLine(reason: string, exitCode: number): string {
  return `dsh-plugin-desktop: disclaimer window render process gone (reason: ${reason}, exitCode: ${formatDesktopExitCode(exitCode)})`
}

/** Only the file name of a failing load: the query carries the base64 state and stays out of logs. */
function disclaimerLoadFileName(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(part => part.length > 0).pop() ?? 'unknown'
  } catch {
    return 'unparsed'
  }
}

/** One failed-load line; `url` is reduced to its file name. */
export function disclaimerLoadFailedLine(
  errorCode: number,
  errorDescription: string,
  url: string,
  isMainFrame: boolean,
): string {
  return `dsh-plugin-desktop: disclaimer window failed to load (${String(errorCode)}: ${errorDescription}, file: ${disclaimerLoadFileName(url)}, mainFrame: ${isMainFrame ? 'yes' : 'no'})`
}

/** One unresponsive-renderer line. */
export function disclaimerUnresponsiveLine(): string {
  return 'dsh-plugin-desktop: disclaimer window renderer unresponsive'
}

/**
 * Make the disclaimer window observable (the sso gate's issue #36 surface):
 * renderer console output, renderer-process loss, failed loads, and hangs
 * each land in the log sink under the greppable `dsh-plugin-desktop:
 * disclaimer window …` prefix. Everything passes the caller's sink, which
 * masks secrets; the state query is never logged raw (loads record their
 * file name only).
 */
export function attachDisclaimerWindowObservability(
  webContents: DisclaimerWebContentsObserver,
  logError: (message: string) => void,
): void {
  webContents.on('console-message', details => {
    logError(disclaimerConsoleLine(details.level, details.message))
  })
  webContents.on('render-process-gone', (_event, details) => {
    logError(disclaimerRendererGoneLine(details.reason, details.exitCode))
  })
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    logError(disclaimerLoadFailedLine(errorCode, errorDescription, validatedUrl, isMainFrame))
  })
  webContents.on('unresponsive', () => {
    logError(disclaimerUnresponsiveLine())
  })
}

/** Parsed renderer action; `agree`/`disagree` are the only navigations this document generates. */
export function parseDisclaimerAction(href: string): { readonly action: 'agree' | 'disagree' } | undefined {
  let url: URL
  try { url = new URL(href) } catch { return undefined }
  if (url.protocol !== DISCLAIMER_SCHEME
    || url.username !== '' || url.password !== '' || url.port !== ''
    || url.pathname !== '' || url.hash !== '' || url.search.length > 0) return undefined
  return url.hostname === 'agree' || url.hostname === 'disagree'
    ? { action: url.hostname }
    : undefined
}

export interface DesktopDisclaimerWindowOptions {
  /** Log sink for window transitions; errors only, never the statement query. */
  readonly logError?: (message: string) => void
}

/**
 * One native disclaimer window. `run()` resolves when the user picks
 * 「同意」 (`agree`) or 「不同意」/closes the window (`disagree` — a close is
 * the same refusal), and the window is destroyed on every settlement.
 */
export class DesktopDisclaimerWindow {
  private window: BrowserWindow | undefined
  private resolveResult: ((result: DisclaimerResult) => void) | undefined
  private settled = false

  constructor(private readonly options: DesktopDisclaimerWindowOptions = {}) {}

  /** Open the window, render the statement once, and settle on the decision. */
  async run(): Promise<DisclaimerResult> {
    const result = new Promise<DisclaimerResult>(resolve => { this.resolveResult = resolve })
    const window = new BrowserWindow({
      title: `${DISCLAIMER_TITLE} - Deloitte DSH Desktop`,
      width: DISCLAIMER_WIDTH,
      height: DISCLAIMER_HEIGHT,
      minWidth: 520,
      minHeight: 480,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#202124',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        partition: 'dsh-disclaimer',
        // The v1 scheme-anchor transport is dead in packaged sandboxed
        // renderers (external-protocol swallow, #63 finding); decisions ride
        // this preload's IPC send instead.
        preload: fileURLToPath(new URL('./disclaimer-preload.cjs', import.meta.url)),
      },
    })
    this.window = window
    if (this.options.logError !== undefined) {
      attachDisclaimerWindowObservability(window.webContents, this.options.logError)
    }
    window.accessibleTitle = `${DISCLAIMER_TITLE} - Deloitte DSH Desktop`
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    const navigate = (event: Electron.Event, href: string): void => {
      const action = parseDisclaimerAction(href)
      event.preventDefault()
      if (action !== undefined) this.finish(action.action)
    }
    window.webContents.on('will-navigate', navigate)
    window.webContents.on('will-redirect', navigate)
    // Deterministic decision transport (see the preload comment above). The
    // sender is pinned to THIS window's webContents so a stray same-partition
    // document cannot decide on its behalf.
    // Captured at registration: between finish() → destroy() and the
    // 'closed' cleanup, an in-flight duplicate IPC would touch a destroyed
    // window's webContents otherwise.
    const wcId = window.webContents.id
    const decide = (event: Electron.IpcMainEvent, action: unknown): void => {
      if (event.sender.id !== wcId) return
      if (action !== 'agree' && action !== 'disagree') return
      this.finish(action)
    }
    ipcMain.on(DESKTOP_DISCLAIMER_DECIDE_CHANNEL, decide)
    const activate = (): void => {
      if (applicationNeedsReveal(window)) revealApplication(window)
    }
    app.on('activate', activate)
    if (process.platform === 'darwin') app.on('did-become-active', activate)
    window.once('ready-to-show', () => { revealApplication(window) })
    window.on('closed', () => {
      ipcMain.removeListener(DESKTOP_DISCLAIMER_DECIDE_CHANNEL, decide)
      app.off('activate', activate)
      if (process.platform === 'darwin') app.off('did-become-active', activate)
      this.window = undefined
      // Closing without agreeing is the refusal — the same stance the SSO
      // gate takes for a close: nothing else has booted yet, so the caller
      // treats it exactly like 「不同意」.
      this.finish('disagree')
    })
    const model: DisclaimerViewModel = { title: DISCLAIMER_TITLE, items: DISCLAIMER_ITEMS }
    const state = Buffer.from(JSON.stringify(model), 'utf8').toString('base64url')
    await window.loadFile(DISCLAIMER_DOCUMENT, { query: { state } })
    return await result
  }

  /** Bring an already open disclaimer window to the foreground (second-instance handling). */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    revealApplication(window)
  }

  private finish(result: DisclaimerResult): void {
    if (this.settled) return
    this.settled = true
    const window = this.window
    this.window = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
    this.resolveResult?.(result)
    this.resolveResult = undefined
  }
}

export default DesktopDisclaimerWindow
