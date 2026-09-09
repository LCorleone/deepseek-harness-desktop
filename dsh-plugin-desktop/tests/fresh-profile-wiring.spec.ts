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
    // The switch picks the rule; the base product version always rides along
    // so the off posture ignores a build-counter-only change.
    expect(source).toContain("const resetRule: 'forced' | 'version' = policy.pluginResetOnVersionChange === true ? 'forced' : 'version'")
    expect(source).toContain('previousAppVersion: storedProfileGeneration.appVersion,')
    // The record is written only after a successful swap (a deferred or
    // failed rebuild retries on the next boot) and on the first observation
    // of a build identity. Pin the AUTOMATIC layer's swap call, not the
    // earlier deferred-retry one.
    const autoResetAt = source.indexOf("if (await runFreshProfileSwap('version-change', resetRule) === 'swapped') {", autoLayerAt)
    expect(autoResetAt).toBeGreaterThan(autoLayerAt)
    expect(source.indexOf('await recordProfileGeneration()', autoResetAt)).toBeGreaterThan(autoResetAt)
    expect(source).toContain("} else if (freshProfileDecision === 'record') {\n      await recordProfileGeneration()")
    expect(source).toContain('writeProfileGenerationState(profileGenerationPath, {')
    expect(source).toContain("const profileExists = existsSync(join(activeProfileDir, 'package.json'))")
    expect(source).toContain('profileExists,')
  })

  it('drops a residual market ledger only when the recorded Profile had no manifest', () => {
    const recordAt = source.indexOf("} else if (freshProfileDecision === 'record') {", autoLayerAt)
    expect(recordAt).toBeGreaterThan(autoLayerAt)
    const recordBody = source.slice(recordAt, source.indexOf('startupRecoveryConfigurationPaths', recordAt))
    // The manifest fact, captured before the decision, is the only gate — the
    // decision string also reads 'record' for a Profile that still has
    // plugins, and clearing there would hide real installs.
    expect(recordBody).toContain('await clearFreshProfileRecordReceipts({')
    expect(recordBody).toContain('profileExists,')
    expect(recordBody).toContain("settingsDocumentPath: join(homeDir, 'settings.yaml'),")
    expect(recordBody).toContain('profileName: activeProfileName,')
  })

  it('gates the record-branch ledger clear on the absence of a restorable checkpoint snapshot (review P2)', () => {
    const recordAt = source.indexOf("} else if (freshProfileDecision === 'record') {", autoLayerAt)
    const recordBody = source.slice(recordAt, source.indexOf('startupRecoveryConfigurationPaths', recordAt))
    // The clear runs before the boot\'s failure path may restore a healthy
    // checkpoint; a restorable snapshot resurrects the very bundles the
    // receipts prove, so the probe result must ride into the clear.
    expect(recordBody).toContain('profileCheckpoint.inspectRestore().snapshotExists')
    expect(recordBody).toContain('restoreSnapshotExists,')
    // The probe itself must not be able to fail the boot: an unreadable
    // checkpoint is logged and treated as no snapshot (the restore reads the
    // same store and would fail the same validation).
    expect(recordBody).toContain('} catch (cause) {')
    expect(recordBody).toContain('healthy profile snapshot probe failed before receipt clearing')
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

  it('tells the recovery window a deferred manual swap completes after restart instead of failing', () => {
    const manualAt = source.indexOf('freshProfileStart = async (token: string) => {')
    const outcomeAt = source.indexOf("const outcome = await runFreshProfileSwap('recovery-window')", manualAt)
    const manualEnd = source.indexOf("startupStage = 'host-boot'", outcomeAt)

    expect(outcomeAt).toBeGreaterThan(manualAt)
    expect(manualEnd).toBeGreaterThan(outcomeAt)
    const outcomeBody = source.slice(outcomeAt, manualEnd)
    expect(outcomeBody).toContain("outcome === 'deferred'")
    expect(outcomeBody).toContain('will complete automatically after DSH Desktop restarts')
    expect(outcomeBody).toContain("outcome === 'failed'")
  })

  it('clears a satisfied deferred marker and records the build when the manual swap lands (review P2)', () => {
    const manualAt = source.indexOf('freshProfileStart = async (token: string) => {')
    const outcomeAt = source.indexOf("const outcome = await runFreshProfileSwap('recovery-window')", manualAt)
    const manualEnd = source.indexOf("startupStage = 'host-boot'", outcomeAt)
    // The success tail (everything after the deferred and failed refusals):
    // a manual swap that landed must satisfy a pending marker for THIS
    // Profile and record the build identity, or the next startup repeats a
    // whole swap the user already performed by hand.
    const successTail = source.slice(source.indexOf("outcome === 'failed'", outcomeAt), manualEnd)
    expect(successTail).toContain('readFreshProfilePending(freshProfilePendingPath)?.profileName === activeProfileName')
    expect(successTail).toContain('clearFreshProfilePending(freshProfilePendingPath)')
    expect(successTail.indexOf('clearFreshProfilePending(freshProfilePendingPath)'))
      .toBeGreaterThan(successTail.indexOf('readFreshProfilePending(freshProfilePendingPath)'))
    expect(successTail).toContain('await recordProfileGeneration()')
  })

  it('persists the deferring layer and rule in the marker and replays them on the retry (P3-c)', () => {
    const deferredAt = source.indexOf('if (result.deferred === true) {')
    const deferredBody = source.slice(deferredAt, source.indexOf("return 'deferred'", deferredAt))
    // The marker records WHO deferred, so the retry telemetry reports the
    // real layer and rule instead of a blind version-change.
    expect(deferredBody).toContain('await writeFreshProfilePending(freshProfilePendingPath, {')
    expect(deferredBody).toContain('trigger,')
    expect(deferredBody).toContain('...(rule === undefined ? {} : { rule }),')

    const pendingActionAt = source.indexOf('const pendingFreshProfileAction = pendingFreshProfileReset === undefined')
    const retryAt = source.indexOf('if (await runFreshProfileSwap(retryTrigger, retryRule) === \'swapped\') {', pendingActionAt)
    const retryBody = source.slice(pendingActionAt, retryAt)
    // Old markers default to the historical trigger and carry no rule.
    expect(retryBody).toContain("const retryTrigger = pendingFreshProfileReset.trigger ?? 'version-change'")
    expect(retryBody).toContain('const retryRule = pendingFreshProfileReset.rule')
    expect(retryBody.indexOf('const retryTrigger')).toBeLessThan(retryBody.indexOf('const retryRule'))
    expect(retryBody.indexOf('const retryRule')).toBeLessThan(retryBody.length)
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
    // A failed rebuild returns an outcome instead of throwing into the
    // startup path it exists to rescue; the recovery window stays the way out.
    expect(helper).toContain("return 'failed'")
  })

  it('reads the deferred marker before the pnpm runtime and any Profile read, then retries before the automatic layer', () => {
    const markerReadAt = source.indexOf('const pendingFreshProfileReset = readFreshProfilePending(freshProfilePendingPath)')
    const pnpmRuntimeAt = source.indexOf('const pnpmRuntime = installDesktopPnpmRuntime({')
    const selectionAt = source.indexOf('profileStartup = beginDesktopProfileStartup(')
    const pendingActionAt = source.indexOf('const pendingFreshProfileAction = pendingFreshProfileReset === undefined')

    expect(markerReadAt).toBeGreaterThan(-1)
    // The marker is the only thing read this early: it lives in userData, so
    // the retry can fire before the runtime install or any profile file.
    expect(markerReadAt).toBeLessThan(pnpmRuntimeAt)
    expect(markerReadAt).toBeLessThan(selectionAt)
    expect(pendingActionAt).toBeGreaterThan(swapHelperAt)
    expect(pendingActionAt).toBeLessThan(autoLayerAt)
    // The retry branch is the only place the deferred rename is attempted,
    // and it clears the marker and records the build identity only after the
    // swap landed (the slice ends at the branch's own finally block). The
    // call threads the marker's own trigger/rule (P3-c), never a hardcoded
    // layer, so the retry telemetry reports who actually deferred.
    const retryAt = source.indexOf('if (await runFreshProfileSwap(retryTrigger, retryRule) === \'swapped\') {', pendingActionAt)
    expect(retryAt).toBeGreaterThan(pendingActionAt)
    expect(retryAt).toBeLessThan(autoLayerAt)
    const retryBody = source.slice(retryAt, source.indexOf('} finally {', retryAt))
    expect(retryBody).toContain('clearFreshProfilePending(freshProfilePendingPath)')
    expect(retryBody).toContain('await recordProfileGeneration()')
    // The automatic layer cannot fire a second rename after the deferred retry.
    expect(source).toContain("if (freshProfileDecision === 'reset' && !pendingFreshProfileHandled) {")
  })

  it('keeps a marker for another Profile and drops it only when the policy is unlocked (review P1-b)', () => {
    const pendingActionAt = source.indexOf('const pendingFreshProfileAction = pendingFreshProfileReset === undefined')
    const dropAt = source.indexOf("pendingFreshProfileAction === 'drop'", pendingActionAt)
    const keepAt = source.indexOf("pendingFreshProfileAction === 'keep'", pendingActionAt)
    const retryAt = source.indexOf('if (await runFreshProfileSwap(retryTrigger, retryRule) === \'swapped\') {', pendingActionAt)

    // The keep/drop gate is the policy LOCK alone: with the version switch off
    // the automatic layer still resets on a product-version change, so a
    // marker for a non-active Profile must survive the boot.
    const gateAt = source.indexOf('const freshProfileResetMarkerPolicyLocked = policy.locked === true')
    expect(gateAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(pendingActionAt)
    expect(source.slice(gateAt, pendingActionAt)).not.toContain('pluginResetOnVersionChange')
    expect(source).toContain('policyLocked: freshProfileResetMarkerPolicyLocked,')

    expect(dropAt).toBeGreaterThan(pendingActionAt)
    expect(keepAt).toBeGreaterThan(dropAt)
    expect(retryAt).toBeGreaterThan(keepAt)
    // The keep branch logs and leaves the marker file alone — no clear.
    expect(source.slice(keepAt, retryAt)).not.toContain('clearFreshProfilePending')
    // The drop branch is the only non-retry clear of the marker.
    expect(source.slice(dropAt, keepAt)).toContain('clearFreshProfilePending(freshProfilePendingPath)')
  })

  it('holds a visible loading surface for the deferred retry instead of waiting silently', () => {
    const pendingActionAt = source.indexOf('const pendingFreshProfileAction = pendingFreshProfileReset === undefined')
    const surfaceAt = source.indexOf('await retrySurface.openLoadingSurface()', pendingActionAt)
    const retryAt = source.indexOf('if (await runFreshProfileSwap(retryTrigger, retryRule) === \'swapped\') {', pendingActionAt)

    expect(surfaceAt).toBeGreaterThan(pendingActionAt)
    expect(surfaceAt).toBeLessThan(retryAt)
    const finallyAt = source.indexOf('} finally {', retryAt)
    expect(finallyAt).toBeGreaterThan(retryAt)
    expect(source.indexOf('if (retrySurfaceOwned) disposeDisclaimerLoading()', finallyAt)).toBeGreaterThan(finallyAt)
  })

  it('writes the marker and reports outcome deferred when the retry is still locked, recording no build identity', () => {
    const deferredAt = source.indexOf('if (result.deferred === true) {')
    expect(deferredAt).toBeGreaterThan(swapHelperAt)
    expect(source.indexOf('await writeFreshProfilePending(freshProfilePendingPath, {', deferredAt)).toBeGreaterThan(deferredAt)
    // The marker's schema version comes from the module constant, never a
    // hardcoded literal that can drift from the reader (review P3-2).
    expect(source.indexOf('version: FRESH_PROFILE_PENDING_VERSION,', deferredAt)).toBeGreaterThan(deferredAt)
    expect(source.indexOf("outcome: 'deferred'", deferredAt)).toBeGreaterThan(deferredAt)
    const deferredEnd = source.indexOf("return 'deferred'", deferredAt)
    expect(deferredEnd).toBeGreaterThan(deferredAt)
    // The version record stays unwritten on the deferred path, so the next
    // boot still sees a version change to retry.
    expect(source.slice(deferredAt, deferredEnd)).not.toContain('recordProfileGeneration')
  })
})
