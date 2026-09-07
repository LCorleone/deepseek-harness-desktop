/**
 * The X-button close decision (2026-09-07): a confirmation dialog decides
 * whether the fleet build quits — replacing the hide-to-tray behavior.
 */
import { describe, expect, it, vi } from 'vitest'
import { requestShellWindowClose } from '../src/electron-shell-generation.ts'

function harness(overrides: Partial<{
  isQuitting: boolean
  confirm: Promise<boolean>
}> = {}) {
  const event = { preventDefault: vi.fn() }
  const state = {
    quit: vi.fn(),
    begin: vi.fn(),
    end: vi.fn(),
    pendingAfterConfirm: false,
  }
  const options = {
    isQuitting: () => overrides.isQuitting ?? false,
    beginConfirm: () => { state.begin() },
    endConfirm: () => { state.end(); },
    confirmClose: () => overrides.confirm ?? Promise.resolve(false),
    quit: () => { state.quit() },
  }
  return { event, state, options }
}

describe('requestShellWindowClose', () => {
  it('lets the close through while the app is already quitting (no dialog)', () => {
    const { event, state, options } = harness({ isQuitting: true })
    requestShellWindowClose(event, options)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(state.begin).not.toHaveBeenCalled()
  })

  it('holds the window, and quits only when the dialog confirms', async () => {
    const { event, state, options } = harness({ confirm: Promise.resolve(true) })
    requestShellWindowClose(event, options)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(state.begin).toHaveBeenCalledOnce()
    expect(state.end).toHaveBeenCalledOnce()
    expect(state.quit).toHaveBeenCalledOnce()
  })

  it('keeps the window open when the dialog is cancelled', async () => {
    const { event, state, options } = harness({ confirm: Promise.resolve(false) })
    requestShellWindowClose(event, options)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(state.quit).not.toHaveBeenCalled()
    expect(state.end).toHaveBeenCalledOnce()
  })

  it('a rejected dialog (window gone, Electron error) never quits', async () => {
    const { state, options } = harness({ confirm: Promise.reject(new Error('window destroyed')) })
    requestShellWindowClose({ preventDefault: () => {} }, options)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(state.quit).not.toHaveBeenCalled()
    expect(state.end).toHaveBeenCalledOnce()
  })
})
