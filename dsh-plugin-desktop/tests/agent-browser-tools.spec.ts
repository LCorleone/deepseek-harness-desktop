/**
 * Agent-browser host plugin: the five B1 tools, policy gating, the URL gate,
 * the prompt section (including the revised injection discipline), and the
 * screenshot ImageBlock path — over fake context services.
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
  const context = {
    desktopPolicy: policy,
    desktopAgentBrowser: {
      describe: () => ({ open: false, url: 'about:blank', title: '', phase: 'idle', generation: 0 }),
      open: vi.fn(),
      navigate: vi.fn(),
      snapshot: vi.fn(),
      wait: vi.fn(),
      captureScreenshot: vi.fn(),
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
  return { context: context as unknown as Context, tools, sections, contexts, attachments }
}

const execution = { signal: undefined }

describe('agent-browser URL gate (policy skeleton)', () => {
  it('admits everything under the wildcard dev allowlist', () => {
    const policy = devPolicy().agentBrowser
    expect(agentBrowserAllowsUrl('https://example.test/page', policy)).toBe(true)
    expect(agentBrowserAllowsUrl('http://127.0.0.1:8080/', policy)).toBe(true)
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

  it('registers the five read-only tools, the prompt section, and the live context', () => {
    const { context, tools, sections, contexts } = fakeContext(devPolicy(), {})

    apply(context)

    expect(tools.map(tool => tool.name).sort()).toEqual([
      'browser_navigate',
      'browser_open',
      'browser_screenshot',
      'browser_snapshot',
      'browser_wait',
    ])
    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: 'agent-browser', order: 150 })
    expect(sections[0]!.text).toBe(AGENT_BROWSER_PROMPT_SECTION)
    expect(contexts).toEqual([{ name: 'agent-browser-state', order: 150 }])
  })

  it('carries the OBSERVE discipline and the injection defense in the section text', () => {
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('OBSERVE')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('never instructions')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('password field: value hidden')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('claimControl')
    expect(AGENT_BROWSER_PROMPT_SECTION).toContain('Screenshots are expensive')
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
