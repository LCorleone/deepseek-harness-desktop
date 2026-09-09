# Brief — 市场「已安装插件」清单卡死降级修复（2026-09-09 晚，回填）

## 1. Goal & background（目标与背景）

同事手工删了 `profiles\desktop` 目录后，市场「已安装插件」列表永久报错。链路：市场回执仍留在 home `settings.yaml` 台账 → profile 目录空、缺 `pnpm-lock.yaml` → `listVerifiedReceipts` 加载 profile 快照抛错 → 转成 `MarketInstallError('operation-failed')` → 路由 500 → 列表永久报错，重启不清。

目标三件：①一条残留回执不得钉死整个列表；②真失败要有诊断日志；③boot 在「无 profile manifest」时主动清残留回执。

## 2. Code map（代码地图）

- `dsh-community-market/src/install/service.ts:1050` `listVerifiedReceipts`：`loadInstalledProfileSnapshot` 失败时 `catch` → `console.warn`（含 profile 名与 cause）+ `return []`（降级空列表），不再抛 `operation-failed`。
- `dsh-community-market/src/host/routes.ts:136` `installFailureDetail`（message + 前 3 帧栈）；`:142` `sendInstallError(res, cause, logger)` 在非 `MarketInstallError` 兜底 500 前 `logger.error(...)`；列表路由 `:1183` 等全部调用点传 `ctx.logger`。
- `dsh-plugin-desktop/src/fresh-profile.ts:416` `clearFreshProfileRecordReceipts`：仅 `profileExists=false` 才调用 `clearMarketInstallReceipts`（`:360`），失败 log + 吞（不阻塞 boot）。
- `dsh-plugin-desktop/src/main.ts:1209` `profileExists = existsSync(join(activeProfileDir,'package.json'))`；`:1230-1243` `record` 分支调用清理。
- 测试：`dsh-community-market/tests/market-install.spec.ts`（降级用例）、`dsh-plugin-desktop/tests/fresh-profile.spec.ts`、`dsh-plugin-desktop/tests/fresh-profile-wiring.spec.ts`。

## 3. Conventions & constraints（约定与约束）

- 降级口径：快照读不到 = 「没有可验证的已安装件」，返回空列表；只 warning，不报错、不抛。
- 清理的闸是**启动时 profile manifest 是否存在**（`profileExists=false`），不是 decision 字符串——version 规则对仍有 manifest 的 profile 也返回 `record`，此时清回执会隐藏真实安装。
- 回执清理在 settings 文档写锁内做原子读改写，失败 log + 吞；市场本体零 desktop import（架构门禁）。
- 兜底 500 只加日志，不改错误码/文案契约。

## 4. Decisions made & failed attempts（已做决策与失败尝试）

- 曾把「读不到 profile 快照」当致命错误（抛 `operation-failed`）→ **否决**：回执寿命长于 profile，手工删目录是合法用户操作，一条残留不该钉死列表。
- 不在市场侧静默删除回执（信任数据；跨 profile 台账由 desktop boot 清理更合适）；不按 decision 字符串清理（会误清真实安装）。
- 日志用 `console.warn`（market 侧）/ `logger.error`（路由兜底），保持失败可见但不阻塞。

## 5. Acceptance criteria（验收标准）

- profile 目录被手工删/无 lockfile：市场「已安装插件」返回空列表 + 一条 warning，不再 500。
- 非 `MarketInstallError` 的 500 在打包态日志含 cause + 栈帧摘要。
- boot `record` 分支且 `profileExists=false` → 残留回执被清（条数入日志）；`profileExists=true` → 一条不清。
- 现有安装/校验/回滚语义不变；desktop/market 测试全绿。
