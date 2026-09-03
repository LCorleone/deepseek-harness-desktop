/**
 * The §5.4 three-entry convergence (B3): the window toolbar button (IPC),
 * the web-client banner (loopback POST), and the model's
 * `browser_claim_control` tool all drive ONE claim state machine — every
 * entry lands on phase `claimed`, act tools fail fast with
 * `OPERATOR_HAS_CONTROL`, every release bumps the generation, and the SSE
 * frames carry the phase (the B2 leftover closure).
 */

import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DesktopPolicy } from '../src/desktop-policy.ts'
import type { DesktopAgentBrowser, AgentBrowserEventFrame } from '../src/agent-browser-contract.ts'
import {
  DESKTOP_AGENT_BROWSER_CLAIM_PATH,
  DESKTOP_AGENT_BROWSER_EVENTS_PATH,
  DESKTOP_AGENT_BROWSER_RELEASE_PATH,
  DESKTOP_AGENT_BROWSER_STATE_PATH,
} from '../src/agent-browser-contract.ts'
import { AgentBrowserError } from '../src/agent-browser-session.ts'
import { apply } from '../src/agent-browser.ts'
import {
  handleAgentBrowserClaimRequest,
  handleAgentBrowserReleaseRequest,
} from '../src/agent-browser-route.ts'
import { createHarness, fakeGuest, fakeGuestDebugger } from './agent-browser-harness.ts'

const ORIGIN = 'http://127.0.0.1:43120'

function devPolicy(): DesktopPolicy {
  return {
    locked: false,
    managedModels: false,
    requireSso: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    allowHomePatch: false,
    allowManualPluginAdd: false,
    trustRoots: [],
    usageReport: false,
    agentBrowser: { enabled: true, allowOrigins: ['*'], allowPersistLogin: false },
  }
}

interface RegisteredTool extends ToolDefinition {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

/** Minimal context capturing the plugin's registrations (the tool entry). */
function pluginContext(executor: DesktopAgentBrowser) {
  const tools: RegisteredTool[] = []
  const context = {
    desktopPolicy: devPolicy(),
    desktopAgentBrowser: executor,
    systemPrompt: {
      section: () => () => {},
      context: () => () => {},
    },
    tools: {
      register: (definition: ToolDefinition) => {
        tools.push(definition as unknown as RegisteredTool)
        return () => {}
      },
    },
    on: () => () => {},
    inject: vi.fn(),
    get: (key: string) => {
      if (key === 'desktopAgentBrowser') return context.desktopAgentBrowser
      if (key === 'desktopPolicy') return context.desktopPolicy
      return undefined
    },
    logger: { info: vi.fn(), error: vi.fn() },
  }
  return { context: context as unknown as Context, tools }
}

function postRequest(body: string): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:43120', origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
  Object.defineProperty(req, 'socket', { configurable: true, value: { remoteAddress: '127.0.0.1' } })
  return req
}

function jsonResponse(): ServerResponse & { body(): unknown, statusCodeOf(): number } {
  let body: unknown
  let statusCode = 0
  const res = {
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader: () => {},
    end: (payload?: string | (() => void)) => {
      if (typeof payload === 'string') body = JSON.parse(payload)
    },
    body: () => body,
    statusCodeOf: () => statusCode,
  }
  return res as unknown as ServerResponse & { body(): unknown, statusCodeOf(): number }
}

