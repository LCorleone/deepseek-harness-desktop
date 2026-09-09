# Agent Note：全新 Profile 换新（P14）——版本变更自动重置与恢复窗手动动作

[English](2026-09-09-fresh-profile-swap.md)

状态：**已实现**（提交链 `27af02223a` 实现 → `a06a83e0b7`/`6180184964`
评审修复 → `39a6ff6bc4`/`7fcd67b9a7` Windows EBUSY → `75b604bced` 版本分级
→ `e7f515da08` 撤销内容搬移并修复复审发现）。本 note 记录唯一的重建原语、
触发规则、deferred 语义、市场回执清理、被否决方案，以及三种结果的验证方式。

## 问题

桌面 Profile 会跨构建累积第三方插件。当构建身份变化——尤其是当某构建携带
DSH runtime 升级时——一套按旧 runtime 组合出的 Profile 插件集可能横跨两个
构建：一个安装器将服务一个插件集混杂的 fleet。既有 profile 机制只在 profile
之间做**选择**（见 `2026-08-15-desktop-profile-management.md`），从不重建某
一个 profile。而一次没有构建身份变化的问题安装同样无路可走，除非手工删除
Profile 目录——而这是不受支持的（见残余风险登记表 R9）。Windows 上还有第二
个约束：只要有任何进程持有目录树内的句柄，OS 就拒绝目录改名，因此以改名为
第一步的重建可能被外部瞬时锁挡住。

## 决策：两层共用一个重建原语

`freshProfileSwap`（`dsh-plugin-desktop/src/fresh-profile.ts:631`）是唯一的
原语；自动层与恢复窗手动动作都经同一个 `runFreshProfileSwap` 包装器
（`main.ts:1034`）调用它。一次换新：

1. 把当前 Profile 目录靠边改名为 `profiles/<名>.bak-<UTC 时间戳>`
   （`profileBackupPath`，`fresh-profile.ts:343`）——从不删除，供取证与手工
   回滚；
2. 通过出厂首次运行机制（`ensureDesktopProfile` / `createDesktopWebProfile`）
   重建该 Profile；
3. 使该 Profile 的健康检查点失效（检查点按 Profile **路径** 键控，而换新
   不改变路径，否则下一次启动失败会把旧快照恢复进重建后的树）；
4. 清掉该 Profile 的市场安装回执；
5. 做一次依赖同步（`pnpm install --frozen-lockfile`）。

不跑任何包管理器手术：对受损树跑 `pnpm remove` 正是本模块要避开的脆弱路径。

靠边目录有上限：`pruneProfileBackups`（`fresh-profile.ts:589`）每个 Profile
保留最新 `MAX_PROFILE_BACKUPS = 2`（`fresh-profile.ts:59`）份，更旧的由
一个与换新解耦的任务尽力删除——数百 MB 的删除绝不能拖慢催生它的启动路径。

## 触发规则（自动层）

自动层在启动时、SSO 与声明窗之后、host boot 之前运行：决策块位于
`profile-selection` 阶段（`main.ts:916`），host boot 起于 `main.ts:1704`。
deferred 标记的读取更早（`main.ts:808`），早于 pnpm runtime 安装、早于任何
Profile 或选择文件被打开。

`freshProfileResetDecision`（`fresh-profile.ts:307`）逐启动决策：

| 条件 | 决策 |
|---|---|
| 策略未锁定 | `unchanged`——逐字节相同的行为；连记录都不写 |
| `pluginResetOnVersionChange` **true**（携带 DSH-base 升级的构建） | 比对**全量构建身份**；任何变化（`2.0.3+b78` → `2.0.3+b79`）都重置 |
| `pluginResetOnVersionChange` **false**（默认，2.0.4 起） | 只比对**产品版本基号**；构建号变化保留 Profile，`2.0.3` → `2.0.4` 重置 |
| 无记录 + 强制规则 | 有 Profile manifest 则重置，没有则记录（真正的全新安装） |
| 无记录 + 版本规则 | 记录——这是首次观测而非横跨（开关关闭的构建此前从不写记录） |
| 已记录的产品版本不同 | 重置（即使没有 manifest——记录证明另一个构建管理过这个 home） |

记录文件是 Desktop user-data 目录下的 `last-profile-generation.json`
（`profileGenerationStatePath`，`fresh-profile.ts:128`），同时携带
`appVersion` 与 `appBuildVersion`。`appVersion` 字段出现前写下的旧记录经
`buildVersionProductBase`（`fresh-profile.ts:108`）剥掉 `+bNNN` 后缀读回，
因此旧记录仍是有效记录，无需 schema 升级。

## Deferred 语义（Windows EBUSY）

