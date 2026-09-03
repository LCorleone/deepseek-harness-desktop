/**
 * Agent-browser window UI (B2): the zero-injection overlay draws the
 * executor-known cursor and click highlight from pushed coordinates, and the
 * toolbar carries the claim/release entry points of the §5.4 state machine.
 * Static rendering over the exported components keeps the window document
 * testable without an Electron display.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentBrowserOverlayState, AgentBrowserViewModel } from '../src/agent-browser-contract.ts'
import { AgentBrowserToolbar } from '../src/native-ui/agent-browser/App.tsx'
import {
  AGENT_BROWSER_CLICK_RING_MS,
  AgentBrowserOverlay,
} from '../src/native-ui/agent-browser/Overlay.tsx'

function viewModel(overrides: Partial<AgentBrowserViewModel> = {}): AgentBrowserViewModel {
  return {
    url: 'https://example.test/',
    title: 'Example',
    phase: 'observing',
    generation: 3,
    partition: 'dsh-agent-browser-token',
    ...overrides,
  }
}

describe('agent-browser overlay (zero page injection)', () => {
  it('draws the cursor dot and the fresh click ring at the pushed coordinates', () => {
    const clickedAt = 1_000
    const overlay: AgentBrowserOverlayState = {
      cursor: { x: 120, y: 80 },
      click: { x: 120, y: 80 },
      clickedAt,
    }
    const markup = renderToStaticMarkup(createElement(AgentBrowserOverlay, {
      overlay,
      now: () => clickedAt + 100,
    }))

    expect(markup).toContain('data-overlay-cursor')
    expect(markup).toContain('data-overlay-click')
    expect(markup).toContain('left:120px')
    expect(markup).toContain('top:80px')
    // The layer never intercepts pointer events — the human's mouse must
    // reach the guest through it.
    expect(markup).toContain('pointer-events-none')
  })

  it('fades the click ring after the ring window and hides it without a click', () => {
    const expired = renderToStaticMarkup(createElement(AgentBrowserOverlay, {
      overlay: { cursor: { x: 10, y: 10 }, click: { x: 10, y: 10 }, clickedAt: 1_000 },
      now: () => 1_000 + AGENT_BROWSER_CLICK_RING_MS + 1,
    }))
    expect(expired).toContain('data-overlay-cursor')
    expect(expired).not.toContain('data-overlay-click')

    const quiet = renderToStaticMarkup(createElement(AgentBrowserOverlay, {
      overlay: { cursor: { x: 10, y: 10 } },
      now: () => 5_000,
    }))
    expect(quiet).not.toContain('data-overlay-click')
    expect(quiet).toContain('data-agent-browser-overlay="cursor-on"')

    const empty = renderToStaticMarkup(createElement(AgentBrowserOverlay, { overlay: undefined, now: () => 0 }))
    expect(empty).toContain('cursor-off')
    expect(empty).not.toContain('data-overlay-cursor')
  })
})

describe('agent-browser toolbar claim/release entry points (§5.4)', () => {
  it('offers Claim control while the agent drives and Release control once claimed', () => {
    const onClaim = vi.fn()
    const onRelease = vi.fn()
    const idle = renderToStaticMarkup(createElement(AgentBrowserToolbar, {
      state: viewModel({ phase: 'observing' }),
      onClaim,
      onRelease,
      onClose: () => {},
    }))
    expect(idle).toContain('Claim control')
    expect(idle).toContain('data-claim-button="claim"')
    expect(idle).not.toContain('Release control')

    const claimed = renderToStaticMarkup(createElement(AgentBrowserToolbar, {
      state: viewModel({ phase: 'claimed', generation: 4 }),
      onClaim,
      onRelease,
      onClose: () => {},
    }))
    expect(claimed).toContain('Release control')
    expect(claimed).toContain('data-claim-button="release"')
    expect(claimed).not.toContain('>Claim control<')
    expect(claimed).toContain('generation 4 · claimed')
  })

  it('keeps the claim button inert until the host pushed its first view model', () => {
    const markup = renderToStaticMarkup(createElement(AgentBrowserToolbar, {
      state: undefined,
      onClaim: () => {},
      onRelease: () => {},
      onClose: () => {},
    }))
    expect(markup).toContain('disabled')
    expect(markup).toContain('No page opened yet')
  })
})
