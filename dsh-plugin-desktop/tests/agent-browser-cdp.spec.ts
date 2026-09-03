/** Typed CDP client over a fake debugger transport: protocol shape (B1 acceptance). */

import { describe, expect, it } from 'vitest'
import {
  AgentBrowserCdpClient,
  AgentBrowserCdpError,
  type AgentBrowserDebuggerTarget,
} from '../src/agent-browser-cdp.ts'

interface FakeDebugger extends AgentBrowserDebuggerTarget {
  /** Deliver one instrumentation event exactly as Electron would. */
  emit(event: 'message', method: string, params: unknown): void
  emitDetach(reason: string): void
}

function fakeDebugger(responses: Record<string, unknown> = {}): FakeDebugger {
  const messageListeners = new Set<(event: unknown, method: string, params: unknown, sessionId: string) => void>()
  const detachListeners = new Set<(event: unknown, reason: string) => void>()
  let attached = false
  return {
    attach: () => { attached = true },
    detach: () => { attached = false },
    isAttached: () => attached,
    sendCommand: async (method: string) => {
      if (method in responses) return responses[method]
      return {}
    },
    on: (event, listener) => {
      if (event === 'message') messageListeners.add(listener as never)
      else detachListeners.add(listener as never)
    },
    off: (event, listener) => {
      if (event === 'message') messageListeners.delete(listener as never)
      else detachListeners.delete(listener as never)
    },
    emit(_event, method, params) {
      for (const listener of [...messageListeners]) listener(undefined, method, params, '')
    },
    emitDetach(reason) {
      attached = false
      for (const listener of [...detachListeners]) listener(undefined, reason)
    },
  }
}

describe('agent-browser CDP client', () => {
  it('refuses commands before attach and surfaces double attach', async () => {
    const client = new AgentBrowserCdpClient(fakeDebugger())
    await expect(client.getDocument()).rejects.toThrow(AgentBrowserCdpError)
    client.attach()
    expect(() => client.attach()).toThrow('already attached')
  })

  it('rejects a non-object payload and wraps transport failures with the method name', async () => {
    const broken = fakeDebugger({ 'DOM.getDocument': 'nope' })
    const brokenClient = new AgentBrowserCdpClient(broken)
    brokenClient.attach()
    await expect(brokenClient.getDocument()).rejects.toThrow('returned a non-object payload')

    const failing: AgentBrowserDebuggerTarget = {
      attach: () => {},
      detach: () => {},
      isAttached: () => false,
      sendCommand: async () => { throw new Error('target went away') },
      on: () => {},
      off: () => {},
    }
    const failingClient = new AgentBrowserCdpClient(failing)
    failingClient.attach()
    await expect(failingClient.navigate('https://example.test/')).rejects.toThrow(
      'CDP command Page.navigate failed: target went away',
    )
  })

  it('maps raw message events to typed listeners and supports unsubscribe', () => {
    const target = fakeDebugger()
    const client = new AgentBrowserCdpClient(target)
    client.attach()
    const navigations: string[] = []
    const mutations: number[] = []
    const stopNavigation = client.on('Page.frameNavigated', params => {
      navigations.push(`${params.frame.id}:${params.frame.url}`)
    })
    client.on('DOM.childNodeInserted', params => { mutations.push(params.parentNodeId) })
    target.emit('message', 'Page.frameNavigated', {
      frame: { id: 'f1', parentId: undefined, url: 'https://example.test/' },
    })
    target.emit('message', 'Page.frameNavigated', {
      frame: { id: 'f2', parentId: 'f1', url: 'https://frame.example.test/' },
    })
    target.emit('message', 'DOM.childNodeInserted', { parentNodeId: 7, previousNodeId: 0, node: { nodeId: 8 } })
    stopNavigation()
    target.emit('message', 'Page.frameNavigated', { frame: { id: 'f3', url: 'about:blank' } })

    // Both main- and sub-frame navigations reach listeners; filtering by
    // frame is the session's job, not the transport's.
    expect(navigations).toEqual([
      'f1:https://example.test/',
      'f2:https://frame.example.test/',
    ])
    expect(mutations).toEqual([7])
  })

  it('fails every command after a detach with the recorded reason', async () => {
    const target = fakeDebugger()
    const client = new AgentBrowserCdpClient(target)
    client.attach()
    target.emitDetach('DevTools was opened')
    await expect(client.pageEnable()).rejects.toThrow(
      'the debugger session detached (DevTools was opened)',
    )
  })

  it('scales the screenshot clip so the capture stays within 1280 px width', async () => {
    const seen: unknown[] = []
    const wide = fakeDebugger({ 'Page.getLayoutMetrics': {} })
    const wideTarget: AgentBrowserDebuggerTarget = {
      ...wide,
      sendCommand: async (method, params) => {
        if (method === 'Page.captureScreenshot') {
          seen.push(params)
          return { data: 'aGk=' }
        }
        return {}
      },
    }
    const client = new AgentBrowserCdpClient(wideTarget)
    client.attach()
    await client.captureScreenshot({ width: 2560, height: 100 })
    expect(seen).toEqual([{
      format: 'jpeg',
      quality: 60,
      clip: { x: 0, y: 0, width: 2560, height: 100, scale: 0.5 },
    }])
    await client.captureScreenshot({ width: 800, height: 600 })
    expect(seen.at(-1)).toMatchObject({ clip: { scale: 1 } })
  })

  it('rejects screenshot payloads without image data', async () => {
    const target = fakeDebugger({ 'Page.captureScreenshot': { data: '' } })
    const client = new AgentBrowserCdpClient(target)
    client.attach()
    await expect(client.captureScreenshot({ width: 100, height: 100 })).rejects.toThrow(
      'returned no image data',
    )
  })
})

