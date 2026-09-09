/**
 * P10 pending-plugin-update prompt inputs: the class-a slice of one boot
 * verification drives the startup notification. The red lines pinned here:
 * only `not-pinned-newer-pinned` with both versions reaches the prompt — a
 * revoked or tamper refusal (and the unclassified fallback) must never be
 * presented as "a newer version is waiting" — and the copy names one plugin
 * with its target version, or summarizes the count. P15 adds the
 * allowed-bundle update slice (`updateVersion`: the installed version still
 * verifies, a newer runtime-compatible pin waits) and the separate
 * `client-update-required` deferral notification.
 */

import { describe, expect, it } from 'vitest'
import type { DesktopBootDeferredUpdate, DesktopBootVerification } from '../src/boot-verification.ts'
import {
  desktopBootClientUpdateNotification,
  desktopBootPluginUpdateNotification,
  pendingDesktopBootClientUpdates,
  pendingDesktopBootPluginUpdates,
} from '../src/boot-update-prompt.ts'

const packageName = 'dsh-plugin-safe'

function verification(
  rejected: readonly DesktopBootVerification['rejected'][number][],
  allowed: readonly DesktopBootVerification['allowed'][number][] = [],
  deferredUpdates?: readonly DesktopBootDeferredUpdate[],
): DesktopBootVerification {
  return {
    manifestTrusted: true,
    manifestSequence: 42,
    keyId: 'company-catalog-2026.01',
    manifestFailure: undefined,
    allowed,
    rejected,
    ...(deferredUpdates === undefined ? {} : { deferredUpdates }),
  }
}

const classA = (overrides: Partial<DesktopBootVerification['rejected'][number]> = {}) => ({
  packageName,
  reason: `the signed company manifest pins ${packageName}@1.3.0, but 1.2.3 is installed`,
  code: 'not-pinned-newer-pinned',
  installedVersion: '1.2.3',
  pinnedVersion: '1.3.0',
  ...overrides,
}) as DesktopBootVerification['rejected'][number]

