import { describe, expect, it } from 'vitest'
import { MarketApiError, MarketOperationTimeoutError } from '../src/client/api.js'
import { isTransientInstallFailure } from '../src/client/install-failure.js'

/** A Host-shaped install-preview failure exactly as `readJson` rethrows it. */
function hostFailure(status: number, code: string, message: string): MarketApiError {
  return new MarketApiError(message, status, code)
}

/** A confirmed-mutation failure carries the package manager's stderr tail. */
function pnpmFailure(detail: string): MarketApiError {
  return hostFailure(
    502,
    'operation-failed',
    `The desktop package manager did not complete successfully: ${detail}`,
  )
}

describe('transient install failure classification (#048)', () => {
  it.each([
    ['npm registry metadata fetch failure', pnpmFailure('ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/dsh-plugin-x failed, reason: read ECONNRESET')],
    ['bare ECONNRESET', pnpmFailure('GET https://registry.npmjs.org/x | ECONNRESET')],
    ['connection timeout', pnpmFailure('network connect ETIMEDOUT 104.16.0.1:443')],
    ['transient DNS retry', pnpmFailure('getaddrinfo EAI_AGAIN registry.npmjs.org')],
    ['aborted connection', pnpmFailure('ECONNABORTED')],
    ['broken pipe', pnpmFailure('write EPIPE')],
    ['undici socket error', pnpmFailure('UND_ERR_SOCKET')],
    ['undici connect timeout', pnpmFailure('UND_ERR_CONNECT_TIMEOUT')],
    ['pnpm socket timeout', pnpmFailure('ERR_SOCKET_TIMEOUT')],
    ['socket hang up', pnpmFailure('socket hang up')],
    ['plain timed-out tail', pnpmFailure('request to https://registry.npmjs.org/x timed out')],
    ['registry 5xx fetch code', pnpmFailure('ERR_PNPM_FETCH_503 GET https://registry.npmjs.org/x')],
    ['registry 502 fetch code', pnpmFailure('ERR_PNPM_FETCH_502 GET https://registry.npmjs.org/x')],
  ])('classifies the network class as transient: %s', (_name, cause) => {
    expect(isTransientInstallFailure(cause)).toBe(true)
  })

  it('classifies the Client-side deadline (operation-timeout) as transient', () => {
    expect(isTransientInstallFailure(new MarketOperationTimeoutError())).toBe(true)
    expect(isTransientInstallFailure(hostFailure(408, 'operation-timeout', 'The market operation timed out before the Host answered.'))).toBe(true)
  })

  it.each([
    ['not-available (404, target absent)', hostFailure(404, 'not-available', 'This catalog item has no verified install target. Refresh the active source and try again.')],
    ['conflict (409, state to reconcile)', hostFailure(409, 'conflict', 'This plugin is already installed at the selected version.')],
    ['intent-expired (410, spent grant)', hostFailure(410, 'intent-expired', 'The confirmation expired or was already used. Preview the operation again.')],
    ['verification-failed (422, identity mismatch)', hostFailure(422, 'verification-failed', 'The npm package identity did not match the catalog.')],
    ['verification-failed (422, registry fetch ambiguity stays conservative)', hostFailure(422, 'verification-failed', 'The plugin package could not be verified with npm.')],
    ['client-update-required (422, runtime window)', hostFailure(422, 'client-update-required', 'The plugin version requires a newer DSH Desktop runtime.')],
    ['persistence-failed (500, local receipt store)', hostFailure(500, 'persistence-failed', 'The install receipt could not be saved, so the installation was rolled back.')],
    ['operation-failed (502) without a network signature', pnpmFailure('ERR_PNPM_PEERS_NOT_RESOLVED UNMET_PEER_DEPENDENCY')],
    ['operation-failed (502) start refusal', hostFailure(502, 'operation-failed', 'The desktop package manager could not start: gate still held')],
    ['operation-failed (502) cancelled generation', hostFailure(502, 'operation-failed', 'The market operation was cancelled because the Market session ended.')],
    ['operation-failed (502) profile unavailable', hostFailure(502, 'operation-failed', 'The active desktop profile is unavailable.')],
    ['operation-failed (500) generic unexpected Host error', hostFailure(500, 'operation-failed', 'market package operation failed')],
  ])('classifies deterministic refusals as NOT transient: %s', (_name, cause) => {
    expect(isTransientInstallFailure(cause)).toBe(false)
  })

  it.each([
    ['registry 404 is a genuine absence, not jitter', pnpmFailure('ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/missing')],
    ['registry auth failures are not jitter', pnpmFailure('ERR_PNPM_FETCH_401 GET https://registry.npmjs.org/x')],
    ['authoritative DNS absence is not the retryable EAI_AGAIN', pnpmFailure('getaddrinfo ENOTFOUND registry.npmjs.org')],
    ['TLS misconfiguration is persistent', pnpmFailure('unable to verify the first certificate')],
  ])('keeps ambiguous network-adjacent failures conservative: %s', (_name, cause) => {
    expect(isTransientInstallFailure(cause)).toBe(false)
  })

  it.each([
    ['plain Error', new Error('The desktop package manager did not complete successfully: read ECONNRESET')],
    ['renderer fetch TypeError (no reasonCode)', Object.assign(new TypeError('fetch failed'), {})],
    ['non-string code', Object.assign(new Error('x'), { code: 502 })],
    ['null', null],
    ['string', 'operation-failed: read ECONNRESET'],
  ])('treats UNKNOWN shapes as NOT transient (conservative): %s', (_name, cause) => {
    expect(isTransientInstallFailure(cause)).toBe(false)
  })
})
