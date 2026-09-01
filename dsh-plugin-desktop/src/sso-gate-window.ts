/**
 * SSO startup gate window: the local, no-network sign-in surface a locked
 * `requireSso` build opens when the silent OS-identity handshake fails.
 *
 * The window reuses the startup-recovery window's shape — a sandboxed
 * BrowserWindow loading a local, script-isolated document from the unpacked
 * native-ui mirror, navigation pinned to one custom scheme, and a view-model
 * re-rendered from the main process — but its state machine is the gate's:
 * the renderer offers exactly one action (`sign-in`), which starts the
 * browser loopback login, and the window settles only when that login
 * succeeds (the launcher then closes the gate and continues the normal boot)
 * or the user closes the window (the application exits; no Host boot, window,
 * market, or CLI surface has started yet, so closing the gate is a full
 * refusal with nothing left unlocked behind it).
 *
 * @module dsh-plugin-desktop/sso-gate-window
 */

import { BrowserWindow, app } from 'electron'
import { fileURLToPath } from 'node:url'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import { formatDesktopExitCode } from './desktop-logger.ts'
import type { DesktopLocale } from './runtime.ts'
import { applicationNeedsReveal, revealApplication } from './electron-reveal.ts'

const SSO_GATE_SCHEME = 'dsh-sso-gate:'
// loadFile requires a physical file; pin to the unpacked mirror (dev paths
// pass through unchanged) — see startup-recovery-window.ts for the rationale.
const SSO_GATE_DOCUMENT = unpackedAsarPath(fileURLToPath(new URL('./native-ui/sso-gate.html', import.meta.url)))
const MAX_ERROR_DETAIL_LENGTH = 2_000
const GATE_WIDTH = 560
const GATE_HEIGHT = 480

/** Renderer phase driven entirely by main-process re-renders. */
type SsoGatePhase = 'ready' | 'waiting' | 'authenticated'

/** View-model serialized into the local document's query state. */
export interface SsoGateViewModel {
  readonly locale: DesktopLocale
  readonly phase: SsoGatePhase
  readonly errorDetail?: string
}

/** Outcome of {@link DesktopSsoGateWindow.run}: authenticated, or the user closed the gate. */
export type SsoGateResult = 'authenticated' | 'quit'

/** webContents event surface the gate observes (structural subset of `Electron.WebContents`). */
export interface SsoGateWebContentsObserver {
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
export function ssoGateConsoleLine(level: string, message: string): string {
  return `dsh-plugin-desktop: sso gate renderer console (${level}): ${message}`
}

/** One renderer-loss line (the legacy `crashed` event is deprecated in favor of this). */
export function ssoGateRendererGoneLine(reason: string, exitCode: number): string {
  return `dsh-plugin-desktop: sso gate render process gone (reason: ${reason}, exitCode: ${formatDesktopExitCode(exitCode)})`
}

/** Only the file name of a failing load: the query carries the base64 state and stays out of logs. */
function ssoGateLoadFileName(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(part => part.length > 0).pop() ?? 'unknown'
  } catch {
    return 'unparsed'
  }
}

/** One failed-load line; `url` is reduced to its file name. */
export function ssoGateLoadFailedLine(
  errorCode: number,
  errorDescription: string,
  url: string,
  isMainFrame: boolean,
): string {
  return `dsh-plugin-desktop: sso gate failed to load (${String(errorCode)}: ${errorDescription}, file: ${ssoGateLoadFileName(url)}, mainFrame: ${isMainFrame ? 'yes' : 'no'})`
}

/** One unresponsive-renderer line. */
export function ssoGateUnresponsiveLine(): string {
  return 'dsh-plugin-desktop: sso gate renderer unresponsive'
}

/**
 * Make the gate window observable (issue #36): renderer console output,
 * renderer-process loss, failed loads, and hangs each land in the log sink
 * under the greppable `dsh-plugin-desktop: sso gate …` prefix. Everything
 * passes the caller's sink, which masks secrets; the state query is never
 * logged raw (loads record their file name only), while `errorDetail` text
 * is loggable by design.
 */
export function attachSsoGateWindowObservability(
  webContents: SsoGateWebContentsObserver,
  logError: (message: string) => void,
): void {
  webContents.on('console-message', details => {
    logError(ssoGateConsoleLine(details.level, details.message))
  })
  webContents.on('render-process-gone', (_event, details) => {
    logError(ssoGateRendererGoneLine(details.reason, details.exitCode))
  })
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    logError(ssoGateLoadFailedLine(errorCode, errorDescription, validatedUrl, isMainFrame))
  })
  webContents.on('unresponsive', () => {
    logError(ssoGateUnresponsiveLine())
  })
}

