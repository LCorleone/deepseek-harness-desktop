import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import { DeloitteBrandName } from '../src/client/DeloitteBrandName.tsx'
import { apply } from '../src/client/index.ts'

/** Apply the client plugin against a compatibility-mode browser context mock. */
function applyDesktopClient(search: string): {
  register: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
} {
  vi.stubGlobal('window', { location: { search } })
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

describe('Deloitte sidebar brand name', () => {
  it('renders both words and the HARNESS badge on the wordmark canvas', () => {
    const markup = renderToStaticMarkup(createElement(DeloitteBrandName))
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('<tspan fill="#86BC25">Deloitte</tspan>')
    expect(markup).toContain('>DeepSeek</tspan>')
    expect(markup).toContain('fill="currentColor"')
    // The badge plate keeps the upstream geometry (rect x=129.348 y=5.5 w=52
    // h=14 rx=2) inside its translating group.
    expect(markup).toMatch(/x="129\.348" y="5\.5" width="52" height="14" rx="2" fill="currentColor"><\/rect>/)
    expect(markup).toContain('var(--dsw-alias-label-primary-inverted)')
    expect(markup).toContain('translate(26.652 0)')
    expect(markup).toContain('deloitte-brand-badge-clip')
  })

  it('pins the live-text advance and shrinks with the host cell', () => {
    const markup = renderToStaticMarkup(createElement(DeloitteBrandName))
    // Width anchor: textLength 124 pins the text advance on the 24-unit grid
    // — right edge x=150, a fixed 6-unit gap before the badge plate at
    // x=156 — so every platform font stops short of the opaque badge
    // regardless of its metrics (DejaVu Sans Bold would otherwise advance
    // ~136 units and slide the tail under the badge). lengthAdjust lets the
    // correction compress or stretch glyphs, and fontFamily mirrors
    // ui-theme's --dsw-font-family so the pin lands on the same font the
    // host would resolve, keeping the correction minimal.
    expect(markup).toContain('textLength="124"')
    expect(markup).toContain('lengthAdjust="spacingAndGlyphs"')
    expect(markup).toMatch(/font-family="-apple-system, BlinkMacSystemFont, &#x27;Segoe UI&#x27;/)
    expect(markup).toContain(', Helvetica, Arial, sans-serif"')
    // Anti-clip: the svg caps at its host cell and scales proportionally
    // (the sidebar minimum 264px leaves a 168px budget, under the 184-unit
    // canvas) instead of letting the cell's overflow:hidden truncate the
    // badge tail.
    expect(markup).toContain('style="max-width:100%;height:auto"')
  })

  it('registers the co-brand into the sidebar name slot for every desktop mode', () => {
    const { register, inject } = applyDesktopClient('?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin')
    expect(inject).toHaveBeenCalledWith('sidebar.brand.name', expect.any(Function))
    const brandCall = register.mock.calls.find(([options]) => (options as { name?: string }).name === 'sidebar.brand.name')
    expect(brandCall).toBeDefined()
    expect(brandCall?.[0]).toEqual({ name: 'sidebar.brand.name', priority: -1 })
    expect(brandCall?.[1]).toBe(DeloitteBrandName)
  })

  it('leaves the slot untouched outside the desktop shell', () => {
    const { register } = applyDesktopClient('')
    expect(register).not.toHaveBeenCalled()
  })

  it('shadows the official occupant through the real slot registry', () => {
    const core = new SlotCore()
    const officialName = (): null => null
    // The declaring component consumes its child render share, satisfying the
    // registry's "declaring is claiming" compile-time check.
    const declareBrandName = (_props: PropsRenderSlots<'sidebar.brand.name'>): null => null
    core.register({
      name: 'root',
      children: { 'sidebar.brand.name': { kind: 'single', scope: 'root' } },
    }, declareBrandName)
    // The official brand plugin fills the cell at the default priority 0;
    // registering there again would throw, so the desktop occupant must take
    // a lower rank — and the registry renders the cell's lowest entry.
    core.register({ name: 'sidebar.brand.name' }, officialName)
    core.register({ name: 'sidebar.brand.name', priority: -1 }, DeloitteBrandName)
    const winner = core.entriesOfSlot('sidebar.brand.name')[0]
    expect(winner?.component).toBe(DeloitteBrandName)
    expect(core.entries('sidebar.brand.name')).toHaveLength(2)
  })
})
