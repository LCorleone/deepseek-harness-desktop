/**
 * Hardened dsh-free-search (P7 first listed plugin): unit tests for the
 * company engine chain, strip-surface assertions over the vendored tree, and
 * an offline fake-harness smoke of the plugin's apply() face.
 *
 * Coverage map (task P7 · 2026-09-03):
 *  - chain selection: resolveEngineChain with/without keys (zero-key =
 *    bing→ddg, keyed engines join only when configured),
 *  - chain execution: per-engine try/catch degradation, zero-results treated
 *    as failure, total failure resolves (never rejects) with readable
 *    failures — the single-process-harness red line,
 *  - strip surface: no pnpm self-update, no npm-registry probe, no 4789
 *    server, no profile-patch direct writes (no node:fs/path/child_process
 *    in lib/), engine endpoint allowlist sweep over lib/,
 *  - coexistence patch: only the web-search-free insert + the single-key
 *    `web` row re-pin; no fetchProvider, no disabled rows,
 *  - package shape: no build scripts, pure-JS dependency set, stable semver
 *    version, workflow-convention source directory name,
 *  - fake-harness smoke: apply() registers the provider (id ddg, takeover
 *    only when searchProviderId unset), the settings bridge (loopback
 *    guarded), both free_search_-prefixed tools with defineTool-projected
 *    complete JSON-Schema parameters, and provider.search returns results
 *    through a faked fetch (tavily keyed path, bing keyless path) and a
 *    readable message — not a throw — when every engine fails.
 */

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// tools/company-catalog/tests → tools/company-catalog → the vendored plugin source.
const PLUGIN_DIR = join(TOOL_DIR, 'plugin-sources', 'dsh-free-search-0.4.182')
const LIB_DIR = join(PLUGIN_DIR, 'lib')

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const read = (path) => readFileSync(path, 'utf8')

/** Remove //-line and block comments so red-line greps hit code, not prose. */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[ \t]*\/\/.*$/gmu, (line) => line.replace(/\/\/.*$/u, ''))
}

const libCode = () => ['index.js', 'client.js', 'engines.js'].map((f) => stripJsComments(read(join(LIB_DIR, f)))).join('\n')

const BING_HTML = `<html><body><ol><li class="b_algo"><h2><a href="https://result.example/one">First Result</a></h2><p>first snippet about the query sign up read more</p></li><li class="b_algo"><h2><a href="https://result.example/two">Second Result</a></h2><p>second snippet</p></li></ol>${'<pad>'.repeat(120)}</body></html>`

const TAVILY_JSON = JSON.stringify({
  results: [
    { url: 'https://result.example/tavily', title: 'Tavily Result', content: 'tavily snippet content' },
  ],
})

/** Response-like object shaped for the plugin's engine implementations. */
const jsonResponse = (payload) => ({ ok: true, status: 200, async text() { return payload }, async json() { return JSON.parse(payload) } })

/** A fetch double routing by URL prefix; failures throw like a network error. */
function fakeFetch(routes) {
  return async (url) => {
    for (const [prefix, handler] of routes) {
      if (String(url).startsWith(prefix)) {
        const value = typeof handler === 'function' ? handler(String(url)) : handler
        if (value instanceof Error) throw value
        return value
      }
    }
    throw new TypeError(`fake fetch: no route for ${String(url)}`)
  }
}

// ---------------------------------------------------------------------------
// engine chain units (lib/engines.js — pure, no DSH imports)
// ---------------------------------------------------------------------------

