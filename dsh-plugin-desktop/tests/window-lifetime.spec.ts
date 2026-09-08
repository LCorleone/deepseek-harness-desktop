/**
 * The window-lifetime guard (2026-09-08): window count never quits the app —
 * the #66 boot gap (agreed disclaimer destroyed → zero windows → Electron's
 * Windows default silently exited before the shell mounted).
 *
 * The fake app is a REAL Node EventEmitter on purpose: the #67 build crashed
 * because an earlier revision called an extracted unbound `app.on(...)`
 * (`reading '_events'`) — a closure-based vi.fn() fake cannot catch that
 * class; a prototype-method fake rethrows it in the test run.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installWindowLifetimeGuard } from '../src/window-lifetime.ts'

/** A real EventEmitter doubles as the minimal `window-all-closed` surface. */
class FakeApp extends EventEmitter {
  emitWindowAllClosed(): boolean {
    return this.emit('window-all-closed', { preventDefault: vi.fn() })
  }
}

describe('installWindowLifetimeGuard', () => {
  it('prevents the default quit on every window-all-closed emission', () => {
    const app = new FakeApp()
    const dispose = installWindowLifetimeGuard(app as never)

    for (let i = 0; i < 3; i += 1) {
      const event = { preventDefault: vi.fn() }
      app.emit('window-all-closed', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }

    dispose()
    // After disposal the guard is truly gone: another emission passes through.
    const late = { preventDefault: vi.fn() }
    app.emit('window-all-closed', late)
    expect(late.preventDefault).not.toHaveBeenCalled()
    expect(app.listenerCount('window-all-closed')).toBe(0)
  })
})
