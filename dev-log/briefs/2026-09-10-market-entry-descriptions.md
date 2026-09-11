# 2026-09-10 · 市场条目描述（catalog description）卡

## 1. Goal & background

公司市场里每个插件只有名字/版本/作者，描述是一行英文占位符 `Company signed catalog entry <pkg>@<ver>`（`dsh-community-market/src/catalog/company-provider.ts:511`）。同事（MR session）今天已完成 seq25 首批 stable 转正（4 stable + engramory beta + sidebar 0.15.2 revoked），但清单条目只有 7 个字段，description 从未进签名目录——handoff 契约里必填的 description 只用于 MR 展示，装配时被丢弃。

**目标**：让 allowlist 里一行可选 `description`（中文一句话）流到签名目录条目 → 桌面校验认可 → 市场卡片显示真实描述；占位符降为无描述时的 fallback。

**顺序雷（本卡的硬约束）**：目录校验是严格形状——`dsh-plugin-desktop/src/desktop-market.ts:866-867`「every unknown key rejects the whole manifest — `source` is the one recognized extension」。带 description 的新清单在旧客户端（b88）上会**整单被拒**。因此：代码 → 构建 b89 → 4 台舰队升级 → 才能发 seq26。本卡**只做代码，不发目录**。

## 2. Code map（行号为 2026-09-10 17:48 HEAD≈`2dfe35a0b3`，近似）

- `tools/company-catalog/allowlist.json` — 6 条目（sidebar 0.18.1 / sidebar 0.15.2 revoked / free-search 0.4.184 / dai-context 0.41.4 / agent-teams 0.1.16 / engramory 0.2.4）。tarball 通道条目带 `source:{kind:'tarball',url,…}`。
- `tools/company-catalog/lib/pipeline.mjs:296-360` — `published → sort → map` 装配签名条目：integrity/repository 归一后构造 entry 对象（约 :345 之后），emit 字段=packageName/version/bundlePatch/repository/runtime/treeDigest/revoked/channel/source。**description 在这里加**：allowlist 条目有非空 `description` 字符串 → emit；否则整个键不出现（旧清单字节兼容）。
- `dsh-plugin-desktop/src/desktop-market.ts` — 桌面注入的字段感知校验器：~:362-380 注释（field-aware build）、:497 beta `testers` 顶层认可键、:621 `validateEntrySource`（strict：未知键拒绝）、:866-867 严格形状总注释。**description 按同一先例加为条目级认可扩展键**（optional，非空 string；出现空串/非串=拒）。测试在 `dsh-plugin-desktop/tests/desktop-market.spec.ts`。
- `dsh-community-market/src/catalog/company-provider.ts` — `CompanyCatalogCandidate`（:131-141）加 `readonly description?: string`；:511 `summary: 'Company signed catalog entry …'` 改为 `summary = entry.description ?? 占位符`；搜索面 :240-241 / :629-630 已引用 `item.summary`/`item.description`，无需大动。测试 `tests/company-provider.spec.ts`、`tests/market-wired-company-catalog.spec.ts`。
- `dsh-community-market/src/client/MarketSettingsTab.tsx:1734` — 渲染 `item.summary`，不用改（确认渲染路径即可）。
- 文档：`tools/company-catalog/docs/handoff/MR-HANDLING.zh.md`（MR 流程）与 SOP/README 里 allowlist 字段说明处，补 `description`（可选、一句话中文、MR 里可评审）。

## 3. Conventions & constraints

- 红线：不碰 `deepseek-harness/` 子模块；`tools/company-catalog` 与 `allowlist.json` 是与 MR session **共享**的文件——edit 工具精确修改，git add 只加自己动过的文件，**严禁 `git add -A`**。
- 一次只加一个认可扩展键（先例：testers→channel→source→现在 description），注释里点名先例。
- description 是纯字符串，**不做**多语言协商/本地化框架；中文直书 allowlist（评审面=MR/allowlist 本身）。
- npm 通道没有 staged package.json，所以统一只从 allowlist 取，**不**做 registry 元数据回退。
- 不 push、不构建、不发目录。commit 一个：`feat(market,desktop): carry allowlist descriptions into the signed catalog and market cards`。

## 4. Decisions made & failed attempts

- （后补 2026-09-10 18:26，July 拍板）**新条目 description 必填、机械强制**：
  · `verify-handoff.mjs` 新增必填参数 `--description "一句话中文"`（缺失或空白 → failCheck，提示从 handoff.plugin.description/MR 描述提炼）；`buildAllowlistSnippet` 把它写进条目。
  · `accept-handoff.mjs` 的 `resolveVerifiedEntry`：回执条目缺非空 description → refuse（防旧版 verify 产出的回执绕过）。
  · 旧条目不受影响（键不出现=合法）；revoked 保留钉/retire 拷贝的旧条目同样豁免（它们不从 verify/accept 走）。
  · MR-HANDLING.zh.md 的「可加可选」措辞同步改为必填。

- 来源选 **allowlist 覆盖式可选字段**（统一两通道、MR 可评审），否决「从 package.json/registry 取」：两通道来源不一、评审面分散。
- 旧条目无 description → 键完全不出现（不是空串），保证旧清单字节不变。
- 5 条中文描述草稿（July 定稿，worker 原样写入并在 commit message 里注明「草稿待 July 确认」）：
  - dsh-better-sidebar@0.18.1：`常驻侧边栏：上下文用量、会话与工具状态一目了然`
  - dsh-dai-context@0.41.4：`上下文洞察与管理：仪表盘查看上下文占用，一键整理收纳`
  - dsh-dai-agent-teams@0.1.16：`多智能体团队协作：队长/成员与依赖任务编排`
  - dsh-dai-engramory@0.2.4：`文件式长期记忆：人类可读的 markdown 笔记，跨会话沉淀`
  - dsh-free-search@0.4.184：`网页搜索（上游 0.4.18 公司加固构建）：统一密钥与内网代理`
  - （sidebar 0.15.2 已 revoked，不加描述）
- 顺序铁律：fleet 全员 b89 之前**任何人不得发 seq26**——写进文档备注。

## 5. Acceptance criteria

1. `tools/company-catalog` 装配测试（node --test）：allowlist 带 description → 条目含该键且值一致；不带 → 键不存在（快照/字节断言）。
2. `desktop-market.spec.ts`：含 description 的清单验证通过；**旧形状（无该键）照常通过**；未知键（如 `descriptionx`）仍整单拒绝；description 空串/非字符串拒绝。
3. `company-provider.spec.ts`：entry 有 description → `item.summary`=description；无 → 占位符 fallback。
4. 三包测试全绿（desktop 2333+8skip 基线只增不减 / market 466 / company-skills 52）+ catalog 测试绿 + `corepack yarn typecheck` 0 错。
5. 文档两处（MR-HANDLING/SOP 或 README 的 allowlist 字段说明）含 description 字段说明 + 「seq26 前 fleet 须全员 b89」备注。
6. 报告 ≤400 字：逐条摘要 + 测试数 + 变异红绿证（至少：去掉新认可键 → 含 description 的清单测试红）。