/** Parsed renderer action; `sign-in` is the only navigation this document generates. */
export function parseSsoGateAction(href: string): { readonly action: 'sign-in' } | undefined {
  let url: URL
  try { url = new URL(href) } catch { return undefined }
  if (url.protocol !== SSO_GATE_SCHEME
    || url.username !== '' || url.password !== '' || url.port !== ''
    || url.pathname !== '' || url.hash !== '' || url.search.length > 0) return undefined
  return url.hostname === 'sign-in' ? { action: 'sign-in' } : undefined
}

export interface DesktopSsoGateWindowOptions {
  readonly locale: DesktopLocale
  /** Why the silent path did not authenticate (masked before it reaches here). */
  readonly silentFailureDetail: string
  /** Run one browser loopback login each time the user presses the button. */
  readonly startBrowserLogin: () => Promise<{ readonly ok: true } | { readonly ok: false, readonly reason: string }>
  /** Log sink for gate transitions; errors only, never tokens. */
  readonly logError?: (message: string) => void
}

/**
 * One native SSO gate window. `run()` resolves when the browser login
 * succeeds (`authenticated`) or the window closes (`quit`); repeated sign-in
 * attempts re-run the browser flow, surfacing each failure in the error area.
 */
export class DesktopSsoGateWindow {
  private window: BrowserWindow | undefined
  private phase: SsoGatePhase = 'ready'
  private errorDetail: string
  private busy = false
  private resolveResult: ((result: SsoGateResult) => void) | undefined
  private settled = false

  constructor(private readonly options: DesktopSsoGateWindowOptions) {
    this.errorDetail = options.silentFailureDetail.slice(0, MAX_ERROR_DETAIL_LENGTH)
  }

  /** Open the gate and settle on authentication or window close. */
  async run(): Promise<SsoGateResult> {
    const result = new Promise<SsoGateResult>(resolve => { this.resolveResult = resolve })
    const window = new BrowserWindow({
      title: this.options.locale === 'zh' ? 'Deloitte DSH Desktop 登录' : 'Deloitte DSH Desktop Sign In',
      width: GATE_WIDTH,
      height: GATE_HEIGHT,
      minWidth: 480,
      minHeight: 400,
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
        partition: 'dsh-sso-gate',
      },
    })
    this.window = window
    if (this.options.logError !== undefined) {
      attachSsoGateWindowObservability(window.webContents, this.options.logError)
    }
    window.accessibleTitle = this.options.locale === 'zh'
      ? 'Deloitte DSH Desktop 登录'
      : 'Deloitte DSH Desktop Sign In'
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    const navigate = (event: Electron.Event, href: string): void => {
      const action = parseSsoGateAction(href)
      event.preventDefault()
      if (action !== undefined) void this.handleAction()
    }
    window.webContents.on('will-navigate', navigate)
    window.webContents.on('will-redirect', navigate)
    const activate = (): void => {
      if (applicationNeedsReveal(window)) revealApplication(window)
    }
    app.on('activate', activate)
    if (process.platform === 'darwin') app.on('did-become-active', activate)
    window.once('ready-to-show', () => { revealApplication(window) })
    window.on('closed', () => {
      app.off('activate', activate)
      if (process.platform === 'darwin') app.off('did-become-active', activate)
      this.window = undefined
      // Closing the gate is a full refusal: the host has not booted, so the
      // launcher exits the application instead of continuing.
      this.finish('quit')
    })
    await this.render()
    return await result
  }

  /** Bring an already open gate to the foreground (second-instance handling). */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    revealApplication(window)
  }

  private async handleAction(): Promise<void> {
    if (this.busy || this.settled) return
    this.busy = true
    this.phase = 'waiting'
    await this.render()
    let outcome: { readonly ok: true } | { readonly ok: false, readonly reason: string }
    try {
      outcome = await this.options.startBrowserLogin()
    } catch (cause) {
      outcome = { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
    }
    this.busy = false
    if (outcome.ok) {
      this.phase = 'authenticated'
      this.errorDetail = ''
      await this.render()
      this.finish('authenticated')
      return
    }
    this.phase = 'ready'
    this.errorDetail = outcome.reason.slice(0, MAX_ERROR_DETAIL_LENGTH)
    await this.render()
  }

  private async render(): Promise<void> {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    const model: SsoGateViewModel = {
      locale: this.options.locale,
      phase: this.phase,
      ...(this.errorDetail.length === 0 ? {} : { errorDetail: this.errorDetail }),
    }
    const state = Buffer.from(JSON.stringify(model), 'utf8').toString('base64url')
    await window.loadFile(SSO_GATE_DOCUMENT, { query: { state } })
  }

  private finish(result: SsoGateResult): void {
    if (this.settled) return
    this.settled = true
    const window = this.window
    this.window = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
    this.resolveResult?.(result)
    this.resolveResult = undefined
  }
}

export default DesktopSsoGateWindow
