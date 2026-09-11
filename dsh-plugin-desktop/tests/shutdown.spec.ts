import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopExitCoordinator,
  createDesktopRestartRequest,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopQuitEvent,
  type DesktopQuitSource,
  type DesktopSignalSource,
} from '../src/shutdown.ts'

afterEach(() => { vi.useRealTimers() })

describe('application shutdown requests', () => {
  it('relaunches a completed mode change', () => {
    const beforeExit = vi.fn()
    const native = {
      prepareToQuit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
    }
    const coordinator = createDesktopExitCoordinator(native, beforeExit)

    coordinator.requestRelaunch()
    coordinator.finish(0)

    expect(beforeExit).toHaveBeenCalledOnce()
    expect(native.prepareToQuit).toHaveBeenCalledOnce()
    expect(native.relaunch).toHaveBeenCalledOnce()
    expect(native.exit).toHaveBeenCalledWith(0)
  })

  it('does not relaunch an exit that never requested one', () => {
    const native = {
      prepareToQuit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
    }
    const coordinator = createDesktopExitCoordinator(native, () => {})

    coordinator.finish(1)

    expect(native.relaunch).not.toHaveBeenCalled()
    expect(native.exit).toHaveBeenCalledWith(1)
  })

  it('relaunches a requested restart that times out, keeping the failure code', () => {
    const native = {
      prepareToQuit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
    }
    const coordinator = createDesktopExitCoordinator(native, () => {})

    // A wedged teardown must not turn an accepted restart into
    // "exited and never came back"; the failure code still reports the timeout.
    coordinator.requestRelaunch()
    coordinator.finish(1, 'timeout')

    expect(native.relaunch).toHaveBeenCalledOnce()
    expect(native.exit).toHaveBeenCalledWith(1)
  })

  it('does not relaunch a requested restart whose generation failed to dispose', () => {
    const native = {
      prepareToQuit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
    }
    const coordinator = createDesktopExitCoordinator(native, () => {})

    coordinator.requestRelaunch()
    coordinator.finish(1, 'failed')

    expect(native.relaunch).not.toHaveBeenCalled()
    expect(native.exit).toHaveBeenCalledWith(1)
  })

  it('exits after graceful disposal and ignores later completions', async () => {
    const dispose = vi.fn(async () => {})
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(dispose, exit)

    await shutdown.request(0)
    await shutdown.request(1)

    expect(dispose).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0, 'completed')
  })

  it('forces a wedged shutdown after the grace period', async () => {
    vi.useFakeTimers()
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(
      () => new Promise<void>(() => {}),
      exit,
      25,
    )
    const request = shutdown.request(0)

    await vi.advanceTimersByTimeAsync(25)

    expect(request).toBeInstanceOf(Promise)
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1, 'timeout')
  })

  it('marks a failed disposal with the failure exit code', async () => {
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(
      async () => { throw new Error('dispose failed') },
      exit,
    )

    await shutdown.request(0)

    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1, 'failed')
  })

  it('relaunches a requested restart after the teardown grace period expires', async () => {
    vi.useFakeTimers()
    const native = {
      prepareToQuit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
    }
    const coordinator = createDesktopExitCoordinator(native, () => {})
    const shutdown = createDesktopShutdown(
      () => new Promise<void>(() => {}),
      (code, outcome) => { coordinator.finish(code, outcome) },
      25,
    )
    const restart = createDesktopRestartRequest(() => shutdown, () => { coordinator.requestRelaunch() })

    void restart()
    await vi.advanceTimersByTimeAsync(25)

    // The timeout still reports the failure code, but the accepted relaunch
    // must happen: this is the "restart requested, teardown wedged" path.
    expect(native.relaunch).toHaveBeenCalledOnce()
    expect(native.exit).toHaveBeenCalledWith(1)
  })

  it('does not relaunch a restart whose generation fails to dispose', async () => {
    const native = {
      prepareToQuit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
    }
    const coordinator = createDesktopExitCoordinator(native, () => {})
    const shutdown = createDesktopShutdown(
      async () => { throw new Error('dispose failed') },
      (code, outcome) => { coordinator.finish(code, outcome) },
    )
    const restart = createDesktopRestartRequest(() => shutdown, () => { coordinator.requestRelaunch() })

    await restart()

    expect(native.relaunch).not.toHaveBeenCalled()
    expect(native.exit).toHaveBeenCalledWith(1)
  })

  it('claims one relaunch and escalates every later restart request', async () => {
    const log = vi.fn()
    const requestRelaunch = vi.fn()
    const request = vi.fn(async () => {})
    const restart = createDesktopRestartRequest(() => ({ request }), requestRelaunch, log)

    await restart()
    await restart()

    // The second click forces the pending teardown instead of being dropped.
    expect(request.mock.calls).toEqual([[0], [0]])
    expect(requestRelaunch).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledOnce()
  })

  it('forces a wedged teardown when the restart is requested twice', async () => {
    let finishDispose!: () => void
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(
      () => new Promise<void>((resolve) => { finishDispose = resolve }),
      exit,
      5_000,
    )
    const restart = createDesktopRestartRequest(() => shutdown, () => {})

    const first = restart()
    await Promise.resolve()
    void restart()

    expect(exit).toHaveBeenCalledWith(0, 'completed')
    finishDispose()
    await first
  })

  it('refuses a restart before the shutdown coordinator exists', async () => {
    const restart = createDesktopRestartRequest(() => undefined, () => {})
    await expect(restart()).rejects.toThrow(/shutdown coordinator is not ready/u)
  })

  it('escalates a repeated request without waiting for disposal', async () => {
    let finish!: () => void
    const dispose = () => new Promise<void>((resolve) => { finish = resolve })
    const exit = vi.fn()
    const shutdown = createDesktopShutdown(dispose, exit, 5_000)
    const first = shutdown.request(0)
    await Promise.resolve()

    void shutdown.request(130)
    expect(exit).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(130, 'completed')

    finish()
    await first
    expect(exit).toHaveBeenCalledOnce()
  })

  it('routes native quit and process signals through one removable coordinator', () => {
    const signalListeners = new Map<string, () => void>()
    const appListeners = new Map<string, (event: DesktopQuitEvent) => void>()
    const signals: DesktopSignalSource = {
      on: (event, listener) => signalListeners.set(event, listener),
      off: (event, listener) => {
        if (signalListeners.get(event) === listener) signalListeners.delete(event)
      },
    }
    const app: DesktopQuitSource = {
      on: (event, listener) => appListeners.set(event, listener),
      off: (event, listener) => {
        if (appListeners.get(event) === listener) appListeners.delete(event)
      },
    }
    const requestQuit = vi.fn()
    const remove = installShutdownRequests(signals, app, requestQuit)
    const quitEvent = { preventDefault: vi.fn() }

    signalListeners.get('SIGINT')?.()
    signalListeners.get('SIGTERM')?.()
    appListeners.get('before-quit')?.(quitEvent)

    expect(requestQuit.mock.calls).toEqual([[130], [0], [0]])
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce()

    remove()
    expect(signalListeners.size).toBe(0)
    expect(appListeners.size).toBe(0)
  })
})
