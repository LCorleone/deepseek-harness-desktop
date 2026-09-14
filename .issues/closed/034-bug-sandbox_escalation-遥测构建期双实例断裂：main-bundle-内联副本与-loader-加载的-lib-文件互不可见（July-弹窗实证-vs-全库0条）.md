# [Bug] #034 sandbox_escalation 遥测构建期双实例断裂：main bundle 内联副本与 loader 加载的 lib 文件互不可见（July 弹窗实证 vs 全库0条）

**Issue ID**: #034
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
- July 亲眼见过多次授权弹窗但全库 sandbox_escalation=0。根因（实证）：tsdown 把 windows-pwsh-sandbox 内联进 lib/main.js bundle，而 Cordis loader 按包导出加载盘上 lib/windows-pwsh-sandbox.js——两个模块实例各自的模块级 sink 变量互不可见，setSink 写 A、report 读 B（恒 undefined），?.() 静默空转。单测单实例抓不到，仅打包产物裂。修法候选：①globalThis Symbol.for 槽（实例无关、最小改动、抗未来打包变化）②tsdown external 化该模块让 main import 盘上文件（单一实例但依赖打包配置）。倾向①+双实例回归测试（import '?duo' 查询串造第二实例验证跨实例可见）。注意：需排查同模式的其他 set* 模块缝（desktop-actions/window-reveal 等 face 是否也有 main-set-loader-read 的 seam）。#007 当时'接线完好'的静态结论只验了存在性没验实例同一性——教训记档。
- 已修+评审 APPROVED（Symbol.for 跨实例槽+双实例红绿回归；兄弟审计=唯一同款断裂；P3槽不随dispose清=预先存在行为记档）。commit e9e6832a90，攒 b94。验收锚点：b94 上线后①DB python_runtime 行出现 shared/pip 字段②July/Lucy 弹窗后出现 sandbox_escalation 首条。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
