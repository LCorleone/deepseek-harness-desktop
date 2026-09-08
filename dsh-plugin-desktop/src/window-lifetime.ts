/**
 * The window-count-never-quits guard (2026-09-08, the #66 boot gap).
 *
 * Electron's Windows default quits the app when its last window closes. The
 * desktop's boot legitimately passes through zero-window gaps — silent SSO →
 * disclaimer gate → shell mount destroys one window before the next exists —
 * and on the real machine the default silently exited mid-boot the moment the
 * agreed disclaimer window was destroyed: no log, no shell, "nothing
 * happened". Process lifetime belongs to the shutdown coordinator alone
 * (X-close confirmation, tray quit, SIGTERM, before-quit all route through
 * it), so window count must never decide it.
 *
 * @module dsh-plugin-desktop/window-lifetime
 */
import type { App } from 'electron'

/**
 * Prevent the default quit-on-last-window-close for the whole process
 * lifetime. Returns a disposer (kept for symmetry; the guard is never
 * removed — the shutdown coordinator owns exits, and a quit in flight is
 * unaffected: it runs through `before-quit` → teardown → `app.exit`).
 *
 * The EventEmitter surface is adapted through `Electron.IpcMainEvent`-free
 * loose callables because Electron's `App.on` overload family does not
 * structurally satisfy a narrow one-event interface.
 */
export function installWindowLifetimeGuard(app: App): () => void {
  // bind(app) is load-bearing: an extracted unbound `app.on(...)` call runs
  // with this === undefined inside Node's EventEmitter ("reading '_events'"
  // — the #67 boot crash); the cast only smooths the overload family.
  const on = app.on.bind(app) as unknown as (event: 'window-all-closed', listener: (event: { preventDefault(): void }) => void) => unknown
  const off = app.off.bind(app) as unknown as (event: 'window-all-closed', listener: (event: { preventDefault(): void }) => void) => unknown
  const guard = (event: { preventDefault(): void }): void => { event.preventDefault() }
  on('window-all-closed', guard)
  return () => { off('window-all-closed', guard) }
}
