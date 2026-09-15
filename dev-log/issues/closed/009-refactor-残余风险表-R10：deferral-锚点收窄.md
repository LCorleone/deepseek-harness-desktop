# [Refactor] #009 残余风险表 R10：deferral 锚点收窄（文档-only）

**Issue ID**: #009
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
09-10 全面评审 P2-2 发现：boot 校验的 deferral 路径（client-update-required 窗口）信任锚是用户可写 settings 里的 `receipt.rootDigest`，而非常规路径的签名 manifest treeDigest。本地写者可「改插件树 + 照文档算法重算摘要 + 改回执」三步伪造，让篡改插件通过 boot 校验。这实质窄化了 v2 计划承重决策「receipt 永不作放行依据」，但该后果从未进残余风险签收表。

**July 2026-09-15 拍板：只更新文档，不改代码。**

### Code Map
- 双语签收表（要改的两个文件）：
  - `.agents/notes/implemented/architecture/2026-08-22-residual-risk-acceptance.md`（英文，"Residual risk register" 节，现有 R1–R9，R3/R8 行是风格锚点）
  - `.agents/notes/implemented/architecture/2026-08-22-residual-risk-acceptance.zh.md`（中文孪生，必须同步）
- 评审原文：`dev-log/reviews/2026-09-10-comprehensive-review-arch.md` P2-2（约 :27-28）
- 代码事实（只引用不改）：`dsh-plugin-desktop/src/boot-verification.ts:92-110`（deferral 文档）、`:679-703`（receipt 仅形状校验）

### 约束
- 表格列格式严格对齐现有 R 行（`| # | Risk | Exposure | Mitigation status |`），编号 R10。
- 内容必须覆盖：①锚点差异（签名 manifest treeDigest vs 用户可写 receipt.rootDigest）②攻击=本地写者三步伪造③后果=篡改插件在 deferral 窗口内可通过 boot 校验④缓解现状=窗口窄 + P4-2 检测锚（report absence / content comparison）仍生效⑤可选项记档：「回执根摘要镜像到 Desktop-private 追加文件」已评估、按文档-only 决定未实施，诚实标注仍非密码学锚。
- zh 与 en 两份语义一致；不改代码、不动 sign-off 表、不动 R1–R9。

### 验收标准
- [ ] 两份表各新增 R10 行，内容互相对齐
- [ ] 上述 5 个覆盖点齐全
- [ ] 无代码改动（`git status` 仅这两个 .md）

## 解决总结

文档-only 完成（2026-09-15）：R10 行补进双语签收表——锚点差异/三步伪造/窗口精确条件（仅条目离 manifest 且无兼容同名时开启，无回执 fail-closed，revoked 仍拒载）/P4-2 检测锚仍生效/镜像加固记档未实施（非密码学锚）。worker 执行，July 口令「只更新文档不改代码」。
