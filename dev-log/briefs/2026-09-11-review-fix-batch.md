# 2026-09-11 · 综合评审修复批（P1+P2 联动 + 4×P3）

## 1. Goal & background
23:00 三路综合评审（arch/logic/upstream，报告在 dev-log/reviews/2026-09-10-comprehensive-review-*.md，含文件:行号证据）发现 1×P1+1×P2+5×P3。本批修代码类全部六项。上游参考面（0.1.5 路线）不在本批。

## 2. 修复项（证据详见两份报告）
1. **P1 换新不清安装恢复 WAL**（arch P1-1 = logic §1 P1）：`main.ts:1316/1355`（自动换新）、`main.ts:1846` 一带（恢复窗手动换新）成功路径不清 `install-recovery` WAL；`fresh-profile.ts:676-743` swap 只清 checkpoint+回执。场景：装插件→WAL 密封 awaiting-restart→不重启先升级→换新重建 profile（profileIdentity=路径哈希，WAL 仍匹配）→首启失败→restore 失配→manual-recovery-required→永久拒启砖。**修**：两处 swap 成功后清空/宣告满足绑定该 profile 的 WAL（注意与 beginLocked 的相位语义对齐，别造成「真待恢复事务被误清」——按 profileIdentity 匹配+相位白名单）；补集成测试「swap 时存在 awaiting-restart WAL → swap 后 claim 不进恢复窗」+「真待恢复相位不被自动换新误清的负例（若适用则论证）」。
2. **P2 anti-rollback 地板回执派生**（logic §4）：`boot-verification.ts:1288-1291`、`desktop-cli.ts:271-281` 的 lastSeenSequence 源于回执清单，换新清回执→地板归 0；目录侧 company-provider 有持久 sequenceStore 但 boot/CLI 不消费。**修**：boot/CLI 并入持久化 sequence ratchet（复用/对齐 company-provider sequenceStore 或 boot 侧独立持久 floor；与 ① 同一提交落）。测试：清空回执后地板不归 0。
3. **P3 pnpm settle**（logic §5）：`pnpm.ts:885-890` terminate 后不等 reap 即放闸（注释与代码不符）→ terminate 后有界 waitForExit 再放闸；测试补「terminate 后放闸前树已 reap」。
4. **P3 非法回执行瘫痪市场**（logic §1）：`dsh-community-market/src/install/service.ts:1621-1626` 一条非法行令全部读写面 persistence-failed 且无自愈 → 读侧隔离非法行（跳过+warn，对齐「读不到≠报错」姿态）；测试：清单含一条非法行 → 其余回执照常读写，warn 有记录。
5. **P3 孤儿 backupDir**（logic §2）：`install-recovery.ts:369,390` 仅在 state.json 存在且匹配时清扫 → read() 对「state 缺失但 backups 非空」也触发一次有界清扫；测试补该路径。
6. **P3 pyenv 并发互斥**（logic §6）：`desktop-shared-python-environment.ts:250+` 两实例并发 provisioning 无互斥 → userData 侧文件锁（败者等待或降级，行为明确+注释）；测试用注入 clock/lock seam 验互斥。

## 3. 约束
- 不碰 deepseek-harness/ 子模块；edit 工具改码；git add 只加自己文件（共享仓，严禁 git add -A）。
- 分两个 commit：`fix(desktop): settle the install-recovery WAL and the rollback floor on fresh-profile swap (review P1+P2)` 与 `fix(desktop,market): review P3 batch — pnpm reap, receipt-line isolation, orphan backup sweep, pyenv lock`。
- 不 push 不构建；三包测试+catalog 全绿（desktop 2339+8skip / market 467 / skills 70 / catalog 186 基线只增不减）；typecheck 0。

## 4. 验收
- ①② 各有集成/单元测试且变异红（去掉 WAL 清理→红；去掉持久地板→红）。
- ③④⑤⑥ 各有测试钉住新行为。
- 报告 ≤400 字：逐项摘要/测试数/变异证。
