import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts')

describe('boot verification rejection visibility is mounted', () => {
  // The refusal decision itself is unit-tested in boot-verification.spec.ts;
  // main.ts is the Electron entry with no direct harness, so the log mount is
  // pinned against the source the way window-lifetime-mount.spec.ts does.
  it('logs one error line per refused bundle through electronLogger after the boot verification is consumed', () => {
    const source = readFileSync(MAIN, 'utf8')
    const preparedAt = source.indexOf('const prepared = prepareDesktopProfile(')
    const snapshotAt = source.indexOf('writeDesktopBootVerificationSnapshot(')
    const loopAt = source.indexOf('for (const rejected of prepared.bootVerification?.rejected ?? [])')
    const eventAt = source.indexOf('bootVerifyEvent(prepared.bootVerification)')
    expect(preparedAt).toBeGreaterThan(-1)
    expect(snapshotAt).toBeGreaterThan(preparedAt)
    // The lines ride the same consumption point as the snapshot and the
    // boot_verify telemetry event — after the profile is prepared, before
    // the rest of the boot continues.
    expect(loopAt).toBeGreaterThan(snapshotAt)
    expect(loopAt).toBeLessThan(eventAt)
    // One masked error line per refusal, bounded to package/version/code:
    // the reason text (which can embed profile-dir paths) stays in the
    // diagnostics snapshot, never in the persistent log.
    expect(source).toContain('electronLogger.error(\n        `${BIN_NAME}: boot verification rejected ${rejected.packageName}${version} (code=${rejected.code})`,')
    expect(source.match(/boot verification rejected /gu)).toHaveLength(1)
  })
})
