/**
 * Company-hardened engine chain for dsh-free-search (pure logic, no DSH
 * imports, no network): the chain order is reviewed policy, not user choice —
 *
 *   tavily (only when a key is configured) → exa (only when a key is
 *   configured) → bing (direct, keyless) → ddg (keyless last resort)
 *
 * The module exists so the selection and the fallback walk are unit-testable
 * offline (Discussion #1884 defense: every engine call is wrapped, a failure
 * degrades to the next engine, and total failure returns a readable outcome —
 * the chain executor never throws to its caller).
 *
 * 上游 v0.4.18 同位置逻辑的收编改造：引擎集合收敛为评审钉死的四引擎链，
 * 「首选引擎」（provider 设置 / advanced_search 的 engine 参数）整体剥离——
 * 链序是公司源口径，不是运行时偏好。
 */

/** The reviewed chain order (company source policy, 2026-09-03 定案). */
export const CHAIN_ENGINES = Object.freeze(["tavily", "exa", "bing", "ddg"]);

/** Chain members that participate only when their API key is configured. */
export const KEYED_ENGINES = Object.freeze(["tavily", "exa"]);

/** Every engine id the hardened plugin accepts anywhere (tools, bridge). */
export const ALL_ENGINES = CHAIN_ENGINES;

/** A configured key is a non-empty trimmed string; anything else is absent. */
const keyPresent = (key) => typeof key === "string" && key.trim().length > 0;

/**
 * Failure text recorded when an engine answers but returns zero sources — the
 * one chain failure that is NOT an engine fault. lib/index.js keys the
 * total-chain summary wording off this marker so "nothing matched" never
 * reads as "search is broken" (review P3).
 */
export const ZERO_RESULTS_ERROR = "returned 0 results";

/**
 * Resolve the engine chain for the current configuration.
 *
 * @param {{ tavilyKey?: string, exaKey?: string }} keys configured keys
 *   (settings section value or environment fallback — resolution stays in
 *   lib/index.js; this function only sees booleans in string form).
 * @returns {string[]} the chain, e.g. ["bing","ddg"] with no keys (zero-key
 *   out-of-box behavior) or ["tavily","exa","bing","ddg"] with both keys.
 */
export function resolveEngineChain(keys = {}) {
  const has = {
    tavily: keyPresent(keys.tavilyKey),
    exa: keyPresent(keys.exaKey),
  };
  return CHAIN_ENGINES.filter((engine) => !KEYED_ENGINES.includes(engine) || has[engine]);
}

/** Total serial-fallback budget: keeps a chain of engine timeouts bounded. */
export const CHAIN_BUDGET_MS = 30000;

/**
 * Walk the chain: try each engine in order, degrade on failure, and NEVER
 * throw — every engine invocation is wrapped, a zero-source result counts as
 * a failure (mirrors upstream), and exhaustion resolves to
 * `{ok:false, failures:[…]}` with one readable entry per attempted engine.
 *
 * @param {{
 *   chain: string[],
 *   runEngine: (engine: string, signal: AbortSignal) => Promise<{sources?: unknown[]}>,
 *   signal?: AbortSignal,
 *   budgetMs?: number,
 *   now?: () => number,
 * }} options
 * @returns {Promise<
 *   | { ok: true, engine: string, result: object, failures: {engine: string, error: string}[] }
 *   | { ok: false, failures: {engine: string, error: string}[] }
 * >}
 */
export async function runEngineChain({ chain, runEngine, signal, budgetMs = CHAIN_BUDGET_MS, now = Date.now }) {
  const deadline = now() + budgetMs;
  const failures = [];
  for (const engine of chain) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      failures.push({ engine, error: `chain budget of ${String(budgetMs)}ms exhausted before ${engine}` });
      return { ok: false, failures };
    }
    // External cancellation + remaining budget compose into one per-engine signal.
    let effectiveSignal;
    try {
      effectiveSignal = AbortSignal.any([
        ...(signal !== undefined ? [signal] : []),
        AbortSignal.timeout(remaining),
      ]);
    } catch {
      // AbortSignal.any/timeout are Node >= 20.3; a hostile runtime without
      // them still gets the chain, just without budget composition.
      effectiveSignal = signal;
    }
    try {
      const result = await runEngine(engine, effectiveSignal);
      if (result === null || typeof result !== "object" || !Array.isArray(result.sources) || result.sources.length === 0) {
        const error = `engine "${engine}" ${ZERO_RESULTS_ERROR}`;
        failures.push({ engine, error });
        continue;
      }
      return { ok: true, engine, result, failures };
    } catch (error) {
      if (signal?.aborted) {
        failures.push({ engine, error: "search aborted" });
        return { ok: false, failures };
      }
      failures.push({ engine, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: false, failures };
}

// time_range 支持：固定档 day/week/month/year，或自定义（相对 12h/3d/2mo/1y、绝对 YYYY-MM-DD）。
const TIME_RANGES = ["day", "week", "month", "year"];
const DAYS_BY_RANGE = { day: 1, week: 7, month: 30, year: 365 };

export function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

/**
 * 把用户/agent 给的 timeRange 解析成统一对象：{ days } 相对天数，或
 * { after } 绝对日期。无效返回 undefined。（上游 v0.4.18 原样收编。）
 */
export function parseTimeRange(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "object") {
    if (typeof input.after === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.after)) return { after: input.after };
    if (typeof input.days === "number" && Number.isFinite(input.days) && input.days > 0) return { days: input.days };
    return undefined;
  }
  const s = String(input).trim().toLowerCase();
  if (s.length === 0) return undefined;
  if (TIME_RANGES.includes(s)) return { days: DAYS_BY_RANGE[s] };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { after: s };
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(h|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years)$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2][0];
    const days =
      unit === "h" ? n / 24 : unit === "d" ? n : unit === "w" ? n * 7 : unit === "m" ? n * 30 : n * 365;
    return { days };
  }
  return undefined;
}

/** 把自定义天数映射到只支持固定档的引擎（tavily / ddg）的最近似档位。 */
export function approximateTimeRange(days) {
  if (days <= 2) return "day";
  if (days <= 14) return "week";
  if (days <= 90) return "month";
  return "year";
}
