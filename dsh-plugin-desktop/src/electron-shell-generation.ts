import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray,
} from 'electron'
import { formatDesktopExitCode } from './desktop-logger.ts'
import { applicationNeedsReveal, revealApplication } from './electron-reveal.ts'
import type { ElectronPlatformStrategy } from './electron-platform.ts'
import type { DesktopNotification, DesktopShellSpec } from './runtime.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import { desktopWindowOptions } from './window-options.ts'
import type { DesktopRestartConfirmationCopy } from './tray-locale.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { DesktopRendererRecovery } from './renderer-recovery.ts'

const MIN_ZOOM_LEVEL = -4
const MAX_ZOOM_LEVEL = 4

function clampedZoomLevel(level: number): number {
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level))
}

function isZoomShortcut(input: Electron.Input): 'in' | 'out' | 'reset' | undefined {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return undefined
  if (input.key === '+' || input.key === '=') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return undefined
}

export interface ElectronShellGenerationOptions {
  readonly platform: ElectronPlatformStrategy
  readonly spec: DesktopShellSpec
  readonly preloadPath: string
  readonly buildApplicationMenuItems: () => readonly Electron.MenuItemConstructorOptions[]
  readonly isQuitting: () => boolean
  /** UI-language preference (the tray-locale pattern): the close-confirmation
   * dialog follows the app's chosen locale, not the raw OS locale. */
  readonly getLocale: () => string
  readonly buildTrayTemplate: () => Electron.MenuItemConstructorOptions[]
  readonly stopRendererBootMonitoring: () => void
  readonly abortRendererBootMonitoring: (cause: unknown) => void
  readonly failRendererBoot: (error: string) => void
  readonly canRecoverRenderer: () => boolean
  readonly rendererRecoveryCopy: () => DesktopRestartConfirmationCopy
  readonly logError: (message: string) => void
}

/** Locale-picked close-confirmation dialog copy (zh/en, the tray-locale pattern). */
const SHELL_CLOSE_CONFIRM = {
  zh: { message: '确定要退出 DSH Desktop 吗？', detail: '退出后正在运行的任务将终止。', buttons: ['取消', '退出'] },
  en: { message: 'Quit DSH Desktop?', detail: 'Running tasks will be terminated.', buttons: ['Cancel', 'Quit'] },
} as const

/**
 * The close decision, extracted for tests: a quitting app lets the close
 * through; otherwise the window is held and a confirmation dialog decides
 * whether to run the graceful quit.
 */
export function requestShellWindowClose(
  event: { preventDefault(): void },
  options: {
    isQuitting(): boolean
    beginConfirm(): void
    endConfirm(): void
    confirmClose(): Promise<boolean>
    quit(): void
  },
): void {
  if (options.isQuitting()) return
  event.preventDefault()
  options.beginConfirm()
  void options.confirmClose().then(
    confirmed => { options.endConfirm(); if (confirmed) options.quit() },
    () => { options.endConfirm() },
  )
}

/** One native close confirmation; true = quit. */
async function confirmShellWindowClose(window: BrowserWindow, localeTag: string): Promise<boolean> {
  const copy = localeTag.toLowerCase().startsWith('zh') ? SHELL_CLOSE_CONFIRM.zh : SHELL_CLOSE_CONFIRM.en
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: [...copy.buttons],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: copy.message,
    message: copy.message,
    detail: copy.detail,
  })
  return response === 1
}

/** Own one BrowserWindow and Tray generation, including every native listener. */
export class ElectronShellGeneration {
  private window: BrowserWindow | undefined
  private closeConfirmPending = false
  private tray: Tray | undefined
  private mounted = false
  private released = false
  private attentionCount = 0
  private cleanupListeners: (() => void) | undefined
  private readonly rendererRecovery: DesktopRendererRecovery
  private rendererRecoveryPending = false

