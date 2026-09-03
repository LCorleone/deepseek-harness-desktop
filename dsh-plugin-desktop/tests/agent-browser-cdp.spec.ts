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
