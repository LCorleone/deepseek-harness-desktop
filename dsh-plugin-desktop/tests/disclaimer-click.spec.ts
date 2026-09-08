// @vitest-environment jsdom
/**
 * Decision-button wiring proof (full-chain review P1, 2026-09-08):
 * renderToStaticMarkup never fires onClick, so the only two decision buttons
 * in the product had never actually been clicked by a test — the exact
 * #63-class blind spot. Here the real document mounts, real clicks land, and
 * the bridge spy must see exactly the contracted actions.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DISCLAIMER_ITEMS, DISCLAIMER_TITLE } from '../src/disclaimer-text.ts'
import { DESKTOP_DISCLAIMER_BRIDGE } from '../src/disclaimer-contract.ts'
import { DisclaimerApp } from '../src/native-ui/disclaimer/App.tsx'

function stateSearch(): string {
  return `?state=${Buffer.from(JSON.stringify({ title: DISCLAIMER_TITLE, items: [...DISCLAIMER_ITEMS] }), 'utf8').toString('base64url')}`
}

function mountApp(bridge: unknown): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  Object.defineProperty(window, 'location', { value: { search: stateSearch() }, writable: true })
  ;(window as unknown as Record<string, unknown>)[DESKTOP_DISCLAIMER_BRIDGE] = bridge
  return host
}

describe('disclaimer decision buttons → bridge (real clicks)', () => {
  let root: Root | undefined
  afterEach(() => {
    act(() => { root?.unmount() })
    document.body.innerHTML = ''
    delete (window as unknown as Record<string, unknown>)[DESKTOP_DISCLAIMER_BRIDGE]
  })

  it('clicking 同意 delivers decide("agree") through the contracted bridge key', () => {
    const decide = vi.fn()
    const host = mountApp({ decide })
    root = createRoot(host)
    act(() => { root!.render(createElement(DisclaimerApp)) })
    const agree = [...host.querySelectorAll('button')].find(b => b.textContent === '同意')!
    act(() => { agree.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(decide).toHaveBeenCalledWith('agree')
  })

  it('clicking 不同意 delivers decide("disagree")', () => {
    const decide = vi.fn()
    const host = mountApp({ decide })
    root = createRoot(host)
    act(() => { root!.render(createElement(DisclaimerApp)) })
    const disagree = [...host.querySelectorAll('button')].find(b => b.textContent === '不同意')!
    act(() => { disagree.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(decide).toHaveBeenCalledWith('disagree')
  })

  it('pressing Escape delivers decide("disagree") — same semantics as closing the window', () => {
    const decide = vi.fn()
    const host = mountApp({ decide })
    root = createRoot(host)
    act(() => { root!.render(createElement(DisclaimerApp)) })
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(decide).toHaveBeenCalledWith('disagree')
    expect(decide).toHaveBeenCalledTimes(1)
  })

  it('Escape stays silent in the degraded state (bridge missing — matches the disabled buttons)', () => {
    const host = mountApp(undefined)
    root = createRoot(host)
    act(() => { root!.render(createElement(DisclaimerApp)) })
    const spy = vi.fn()
    Object.defineProperty(window, DESKTOP_DISCLAIMER_BRIDGE, { value: { decide: spy }, writable: true })
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    // The handler captured degraded=true at mount; a late bridge must not fire.
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('disclaimer.html static fallback (early render death)', () => {
  it('ships a visible no-JS / no-bundle message inside #root that React replaces on mount', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'native-ui', 'disclaimer.html'), 'utf8')
    const root = html.match(/<div id="root">([\s\S]*?)<\/div>/)![1]!
    expect(root).toContain('<noscript>')
    expect(root).toMatch(/组件加载异常/)
  })

  it('every native window ships the same static bundle-death fallback inside #root', () => {
    for (const name of ['sso-gate', 'recovery', 'profile-create', 'agent-browser'] as const) {
      const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'native-ui', `${name}.html`), 'utf8')
      const root = html.match(/<div id="root">([\s\S]*?)<\/div>/)![1]!
      expect(root, name).toContain('<noscript>')
      expect(root, name).toMatch(/组件加载异常/)
    }
  })
})
