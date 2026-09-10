/** Reveal policy for native windows, without an `electron` import.
 *
 * The Electron binding (`revealApplication` in electron-reveal.ts) and the
 * CLI-capable callers that must not import `electron` (`windows-pwsh-sandbox.ts`
 * escalation dialog) share this one implementation: a macOS application hidden
 * behind another app (Cmd+H) keeps every window invisible, and `show()` on the
 * window alone does not unhide it (b85-class bug).
 * @module dsh-plugin-desktop/window-reveal
 */

/** The application-level half of a reveal; Electron's `app` satisfies it. */
export interface RevealableApplication {
  /** Whether the application is currently hidden (macOS NSApp hidden state). */
  isHidden(): boolean
  /** Show the hidden application. */
  show(): void
}

/** The native-window half of a reveal; Electron's `BrowserWindow` satisfies it. */
export interface RevealableWindow {
  /** Whether the window is minimized. */
  isMinimized(): boolean
  /** Un-minimize the window. */
  restore(): void
  /** Un-hide the window (a shell hidden to the tray included). */
  show(): void
  /** Bring the window to the front. */
  focus(): void
}

/**
 * Reveal one native window, restoring the macOS application before the window.
 * @param application - the app handle, or `undefined` when the caller has none
 * (non-Electron hosts); it is only consulted on macOS.
 * @param window - the native window to reveal.
 * @param platform - host platform; defaults to `process.platform`.
 */
export function revealWindow(
  application: RevealableApplication | undefined,
  window: RevealableWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin' && application?.isHidden() === true) application.show()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}
