/**
 * Hardened dsh-free-search (P7 first listed plugin): unit tests for the
 * company engine chain, strip-surface assertions over the vendored tree, and
 * an offline fake-harness smoke of the plugin's apply() face.
 *
 * Coverage map (task P7 · 2026-09-03, 0.4.183 三键制改版 · 2026-09-05):
 *  - chain selection: resolveEngineChain is keyed-only — zero keys resolve
 *    to an empty chain (the caller must answer with setup guidance), keyed
 *    engines join in reviewed order whatever the mix,
 *  - chain execution: per-engine try/catch degradation, zero-results treated
 *    as failure, an already-aborted signal stops the chain before any engine
 *    runs (the fetchHtml precheck moved into the executor), total failure
 *    resolves (never rejects) with readable failures — the
 *    single-process-harness red line,
 *  - strip surface: no pnpm self-update, no npm-registry probe, no 4789
 *    server, no profile-patch direct writes (no node:fs/path/child_process
 *    in lib/), engine endpoint allowlist sweep over lib/, and the 0.4.183
 *    regression pins — no bing/ddg engine surface at all
 *    (BING_URL/DDG_HTML_URL/fetchHtml/searchBing/searchDdgHtml gone),
 *  - coexistence patch: only the web-search-free insert + the single-key
 *    `web` row re-pin; the re-pin value equals the provider id defined once
 *    in lib/index.js (PROVIDER_ID, "free-search" since 0.4.183),
 *  - package shape: no build scripts, pure-JS dependency set, stable semver
 *    version, workflow-convention source directory name,
 *  - fake-harness smoke: apply() registers the provider (id free-search,
 *    takeover only when searchProviderId unset), the settings bridge
 *    (loopback guarded), both free_search_-prefixed tools with
 *    defineTool-projected complete JSON-Schema parameters; provider.search
 *    returns results through a faked fetch (tavily keyed path, anysearch
 *    keyed path with code!==0 readable rejection), zero keys return the
 *    setup guidance without any fetch, and a readable message — not a
 *    throw — when every engine fails,
 *  - engine test bound (fs-183 review P2): runEngineTest dispatches with
 *    AbortSignal.timeout(15000) — a hanging endpoint fails readably at the
 *    15s bound for every chain engine instead of hanging the tool forever
 *    (exa/anysearch fetches have no internal bound; AbortSignal.timeout is
 *    a native timer, so the test stubs the static and drives the abort via
 *    fake global setTimeout),
 *  - result-count caps (fs-183 review P3): all three engine request bodies
 *    clamp the result count to 20 — exa numResults and anysearch max_results
 *    join tavily max_results, so a runaway caller cannot burn the free
 *    quota in one request.
 */

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// tools/company-catalog/tests → tools/company-catalog → the vendored plugin source.
const PLUGIN_DIR = join(TOOL_DIR, 'plugin-sources', 'dsh-free-search-0.4.183')
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

const TAVILY_JSON = JSON.stringify({
  results: [
    { url: 'https://result.example/tavily', title: 'Tavily Result', content: 'tavily snippet content' },
  ],
})

const EXA_JSON = JSON.stringify({
  results: [
    { url: 'https://result.example/exa-one', title: 'Exa Result One', highlights: ['exa highlight snippet one'], publishedDate: '2026-09-01' },
    { url: 'https://result.example/exa-two', title: 'Exa Result Two', highlights: ['exa highlight snippet two'] },
  ],
})

// AnySearch 实测形态：code===0 → data.results[]（title/url/snippet）
const ANYSEARCH_JSON = JSON.stringify({
  code: 0,
  data: {
    results: [
      { url: 'https://result.example/anysearch', title: 'AnySearch Result', snippet: 'anysearch snippet' },
    ],
  },
})

// content 字段兼容形态：无 snippet 时回退 content
const ANYSEARCH_CONTENT_JSON = JSON.stringify({
  code: 0,
  data: {
    results: [
      { url: 'https://result.example/anysearch-content', title: 'Content Field Result', content: 'content-field snippet' },
    ],
  },
})

