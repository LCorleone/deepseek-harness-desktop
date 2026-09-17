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
- 范围回调（2026-09-17 11:39，July）：【撤回】无条件全删终端引导——正常详情页按钮+manualInstall 提示保留；只改【失败回退落点】：安装/预览失败落到详情表单时不得出现终端引导（无 open-terminal 按钮无 dsh plugin add 展示），改为瞬态=失败横幅+重试+关闭、非瞬态=现有失败展示（同样无终端引导）。实现=落点门控（记录详情视图是否因失败到达，失败到达则抑制手动引导 footer）。worker-048b 已 steer（若已按旧简报删除则恢复+改门控）。启动恢复缝仍不可动。
- 最终范围（2026-09-17 11:41，July 复裁）：【维持无条件全删】——worker 已按原简报删除 manual.ts/路由/桌面注入/模态框按钮，11:39 的范围回调撤回，不做失败落点门控。交付=瞬态分类器+重试横幅+全量终端引导移除+测试+门禁。worker-048b 已二次 steer 确认原范围。
- 完工（2026-09-17 12:02，048c 接管审计；真相：048b 未死，持续产出至 11:48——大部分代码/测试/文档为 048b 产物，048c 补 3 处文档缺口+i18n hash 刷新（教训⑲流程）+全门禁认证）。
【交付】①分类器 install-failure.ts（66 行纯函数，13+12+4+5 例边界测试，UNKNOWN 保守非瞬态，网络邻接不重试类专测）②重试横幅：瞬态→横幅+Retry（重发同 preview 幂等+重入 pending 隐藏门，测试断言）+Close ③终端引导全量移除：manual.ts 删除、manualInstall 全链拔除（api-types/service/routes/client）、open-terminal 路由+客户端函数+DesktopActionsService.openTerminal+main.ts 注入全删、capability 收窄为 requestRestart ④恢复缝 main.ts:735 原样（diff 恰一行）⑤文档双语+3 个 i18n.yaml hash。
【门禁】market 535 绿/tc 0；desktop 2601 绿（含并行 #049 在途改动）/tc 0；layout 4/4。
【提交注意】与 #049 共享工作树——提交时按文件面切分；manual.ts 删除已 staged。
→ reviewer 待派。
- reviewer APPROVED（f198d947，2026-09-17 12:20）：分类决策表与 host 词汇逐字对齐+对抗边界钉死；加固测试从各方向断言终端引导缺失（含全文无 dsh plugin add）；移除外科式（main.ts 恰一行+capability 断言 in false+路由表级断言）；双语文档+hash 门过。P3×2 记档：①预览腿 npm registry 抖动实际浮现为 verification-failed（npm 验证器吞网络因）——分类器保守判非瞬态→实际 Retry 只对 operation-timeout 生效；执行腿 operation-failed+网络尾无 Retry 横幅（Confirm 即恢复路径）。②分类器头注释过度声明调用面。均不阻塞。→【遗留关注】P3-1 意味着 zhong 的 npm 抖动场景（本卡起点）拿不到重试——需后续在 npm 验证器区分网络失败/校验失败或把 registry-fetch 歧义上调为瞬态。commit 中。
- July 裁定（2026-09-17 12:14）：P3-1 遗留接受——npm 抖动现状（失败横幅+可手动重点安装+无终端引导）已够用；npm 验证器网络/校验区分不做（记为已知残留，未来有诉求再启）。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
