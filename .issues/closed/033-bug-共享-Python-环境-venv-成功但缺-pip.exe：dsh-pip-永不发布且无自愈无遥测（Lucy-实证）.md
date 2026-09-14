# [Bug] #033 共享 Python 环境 venv 成功但缺 pip.exe：dsh-pip 永不发布且无自愈无遥测（Lucy 实证）

**Issue ID**: #033
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
- Lucy(b93) 想装 python 包提示无 dsh-pip 命令。dsh-pip 是授权弹窗入口（P16 链），缺它 agent 裸跑 pip 被沙箱拦。根因分析：①provision 成功判据=venv exit0+python.exe 存在，不验 pip.exe——本地 Python 缺 ensurepip 轮子时建出无 pip 的 venv 且永久复用不重试（desktop-shared-python-environment.ts:356 区域）；②python_runtime 遥测只报 available+version，不含 shared/pip 状态，服务端盲。修法：a) 成功判据加 pip.exe（缺则落到二层 bundled virtualenv）b) python 健在但 pip 缺时的自愈：ensurepip 或整树重建 c) python_runtime 事件补 shared/pip 字段。诊断辅助：Lucy 机器跑 dev-log/grab-dsh-logs.ps1 看降级日志行可实证命中分支。
- 遥测联动发现（July 质疑 sandbox_escalation 不生效，核实）：接线完好（main.ts:587→sink→reporter，spec 钉住），但全库 0 条——触发前提是「快速失败型沙箱拒绝→弹窗落定」，而现网两条主路径都不产燃料：①裸 pip/python -m pip 在沙箱=挂死非拒绝（Lucy 16:44 实证，无任何事件）②本该产事件最多的 dsh-pip 事前闸被 #033 本身掐断（无 pip.exe→无 dsh-pip）。#033 修好后此遥测应自然恢复产数据。验收锚点追加：修复版上线后 Lucy 机器出现首条 sandbox_escalation（端到端验证 #033+遥测链）。临时验证法：julu 机 agent 里跑一条越界写命令（如写 C:\ 根）应弹授权窗→批/拒→DB 出现事件。
- 已修+两轮评审 APPROVED（判据含 pip、ensurepip 原地自愈、python_runtime 加 shared/pip 字段；P3①锁注释已写实、P3②记档）。commit 091840e423，攒 b94。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
