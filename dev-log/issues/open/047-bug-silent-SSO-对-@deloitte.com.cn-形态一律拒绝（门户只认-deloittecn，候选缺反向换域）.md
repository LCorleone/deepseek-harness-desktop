# [Bug] #047 silent SSO 对 @deloitte.com.cn 形态一律拒绝（门户只认 deloittecn，候选缺反向换域）

**Issue ID**: #047
**Status**: Open
**Priority**: Medium
**Type**: bug
**Created**: 2026-09-17
**Updated**: 2026-09-17
**Assignee**: Unassigned
**Labels**: bug

---

## 描述

**现象（2026-09-17 10:34，用户反馈）**：liamzhong 报「静默 SSO 不生效，每次都弹窗」。遥测实证（09-08 全量）：
- silent 成功者（sebtang/jackjuzhang/mzhuo/luklu/leoliu/julu）全部 @deloittecn.com.cn UPN
- silent 失败「Invalid username! (code 1000)」→browser 回退：liamzhong(b93)、webhu(b90) 全部 @deloitte.com.cn；sebtang 偶发靴（09-16 13:37/13:39，账号两域属性并存时探测到 .com.cn 形态）
- 域分裂 100% 一致，零例外

**根因**：`company-sso.ts silentSsoLogin` 的 email 候选列表只做单向换域（deloittecn→deloitte，nova canonicalize 方向）。探测到 @deloitte.com.cn 的靴子只有一个候选，而门户 SignEntity 只认 deloittecn 形态账号 → 必拒 → 每靴弹窗。浏览器路径是另一端点，认全局账号，所以弹完能成功。

**修法（July 已裁）**：候选列表双向化——UPN 为 @deloitte.com.cn 时追加 @deloittecn.com.cn 候选重试一次。实证受益人：sebtang 偶发靴（其 deloittecn 形态门户必认）。liamzhong/webhu 取决于门户是否有其 deloittecn 别名（已列 IT 待问项，不阻塞本修）。附带观察：sebtang 09-14 17:44 形态=「no corporate email resolved」（探测瞬态），本卡只观察不修（频度低、browser 兜底在）。

## Code Map
- `dsh-plugin-desktop/src/company-sso.ts`：`silentSsoLogin`（~1140-1200，候选循环）、`canonicalizeSsoEmail`（~712，单向）
- 测试：`dsh-plugin-desktop/tests/company-sso.spec.ts`
- 遥测事件：sso_login{result,mode,reason}——成功行带 user_email=最终采纳的候选

## 约束
- 双向候选各至多一次 POST，总预算不变（6s silent 门）
- 成功后 session.email=被门户采纳的候选（现状语义）；遥测 user_email 反映真实采纳形态
- 不改 canonicalizeSsoEmail 的方向（browser 路径会话规范化依赖它）；只扩 silentSsoLogin 的候选数组
- 候选顺序：UPN 原形优先，反向换域第二（与现有 raw→canonical 顺序一致）
- 不碰浏览器路径/门户协议/子模块

## 验收标准
1. UPN=deloittecn：行为不变（raw→deloitte 两候选，测试钉死现有顺序）
2. UPN=deloitte.com.cn：候选=[原形, deloittecn 换域]；第一个拒、第二个过 → silent 成功，session.email=deloittecn 形态
3. 两候选全拒 → 原因=最后一次失败（现状语义），browser 兜底不受影响
4. 失败路径 warn sink 逐候选记录（现有行为，测试覆盖两候选两条 warn）
5. company-sso.spec 全绿 + desktop 全套 + typecheck

[详细描述 Bug 的具体表现]

## 复现步骤

1. 步骤 1
2. 步骤 2
3. 步骤 3

## 期望行为

[描述期望的正确行为]

## 实际行为

[描述当前的实际行为]

## 环境信息

- **OS**: Linux / macOS / Windows
- **运行时/语言版本**: `<runtime> --version`（按项目实际填写，如 `python3 --version`、`node --version`、`rustc --version`）
- **相关依赖版本**:

## 根本原因

[分析问题的根本原因]

## 解决方案

[提出的解决方案]

### 技术方案

[详细的技术实现方案]

## 相关文件

- `path/to/file1.rs`
- `path/to/file2.rs`

## 相关 Issue

- Blocks: #XXX
- Blocked by: #XXX
- Related: #XXX

## 进展记录

### 2026-09-17 HH:MM
- [ ] 分析问题根本原因
- [ ] 设计解决方案
- [ ] 实现代码修复
- [ ] 编写单元测试
- [ ] 更新文档
- 立卡（2026-09-17 10:42，July 裁定立卡修）。worker 待派——注意 worker-046-publish 仍在跑（#046 发布轮），两个 worker 并行不冲突（不同文件面）。
- worker 完成（2026-09-17 10:50，a52b903b，30 工具调用，未提交）：新增导出 silentSsoEmailCandidates（canonical 后追加 deloitte→deloittecn 反向换域，大小写不敏感去重，raw 优先）+ silentSsoLogin 候选循环改用之 + 测试 5 形态（deloittecn 行为不变/.com.cn 双候选第二过/双拒语义+两 warn/第三域单候选/大小写去重）共 +166 行。门禁：company-sso 72 绿+1skip、tc 0。→ reviewer 待派。
- reviewer APPROVED（206eff56，2026-09-17 10:58）：六项全过（deloittecn 字节级不变/.com.cn 双候选+session.email=采纳形/边界形状/预算不变=结构性上限 2 候选/无消费者破坏+遥测语义保持/门禁绿）。P3=corrupt-blob spec 归属 #047 提交（已照办）。全绿：SSO 77+1skip、tc 0、desktop 全套。commit 中，随 b104 出厂。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
