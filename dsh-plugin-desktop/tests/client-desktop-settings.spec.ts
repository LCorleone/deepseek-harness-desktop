import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { DesktopSettingsSection, desktopSettingsSectionVisibility } from '../src/client/DesktopSettingsSection.tsx'
import { DesktopTerminalSettingsAction } from '../src/client/DesktopTerminalSettingsAction.tsx'
import { GeneralUserInfoCard } from '../src/client/GeneralUserInfoCard.tsx'
import {
  createDesktopSettingsApi,
  desktopSettingsPaths,
  parseDesktopActionAcceptance,
  parseDesktopAgentBrowserLogin,
  parseDesktopRestartAcceptance,
  parseDesktopSettingsView,
  type DesktopSettingsView,
} from '../src/client/desktop-settings-api.ts'
import {
  applyDesktopSettings,
  DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE,
  DESKTOP_SETTINGS_LOCALE_NAMESPACE,
  DESKTOP_SHELL_SETTINGS_NAMESPACE,
} from '../src/client/desktop-settings.ts'
import { installDesktopSettingsStyles } from '../src/client/desktop-settings-styles.ts'

const VIEW: DesktopSettingsView = {
  current: 'desktop',
  locked: false,
  profiles: [
    { name: 'desktop', exists: true, webCapable: true, selectable: true, deletable: false },
    { name: 'headless', exists: true, webCapable: false, selectable: false, deletable: false },
    { name: 'work', exists: true, webCapable: true, selectable: true, deletable: true },
  ],
  market: { requested: 'disabled', effective: 'disabled', legacyDefaulted: true },
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Desktop settings API', () => {
  it('validates the bounded launcher projection', () => {
    expect(parseDesktopSettingsView(VIEW)).toEqual(VIEW)
    expect(parseDesktopSettingsView({ ...VIEW, locked: true })).toEqual({ ...VIEW, locked: true })
    expect(() => parseDesktopSettingsView({ ...VIEW, locked: 'yes' }))
      .toThrow('invalid Desktop settings response')
    expect(() => parseDesktopSettingsView({ ...VIEW, profiles: [...VIEW.profiles, VIEW.profiles[0]] }))
      .toThrow('duplicate profile')
    expect(() => parseDesktopSettingsView({ ...VIEW, market: { ...VIEW.market, requested: 'unknown' } }))
      .toThrow('invalid Desktop settings response')
    expect(parseDesktopRestartAcceptance({ accepted: true, restartRequired: true }))
      .toEqual({ accepted: true, restartRequired: true })
    expect(parseDesktopRestartAcceptance({ accepted: true, restartRequired: false }))
      .toEqual({ accepted: true, restartRequired: false })
    expect(() => parseDesktopRestartAcceptance({ accepted: true })).toThrow('invalid Desktop restart response')
    expect(parseDesktopActionAcceptance({ accepted: true })).toBeUndefined()
    expect(() => parseDesktopActionAcceptance({ accepted: true, detail: 'extra' }))
      .toThrow('invalid Desktop action response')
  })

  it('validates the optional sso session projection', () => {
    const withSso = {
      ...VIEW,
      sso: { authenticated: true, email: 'zhangsan@deloitte.com.cn', source: 'browser' },
    }
    expect(parseDesktopSettingsView(withSso)).toEqual(withSso)
    expect(parseDesktopSettingsView(VIEW)).not.toHaveProperty('sso')
    expect(() => parseDesktopSettingsView({ ...VIEW, sso: { authenticated: 'yes' } }))
      .toThrow('invalid sso settings response')
    expect(() => parseDesktopSettingsView({ ...VIEW, sso: { authenticated: true, email: 'not-an-email', source: 'browser' } }))
      .toThrow('invalid sso settings response')
    expect(() => parseDesktopSettingsView({ ...VIEW, sso: { authenticated: true, email: 'a@d.com', source: 'unknown' } }))
      .toThrow('invalid sso settings response')
  })

  it('uses the strict same-origin routes and request bodies', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      if (path === desktopSettingsPaths.terminalOpen) return json({ accepted: true })
      return path === desktopSettingsPaths.settings || path === desktopSettingsPaths.profileCreate || path === desktopSettingsPaths.profileDelete
        ? json(VIEW)
        : json({ accepted: true, restartRequired: true })
    })
    const api = createDesktopSettingsApi(fetcher)

    await expect(api.read()).resolves.toEqual(VIEW)
    await expect(api.createProfile('work')).resolves.toEqual(VIEW)
    await expect(api.selectProfile('work')).resolves.toEqual({ accepted: true, restartRequired: true })
    await expect(api.deleteProfile('work')).resolves.toEqual(VIEW)
    await expect(api.selectMarket('community-market')).resolves.toEqual({ accepted: true, restartRequired: true })
    await expect(api.openTerminal()).resolves.toBeUndefined()

    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      desktopSettingsPaths.settings,
      desktopSettingsPaths.profileCreate,
      desktopSettingsPaths.profileSelect,
      desktopSettingsPaths.profileDelete,
      desktopSettingsPaths.marketSelect,
      desktopSettingsPaths.terminalOpen,
    ])
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      body: JSON.stringify({ name: 'work' }),
    })
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify({ name: 'work' }),
    })
    expect(fetcher.mock.calls[4]?.[1]).toMatchObject({
      body: JSON.stringify({ provider: 'community-market' }),
    })
    expect(fetcher.mock.calls[5]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({}),
    })
  })

  it('does not reflect an untrusted error body into its public error', async () => {
    const api = createDesktopSettingsApi(async () => json({ error: '/Users/private/profile failed' }, 400))
    await expect(api.read()).rejects.toThrow('Desktop settings request failed (400)')
    await expect(api.read()).rejects.not.toThrow('/Users/private')
  })
})

