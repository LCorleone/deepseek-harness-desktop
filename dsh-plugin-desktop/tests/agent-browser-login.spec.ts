/**
 * Agent-browser login persistence (§5.2, B3): the default stays the one-shot
 * token; enabling persistence mints the UUID once, reuses it across window
 * creations (and "restarts" — a fresh session over the same document), and
 * the clear action closes the window before wiping storage and rotating the
 * UUID, keeping the settings document in sync.
 */

import { describe, expect, it } from 'vitest'
import type { AgentBrowserLoginDocument } from '../src/agent-browser-partition.ts'
import type { AgentBrowserEventFrame } from '../src/agent-browser-contract.ts'
import { agentBrowserPersistPartition } from '../src/agent-browser-partition.ts'
import { createHarness, fakeGuest, fakeGuestDebugger } from './agent-browser-harness.ts'

const UUID_1 = '00000000-1111-2222-3333-444444444444'
const UUID_2 = 'abcdefab-cdef-abcd-efab-cdefabcdefab'

/** In-memory login document store with scripted UUID mints. */
function loginStore(initial: AgentBrowserLoginDocument = { version: 1, persistLogin: false }) {
  const state = { document: initial }
  const mints: string[] = []
  const wiped: string[] = []
  const queue = [UUID_1, UUID_2]
  return {
    state,
    mints,
    wiped,
    read: () => state.document,
    write: (next: AgentBrowserLoginDocument) => { state.document = next },
    mintUuid: () => {
      const value = queue.shift() ?? `aaaaaaaa-0000-0000-0000-${String(mints.length).padStart(12, '0')}`
      mints.push(value)
      return value
    },
    wipePersistedPartition: async (partition: string) => { wiped.push(partition) },
  }
}

function loginHarness(store: ReturnType<typeof loginStore>, options: {
  wipe?: (partition: string) => Promise<void>
  policyAllowsPersist?: boolean
} = {}) {
  return createHarness({
    attachGuest: () => fakeGuest(fakeGuestDebugger().target),
    login: {
      store,
      mintUuid: store.mintUuid,
      wipePersistedPartition: options.wipe ?? store.wipePersistedPartition,
      ...(options.policyAllowsPersist === undefined ? {} : { policyAllowsPersist: options.policyAllowsPersist }),
    },
  })
}

