/**
 * The build identity: upstream-pinned product version + CI build counter as
 * semver build metadata (2026-09-07).
 */
import { describe, expect, it } from 'vitest'
import { desktopBuildVersion, desktopProductVersionBase } from '../src/desktop-build-version.ts'
import { modelUsageClientVersion } from '../src/model-usage-reporter.ts'

describe('desktop build version', () => {
  it('base is the package manifest version (the installer face)', () => {
    expect(desktopProductVersionBase()).toMatch(/^\d+\.\d+\.\d+$/u)
  })

  it('seq 0 (unpackaged) renders the plain version', () => {
    // The committed generated default is 0 — same expectation as dev runs.
    expect(desktopBuildVersion()).toBe(desktopProductVersionBase())
  })

  it('usage telemetry client version carries the same identity', () => {
    expect(modelUsageClientVersion()).toBe(desktopBuildVersion())
  })
})
