/**
 * Agent-browser host plugin: the browser tools (B1 read-only set, the B2 act
 * loop, the B3 claim tool), policy gating, the URL gate, the prompt section
 * (including the revised injection discipline), and the screenshot ImageBlock
 * path — over fake context services.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopPolicy } from '../src/desktop-policy.ts'
import type { DesktopAgentBrowser, AgentBrowserLiveState, AgentBrowserSnapshot } from '../src/agent-browser-contract.ts'
import {
  AGENT_BROWSER_PROMPT_SECTION,
  agentBrowserAllowsUrl,
  agentBrowserDeniedMessage,
  apply,
  name,
} from '../src/agent-browser.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { agentBrowserPreExecuteAsk } from '../src/agent-browser.ts'

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

function lockedPolicy(): DesktopPolicy {
  return {
    ...devPolicy(),
    locked: true,
    agentBrowser: { enabled: false, allowOrigins: [], allowPersistLogin: false },
  }
}

interface RegisteredTool extends ToolDefinition {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

function fakeContext(policy: DesktopPolicy, executor: Partial<DesktopAgentBrowser>) {
  const tools: RegisteredTool[] = []
  const sections: Array<{ name: string, order: number, text: string }> = []
  const contexts: Array<{ name: string, order: number }> = []
  const listeners: Array<{ event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown> }> = []
  const context = {
    desktopPolicy: policy,
    desktopAgentBrowser: {
      describe: () => ({ open: false, url: 'about:blank', title: '', phase: 'idle', generation: 0 }),
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
      ...executor,
    } as DesktopAgentBrowser,
    systemPrompt: {
      section: (section: { name: string, order: number, text: string }) => {
        sections.push(section)
        return () => {}
      },
      context: (entry: { name: string, order: number }) => {
        contexts.push({ name: entry.name, order: entry.order })
        return () => {}
      },
    },
    tools: {
      register: (definition: ToolDefinition) => {
        tools.push(definition as unknown as RegisteredTool)
        return () => {}
      },
    },
    on: (event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.push({ event, listener })
      return () => {}
    },
    // The B3 loopback routes wait for the webServer service; the tool-focused
    // suites never provide one, so the no-op keeps the injection inert.
    inject: (_names: string[], _callback: (ctx: Context) => void) => { },
    get: (key: string) => {
      if (key === 'attachments') return attachments
      if (key === 'desktopAgentBrowser') return context.desktopAgentBrowser
      if (key === 'desktopPolicy') return context.desktopPolicy
      return undefined
    },
    logger: { info: vi.fn(), error: vi.fn() },
  }
  const attachments = {
    saveImage: vi.fn(async (input: { data: Uint8Array, mediaType: string, name?: string }) => ({
      attachmentId: 'att-1',
      mediaType: 'image/jpeg' as const,
      bytes: input.data.byteLength + 897,
      width: 1280,
      height: 400,
      ...(input.name === undefined ? {} : { name: input.name }),
    })),
  }
  return {
    context: context as unknown as Context,
    tools,
    sections,
    contexts,
    attachments,
    listeners,
    /** The registered pre-execute listener (the ask matrix drives it). */
    preExecute: () => listeners.find(entry => entry.event === 'tools/pre-execute')?.listener,
  }
}

const execution = { signal: undefined }

