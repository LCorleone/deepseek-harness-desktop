import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SsoGateApp, SsoGateErrorBoundary, SsoGateRenderFailure } from '../src/native-ui/sso-gate/App.tsx'

/** Serialize one view-model exactly the way the main process renders it. */
function stateQuery(model: unknown): string {
  return `?state=${Buffer.from(JSON.stringify(model), 'utf8').toString('base64url')}`
}

/** Render the gate document against a stubbed window.location.search. */
function renderGate(search: string): string {
  vi.stubGlobal('window', { location: { search } })
  try {
    return renderToStaticMarkup(createElement(SsoGateApp))
  } finally {
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sso gate document state decoding (issue #36 black-screen defense)', () => {
  it('renders the sign-in card for a legal state', () => {
    const markup = renderGate(stateQuery({ locale: 'en', phase: 'ready' }))
    expect(markup).toContain('Deloitte DSH Desktop Sign In')
    expect(markup).toContain('Sign in with Browser')
    expect(markup).not.toContain('The sign-in state could not be read')
    const zh = renderGate(stateQuery({ locale: 'zh', phase: 'waiting', errorDetail: '认证码已被使用' }))
    expect(zh).toContain('重试浏览器登录')
    expect(zh).toContain('认证码已被使用')
  })

  it('renders the fallback error card instead of crashing on a bad locale', () => {
    // `state=e30` (`{}`) is the reproduced black-screen input: before the
    // strict check, COPY[undefined] threw inside the render.
    const empty = renderGate('?state=e30')
    expect(empty).toContain('The sign-in state could not be read')
    const badLocale = renderGate(stateQuery({ locale: 'fr', phase: 'ready' }))
    expect(badLocale).toContain('The sign-in state could not be read')
    expect(badLocale).not.toContain('Sign in with Browser')
  })

  it('renders the fallback error card on a bad phase or non-string errorDetail', () => {
    expect(renderGate(stateQuery({ locale: 'en', phase: 'booting' })))
      .toContain('The sign-in state could not be read')
    expect(renderGate(stateQuery({ locale: 'en', phase: 'ready', errorDetail: 123 })))
      .toContain('The sign-in state could not be read')
    expect(renderGate('?state=not-base64!')).toContain('The sign-in state could not be read')
    expect(renderGate('')).toContain('The sign-in state could not be read')
  })
})

describe('sso gate render failure boundary', () => {
  /** A child that throws is exactly the crash the boundary must survive. */
  function RenderBoom(): JSX.Element {
    throw new Error('renderer exploded')
  }

  it('arms on a child render error and shows the visible card in each locale', () => {
    // A child render error derives the failed state — the React contract the
    // boundary relies on instead of escaping to the root.
    expect(SsoGateErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true })
    const derived: SsoGateErrorBoundary['state'] = { failed: true }
    // The armed boundary renders the quit-and-restart card, never a blank
    // window. React only invokes the derived state in a real renderer, so the
    // class contract is asserted at the unit level (SSR rethrows child errors).
    expect(() => renderToStaticMarkup(createElement(RenderBoom))).toThrow('renderer exploded')
    const en = new SsoGateErrorBoundary({})
    en.state = derived
    expect(renderToStaticMarkup(en.render() as JSX.Element))
      .toContain('Sign-in window failed to render. Quit and start again.')
    vi.stubGlobal('window', { location: { search: stateQuery({ locale: 'zh', phase: 'ready' }) } })
    const zh = new SsoGateErrorBoundary({})
    zh.state = derived
    expect(renderToStaticMarkup(zh.render() as JSX.Element))
      .toContain('登录窗口渲染失败，请退出后重新启动。')
    vi.unstubAllGlobals()
  })

  it('falls back to English when the boundary locale cannot be read', () => {
    // The pass-through branch keeps children; the fallback card itself is
    // locale-aware, defaulting to English for any malformed state.
    expect(renderToStaticMarkup(createElement(SsoGateRenderFailure, { locale: 'zh' })))
      .toContain('登录窗口渲染失败，请退出后重新启动。')
    vi.stubGlobal('window', { location: { search: stateQuery({ locale: 'fr', phase: 'ready' }) } })
    const gate = new SsoGateErrorBoundary({})
    gate.state = { failed: true }
    expect(renderToStaticMarkup(gate.render() as JSX.Element))
      .toContain('Sign-in window failed to render. Quit and start again.')
  })
})
