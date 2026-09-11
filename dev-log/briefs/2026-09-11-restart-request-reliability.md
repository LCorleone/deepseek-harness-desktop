# Brief: 「立即重启」可靠性修复（2026-09-11，b91 真机反馈）

## 1. Goal & background

真机（b91）：卸载 beta 插件 `dsh-dai-engramory` 后，成功弹窗点「立即重启」失败，UI 报
`DSH Desktop could not be restarted. Restart it manually when convenient.`；手动重启正常；**日志零错误行**。

侦察（scout）确认的代码事实：
- 卸载/安装**不会**换代市场宿主（只有 Host 拆除才会），所以「旧 token 被换代清掉」不成立。
- 一次性重启授权存在两处、都只活在单代进程内存：路由 `desktopPluginRestartTokens`（5 分钟 TTL，
  `dsh-community-market/src/host/routes.ts:1393`/`1428-1435`/`1461`）+ 安装服务 `restartIntents`
  （`src/install/service.ts:1020`/`1458-1467`/TTL `:28`）。
- 首次被接受的 POST 会**消耗** token 并回 200；客户端无成功反馈、按钮回到「立即重启」；
  桌面侧一旦 latch（`dsh-plugin-desktop/src/main.ts:606-613` `if (restartRequested) return`）
  后续请求被**静默忽略** ⇒ 第二次点击必然 410 `intent-expired` → 通用报错。
- 另一处真隐患：关机链 5s 上限（`dsh-plugin-desktop/src/shutdown.ts` `DESKTOP_SHUTDOWN_TIMEOUT_MS`），
  超时走 `exitOnce(failureCode=1)`，而 `createDesktopExitCoordinator.finish(code)` **只在 code===0 时 relaunch**
  ⇒ 请求过重启但 teardown 超时 = 应用退出且**不回来**。

无法从日志区分具体分支（405 `mutationAllowed` / 400 `asRestartToken` / 410 `intent-expired` / 静默 latch），
因此本卡按「整个失败类」防御性修复，并补一条可诊断日志。

## 2. Code map（HEAD `617597bbb9`，行号近似）

- `dsh-community-market/src/host/routes.ts:1412-1455` 重启路由：`mutationAllowed` → `purgeDesktopTokens()`
  → `desktopPluginRestartTokens.delete(token)`，未命中则 `install.consumeRestartToken(token)`
  → 先回 200，再 `actions.requestRestart()`（失败只 log）
- `dsh-community-market/src/install/service.ts:1450-1453` 操作结果为 install/uninstall 都 `issueRestartToken()`；
  `:1458-1467` `consumeRestartToken`（未命中抛 `intent-expired`）；`:1020` 内存表；`:1745-1758` 惰性 purge
- `dsh-community-market/src/client/MarketSettingsTab.tsx:983-1003` `runDesktopAction`（任何非 2xx/抛错 → `restartError`）；
  `:2083-2089` 弹窗按钮（无「重启中」持久态）
- `dsh-plugin-desktop/src/main.ts:606-613` 重启 latch（`restartRequested`）；`:2103-2106` `DesktopActionsService`
- `dsh-plugin-desktop/src/desktop-actions.ts:36-52` `requestRestart` 去重（`restartCompleted`/`restartOperation`）
- `dsh-plugin-desktop/src/shutdown.ts` 关机控制器 + exit 协调器（超时/relaunch 语义）
- 测试：`dsh-community-market/tests/market-install.spec.ts:1554-1615,1700-1800`、
  `market-settings-tab.spec.tsx:831-862`、`market-host-lifecycle.spec.ts:125-150`；
  `dsh-plugin-desktop/tests/*shutdown*`（若有）

## 3. 修复范围（四条，按风险从低到高）

1. **可诊断**：重启请求的每个分支都 log 一行（含 token 命中/未命中、`mutationAllowed` 拒绝、
   `intent-expired`、以及桌面侧 latch 命中），保持隐私口径（不回 token 原文，只回状态）。
2. **幂等**：已接受过重启请求时，后续 POST 回 **200 + `{ ok: true, alreadyRequested: true }`**
   （不是 410）；客户端此时保持「正在重启…」禁用态，不再报 `restartError`。
   仍是一次性授权语义：token 被消耗后不允许「新授权」，只承认「同一台机器上已在进行中的重启」。
3. **latch 可升级**：`main.ts` 的 `if (restartRequested) return` 改为**再次调用 `shutdown.request(0)`**
   （`shutdown.ts` 的第二次 request 会立即强制退出），使「第一次没退成」的卡死能被第二次点击推动。
4. **超时不得静默不回来**：请求过 relaunch 时，teardown 超时也必须走 relaunch 路径
   （即超时不能变成「退出且不回来」的 code 1 静默失败；如要保留失败码，需在 relaunch 后再以该码收尾）。
   **这条改的是全局关机语义，务必谨慎 + 明确测试。**

## 4. Decisions & non-goals

- 不采用「把 token 持久化到磁盘」：本卡已证明换代不是原因，持久化只扩大授权面。
- 不做「无 token 也能重启」：一次性授权语义保留（本卡只让「重复点击」与「卡死」变得幂等/可推进）。
- 不改客户端把「请求失败」一律显示为 `restartError` 的映射（除第 2 条的已受理态）。
- 不碰 `deepseek-harness/` 子模块；不碰 `dsh-company-skills/skills/`。

## 5. Acceptance criteria

1. 路由测试：token 首次 POST → 200（既有行为不变）；**同一 token 第二次 POST → 200 + `alreadyRequested`**
   （旧行为 410），且桌面侧动作只被触发一次（不重复 shutdown）。
2. 路由测试：token 从未知/过期 + 无进行中重启 → 仍非 200（保持 fail-closed），并留下诊断日志。
3. 桌面测试：`restartRequested` 已置位时再次请求 → 调用 `shutdown.request(0)`（第二次 request 立即强制退出）
   —— 用假 shutdown 断言「被调用两次」。
4. 关机测试：请求过 relaunch 且 teardown 超时 → **仍然 relaunch**（断言 `relaunch()` 被调用、exit 码符合设计）。
5. 客户端测试：已受理态下按钮保持「重启中…」禁用且**不**显示 `restartError`。
6. `corepack yarn workspace dsh-community-market test` + `corepack yarn workspace dsh-plugin-desktop test` +
   `corepack yarn typecheck` 全绿；报告改动文件、AC→测试名映射。不 commit。
