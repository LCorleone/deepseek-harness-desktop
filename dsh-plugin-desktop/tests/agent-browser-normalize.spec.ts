/**
 * Action-normalizer alias matrix (B2 acceptance, design §4): every
 * model-hallucinated alias class the scout-cua lesson validated, mapped onto
 * canonical tool arguments — plus the coercion and purity contracts.
 */

import { describe, expect, it } from 'vitest'
import {
  NORMALIZED_ALIAS_KEYS,
  normalizeBrowserArgs,
} from '../src/agent-browser-normalize.ts'

describe('agent-browser normalizer: click aliases', () => {
  it('maps click_type/left_click/single_click onto the click parameters', () => {
    expect(normalizeBrowserArgs('browser_click', { click_type: 'left_click', element: 'e5' }))
      .toEqual({ tool: 'browser_click', ref: 'e5', button: 'left' })
    expect(normalizeBrowserArgs('browser_click', { left_click: true, ref_id: 'e7' }))
      .toEqual({ tool: 'browser_click', ref: 'e7', button: 'left' })
    expect(normalizeBrowserArgs('browser_click', { single_click: true, node: 'e9' }))
      .toEqual({ tool: 'browser_click', ref: 'e9', button: 'left' })
    expect(normalizeBrowserArgs('browser_click', { clickType: 'right_click', ref: 'e2' }))
      .toEqual({ tool: 'browser_click', ref: 'e2', button: 'right' })
    expect(normalizeBrowserArgs('browser_click', { mouse_button: 'secondary', ref: 'e2' }))
      .toEqual({ tool: 'browser_click', ref: 'e2', button: 'right' })
    expect(normalizeBrowserArgs('browser_click', { middle_click: true, ref: 'e3' }))
      .toEqual({ tool: 'browser_click', ref: 'e3', button: 'middle' })
  })

  it('maps double/triple styles and click_count onto clickCount', () => {
    expect(normalizeBrowserArgs('browser_click', { double_click: true, ref: 'e4' }))
      .toEqual({ tool: 'browser_click', ref: 'e4', button: 'left', clickCount: 2 })
    expect(normalizeBrowserArgs('browser_click', { click_type: 'double', ref: 'e4' }))
      .toEqual({ tool: 'browser_click', ref: 'e4', button: 'left', clickCount: 2 })
    expect(normalizeBrowserArgs('browser_click', { ref: 'e4', click_count: '2' }))
      .toEqual({ tool: 'browser_click', ref: 'e4', clickCount: 2 })
    expect(normalizeBrowserArgs('browser_click', { ref: 'e4', clicks: 3 }))
      .toEqual({ tool: 'browser_click', ref: 'e4', clickCount: 3 })
  })

  it('splits coordinate:[x,y] onto x/y and accepts numeric backendNodeIds as refs', () => {
    expect(normalizeBrowserArgs('browser_click', { coordinate: [120, '240'] }))
      .toEqual({ tool: 'browser_click', ref: undefined, x: 120, y: 240 })
    expect(normalizeBrowserArgs('browser_click', { coordinates: { x: 10, y: 20 } }))
      .toEqual({ tool: 'browser_click', ref: undefined, x: 10, y: 20 })
    // 101 in base36 is 2t — the snapshot walker's ref form.
    expect(normalizeBrowserArgs('browser_click', { element: 101 }))
      .toEqual({ tool: 'browser_click', ref: 'e2t' })
  })

  it('never invents a ref from non-ref shapes', () => {
    expect(normalizeBrowserArgs('browser_click', { element: ['e5'] }).ref).toBeUndefined()
    expect(normalizeBrowserArgs('browser_click', { element: { id: 'e5' } }).ref).toBeUndefined()
    expect(normalizeBrowserArgs('browser_click', { element: 'submit button' }).ref).toBeUndefined()
    expect(normalizeBrowserArgs('browser_click', {}).ref).toBeUndefined()
  })
})

describe('agent-browser normalizer: type aliases', () => {
  it('maps value/content/input/keys onto text and press_enter onto submit', () => {
    expect(normalizeBrowserArgs('browser_type', { element: 'e8', value: 'hello' }))
      .toEqual({ tool: 'browser_type', ref: 'e8', text: 'hello' })
    expect(normalizeBrowserArgs('browser_type', { ref: 'e8', content: 'hi', press_enter: true }))
      .toEqual({ tool: 'browser_type', ref: 'e8', text: 'hi', submit: true })
    expect(normalizeBrowserArgs('browser_type', { ref: 'e8', input: 'hi', submit_form: 'true' }))
      .toEqual({ tool: 'browser_type', ref: 'e8', text: 'hi', submit: true })
    expect(normalizeBrowserArgs('browser_type', { ref: 'e8', text_to_type: 'hi', keys: 'no' }))
      .toEqual({ tool: 'browser_type', ref: 'e8', text: 'hi' })
  })

  it('maps clear_field/replace onto clear', () => {
    expect(normalizeBrowserArgs('browser_type', { ref: 'e8', text: 'x', clear_field: true }))
      .toEqual({ tool: 'browser_type', ref: 'e8', text: 'x', clear: true })
    expect(normalizeBrowserArgs('browser_type', { ref: 'e8', text: 'x', replace: true }))
      .toEqual({ tool: 'browser_type', ref: 'e8', text: 'x', clear: true })
    // "false" strings stay absent, not false.
    expect(normalizeBrowserArgs('browser_type', { ref: 'e8', text: 'x', replace: 'false' }).clear).toBeUndefined()
  })
})