test('resolveEngineChain: zero keys → bing → ddg (out-of-the-box behavior)', async () => {
  const { resolveEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  assert.deepEqual(resolveEngineChain({}), ['bing', 'ddg'])
  assert.deepEqual(resolveEngineChain({ tavilyKey: '', exaKey: '   ' }), ['bing', 'ddg'], 'blank/whitespace keys are absent')
  assert.deepEqual(resolveEngineChain({ tavilyKey: 42, exaKey: null }), ['bing', 'ddg'], 'non-string keys are absent')
})

test('resolveEngineChain: keyed engines join in reviewed order ahead of the keyless pair', async () => {
  const { resolveEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  assert.deepEqual(resolveEngineChain({ tavilyKey: 'tvly-1' }), ['tavily', 'bing', 'ddg'])
  assert.deepEqual(resolveEngineChain({ exaKey: 'exa-1' }), ['exa', 'bing', 'ddg'])
  assert.deepEqual(resolveEngineChain({ tavilyKey: 'tvly-1', exaKey: 'exa-1' }), ['tavily', 'exa', 'bing', 'ddg'])
})

test('runEngineChain: first engine wins, no failures recorded', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const tried = []
  const outcome = await runEngineChain({
    chain: ['tavily', 'exa', 'bing', 'ddg'],
    runEngine: async (engine) => { tried.push(engine); return { sources: [{ url: `https://x/${engine}` }] } },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.engine, 'tavily')
  assert.deepEqual(tried, ['tavily'])
  assert.deepEqual(outcome.failures, [])
})

test('runEngineChain: throwing engine degrades to the next; failures carry readable errors', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const outcome = await runEngineChain({
    chain: ['tavily', 'exa', 'bing', 'ddg'],
    runEngine: async (engine) => {
      if (engine === 'bing') return { sources: [{ url: 'https://x/bing' }] }
      if (engine === 'tavily') throw new Error('Tavily API key is invalid (HTTP 401)')
      throw 'non-Error rejection'
    },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.engine, 'bing')
  assert.deepEqual(outcome.failures, [
    { engine: 'tavily', error: 'Tavily API key is invalid (HTTP 401)' },
    { engine: 'exa', error: 'non-Error rejection' },
  ])
})

test('runEngineChain: zero-source results count as failure and the chain moves on', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const outcome = await runEngineChain({
    chain: ['bing', 'ddg'],
    runEngine: async (engine) => (engine === 'bing' ? { sources: [] } : { sources: [{ url: 'https://x/ddg' }] }),
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.engine, 'ddg')
  assert.equal(outcome.failures[0].error.includes('0 results'), true)
})

test('runEngineChain: every engine failing RESOLVES with readable failures — never a top-level throw', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const outcome = await runEngineChain({
    chain: ['tavily', 'exa', 'bing', 'ddg'],
    runEngine: async () => { throw new Error('connection error: boom') },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failures.length, 4)
  for (const failure of outcome.failures) {
    assert.equal(typeof failure.engine, 'string')
    assert.equal(failure.error.includes('connection error'), true)
  }
})

test('runEngineChain: malformed engine results are failures, not crashes', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const outcome = await runEngineChain({
    chain: ['bing', 'ddg'],
    runEngine: async (engine) => (engine === 'bing' ? null : undefined),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failures.length, 2)
})

test('runEngineChain: an already-aborted external signal stops the chain with an aborted failure', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const controller = new AbortController()
  controller.abort()
  const outcome = await runEngineChain({
    chain: ['bing', 'ddg'],
    signal: controller.signal,
    runEngine: async () => { throw new Error('fetch failed') },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failures.length, 1)
  assert.equal(outcome.failures[0].error, 'search aborted')
})

test('runEngineChain: the serial budget bounds the chain (deadline exhausted before a late engine)', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  let now = 0
  const outcome = await runEngineChain({
    chain: ['bing', 'ddg'],
    budgetMs: 1000,
    now: () => now,
    runEngine: async (engine) => {
      if (engine === 'bing') { now = 2000; throw new Error('slow') }
      return { sources: [{ url: 'https://x/ddg' }] }
    },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failures.length, 2)
  assert.equal(outcome.failures[1].error.includes('budget'), true)
})

test('parseTimeRange: fixed tiers, relative units, absolute dates, and rejects junk', async () => {
  const { parseTimeRange } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  assert.deepEqual(parseTimeRange('week'), { days: 7 })
  assert.deepEqual(parseTimeRange('12h'), { days: 0.5 })
  assert.deepEqual(parseTimeRange('2mo'), { days: 60 })
  assert.deepEqual(parseTimeRange('2026-07-01'), { after: '2026-07-01' })
  assert.deepEqual(parseTimeRange({ days: 3 }), { days: 3 })
  assert.deepEqual(parseTimeRange({ after: '2026-01-02' }), { after: '2026-01-02' })
  assert.equal(parseTimeRange('yesterday-ish'), undefined)
  assert.equal(parseTimeRange(''), undefined)
  assert.equal(parseTimeRange({}), undefined)
})

// ---------------------------------------------------------------------------
// strip surface (the hardened red lines, asserted over the shipped files)
// ---------------------------------------------------------------------------

test('strip surface: no self-update path (pnpm add / child_process / npm registry probe / update routes)', () => {
  const code = libCode()
  assert.equal(/pnpm\s+add/u.test(code), false, 'lib/ must not contain a pnpm add invocation')
  assert.equal(/child_process/u.test(code), false, 'lib/ must not import child_process')
  assert.equal(/\bexec\s*\(/u.test(code), false, 'lib/ must not shell out')
  assert.equal(/npmjs\.com|registry\.npmjs\.org/u.test(code), false, 'lib/ must not probe the npm registry')
  assert.equal(/check-update|checkUpdate|updatePlugin|fetchLatestVersion|detectInstallMode/u.test(code), false, 'lib/ must not carry the update-check surface')
})

test('strip surface: no tools/ server bypass (4789, engine switcher, profile patch writes)', () => {
  const code = libCode()
  assert.equal(code.includes('4789'), false, 'lib/ must not reference the engine-switcher port')
  assert.equal(/node:fs|node:path|node:child_process/u.test(code), false, 'server plugin keeps no filesystem or process imports')
  assert.equal(/writeFileSync|readFileSync|lstatSync/u.test(code), false, 'no direct file writes anywhere in lib/')
  assert.equal(/cordis\.patch\.yml|profiles/u.test(code), false, 'lib/ never writes the profile patch layer')
  assert.equal(existsSync(join(PLUGIN_DIR, 'tools')), false, 'the vendored tree carries no tools/ directory')
  assert.equal(existsSync(join(PLUGIN_DIR, 'switch-engine.html')), false)
  assert.equal(existsSync(join(PLUGIN_DIR, 'switch-engine.ps1')), false)
  assert.equal(existsSync(join(PLUGIN_DIR, '启动DeepSeekHarness.cmd')), false)
  assert.equal(existsSync(join(PLUGIN_DIR, '启动搜索引擎切换器.cmd')), false)
})

test('strip surface: engine endpoints are exactly the reviewed chain; no keyless/extra engine APIs', () => {
  const code = libCode()
  const urls = code.match(/https:\/\/[a-z0-9.-]+/giu) ?? []
  const origins = new Set(urls.map((url) => url.slice('https://'.length)))
  assert.deepEqual(
    [...origins].sort(),
    ['api.exa.ai', 'api.tavily.com', 'html.duckduckgo.com', 'www.bing.com'],
    'the only https origins in lib/ are the four chain engine endpoints',
  )
  for (const gone of ['keenable', 'anysearch', 'searxng', 'perplexity', 'deepseek-official', 'ddg-lite', 'mcp.exa.ai', 'x-tavily-access-mode', 'api.deepseek.com']) {
    assert.equal(code.toLowerCase().includes(gone), false, `lib/ must not reference the stripped engine surface (${gone})`)
  }
})

test('strip surface: credentials-center integration and engine preference are gone', () => {
  const code = libCode()
  assert.equal(/\bctx\.get\s*\(/u.test(code), false, 'no un-injected service access through ctx.get (Cordis proxy throws)')
  assert.equal(/credentials-set|credentials-unset|credentials-status|KEY_REF_MAP|keyStorage/u.test(code), false, 'credentials-center bridge/UI must be gone')
  assert.equal(/provider:\s*z\.string|keyStorage|platforms:\s*z\.array/u.test(code), false, 'the provider/keyStorage/platforms settings are gone')
  assert.equal(/platform_search/u.test(code), false, 'platform_search tool is outside the reviewed source scope')
})

test('coexistence patch: one insert row plus the single-key web row re-pin, nothing else', () => {
  const patch = read(join(PLUGIN_DIR, 'cordis.patch.yml'))
  const ids = [...patch.matchAll(/^\s*-\s+id:\s+([^\s#]+)/gmu)].map((m) => m[1])
  assert.deepEqual(ids, ['web-search-free', 'web'], 'the patch touches exactly its own insert and the web row')
  assert.equal(/searchProvider:\s*ddg/u.test(patch), true, 'the web row is re-pinned to this plugin provider id')
  assert.equal(patch.includes('fetchProvider'), false, 'the minimal patch must not restate unrelated web config')
  assert.equal(/^\s*disabled:/mu.test(patch), false, 'the patch disables nothing')
})

test('package shape: no build scripts, pure-JS deps, stable semver, workflow-convention directory name', () => {
  const pkg = JSON.parse(read(join(PLUGIN_DIR, 'package.json')))
  assert.equal(pkg.name, 'dsh-free-search')
  assert.equal(pkg.version, '0.4.182')
  assert.match(pkg.version, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u, 'the manifest signs stable semver only')
  assert.equal(pkg.scripts, undefined, 'no build scripts — pnpm build-script interception never applies')
  assert.deepEqual(Object.keys(pkg.dependencies), ['@deepseek-ai/schemastery'], 'single pure-JS dependency, no native builds')
  assert.equal(Object.keys(pkg.peerDependencies).includes('@deepseek-ai/dsh-settings'), true)
  assert.equal(Object.keys(pkg.peerDependencies).includes('@deepseek-ai/dsh-tools'), true)
  assert.deepEqual(pkg.files.sort(), ['cordis.patch.yml', 'lib/client.js', 'lib/engines.js', 'lib/index.js'])
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime'], 'client inject stays a flat string array')
  assert.equal(basename(PLUGIN_DIR), `${pkg.name}-${pkg.version}`, 'the source directory follows the pack-tarball --from-allowlist stem convention')
  for (const file of pkg.files) assert.equal(existsSync(join(PLUGIN_DIR, file)), true, `${file} is declared but missing`)
  assert.equal(existsSync(join(PLUGIN_DIR, 'LICENSE')), true, 'upstream LICENSE kept')
  assert.equal(existsSync(join(PLUGIN_DIR, 'docs', 'README-upstream.md')), true, 'upstream README kept for provenance (not shipped: outside files)')
})

test('tool surface: every registered tool is free_search_-prefixed and goes through defineTool', () => {
  const code = libCode()
  const names = [...code.matchAll(/name:\s*"(free_search_[a-z_]+)"/gu)].map((m) => m[1])
  assert.deepEqual(names.sort(), ['free_search_advanced', 'free_search_test'])
  assert.equal(/name:\s*"advanced_search"/u.test(code), false)
  assert.equal(/name:\s*"platform_search"/u.test(code), false)
  const registers = [...code.matchAll(/sctx\.tools\.register\(\s*defineTool\(/gu)]
  assert.equal(registers.length, 2, 'both registrations wrap defineTool (projected complete JSON Schema parameters)')
})

// ---------------------------------------------------------------------------
// fake-harness apply() smoke — stub the three DSH peer imports, import the
// real plugin, drive provider.search/bridge/tools against a faked fetch
// ---------------------------------------------------------------------------

/** Stage a temp package whose node_modules stubs the DSH peers, then import the plugin. */
async function importPluginWithStubs() {
  const staging = mkdtempSync(join(tmpdir(), 'dsh-free-search-smoke-'))
  cpSync(LIB_DIR, join(staging, 'lib'), { recursive: true })
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2)}\n`)
  const stubs = {
    '@deepseek-ai/dsh-settings': `
      export class SettingsConflictError extends Error {}
      export function settingsNamespace(ns) { return ns; }
      export function installSettingsSection(ctx, ns, schema, entry, hooks) {
        hooks.setSource(() => entry);
      }
    `,
    '@deepseek-ai/dsh-tools': `
      export function defineTool(definition) {
        const spec = definition.parameters ?? {};
        const required = Object.entries(spec).filter(([, p]) => p && p.required === true).map(([key]) => key);
        const parameters = { type: 'object', properties: spec, ...(required.length > 0 ? { required } : {}) };
        return { ...definition, parameters, __parametersProjected: true };
      }
    `,
    '@deepseek-ai/schemastery': `
      const chain = () => {
        const node = { default() { return node; }, role() { return node; } };
        return node;
      };
      const z = {
        object(shape) { return { shape, __schemasteryObject: true }; },
        boolean: chain, string: chain, number: chain, array: chain,
      };
      export default z;
    `,
  }
  for (const [name, source] of Object.entries(stubs)) {
    const dir = join(staging, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.0.0-stub', type: 'module', main: 'index.js' })}\n`)
    writeFileSync(join(dir, 'index.js'), source)
  }
  const plugin = await import(pathToFileURL(join(staging, 'lib', 'index.js')).href)
  return { plugin, staging }
}

/** A minimal Cordis-shaped ctx double that records everything apply() registers. */
function makeFakeCtx() {
  const registered = { providers: [], routes: [], tools: [], promptSections: [], injections: [] }
  const scope = (services) => ({
    effect(fn) { return fn() },
    ...(services.includes('webServer') ? { webServer: { register(route) { registered.routes.push(route); return () => {} } } } : {}),
    ...(services.includes('settings') ? { settings: { describe: () => [], mutate: async () => {} } } : {}),
    ...(services.includes('tools') ? { tools: { register(def) { registered.tools.push(def); return () => {} } } } : {}),
    ...(services.includes('systemPrompt') ? { systemPrompt: { section(opts) { registered.promptSections.push(opts); return () => {} } } } : {}),
  })
  const ctx = {
    logger: { info() {}, warn() {} },
    inject(services, fn) {
      registered.injections.push([...services])
      fn(scope(services))
    },
    web: {
      searchProviderId: undefined,
      registerSearchProvider(provider) { registered.providers.push(provider); return () => {} },
    },
  }
  return { ctx, registered }
}

test('apply() smoke: provider registration, takeover only when unset, bridge, tools, prompt', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { tavilyApiKey: 'tvly-test', cache: false })
    assert.equal(plugin.name, 'web-search-free')
    assert.deepEqual(plugin.inject, ['web'], 'server inject stays a flat string array')

    // Provider + takeover-when-unset coexistence rule
    assert.equal(registered.providers.length, 1)
    const provider = registered.providers[0]
    assert.equal(provider.id, 'ddg')
    assert.equal(provider.available(), true)
    assert.equal(ctx.web.searchProviderId, 'ddg', 'unset searchProvider is taken over')
    const ctx2 = makeFakeCtx()
    ctx2.ctx.web.searchProviderId = 'someone-else'
    plugin.apply(ctx2.ctx, {})
    assert.equal(ctx2.ctx.web.searchProviderId, 'someone-else', 'an explicit other provider is left alone')

    // Injections are declarative only — no ctx.get anywhere
    assert.deepEqual(registered.injections.sort(), [['systemPrompt'], ['tools'], ['tools'], ['webServer', 'settings']])

    // Bridge: three loopback-guarded routes, no update/credentials routes
    assert.deepEqual(registered.routes.map((route) => route.path).sort(), [
      '/api/dsh-free-search-settings/describe',
      '/api/dsh-free-search-settings/mutate',
      '/api/dsh-free-search-settings/raw-search',
    ])

    // Tools: free_search_-prefixed, defineTool-projected object-rooted parameters
    assert.deepEqual(registered.tools.map((tool) => tool.name).sort(), ['free_search_advanced', 'free_search_test'])
    for (const tool of registered.tools) {
      assert.equal(tool.__parametersProjected, true)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.parameters.properties, 'object')
    }
    const advanced = registered.tools.find((tool) => tool.name === 'free_search_advanced')
    assert.deepEqual(advanced.parameters.required, ['query'])
    assert.equal(Object.keys(advanced.parameters.properties).includes('engine'), false, 'engine forcing is stripped (chain is policy)')
    assert.equal(Object.keys(registered.tools.find((tool) => tool.name === 'free_search_test').parameters.properties).includes('engines'), true)

    // System prompt reflects the company chain
    assert.equal(registered.promptSections.length, 1)
    assert.match(registered.promptSections[0].text, /tavily -> exa -> bing -> ddg/u)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

test('provider.search smoke: keyed tavily answers first; keyless run answers through bing; failures degrade readably', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  try {
    // 1. tavily keyed: chain [tavily, bing, ddg], fake tavily JSON answers.
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-test', cache: false })
      globalThis.fetch = fakeFetch([
        ['https://api.tavily.com/', jsonResponse(TAVILY_JSON)],
        ['https://www.bing.com/', jsonResponse(BING_HTML)],
        ['https://html.duckduckgo.com/', jsonResponse(BING_HTML)],
      ])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'tavily')
      assert.equal(result.sources.length, 1)
      assert.equal(result.sources[0].url, 'https://result.example/tavily')
      assert.equal(result._cache, 'miss')
    }
    // 2. zero keys: chain [bing, ddg], the faked bing HTML answers, snippet cleaning runs.
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { cache: false })
      globalThis.fetch = fakeFetch([['https://www.bing.com/', jsonResponse(BING_HTML)]])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'bing')
      assert.equal(result.sources.length, 2)
      assert.equal(result.sources[0].snippet.includes('sign up'), false, 'snippet noise phrases are cleaned')
    }
    // 3. whole chain failing: readable content, sources [], and NO rejection.
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { cache: false })
      // collapse the retry backoff so the failure path stays fast
      globalThis.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return { unref() {} } }
      globalThis.fetch = fakeFetch([['https://', new TypeError('fetch failed')]])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.deepEqual(result.sources, [])
      assert.equal(result.truncated, false)
      assert.match(result.content, /every engine in the company chain/u)
      assert.match(result.content, /bing/u)
      assert.match(result.content, /ddg/u)
    }
    // 4. malformed query still fails fast through the shared guard (seam contract misuse).
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, {})
      globalThis.fetch = fakeFetch([])
      await assert.rejects(registered.providers[0].search({ query: '   ' }), /query is required/u)
    }
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    rmSync(staging, { recursive: true, force: true })
  }
})