describe('pendingDesktopBootPluginUpdates (P10)', () => {
  it('stays silent when the pinned version is not newer (review P3: downgrade alignment)', () => {
    // A roster machine leaving the beta overlay, or a re-pinned manifest, can
    // produce pinned < installed. The class name promises "newer" — an older
    // pin is an alignment, not an update, and must not be advertised.
    const pending = pendingDesktopBootPluginUpdates(verification([
      classA({ installedVersion: '1.3.0', pinnedVersion: '1.2.3' }),
      classA({ packageName: 'same-pin-plugin', installedVersion: '1.2.3', pinnedVersion: '1.2.3' }),
    ]))
    expect(pending).toEqual([])
  })

  it('lifts exactly the class-a rejections with both versions', () => {
    const pending = pendingDesktopBootPluginUpdates(verification([
      classA(),
      { packageName: 'other-plugin', reason: 'other-plugin is revoked in the signed company manifest', code: 'revoked' },
      {
        packageName: 'tampered-plugin',
        reason: 'the installed files of tampered-plugin@2.0.0 differ from the tree digest pinned in the signed company manifest',
        code: 'tree-mismatch',
      },
      { packageName: 'unclassified-plugin', reason: 'the installed tree of unclassified-plugin could not be measured: boom', code: 'other' },
      { packageName: 'drifting-pin', reason: 'the signed company manifest pins drifting-pin@2.0.0, but 1.0.0 is installed', code: 'not-pinned-newer-pinned', installedVersion: '1.0.0', pinnedVersion: '2.0.0' },
    ]))
    expect(pending).toEqual([
      { packageName, installedVersion: '1.2.3', pinnedVersion: '1.3.0' },
      { packageName: 'drifting-pin', installedVersion: '1.0.0', pinnedVersion: '2.0.0' },
    ])
  })

  it('never turns revoked, tampered, or unclassified rejections into update prompts (red)', () => {
    const pending = pendingDesktopBootPluginUpdates(verification([
      { packageName: 'revoked-plugin', reason: 'revoked-plugin@1.0.0 is revoked in the signed company manifest', code: 'revoked' },
      {
        packageName: 'tampered-plugin',
        reason: 'the profile lockfile pins tampered-plugin@1.0.0 to integrity a, but the signed company manifest pins b',
        code: 'integrity-mismatch',
      },
      {
        packageName: 'tree-plugin',
        reason: 'the installed files of tree-plugin@1.0.0 differ from the tree recorded in its install receipt',
        code: 'tree-mismatch',
      },
      { packageName: 'unresolved-plugin', reason: 'unresolved-plugin cannot be resolved as an installed package in the active profile', code: 'unresolved' },
      { packageName: 'absent-plugin', reason: 'absent-plugin@1.0.0 is not in the signed company manifest', code: 'not-in-manifest' },
      { packageName: 'unpinned-plugin', reason: 'unpinned-plugin@1.0.0 has no exact pinned record in the profile lockfile', code: 'no-lock-integrity' },
      { packageName: 'fallback-plugin', reason: 'the company manifest is not trusted (expired): expired', code: 'other' },
    ]))
    expect(pending).toEqual([])
  })

  it('ignores a class-a entry whose structured versions are missing', () => {
    const pending = pendingDesktopBootPluginUpdates(verification([
      {
        packageName,
        reason: `the signed company manifest pins ${packageName}@1.3.0, but 1.2.3 is installed`,
        code: 'not-pinned-newer-pinned',
      },
    ]))
    expect(pending).toEqual([])
  })

  it('lifts allowed bundles carrying an update target (P15 compatibility window)', () => {
    // The installed version still verifies while a newer runtime-compatible
    // pin waits in the catalog — the same market action as class a, sourced
    // from the allowed slice instead of a rejection.
    const pending = pendingDesktopBootPluginUpdates(verification([], [
      {
        packageName,
        evidence: 'manifest-only',
        manifestSequence: 42,
        keyId: 'company-catalog-2026.01',
        updateVersion: '1.3.0',
        installedVersion: '1.2.3',
      },
    ]))
    expect(pending).toEqual([{ packageName, installedVersion: '1.2.3', pinnedVersion: '1.3.0' }])
  })

  it('stays silent for an allowed update target that is not newer (same defensive direction check)', () => {
    const pending = pendingDesktopBootPluginUpdates(verification([], [
      {
        packageName,
        evidence: 'manifest-only',
        manifestSequence: 42,
        keyId: 'company-catalog-2026.01',
        updateVersion: '1.2.3',
        installedVersion: '1.2.3',
      },
      // A malformed decision without the installed version never prompts.
      {
        packageName: 'broken-decision',
        evidence: 'manifest-only',
        manifestSequence: 42,
        keyId: 'company-catalog-2026.01',
        updateVersion: '2.0.0',
      },
    ]))
    expect(pending).toEqual([])
  })

  it('returns nothing for unlocked boots (no verification) or clean boots', () => {
    expect(pendingDesktopBootPluginUpdates(undefined)).toEqual([])
    expect(pendingDesktopBootPluginUpdates(verification([]))).toEqual([])
  })
})

describe('pendingDesktopBootClientUpdates (P15, absorbing P12)', () => {
  const deferred = [{
    packageName,
    installedVersion: '0.18.1',
    availableVersion: '0.19.0',
    requiredRuntime: '^0.1.3',
  }]

  it('lifts exactly the deferredUpdates slice of the decision', () => {
    expect(pendingDesktopBootClientUpdates(verification([], [], deferred))).toEqual(deferred)
    expect(pendingDesktopBootClientUpdates(verification([
      // A class-a rejection and a deferral are different states: the
      // rejection joins the plugin-update prompt, the deferral stays here.
      classA(),
    ], [], deferred))).toEqual(deferred)
    expect(pendingDesktopBootClientUpdates(verification([]))).toEqual([])
    expect(pendingDesktopBootClientUpdates(undefined)).toEqual([])
  })

  it('never turns a deferral into a market update offer', () => {
    expect(pendingDesktopBootPluginUpdates(verification([], [], deferred))).toEqual([])
  })
})

