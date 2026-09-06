/**
 * dsh-free-search — company-hardened build (upstream DDDMUC/dsh-free-search
 * v0.4.18, commit 36c6446211cd2a759cf59de87a1ba6a893c34ebd, MIT).
 *
 * Hardened delta over upstream (see README-hardened.zh.md for the full strip
 * list and the review trail):
 *   - Engine chain is reviewed policy, not preference: tavily → exa →
 *     anysearch, and since 0.4.183 every member is keyed-only (纯三键制).
 *     The keyless bing/ddg scrapers are removed — bing's scraped quality was
 *     unusable and ddg is blocked on the company network; the company
 *     posture is self-registered free quotas, never free scraping. Zero
 *     keys no longer silently run a keyless chain: search returns readable
 *     setup guidance (free tiers, signup portals, where to configure).
 *     AnySearch returns here as a keyed REST engine (upstream's variant was
 *     stripped with the other extra engines; this is the company
 *     integration). Upstream's remaining engines (ddg-lite/searxng/keenable/
 *     perplexity/deepseek-official, plus the keyless MCP/anonymous variants
 *     of exa/tavily) are removed, and so is the `provider`
 *     (preferred-engine) setting — selection is not user choice.
 *   - The self-update path is gone: no npm-registry version probe, no
 *     `pnpm add dsh-free-search@latest` exec, no check-update/update bridge
 *     routes, no client update UI. Updates arrive only through the company
 *     catalog channel that installed this package.
 *   - The credentials-center integration is gone: keys live in this plugin's
 *     own settings section (settings.yaml under the `free-search` namespace)
 *     with a plain environment-variable fallback. No `ctx.get("credentials")`
 *     access remains (un-injected service access throws on the Cordis proxy).
 *   - platform_search and its eight platform APIs are removed (outside the
 *     reviewed source scope).
 *   - The engine fallback walk (runEngineChain, lib/engines.js) never throws:
 *     per-engine try/catch, degrade to the next engine, readable text when
 *     the whole chain fails.
 *
 * Kept from upstream verbatim (bar the listed cuts): the keyed engine
 * implementations, the result cache, the settings bridge shape, the loopback
 * guard, and the `installSettingsSection` wiring (v0.4.18 is the last
 * upstream line using the exported function; v0.4.19+ moved to the
 * 0.1.2-alpha `sctx.settings.installSection` API, which the pinned
 * 0.1.1-rc.2 runtime does not provide).
 */

