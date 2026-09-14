import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopBootSplashWindow,
  attachBootSplashWindowObservability,
  bootSplashConsoleLine,
  bootSplashLoadFailedLine,
  bootSplashRendererGoneLine,
  bootSplashUnresponsiveLine,
  BOOT_SPLASH_MIN_LIFTOFF_MS,
  type BootSplashWebContentsObserver,
} from '../src/boot-splash-window.ts'

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  /** Capture on/once/off registrations so tests can emit real event sequences. */
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

  const windows: FakeSplashWindow[] = []

  class FakeSplashWindow {
    readonly webContents = {
      ...emitter(),
      id: 7,
      setWindowOpenHandler: vi.fn(() => ({ action: 'deny' })),
    }
    readonly events = emitter()
    /** Set true to make the next loadURL reject (the failed-load path). */
    failLoad = false
    readonly loadURL = vi.fn(async (target: string): Promise<void> => {
      this.loadedUrl = target
      // Deferred one microtask so a test can arm failLoad after open() has
      // captured the window but before the load resolves.
      await Promise.resolve()
      if (this.failLoad) throw new Error('ERR_FAILED')
    })
    loadedUrl = ''
    readonly destroy = vi.fn()
    readonly removeMenu = vi.fn()
    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly isVisible = vi.fn(() => false)
    readonly show = vi.fn()
    readonly showInactive = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    accessibleTitle = ''
    constructor(readonly options: unknown) {
      windows.push(this)
    }
    on(event: string, listener: Listener): void { this.events.on(event, listener) }
    once(event: string, listener: Listener): void { this.events.once(event, listener) }
  }

  return {
    app: { isHidden: vi.fn(() => false), show: vi.fn() },
    BrowserWindow: FakeSplashWindow,
    windows,
  }
})

vi.mock('electron', () => ({ app: electron.app, BrowserWindow: electron.BrowserWindow }))