describe('agent-browser login persistence (§5.2, B3)', () => {
  it('keeps the one-shot default without a login seam', async () => {
    const { session, tokens } = createHarness({ attachGuest: () => fakeGuest(fakeGuestDebugger().target) })
    expect(session.describeLogin()).toEqual({
      persistLogin: false,
      persisted: false,
      windowOnPersistPartition: false,
    })
    await session.open('https://example.test/', { waitForLoad: false })
    expect(tokens[0]).toMatch(/^dsh-agent-browser-test-\d+$/u)
    await session.close()
    // One-shot tokens never carry the persist prefix.
    expect(tokens[0]!.startsWith('persist:')).toBe(false)
  })

  it('rejects the toggle on a composition without the login seam', async () => {
    const { session } = createHarness({ attachGuest: () => fakeGuest(fakeGuestDebugger().target) })
    await expect(session.setPersistLogin(true)).rejects.toThrow('login persistence is not configured')
    await expect(session.clearLoginState()).rejects.toThrow('login persistence is not configured')
  })

  it('mints the persist UUID once and mounts the persist partition at the next window creation', async () => {
    const store = loginStore()
    const { session, tokens } = loginHarness(store)

    await session.open('https://example.test/', { waitForLoad: false })
    expect(tokens[0]).toMatch(/^dsh-agent-browser-test-\d+$/u)
    expect(session.describeLogin()).toEqual({
      persistLogin: false,
      persisted: false,
      windowOnPersistPartition: false,
    })

    // Enable: the UUID is minted once and lands in the settings document.
    const afterEnable = await session.setPersistLogin(true)
    expect(afterEnable).toEqual({ persistLogin: true, persisted: true, windowOnPersistPartition: false })
    expect(store.mints).toEqual([UUID_1])
    expect(store.state.document).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_1 })
    // The LIVE window keeps its one-shot partition (restart-applied: a
    // partition is only settable before the guest's first navigation).
    expect(session.describeLogin().windowOnPersistPartition).toBe(false)

    // Re-enable after disable: same UUID — no silent re-mint.
    await session.setPersistLogin(false)
    await session.setPersistLogin(true)
    expect(store.state.document).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_1 })
    expect(store.mints).toEqual([UUID_1])

    // Next window creation mounts the persist partition.
    await session.close()
    await session.open('https://example.test/', { waitForLoad: false })
    expect(tokens.at(-1)).toBe(agentBrowserPersistPartition(UUID_1))
    expect(session.describeLogin().windowOnPersistPartition).toBe(true)
  })

  it('reuses the persisted UUID across restarts (a fresh session over the same document)', async () => {
    const store = loginStore({ version: 1, persistLogin: true, persistUuid: UUID_2 })
    const first = loginHarness(store)
    await first.session.open('https://example.test/', { waitForLoad: false })
    await first.session.close()

    const second = loginHarness(store)
    await second.session.open('https://example.test/', { waitForLoad: false })
    expect(second.tokens.at(-1)).toBe(agentBrowserPersistPartition(UUID_2))
    expect(second.session.describeLogin()).toEqual({
      persistLogin: true,
      persisted: true,
      windowOnPersistPartition: true,
    })
  })

  it('enforces the policy gate at mount time: a denial falls back to one-shot partitions (B3 review P1)', async () => {
    // A true→false policy flip on a machine that had persistence enabled:
    // the document still prefers persistence, but the persist partition must
    // never mount again — no accumulating logins against the policy.
    const store = loginStore({ version: 1, persistLogin: true, persistUuid: UUID_2 })
    const { session, tokens } = loginHarness(store, { policyAllowsPersist: false })

    await session.open('https://example.test/', { waitForLoad: false })
    expect(tokens[0]).toMatch(/^dsh-agent-browser-test-\d+$/u)
    expect(tokens[0]!.startsWith('persist:')).toBe(false)
    expect(session.describeLogin().windowOnPersistPartition).toBe(false)

    // Every subsequent window creation stays one-shot; the document is untouched.
    await session.close()
    await session.open('https://example.test/', { waitForLoad: false })
    expect(tokens.at(-1)).toMatch(/^dsh-agent-browser-test-\d+$/u)
    expect(store.state.document).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_2 })
  })

  it('refuses enabling persistence under a policy denial, but keeps clearing reachable', async () => {
    const store = loginStore({ version: 1, persistLogin: true, persistUuid: UUID_2 })
    const { session } = loginHarness(store, { policyAllowsPersist: false })

    await expect(session.setPersistLogin(true)).rejects.toSatisfy((error: unknown) => {
      expect((error as { code?: string }).code).toBe('DENIED_BY_POLICY')
      return true
    })
    // Disabling stays allowed (it is the policy's own direction).
    await expect(session.setPersistLogin(false)).resolves.toMatchObject({ persistLogin: false })

    // The residue clear remains executable under the denial — the wipe and
    // the UUID rotation are exactly what retires the leftover partition.
    await expect(session.clearLoginState()).resolves.toMatchObject({ persistLogin: false, persisted: true })
    expect(store.wiped).toEqual([agentBrowserPersistPartition(UUID_2)])
    expect(store.state.document.persistUuid).toBe(UUID_1)
  })

  it('wipes residual persisted login once and resets the document when the policy denies it', async () => {
    const store = loginStore({ version: 1, persistLogin: true, persistUuid: UUID_2 })
    const { session } = loginHarness(store, { policyAllowsPersist: false })

    await session.enforceLoginPersistencePolicy()
    expect(store.wiped).toEqual([agentBrowserPersistPartition(UUID_2)])
    // The document resets to the one-shot default — no UUID lingers to
    // re-arm the enforcement, and the denied toggle never had a live user
    // preference to preserve.
    expect(store.state.document).toEqual({ version: 1, persistLogin: false })
    expect(session.describeLogin()).toEqual({
      persistLogin: false,
      persisted: false,
      windowOnPersistPartition: false,
    })

    // Converged: a second enforcement neither wipes nor writes.
    await session.enforceLoginPersistencePolicy()
    expect(store.wiped).toHaveLength(1)
  })

  it('leaves the login document alone when the policy allows persistence', async () => {
    const store = loginStore({ version: 1, persistLogin: true, persistUuid: UUID_2 })
    const { session } = loginHarness(store, { policyAllowsPersist: true })
    await session.enforceLoginPersistencePolicy()
    expect(store.wiped).toEqual([])
    expect(store.state.document).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_2 })
  })

  it('retries a failed residue wipe on the next enforcement (no reset past a failure)', async () => {
    const store = loginStore({ version: 1, persistLogin: true, persistUuid: UUID_2 })
    const { session } = loginHarness(store, {
      policyAllowsPersist: false,
      wipe: async () => { throw new Error('partition locked') },
    })

    await expect(session.enforceLoginPersistencePolicy()).rejects.toThrow('partition locked')
    // The document still references the un-wiped partition — the next launch
    // (or retry) finds and wipes it instead of orphaning it behind a reset.
    expect(store.state.document).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_2 })
  })

  it('clears login state: close first, wipe storage, rotate the UUID, sync the document', async () => {
    const store = loginStore({ version: 1, persistLogin: true, persistUuid: UUID_2 })
    const wipeOrdering: Array<{ partition: string, windowsClosedAtWipe: number }> = []
    const { session, closed } = loginHarness(store, {
      wipe: async partition => {
        wipeOrdering.push({ partition, windowsClosedAtWipe: closed.length })
        await store.wipePersistedPartition(partition)
      },
    })
    const frames: AgentBrowserEventFrame[] = []
    const unsubscribe = session.subscribe(frame => { frames.push(frame) })

    await session.open('https://example.test/', { waitForLoad: false })
    expect(session.describe().open).toBe(true)

    const afterClear = await session.clearLoginState()
    expect(afterClear).toEqual({ persistLogin: true, persisted: true, windowOnPersistPartition: false })
    // The window closed BEFORE the wipe (§5.2 ordering: live profile
    // directories are unreliable to delete — Windows locks, SW residue).
    expect(closed).toHaveLength(1)
    expect(wipeOrdering).toEqual([{ partition: agentBrowserPersistPartition(UUID_2), windowsClosedAtWipe: 1 }])
    // The UUID rotated and the document stayed in sync (clear ≠ uninstall).
    expect(store.mints).toEqual([UUID_1])
    expect(store.state.document).toEqual({ version: 1, persistLogin: true, persistUuid: UUID_1 })
    expect(session.describe().open).toBe(false)
    // The loopback observation learned the surface closed through a frame —
    // and the close-time state frame CARRIES open:false, which is what lets
    // the banner retire instead of haunting the conversation (B3 review P2:
    // this exact assertion used to be the gap the ghost banner slipped through).
    const stateFrames = frames.filter(frame => frame.kind === 'state')
    expect(stateFrames.length).toBeGreaterThan(0)
    expect(stateFrames.at(-1)).toMatchObject({ kind: 'state', open: false, phase: 'idle' })

    // The next window creation starts from the rotated, empty partition.
    await session.open('https://example.test/', { waitForLoad: false })
    expect(session.describeLogin().windowOnPersistPartition).toBe(true)
    unsubscribe()
  })
})
