# Brief — 声明窗同意后变身加载页（消除首启空窗，2026-09-08）

## 1. Goal & background

用户报：首次启动双击→声明窗→点同意→**一切消失**→长空窗（内网代理+证书解析几秒；首启 profile 创建 pnpm 10-30s+）→主窗才出。用户以为客户端挂了。#66/#68 已修「同意后进程静默退出」，本卡修**观感空窗**：同意后声明窗不销毁，原地变身「正在启动」加载态，直到后继可见窗口出现才销毁。

## 2. Code map（HEAD=8fea1ac6e4，fork=backup 已同步）

- `dsh-plugin-desktop/src/disclaimer-window.ts`：DesktopDisclaimerWindow——agree/disagree 均 settlement 即 destroy（~140 注释、195-211 IPC→finish→destroy→closed 清理）。**改造点：agree 不再 destroy，进入 loading 态；新增 dispose 信号**。disagree 语义不变（拒绝=退出）。
- `dsh-plugin-desktop/src/main.ts`：`runDisclaimerGate`（~690-710）await 返回 'agreed' 后跑长链（shell env→corporate env→cache 恢复→卷诊断→…→shell schedule→主窗）。**改造点：拿住 loading 窗实例，在后继面出现时 dispose**。
- 后继面（首个出现者销毁 loading）：
  - 主窗 ready-to-show：`electron-shell-generation.ts`（shell 挂载/generation，找现有 ready/shown 回调——renderer boot 监控在 electron-runtime.ts beginRendererBootMonitoring 一带）
  - `startup-recovery-window.ts`（启动失败恢复窗创建点）
  - `profile-create-window.ts`（首启 profile 创建窗创建点）
  - `sso-gate-window.ts`（SSO 登录窗创建点——静默路径无窗不算）
  - 简化实现允许：一个 `disposeDisclaimerLoading()` 幂等函数+各创建点调用一行；或事件聚合。取侵入最小者。
- 渲染端：`src/native-ui/disclaimer.html` + `disclaimer/App.tsx`（React 18.3.1，#root 静态兜底基建在——noscript+加载异常纯文本）。**加 starting 态**：点同意→本地状态切 starting（不等 IPC 往返）：按钮区隐藏、转圈+文案（zh/en 双语，i18n hash 机制照 README.i18n.yaml 先例若涉及文档改动；本次纯 UI 文案走 App.tsx 内嵌 locale 结构，沿用现有文案模式）。静态兜底文本加一句「同意后应用正在启动」语义（防 starting 态渲染死亡时窗口纯白）。
- 关窗语义：loading 态用户点 X=只关窗不退进程（#66 window-lifetime 守卫已保证）；可保留窗口 closable。closed 清理路径已有（211 行）确保 dispose 信号晚到安全。
- 遥测：disclaimer agree 事件语义零变化（reportDecision 时序不动）。

## 3. Conventions & constraints

- **不改**：disagree/Escape=拒绝退出语义、声明文本/哈希、gate 持久化（disclaimer-ack.json）、#66 守卫、renderer boot 健康门。
- 用户点关 loading 窗后主窗稍后自出=接受行为（后台继续 boot）。
- edit 工具改码；vitest/typecheck `timeout 900`；desktop 全量基线 **2050 passed + 7 skipped**；不 push、不构建、不动子模块。
- 一个 commit：`feat(desktop): disclaimer window becomes a startup loading surface after agree`。

## 4. Decisions made & failed attempts

- 复用声明窗=不新开 splash 窗（零新窗口基建、零新关闭竞态面）。
- 首个后继可见面销毁（主窗/recovery/profile-create/sso-gate），不是定时器。
- starting 态由渲染端本地切换（点击即反馈，不等 IPC）——IPC 'agree' 照发，主进程 finish() 返回后 main 侧不 destroy。
- 静默 SSO 无窗路径：loading 窗继续活到主窗（正确，中间没有可见面）。

## 5. Acceptance criteria

- 红绿证：改前「同意即 destroy」断言红→改后 loading 态持有+dispose 信号测试绿；各后继面触发 dispose 有测试（mock 窗口创建点调用）。
- 渲染端：starting 态切换测试（jsdom 点击→按钮消失→加载文案出现）；静态兜底含启动语义文本。
- vitest 全绿 2050+7skip 之上只增不减 + typecheck 0。
- 报告含真机验证步骤：清 ack 首启→同意→加载窗持续→主窗出瞬间加载窗消失；首启慢链路（profile 创建）期间窗口不白不消失。
