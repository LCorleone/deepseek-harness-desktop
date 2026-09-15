# [Bug] #038 共享Python provision 锁层失败=整体放弃：ENOENT 时自愈永不执行（Lucy 实证）

**Issue ID**: #038
**Status**: Closed ✅
**Priority**: High
**Type**: bug
**Created**: 2026-09-15
**Updated**: 2026-09-15
**Closed**: 2026-09-15
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

### 2026-09-15 HH:MM
- [ ] 分析问题根本原因
- [ ] 设计解决方案
- [ ] 实现代码修复
- [ ] 编写单元测试
- [ ] 更新文档
- Lucy(b94) 日志实证：'could not serialize the shared python environment provisioning ... ENOENT: open pyenv.provision.lock' → withSharedPythonProvisionLock 任何失败都跳过整个 provision 体（含 #033 自愈）→ 永远降级 bundled/无 pip。设计倒置：锁防罕见双实例竞态，锁层故障的代价却是永不 provision。修法三层：a) 上锁前 mkdir 父目录 b) 锁失败重试一次 c) 仍失败→降级无锁 provision+警告（宁可冒双实例竞态小险，不做永远没 pip 大死）。需先读 withFileLock 实现钉死 ENOENT 具体成因（疑杀软竞态删文件或路径细节）。附带：遥测只报 shared/pip 布尔，锁失败这个降级原因不可见——本卡顺带把 provision 结局写进日志行已有，评估是否值得加字段。
- 已修+评审 APPROVED（根因=锁父目录鸡生蛋；三层防御；P3①收敛措辞已诚实化=下次启动收敛；P3②无锁层对权限型 EACCES 也放行=正确结果轻微浪费，记档）。commit 4a63315eea，攒 b96。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
