import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only SlotMap convergence for the Desktop settings and brand sections.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { startRendererBootReporter } from './boot-health.ts'
import { DeloitteBrandName } from './DeloitteBrandName.tsx'
import { applyDesktopSettings } from './desktop-settings.ts'
import { installDesktopDirectoryPickerBridge, requestDesktopDirectoryValidation } from './directory-picker.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { installWorkspaceFolderDrop } from './workspace-folder-drop.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export { applyDesktopSettings } from './desktop-settings.ts'
export {
  createDesktopSettingsApi,
  desktopSettingsPaths,
  parseDesktopActionAcceptance,
  parseDesktopRestartAcceptance,
  parseDesktopSettingsView,
} from './desktop-settings-api.ts'
export type {
  DesktopMarketProvider,
  DesktopMarketView,
  DesktopProfileView,
  DesktopRestartAcceptance,
  DesktopSettingsApi,
  DesktopSettingsSsoSource,
  DesktopSettingsSsoView,
  DesktopSettingsView,
} from './desktop-settings-api.ts'
export { DesktopSettingsSection } from './DesktopSettingsSection.tsx'
export { DesktopTerminalSettingsAction } from './DesktopTerminalSettingsAction.tsx'
export { DeloitteBrandName } from './DeloitteBrandName.tsx'
export { GeneralUserInfoCard, GeneralUserInfoCardView } from './GeneralUserInfoCard.tsx'
export type {
  GeneralUserInfoCardInjected,
  GeneralUserInfoCardProps,
} from './GeneralUserInfoCard.tsx'
export type {
  DesktopTerminalSettingsActionInjected,
  DesktopTerminalSettingsActionProps,
} from './DesktopTerminalSettingsAction.tsx'
export type {
  DesktopNotificationSettings,
  DesktopSettingsSectionInjected,
  DesktopSettingsSectionProps,
  DesktopShellSettings,
} from './DesktopSettingsSection.tsx'
export {
  RENDERER_BOOT_REPORT_PATH,
  rendererBootReport,
  sendRendererBootReport,
  startRendererBootReporter,
} from './boot-health.ts'
export type { RendererBootLoader, RendererBootReport } from './boot-health.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by Desktop settings and advanced presentation. */
export const inject = [
  'slots',
  'locale',
  'connection',
  'remote',
  'settingsScope',
  'sessions',
  'theme',
  'workspaces',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  if (!environment) return
  // The lock class lands before React mounts, so the settings header actions
  // hidden through it (desktop-settings-styles.ts) never paint.
  if (environment.locked) document.documentElement.classList.add('dsh-desktop-locked')
  applyDesktopSettings(ctx, environment)
  ctx.effect(
    () => startRendererBootReporter(ctx.loader),
    'dsh-plugin-desktop: renderer boot health report',
  )
  ctx.effect(
    () => installWorkspaceFolderDrop({
      create: input => ctx.workspaces.create(input),
      startSession: workspaceId => { ctx.workspaces.startSession(workspaceId) },
      ...(environment.platform === 'win32'
        ? { validateDirectory: (path: string) => requestDesktopDirectoryValidation(path) }
        : {}),
    }),
    'dsh-plugin-desktop: workspace folder drop',
  )
  if (environment.platform === 'win32') {
    ctx.effect(
      () => installDesktopDirectoryPickerBridge(),
      'dsh-plugin-desktop: native directory picker bridge',
    )
  }
  // 'sidebar.brand.name' is a single-kind slot, so every occupant shares one
  // cell: a second registration at an occupied cell's exact priority (the
  // default 0) throws, while a different priority coexists with the LOWEST
  // live entry rendering (SlotCore.entriesOfSlot). The official brand bundle
  // — active in this build, DSH_CLIENT_BUILD_PROFILE === 'official' — fills
  // the cell at the default 0 from its ui-brand-official roster row. The
  // desktop bundle layer composes immediately after the web-app layer in the
  // profile patch order (src/profile.ts), so later user layers may register
  // after this plugin — which changes nothing: only an exact-priority
  // collision throws, and among distinct priorities the registry renders the
  // cell's lowest entry regardless of registration order, so the -1 rank
  // wins on rank alone. priority -1 keeps the official wordmark registered
  // purely as a hypothetical fallback — it could only render without this
  // plugin, and dsh-plugin-desktop is immutable (IMMUTABLE_BUNDLES in
  // src/desktop-plugins.ts), so that fallback can never trigger — while the
  // Deloitte co-brand renders. The inject wrapper keys the
  // contribution to the slot's declaration lifetime (ui-sidebar owns it), the
  // same declaration-gating the official brand plugin uses, so the
  // registration survives ui-sidebar re-declarations and unloads with this
  // plugin's fiber. Applies in BOTH shell modes: the brand row is upstream
  // ui-sidebar surface in compatibility mode and stays mounted in advanced.
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
    { name: 'sidebar.brand.name', priority: -1 },
    DeloitteBrandName,
  ))
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
}
