import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it } from 'vitest'
import { GeneralUserInfoCardView } from '../src/client/GeneralUserInfoCard.tsx'
import type { DesktopSettingsSsoView } from '../src/client/desktop-settings-api.ts'
import { en, zh, type DesktopSettingsLocaleKey } from '../src/client/desktop-settings-locales.ts'

const AUTHENTICATED: DesktopSettingsSsoView = {
  authenticated: true,
  email: 'zhangsan@deloitte.com.cn',
  source: 'silent',
}

function translate(dict: Record<DesktopSettingsLocaleKey, string>): TranslateNS<'desktop.settings'> {
  return key => dict[key as DesktopSettingsLocaleKey] ?? key
}

describe('General user info row', () => {
  it('renders one Setting-Cell line with the Chinese label and the email', () => {
    const markup = renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: AUTHENTICATED, t: translate(zh) }),
    )
    expect(markup).toContain('当前登录')
    expect(markup).toContain('zhangsan@deloitte.com.cn')
    // One line only: no card title, auth-method, or status copy remains.
    expect(markup).not.toContain('用户信息')
    expect(markup).not.toContain('认证方式')
    expect(markup).not.toContain('状态')
    // Mirrors the General section's owned rows: label on the left, value right.
    expect(markup).toContain('dshGeneralUserInfoRow')
    expect(markup).toContain('dshGeneralUserInfoTitle')
    expect(markup).toContain('dshGeneralUserInfoValue')
  })

  it('renders nothing without an authenticated session', () => {
    expect(renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: undefined, t: translate(zh) }),
    )).toBe('')
    expect(renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: { authenticated: false }, t: translate(zh) }),
    )).toBe('')
  })

  it('uses the English label when the locale is English', () => {
    const markup = renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, { sso: AUTHENTICATED, t: translate(en) }),
    )
    expect(markup).toContain('Signed in as')
    expect(markup).toContain('zhangsan@deloitte.com.cn')
    expect(markup).not.toContain('Auth method')
    expect(markup).not.toContain('Status')
    expect(markup).not.toContain('User Info')
  })

  it('keeps a fallback dash when the session carries no email', () => {
    const markup = renderToStaticMarkup(
      createElement(GeneralUserInfoCardView, {
        sso: { authenticated: true },
        t: translate(zh),
      }),
    )
    expect(markup).toContain('当前登录')
    expect(markup).toContain('—')
  })
})
