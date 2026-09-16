/**
 * The process-global host-injection seam (#043 D1): the desktop main process
 * (a separate module instance of this very process, in the packaged desktop)
 * publishes the API skills' `ROUTER_URL`/`ROUTER_API_KEY` on a `Symbol.for`
 * globalThis slot; the plugin reads it at executor construction. These tests
 * pin the seam from the plugin side — including the registry-key string,
 * which the desktop pins independently in
 * `dsh-plugin-desktop/src/company-skills-env.ts` (a drift on either side
 * breaks that side's pin, so the two declarations cannot silently diverge).
 *
 * @module dsh-company-skills/tests/host-env
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT,
  companySkillsExecutionEnvironment,
} from '../src/host-env.js'

/** The registry string both packages must declare verbatim. */
const EXPECTED_REGISTRY_KEY = 'dsh.companySkillsExecutionEnvironment'

afterEach(() => {
  // Never leak a hand-off between tests: the slot is process-global.
  const globals = globalThis as unknown as Record<symbol, unknown>
  delete globals[COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT]
})

describe('the execution-environment slot key', () => {
  it('is registered under the exact shared string (the desktop declares the same one)', () => {
    expect(Symbol.keyFor(COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT)).toBe(EXPECTED_REGISTRY_KEY)
    // A DIFFERENT Symbol.for declaration in the same process meets the same
    // slot — the property the packaged desktop depends on, because the Cordis
    // loader loads the plugin face as its own module instance.
    const desktopsDeclaration = Symbol.for(EXPECTED_REGISTRY_KEY)
    const globals = globalThis as unknown as Record<symbol, unknown>
    globals[desktopsDeclaration] = { ROUTER_URL: 'http://router.internal', ROUTER_API_KEY: 'k' }
    expect(companySkillsExecutionEnvironment()).toEqual({ ROUTER_URL: 'http://router.internal', ROUTER_API_KEY: 'k' })
  })
})

describe('reading the host-injected execution environment', () => {
  it('returns undefined when the host injected nothing (unmanaged launch)', () => {
    expect(companySkillsExecutionEnvironment()).toBeUndefined()
  })

  it('returns a validated copy of a well-formed fragment', () => {
    const globals = globalThis as unknown as Record<symbol, unknown>
    globals[COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT] = {
      ROUTER_URL: 'http://router.internal',
      ROUTER_API_KEY: 'sk-live',
    }
    expect(companySkillsExecutionEnvironment()).toEqual({
      ROUTER_URL: 'http://router.internal',
      ROUTER_API_KEY: 'sk-live',
    })
  })

  it('degrades a malformed hand-off to undefined instead of half an environment', () => {
    const globals = globalThis as unknown as Record<symbol, unknown>
    for (const malformed of [
      'not-an-object',
      ['array'],
      { 'lower-case': 'x' },
      { EMPTY_STRING: '' },
      { NOT_A_STRING: 7 },
    ]) {
      globals[COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT] = malformed
      expect(companySkillsExecutionEnvironment(), JSON.stringify(malformed)).toBeUndefined()
    }
  })

  it('freezes the returned fragment so a later mutation cannot reach children', () => {
    const globals = globalThis as unknown as Record<symbol, unknown>
    const source: Record<string, string> = { ROUTER_URL: 'http://router.internal' }
    globals[COMPANY_SKILLS_EXECUTION_ENVIRONMENT_SLOT] = source
    const read = companySkillsExecutionEnvironment()
    expect(Object.isFrozen(read)).toBe(true)
    source.ROUTER_URL = 'http://mutated'
    expect(read?.ROUTER_URL).toBe('http://router.internal')
  })
})
