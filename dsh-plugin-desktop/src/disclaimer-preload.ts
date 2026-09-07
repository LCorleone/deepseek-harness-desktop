/**
 * Context-isolated bridge for the disclaimer window document.
 *
 * The v1 scheme-navigation transport (`<a href="dsh-disclaimer://agree">` →
 * `will-navigate`) turned out to be dead in packaged sandboxed renderers:
 * Chromium treats an unknown scheme as an external protocol and the anchor
 * click never reaches main (#63 real-machine finding, 2026-09-07). This
 * preload is the deterministic replacement — a plain IPC send, no navigation
 * semantics to gamble on. The will-navigate listener stays as an inert belt.
 *
 * @module dsh-plugin-desktop/disclaimer-preload
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_DISCLAIMER_BRIDGE,
  DESKTOP_DISCLAIMER_DECIDE_CHANNEL,
} from './disclaimer-contract.ts'

function decide(action: 'agree' | 'disagree'): void {
  ipcRenderer.send(DESKTOP_DISCLAIMER_DECIDE_CHANNEL, action)
}

contextBridge.exposeInMainWorld(DESKTOP_DISCLAIMER_BRIDGE, { decide })