describe('agent-browser URL gate (policy skeleton)', () => {
  it('admits everything under the wildcard dev allowlist', () => {
    const policy = devPolicy().agentBrowser
    expect(agentBrowserAllowsUrl('https://example.test/page', policy)).toBe(true)
    expect(agentBrowserAllowsUrl('http://127.0.0.1:8080/', policy)).toBe(true)
  })

  it('rejects non-http(s) schemes even under the wildcard allowlist (B2 review P1)', () => {
    const wildcard = devPolicy().agentBrowser // allowOrigins: ['*']
    expect(agentBrowserAllowsUrl('file:///etc/passwd', wildcard)).toBe(false)
    expect(agentBrowserAllowsUrl('file:///home/user/.aws/credentials', wildcard)).toBe(false)
    expect(agentBrowserAllowsUrl('data:text/html,<script>alert(1)</script>', wildcard)).toBe(false)
    // The wildcard still admits every http(s) origin.
    expect(agentBrowserAllowsUrl('https://example.test/', wildcard)).toBe(true)
    expect(agentBrowserAllowsUrl('http://127.0.0.1:8080/', wildcard)).toBe(true)
  })

  it('denies everything while the allowlist is empty, matches exact origins otherwise', () => {
    const empty = lockedPolicy().agentBrowser
    expect(agentBrowserAllowsUrl('https://example.test/', empty)).toBe(false)

    const narrowed = { enabled: true, allowOrigins: ['https://docs.company.example'], allowPersistLogin: false }
    expect(agentBrowserAllowsUrl('https://docs.company.example/guide', narrowed)).toBe(true)
    expect(agentBrowserAllowsUrl('https://evil.example/', narrowed)).toBe(false)
    expect(agentBrowserAllowsUrl('not a url', narrowed)).toBe(false)
    expect(agentBrowserAllowsUrl('file:///etc/passwd', narrowed)).toBe(false)
  })

  it('names the policy in the deny text', () => {
    expect(agentBrowserDeniedMessage('https://evil.example/')).toContain('policy does not allow')
  })
})

