/**
 * Inject-surface regression gate for the agent-browser Host plugin (#52).
 *
 * The boot crash: the plugin shipped `inject = []` while its `apply` reads
 * `ctx.systemPrompt` and `ctx.tools` DIRECTLY. In the host tree those
 * services are provided by SIBLING loader entries, and the Cordis context
 * proxy resolves a sibling service only through a declared inject — every
 * other read walks the fiber's ancestor stores and dies with
 * `cannot get property "systemPrompt" without inject`, which failed the
 * whole plugin tree and looped the release boot.
 *
 * The fake-ctx suites (`agent-browser-tools.spec.ts` and friends) cannot
 * catch this class of bug: their `context` object is a plain record cast to
 * `Context`, so `ctx.systemPrompt` resolves unconditionally. This suite
 * boots the plugin under REAL Cordis strict-context semantics instead — a
 * real `Context`, the real `dsh-system-prompt` and `dsh-tools` provider
 * fibers mounted as SIBLINGS of the plugin fiber (exactly the host-tree
 * entry shape), the launcher/policy/attachment services provided as fakes —
 * and lets `await ctx.plugin(...)` rethrow any undeclared access. A missing
 * inject declaration can then only surface here as a rejection or a
 * never-activating fiber, never again as a field boot loop.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { DesktopAgentBrowser } from '../src/agent-browser-contract.ts'
import type { DesktopPolicy } from '../src/desktop-policy.ts'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'
import * as agentBrowser from '../src/agent-browser.ts'

/** The shipped release asset: the #52 fleet form — the browser policy is ON. */
function releasePolicy(): DesktopPolicy {
  return parseDesktopPolicy(JSON.parse(readFileSync(
    new URL('../src/policy/desktop-policy.release.json', import.meta.url),
    'utf8',
  )) as unknown)
}

function executorFake(): DesktopAgentBrowser {
  return {
    describe: () => ({ open: false, url: 'about:blank', title: '', phase: 'idle', generation: 0 }),
    subscribe: vi.fn(() => () => {}),
    describeLogin: vi.fn(),
    setPersistLogin: vi.fn(),
    open: vi.fn(),
    navigate: vi.fn(),
    snapshot: vi.fn(),
    wait: vi.fn(),
    captureScreenshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    scroll: vi.fn(),
    isSubmitControl: vi.fn(async () => false),
    claimControl: vi.fn(),
    releaseControl: vi.fn(),
    close: vi.fn(),
  } as unknown as DesktopAgentBrowser
}

interface DesktopTree {
  ctx: CordisContext
  webServer: { port: number, register: ReturnType<typeof vi.fn> }
  dispose(): Promise<void>
}

/**
 * Compose the strict-semantics tree: real provider fibers for the model
 * surface (siblings of the plugin fiber, the host entry shape), fake
 * launcher-provided services. Loading the plugin through `ctx.plugin`
 * rethrows any `ctx.<service>` read the module never declared.
 */
async function bootDesktopTree(policy: DesktopPolicy | undefined, executor: DesktopAgentBrowser | undefined): Promise<DesktopTree> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (policy !== undefined) ctx.provide('desktopPolicy', policy)
  if (executor !== undefined) ctx.provide('desktopAgentBrowser', executor)
  ctx.provide('attachments', { saveImage: vi.fn() })
  const webServer = { port: 45_123, register: vi.fn(() => () => {}) }
  ctx.provide('webServer', webServer)
  const fiber = await ctx.plugin(agentBrowser as Parameters<CordisContext['plugin']>[0])
  return {
    ctx,
    webServer,
    dispose: () => fiber.dispose().finally(() => ctx.fiber.dispose()),
  }
}

function browserToolNames(ctx: CordisContext): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}

describe('agent-browser inject surface (real Cordis strict contexts)', () => {
  it('keeps the module Loader-shaped: no default export, name/inject/apply intact', () => {
    // The harness postmortem-0001 shape: a default export makes
    // `unwrapExports` collapse the namespace and drop `inject`, which
    // re-creates the undeclared-access crash through the loader path.
    expect('default' in agentBrowser).toBe(false)
    expect(agentBrowser.name).toBe('desktop-agent-browser')
    expect(typeof agentBrowser.apply).toBe('function')
    // The audited direct-read surface: everything `apply` touches on its OWN
    // ctx beyond the core mixins (`logger`/`on`/`inject`/`effect`/`get`).
    // `webServer` mounts through a runtime `ctx.inject(['webServer'], …)`
    // child; the launcher services and `attachments` are probed via `ctx.get`.
    expect(agentBrowser.inject).toEqual(['systemPrompt', 'tools'])
  })

  it('boots the release (policy enabled) form without an inject error and activates the full surface', async () => {
    const tree = await bootDesktopTree(releasePolicy(), executorFake())
    try {
      // `await ctx.plugin(...)` above settles only when apply completed under
      // the strict proxy; reaching this line is the #52 regression gate.
      const tools = browserToolNames(tree.ctx)
      expect(tools).toEqual(expect.arrayContaining([
        'browser_open',
        'browser_navigate',
        'browser_snapshot',
        'browser_wait',
        'browser_screenshot',
        'browser_click',
        'browser_type',
        'browser_scroll',
        'browser_claim_control',
      ]))
      // The loopback routes mount in a runtime `ctx.inject(['webServer'], …)`
      // child fiber, which activates a tick after apply — same strict rules.
      await vi.waitFor(() => {
        expect(tree.webServer.register).toHaveBeenCalledTimes(4)
      })
    } finally {
      await tree.dispose()
    }
  })

  it('boots the policy-disabled form cleanly with no browser surface', async () => {
    const policy: DesktopPolicy = {
      ...releasePolicy(),
      agentBrowser: { enabled: false, allowOrigins: [], allowPersistLogin: false },
    }
    const tree = await bootDesktopTree(policy, executorFake())
    try {
      expect(browserToolNames(tree.ctx)).not.toContain('browser_open')
      expect(tree.webServer.register).not.toHaveBeenCalled()
    } finally {
      await tree.dispose()
    }
  })

  it('boots without the desktop launcher (probe contract: absent, not fatal)', async () => {
    const tree = await bootDesktopTree(undefined, undefined)
    try {
      expect(browserToolNames(tree.ctx)).not.toContain('browser_open')
      expect(tree.webServer.register).not.toHaveBeenCalled()
    } finally {
      await tree.dispose()
    }
  })
})