  constructor(private readonly options: ElectronShellGenerationOptions) {
    this.rendererRecovery = new DesktopRendererRecovery({
      available: () => !this.released && !this.options.isQuitting()
        && this.window !== undefined && !this.window.isDestroyed(),
      reload: () => { this.reloadRenderer() },
      exhausted: () => { void this.offerRendererRecovery() },
      log: message => { this.options.logError(`dsh-plugin-desktop: ${message}`) },
    })
  }

  async mount(beforeInteractive?: () => void): Promise<void> {
    if (this.mounted || this.window !== undefined) {
      throw new Error('dsh-plugin-desktop: native shell generation is already mounted')
    }

    const { platform, spec } = this.options
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    platform.configureApplication(icon, spec.productName, this.options.buildApplicationMenuItems())
    const origin = new URL(spec.url).origin
    if (spec.mode === 'advanced') nativeTheme.themeSource = spec.readThemeSource()
    const window = new BrowserWindow(desktopWindowOptions(spec, icon, platform.platform, this.options.preloadPath))
    window.accessibleTitle = spec.windowTitle
    platform.configureWindow(window)
    this.window = window

    const show = (): void => { this.show() }
    const activate = (): void => {
      if (applicationNeedsReveal(window, platform.platform)) this.show()
    }
    const clearAttention = (): void => { this.clearAttention() }
    const close = (event: Electron.Event): void => {
      // X quits (2026-09-07): the fleet build no longer hides to tray — a
      // confirmation dialog decides, and 退出 runs the same graceful quit
      // path as the tray's exit item (app.quit -> before-quit teardown).
      if (this.closeConfirmPending) { event.preventDefault(); return }
      requestShellWindowClose(event, {
        isQuitting: this.options.isQuitting,
        beginConfirm: () => { this.closeConfirmPending = true },
        endConfirm: () => { this.closeConfirmPending = false },
        confirmClose: () => confirmShellWindowClose(window, this.options.getLocale()),
        quit: () => { app.quit() },
      })
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const handleZoomShortcut = (event: Electron.Event, input: Electron.Input): void => {
      const action = isZoomShortcut(input)
      if (action === undefined) return
      event.preventDefault()
      if (action === 'reset') {
        window.webContents.setZoomLevel(0)
        return
      }
      const step = action === 'in' ? 1 : -1
      window.webContents.setZoomLevel(clampedZoomLevel(window.webContents.getZoomLevel() + step))
    }
    const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>): void => {
      if (!event.isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const redirect = (
      event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }
    const rendererGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      const detail = `renderer process gone (reason: ${details.reason}, exitCode: ${formatDesktopExitCode(details.exitCode)})`
      this.options.logError(`dsh-plugin-desktop: ${detail}`)
      this.options.failRendererBoot(detail)
      if (details.reason !== 'clean-exit' && details.reason !== 'killed'
        && this.options.canRecoverRenderer()) {
        this.rendererRecovery.fail(detail)
      }
    }
    const loadFailed = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      this.options.logError(`dsh-plugin-desktop: renderer failed to load (${errorCode}: ${errorDescription})`)
      if (isMainFrame === true && errorCode !== -3) {
        this.options.failRendererBoot(
          `renderer main frame failed to load (${String(errorCode)}: ${errorDescription})`,
        )
        if (this.options.canRecoverRenderer()) {
          this.rendererRecovery.fail(`renderer main frame failed to load (${String(errorCode)}: ${errorDescription})`)
        }
      }
    }
    const loaded = (): void => { this.rendererRecovery.loaded() }

    app.on('activate', activate)
    if (platform.platform === 'darwin') app.on('did-become-active', activate)
    window.on('close', close)
    window.on('focus', clearAttention)
    window.on('page-title-updated', preserveBlankTitle)
    window.webContents.on('before-input-event', handleZoomShortcut)
    window.webContents.on('will-frame-navigate', navigate)
    window.webContents.on('will-redirect', redirect)
    window.webContents.on('render-process-gone', rendererGone)
    window.webContents.on('did-fail-load', loadFailed)
    window.webContents.on('did-finish-load', loaded)
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            this.options.logError(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })
    window.once('ready-to-show', show)
    let tray: Tray | undefined
    this.cleanupListeners = () => {
      app.off('activate', activate)
      if (platform.platform === 'darwin') app.off('did-become-active', activate)
      window.off('close', close)
      window.off('focus', clearAttention)
      window.off('page-title-updated', preserveBlankTitle)
      window.off('ready-to-show', show)
      window.webContents.off('before-input-event', handleZoomShortcut)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', redirect)
      window.webContents.off('render-process-gone', rendererGone)
      window.webContents.off('did-fail-load', loadFailed)
      window.webContents.off('did-finish-load', loaded)
      tray?.off('click', show)
    }