describe('desktopBootClientUpdateNotification (P15)', () => {
  it('names the waiting version and the runtime it needs in both locales', () => {
    const deferred = [{
      packageName,
      installedVersion: '0.18.1',
      availableVersion: '0.19.0',
      requiredRuntime: '^0.1.3',
    }]
    expect(desktopBootClientUpdateNotification(deferred, 'en')).toEqual({
      title: 'Plugin updates need a newer client',
      body: `A newer ${packageName} (0.19.0) is available after upgrading DSH Desktop (requires dsh runtime ^0.1.3).`,
    })
    expect(desktopBootClientUpdateNotification(deferred, 'zh')).toEqual({
      title: '插件新版本需升级客户端',
      body: `「${packageName}」的新版本 0.19.0 需要 dsh runtime ^0.1.3，升级 DSH Desktop 后可用。`,
    })
  })

  it('summarizes several deferred updates by count', () => {
    const deferred = [
      { packageName, installedVersion: '0.18.1', availableVersion: '0.19.0', requiredRuntime: '^0.1.3' },
      { packageName: 'other-plugin', installedVersion: '0.9.0', availableVersion: '1.0.0', requiredRuntime: '^0.1.3' },
    ]
    expect(desktopBootClientUpdateNotification(deferred, 'en')).toEqual({
      title: 'Plugin updates need a newer client',
      body: '2 plugins have newer versions available after upgrading DSH Desktop.',
    })
    expect(desktopBootClientUpdateNotification(deferred, 'zh')).toEqual({
      title: '插件新版本需升级客户端',
      body: '有 2 个插件的新版本需升级 DSH Desktop 后可用。',
    })
  })

  it('stays silent without deferred updates', () => {
    expect(desktopBootClientUpdateNotification([], 'en')).toBeUndefined()
    expect(desktopBootClientUpdateNotification([], 'zh')).toBeUndefined()
  })
})

describe('desktopBootPluginUpdateNotification (P10)', () => {
  it('names the single plugin and its target version in both locales', () => {
    const pending = [{ packageName, installedVersion: '1.2.3', pinnedVersion: '1.3.0' }]
    expect(desktopBootPluginUpdateNotification(pending, 'en')).toEqual({
      title: 'Plugin update available',
      body: `${packageName} can be updated to 1.3.0. Open the Plugin Market to update.`,
    })
    expect(desktopBootPluginUpdateNotification(pending, 'zh')).toEqual({
      title: '插件有新版本',
      body: `「${packageName}」可更新到 1.3.0，打开插件市场完成更新。`,
    })
  })

  it('summarizes several pending updates by count', () => {
    const pending = [
      { packageName, installedVersion: '1.2.3', pinnedVersion: '1.3.0' },
      { packageName: 'other-plugin', installedVersion: '0.9.0', pinnedVersion: '0.9.1' },
    ]
    expect(desktopBootPluginUpdateNotification(pending, 'en')).toEqual({
      title: 'Plugin updates available',
      body: '2 plugins can be updated. Open the Plugin Market to update them.',
    })
    expect(desktopBootPluginUpdateNotification(pending, 'zh')).toEqual({
      title: '插件有新版本',
      body: '有 2 个插件可更新，打开插件市场完成更新。',
    })
  })

  it('stays silent without pending updates', () => {
    expect(desktopBootPluginUpdateNotification([], 'en')).toBeUndefined()
    expect(desktopBootPluginUpdateNotification([], 'zh')).toBeUndefined()
  })
})
