# [Bug] #050 共享pyenv有存量旧包时48轮子批装全败（liamzhong installed:0，pip依赖解析冲突）

**Issue ID**: #050
**Status**: Open
**Priority**: Medium
**Type**: bug
**Created**: 2026-09-17
**Updated**: 2026-09-17
**Assignee**: Unassigned
**Labels**: bug

---

## 描述

**现象（2026-09-17 15:20，liamzhong b104 实机+日志）**：python_runtime libs{pinned:48, installed:0}——48 个预装轮子一个没装上。日志：`pip could not install the 48 missing preinstalled python libraries ... (Processing ...aiohappyeyeballs-2.7.1... ERROR: aiohttp-3.14.3-cp312-cp3)`（截断）。July 全新机器 48/48 正常——差异=他的共享 pyenv 是 b93 时代建的（有存量旧包），pip 对 48 轮子做依赖解析时与存量冲突，整批失败；「下次靴重试」语义在（但脏环境不解决会一直失败）。

**根因**：48 个轮子是锁清单闭集（自洽、版本精确钉死），却走了 pip 的完整依赖解析——解析器看到 env 里已有不同版本的包（如旧 aiohttp）就报冲突。闭集直装根本不需要解析。

**修法**：装腿改 `pip install --no-deps --upgrade`（或对已存在版本加 force）+ 锁内重探逻辑不变（用户自装的新版本仍不被覆盖——注意 --upgrade 与「装前锁内重探」的语义冲突：只对【缺失】的库装，--upgrade 只影响【同库旧版本存量】，恰好是本 bug 要治的；用户自装=已满足探测=不进安装列表，不受影响）。

## Code Map
- `dsh-plugin-desktop/src/desktop-shared-python-environment.ts`（pip 装腿参数）
- 测试：desktop-shared-python-environment.spec.ts（装腿参数断言处）

## 验收标准
1. 装腿对缺失库列表使用 --no-deps（闭集直装，零解析）
2. 存量旧版本被钉版本覆盖（liamzhong 场景修复）；用户自装的较新版本仍不被降级（重探保护不回归）
3. 失败日志包含完整 pip stderr（现在被截断）
4. 现有测试全绿+新增脏环境用例（env 有旧 aiohttp → 装腿参数含 --no-deps、结果 48/48）

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

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
