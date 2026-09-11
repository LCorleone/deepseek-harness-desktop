/** DSH Desktop executable: minimal Electron bootstrap around the Host Cordis root. */

import { app, crashReporter, dialog, net, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  PROFILE_PATCH_FILENAME,
  resolveProfileDir,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { isDesktopInstallerQuitRequest } from './desktop-installer-quit.ts'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
  installDesktopPythonRuntime,
  type DesktopPythonRuntimeInstallation,
} from './desktop-runtime-environment.ts'
import { desktopProductVersion, ElectronDesktopRuntime } from './electron-runtime.ts'
import { desktopBuildVersion } from './desktop-build-version.ts'
import { installWindowLifetimeGuard } from './window-lifetime.ts'
import {
  ElectronStderrLogger,
  installDesktopChildProcessLogging,
  installDesktopUncaughtExceptionLogging,
  type DesktopLogger,
} from './desktop-logger.ts'
import {
  beginDesktopRun,
  startDesktopCrashReporting,
  type DesktopRun,
} from './crash-evidence.ts'
import { exportDesktopDiagnostics } from './diagnostic-export.ts'
import { createDesktopLifecycleRecorder } from './lifecycle-events.ts'
import type {
  DesktopLifecycleFailureReason,
  DesktopLifecycleRendererFailureReason,
} from './lifecycle-events.ts'
import { FileExporter } from './file-exporter.ts'
import { DESKTOP_SETTINGS_NAMESPACE, type DesktopSettings } from './index.ts'
import { LogFileSink } from './log-files.ts'
import { maskSecrets } from './mask-secrets.ts'
import { resolveCorporateNetworkEnv } from './corporate-network-env.ts'
import { resolveDesktopShellEnvironment, scrubInheritedPermissionModeOverride } from './shell-environment.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { packagedDependencyPath, unpackedAsarPath } from './packaged-runtime-path.ts'
import { resolveDesktopNodeExecutable } from './desktop-node-runtime.ts'
import { pythonPipAvailable, resolveDesktopLocalPythonExecutable, resolveDesktopPythonExecutable } from './desktop-python-runtime.ts'
import {
  desktopSharedPythonEnvironmentRoot,
  ensureDesktopSharedPythonEnvironment,
} from './desktop-shared-python-environment.ts'
import { setDesktopSandboxEscalationSink } from './windows-pwsh-sandbox.ts'
import {
  DesktopInstallRecoveryStore,
  desktopInstallRecoveryStatePath,
  type DesktopInstallRecoveryFailureReason,
  type DesktopInstallRecoveryTransaction,
} from './install-recovery.ts'
import {
  beginDesktopProfileStartup,
  assertDesktopProfileName,
  createDesktopWebProfile,
  listDesktopProfiles,
  canDeleteDesktopProfile,
  deleteDesktopProfile,
  readDesktopProfileState,
  selectDesktopProfile,
  type DesktopProfileStartup,
} from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { DesktopActionsService } from './desktop-actions.ts'
import { clearDesktopProfilePluginState, DesktopPluginsService } from './desktop-plugins.ts'
import {
  desktopMarketSnapshotWithEffective,
  desktopCompanyManifestVerifierForMarket,
  readDesktopMarketStateForUserData,
  selectDesktopMarketProvider,
} from './desktop-market.ts'
import {
  resolveDesktopBetaChannelOverlay,
  type DesktopBetaChannelOptions,
  type DesktopBetaChannelOverlay,
} from './beta-channel.ts'
import {
  browserSsoLogin,
  desktopSsoGateRequired,
  getSsoSession,
  setSsoSession,
  silentSsoLogin,
  type SsoRequestBoundary,
  type SsoSession,
} from './company-sso.ts'
import { DesktopSsoGateWindow } from './sso-gate-window.ts'
import { DesktopDisclaimerWindow } from './disclaimer-window.ts'
import { runDisclaimerGate } from './disclaimer-gate.ts'
import { disclaimerTextHash } from './disclaimer-text.ts'
import { desktopPolicyEnvironmentEntries, readDesktopPolicy } from './desktop-policy.ts'
import {
  betaCatalogRefreshEvent,
  betaDeliveredPackageKeys,
  bootVerifyEvent,
  createClientEventCollector,
  disclaimerEvent,
  pluginInstallEvent,
  pluginResetEvent,
  pythonRuntimeEvent,
  sandboxEscalationEvent,
  ssoLoginEvent,
  stableCatalogRefreshEvent,
} from './client-event-reporter.ts'
import type { MarketInstallEventSink } from 'dsh-community-market'
import {
  managedModelGateway,
  managedModelsPresetGateEntry,
  readStoredCredentialNames,
  resolveManagedModelGatewayEnvironment,
  storedCredentialsPath,
} from './model-gateway.ts'
import {
  createCachedDesktopBootTreeRootDigestMeasure,
  DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME,
  desktopBootVerificationInputs,
  readDesktopBootReceiptsFromSettings,
} from './boot-verification.ts'
import type { DesktopBootVerification } from './boot-verification.ts'
import {
  desktopBootClientUpdateNotification,
  desktopBootPluginUpdateNotification,
  pendingDesktopBootClientUpdates,
  pendingDesktopBootPluginUpdates,
} from './boot-update-prompt.ts'
import { companyCatalogHttpOverElectronNet, fetchCompanyManifestTextOverElectronNet } from './electron-company-manifest.ts'
import { stageCompanyManifestForCliChildren } from './company-manifest-handoff.ts'
import { createDesktopCompanyMarketTarballInstallChannel } from './company-market-install.ts'
import { writeDesktopBootVerificationSnapshot } from './diagnostic-self-check.ts'
import DesktopSettingsController, { projectSsoSession } from './desktop-settings-controller.ts'
import { DesktopStartupRecoveryController } from './startup-recovery-controller.ts'
import {
  DesktopStartupRecoveryWindow,
  type DesktopStartupRecoveryConfigurationPaths,
  type DesktopStartupRecoveryProfileActions,
  type DesktopStartupFailureStage,
} from './startup-recovery-window.ts'
import { routeDesktopStartupFailure } from './startup-failure-routing.ts'
import { DesktopStartupGeneration } from './startup-generation.ts'
import { DesktopStartupStateCommit } from './startup-state-commit.ts'
import {
  DESKTOP_PROFILE_NAME,
  desktopInstallAnchor,
  ensureDesktopProfile,
  healDesktopProfileModuleFallback,
  prepareDesktopProfile,
  type SkippedOptionalEntry,
} from './profile.ts'
import { clearDesktopProfileCheckpoint, DesktopProfileCheckpoint } from './profile-checkpoint.ts'
import { materializeProfileWithRetry, ProfileMaterializationError, PROFILE_MATERIALIZATION_ATTEMPTS } from './profile-materializer.ts'
import { ensureProfilePnpmBuildApproval } from './profile-pnpm-policy.ts'
import {
  FRESH_PROFILE_PENDING_VERSION,
  clearFreshProfilePending,
  clearFreshProfileRecordReceipts,
  freshProfilePendingAction,
  freshProfilePendingStatePath,
  freshProfileResetDecision,
  freshProfileSwap,
  profileGenerationStatePath,
  readFreshProfilePending,
  readProfileGenerationState,
  writeFreshProfilePending,
  writeProfileGenerationState,
} from './fresh-profile.ts'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import { DesktopAgentBrowserSession } from './agent-browser-session.ts'
import { DesktopAgentBrowserWindowHost, clearAgentBrowserPersistedPartition } from './agent-browser-window.ts'
import { AgentBrowserLoginFileStore } from './agent-browser-partition.ts'
import {
  createDesktopExitCoordinator,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopShutdown,
} from './shutdown.ts'
import {
  diagnoseWindowsVolumes,
  formatWindowsVolumeConcern,
  type WindowsVolumeConcern,
} from './windows-volume-diagnostics.ts'
import type { RendererBootReport } from './renderer-boot-contract.ts'
import { desktopLocaleFromLanguageTag } from './tray-locale.ts'
import {
  recoverOversizedSessionProjectionCache,
  type SessionProjectionCacheRecoveryResult,
} from './session-projcache-recovery.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const PRODUCT_NAME = 'DSH Desktop'

/**
 * The disclaimer window across its two lives: the deciding prompt, then —
 * after 「同意」 — the startup loading surface that keeps a visible face on
 * screen while the slow boot chain (corporate env, first-boot Profile
 * creation, Host boot, shell mount) runs. Reused instead of a splash
 * window: zero new window infrastructure and zero new close races — the
 * #66 lifetime guard already owns a user-closed loading window.
 */
let disclaimerWindow: DesktopDisclaimerWindow | undefined
/**
 * Retire the loading surface once the first successor face is visible:
 * the shell window's first show, the startup recovery window, the Profile
 * creator, or the SSO gate window. Idempotent — safe before the prompt
 * even opened (a silent-SSO or everyday boot) and after the user closed
 * the loading window themselves.
 */
const disposeDisclaimerLoading = (): void => {
  disclaimerWindow?.dispose()
  disclaimerWindow = undefined
}

class RendererStartupFailure extends Error {
  constructor(
    readonly reason: Extract<DesktopInstallRecoveryFailureReason, 'renderer-failed' | 'renderer-timeout'>,
    report: Extract<RendererBootReport, { status: 'failed' }>,
  ) {
    super(report.error ?? `Renderer boot failed for ${String(report.plugins.length)} plugin(s)`)
    this.name = 'RendererStartupFailure'
  }
}

function lifecycleRendererFailureReason(
  reason: Extract<DesktopInstallRecoveryFailureReason, 'renderer-failed' | 'renderer-timeout'> | undefined,
): DesktopLifecycleRendererFailureReason {
  return reason === 'renderer-timeout' ? 'renderer-timeout' : 'renderer-failed'
}

function lifecycleStartupFailureReason(
  cause: unknown,
  runtime: ElectronDesktopRuntime,
): DesktopLifecycleFailureReason {
  if (cause instanceof RendererStartupFailure) return cause.reason
  return runtime.rendererBootFailureReason ?? 'startup-failed'
}

