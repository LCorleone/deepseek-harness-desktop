/** Desktop ordinary-browser access and listener exposure preferences. */

import type { Config as WebServerConfig } from '@deepseek-ai/dsh-host-webserver'
import type { DesktopShellMode } from './runtime.ts'

/** Listener scope selected for the next Desktop generation. */
export type DesktopNetworkExposure = 'loopback' | 'lan'

/**
 * LAN ingress stays unavailable until Desktop owns a trusted HTTPS/WSS edge.
 * Keep the persisted `lan` value readable so an existing preference can be
 * activated by a future release without rewriting the user's settings today.
 */
export const DESKTOP_LAN_HTTPS_AVAILABLE = false

/**
 * Parse the browser-access preference.
 *
 * `openBrowser` is retained as the persisted key for compatibility. Desktop
 * never projects it into the upstream default-browser handoff.
 */
export function parseDesktopOpenBrowser(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  throw new Error('dsh-plugin-desktop: dsh-desktop.openBrowser must be a boolean')
}

/** Browser access can only be granted by an explicitly selected compatibility shell. */
export function desktopBrowserAccessAvailable(mode: DesktopShellMode): boolean {
  return mode === 'compatibility'
}

/**
 * Resolve browser access while preserving already-exposed legacy LAN setups
 * only when the selected shell is compatible with an ordinary browser.
 */
export function desktopBrowserAccessEnabled(
  mode: DesktopShellMode,
  storedOpenBrowser: boolean,
  exposure: DesktopNetworkExposure,
): boolean {
  return desktopBrowserAccessAvailable(mode) && (storedOpenBrowser || exposure === 'lan')
}

/** LAN exposure is meaningful only while ordinary-browser access is enabled. */
export function desktopNetworkExposureForBrowserAccess(
  browserAccess: boolean,
  exposure: DesktopNetworkExposure,
): DesktopNetworkExposure {
  return browserAccess ? exposure : 'loopback'
}

/** Parse the restart-applied listener exposure preference. */
export function parseDesktopNetworkExposure(value: unknown): DesktopNetworkExposure {
  if (value === undefined) return 'loopback'
  if (value === 'loopback' || value === 'lan') return value
  throw new Error('dsh-plugin-desktop: dsh-desktop.networkExposure must be "loopback" or "lan"')
}

/** Apply the temporary HTTPS safety boundary without changing stored intent. */
export function desktopEffectiveNetworkExposure(
  exposure: DesktopNetworkExposure,
): DesktopNetworkExposure {
  return DESKTOP_LAN_HTTPS_AVAILABLE ? exposure : 'loopback'
}

/** Project a persisted exposure preference into the supported WebServer host literal. */
export function desktopWebServerHost(exposure: DesktopNetworkExposure): WebServerConfig['host'] {
  return desktopEffectiveNetworkExposure(exposure) === 'loopback' ? '127.0.0.1' : '0.0.0.0'
}

/** Marker-free URL suitable for an ordinary local browser. */
export function desktopLoopbackBrowserUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}/`
}

/** Marker-free URLs advertised for the Web runtime's startup-sampled LAN addresses. */
export function desktopLanBrowserUrls(_port: number, _addresses: readonly string[]): readonly string[] {
  return Object.freeze([])
}