describe('agent-browser CDP client: act-domain command shapes (B2)', () => {
  it('sends the exact Input mouse/key/insertText parameter shapes', async () => {
    const seen: Array<{ method: string, params?: unknown }> = []
    const target: AgentBrowserDebuggerTarget = {
      attach: () => {},
      detach: () => {},
      isAttached: () => false,
      sendCommand: async (method, params) => {
        seen.push({ method, ...(params === undefined ? {} : { params }) })
        return {}
      },
      on: () => {},
      off: () => {},
    }
    const client = new AgentBrowserCdpClient(target)
    client.attach()

    await client.dispatchMouseEvent({ type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 2 })
    await client.dispatchMouseEvent({ type: 'wheel', x: 60, y: 40, deltaX: 0, deltaY: -300 })
    await client.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
    await client.insertText('hello')

    expect(seen).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 2 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'wheel', x: 60, y: 40, deltaX: 0, deltaY: -300 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 } },
      { method: 'Input.insertText', params: { text: 'hello' } },
    ])
  })

  it('reduces the getBoxModel content quad to its center and size', async () => {
    const target = fakeDebugger({ 'DOM.getBoxModel': { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } } })
    const client = new AgentBrowserCdpClient(target)
    client.attach()
    expect(await client.getBoxModel(100)).toEqual({ x: 60, y: 40, width: 100, height: 40 })
  })

  it('rejects box models without a complete content quad', async () => {
    const target = fakeDebugger({ 'DOM.getBoxModel': { model: { content: [10, 20, 110] } } })
    const client = new AgentBrowserCdpClient(target)
    client.attach()
    await expect(client.getBoxModel(100)).rejects.toThrow('returned no content quad')
  })

  it('carries executionContextId through resolveNode, callFunctionOn, and evaluate', async () => {
    const seen: Array<{ method: string, params?: unknown }> = []
    const target: AgentBrowserDebuggerTarget = {
      attach: () => {},
      detach: () => {},
      isAttached: () => false,
      sendCommand: async (method, params) => {
        seen.push({ method, ...(params === undefined ? {} : { params }) })
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-9', type: 'node' } }
        if (method === 'Runtime.callFunctionOn') return { result: { type: 'boolean', value: true } }
        if (method === 'Runtime.evaluate') return { result: { type: 'object', value: { before: 0, after: 1 } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 12 }
        return {}
      },
      on: () => {},
      off: () => {},
    }
    const client = new AgentBrowserCdpClient(target)
    client.attach()

    const world = await client.createIsolatedWorld('frame-1')
    expect(world.executionContextId).toBe(12)
    const resolved = await client.resolveNode(100, { executionContextId: world.executionContextId })
    expect(resolved.object.objectId).toBe('obj-9')
    const focused = await client.callFunctionOn({
      objectId: 'obj-9',
      functionDeclaration: 'function(){ this.focus(); return true; }',
      returnByValue: true,
    })
    expect(focused.value).toBe(true)
    const scrolled = await client.evaluateInContext(12, '(() => 1)()')
    expect(scrolled.value).toEqual({ before: 0, after: 1 })

    expect(seen).toEqual([
      { method: 'Page.createIsolatedWorld', params: { frameId: 'frame-1', worldName: 'dsh-agent-browser-act' } },
      { method: 'DOM.resolveNode', params: { backendNodeId: 100, executionContextId: 12 } },
      { method: 'Runtime.callFunctionOn', params: { objectId: 'obj-9', functionDeclaration: 'function(){ this.focus(); return true; }', returnByValue: true } },
      { method: 'Runtime.evaluate', params: { expression: '(() => 1)()', contextId: 12, returnByValue: true } },
    ])
  })

  it('describes nodes and rejects payload shapes it cannot decode', async () => {
    const target = fakeDebugger({
      'DOM.describeNode': { node: { nodeName: 'INPUT', localName: 'input', nodeType: 1, attributes: ['type', 'password'] } },
    })
    const client = new AgentBrowserCdpClient(target)
    client.attach()
    const described = await client.describeNode(100)
    expect(described.node.attributes).toEqual(['type', 'password'])

    const broken = fakeDebugger({ 'DOM.describeNode': {} })
    const brokenClient = new AgentBrowserCdpClient(broken)
    brokenClient.attach()
    await expect(brokenClient.describeNode(100)).rejects.toThrow('returned no node')
  })
})
