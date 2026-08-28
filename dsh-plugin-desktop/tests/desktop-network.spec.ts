import { describe, expect, it } from 'vitest'
import {
  DESKTOP_LAN_HTTPS_AVAILABLE,
  desktopEffectiveNetworkExposure,
  desktopLanBrowserUrls,
  desktopWebServerHost,
  parseDesktopNetworkExposure,
} from '../src/desktop-network.ts'

describe('Desktop LAN HTTPS boundary', () => {
  it('preserves the stored LAN schema while clamping effective exposure to loopback', () => {
    expect(parseDesktopNetworkExposure('lan')).toBe('lan')
    expect(DESKTOP_LAN_HTTPS_AVAILABLE).toBe(false)
    expect(desktopEffectiveNetworkExposure('lan')).toBe('loopback')
    expect(desktopWebServerHost('lan')).toBe('127.0.0.1')
    expect(desktopWebServerHost('loopback')).toBe('127.0.0.1')
  })

  it('does not advertise HTTP LAN URLs while trusted HTTPS is unavailable', () => {
    const urls = desktopLanBrowserUrls(43_120, ['192.168.1.20', '2001:db8::1'])
    expect(urls).toEqual([])
    expect(Object.isFrozen(urls)).toBe(true)
  })
})
