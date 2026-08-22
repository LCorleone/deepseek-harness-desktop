import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import {
  registerMarketRoutes,
  registerMarketSettings,
  type MarketDesktopPlugins,
} from './host/routes.js'
import { createRestrictedHttpClient } from './network/restricted-http.js'
import {
  createNpmRegistryVerifier,
  MarketInstallService,
  rejectAllInstallTargetAuthority,
  type MarketDesktopPnpm,
  type MarketDesktopProfile,
} from './install/service.js'
import type { CatalogSourceLockOptions } from './catalog/source-store.js'
import type { LocalSourceRecord } from './contracts/types.js'
import { DSHFIND_ADAPTER_ID, DSHFIND_KEY, DSHFIND_PROVIDER_ID } from './adapters/dshfind.js'

export const name = 'community-market'
export const inject = ['webServer', 'settings']

interface DesktopProfilesCapability {
  readonly current: MarketDesktopProfile
}

interface DesktopActionsCapability {
  openTerminal(): void
  requestRestart(): Promise<void>
}

/**
 * Narrow view of the desktop-provided deployment policy. The desktop host
 * provides the full embedded policy before bundle plugins load; this package
 * never imports the desktop definition and treats a missing capability as an
 * unlocked standalone deployment.
 */
interface DesktopPolicyView {
  readonly locked: boolean
}

/**
 * Phase-1 company source placeholder: the built-in cooperative catalog keeps
 * browsing available in locked test builds while every install target is
 * rejected. The signed company catalog adapter (P2) replaces this record.
 */
const COMPANY_SOURCE_PLACEHOLDER: LocalSourceRecord = Object.freeze({
  sourceRecordId: 'company-catalog-placeholder',
  registrationKind: 'built-in',
  adapterId: DSHFIND_ADAPTER_ID,
  providerId: DSHFIND_PROVIDER_ID,
  builtInProviderKey: DSHFIND_KEY,
  enabled: true,
  order: 0,
})

const npmRegistryHttp = createRestrictedHttpClient({
  // This is a compiled-in official registry hostname, never provider input.
  syntheticProxyHostnames: ['registry.npmjs.org'],
})

export function apply(ctx: Context): void {
  const scope = registerMarketSettings(ctx)
  const policy = ctx.get('desktopPolicy') as DesktopPolicyView | undefined
  const locked = policy?.locked === true
  const sourceLock: CatalogSourceLockOptions | undefined = locked
    ? { locked: true, companySource: COMPANY_SOURCE_PLACEHOLDER }
    : undefined
  let installService: MarketInstallService | undefined
  let desktopActions: DesktopActionsCapability | undefined
  let desktopPlugins: MarketDesktopPlugins | undefined
  const installProvider = { get: () => installService }
  const desktopActionsProvider = { get: () => desktopActions }
  const desktopPluginsProvider = { get: () => desktopPlugins }
  ctx.effect(
    () => registerMarketRoutes(ctx, scope, installProvider, desktopActionsProvider, desktopPluginsProvider, sourceLock),
    'community-market: routes',
  )
  ctx.inject(['desktopActions'], (desktopCtx) => {
    const actions = desktopCtx.get('desktopActions') as DesktopActionsCapability
    desktopCtx.effect(() => {
      desktopActions = actions
      return () => {
        if (desktopActions === actions) desktopActions = undefined
      }
    }, 'community-market: optional desktop actions')
  })
  ctx.inject(['desktopPlugins'], (desktopCtx) => {
    const plugins = desktopCtx.get('desktopPlugins') as MarketDesktopPlugins
    desktopCtx.effect(() => {
      desktopPlugins = plugins
      return () => {
        if (desktopPlugins === plugins) desktopPlugins = undefined
      }
    }, 'community-market: optional desktop plugin management')
  })
  // Browsing remains portable. Desktop-only package operations appear whenever
  // the narrow profile and package-manager capabilities are live.
  ctx.inject(['desktopProfiles', 'desktopPnpm'], (desktopCtx) => {
    const profiles = desktopCtx.get('desktopProfiles') as DesktopProfilesCapability
    const pnpm = desktopCtx.get('desktopPnpm') as MarketDesktopPnpm
    desktopCtx.effect(() => {
      const service = new MarketInstallService(
        scope,
        () => profiles.current,
        pnpm,
        createNpmRegistryVerifier(npmRegistryHttp),
        {
          ...(locked ? { installTargetAuthority: rejectAllInstallTargetAuthority } : {}),
          disabledPackageNames: () => {
            const plugins = desktopPlugins
            if (plugins === undefined) {
              throw new Error('desktop plugin policy unavailable')
            }
            return plugins.disabledPackageNames()
          },
        },
      )
      installService = service
      return () => {
        if (installService === service) installService = undefined
        service.dispose()
      }
    }, 'community-market: desktop package operations')
  })
}

export { marketRoutes } from './host/routes.js'
export { BUILT_IN_PROVIDERS, DefaultCatalogService } from './catalog/service.js'
export { dsh1024StoreAdapter } from './adapters/dsh-1024store.js'
export { dshfindAdapter } from './adapters/dshfind.js'
export type * from './api-types.js'
export * from './contracts/index.js'
export * from './signing/index.js'
