import { describe, expect, it, vi } from 'vitest'
import type {
  DesktopStartupRecoverySnapshot,
} from '../src/startup-recovery-controller.ts'
import {
  desktopStartupRecoveryWindowBounds,
  parseDesktopStartupRecoveryAction,
  renderDesktopStartupRecoveryHtml,
  DesktopStartupRecoveryWindow,
  type DesktopStartupRecoveryScreenApi,
  type DesktopStartupRecoveryViewModel,
} from '../src/startup-recovery-window.ts'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  screen: {},
  shell: {},
}))

function viewModel(
  overrides: Partial<DesktopStartupRecoveryViewModel> = {},
): DesktopStartupRecoveryViewModel {
  return {
    locale: 'zh',
    failureStage: 'profile-composition',
    failureDetail: 'duplicate loader entry id "storage"',
    diagnostics: { status: 'saving' },
    busy: false,
    restartReady: false,
    configurationAvailable: false,
    ...overrides,
  }
}

describe('Desktop startup recovery document', () => {
  it('is a no-script local document with a deny-by-default CSP and a localized stage', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel())

    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('失败阶段')
    expect(html).toContain('插件配置组合')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("object-src 'none'")
    expect(html).toContain("base-uri 'none'")
    expect(html).toContain("form-action 'none'")
    expect(html).toContain("frame-ancestors 'none'")
    expect(html).not.toMatch(/<script\b/iu)
    expect(html).not.toMatch(/\son[a-z]+\s*=/iu)
  })

  it('keeps the page and footer usable at narrow widths', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel())

    expect(html).toContain('.footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap')
    expect(html).toContain('@media(max-width:640px)')
    expect(html).toContain('.footer .button{flex:1 1 180px}')
    expect(html).toContain('@media(max-width:420px)')
    expect(html).toContain('.row-actions,.actions,.footer{align-items:stretch;flex-direction:column}')
  })

  it('escapes failure, profile, bundle, diagnostics, and notice values', () => {
    const snapshot: DesktopStartupRecoverySnapshot = {
      profileName: 'desktop<img src=x onerror="profile-secret">',
      bundles: [{
        bundleId: 'bundle_00000000000000000000000000000000',
        packageName: 'plugin</code><script>bundle-secret</script>',
        status: 'active',
        owner: 'external',
        action: 'disable',
      }],
    }
    const html = renderDesktopStartupRecoveryHtml(viewModel({
      failureDetail: '<script>alert("failure<&\'")</script>',
      snapshot,
      snapshotError: '<img src=x onerror="snapshot-secret">',
      diagnostics: { status: 'saved', filename: '<private&".zip' },
      notice: {
        tone: 'success',
        title: '<b>rollback-secret</b>',
        body: 'restored & <complete>',
      },
    }))

    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>rollback-secret</b>')
    expect(html).toContain('&lt;script&gt;alert(&quot;failure&lt;&amp;&#39;&quot;)&lt;/script&gt;')
    expect(html).toContain('desktop&lt;img src=x onerror=&quot;profile-secret&quot;&gt;')
    expect(html).toContain('plugin&lt;/code&gt;&lt;script&gt;bundle-secret&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=&quot;snapshot-secret&quot;&gt;')
    expect(html).toContain('&lt;private&amp;&quot;.zip')
    expect(html).toContain('&lt;b&gt;rollback-secret&lt;/b&gt;')
    expect(html).toContain('restored &amp; &lt;complete&gt;')
  })

  it('does not expose plugin or install mutation links without a controller snapshot', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel({
      failureStage: 'shell-environment',
      failureDetail: 'login shell failed',
      diagnostics: { status: 'failed' },
    }))

    expect(html).toContain('Shell 环境恢复')
    expect(html).toContain('dsh-recovery://export-diagnostics')
    expect(html).toContain('dsh-recovery://restart')
    expect(html).toContain('dsh-recovery://quit')
    expect(html).not.toContain('dsh-recovery://preview-disable')
    expect(html).not.toContain('dsh-recovery://preview-rollback')
    expect(html).not.toContain('dsh-recovery://preview-retry')
    expect(html).not.toContain('dsh-recovery://confirm-')
    expect(html).not.toContain('dsh-recovery://open-profile-patch')
    expect(html).not.toContain('dsh-recovery://open-settings-document')
  })

  it('offers only fixed profile configuration targets when main provides them', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel({ configurationAvailable: true }))

    expect(html).toContain('手动编辑配置')
    expect(html).toContain('dsh-recovery://open-settings-document')
    expect(html).toContain('dsh-recovery://open-profile-patch')
    expect(html).toContain('dsh-recovery://open-profile-manifest')
    expect(html).toContain('dsh-recovery://open-profile-directory')
    expect(html).not.toContain('/Users/')
  })

  it('offers the fresh-Profile start only when main provides the action', () => {
    const available = renderDesktopStartupRecoveryHtml(viewModel({
      freshProfileStartAvailable: true,
      profileActionToken: 'opaque-token-0001',
    }))

    expect(available).toContain('全新配置启动')
    expect(available).toContain('移除其中已安装的全部第三方插件')
    expect(available).toContain('dsh-recovery://preview-fresh-profile?id=opaque-token-0001')

    const withoutToken = renderDesktopStartupRecoveryHtml(viewModel({
      freshProfileStartAvailable: true,
    }))
    expect(withoutToken).not.toContain('dsh-recovery://preview-fresh-profile')
    expect(renderDesktopStartupRecoveryHtml(viewModel()))
      .not.toContain('全新配置启动')
  })

  it('renders the fresh-Profile confirmation with the bilingual consequence copy', () => {
    const confirmation = { kind: 'fresh-profile' as const, token: 'opaque-token-0001' }
    const zh = renderDesktopStartupRecoveryHtml(viewModel({ confirmation }))

    expect(zh).toContain('确认全新配置启动？')
    expect(zh).toContain('第三方插件会被全部移除')
    expect(zh).toContain('对话记录、设置和登录状态不受影响')
    expect(zh).toContain('dsh-recovery://confirm-fresh-profile?id=opaque-token-0001')
    expect(zh).toContain('dsh-recovery://home')

    const en = renderDesktopStartupRecoveryHtml(viewModel({ confirmation, locale: 'en' }))
    expect(en).toContain('Start with a fresh Profile?')
    expect(en).toContain('Conversations, settings, and sign-in are unaffected')
  })

  it('offers both rollback and one retry for a recovery-pending install', () => {
    const snapshot: DesktopStartupRecoverySnapshot = {
      profileName: 'desktop',
      bundles: [],
      pendingInstall: {
        recoveryId: 'recovery-transaction-0001',
        packageName: 'example-plugin',
        packageVersion: '1.2.3',
        phase: 'recovery-pending',
        rollbackAvailable: true,
        retryAvailable: true,
      },
    }
    const html = renderDesktopStartupRecoveryHtml(viewModel({ snapshot }))

    expect(html).toContain('最近一次受保护安装')
    expect(html).toContain('example-plugin@1.2.3')
    expect(html).toContain('恢复安装前配置')
    expect(html).toContain('仅重试一次')
    expect(html).toContain('dsh-recovery://preview-rollback?id=recovery-transaction-0001')
    expect(html).toContain('dsh-recovery://preview-retry?id=recovery-transaction-0001')
  })

  it('renders the explicit result of a completed rollback', () => {
    const html = renderDesktopStartupRecoveryHtml(viewModel({
      diagnostics: { status: 'saved', filename: 'diagnostics.zip' },
      notice: {
        tone: 'success',
        title: 'example-plugin',
        body: '安装前配置已恢复。请重新启动 Desktop。',
      },
      restartReady: true,
    }))

    expect(html).toContain('notice success')
    expect(html).toContain('example-plugin')
    expect(html).toContain('安装前配置已恢复。请重新启动 Desktop。')
    expect(html).toContain('class="button primary" href="dsh-recovery://restart"')
  })
})