// code!==0：配额/错误负载
const ANYSEARCH_ERR_JSON = JSON.stringify({ code: 1001, message: 'quota exceeded' })

/** Response-like object shaped for the plugin's engine implementations. */
const jsonResponse = (payload) => ({ ok: true, status: 200, async text() { return payload }, async json() { return JSON.parse(payload) } })
const statusResponse = (status, payload) => ({ ok: false, status, async text() { return payload }, async json() { return JSON.parse(payload) } })

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

const KEY_ENV_NAMES = ['TAVILY_API_KEY', 'EXA_API_KEY', 'ANYSEARCH_API_KEY']

/**
 * Snapshot the three engine-key env vars, delete them, return the restore
 * fn. The keyed-only chain resolves keys settings > env, so key-sensitive
 * assertions must not depend on whatever the test host carries in env.
 */
function isolateKeyEnv() {
  const snapshot = KEY_ENV_NAMES.map((name) => [name, process.env[name]])
  for (const [name] of snapshot) delete process.env[name]
  return () => {
    for (const [name, value] of snapshot) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

// ---------------------------------------------------------------------------
// engine chain units (lib/engines.js — pure, no DSH imports)
// ---------------------------------------------------------------------------

test('resolveEngineChain: keyed-only since 0.4.183 — zero keys resolve to an empty chain', async () => {
  const { resolveEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  assert.deepEqual(resolveEngineChain({}), [], 'no keys, no chain — the caller answers with setup guidance')
  assert.deepEqual(resolveEngineChain({ tavilyKey: '', exaKey: '   ', anysearchKey: '\t' }), [], 'blank/whitespace keys are absent')
  assert.deepEqual(resolveEngineChain({ tavilyKey: 42, exaKey: null, anysearchKey: {} }), [], 'non-string keys are absent')
})

test('resolveEngineChain: keyed engines join in reviewed order whatever the mix', async () => {
  const { resolveEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  assert.deepEqual(resolveEngineChain({ tavilyKey: 'tvly-1' }), ['tavily'])
  assert.deepEqual(resolveEngineChain({ exaKey: 'exa-1' }), ['exa'])
  assert.deepEqual(resolveEngineChain({ anysearchKey: 'as-1' }), ['anysearch'])
  assert.deepEqual(resolveEngineChain({ tavilyKey: 'tvly-1', anysearchKey: 'as-1' }), ['tavily', 'anysearch'])
  assert.deepEqual(resolveEngineChain({ exaKey: 'exa-1', anysearchKey: 'as-1' }), ['exa', 'anysearch'])
  assert.deepEqual(resolveEngineChain({ tavilyKey: 'tvly-1', exaKey: 'exa-1' }), ['tavily', 'exa'])
  assert.deepEqual(resolveEngineChain({ tavilyKey: 'tvly-1', exaKey: 'exa-1', anysearchKey: 'as-1' }), ['tavily', 'exa', 'anysearch'])
})

test('runEngineChain: first engine wins, no failures recorded', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const tried = []
  const outcome = await runEngineChain({
    chain: ['tavily', 'exa', 'anysearch'],
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
    chain: ['tavily', 'exa', 'anysearch'],
    runEngine: async (engine) => {
      if (engine === 'anysearch') return { sources: [{ url: 'https://x/anysearch' }] }
      if (engine === 'tavily') throw new Error('Tavily API key is invalid (HTTP 401)')
      throw 'non-Error rejection'
    },
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.engine, 'anysearch')
  assert.deepEqual(outcome.failures, [
    { engine: 'tavily', error: 'Tavily API key is invalid (HTTP 401)' },
    { engine: 'exa', error: 'non-Error rejection' },
  ])
})

test('runEngineChain: zero-source results count as failure and the chain moves on', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const outcome = await runEngineChain({
    chain: ['exa', 'anysearch'],
    runEngine: async (engine) => (engine === 'exa' ? { sources: [] } : { sources: [{ url: 'https://x/anysearch' }] }),
  })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.engine, 'anysearch')
  assert.equal(outcome.failures[0].error.includes('0 results'), true)
})

test('runEngineChain: every engine failing RESOLVES with readable failures — never a top-level throw', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const outcome = await runEngineChain({
    chain: ['tavily', 'exa', 'anysearch'],
    runEngine: async () => { throw new Error('connection error: boom') },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failures.length, 3)
  for (const failure of outcome.failures) {
    assert.equal(typeof failure.engine, 'string')
    assert.equal(failure.error.includes('connection error'), true)
  }
})

test('runEngineChain: malformed engine results are failures, not crashes', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const outcome = await runEngineChain({
    chain: ['exa', 'anysearch'],
    runEngine: async (engine) => (engine === 'exa' ? null : undefined),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.failures.length, 2)
})

test('runEngineChain: an already-aborted external signal stops the chain BEFORE any engine runs', async () => {
  // 评审 P3 回归钉（0.4.183 上移版）：fetchHtml 删除后，已取消 signal 的
  // 预检由链执行器承担——abort 事件不对已取消的 signal 重放，不预检的话
  // 第一个引擎会带着已取消的请求跑完自己的超时。
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  const controller = new AbortController()
  controller.abort()
  let engineCalls = 0
  const outcome = await runEngineChain({
    chain: ['tavily', 'exa', 'anysearch'],
    signal: controller.signal,
    runEngine: async () => { engineCalls += 1; throw new Error('must not run') },
  })
  assert.equal(outcome.ok, false)
  assert.equal(engineCalls, 0, 'an already-aborted signal must stop the chain before the first engine')
  assert.deepEqual(outcome.failures, [{ engine: 'tavily', error: 'search aborted' }])
})

test('runEngineChain: the serial budget bounds the chain (deadline exhausted before a late engine)', async () => {
  const { runEngineChain } = await import(pathToFileURL(join(LIB_DIR, 'engines.js')).href)
  let now = 0
  const outcome = await runEngineChain({
    chain: ['exa', 'anysearch'],
    budgetMs: 1000,
    now: () => now,
    runEngine: async (engine) => {
      if (engine === 'exa') { now = 2000; throw new Error('slow') }
      return { sources: [{ url: 'https://x/anysearch' }] }
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

test('strip surface: engine endpoints are exactly the reviewed keyed chain; no keyless/extra engine APIs', () => {
  const code = libCode()
  const urls = code.match(/https:\/\/[a-z0-9.-]+/giu) ?? []
  const origins = new Set(urls.map((url) => url.slice('https://'.length)))
  assert.deepEqual(
    [...origins].sort(),
    // the three keyed API endpoints plus the three signup portals carried in
    // the zero-key guidance and the settings-card signup guide (inert text
    // for the user to open — never fetched by the plugin)
    ['anysearch.com', 'api.anysearch.com', 'api.exa.ai', 'api.tavily.com', 'exa.ai', 'tavily.com'],
    'the only https origins in lib/ are the three chain engine endpoints and the three signup portals',
  )
  for (const gone of ['keenable', 'searxng', 'perplexity', 'deepseek-official', 'ddg-lite', 'mcp.exa.ai', 'x-tavily-access-mode', 'api.deepseek.com']) {
    assert.equal(code.toLowerCase().includes(gone), false, `lib/ must not reference the stripped engine surface (${gone})`)
  }
})

test('strip surface: the bing/ddg engines and their scraping path are gone (0.4.183 keyed-only chain)', () => {
  // 用户拍板：不要免费抓取源。bing（质量差）与 ddg（公司网络封禁）连同
  // fetchHtml 抓取路径整体移除——grep 断言钉死，防回潮。
  const code = libCode()
  for (const gone of ['BING_URL', 'DDG_HTML_URL', 'searchBing', 'searchDdgHtml', 'fetchHtml', 'fetchHtmlWithRetry', 'www.bing.com', 'html.duckduckgo.com']) {
    assert.equal(code.includes(gone), false, `lib/ must not carry the removed free-scraping engine surface (${gone})`)
  }
  assert.equal(/safeSearch|bingMarket|region:\s*z\.string/u.test(code), false, 'the bing/ddg-only settings (safeSearch/bingMarket/region) are gone with their engines')
  const pkg = JSON.parse(read(join(PLUGIN_DIR, 'package.json')))
  assert.equal(/duckduckgo|bing/u.test(pkg.keywords.join(' ')), false, 'the package keywords drop the removed engines')
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
  const providerId = stripJsComments(read(join(LIB_DIR, 'index.js'))).match(/PROVIDER_ID = "([^"]+)"/u)?.[1]
  assert.equal(providerId, 'free-search', 'lib/index.js defines the provider id once (PROVIDER_ID)')
  assert.equal(new RegExp(`searchProvider:\\s*${providerId}\\b`, 'u').test(patch), true, 'the web row is re-pinned to exactly the plugin provider id')
  assert.equal(patch.includes('fetchProvider'), false, 'the minimal patch must not restate unrelated web config')
  assert.equal(/^\s*disabled:/mu.test(patch), false, 'the patch disables nothing')
})

test('package shape: no build scripts, pure-JS deps, stable semver, workflow-convention directory name', () => {
  const pkg = JSON.parse(read(join(PLUGIN_DIR, 'package.json')))
  assert.equal(pkg.name, 'dsh-free-search')
  assert.equal(pkg.version, '0.4.183')
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
  const restoreEnv = isolateKeyEnv()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { tavilyApiKey: 'tvly-test', cache: false })
    assert.equal(plugin.name, 'web-search-free')
    assert.deepEqual(plugin.inject, ['web'], 'server inject stays a flat string array')

    // Provider + takeover-when-unset coexistence rule
    assert.equal(registered.providers.length, 1)
    const provider = registered.providers[0]
    assert.equal(provider.id, 'free-search', 'the provider id is the neutral plugin id (0.4.183; the "ddg" id outlived its engine)')
    assert.equal(provider.available(), true)
    assert.equal(ctx.web.searchProviderId, 'free-search', 'unset searchProvider is taken over')
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
    const test = registered.tools.find((tool) => tool.name === 'free_search_test')
    assert.equal(Object.keys(test.parameters.properties).includes('engines'), true)
    assert.match(test.parameters.properties.engines.description, /tavily, exa, anysearch/u)

    // System prompt reflects the company chain
    assert.equal(registered.promptSections.length, 1)
    assert.match(registered.promptSections[0].text, /tavily -> exa -> anysearch/u)
    assert.match(registered.promptSections[0].text, /Currently keyed engines: tavily\b/u)
  } finally {
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('provider.search smoke: keyed tavily answers first; a 401 degrades to exa with a note; total failure stays readable', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    // 1. tavily keyed: chain [tavily], fake tavily JSON answers.
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-test', cache: false })
      globalThis.fetch = fakeFetch([
        ['https://api.tavily.com/', jsonResponse(TAVILY_JSON)],
        ['https://api.exa.ai/', jsonResponse(EXA_JSON)],
        ['https://api.anysearch.com/', jsonResponse(ANYSEARCH_JSON)],
      ])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'tavily')
      assert.equal(result.sources.length, 1)
      assert.equal(result.sources[0].url, 'https://result.example/tavily')
      assert.equal(result._cache, 'miss')
    }
    // 2. mixed keys, head engine 401: degrades to exa and the result carries
    //    a note naming the failed engine and the engine that answered.
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-bad', exaApiKey: 'exa-1', cache: false })
      globalThis.fetch = fakeFetch([
        ['https://api.tavily.com/', statusResponse(401, '{"detail":"bad key"}')],
        ['https://api.exa.ai/', jsonResponse(EXA_JSON)],
      ])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'exa')
      assert.equal(result.sources.length, 2)
      assert.match(result.content, /tavily unavailable or failed \(Tavily API key is invalid \(HTTP 401\)/u)
      assert.match(result.content, /using exa/u)
    }
    // 3. every keyed engine failing: readable content, sources [], NO rejection.
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-x', exaApiKey: 'exa-x', anysearchApiKey: 'as-x', cache: false })
      globalThis.fetch = fakeFetch([['https://', new TypeError('fetch failed')]])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.deepEqual(result.sources, [])
      assert.equal(result.truncated, false)
      assert.match(result.content, /every engine in the company chain \(tavily -> exa -> anysearch\) failed/u)
      assert.match(result.content, /Failures: tavily:/u)
      assert.match(result.content, /exa:/u)
      assert.match(result.content, /anysearch:/u)
    }
    // 4. malformed query still fails fast through the shared guard (seam contract misuse).
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-test' })
      globalThis.fetch = fakeFetch([])
      await assert.rejects(registered.providers[0].search({ query: '   ' }), /query is required/u)
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('anysearch engine smoke: code 0 parses results (snippet + content fallback), code!==0 rejects readably, network errors degrade', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    // 1. code===0, snippet 形态：直接解析 title/url/snippet。
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { anysearchApiKey: 'as-1', cache: false })
      globalThis.fetch = fakeFetch([['https://api.anysearch.com/', jsonResponse(ANYSEARCH_JSON)]])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'anysearch')
      assert.equal(result.sources.length, 1)
      assert.equal(result.sources[0].url, 'https://result.example/anysearch')
      assert.equal(result.sources[0].title, 'AnySearch Result')
      assert.equal(result.sources[0].snippet, 'anysearch snippet')
    }
    // 2. code===0, 无 snippet：content 字段兼容回退。
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { anysearchApiKey: 'as-1', cache: false })
      globalThis.fetch = fakeFetch([['https://api.anysearch.com/', jsonResponse(ANYSEARCH_CONTENT_JSON)]])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'anysearch')
      assert.equal(result.sources[0].snippet, 'content-field snippet', 'the content field is the snippet fallback')
    }
    // 3. code!==0：可读错误（作为链内唯一引擎时全链失败文案携带它）。
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { anysearchApiKey: 'as-1', cache: false })
      globalThis.fetch = fakeFetch([['https://api.anysearch.com/', jsonResponse(ANYSEARCH_ERR_JSON)]])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.deepEqual(result.sources, [])
      assert.match(result.content, /AnySearch API error \(code 1001\): quota exceeded/u)
    }
    // 4. 网络错误降级：链头 tavily 网络错误 → anysearch 接管应答。
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-1', anysearchApiKey: 'as-1', cache: false })
      globalThis.fetch = fakeFetch([
        ['https://api.tavily.com/', new TypeError('fetch failed')],
        ['https://api.anysearch.com/', jsonResponse(ANYSEARCH_JSON)],
      ])
      const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
      assert.equal(result.provider, 'anysearch')
      assert.equal(result.sources.length, 1)
      assert.match(result.content, /using anysearch/u)
    }
    // 5. 未配 key：引擎自身抛可读错误（keyed-only 的引擎级表现，链外直测）。
    {
      await assert.rejects(plugin.searchAnysearch('q', 5, '', undefined), /AnySearch search requires ANYSEARCH_API_KEY/u)
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('zero keys: search returns setup guidance — quotas, signup portals, config location — and issues no fetch', async () => {
  // 0.4.183 三键制核心行为：无任何 key 时不再有静默的免费链，search 返回
  // 配置引导（三引擎免费额度 + 注册入口 + 配置位置），且零网络调用。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { cache: false })
    let fetchCalls = 0
    globalThis.fetch = async () => { fetchCalls += 1; return jsonResponse(TAVILY_JSON) }
    const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 })
    assert.equal(fetchCalls, 0, 'the empty chain must never reach fetch')
    assert.deepEqual(result.sources, [])
    assert.equal(result.truncated, false)
    assert.match(result.content, /no engine keys are configured/u)
    assert.match(result.content, /company chain \(tavily -> exa -> anysearch\) has no members/u)
    assert.match(result.content, /keyed-only/u)
    for (const portal of ['https://tavily.com', 'https://exa.ai', 'https://anysearch.com']) {
      assert.equal(result.content.includes(portal), true, `the guidance must carry the ${portal} signup portal`)
    }
    assert.match(result.content, /1,000 searches\/month/u, 'tavily free tier')
    assert.match(result.content, /\$20 signup credit plus \$10\/month/u, 'exa free tier')
    assert.match(result.content, /1,000 searches\/day/u, 'anysearch free tier')
    assert.match(result.content, /Settings > Plugins > Free Search/u, 'where to configure')
    for (const envName of ['TAVILY_API_KEY', 'EXA_API_KEY', 'ANYSEARCH_API_KEY']) {
      assert.equal(result.content.includes(envName), true, `the guidance must name the ${envName} fallback`)
    }
    assert.match(result.content, /Any one key is enough/u)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('tool execution smoke (fakes): free_search_advanced runs the chain; free_search_test reports per engine', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { exaApiKey: 'exa-1', anysearchApiKey: 'as-1', cache: false })
    globalThis.fetch = fakeFetch([
      ['https://api.exa.ai/', jsonResponse(EXA_JSON)],
      ['https://api.anysearch.com/', jsonResponse(ANYSEARCH_ERR_JSON)],
    ])
    const advanced = registered.tools.find((tool) => tool.name === 'free_search_advanced')
    const advancedResult = await advanced.execute({ query: 'deepseek harness', timeRange: 'week', maxResults: 2 })
    assert.equal(advancedResult.provider, 'exa')
    assert.equal(advancedResult.sources.length, 2)
    assert.equal(advancedResult.sources[0].url.startsWith('https://result.example/'), true)

    const test = registered.tools.find((tool) => tool.name === 'free_search_test')
    const testResult = await test.execute({ engines: ['exa', 'anysearch'] })
    assert.equal(testResult.results.length, 2)
    assert.equal(testResult.results.find((r) => r.engine === 'exa').status, 'ok')
    const anysearch = testResult.results.find((r) => r.engine === 'anysearch')
    assert.equal(anysearch.status, 'fail')
    assert.match(anysearch.error, /AnySearch API error \(code 1001\)/u)
    // default engines = the whole three-engine chain (keyed engines without
    // keys fail readably — the keyed-only behavior through the tool face)
    const defaultResult = await test.execute({})
    assert.deepEqual(defaultResult.results.map((r) => r.engine), ['tavily', 'exa', 'anysearch'])
    assert.match(defaultResult.results.find((r) => r.engine === 'tavily').error, /requires TAVILY_API_KEY/u)
    const blocks = advanced.finalizeContent({}, { content: 'text' })
    assert.deepEqual(blocks, [{ type: 'text', text: 'text' }])
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
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
  assert.ok(new Set(referenced).has('signupRows'), 'the 0.4.183 signup guide rows must stay referenced and defined')
})