test('tool execution smoke (fakes): free_search_advanced runs the chain; free_search_test reports per engine', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { cache: false })
    // collapse the ddg retry backoff so the failing-engine report stays fast
    globalThis.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return { unref() {} } }
    globalThis.fetch = fakeFetch([
      ['https://www.bing.com/', jsonResponse(BING_HTML)],
      ['https://html.duckduckgo.com/', new Error('ddg rate-limited')],
    ])
    const advanced = registered.tools.find((tool) => tool.name === 'free_search_advanced')
    const advancedResult = await advanced.execute({ query: 'deepseek harness', timeRange: 'week', maxResults: 2 })
    assert.equal(advancedResult.provider, 'bing')
    assert.equal(advancedResult.sources.length, 2)
    assert.equal(advancedResult.sources[0].url.startsWith('https://result.example/'), true)

    const test = registered.tools.find((tool) => tool.name === 'free_search_test')
    const testResult = await test.execute({ engines: ['bing', 'ddg'] })
    assert.equal(testResult.results.length, 2)
    assert.equal(testResult.results.find((r) => r.engine === 'bing').status, 'ok')
    const ddg = testResult.results.find((r) => r.engine === 'ddg')
    assert.equal(ddg.status, 'fail')
    assert.match(ddg.error, /rate-limited|connection error/u)
    const blocks = advanced.finalizeContent({}, { content: 'text' })
    assert.deepEqual(blocks, [{ type: 'text', text: 'text' }])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    rmSync(staging, { recursive: true, force: true })
  }
})