describe('Desktop startup recovery diagnostics export', () => {
  function recoveryWindow(exportDiagnostics: (signal: AbortSignal) => Promise<string>): DesktopStartupRecoveryWindow {
    return new DesktopStartupRecoveryWindow({
      locale: 'zh',
      failureStage: 'profile-composition',
      failureDetail: 'diagnostic export test',
      exportDiagnostics,
    })
  }

  function handleAction(window: DesktopStartupRecoveryWindow): (action: { readonly action: string }) => Promise<void> {
    return (window as unknown as {
      handleAction: (action: { readonly action: string }) => Promise<void>
    }).handleAction.bind(window)
  }

  function finish(window: DesktopStartupRecoveryWindow, result: 'restart' | 'quit'): void {
    (window as unknown as { finish: (value: 'restart' | 'quit') => void }).finish(result)
  }

  function deferred<T>(): {
    readonly promise: Promise<T>
    readonly resolve: (value: T) => void
    readonly reject: (cause: unknown) => void
  } {
    let resolve!: (value: T) => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    return { promise, resolve, reject }
  }

  it('shares an in-flight export and reuses the saved result', async () => {
    const task = deferred<string>()
    const exportDiagnostics = vi.fn(() => task.promise)
    const window = recoveryWindow(exportDiagnostics)
    const runAction = handleAction(window)

    const first = runAction({ action: 'export-diagnostics' })
    await vi.waitFor(() => expect(exportDiagnostics).toHaveBeenCalledOnce())
    const second = runAction({ action: 'export-diagnostics' })

    await Promise.resolve()
    expect(exportDiagnostics).toHaveBeenCalledOnce()
    task.resolve('C:\\Temp\\diagnostics.zip')
    await Promise.all([first, second])

    await runAction({ action: 'export-diagnostics' })
    expect(exportDiagnostics).toHaveBeenCalledOnce()
  })

  it('clears a failed export task so the next attempt can retry', async () => {
    const firstTask = deferred<string>()
    const secondTask = deferred<string>()
    const exportDiagnostics = vi.fn()
      .mockImplementationOnce(() => firstTask.promise)
      .mockImplementationOnce(() => secondTask.promise)
    const window = recoveryWindow(exportDiagnostics)
    const runAction = handleAction(window)

    const first = runAction({ action: 'export-diagnostics' })
    await vi.waitFor(() => expect(exportDiagnostics).toHaveBeenCalledOnce())
    firstTask.reject(new Error('archive unavailable'))
    await first

    const retry = runAction({ action: 'export-diagnostics' })
    await vi.waitFor(() => expect(exportDiagnostics).toHaveBeenCalledTimes(2))
    secondTask.resolve('C:\\Temp\\diagnostics-retry.zip')
    await retry
  })

  it('cancels the in-flight export when the recovery window generation ends', async () => {
    let exportSignal: AbortSignal | undefined
    const exportDiagnostics = vi.fn(async (signal: AbortSignal) => {
      exportSignal = signal
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'))
        }, { once: true })
      })
      return 'unreachable.zip'
    })
    const window = recoveryWindow(exportDiagnostics)
    const pending = handleAction(window)({ action: 'export-diagnostics' })
    await vi.waitFor(() => expect(exportDiagnostics).toHaveBeenCalledOnce())

    finish(window, 'restart')

    await pending
    expect(exportSignal?.aborted).toBe(true)
  })
})

