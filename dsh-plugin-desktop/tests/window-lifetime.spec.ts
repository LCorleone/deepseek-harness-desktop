/**
 * The window-lifetime guard (2026-09-08): window count never quits the app —
 * the #66 boot gap (agreed disclaimer destroyed → zero windows → Electron's
 * Windows default silently exited before the shell mounted).
 */
import { describe, expect, it, vi } from 'vitest'
import { installWindowLifetimeGuard } from '../src/window-lifetime.ts'

describe('installWindowLifetimeGuard', () => {
  it('prevents the default quit on every window-all-closed emission', () => {
    const listeners: Array<(event: { preventDefault: () => void }) => void> = []
    const on = vi.fn((_event: string, listener: (event: { preventDefault: () => void }) => void) => {
      listeners.push(listener)
    })
    const off = vi.fn()
    const dispose = installWindowLifetimeGuard({ on, off } as never)

    expect(listeners).toHaveLength(1)
    for (let i = 0; i < 3; i += 1) {
      const event = { preventDefault: vi.fn() }
      listeners[0]!(event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }

    dispose()
    expect(off).toHaveBeenCalledOnce()
  })
})