test('i18n surface: every t.<key> referenced in client.js exists in both the zh and the en dictionary', () => {
  // 评审 P2-1 回归钉：键集收窄曾误删仍被脏状态指示器引用的 unsaved
  // （渲染 undefined）。client.js 是 ModuleLoader 工厂包，无法在 Node 直接
  // import——对源码做结构化解析：引用侧扫 t.<key>，字典侧按 8 空格缩进的
  // 键行收集两语言键集。
  const source = read(join(LIB_DIR, 'client.js'))
  const i18nStart = source.indexOf('const I18N = {')
  assert.notEqual(i18nStart, -1, 'client.js must define the I18N dictionaries')
  const i18nEnd = source.indexOf('\n    };', i18nStart)
  assert.notEqual(i18nEnd, -1, 'the I18N literal must close at the factory top level')
  const block = source.slice(i18nStart, i18nEnd)
  const dictionary = (lang) => {
    const start = block.indexOf(`${lang}: {`)
    assert.notEqual(start, -1, `the ${lang} dictionary must exist`)
    const end = block.indexOf('\n      },', start)
    assert.notEqual(end, -1, `the ${lang} dictionary must close`)
    return new Set([...block.slice(start, end).matchAll(/^ {8}([A-Za-z_$][\w$]*):/gmu)].map((m) => m[1]))
  }
  const zh = dictionary('zh')
  const en = dictionary('en')
  assert.deepEqual([...en], [...zh], 'zh and en carry the same key set (order preserved)')
  const referenced = [...source.matchAll(/\bt\.([A-Za-z_$][\w$]*)/gu)].map((m) => m[1])
  assert.ok(referenced.length >= 20, `expected a realistic key surface, got ${String(referenced.length)}`)
  for (const key of referenced) {
    assert.ok(zh.has(key), `t.${key} is referenced but missing from the zh dictionary`)
    assert.ok(en.has(key), `t.${key} is referenced but missing from the en dictionary`)
  }
  assert.ok(new Set(referenced).has('unsaved'), 'the dirty-indicator key unsaved must stay referenced and defined')
})

