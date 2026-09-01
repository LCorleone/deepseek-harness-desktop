import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { SsoAccountBadge, ssoAccountBadgeOccupant } from '../src/client/SsoAccountBadge.tsx'
import { apply } from '../src/client/index.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'

/** Apply the client plugin against a compatibility-mode browser context mock. */
function applyDesktopClient(search: string): {
  register: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
} {
  vi.stubGlobal('window', { location: { search } })
  vi.stubGlobal('document', { documentElement: { classList: { add: vi.fn() } } })
  const register = vi.fn(() => () => {})
  const inject = vi.fn((_name: string, mount: () => unknown) => mount())
  const ctx = {
    settingsScope: { bind: vi.fn() },
    locale: { bind: vi.fn(() => (key: string) => key), register: vi.fn(() => () => {}) },
    effect: vi.fn(),
    slots: { inject, register },
  } as unknown as ClientContext

  try {
    apply(ctx)
    return { register, inject }
  }
  finally {
    vi.unstubAllGlobals()
  }
}

describe('desktop client environment account marker', () => {
  it('parses a validated account email beside the mode markers', () => {
    const environment = parseDesktopClientEnvironment(
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-locked=1&dsh-desktop-account=zhangsan%40deloitte.com.cn',
    )
    expect(environment).toEqual({
      mode: 'compatibility',
      platform: 'win32',
      locked: true,
      account: 'zhangsan@deloitte.com.cn',
    })
  })

  it('keeps every unauthenticated URL exactly as before', () => {
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin'))
      .toEqual({ mode: 'advanced', platform: 'darwin', locked: false })
    expect(parseDesktopClientEnvironment('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-locked=1'))
      .toEqual({ mode: 'advanced', platform: 'darwin', locked: true })
    expect(parseDesktopClientEnvironment('')).toBeUndefined()
  })

  it('fails loud on a corrupted account spelling', () => {
    expect(() => parseDesktopClientEnvironment(
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-account=not-an-email',
    )).toThrow('invalid dsh-desktop-account')
    expect(() => parseDesktopClientEnvironment(
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-account=x%40y%2Ez%0A',
    )).toThrow('invalid dsh-desktop-account')
  })
})

describe('sso account badge registration gating', () => {
  it('registers the footer occupant only for an authenticated desktop URL', () => {
    const { register, inject } = applyDesktopClient(
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-locked=1&dsh-desktop-account=zhangsan%40deloitte.com.cn',
    )
    expect(inject).toHaveBeenCalledWith('sidebar.footer.action', expect.any(Function))
    const badgeCall = register.mock.calls.find(([options]) => (options as { name?: string }).name === 'sidebar.footer.action')
    // List-kind slot: unique id, default priority, no brand-slot rank games.
    expect(badgeCall?.[0]).toEqual({ name: 'sidebar.footer.action', id: 'dsh-desktop-sso-account' })
    const occupant = badgeCall?.[1] as (props: { wide: boolean }) => string
    expect(renderToStaticMarkup(createElement(occupant, { wide: true })))
      .toContain('zhangsan@deloitte.com.cn')
  })

  it('leaves the footer slot untouched without an account marker', () => {
    const { register } = applyDesktopClient('?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-locked=1')
    expect(register.mock.calls.some(([options]) => (options as { name?: string }).name === 'sidebar.footer.action'))
      .toBe(false)
  })

  it('leaves the footer slot untouched outside the desktop shell', () => {
    const { register } = applyDesktopClient('')
    expect(register).not.toHaveBeenCalled()
  })
})

describe('sso account badge presentation', () => {
  it('renders the full email as muted text in the wide column', () => {
    const markup = renderToStaticMarkup(
      createElement(SsoAccountBadge, { wide: true, email: 'zhangsan@deloitte.com.cn' }),
    )
    expect(markup).toContain('zhangsan@deloitte.com.cn')
    expect(markup).toContain('title="zhangsan@deloitte.com.cn"')
    expect(markup).toContain('text-overflow:ellipsis')
    expect(markup).toContain('white-space:nowrap')
  })

  it('renders a compact glyph with the email as its label in the collapsed rail', () => {
    const markup = renderToStaticMarkup(
      createElement(SsoAccountBadge, { wide: false, email: 'zhangsan@deloitte.com.cn' }),
    )
    expect(markup).toContain('<svg')
    expect(markup).toContain('aria-label="zhangsan@deloitte.com.cn"')
    // The only email occurrence lives inside the accessibility label and the
    // svg <title>; the glyph itself is the visible content.
    expect(markup).not.toContain('text-overflow')
  })

  it('builds a stable occupant component per account', () => {
    const occupant = ssoAccountBadgeOccupant('a@deloitte.com.cn')
    expect(renderToStaticMarkup(createElement(occupant, { wide: true }))).toContain('a@deloitte.com.cn')
    expect(renderToStaticMarkup(createElement(occupant, { wide: false }))).toContain('<svg')
  })
})
