import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import {
  registerMarketRoutes,
  registerMarketSettings,
  type MarketCompanyCatalogRouteWiring,
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
import { createSignedManifestInstallTargetAuthority, type SignedManifestInstallTargetAuthority } from './install/signed-manifest-authority.js'
import type { CatalogSourceLockOptions } from './catalog/source-store.js'
import type { MarketSettingsDocument } from './catalog/source-store.js'
import {
  COMPANY_CATALOG_ADAPTER_ID,
  COMPANY_CATALOG_BUILT_IN_KEY,
  COMPANY_CATALOG_PROVIDER_ID,
  CompanyCatalogUntrustedError,
  createCompanyCatalogProvider,
  SettingsCompanyManifestSequenceStore,
  type CompanyCatalogProvider,
  type CompanyManifestContentProvider,
} from './catalog/company-provider.js'
import type { CatalogAdapter, CatalogHttpClient, LocalSourceRecord } from './contracts/types.js'
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
 * unlocked standalone deployment. The locked company-catalog wiring below
 * reads `trustRoots`, `companyCatalogOrigin`, and `companyManifestUrl`
 * verbatim — the same projection rule every other policy channel follows
 * (see `.agents/notes/implemented/process/2026-08-23-policy-distribution-adr.md`).
 */
export interface DesktopPolicyView {
  readonly locked: boolean
  readonly trustRoots: readonly { readonly keyId: string; readonly fingerprint: string }[]
  readonly companyCatalogOrigin: string | null
  readonly companyManifestUrl: string
}

/** Stable identity of the locked company catalog source record (a fixed UUID: the record is synthesized, never user-created). */
const COMPANY_SOURCE_RECORD_ID = '018f1f77-a5c4-7b73-a9ae-0242ac130001'
/**
 * Origin-mode manifest body bound, mirroring the desktop CLI's embedded
 * asset cap (the manifest schema caps 10000 entries at roughly 2.5 MiB).
 */
const COMPANY_MANIFEST_MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Phase-1 company source placeholder: the built-in cooperative catalog keeps
 * browsing available in locked test builds while every install target is
 * rejected. Superseded by the signed company catalog wiring whenever the
 * locked policy pins trust roots; kept for locked policies that cannot
 * construct the signed chain (fail-closed provider contract) so such a build
 * still boots — the release gate rejects that state before it ships.
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

/**
 * Resolve the packaged company manifest asset path for content-mode policies.
 *
 * The asset ships inside the application bundle under the desktop package's
 * `lib/<companyManifestUrl>` — the same file the desktop boot verifier and
 * the terminal plugin-add gate read — so this module anchors on its own
 * packaged placement (`<app>/node_modules/dsh-community-market/lib/index.js`,
 * four levels below the application root) instead of duplicating desktop
 * asset code. Profile fallback may load this module from the physical
 * `app.asar.unpacked` tree; {@link packagedCompanyManifestContentProvider}
 * then prefers the in-archive copy and keeps the physical mirror as fallback.
 */
export function packagedCompanyManifestAssetPath(
  companyManifestUrl: string,
  moduleUrl: string = import.meta.url,
): string {
  if (typeof companyManifestUrl !== 'string' || companyManifestUrl.length === 0
    || companyManifestUrl.includes('\0') || companyManifestUrl.includes('\\')
    || companyManifestUrl.startsWith('/')) {
    throw new TypeError('company manifest URL must be a relative bundled asset path without NUL or backslash')
  }
  const segments = companyManifestUrl.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError('company manifest URL must not contain empty or dot path segments')
  }
  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) {
    throw new TypeError('company manifest module URL must be a non-empty file URL')
  }
  const applicationRoot = dirname(dirname(dirname(dirname(fileURLToPath(new URL(moduleUrl))))))
  return join(applicationRoot, 'lib', ...segments)
}

/**
 * Content-mode manifest bytes from the packaged asset. A missing or
 * unreadable asset throws, which fails the whole provider scan fail-closed:
 * without verified manifest bytes the catalog is untrusted and the install
 * authority has nothing to allow.
 */
export function packagedCompanyManifestContentProvider(
  companyManifestUrl: string,
  moduleUrl: string = import.meta.url,
): CompanyManifestContentProvider {
  const physicalPath = packagedCompanyManifestAssetPath(companyManifestUrl, moduleUrl)
  const archivePath = physicalPath.replace(/([\\/])app\.asar\.unpacked\1/u, '$1app.asar$1')
  return () => {
    if (archivePath !== physicalPath) {
      try {
        return readFileSync(archivePath, 'utf8')
      } catch {
        // Fall through to the physical mirror below.
      }
    }
    return readFileSync(physicalPath, 'utf8')
  }
}