describe('boot splash observability lines', () => {
  it('formats each renderer event under the boot splash prefix', () => {
    expect(bootSplashConsoleLine('error', 'Uncaught TypeError: x'))
      .toBe('dsh-plugin-desktop: boot splash window renderer console (error): Uncaught TypeError: x')
    expect(bootSplashRendererGoneLine('oom', 106659))
      .toBe('dsh-plugin-desktop: boot splash window render process gone (reason: oom, exitCode: 106659 / 0x0001a0a3)')
    expect(bootSplashLoadFailedLine(-6, 'ERR_FILE_NOT_FOUND', 'file:///opt/app/resources/app.asar.unpacked/native-ui/splash.html', true))
      .toBe('dsh-plugin-desktop: boot splash window failed to load (-6: ERR_FILE_NOT_FOUND, file: splash.html, mainFrame: yes)')
    expect(bootSplashUnresponsiveLine())
      .toBe('dsh-plugin-desktop: boot splash window renderer unresponsive')
  })

  it('wires every renderer event through the log sink', () => {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    const webContents: BootSplashWebContentsObserver = {
      on(
        event: 'console-message' | 'render-process-gone' | 'did-fail-load' | 'unresponsive',
        listener: unknown,
      ): unknown {
        const existing = listeners.get(event) ?? []
        existing.push(listener as (...args: unknown[]) => void)
        listeners.set(event, existing)
        return undefined
      },
    }
    const lines: string[] = []
    attachBootSplashWindowObservability(webContents, message => { lines.push(message) })
    for (const [event, args] of [
      ['console-message', [{ level: 'error', message: 'splash exploded' }]],
      ['render-process-gone', [{}, { reason: 'crashed', exitCode: 20 }]],
      ['did-fail-load', [{}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/native-ui/splash.html', true]],
      ['unresponsive', []],
    ] as const) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    }
    expect(lines).toEqual([
      'dsh-plugin-desktop: boot splash window renderer console (error): splash exploded',
      'dsh-plugin-desktop: boot splash window render process gone (reason: crashed, exitCode: 20 / 0x00000014)',
      'dsh-plugin-desktop: boot splash window failed to load (-6: ERR_FILE_NOT_FOUND, file: splash.html, mainFrame: yes)',
      'dsh-plugin-desktop: boot splash window renderer unresponsive',
    ])
  })
})

describe('DesktopBootSplashWindow', () => {
  type WindowMock = (typeof electron.windows)[number]

  /** Open one splash and return its captured window. */
  async function openSplash(): Promise<WindowMock> {
    const splash = new DesktopBootSplashWindow()
    await splash.open()
    const window = electron.windows[0]
    if (window === undefined) throw new Error('splash window was not created')
    return window
  }

  beforeEach(() => {
    electron.windows.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => { vi.useRealTimers() })

  it('creates the window with the native-ui hardening shape and no preload', async () => {
    const window = await openSplash()
    const options = window.options as {
      readonly title: string
      readonly show: boolean
      readonly resizable: boolean
      readonly autoHideMenuBar: boolean
      readonly backgroundColor: string
      readonly webPreferences: Record<string, unknown>
    }
    expect(options.title).toBe('正在启动 DSH Desktop - Deloitte DSH Desktop')
    expect(options.show).toBe(false)
    expect(options.resizable).toBe(false)
    expect(options.autoHideMenuBar).toBe(true)
    expect(options.backgroundColor).toBe('#202124')
    // The disclaimer-window hardening set (contextIsolation/sandbox/dedicated
    // partition), and NO preload: the splash has no transport to bridge.
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      partition: 'dsh-boot-splash',
    })
    expect('preload' in options.webPreferences).toBe(false)
    expect(window.accessibleTitle).toBe('正在启动 DSH Desktop - Deloitte DSH Desktop')
    expect(window.removeMenu).toHaveBeenCalledOnce()
    expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
  })

  it('loads the static splash document from the native-ui mirror, no query', async () => {
    const window = await openSplash()
    expect(window.loadURL).toHaveBeenCalledOnce()
    const target = new URL(window.loadedUrl)
    expect(target.protocol).toBe('file:')
    expect(target.pathname.endsWith('/native-ui/splash.html')).toBe(true)
    expect(target.search).toBe('')
  })

  it('waits for ready-to-show AND the liftoff floor — neither alone shows', async () => {
    const window = await openSplash()
    // Painted early, floor not reached: still invisible.
    window.events.emit('ready-to-show')
    vi.advanceTimersByTime(BOOT_SPLASH_MIN_LIFTOFF_MS - 1)
    expect(window.showInactive).not.toHaveBeenCalled()
    // The floor completes the pair: reveal exactly once, never activating.
    vi.advanceTimersByTime(1)
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })

  it('stays hidden when the floor passes before the paint, then shows on the paint', async () => {
    const window = await openSplash()
    vi.advanceTimersByTime(BOOT_SPLASH_MIN_LIFTOFF_MS * 10)
    expect(window.showInactive).not.toHaveBeenCalled()
    window.events.emit('ready-to-show')
    expect(window.showInactive).toHaveBeenCalledOnce()
  })

  it('dispose before either gate: never reveals, destroys exactly once, cancels the timer', async () => {
    const splash = new DesktopBootSplashWindow()
    const opened = splash.open()
    const window = electron.windows.at(-1)
    if (window === undefined) throw new Error('splash window was not created')
    await opened
    // Painted but inside the floor: a fast boot retires the splash now.
    window.events.emit('ready-to-show')
    vi.advanceTimersByTime(50)
    splash.dispose()
    expect(window.showInactive).not.toHaveBeenCalled()
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(splash.alive).toBe(false)
    // Idempotent — a second dispose (the retire chain can fire twice) never
    // double-destroys, and the cancelled timer cannot reveal later.
    splash.dispose()
    expect(window.destroy).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(BOOT_SPLASH_MIN_LIFTOFF_MS * 10)
    expect(window.showInactive).not.toHaveBeenCalled()
  })

  it('dispose after the reveal still destroys exactly once; closed is a late no-op', async () => {
    const splash = new DesktopBootSplashWindow()
    const opened = splash.open()
    const window = electron.windows.at(-1)
    if (window === undefined) throw new Error('splash window was not created')
    await opened
    window.events.emit('ready-to-show')
    vi.advanceTimersByTime(BOOT_SPLASH_MIN_LIFTOFF_MS)
    expect(window.showInactive).toHaveBeenCalledOnce()
    splash.dispose()
    splash.dispose()
    expect(window.destroy).toHaveBeenCalledOnce()
    // Electron delivers `closed` after destroy(): must not throw.
    window.events.emit('closed')
    expect(splash.alive).toBe(false)
  })

  it('survives the user closing the splash — dispose afterwards is a plain no-op', async () => {
    const splash = new DesktopBootSplashWindow()
    const opened = splash.open()
    const window = electron.windows.at(-1)
    if (window === undefined) throw new Error('splash window was not created')
    await opened
    window.events.emit('closed')
    expect(splash.alive).toBe(false)
    expect(() => { splash.dispose() }).not.toThrow()
    expect(window.destroy).not.toHaveBeenCalled()
    // The cancelled timer cannot reveal a closed window.
    vi.advanceTimersByTime(BOOT_SPLASH_MIN_LIFTOFF_MS)
    expect(window.showInactive).not.toHaveBeenCalled()
  })

  it('show() forces the reveal past the floor once painted (second-instance feedback)', async () => {
    const splash = new DesktopBootSplashWindow()
    const opened = splash.open()
    const window = electron.windows.at(-1)
    if (window === undefined) throw new Error('splash window was not created')
    await opened
    // Not painted yet: the forced reveal waits for the paint.
    splash.show()
    expect(window.showInactive).not.toHaveBeenCalled()
    window.events.emit('ready-to-show')
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
  })

  it('show() after the reveal brings the splash to the front (the disclaimer show shape)', async () => {
    const splash = new DesktopBootSplashWindow()
    const opened = splash.open()
    const window = electron.windows.at(-1)
    if (window === undefined) throw new Error('splash window was not created')
    await opened
    window.events.emit('ready-to-show')
    vi.advanceTimersByTime(BOOT_SPLASH_MIN_LIFTOFF_MS)
    expect(window.showInactive).toHaveBeenCalledOnce()
    splash.show()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    // A dead window is a plain no-op.
    splash.dispose()
    expect(() => { splash.show() }).not.toThrow()
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('cleans the window up and rethrows when the document fails to load', async () => {
    const splash = new DesktopBootSplashWindow()
    const opened = splash.open()
    const window = electron.windows.at(-1)
    if (window === undefined) throw new Error('splash window was not created')
    window.failLoad = true
    await expect(opened).rejects.toThrow('ERR_FAILED')
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(splash.alive).toBe(false)
    expect(() => { splash.dispose() }).not.toThrow()
    // The cancelled timer cannot reveal anything afterwards.
    vi.advanceTimersByTime(BOOT_SPLASH_MIN_LIFTOFF_MS)
    expect(window.showInactive).not.toHaveBeenCalled()
  })
})