test('system prompt engine list: env-configured keys count — same resolution path and priority as the chain', async () => {
  // 评审 P2-2 回归钉：refreshPrompt 曾只看设置值，漏掉链路 resolveApiKey
  // 的 TAVILY_API_KEY/EXA_API_KEY 环境变量回退，env 配 key 时提示词谎报
  // 「无 keyed 引擎」。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const originalTavily = process.env.TAVILY_API_KEY
  const originalExa = process.env.EXA_API_KEY
  try {
    // 1. settings 无 key、仅 env 配 TAVILY_API_KEY：提示词必须列 tavily。
    process.env.TAVILY_API_KEY = 'tvly-env'
    delete process.env.EXA_API_KEY
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { cache: false })
      assert.equal(registered.promptSections.length, 1)
      assert.match(registered.promptSections[0].text, /Currently keyed engines: tavily\b/u)
      assert.doesNotMatch(registered.promptSections[0].text, /Currently keyed engines: none/u)
    }
    // 2. 设置值与 env 同时存在：优先级与链一致（设置值 > env）——链发出的
    //    请求必须携带设置值 key，提示词与链同源。
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-settings', cache: false })
      assert.match(registered.promptSections[0].text, /Currently keyed engines: tavily\b/u)
      let seenAuthorization = null
      globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('https://api.tavily.com/')) {
          seenAuthorization = init?.headers?.authorization
          return jsonResponse(TAVILY_JSON)
        }
        throw new TypeError(`fake fetch: no route for ${String(url)}`)
      }
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'tavily')
      assert.equal(seenAuthorization, 'Bearer tvly-settings', 'the settings value must beat the env value in the actual chain')
    }
  } finally {
    for (const [name, value] of [['TAVILY_API_KEY', originalTavily], ['EXA_API_KEY', originalExa]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    globalThis.fetch = originalFetch
    rmSync(staging, { recursive: true, force: true })
  }
})

