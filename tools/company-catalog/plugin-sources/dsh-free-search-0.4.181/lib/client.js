window.__ModuleLoader__.load({
  id: "dsh-free-search",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // Company-hardened settings card for dsh-free-search (upstream
    // DDDMUC/dsh-free-search v0.4.18, lib/client.js). Stripped versus
    // upstream: the npm check-update / one-click-upgrade UI (updates arrive
    // only through the company catalog channel), the engine picker (the
    // chain tavily->exa->bing->ddg is reviewed policy), the keyless/extra
    // engine key inputs, the credentials-center key storage toggle, the
    // platform_search toggles, and the /free-search-engine command.
    //#region css
    const css = [
      ".dshfs-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;min-width:0;list-style:none;transition:border-color .16s,background .16s;overflow:hidden;margin-bottom:8px}",
      ".dshfs-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
      ".dshfs-header{width:100%;color:inherit;cursor:pointer;text-align:left;font:inherit;background:0 0;border:0;align-items:center;gap:8px;padding:10px 14px;display:flex}",
      ".dshfs-header:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshfs-headText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;overflow:hidden}",
      ".dshfs-name{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-weight:600;overflow:hidden}",
      ".dshfs-description{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:12px;overflow:hidden}",
      ".dshfs-pending{color:var(--dsw-alias-state-warn-primary);white-space:nowrap;flex:none;font-size:12px}",
      ".dshfs-chevron{color:var(--dsw-alias-label-tertiary);flex:none;font-size:13px;transition:transform .12s}",
      ".dshfs-chevronOpen{transform:rotate(180deg)}",
      ".dshfs-body{flex-direction:column;gap:14px;padding:0 14px 14px;display:flex}",
      ".dshfs-footer{justify-content:space-between;align-items:center;gap:8px;display:flex;flex-wrap:wrap}",
      ".dshfs-footerRight{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshfs-failed{color:var(--dsw-alias-state-error-primary);font-size:12px}",
      ".dshfs-testOk{color:#7ddb9c;font-size:12px;line-height:1.5}",
      ".dshfs-resultRow{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;margin-top:2px}",
      ".dshfs-field{flex-direction:column;gap:4px;min-width:0;display:flex}",
      ".dshfs-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}",
      ".dshfs-select{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;transition:border-color .13s,box-shadow .13s;width:100%}",
      ".dshfs-select:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
      // 下拉选项列表配色锁死：不随皮肤变量变化（皮肤只影响 select 框体本身）
      ".dshfs-select{color-scheme:light dark}",
      ".dshfs-select option,.dshfs-select optgroup{background-color:#ffffff;color:#1f2328}",
      "@media (prefers-color-scheme:dark){.dshfs-select{color-scheme:dark}.dshfs-select option,.dshfs-select optgroup{background-color:#1e1f24;color:#e8e8ea}}",
      ".dshfs-input{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;transition:border-color .13s,box-shadow .13s;width:100%}",
      ".dshfs-ttl{width:88px}",
      ".dshfs-fieldRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshfs-input:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
      ".dshfs-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".dshfs-input:disabled{opacity:.6;cursor:default}",
      ".dshfs-hint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}",
      ".dshfs-link{color:var(--dsw-alias-state-business-primary);font-size:12px;text-decoration:none;align-self:flex-start;padding:2px 0}",
      ".dshfs-link:hover{text-decoration:underline}",
      ".dshfs-btn{font:inherit;cursor:pointer;border-radius:6px;padding:5px 12px;font-size:13px;transition:background-color .13s,border-color .13s,color .13s}",
      ".dshfs-save{border:1px solid var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}",
      ".dshfs-save:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}",
      ".dshfs-save:disabled{opacity:.5;cursor:default}",
      ".dshfs-badge{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-state-business-primary);white-space:nowrap;border-radius:999px;flex:none;padding:1px 6px;font-size:11px}",
      ".dshfs-langToggle{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;flex:none;padding:2px 8px;font-size:11px;border-radius:6px}",
    ].join("");
    const tagId = "dsh-free-search/card.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-free-search";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    const BRIDGE_PREFIX = "/api/dsh-free-search-settings";
    const NS = "free-search";
    const I18N = {
      zh: {
        description: "免费网页搜索（公司引擎链 tavily→exa→bing→ddg，前两个需配 key）",
        chain: "公司引擎链",
        chainSummary: "tavily → exa → bing → ddg",
        chainHint: "链序为公司口径，不可在此切换。tavily/exa 仅在下方配置 key 后入链；无 key 时自动 bing → ddg，开箱即用。任一引擎失败自动降级到下一个。",
        apiKeys: "API 密钥（可选）",
        exaPh: (c) => c ? "Exa API 密钥（已配置）" : "Exa API 密钥（可选；未配置则不入链）",
        tavilyPh: (c) => c ? "Tavily API 密钥（已配置）" : "Tavily API 密钥（可选；未配置则不入链）",
        keysHint: "密钥保存在本机 settings.yaml 的 free-search 命名空间（本插件设置节），或通过 TAVILY_API_KEY / EXA_API_KEY 环境变量提供。密钥只存在本机，不随插件分发。",
        safeSearch: "安全搜索过滤（adlt）",
        safeSearchHint: "作用于 bing（adlt）与 ddg（adlt 档位）。若看到引擎自身的过滤效果，在此调整。",
        cacheTtl: "结果缓存时长（分钟）",
        cacheTtlHint: "0 关闭缓存，最长 5 分钟。缩短可加快时效，延长可防限流、省额度。",
        unavailable: "设置不可用 —— free-search 桥接未暴露。",
        saveFailed: "保存失败",
        testing: "测试中…",
        testChain: "测试引擎链",
        testOk: (r) => `✓ ${r.count} 条结果（引擎: ${r.engine}）${r.content ? ` — ${r.content}` : ""}${r.sample ? ` · 例如 "${r.sample.slice(0, 40)}"` : ""}`,
        testFail: (e) => `✗ ${e}`,
        discard: "撤销",
        saving: "保存中…",
        save: "保存",
        toggleLang: "EN",
      },
      en: {
        description: "Free web search (company chain tavily→exa→bing→ddg; first two need keys)",
        chain: "Company engine chain",
        chainSummary: "tavily → exa → bing → ddg",
        chainHint: "The chain order is company policy and cannot be switched here. Tavily/Exa join the chain only after their key is configured below; without keys it is bing → ddg out of the box. Any engine failure degrades to the next one automatically.",
        apiKeys: "API keys (optional)",
        exaPh: (c) => c ? "Exa API key (configured)" : "Exa API key (optional; not in the chain without one)",
        tavilyPh: (c) => c ? "Tavily API key (configured)" : "Tavily API key (optional; not in the chain without one)",
        keysHint: "Keys are stored in this machine's settings.yaml under the free-search namespace (this plugin's settings section), or provided through the TAVILY_API_KEY / EXA_API_KEY environment variables. Keys never ship with the plugin.",
        safeSearch: "Safe search filter (adlt)",
        safeSearchHint: "Applies to bing (adlt) and ddg (adlt degree). If you see the engine's own filtering, adjust here.",
        cacheTtl: "Result cache TTL (minutes)",
        cacheTtlHint: "0 disables caching, max 5 minutes. Lower = fresher results, higher = less rate-limiting.",
        unavailable: "Settings unavailable — the free-search bridge is not exposed.",
        saveFailed: "save failed",
        testing: "Testing…",
        testChain: "Test chain",
        testOk: (r) => `✓ ${r.count} results (engine: ${r.engine})${r.content ? ` — ${r.content}` : ""}${r.sample ? ` · e.g. "${r.sample.slice(0, 40)}"` : ""}`,
        testFail: (e) => `✗ ${e}`,
        discard: "Discard",
        saving: "Saving…",
        save: "Save",
        toggleLang: "中文",
      },
    };
    const tt = (lang) => I18N[lang === "en" ? "en" : "zh"];

    async function bridgeDescribe() {
      const response = await fetch(`${BRIDGE_PREFIX}/describe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.json();
    }

    async function bridgeMutate(payload) {
      const response = await fetch(`${BRIDGE_PREFIX}/mutate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return response.json();
    }

    async function bridgeRawSearch(payload) {
      const response = await fetch(`${BRIDGE_PREFIX}/raw-search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return response.json();
    }

    function FreeSearchCard(props) {
      // 检测应用主题深浅（读 body 的 --dsw-alias-bg-base 变量亮度），用于锁定原生下拉配色
      const isDarkScheme = react.useMemo(() => {
        try {
          const root = document.body || document.documentElement;
          const bg = getComputedStyle(root).getPropertyValue("--dsw-alias-bg-base").trim();
          const m = bg.match(/(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
          if (m) {
            const l = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
            return l < 128;
          }
          if (/^#([0-9a-f]{3,8})/i.test(bg)) {
            const hex = bg.slice(1);
            const h = hex.length <= 4 ? hex.replace(/./g, (c) => c + c) : hex;
            const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
            return 0.299 * r + 0.587 * g + 0.114 * b < 128;
          }
        } catch {}
        return typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : false;
      }, []);
      const selectColorScheme = isDarkScheme ? "dark" : "light";
      const [open, setOpen] = react.useState(false);
      const [state, setState] = react.useState({ status: "loading" });
      const [safeSearch, setSafeSearch] = react.useState("off");
      const [exaKey, setExaKey] = react.useState("");
      const [tavilyKey, setTavilyKey] = react.useState("");
      const [cacheTtl, setCacheTtl] = react.useState(5);
      const [keysConfigured, setKeysConfigured] = react.useState({});
      const [lang, setLang] = react.useState("zh");
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [failed, setFailed] = react.useState(false);
      const [testing, setTesting] = react.useState(false);
      const [testResult, setTestResult] = react.useState(null);

      const load = react.useCallback(async () => {
        try {
          const result = await bridgeDescribe();
          if (result.ok) {
            const view = result.value.namespaces.find((n) => n.ns === NS);
            if (view) {
              const v = view.value ?? {};
              setSafeSearch(v.safeSearch === "strict" || v.safeSearch === "moderate" ? v.safeSearch : "off");
              setLang(v.lang === "en" ? "en" : "zh");
              setExaKey(v.exaApiKey ?? "");
              setTavilyKey(v.tavilyApiKey ?? "");
              setCacheTtl(v.cacheTtl === undefined ? 5 : Math.min(Math.max(Number(v.cacheTtl) ?? 5, 0), 5));
              // secrets 字段标记哪些 key 已配置（值被脱敏，仅显示"已配置"）
              const configured = {};
              for (const secret of view.secrets ?? []) {
                if (secret.set) {
                  const path = secret.path.join(".");
                  if (path === "exaApiKey") configured.exa = true;
                  if (path === "tavilyApiKey") configured.tavily = true;
                }
              }
              setKeysConfigured(configured);
              setState({ status: "ready", writable: result.value.writable });
            } else {
              setState({ status: "unavailable" });
            }
          } else {
            setState({ status: "unavailable" });
          }
        } catch {
          setState({ status: "unavailable" });
        }
      }, []);

      react.useEffect(() => {
        load();
      }, [load]);

      const save = async () => {
        setSaving(true);
        setFailed(false);
        try {
          // key 直接写入本插件设置节（settings.yaml 的 free-search 命名空间）
          const ops = [
            { op: "set", path: ["lang"], value: lang },
            { op: "set", path: ["safeSearch"], value: safeSearch },
            { op: "set", path: ["cacheTtl"], value: Math.min(Math.max(Number(cacheTtl) ?? 5, 0), 5) },
          ];
          if (exaKey.trim()) ops.push({ op: "set", path: ["exaApiKey"], value: exaKey.trim() });
          if (tavilyKey.trim()) ops.push({ op: "set", path: ["tavilyApiKey"], value: tavilyKey.trim() });
          const result = await bridgeMutate({ ns: NS, ops });
          if (result.ok) {
            setDirty(false);
            setFailed(false);
            load();
          } else {
            setFailed(true);
          }
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };

      const discard = () => {
        load();
        setDirty(false);
        setFailed(false);
      };

      // 测试按钮：走完整引擎链（不带 engine 参数），返回实际应答的引擎
      const runTest = async () => {
        setTesting(true);
        setTestResult(null);
        setFailed(false);
        try {
          const result = await bridgeRawSearch({
            query: "DeepSeek Harness",
            maxResults: 2,
          });
          if (result.ok) {
            const sources = result.value.sources ?? [];
            setTestResult({
              ok: true,
              count: sources.length,
              engine: result.value.provider ?? "chain",
              content: result.value.content ?? "",
              sample: sources[0]?.title ?? "",
            });
          } else {
            setTestResult({ ok: false, error: result.message ?? "unknown error" });
          }
        } catch {
          setTestResult({ ok: false, error: "request failed" });
        } finally {
          setTesting(false);
        }
      };

      if (state.status === "loading") return null;
      const ready = state.status === "ready";
      const t = tt(lang);
      const title = "Free Search";
      const description = t.description;

      const toggleLang = () => {
        setLang((prev) => (prev === "en" ? "zh" : "en"));
        setDirty(true);
        setFailed(false);
      };

      return react_jsx_runtime.jsx("li", {
        className: open ? "dshfs-card dshfs-cardOpen" : "dshfs-card",
        children: [
          react_jsx_runtime.jsx("button", {
            type: "button",
            className: "dshfs-header",
            "aria-expanded": open,
            onClick: () => setOpen(!open),
            children: [
              react_jsx_runtime.jsx("span", { className: "dshfs-headText", children: [
                react_jsx_runtime.jsx("span", { className: "dshfs-name", children: title }),
                react_jsx_runtime.jsx("span", { className: "dshfs-description", children: description }),
              ] }),
              react_jsx_runtime.jsx("span", { className: "dshfs-badge", children: t.chainSummary }),
              dirty ? react_jsx_runtime.jsx("span", { className: "dshfs-pending", children: t.unsaved }) : null,
              react_jsx_runtime.jsx("button", {
                type: "button",
                className: "dshfs-btn dshfs-langToggle",
                onClick: (e) => {
                  e.stopPropagation();
                  toggleLang();
                },
                children: t.toggleLang,
              }),
              react_jsx_runtime.jsx("span", {
                className: open ? "dshfs-chevron dshfs-chevronOpen" : "dshfs-chevron",
                children: "▾",
              }),
            ],
          }),
          open
            ? react_jsx_runtime.jsx("div", {
                className: "dshfs-body",
                children: [
                  react_jsx_runtime.jsx("div", {
                    className: "dshfs-field",
                    children: [
                      react_jsx_runtime.jsx("div", {
                        className: "dshfs-label",
                        children: t.chain,
                      }),
                      react_jsx_runtime.jsx("p", {
                        className: "dshfs-hint",
                        children: t.chainHint,
                      }),
                    ],
                  }),
                  react_jsx_runtime.jsx("div", {
                    className: "dshfs-field",
                    children: [
                      react_jsx_runtime.jsx("div", {
                        className: "dshfs-label",
                        children: t.safeSearch,
                      }),
                      react_jsx_runtime.jsx("select", {
                        className: "dshfs-select",
                        value: safeSearch,
                        style: { colorScheme: selectColorScheme },
                        disabled: !ready || saving,
                        onChange: (e) => {
                          setSafeSearch(e.target.value);
                          setDirty(true);
                          setFailed(false);
                        },
                        children: [
                          react_jsx_runtime.jsx("option", { value: "off", children: "Off - engine default (no filtering)" }, "off"),
                          react_jsx_runtime.jsx("option", { value: "moderate", children: "Moderate - Bing default" }, "moderate"),
                          react_jsx_runtime.jsx("option", { value: "strict", children: "Strict" }, "strict"),
                        ],
                      }),
                      react_jsx_runtime.jsx("p", {
                        className: "dshfs-hint",
                        children: t.safeSearchHint,
                      }),
                    ],
                  }),
                  react_jsx_runtime.jsx("div", {
                    className: "dshfs-field",
                    children: [
                      react_jsx_runtime.jsx("div", {
                        className: "dshfs-label",
                        children: t.apiKeys,
                      }),
                      react_jsx_runtime.jsx("input", {
                        className: "dshfs-input",
                        type: "password",
                        placeholder: t.tavilyPh(keysConfigured.tavily),
                        value: tavilyKey,
                        disabled: !ready || saving,
                        onChange: (e) => {
                          setTavilyKey(e.target.value);
                          setDirty(true);
                          setFailed(false);
                        },
                      }),
                      react_jsx_runtime.jsx("input", {
                        className: "dshfs-input",
                        type: "password",
                        placeholder: t.exaPh(keysConfigured.exa),
                        value: exaKey,
                        disabled: !ready || saving,
                        onChange: (e) => {
                          setExaKey(e.target.value);
                          setDirty(true);
                          setFailed(false);
                        },
                      }),
                      react_jsx_runtime.jsx("p", {
                        className: "dshfs-hint",
                        children: t.keysHint,
                      }),
                    ],
                  }),
                  react_jsx_runtime.jsx("div", {
                    className: "dshfs-field",
                    children: [
                      react_jsx_runtime.jsx("div", {
                        className: "dshfs-label",
                        children: t.cacheTtl,
                      }),
                      react_jsx_runtime.jsx("input", {
                        className: "dshfs-input dshfs-ttl",
                        type: "number",
                        min: 0,
                        max: 5,
                        step: 1,
                        value: cacheTtl,
                        disabled: !ready || saving,
                        onChange: (e) => {
                          setCacheTtl(Number(e.target.value));
                          setDirty(true);
                          setFailed(false);
                        },
                      }),
                      react_jsx_runtime.jsx("p", {
                        className: "dshfs-hint",
                        children: t.cacheTtlHint,
                      }),
                    ],
                  }),
                  react_jsx_runtime.jsx("div", {
                    className: "dshfs-resultRow",
                    children: [
                      failed ? react_jsx_runtime.jsx("span", { className: "dshfs-failed", children: t.saveFailed }) : null,
                      testResult
                        ? react_jsx_runtime.jsx("span", {
                            className: testResult.ok ? "dshfs-testOk" : "dshfs-failed",
                            children: testResult.ok
                              ? t.testOk(testResult)
                              : t.testFail(testResult.error),
                          })
                        : null,
                    ],
                  }),
                  !ready
                    ? react_jsx_runtime.jsx("p", {
                        className: "dshfs-hint",
                        children: t.unavailable,
                      })
                    : null,
                  react_jsx_runtime.jsx("div", {
                    className: "dshfs-footer",
                    children: [
                      react_jsx_runtime.jsx("div", {
                        className: "dshfs-footerRight",
                        children: [
                          react_jsx_runtime.jsx("button", {
                            className: "dshfs-btn",
                            type: "button",
                            onClick: runTest,
                            disabled: testing || saving || !ready,
                            children: testing ? t.testing : t.testChain,
                          }),
                          react_jsx_runtime.jsx("button", {
                            className: "dshfs-btn",
                            type: "button",
                            onClick: discard,
                            disabled: saving || !dirty,
                            children: t.discard,
                          }),
                          react_jsx_runtime.jsx("button", {
                            className: "dshfs-btn dshfs-save",
                            type: "button",
                            onClick: save,
                            disabled: saving || !dirty || !ready,
                            children: saving ? t.saving : t.save,
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              })
          : null,
        ],
      });
    }

    const inject = ["slots"];

    function apply(ctx) {
      // 挂官方插槽 settings.plugin.item（设置 → 插件 → 可配置标签页）。
      // 不依赖 dsh-web-ui：配置读写走自建 bridge（/api/dsh-free-search-settings）。
      ctx.slots.inject("settings.plugin.item", () =>
        ctx.slots.register(
          {
            name: "settings.plugin.item",
            key: "free-search",
            id: "dsh-free-search",
            order: 120,
            inject: () => ({}),
          },
          FreeSearchCard
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
