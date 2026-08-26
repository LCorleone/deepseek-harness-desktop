import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopSetupWizardInput,
  DesktopSetupWizardNetworkExposure,
  DesktopSetupWizardSelection,
} from '../src/setup-wizard-contract.ts'
import {
  decodeDesktopSetupWizardInput,
  DESKTOP_SETUP_WIZARD_STEPS,
  nextDesktopSetupWizardStep,
  previousDesktopSetupWizardStep,
  SetupWizardLanConfirmation,
  SetupWizardNavigation,
  SetupWizardStepPage,
  SetupWizardSuccess,
} from '../src/native-ui/setup-wizard/App.tsx'
import { Button } from '../src/native-ui/components/ui/button.tsx'
import { DialogClose } from '../src/native-ui/components/ui/dialog.tsx'
import { desktopSetupWizardCopy } from '../src/setup-wizard-copy.ts'

const input: DesktopSetupWizardInput = {
  profileName: 'work',
  platform: 'darwin',
  micaSupported: false,
  mode: 'extended',
  macosMaterial: 'transparent',
  windowsMaterial: 'acrylic',
  openBrowser: true,
  networkExposure: 'loopback',
  market: 'community-market',
  notifications: {
    enabled: true,
    notifyOnTurnCompletion: true,
    notifyOnTurnFailure: true,
    notifyOnJobCompletion: false,
    notifyOnJobFailure: true,
  },
}

const selection: DesktopSetupWizardSelection = {
  mode: input.mode,
  macosMaterial: input.macosMaterial,
  windowsMaterial: input.windowsMaterial,
  openBrowser: input.openBrowser,
  networkExposure: input.networkExposure,
  market: input.market,
  notifications: input.notifications,
}

const copy = desktopSetupWizardCopy('zh')

function renderStep(step: Exclude<(typeof DESKTOP_SETUP_WIZARD_STEPS)[number], 'success'>): string {
  return renderToStaticMarkup(createElement(SetupWizardStepPage, {
    copy,
    input,
    requestExposure: (_exposure: DesktopSetupWizardNetworkExposure) => {},
    selection,
    step,
    update: (_next: DesktopSetupWizardSelection) => {},
  }))
}

function occurrences(markup: string, fragment: string): number {
  return markup.split(fragment).length - 1
}

function elementText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return Children.toArray(node).map(elementText).join(' ')
  return elementText((node.props as { readonly children?: ReactNode }).children)
}

function elementTree(node: ReactNode): readonly ReactElement[] {
  const elements: ReactElement[] = []
  Children.forEach(node, child => {
    if (!isValidElement(child)) return
    elements.push(child)
    elements.push(...elementTree((child.props as { readonly children?: ReactNode }).children))
  })
  return elements
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Setup Wizard step flow', () => {
  it('keeps one setting per page and browser access as the final setting page', () => {
    expect(DESKTOP_SETUP_WIZARD_STEPS).toEqual([
      'mode',
      'material',
      'market',
      'notifications',
      'browser',
      'success',
    ])
  })

  it('moves only between adjacent pages and stops at both boundaries', () => {
    expect(DESKTOP_SETUP_WIZARD_STEPS.map(step => previousDesktopSetupWizardStep(step))).toEqual([
      undefined,
      'mode',
      'material',
      'market',
      'notifications',
      'browser',
    ])
    expect(DESKTOP_SETUP_WIZARD_STEPS.map(step => nextDesktopSetupWizardStep(step))).toEqual([
      'material',
      'market',
      'notifications',
      'browser',
      'success',
      undefined,
    ])
  })
})

describe('Setup Wizard setting pages', () => {
  it.each([
    ['mode', 'presentationTitle', 'presentationBody'],
    ['material', 'windowMaterial', 'windowMaterialBody'],
    ['market', 'marketTitle', 'marketBody'],
    ['notifications', 'notificationsTitle', 'notificationsBody'],
    ['browser', 'browserTitle', 'browserBody'],
  ] as const)('renders the %s page with its own title and subtitle', (step, title, body) => {
    const markup = renderStep(step)
    expect(markup).toContain(`data-setup-step="${step}"`)
    expect(markup).toContain(copy[title])
    expect(markup).toContain(copy[body])
    expect(occurrences(markup, 'data-setup-step=')).toBe(1)
  })

  it.each(['mode', 'material', 'market', 'notifications', 'browser'] as const)(
    'lays out the %s page options vertically',
    (step) => {
      expect(renderStep(step)).toContain('data-orientation="vertical"')
    },
  )

  it.each([
    ['mode', copy.presentationTitle],
    ['material', copy.windowMaterial],
    ['market', copy.marketTitle],
    ['browser', copy.networkExposure],
  ] as const)('uses a named shadcn RadioGroup for the %s choices', (step, accessibleName) => {
    const markup = renderStep(step)
    expect(markup).toContain('data-slot="radio-group"')
    expect(markup).toContain(`aria-label="${accessibleName}"`)
    expect(markup).toContain('data-slot="radio-group-item"')
  })

  it('does not combine the plugin market and browser settings', () => {
    const market = renderStep('market')
    const browser = renderStep('browser')
    expect(market).toContain(copy.marketTitle)
    expect(market).not.toContain(copy.browserTitle)
    expect(market).not.toContain(copy.openBrowser)
    expect(browser).toContain(copy.browserTitle)
    expect(browser).not.toContain(copy.marketTitle)
    expect(browser).not.toContain(copy.communityMarket)
    expect(browser).not.toContain(copy.dshMarket)
  })

  it('uses the shadcn Switch component for every wizard toggle', () => {
    const notifications = renderStep('notifications')
    const browser = renderStep('browser')
    expect(occurrences(notifications, 'data-slot="switch"')).toBe(5)
    expect(occurrences(notifications, 'role="switch"')).toBe(5)
    expect(occurrences(browser, 'data-slot="switch"')).toBe(1)
    expect(occurrences(browser, 'role="switch"')).toBe(1)
  })
})

