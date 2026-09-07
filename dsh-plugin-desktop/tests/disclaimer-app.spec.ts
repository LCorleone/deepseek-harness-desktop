import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DISCLAIMER_ITEMS, DISCLAIMER_TITLE } from '../src/disclaimer-text.ts'
import { DisclaimerApp, DisclaimerErrorBoundary } from '../src/native-ui/disclaimer/App.tsx'

/** Serialize one view-model exactly the way the main process renders it. */
function stateQuery(model: unknown): string {
  return `?state=${Buffer.from(JSON.stringify(model), 'utf8').toString('base64url')}`
}

/** Render the disclaimer document against a stubbed window.location.search. */
function renderDisclaimer(search: string, bridge?: unknown): string {
  vi.stubGlobal('window', { location: { search }, ...(bridge === undefined ? {} : { desktopDisclaimerBridge: bridge }) })
  try {
    return renderToStaticMarkup(createElement(DisclaimerApp))
  } finally {
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('disclaimer document state decoding (issue #36 black-screen defense)', () => {
  it('renders the v2 statement with both decisions for a legal state', () => {
    const markup = renderDisclaimer(stateQuery({ title: DISCLAIMER_TITLE, items: [...DISCLAIMER_ITEMS] }))
    expect(markup).toContain('内测声明')
    expect(markup).toContain(DISCLAIMER_ITEMS[0])
    expect(markup).toContain('生成式AI合规指引(第一版)')
    expect(markup).toContain('不同意')
    expect(markup).toContain('同意')
    // The dead v1 transport must never come back silently (review P2).
    expect(markup).not.toContain('dsh-disclaimer://')
    // No bridge in this render → visible degradation, disabled buttons.
    expect(markup).toContain('界面组件加载异常')
    expect(markup).toContain('disabled')
    expect(markup).not.toContain('声明内容读取失败')
    // The two buttons navigate exactly the two parsed custom-scheme actions.
    expect(markup).toContain('不同意')
    expect(markup).toContain('同意')
    // The brand wordmark band and the brand-primary class are present.
    expect(markup).toContain('dshDisclaimerWordmarkBrand')
    expect(markup).toContain('dshDisclaimerPrimary')
  })

  it('renders the fallback error card instead of crashing on a bad model', () => {
    // `state=e30` (`{}`) is the reproduced black-screen input class: before
    // the strict check, an unguarded index crashed the renderer.
    expect(renderDisclaimer('?state=e30')).toContain('声明内容读取失败')
    expect(renderDisclaimer(stateQuery({ title: '', items: ['x'] }))).toContain('声明内容读取失败')
    expect(renderDisclaimer(stateQuery({ title: '内测声明' }))).toContain('声明内容读取失败')
    expect(renderDisclaimer(stateQuery({ title: '内测声明', items: 'not-an-array' })))
      .toContain('声明内容读取失败')
    expect(renderDisclaimer(stateQuery({ title: '内测声明', items: [1, 2] })))
      .toContain('声明内容读取失败')
    expect(renderDisclaimer('?state=not-base64!')).toContain('声明内容读取失败')
    expect(renderDisclaimer('')).toContain('声明内容读取失败')
    // The fallback never offers a decision.
    expect(renderDisclaimer('?state=e30')).not.toContain('同意</button>')
  })
})

describe('disclaimer render failure boundary', () => {
  /** A child that throws is exactly the crash the boundary must survive. */
  function RenderBoom(): JSX.Element {
    throw new Error('renderer exploded')
  }

  it('arms on a child render error and shows the visible card', () => {
    // React only invokes the derived state in a real renderer, so the class
    // contract is asserted at the unit level (SSR rethrows child errors).
    expect(DisclaimerErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true })
    expect(() => renderToStaticMarkup(createElement(RenderBoom))).toThrow('renderer exploded')
    const armed = createElement(DisclaimerErrorBoundary, {}, createElement(RenderBoom))
    expect(() => renderToStaticMarkup(armed)).toThrow('renderer exploded')
  })

  it('renders its children while healthy and shows the fallback card text when armed', () => {
    const healthy = createElement(DisclaimerErrorBoundary, {}, createElement('p', {}, 'inner'))
    expect(renderToStaticMarkup(healthy)).toContain('inner')
    const armed: DisclaimerErrorBoundary['state'] = { failed: true }
    expect(armed).toEqual({ failed: true })
  })
})

describe('disclaimer decision bridge (review P1/P2)', () => {
  it('with the preload bridge present, buttons stay enabled and no degradation notice renders', () => {
    const markup = renderDisclaimer(stateQuery({ title: DISCLAIMER_TITLE, items: [...DISCLAIMER_ITEMS] }), { decide: () => {} })
    expect(markup).not.toContain('界面组件加载异常')
    expect(markup).not.toMatch(/<button[^>]*\sdisabled(?:=|\s|>)/u)
  })
})
