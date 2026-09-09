/**
 * Pending-plugin-update prompt inputs derived from one boot verification
 * (P10, extended by P15).
 *
 * Version replacement is a hard cutover: after the signed company manifest
 * re-pins a plugin, the next boot refuses the still-installed old version
 * and the plugin silently disappears until the user reinstalls it. This
 * module turns exactly the class-a rejections (`not-pinned-newer-pinned`:
 * the manifest pins X@new, but old is installed) into visible update
 * guidance — one desktop notification after startup; the market page's
 * update banner derives the same set from its own live authorities.
 *
 * P15 adds the second, softer source: a bundle whose installed version
 * still verifies may carry `updateVersion` (a newer catalog pin this
 * machine's runtime can install — the compatibility-window view). It joins
 * the same prompt, because the user action is the same: open the Plugin
 * Market and update. A third state stays its own notification:
 * `client-update-required` deferrals load on receipt evidence and wait on a
 * desktop client upgrade, so {@link desktopBootClientUpdateNotification}
 * says exactly that instead of pointing at the market.
 *
 * Enforcement is untouched: both derivations only read classifications
 * `verifyDesktopBootBundles` already produced. Revoked, tampered, and every
 * other rejection class never reach either prompt (they stay log-only), so
 * a revocation or integrity refusal can never be presented as "a newer
 * version is waiting".
 */

import type { DesktopBootDeferredUpdate, DesktopBootVerification } from './boot-verification.ts'
import type { DesktopLocale, DesktopNotification } from './runtime.ts'

/** One class-a boot rejection as the update prompt consumes it. */
export interface DesktopBootPendingPluginUpdate {
  readonly packageName: string
  /** Version still installed in the active profile. */
  readonly installedVersion: string
  /** Version the signed company manifest pins (the update target). */
  readonly pinnedVersion: string
}

/**
 * Compare two stable three-segment versions (the catalog only ever pins
 * those). Returns a positive number when a > b, negative when a < b, 0 on
 * equality; a non-parsing pair falls back to string order rather than
 * throwing — the prompt is advisory, never an enforcement point.
 */
function compareStableVersions(a: string, b: string): number {
  const parse = (value: string): number[] | undefined => {
    const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
    return parts === null ? undefined : parts.slice(1).map(Number)
  }
  const va = parse(a)
  const vb = parse(b)
  if (va === undefined || vb === undefined) return a.localeCompare(b)
  for (let i = 0; i < 3; i += 1) {
    const da = va[i]
    const db = vb[i]
    if (da === undefined || db === undefined) return a.localeCompare(b)
    if (da !== db) return da - db
  }
  return 0
}

/**
 * The update-available slice of one boot decision: rejected entries
 * classified `not-pinned-newer-pinned` with both versions present, plus
 * allowed bundles carrying `updateVersion` (P15: the installed version
 * still verifies, a newer runtime-compatible pin is waiting). Every other
 * rejection — revoked, integrity or tree tampering, unresolved,
 * unclassified — is deliberately absent, keeping those classes log-only.
 */
export function pendingDesktopBootPluginUpdates(
  verification: DesktopBootVerification | undefined,
): readonly DesktopBootPendingPluginUpdate[] {
  if (verification === undefined) return []
  const pending: DesktopBootPendingPluginUpdate[] = []
  for (const rejected of verification.rejected) {
    if (rejected.code !== 'not-pinned-newer-pinned') continue
    if (rejected.installedVersion === undefined || rejected.pinnedVersion === undefined) continue
    // Direction check (review P3): the class name promises "newer", but a
    // roster machine leaving the beta overlay (or a re-pinned manifest) can
    // produce pinned < installed. That is an alignment, not an update — stay
    // silent rather than advertising a downgrade as "new".
    if (compareStableVersions(rejected.pinnedVersion, rejected.installedVersion) <= 0) continue
    pending.push({
      packageName: rejected.packageName,
      installedVersion: rejected.installedVersion,
      pinnedVersion: rejected.pinnedVersion,
    })
  }
  for (const bundle of verification.allowed) {
    // P15: the installed version still verifies while a newer
    // runtime-compatible pin waits in the catalog — the same user action
    // (open the market, update) as the class-a rejection. The direction was
    // already decided at classification (semver-newer); the same defensive
    // check keeps a malformed decision from advertising a downgrade.
    if (bundle.updateVersion === undefined || bundle.installedVersion === undefined) continue
    if (compareStableVersions(bundle.updateVersion, bundle.installedVersion) <= 0) continue
    pending.push({
      packageName: bundle.packageName,
      installedVersion: bundle.installedVersion,
      pinnedVersion: bundle.updateVersion,
    })
  }
  return pending
}