describe('Setup Wizard navigation and completion', () => {
  it('shows Skip on the left and back/forward arrow buttons on every setting page', () => {
    for (const step of DESKTOP_SETUP_WIZARD_STEPS.slice(0, -1)) {
      const markup = renderToStaticMarkup(createElement(SetupWizardNavigation, {
        copy,
        onBack: () => {},
        onNext: () => {},
        onSkip: () => {},
        step,
      }))
      expect(markup).toContain(copy.skip)
      expect(markup).toContain(`aria-label="${copy.back}"`)
      expect(markup).toContain(`aria-label="${copy.next}"`)
      expect(markup).toContain('lucide-arrow-left')
      expect(markup).toContain('lucide-arrow-right')
      expect(markup.indexOf(copy.skip)).toBeLessThan(markup.indexOf(`aria-label="${copy.back}"`))
    }
  })

  it('keeps the first-page back button visible but disabled', () => {
    const markup = renderToStaticMarkup(createElement(SetupWizardNavigation, {
      copy,
      onBack: () => {},
      onNext: () => {},
      onSkip: () => {},
      step: 'mode',
    }))
    expect(markup).toMatch(new RegExp(`<button[^>]+aria-label="${copy.back}"[^>]+disabled`, 'u'))
  })

  it('uses a dialog trigger for Skip and explains where setup remains available', () => {
    const markup = renderToStaticMarkup(createElement(SetupWizardNavigation, {
      copy,
      onBack: () => {},
      onNext: () => {},
      onSkip: () => {},
      step: 'market',
    }))
    expect(markup).toContain('data-slot="dialog-trigger"')
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(copy.skipDialogBody).toContain('设置')
    expect(copy.skipDialogBody).toContain('桌面设置')
  })

  it('renders only centered success and Start using controls on the final page', () => {
    const success = renderToStaticMarkup(createElement(SetupWizardSuccess, {
      copy,
      onStart: () => {},
    }))
    const navigation = renderToStaticMarkup(createElement(SetupWizardNavigation, {
      copy,
      onBack: () => {},
      onNext: () => {},
      onSkip: () => {},
      step: 'success',
    }))
    expect(success).toContain('data-setup-step="success"')
    expect(success).toContain('data-align="center"')
    expect(success).toContain(copy.successTitle)
    expect(success).toContain(copy.successBody)
    expect(success).toContain(copy.startUsing)
    expect(success).not.toContain(copy.skip)
    expect(success).not.toContain(`aria-label="${copy.back}"`)
    expect(success).not.toContain(`aria-label="${copy.next}"`)
    expect(navigation).toBe('')
  })
})

describe('Setup Wizard native UI boundaries', () => {
  it('renders the LAN warning as an in-window alert dialog with explicit choices', () => {
    const dialog = SetupWizardLanConfirmation({
      copy,
      confirm: () => {},
      cancel: () => {},
    })
    const dialogProps = dialog.props as { readonly children?: ReactNode; readonly open?: boolean }
    const content = Children.toArray(dialogProps.children).find(isValidElement) as ReactElement | undefined
    expect(dialogProps.open).toBe(true)
    expect(content).toBeDefined()
    expect(content?.props).toMatchObject({
      'aria-describedby': 'lan-warning-body',
      'aria-labelledby': 'lan-warning-title',
      'aria-modal': 'true',
      role: 'alertdialog',
      showCloseButton: false,
    })
    const text = elementText(content)
    expect(text).toContain('这样很危险，所有在你局域网内的人都能直接操作你的电脑，请谨慎开启')
    expect(text).toContain('确认开启局域网访问')
    expect(text).toContain('保持仅本机访问')
    const descendants = elementTree(content)
    const close = descendants.find(element => element.type === DialogClose)
    const confirm = descendants.find(element => element.type === Button
      && elementText(element).includes(copy.confirmLan)
      && (element.props as { readonly variant?: string }).variant === 'destructive')
    expect(close).toBeDefined()
    expect((close?.props as { readonly render?: ReactElement }).render?.props).toMatchObject({ autoFocus: true })
    expect(confirm).toBeDefined()
    expect((confirm?.props as { readonly autoFocus?: boolean }).autoFocus).not.toBe(true)
  })

  it('decodes only the exact bounded state tuple emitted by the owner window', () => {
    vi.stubGlobal('window', { atob: globalThis.atob })
    const state = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url')
    const valid = `?locale=zh&state=${state}&platform=darwin&frame=true`
    expect(decodeDesktopSetupWizardInput(valid)).toEqual(input)
    expect(decodeDesktopSetupWizardInput(`${valid}&unexpected=true`)).toBeUndefined()
    expect(decodeDesktopSetupWizardInput(valid.replace('platform=darwin', 'platform=win32'))).toBeUndefined()
    expect(decodeDesktopSetupWizardInput(valid.replace('locale=zh', 'locale=fr'))).toBeUndefined()
    expect(decodeDesktopSetupWizardInput(valid.replace('frame=true', 'frame=yes'))).toBeUndefined()
  })
})