describe('Desktop startup recovery fresh-Profile action', () => {
  function windowWith(freshProfileStart: (token: string) => Promise<void> | void): DesktopStartupRecoveryWindow {
    return new DesktopStartupRecoveryWindow({
      locale: 'zh',
      failureStage: 'profile-composition',
      failureDetail: 'a bad plugin broke the Host',
      exportDiagnostics: async () => 'diagnostics.zip',
      freshProfileStart,
    })
  }

  function handleAction(window: DesktopStartupRecoveryWindow): (action: { readonly action: string; readonly id?: string }) => Promise<void> {
    return (window as unknown as {
      handleAction: (action: { readonly action: string; readonly id?: string }) => Promise<void>
    }).handleAction.bind(window)
  }

  it('asks for confirmation before touching the Profile', async () => {
    const freshProfileStart = vi.fn(async () => {})
    const window = windowWith(freshProfileStart)

    await handleAction(window)({ action: 'preview-fresh-profile', id: 'opaque-token-0001' })

    expect(freshProfileStart).not.toHaveBeenCalled()
    expect((window as unknown as { confirmation?: { kind: string } }).confirmation)
      .toEqual({ kind: 'fresh-profile', token: 'opaque-token-0001' })
  })

  it('runs the swap on confirm and asks for a restart', async () => {
    const freshProfileStart = vi.fn(async () => {})
    const window = windowWith(freshProfileStart)
    const runAction = handleAction(window)

    await runAction({ action: 'preview-fresh-profile', id: 'opaque-token-0001' })
    await runAction({ action: 'confirm-fresh-profile', id: 'opaque-token-0001' })

    expect(freshProfileStart).toHaveBeenCalledWith('opaque-token-0001')
    expect((window as unknown as { confirmation?: unknown }).confirmation).toBeUndefined()
    expect((window as unknown as { restartReady: boolean }).restartReady).toBe(true)
    expect((window as unknown as { notice?: { tone: string; body: string } }).notice)
      .toEqual({
        tone: 'success',
        title: '全新配置启动',
        body: '配置已从出厂状态重建。请重新启动 DSH Desktop。',
      })
  })

  it('reports a failed swap in the window instead of pretending success', async () => {
    const window = windowWith(async () => { throw new Error('profile directory is locked') })

    await handleAction(window)({ action: 'confirm-fresh-profile', id: 'opaque-token-0001' })

    const notice = (window as unknown as { notice?: { tone: string; body: string } }).notice
    expect(notice?.tone).toBe('error')
    expect(notice?.body).toBe('profile directory is locked')
    expect((window as unknown as { restartReady: boolean }).restartReady).toBe(false)
  })

  it('refuses the action when main did not provide it', async () => {
    const window = new DesktopStartupRecoveryWindow({
      locale: 'en',
      failureStage: 'profile-composition',
      failureDetail: 'no profile actions',
      exportDiagnostics: async () => 'diagnostics.zip',
    })

    await handleAction(window)({ action: 'confirm-fresh-profile', id: 'opaque-token-0001' })

    const notice = (window as unknown as { notice?: { tone: string; body: string } }).notice
    expect(notice?.tone).toBe('error')
    expect(notice?.body).toContain('fresh Profile start is unavailable')
  })
})

