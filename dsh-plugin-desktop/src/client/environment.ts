/** Desktop renderer modes accepted from the Electron-owned page URL. */
export type DesktopClientMode = 'compatibility' | 'advanced'

/** Host platforms whose native chrome has a desktop presentation. */
export type DesktopClientPlatform = 'darwin' | 'win32' | 'linux'

/** Validated renderer environment supplied by the Electron Host. */
export interface DesktopClientEnvironment {
  /** Active shell mode for this BrowserWindow lifetime. */
  mode: DesktopClientMode
  /** Electron Host platform used for native spacing and drag regions. */
  platform: DesktopClientPlatform
  /** Whether the embedded company policy locks this build's choice surfaces. */
  locked: boolean
}

const MODES = new Set<DesktopClientMode>(['compatibility', 'advanced'])
const PLATFORMS = new Set<DesktopClientPlatform>(['darwin', 'win32', 'linux'])

/**
 * Validate the Electron-owned query marker before any desktop client effects run.
 * @param search - URL search string, including or omitting the leading question mark.
 * @returns the validated desktop renderer environment, or undefined outside the desktop shell.
 */
export function parseDesktopClientEnvironment(search: string): DesktopClientEnvironment | undefined {
  const params = new URLSearchParams(search)
  const mode = params.get('dsh-desktop-mode')
  const platform = params.get('dsh-desktop-platform')
  const locked = params.get('dsh-desktop-locked')
  // Outside the desktop shell: NO dsh-desktop-* marker at all. Any single
  // marker — e.g. a lone dsh-desktop-locked=1 — still enters the strict
  // validation below: a half-corrupted desktop URL must fail loud, not
  // silently degrade to "no desktop environment".
  if (mode === null && platform === null && locked === null) return undefined
  if (!MODES.has(mode as DesktopClientMode)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-mode ${JSON.stringify(mode)}`)
  }
  if (!PLATFORMS.has(platform as DesktopClientPlatform)) {
    throw new Error(`dsh-plugin-desktop: invalid or missing dsh-desktop-platform ${JSON.stringify(platform)}`)
  }
  // The Electron Host sets the lock marker to '1' on company builds only;
  // an unlocked shell omits it, so any other spelling is a corrupted URL.
  if (locked !== null && locked !== '1') {
    throw new Error(`dsh-plugin-desktop: invalid dsh-desktop-locked ${JSON.stringify(locked)}`)
  }
  return { mode: mode as DesktopClientMode, platform: platform as DesktopClientPlatform, locked: locked === '1' }
}