describe('agent-browser host plugin registration', () => {
  it('is the desktop-agent-browser plugin', () => {
    expect(name).toBe('desktop-agent-browser')
  })

  it('registers nothing while policy keeps the capability disabled', () => {
    const { context, tools, sections } = fakeContext(lockedPolicy(), {})

    apply(context)

    expect(tools).toHaveLength(0)
    expect(sections).toHaveLength(0)
  })

  it('registers the nine browser tools, the prompt section, and the live context', () => {
    const { context, tools, sections, contexts } = fakeContext(devPolicy(), {})

    apply(context)

    expect(tools.map(tool => tool.name).sort()).toEqual([
      'browser_claim_control',
      'browser_click',
      'browser_navigate',
      'browser_open',
      'browser_screenshot',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
      'browser_wait',
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: 'agent-browser', order: 150 })
    expect(sections[0]!.text).toBe(AGENT_BROWSER_PROMPT_SECTION)
    expect(contexts).toEqual([{ name: 'agent-browser-state', order: 150 }])
  })

  it('carries the OBSERVE discipline, the ACT discipline, and the injection defense in the section text', () => {
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('OBSERVE')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('never instructions')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('password field: value hidden')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('claimControl')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('browser_claim_control')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('Screenshots are expensive')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('STALE_SNAPSHOT')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('OPERATOR_HAS_CONTROL')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('approval')
  })

  it('hands control to the operator through browser_claim_control (§5.4 entry 3)', async () => {
    const claimControl = vi.fn()
    const describe = vi.fn((): AgentBrowserLiveState => ({
      open: true,
      url: 'https://example.test/login',
      title: 'Login',
      phase: 'claimed',
      generation: 3,
    }))
    const { context, tools } = fakeContext(devPolicy(), { claimControl, describe })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_claim_control')!

    const value = await tool.execute({ reason: 'please type the second factor' }, execution) as { claimed: boolean, reason?: string }
    expect(value).toEqual({ claimed: true, reason: 'please type the second factor' })
    expect(claimControl).toHaveBeenCalledExactlyOnceWith('the agent invited the operator to take over: please type the second factor')
    expect(tool.output.render({ reason: 'x' }, { claimed: true, reason: 'x' })).toEqual([
      { type: 'text', text: '<browser action="claim_control" claimed="true" reason="x" />' },
    ])
  })

  it('guards open and navigate through the allowlist and forwards exec.signal', async () => {
    const open = vi.fn(async () => ({ url: 'https://example.test/', title: 'Example', generation: 1 }))
    const navigate = vi.fn(async () => ({ url: 'https://example.test/2', title: 'Two', generation: 2 }))
    const { context, tools } = fakeContext(
      { ...devPolicy(), agentBrowser: { enabled: true, allowOrigins: ['https://example.test'], allowPersistLogin: false } },
      { open, navigate },
    )
    apply(context)
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    await expect(byName.get('browser_open')!.execute({ url: 'https://evil.example/' }, execution))
      .rejects.toThrow('DENIED_BY_POLICY')
    await expect(byName.get('browser_navigate')!.execute({ url: 'https://evil.example/' }, execution))
      .rejects.toThrow('policy does not allow')

    await byName.get('browser_open')!.execute({ url: 'https://example.test/' }, execution)
    await byName.get('browser_navigate')!.execute({ url: 'https://example.test/deep' }, execution)
    expect(open).toHaveBeenCalledWith('https://example.test/', {}, undefined)
    expect(navigate).toHaveBeenCalledWith('https://example.test/deep', undefined)
  })

  it('surfaces a stale snapshot as the classified corrective error', async () => {
    const snapshot = vi.fn(async () => {
      throw Object.assign(new Error('[STALE_SNAPSHOT] observed at generation 1'), { code: 'STALE_SNAPSHOT' })
    })
    const { context, tools } = fakeContext(devPolicy(), { snapshot })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_snapshot')!

    await expect(tool.execute({ generation: 1 }, execution)).rejects.toThrow('STALE_SNAPSHOT')
    expect(snapshot).toHaveBeenCalledWith(1, undefined)
  })

  it('persists screenshots through attachments.saveImage into an ImageBlock', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const captureScreenshot = vi.fn(async () => ({ data: bytes, width: 1280, height: 400 }))
    const describe = vi.fn((): AgentBrowserLiveState => ({
      open: true,
      url: 'https://example.test/',
      title: 'Example',
      phase: 'observing',
      generation: 3,
    }))
    const { context, tools, attachments } = fakeContext(devPolicy(), { captureScreenshot, describe })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_screenshot')!

    const value = await tool.execute({}, execution) as {
      url: string
      generation: number
      image: { attachmentId: string, mediaType: string, bytes: number }
    }

    expect(attachments.saveImage).toHaveBeenCalledWith(expect.objectContaining({
      data: bytes,
      mediaType: 'image/jpeg',
    }))
    expect(value).toEqual({
      url: 'https://example.test/',
      generation: 3,
      image: {
        attachmentId: 'att-1',
        mediaType: 'image/jpeg',
        bytes: 900,
        width: 1280,
        height: 400,
        name: 'agent-browser-generation-3.jpg',
      },
    })

    // The declared render emits the text envelope plus the image block.
    const definition = tool as unknown as {
      output: { render: (args: unknown, value: unknown) => Array<{ type: string }> }
    }
    const rendered = definition.output.render({}, value)
    expect(rendered.map(block => block.type)).toEqual(['text', 'image'])
    expect(rendered[1]).toMatchObject({ type: 'image' })
  })

  it('passes wait arguments through in their canonical shapes', async () => {
    const wait = vi.fn(async () => ({ generation: 1, waited: 500 }))
    const { context, tools } = fakeContext(devPolicy(), { wait })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_wait')!

    await tool.execute({ ms: 250, until: 'settle', timeoutMs: 5_000 }, execution)
    expect(wait).toHaveBeenCalledWith({ ms: 250, until: 'settle', timeoutMs: 5_000 }, undefined)
  })
})

describe('agent-browser snapshot tool output', () => {
  it('declares the canonical snapshot schema and renders the tree envelope', async () => {
    const snapshotPayload: AgentBrowserSnapshot = {
      url: 'https://example.test/',
      title: 'Example',
      generation: 4,
      viewport: { width: 1120, height: 760 },
      truncated: false,
      tree: 'document\n  main #e5',
    }
    const snapshot = vi.fn(async () => snapshotPayload)
    const { context, tools } = fakeContext(devPolicy(), { snapshot })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_snapshot')!
    const definition = tool as unknown as {
      output: { render: (args: unknown, value: unknown) => Array<{ type: string, text: string }> }
      parameters: { properties?: Record<string, { type?: string }> }
    }

    // The registry-facing schema is the compiled JSON Schema projection.
    expect(definition.parameters.properties?.generation?.type).toBe('integer')
    const value = await tool.execute({}, execution)
    expect(value).toEqual(snapshotPayload)
    const rendered = definition.output.render({}, snapshotPayload)
    expect(rendered[0]!.type).toBe('text')
    expect(rendered[0]!.text).toContain('<browser url="https://example.test/"')
    expect(rendered[0]!.text).toContain('main #e5')
  })
})