import { SettingsConflictError, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import {
  ALL_ENGINES,
  ZERO_RESULTS_ERROR,
  approximateTimeRange,
  isoDaysAgo,
  parseTimeRange,
  resolveEngineChain,
  runEngineChain,
} from "./engines.js";

const TAVILY_URL = "https://api.tavily.com/search";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const ANYSEARCH_URL = "https://api.anysearch.com/v1/search";

/**
 * 单引擎请求超时上界（ms）：tavily 的内部 AbortController 计时器与引擎
 * 测试路径（runEngineTest）共用。链路 provider.search 另有 runEngineChain
 * 的 CHAIN_BUDGET_MS 兜底；引擎直测路径没有那层兜底，靠 runEngineTest
 * 挂的 AbortSignal.timeout 封顶（评审 P2：exa/anysearch 的 fetch 无
 * signal 即无上界，挂起的端点会把测试工具整个挂死）。
 */
const ENGINE_REQUEST_TIMEOUT_MS = 15000;

/**
 * 单请求结果数上界（评审 P3）：三个引擎的请求体统一钳到该值——失控的
 * maxResults 不得借引擎请求一次烧光免费额度；调用方自身的更小预算
 * （bridge/advanced 钳 10、引擎测试用 2）照常生效。
 */
const MAX_RESULTS_CAP = 20;

/**
 * The registry id of the one provider this plugin registers. It is a
 * registry key, not an engine choice — the chain order is plugin policy.
 * Neutral on purpose (0.4.183: the old "ddg" id outlived its engine): it
 * names the plugin, matching the settings namespace and the tool prefix.
 * cordis.patch.yml re-pins `web.searchProvider` to exactly this value —
 * change them together.
 */
const PROVIDER_ID = "free-search";

/**
 * Zero-key guidance (0.4.183): with no engine key configured at all the
 * chain is empty — answer with the free tiers, the signup portals, and where
 * to configure, instead of a silent empty-chain failure.
 */
const NO_KEY_GUIDANCE = [
  "free-search: no engine keys are configured, so the company chain (tavily -> exa -> anysearch) has no members - since 0.4.183 every engine is keyed-only and the keyless bing/ddg engines are removed.",
  "Tell the user web search needs a one-time free key setup, then offer these self-registered free tiers (Settings > Plugins > Free Search, or the matching environment variable):",
  "- tavily - free tier 1,000 searches/month, no credit card: register at https://tavily.com (configure tavilyApiKey or set TAVILY_API_KEY)",
  "- exa - $20 signup credit plus $10/month free (about 1,400 searches/month): register at https://exa.ai (configure exaApiKey or set EXA_API_KEY)",
  "- anysearch - free 1,000 searches/day: register at https://anysearch.com (configure anysearchApiKey or set ANYSEARCH_API_KEY)",
  "Any one key is enough to search; each additional key adds automatic fallback.",
].join("\n");

const FREE_SEARCH_NS = settingsNamespace("free-search");
const BRIDGE_PREFIX = "/api/dsh-free-search-settings";

//#region 结果缓存（防限流/省额度，LRU 50 条，TTL 可配置 0-5 分钟；上游 v0.4.18 原样收编）
const CACHE_MAX_ENTRIES = 50;

function buildCacheKey(query, maxResults, timeRangeLabel) {
  return [query ?? "", maxResults ?? 5, timeRangeLabel ?? ""].join("\u0000");
}
//#endregion

// 统一的 snippet 清洗：剔除登录/付费墙/订阅等噪音短语，折叠空白，限制长度（上游原样收编）。
const SNIPPET_NOISE =
  /\b(sign up|sign in|log in|login|subscribe( to| for)?|member[- ]?only|become a member|create (a )?free account|read more|continue reading|story continues|get started|install (the )?app|view on|medium membership|join \w+ for free|get updates from this writer|stories in your inbox|remember me for|unlock this|free to read|become a patron)\b/gi;

function cleanSnippet(text) {
  if (!text) return text;
  return String(text)
    .replace(SNIPPET_NOISE, " ")
    .replace(/^\s*(#{1,6}\s*|\[\s*x?\s*\]\s*|-\s*\[\s*x?\s*\]\s*|>\s*)/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function uniqueSources(sources, limit) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      out.push(s);
    }
    if (out.length >= limit) break;
  }
  return out;
}

// Exa：账号档 REST（key 必需）。上游的无 key MCP 匿名端点已按源口径剥离。
async function searchExa(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Exa search requires EXA_API_KEY (configured in Settings > Plugins > Free Search)");
  const body = {
    query,
    type: "auto",
    contents: { highlights: { highlightsPerUrl: 1 } },
    // 评审 P3：numResults 与 tavily 同口径钳到上界
    ...(maxResults !== undefined ? { numResults: Math.min(maxResults, MAX_RESULTS_CAP) } : {}),
  };
  // Exa 时间过滤：startPublishedDate（ISO 日期；支持任意天数和绝对日期）
  if (timeRange) {
    if (timeRange.after) body.startPublishedDate = timeRange.after;
    else if (timeRange.days !== undefined) body.startPublishedDate = isoDaysAgo(timeRange.days);
  }
  const response = await fetch(EXA_SEARCH_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "deepseek-harness/free-search",
    },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Exa API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Exa API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .map((result) => {
      const snippet = result.highlights?.find((h) => h.trim().length > 0);
      if (!snippet) return null;
      return {
        url: result.url,
        ...(result.title ? { title: result.title } : {}),
        snippet,
        ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
      };
    })
    .filter(Boolean);
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// Tavily：账号档（key 必需，Bearer）。上游的无 key 匿名额度（x-tavily-access-mode）
// 已按源口径剥离——公司口径里 tavily 只在配 key 时入链。
async function searchTavily(query, maxResults, apiKey, timeRange, signal) {
  if (!apiKey) throw new Error("Tavily search requires TAVILY_API_KEY (configured in Settings > Plugins > Free Search)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENGINE_REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  let response;
  try {
    const body = {
      query,
      max_results: Math.min(maxResults ?? 5, MAX_RESULTS_CAP),
      search_depth: "basic",
    };
    // Tavily 时间过滤：time_range 只支持固定档，自定义天数取最近似档位
    if (timeRange) {
      const tr = approximateTimeRange(timeRange.days ?? 7);
      if (tr) body.time_range = tr;
    }
    response = await fetch(TAVILY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Tavily request failed: ${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Tavily API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`Tavily API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.content ? { snippet: String(r.content).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

// AnySearch：keyed REST（0.4.183 入链，纯三键制的末位引擎）。POST
// /v1/search，Bearer 鉴权，最小请求面 {query, max_results}（domain/zone
// 等可选参数不收编）。响应 code===0 → data.results[]（title/url/snippet
// 实测形态，另备 content 字段兼容）；code!==0 → 可读错误。
async function searchAnysearch(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error("AnySearch search requires ANYSEARCH_API_KEY (configured in Settings > Plugins > Free Search)");
  const response = await fetch(ANYSEARCH_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      query,
      // 评审 P3：max_results 与 tavily 同口径钳到上界
      ...(maxResults !== undefined ? { max_results: Math.min(maxResults, MAX_RESULTS_CAP) } : {}),
    }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("AnySearch API key is invalid (HTTP 401) - update it in Settings > Plugins > Free Search");
    }
    throw new Error(`AnySearch API error (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`AnySearch API error (code ${String(data.code)}): ${String(data.message ?? data.msg ?? "unknown error").slice(0, 200)}`);
  }
  const sources = (data.data?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      ...(r.title ? { title: String(r.title) } : {}),
      // snippet 为实测形态；content 字段作为兼容回退
      ...(r.snippet ? { snippet: String(r.snippet).slice(0, 300) } : r.content ? { snippet: String(r.content).slice(0, 300) } : {}),
    }));
  return { sources: uniqueSources(sources, maxResults ?? 10), truncated: false };
}

//#region bridge（上游 v0.4.18 原样收编；check-update / update / credentials-* 路由已剥离）
const MAX_JSON_BODY_BYTES = 64 * 1024;

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function toView(descriptor) {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
    ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
    ...(descriptor.secrets === undefined
      ? {}
      : { secrets: descriptor.secrets.map((secret) => ({ path: [...secret.path], set: secret.set })) }),
    revision: descriptor.revision,
  };
}

function makeBridgeRoutes(settings, search, testEngine) {
  const allowlisted = () =>
    settings
      .describe({ redactSecrets: true })
      .filter((descriptor) => String(descriptor.ns) === FREE_SEARCH_NS)
      .map((descriptor) => String(descriptor.ns));

  const handlers = {
    async rawSearch(request) {
      if (request === null || typeof request !== "object" || typeof request.query !== "string" || request.query.length === 0) {
        return { ok: false, code: "search-rejected", message: "malformed bridge search request (query is required)" };
      }
      const maxResults = Math.min(Math.max(Number(request.maxResults) || 5, 1), 10);
      const timeRange = parseTimeRange(request.timeRange);
      // 指定 engine：直测该引擎本身（不走回退链），报告它自己的可用性。
      // 收编后仅接受链内三引擎（上游的十引擎枚举随引擎剥离一起收敛）。
      if (typeof request.engine === "string" && request.engine.length > 0) {
        if (!ALL_ENGINES.includes(request.engine)) {
          return { ok: false, code: "engine-rejected", message: `unknown engine "${request.engine}" - the company chain is: ${ALL_ENGINES.join(", ")}` };
        }
        if (typeof testEngine !== "function") {
          return { ok: false, code: "search-unavailable", message: "engine test is not wired" };
        }
        try {
          const result = await testEngine(request.engine, request.query, timeRange);
          if (result.ok === false) {
            return { ok: false, code: "engine-failed", message: result.error ?? `${request.engine} failed` };
          }
          return {
            ok: true,
            value: {
              provider: request.engine,
              sources: result.sources ?? [],
              content: result.content ?? "",
            },
          };
        } catch (error) {
          return { ok: false, code: "engine-failed", message: error instanceof Error ? error.message : String(error) };
        }
      }
      if (typeof search !== "function") {
        return { ok: false, code: "search-unavailable", message: "search provider is not wired" };
      }
      try {
        const result = await search({ ...request, maxResults, timeRange });
        return {
          ok: true,
          value: {
            provider: result.provider ?? "chain",
            sources: result.sources ?? [],
            content: result.content ?? "",
            cache: result._cache === "hit" ? "hit" : "miss",
          },
        };
      } catch (error) {
        return { ok: false, code: "search-failed", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async describe() {
      const descriptors = settings.describe({ redactSecrets: true });
      return {
        ok: true,
        value: {
          namespaces: allowlisted()
            .map((ns) => descriptors.find((descriptor) => String(descriptor.ns) === ns))
            .filter((descriptor) => descriptor !== undefined)
            .map(toView),
          writable: settings.writable !== false,
        },
      };
    },
    async mutate(request) {
      const body = request;
      if (body === null || typeof body !== "object" || typeof body.ns !== "string" || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      const { ns } = body;
      if (!allowlisted().includes(ns)) {
        return { ok: false, code: "settings-not-exposed", message: `settings namespace "${ns}" is not exposed` };
      }
      const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
      try {
        await settings.mutate(settingsNamespace(ns), body.ops, expectedRevision);
      } catch (error) {
        if (error instanceof SettingsConflictError) {
          return { ok: false, code: "settings-conflict", message: error.message };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, code: "internal", message };
      }
      const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === ns);
      if (descriptor === undefined) {
        return { ok: false, code: "internal", message: `settings namespace "${ns}" was disposed after the mutate` };
      }
      return { ok: true, value: toView(descriptor) };
    },
  };

  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "loopback requests only" });
      return false;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
      return false;
    }
    return true;
  };

  return [
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        writeJson(res, 200, await handlers.describe());
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "settings-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.mutate(body));
      },
    },
    {
      kind: "exact",
      path: `${BRIDGE_PREFIX}/raw-search`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        const body = await readJsonBody(req);
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: "search-rejected", message: "malformed JSON body" });
          return;
        }
        writeJson(res, 200, await handlers.rawSearch(body));
      },
    },
  ];
}
//#endregion

