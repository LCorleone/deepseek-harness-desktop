/** Preload bridge contract: exactly onState/claimControl/releaseControl/closeWindow. */

import { describe, expect, it, vi } from 'vitest'

const exposed = vi.hoisted(() => ({
  key: undefined as string | undefined,
  bridge: undefined as Record<string, unknown> | undefined,
}))

vi.mock('electron', () => {
  const listeners = new Map<string, Array<(event: unknown, state: unknown) => void>>()
  const sent: Array<{ channel: string }> = []
  return {
    contextBridge: {
      exposeInMainWorld: (key: string, bridge: Record<string, unknown>) => {
        if (exposed.key !== undefined) throw new Error('the bridge must be exposed exactly once')
        exposed.key = key
        exposed.bridge = bridge
      },
    },
    ipcRenderer: {
      on: (channel: string, listener: (event: unknown, state: unknown) => void) => {
        const existing = listeners.get(channel) ?? []
        existing.push(listener)
        listeners.set(channel, existing)
      },
      removeListener: (channel: string, listener: (event: unknown, state: unknown) => void) => {
        const existing = listeners.get(channel) ?? []
        listeners.set(channel, existing.filter(entry => entry !== listener))
      },
      send: (channel: string) => { sent.push({ channel }) },
    },
    __harness: { listeners, sent },
  }
})

import '../src/agent-browser-preload.ts'
import { DESKTOP_AGENT_BROWSER_BRIDGE } from '../src/agent-browser-contract.ts'

const harness = (vi.mocked(await import('electron')) as unknown as {
  __harness: {
    listeners: Map<string, Array<(event: unknown, state: unknown) => void>>
    sent: Array<{ channel: string }>
  }
}).__harness

describe('agent-browser preload bridge', () => {
  it('exposes exactly the four contract methods under the dedicated key', () => {
    expect(exposed.key).toBe(DESKTOP_AGENT_BROWSER_BRIDGE)
    expect(exposed.bridge && Object.keys(exposed.bridge).sort()).toEqual([
      'claimControl',
      'closeWindow',
      'onState',
      'releaseControl',
    ])
  })

  it('delivers pushed view models and unsubscribes cleanly', () => {
    const bridge = exposed.bridge as unknown as {
      onState: (callback: (state: unknown) => void) => () => void
    }
    const received: unknown[] = []
    const unsubscribe = bridge.onState(state => { received.push(state) })

    const channel = 'dsh-agent-browser/state'
    for (const listener of [...(harness.listeners.get(channel) ?? [])]) {
      listener(undefined, { url: 'https://example.test/', generation: 1 })
    }
    expect(received).toEqual([{ url: 'https://example.test/', generation: 1 }])

    unsubscribe()
    expect(harness.listeners.get(channel)).toHaveLength(0)
  })

  it('routes claim, release, and close to their dedicated channels', () => {
    const bridge = exposed.bridge as unknown as {
      claimControl: () => void
      releaseControl: () => void
      closeWindow: () => void
    }
    bridge.claimControl()
    bridge.releaseControl()
    bridge.closeWindow()

    expect(harness.sent.map(entry => entry.channel)).toEqual([
      'dsh-agent-browser/claim',
      'dsh-agent-browser/release',
      'dsh-agent-browser/close',
    ])
  })
})