test('system prompt engine list: env-configured keys count — same resolution path and priority as the chain', async () => {
  // 评审 P2-2 回归钉：refreshPrompt 曾只看设置值，漏掉链路 resolveApiKey
  // 的环境变量回退，env 配 key 时提示词谎报「无 keyed 引擎」。三键制下同
  // 一条 resolveApiKeyValue 覆盖三个键。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const snapshot = KEY_ENV_NAMES.map((name) => [name, process.env[name]])
  try {
    for (const [name] of snapshot) delete process.env[name]
    // 1. settings 无 key、仅 env 配 TAVILY_API_KEY：提示词必须列 tavily。
    process.env.TAVILY_API_KEY = 'tvly-env'
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { cache: false })
      assert.equal(registered.promptSections.length, 1)
      assert.match(registered.promptSections[0].text, /Currently keyed engines: tavily\b/u)
      assert.doesNotMatch(registered.promptSections[0].text, /Currently keyed engines: none/u)
    }
    // 1b. env 再加 ANYSEARCH_API_KEY：提示词与链同序列出两引擎。
    process.env.ANYSEARCH_API_KEY = 'as-env'
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { cache: false })
      assert.match(registered.promptSections[0].text, /Currently keyed engines: tavily, anysearch\b/u)
    }
    // 2. 设置值与 env 同时存在：优先级与链一致（设置值 > env）——链发出的
    //    请求必须携带设置值 key，提示词与链同源。
    {
      const { ctx, registered } = makeFakeCtx()
      plugin.apply(ctx, { tavilyApiKey: 'tvly-settings', cache: false })
      assert.match(registered.promptSections[0].text, /Currently keyed engines: tavily, anysearch\b/u)
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
    for (const [name, value] of snapshot) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    globalThis.fetch = originalFetch
    rmSync(staging, { recursive: true, force: true })
  }
})

