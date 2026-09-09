import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopDisclaimerWindow,
  attachDisclaimerWindowObservability,
  disclaimerConsoleLine,
  disclaimerLoadFailedLine,
  disclaimerRendererGoneLine,
  disclaimerUnresponsiveLine,
  parseDisclaimerAction,
  type DisclaimerViewModel,
  type DisclaimerWebContentsObserver,
} from '../src/disclaimer-window.ts'
import { DISCLAIMER_ITEMS, DISCLAIMER_TITLE } from '../src/disclaimer-text.ts'

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

  const windows: FakeDisclaimerWindow[] = []

  class FakeDisclaimerWindow {
    /** View-model states rendered into the document, in order. */
    readonly states: string[] = []
    readonly webContents = {
      ...emitter(),
      id: 42,
      setWindowOpenHandler: vi.fn(() => ({ action: 'deny' })),
    }
    readonly events = emitter()
    readonly loadURL = vi.fn(async (target: string): Promise<void> => {
      const state = new URL(target).searchParams.get('state')
      if (state !== null) this.states.push(state)
    })
    readonly destroy = vi.fn()
    readonly removeMenu = vi.fn()
    readonly isDestroyed = vi.fn(() => false)
    readonly isMinimized = vi.fn(() => false)
    readonly isVisible = vi.fn(() => true)
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    accessibleTitle = ''
    constructor(readonly options: unknown) {
      windows.push(this)
    }
    on(event: string, listener: Listener): void { this.events.on(event, listener) }
    once(event: string, listener: Listener): void { this.events.once(event, listener) }
  }

  const appEmitter = emitter()
  const ipcListeners = new Map<string, Set<(event: unknown, action: unknown) => void>>()
  const ipcMain = {
    on: (channel: string, listener: (event: unknown, action: unknown) => void): void => {
      const set = ipcListeners.get(channel) ?? new Set()
      set.add(listener)
      ipcListeners.set(channel, set)
    },
    removeListener: (channel: string, listener: (event: unknown, action: unknown) => void): void => {
      ipcListeners.get(channel)?.delete(listener)
    },
    emit: (channel: string, event: unknown, action: unknown): void => {
      for (const listener of ipcListeners.get(channel) ?? []) listener(event, action)
    },
  }
  return {
    app: { on: appEmitter.on, off: appEmitter.off, isHidden: vi.fn(() => false), show: vi.fn() },
    BrowserWindow: FakeDisclaimerWindow,
    ipcMain,
    ipcListeners,
    windows,
  }
})

vi.mock('electron', () => ({ app: electron.app, BrowserWindow: electron.BrowserWindow, ipcMain: electron.ipcMain, contextBridge: { exposeInMainWorld: () => {} }, ipcRenderer: { send: () => {} } }))

const SCHEME = 'dsh-disclaimer:'

describe('disclaimer window action parsing', () => {
  it('accepts exactly the two decisions without parameters', () => {
    expect(parseDisclaimerAction(`${SCHEME}//agree`)).toEqual({ action: 'agree' })
    expect(parseDisclaimerAction(`${SCHEME}//disagree`)).toEqual({ action: 'disagree' })
  })

  it('rejects every other origin, path, query, or credential spelling', () => {
    expect(parseDisclaimerAction('https://portal.example/agree')).toBeUndefined()
    expect(parseDisclaimerAction(`${SCHEME}//maybe`)).toBeUndefined()
    expect(parseDisclaimerAction(`${SCHEME}//agree?forced=1`)).toBeUndefined()
    expect(parseDisclaimerAction(`${SCHEME}//user:pw@agree`)).toBeUndefined()
    expect(parseDisclaimerAction(`${SCHEME}//agree:8080`)).toBeUndefined()
    expect(parseDisclaimerAction(`${SCHEME}//agree/extra`)).toBeUndefined()
    expect(parseDisclaimerAction(`${SCHEME}//agree#fragment`)).toBeUndefined()
    expect(parseDisclaimerAction('not a url')).toBeUndefined()
    expect(parseDisclaimerAction('about:blank')).toBeUndefined()
  })
})

