# [Bug] #048 安装失败回退到手动终端引导而非重试（npm 抖动应提示重试；锁定构建手动引导误导）

**Issue ID**: #048
**Status**: Open
**Priority**: Medium
**Type**: bug
**Created**: 2026-09-17
**Updated**: 2026-09-17
**Assignee**: Unassigned
**Labels**: bug

---

## 描述

**现象链（2026-09-17，源自 zhong b93 案例）**：安装预览/安装失败（如 npm 公共源抖动，zhong 09-15 两次 operation-failed）→ 70bd6d5ee0 的失败回退落地在详情表单——「打开 DSH 终端」按钮 + `dsh plugin add` 手动命令。July 裁定：**瞬态失败应提示重试，不是回退手动引导**。

**第二问题（2026-09-17 11:17 July 收紧为硬性要求）**：市场 UI【一定不能出现终端引导】——不分锁定与否、不分条目来源，「打开 DSH 终端」按钮与 `dsh plugin add` 手动命令展示全部移除（锁定构建里该命令本就会被 add 门挡，是死路；非锁定也不该引导用户绕开受管路径）。

**修法方向**：
A. 失败分类：install/preview 失败按 reasonCode/错误形状分瞬态（网络/超时/registry 5xx/ECONNRESET 类）与非瞬态（未找到/完整性/策略拒绝）。
B. UI：瞬态失败 → 失败横幅 +【重试】（重新拉预览）+ 关闭；非瞬态 → 现有失败展示。手动引导（终端按钮+命令）只对「非瞬态且手动路径实际可用」的场景展示。
C.（收紧后）市场 UI 的终端引导【无条件移除】：弹窗 footer 的 Open DSH Terminal 按钮、manualInstall 提示的命令展示路径全部删除；市场侧 DesktopActionsService 的 openTerminal 注入（main.ts ~2570）一并移除。启动恢复流的 openTerminal（main.ts:735 recoveryTerminalAvailable）是另一条缝，【不得破坏】。manual.ts 若因此无消费者，删除其展示链路（保留 or 删除由 worker 按 consumers 判断并汇报）。

## Code Map
- `dsh-community-market/src/client/MarketSettingsTab.tsx`：详情/确认弹窗 footer（~2280-2315）、失败回退逻辑（70bd6d5ee0 引入的 pending→confirm/detail 分叉）
- `dsh-community-market/src/install/manual.ts`：manualInstallHint（npm 条目即提示）
- `dsh-community-market/src/install/service.ts`：失败 reasonCode 词汇表（分类依据）
- `dsh-plugin-desktop/src/main.ts` ~2570：DesktopActionsService openTerminal 注入（锁定门控点）
- 测试：market-settings-tab.spec.tsx / market-install.spec.ts / client-overlay.spec.tsx

## 约束
- 不破坏 70bd6d5ee0 的「pending 隐藏防闪现」行为
- 启动恢复流 openTerminal（main.ts:735 recoveryTerminalAvailable）不动
- 重试=重新发起同一预览请求，幂等
- 错误分类保守：判不准的算非瞬态（宁可少给重试，不误报可重试）
- 桌面/市场两包测试全绿 + typecheck

## 验收标准
1. 瞬态失败（网络类 reasonCode）→ 弹窗显示失败原因 + 重试按钮；重试成功 → 正常进确认/安装流
2. 非瞬态失败 → 现有失败展示，无重试按钮也可见关闭
3. 【硬性】任何构建、任何条目、任何路径：市场 UI 不再出现「打开 DSH 终端」按钮与 dsh plugin add 命令展示
4. 市场 host 路由/desktopActions 的 openTerminal 能力对市场移除（API 面收窄）；启动恢复流不受影响
5. 启动恢复流终端能力不受影响（现有测试绿）
6. 测试覆盖：分类边界（每类 reasonCode）、重试幂等、锁定隐藏、恢复流不破坏

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
- 立卡（2026-09-17 11:16，July 裁定：npm 抖动应提示重试非回退手动引导）。worker 待派。
- July 收紧（2026-09-17 11:17）：终端引导【一定不能出现】——无条件移除（原方案C的锁定门控升级为全量删除）。首个 worker 因模型 503 死亡（0f368328，无产出），重派中。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