    try {
      await window.loadURL(spec.url)
      tray = new Tray(prepareTrayIcon(spec.trayIcons, platform.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.refreshTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
      this.mounted = true
    } catch (cause) {
      this.options.abortRendererBootMonitoring(cause)
      await this.release()
      throw cause
    }
  }

  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    this.clearAttention()
    revealApplication(window, this.options.platform.platform)
    if (this.rendererRecovery.exhausted) void this.offerRendererRecovery()
  }

  reportRendererRecovery(report: RendererBootReport): void {
    this.rendererRecovery.report(report)
  }

  stopRendererRecovery(): void {
    this.rendererRecovery.stop()
  }

  private async offerRendererRecovery(): Promise<void> {
    const window = this.window
    if (this.rendererRecoveryPending || this.released || this.options.isQuitting()
      || window === undefined || window.isDestroyed() || !this.rendererRecovery.exhausted) return
    this.rendererRecoveryPending = true
    try {
      this.show()
      const copy = this.options.rendererRecoveryCopy()
      const result = await dialog.showMessageBox(window, {
        type: 'warning',
        title: copy.title,
        message: copy.message,
        detail: `${copy.detail}\n\n${this.rendererRecovery.detail}`,
        buttons: [copy.confirm, copy.cancel],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      if (result.response !== 0 || this.released || this.options.isQuitting()
        || this.window !== window || window.isDestroyed()) return
      this.rendererRecovery.retry()
    } catch (cause) {
      this.options.logError(`dsh-plugin-desktop: renderer recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      this.rendererRecoveryPending = false
    }
  }

  /** Reload the active renderer without permitting arbitrary renderer commands. */
  reloadRenderer(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) {
      throw new Error('dsh-plugin-desktop: renderer reload requires a mounted window')
    }
    window.webContents.reloadIgnoringCache()
  }

  notifyAttention(notification: DesktopNotification): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || window.isFocused()) return

    this.attentionCount += 1
    if (this.options.platform.platform === 'win32') window.flashFrame(true)
    else app.setBadgeCount(this.attentionCount)

    if (!Notification.isSupported()) return
    const nativeNotification = new Notification(notification)
    nativeNotification.once('click', () => { this.show() })
    nativeNotification.show()
  }

  async showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    const window = this.window
    return window === undefined || window.isDestroyed()
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options)
  }

  refreshTrayMenu(): void {
    if (this.tray === undefined) return
    this.tray.setContextMenu(Menu.buildFromTemplate(this.options.buildTrayTemplate()))
  }

  refreshThemeMaterial(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) this.options.platform.refreshThemeMaterial(this.window)
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.rendererRecovery.stop()
    this.options.stopRendererBootMonitoring()

    const window = this.window
    const tray = this.tray
    this.clearAttention()
    this.window = undefined
    this.tray = undefined
    if (window === undefined) return

    this.cleanupListeners?.()
    this.cleanupListeners = undefined
    tray?.destroy()
    if (!window.isDestroyed()) window.destroy()
  }

  private clearAttention(): void {
    if (this.attentionCount === 0) return
    this.attentionCount = 0
    if (this.options.platform.platform === 'win32') {
      const window = this.window
      if (window !== undefined && !window.isDestroyed()) window.flashFrame(false)
    } else {
      app.setBadgeCount(0)
    }
  }
}