test('provider.search with an already-aborted signal: no fetch is issued and the abort resolves readably', async () => {
  // 评审 P3 回归钉：fetchHtml 曾对已取消的 signal 照常发请求（abort 事件
  // 不重放），最坏情有带一个引擎的完整重试周期。预检后 fetch 零调用。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const originalSetTimeout = globalThis.setTimeout
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { cache: false })
    let fetchCalls = 0
    globalThis.fetch = async () => { fetchCalls += 1; return jsonResponse(TAVILY_JSON) }
    // collapse the retry backoff so the abort path stays fast
    globalThis.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return { unref() {} } }
    const controller = new AbortController()
    controller.abort()
    const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 }, controller.signal)
    assert.equal(fetchCalls, 0, 'an already-aborted signal must never reach fetch')
    assert.deepEqual(result.sources, [])
    assert.equal(result.truncated, false)
    assert.match(result.content, /search aborted/u, 'the readable outcome must say the search was aborted')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    rmSync(staging, { recursive: true, force: true })
  }
})

test('a whole chain of true 0-results reads as “nothing matched”, not as an engine outage', async () => {
  // 评审 P3 回归钉：全部引擎真无结果时，总结句不得再宣称「搜索暂不可用」
  // （per-engine 条目已带 returned 0 results 字样）。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { cache: false })
    const EMPTY_HTML = `<html><body><ol></ol>${'<pad>'.repeat(120)}</body></html>`
    globalThis.fetch = fakeFetch([
      ['https://www.bing.com/', jsonResponse(EMPTY_HTML)],
      ['https://html.duckduckgo.com/', jsonResponse(EMPTY_HTML)],
    ])
    const result = await registered.providers[0].search({ query: 'obscure query with no matches', maxResults: 5 })
    assert.deepEqual(result.sources, [])
    assert.match(result.content, /returned 0 results for this query/u)
    assert.match(result.content, /nothing matched/u)
    assert.doesNotMatch(result.content, /temporarily unavailable/u)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(staging, { recursive: true, force: true })
  }
})

