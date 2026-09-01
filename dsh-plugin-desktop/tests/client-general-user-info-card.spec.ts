import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it } from 'vitest'
import { GeneralUserInfoCardView } from '../src/client/GeneralUserInfoCard.tsx'
import type { DesktopSettingsSsoView } from '../src/client/desktop-settings-api.ts'
import { en, zh, type DesktopSettingsLocaleKey } from '../src/client/desktop-settings-locales.ts'

const SILENT: DesktopSettingsSsoView = {
  authenticated: true,
  email: 'zhangsan@deloitte.com.cn',
  source: 'silent',
}

const BROWSER: DesktopSettingsSsoView = {
  authenticated: true,
  email: 'lisi@deloitte.com.cn',
  source: 'browser',
}

function translate(dict: Record<DesktopSettingsLocaleKey, string>): TranslateNS<'desktop.settings'> {
  return key => dict[key as DesktopSettingsLocaleKey] ?? key
}

describe('General user info card', () => {
  it('renders the full email and auth source with the Chinese copy', () => {
    const markup = renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: SILENT, t: translate(zh) }),
    )
    expect(markup).toContain('用户信息')
    expect(markup).toContain('当前登录')
    expect(markup).toContain('zhangsan@deloitte.com.cn')
    expect(markup).toContain('认证方式')
    expect(markup).toContain('公司单点登录')
    expect(markup).toContain('公司单点登录 · 自动认证')
    expect(markup).toContain('状态')
    expect(markup).toContain('已通过 Deloitte SSO 认证')
  })

  it('maps the browser path to the browser-auth source label', () => {
    const markup = renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: BROWSER, t: translate(zh) }),
    )
    expect(markup).toContain('公司单点登录 · 浏览器认证')
    expect(markup).toContain('lisi@deloitte.com.cn')
  })

  it('renders nothing without an authenticated session', () => {
    expect(renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: undefined, t: translate(zh) }),
    )).toBe('')
    expect(renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: { authenticated: false }, t: translate(zh) }),
    )).toBe('')
  })

  it('uses the English copy when the locale is English', () => {
    const markup = renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: BROWSER, t: translate(en) }),
    )
    expect(markup).toContain('User Info')
    expect(markup).toContain('Signed in as')
    expect(markup).toContain('lisi@deloitte.com.cn')
    expect(markup).toContain('Auth method')
    expect(markup).toContain('Company SSO · Browser')
    expect(markup).toContain('Status')
    expect(markup).toContain('Authenticated via Deloitte SSO')
  })

  it('never truncates the email in markup', () => {
    const markup = renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: SILENT, t: translate(zh) }),
    )
    expect(markup).not.toContain('text-overflow')
    expect(markup).not.toContain('ellipsis')
  })
})