/** Wired catalog components of a locked deployment's signed company source. */
export interface CommunityMarketCompanyCatalogWiring {
  /** The signed company source record the catalog source lock pins. */
  readonly companySource: LocalSourceRecord
  /** Catalog-service adapter registration; reports scan failures to the authority. */
  readonly adapters: readonly CatalogAdapter[]
  /** HTTP clients keyed by adapter id; origin mode pins a body-bounded client. */
  readonly adapterHttpClients: ReadonlyMap<string, CatalogHttpClient>
  /** Install whitelist over the provider's last verified manifest. */
  readonly installTargetAuthority: SignedManifestInstallTargetAuthority
  /** The provider itself, for diagnostics and focused tests. */
  readonly provider: CompanyCatalogProvider
}

/** Options for {@link createCommunityMarketCompanyCatalog}. */
export interface CommunityMarketCompanyCatalogOptions {
  /** Module URL the packaged content-mode asset anchor derives from; defaults to this module. */
  readonly moduleUrl?: string
  /** Clock deciding manifest expiry; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Forward one catalog scan task, reporting untrusted verdicts to the authority. */
async function reportUntrustedCatalogScan<T>(
  task: () => Promise<T>,
  authority: SignedManifestInstallTargetAuthority,
): Promise<T> {
  try {
    return await task()
  } catch (cause) {
    // Propagation strategy (P2-3): every CompanyCatalogUntrustedError caught
    // around a catalog scan closes the install authority until a strictly
    // newer manifest sequence verifies again.
    if (cause instanceof CompanyCatalogUntrustedError) authority.reportUntrustedCatalog(cause)
    throw cause
  }
}

/**
 * Wire the locked deployment's signed company catalog end to end from the
 * policy projection: the catalog provider (content or origin mode), the
 * settings-backed anti-rollback sequence store, the catalog source record,
 * the catalog-service adapter registration with the untrusted-reporting
 * wrapper, and the signed-manifest install whitelist.
 */
export function createCommunityMarketCompanyCatalog(
  policy: DesktopPolicyView,
  scope: SettingsScope<MarketSettingsDocument>,
  options: CommunityMarketCompanyCatalogOptions = {},
): CommunityMarketCompanyCatalogWiring {
  if (policy.locked !== true) {
    throw new TypeError('community market company catalog wiring requires a locked deployment policy')
  }
  if (policy.trustRoots.length === 0) {
    throw new TypeError('community market company catalog wiring requires pinned trust roots')
  }
  const provider = createCompanyCatalogProvider({
    ...(policy.companyCatalogOrigin === null
      ? {
          manifestContentProvider: packagedCompanyManifestContentProvider(
            policy.companyManifestUrl,
            options.moduleUrl,
          ),
        }
      : { companyManifestUrl: policy.companyManifestUrl }),
    trustRoots: policy.trustRoots,
    sequenceStore: new SettingsCompanyManifestSequenceStore(scope),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const installTargetAuthority = createSignedManifestInstallTargetAuthority(
    provider,
    options.now === undefined ? {} : { now: options.now },
  )
  const adapters: readonly CatalogAdapter[] = [{
    adapterId: COMPANY_CATALOG_ADAPTER_ID,
    fetch: (query, context) => reportUntrustedCatalogScan(async () => await provider.fetch(query, context), installTargetAuthority),
    scanCatalog: (query, context) => reportUntrustedCatalogScan(async () => await provider.scanCatalog(query, context), installTargetAuthority),
  }]
  const adapterHttpClients = new Map<string, CatalogHttpClient>()
  if (policy.companyCatalogOrigin !== null) {
    // The origin is policy-pinned; the provider re-asserts `allowedOrigin` on
    // every request through this client.
    adapterHttpClients.set(COMPANY_CATALOG_ADAPTER_ID, createRestrictedHttpClient({
      maxBodyBytes: COMPANY_MANIFEST_MAX_BODY_BYTES,
    }))
  }
  return {
    companySource: Object.freeze({
      sourceRecordId: COMPANY_SOURCE_RECORD_ID,
      registrationKind: 'built-in',
      adapterId: COMPANY_CATALOG_ADAPTER_ID,
      providerId: COMPANY_CATALOG_PROVIDER_ID,
      builtInProviderKey: COMPANY_CATALOG_BUILT_IN_KEY,
      enabled: true,
      order: 0,
    }),
    adapters,
    adapterHttpClients,
    installTargetAuthority,
    provider,
  }
}

const npmRegistryHttp = createRestrictedHttpClient({
  // This is a compiled-in official registry hostname, never provider input.
  syntheticProxyHostnames: ['registry.npmjs.org'],
})

export function apply(ctx: Context): void {
  const scope = registerMarketSettings(ctx)
  const policy = ctx.get('desktopPolicy') as DesktopPolicyView | undefined
  const locked = policy?.locked === true
  // L2 wiring: a locked deployment with pinned trust roots serves the signed
  // company catalog end to end. A locked policy without trust roots cannot
  // construct the signed chain (the provider refuses to build), so that state
  // keeps the Phase-1 placeholder — the company release gate rejects it at
  // packaging time, and the host keeps booting either way.
  const companyCatalog = locked && policy !== undefined && policy.trustRoots.length > 0
    ? createCommunityMarketCompanyCatalog(policy, scope)
    : undefined
  if (locked && companyCatalog === undefined) {
    ctx.logger.warn(
      'dsh-community-market: locked deployment pins no catalog trust roots; the signed catalog stays unavailable and installs remain rejected (the company release gate must provision policy trustRoots)',
    )
  }
  const sourceLock: CatalogSourceLockOptions | undefined = locked
    ? { locked: true, companySource: companyCatalog?.companySource ?? COMPANY_SOURCE_PLACEHOLDER }
    : undefined
  const companyCatalogRoutes: MarketCompanyCatalogRouteWiring | undefined = companyCatalog === undefined
    ? undefined
    : { adapters: companyCatalog.adapters, adapterHttpClients: companyCatalog.adapterHttpClients }
  let installService: MarketInstallService | undefined
  let desktopActions: DesktopActionsCapability | undefined
  let desktopPlugins: MarketDesktopPlugins | undefined
  const installProvider = { get: () => installService }
  const desktopActionsProvider = { get: () => desktopActions }
  const desktopPluginsProvider = { get: () => desktopPlugins }
  ctx.effect(
    () => registerMarketRoutes(ctx, scope, installProvider, desktopActionsProvider, desktopPluginsProvider, sourceLock, companyCatalogRoutes),
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
          // Locked installs pass exactly when the signed company manifest
          // allows them; until trust roots are pinned (and for every
          // non-locked-but-injected case there is none) the fail-closed
          // authority keeps rejecting.
          ...(companyCatalog !== undefined
            ? { installTargetAuthority: companyCatalog.installTargetAuthority }
            : locked ? { installTargetAuthority: rejectAllInstallTargetAuthority } : {}),
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
export {
  COMPANY_CATALOG_ADAPTER_ID,
  COMPANY_CATALOG_BUILT_IN_KEY,
  COMPANY_CATALOG_CONTENT_FINAL_URL,
  COMPANY_CATALOG_PROVIDER_ID,
  CompanyCatalogUntrustedError,
  createCompanyCatalogProvider,
  SettingsCompanyManifestSequenceStore,
  type CompanyCatalogCandidate,
  type CompanyCatalogProvider,
  type CompanyCatalogProviderOptions,
  type CompanyCatalogVerification,
  type CompanyManifestContentProvider,
  type CompanyManifestSequenceStore,
} from './catalog/company-provider.js'
export type { MarketCompanyManifestRecord } from './catalog/source-store.js'
export { createSignedManifestInstallTargetAuthority } from './install/signed-manifest-authority.js'
export type {
  SignedManifestInstallTargetAuthority,
  SignedManifestInstallTargetAuthorityOptions,
  SignedManifestPackageSource,
} from './install/signed-manifest-authority.js'
export type {
  InstallTargetAuthority,
  InstallTargetCandidate,
  InstallTargetDecision,
  InstallTargetEvidence,
} from './install/service.js'
export type {
  MarketInstallTreeDigest,
  MarketInstallTreeDigestFile,
} from './install/tree-digest.js'
export { dsh1024StoreAdapter } from './adapters/dsh-1024store.js'
export { dshfindAdapter } from './adapters/dshfind.js'
export type * from './api-types.js'
export * from './contracts/index.js'
export * from './signing/index.js'