test('provider.search with an already-aborted signal: no fetch is issued and the abort resolves readably', async () => {
  // 评审 P3 回归钉（0.4.183 上移版）：fetchHtml 移除后，已取消 signal 的
  // 预检由 runEngineChain 承担——预检缺失时最坏带一个引擎的完整超时。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { tavilyApiKey: 'tvly-test', cache: false })
    let fetchCalls = 0
    globalThis.fetch = async () => { fetchCalls += 1; return jsonResponse(TAVILY_JSON) }
    const controller = new AbortController()
    controller.abort()
    const result = await registered.providers[0].search({ query: 'deepseek harness', maxResults: 5 }, controller.signal)
    assert.equal(fetchCalls, 0, 'an already-aborted signal must never reach fetch')
    assert.deepEqual(result.sources, [])
    assert.equal(result.truncated, false)
    assert.match(result.content, /search aborted/u, 'the readable outcome must say the search was aborted')
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('a whole chain of true 0-results reads as “nothing matched”, not as an engine outage', async () => {
  // 评审 P3 回归钉：全部引擎真无结果时，总结句不得再宣称「搜索暂不可用」
  // （per-engine 条目已带 returned 0 results 字样）。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { exaApiKey: 'exa-1', anysearchApiKey: 'as-1', cache: false })
    globalThis.fetch = fakeFetch([
      ['https://api.exa.ai/', jsonResponse(JSON.stringify({ results: [] }))],
      ['https://api.anysearch.com/', jsonResponse(JSON.stringify({ code: 0, data: { results: [] } }))],
    ])
    const result = await registered.providers[0].search({ query: 'obscure query with no matches', maxResults: 5 })
    assert.deepEqual(result.sources, [])
    assert.match(result.content, /returned 0 results for this query/u)
    assert.match(result.content, /nothing matched/u)
    assert.doesNotMatch(result.content, /temporarily unavailable/u)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('bridge smoke: raw-search is loopback-guarded, POST-only, and answers through the provider', async () => {
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { exaApiKey: 'exa-1', cache: false })
    globalThis.fetch = fakeFetch([['https://api.exa.ai/', jsonResponse(EXA_JSON)]])
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
      assert.equal(res.state.body.value.provider, 'exa')
      assert.equal(res.state.body.value.sources.length, 2)
    }
    // engine param outside the company chain is rejected with the chain spelled out
    {
      const res = makeRes()
      await rawSearch.handler(makeReq('127.0.0.1', {}, { query: 'x', engine: 'keenable' }), res)
      assert.equal(res.state.status, 200)
      assert.equal(res.state.body.ok, false)
      assert.equal(res.state.body.code, 'engine-rejected')
      assert.match(res.state.body.message, /tavily, exa, anysearch/u)
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('engine test bound: a hanging endpoint fails readably at the 15s bound for every chain engine (review P2)', async (t) => {
  // fs-183 评审 P2 回归钉：runEngineTest 此前不向 dispatchEngine 传 signal
  // ——链路 provider.search 有 runEngineChain 预算超时兑底，引擎直测路径没有，
  // 而 exa/anysearch 的 fetch 无 signal 即无上界，挂起的端点会把测试工具整个
  // 挂死。AbortSignal.timeout 是原生定时器，node:test 的 fake timers 驱动不
  // 了它——这里打桩捕获时长（断言 15s 上界），abort 由 fake 全局 setTimeout
  // 触发，假 fetch 永不自行返回、只在请求 signal abort 时拒绝（真实 fetch
  // 语义）。timeout 选项兑底：修复缺失时测试快速失败而非挂死套件。
  const { plugin, staging } = await importPluginWithStubs()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requestedMs = []
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    requestedMs.push(ms)
    const controller = new AbortController()
    setTimeout(
      () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      ms,
    )
    return controller.signal
  })
  const originalFetch = globalThis.fetch
  const restoreEnv = isolateKeyEnv()
  try {
    const { ctx, registered } = makeFakeCtx()
    plugin.apply(ctx, { tavilyApiKey: 'tvly-1', exaApiKey: 'exa-1', anysearchApiKey: 'as-1', cache: false })
    let sawSignal = null
    globalThis.fetch = (url, init) => {
      sawSignal = init?.signal ?? null
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    const testTool = registered.tools.find((tool) => tool.name === 'free_search_test')
    for (const engine of ['exa', 'anysearch', 'tavily']) {
      let settled = false
      sawSignal = null
      requestedMs.length = 0
      // 发起引擎测试：dispatchEngine 内有 await resolveApiKey 的微任务跳跃，
      // await null 排干队列后 fetch 才真正发出（signal 那时还未取消）。
      const pending = testTool.execute({ engines: [engine] }).then((r) => { settled = true; return r })
      await null
      const carriedSignal = sawSignal
      t.mock.timers.tick(14999)
      assert.equal(settled, false, `${engine}: before the 15s bound the hanging engine test must not have settled`)
      t.mock.timers.tick(1)
      const result = await pending
      assert.equal(settled, true, `${engine}: the 15s bound must fail the test`)
      assert.deepEqual(requestedMs, [15000], `${engine}: runEngineTest must bound the dispatch with AbortSignal.timeout(15000)`)
      assert.notEqual(carriedSignal, null, `${engine}: the engine fetch must carry the timeout signal`)
      assert.equal(carriedSignal.aborted, true, `${engine}: the timeout signal must be the thing that fired`)
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0].engine, engine)
      assert.equal(result.results[0].status, 'fail')
      assert.match(result.results[0].error, new RegExp(`${engine} engine test timed out after 15s`, 'u'), 'a readable timeout, not a raw DOMException message')
    }
  } finally {
    globalThis.fetch = originalFetch
    restoreEnv()
    rmSync(staging, { recursive: true, force: true })
  }
})

test('result-count caps: exa numResults and anysearch max_results clamp to 20 in the request body, like tavily (review P3)', async () => {
  // fs-183 评审 P3 回归钉：失控的 maxResults 不得借引擎请求一次烧光免费
  // 额度——三个引擎的请求体统一钳到上界 20（tavily 原有，exa/anysearch
  // 评审补齐）；调用方自身的更小预算原样透传。
  const { plugin, staging } = await importPluginWithStubs()
  const originalFetch = globalThis.fetch
  try {
    const bodies = {}
    globalThis.fetch = async (url, init) => {
      const target = String(url)
      const key = target.startsWith('https://api.tavily.com/') ? 'tavily'
        : target.startsWith('https://api.exa.ai/') ? 'exa'
          : target.startsWith('https://api.anysearch.com/') ? 'anysearch'
            : null
      if (key === null) throw new TypeError(`fake fetch: no route for ${target}`)
      bodies[key] = JSON.parse(init.body)
      return jsonResponse(key === 'tavily' ? TAVILY_JSON : key === 'exa' ? EXA_JSON : ANYSEARCH_JSON)
    }
    // 失控的 100：三个引擎的请求体都钳到 20
    await plugin.searchExa('query', 100, 'exa-key', undefined, undefined)
    await plugin.searchAnysearch('query', 100, 'as-key', undefined)
    await plugin.searchTavily('query', 100, 'tvly-key', undefined, undefined)
    assert.equal(bodies.exa.numResults, 20)
    assert.equal(bodies.anysearch.max_results, 20)
    assert.equal(bodies.tavily.max_results, 20)
    // 正常量级原样透传（不因上界而缩水）
    await plugin.searchExa('query', 5, 'exa-key', undefined, undefined)
    await plugin.searchAnysearch('query', 3, 'as-key', undefined)
    await plugin.searchTavily('query', 7, 'tvly-key', undefined, undefined)
    assert.equal(bodies.exa.numResults, 5)
    assert.equal(bodies.anysearch.max_results, 3)
    assert.equal(bodies.tavily.max_results, 7)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(staging, { recursive: true, force: true })
  }
})
