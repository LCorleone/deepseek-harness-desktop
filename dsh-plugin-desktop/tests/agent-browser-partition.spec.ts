/**
 * Agent-browser login document (§5.2, B3): strict parsing with recovery, the
 * toggle/rotate transitions, and the file store's atomic round-trip.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AGENT_BROWSER_PERSIST_PARTITION_PREFIX,
  AgentBrowserLoginFileStore,
  DEFAULT_AGENT_BROWSER_LOGIN,
  agentBrowserPersistPartition,
  isAgentBrowserUuid,
  nextAgentBrowserLoginForToggle,
  parseAgentBrowserLoginDocument,
  rotatedAgentBrowserLogin,
} from '../src/agent-browser-partition.ts'

const UUID_A = '00000000-1111-2222-3333-444444444444'
const UUID_B = 'abcdefab-cdef-abcd-efab-cdefabcdefab'

const minted: string[] = []
const mint = (): string => {
  const value = `ffffffff-ffff-ffff-ffff-${String(minted.length + 1).padStart(12, '0')}`
  minted.push(value)
  return value
}

describe('agent-browser login document', () => {
  it('defaults to the one-shot document (persist off, no uuid)', () => {
    expect(DEFAULT_AGENT_BROWSER_LOGIN).toEqual({ version: 1, persistLogin: false })
    expect(parseAgentBrowserLoginDocument(undefined)).toBe(DEFAULT_AGENT_BROWSER_LOGIN)
    expect(parseAgentBrowserLoginDocument(null)).toBe(DEFAULT_AGENT_BROWSER_LOGIN)
    expect(parseAgentBrowserLoginDocument('nonsense')).toBe(DEFAULT_AGENT_BROWSER_LOGIN)
    expect(parseAgentBrowserLoginDocument({ version: 1 })).toBe(DEFAULT_AGENT_BROWSER_LOGIN)
    expect(parseAgentBrowserLoginDocument({ version: 2, persistLogin: false })).toBe(DEFAULT_AGENT_BROWSER_LOGIN)
    expect(parseAgentBrowserLoginDocument({ version: 1, persistLogin: 'yes' })).toBe(DEFAULT_AGENT_BROWSER_LOGIN)
    expect(parseAgentBrowserLoginDocument({ version: 1, persistLogin: true, persistUuid: 'not-a-uuid' }))
      .toBe(DEFAULT_AGENT_BROWSER_LOGIN)
    expect(parseAgentBrowserLoginDocument({
      version: 1,
      persistLogin: true,
      persistUuid: UUID_A,
      extra: true,
    })).toBe(DEFAULT_AGENT_BROWSER_LOGIN)
  })

  it('accepts exactly the two valid shapes', () => {
    expect(parseAgentBrowserLoginDocument({ version: 1, persistLogin: true, persistUuid: UUID_A }))
      .toEqual({ version: 1, persistLogin: true, persistUuid: UUID_A })
    expect(parseAgentBrowserLoginDocument({ version: 1, persistLogin: true, persistUuid: UUID_B }))
      .toEqual({ version: 1, persistLogin: true, persistUuid: UUID_B })
    expect(isAgentBrowserUuid(UUID_A)).toBe(true)
    expect(isAgentBrowserUuid('00000000-1111-2222-3333-4444444444gg')).toBe(false)
  })

  it('mints the UUID exactly once across repeated enables (§5.2)', () => {
    const first = nextAgentBrowserLoginForToggle(DEFAULT_AGENT_BROWSER_LOGIN, true, mint)
    expect(first).toEqual({ version: 1, persistLogin: true, persistUuid: 'ffffffff-ffff-ffff-ffff-000000000001' })

    // Re-enable after disable: the SAME uuid survives (re-minting per toggle
    // would silently defeat persistence).
    const disabled = nextAgentBrowserLoginForToggle(first, false, mint)
    expect(disabled).toEqual({ version: 1, persistLogin: false, persistUuid: 'ffffffff-ffff-ffff-ffff-000000000001' })
    const reEnabled = nextAgentBrowserLoginForToggle(disabled, true, mint)
    expect(reEnabled).toEqual(first)
    expect(minted).toHaveLength(1)
  })

  it('rotates a fresh UUID while keeping the preference (clear ≠ uninstall)', () => {
    const current = parseAgentBrowserLoginDocument({ version: 1, persistLogin: true, persistUuid: UUID_A })
    const rotated = rotatedAgentBrowserLogin(current, mint)
    expect(rotated.persistLogin).toBe(true)
    expect(rotated.persistUuid).not.toBe(UUID_A)
    expect(isAgentBrowserUuid(rotated.persistUuid)).toBe(true)
  })

  it('derives the persist partition token', () => {
    expect(agentBrowserPersistPartition(UUID_A)).toBe(`${AGENT_BROWSER_PERSIST_PARTITION_PREFIX}${UUID_A}`)
  })
})

describe('agent-browser login file store', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-agent-browser-login-'))

  it('round-trips documents and recovers malformed files to the default', () => {
    const statePath = join(scratch, 'state.json')
    const store = new AgentBrowserLoginFileStore(statePath)

    expect(store.read()).toEqual(DEFAULT_AGENT_BROWSER_LOGIN)

    store.write({ version: 1, persistLogin: true, persistUuid: UUID_A })
    expect(store.read()).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_A })
    expect(JSON.parse(readFileSync(statePath, 'utf8') as unknown as string))
      .toEqual({ version: 1, persistLogin: true, persistUuid: UUID_A })

    writeFileSync(statePath, '{broken json', 'utf8')
    expect(store.read()).toEqual(DEFAULT_AGENT_BROWSER_LOGIN)

    store.write(rotatedAgentBrowserLogin(store.read(), () => UUID_B))
    expect(store.read()).toEqual({ version: 1, persistLogin: false, persistUuid: UUID_B })
  })

  it('creates its directory on first write', () => {
    const statePath = join(scratch, 'nested', 'dir', 'state.json')
    const store = new AgentBrowserLoginFileStore(statePath)
    store.write({ version: 1, persistLogin: true, persistUuid: UUID_B })
    expect(store.read()).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_B })
  })

  it('cleans up', () => {
    rmSync(scratch, { recursive: true, force: true })
    expect(new AgentBrowserLoginFileStore(join(fileURLToPath(new URL('.', import.meta.url)), 'gone.json')).read())
      .toEqual(DEFAULT_AGENT_BROWSER_LOGIN)
  })
})