describe('Desktop startup recovery window bounds', () => {
  function screenApi(
    current: { readonly width: number; readonly height: number } | Error,
    primary: { readonly width: number; readonly height: number } = { width: 1920, height: 1040 },
  ): DesktopStartupRecoveryScreenApi & {
    readonly getCursorScreenPoint: ReturnType<typeof vi.fn>
    readonly getDisplayNearestPoint: ReturnType<typeof vi.fn>
    readonly getPrimaryDisplay: ReturnType<typeof vi.fn>
  } {
    const getCursorScreenPoint = vi.fn(() => ({ x: 120, y: 80 }))
    const getDisplayNearestPoint = vi.fn(() => {
      if (current instanceof Error) throw current
      return { workAreaSize: current }
    })
    const getPrimaryDisplay = vi.fn(() => ({ workAreaSize: primary }))
    return { getCursorScreenPoint, getDisplayNearestPoint, getPrimaryDisplay }
  }

  it('uses the 800x760 default on a spacious current display', () => {
    const electronScreen = screenApi({ width: 1440, height: 900 })

    expect(desktopStartupRecoveryWindowBounds(electronScreen)).toEqual({
      width: 800,
      height: 760,
      minWidth: 680,
      minHeight: 560,
    })
    expect(electronScreen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 120, y: 80 })
    expect(electronScreen.getPrimaryDisplay).not.toHaveBeenCalled()
  })

  it('subtracts 48px and clamps each dimension to the current work area', () => {
    const bounds = desktopStartupRecoveryWindowBounds(screenApi({ width: 760, height: 640 }))

    expect(bounds).toEqual({
      width: 712,
      height: 592,
      minWidth: 680,
      minHeight: 560,
    })
    expect(bounds.width).toBeLessThanOrEqual(760)
    expect(bounds.height).toBeLessThanOrEqual(640)
  })

  it('lowers native minimums safely for very small work areas', () => {
    const bounds = desktopStartupRecoveryWindowBounds(screenApi({ width: 480, height: 320 }))

    expect(bounds).toEqual({
      width: 432,
      height: 272,
      minWidth: 432,
      minHeight: 272,
    })
    expect(bounds.minWidth).toBeLessThanOrEqual(bounds.width)
    expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height)
  })

  it('falls back to the primary display when the current display cannot be read', () => {
    const electronScreen = screenApi(new Error('screen unavailable'), { width: 700, height: 600 })

    expect(desktopStartupRecoveryWindowBounds(electronScreen)).toEqual({
      width: 652,
      height: 552,
      minWidth: 652,
      minHeight: 552,
    })
    expect(electronScreen.getPrimaryDisplay).toHaveBeenCalledOnce()
  })
})

describe('Desktop startup recovery action parser', () => {
  it('accepts only known actions with the expected id shape', () => {
    for (const action of [
      'home',
      'export-diagnostics',
      'show-diagnostics',
      'open-settings-document',
      'open-profile-patch',
      'open-profile-manifest',
      'open-profile-directory',
      'restart',
      'quit',
    ]) {
      expect(parseDesktopStartupRecoveryAction(`dsh-recovery://${action}`)).toEqual({ action })
    }

    for (const action of [
      'preview-disable',
      'confirm-disable',
      'preview-rollback',
      'confirm-rollback',
      'preview-retry',
      'confirm-retry',
      'preview-fresh-profile',
      'confirm-fresh-profile',
    ]) {
      expect(parseDesktopStartupRecoveryAction(
        `dsh-recovery://${action}?id=opaque-id_0001`,
      )).toEqual({ action, id: 'opaque-id_0001' })
    }
  })

  it.each([
    'not a url',
    'https://restart',
    'dsh-recovery://unknown',
    'dsh-recovery://home/',
    'dsh-recovery://user:password@home',
    'dsh-recovery://home:1234',
    'dsh-recovery://home#fragment',
    'dsh-recovery://home?id=unexpected',
    'dsh-recovery://home?extra=value',
    'dsh-recovery://preview-disable',
    'dsh-recovery://preview-disable?id=short',
    'dsh-recovery://confirm-fresh-profile',
    'dsh-recovery://preview-fresh-profile?id=short',
    'dsh-recovery://preview-disable?id=opaque-id_0001&id=opaque-id_0002',
    'dsh-recovery://preview-disable?id=opaque-id_0001&extra=value',
    `dsh-recovery://preview-disable?id=${'x'.repeat(161)}`,
  ])('rejects invalid or over-privileged navigation: %s', href => {
    expect(parseDesktopStartupRecoveryAction(href)).toBeUndefined()
  })
})