describe('agent-browser act tools (B2)', () => {
  it('normalizes model-hallucinated aliases at the execute entry', async () => {
    const click = vi.fn(async () => ({ generation: 3, performed: true }))
    const type = vi.fn(async () => ({ generation: 3, performed: true }))
    const scroll = vi.fn(async () => ({ generation: 3, performed: true }))
    const { context, tools } = fakeContext(devPolicy(), { click, type, scroll })
    apply(context)
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    // click_type/left_click → button; element → ref; gen → generation.
    await byName.get('browser_click')!.execute({ click_type: 'left_click', element: 'e5', gen: '3' }, execution)
    expect(click).toHaveBeenCalledWith({ ref: 'e5', generation: 3, button: 'left' }, undefined)

    // value → text; press_enter → submit; clear_field → clear.
    await byName.get('browser_type')!.execute({ element: 'e8', value: 'hi', press_enter: true, clear_field: true }, execution)
    expect(type).toHaveBeenCalledWith({ ref: 'e8', text: 'hi', clear: true, submit: true }, undefined)

    // scroll_direction/pixels → direction/amount; node_ref → ref.
    await byName.get('browser_scroll')!.execute({ scroll_direction: 'down', pixels: '600', node_ref: 'e2' }, execution)
    expect(scroll).toHaveBeenCalledWith({ ref: 'e2', direction: 'down', amount: 600 }, undefined)
  })

  it('declares the canonical act schemas and renders the action envelope', async () => {
    const click = vi.fn(async () => ({ generation: 4, performed: true }))
    const { context, tools } = fakeContext(devPolicy(), { click })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_click')!
    const definition = tool as unknown as {
      output: { render: (args: unknown, value: unknown) => Array<{ type: string, text: string }> }
      parameters: { properties?: Record<string, { type?: string, enum?: string[] }> }
    }

    expect(definition.parameters.properties?.button?.enum).toEqual(['left', 'middle', 'right'])
    const value = await tool.execute({ ref: 'e5' }, execution)
    expect(value).toEqual({ generation: 4, performed: true })
    const rendered = definition.output.render({}, value)
    expect(rendered[0]!.text).toBe('<browser action="click" performed="true" generation="4" />')
  })

  it('refuses coordinate clicks with a ref-pointing correction', async () => {
    const click = vi.fn()
    const { context, tools } = fakeContext(devPolicy(), { click })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_click')!

    await expect(tool.execute({ coordinate: [120, 240] }, execution)).rejects.toSatisfy((error: unknown) => {
      expect((error as Error).message).toContain('REF_NOT_FOUND')
      expect((error as Error).message).toContain('browser_snapshot')
      return true
    })
    expect(click).not.toHaveBeenCalled()
  })

  it('forwards exec.signal and surfaces the executor password refusal', async () => {
    const type = vi.fn(async () => {
      throw Object.assign(new Error('[DENIED_BY_POLICY] the type target e9 is a password field; invite the operator via claimControl'), { code: 'DENIED_BY_POLICY' })
    })
    const { context, tools } = fakeContext(devPolicy(), { type })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_type')!
    const controller = new AbortController()

    await expect(tool.execute({ ref: 'e9', text: 'x' }, { signal: controller.signal }))
      .rejects.toThrow('claimControl')
    expect(type).toHaveBeenCalledWith({ ref: 'e9', text: 'x' }, controller.signal)
  })

  it('reports missing canonical type text after normalization', async () => {
    const type = vi.fn()
    const { context, tools } = fakeContext(devPolicy(), { type })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_type')!

    await expect(tool.execute({ ref: 'e9' }, execution)).rejects.toThrow('INVALID_ARGS')
    expect(type).not.toHaveBeenCalled()
  })

  it('reports missing canonical scroll arguments after normalization', async () => {
    const scroll = vi.fn()
    const { context, tools } = fakeContext(devPolicy(), { scroll })
    apply(context)
    const tool = tools.find(candidate => candidate.name === 'browser_scroll')!

    await expect(tool.execute({ direction: 'down' }, execution)).rejects.toThrow('INVALID_ARGS')
    await expect(tool.execute({ pixels: 100 }, execution)).rejects.toThrow('scroll_direction')
    expect(scroll).not.toHaveBeenCalled()
  })
})