describe('agent-browser normalizer: scroll aliases', () => {
  it('maps scroll_direction/pixels/delta onto direction/amount with coercions', () => {
    expect(normalizeBrowserArgs('browser_scroll', { scroll_direction: 'down', pixels: '600', node_ref: 'e2' }))
      .toEqual({ tool: 'browser_scroll', ref: 'e2', direction: 'down', amount: 600 })
    expect(normalizeBrowserArgs('browser_scroll', { direction: 'up', amount: 300 }))
      .toEqual({ tool: 'browser_scroll', ref: undefined, direction: 'up', amount: 300 })
    expect(normalizeBrowserArgs('browser_scroll', { dir: 'downward', delta: 250 }))
      .toEqual({ tool: 'browser_scroll', ref: undefined, direction: 'down', amount: 250 })
    expect(normalizeBrowserArgs('browser_scroll', { direction: 'sideways', amount: 10 }).direction).toBeUndefined()
  })
})

describe('agent-browser normalizer: url and generation coercion', () => {
  it('prepends https:// to scheme-less urls and lowercases the scheme', () => {
    expect(normalizeBrowserArgs('browser_open', { url: 'example.test/deep/path' }).url)
      .toBe('https://example.test/deep/path')
    expect(normalizeBrowserArgs('browser_navigate', { url: 'HTTP://Example.test/X' }).url)
      .toBe('http://Example.test/X')
    expect(normalizeBrowserArgs('browser_navigate', { url: 'ftp://files.test/' }).url)
      .toBe('ftp://files.test/')
    expect(normalizeBrowserArgs('browser_open', { url: '   ' }).url).toBe('')
  })

  it('coerces stringified generations from canonical and alias keys', () => {
    expect(normalizeBrowserArgs('browser_click', { ref: 'e1', generation: '3' }).generation).toBe(3)
    expect(normalizeBrowserArgs('browser_click', { ref: 'e1', gen: '12' }).generation).toBe(12)
    expect(normalizeBrowserArgs('browser_type', { ref: 'e1', text: 'x', snapshot_generation: 7 }).generation).toBe(7)
    expect(normalizeBrowserArgs('browser_scroll', { direction: 'up', amount: 1, generation_id: '9' }).generation).toBe(9)
    expect(normalizeBrowserArgs('browser_click', { ref: 'e1', gen: 'not-a-number' }).generation).toBeUndefined()
  })
})

describe('agent-browser normalizer: purity and shape discipline', () => {
  it('never mutates the frozen input and leaves canonical calls untouched', () => {
    const input = Object.freeze({ ref: 'e5', generation: 2, button: 'right' as const })
    expect(normalizeBrowserArgs('browser_click', input))
      .toEqual({ tool: 'browser_click', ref: 'e5', generation: 2, button: 'right' })
    expect(input).toEqual({ ref: 'e5', generation: 2, button: 'right' })
  })

  it('degrades to empty canonical shells for non-object input', () => {
    expect(normalizeBrowserArgs('browser_click', undefined)).toEqual({ tool: 'browser_click', ref: undefined })
    expect(normalizeBrowserArgs('browser_type', 'nonsense')).toEqual({ tool: 'browser_type', ref: undefined, text: undefined })
    expect(normalizeBrowserArgs('browser_scroll', ['down'])).toEqual({
      tool: 'browser_scroll',
      ref: undefined,
      direction: undefined,
      amount: undefined,
    })
  })

  it('documents the recognized alias key set', () => {
    expect(NORMALIZED_ALIAS_KEYS).toContain('ref_id')
    expect(NORMALIZED_ALIAS_KEYS).toContain('coordinate')
    expect(NORMALIZED_ALIAS_KEYS).toContain('left_click')
    expect(NORMALIZED_ALIAS_KEYS).toContain('press_enter')
    expect(NORMALIZED_ALIAS_KEYS).toContain('scroll_direction')
    expect(NORMALIZED_ALIAS_KEYS).not.toContain('ref')
    expect(NORMALIZED_ALIAS_KEYS).not.toContain('text')
  })
})
