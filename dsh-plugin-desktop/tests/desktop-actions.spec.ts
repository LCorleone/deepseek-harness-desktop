import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import DesktopActionsService, { type DesktopActionsBootstrap } from '../src/desktop-actions.ts'

async function mount(bootstrap: DesktopActionsBootstrap): Promise<{
  readonly ctx: Context
  readonly service: DesktopActionsService
  dispose(): Promise<unknown>
}> {
  const ctx = new Context()
  const fiber = ctx.plugin(DesktopActionsService, bootstrap)
  await fiber
  return { ctx, service: ctx.desktopActions as DesktopActionsService, dispose: fiber.dispose }
}

describe('desktop actions Host service', () => {
  it('exposes only no-argument terminal and restart operations', async () => {
    const openTerminal = vi.fn<() => void>()
    const requestRestart = vi.fn<() => Promise<void>>(async () => {})
    const mounted = await mount({ openTerminal, requestRestart })

    mounted.service.openTerminal()
    await expect(mounted.service.requestRestart()).resolves.toBeUndefined()

    expect(openTerminal).toHaveBeenCalledWith()
    expect(requestRestart).toHaveBeenCalledWith()
    expect(Object.keys(mounted.service).sort()).not.toContain('runCommand')
  })

  it('re-enters the bootstrap on a repeat request and rejects retained references after disposal', async () => {
    const resolvers: Array<() => void> = []
    const requestRestart = vi.fn(() => new Promise<void>(resolve => { resolvers.push(resolve) }))
    const mounted = await mount({ openTerminal: vi.fn(), requestRestart })

    const first = mounted.service.requestRestart()
    const second = mounted.service.requestRestart()
    // A repeated request must reach the bootstrap: the launcher turns it into
    // an escalation of a wedged shutdown, so coalescing would swallow the
    // retry the Market route deliberately forwards.
    expect(second).not.toBe(first)
    expect(requestRestart).toHaveBeenCalledTimes(2)
    await mounted.dispose()
    expect(() => mounted.service.openTerminal()).toThrow(/service disposed/u)
    await expect(mounted.service.requestRestart()).rejects.toThrow(/service disposed/u)

    for (const resolve of resolvers) resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })
})