describe('disclaimer window observability', () => {
  /** Captures the listener each event would deliver to Electron. */
  function observer(): {
    webContents: DisclaimerWebContentsObserver
    emit: (event: 'console-message' | 'render-process-gone' | 'did-fail-load' | 'unresponsive', ...args: unknown[]) => void
  } {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    const webContents: DisclaimerWebContentsObserver = {
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
    return {
      webContents,
      emit: (event, ...args) => {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
    }
  }

  it('logs renderer console output with its level under the disclaimer prefix', () => {
    expect(disclaimerConsoleLine('error', 'Uncaught TypeError: Cannot read properties of undefined'))
      .toBe('dsh-plugin-desktop: disclaimer window renderer console (error): Uncaught TypeError: Cannot read properties of undefined')
    expect(disclaimerConsoleLine('info', 'ready'))
      .toBe('dsh-plugin-desktop: disclaimer window renderer console (info): ready')
  })

  it('logs renderer loss with reason and exit code', () => {
    expect(disclaimerRendererGoneLine('oom', 106659))
      .toBe('dsh-plugin-desktop: disclaimer window render process gone (reason: oom, exitCode: 106659 / 0x0001a0a3)')
  })

  it('reduces a failed load to its file name — the state query never reaches the log', () => {
    const line = disclaimerLoadFailedLine(
      -6,
      'ERR_FILE_NOT_FOUND',
      'file:///opt/app/resources/app.asar.unpacked/native-ui/disclaimer.html?state=eyJ0aXRsZSI6IuWfuuWuumhlSJ4In0',
      true,
    )
    expect(line).toBe('dsh-plugin-desktop: disclaimer window failed to load (-6: ERR_FILE_NOT_FOUND, file: disclaimer.html, mainFrame: yes)')
    expect(line).not.toContain('state=')
    expect(disclaimerLoadFailedLine(-3, 'ERR_ABORTED', 'not a url', false))
      .toBe('dsh-plugin-desktop: disclaimer window failed to load (-3: ERR_ABORTED, file: unparsed, mainFrame: no)')
  })

  it('logs an unresponsive renderer', () => {
    expect(disclaimerUnresponsiveLine())
      .toBe('dsh-plugin-desktop: disclaimer window renderer unresponsive')
  })

  it('wires every event through the log sink', () => {
    const { webContents, emit } = observer()
    const lines: string[] = []
    attachDisclaimerWindowObservability(webContents, message => { lines.push(message) })
    emit('console-message', { level: 'error', message: 'renderer exploded' })
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 20 })
    emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/native-ui/disclaimer.html?state=e30', true)
    emit('unresponsive')
    expect(lines).toEqual([
      'dsh-plugin-desktop: disclaimer window renderer console (error): renderer exploded',
      'dsh-plugin-desktop: disclaimer window render process gone (reason: crashed, exitCode: 20 / 0x00000014)',
      'dsh-plugin-desktop: disclaimer window failed to load (-6: ERR_FILE_NOT_FOUND, file: disclaimer.html, mainFrame: yes)',
      'dsh-plugin-desktop: disclaimer window renderer unresponsive',
    ])
  })
})

