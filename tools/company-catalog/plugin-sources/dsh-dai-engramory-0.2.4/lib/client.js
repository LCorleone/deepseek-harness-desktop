/**
 * dsh-engramory browser half — an "Engramory 记忆" mode selector in the
 * DSH settings page, rendered as a segmented pill slider with motion.
 *
 * The store and the recall mode live on the HOST, so this half talks to it
 * through the two endpoints the host half mounts:
 *   GET  /engramory/status  → { mode, ...index stats }
 *   POST /engramory/mode    → { mode: "global" | "explicit" | "off" }
 * and renders the current mode as a segmented control whose highlight pill
 * glides between the three stops with a spring-up mount and press feedback.
 * No browser-side data, no injected hooks — the section is a plain fetch
 * selector tolerant of hosts whose settings shell hands over only the
 * `close` owner prop.
 *
 * Built in the standard client-bundle shape: a `window.__ModuleLoader__.load`
 * closure-factory that resolves `react` through the loader module table.
 * React is used via `createElement`, depending only on `react`.
 */
window.__ModuleLoader__.load({
  id: "dsh-dai-engramory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let { createElement: h, useEffect, useState, useCallback } = react;

    var MODE_OPTIONS = [
      {
        id: "global", label: "global",
        desc: "记忆读写全开：每次对话开始都自动读取记忆并注入上下文，同时允许随时写入新记忆。",
        descEn: "Fully on: memory is auto-read and injected at the start of every conversation, and new memories can be written any time.",
      },
      {
        id: "explicit", label: "explicit",
        desc: "记忆读写仅在 /engramory 时开启：普通对话不做任何自动读取/调取，只有输入 /engramory 命令后在本次会话内开放完整的记忆读取与写入维护。",
        descEn: "Read/write only via /engramory: normal conversations do not auto-recall; typing /engramory opens the store for full read and write maintenance within that turn.",
      },
      {
        id: "off", label: "off",
        desc: "记忆读写关闭：任何情况下（包括 /engramory 命令）都不读取或写入记忆。",
        descEn: "Memory off: no memory is read or written under any circumstances (including the /engramory command).",
      },
    ];
    var MODE_BY_ID = {};
    MODE_OPTIONS.forEach(function (o) { MODE_BY_ID[o.id] = o; });

    // Keyframe animations for the motions that need more than a CSS transition:
    // a spring-in on mount and a subtle pulse on the active pill.
    function injectStyles() {
      var id = "dsh-engramory-anim";
      if (document.getElementById(id)) return;
      var tag = document.createElement("style");
      tag.id = id;
      tag.textContent = [
        "@keyframes dshEngramoryPop {",
        "  0% { transform: scale(0.86); opacity: 0.4; }",
        "  60% { transform: scale(1.04); opacity: 1; }",
        "  100% { transform: scale(1); opacity: 1; }",
        "}",
        "@keyframes dshEngramoryDescIn {",
        "  from { opacity: 0; transform: translateY(2px); }",
        "  to { opacity: 1; transform: translateY(0); }",
        "}",
      ].join("\n");
      (document.head || document.documentElement).appendChild(tag);
    }

    function LoadingState() {
      return h("div", { style: { padding: "24px 0", textAlign: "center", color: "var(--dsw-alias-label-tertiary, #888)" } },
        "正在读取 engramory配置…");
    }

    function ErrorState(props) {
      return h("div", { style: { padding: "24px 0", textAlign: "center", color: "#b42318" } },
        h("div", null, "无法读取记忆设置"),
        props.error ? h("div", { style: { fontSize: 12, marginTop: 6, opacity: 0.8, wordBreak: "break-all" } }, props.error) : null,
      );
    }

    function EngramorySection() {
      const [mode, setMode] = useState(null);
      const [error, setError] = useState(null);
      const [saveError, setSaveError] = useState(null);
      // Memory-file detail list (fetched from /engramory/memories).
      const [memories, setMemories] = useState(null);
      const [memError, setMemError] = useState(null);
      const [expanded, setExpanded] = useState(null);
      // Per-segment hover for tactile feedback. Deliberately NO `pressed`-state /
      // `onMouseDown` re-render: in the settings host a state update on mousedown
      // remounts the slot-injected button node between mousedown and mouseup, which
      // cancels the native `click` event — so real clicks would never fire. The
      // cosmetic press animation is not worth that; hover feedback stays.
      const [hovered, setHovered] = useState(null);
      // Re-entrancy guard: a ref never leaks through a stuck state, so the buttons
      // can NEVER be left unclickable by a hung request. Used with the `disabled`
      // button attribute removed below (a disabled button eats clicks silently,
      // which reads to the user as "点不了").
      const busyRef = { current: false };

      const load = useCallback(function () {
        let live = true;
        fetch("/engramory/status", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (body) { if (live) setMode(body.mode); })
          .catch(function (e) { if (live) setError(e instanceof Error ? e.message : String(e)); });
        return function () { live = false; };
      }, []);

      function loadMemories() {
        fetch("/engramory/memories", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            setMemories({ files: body.files || [], referenced: body.referenced || [], memoryRoot: body.memoryRoot || "", maxLines: body.maxLines, maxBytes: body.maxBytes });
          })
          .catch(function (e) { setMemError(e instanceof Error ? e.message : String(e)); });
      }

      useEffect(function () {
        injectStyles();
        const off = load();
        loadMemories();
        return off;
      }, [load]);

      if (error !== null) return h(ErrorState, { error: error });
      if (mode === null) return h(LoadingState, null);

      function select(next) {
        if (next === mode || busyRef.current) return;
        busyRef.current = true;
        // Optimistic update: move the highlight immediately so the switch feels
        // instant, then persist. Roll back only if the server rejects. The host
        // echoes `mode` on success; we apply `body.mode` (not `next`) so any
        // server-side normalization wins, and keep the last-confirmed value on
        // failure so the UI never disagrees with the persisted store.
        const previous = mode;
        setMode(next);
        setSaveError(null);
        fetch("/engramory/mode", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: next }),
          cache: "no-store",
        })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (body.ok) setMode(body.mode);
            else { setMode(previous); setSaveError(body.error || "保存失败"); }
          })
          .catch(function (e) { setMode(previous); setSaveError(e instanceof Error ? e.message : String(e)); })
          .finally(function () { busyRef.current = false; });
      }

      const accent = "var(--dsw-alias-accent, #2768ff)";
      const active = MODE_BY_ID[mode] ?? MODE_OPTIONS[0];
      const activeIdx = MODE_OPTIONS.findIndex(function (o) { return o.id === mode; });
      const thumbLeft = activeIdx * (100 / MODE_OPTIONS.length) + "%";
      const thumbWidth = 100 / MODE_OPTIONS.length + "%";

      function Segment(props) {
        const o = props.option;
        const on = o.id === mode;
        const isHover = hovered === o.id;
        return h("button", {
          type: "button",
          // NOTE: deliberately NO `disabled` here — a disabled button
          // swallows clicks with zero feedback, which is exactly the user's
          // "点了没反应". Re-entrancy is handled by the busyRef guard in
          // `select`; the button stays clickable so press feedback always shows.
          onClick: function () { select(o.id); },
          onMouseEnter: function () { setHovered(o.id); },
          onMouseLeave: function () { setHovered(null); },
          title: o.desc,
          style: {
            position: "relative",
            zIndex: 1,
            flex: 1,
            padding: "9px 10px",
            borderRadius: 18,
            border: "none",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "var(--dsw-font-mono, monospace)",
            fontWeight: on ? 600 : 400,
            color: on ? "#fff" : isHover ? "var(--dsw-alias-label-primary, #444)" : "var(--dsw-alias-label-tertiary, #888)",
            background: "transparent",
            whiteSpace: "nowrap",
            lineHeight: 1,
            transition: "color .15s ease",
          },
        }, o.label);
      }

      return h("div", null,
        h("div", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #333)", marginBottom: 16 } },
          "engramory"),
        h("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #888)", marginBottom: 10 } },
          "记忆读写模式 · Memory read/write mode"),
        h("div", { style: {
          position: "relative",
          display: "flex",
          padding: 4,
          borderRadius: 22,
          background: "var(--dsw-alias-bg-module-platform, #f5f6f7)",
          border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.18))",
          overflow: "hidden",
        } },
          // Gliding highlight pill: spring-in on mount, smooth slide between
          // stops, soft glow. pointerEvents none — it is a pure visual layer
          // and must NEVER intercept the pointer from the buttons beneath it;
          // an absolutely-positioned sibling without this would eat clicks and
          // make adjacent segments unclickable.
          h("div", { key: "thumb", style: {
            position: "absolute",
            pointerEvents: "none",
            top: 4,
            bottom: 4,
            left: thumbLeft,
            width: thumbWidth,
            borderRadius: 18,
            background: accent,
            boxShadow: "0 2px 8px rgba(39,104,255,0.4), inset 0 1px 0 rgba(255,255,255,0.18)",
            transition: "left .3s cubic-bezier(.34,1.2,.4,1)",
            animation: "dshEngramoryPop .35s cubic-bezier(.34,1.2,.4,1)",
          } }),
          MODE_OPTIONS.map(function (o) { return h(Segment, { key: o.id, option: o }); }),
        ),
        h("div", {
          key: mode,
          style: {
            fontSize: 12,
            color: saveError ? "#b42318" : "var(--dsw-alias-label-tertiary, #888)",
            marginTop: 8,
            animation: "dshEngramoryDescIn .25s ease",
          },
        },
          saveError ?? active.desc,
        ),
        active.descEn
          ? h("div", {
              key: mode + ":en",
              style: {
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--dsw-alias-label-tertiary, #999)",
                marginTop: 4,
                animation: "dshEngramoryDescIn .25s ease",
              },
            },
            active.descEn)
          : null,
        active.id === "explicit"
          ? h("div", {
              key: mode + ":warn",
              style: {
                fontSize: 12,
                color: "#b42318",
                background: "rgba(180,35,24,0.08)",
                border: "1px solid rgba(180,35,24,0.25)",
                borderRadius: 8,
                padding: "8px 10px",
                marginTop: 10,
                lineHeight: 1.5,
              },
            },
            "开启 explicit 后：普通对话不会再自动读取记忆——记忆只有在输入 /engramory 命令、于该次会话的维护窗口内被召回并写入。也就是说，不是整段会话都读记忆，而是仅在 /engramory 那一刻把前面的记忆拉进来。")
          : null,
        MemoryFileList({ memories, memError, expanded, setExpanded }),
      );
    }

    function MemoryFileList(props) {
      const { memories, memError, expanded, setExpanded } = props;
      if (memError !== null) {
        return h("div", { style: { marginTop: 18, fontSize: 12, color: "#b42318" } },
          "无法读取记忆文件：" + memError);
      }
      if (memories === null) {
        return h("div", { style: { marginTop: 18, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)" } },
          "正在读取记忆文件…");
      }
      const refs = new Set(memories.referenced || []);
      const notes = (memories.files || []).filter(function (f) { return !f.isIndex; });
      const index = (memories.files || []).find(function (f) { return f.isIndex; });
      const divider = { height: 1, background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.14))", margin: "16px 0" };
      return h("div", { style: { marginTop: 18 } },
        h("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 } },
          h("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary, #888)" } }, "记忆文件 · Memory files"),
          memories.memoryRoot
            ? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #999)", wordBreak: "break-all", textAlign: "right", marginLeft: 12 } }, memories.memoryRoot)
            : null,
        ),
        index
          ? IndexRow({ index: index, memories: memories })
          : h("div", { style: { fontSize: 12, color: "#b42318", marginBottom: 8 } }, "未找到索引文件"),
        h("div", { style: divider }),
        notes.length === 0
          ? h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)" } }, "还没有记忆文件")
          : notes.map(function (f) { return NoteRow({ f: f, ref: refs.has(f.name), expanded: expanded === f.name, onToggle: function () { setExpanded(expanded === f.name ? null : f.name); } }); }),
      );
    }

    function IndexRow(props) {
      const { index, memories } = props;
      const FONT = { fontFamily: "var(--dsw-font-mono, monospace)", fontSize: 11 };
      return h("div", { style: { background: "var(--dsw-alias-bg-module-platform, #f5f6f7)", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.14))", borderRadius: 8, padding: "8px 10px" } },
        h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } },
          h("span", { style: { fontWeight: 600 } }, "索引 " + index.name),
          h("span", { style: FONT, color: "var(--dsw-alias-label-tertiary, #888)" }, index.lines + " 行 · " + index.bytes + " B"),
        ),
        h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", marginTop: 4 } },
          "上限 " + (memories.maxLines ?? "—") + " 行 / " + Math.round(((memories.maxBytes ?? 0) || 0) / 1024) + " KB"),
      );
    }

    function NoteRow(props) {
      const { f, ref, expanded, onToggle } = props;
      const hasBody = !!f.body;
      const meta = [f.type || "?", f.created || "?", f.updated || "?"].join(" · ");
      return h("div", { style: { border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.14))", borderRadius: 8, marginBottom: 6, overflow: "hidden" } },
        h("button", {
          type: "button",
          onClick: onToggle,
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: "8px 10px",
            cursor: "pointer",
          },
        },
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary, #333)" } }, f.name.replace(/\.md$/, "")),
            h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
              f.description || "(无描述)",
            ),
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: 8 } },
            h("span", { style: { fontSize: 10, padding: "1px 6px", borderRadius: 10, background: ref ? "rgba(39,104,255,0.12)" : "rgba(180,35,24,0.12)", color: ref ? "#2768ff" : "#b42318" } },
              ref ? "已引用" : "未引用"),
            h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)" } }, f.bytes + " B"),
            h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s ease" } }, "›"),
          ),
        ),
        expanded
          ? h("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.14))", padding: "8px 10px", background: "#fff" } },
              h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)", marginBottom: 6 } }, meta),
              h("pre", { style: { margin: 0, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--dsw-alias-label-primary, #333)", maxHeight: 240, overflow: "auto" } },
                hasBody ? f.body : "(空文件)"),
            )
          : null,
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "engramory",
          order: 30,
          label: function () {
            // Locale-aware tab label: English UI ("Engramory Settings"), Chinese
            // UI ("engramory 设置"). dsh's locale service writes the active language
            // onto document.documentElement.lang ('zh-CN' for Chinese, the locale
            // id otherwise — default 'en').
            var lang = "";
            try { lang = String((document.documentElement && document.documentElement.lang) || ""); } catch (e) { lang = ""; }
            return /^zh/i.test(lang) ? "engramory 设置" : "Engramory Settings";
          },
        }, EngramorySection);
      });
    }

    module.exports = { name: "engramory", inject: ["slots"], apply: apply };
    return module.exports;
  }
});
