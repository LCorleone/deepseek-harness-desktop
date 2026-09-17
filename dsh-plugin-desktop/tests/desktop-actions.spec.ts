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
  it('exposes only the no-argument restart operation', async () => {
    const requestRestart = vi.fn<() => Promise<void>>(async () => {})
    const mounted = await mount({ requestRestart })

    await expect(mounted.service.requestRestart()).resolves.toBeUndefined()

    expect(requestRestart).toHaveBeenCalledWith()
    expect(Object.keys(mounted.service).sort()).not.toContain('runCommand')
    // #048: the market-facing openTerminal capability is removed from the
    // desktopActions service — restart is the only published action.
    expect('openTerminal' in mounted.service).toBe(false)
  })

  it('re-enters the bootstrap on a repeat request and rejects retained references after disposal', async () => {
    const resolvers: Array<() => void> = []
    const requestRestart = vi.fn(() => new Promise<void>(resolve => { resolvers.push(resolve) }))
    const mounted = await mount({ requestRestart })

    const first = mounted.service.requestRestart()
    const second = mounted.service.requestRestart()
    // A repeated request must reach the bootstrap: the launcher turns it into
    // an escalation of a wedged shutdown, so coalescing would swallow the
    // retry the Market route deliberately forwards.
    expect(second).not.toBe(first)
    expect(requestRestart).toHaveBeenCalledTimes(2)
    await mounted.dispose()
    await expect(mounted.service.requestRestart()).rejects.toThrow(/service disposed/u)

    for (const resolve of resolvers) resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })
})