/**
 * The one-shot startup notification copy for the pending updates, or
 * undefined when there are none. One plugin names the plugin and its target
 * version; several summarize the count. The copy points at the Plugin
 * Market (where the update banner carries the actual update buttons); the
 * notification itself carries no click action because the desktop has no
 * open-market channel yet.
 */
export function desktopBootPluginUpdateNotification(
  pending: readonly DesktopBootPendingPluginUpdate[],
  locale: DesktopLocale,
): DesktopNotification | undefined {
  if (pending.length === 0) return undefined
  const first = pending[0]!
  if (locale === 'zh') {
    return pending.length === 1
      ? {
          title: '插件有新版本',
          body: `「${first.packageName}」可更新到 ${first.pinnedVersion}，打开插件市场完成更新。`,
        }
      : {
          title: '插件有新版本',
          body: `有 ${pending.length} 个插件可更新，打开插件市场完成更新。`,
        }
  }
  return pending.length === 1
    ? {
        title: 'Plugin update available',
        body: `${first.packageName} can be updated to ${first.pinnedVersion}. Open the Plugin Market to update.`,
      }
    : {
        title: 'Plugin updates available',
        body: `${pending.length} plugins can be updated. Open the Plugin Market to update them.`,
      }
}

/**
 * The deferred `client-update-required` slice of one boot decision (P15,
 * absorbing P12): bundles that loaded on receipt evidence because every
 * remaining catalog pin needs a newer DSH runtime than this build has. The
 * user action differs from a market update — nothing to install there
 * until the desktop client itself upgrades — so this slice never joins
 * {@link pendingDesktopBootPluginUpdates}; it drives its own notification.
 */
export function pendingDesktopBootClientUpdates(
  verification: DesktopBootVerification | undefined,
): readonly DesktopBootDeferredUpdate[] {
  return verification?.deferredUpdates ?? []
}

/**
 * The one-shot startup notification for deferred client updates, or
 * undefined when there are none. One plugin names the waiting version and
 * the runtime it needs; several summarize the count. The copy points at
 * the desktop upgrade, never at the Plugin Market — the market cannot
 * install these versions on this build.
 */
export function desktopBootClientUpdateNotification(
  deferred: readonly DesktopBootDeferredUpdate[],
  locale: DesktopLocale,
): DesktopNotification | undefined {
  if (deferred.length === 0) return undefined
  const first = deferred[0]!
  if (locale === 'zh') {
    return deferred.length === 1
      ? {
          title: '插件新版本需升级客户端',
          body: `「${first.packageName}」的新版本 ${first.availableVersion} 需要 dsh runtime ${first.requiredRuntime}，升级 DSH Desktop 后可用。`,
        }
      : {
          title: '插件新版本需升级客户端',
          body: `有 ${deferred.length} 个插件的新版本需升级 DSH Desktop 后可用。`,
        }
  }
  return deferred.length === 1
    ? {
        title: 'Plugin updates need a newer client',
        body: `A newer ${first.packageName} (${first.availableVersion}) is available after upgrading DSH Desktop (requires dsh runtime ${first.requiredRuntime}).`,
      }
    : {
        title: 'Plugin updates need a newer client',
        body: `${deferred.length} plugins have newer versions available after upgrading DSH Desktop.`,
      }
}
