/**
 * Shared contract of the disclaimer decision transport (2026-09-08).
 *
 * Deliberately runtime-pure, mirroring `agent-browser-contract.ts`: the main
 * process (disclaimer-window) and the preload (disclaimer-preload) both need
 * the channel and bridge names, but the main bundle must NEVER import the
 * preload module itself — preload-only electron exports (`contextBridge`,
 * `ipcRenderer`) in the main-process import graph crash the packaged app at
 * boot (#65 finding: "does not provide an export named 'contextBridge'").
 * Every export here is a plain constant.
 *
 * @module dsh-plugin-desktop/disclaimer-contract
 */

/** Main-world key the disclaimer document calls (see disclaimer-preload). */
export const DESKTOP_DISCLAIMER_BRIDGE = 'desktopDisclaimerBridge'

/** IPC channel carrying one decision; payload validated on both sides. */
export const DESKTOP_DISCLAIMER_DECIDE_CHANNEL = 'dsh-disclaimer:decide'
