/**
 * Context-isolated bridge for the SSO gate window document.
 *
 * The v1 scheme-anchor transport (`<a href="dsh-sso-gate://sign-in">` →
 * `will-navigate`) is dead in packaged sandboxed renderers — Chromium treats
 * unknown schemes as external protocols and the click never reaches main
 * (proven by the #63 disclaimer finding, 2026-09-07; the gate's button had
 * simply never been clicked in a packaged build because silent login always
 * succeeded). This preload is the deterministic replacement — a plain IPC
 * send, no navigation semantics. The will-navigate listener stays as a belt.
 *
 * @module dsh-plugin-desktop/sso-gate-preload
 */
import { contextBridge, ipcRenderer } from 'electron'

/** Main-world key the gate document calls. */
export const DESKTOP_SSO_GATE_BRIDGE = 'desktopSsoGateBridge'

/** IPC channel carrying the sign-in request. */
export const DESKTOP_SSO_GATE_SIGN_IN_CHANNEL = 'dsh-sso-gate:sign-in'

contextBridge.exposeInMainWorld(DESKTOP_SSO_GATE_BRIDGE, {
  signIn(): void {
    ipcRenderer.send(DESKTOP_SSO_GATE_SIGN_IN_CHANNEL)
  },
})
