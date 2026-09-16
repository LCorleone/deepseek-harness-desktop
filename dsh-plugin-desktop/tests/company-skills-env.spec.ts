/**
 * The company-skills router environment (#043 D1, batch B): the generator /
 * runtime-decoder pair behind the build-time blob, the policy gate, and the
 * process-global slot the skills executor reads — the desktop side of the
 * seam whose plugin side lives in `dsh-company-skills/src/host-env.ts`.
 *
 * @module dsh-plugin-desktop/tests/company-skills-env
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  companySkillsEnvFromEnvironment,
  encodeCompanySkillsEnvBlob,
  isEmptyCompanySkillsEnvPayload,
} from '../scripts/make-company-skills-env-blob.mjs'
import { parseDesktopPolicy, type DesktopPolicy } from '../src/desktop-policy.ts'
import {
  COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT,
  companySkillsExecutionEnvironment,
  companySkillsExecutionEnvironmentEntries,
  decodeCompanySkillsEnvBlob,
  managedCompanySkillsEnvironment,
  setCompanySkillsExecutionEnvironment,
} from '../src/company-skills-env.ts'

afterEach(() => {
  setCompanySkillsExecutionEnvironment(undefined)
})

function policy(locked: boolean): DesktopPolicy {
  return parseDesktopPolicy({
    agentBrowser: { allowOrigins: [], allowPersistLogin: false, enabled: false },
    allowHomePatch: false,
    allowManualPluginAdd: false,
    companyCatalogOrigin: null,
    companyManifestUrl: 'company-market/catalog-manifest.json',
    locked,
    managedModels: false,
    pluginResetOnVersionChange: false,
    requireSso: false,
    trustRoots: [],
    usageReport: false,
  })
}

const LIVE = { routerUrl: 'http://10.173.109.204:8080', routerApiKey: 'synthetic-router-key' }
const EMPTY = { routerUrl: '', routerApiKey: '' }

describe('the generator reads ROUTER_* from the invoking environment', () => {
  it('yields the empty payload when neither variable is set (the committed default)', () => {
    const payload = companySkillsEnvFromEnvironment({})
    expect(payload).toEqual({ routerUrl: '', routerApiKey: '' })
    expect(isEmptyCompanySkillsEnvPayload(payload)).toBe(true)
  })

  it('accepts a complete well-formed pair', () => {
    expect(companySkillsEnvFromEnvironment({
      ROUTER_URL: LIVE.routerUrl,
      ROUTER_API_KEY: LIVE.routerApiKey,
    })).toEqual(LIVE)
  })

  it('refuses a half-configured pair, surrounding whitespace, and non-bare URLs', () => {
    for (const environment of [
      { ROUTER_URL: LIVE.routerUrl },
      { ROUTER_API_KEY: LIVE.routerApiKey },
      { ROUTER_URL: ` ${LIVE.routerUrl} `, ROUTER_API_KEY: LIVE.routerApiKey },
      { ROUTER_URL: 'not a url', ROUTER_API_KEY: LIVE.routerApiKey },
      { ROUTER_URL: 'ftp://router.internal', ROUTER_API_KEY: LIVE.routerApiKey },
      { ROUTER_URL: 'http://user:pass@router.internal', ROUTER_API_KEY: LIVE.routerApiKey },
    ]) {
      expect(
        () => companySkillsEnvFromEnvironment(environment),
        JSON.stringify(environment),
      ).toThrow(/company-skills env blob: /u)
    }
  })
})

describe('the runtime decoder mirrors the generator', () => {
  it('round-trips a live payload and the empty payload', () => {
    expect(decodeCompanySkillsEnvBlob(encodeCompanySkillsEnvBlob(LIVE))).toEqual(LIVE)
    expect(decodeCompanySkillsEnvBlob(encodeCompanySkillsEnvBlob({ routerUrl: '', routerApiKey: '' })))
      .toEqual({ routerUrl: '', routerApiKey: '' })
  })

  it('rejects malformed blobs without quoting blob content', () => {
    for (const blob of ['', 'not base64 !!!', 'AAAAAAAAAAAAAAAA']) {
      expect(() => decodeCompanySkillsEnvBlob(blob), JSON.stringify(blob)).toThrow(/invalid company-skills env blob/u)
    }
  })

  it('rejects a decodable payload that is not the exact complete pair', () => {
    // The generator refuses these shapes; the decoder must too, so a
    // hand-crafted blob can never half-inject (an empty URL with a live key,
    // or vice versa, or an extra member).
    for (const payload of [
      { routerUrl: '', routerApiKey: 'synthetic-key' },
      { routerUrl: 'http://router.internal', routerApiKey: '' },
      { routerUrl: 'http://router.internal', routerApiKey: 'synthetic-key', extra: 1 },
    ]) {
      expect(
        () => decodeCompanySkillsEnvBlob(encodeCompanySkillsEnvBlob(payload)),
        JSON.stringify(payload),
      ).toThrow(/invalid company-skills env blob/u)
    }
  })
})

describe('the policy gate: locked builds only, fail closed on corruption', () => {
  it('an unlocked or absent policy never reads the blob', () => {
    // Even a corrupt blob stays unread: the gate returns before the decode.
    expect(managedCompanySkillsEnvironment(policy(false), 'not base64 !!!')).toBeUndefined()
    expect(managedCompanySkillsEnvironment(undefined, 'not base64 !!!')).toBeUndefined()
  })

  it('a locked build with an empty payload injects nothing', () => {
    // Explicit empty payload, not the embedded constant: the release pipeline
    // bakes real values into the embedded blob (#043), so these assertions
    // must not depend on the checkout's build state.
    expect(managedCompanySkillsEnvironment(policy(true), encodeCompanySkillsEnvBlob(EMPTY))).toBeUndefined()
  })

  it('a locked build with a live blob decodes it', () => {
    expect(managedCompanySkillsEnvironment(policy(true), encodeCompanySkillsEnvBlob(LIVE))).toEqual(LIVE)
  })

  it('a locked build with a corrupt blob fails closed', () => {
    expect(() => managedCompanySkillsEnvironment(policy(true), 'not base64 !!!'))
      .toThrow(/invalid company-skills env blob/u)
  })
})

describe('the process-global slot the plugin reads', () => {
  it('is registered under the exact string the plugin declares', () => {
    // dsh-company-skills/src/host-env.ts declares the same registry key; each
    // side pins its own declaration, so a drift on either side fails here or
    // in that package's suite.
    expect(Symbol.keyFor(COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT))
      .toBe('dsh.companySkillsExecutionEnvironment')
  })

  it('set publishes a defensive frozen copy, and undefined clears it', () => {
    setCompanySkillsExecutionEnvironment(companySkillsExecutionEnvironmentEntries(LIVE))
    expect(companySkillsExecutionEnvironment()).toEqual({
      ROUTER_URL: LIVE.routerUrl,
      ROUTER_API_KEY: LIVE.routerApiKey,
    })
    expect(Object.isFrozen(companySkillsExecutionEnvironment())).toBe(true)
    setCompanySkillsExecutionEnvironment(undefined)
    expect(companySkillsExecutionEnvironment()).toBeUndefined()
  })

  it('a later mutation of the source record cannot change what children see', () => {
    const source: Record<string, string> = { ROUTER_URL: LIVE.routerUrl, ROUTER_API_KEY: LIVE.routerApiKey }
    setCompanySkillsExecutionEnvironment(source)
    source.ROUTER_API_KEY = 'mutated'
    expect(companySkillsExecutionEnvironment()?.ROUTER_API_KEY).toBe(LIVE.routerApiKey)
  })
})

describe('the empty payload shape', () => {
  it('round-trips, equals what a secret-free environment produces, and carries no plaintext trace', () => {
    // The EMPTY fixture stands in for the committed default. The release
    // pipeline overwrites the embedded constant with real values (#043), so
    // asserting on the constant would fail exactly when the secret wiring
    // works — the property under test is the encoding, not the build state.
    const empty = encodeCompanySkillsEnvBlob(EMPTY)
    expect(decodeCompanySkillsEnvBlob(empty)).toEqual(EMPTY)
    expect(decodeCompanySkillsEnvBlob(empty)).toEqual(companySkillsEnvFromEnvironment({}))
    expect(isEmptyCompanySkillsEnvPayload(decodeCompanySkillsEnvBlob(empty))).toBe(true)
    // The obfuscated bytes carry no plaintext trace of a router secret.
    expect(empty).not.toContain(LIVE.routerApiKey)
    expect(/sk-[A-Za-z0-9_-]{8,}/u.test(empty)).toBe(false)
  })
})
