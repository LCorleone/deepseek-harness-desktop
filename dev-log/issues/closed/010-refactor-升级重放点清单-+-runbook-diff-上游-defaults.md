# [Refactor] #010 升级重放点清单 + runbook「diff 上游 defaults」步骤（文档-only）

**Issue ID**: #010
**Status**: Closed ✅
**Priority**: Medium
**Type**: refactor
**Created**: 2026-09-12
**Updated**: 2026-09-15
**Closed**: 2026-09-15
**Labels**: refactor, docs

---

## 任务简报

### 目标与背景
09-10 全面评审 P2-3 发现：升级重放点清单定格在 2026-09-02，未含其后新增接缝——下次 0.1.5 升级专项（#005，8-12 批）按失真清单估算会漏接缝。同时隐式耦合无系统性守卫（includeShippedRoot 事故=上游 zod 默认值翻转穿透补丁面，靠一次性人工核查发现）。

**July 2026-09-15 拍板：只更新文档，不改代码。**

要做两件事：
1. 新建活文档 `dev-log/upstream-upgrade-replay-checklist.md`：完整重放点清单（补齐 P2-3 列出的全部缺失项）+ Step 0「升级前 diff 上游 defaults/接触面」固化程序（动机案例=includeShippedRoot 事故）。
2. `dev-log/2026-08-22-company-market-lockdown-plan-v2.md` 旧估算段（「升级工作量估算（2026-09-02 定…）」处）加一行指向新活文档，注明清单已迁移、以活文档为准。

### Code Map
- 评审原文：`dev-log/reviews/2026-09-10-comprehensive-review-arch.md` P2-3（约 :30-31）——缺失项清单的权威来源
- 旧清单位置：`dev-log/2026-08-22-company-market-lockdown-plan-v2.md`（约 :233 起「升级工作量估算」段）
- 各接缝文件锚点（用 rg 验证后写入，别凭印象）：
  - P11 捆绑 Python：`dsh-plugin-desktop/src/desktop-shared-python-environment.ts`、`dsh-plugin-desktop/scripts/` 下 beforePack/afterPack/digest 门禁
  - P14 generation/pending marker：`dsh-plugin-desktop/src/fresh-profile.ts`（generation 记录 / `fresh-profile-pending.json`）
  - P15 boot 分类 + runtime 谓词：`dsh-plugin-desktop/src/desktop-build-version.ts`、相关 parity 测试
  - P16 pwsh 适配器 + dsh-pip 事前闸：`dsh-plugin-desktop/src/windows-pwsh-sandbox.ts`
  - P6 skills provider：`dsh-company-skills/src/`（`inject(['skills'])` / registerProvider 接缝）
  - P7 tarball 通道：`tools/company-catalog/lib/tarball.mjs`、安装链路
  - P9 beta overlay：`dsh-plugin-desktop/src/cli-install-channel.ts`
  - dshmarket 1.17.1 兼容复验：`dsh-plugin-desktop/src/desktop-market.ts`
- Step 0 动机案例：includeShippedRoot 事故（2026-09-08 教训，事故台账/`dev-log/briefs/2026-09-08-*.md` 可引）

### 约束
- 文档 only，零代码改动。
- 清单条目格式：接缝 × 位置（file:line 或 file）× 升级时要重放/复验的动作 × 已有守卫测试（有则记，无则明确写「无守卫」）。
- 不重排 lockdown-plan-v2 既有内容，只加迁移指向；活文档开头注明「随每次接缝新增更新本清单」。

### 验收标准
- [ ] 新活文档含 P2-3 全部 8 类缺失项，每项有验证过的文件锚点
- [ ] Step 0 程序成文（含 includeShippedRoot 案例）
- [ ] 旧文档有迁移指向行
- [ ] 无代码改动

## 解决总结

文档-only 完成（2026-09-15）：活文档 dev-log/upstream-upgrade-replay-checklist.md 落地——P2-3 全部 8 类接缝（锚点逐一 rg 验证，含 4 处纠偏：parity 脚本在仓根/desktop-pip-gate.ts 独立文件/dshmarket 档案位置/includeShippedRoot 档案行号）+ Step 0 diff 上游 defaults 五步程序（includeShippedRoot 动机案例）+ 维护规则；plan-v2:233 加迁移指向行。
