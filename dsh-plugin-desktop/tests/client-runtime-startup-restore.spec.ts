/**
 * Startup-selection gate of the `@deepseek-ai/dsh-api-session-controller`
 * yarn patch (`patches/dsh-api-session-controller@0.1.2-rc.1.patch`): the
 * persisted `dsh.sessions.current` selection must survive every list
 * projection while the authoritative Host baseline is still pending, and is
 * only cleared once a `ready` baseline proves the id gone. The 0.1.1 guard
 * lived in `dsh-client-runtime` (`client-runtime-startup-restore`); the
 * client split moved the projection here, so the patch and this spec moved
 * with it.
 *
 * The shipped bundle is a `window.__ModuleLoader__` browser artifact whose
 * chained requires are defeated by Vitest's CommonJS rewriting, so the
 * bundle boots in a plain-node child process (the loader contract is
 * JavaScript, not Vitest-specific) and the cases read its printed snapshots.
 * The 0.1.1 suite also asserted the workspace-default auto-create; that
 * orchestration left the session controller for the conversation shell in
 * 0.1.2, so this spec pins only the selection lifecycle.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUNDLE = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js', import.meta.url))

/** Drive one scenario inside a fresh plain-node child and return its trace. */
function runScenario(scenario: 'keep-pending' | 'clear-after-ready'): Array<
  { phase: string, current: string | undefined, storage: string | undefined }
> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-asc-restore-'))
  const driver = join(root, 'driver.mjs')
  writeFileSync(driver, [
    "import { createRequire } from 'node:module'",
    "import { pathToFileURL } from 'node:url'",
    `const bundlePath = ${JSON.stringify(BUNDLE)}`,
    "const scenario = " + JSON.stringify(scenario),
    "const storage = new Map([['dsh.sessions.current', JSON.stringify({ sessionId: scenario === 'keep-pending' ? 's-restored' : 's-deleted' })]])",
    "globalThis.localStorage = {",
    "  getItem: (key) => storage.get(key) ?? null,",
    "  setItem: (key, value) => { storage.set(key, value) },",
    "  removeItem: (key) => { storage.delete(key) },",
    "}",
    "const baseRequire = createRequire(bundlePath)",
    "const loader = {",
    "  modules: new Map(),",
    "  load(definition) {",
    "    const value = definition.factory((id) => {",
    "      const before = new Set(loader.modules.keys())",
    "      const resolved = baseRequire.resolve(id)",
    "      delete baseRequire.cache[resolved]",
    "      const loaded = baseRequire(id)",
    "      const registered = [...loader.modules.keys()].filter((name) => !before.has(name) && (name === id || id.startsWith(`${name}/`)))",
    "      return registered.length === 1 ? loader.modules.get(registered[0]) : loaded",
    "    })",
    "    this.modules.set(definition.id, value)",
    "    return value",
    "  },",
    "}",
    "globalThis.window = { __ModuleLoader__: loader }",
    "const module = await import(pathToFileURL(bundlePath).href)",
    "const controller = loader.modules.get('@deepseek-ai/dsh-api-session-controller')",
    "const { Context } = baseRequire('@deepseek-ai/cordis')",
    "const ctx = new Context()",
    "let resolveList",
    "const calls = []",
    "async function* asyncEmptyStream() {}",
    "const remote = {",
    "  $on: () => () => {},",,
    "  $host: { home: '/h' },",
    "  $stream: (spec) => ({ name: spec.name, restart: () => {}, dispose: async () => {}, [Symbol.asyncIterator]: asyncEmptyStream }),",
    "  follow: () => ({ [Symbol.asyncIterator]: asyncEmptyStream }),",
    "  session: {",
    "    list: () => new Promise((resolve) => { resolveList = resolve }),",
    "    create: (payload) => { calls.push(['create', payload]); return { ok: true, value: { sessionId: 's-new' } } },",
    "    page: () => ({ ok: true, value: { records: [], hasMore: false } }),",
    "    control: () => ({ [Symbol.asyncIterator]: asyncEmptyStream }),",
    "  },",
    "  subagents: { list: () => ({ ok: true, value: { entries: [] } }) },",
    "}",
    "ctx.remote = remote",
    "ctx.typert = { contexts: { registerClient: () => () => {} } }",
    "controller.apply(ctx)",
    "const sessions = ctx.sessions",
    "const flush = async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)) }",
    "await flush()",
    "const pending = { phase: sessions.list.getSnapshot().phase, current: sessions.list.getSnapshot().current ?? null, storage: storage.get('dsh.sessions.current') ?? null }",
    "resolveList({ ok: true, value: { items: scenario === 'keep-pending'",
    "  ? [{ sessionId: 's-restored', updatedAt: 1, running: false, blank: false, cwd: '/w/recent' }]",
    "  : [] } })",
    "await flush()",
    "await flush()",
    "const ready = { phase: sessions.list.getSnapshot().phase, current: sessions.list.getSnapshot().current ?? null, storage: storage.get('dsh.sessions.current') ?? null }",
    "process.stdout.write(JSON.stringify({ pending, ready, createCalls: calls }))",
  ].join('\n'))
  try {
    const stdout = execFileSync(process.execPath, [driver], { encoding: 'utf8', timeout: 30_000 })
    return JSON.parse(stdout) as never
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('api-session-controller startup restore (patched bundle)', () => {
  it('keeps a persisted selection while the authoritative session baseline is still pending', () => {
    const { pending, ready } = runScenario('keep-pending') as never as {
      pending: { phase: string, current: string | null, storage: string | null }
      ready: { phase: string, current: string | null, storage: string | null }
    }

    expect(pending.phase).toBe('pending')
    expect(pending.current).toBeNull()
    expect(pending.storage).toContain('s-restored')

    expect(ready.phase).toBe('ready')
    expect(ready.current).toBe('s-restored')
    expect(ready.storage).toContain('s-restored')
  })

  it('clears a deleted selection only after the ready baseline proves the id gone', () => {
    const { pending, ready } = runScenario('clear-after-ready') as never as {
      pending: { phase: string, current: string | null, storage: string | null }
      ready: { phase: string, current: string | null, storage: string | null }
    }

    expect(pending.phase).toBe('pending')
    expect(pending.storage).toContain('s-deleted')

    expect(ready.phase).toBe('ready')
    expect(ready.current).toBeNull()
    // The store persists the cleared selection as an empty document rather
    // than removing the key; the guard's contract is that no session id
    // survives the ready baseline that proved it gone.
    expect(ready.storage === null ? {} : JSON.parse(ready.storage)).toEqual({})
  })
})