# [Bug] #016 restart 重复点击 5min TTL 后回 410

**Issue ID**: #016
**Status**: Closed ✅
**Priority**: Low
**Type**: bug
**Created**: 2026-09-12
**Updated**: 2026-09-12
**Closed**: 2026-09-12
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

### 2026-09-12 HH:MM
- [ ] 分析问题根本原因
- [ ] 设计解决方案
- [ ] 实现代码修复
- [ ] 编写单元测试
- [ ] 更新文档
- 评审 P3：acceptedRestartTokens TTL=授权 5min，之后重复点击回 410 而 UI 显 restarting。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]

## 解决总结

July 09-12 拍板：关闭——主路径已稳+有遥测，5min 晾置场景留观 restart_request 真实命中率，撞上再立卡
