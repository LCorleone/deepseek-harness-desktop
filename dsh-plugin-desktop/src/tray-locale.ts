/** Desktop-owned native tray copy for the locales shipped by DSH. */

import type { DesktopLocale } from './runtime.ts'

export type DesktopTrayLabelKey =
  | 'addProfile'
  | 'checkForUpdates'
  | 'checkingForUpdates'
  | 'downloadingUpdate'
  | 'exportDiagnostics'
  | 'openDesktop'
  | 'openTerminal'
  | 'profile'
  | 'quit'
  | 'signedInAs'
  | 'switchToAdvanced'
  | 'switchToCompatibility'
  | 'unavailableForDesktop'
  | 'updateAvailable'

const labels: Record<DesktopLocale, Record<DesktopTrayLabelKey, (value: string) => string>> = {
  en: {
    addProfile: () => 'Add Profile…',
    checkForUpdates: () => 'Check for Updates…',
    checkingForUpdates: () => 'Checking for Updates…',
    downloadingUpdate: version => `Downloading Deloitte DSH Desktop ${version}…`,
    exportDiagnostics: () => 'Export Diagnostics…',
    openDesktop: productName => `Open ${productName}`,
    openTerminal: () => 'Open DSH Terminal',
    profile: profileName => `Profile: ${profileName}`,
    quit: () => 'Quit',
    signedInAs: email => `Signed in: ${email}`,
    switchToAdvanced: () => 'Switch to Advanced Mode',
    switchToCompatibility: () => 'Switch to Compatibility Mode',
    unavailableForDesktop: profileName => `${profileName} (Unavailable for Desktop)`,
    updateAvailable: version => `Deloitte DSH Desktop ${version} Available`,
  },
  zh: {
    addProfile: () => '添加配置…',
    checkForUpdates: () => '检查更新…',
    checkingForUpdates: () => '正在检查更新…',
    downloadingUpdate: version => `正在下载 Deloitte DSH Desktop ${version}…`,
    exportDiagnostics: () => '导出诊断信息…',
    openDesktop: productName => `打开 ${productName}`,
    openTerminal: () => '打开 DSH 终端',
    profile: profileName => `配置文件：${profileName}`,
    quit: () => '退出',
    signedInAs: email => `已登录：${email}`,
    switchToAdvanced: () => '切换到高级模式',
    switchToCompatibility: () => '切换到兼容模式',
    unavailableForDesktop: profileName => `${profileName}（不可用于桌面端）`,
    updateAvailable: version => `Deloitte DSH Desktop ${version} 可用`,
  },
}

export interface DesktopDiagnosticsPrivacyCopy {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly confirm: string
  readonly cancel: string
}

/** Shape shared by native recovery/restore prompts (title, message, detail, buttons). */
export interface DesktopRestartConfirmationCopy {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly confirm: string
  readonly cancel: string
}

/** Fallback prompt after automatic renderer recovery is exhausted (tray-locale pattern). */
export const rendererRecoveryCopy: Record<DesktopLocale, DesktopRestartConfirmationCopy> = {
  en: {
    title: 'Restore DSH Desktop',
    message: 'The interface could not recover automatically.',
    detail: 'Automatic recovery stopped after repeated failures to avoid a restart loop. You can try again without restarting the background service. Unsent input may be lost. Export diagnostics from the tray to investigate. Choose Open DSH Desktop from the tray to return to this prompt later.',
    confirm: 'Try recovery again',
    cancel: 'Not now',
  },
  zh: {
    title: '恢复 DSH Desktop',
    message: '界面未能自动恢复。',
    detail: '自动恢复连续失败，为避免重启循环已暂停。可以再次尝试恢复，无需重启后台服务。未发送的输入可能丢失。请从托盘导出诊断信息以继续调查。稍后可从托盘选择“打开 DSH Desktop”再次打开此提示。',
    confirm: '再次尝试恢复',
    cancel: '暂不处理',
  },
}

const diagnosticsPrivacyCopy: Record<DesktopLocale, DesktopDiagnosticsPrivacyCopy> = {
  en: {
    title: 'Export Diagnostics',
    message: 'Review the diagnostic archive before sharing it.',
    detail: 'The archive contains recent application logs, local crash dumps, and system information. Logs may contain local paths, workspace IDs, and session IDs. Crash dumps may contain fragments of process memory. Authentication credentials are masked in logs when recognized, but you should still review the archive before uploading it publicly.',
    confirm: 'Export',
    cancel: 'Cancel',
  },
  zh: {
    title: '导出诊断信息',
    message: '分享诊断包前请先检查其中的内容。',
    detail: '诊断包包含最近的应用日志、本地崩溃转储和系统信息。日志可能包含本地路径、工作区 ID 和会话 ID，崩溃转储可能包含进程内存片段。系统会对日志中可识别的认证凭据进行脱敏，但公开上传前仍应检查诊断包。',
    confirm: '导出',
    cancel: '取消',
  },
}

/** Resolve DSH's zh/en locale from an Electron or browser language tag. */
export function desktopLocaleFromLanguageTag(languageTag: string): DesktopLocale {
  return /^zh(?:[-_]|$)/i.test(languageTag) ? 'zh' : 'en'
}

/** Resolve one native tray label in the active desktop locale. */
export function desktopTrayLabel(
  locale: DesktopLocale,
  key: DesktopTrayLabelKey,
  value = '',
): string {
  return labels[locale][key](value)
}

/** Resolve the native privacy confirmation shown before diagnostics export. */
export function desktopDiagnosticsPrivacyCopy(locale: DesktopLocale): DesktopDiagnosticsPrivacyCopy {
  return diagnosticsPrivacyCopy[locale]
}
