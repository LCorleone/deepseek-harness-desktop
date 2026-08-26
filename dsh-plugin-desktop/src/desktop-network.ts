/** Desktop Web handoff and listener exposure preferences. */

import type { Config as WebServerConfig } from '@deepseek-ai/dsh-host-webserver'

/** Listener scope selected for the next Desktop generation. */
export type DesktopNetworkExposure = 'loopback' | 'lan'

/** Parse the opt-in default-browser handoff preference. */
export function parseDesktopOpenBrowser(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  throw new Error('dsh-plugin-desktop: dsh-desktop.openBrowser must be a boolean')
}

/** Parse the restart-applied listener exposure preference. */
export function parseDesktopNetworkExposure(value: unknown): DesktopNetworkExposure {
  if (value === undefined) return 'loopback'
  if (value === 'loopback' || value === 'lan') return value
  throw new Error('dsh-plugin-desktop: dsh-desktop.networkExposure must be "loopback" or "lan"')
}

/** Project a persisted exposure preference into the supported WebServer host literal. */
export function desktopWebServerHost(exposure: DesktopNetworkExposure): WebServerConfig['host'] {
  return exposure === 'lan' ? '0.0.0.0' : '127.0.0.1'
}

/** Marker-free URL suitable for an ordinary local browser. */
export function desktopLoopbackBrowserUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}/`
}

/** Marker-free URLs advertised for the Web runtime's startup-sampled LAN addresses. */
export function desktopLanBrowserUrls(port: number, addresses: readonly string[]): readonly string[] {
  return Object.freeze(addresses.map(address => `http://${address}:${String(port)}/`))
}