describe('DesktopDisclaimerWindow lifecycle', () => {
  type WindowMock = (typeof electron.windows)[number]

  /** Decode one rendered base64url view-model state. */
  function renderedModels(window: WindowMock): DisclaimerViewModel[] {
    return window.states.map(state => JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as DisclaimerViewModel)
  }

  /** Flush pending promise continuations past the microtask queue. */
  async function flushAsync(): Promise<void> {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }

  /**
   * Open one disclaimer window through `run()` and return the drivers its
   * lifecycle needs: the captured window, the run promise (with every
   * settlement recorded), and the renderer's three exits — either button
   * (a `will-navigate` the main process intercepts) and closing the window.
   */
  async function openDisclaimer(): Promise<{
    readonly host: DesktopDisclaimerWindow
    readonly window: WindowMock
    readonly results: ('agree' | 'disagree')[]
    readonly run: Promise<'agree' | 'disagree'>
    readonly decide: (action: 'agree' | 'disagree') => void
    readonly close: () => void
  }> {
    const disclaimer = new DesktopDisclaimerWindow()
    const results: ('agree' | 'disagree')[] = []
    const run = disclaimer.run().then(result => {
      results.push(result)
      return result
    })
    const window = electron.windows[0]
    if (window === undefined) throw new Error('disclaimer window was not created')
    // The preload path is the transport's lifeline (review P2): a typo'd
    // filename degrades visibly only on a real machine.
    expect((window.options as { webPreferences: { preload: string } }).webPreferences.preload)
      .toMatch(/disclaimer-preload\.cjs$/u)
    await vi.waitFor(() => expect(window.states).toHaveLength(1))
    window.events.emit('ready-to-show')
    return {
      host: disclaimer,
      window,
      results,
      run,
      // The real transport since the #63 packaged-renderer finding: the
      // preload's IPC send, not scheme navigation.
      decide: action => {
        electron.ipcMain.emit('dsh-disclaimer:decide', { sender: { id: window.webContents.id } }, action)
      },
      close: () => { window.events.emit('closed') },
    }
  }

  beforeEach(() => { electron.windows.length = 0 })

  it('ignores a decide IPC from a foreign sender webContents', async () => {
    const { results, close } = await openDisclaimer()
    electron.ipcMain.emit('dsh-disclaimer:decide', { sender: { id: 999 } }, 'agree')
    await flushAsync()
    expect(results).toEqual([])
    close()
    await flushAsync()
  })

  it('ignores a decide IPC carrying an off-enum action', async () => {
    const { results, window, close } = await openDisclaimer()
    electron.ipcMain.emit('dsh-disclaimer:decide', { sender: { id: window.webContents.id } }, 'agree-but-louder')
    await flushAsync()
    expect(results).toEqual([])
    close()
    await flushAsync()
  })

  it('removes the decide listener when the window closes', async () => {
    const { close } = await openDisclaimer()
    close()
    await flushAsync()
    // A late in-flight IPC after closed must not throw (destroyed window)
    // and the listener set is empty — nothing remains registered.
    electron.ipcMain.emit('dsh-disclaimer:decide', { sender: { id: 42 } }, 'agree')
    expect(electron.ipcListeners.get('dsh-disclaimer:decide')?.size ?? 0).toBe(0)
  })

  it('renders the v2 statement once and settles agree, keeping the window alive as the loading surface', async () => {
    const disclaimer = await openDisclaimer()

    // The rendered view model IS the hashed copy: same title, same clauses.
    expect(renderedModels(disclaimer.window)).toEqual([
      { title: DISCLAIMER_TITLE, items: [...DISCLAIMER_ITEMS] },
    ])
    // ready-to-show revealed the window once it had painted.
    expect(disclaimer.window.show).toHaveBeenCalledOnce()
    expect(disclaimer.window.focus).toHaveBeenCalledOnce()

    disclaimer.decide('agree')

    await expect(disclaimer.run).resolves.toBe('agree')
    // Agree no longer destroys: the window stays on screen as the startup
    // loading surface until the caller disposes it at the first successor
    // face (shell window / recovery / Profile creator / SSO gate).
    expect(disclaimer.window.destroy).not.toHaveBeenCalled()
    expect(disclaimer.results).toEqual(['agree'])

    // dispose() is the retirement signal — and idempotent.
    disclaimer.host.dispose()
    disclaimer.host.dispose()
    expect(disclaimer.window.destroy).toHaveBeenCalledOnce()
    // Electron delivers `closed` after destroy(); the listener cleanup runs.
    disclaimer.close()
    await flushAsync()
    expect(electron.ipcListeners.get('dsh-disclaimer:decide')?.size ?? 0).toBe(0)
  })

  it('dispose is safe after the user closed the loading window — a late signal is a no-op', async () => {
    const disclaimer = await openDisclaimer()

    disclaimer.decide('agree')
    await expect(disclaimer.run).resolves.toBe('agree')
    // The user closes the loading window themselves (X = close, not quit:
    // the #66 lifetime guard owns the boot gap).
    disclaimer.close()
    await flushAsync()

    expect(disclaimer.results).toEqual(['agree'])
    expect(disclaimer.window.destroy).not.toHaveBeenCalled()
    // A dispose signal arriving after `closed` must neither throw nor
    // double-destroy — `closed` already released the window and the listeners.
    disclaimer.host.dispose()
    expect(disclaimer.window.destroy).not.toHaveBeenCalled()
    expect(electron.ipcListeners.get('dsh-disclaimer:decide')?.size ?? 0).toBe(0)
  })

  it('settles disagree from the 「不同意」 button and destroys the window', async () => {
    const disclaimer = await openDisclaimer()

    disclaimer.decide('disagree')

    await expect(disclaimer.run).resolves.toBe('disagree')
    expect(disclaimer.window.destroy).toHaveBeenCalledOnce()
    expect(disclaimer.results).toEqual(['disagree'])
  })

  it('settles disagree when the window is closed — a close is the same refusal', async () => {
    const disclaimer = await openDisclaimer()

    disclaimer.close()

    await expect(disclaimer.run).resolves.toBe('disagree')
    // The window closed on its own; `closed` had already released it, so
    // finish must not call destroy on the destroyed window.
    expect(disclaimer.window.destroy).not.toHaveBeenCalled()
    expect(disclaimer.results).toEqual(['disagree'])
  })

  it('settles exactly once — a late closed event cannot flip the decision', async () => {
    const disclaimer = await openDisclaimer()

    disclaimer.decide('agree')
    await expect(disclaimer.run).resolves.toBe('agree')

    // Electron delivers `closed` after the user closes the loading window;
    // settling again is a no-op and the agree verdict stands.
    disclaimer.close()
    disclaimer.close()
    await flushAsync()

    expect(disclaimer.results).toEqual(['agree'])
    // The window closed on its own; finish must not destroy on agree.
    expect(disclaimer.window.destroy).not.toHaveBeenCalled()
  })

  it('ignores decision navigations after settlement', async () => {
    const disclaimer = await openDisclaimer()

    disclaimer.decide('disagree')
    await expect(disclaimer.run).resolves.toBe('disagree')
    disclaimer.decide('agree')
    await flushAsync()

    expect(disclaimer.results).toEqual(['disagree'])
  })

  it('opens directly on the loading surface when asked, with no decision to settle', async () => {
    const host = new DesktopDisclaimerWindow()
    const opened = host.openLoadingSurface()
    const window = electron.windows[0]
    if (window === undefined) throw new Error('loading surface window was not created')
    await vi.waitFor(() => expect(window.states).toHaveLength(1))
    expect(renderedModels(window)).toEqual([{
      title: DISCLAIMER_TITLE,
      items: [...DISCLAIMER_ITEMS],
      starting: true,
    }])
    await opened
    // No decision is awaited: a late decide IPC is a no-op and dispose is the
    // only retirement path.
    electron.ipcMain.emit('dsh-disclaimer:decide', { sender: { id: window.webContents.id } }, 'agree')
    await flushAsync()
    expect(window.destroy).not.toHaveBeenCalled()
    host.dispose()
    expect(window.destroy).toHaveBeenCalledOnce()
    window.events.emit('closed')
    await flushAsync()
  })
})
