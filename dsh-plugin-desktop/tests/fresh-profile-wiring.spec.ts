/**
 * P14 wiring pins. `main.ts` is the Electron entry with no direct harness
 * (it boots Electron at import time), so — exactly like
 * profile-restore-hardening.spec.ts and boot-rejection-visibility.spec.ts —
 * the two mount points are pinned against the source. The behavior behind
 * them is unit-tested for real: the trigger decision in
 * fresh-profile.spec.ts (red/green on version change / unchanged / policy
 * off), the swap itself against a real temporary home in the same spec, and
 * the recovery-window action in startup-recovery-window.spec.ts.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts')

describe('fresh Profile swap wiring (P14)', () => {
  const source = readFileSync(MAIN, 'utf8')
  const swapHelperAt = source.indexOf('const runFreshProfileSwap = async (')
  const autoLayerAt = source.indexOf('const freshProfileDecision = freshProfileResetDecision({')
  const bootInputsAt = source.indexOf('const bootVerificationInputs = policy.locked')
  const prepareAt = source.indexOf('const prepared = prepareDesktopProfile(')
  const bootAt = source.indexOf('const ctx = await boot(')

  it('runs the automatic reset early: after profile selection, before boot verification and profile preparation', () => {
    const selectionAt = source.indexOf('profileStartup = beginDesktopProfileStartup(')

    expect(swapHelperAt).toBeGreaterThan(selectionAt)
    expect(autoLayerAt).toBeGreaterThan(swapHelperAt)
    expect(autoLayerAt).toBeLessThan(bootInputsAt)
    expect(autoLayerAt).toBeLessThan(prepareAt)
    expect(autoLayerAt).toBeLessThan(bootAt)
    // The market ledger is cleared inside the awaited swap primitive, which
    // therefore runs before boot verification reads the receipts out of the
    // same settings document.
    const swapCallAt = source.indexOf('const result = await freshProfileSwap({', swapHelperAt)
    expect(swapCallAt).toBeGreaterThan(swapHelperAt)
    expect(source.indexOf('settingsDocumentPath,', swapCallAt)).toBeGreaterThan(swapCallAt)
    expect(swapCallAt).toBeLessThan(bootInputsAt)
  })

  it('gates the automatic layer on the locked policy switch and records the build identity', () => {
    expect(autoLayerAt).toBeGreaterThan(-1)
    expect(source).toContain('resetOnVersionChange: policy.pluginResetOnVersionChange,')
    expect(source).toContain('locked: policy.locked,')
    expect(source).toContain("if (await runFreshProfileSwap('version-change')) {")
    // The record is written only after a successful swap (a failure retries
    // on the next boot) and on the first observation of a build identity.
    const resetAt = source.indexOf("if (await runFreshProfileSwap('version-change')) {")
    expect(source.indexOf('await recordProfileGeneration()', resetAt)).toBeGreaterThan(resetAt)
    expect(source).toContain("} else if (freshProfileDecision === 'record') {\n      await recordProfileGeneration()")
    expect(source).toContain('writeProfileGenerationState(profileGenerationPath, {')
    expect(source).toContain("profileExists: existsSync(join(activeProfileDir, 'package.json')),")
  })

  it('invalidates the rebuilt Profile health checkpoint so a failed boot cannot undo the swap', () => {
    const helper = source.slice(swapHelperAt, autoLayerAt)

    expect(helper).toContain(
      "clearCheckpoint: () => {\n            clearDesktopProfileCheckpoint(app.getPath('userData'), resolveProfileDir(activeProfileName, homeDir))",
    )
  })

  it('mounts the manual action on the recovery window with the token guard and a Host quiesce', () => {
    const manualAt = source.indexOf('freshProfileStart = async (token: string) => {')

    expect(manualAt).toBeGreaterThan(-1)
    expect(source).toContain('token !== recoveryProfileToken || profileRecoveryActionUsed')
    expect(source.indexOf('await generation.quiesceForRecovery()', manualAt)).toBeGreaterThan(manualAt)
    expect(source.indexOf("await runFreshProfileSwap('recovery-window')", manualAt)).toBeGreaterThan(manualAt)
    expect(source).toContain('...(freshProfileStart === undefined ? {} : { freshProfileStart }),')
  })

  it('rebuilds through the shipped first-run mechanism plus the retrying dependency synchronization', () => {
    expect(source).toContain('if (activeProfileName === DESKTOP_PROFILE_NAME) ensureDesktopProfile(homeDir)')
    expect(source).toContain('else createDesktopWebProfile(homeDir, activeProfileName)')
    const freshMaterializerAt = source.indexOf('const materializeFreshProfile = async (')
    expect(freshMaterializerAt).toBeGreaterThan(-1)
    expect(source.indexOf('ensureProfilePnpmBuildApproval(profileDir)', freshMaterializerAt))
      .toBeGreaterThan(freshMaterializerAt)
    expect(source.indexOf('await materializeProfileWithRetry(', freshMaterializerAt))
      .toBeGreaterThan(freshMaterializerAt)
    expect(source).toContain("materialize: () => materializeFreshProfile(resolveProfileDir(activeProfileName, homeDir)),")
  })

  it('reports both layers to the client event table and never lets a failure crash the boot', () => {
    const helper = source.slice(swapHelperAt, autoLayerAt)

    expect(helper).toContain("clientEvents?.pluginReset(pluginResetEvent(trigger, {")
    expect(helper).toContain("outcome: 'swapped'")
    expect(helper).toContain("outcome: 'failed'")
    // A failed rebuild returns false instead of throwing into the startup
    // path it exists to rescue; the recovery window stays the way out.
    expect(helper).toContain('return false')
  })
})
