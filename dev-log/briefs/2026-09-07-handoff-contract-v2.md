# Handoff contract v2 — plugin metadata (author/description/type) + MR template + README front page

## 1. Goal & background

插件交接仓已整体迁到 pluginpuller/dsh-desktop-plugins（http://10.173.59.30:9080，
master Maintainer-only 保护）。老板拍板：MR 提交必须带插件元数据（名/作者/版本/
描述/类型）——实现方式=扩展既有 handoff.json（不造第二份 JSON），配 GitLab MR
模板，README 重构为仓库首页。还没任何同事发过 MR——**零历史包袱，直接 v2 强制**。

## 2. Code map（2026-09-07 16:50，master fb6fb510c1，行号近似）

- `tools/company-catalog/docs/handoff/handoff.schema.json` — 现版 schemaVersion=1；
  `properties.plugin` 只有 packageName+version；required 六键。
  **改**：schemaVersion const → 2；plugin 增三字段（全部 required）：
  - `author`: string（简单字符串，不校验邮箱格式——可以是 "sebtang" 或 "sebtang@…"；
    描述注明 作者≠提交人，可以代交）
  - `description`: string，minLength 1，描述注明 1-2 句
  - `type`: **enum（英文值，固定十一个）**：
    `tool | skill | docs-and-rendering | vision-and-multimodal | voice-and-audio |
     memory | workflow-and-automation | git-and-code-review | interface-ui |
     browser-and-network | other`
- `tools/company-catalog/docs/handoff/example.handoff.json` — 同步三字段（free-search
  示例：author "julu"、description 用现有 free-search 一句话、type "tool"）。
- `tools/company-catalog/docs/handoff/README.zh.md` — 重构为**仓库首页**结构：
  ①仓库定位一句话（公司插件交接唯一入口）②快速开始五步浓缩（细节链接 SOP.zh.md）
  ③契约文件清单+字段表（含新三字段说明）④MR 规范（模板自动带出+verdict 回执机制
  一句话）⑤新实例注意事项（10.173.59.30 需账号、HTTP 内网）。保持中文。
- `.gitlab/merge_request_templates/plugin.md` — **新建**（desktop 仓
  tools/company-catalog/docs/handoff/ 下作为 source of truth，文件名即模板名）：
  中文表头+勾选清单：插件名/版本/作者/类型（列全 11 枚举中文对照）/一句话描述/
  测试情况勾选（装/基本功能/设置持久化）+ 提醒「handoff.json 与本描述一致」。
  枚举对照表：tool=工具 skill=技能 docs-and-rendering=文档与渲染
  vision-and-multimodal=视觉与多模态 voice-and-audio=语音与音频 memory=记忆
  workflow-and-automation=工作流与自动化 git-and-code-review=Git与代码审查
  interface-ui=界面与UI browser-and-network=浏览器与网络 other=其他
- `tools/company-catalog/lib/verify-handoff.mjs`（或同目录实现文件，rg 定位）—
  schema 校验消费者：确认它加载 schema.json 做校验（新增字段自动覆盖）；**核查**
  schemaVersion 是否有硬编码 '1' 断言，有则同步 v2；错误信息里给中英提示
  「handoff contract v2 requires plugin.author/description/type」。
- `tools/company-catalog/docs/handoff/SOP.zh.md` — 契约字段清单处补一行三新字段。
- 测试家：`tools/company-catalog/tests/`（rg verify-handoff / handoff schema 相关
  spec；161+ 基线）。

## 3. Conventions & constraints

- schema $id 已指向新实例（http://10.173.59.30:9080/pluginpuller/…），别动。
- 枚举值一律上面给的英文 slug，模板/文档里才出现中文对照。
- verify-handoff 错误路径 fail-closed 语义不变；只收紧不放松。
- vitest+typecheck 双跑（worker 长命令 timeout）；单 commit 不 push。
- 不碰 deepseek-harness/ 子模块、不碰 staging、不动 GitLab（push 由 orchestrator 做）。

## 4. Decisions made & failed attempts

- 不造第二份 metadata JSON——两份必漂移，闸门已在 handoff.json 上（老板已认可方案）。
- author=string 不校验邮箱（老板拍板）。
- schemaVersion v2 直接强制，无 v1 兼容层（零存量 MR）。
- MR 模板=人读引导，handoff.json=机器闸门，双轨各司其职不重复事实源。

## 5. Acceptance criteria

1. schema v2 生效：v1 文件被拒（错误信息可读）；缺 author/description/type 拒；
   type 非法枚举值拒；合法 v2 过。
2. example.handoff.json 通过自身 schema 校验（如有自检测试）。
3. README.zh.md 首页化、MR 模板文件就位（路径 .gitlab/merge_request_templates/
   plugin.md 的 source 副本 + 同步说明）。
4. `corepack yarn workspace dsh-plugin-desktop test:company-catalog` 全绿（报新增数）；
   desktop typecheck 不受影响（纯 catalog 侧改动则可豁免但跑一下无妨）。
5. 报告：文件清单、schema diff 摘要、测试数、任何偏离 brief 的决定。