describe('Desktop settings section visibility', () => {
  it('keeps every preference group available while unlocked or before the view loads', () => {
    expect(desktopSettingsSectionVisibility(VIEW)).toEqual({
      profile: true,
      market: true,
      presentation: true,
      agentBrowser: false,
    })
    expect(desktopSettingsSectionVisibility(undefined)).toEqual({
      profile: true,
      market: true,
      presentation: true,
      agentBrowser: false,
    })
  })

  it('hides the Profile, Market, and Presentation groups on a company-locked view', () => {
    expect(desktopSettingsSectionVisibility({ ...VIEW, locked: true })).toEqual({
      profile: false,
      market: false,
      presentation: false,
      agentBrowser: false,
    })
  })

  it('keeps the agent-browser login group unreachable until the view proves it allowed (§5.2)', () => {
    // Absent member (policy denies / capability absent) and the unread view
    // both hide the group — unlike the lock-flag groups, this one must stay
    // hidden until positively allowed.
    expect(desktopSettingsSectionVisibility(VIEW).agentBrowser).toBe(false)
    expect(desktopSettingsSectionVisibility(undefined).agentBrowser).toBe(false)
    expect(desktopSettingsSectionVisibility({
      ...VIEW,
      agentBrowser: { allowed: true, persistLogin: false, persisted: false, windowOnPersistPartition: false },
    }).agentBrowser).toBe(true)
  })

  it('validates the agent-browser login projection like the server emits it', () => {
    const agentBrowser = { allowed: true, persistLogin: true, persisted: true, windowOnPersistPartition: false }
    const withAgentBrowser = { ...VIEW, agentBrowser }
    expect(parseDesktopSettingsView(withAgentBrowser)).toEqual(withAgentBrowser)
    expect(parseDesktopSettingsView(VIEW)).not.toHaveProperty('agentBrowser')
    expect(() => parseDesktopSettingsView({ ...VIEW, agentBrowser: { allowed: true, persistLogin: 'yes' } }))
      .toThrow('invalid agent browser settings response')
    expect(parseDesktopAgentBrowserLogin({ accepted: true, persistLogin: true, persisted: true, windowOnPersistPartition: false }))
      .toEqual({ accepted: true, persistLogin: true, persisted: true, windowOnPersistPartition: false })
    expect(() => parseDesktopAgentBrowserLogin({ accepted: true }))
      .toThrow('invalid agent browser login response')
  })

  it('persists and clears the browser login state through the fixed endpoints', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      if (path === desktopSettingsPaths.agentBrowserPersist) {
        return json({ accepted: true, persistLogin: true, persisted: true, windowOnPersistPartition: false })
      }
      return json({ accepted: true, persistLogin: false, persisted: false, windowOnPersistPartition: false })
    })
    const api = createDesktopSettingsApi(fetcher)

    await expect(api.setAgentBrowserPersistLogin(true)).resolves.toEqual({
      accepted: true, persistLogin: true, persisted: true, windowOnPersistPartition: false,
    })
    await expect(api.clearAgentBrowserLogin()).resolves.toEqual({
      accepted: true, persistLogin: false, persisted: false, windowOnPersistPartition: false,
    })
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      desktopSettingsPaths.agentBrowserPersist,
      desktopSettingsPaths.agentBrowserLoginClear,
    ])
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ enabled: true }),
    })
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({}),
    })
  })
})

