# Agent-browser 客户端面样式补齐（B3 遗漏）

## 1. Goal & background
#55 真机 P8 首航成功后用户反馈：对话区横幅（Release / Take over 按钮）位置与观感差。
排查确诊：`src/client/agent-browser-ui.tsx` 使用的类名 `dshAgentBrowserBanner*` / `dshAgentBrowserToolCard*` **全仓无任何 CSS 定义**——B3 只写了结构没写样式，横幅以无样式裸 div 渲染（光秃文本+默认按钮悬在输入坞席位上）。本任务补齐样式，不改任何行为逻辑。

## 2. Code map（master 58cb06540c，未提交无）
- `dsh-plugin-desktop/src/client/agent-browser-ui.tsx`（565 行）
  - `AgentBrowserBannerView`（≈L315）：横幅结构。span×3（label/url/meta）+ button（action）。类名：`dshAgentBrowserBanner`（含 `data-phase`）、`…Label/…Url/…Meta/…Action`。
  - `AgentBrowserToolCardView`（≈L483）：工具卡。类名 `dshAgentBrowserToolCard`（含 `data-failed`）、`…Label/…Url/…Detail`。
  - 注册席位：横幅=`conversation.input.dock`（list 席，InputZone，位于输入框上方条带）；工具卡=`tool.call.toolview`。
- `dsh-plugin-desktop/src/client/styles.ts`：**样式惯例**——纯字符串 CSS（`ADVANCED_STYLES`），自包含进 client bundle。用上游设计令牌 `var(--dsw-alias-border-l1)` 等（见 `dshDesktopSidebarSurface` 一段）。需查清该字符串如何注入 DOM（AdvancedShell？两者模式是否都覆盖——compatibility 模式（上游原版 client 直跑）也会渲染这些席位，样式注入必须在两种模式下都生效；若现注入点只在 advanced shell，需为横幅样式找到双模式可达的注入点——查 `styles.ts` 的消费方与 `src/advanced-shell.ts`）。
- 参考：`src/client/desktop-settings-styles.ts`（另一份样式字符串先例，看它如何注入）。

## 3. Conventions & constraints
- 纯呈现层改动：**不改** SSE/claim/release/parse 任何逻辑、类名、data-* 属性、DOM 结构（除非样式确需微调包裹层——保持最小）。
- 样式走设计令牌（`--dsw-alias-*`/`--ds-*` 等 styles.ts 已用前缀），自动适配明暗主题；禁硬编码色值。
- 视觉目标：横幅=输入框上方一条**低调单行 pill**（圆角、细边框、小号 url 用 mono、右侧 ghost 风格动作按钮、phase 用弱化文本）；工具卡=同样克制的紧凑行。与上游对话 UI 视觉语言一致（不抢输入框焦点）。`data-phase=claimed` 时动作按钮可给轻微强调色。
- 保持零 Node globals 门禁合规（纯 CSS 字符串无碍）。

## 4. Decisions & failed attempts
- 无先例可抄（这两组类名从无样式）。styles.ts 与 desktop-settings-styles.ts 是仅有的两个注入先例——先读注入机制再动笔。

## 5. Acceptance criteria
- `corepack yarn check` 全绿（基线 1826+7skip；静态渲染 spec 若断言类名/结构应零改动通过）。
- 横幅与工具卡在两种 shell 模式下都有样式（说明注入路径如何覆盖，写在 PR 描述）。
- 单 commit：`feat(desktop): style the agent-browser banner and tool cards`，不 push。
