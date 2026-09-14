/**
 * Boot splash window (#035): the earliest visible face of a launch.
 *
 * Double-clicking the client (or accepting a plugin install's 「立即重启」
 * relaunch) enters a 4-12 s dead zone — SSO silent probe, shared Python,
 * boot verification, Host boot, shell load — during which no window exists
 * at all, and users read it as "nothing happened" and click again. This
 * module is a deliberately minimal answer: one small, sandboxed, static
 * document (wordmark + CSS spinner, no scripts, no preload) shown as close
 * to `app.whenReady()` as the boot allows and destroyed the moment the
 * first real surface (shell window, SSO gate, recovery window, Profile
 * creator) takes over the zone — {@link DesktopBootSplashWindow.dispose}
 * is wired into the same chain that retires the disclaimer loading surface.
 *
 * Two deliberate mechanics:
 *
 * - **Anti-flash** — a fast boot retires the splash before it ever shows:
 *   the window is created hidden and `showInactive()` fires only when BOTH
 *   the renderer has painted (`ready-to-show`) AND the
 *   {@link BOOT_SPLASH_MIN_LIFTOFF_MS} floor since creation has elapsed. A
 *   boot that reaches its first real surface inside the floor never calls
 *   show at all, so the user never sees a window blink in and out.
 * - **Never steals focus** — the reveal is `showInactive()`, not `show()`:
 *   a relaunch (installer restart) happens while the user may be elsewhere,
 *   and the OS foreground policy would only paint an orange taskbar button.
 *   `focusable: false` was considered and rejected: on Linux it stops the
 *   window interacting with the WM (always on top in all workspaces), and
 *   macOS keeps trying to focus such windows anyway (electron#29644). The
 *   explicit second-instance reveal ({@link show}) gives feedback without
 *   stealing focus while unrevealed (`showInactive`); once revealed it
 *   activates ({@link revealApplication}) — the user clicked the icon again
 *   and asked for us.
 *
 * @module dsh-plugin-desktop/boot-splash-window
 */

import { fileURLToPath } from 'node:url'
import { BrowserWindow } from 'electron'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import { nativeUiDocumentUrl } from './native-ui-document.ts'
import { formatDesktopExitCode } from './desktop-logger.ts'
import { revealApplication } from './electron-reveal.ts'

// loadFile requires a physical file; pin to the unpacked mirror (dev paths
// pass through unchanged) — see startup-recovery-window.ts for the rationale.
const SPLASH_DOCUMENT = unpackedAsarPath(fileURLToPath(new URL('./native-ui/splash.html', import.meta.url)))
const SPLASH_TITLE = '正在启动 DSH Desktop - Deloitte DSH Desktop'
const SPLASH_WIDTH = 480
const SPLASH_HEIGHT = 320

/**
 * The earliest the splash may appear, measured from window creation. The
 * document is tiny and static, so `ready-to-show` fires in tens of
 * milliseconds; this floor is what makes a fast boot window-silent — any
 * dispose inside the window races the timer and wins before a single
 * `showInactive()`.
 */
export const BOOT_SPLASH_MIN_LIFTOFF_MS = 300

/** webContents event surface the splash observes (structural subset of `Electron.WebContents`). */
export interface BootSplashWebContentsObserver {
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

/** One renderer-console line. */
export function bootSplashConsoleLine(level: string, message: string): string {
  return `dsh-plugin-desktop: boot splash window renderer console (${level}): ${message}`
}

/** One renderer-loss line (the legacy `crashed` event is deprecated in favor of this). */
export function bootSplashRendererGoneLine(reason: string, exitCode: number): string {
  return `dsh-plugin-desktop: boot splash window render process gone (reason: ${reason}, exitCode: ${formatDesktopExitCode(exitCode)})`
}

/** Only the file name of a failing load; the URL never carries state, but keep logs lean. */
function bootSplashLoadFileName(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(part => part.length > 0).pop() ?? 'unknown'
  } catch {
    return 'unparsed'
  }
}

/** One failed-load line; `url` is reduced to its file name. */
export function bootSplashLoadFailedLine(
  errorCode: number,
  errorDescription: string,
  url: string,
  isMainFrame: boolean,
): string {
  return `dsh-plugin-desktop: boot splash window failed to load (${String(errorCode)}: ${errorDescription}, file: ${bootSplashLoadFileName(url)}, mainFrame: ${isMainFrame ? 'yes' : 'no'})`
}

/** One unresponsive-renderer line. */
export function bootSplashUnresponsiveLine(): string {
  return 'dsh-plugin-desktop: boot splash window renderer unresponsive'
}

/**
 * Make the splash observable (the sso gate/disclaimer issue #36 surface):
 * renderer console output, renderer-process loss, failed loads, and hangs
 * each land in the log sink under the greppable `dsh-plugin-desktop: boot
 * splash window …` prefix. A DOA splash is exactly the class of
 * real-machine bug the dead zone hid (#035's motivation), so the same
 * four-event visibility rides along.
 */
