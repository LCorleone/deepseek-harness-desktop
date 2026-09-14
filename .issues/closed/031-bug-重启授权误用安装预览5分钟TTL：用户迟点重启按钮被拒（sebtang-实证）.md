# [Bug] #031 重启授权误用安装预览5分钟TTL：用户迟点重启按钮被拒（sebtang 实证）

**Issue ID**: #031
**Status**: Closed ✅
**Priority**: High
**Type**: bug
**Created**: 2026-09-14
**Updated**: 2026-09-14
**Closed**: 2026-09-14
**Assignee**: Unassigned
**Labels**: bug

---

## 描述

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

### 2026-09-14 HH:MM
- [ ] 分析问题根本原因
- [ ] 设计解决方案
- [ ] 实现代码修复
- [ ] 编写单元测试
- [ ] 更新文档
- sebtang 2026-09-14 实证：装完 agent-teams 后 11 分钟点「立即重启」→ restart_request rejected intent-expired ×2 → UI 通用错误「could not be restarted, restart manually」→ 手动重启。根因：issueRestartToken(service.ts:1727) 复用 intentTtlMs=INSTALL_INTENT_TTL_MS=5min(service.ts:28)——该 TTL 为防陈旧安装预览设计；重启授权是变更已提交后的一次性动作，晚重启无害且已有防重放（一次性删除+客户端闭锁+host 单流）。修法：独立 restartIntentTtlMs（默认 24h）+ 过期路径专用文案（说明确认已过期、随时可手动重启）。遥测验证点：intent-expired 拒绝应归零。
- 已修+两轮评审 APPROVED（主修+P2 同类病灶：禁用/启用路径与幂等窗统一 24h 常量）。装/卸预览仍 5min 防陈旧。遥测验证锚点：intent-expired 拒绝归零（b94 起）。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