test('bridge smoke: raw-search is loopback-guarded, POST-only, and answers through the provider', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { cache: false })
    globalThis.fetch = fakeFetch([['https://www.bing.com/', jsonResponse(BING_HTML)]])
    const rawSearch = registered.routes.find((route) => route.path.endsWith('/raw-search'))
    const makeRes = () => {
      const state = {}
      return {
        state,
        writeHead(status, headers) { state.status = status; state.headers = headers },
        end(payload) { state.body = JSON.parse(payload) },
      }
    }
    const makeReq = (socketAddress, headers = {}, body) => ({
      method: 'POST',
      socket: { remoteAddress: socketAddress },
      headers: { host: '127.0.0.1:3080', ...headers },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
    })
    // non-loopback → 403 before any handler runs
    {
      const res = makeRes()
      await rawSearch.handler(makeReq('192.168.1.5'), res)
      assert.equal(res.state.status, 403)
    }
    // loopback happy path → 200 with the engine that answered
    {
      const res = makeRes()
      await rawSearch.handler(makeReq('127.0.0.1', {}, { query: 'deepseek harness', maxResults: 2 }), res)
      assert.equal(res.state.status, 200)
      assert.equal(res.state.body.ok, true)
      assert.equal(res.state.body.value.provider, 'bing')
      assert.equal(res.state.body.value.sources.length, 2)
    }
    // engine param outside the company chain is rejected with the chain spelled out
    {
      const res = makeRes()
      await rawSearch.handler(makeReq('127.0.0.1', {}, { query: 'x', engine: 'keenable' }), res)
      assert.equal(res.state.status, 200)
      assert.equal(res.state.body.ok, false)
      assert.equal(res.state.body.code, 'engine-rejected')
      assert.match(res.state.body.message, /tavily, exa, bing, ddg/u)
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(staging, { recursive: true, force: true })
  }
})