describe('agent-browser approval asks (§5.1 trigger matrix)', () => {
  const live = (open: boolean, url: string) => ({ open, url })

  it('asks on cross-origin navigation and form submission (pure classifier)', async () => {
    const current = live(true, 'https://example.test/page')

    // Cross-origin: ask on both tools, canonical and alias urls alike.
    expect(await agentBrowserPreExecuteAsk('browser_navigate', { url: 'https://other.example.test/' }, current))
      .toMatchObject({ kind: 'ask' })
    expect((await agentBrowserPreExecuteAsk('browser_open', { url: 'other.example.test' }, current))?.reason)
      .toContain('CROSS-ORIGIN')
    // Same-origin (including subpaths and ports): no ask.
    expect(await agentBrowserPreExecuteAsk('browser_navigate', { url: 'https://example.test/deeper/page' }, current)).toBeUndefined()
    expect(await agentBrowserPreExecuteAsk('browser_open', { url: 'https://example.test:443/other' }, current)).toBeUndefined()
    // No current page yet (closed surface or about:blank): the allowlist deny
    // gate owns the first open — no cross-origin ask exists to answer.
    expect(await agentBrowserPreExecuteAsk('browser_open', { url: 'https://other.example.test/' }, live(false, 'about:blank'))).toBeUndefined()
    expect(await agentBrowserPreExecuteAsk('browser_open', { url: 'https://other.example.test/' }, live(true, 'about:blank'))).toBeUndefined()

    // Form submission: submit:true (or the press_enter alias) asks; typing alone never does.
    expect(await agentBrowserPreExecuteAsk('browser_type', { ref: 'e9', text: 'x', submit: true }, current))
      .toMatchObject({ kind: 'ask' })
    expect(await agentBrowserPreExecuteAsk('browser_type', { ref: 'e9', text: 'x', press_enter: true }, current))
      .toMatchObject({ kind: 'ask' })
    expect(await agentBrowserPreExecuteAsk('browser_type', { ref: 'e9', text: 'x' }, current)).toBeUndefined()

    // Everything else delegates: observation, same-site acts, foreign tools.
    expect(await agentBrowserPreExecuteAsk('browser_snapshot', {}, current)).toBeUndefined()
    expect(await agentBrowserPreExecuteAsk('browser_click', { ref: 'e1' }, current)).toBeUndefined()
    expect(await agentBrowserPreExecuteAsk('bash', { command: 'true' }, current)).toBeUndefined()
  })

  it('asks on clicking a form-submit control through the ref classifier (B2 review P1)', async () => {
    const current = live(true, 'https://example.test/form')
    const isSubmitControl = vi.fn(async (ref: string) => ref === 'e9')
    const classified = { ...current, isSubmitControl }

    // Clicking the submit-control ref raises the ask with a submit reason.
    expect((await agentBrowserPreExecuteAsk('browser_click', { ref: 'e9' }, classified))?.reason)
      .toContain('SUBMIT')
    // A plain button/link ref (isSubmitControl false) never does.
    expect(await agentBrowserPreExecuteAsk('browser_click', { ref: 'e5' }, classified)).toBeUndefined()
    // Without a classifier injected (no executor) the click delegates — the
    // act body still owns the real failure.
    expect(await agentBrowserPreExecuteAsk('browser_click', { ref: 'e9' }, current)).toBeUndefined()
    expect(isSubmitControl).toHaveBeenCalledWith('e9')
  })

  it('asks on clicking a submit control through a DESCENDANT ref (P8 B2 residual P1)', async () => {
    const current = live(true, 'https://example.test/form')
    // e9 is the submit button; e10 is the span/icon INSIDE it whose ref the
    // model clicks just as naturally (the snapshot refs every element).
    const isSubmitControl = vi.fn(async (ref: string) => ref === 'e9' || ref === 'e10')
    const classified = { ...current, isSubmitControl }

    // The child ref rides the same classifier seam and raises the same ask —
    // a trusted click on the span activates the submit control.
    expect((await agentBrowserPreExecuteAsk('browser_click', { ref: 'e10' }, classified))?.reason)
      .toContain('SUBMIT')
    expect(isSubmitControl).toHaveBeenCalledWith('e10')
    // A child ref inside a plain button never does.
    expect(await agentBrowserPreExecuteAsk('browser_click', { ref: 'e11' }, classified)).toBeUndefined()
    expect(isSubmitControl).toHaveBeenCalledWith('e11')
  })

  it('routes only its own tool names through the registered pre-execute listener', async () => {
    const describe = vi.fn((): AgentBrowserLiveState => ({ open: true, url: 'https://example.test/', title: 'Example', phase: 'observing', generation: 2 }))
    const { context, preExecute } = fakeContext(devPolicy(), { describe })
    apply(context)
    const listener = preExecute()
    expect(listener).toBeDefined()

    const delegated: string[] = []
    const next = async (): Promise<PreToolDecision> => {
      delegated.push('next')
      return { kind: 'allow' }
    }

    // A foreign tool never reaches the classifier.
    expect(await listener!({ name: 'bash', arguments: {} }, next)).toEqual({ kind: 'allow' })
    // Same-origin navigation delegates to allow.
    expect(await listener!({ name: 'browser_navigate', arguments: { url: 'https://example.test/x' } }, next))
      .toEqual({ kind: 'allow' })
    // Cross-origin navigation raises the ask for the approval seam.
    const ask = await listener!({ name: 'browser_navigate', arguments: { url: 'https://evil.example.test/' } }, next)
    expect(ask).toMatchObject({ kind: 'ask' })
    // Form submission raises the ask too.
    expect(await listener!({ name: 'browser_type', arguments: { ref: 'e9', text: 'x', submit: true } }, next))
      .toMatchObject({ kind: 'ask' })
    expect(delegated).toEqual(['next', 'next'])
  })

  it('routes a submit-control click to the ask through the ref classifier', async () => {
    const isSubmitControl = vi.fn(async (ref: string) => ref === 'e9')
    const describe = vi.fn((): AgentBrowserLiveState => ({ open: true, url: 'https://example.test/form', title: 'Form', phase: 'observing', generation: 2 }))
    const { context, preExecute } = fakeContext(devPolicy(), { describe, isSubmitControl })
    apply(context)
    const listener = preExecute()!
    const next = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

    // A submit-control click raises the ask for the approval seam.
    expect(await listener({ name: 'browser_click', arguments: { ref: 'e9' } }, next))
      .toMatchObject({ kind: 'ask' })
    // A plain target click delegates to allow.
    expect(await listener({ name: 'browser_click', arguments: { ref: 'e5' } }, next))
      .toEqual({ kind: 'allow' })
    expect(isSubmitControl).toHaveBeenCalledWith('e9')
  })

  it('gates the act tool body behind the ask through a stubbed approval service', async () => {
    // The registry contract: an `ask` decision runs the tool only after the
    // approval service returns allowed-once, and denies otherwise. The stub
    // below plays the service's two outcomes; the plugin itself never looks
    // the service up (the registry does the routing).
    const click = vi.fn(async () => ({ generation: 2, performed: true }))
    const describe = vi.fn((): AgentBrowserLiveState => ({ open: true, url: 'https://example.test/', title: 'Example', phase: 'observing', generation: 2 }))
    const { context, tools, preExecute } = fakeContext(devPolicy(), { click, describe })
    apply(context)
    const listener = preExecute()!
    const tool = tools.find(candidate => candidate.name === 'browser_click')!
    const next = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

    const decision = await listener({ name: 'browser_click', arguments: { ref: 'e5' } }, next)
    expect(decision).toEqual({ kind: 'allow' })

    const submitAsk = await listener({ name: 'browser_type', arguments: { ref: 'e9', text: 'q', submit: true } }, next)
    expect(submitAsk).toMatchObject({ kind: 'ask' })
    // Denied approval: the body never runs.
    expect(click).not.toHaveBeenCalled()
    // Allowed-once approval: the body runs exactly once.
    const value = await tool.execute({ ref: 'e5' }, execution)
    expect(value).toEqual({ generation: 2, performed: true })
  })
})
