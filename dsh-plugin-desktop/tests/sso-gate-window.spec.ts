import { describe, expect, it } from 'vitest'
import {
  attachSsoGateWindowObservability,
  parseSsoGateAction,
  ssoGateConsoleLine,
  ssoGateLoadFailedLine,
  ssoGateRendererGoneLine,
  ssoGateUnresponsiveLine,
  type SsoGateWebContentsObserver,
} from '../src/sso-gate-window.ts'

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
