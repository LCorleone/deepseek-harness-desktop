/** Bilingual copy for the pre-Host native Setup Wizard. */

import type { DesktopLocale } from './runtime.ts'

export interface DesktopSetupWizardCopy {
  readonly title: string
  readonly heading: string
  readonly introduction: string
  readonly profile: string
  readonly appearanceTab: string
  readonly accessTab: string
  readonly notificationsTab: string
  readonly presentationTitle: string
  readonly presentationBody: string
  readonly compatibilityMode: string
  readonly compatibilityModeBody: string
  readonly extendedMode: string
  readonly extendedModeBody: string
  readonly advancedMode: string
  readonly advancedModeBody: string
  readonly unavailableOnLinux: string
  readonly windowMaterial: string
  readonly windowMaterialBody: string
  readonly materialOff: string
  readonly materialTransparent: string
  readonly materialAcrylic: string
  readonly materialMica: string
  readonly browserTitle: string
  readonly browserBody: string
  readonly openBrowser: string
  readonly networkExposure: string
  readonly networkExposureBody: string
  readonly loopback: string
  readonly loopbackBody: string
  readonly lan: string
  readonly lanBody: string
  readonly lanWarningTitle: string
  readonly lanWarningBody: string
  readonly confirmLan: string
  readonly cancelLan: string
  readonly marketTitle: string
  readonly marketBody: string
  readonly marketDisabled: string
  readonly marketDisabledBody: string
  readonly communityMarket: string
  readonly communityMarketBody: string
  readonly dshMarket: string
  readonly dshMarketBody: string
  readonly notificationsTitle: string
  readonly notificationsBody: string
  readonly notificationsEnabled: string
  readonly turnCompletion: string
  readonly turnFailure: string
  readonly jobCompletion: string
  readonly jobFailure: string
  readonly complete: string
  readonly skip: string
  readonly invalidState: string
}

