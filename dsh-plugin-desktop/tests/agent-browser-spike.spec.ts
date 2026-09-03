/**
 * P8 B1 day-1 spike record (design §6 B1, review P2).
 *
 * The real-composition spike ran under the exact Electron this package pins
 * (43.4.0, `xvfb-run -a electron --no-sandbox`): a sandboxed embedder
 * (`webviewTag: true, sandbox: true, contextIsolation: true`) mounts a
 * `<webview partition="token" src="about:blank">`, `did-attach-webview`
 * delivers the guest webContents, `webContents.debugger.attach('1.3')`
 * succeeds, and `DOM.getDocument` / `Page.navigate` /
 * `Page.captureScreenshot` / `Page.frameNavigated` all behave. 15/15 steps
 * passed; the WebContentsView fallback (§7) was NOT needed.
 *
 * Two spike findings are encoded as machine checks plus production behavior:
 *
 * 1. `did-attach-webview` fires WHILE the host document parses the
 *    `<webview>` element, so the subscription must precede `loadFile`
 *    (`agent-browser-window.ts`).
 * 2. Electron's `Session` exposes no `.partition` string — the P0 isolation
 *    assertion is session IDENTITY (`guest.session ===
 *    session.fromPartition(token)`, distinct from `session.defaultSession`),
 *    which the window module's partition guard plus the fake-environment
 *    window spec pin instead.
 *
 * This spec keeps the spike re-runnable headless: it asserts the composition
 * exists in the shipped Electron typings, so an Electron upgrade that drops
 * webview or reshapes the Debugger API fails here before it fails in a
 * window.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AGENT_BROWSER_CDP_PROTOCOL_VERSION, AgentBrowserCdpClient, type AgentBrowserDebuggerTarget } from '../src/agent-browser-cdp.ts'

const electronTypings = readFileSync(
  new URL('../node_modules/electron/electron.d.ts', import.meta.url),
  'utf8',
)
const electronVersion = JSON.parse(readFileSync(
  new URL('../node_modules/electron/package.json', import.meta.url),
  'utf8',
)) as { version?: string }

describe('agent-browser spike: Electron composition surface', () => {
  it('pins the Electron version the spike validated', () => {
    // The real spike ran against the same dependency this package installs;
    // an Electron bump re-runs the spike before this pin moves.
    expect(electronVersion.version).toBe('43.4.0')
  })

  it('still ships <webview> mounting under a sandboxed embedder', () => {
    expect(electronTypings).toContain('webviewTag?: boolean')
    expect(electronTypings).toContain("on(event: 'will-attach-webview'")
    expect(electronTypings).toContain("on(event: 'did-attach-webview'")
  })

  it('still ships the Debugger CDP transport', () => {
    expect(electronTypings).toContain('sendCommand(method: string')
    expect(electronTypings).toContain('attach(protocolVersion?: string)')
    expect(electronTypings).toContain("on(event: 'message'")
    expect(electronTypings).toContain("on(event: 'detach'")
  })

  it('documents the Session partition finding: no .partition property exists', () => {
    // Spike finding 2: isolation is asserted through session identity, so a
    // future Session.partition property should be adopted by the P0 checks.
    expect(electronTypings).not.toMatch(/readonly partition: string/u)
  })
})

describe('agent-browser spike: fake debugger protocol shape', () => {
  it('attaches over 1.3 and sends the exact DOM/Page command shapes', async () => {
    const sent: Array<{ method: string, params?: unknown }> = []
    const target: AgentBrowserDebuggerTarget = {
      attach: protocolVersion => {
        expect(protocolVersion).toBe(AGENT_BROWSER_CDP_PROTOCOL_VERSION)
      },
      detach: () => {},
      isAttached: () => false,
      sendCommand: async (method, params) => {
        sent.push({ method, ...(params === undefined ? {} : { params }) })
        if (method === 'DOM.getDocument') {
          return { root: { nodeId: 1, nodeType: 9, nodeName: '#document', children: [] } }
        }
        return {}
      },
      on: () => {},
      off: () => {},
    }
    const client = new AgentBrowserCdpClient(target)
    client.attach()
    await client.domEnable()
    await client.getDocument({ depth: 16, pierce: true })
    await client.pageEnable()
    await client.navigate('https://example.test/')
    await client.setLifecycleEventsEnabled(true)

    expect(sent).toEqual([
      { method: 'DOM.enable' },
      { method: 'DOM.getDocument', params: { depth: 16, pierce: true } },
      { method: 'Page.enable' },
      { method: 'Page.navigate', params: { url: 'https://example.test/' } },
      { method: 'Page.setLifecycleEventsEnabled', params: { enabled: true } },
    ])
    client.detach()
  })
})
