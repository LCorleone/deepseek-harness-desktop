import { describe, expect, it } from 'vitest'
import { compareStableVersions } from '../src/client/stable-version.js'

describe('compareStableVersions (P2-2)', () => {
  it('orders stable triples numerically, part by part from the major', () => {
    expect(compareStableVersions('1.3.0', '1.2.3')).toBeGreaterThan(0)
    expect(compareStableVersions('0.4.184', '0.4.183')).toBeGreaterThan(0)
    expect(compareStableVersions('1.2.3', '1.3.0')).toBeLessThan(0)
    expect(compareStableVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(compareStableVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareStableVersions('0.0.2', '0.1.0')).toBeLessThan(0)
  })

  it('returns 0 on equality', () => {
    expect(compareStableVersions('0.4.184', '0.4.184')).toBe(0)
    expect(compareStableVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('falls back to string order for non-triple versions instead of throwing (advisory, like the boot side)', () => {
    // The banner gate consumes arbitrary pinned/installed strings; a
    // prerelease or malformed spelling must order somehow, never throw.
    expect(compareStableVersions('1.2.3-beta.1', '1.2.3')).toBe('1.2.3-beta.1'.localeCompare('1.2.3'))
    expect(compareStableVersions('soon', '1.2.3')).toBe('soon'.localeCompare('1.2.3'))
    expect(compareStableVersions('1.2', '1.2.3')).toBe('1.2'.localeCompare('1.2.3'))
  })
})
