import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopSetupWizardInput } from '../src/setup-wizard-contract.ts'
import {
  decodeDesktopSetupWizardInput,
  SetupWizardLanConfirmation,
} from '../src/native-ui/setup-wizard/App.tsx'
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

afterEach(() => { vi.unstubAllGlobals() })

describe('Setup Wizard native UI boundaries', () => {
  it('renders the LAN warning as an in-window alert dialog with explicit choices', () => {
    const markup = renderToStaticMarkup(createElement(SetupWizardLanConfirmation, {
      copy: desktopSetupWizardCopy('zh'),
      confirm: () => {},
      cancel: () => {},
    }))
    expect(markup).toContain('role="alertdialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('这样很危险，所有在你局域网内的人都能直接操作你的电脑，请谨慎开启')
    expect(markup).toContain('确认开启局域网访问')
    expect(markup).toContain('保持仅本机访问')
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