以 `EBUSY`/`EPERM`/`ENOTEMPTY`/`EACCES` 被拒的 `renameSync` 会按六步退避
重试——100/200/400/800/1600/3200 ms，共约 6.3 s（`RENAME_RETRY_DELAYS_MS`，
`fresh-profile.ts:72`）。若每一步都被拒，换新**不失败**，而是返回 deferred
结果，桌面：

- 在 userData 写 `fresh-profile-pending.json`；
- 上报 `plugin_reset.outcome=deferred`；
- **不写构建身份记录**，因此版本变更保持 pending；
- 继续启动现有 Profile。

下次启动会在最早时刻重试改名，早于任何组件打开 Profile；当本次启动没有可用的
声明窗时，会为等待过程持一个可见的加载面（`main.ts:1169-1188`）。若标记指向的
Profile 本次启动并非激活项，则**保留**标记并跳过重试——丢弃它会永久失去这次
待重建，因为 deferred 路径从未记录被标记 Profile 的身份。只有策略未锁定时才
丢弃标记，因为未锁定构建永远无法执行重建（`freshProfilePendingAction`，
`fresh-profile.ts:270`）。手动恢复窗把 deferred 结果呈现为「重建已排队、重启
后自动完成」，而不是让用户再按一次按钮去「修」的失败（`main.ts:1691`）。

**根因已实证**：该锁是外部进程持有 Profile 内的目录句柄。用户编辑器打开
Profile 内文件会对目录持 watcher 句柄：子项逐个可改、目录本身不可改。这正
是 Linux 测试全绿而同一份代码在 Windows 失败的原因。

## 市场安装回执

换新会从共享的 home `settings.yaml` 中清掉被换 Profile 自己的回执
（`clearMarketInstallReceipts`，`fresh-profile.ts:360`）。回执账本是 home
级、且每条回执都标明所属 Profile，因此只清本 Profile 的回执既能让其目录条目
回到可安装状态，又不会把兄弟 Profile 的已装 bundle 降级。改动是在文档所有者
的写锁下做 YAML AST 往返，并沿用同一种原子替换提交，所以注释与其它设置全部
保留。

`record` 分支在启动时无 Profile manifest 的情况下清掉残留回执
（`clearFreshProfileRecordReceipts`，`fresh-profile.ts:416`）。这种形态覆盖
真正的全新安装与用户手工删除的 Profile 目录：两者中，任何仍指向该 Profile 的
回执都无法对空目录完成校验，会把市场的已装清单钉死在错误态。此处由
**manifest 事实**把关，而非决策字符串——版本规则对仍有 manifest 与插件的
Profile 也会返回 `record`，在那里清理会掩盖真实安装。失败只记日志并吞掉：
一份写不了的回执账本绝不能阻断启动。

## 验证

- 遥测：`plugin_reset {trigger, profileName, outcome, materialized,
  receiptsCleared, rule}`（`client-event-reporter.ts:643`），其中 `trigger`
  为 `version-change` 或 `recovery-window`，`outcome` 为 `swapped`、
  `failed` 或 `deferred`；`rule` 为 `forced` 或 `version`，手动动作时省略。
- 三种结果（`swapped`/`failed`/`deferred`）均在真机实测，包括促成重试/defer
  路径的 b77 首次触发 `EBUSY` 事故。
- Focused 测试：`fresh-profile.spec.ts`（两种开关的决策规则、记录往返、备份
  命名与保留、写锁下的回执清理）与 `fresh-profile-wiring.spec.ts`（自动层
  的早执行、锁定策略门、标记读取/重试顺序、跨 Profile 标记保留、可见加载面、
  deferred 写标记且不记身份、检查点失效、手动动作 token 守卫、遥测，以及失败
  永不使启动崩溃）。

## 考虑过的替代方案（已否决——勿重走）

**内容级搬移。** 把 Profile 的子项搬进靠边目录，而不是改名目录本身。此方案
已实现，随后按用户决策撤销（`e7f515da08`）：真实场景罕见，且搬空后 live
目录仍然存在，会撞上 `createDesktopWebProfile` 的「已存在」检查
（`profile-manager.ts:220`）。

**`pnpm remove` 手术式清理。** 早期实证表明它脆弱——缺失的 tarball 会以
`ENOENT` 中断。这正是本模块要避开的路径。

**junction 重指向。** 同一个目录句柄锁同样限制改名，因此重指 junction 并不能
消除该失败模式。

## 结果

一个安装器现在服务一个插件集永不横跨两个构建的 fleet，回滚也会落到干净的树。
Windows 目录锁降级为一次启动的延迟而非升级失败，且版本变更保持 pending 直到
重试落地。Launcher 增加一份持久化的 generation 记录、一个 deferred 标记、
一组有上限的靠边目录，以及一个由自动层与手动层共用的 Host 侧重建原语。
