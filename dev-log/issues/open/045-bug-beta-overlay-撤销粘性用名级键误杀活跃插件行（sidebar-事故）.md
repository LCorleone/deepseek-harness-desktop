# [Bug] #045 beta-overlay 撤销粘性用名级键误杀活跃插件行（sidebar 事故）

**Issue ID**: #045
**Status**: Open
**Priority**: Medium
**Type**: bug
**Created**: 2026-09-16
**Updated**: 2026-09-16
**Assignee**: Unassigned
**Labels**: bug

---

## 描述

**现象（2026-09-16 18:30，July 实机）**：b100 插件市场只见 6 个公司插件，dsh-better-sidebar@0.18.1 消失。已安装的 sidebar 本体不受影响（只影响市场行）。

**复现（确定性，非环境问题）**：用生产接线（release policy 信任根 + 字段感知 verifier + 线上 stable35/beta37 真字节）跑 catalog 扫描：stable-only=7 行（含 sidebar）；带 beta overlay=6 行（sidebar 没了）。

**根因**：beta overlay 合并的「撤销粘性」按【包名】粘——stable 同时钉着 sidebar 0.15.2 [REVOKED]（0.18.1 晋级时的 retire 记录）和 0.18.1（活跃），overlay 只钉 0.18.1；合并循环走到 stable 0.15.2（该名第一条）时把 overlay 的 0.18.1 改成 revoked:true 推入，0.18.1 因 replaced 被跳过 → merged 里该名唯一条目=0.18.1[REVOKED] → 视图选择 revoked→continue → 行消失。**只影响 beta 名单机**（julu/sebtang/lizywu+July），非名单机走 stable-only 正常。

**三处实现不一致（本 bug 的结构性根源）**：
1. `findDesktopCompanyManifestPackageWithBeta`（desktop beta-aware lookup）——P15 phase 0 已改为 name@version 键，红测试场景与本事故一模一样 ✓
2. `mergeCompanyBetaPackages`（market provider）——仍是名级键 ✗
3. `bootClassificationCandidates`（boot 分类）——仍是名级键 ✗

**语义裁决**：撤版≠封名（对齐 P15 phase 0）。真要封名=在 stable 撤掉该名全部版本（stable-only 路径本来就是这个表现：0.15.2 revoked 从没藏住过 0.18.1）。同版本复活拦截保留（防陈旧 beta 复活已撤版本——安全属性不降级）。


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

### 2026-09-16 HH:MM
- [ ] 分析问题根本原因
- [ ] 设计解决方案
- [ ] 实现代码修复
- [ ] 编写单元测试
- [ ] 更新文档
- 修复完成（2026-09-16 18:50，orchestrator 亲修）：
1. company-provider.ts mergeCompanyBetaPackages：粘性集改为 name@version 钉键（stableRevokedPins），overlay 条目仅在【同版本】被 stable 撤销时保持 revoked
2. boot-verification.ts bootClassificationCandidates：同款改法（stableRevokedVersions 按版本）
3. 测试：新增事故形状红测试（stable[0.15.2 revoked,0.18.1 active]+overlay 钉 0.18.1 → 单条 0.18.1 活跃）；改写原名级语义测试 445（新版重钉=新鲜钉，注释写明事故与封名=撤全版本）
门禁：market 500 / desktop 2528 / 双 typecheck 0 / 线上真数据复现带 overlay=7 行（sidebar 回归）
待办：随 b101 出厂；July 实机确认市场行回归后关卡

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
