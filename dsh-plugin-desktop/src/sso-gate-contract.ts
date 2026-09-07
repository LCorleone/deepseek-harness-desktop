/**
 * Shared contract of the SSO gate sign-in transport (2026-09-08).
 *
 * Deliberately runtime-pure, mirroring `agent-browser-contract.ts`: the main
 * process (sso-gate-window) and the preload (sso-gate-preload) both need the
 * channel and bridge names, but the main bundle must NEVER import the preload
 * module itself — preload-only electron exports (`contextBridge`,
 * `ipcRenderer`) in the main-process import graph crash the packaged app at
 * boot (#65 finding). Every export here is a plain constant.
 *
 * @module dsh-plugin-desktop/sso-gate-contract
 */

/** Main-world key the gate document calls (see sso-gate-preload). */
export const DESKTOP_SSO_GATE_BRIDGE = 'desktopSsoGateBridge'

/** IPC channel carrying the sign-in request. */
export const DESKTOP_SSO_GATE_SIGN_IN_CHANNEL = 'dsh-sso-gate:sign-in'
