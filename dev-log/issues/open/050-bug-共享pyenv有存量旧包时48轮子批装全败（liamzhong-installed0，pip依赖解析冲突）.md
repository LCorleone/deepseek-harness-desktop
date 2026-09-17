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

**根因（2026-09-17 15:40 修订中）**：--no-deps 实际已在 b104（#043 批C 7f321157af）——原「依赖解析冲突」叙事被证伪存疑。截断串 `ERROR: aiohttp-3.14.3-cp312-cp3…` 同样吻合「is not a supported wheel on this platform」（b93 世代 pyenv 的解释器早于 cp312 轮子集）。定谳=liamzhong 下靴的 8KiB full-stderr。

**修法（已实现，语义按 #043 D2 决策重述）**：装腿 `--no-deps --upgrade`（--upgrade 只能治愈探测不可见的 pip 侧残留）；**探测可见的版本永不重装**——旧版本与用户故意降级不可区分（D2），收敛目标=按名字覆盖（48/48 by name）而非钉版本。失败行识别平台标签错误时直接给「删 pyenv 重建」指引。

## Code Map
- `dsh-plugin-desktop/src/desktop-shared-python-environment.ts`（pip 装腿参数）
- 测试：desktop-shared-python-environment.spec.ts（装腿参数断言处）

## 验收标准
1. 装腿对缺失库列表使用 --no-deps（闭集直装，零解析）
2.（修订）探测可见的钉名版本永不触碰（D2 语义：旧版与用户降级不可区分）；--upgrade 仅治愈探测不可见的残留；用户自装新版本不进安装列表（重探保护，测试钉死）
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
- worker 完成（2026-05-17 15:35，b54c56d3，未提交）：①pip argv 增 --upgrade（--no-deps 本就在——#043 批C 7f321157af 已落，b104 已带）+不变量注释（argv 只对探测判缺失的名字构建，--upgrade 只可能换 pip 可见的陈旧同库发行版，永不碰用户自装版本）；②stderr 8KiB（仅装腿，160 上限保留给降级行）；③测试 3 新 1 改（脏环境闭集批装/旧+用户新版都不进列表/真实 spawn 全 stderr），stash 往返验证判别性；desktop 2604 绿/tc 0。【重要修正】根因存疑：--no-deps 已在 b104 仍失败 → 截断串 'ERROR: aiohttp-3.14.3-cp312-cp3…' 同样吻合 'not a supported wheel on this platform'（b93 世代 pyenv 的 Python 版本 vs cp312 轮子）——liamzhong 下靴 full-stderr 定谳；若是平台标签类，解法=删 pyenv 重建（已给的偏方）。→ reviewer 待派（重点：b104 确含 --no-deps 的核实、--upgrade 不变量、真实失败类别的两种假设对修复的覆盖度）。
- reviewer NEEDS-FIX→三项全落（2026-09-17 15:45）：P1=卡面和解（根因改「修订中：--no-deps 已在 b104，平台标签假说等下靴 full-stderr 定谳」；验收②改 D2 语义「探测可见永不触碰，--upgrade 只治愈探测不可见残留」）；P2=失败行平台标签识别+「删 pyenv 重建」指引；P3=POSIX-only 测试记档。代码判「sound may land」。门禁 2604 绿/tc 0。commit 中，【保持开放】等 liamzhong 下靴诊断。随 b105。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
