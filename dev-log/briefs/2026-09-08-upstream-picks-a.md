# Brief — 上游 A 类摘取（dsh-desktop → fork，2026-09-08）

## 1. Goal & background

上游客户端仓 `anywhere-labs/dsh-desktop`（remote `dsh-desktop`，已 fetch）自 09-02 以来有 87 个非合并提交。盘点分拣后用户拍板摘「A 类」10 个 commit：更新链修复 2 + Windows 小修 4 + 启动性能 3 + 渲染器崩溃自动恢复 2。目的：白捡上游的可靠性/性能/打磨，不引入 B 类（Safe Mode、compat 隔离 chrome）和 C 类（profile 架构重构、公网双包基建）的大冲突面。

我们 = 公司 fork（LCorleone/deepseek-harness-desktop），master 上有大量自有锁定层（policy/preset/native-ui/市场/遥测），**绝不能被上游改动冲掉**。

## 2. Code map

- 仓库根 `/opt/july/pi_tasks/deepseek-harness-desktop`；fork remote=`fork`；上游 remote=`dsh-desktop`（master 已 fetch）。
- 冲突高危区（我们改过、上游也改）：`dsh-plugin-desktop/src/main.ts`（声明门/SSO 门/守卫全在）、`src/electron-shell-generation.ts`、`src/profile*.ts`、`src/desktop-policy.ts`、`package.json`。
- 上游 commit 清单（按批）：
  - 批1 热身：`1bddc64eb0`（update 头校验移除）、`e7a7537f8c`（handoff 显示安装器）、`1097fcdea3`（对话框底距）、`05276d3230`（宽表滚动条）、`caeefec7b2`（安装器图标）、`15668197aa`（启动期托盘隐藏窗）
  - 批2 性能：`9b1cdb8e22`（避免重复 profile 准备）、`cdf1d51c22`（resolver 热路径）、`dae8660de3`（选择性 ASAR）+条件前置 `74b8747fb7`（pnpm smart unpack）
  - 批3 崩溃恢复：`62171c6010`（自动恢复渲染器）、`7e21d642e2`（beta 侧同步，**可能只摘适用的那半**）
- 看上游 diff：`git show <sha>`；看上游某文件当时全貌：`git show <sha>:<path>`。

## 3. Conventions & constraints

- 一批一个 commit（`chore(upstream): pick batch N — <一句话>`）；批内每个上游 commit 用 `git cherry-pick -n <sha>` 叠加后统一提交，或手工 apply——按冲突量自选，但**提交信息里列出全部源 SHA**。
- 冲突解原则：**我们的锁定层/门/守卫/policy 永远赢**；上游改动若与其冲突，改写成在我们的结构上等效实现（保留上游意图），并在 commit body 记一句改写原因。
- 上游 commit 里混有 stable/beta 双包基建（`.github/`、`scripts/release*`、双 variant CI）的 hunk **一律丢弃**——我们有自己的发布管线，只摘 `dsh-plugin-desktop/src|tests` 里的产品代码。
- 代码编辑一律 `edit` 工具（oldText 唯一）；bash 只跑命令。
- 长命令（vitest/typecheck）加 `timeout 900`。
- **不要 push**（主会话统一 push）；**不要动 `deepseek-harness/` 子模块**；**不要构建**。
- 完成判据每批：`corepack yarn workspace dsh-plugin-desktop vitest run` 全绿（**基线更新 2026-09-08 18:25：2025 passed + 7 skipped**，boot 后缀修复并入后）+ `corepack yarn workspace dsh-plugin-desktop typecheck` 0 error。若上游 commit 自带新测试，允许 passed 数增加，不允许 fail。

## 4. Decisions made & failed attempts

- 2026-09-08 11:33 盘点定案：A 类=上表 10 commit；B 类（Safe Mode/compat chrome）等上游稳+做整合设计；C 类（profile 重构波/双包基建）不跟。
- `74b8747fb7`（pnpm smart unpack）是否随批2 摘：看 `dae8660de3` 是否依赖它，依赖才带，不依赖不带（少引入一个打包行为变化）。
- `7e21d642e2` 若大半是 beta 适配则只摘对 stable/主线适用的 hunks；摘不动就放弃并在结果里说明（c1 为主件）。
- 上游 stable 的 DSH 运行时=我们的 0.1.1-rc.2，无子模块漂移问题。

## 5. Acceptance criteria

- 批1：6 commit 全进，vitest/typecheck 基线保持，diff 复核每笔只动声称面（无 .github/双包 hunk 混入）。
- 批2：3（或 4）commit 全进，同上；且 `yarn check`（全仓门禁）跑通。
- 批3：2（或 1）commit 全进，同上；报告里给出「杀渲染进程→窗口自动回来」的真机验证步骤清单（主会话安排真机验）。
- 全程零子模块变更、零 push、零构建。