export function attachBootSplashWindowObservability(
  webContents: BootSplashWebContentsObserver,
  logError: (message: string) => void,
): void {
  webContents.on('console-message', details => {
    logError(bootSplashConsoleLine(details.level, details.message))
  })
  webContents.on('render-process-gone', (_event, details) => {
    logError(bootSplashRendererGoneLine(details.reason, details.exitCode))
  })
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    logError(bootSplashLoadFailedLine(errorCode, errorDescription, validatedUrl, isMainFrame))
  })
  webContents.on('unresponsive', () => {
    logError(bootSplashUnresponsiveLine())
  })
}

export interface DesktopBootSplashWindowOptions {
  /** Log sink for renderer-loss/failed-load lines; errors only. */
  readonly logError?: (message: string) => void
}

/**
 * One boot splash window. {@link open} creates the hidden window and starts
 * the anti-flash gate; {@link dispose} retires it (idempotent, and a no-op
 * after the user closed it themselves); {@link show} is the explicit
 * second-instance reveal. The splash carries no transport — there is no
 * preload and nothing to decide, so a compromised renderer has no channel
 * beyond painting its own static document.
 */
export class DesktopBootSplashWindow {
  private window: BrowserWindow | undefined
  private revealTimer: NodeJS.Timeout | undefined
  /** `ready-to-show` fired: the document has painted. */
  private readyToReveal = false
  /** The {@link BOOT_SPLASH_MIN_LIFTOFF_MS} floor elapsed since creation. */
  private liftoffReached = false
  /** An explicit reveal ({@link show}) lifted the floor early. */
  private forced = false
  private revealed = false
  private disposed = false

  constructor(private readonly options: DesktopBootSplashWindowOptions = {}) {}

  /** Whether a live window is still attached (false once disposed or closed). */
  get alive(): boolean {
    const window = this.window
    return window !== undefined && !window.isDestroyed()
  }

  /**
   * Create the hidden splash window and load the static document. A failed
   * load cleans the window up and rethrows — the caller logs and drops the
   * surface; the boot never depends on the splash.
   */
  async open(): Promise<void> {
    if (this.disposed || this.window !== undefined) return
    const window = new BrowserWindow({
      title: SPLASH_TITLE,
      width: SPLASH_WIDTH,
      height: SPLASH_HEIGHT,
      resizable: false,
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
        // A dedicated in-memory partition: the splash shares nothing with
        // the SSO gate, disclaimer, or agent-browser sessions (there is no
        // preload, so nothing could ride one anyway — this is hardening by
        // isolation, matching the disclaimer/recovery window shape).
        partition: 'dsh-boot-splash',
      },
    })
    this.window = window
    window.accessibleTitle = SPLASH_TITLE
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    // Navigation belt (matches startup-recovery-window): the static document
    // has no links, but a drag-dropped file must not navigate this window.
    window.webContents.on('will-navigate', event => { event.preventDefault() })
    if (this.options.logError !== undefined) {
      attachBootSplashWindowObservability(window.webContents, this.options.logError)
    }
    // The anti-flash gate: show only when painted AND past the floor (or
    // explicitly forced). Whichever signal arrives second triggers the
    // reveal; a dispose before either leaves `showInactive` uncalled.
    window.once('ready-to-show', () => {
      this.readyToReveal = true
      this.maybeReveal()
    })
    window.on('closed', () => { this.release(window) })
    this.revealTimer = setTimeout(() => {
      this.revealTimer = undefined
      this.liftoffReached = true
      this.maybeReveal()
    }, BOOT_SPLASH_MIN_LIFTOFF_MS)
    try {
      await window.loadURL(nativeUiDocumentUrl(SPLASH_DOCUMENT))
    } catch (cause) {
      this.release(window)
      if (!window.isDestroyed()) window.destroy()
      throw cause
    }
  }

  /**
   * Explicit reveal (second-instance: the user clicked the app again).
   * Lifts the liftoff floor — the wait already happened — brings an
   * on-screen window to the front (the disclaimer window's `show` shape),
   * and is a plain no-op on a dead window (the caller decides whether to
   * re-create).
   */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    this.forced = true
    if (this.revealed) {
      revealApplication(window)
      return
    }
    this.maybeReveal()
  }

  /**
   * Retire the splash: cancel the pending reveal, destroy the window.
   * Idempotent, and safe after the user closed it themselves (the `closed`
   * cleanup already released the window, so this is a plain no-op).
   */
  dispose(): void {
    this.disposed = true
    if (this.revealTimer !== undefined) {
      clearTimeout(this.revealTimer)
      this.revealTimer = undefined
    }
    const window = this.window
    this.window = undefined
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }

  private maybeReveal(): void {
    if (this.disposed || this.revealed) return
    if (!this.readyToReveal) return
    if (!this.liftoffReached && !this.forced) return
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    this.revealed = true
    // Never steal focus (see the module doc): showInactive paints the window
    // without activating, exactly what a boot-time splash owes the user.
    window.showInactive()
  }

  /** `closed` (user X or a failed-load destroy): release the window and the timer. */
  private release(window: BrowserWindow): void {
    if (this.window !== window) return
    this.window = undefined
    if (this.revealTimer !== undefined) {
      clearTimeout(this.revealTimer)
      this.revealTimer = undefined
    }
  }
}

export default DesktopBootSplashWindow
