import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts')

/**
 * The #73 half-chain fix has two main.ts mount points. main.ts is the
 * Electron entry with no direct harness, so — exactly like
 * boot-rejection-visibility.spec.ts — the wiring is pinned against the
 * source, while the retry itself and the checkpoint marker flag are
 * unit-tested in profile-materializer.spec.ts and profile-checkpoint.spec.ts.
 */
describe('restored profile dependency synchronization hardening (#73 defect C)', () => {
  const source = readFileSync(MAIN, 'utf8')
  const prepareAt = source.indexOf('const prepared = prepareDesktopProfile(')
  const pendingProbeAt = source.indexOf('profileCheckpoint.dependencySyncPending()')
  const restoreAt = source.indexOf('const restoreProfileCheckpoint = async (')
  const bootAt = source.indexOf('const ctx = await boot(')

  it('mounts the durable pre-boot retry after profile preparation and before the Host boots', () => {
    expect(prepareAt).toBeGreaterThan(-1)
    expect(pendingProbeAt).toBeGreaterThan(prepareAt)
    expect(pendingProbeAt).toBeLessThan(bootAt)
    // The retry clears the pending flag only after a successful re-sync.
    expect(source).toContain('profileCheckpoint.setDependencySyncPending(false)')
  })

  it('retries the materialization and degrades instead of stranding the restore', () => {
    expect(restoreAt).toBeGreaterThan(-1)
    // Retry semantics: the restore path runs the fixed install through the
    // retrying wrapper (two attempts), never the single-shot call.
    expect(source).toContain('await materializeProfileWithRetry(')
    expect(source).not.toContain('await materializeProfile(')
    // Degrade semantics: a failed synchronization marks the restore marker
    // pending instead of denying a restore that already mutated the profile.
    expect(source.indexOf('setDependencySyncPending(true)')).toBeGreaterThan(restoreAt)
    expect(source).toContain('restored profile dependency synchronization failed (attempt ')
  })
})
