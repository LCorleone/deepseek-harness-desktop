# [Bug] #049 禁用插件重启后依旧生效（dshMarket 姿态下托管禁用集永不合并）

**Issue ID**: #049
**Status**: Closed ✅
**Priority**: Medium
**Type**: bug
**Created**: 2026-09-17
**Updated**: 2026-09-17
**Closed**: 2026-09-17
**Assignee**: Unassigned
**Labels**: bug

---

## 描述

**现象（2026-09-17 11:43，July b103 实证）**：市场界面禁用插件→提示重启→重启后插件依旧生效。npm（sidebar）与 tar 包（context 等）通杀。

**根因**：`dsh-plugin-desktop/src/profile.ts` ~940-958 启动禁用集合成：
```
disabledBundles = 恢复态禁用
if (无恢复态文件 || provider==community) 才合并托管态禁用
```
生产（recoveryStatePath 有值 + dshMarket provider）→ 界面写的托管禁用【永不进 boot 过滤】。设计注释意图是「切 provider 不复用 community 陈旧禁用」，实现却把市场 UI 的用户禁用整个判给 community 专属。UI 侧读托管态显示 disabled+「重启生效」，boot 却只认恢复态——两层状态源脱节。

## Code Map
- `dsh-plugin-desktop/src/profile.ts` ~940-975（禁用集合合成+loadRecoveryFilteredProfile）
- `dsh-plugin-desktop/src/desktop-plugins.ts`（readDesktopDisabledBundles/状态读写/UI 清单）
- 测试：profile.spec.ts 相关 disable 用例

## 约束
- 保留原设计的安全意图：provider 切换不把【陈旧】禁用跨 provider 乱套
- 修法方向（worker 评估择一）：
  A. 托管禁用视为 provider 无关的用户意图——无条件合并（最简；代价：community 姿态下的禁用跟人走到 dshMarket 姿态，可在 UI 重新启用，可逆）
  B. 状态文件记录禁用时的 provider 归属，同 provider 或显式标记才合并（重）
- 不碰恢复态语义（恢复态禁用永远生效的现有规则不变）

## 验收标准
1. dshMarket 姿态：界面禁用（npm 或 tarball 任一）→重启→插件不加载（boot 层过滤生效）
2. community 姿态行为不变（现有测试绿）
3. 禁用→启用→重启→恢复加载，全链路测试
4. 恢复态禁用（如启动校验拒绝）仍无条件生效（现有语义）
5. profile/desktop 全套测试+typecheck 绿；补「dshMarket 禁用重启生效」红绿测试

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
- worker 完成（2026-09-17 12:05，7d802023，未提交）：
【A/B 裁决=细化 A：合并门控从 requested 换 effective】根因深挖=读写不对称：托管禁用唯一写者（DesktopPluginsService）只在 effective==community-market 时注册（main.ts ~2572），而 boot 读者在 requested==community 才合并——锁定构建 effective 恒为 community/company，requested 因设置页隐藏从不写入（fail-safe 'disabled'）→ 界面禁用永不达 boot 过滤。纯 A 的坑：dshMarket 姿态下上游市场既不显示也不能撤销我们侧状态=不可见不可修的 boot 过滤；B=状态格式 v2+迁移过重。effective 门控：生产全 requested 值修复+保留原设计意图（解锁切走仍丢陈旧禁用）+读写同谓词=结构性防再发+零格式变更。
【改动】profile.ts +15/−9（谓词换+设计注释重写+legacy 路径种子简化）；两 spec 各+1 测试（headline 红绿验证：锁定姿态禁用→boot 过滤；AC3 全链路 disable→过滤→enable→复载）。
【既有测试】'does not let community-management disables suppress a third-party market' 钉的是真需求（解锁 dshMarket 姿态）——修复下不变通过。
【门禁】desktop 全绿+tc 0（通知确认）。文件面与 #048 零重叠。
→ reviewer 待派。
- reviewer APPROVED（922381b5，2026-09-17 12:15）：真值表全组合核验（writer-live⟹reader-merge 单向包含=正确性所需方向；解锁 dshMarket 丢弃行为保留；legacy 路径恒等；恢复态语义未动）。P3×2（注释 containment 措辞/测试隐式 ENOENT 依赖）不修记档。commit 中，随 b104。
- 整体终审偏差记档（2026-09-17 12:25，reviewer-day 5ecb38a6）：a6b78b458d 意外捎走 #048 staged 的 manual.ts 删除（该 commit 单独 typecheck 不过；HEAD 无影响；bisect 该区间会在无关 commit 断）。不改已推历史。流程规则新增：共享工作树拆分提交日，push 前对每笔 commit 做 git show --stat 文件面核对（或 per-commit typecheck）。其余：main.ts 双流交叉恰一行且范围正确、capability 零悬挂消费者、#046/#049 boot 区语义独立、门禁 535/2601/26/4 全部≥基线、树干净。
- 关闭（2026-09-17 12:57）：验证完成详见各卡进展记录（#042=b100 实机相位验证+T1 生效；#046=b103 实机+beta rev1 远程发布闭环；#048/#049=b104 July 实测）。

## 验收标准

- [ ] Bug 已修复
- [ ] 测试通过
- [ ] 文档已更新
- [ ] Code Review 通过

---

## 备注

[其他相关信息、讨论、参考链接等]