describe('agent-browser three-entry claim convergence (§5.4, B3)', () => {
  it('claims and releases converge across the three entries with phase-carrying frames', async () => {
    const debugger_ = fakeGuestDebugger()
    const { session, hosts, pressClaimButton, pressReleaseButton } = createHarness({
      attachGuest: () => fakeGuest(debugger_.target),
    })
    const frames: AgentBrowserEventFrame[] = []
    const unsubscribe = session.subscribe(frame => { frames.push(frame) })
    const { context, tools } = pluginContext(session)
    apply(context)
    const claimTool = tools.find(tool => tool.name === 'browser_claim_control')
    expect(claimTool).toBeDefined()

    await session.open('https://example.test/', { waitForLoad: false })
    expect(session.describe()).toMatchObject({ open: true, phase: 'observing', generation: 1 })

    // Entry 3 (model): browser_claim_control → executor.claimControl.
    const claimed = await claimTool!.execute({ reason: 'please sign in' }, { signal: undefined })
    expect(claimed).toEqual({ claimed: true, reason: 'please sign in' })
    expect(session.describe().phase).toBe('claimed')
    await expect(session.click({ ref: 'e2s' })).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('OPERATOR_HAS_CONTROL')
      return true
    })
    // Entry 1 (window button) releases: one generation boundary, back to observing.
    pressReleaseButton()
    expect(session.describe()).toMatchObject({ phase: 'observing', generation: 2 })

    // Entry 2 (banner POST) claims through the real loopback handler.
    const claimRes = jsonResponse()
    await handleAgentBrowserClaimRequest(
      postRequest(JSON.stringify({ reason: 'taking over from the banner' })),
      claimRes,
      ORIGIN,
      session,
    )
    expect(claimRes.statusCodeOf()).toBe(200)
    expect(claimRes.body()).toEqual({ claimed: true, phase: 'claimed' })
    expect(session.describe().phase).toBe('claimed')
    await expect(session.navigate('https://example.test/next')).rejects.toSatisfy((error: unknown) => {
      expect((error as AgentBrowserError).code).toBe('OPERATOR_HAS_CONTROL')
      return true
    })
    // The banner's release POST bumps the generation again.
    const releaseRes = jsonResponse()
    handleAgentBrowserReleaseRequest(postRequest(''), releaseRes, ORIGIN, session)
    expect(releaseRes.statusCodeOf()).toBe(200)
    expect(releaseRes.body()).toMatchObject({ released: true, phase: 'observing', generation: 3 })

    // Entry 1 (window button) claims; the tool entry observes the same machine.
    pressClaimButton()
    expect(session.describe().phase).toBe('claimed')
    expect(await claimTool!.execute({ reason: 'again' }, { signal: undefined })).toEqual({ claimed: true, reason: 'again' })
    pressReleaseButton()
    expect(session.describe()).toMatchObject({ phase: 'observing', generation: 4 })

    // The window's pushed view models and the loopback frames agree on the
    // phase at every boundary (the B2 leftover closure).
    const phases = frames.filter(frame => frame.kind === 'state').map(frame => (frame as { phase: string }).phase)
    expect(phases).toContain('claimed')
    expect(phases).toContain('observing')
    for (const state of hosts[0]!.states) {
      if (state.phase === 'claimed') expect(state.actionDescription).toBeDefined()
    }
    unsubscribe()
  })

  it('the tool hands a missing reason to the state machine default and stays idempotent', async () => {
    const { session } = createHarness({ attachGuest: () => fakeGuest(fakeGuestDebugger().target) })
    const { context, tools } = pluginContext(session)
    apply(context)
    const claimTool = tools.find(tool => tool.name === 'browser_claim_control')!

    await claimTool.execute({ reason: '  ' }, { signal: undefined })
    expect(session.describe().phase).toBe('claimed')
    // A second claim while claimed only updates the reason — no re-abort churn.
    await claimTool.execute({ reason: 'second' }, { signal: undefined })
    expect(session.describe().phase).toBe('claimed')
  })

  it('the plugin registers the four loopback banner routes once webServer is live', () => {
    const { session } = createHarness({ attachGuest: () => fakeGuest(fakeGuestDebugger().target) })
    const { context } = pluginContext(session)
    const injections: Array<{ names: string[], callback: (ctx: unknown) => void }> = []
    ;(context as unknown as { inject: (names: string[], callback: (ctx: unknown) => void) => void }).inject = (
      names,
      callback,
    ) => { injections.push({ names, callback }) }
    apply(context)

    expect(injections).toHaveLength(1)
    expect(injections[0]!.names).toEqual(['webServer'])
    const registrations: Array<{ kind: string, path: string }> = []
    const routeCtx = {
      webServer: { port: 43120, register: (route: { kind: string, path: string }) => {
        registrations.push(route)
        return () => {}
      } },
      effect: (factory: () => unknown) => { factory(); return () => {} },
    }
    injections[0]!.callback(routeCtx)
    expect(registrations.map(route => route.path)).toEqual([
      DESKTOP_AGENT_BROWSER_STATE_PATH,
      DESKTOP_AGENT_BROWSER_CLAIM_PATH,
      DESKTOP_AGENT_BROWSER_RELEASE_PATH,
      DESKTOP_AGENT_BROWSER_EVENTS_PATH,
    ])
    expect(registrations.every(route => route.kind === 'exact')).toBe(true)
  })
})
