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
    // chain tavily->exa->anysearch is reviewed policy), the keyless/extra
    // engine key inputs, the credentials-center key storage toggle, the
    // platform_search toggles, and the /free-search-engine command. Since
    // 0.4.183 the chain is keyed-only (three self-registered free keys);
    // since 0.4.184 the card copy is minimal by user decision: one intro
    // line, then per engine a key input, a "get a free key" registration
    // link, and the free-quota note — the chain explainer, the storage/
    // settings-file notes, and the cache-TTL field are gone (the setting
    // keeps working server-side with its schema default).
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
      ".dshfs-input{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;transition:border-color .13s,box-shadow .13s;width:100%}",
      ".dshfs-fieldRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshfs-note{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshfs-input:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
      ".dshfs-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}",
      ".dshfs-input:disabled{opacity:.6;cursor:default}",
      ".dshfs-hint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}",
      ".dshfs-link{color:var(--dsw-alias-state-business-primary);font-size:12px;text-decoration:none;padding:2px 0}",
      ".dshfs-link:hover{text-decoration:underline}",
      ".dshfs-btn{font:inherit;cursor:pointer;border-radius:6px;padding:5px 12px;font-size:13px;transition:background-color .13s,border-color .13s,color .13s}",
      ".dshfs-save{border:1px solid var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}",
      ".dshfs-save:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}",

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
        description: "免费网页搜索",
        intro: "配置以下一个或多个 API Key，即可免费使用搜索功能。",
        engines: [
          { id: "tavily", name: "Tavily", url: "https://tavily.com", note: "免费 1,000 次/月，无需信用卡" },
          { id: "exa", name: "Exa", url: "https://exa.ai", note: "注册送 $20 + 每月 $10（约 1,400 次/月）" },
          { id: "anysearch", name: "AnySearch", url: "https://anysearch.com", note: "免费 1,000 次/天" },
        ],
        getKey: "获取免费 Key",
        keyPh: (name, configured) => configured ? `${name} API Key（已配置）` : `${name} API Key`,
        unavailable: "设置不可用 —— free-search 桥接未暴露。",
        saveFailed: "保存失败",
        unsaved: "未保存",
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
        description: "Free web search",
        intro: "Configure one or more of the API keys below to use search for free.",
        engines: [
          { id: "tavily", name: "Tavily", url: "https://tavily.com", note: "1,000 free searches/month, no credit card" },
          { id: "exa", name: "Exa", url: "https://exa.ai", note: "$20 signup credit + $10/month free (about 1,400 searches/month)" },
          { id: "anysearch", name: "AnySearch", url: "https://anysearch.com", note: "1,000 free searches/day" },
        ],
        getKey: "Get a free key",
        keyPh: (name, configured) => configured ? `${name} API key (configured)` : `${name} API key`,
        unavailable: "Settings unavailable — the free-search bridge is not exposed.",
        saveFailed: "save failed",
        unsaved: "unsaved",
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
      const [open, setOpen] = react.useState(false);
      const [state, setState] = react.useState({ status: "loading" });
      const [exaKey, setExaKey] = react.useState("");
      const [tavilyKey, setTavilyKey] = react.useState("");
      const [anysearchKey, setAnysearchKey] = react.useState("");
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
              setLang(v.lang === "en" ? "en" : "zh");
              setExaKey(v.exaApiKey ?? "");
              setTavilyKey(v.tavilyApiKey ?? "");
              setAnysearchKey(v.anysearchApiKey ?? "");
              // secrets 字段标记哪些 key 已配置（值被脱敏，仅显示"已配置"）
              const configured = {};
              for (const secret of view.secrets ?? []) {
                if (secret.set) {
                  const path = secret.path.join(".");
                  if (path === "exaApiKey") configured.exa = true;
                  if (path === "tavilyApiKey") configured.tavily = true;
                  if (path === "anysearchApiKey") configured.anysearch = true;
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
          ];
          if (exaKey.trim()) ops.push({ op: "set", path: ["exaApiKey"], value: exaKey.trim() });
          if (tavilyKey.trim()) ops.push({ op: "set", path: ["tavilyApiKey"], value: tavilyKey.trim() });
          if (anysearchKey.trim()) ops.push({ op: "set", path: ["anysearchApiKey"], value: anysearchKey.trim() });
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
            // 0 结果且有引导文案（三键制下未配 key 的常态）：按失败样式展示
            // 引导内容，而不是「✓ 0 条结果」
            if (sources.length === 0) {
              setTestResult({ ok: false, error: result.value.content || "0 results" });
            } else {
              setTestResult({
                ok: true,
                count: sources.length,
                engine: result.value.provider ?? "chain",
                content: result.value.content ?? "",
                sample: sources[0]?.title ?? "",
              });
            }
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

      // Per-engine wiring: the i18n rows carry the copy (name, link, quota),
      // this map carries which state each row edits.
      const engineFields = {
        tavily: { value: tavilyKey, set: setTavilyKey, configured: keysConfigured.tavily },
        exa: { value: exaKey, set: setExaKey, configured: keysConfigured.exa },
        anysearch: { value: anysearchKey, set: setAnysearchKey, configured: keysConfigured.anysearch },
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
                  react_jsx_runtime.jsx("p", {
                    className: "dshfs-hint",
                    children: t.intro,
                  }),
                  ...t.engines.map((engine) => {
                    const field = engineFields[engine.id];
                    return react_jsx_runtime.jsx(
                      "div",
                      {
                        className: "dshfs-field",
                        children: [
                          react_jsx_runtime.jsx("div", {
                            className: "dshfs-label",
                            children: engine.name,
                          }),
                          react_jsx_runtime.jsx("input", {
                            className: "dshfs-input",
                            type: "password",
                            placeholder: t.keyPh(engine.name, field.configured),
                            value: field.value,
                            disabled: !ready || saving,
                            onChange: (e) => {
                              field.set(e.target.value);
                              setDirty(true);
                              setFailed(false);
                            },
                          }),
                          react_jsx_runtime.jsx("div", {
                            className: "dshfs-fieldRow",
                            children: [
                              react_jsx_runtime.jsx("a", {
                                className: "dshfs-link",
                                href: engine.url,
                                target: "_blank",
                                rel: "noreferrer noopener",
                                children: t.getKey,
                              }),
                              react_jsx_runtime.jsx("span", {
                                className: "dshfs-note",
                                children: engine.note,
                              }),
                            ],
                          }),
                        ],
                      },
                      engine.id
                    );
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