/** Report profile recovery without changing startup or rollback outcomes. */
function notifyProfileRecovery(runtime: ElectronDesktopRuntime, logger: DesktopLogger, body: string): void {
  try {
    runtime.updates.notify({ title: 'Unable to Open Profile', body })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show profile recovery notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Explain a completed cross-restart install rollback after Desktop is healthy again. */
async function showInstallRollbackNotice(
  transaction: DesktopInstallRecoveryTransaction,
  locale: 'en' | 'zh',
  logger: DesktopLogger,
): Promise<boolean> {
  const copy = locale === 'zh'
    ? {
        title: '插件安装已回滚',
        message: `DSH Desktop 已恢复安装 ${transaction.packageName} 前的配置。`,
        detail: '上一次启动未能通过健康验证。DSH Desktop 已在本地保存诊断信息，并恢复 package.json、pnpm-lock.yaml 和 pnpm-workspace.yaml；诊断信息不会自动上传。',
        confirm: '知道了',
      }
    : {
        title: 'Plugin installation rolled back',
        message: `DSH Desktop restored the configuration from before ${transaction.packageName} was installed.`,
        detail: 'The previous startup did not pass its health check. DSH Desktop saved diagnostics locally and restored package.json, pnpm-lock.yaml, and pnpm-workspace.yaml. Diagnostics are not uploaded automatically.',
        confirm: 'OK',
      }
  try {
    await dialog.showMessageBox({
      type: 'info',
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.confirm],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return true
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show install rollback notice: ${cause instanceof Error ? cause.message : String(cause)}`)
    return false
  }
}

/** Explain an automatic last-known-good profile restore before relaunching. */
async function showProfileCheckpointRestoreNotice(
  profileName: string,
  locale: 'en' | 'zh',
  logger: DesktopLogger,
): Promise<void> {
  const copy = locale === 'zh'
    ? {
        title: '已恢复最近一次可用配置',
        message: `DSH Desktop 已恢复最近一次成功启动的配置「${profileName}」。`,
        detail: '诊断信息已尽可能保存在本地；如果恢复涉及依赖声明，插件依赖也已按锁文件重新同步。DSH Desktop 现在将重新启动。',
        confirm: '重新启动',
      }
    : {
        title: 'Last healthy configuration restored',
        message: `DSH Desktop restored Profile “${profileName}” from the last successful startup.`,
        detail: 'Diagnostics were saved locally when possible. When dependency declarations were restored, plugin dependencies were synchronized from the lockfile. DSH Desktop will now restart.',
        confirm: 'Restart',
      }
  try {
    await dialog.showMessageBox({
      type: 'info',
      title: copy.title,
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.confirm],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show profile restore notice: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  entries: readonly SkippedOptionalEntry[],
): void {
  if (entries.length === 0) return
  const names = entries.map(entry => entry.name)
  const suffix = names.length > 1 ? ` and ${names.length - 1} more` : ''
  try {
    runtime.updates.notify({
      title: 'Skipped Unavailable UI Plugin',
      body: `${names[0]} is not installed in this profile${suffix}.`,
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show skipped plugin notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Surface path/volume risks that otherwise become obscure sandbox or pnpm failures later. */
function warnWindowsVolumeConcerns(logger: DesktopLogger, concerns: readonly WindowsVolumeConcern[]): void {
  for (const concern of concerns) {
    logger.error(`${BIN_NAME}: Windows volume warning: ${formatWindowsVolumeConcern(concern)}`)
  }
}

/** Notify once after the UI is ready; stderr carries the exact paths. */
function notifyWindowsVolumeConcerns(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  concerns: readonly WindowsVolumeConcern[],
): void {
  if (concerns.length === 0) return
  try {
    runtime.updates.notify({
      title: 'Storage May Be Unsupported',
      body: `${concerns[0]?.label ?? 'A configured path'} is on a volume that may break sandboxed commands or plugin installs.`,
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show Windows volume warning: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function notifySessionProjectionCacheRecovery(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  _recovery: Extract<SessionProjectionCacheRecoveryResult, { status: 'quarantined' }>,
): void {
  try {
    runtime.updates.notify({
      title: 'Recovered Session Cache',
      body: 'An oversized session projection cache was moved aside and will be rebuilt from session history.',
    })
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show session projection cache recovery notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Surface the class-a boot rejections as one update notification (P10): the
 * signed manifest pins a newer version while an older one is installed, so
 * without this prompt the plugin just disappears after the hard cutover.
 * Every other rejection class stays log-only — a revocation or tamper
 * refusal must never look like "a newer version is waiting". Called once
 * per session from the post-renderer-boot notification block; the
 * notification carries no click action because no open-market channel
 * exists yet (the copy points at the Plugin Market instead).
 */
function notifyPendingBootPluginUpdates(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  bootVerification: DesktopBootVerification | undefined,
): void {
  const notification = desktopBootPluginUpdateNotification(
    pendingDesktopBootPluginUpdates(bootVerification),
    runtime.locale,
  )
  if (notification === undefined) return
  try {
    runtime.updates.notify(notification)
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show pending plugin update notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Surface the deferred `client-update-required` bundles (P15, absorbing
 * P12): these loaded on install-receipt evidence because every remaining
 * catalog pin needs a newer DSH runtime than this build pins. The
 * notification says "upgrade the desktop client" — the Plugin Market
 * cannot resolve them — and runs beside the P10 prompt from the same
 * post-renderer-boot notification block.
 */
function notifyDeferredBootClientUpdates(
  runtime: ElectronDesktopRuntime,
  logger: DesktopLogger,
  bootVerification: DesktopBootVerification | undefined,
): void {
  const notification = desktopBootClientUpdateNotification(
    pendingDesktopBootClientUpdates(bootVerification),
    runtime.locale,
  )
  if (notification === undefined) return
  try {
    runtime.updates.notify(notification)
  } catch (cause) {
    logger.error(`${BIN_NAME}: failed to show deferred client update notification: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  let ssoGateWindow: DesktopSsoGateWindow | undefined
  if (isDesktopInstallerQuitRequest(process.argv, process.platform)) {
    app.quit()
    return
  }

  let profileStartup: DesktopProfileStartup | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let removeUncaughtExceptionLogging: (() => void) | undefined
  let removeChildProcessLogging: (() => void) | undefined
  let fileExporter: FileExporter | undefined
  let runtime!: ElectronDesktopRuntime
  let logSink: LogFileSink | undefined
  let installRecovery: DesktopInstallRecoveryStore | undefined
  let startupRecoveryController: DesktopStartupRecoveryController | undefined
  let startupRecoveryWindow: DesktopStartupRecoveryWindow | undefined
  let startupRecoveryConfigurationPaths: DesktopStartupRecoveryConfigurationPaths | undefined
  let startupStateCommit: DesktopStartupStateCommit | undefined
  let rolledBackInstallToNotify: DesktopInstallRecoveryTransaction | undefined
  let profileCheckpoint: DesktopProfileCheckpoint | undefined
  let restoreHealthyProfile: (() => Promise<boolean>) | undefined
  let restoreLastKnownGoodProfile: ((token: string) => Promise<void>) | undefined
  let freshProfileStart: ((token: string) => Promise<void>) | undefined
  let startupRecoveryProfileActions: DesktopStartupRecoveryProfileActions | undefined
  let sessionProjectionCacheRecovery:
    | Extract<SessionProjectionCacheRecoveryResult, { status: 'quarantined' }>
    | undefined
  let profileRecoveryActionUsed = false
  let recoveryTerminalAvailable = false
  let profileRollbackPrepared = false
  let protectedInstallVerificationActive = false
  let startupStage: DesktopStartupFailureStage = 'electron-ready'
  const appVersion = desktopProductVersion()
  // Build-distinguishing identity for telemetry, the disclaimer gate, and the
  // log header; the installer/updater faces keep the plain appVersion.
  const appBuildVersion = desktopBuildVersion()
  try {
    logSink = new LogFileSink(join(app.getPath('userData'), 'logs'), {
      maxFileBytes: 10 * 1024 * 1024,
      maxDirectoryBytes: 200 * 1024 * 1024,
    })
    logSink.enforceDirectoryCap()
    logSink.purgeOlderThan(7)
    logSink.writeHeader(`--- ${BIN_NAME} ${PRODUCT_NAME} ${appBuildVersion} ${process.platform} node ${process.version} run ${Date.now()} ---`)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    process.stderr.write(`${BIN_NAME}: file logging unavailable: ${maskSecrets(detail)}\n`)
    logSink = undefined
  }
  const electronLogger = new ElectronStderrLogger(logSink)
  const generation = new DesktopStartupGeneration({ logger: electronLogger })
  const generationId = generation.id
  const lifecycleRecorder = createDesktopLifecycleRecorder({
    userDataDir: app.getPath('userData'),
    appVersion,
    platform: process.platform,
    arch: process.arch,
    logger: electronLogger,
  })
  lifecycleRecorder.startStartup(startupStage)
  try {
    startDesktopCrashReporting(crashReporter, {
      productName: PRODUCT_NAME,
      version: appVersion,
      platform: process.platform,
      arch: process.arch,
    })
  } catch (cause) {
    electronLogger.error(`${BIN_NAME}: local crash reporting unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  let desktopRun: DesktopRun | undefined
  try {
    desktopRun = beginDesktopRun(
      join(app.getPath('userData'), 'crash-evidence', 'active-run.json'),
      {
        startedAt: new Date().toISOString(),
        pid: process.pid,
        version: appVersion,
      },
    )
    const previousRun = desktopRun.previousRun
    if (previousRun !== undefined) {
      electronLogger.error('unreadable' in previousRun
        ? `${BIN_NAME}: previous desktop run did not shut down cleanly (active run marker unreadable)`
        : `${BIN_NAME}: previous desktop run did not shut down cleanly (startedAt: ${previousRun.startedAt}, pid: ${String(previousRun.pid)}, version: ${previousRun.version})`)
    }
  } catch (cause) {
    electronLogger.error(`${BIN_NAME}: active run tracking unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  removeChildProcessLogging = installDesktopChildProcessLogging(app, electronLogger)
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => { runtime.prepareToQuit() },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => {
      removeShutdownRequests?.()
      removeUncaughtExceptionLogging?.()
      removeChildProcessLogging?.()
      try {
        desktopRun?.markClean()
      } catch (cause) {
        electronLogger.error(`${BIN_NAME}: failed to clear active run marker: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
  )
  let restartRequested = false
  // Parsed once for the whole launch: the locked flag feeds the runtime's
  // update wiring below, and the same immutable policy document reaches the
  // profile composition (boot verification, market, CLI environment).
  const policy = readDesktopPolicy()
  // Low-frequency client event telemetry (2026-09-07): SSO logins, catalog
  // refresh outcomes, boot verification refusals, market installs, and the
  // bundled python runtime's per-boot availability land
  // in `dsh_client_events` of the same company database as the model usage
  // reporter (own connection, fire-and-forget, drop-on-failure). Created
  // BEFORE the SSO gate so login attempts are covered; a `usageReport:`
  // false policy or an invalid destination keeps the desktop completely
  // offline (undefined collector, one sanitized log line) — telemetry must
  // never fail the boot.
  const clientEvents = createClientEventCollector({
    policy,
    clientVersion: appBuildVersion,
    userEmail: () => getSsoSession()?.email ?? null,
    logInfo: message => { electronLogger.error(`${message}`) },
    logError: message => { electronLogger.error(`${message}`) },
  })
  // P16 sandbox-escalation telemetry: the Windows PowerShell sandbox adapter
  // is constructed by the Cordis loader from composition data, so the
  // collector reaches it through the adapter's module seam instead of a
  // constructor argument. Only the command HASH travels — the dialog keeps
  // the command text local (see client-event-reporter's privacy contract).
  setDesktopSandboxEscalationSink(event => {
    clientEvents?.sandboxEscalation(sandboxEscalationEvent(event.commandHash, event.outcome, event.mode))
  })
  generation.own(() => { void clientEvents?.dispose() })
  // Launcher-environment hygiene (review guard-clamp P2-1): the locked GUI
  // evaluates the base rows' `!!js` sandbox/approval expressions in THIS
  // process, and the locked restatement deliberately leaves those two rows
  // alone — it rests on the GUI process never carrying the upstream override.
  // A shell-inherited spelling (`DSH_PERMISSION_MODE=danger-full-access open
  // "DSH Desktop.app"`) would arm them straight to full access with approval
  // `never`, so every spelling is deleted here: before the SSO gate, before
  // the login-shell environment recovery (which refuses `DSH_*` exports but
  // never scrubbed the inherited half), before the launch-environment
  // snapshot (`loadLayeredEnv` below), before the Host composition evaluates
  // any row, and before a terminal or CLI child could inherit it. Unlocked
  // and development launches keep the upstream deployment override, the same
  // trust boundary the CLI clamp draws.
  if (policy.locked) {
    const droppedPermissionModeSpellings = scrubInheritedPermissionModeOverride(process.env)
    if (droppedPermissionModeSpellings.length > 0) {
      electronLogger.error(
        `${BIN_NAME}: dropped an inherited sandbox-mode override from the locked launch environment: ${droppedPermissionModeSpellings.join(', ')}`,
      )
    }
  }
  runtime = new ElectronDesktopRuntime(async () => {
    if (shutdown === undefined) {
      throw new Error('dsh-plugin-desktop: shutdown coordinator is not ready')
    }
    if (restartRequested) return
    restartRequested = true
    nativeExit.requestRelaunch()
    await shutdown.request(0)
  }, (report) => {
    if (report.status === 'failed') {
      lifecycleRecorder.finishRendererBoot(
        report,
        lifecycleRendererFailureReason(runtime.rendererBootFailureReason),
      )
    }
    // Main owns every pre-health failure branch. Returning true prevents the
    // legacy Renderer recovery dialog from racing the native startup window.
    return report.status === 'failed'
  }, electronLogger, undefined, policy.locked, disposeDisclaimerLoading)
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => { await generation.release() },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeUncaughtExceptionLogging = installDesktopUncaughtExceptionLogging(
    process,
    electronLogger,
    requestQuit,
  )
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  const openStartupRecoveryWindow = async (
    failureDetail: string,
    controller: DesktopStartupRecoveryController | undefined,
  ): Promise<'restart' | 'quit' | 'unavailable'> => {
    if (!app.isReady()) return 'unavailable'
    try {
      // A visible successor face replaces the disclaimer loading surface.
      disposeDisclaimerLoading()
      startupRecoveryWindow = new DesktopStartupRecoveryWindow({
        ...(controller === undefined ? {} : { controller }),
        ...(startupRecoveryConfigurationPaths === undefined
          ? {}
          : { configurationPaths: startupRecoveryConfigurationPaths }),
        locale: desktopLocaleFromLanguageTag(app.getLocale()),
        failureStage: startupStage,
        failureDetail: maskSecrets(failureDetail),
        exportDiagnostics: async signal => await exportDesktopDiagnostics(app.getPath('userData'), {
          appVersion,
          crashDumpsDir: app.getPath('crashDumps'),
          signal,
        }),
        ...(recoveryTerminalAvailable ? { openTerminal: () => { runtime.openTerminal() } } : {}),
        ...(startupRecoveryProfileActions === undefined ? {} : { profileActions: startupRecoveryProfileActions }),
        ...(restoreLastKnownGoodProfile === undefined ? {} : { rollbackLastKnownGood: restoreLastKnownGoodProfile }),
        ...(freshProfileStart === undefined ? {} : { freshProfileStart }),
      })
      return await startupRecoveryWindow.run()
    } catch (cause) {
      electronLogger.error(
        `${BIN_NAME}: failed to open startup recovery window: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return 'unavailable'
    } finally {
      startupRecoveryWindow = undefined
    }
  }

  app.on('second-instance', (_event, argv) => {
    if (isDesktopInstallerQuitRequest(argv, process.platform)) {
      requestQuit(0)
      return
    }
    if (ssoGateWindow !== undefined) ssoGateWindow.show()
    else if (disclaimerWindow !== undefined) disclaimerWindow.show()
    else if (startupRecoveryWindow !== undefined) startupRecoveryWindow.show()
    else runtime.show()
  })
  try {
    await app.whenReady()
    // Windows decides nothing (the #66 boot gap): the agreed disclaimer
    // window was destroyed seconds before the shell window existed, Electron's
    // Windows default quit-on-last-window-close silently exited mid-boot, and
    // the shutdown coordinator owns every exit path instead.
    installWindowLifetimeGuard(app)
    startupStage = 'shell-environment'
    lifecycleRecorder.transitionStartupStage(startupStage)
    if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.dsh.desktop')
    if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))
    // SSO startup gate (locked + requireSso): the whole authentication runs
    // BEFORE any window, Host boot, market composition, or CLI shim exists,
    // so nothing company-controlled is reachable while unauthenticated. The
    // silent path is one bounded OS probe plus one SignEntity POST through
    // Electron's Chromium network stack (system CA store; Node's undici
    // would fail the corporate-CA handshake). Its failure is an accelerator
    // miss, not an error the user must fix: the gate window offers the true
    // SSO decision — the browser loopback flow with the code_challenge and
    // callback-signature checks, confirmed against the portal's
    // verify_auth_code endpoint before the session settles. Closing the
    // gate quits the application; a
    // successful login adopts the in-memory session (never persisted, the
    // token never logged) and the boot continues exactly as an un-gated
    // launch from here on. Every other policy combination (unlocked, or
    // requireSso=false) skips this block entirely, keeping the boot sequence
    // byte-for-byte unchanged.
    if (desktopSsoGateRequired(policy)) {
      const ssoWarn = (message: string): void => { electronLogger.error(maskSecrets(message)) }
      const ssoRequest: SsoRequestBoundary = (url, init) => net.fetch(url, init)
      const adoptSession = (session: SsoSession): void => {
        setSsoSession(session)
        runtime.setSsoAccount(session.email)
      }
      const silent = await silentSsoLogin({ request: ssoRequest, onWarn: ssoWarn })
      if (silent.ok) {
        electronLogger.error(
          `${BIN_NAME}: sso silent authentication ok (email=${silent.session.email})`,
        )
        adoptSession(silent.session)
        clientEvents?.ssoLogin(ssoLoginEvent('success', 'silent'))
      } else {
        electronLogger.error(`${BIN_NAME}: sso silent authentication unavailable: ${maskSecrets(silent.reason)}`)
        clientEvents?.ssoLogin(ssoLoginEvent('failure', 'silent', silent.reason))
        // A visible successor face replaces the disclaimer loading surface
        // (today this runs before the gate, so the call is a future-proof
        // no-op — kept so no reordering can reintroduce the empty gap).
        disposeDisclaimerLoading()
        const gate = new DesktopSsoGateWindow({
          locale: desktopLocaleFromLanguageTag(app.getLocale()),
          silentFailureDetail: maskSecrets(silent.reason),
          // Gate-window observability (issue #36): renderer console output,
          // renderer loss, failed loads, and hangs land in the log through
          // the same masked sink as every other sso line.
          logError: message => { electronLogger.error(maskSecrets(message)) },
          startBrowserLogin: async () => {
            const result = await browserSsoLogin({
              openExternal: async url => { await shell.openExternal(url) },
              request: ssoRequest,
            })
            if (result.ok) {
              electronLogger.error(
                `${BIN_NAME}: sso browser authentication ok (email=${result.session.email})`,
              )
              adoptSession(result.session)
              clientEvents?.ssoLogin(ssoLoginEvent('success', 'browser'))
              return { ok: true as const }
            }
            const reason = maskSecrets(result.reason)
            electronLogger.error(`${BIN_NAME}: sso browser authentication failed: ${reason}`)
            clientEvents?.ssoLogin(ssoLoginEvent('failure', 'browser', result.reason))
            return { ok: false, reason }
          },
        })
        ssoGateWindow = gate
        const verdict = await gate.run()
        ssoGateWindow = undefined
        if (verdict !== 'authenticated') {
          electronLogger.error(`${BIN_NAME}: the sso gate closed without authentication; exiting`)
          lifecycleRecorder.failStartup(startupStage, 'startup-failed')
          await shutdown.request(0)
          return
        }
      }
    }
    // Beta disclaimer gate (2026-09-07): one prompt per client version AND
    // statement revision — no ack (fresh install), a version change (update),
    // or a text-hash change (revised statement) each ask once, everyday boots
    // stay untouched. The check sits where the boot has just authenticated
    // (after adoptSession on both silent and browser paths, with the SSO gate
    // window already closed — AAD 之后的自然挂点) and in dev/unpackaged boots
    // at the identical spot (same rule everywhere, no dev exemption, so the
    // flow is verifiable on real machines), always BEFORE any shell window,
    // Host boot, market, or CLI surface exists — a refusal leaves nothing
    // unlocked behind it. Agree persists the ack (userData/disclaimer-ack.json)
    // and the boot continues; disagree — or closing the window, which is the
    // same refusal — reports the decision and runs the same graceful quit
    // chain the shell's X-close quit uses (dispose teardown, then exit).
    const disclaimerCurrent = { clientVersion: appBuildVersion, textHash: disclaimerTextHash() }
    const disclaimerOutcome = await runDisclaimerGate(disclaimerCurrent, {
      userDataDir: app.getPath('userData'),
      openWindow: () => {
        const window = new DesktopDisclaimerWindow({
          logError: message => { electronLogger.error(maskSecrets(message)) },
        })
        disclaimerWindow = window
        return window
      },
      // Fire-and-forget (never awaited, never throws): a refuse row can be
      // lost when the teardown outpaces the single-row write — accepted
      // trade, documented in disclaimer-gate.ts.
      reportDecision: decision => {
        clientEvents?.disclaimer(disclaimerEvent(decision, disclaimerCurrent))
      },
      logError: message => { electronLogger.error(maskSecrets(message)) },
      quit: async () => {
        electronLogger.error(`${BIN_NAME}: the beta disclaimer was declined; exiting`)
        lifecycleRecorder.failStartup(startupStage, 'startup-failed')
        await shutdown.request(0)
      },
    })
    if (disclaimerOutcome !== 'agreed') {
      disclaimerWindow = undefined
      return
    }
    // Agreed: the window stays alive as the startup loading surface — no
    // empty gap between the prompt and the first successor face. The SSO
    // silent path has no intermediate window, so the loading surface simply
    // lives until the shell window's first show.
    const shellEnvironmentResolution = await resolveDesktopShellEnvironment({
      environment: process.env,
      home: app.getPath('home'),
      isPackaged: app.isPackaged,
      platform: process.platform,
    })
    for (const [name, value] of Object.entries(shellEnvironmentResolution.updates)) process.env[name] = value
    // Corporate network self-injection (Windows-only): Electron/Chromium clears
    // both corporate gates through the system proxy resolver (PAC included) and
    // the system certificate store, but shell descendants fail both — git's
    // libcurl against its packaged CA bundle, the bundled Node against its
    // compiled-in roots — so TLS handshakes are cut mid-flight on inspected
    // networks. Resolve the proxy and export the Windows trust stores into
    // this process's environment BEFORE any child spawns (pnpm, Host,
    // sandboxed pwsh all inherit plain env semantics; dsh-subprocess's scrub
    // keeps proxy and CA names). Every failure logs once and boots bare —
    // behavior identical to a non-corporate network.
    try {
      const corporateNetworkEnvironment = await resolveCorporateNetworkEnv(app, {
        onError: message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
      })
      Object.assign(process.env, corporateNetworkEnvironment)
      const injectedCorporateNetworkKeys = Object.keys(corporateNetworkEnvironment)
      if (injectedCorporateNetworkKeys.length > 0) {
        electronLogger.error(
          `${BIN_NAME}: corporate network environment injected (${injectedCorporateNetworkKeys.join(', ')})`,
        )
      }
    } catch (cause) {
      electronLogger.error(
        `${BIN_NAME}: corporate network environment injection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    const homeDir = resolveDshHome()
    // Deferred fresh-Profile rebuild (P14, Windows EBUSY): a previous boot
    // could not set the Profile directory aside because the OS kept a handle
    // open inside it. The marker lives in userData, so it is read here —
    // before the pnpm runtime install, before any Profile or selection file
    // is opened — and handled before the automatic version-change layer,
    // which also stops it from firing a second rename.
    const freshProfilePendingPath = freshProfilePendingStatePath(app.getPath('userData'))
    const pendingFreshProfileReset = readFreshProfilePending(freshProfilePendingPath)
    if (pendingFreshProfileReset !== undefined) {
      electronLogger.error(
        `${BIN_NAME}: deferred profile rebuild marker present (profile ${pendingFreshProfileReset.profileName}, `
          + `build ${pendingFreshProfileReset.appBuildVersion}, last rename ${pendingFreshProfileReset.reason})`,
      )
    }
    const projectionCacheRecovery = recoverOversizedSessionProjectionCache(homeDir)
    if (projectionCacheRecovery.status === 'quarantined') {
      sessionProjectionCacheRecovery = projectionCacheRecovery
      electronLogger.error(
        `${BIN_NAME}: quarantined oversized session projection cache (${String(projectionCacheRecovery.sizeBytes)} bytes) at `
          + `${projectionCacheRecovery.cachePath}; backup saved to ${projectionCacheRecovery.backupPath}`,
      )
    }
    const windowsVolumeConcerns = diagnoseWindowsVolumes(process.platform, [
      { label: 'application install', path: process.execPath },
      { label: 'desktop user data', path: app.getPath('userData') },
      { label: 'DSH home', path: homeDir },
    ])
    warnWindowsVolumeConcerns(electronLogger, windowsVolumeConcerns)

    const failLoudProcess: FailLoudProcess = {
      on: (event, handler) => process.on(event, handler),
      off: (event, handler) => process.off(event, handler),
      stderr: electronLogger,
      exit: finalExit,
    }
    installFailLoud(BIN_NAME, failLoudProcess, async () => { await generation.release() })

    // Managed-models gate for the company agent preset (locked +
    // managedModels): the Deloitte preset's `tool-web` row carries a `!!js`
    // disabled expression over this environment name, and Loader expressions
    // evaluate in THIS process — here, at the same layer as the gateway token
    // injection below and BEFORE `loadLayeredEnv` takes the launch-environment
    // snapshot and the Host composition loads the preset. The entry is written
    // for every build; the value is '1' only for the effective managed
    // posture, so open, unlocked, and development launches both evaluate the
    // gate to false and scrub any stray inherited '1' — the tool stays enabled
    // exactly as upstream ships it. The gate keeps its own `DSH_`-prefixed
    // name (DSH_COMPANY_MANAGED_MODELS), separate from the CLI policy
    // hand-off (cliPolicyEnvironment below): that hand-off decodes as an
    // all-five group (desktopPolicyFromEnvironment), so a lone
    // hand-off-shaped key in the shared host environment would poison any
    // future consumer reading the hand-off from a host snapshot. The `DSH_`
    // prefix also keeps the name inside the login-shell capture's `DSH_*`
    // scrub (resolveDesktopShellEnvironment) and `loadLayeredEnv`'s `.env`
    // rejection, so neither layer can smuggle a foreign value into the gate.
    const managedModelsGate = managedModelsPresetGateEntry(policy)
    process.env[managedModelsGate.name] = managedModelsGate.value

    // Managed company gateway token injection (locked + managedModels): the
    // gateway api keys enter the process environment here — one entry per
    // blob provider, BEFORE `loadLayeredEnv` takes the launch-environment
    // snapshot — so they land in the snapshot's `process` layer, which is
    // exactly the layer the credentials seam (`dsh-credentials-local`, and
    // through it the `llm-pi-ai` adapter's `apiKeyEnv` resolution) trusts
    // most. The same `process.env` writes also propagate to the terminal and
    // CLI children through normal environment inheritance. User-priority
    // yield, evaluated per provider: an inherited value for that provider's
    // `DSH_`-prefixed environment name, or an entry with that name in
    // `$DSH_HOME/.credentials.yaml` (probed read-only through the upstream
    // parser), keeps the launcher's value out entirely — one provider
    // yielding never affects another; `.env` files cannot carry the
    // `DSH_`-prefixed names at all (upstream rejects them).
    const managedGateway = managedModelGateway(policy)
    const storedCredentials = readStoredCredentialNames(storedCredentialsPath(homeDir))
    const gatewayEnvironment = resolveManagedModelGatewayEnvironment(managedGateway, {
      inheritedEnvironment: process.env,
      storedCredentials,
    })
    if (gatewayEnvironment.managed) {
      for (const [name, value] of Object.entries(gatewayEnvironment.environment)) {
        process.env[name] = value
      }
    }
    if (gatewayEnvironment.managed && storedCredentials.status === 'unreadable') {
      electronLogger.error(
        `${BIN_NAME}: skipping the company gateway token injection because the credentials document could not be probed: ${storedCredentials.reason}`,
      )
    }

    startupStage = 'runtime-bootstrap'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const installRecoveryStatePath = desktopInstallRecoveryStatePath(app.getPath('userData'))
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    const electronVersion = process.versions.electron
    if (electronVersion === undefined) {
      throw new Error(`${BIN_NAME}: plugin runtime requires the Electron runtime version`)
    }
    const pnpmBinPath = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')
    const nodeExecutable = resolveDesktopNodeExecutable(import.meta.url, {
      platform: process.platform,
      environment: process.env,
    })
    const pnpmRuntime = installDesktopPnpmRuntime({
      platform: process.platform,
      nodeExecutable,
      pnpmBinPath,
      electronVersion,
      stateDir: join(app.getPath('userData'), 'runtime-commands'),
      environment: process.env,
    })
    // Installing the pnpm and Python runtimes also publishes their absolute
    // interpreter commands to this process environment
    // (DSH_DESKTOP_NODE_EXECUTABLE / DSH_DESKTOP_PYTHON_EXECUTABLE): a packaged
    // desktop exposes only `.cmd` shims on PATH, which a shell-less spawn
    // cannot execute, so host plugins resolve the real command from there.
    const releasePnpmRuntime = generation.own(() => { pnpmRuntime.dispose() })
    // The bundled Python runtime is Windows-only (embeddable CPython), and a
    // missing or unverifiable distribution disables only this command
    // surface instead of failing application startup — the digest gate is
    // fail-closed per surface, not per application.
    //
    // P16: when the surface is enabled, the published aliases target the
    // desktop-wide shared Python environment (`%LOCALAPPDATA%\DSH Desktop`
    // + `pyenv`), provisioned once from a real local Python when one exists
    // (WindowsApps store stubs excluded by the shared resolution) and from
    // the digest-verified bundled interpreter otherwise — including when
    // the local attempt fails, since the bundled tree ships `virtualenv`.
    // Provisioning spawns run bytecode-blind (`PYTHONDONTWRITEBYTECODE=1`)
    // and write only below the shared root, so the bundled tree stays
    // byte-identical and its packaged digest keeps verifying; any failure
    // logs once and keeps today's behavior (bundled aliases, no pip alias).
    let pythonRuntime: DesktopPythonRuntimeInstallation | undefined
    if (process.platform === 'win32') {
      try {
        const bundledPythonExecutable = resolveDesktopPythonExecutable(import.meta.url, {
          platform: process.platform,
          environment: process.env,
        })
        const sharedPythonEnvironment = await ensureDesktopSharedPythonEnvironment({
          platform: process.platform,
          localPythonExecutable: resolveDesktopLocalPythonExecutable({
            platform: process.platform,
            environment: process.env,
          }),
          bundledPythonExecutable,
          rootDirectory: desktopSharedPythonEnvironmentRoot(process.env, app.getPath('userData')),
          environment: process.env,
          log: message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
        })
        pythonRuntime = installDesktopPythonRuntime({
          platform: process.platform,
          pythonExecutable: sharedPythonEnvironment.pythonExecutable,
          ...(sharedPythonEnvironment.pipExecutable === undefined
            ? {}
            : { pipExecutable: sharedPythonEnvironment.pipExecutable }),
          nodeExecutable,
          pipGatePath: unpackedAsarPath(
            fileURLToPath(new URL('./desktop-pip-gate.js', import.meta.url)),
          ),
          stateDir: join(app.getPath('userData'), 'python-runtime-commands'),
          environment: process.env,
        })
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: the bundled Python runtime is unavailable; python commands stay disabled: `
          + `${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    const releasePythonRuntime = generation.own(() => { pythonRuntime?.dispose() })
    // Client event telemetry (P11): one `python_runtime` row per boot reports
    // whether the bundled Python command surface came up — installation
    // covers the fail-closed digest gate, and every disabled surface
    // (non-Windows builds, dev checkouts, refused trees) reports
    // `available: false` — plus the pinned version the packaged digest
    // manifest names, when that manifest is still readable (a Windows
    // digest refusal keeps it; dev and non-Windows omit the version).
    // The spawn-free pip probe supplies that version, so
    // fleet adoption of the bundled runtime stays observable from both
    // states without ever running the interpreter for telemetry.
    clientEvents?.pythonRuntime(pythonRuntimeEvent(
      pythonRuntime !== undefined,
      pythonPipAvailable(import.meta.url, { platform: process.platform }).pythonVersion,
    ))
    const selectionStatePath = join(app.getPath('userData'), 'profile-selection', 'state.json')
    const pluginManagementStatePath = join(app.getPath('userData'), 'plugin-management', 'state.json')
    const startupRecoveryStatePath = join(app.getPath('userData'), 'startup-recovery', 'state.json')
    startupStage = 'profile-selection'
    lifecycleRecorder.transitionStartupStage(startupStage)
    profileStartup = beginDesktopProfileStartup(selectionStatePath, homeDir)
    const activeProfileName = profileStartup.profileName
    const activeProfileDir = resolveProfileDir(activeProfileName, homeDir)
    const recoveryProfileToken = randomUUID()
    startupRecoveryProfileActions = {
      token: recoveryProfileToken,
      list: () => listDesktopProfiles(homeDir).map(profile => ({
        name: profile.name,
        current: profile.name === activeProfileName,
        selectable: profile.webCapable && profile.problem === undefined,
      })),
      switchProfile: (name, token) => {
        if (token !== recoveryProfileToken || profileRecoveryActionUsed) {
          throw new Error(`${BIN_NAME}: the Profile recovery action is no longer valid`)
        }
        profileRecoveryActionUsed = true
        assertDesktopProfileName(name)
        const selection = readDesktopProfileState(selectionStatePath)
        if (selection.active !== activeProfileName) throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
        const target = listDesktopProfiles(homeDir).find(profile => profile.name === name)
        if (target === undefined || !target.webCapable || target.problem !== undefined) {
          throw new Error(`${BIN_NAME}: Profile ${JSON.stringify(name)} is unavailable`)
        }
        selectDesktopProfile(selectionStatePath, homeDir, name)
      },
      openCreator: () => {
        runtime.openProfileCreateWindow({
          onSubmit: async name => {
            assertDesktopProfileName(name)
            const selection = readDesktopProfileState(selectionStatePath)
            if (selection.active !== activeProfileName) throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
            createDesktopWebProfile(homeDir, name)
            selectDesktopProfile(selectionStatePath, homeDir, name)
          },
        })
      },
    }
    try {
      profileCheckpoint = new DesktopProfileCheckpoint({
        userDataDir: app.getPath('userData'),
        profileDir: activeProfileDir,
        profileName: activeProfileName,
        provider: 'desktop-profile',
        logWarning: message => { electronLogger.error(`${BIN_NAME}: ${maskSecrets(message)}`) },
      })
    } catch (cause) {
      electronLogger.error(
        `${BIN_NAME}: healthy profile checkpoints are unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    // Shared materializer inputs for both dependency-synchronization
    // callers below (restore path and fresh-start path): the packaged
    // Node/pnpm runtime plus the target Profile directory.
    const profileMaterializerOptions = (profileDir: string) => ({
      nodeExecutable,
      pnpmBinPath,
      nodeBinDir: pnpmRuntime.nodeBinDir,
      nodeShimPath: pnpmRuntime.nodeShimPath,
      homeDir,
      profileDir,
      electronVersion,
    })
    // Shared restore-path dependency synchronization (the #73 half-chain
    // fix): re-approve the build whitelist, then run the fixed pnpm install
    // with one retry. Returns false only after both attempts failed — the
    // callers then degrade (pending flag) instead of stranding the restore.
    const materializeRestoredProfile = async (profileDir: string): Promise<boolean> => {
      // The restored snapshot may predate the build-approval whitelist, so
      // re-approve before materializing or pnpm 11 fails the dependency
      // synchronization on ERR_PNPM_IGNORED_BUILDS. Best-effort: a failed
      // approval must not block the restore itself.
      try {
        ensureProfilePnpmBuildApproval(profileDir)
      } catch (approvalCause) {
        electronLogger.error(
          `${BIN_NAME}: profile build approval before restore materialization failed: ${approvalCause instanceof Error ? approvalCause.message : String(approvalCause)}`,
        )
      }
      return await materializeProfileWithRetry(
        profileMaterializerOptions(profileDir),
        (attempt, materializationCause) => {
          const detail = materializationCause instanceof ProfileMaterializationError
            ? materializationCause.result?.stderr || materializationCause.message
            : materializationCause instanceof Error ? materializationCause.message : String(materializationCause)
          electronLogger.error(`${BIN_NAME}: restored profile dependency synchronization failed (attempt ${String(attempt)} of ${String(PROFILE_MATERIALIZATION_ATTEMPTS)}): ${maskSecrets(detail)}`)
        },
      ).then(() => true, () => false)
    }
    // Fresh-Profile dependency synchronization (P14): the same fixed
    // `pnpm install --frozen-lockfile` with one retry the restore path uses,
    // logged under the fresh-start caller. Best-effort by contract — the
    // rebuilt Profile's base bundles resolve through the launcher module
    // fallback, so a failed install degrades instead of blocking the boot.
    const materializeFreshProfile = async (profileDir: string): Promise<boolean> => {
      try {
        ensureProfilePnpmBuildApproval(profileDir)
      } catch (approvalCause) {
        electronLogger.error(
          `${BIN_NAME}: fresh profile build approval before materialization failed: ${approvalCause instanceof Error ? approvalCause.message : String(approvalCause)}`,
        )
      }
      return await materializeProfileWithRetry(
        profileMaterializerOptions(profileDir),
        (attempt, materializationCause) => {
          const detail = materializationCause instanceof ProfileMaterializationError
            ? materializationCause.result?.stderr || materializationCause.message
            : materializationCause instanceof Error ? materializationCause.message : String(materializationCause)
          electronLogger.error(`${BIN_NAME}: fresh profile dependency synchronization failed (attempt ${String(attempt)} of ${String(PROFILE_MATERIALIZATION_ATTEMPTS)}): ${maskSecrets(detail)}`)
        },
      ).then(() => true, () => false)
    }
    // The one rebuild primitive both P14 layers call: the automatic
    // version-change reset below and the recovery window's manual action.
    // A failed rebuild logs and reports telemetry, then lets the boot
    // continue on the existing Profile (the recovery window stays the way
    // out) — it must never crash the startup path it exists to rescue.
    const runFreshProfileSwap = async (
      trigger: 'version-change' | 'recovery-window',
      /** Which automatic rule fired; omitted for the recovery window's manual action. */
      rule?: 'forced' | 'version',
    ): Promise<'swapped' | 'deferred' | 'failed'> => {
      const settingsDocumentPath = join(homeDir, 'settings.yaml')
      try {
        const result = await freshProfileSwap({
          home: homeDir,
          profileName: activeProfileName,
          settingsDocumentPath,
          createProfile: () => {
            if (activeProfileName === DESKTOP_PROFILE_NAME) ensureDesktopProfile(homeDir)
            else createDesktopWebProfile(homeDir, activeProfileName)
          },
          materialize: () => materializeFreshProfile(resolveProfileDir(activeProfileName, homeDir)),
          clearCheckpoint: () => {
            clearDesktopProfileCheckpoint(app.getPath('userData'), resolveProfileDir(activeProfileName, homeDir))
          },
          logError: message => { electronLogger.error(`${BIN_NAME}: ${maskSecrets(message)}`) },
        })
        if (result.deferred === true) {
          // Windows kept a handle inside the Profile for the whole backoff
          // schedule. The existing Profile is untouched and keeps booting;
          // the marker makes the NEXT startup retry this rename before it
          // opens anything, and the generation record is deliberately left
          // unwritten so the version change is still pending.
          await writeFreshProfilePending(freshProfilePendingPath, {
            version: FRESH_PROFILE_PENDING_VERSION,
            profileName: result.profileName,
            appBuildVersion,
            reason: result.reasonCode ?? 'EBUSY',
            // The retry's telemetry must report the layer and rule that
            // actually deferred (P3-c), not a blind version-change.
            trigger,
            ...(rule === undefined ? {} : { rule }),
          })
          electronLogger.error(
            `${BIN_NAME}: fresh profile rebuild deferred (${trigger}): profile ${result.profileName} stayed locked through `
              + `${String(result.attempts ?? 0)} rename attempts (${result.reasonCode ?? 'EBUSY'}); retrying on the next startup`,
          )
          clientEvents?.pluginReset(pluginResetEvent(trigger, {
            profileName: result.profileName,
            outcome: 'deferred',
            materialized: false,
            receiptsCleared: 0,
            ...(rule === undefined ? {} : { rule }),
          }))
          return 'deferred'
        }
        // Review P1: the rebuild just discarded every profile file the
        // install-recovery WAL's before/after images describe, so a WAL left
        // behind can only ever mismatch on the next claim — the recovery
        // window it opens has no working exit on a rebuilt tree (restore
        // mismatches into manual-recovery-required, which refuses every later
        // boot). Retire the WAL bound to this profile right here, on both
        // layers and the recovery window's manual action alike, BEFORE this
        // boot's claim runs below and before the build identity is recorded
        // (a crash in between leaves the record unwritten, so the next boot
        // re-runs the whole swap and this retire again — self-healing, the
        // same window the receipt clear accepts). The store method's phase
        // whitelist keeps genuinely pending recovery transactions (another
        // profile's WAL, a still-live `prepared` install, and — unless the
        // user just confirmed the rebuild by hand — the user-decision phases)
        // untouched; failures log and continue, exactly like the checkpoint
        // and receipt clears above: the rebuilt Profile is still the better
        // state to boot on.
        let installRecoveryRetirement = 'absent'
        try {
          const retirement = await new DesktopInstallRecoveryStore({
            statePath: installRecoveryStatePath,
            profileName: activeProfileName,
            profileDir: resolveProfileDir(activeProfileName, homeDir),
            generationId,
          }).retireForProfileRebuild({ userConfirmedRebuild: trigger === 'recovery-window' })
          installRecoveryRetirement = retirement.status
          if (retirement.status === 'kept') {
            electronLogger.error(
              `${BIN_NAME}: kept the plugin install recovery WAL of phase ${retirement.transaction.phase} (${retirement.reason}) after rebuilding profile ${retirement.transaction.profileName}; its recovery obligations stand`,
            )
          }
        } catch (cause) {
          installRecoveryRetirement = 'failed'
          electronLogger.error(
            `${BIN_NAME}: could not retire the plugin install recovery WAL after rebuilding profile ${activeProfileName}: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
        electronLogger.error(
          `${BIN_NAME}: rebuilt profile ${result.profileName} from scratch (${trigger}${rule === undefined ? '' : `; rule ${rule}`}; backup ${result.backupDir ?? 'none'}; materialized=${String(result.materialized)}; market receipts cleared=${String(result.receiptsCleared)}; install recovery WAL ${installRecoveryRetirement})`,
        )
        clientEvents?.pluginReset(pluginResetEvent(trigger, {
          profileName: result.profileName,
          outcome: 'swapped',
          materialized: result.materialized,
          receiptsCleared: result.receiptsCleared,
          ...(rule === undefined ? {} : { rule }),
        }))
        return 'swapped'
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: fresh profile rebuild failed (${trigger}): ${maskSecrets(cause instanceof Error ? cause.message : String(cause))}`,
        )
        clientEvents?.pluginReset(pluginResetEvent(trigger, {
          profileName: activeProfileName,
          outcome: 'failed',
          materialized: false,
          receiptsCleared: 0,
          ...(rule === undefined ? {} : { rule }),
        }))
        return 'failed'
      }
    }
    // Automatic layer (P14): a locked build rebuilds the active Profile when
    // the identity its policy rule watches changes — upgrade or downgrade
    // alike — so one installer serves a fleet whose plugin sets can never
    // straddle two builds, and a rollback lands on a clean tree too. With
    // `pluginResetOnVersionChange` on, that rule is the full build identity
    // (every build counter). With it off, the rule is the product-version
    // base only: a `2.0.3+b78` → `2.0.3+b79` build bump keeps the Profile,
    // and only `2.0.3` → `2.0.4` rebuilds it. The record lives in userData;
    // an unchanged identity is a pure read (no write, no swap) and an
    // unlocked build never even writes the record. A failed rebuild leaves
    // the record untouched, so the next boot retries it.
    const profileGenerationPath = profileGenerationStatePath(app.getPath('userData'))
    const storedProfileGeneration = readProfileGenerationState(profileGenerationPath)
    const recordProfileGeneration = async (): Promise<void> => {
      await writeProfileGenerationState(profileGenerationPath, {
        version: 1,
        appBuildVersion,
        appVersion,
        updatedAt: new Date().toISOString(),
      })
    }
    // Deferred-retry layer (P14, Windows EBUSY): the previous boot wrote a
    // marker when the set-aside rename stayed locked through every retry.
    // Handled BEFORE the automatic layer so one boot never renames the same
    // directory twice. The marker is dropped only when the policy is
    // UNLOCKED — a build that can never reset has no use for it. The
    // `pluginResetOnVersionChange` switch is not part of this gate: with it
    // off the automatic layer still rebuilds on a product-version change, so
    // dropping the marker would lose that pending rebuild. When the marker
    // names a Profile that is not active this boot it is KEPT and the retry
    // is skipped — dropping it would lose the pending rebuild forever,
    // because the deferred path never recorded the marked Profile's build
    // identity and the automatic layer below records the CURRENT build for
    // whichever Profile is active. A retry that lands clears the marker and
    // records the build; one that defers again leaves the marker and lets the
    // boot continue.
    const freshProfileResetMarkerPolicyLocked = policy.locked === true
    const pendingFreshProfileAction = pendingFreshProfileReset === undefined
      ? undefined
      : freshProfilePendingAction({
        markerProfileName: pendingFreshProfileReset.profileName,
        activeProfileName,
        policyLocked: freshProfileResetMarkerPolicyLocked,
      })
    let pendingFreshProfileHandled = false
    if (pendingFreshProfileReset !== undefined && pendingFreshProfileAction === 'drop') {
      electronLogger.error(
        `${BIN_NAME}: dropping the deferred profile rebuild marker for ${pendingFreshProfileReset.profileName} `
          + `(policy locked=${String(freshProfileResetMarkerPolicyLocked)})`,
      )
      clearFreshProfilePending(freshProfilePendingPath)
    } else if (pendingFreshProfileReset !== undefined && pendingFreshProfileAction === 'keep') {
      electronLogger.error(
        `${BIN_NAME}: keeping the deferred profile rebuild marker for ${pendingFreshProfileReset.profileName} `
          + `(active profile ${activeProfileName}); it retries when that Profile is active`,
      )
    } else if (pendingFreshProfileReset !== undefined && pendingFreshProfileAction === 'retry') {
      pendingFreshProfileHandled = true
      // The marker carries the layer and rule that deferred (P3-c): the retry
      // reports those to `plugin_reset` telemetry. Older markers read without
      // them, so the default is the historical `version-change` / no rule.
      const retryTrigger = pendingFreshProfileReset.trigger ?? 'version-change'
      const retryRule = pendingFreshProfileReset.rule
      electronLogger.error(
        `${BIN_NAME}: retrying the deferred profile rebuild for ${activeProfileName} (last rename ${pendingFreshProfileReset.reason}; deferred by ${retryTrigger}${retryRule === undefined ? '' : `, rule ${retryRule}`})`,
      )
      // The retry can spend the whole rename backoff (~6.3 s) on a boot that
      // has no other window (an everyday cold start whose disclaimer was
      // already acked). Hold a visible loading face for the wait: the
      // disclaimer window's post-agree surface, already on screen when this
      // boot asked the disclaimer, or a fresh one opened here.
      const retrySurfaceOwned = disclaimerWindow === undefined
      const retrySurface = retrySurfaceOwned
        ? new DesktopDisclaimerWindow({
            logError: message => { electronLogger.error(maskSecrets(message)) },
          })
        : undefined
      if (retrySurface !== undefined) {
        disclaimerWindow = retrySurface
        try {
          await retrySurface.openLoadingSurface()
        } catch (cause) {
          electronLogger.error(
            `${BIN_NAME}: could not open the deferred-rebuild loading surface: ${maskSecrets(cause instanceof Error ? cause.message : String(cause))}`,
          )
        }
      }
      try {
        if (await runFreshProfileSwap(retryTrigger, retryRule) === 'swapped') {
          clearFreshProfilePending(freshProfilePendingPath)
          await recordProfileGeneration()
        }
      } finally {
        // Only retire the surface this layer opened; a disclaimer window the
        // boot already owns stays until the first successor face.
        if (retrySurfaceOwned) disposeDisclaimerLoading()
      }
    }
    // Which rule this build compares identities by: the policy switch on is
    // the forced per-build rule, off is the product-version rule. Reported in
    // the log and `plugin_reset` telemetry so a real machine says which one
    // fired.
    const resetRule: 'forced' | 'version' = policy.pluginResetOnVersionChange === true ? 'forced' : 'version'
    // No manifest means a genuinely fresh install: there is no third-party
    // composition to strip, so a missing record only records the build
    // instead of rebuilding. (A recorded build that differs still resets
    // even without a manifest — the record proves another build managed
    // this home.) Kept as its own fact because the record branch below also
    // gates on it: a user-deleted Profile directory leaves the same shape.
    const profileExists = existsSync(join(activeProfileDir, 'package.json'))
    const freshProfileDecision = freshProfileResetDecision({
      locked: policy.locked,
      resetOnVersionChange: policy.pluginResetOnVersionChange,
      ...(storedProfileGeneration === undefined
        ? {}
        : {
            previousAppBuildVersion: storedProfileGeneration.appBuildVersion,
            previousAppVersion: storedProfileGeneration.appVersion,
          }),
      appBuildVersion,
      appVersion,
      profileExists,
    })
    if (freshProfileDecision === 'reset' && !pendingFreshProfileHandled) {
      electronLogger.error(
        `${BIN_NAME}: build identity changed (${storedProfileGeneration?.appBuildVersion ?? 'unknown'} -> ${appBuildVersion}; rule ${resetRule}); rebuilding profile ${activeProfileName}`,
      )
      if (await runFreshProfileSwap('version-change', resetRule) === 'swapped') {
        await recordProfileGeneration()
      }
    } else if (freshProfileDecision === 'record') {
      await recordProfileGeneration()
      // A manifest-less Profile at boot only gets its identity recorded, but
      // a residual market ledger from that Profile's previous life must not
      // survive: its receipts can never verify against the empty directory
      // and would pin the market's installed list to an error. Gated on the
      // manifest fact, not the decision string — the version rule also
      // records for a Profile that still has plugins.
      //
      // Second gate (review P2): this clear runs long before the boot's
      // failure path may restore a healthy checkpoint (which resurrects
      // package.json, the lockfile, and node_modules). A restorable snapshot
      // must therefore keep the receipts — the restored plugins come back
      // installed, and a cleared ledger would make the market treat them as
      // external and refuse a reinstall with a conflict. A checkpoint whose
      // probe fails is as good as no snapshot for this boot: the restore
      // reads the same store and would fail the same validation, so no
      // resurrected plugin can exist. Likewise an undefined checkpoint (its
      // construction failed above) means the store could not be opened at
      // all — the receipts are dead weight that would pin the market's
      // installed view to an error, so the clear stands.
      let restoreSnapshotExists = false
      if (profileCheckpoint !== undefined) {
        try {
          restoreSnapshotExists = profileCheckpoint.inspectRestore().snapshotExists
        } catch (cause) {
          electronLogger.error(
            `${BIN_NAME}: healthy profile snapshot probe failed before receipt clearing: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      }
      await clearFreshProfileRecordReceipts({
        profileExists,
        restoreSnapshotExists,
        settingsDocumentPath: join(homeDir, 'settings.yaml'),
        profileName: activeProfileName,
        logError: message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
      })
    }
    startupRecoveryConfigurationPaths = {
      settingsDocument: join(homeDir, 'settings.yaml'),
      profilePatch: join(activeProfileDir, PROFILE_PATCH_FILENAME),
      profileManifest: join(activeProfileDir, 'package.json'),
      profileDirectory: activeProfileDir,
    }
    installRecovery = new DesktopInstallRecoveryStore({
      statePath: installRecoveryStatePath,
      profileName: activeProfileName,
      profileDir: activeProfileDir,
      generationId,
    })
    const stateCommit = new DesktopStartupStateCommit({
      profile: profileStartup,
      profileStatePath: selectionStatePath,
      installRecovery,
      quiesceForRecovery: () => generation.quiesceForRecovery(),
      logger: electronLogger,
    })
    startupStateCommit = stateCommit
    startupRecoveryController = new DesktopStartupRecoveryController({
      pluginState: {
        profileName: activeProfileName,
        homeDir,
        statePath: startupRecoveryStatePath,
      },
      generationId,
      currentGeneration: () => ({
        profileName: readDesktopProfileState(selectionStatePath).active,
        generationId,
      }),
      installRecovery,
    })
    startupStage = 'install-recovery'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const recoveryClaim = await installRecovery.claim()
    stateCommit.observeInstallRecoveryClaim(recoveryClaim)
    protectedInstallVerificationActive = recoveryClaim.action === 'verify'
    if (recoveryClaim.action === 'prompt') {
      electronLogger.error(
        `${BIN_NAME}: protected plugin install ${recoveryClaim.transaction.packageName} (${recoveryClaim.transaction.transactionId}) requires a recovery choice after ${recoveryClaim.reason}`,
      )
      const recoveryResult = await openStartupRecoveryWindow(
        `Protected plugin installation ${recoveryClaim.transaction.packageName}@${recoveryClaim.transaction.packageVersion} requires a recovery choice after ${recoveryClaim.reason}.`,
        startupRecoveryController,
      )
      startupRecoveryController.dispose()
      startupRecoveryController = undefined
      if (recoveryResult === 'restart') nativeExit.requestRelaunch()
      lifecycleRecorder.failStartup(startupStage, 'startup-failed')
      await shutdown.request(recoveryResult === 'restart' ? 0 : 1)
      return
    } else if (
      recoveryClaim.action === 'terminal'
      && recoveryClaim.transaction.phase === 'manual-recovery-required'
    ) {
      throw new Error(`${BIN_NAME}: plugin install recovery requires manual repair before this profile can start`)
    } else if (
      recoveryClaim.action === 'terminal'
      && recoveryClaim.transaction.phase === 'rolled-back'
      && recoveryClaim.transaction.rollbackNotifiedAt === undefined
    ) {
      rolledBackInstallToNotify = recoveryClaim.transaction
    } else if (recoveryClaim.action === 'deferred') {
      electronLogger.error(
        `${BIN_NAME}: deferred plugin install recovery (${recoveryClaim.reason}) for ${recoveryClaim.transaction.packageName}`,
      )
    }
    startupStage = 'profile-composition'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const marketUserDataDir = app.getPath('userData')
    const marketSelection = readDesktopMarketStateForUserData(marketUserDataDir, policy)
    // Beta catalog channel (P9): the shared host resolver — fetch
    // `catalog-manifest.beta.json` from the policy-pinned origin beside the
    // stable manifest, verify it under the same trust roots with the beta
    // channel's one recognized extension (the signed `testers` roster), and
    // admit it only when the locally authenticated SSO identity is in that
    // roster. Origin-mode deployments only (content-mode policies pin no
    // origin to derive the beta URL from); every failure resolves to
    // `undefined`, and each consumer — boot verification, the market catalog
    // provider, the tarball install channel — then keeps the stable
    // manifest alone, exactly today's behavior. One diagnostic line per
    // outcome; the roster contents and the identity never appear in it.
    // The beta catalog resolution options are shared by the boot-time call
    // (which additionally reports the telemetry outcome) and the capability
    // closures below — same session lookup, same Chromium network boundary,
    // same diagnostic sink.
    const betaCatalogOptions = (): Omit<DesktopBetaChannelOptions, 'onOutcome'> => {
      const session = getSsoSession()
      return {
        policy,
        request: (url, init) => net.fetch(url, init),
        ...(session === undefined ? {} : { session }),
        ...(electronLogger === undefined
          ? {}
          : { log: (message: string) => { electronLogger.error(`${message}`) } }),
      }
    }
    const resolveBetaCatalogOverlay = policy.locked && policy.companyCatalogOrigin !== null
      ? () => resolveDesktopBetaChannelOverlay(betaCatalogOptions())
      : undefined
    // The boot-time resolution starts concurrently with the stable manifest
    // fetch below, so a healthy origin adds no boot latency; a hanging one
    // is bounded by the resolver's own whole-request timeout. This ONE call
    // also reports the beta channel's `catalog_refresh` event — the shared
    // closure above stays silent, so later re-resolutions (the market
    // catalog provider, the tarball channel) keep the event table at one
    // row per boot per channel instead of one per scan.
    const bootBetaOverlayPromise = resolveBetaCatalogOverlay === undefined
      ? undefined
      : resolveDesktopBetaChannelOverlay({
        ...betaCatalogOptions(),
        onOutcome: outcome => {
          clientEvents?.catalogRefresh(betaCatalogRefreshEvent(outcome))
        },
      })
    // Production wiring for locked boot verification (P2-4 + L2): the
    // receipts and manifest bytes come from the shared market settings
    // document, the embedded catalog asset (content mode), or one restricted
    // pre-composition fetch (origin mode). The origin-mode fetch rides
    // Electron's Chromium network stack: the main-process global fetch is
    // Node's undici with the bundled Mozilla trust store, which ignores the
    // Windows system certificate store, so corporate-CA origins only verify
    // through `net.fetch`. The injected measure wraps the
    // full tree measurement with the persisted stat-fingerprint cache so
    // receipt-anchored repeat boots skip the full content hash; authority
    // entries (signed `treeDigest`) signal the `'signed-tree'` purpose and
    // the wrapper bypasses the user-writable cache, measuring those trees in
    // full on every boot. Without this the receipt reconciliation and the
    // sequence ratchet would never run outside tests.
    // Boot-time beta overlay snapshot (client event telemetry): the overlay
    // this generation verified, retained for install channel attribution —
    // a market install of an overlay-only `name@version` is a beta-channel
    // delivery. Non-roster and origin-less boots keep it undefined.
    let bootBetaOverlay: DesktopBetaChannelOverlay | undefined
    const bootVerificationInputs = policy.locked
      ? await desktopBootVerificationInputs(
        policy,
        join(homeDir, 'settings.yaml'),
        import.meta.url,
        {
          fetchManifestText: fetchCompanyManifestTextOverElectronNet,
          measureTreeRootDigest: createCachedDesktopBootTreeRootDigestMeasure(
            join(marketUserDataDir, DESKTOP_BOOT_TREE_FINGERPRINTS_FILENAME),
          ),
          // Beta overlay (P9): resolved concurrently with the stable fetch
          // above; a rejected promise must never block the boot (the overlay
          // is best-effort — undefined keeps boot verification stable-only).
          ...(await (async () => {
            if (bootBetaOverlayPromise === undefined) return {}
            const overlay = await bootBetaOverlayPromise.catch(() => undefined)
            bootBetaOverlay = overlay
            return overlay === undefined ? {} : { betaOverlay: overlay }
          })()),
        },
      )
      : undefined
    // Origin-mode CLI byte hand-off: the bundled-Node desktop-cli children
    // (market installs, terminal adds) cannot reach a corporate-CA origin
    // with their own fetch, so stage the exact bytes boot verification just
    // fetched and point every child at them through DSH_COMPANY_MANIFEST_FILE;
    // the child still verifies the signature itself. The staging file lives
    // for this generation only — the release hook removes it, and a stale
    // path degrades to the child's restricted network fetch (fail-closed).
    // A failed staging write never blocks the boot: the children fall back
    // to their restricted network fetch exactly like a content-mode build.
    let companyManifestHandoff: Awaited<ReturnType<typeof stageCompanyManifestForCliChildren>> = undefined
    if (policy.companyCatalogOrigin !== null) {
      try {
        companyManifestHandoff = await stageCompanyManifestForCliChildren(
          marketUserDataDir,
          generationId,
          bootVerificationInputs?.manifestBytes,
        )
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: staging the company catalog manifest for CLI children failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    if (companyManifestHandoff !== undefined) {
      generation.own(() => { companyManifestHandoff.dispose() })
    }
    const cliPolicyEnvironment: Record<string, string> = {
      ...desktopPolicyEnvironmentEntries(policy),
      ...(companyManifestHandoff?.environment ?? {}),
    }
    await healDesktopProfileModuleFallback(homeDir)
    const prepared = prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      activeProfileName,
      pluginManagementStatePath,
      marketSelection,
      startupRecoveryStatePath,
      {
        onSettingsDocumentResolved: settingsDocument => {
          if (startupRecoveryConfigurationPaths === undefined) return
          startupRecoveryConfigurationPaths = {
            ...startupRecoveryConfigurationPaths,
            settingsDocument,
          }
        },
      },
      policy,
      bootVerificationInputs,
    )
    await healDesktopProfileModuleFallback(homeDir, prepared.profile)
    // P4-1: persist this boot's verification decision so every diagnostic
    // export — tray, recovery window, or headless CLI — can embed the exact
    // allowed and refused bundle lists in its signed self-check report.
    if (!writeDesktopBootVerificationSnapshot(app.getPath('userData'), prepared.bootVerification)) {
      electronLogger.error(
        `${BIN_NAME}: failed to persist the boot verification snapshot for diagnostics`,
      )
    }
    // Rejection visibility (2026-09-08): the refusal already rides the DB
    // boot_verify event and the diagnostics snapshot, but the persistent
    // dsh-*.log stayed silent — a silently disabled plugin (the pnpm peer
    // suffix incident) was undebuggable on real machines. One error line
    // per refused bundle; the reason text is omitted because it can embed
    // profile-dir paths the log masking does not cover — the bounded code
    // names the branch here, the snapshot keeps the full reason.
    for (const rejected of prepared.bootVerification?.rejected ?? []) {
      const version = rejected.installedVersion === undefined ? '' : `@${rejected.installedVersion}`
      electronLogger.error(
        `${BIN_NAME}: boot verification rejected ${rejected.packageName}${version} (code=${rejected.code})`,
      )
    }
    // Deferred-window visibility (P15): a `client-update-required` bundle
    // loaded on receipt evidence while its update waits on a desktop client
    // upgrade — one bounded line per deferred bundle, same masking posture
    // as the refusal lines (package, versions, runtime; no paths).
    for (const deferred of prepared.bootVerification?.deferredUpdates ?? []) {
      electronLogger.error(
        `${BIN_NAME}: boot verification deferred ${deferred.packageName}@${deferred.installedVersion} (waiting ${deferred.availableVersion}, requires dsh runtime ${deferred.requiredRuntime}; upgrade the desktop client)`,
      )
    }
    // Client event telemetry (2026-09-07): the stable catalog's refresh
    // outcome — every locked boot resolves it, stable-only machines included
    // (that is this hook: the beta channel's event rode the boot overlay
    // resolution above) — and the boot verification refusals, reported only
    // when at least one bundle was refused so healthy boots stay silent.
    const stableCatalogEvent = stableCatalogRefreshEvent(
      prepared.bootVerification === undefined
        ? undefined
        : {
          manifestTrusted: prepared.bootVerification.manifestTrusted,
          manifestSequence: prepared.bootVerification.manifestSequence,
          manifestFailureCode: prepared.bootVerification.manifestFailure?.code,
        },
      bootVerificationInputs?.manifestBytes,
    )
    if (stableCatalogEvent !== undefined) clientEvents?.catalogRefresh(stableCatalogEvent)
    const bootVerifyDetail = bootVerifyEvent(prepared.bootVerification)
    if (bootVerifyDetail !== undefined) clientEvents?.bootVerify(bootVerifyDetail)
    if (profileCheckpoint === undefined) {
      try {
        profileCheckpoint = new DesktopProfileCheckpoint({
          userDataDir: app.getPath('userData'),
          profileDir: prepared.profile.dir,
          profileName: activeProfileName,
          provider: 'desktop-profile',
          logWarning: message => { electronLogger.error(`${BIN_NAME}: ${maskSecrets(message)}`) },
        })
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: healthy profile checkpoints remain unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    // Durable retry of a degraded restore (#73): a restore whose dependency
    // synchronization failed left the pending flag on the restore marker, so
    // every later generation re-attempts the sync here — before the Host and
    // renderer boot on top of the restored declarative profile. A corrupt
    // checkpoint must never block the boot: probe failures only log.
    if (profileCheckpoint !== undefined) {
      try {
        if (profileCheckpoint.dependencySyncPending()) {
          electronLogger.error(`${BIN_NAME}: retrying the pending restored profile dependency synchronization`)
          if (await materializeRestoredProfile(prepared.profile.dir)) {
            profileCheckpoint.setDependencySyncPending(false)
          }
        }
      } catch (cause) {
        electronLogger.error(
          `${BIN_NAME}: pending restored profile dependency synchronization was unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    if (prepared.marketFailure !== undefined) {
      electronLogger.error(
        `${BIN_NAME}: requested Market provider ${prepared.market.requested} was disabled for this generation: ${prepared.marketFailure}`,
      )
    }
    startupStage = 'runtime-bootstrap'
    lifecycleRecorder.transitionStartupStage(startupStage)
    // The bundled-Node terminal and Host-plugin subprocesses execute this
    // entry directly, so it must be the physical app.asar.unpacked path; a
    // virtual ASAR path is only readable inside the Electron process (P3-2).
    const dshBootstrapPath = unpackedAsarPath(
      fileURLToPath(new URL('./desktop-cli.js', import.meta.url)),
    )
    const dshRuntime = process.platform === 'win32'
      ? installDesktopDshRuntime({
          platform: process.platform,
          nodeExecutable,
          dshBootstrapPath,
          cliPolicyEnvironment,
          profileName: activeProfileName,
          homeDir,
          stateDir: join(app.getPath('userData'), 'host-commands', activeProfileName),
          installRecoveryStatePath,
          environment: process.env,
        })
      : undefined
    const releaseDshRuntime = generation.own(() => { dshRuntime?.dispose() })
    const desktopPnpmBootstrap: DesktopPnpmBootstrap = {
      activeProfileName,
      activeProfileDir: prepared.profile.dir,
      homeDir,
      nodeExecutable,
      pnpmBinPath,
      electronVersion,
      nodeBinDir: pnpmRuntime.nodeBinDir,
      nodeShimPath: pnpmRuntime.nodeShimPath,
      dshBootstrapPath,
      installRecoveryStatePath,
      generationId,
      externalMarketInstallEnabled: prepared.market.effective === 'dsh-market',
      // The install child runs the packaged desktop-cli, which cannot read
      // the in-archive policy asset and fails closed without the hand-off.
      cliPolicyEnvironment,
    }
    const restoreProfileCheckpoint = async (
      checkpoint: DesktopProfileCheckpoint,
      profileName: string,
      profileDir: string,
      attemptId: string,
      forceMaterialization = false,
      showNotice = true,
    ): Promise<boolean> => {
      const inspection = checkpoint.inspectRestore(attemptId)
      if (!inspection.snapshotExists || inspection.restoreAttempted
        || (!inspection.currentDiffers && !forceMaterialization)) return false
      try {
        const diagnosticsPath = await exportDesktopDiagnostics(app.getPath('userData'), {
          appVersion,
          crashDumpsDir: app.getPath('crashDumps'),
        })
        electronLogger.error(`${BIN_NAME}: startup diagnostics saved before profile restore: ${diagnosticsPath}`)
      } catch (diagnosticCause) {
        electronLogger.error(
          `${BIN_NAME}: failed to export diagnostics before profile restore: ${diagnosticCause instanceof Error ? diagnosticCause.message : String(diagnosticCause)}`,
        )
      }
      const restored = checkpoint.restoreLatest(attemptId)
      if (restored.status !== 'restored') return false
      const dependencyFilesChanged = restored.changedFiles.some(name =>
        name === 'package.json' || name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml')
      if (dependencyFilesChanged || forceMaterialization) {
        const synchronized = await materializeRestoredProfile(profileDir)
        if (!synchronized) {
          // Degrade, never strand (#73): the declarative restore stands and
          // this boot continues on the restored state, while the pending flag
          // on the checkpoint's restore marker makes the next generation
          // re-attempt the dependency synchronization before the Host boots.
          // Returning false here would falsely deny a restore that already
          // mutated the profile and leave no retry anywhere.
          try {
            checkpoint.setDependencySyncPending(true)
          } catch (pendingCause) {
            electronLogger.error(
              `${BIN_NAME}: failed to mark the restored profile dependency synchronization as pending: ${pendingCause instanceof Error ? pendingCause.message : String(pendingCause)}`,
            )
          }
        }
      }
      if (showNotice) {
        await showProfileCheckpointRestoreNotice(
          profileName,
          desktopLocaleFromLanguageTag(app.getLocale()),
          electronLogger,
        )
      }
      return true
    }
    restoreHealthyProfile = async () => {
      const checkpoint = profileCheckpoint
      if (checkpoint === undefined) return false
      return await restoreProfileCheckpoint(
        checkpoint,
        activeProfileName,
        activeProfileDir,
        generationId,
      )
    }
    restoreLastKnownGoodProfile = async (token: string) => {
      if (token !== recoveryProfileToken || profileRecoveryActionUsed) {
        throw new Error(`${BIN_NAME}: the Profile recovery action is no longer valid`)
      }
      profileRecoveryActionUsed = true
      const selection = readDesktopProfileState(selectionStatePath)
      if (selection.active !== activeProfileName) throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
      const targetProfile = selection.lastKnownGood
      const target = listDesktopProfiles(homeDir).find(profile => profile.name === targetProfile)
      if (target === undefined || !target.webCapable || target.problem !== undefined) {
        throw new Error(`${BIN_NAME}: last-known-good Profile is unavailable`)
      }
      const targetDir = resolveProfileDir(targetProfile, homeDir)
      const targetCheckpoint = targetProfile === activeProfileName && profileCheckpoint !== undefined
        ? profileCheckpoint
        : new DesktopProfileCheckpoint({
            userDataDir: app.getPath('userData'),
            profileDir: targetDir,
            profileName: targetProfile,
            provider: 'desktop-profile',
          })
      if (!targetCheckpoint.inspectRestore().snapshotExists) {
        throw new Error(`${BIN_NAME}: no healthy configuration snapshot is available`)
      }
      if (!await generation.quiesceForRecovery()) {
        throw new Error(`${BIN_NAME}: Host could not be stopped safely for Profile recovery`)
      }
      const restored = await restoreProfileCheckpoint(
        targetCheckpoint,
        targetProfile,
        targetDir,
        `manual-${generationId}-${randomUUID()}`,
        true,
        false,
      )
      if (!restored) throw new Error(`${BIN_NAME}: healthy Profile snapshot was not restored`)
      selectDesktopProfile(selectionStatePath, homeDir, targetProfile)
    }
    // Manual layer (P14): the recovery window's fresh-Profile start runs the
    // same rebuild primitive as the automatic version-change reset. It is
    // the way out for the case the automatic layer cannot cover — a bad
    // install with no build-identity change — and it stays available on a
    // healthy machine too (idempotent: the rebuilt Profile is simply fresh).
    // The button exists only once the boot reaches this assignment: a failure
    // during profile composition or boot verification happens earlier, in the
    // same window the existing last-known-good rollback covers, so those early
    // failures are not offered this action.
    freshProfileStart = async (token: string) => {
      if (token !== recoveryProfileToken || profileRecoveryActionUsed) {
        throw new Error(`${BIN_NAME}: the Profile recovery action is no longer valid`)
      }
      profileRecoveryActionUsed = true
      const selection = readDesktopProfileState(selectionStatePath)
      if (selection.active !== activeProfileName) throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
      if (!await generation.quiesceForRecovery()) {
        throw new Error(`${BIN_NAME}: Host could not be stopped safely for a fresh Profile start`)
      }
      const outcome = await runFreshProfileSwap('recovery-window')
      if (outcome === 'deferred') {
        // The marker is written: the rebuild is queued for the next startup,
        // not failed. Say exactly that instead of reporting a failure the
        // user would try to "fix" by pressing the button again.
        throw new Error(
          `${BIN_NAME}: the Profile directory is locked by another process; the rebuild is queued and will complete automatically after DSH Desktop restarts`,
        )
      }
      if (outcome === 'failed') {
        throw new Error(`${BIN_NAME}: the fresh Profile start failed; see the desktop log for details`)
      }
      // A manual swap that landed satisfies a deferred-rebuild marker for
      // this Profile (review P2): clear it and record this build, or the next
      // startup repeats a whole swap the user just performed by hand. A
      // marker naming another Profile stays — its pending rebuild is not
      // this swap's to spend.
      if (readFreshProfilePending(freshProfilePendingPath)?.profileName === activeProfileName) {
        clearFreshProfilePending(freshProfilePendingPath)
      }
      await recordProfileGeneration()
    }
    startupStage = 'host-boot'
    lifecycleRecorder.transitionStartupStage(startupStage)
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    // Configure the launcher-owned terminal before Host boot so the native
    // recovery window can still open it when profile composition fails.
    runtime.configureTerminal({
      profileName: activeProfileName,
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
      // The bundled-Node CLI child cannot read the in-archive policy asset, so
      // the locked state, trust roots, and any staged origin-mode manifest
      // bytes ride the generated shim (P3 fix + L2 TLS hand-off).
      cliPolicyEnvironment,
    })
    recoveryTerminalAvailable = true
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
        generation.bindHost(hostCtx)
        hostCtx.effect(
          () => releasePnpmRuntime,
          'dsh-plugin-desktop: packaged pnpm runtime PATH',
        )
        if (pythonRuntime !== undefined) {
          hostCtx.effect(
            () => releasePythonRuntime,
            'dsh-plugin-desktop: packaged python runtime PATH',
          )
        }
        if (dshRuntime !== undefined) {
          hostCtx.effect(
            () => releaseDshRuntime,
            'dsh-plugin-desktop: packaged dsh runtime PATH',
          )
        }
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        hostCtx.provide('desktopPolicy', policy)
        // P8: the agent-browser executor runs in this process — the host
        // tree, the window, and the CDP session share the Electron main
        // loop (design §2). Construction is lazy: no window exists until
        // the first browser_open, and the partition token is resolved then
        // (§5.2: a one-shot token, or the persisted UUID when the user
        // enabled login persistence and the policy allows it).
        const agentBrowserSession = new DesktopAgentBrowserSession({
          createWindowHost: options => new DesktopAgentBrowserWindowHost(options),
          mintPartitionToken: () => `dsh-agent-browser-${randomUUID()}`,
          login: {
            store: new AgentBrowserLoginFileStore(
              join(app.getPath('userData'), 'agent-browser', 'login-state.json'),
            ),
            mintUuid: () => randomUUID(),
            wipePersistedPartition: async (partition) => {
              await clearAgentBrowserPersistedPartition(
                session,
                app.getPath('userData'),
                partition,
                electronLogger === undefined
                  ? undefined
                  : message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
              )
            },
            // §5.2 double gate: the policy flag rides the executor itself, so
            // a persist partition stops mounting the moment the policy flips
            // — not just when the settings UI happens to be closed.
            policyAllowsPersist: policy.agentBrowser.allowPersistLogin,
          },
          // B4 §5.5 enforcement binding: the guest-side pre-commit guards
          // (will-navigate / will-redirect deny, §5.5) and the download
          // refusal (§5.1) read the SAME embedded policy the tool-level
          // open/navigate gate reads, so every enforcement point flips
          // together with the company config.
          navigationPolicy: policy.agentBrowser,
          ...(electronLogger === undefined ? {} : {
            logError: message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
          }),
        })
        hostCtx.provide('desktopAgentBrowser', agentBrowserSession)
        if (!policy.agentBrowser.allowPersistLogin) {
          // §5.2 enforcement (B3 review): a policy flip to false must not
          // leave the previously persisted login partition on disk either —
          // the executor falls back to one-shot partitions for every window,
          // and this one-shot wipe resets the login document so the residue
          // is cleared instead of silently remaining. A failed wipe throws
          // before the reset, so the next launch retries it.
          void agentBrowserSession.enforceLoginPersistencePolicy().catch(cause => {
            electronLogger?.error(`${BIN_NAME}: the agent-browser login-policy residue wipe failed (retrying on the next launch): ${cause instanceof Error ? cause.message : String(cause)}`)
          })
        }
        // Field-aware manifest verification for the locked market catalog
        // (the market's `desktopCompanyManifestVerifier` capability): the
        // catalog provider's scan and the signed-manifest install whitelist
        // derived from it verify through the same dual-channel verifier as
        // boot and the locked terminal add — a `source`-carrying manifest
        // lights up the market UI's catalog instead of being rejected whole
        // by the field-unaware default verifier.
        hostCtx.provide(
          'desktopCompanyManifestVerifier',
          desktopCompanyManifestVerifierForMarket(policy),
        )
        // Beta catalog overlay (P9): the market catalog provider resolves
        // the signed SSO tester roster through this capability — the same
        // shared resolver boot verification and the tarball channel use. A
        // non-roster machine resolves to undefined and the provider scans
        // the stable manifest alone, byte-for-byte today's behavior.
        if (resolveBetaCatalogOverlay !== undefined) {
          hostCtx.provide('desktopCompanyBetaCatalog', resolveBetaCatalogOverlay)
        }
        // Client event telemetry (2026-09-07): the market library reports
        // every install attempt through this capability (its
        // `desktopClientEventReporter` seam) and this adapter forwards the
        // categorical facts into `dsh_client_events`. The channel column is
        // desktop knowledge: an install whose `name@version` the boot-time
        // beta overlay delivered and the stable manifest does not pin is a
        // beta-channel delivery; everything else is stable. A missing
        // collector (offline policy) keeps the adapter as a silent no-op —
        // the market's behavior never depends on telemetry.
        const installBetaDeliveredKeys = betaDeliveredPackageKeys(
          bootBetaOverlay?.packages,
          bootVerificationInputs?.manifestBytes,
        )
        const clientEventReporterForMarket: MarketInstallEventSink = {
          reportInstallEvent: event => {
            clientEvents?.pluginInstall(pluginInstallEvent(event, installBetaDeliveredKeys))
          },
        }
        hostCtx.provide('desktopClientEventReporter', clientEventReporterForMarket)
        if (policy.locked) {
          // Tarball install orchestration for the market UI (P7 2c): one
          // channel object serves two capabilities. The market library
          // consumes its verifier view (`desktopMarketTarballEntryVerifier`)
          // so catalog entries published on the tarball channel verify with
          // their signed facts instead of failing the registry verification;
          // the desktop pnpm boundary consumes its diversion view
          // (`desktopCompanyMarketTarballInstall`) so the market's install
          // request for such an entry runs the controlled pipeline — stage →
          // install → signed tree re-verification → rollback — instead of
          // the registry target. Origin-mode fetches (manifest and tarball)
          // ride the same Chromium network boundary boot verification uses,
          // and the anti-rollback floor is the shared receipts ratchet.
          const companyMarketTarballInstall = createDesktopCompanyMarketTarballInstallChannel({
            policy,
            profileDir: prepared.profile.dir,
            lastSeenSequence: () => {
              let highest: number | undefined
              for (const receipt of readDesktopBootReceiptsFromSettings(join(homeDir, 'settings.yaml'))) {
                if (highest === undefined || receipt.manifestSequence > highest) highest = receipt.manifestSequence
              }
              return highest
            },
            fetchManifestText: fetchCompanyManifestTextOverElectronNet,
            request: (url, init) => net.fetch(url, init),
            // Beta overlay (P9): beta tarball entries verify through the
            // shared resolver before the registry cross-check would reject
            // their signed sha512.
            ...(resolveBetaCatalogOverlay === undefined
              ? {}
              : { betaOverlay: resolveBetaCatalogOverlay }),
            ...(electronLogger === undefined
              ? {}
              : {
                  warn: message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
                  // Post-install assertion failures (bundle identity, bundle
                  // patch, signed tree digest) reach the desktop log file
                  // with their assertion name and expected-vs-actual detail.
                  logError: message => { electronLogger.error(`${BIN_NAME}: ${message}`) },
                }),
          })
          hostCtx.provide('desktopMarketTarballEntryVerifier', companyMarketTarballInstall)
          hostCtx.provide('desktopCompanyMarketTarballInstall', companyMarketTarballInstall)
        }
        if (policy.companyCatalogOrigin !== null) {
          // Origin-mode market catalog fetches ride the same Chromium network
          // boundary boot verification uses: the community market's portable
          // restricted client refuses the internal GitLab origin's
          // private-network addresses by design and Node's https does not
          // trust the corporate CA, so the host injects this client (the
          // market's `desktopCompanyCatalogHttp` capability) for exactly the
          // policy-pinned manifest URL. Community sources keep the restricted
          // client; the signature gate over the returned bytes is unchanged.
          hostCtx.provide(
            'desktopCompanyCatalogHttp',
            companyCatalogHttpOverElectronNet(policy),
          )
        }
        await hostCtx.plugin(DesktopActionsService, {
          openTerminal: () => { runtime.openTerminal() },
          requestRestart: () => runtime.requestRestart(),
        })
        if (prepared.market.effective === 'community-market') {
          await hostCtx.plugin(DesktopPluginsService, {
            profileName: activeProfileName,
            homeDir,
            statePath: pluginManagementStatePath,
            recoveryStatePath: startupRecoveryStatePath,
            installAnchor: desktopInstallAnchor(),
          })
        }
        if (logSink !== undefined) {
          fileExporter = new FileExporter(logSink)
          hostCtx.logger.exporter(fileExporter)
        }
        await hostCtx.plugin(DesktopProfileService, {
          current: {
            name: activeProfileName,
            dir: prepared.profile.dir,
          },
          create: name => createDesktopWebProfile(homeDir, name),
          list: () => listDesktopProfiles(homeDir),
          canDelete: name => canDeleteDesktopProfile({
            home: homeDir,
            selectionStatePath,
            currentProfileName: activeProfileName,
          }, name),
          delete: name => deleteDesktopProfile({
            home: homeDir,
            selectionStatePath,
            currentProfileName: activeProfileName,
            ...(installRecovery === undefined ? {} : { installRecovery }),
            clearDisabledState: () => clearDesktopProfilePluginState(pluginManagementStatePath, name),
            clearCheckpoint: () => clearDesktopProfileCheckpoint(app.getPath('userData'), resolveProfileDir(name, homeDir)),
          }, name),
          persistSelection: name => { selectDesktopProfile(selectionStatePath, homeDir, name) },
          requestRestart: () => runtime.requestRestart(),
        })
        let pendingSettingsRestart: ReturnType<typeof setImmediate> | undefined
        const scheduleSettingsRestart = (): void => {
          pendingSettingsRestart ??= setImmediate(() => {
            pendingSettingsRestart = undefined
            void runtime.requestRestart().catch((cause: unknown) => {
              hostCtx.logger.error(
                `${BIN_NAME}: failed to restart after Desktop setting change: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            })
          })
        }
        hostCtx.effect(() => () => {
          if (pendingSettingsRestart !== undefined) clearImmediate(pendingSettingsRestart)
          pendingSettingsRestart = undefined
        }, 'dsh-plugin-desktop: pending Desktop settings restart')
        const readMarket = () => desktopMarketSnapshotWithEffective(
          readDesktopMarketStateForUserData(marketUserDataDir),
          prepared.market.effective,
        )
        const prepareProfileRollback = () => {
          if (profileRollbackPrepared) {
            throw new Error(`${BIN_NAME}: a last-known-good Profile restore is already pending`)
          }
          const selection = readDesktopProfileState(selectionStatePath)
          if (selection.active !== activeProfileName) {
            throw new Error(`${BIN_NAME}: active Profile changed before recovery`)
          }
          const targetProfile = selection.lastKnownGood
          const target = listDesktopProfiles(homeDir).find(candidate => candidate.name === targetProfile)
          if (target === undefined || !target.webCapable || target.problem !== undefined) {
            throw new Error(`${BIN_NAME}: last-known-good Profile is unavailable`)
          }
          const targetDir = resolveProfileDir(targetProfile, homeDir)
          let targetCheckpoint: DesktopProfileCheckpoint | undefined
          let targetSnapshotExists = false
          if (target.exists) {
            targetCheckpoint = targetProfile === activeProfileName && profileCheckpoint !== undefined
              ? profileCheckpoint
              : new DesktopProfileCheckpoint({
                  userDataDir: app.getPath('userData'),
                  profileDir: targetDir,
                  profileName: targetProfile,
                  provider: 'desktop-profile',
                })
            targetSnapshotExists = targetCheckpoint.inspectRestore().snapshotExists
          }
          if (targetCheckpoint === undefined || !targetSnapshotExists) {
            throw new Error(`${BIN_NAME}: no healthy configuration snapshot is available`)
          }
          profileRollbackPrepared = true
          return Object.freeze({
            response: Object.freeze({
              accepted: true as const,
              restartRequired: true as const,
              targetProfile,
            }),
            afterResponse: () => {
              void (async () => {
                const fresh = readDesktopProfileState(selectionStatePath)
                if (fresh.active !== activeProfileName || fresh.lastKnownGood !== targetProfile) {
                  throw new Error(`${BIN_NAME}: Profile selection changed before recovery`)
                }
                if (!await generation.quiesceForRecovery()) {
                  throw new Error(`${BIN_NAME}: Host could not be stopped safely for Profile recovery`)
                }
                const restored = await restoreProfileCheckpoint(
                  targetCheckpoint,
                  targetProfile,
                  targetDir,
                  `manual-${generationId}`,
                  true,
                )
                if (!restored) throw new Error(`${BIN_NAME}: healthy Profile snapshot was not restored`)
                stateCommit.restoreLastKnownGoodProfile()
                nativeExit.requestRelaunch()
                await shutdown?.request(0)
              })().catch(async (cause: unknown) => {
                const detail = cause instanceof Error ? cause.message : String(cause)
                electronLogger.error(
                  `${BIN_NAME}: explicit last-known-good Profile restore failed: ${detail}`,
                )
                const recoveryResult = await openStartupRecoveryWindow(
                  `The requested last-known-good Profile restore could not be completed: ${detail}`,
                  startupRecoveryController,
                )
                if (recoveryResult === 'restart') nativeExit.requestRelaunch()
                await shutdown?.request(recoveryResult === 'restart' ? 0 : 1)
              })
            },
          })
        }
        hostCtx.provide('desktopSettingsController', new DesktopSettingsController({
          // Same single signal as the update gate: the renderer settings view
          // hides its Profile, Market, and presentation rows on locked builds.
          locked: policy.locked,
          profiles: hostCtx.desktopProfiles,
          persistProfileSelection: name => {
            selectDesktopProfile(selectionStatePath, homeDir, name)
          },
          readMarket,
          selectMarket: async provider => desktopMarketSnapshotWithEffective(
            await selectDesktopMarketProvider(marketUserDataDir, provider),
            prepared.market.effective,
          ),
          scheduleRestart: scheduleSettingsRestart,
          openTerminal: () => { runtime.openTerminal() },
          exportDiagnostics: () => runtime.exportDiagnostics(),
          openProfileCreator: () => {
            runtime.openProfileCreateWindow({
              onSubmit: async name => {
                hostCtx.desktopProfiles.create(name)
                await hostCtx.desktopProfiles.select(name)
              },
            })
          },
          readSso: () => {
            const session = getSsoSession()
            if (session === undefined) return undefined
            return projectSsoSession(session.email, session.source)
          },
          prepareProfileRollback,
          // §5.2/B3: the persist-login settings group rides the same
          // controller seam as every other Desktop preference. `allowed` is
          // the policy gate (hidden group + refused POSTs when false).
          ...(policy.agentBrowser.enabled
            ? {
              agentBrowserLogin: {
                allowed: policy.agentBrowser.allowPersistLogin,
                read: () => agentBrowserSession.describeLogin(),
                setPersistLogin: (enabled: boolean) => agentBrowserSession.setPersistLogin(enabled),
                clearLoginState: () => agentBrowserSession.clearLoginState(),
              },
            }
            : {}),
        }))
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', String(prepared.port)],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    })
    generation.bindHost(ctx)
    fileExporter?.setThreshold((ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE) as DesktopSettings | undefined)?.logLevel ?? 'info')
    ctx.on('settings/updated', (namespace, next) => {
      if (namespace !== DESKTOP_SETTINGS_NAMESPACE) return
      fileExporter?.setThreshold((next as DesktopSettings).logLevel)
    })
    startupStage = 'renderer-startup'
    lifecycleRecorder.transitionStartupStage(startupStage)
    lifecycleRecorder.startRendererBoot()
    const rendererBoot = runtime.beginRendererBootMonitoring({
      commitHealthy: async () => {
        lifecycleRecorder.finishRendererBoot({ status: 'healthy' }, 'renderer-failed')
        startupStage = 'health-commit'
        lifecycleRecorder.transitionStartupStage(startupStage)
        await stateCommit.commitHealthy()
        try {
          profileCheckpoint?.captureHealthy()
        } catch (cause) {
          electronLogger.error(
            `${BIN_NAME}: failed to checkpoint the healthy profile configuration: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      },
    })
    const [, rendererVerdict] = await Promise.all([
      runtime.mountScheduled(),
      rendererBoot,
    ])
    const rendererReport = rendererVerdict.report
    if (!('failureReason' in rendererVerdict)) {
      if (rolledBackInstallToNotify !== undefined) {
        const notified = await showInstallRollbackNotice(
          rolledBackInstallToNotify,
          desktopLocaleFromLanguageTag(app.getLocale()),
          electronLogger,
        )
        if (notified && installRecovery !== undefined) {
          try {
            const transaction = rolledBackInstallToNotify
            if (transaction.receiptId.startsWith('dsh-market:')) {
              // dsh-market has no receipt ledger to reconcile. Its Desktop
              // compatibility receipt exists only to bind the recovery WAL,
              // so the launcher owns cleanup after the user sees the result.
              await installRecovery.clear(transaction.transactionId)
            } else {
              await installRecovery.markRollbackNotified(transaction.transactionId)
            }
            rolledBackInstallToNotify = undefined
          } catch (cause) {
            electronLogger.error(
              `${BIN_NAME}: failed to persist install rollback notice: ${cause instanceof Error ? cause.message : String(cause)}`,
            )
          }
        }
      }
    } else {
      throw new RendererStartupFailure(
        rendererVerdict.failureReason,
        rendererVerdict.report,
      )
    }
    lifecycleRecorder.completeStartup(startupStage, rendererReport)
    notifySkippedOptionalEntries(runtime, electronLogger, prepared.skippedOptionalEntries)
    notifyWindowsVolumeConcerns(runtime, electronLogger, windowsVolumeConcerns)
    notifyPendingBootPluginUpdates(runtime, electronLogger, prepared.bootVerification)
    notifyDeferredBootClientUpdates(runtime, electronLogger, prepared.bootVerification)
    if (profileStartup.rolledBackFrom !== undefined) {
      notifyProfileRecovery(
        runtime,
        electronLogger,
        `Reopened last-known-good profile ${activeProfileName}.`,
      )
    }
    if (sessionProjectionCacheRecovery !== undefined) {
      notifySessionProjectionCacheRecovery(runtime, electronLogger, sessionProjectionCacheRecovery)
    }
  } catch (cause) {
    runtime.stopRendererBootMonitoring()
    lifecycleRecorder.failRendererBootIfPending(lifecycleRendererFailureReason(runtime.rendererBootFailureReason))
    lifecycleRecorder.failStartup(startupStage, lifecycleStartupFailureReason(cause, runtime))
    electronLogger.errorCause(cause)
    let exitCode = 1
    const failureReason: DesktopInstallRecoveryFailureReason = cause instanceof RendererStartupFailure
      ? cause.reason
      : runtime.rendererBootFailureReason ?? 'startup-failed'
    if (!protectedInstallVerificationActive && restoreHealthyProfile !== undefined) {
      const recoveryActionsSafe = await generation.quiesceForRecovery()
      if (recoveryActionsSafe) {
        try {
          if (await restoreHealthyProfile()) {
            nativeExit.requestRelaunch()
            startupRecoveryController?.dispose()
            await shutdown.request(0)
            return
          }
        } catch (restoreCause) {
          electronLogger.error(
            `${BIN_NAME}: latest healthy profile restore was unavailable: ${restoreCause instanceof Error ? restoreCause.message : String(restoreCause)}`,
          )
        }
      }
    }
    const failureCommit = startupStateCommit === undefined
      ? {
          route: routeDesktopStartupFailure({
            appReady: app.isReady(),
            stage: startupStage,
            verifyingProtectedInstall: false,
            ...(profileStartup === undefined
              ? {}
              : {
                  profile: {
                    active: profileStartup.profileName,
                    lastKnownGood: profileStartup.state.lastKnownGood,
                  },
                }),
          }),
          recoveryActionsSafe: await generation.quiesceForRecovery(),
        }
      : await startupStateCommit.commitFailure({
          appReady: app.isReady(),
          stage: startupStage,
          failureReason,
        })
    const failureRoute = failureCommit.route
    if (failureCommit.reopenLastKnownGood !== undefined) {
      nativeExit.requestRelaunch()
      exitCode = 0
      notifyProfileRecovery(
        runtime,
        electronLogger,
        `Reopening last-known-good profile ${failureCommit.reopenLastKnownGood}.`,
      )
    }
    if (exitCode !== 0
      && (failureRoute === 'protected-install-recovery' || failureRoute === 'startup-recovery')) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      const recoveryResult = await openStartupRecoveryWindow(
        detail,
        failureCommit.recoveryActionsSafe ? startupRecoveryController : undefined,
      )
      if (recoveryResult === 'restart') {
        nativeExit.requestRelaunch()
        exitCode = 0
      }
    }
    startupRecoveryController?.dispose()
    await shutdown.request(exitCode)
  }
}

async function run(): Promise<void> {
  app.setName(PRODUCT_NAME)
  if (process.argv.includes('--export-diagnostics')) {
    try {
      await app.whenReady()
      const path = await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: desktopBuildVersion(),
        crashDumpsDir: app.getPath('crashDumps'),
      })
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${path}\n`, error => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      })
      app.exit(0)
    } catch (cause) {
      const message = `dsh-plugin-desktop: failed to export diagnostics: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`
      await new Promise<void>(resolve => {
        process.stderr.write(message, () => { resolve() })
      })
      app.exit(1)
    }
    return
  }
  await start()
}

/** Last-resort branch for launcher failures that happen before start's owned coordinator exists. */
async function handleFatalLauncherFailure(cause: unknown): Promise<void> {
  const detail = maskSecrets(cause instanceof Error ? cause.stack ?? cause.message : String(cause))
  process.stderr.write(`${BIN_NAME}: fatal launcher failure: ${detail}\n`)
  if (!app.isReady()) {
    app.exit(1)
    return
  }
  try {
    // The last-resort recovery window is a visible successor face too.
    disposeDisclaimerLoading()
    const recoveryWindow = new DesktopStartupRecoveryWindow({
      locale: desktopLocaleFromLanguageTag(app.getLocale()),
      failureStage: 'electron-ready',
      failureDetail: detail,
      exportDiagnostics: async signal => await exportDesktopDiagnostics(app.getPath('userData'), {
        appVersion: desktopBuildVersion(),
        crashDumpsDir: app.getPath('crashDumps'),
        signal,
      }),
    })
    const result = await recoveryWindow.run()
    if (result === 'restart') {
      app.relaunch()
      app.exit(0)
    } else {
      app.exit(1)
    }
  } catch (windowCause) {
    process.stderr.write(
      `${BIN_NAME}: fatal recovery window failure: ${maskSecrets(windowCause instanceof Error ? windowCause.stack ?? windowCause.message : String(windowCause))}\n`,
    )
    app.exit(1)
  }
}

void run().catch(async (cause: unknown) => { await handleFatalLauncherFailure(cause) })