describe('Desktop settings locked-header styles', () => {
  it('hides every settings header action behind the lock class', () => {
    let css = ''
    const style = {
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove: vi.fn(),
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      getElementById: () => null,
      createElement: () => style,
      head: { appendChild },
    })

    try {
      const dispose = installDesktopSettingsStyles()
      // The upstream slot anchor carries an inline display:contents style, so
      // the locked rule must win the cascade with !important.
      expect(css).toMatch(/html\.dsh-desktop-locked \[data-slot='settings\.action'\] \{ display: none !important; \}/)
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(style.remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Desktop settings Slot registration', () => {
  it('registers the official Desktop section, terminal action, and both settings scopes', () => {
    const scope = {
      getSnapshot: () => ({
        status: 'loading' as const,
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: 'host' as const,
      }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    } satisfies SettingsScope<unknown>
    const bind = vi.fn(() => scope)
    const register = vi.fn(() => () => {})
    const inject = vi.fn((_name: string, mount: () => unknown) => mount())
    const localeRegister = vi.fn(() => () => {})
    const ctx = {
      settingsScope: { bind },
      locale: {
        bind: (namespace: string) => (key: string) => `${namespace}:${key}`,
        register: localeRegister,
      },
      effect: vi.fn(),
      slots: { inject, register },
    } as unknown as ClientContext

    applyDesktopSettings(ctx, { mode: 'compatibility', platform: 'darwin', locked: false })

    expect(bind).toHaveBeenNthCalledWith(1, { namespace: DESKTOP_SHELL_SETTINGS_NAMESPACE })
    expect(bind).toHaveBeenNthCalledWith(2, { namespace: DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE })
    expect(inject).toHaveBeenCalledWith('settings.section', expect.any(Function))
    expect(inject).toHaveBeenCalledWith('settings.action', expect.any(Function))
    const [options, component] = register.mock.calls[0] as unknown as [
      { id: string; order: number; locale: string; label: () => string; inject: () => Record<string, unknown> },
      unknown,
    ]
    expect(options).toMatchObject({
      name: 'settings.section',
      id: 'desktop',
      order: 100,
      locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    })
    expect(options.label()).toBe(`${DESKTOP_SETTINGS_LOCALE_NAMESPACE}:nav`)
    expect(options.inject()).toMatchObject({ platform: 'darwin', initialMode: 'compatibility' })
    expect(component).toBe(DesktopSettingsSection)

    const [actionOptions, actionComponent] = register.mock.calls[1] as unknown as [
      { id: string; order: number; locale: string; inject: () => Record<string, unknown> },
      unknown,
    ]
    expect(actionOptions).toMatchObject({
      name: 'settings.action',
      id: 'open-desktop-terminal',
      order: 1,
      locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    })
    expect(actionOptions.inject()).toHaveProperty('api')
    expect(actionComponent).toBe(DesktopTerminalSettingsAction)

    const [generalItemOptions, generalItemComponent] = register.mock.calls[2] as unknown as [
      { id: string; order: number; locale: string; inject: () => Record<string, unknown> },
      unknown,
    ]
    expect(generalItemOptions).toMatchObject({
      name: 'settings.general.item',
      id: 'desktop-user-info',
      order: -30,
      locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    })
    expect(generalItemOptions.inject()).toHaveProperty('api')
    expect(generalItemComponent).toBe(GeneralUserInfoCard)
  })
})
