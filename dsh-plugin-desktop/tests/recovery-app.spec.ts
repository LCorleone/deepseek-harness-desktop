/**
 * Recovery assistant document (React half of the recovery window, P14): the
 * fresh-Profile action and its confirmation must render from the same
 * view-model fields the main process sends, in both locales. The no-script
 * HTML renderer is covered in startup-recovery-window.spec.ts.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecoveryApp } from '../src/native-ui/recovery/App.tsx'

/** Serialize one view-model exactly the way the main process renders it. */
function stateQuery(model: unknown): string {
  return `?state=${Buffer.from(JSON.stringify(model), 'utf8').toString('base64url')}`
}

function renderRecovery(state: Record<string, unknown>): string {
  vi.stubGlobal('window', { location: { search: stateQuery(state) } })
  vi.stubGlobal('document', { title: '' })
  try {
    return renderToStaticMarkup(createElement(RecoveryApp))
  } finally {
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const BASE = {
  failureStage: 'host-boot',
  failureDetail: 'a plugin broke the Host',
  diagnostics: { status: 'saved', filename: 'diagnostics.zip' },
  busy: false,
  restartReady: false,
  configurationAvailable: false,
} as const

describe('recovery assistant fresh-Profile action', () => {
  it('offers the action with the consequence copy when main provides the token', () => {
    const markup = renderRecovery({
      ...BASE,
      locale: 'zh',
      freshProfileStartAvailable: true,
      profileActionToken: 'opaque-token-0001',
    })

    expect(markup).toContain('全新配置启动')
    expect(markup).toContain('移除其中已安装的全部第三方插件')
    expect(markup).toContain('对话记录、设置和登录状态不受影响')
    expect(markup).toContain('dsh-recovery://preview-fresh-profile?id=opaque-token-0001')
  })

  it('stays absent without the capability or the token', () => {
    expect(renderRecovery({ ...BASE, locale: 'zh', profileActionToken: 'opaque-token-0001' }))
      .not.toContain('dsh-recovery://preview-fresh-profile')
    expect(renderRecovery({ ...BASE, locale: 'zh', freshProfileStartAvailable: true }))
      .not.toContain('dsh-recovery://preview-fresh-profile')
  })

  it('renders the confirmation card in both locales with the confirm action', () => {
    const confirmation = { kind: 'fresh-profile', token: 'opaque-token-0001' }
    const zh = renderRecovery({ ...BASE, locale: 'zh', confirmation })

    expect(zh).toContain('确认全新配置启动？')
    expect(zh).toContain('第三方插件会被全部移除')
    expect(zh).toContain('dsh-recovery://confirm-fresh-profile?id=opaque-token-0001')
    expect(zh).toContain('dsh-recovery://home')

    const en = renderRecovery({ ...BASE, locale: 'en', confirmation })
    expect(en).toContain('Start with a fresh Profile?')
    expect(en).toContain('Conversations, settings, and sign-in are unaffected')
    expect(en).toContain('dsh-recovery://confirm-fresh-profile?id=opaque-token-0001')
  })
})
