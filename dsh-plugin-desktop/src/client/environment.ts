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
  /** Authenticated SSO account email; present only on locked `requireSso` builds after the gate authenticated. */
  account?: string
}

const MODES = new Set<DesktopClientMode>(['compatibility', 'advanced'])
const PLATFORMS = new Set<DesktopClientPlatform>(['darwin', 'win32', 'linux'])
const ACCOUNT_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/u
const MAX_ACCOUNT_BYTES = 320

/** UTF-8 byte length without the Node `Buffer` global (this module runs in the sandboxed renderer). */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

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
  const account = params.get('dsh-desktop-account')
  // Outside the desktop shell: NO dsh-desktop-* marker at all. Any single
  // marker — e.g. a lone dsh-desktop-locked=1 — still enters the strict
  // validation below: a half-corrupted desktop URL must fail loud, not
  // silently degrade to "no desktop environment".
  if (mode === null && platform === null && locked === null && account === null) return undefined
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
  // The account marker is the launcher-owned email of an authenticated SSO
  // session; absence means no session, and a non-email spelling is a
  // corrupted desktop URL rather than a badge worth rendering.
  if (account !== null) {
    if (!ACCOUNT_PATTERN.test(account) || utf8ByteLength(account) > MAX_ACCOUNT_BYTES) {
      throw new Error(`dsh-plugin-desktop: invalid dsh-desktop-account ${JSON.stringify(account)}`)
    }
    return {
      mode: mode as DesktopClientMode,
      platform: platform as DesktopClientPlatform,
      locked: locked === '1',
      account,
    }
  }
  return { mode: mode as DesktopClientMode, platform: platform as DesktopClientPlatform, locked: locked === '1' }
}
