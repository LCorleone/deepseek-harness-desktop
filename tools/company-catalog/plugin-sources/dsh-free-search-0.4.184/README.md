# dsh-free-search (company-hardened build)

Free web search for DeepSeek Harness — **company hardened build of upstream
[DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search) v0.4.18**
(commit `36c6446211cd2a759cf59de87a1ba6a893c34ebd`, MIT; upstream README kept
at `docs/README-upstream.md`). Distributed **only** through the company
catalog tarball channel — this package never resolves from the public npm
registry, and its version (`0.4.183` = upstream `0.4.18` + company build `3`;
build `1` = `0.4.181`, retired for a bundle patch declaration prefix mismatch
that failed every real-machine install; build `2` = `0.4.182`, superseded by
the 0.4.183 keyed-only chain — see `README-hardened.zh.md`)
never exists on npm.

## What it does

Registers one web search provider (id `free-search`) into the `ctx.web` seam
and pins `web.searchProvider` to it through a minimal coexistence patch, so
the built-in `web_search` tool runs on the reviewed engine chain:

```
tavily → exa → anysearch
```

- **Every engine is keyed-only** (0.4.183, 纯三键制): an engine joins the
  chain only while its API key is configured (Settings → Plugins → Free
  Search, or the `TAVILY_API_KEY` / `EXA_API_KEY` / `ANYSEARCH_API_KEY`
  environment variables). No key, no hop — it is skipped, not attempted.
- **Zero keys is a guided state, not a silent one**: with no key at all,
  `web_search` returns readable setup guidance (free tiers, signup portals,
  and where to configure) instead of running an empty chain. Any one key is
  enough to search; two or three add automatic fallback.
- Any engine failure (missing/invalid key, 401, rate limit, network, zero
  results) automatically degrades to the next engine in the chain. The chain
  walk never throws; total failure returns a readable message telling the
  agent web search is temporarily unavailable.
- Keys live only in this machine's `settings.yaml` (`free-search` namespace,
  this plugin's own settings section) or environment variables. They are
  never part of the shipped package.

### Free tiers (self-registered, no company key distribution)

| Engine | Free tier | Signup |
| --- | --- | --- |
| tavily | 1,000 searches/month, no credit card | https://tavily.com |
| exa | $20 signup credit + $10/month (≈1,400 searches/month) | https://exa.ai |
| anysearch | 1,000 searches/day | https://anysearch.com |

## Tools

| Tool | Purpose |
| --- | --- |
| `web_search` | built-in tool, now backed by this chain |
| `free_search_advanced` | like `web_search` plus a `timeRange` filter (`day`/`week`/`month`/`year`, `12h`/`3d`/`2mo`/`1y`, or `2026-07-01`); tavily/exa apply it precisely, anysearch ignores it |
| `free_search_test` | tests each chain engine and reports availability (diagnostics for the agent) |

## Settings (Settings → Plugins → Free Search)

`tavilyApiKey` / `exaApiKey` / `anysearchApiKey` (the three engine keys, each
optional but at least one is needed to search), `cache`/`cacheTtl` (result
cache, 0–5 min), `lang` (card language). The card carries a signup guide
with the three free tiers and their portals.

## Removed versus upstream v0.4.18

Updates arrive only through the company catalog channel that installed this
package: the npm check-update probe, the one-click `pnpm add
dsh-free-search@latest` upgrade, the local engine-switcher HTTP server, the
credentials-center integration, the engine picker (the chain order is company
policy), and every engine outside the reviewed chain (ddg-lite, searxng,
keenable, perplexity, deepseek-official, the keyless MCP/anonymous variants
of exa/tavily, and — removed in 0.4.183 — the keyless bing/ddg scrapers)
are stripped. The full strip list with the review trail lives in
`README-hardened.zh.md`.

## License

MIT — © dsh-free-search contributors (upstream), hardened build maintained in
the desktop repository's company catalog.