const COPY: Record<DesktopLocale, DesktopSetupWizardCopy> = {
  en: {
    title: 'Set up DSH Desktop',
    heading: 'Set up this Profile',
    introduction: 'Choose the initial Desktop experience. You can change these options later in Desktop settings.',
    profile: 'Profile',
    appearanceTab: 'Window',
    accessTab: 'Browser & market',
    notificationsTab: 'Notifications',
    presentationTitle: 'Window mode',
    presentationBody: 'Choose how DSH Desktop presents the official client.',
    compatibilityMode: 'Compatibility mode',
    compatibilityModeBody: 'Keep the official client layout for the broadest compatibility.',
    extendedMode: 'Extended window',
    extendedModeBody: 'Add Desktop controls around the official content area.',
    advancedMode: 'Enhanced mode',
    advancedModeBody: 'Use the layout and window interactions optimized for Desktop.',
    unavailableOnLinux: 'This mode is currently available on macOS and Windows.',
    windowMaterial: 'Window material',
    windowMaterialBody: 'Choose the transparency or glass effect used by the Desktop window.',
    materialOff: 'No window material',
    materialTransparent: 'Transparent',
    materialAcrylic: 'Acrylic',
    materialMica: 'Mica',
    browserTitle: 'Browser access',
    browserBody: 'Choose whether to open the client in your browser and who can reach it.',
    openBrowser: 'Open the client in my browser after startup',
    networkExposure: 'Network access',
    networkExposureBody: 'Loopback keeps access on this computer. LAN makes the client reachable from your local network.',
    loopback: 'This computer only',
    loopbackBody: 'Listen on loopback addresses only.',
    lan: 'Local network',
    lanBody: 'Allow other devices on the same LAN to open and operate the client.',
    lanWarningTitle: 'Allow control from your local network?',
    lanWarningBody: 'This is dangerous: everyone on your local network may be able to operate your computer directly. Enable it only with great care.',
    confirmLan: 'Enable LAN access',
    cancelLan: 'Keep this computer only',
    marketTitle: 'Plugin market',
    marketBody: 'Choose one plugin market for this Desktop installation.',
    marketDisabled: 'Do not enable a plugin market',
    marketDisabledBody: 'Keep plugin market features turned off.',
    communityMarket: 'dsh-community-market',
    communityMarketBody: 'The open market built into DSH Desktop, including custom data sources.',
    dshMarket: 'dsh-market',
    dshMarketBody: 'The popular community market powered by awesome-dsh-plugin data.',
    notificationsTitle: 'Desktop notifications',
    notificationsBody: 'Choose which completion and failure events send a system notification. Notification text never includes conversation content.',
    notificationsEnabled: 'Enable Desktop notifications',
    turnCompletion: 'User turn completed',
    turnFailure: 'User turn failed',
    jobCompletion: 'Background job completed',
    jobFailure: 'Background job failed',
    complete: 'Finish setup',
    skip: 'Skip setup',
    invalidState: 'Setup information could not be loaded. Close this window and try again.',
  },
  zh: {
    title: '设置 DSH Desktop',
    heading: '设置这个 Profile',
    introduction: '选择初始桌面体验。之后仍可在“桌面设置”中修改这些选项。',
    profile: 'Profile',
    appearanceTab: '窗口',
    accessTab: '浏览器与市场',
    notificationsTab: '通知',
    presentationTitle: '窗口模式',
    presentationBody: '选择 DSH Desktop 如何呈现官方客户端。',
    compatibilityMode: '兼容模式',
    compatibilityModeBody: '保留官方客户端布局，兼容性最好。',
    extendedMode: '扩展窗口',
    extendedModeBody: '在官方内容区域周围增加桌面控制。',
    advancedMode: '增强模式',
    advancedModeBody: '使用针对桌面端优化的布局和窗口交互。',
    unavailableOnLinux: '此模式目前支持 macOS 和 Windows。',
    windowMaterial: '窗口材质',
    windowMaterialBody: '选择桌面窗口使用的透明或玻璃效果。',
    materialOff: '不使用窗口材质',
    materialTransparent: '透明材质',
    materialAcrylic: '亚克力',
    materialMica: 'Mica',
    browserTitle: '浏览器访问',
    browserBody: '选择启动后是否在浏览器中打开客户端，以及谁可以访问。',
    openBrowser: '启动后在我的浏览器中打开客户端',
    networkExposure: '网络访问范围',
    networkExposureBody: '仅本机访问只监听回环地址；局域网访问会让同一网络中的设备能够打开客户端。',
    loopback: '仅这台电脑',
    loopbackBody: '只监听本机回环地址。',
    lan: '局域网',
    lanBody: '允许同一局域网中的其他设备打开并操作客户端。',
    lanWarningTitle: '允许局域网中的设备控制吗？',
    lanWarningBody: '这样很危险，所有在你局域网内的人都能直接操作你的电脑，请谨慎开启。',
    confirmLan: '确认开启局域网访问',
    cancelLan: '保持仅本机访问',
    marketTitle: '插件市场',
    marketBody: '为这套桌面安装选择一个插件市场。',
    marketDisabled: '不启用插件市场',
    marketDisabledBody: '保持插件市场功能关闭。',
    communityMarket: 'dsh-community-market',
    communityMarketBody: 'DSH Desktop 内置的开放市场，并支持自定义数据源。',
    dshMarket: 'dsh-market',
    dshMarketBody: '使用 awesome-dsh-plugin 数据的热门社区市场。',
    notificationsTitle: '桌面通知',
    notificationsBody: '选择哪些完成或失败事件发送系统通知。通知文本不会包含会话内容。',
    notificationsEnabled: '启用桌面通知',
    turnCompletion: '用户回合完成',
    turnFailure: '用户回合失败',
    jobCompletion: '后台任务完成',
    jobFailure: '后台任务失败',
    complete: '完成设置',
    skip: '跳过设置',
    invalidState: '无法加载设置信息。请关闭此窗口后重试。',
  },
}

export function desktopSetupWizardCopy(locale: DesktopLocale): DesktopSetupWizardCopy {
  return COPY[locale]
}
