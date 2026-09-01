import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopSsoGateWindow,
  attachSsoGateWindowObservability,
  parseSsoGateAction,
  ssoGateConsoleLine,
  ssoGateLoadFailedLine,
  ssoGateRendererGoneLine,
  ssoGateUnresponsiveLine,
  type DesktopSsoGateWindowOptions,
  type SsoGateResult,
  type SsoGateViewModel,
  type SsoGateWebContentsObserver,
} from '../src/sso-gate-window.ts'

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

  const windows: FakeGateWindow[] = []

  class FakeGateWindow {
    /** View-model states rendered into the document, in order. */
    readonly states: string[] = []
    readonly webContents = {
      ...emitter(),
      setWindowOpenHandler: vi.fn(() => ({ action: 'deny' })),
    }
    readonly events = emitter()
    readonly loadFile = vi.fn(async (
      _document: string,
      options: { readonly query: { readonly state: string } },
    ): Promise<void> => {
      this.states.push(options.query.state)
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
  return {
    app: { on: appEmitter.on, off: appEmitter.off, isHidden: vi.fn(() => false), show: vi.fn() },
    BrowserWindow: FakeGateWindow,
    windows,
  }
})

vi.mock('electron', () => ({ app: electron.app, BrowserWindow: electron.BrowserWindow }))

const SCHEME = 'dsh-sso-gate:'

describe('sso gate window action parsing', () => {
  it('accepts exactly the sign-in action without parameters', () => {
    expect(parseSsoGateAction(`${SCHEME}//sign-in`)).toEqual({ action: 'sign-in' })
  })

  it('rejects every other origin, path, query, or credential spelling', () => {
    expect(parseSsoGateAction('https://portal.example/sign-in')).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//quit`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in?repeat=1`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//user:pw@sign-in`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in:8080`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in/extra`)).toBeUndefined()
    expect(parseSsoGateAction(`${SCHEME}//sign-in#fragment`)).toBeUndefined()
    expect(parseSsoGateAction('not a url')).toBeUndefined()
    expect(parseSsoGateAction('about:blank')).toBeUndefined()
  })
})

describe('sso gate window observability', () => {
  /** Captures the listener each event would deliver to Electron. */
  function observer(): {
    webContents: SsoGateWebContentsObserver
    emit: (event: 'console-message' | 'render-process-gone' | 'did-fail-load' | 'unresponsive', ...args: unknown[]) => void
  } {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    const webContents: SsoGateWebContentsObserver = {
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

  it('logs renderer console output with its level under the gate prefix', () => {
    expect(ssoGateConsoleLine('error', 'Uncaught TypeError: Cannot read properties of undefined'))
      .toBe('dsh-plugin-desktop: sso gate renderer console (error): Uncaught TypeError: Cannot read properties of undefined')
    expect(ssoGateConsoleLine('info', 'ready')).toBe('dsh-plugin-desktop: sso gate renderer console (info): ready')
  })

  it('logs renderer loss with reason and exit code', () => {
    expect(ssoGateRendererGoneLine('oom', 106659))
      .toBe('dsh-plugin-desktop: sso gate render process gone (reason: oom, exitCode: 106659 / 0x0001a0a3)')
  })

  it('reduces a failed load to its file name — the state query never reaches the log', () => {
    const line = ssoGateLoadFailedLine(
      -6,
      'ERR_FILE_NOT_FOUND',
      'file:///opt/app/resources/app.asar.unpacked/native-ui/sso-gate.html?state=eyJsb2NhbGUiOiJlbiJ9',
      true,
    )
    expect(line).toBe('dsh-plugin-desktop: sso gate failed to load (-6: ERR_FILE_NOT_FOUND, file: sso-gate.html, mainFrame: yes)')
    expect(line).not.toContain('state=')
    expect(ssoGateLoadFailedLine(-3, 'ERR_ABORTED', 'not a url', false))
      .toBe('dsh-plugin-desktop: sso gate failed to load (-3: ERR_ABORTED, file: unparsed, mainFrame: no)')
  })

  it('logs an unresponsive renderer', () => {
    expect(ssoGateUnresponsiveLine()).toBe('dsh-plugin-desktop: sso gate renderer unresponsive')
  })

  it('wires every event through the log sink', () => {
    const { webContents, emit } = observer()
    const lines: string[] = []
    attachSsoGateWindowObservability(webContents, message => { lines.push(message) })
    emit('console-message', { level: 'error', message: 'renderer exploded' })
    emit('render-process-gone', {}, { reason: 'crashed', exitCode: 20 })
    emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/native-ui/sso-gate.html?state=e30', true)
    emit('unresponsive')
    expect(lines).toEqual([
      'dsh-plugin-desktop: sso gate renderer console (error): renderer exploded',
      'dsh-plugin-desktop: sso gate render process gone (reason: crashed, exitCode: 20 / 0x00000014)',
      'dsh-plugin-desktop: sso gate failed to load (-6: ERR_FILE_NOT_FOUND, file: sso-gate.html, mainFrame: yes)',
      'dsh-plugin-desktop: sso gate renderer unresponsive',
    ])
  })
})

describe('DesktopSsoGateWindow lifecycle', () => {
  type GateWindowMock = (typeof electron.windows)[number]
  type BrowserLoginOutcome = { readonly ok: true } | { readonly ok: false, readonly reason: string }

  /** Resolve-later promise, so a test controls when the browser login lands. */
  function deferred<T>(): { readonly promise: Promise<T>, readonly resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
    return { promise, resolve }
  }

  /** Decode one rendered base64url view-model state. */
  function renderedModels(window: GateWindowMock): SsoGateViewModel[] {
    return window.states.map(state => JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as SsoGateViewModel)
  }

  /** Flush pending promise continuations past the microtask queue. */
  async function flushAsync(): Promise<void> {
    await new Promise(resolve => { setTimeout(resolve, 0) })
  }

  /**
   * Open one gate window through `run()` and return the drivers its
   * lifecycle needs: the captured window, the run promise (with every
   * settlement recorded), and the renderer's two exits — pressing the
   * sign-in button (a `will-navigate` the main process intercepts) and
   * closing the window.
   */
  async function openGate(startBrowserLogin: DesktopSsoGateWindowOptions['startBrowserLogin']): Promise<{
    readonly window: GateWindowMock
    readonly results: SsoGateResult[]
    readonly run: Promise<SsoGateResult>
    readonly signIn: () => void
    readonly close: () => void
  }> {
    const gate = new DesktopSsoGateWindow({
      locale: 'zh',
      silentFailureDetail: 'silent handshake unavailable',
      startBrowserLogin,
    })
    const results: SsoGateResult[] = []
    const run = gate.run().then(result => {
      results.push(result)
      return result
    })
    const window = electron.windows[0]
    if (window === undefined) throw new Error('gate window was not created')
    await vi.waitFor(() => expect(window.states).toHaveLength(1))
    window.events.emit('ready-to-show')
    return {
      window,
      results,
      run,
      signIn: () => {
        window.webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'dsh-sso-gate://sign-in')
      },
      close: () => { window.events.emit('closed') },
    }
  }

  beforeEach(() => { electron.windows.length = 0 })

  it('settles authenticated and renders that phase once the browser login succeeds', async () => {
    const startBrowserLogin = vi.fn(async () => ({ ok: true as const }))
    const gate = await openGate(startBrowserLogin)

    gate.signIn()

    await expect(gate.run).resolves.toBe('authenticated')
    expect(startBrowserLogin).toHaveBeenCalledOnce()
    // ready-to-show revealed the window once it had painted.
    expect(gate.window.show).toHaveBeenCalledOnce()
    expect(gate.window.focus).toHaveBeenCalledOnce()
    // ready (with the silent-failure detail) → waiting (detail retained)
    // → authenticated; the cleared error area drops the errorDetail key.
    expect(renderedModels(gate.window)).toEqual([
      { locale: 'zh', phase: 'ready', errorDetail: 'silent handshake unavailable' },
      { locale: 'zh', phase: 'waiting', errorDetail: 'silent handshake unavailable' },
      { locale: 'zh', phase: 'authenticated' },
    ])
    expect(gate.window.destroy).toHaveBeenCalledOnce()
    expect(gate.results).toEqual(['authenticated'])
  })

  it('returns to the ready phase with the truncated failure reason when the login fails', async () => {
    const startBrowserLogin = vi.fn(async () => ({ ok: false as const, reason: '拒'.repeat(2_050) + 'x'.repeat(500) }))
    const gate = await openGate(startBrowserLogin)

    gate.signIn()

    await vi.waitFor(() => expect(gate.window.states).toHaveLength(3))
    const models = renderedModels(gate.window)
    expect(models[2]?.phase).toBe('ready')
    expect(models[2]?.errorDetail).toHaveLength(2_000)
    expect(models[2]?.errorDetail).toBe('拒'.repeat(2_050).slice(0, 2_000))
    // The gate stays open for another attempt; only closing settles quit.
    expect(gate.window.destroy).not.toHaveBeenCalled()
    gate.close()
    await expect(gate.run).resolves.toBe('quit')
  })

  it('ignores further sign-in actions while one browser login is in flight', async () => {
    const login = deferred<BrowserLoginOutcome>()
    const startBrowserLogin = vi.fn(() => login.promise)
    const gate = await openGate(startBrowserLogin)

    gate.signIn()
    gate.signIn()
    gate.signIn()

    await vi.waitFor(() => expect(startBrowserLogin).toHaveBeenCalledOnce())
    // Only the initial ready render and one waiting render happened.
    expect(gate.window.states).toHaveLength(2)
    login.resolve({ ok: true })
    await expect(gate.run).resolves.toBe('authenticated')
    expect(startBrowserLogin).toHaveBeenCalledOnce()
  })

  it('keeps quit when the gate closes mid-login and the login settles authenticated late', async () => {
    const login = deferred<BrowserLoginOutcome>()
    const startBrowserLogin = vi.fn(() => login.promise)
    const gate = await openGate(startBrowserLogin)

    gate.signIn()
    await vi.waitFor(() => expect(startBrowserLogin).toHaveBeenCalledOnce())
    gate.close()
    await expect(gate.run).resolves.toBe('quit')

    login.resolve({ ok: true })
    await flushAsync()

    // The late authenticated outcome cannot flip the settlement or render:
    // the window is gone and finish is already settled. (destroy is not
    // called on this path — the window closed on its own, so `closed` had
    // already released it before finish ran.)
    expect(gate.results).toEqual(['quit'])
    expect(gate.window.states).toHaveLength(2)
    expect(gate.window.destroy).not.toHaveBeenCalled()
  })

  it('settles exactly once — the closed event that follows destroy cannot flip the result', async () => {
    const startBrowserLogin = vi.fn(async () => ({ ok: true as const }))
    const gate = await openGate(startBrowserLogin)

    gate.signIn()
    await expect(gate.run).resolves.toBe('authenticated')
    expect(gate.window.destroy).toHaveBeenCalledOnce()

    // Electron delivers `closed` after destroy(); settling again is a no-op.
    gate.close()
    gate.close()
    await flushAsync()

    expect(gate.results).toEqual(['authenticated'])
    expect(gate.window.destroy).toHaveBeenCalledOnce()
  })
})