const name = "web-search-free";
const inject = ["web"];

// 收编后的设置面：引擎链是公司口径（无 provider 选择）；key 只经本插件
// 设置节（settings.yaml 的 free-search 命名空间）+ 环境变量回退。0.4.183
// 起三键制：tavilyApiKey / exaApiKey / anysearchApiKey，三者均 role("secret")。
const Config = z.object({
  cache: z.boolean().default(true), // 单 query 结果缓存开关（防限流/省额度）
  cacheTtl: z.number().default(5), // 缓存时长（分钟），0-5 可配置（使用处再 clamp）
  lang: z.string().default("zh"), // 设置卡片界面语言（zh/en）
  tavilyApiKey: z.string().role("secret"),
  exaApiKey: z.string().role("secret"),
  anysearchApiKey: z.string().role("secret"),
});

function apply(ctx, config) {
  let current = () => config ?? {};
  const logger = ctx.logger;

  // 系统提示词动态刷新：设置变更时重新生成，避免显示旧内容
  let refreshPrompt = null;

  // 单 query 结果缓存（provider.search 内闭包持有）：LRU 50 条 / TTL 可配置
  const searchCache = new Map(); // key -> { value, expiresAt }

  // key 解析：本插件设置节 > 环境变量。凭据中心路径已剥离——未 inject 的
  // 服务在 Cordis proxy 上 get 即抛（?. 救不了），这里不再触碰任何 ctx.get。
  // 同步核心 resolveApiKeyValue 供链调用（resolveApiKey）与系统提示词
  // （refreshPrompt）共用：同一条优先级，提示词永远不谎报 keyed 引擎
  // （评审 P2-2：env 配 key 时不得宣称「无 keyed 引擎」）。
  const resolveApiKeyValue = (envName, settingsKey) => {
    const cfg = current();
    if (settingsKey && cfg[settingsKey]) return cfg[settingsKey];
    return process.env[envName] ?? "";
  };
  const resolveApiKey = async (envName, settingsKey) => resolveApiKeyValue(envName, settingsKey);

  // 分发到链内三引擎的具体实现（时间过滤随引擎能力：tavily/exa 精确、
  // anysearch 忽略）。
  const dispatchEngine = async (engine, query, maxResults, cfg, timeRange, signal) => {
    if (engine === "exa") return searchExa(query, maxResults, await resolveApiKey("EXA_API_KEY", "exaApiKey"), timeRange, signal);
    if (engine === "tavily") return searchTavily(query, maxResults, await resolveApiKey("TAVILY_API_KEY", "tavilyApiKey"), timeRange, signal);
    if (engine === "anysearch") return searchAnysearch(query, maxResults, await resolveApiKey("ANYSEARCH_API_KEY", "anysearchApiKey"), signal);
    throw new Error(`unknown engine "${engine}" - the company chain is: ${ALL_ENGINES.join(", ")}`);
  };

  // 总控 provider：公司链 tavily→exa→anysearch（纯三键制，0.4.183）。任何
  // 引擎失败（缺 key / 401 / 限流 / 网络 / 0 结果）自动降级到下一引擎；一个
  // key 都没有时链为空，返回配置引导文案；全链失败返回可读文本，绝不向
  // 调用方抛顶层异常（单进程 harness 的容错红线）。
  const provider = {
    id: PROVIDER_ID,
    available() {
      return true;
    },
    async search(request, signal) {
      // 公共咽喉校验：web_search / free_search_advanced / raw-search 三条路径都经过这里
      if (request === null || typeof request !== "object" || typeof request.query !== "string" || request.query.trim().length === 0) {
        throw new Error("query is required");
      }
      const cfg = current();
      const timeRange = parseTimeRange(request.timeRange);
      const timeRangeLabel = typeof request.timeRange === "string" ? request.timeRange : String(timeRange?.days ?? timeRange?.after ?? "");

      // 三键制核心：链 = 配了 key 的引擎。一个 key 都没有 → 不进缓存、不
      // 发请求，直接返回配置引导（免费额度 + 注册入口 + 配置位置）。
      const chain = resolveEngineChain({
        tavilyKey: await resolveApiKey("TAVILY_API_KEY", "tavilyApiKey"),
        exaKey: await resolveApiKey("EXA_API_KEY", "exaApiKey"),
        anysearchKey: await resolveApiKey("ANYSEARCH_API_KEY", "anysearchApiKey"),
      });
      if (chain.length === 0) {
        if (signal?.aborted) throw new Error("search aborted");
        logger.warn("free-search: no engine keys configured - answering with setup guidance instead of running an empty chain");
        return { sources: [], truncated: false, content: NO_KEY_GUIDANCE };
      }

      // 缓存 TTL（分钟，0-5 可配置）；cache=false 或 ttl<=0 时完全禁用
      const cacheTtlMs = (Math.min(Math.max(Number(cfg.cacheTtl) ?? 5, 0), 5)) * 60 * 1000;
      const cacheEnabled = cfg.cache !== false && cacheTtlMs > 0;
      const cacheKey = cacheEnabled
        ? buildCacheKey(request.query, request.maxResults, timeRangeLabel)
        : null;
      if (cacheKey !== null) {
        const hit = searchCache.get(cacheKey);
        if (hit && hit.expiresAt > Date.now()) {
          if (signal?.aborted) throw new Error("search aborted");
          searchCache.delete(cacheKey);
          searchCache.set(cacheKey, hit);
          // 浅拷贝 + 私有标记：sources 数组也复制一层，彻底隔离缓存对象
          return { ...hit.value, sources: hit.value.sources?.slice(), _cache: "hit" };
        }
        if (hit) searchCache.delete(cacheKey);
      }

      const outcome = await runEngineChain({
        chain,
        signal,
        runEngine: (engine, effectiveSignal) =>
          dispatchEngine(engine, request.query, request.maxResults, cfg, timeRange, effectiveSignal),
      });

      if (outcome.ok) {
        const { engine, result, failures } = outcome;
        // 统一清洗 snippet：去登录/付费墙/订阅噪音，折叠空白（有值的才处理）
        result.sources = result.sources.map((s) =>
          s.snippet ? { ...s, snippet: cleanSnippet(s.snippet) } : s
        );
        // 链头引擎失败后降级成功：结果里附上准确提示（agent 可读出实际引擎）
        if (engine !== chain[0]) {
          const firstFailure = failures[0];
          result.content = firstFailure
            ? `Note: ${firstFailure.engine} unavailable or failed (${firstFailure.error}), using ${engine}.`
            : `Note: using ${engine}.`;
        }
        const cached = { ...result, provider: engine, engine };
        if (cacheKey !== null) {
          // 回退条目（实际引擎≠链头）用配置 TTL 的 1/5，链头成功保持完整 TTL
          const entryTtlMs = engine !== chain[0] ? Math.max(cacheTtlMs / 5, 1000) : cacheTtlMs;
          searchCache.set(cacheKey, {
            value: cached,
            expiresAt: Date.now() + entryTtlMs,
          });
          if (searchCache.size > CACHE_MAX_ENTRIES) {
            const oldest = searchCache.keys().next().value;
            if (oldest !== undefined) searchCache.delete(oldest);
          }
        }
        return { ...cached, _cache: "miss" };
      }

      // 全链失败：可读文本，不抛（单进程 harness 容错红线）。全部引擎都是
      // 「真 0 结果」时不是引擎故障——总结句换措辞，指引 agent 告知用户
      // 无匹配、建议改写查询，而非宣称搜索不可用（per-engine 条目本就带
      // returned 0 results 字样，与连接错误可区分；评审 P3）。
      const summary = outcome.failures.map((f) => `${f.engine}: ${f.error}`).join("; ").slice(0, 500);
      const allZeroResults = outcome.failures.length > 0
        && outcome.failures.every((f) => f.error.includes(ZERO_RESULTS_ERROR));
      logger.warn(`free-search: the whole engine chain ${allZeroResults ? "returned 0 results" : "failed"} (${summary})`);
      return {
        sources: [],
        truncated: false,
        content: allZeroResults
          ? `free-search: every engine in the company chain (${chain.join(" -> ")}) ran but returned 0 results for this query — the engines are healthy, nothing matched. Tell the user the search found no results and suggest a broader or rephrased query; do not claim web search is unavailable. Engines: ${summary}`
          : `free-search: every engine in the company chain (${chain.join(" -> ")}) failed. Tell the user web search is temporarily unavailable rather than retrying immediately. Failures: ${summary}`,
      };
    },
  };

  installSettingsSection(ctx, FREE_SEARCH_NS, Config, config ?? {}, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
      // settings 变更时刷新系统提示词
      if (typeof refreshPrompt === "function") refreshPrompt();
    },
  });

  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      const disposers = makeBridgeRoutes(
        sctx.settings,
        (request) => provider.search(request, undefined),
        (engine, query, timeRange) => runEngineTest(engine, query, timeRange)
      ).map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "free-search: settings bridge");
  });

  ctx.web.registerSearchProvider(provider);

  // 运行时兜底：profile patch 的 config 会整体覆盖 bundle patch 的 config，
  // 用户的 `- id: web` patch 可能抹掉 searchProvider。这里在 provider 注册后
  // 检查：未指向任何 provider（undefined）时自动接管为本插件；显式配置了
  // 其他 provider 则不动（与官方 web 插件共存的让位规则）。
  if (!ctx.web.searchProviderId) {
    ctx.web.searchProviderId = provider.id;
    logger.info(`free-search: web.searchProvider was unset (patch override or missing config), taking over as "${provider.id}"`);
  }

  // 测试工具：让 agent 逐个测试链内引擎，报告可用性
  const runEngineTest = async (engine, query, timeRange) => {
    const cfg = current();
    const q = query || "DeepSeek Harness";
    const tr = parseTimeRange(timeRange);
    // 评审 P2：引擎直测必须有界——provider.search 走 runEngineChain 的预算
    // 超时，这条路径此前不传 signal，而 exa/anysearch 的 fetch 无 signal 即
    // 无上界。挂 15s 超时 signal；触发时统一转可读失败，不直传底层
    // DOMException 文案。
    const signal = AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS);
    try {
      if (!ALL_ENGINES.includes(engine)) return { ok: false, error: `unknown engine: ${engine}` };
      const result = await dispatchEngine(engine, q, 2, cfg, tr, signal);
      return {
        ok: true,
        sources: (result.sources ?? []).map((s) =>
          s.snippet ? { ...s, snippet: cleanSnippet(s.snippet) } : s
        ),
        truncated: result.truncated ?? false,
      };
    } catch (error) {
      // 该 signal 唯一的 abort 来源就是上面的超时——触发即报告可读的超时失败
      if (signal.aborted) {
        return { ok: false, error: `${engine} engine test timed out after ${ENGINE_REQUEST_TIMEOUT_MS / 1000}s (endpoint unreachable or hanging)` };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  // 引擎测试工具（撞名防御：所有注册工具统一带 free_search_ 前缀）。
  // 参数经 defineTool 的 ParameterSchemaSpec（per-property map）投影为完整
  // JSON Schema（顶层 type:'object'）——钉住的 0.1.1-rc.2 dsh-tools 语义，
  // 工具注册面不直接向 provider 暴露裸 map。
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "free_search_test",
          description:
            "Test every engine in the company search chain (tavily, exa, anysearch) and report which ones work. Use this to verify engine availability, diagnose search failures, or check whether an API key is configured. Every engine is keyed-only since 0.4.183 — an engine fails here when its free API key is missing or invalid.",
          parameters: {
            engines: {
              type: "array",
              description: "Which engines to test (default: all three). Options: tavily, exa, anysearch.",
              items: { type: "string" },
            },
            query: {
              type: "string",
              description: "Optional search query to use for the test (default: 'DeepSeek Harness').",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      engine: { type: "string" },
                      status: { type: "string" },
                      results: { type: "number" },
                      error: { type: "string" },
                      sampleTitle: { type: "string" },
                      sampleUrl: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.results.map((r) => {
                if (r.status === "ok") {
                  return `- ${r.engine}: OK (${r.results} results${r.sampleTitle ? `, e.g. "${r.sampleTitle.slice(0, 40)}"` : ""})`;
                }
                return `- ${r.engine}: FAIL - ${r.error}`;
              });
              return `Search engine test:\n${lines.join("\n")}`;
            },
          },
          async execute(args) {
            const engines = args.engines && args.engines.length > 0 ? args.engines : ALL_ENGINES;
            const results = [];
            for (const engine of engines) {
              const r = await runEngineTest(engine, args.query);
              if (r.ok) {
                const item = {
                  engine,
                  status: "ok",
                  results: r.sources.length,
                };
                if (r.sources[0]?.title) item.sampleTitle = String(r.sources[0].title);
                if (r.sources[0]?.url) item.sampleUrl = String(r.sources[0].url);
                results.push(item);
              } else {
                results.push({ engine, status: "fail", error: r.error ?? "unknown error" });
              }
            }
            return { results };
          },
          finalizeContent(exec, result) {
            // 把 render 输出包装成合法的 text block（content 必须是 block 数组）
            const text = result.content;
            if (typeof text === "string" && text.length > 0) {
              return [{ type: "text", text }];
            }
            return undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: test engines tool");
  });

  // 高级搜索工具（上游 advanced_search 收编更名 free_search_advanced）：
  // 支持时间过滤；engine 强制参数已随「链序=公司口径」剥离，仍走统一回退链。
  ctx.inject(["tools"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.tools.register(
        defineTool({
          name: "free_search_advanced",
          description:
            "Search the web with optional time filtering. Use when the user wants results from a specific time window (e.g. 'last week', 'this month'). Runs the company engine chain (tavily -> exa -> anysearch, each engine only while its free key is configured) with automatic fallback, exactly like web_search.",
          parameters: {
            query: {
              type: "string",
              description: "The search query.",
              required: true,
            },
            maxResults: {
              type: "number",
              description: "Optional result count (default 5, max 10).",
            },
            timeRange: {
              type: "string",
              description: "Optional time filter. Fixed tiers: day, week, month, year. Custom: relative like 12h, 3d, 2mo, 1y, or an absolute date like 2026-07-01. Tavily/Exa apply it precisely; anysearch ignores it.",
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                provider: { type: "string" },
                content: { type: "string" },
                sources: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      url: { type: "string" },
                      title: { type: "string" },
                      snippet: { type: "string" },
                      publishedAt: { type: "string" },
                    },
                  },
                },
              },
            },
            render(args, value) {
              const lines = value.sources.map((s) => `- [${s.title ?? s.url}](${s.url})${s.snippet ? ` - ${s.snippet.slice(0, 120)}` : ""}${s.publishedAt ? ` (${s.publishedAt})` : ""}`);
              return `Search (${value.provider}${args.timeRange ? `, timeRange=${args.timeRange}` : ""}):\n${lines.join("\n") || "No results found."}${value.content ? `\n\n${value.content}` : ""}`;
            },
          },
          async execute(args) {
            if (!args.query || !String(args.query).trim()) throw new Error("query is required");
            const request = {
              query: args.query,
              maxResults: Math.min(args.maxResults ?? 5, 10),
            };
            if (parseTimeRange(args.timeRange) !== undefined) request.timeRange = args.timeRange;
            const result = await provider.search(request);
            // lossless JSON 不允许 undefined 字段：按存在的值构造对象，缺字段直接省略
            return {
              provider: result.provider ?? result._provider ?? "chain",
              content: typeof result.content === "string" ? result.content : "",
              sources: (result.sources ?? []).map((s) => {
                const source = {};
                if (s.url !== undefined && s.url !== null && s.url !== "") source.url = s.url;
                if (s.title !== undefined && s.title !== null && s.title !== "") source.title = String(s.title);
                if (s.snippet !== undefined && s.snippet !== null && s.snippet !== "") source.snippet = String(s.snippet);
                if (s.publishedAt !== undefined && s.publishedAt !== null && s.publishedAt !== "") {
                  source.publishedAt = String(s.publishedAt);
                }
                return source;
              }),
            };
          },
          finalizeContent(exec, result) {
            // Tool-result content must be an array of content blocks, not a raw string.
            const text = result.content;
            return typeof text === "string" && text.length > 0 ? [{ type: "text", text }] : undefined;
          },
        })
      );
      return () => {
        dispose();
      };
    }, "free-search: advanced search tool");
  });

  // 让 agent 知道可用搜索引擎（动态生成，随 key/设置变化）
  ctx.inject(["systemPrompt"], (sctx) => {
    let disposeSection = null;
    refreshPrompt = () => {
      if (disposeSection) {
        disposeSection();
        disposeSection = null;
      }
      const cfg = current();
      // 链成员清单与实际链同源：同一 resolveApiKeyValue（设置值 > 环境变量），
      // env 配 key 时提示词照实列出（评审 P2-2）。三键制下链=配了 key 的
      // 引擎子集；一个都没有时链为空，提示词照实说明并给出注册指引。
      const keyed = resolveEngineChain({
        tavilyKey: resolveApiKeyValue("TAVILY_API_KEY", "tavilyApiKey"),
        exaKey: resolveApiKeyValue("EXA_API_KEY", "exaApiKey"),
        anysearchKey: resolveApiKeyValue("ANYSEARCH_API_KEY", "anysearchApiKey"),
      });
      disposeSection = sctx.systemPrompt.section({
        name: "free-search:engines",
        order: 500,
        text: [
          "## Available web search engines (free-search plugin, company chain)",
          "",
          "You have the web_search tool. Its backend is the company engine chain - the order is fixed policy, not a setting.",
          "Chain: tavily -> exa -> anysearch. Since 0.4.183 every engine is keyed-only: an engine joins the chain only while its API key is configured (Settings > Plugins > Free Search, or the TAVILY_API_KEY / EXA_API_KEY / ANYSEARCH_API_KEY environment variables). The keyless bing/ddg engines are removed.",
          `Currently keyed engines: ${keyed.length > 0 ? keyed.join(", ") : "none - web_search answers with setup guidance (free signups: tavily.com 1,000 searches/month, exa.ai $20 signup + $10/month, anysearch.com 1,000 searches/day) until at least one key is configured"}.`,
          "",
          "IMPORTANT: If an engine fails (missing or invalid key, 401, rate limit, or network error), web_search automatically tries the next engine in the chain. The result includes a note showing which engine actually answered and why the earlier one was skipped. If EVERY engine fails you get a readable failure message - tell the user web search is temporarily unavailable instead of retrying immediately. Never claim search is unavailable while the chain still has engines left.",
          "",
          "Use the free_search_test tool to check which engines work right now.",
          "",
          "When the user wants results from a specific time window (e.g. 'last week', 'this month', 'last 3 days'), use the free_search_advanced tool with timeRange. Fixed tiers: day|week|month|year. Custom: 12h, 3d, 2mo, 1y, or an absolute date like 2026-07-01. Tavily/Exa apply it precisely; anysearch ignores it.",
        ].join("\n"),
      });
    };
    sctx.effect(() => {
      refreshPrompt();
      return () => {
        if (disposeSection) disposeSection();
        disposeSection = null;
      };
    }, "free-search: engine list prompt section");
  });
}

export {
  ALL_ENGINES,
  ANYSEARCH_URL,
  Config,
  EXA_SEARCH_URL,
  FREE_SEARCH_NS,
  NO_KEY_GUIDANCE,
  PROVIDER_ID,
  TAVILY_URL,
  apply,
  inject,
  name,
  searchAnysearch,
  searchExa,
  searchTavily,
};
