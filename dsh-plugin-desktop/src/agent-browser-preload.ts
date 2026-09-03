/**
 * Context-isolated bridge for the agent-browser window document.
 *
 * Exposes exactly `onState` / `claimControl` / `releaseControl` /
 * `closeWindow` under one main-world key (design §2) — the same shape as the
 * file-path bridge in `preload.ts`, a separate file because `preload.cjs`
 * belongs to the main shell window. The claim/release channels drive the B2
 * claim state machine in the session (§5.4).
 *
 * @module dsh-plugin-desktop/agent-browser-preload
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_AGENT_BROWSER_BRIDGE,
  DESKTOP_AGENT_BROWSER_CLAIM_CHANNEL,
  DESKTOP_AGENT_BROWSER_CLOSE_CHANNEL,
  DESKTOP_AGENT_BROWSER_RELEASE_CHANNEL,
  DESKTOP_AGENT_BROWSER_STATE_CHANNEL,
  type AgentBrowserViewModel,
} from './agent-browser-contract.ts'

contextBridge.exposeInMainWorld(DESKTOP_AGENT_BROWSER_BRIDGE, {
  /** Subscribe to main-pushed view models; returns the unsubscribe function. */
  onState(callback: (state: AgentBrowserViewModel) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, state: AgentBrowserViewModel): void => {
      callback(state)
    }
    ipcRenderer.on(DESKTOP_AGENT_BROWSER_STATE_CHANNEL, listener)
    return () => { ipcRenderer.removeListener(DESKTOP_AGENT_BROWSER_STATE_CHANNEL, listener) }
  },
  /** Toolbar: the human takes over — the §5.4 claim state machine (B2). */
  claimControl(): void {
    ipcRenderer.send(DESKTOP_AGENT_BROWSER_CLAIM_CHANNEL)
  },
  /** Toolbar: the human hands control back — generation bumps on release. */
  releaseControl(): void {
    ipcRenderer.send(DESKTOP_AGENT_BROWSER_RELEASE_CHANNEL)
  },
  /** Toolbar: close the browser window. */
  closeWindow(): void {
    ipcRenderer.send(DESKTOP_AGENT_BROWSER_CLOSE_CHANNEL)
  },
})
