import { describe, expect, it } from 'vitest'
import {
  desktopSetupWizardRequiresLanAcknowledgement,
  desktopSetupWizardRequiresLanConfirmation,
  desktopSetupWizardSelectionIsAvailable,
  isDesktopSetupWizardInput,
  type DesktopSetupWizardInput,
} from '../src/setup-wizard-contract.ts'
import { desktopSetupWizardCopy } from '../src/setup-wizard-copy.ts'

const input: DesktopSetupWizardInput = {
  profileName: 'work',
  platform: 'win32',
  micaSupported: true,
  mode: 'compatibility',
  macosMaterial: 'transparent',
  windowsMaterial: 'mica',
  openBrowser: false,
  networkExposure: 'loopback',
  market: 'disabled',
  notifications: {
    enabled: true,
    notifyOnTurnCompletion: true,
    notifyOnTurnFailure: true,
    notifyOnJobCompletion: true,
    notifyOnJobFailure: true,
  },
}

describe('Desktop Setup Wizard copy and contract', () => {
  it('keeps English and Chinese dictionaries structurally complete', () => {
    const english = desktopSetupWizardCopy('en')
    const chinese = desktopSetupWizardCopy('zh')
    expect(Object.keys(english)).toEqual(Object.keys(chinese))
    expect(Object.values(english).every(value => value.length > 0)).toBe(true)
    expect(Object.values(chinese).every(value => value.length > 0)).toBe(true)
  })

  it('contains the required direct-control LAN danger warning in both locales', () => {
    expect(desktopSetupWizardCopy('zh').lanWarningBody).toContain(
      '这样很危险，所有在你局域网内的人都能直接操作你的电脑，请谨慎开启',
    )
    expect(desktopSetupWizardCopy('en').lanWarningBody).toContain('everyone on your local network')
    expect(desktopSetupWizardCopy('en').lanWarningBody).toContain('operate your computer directly')
  })

  it('describes the sequential navigation, skip confirmation, and final success action', () => {
    const english = desktopSetupWizardCopy('en')
    const chinese = desktopSetupWizardCopy('zh')
    expect(chinese.back).toBe('上一步')
    expect(chinese.next).toBe('下一步')
    expect(chinese.successTitle).toContain('成功')
    expect(chinese.startUsing).toBe('开始使用')
    expect(chinese.skipDialogBody).toContain('设置')
    expect(chinese.skipDialogBody).toContain('桌面设置')
    expect(english.back).toMatch(/^(?:Back|Previous)$/u)
    expect(english.next).toBe('Next')
    expect(english.startUsing).toContain('Start using')
    expect(english.skipDialogBody).toContain('Settings')
    expect(english.skipDialogBody).toContain('Desktop settings')
  })

  it('introduces first-time setup for the current Profile before showing settings', () => {
    const english = desktopSetupWizardCopy('en')
    const chinese = desktopSetupWizardCopy('zh')
    expect(chinese.welcomeTitle).toBeTruthy()
    expect(chinese.welcomeBody).toContain('Profile')
    expect(chinese.firstProfileSetup).toContain('第一次')
    expect(chinese.firstProfileSetup).toContain('桌面模式')
    expect(chinese.startSetup).toBe('开始设置')
    expect(english.welcomeTitle).toBeTruthy()
    expect(english.welcomeBody).toContain('Profile')
    expect(english.firstProfileSetup).toMatch(/first(?:-time| time)/iu)
    expect(english.firstProfileSetup).toMatch(/Desktop mode/iu)
    expect(english.startSetup).toBe('Start setup')
  })

  it('treats browser opening as permission, not an automatic startup action', () => {
    const english = desktopSetupWizardCopy('en')
    const chinese = desktopSetupWizardCopy('zh')
    expect(chinese.openBrowser).toBe('允许在浏览器中打开')
    expect(chinese.openBrowser).not.toMatch(/启动后|自动/u)
    expect(chinese.browserCompatibilityNotice).toContain('兼容模式')
    expect(chinese.browserCompatibilityNotice).toMatch(/只(?:能|支持|可)/u)
    expect(english.openBrowser).toMatch(/allow.+(?:open|opening).+browser/iu)
    expect(english.openBrowser).not.toMatch(/after startup|automatically/iu)
    expect(english.browserCompatibilityNotice).toMatch(/only.+compatibility mode/iu)
  })

  it('requires confirmation only when loopback access is changed to LAN', () => {
    expect(desktopSetupWizardRequiresLanConfirmation('loopback', 'lan')).toBe(true)
    expect(desktopSetupWizardRequiresLanConfirmation('lan', 'loopback')).toBe(false)
    expect(desktopSetupWizardRequiresLanConfirmation('lan', 'lan')).toBe(false)
    expect(desktopSetupWizardRequiresLanConfirmation('loopback', 'loopback')).toBe(false)
  })

  it('requires a fresh first-run acknowledgement even when persisted settings already request LAN', () => {
    expect(desktopSetupWizardRequiresLanAcknowledgement('lan', 'lan', false)).toBe(true)
    expect(desktopSetupWizardRequiresLanAcknowledgement('lan', 'lan', true)).toBe(false)
    expect(desktopSetupWizardRequiresLanAcknowledgement('loopback', 'lan', true)).toBe(true)
    expect(desktopSetupWizardRequiresLanAcknowledgement('lan', 'loopback', false)).toBe(false)
  })

  it('strictly validates complete input and platform capability gates', () => {
    expect(isDesktopSetupWizardInput(input)).toBe(true)
    expect(isDesktopSetupWizardInput({ ...input, unexpected: true })).toBe(false)
    expect(isDesktopSetupWizardInput({ ...input, notifications: { enabled: true } })).toBe(false)
    expect(isDesktopSetupWizardInput({ ...input, profileName: '../escape' })).toBe(false)
    expect(isDesktopSetupWizardInput({ ...input, profileName: 'CON' })).toBe(false)
    expect(desktopSetupWizardSelectionIsAvailable(input, input)).toBe(true)
    expect(desktopSetupWizardSelectionIsAvailable(input, { platform: 'win32', micaSupported: false })).toBe(false)
    expect(desktopSetupWizardSelectionIsAvailable(
      { ...input, mode: 'extended', windowsMaterial: 'acrylic' },
      { platform: 'linux', micaSupported: false },
    )).toBe(false)
  })
})
