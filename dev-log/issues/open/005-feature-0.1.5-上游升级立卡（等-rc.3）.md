# [Feature] #005 0.1.5 上游升级立卡（等 rc.3）

**Issue ID**: #005
**Status**: Open
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-12
**Updated**: 2026-09-15
**Assignee**: Unassigned
**Labels**: feature

---

## 描述

[详细描述功能需求]

## 需求背景

[说明为什么需要这个功能]

## 用户故事

作为 [用户角色]，我希望 [功能描述]，以便 [达成目标]。

## 功能需求

### 基本功能

1. **功能点 1**
   - 子功能 1.1
   - 子功能 1.2

2. **功能点 2**
   - 子功能 2.1
   - 子功能 2.2

### 高级功能（可选）

3. **功能点 3**
   - 子功能 3.1

## 技术方案

### 1. 架构设计

[描述整体架构设计]

### 2. 数据结构

```rust
pub struct NewFeature {
    // 字段定义
}
```

### 3. API 设计

```rust
impl NewFeature {
    pub fn new() -> Self { }
    pub async fn do_something(&self) -> Result<()> { }
}
```

## 实现计划

### Phase 1: 基础功能（估计 X 小时）
- [ ] 任务 1
- [ ] 任务 2

### Phase 2: 高级功能（估计 X 小时）
- [ ] 任务 1
- [ ] 任务 2

### Phase 3: 优化和测试（估计 X 小时）
- [ ] 性能优化
- [ ] 单元测试
- [ ] 集成测试

## 相关文件

- `path/to/new/file.rs` (新增)
- `path/to/modified/file.rs` (修改)

## 相关 Issue

- Depends on: #XXX
- Related: #XXX

## 进展记录


### 2026-09-15
- 目标与破坏性面终版（2026-09-15，scout-f20b098d，fetch-only）：

【目标钉死】dsh-v0.1.2-rc.1（现 pin a66e470204）→ dsh-v0.1.5-rc.2（rc 线现役唯一；rc.3 不存在，0.1.6-alpha 按 July 规矩排除）。规模=1490 commits/6774 文件/+208k−58k。估算维持 8-12 批但按上限排——三个全新子系统各踩我们的接缝。

【BLOCKER×2（编译级碎）】
B1 session V3：assistant/chunk→assistant/attempt 改名 + 事件强制 surfaceOp 字段——model-usage-reporter.ts:399 'assistant/chunk' case 直接编译碎（TTFT 统计）；approval-mirror 类型名幸存但需对 V3 信封+磁盘 .jsonl 迁移重验。新增 session-format{,-catalog,-v0..v2-to-v3} 包族。
B2 UI：ui-layout 'details' 槽位在 rc.2 被删除（sidebar 重做=新 ui-dockkit+ui-sidebar-right）——AdvancedFrame.tsx:21 PropsRenderSlots<'details'> 碎。幸存槽：sidebar.brand.name/sidebar.footer.action/shell.overlay（市场设置卡、品牌、桌面设置面都在幸存槽上）。

【ADAPT×4】
A1 补丁重基底：11/14 语义补丁需重放（ui-primitives +1592/−90、ui-conversation、api-session-controller、agent-loop 等）；3 个可干净应用（dsh-settings、两个 directory-picker-browse）。
A2 NO_PROXY 匹配缺口（安全相关！）：新 packages/util/http-proxy 全局接管出站（模型调用/web_fetch/MCP-HTTP/web search），其 bypassesProxy() 不匹配 CIDR 且 10.* 无后缀匹配——我们注入的 10.*/10.0.0.0/8 条目【静默失效】，RFC1918 直连对上游发起的 fetch 死亡（精确域名后缀如 *.deloitte.cn 仍活）。升级时改写条目为后缀形或接受 10.x 走代理。另 NODE_USE_ENV_PROXY=1 变冗余。回环恒绕过、遥测刻意直连——与我们 corporate-network-env.ts 语义需逐条重对（也影响 #040 的 #8 出网面结论：升级后上游 fetch 的内网可达性变【经代理】，是收紧不是放松）。
A3 上游官方桌面应用现身：apps/desktop（Electron ^44、electron-builder、自动更新→腾讯 COS——正是我们禁用的面）+ apps/desktop-host 进 workspace——与 dsh-plugin-desktop 打包共存关系需一个决策批。
A4 ui-conversation 补丁上下文漂移 + token-meter usage-projection（我们补丁触碰）重构。

【CLEAN×4】preset schema 字节级未变（includeShippedRoot:z.boolean().default(true) 两侧一致，无新默认泄漏）；CLI 钳制面 plugin.ts 未动；Cordis 接缝编译级稳定（agent/pre-step 载荷一致、AgentCancelCause hook 一致、tools/post-execute、concludesTurn、registerProvider 全在）；engines/pnpm 未变。沙箱判据（mkdtempSync/TEMP rewrite）原样幸存。

【批次构成修正】~1 批=11 个补丁重放；专用批=model-usage-reporter V3 适配、AdvancedFrame details 槽迁移、NO_PROXY 条目改写、上游桌面共存决策；其余按活清单 dev-log/upstream-upgrade-replay-checklist.md 逐项。

【触发时机不变】b96 fleet 稳定 + #032 收尾后开批。

### 2026-09-12 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- 等上游 rc.3。三雷已知：modeSelectionEnabled 新默认/session v2-v3 不可回滚/默认模型 V41 Flash。需四波重放。
- 补充参考（迁移评审补齐）：①上游评审『值得抄 8 项』（含 acceptIdentity）②档3 首拒自动弹窗=runtime 升级需求清单项 ③P6 per-skill derived-key 升级路径（briefs/2026-09-10-p6-company-skills.md:18）。升级时四波重放需覆盖。

## 验收标准

- [ ] 功能正常工作
- [ ] 性能满足要求
- [ ] 测试覆盖率 > 80%
- [ ] 文档完善
- [ ] Code Review 通过

---

## 备注

### 参考资料

- [相关文档链接]
- [类似功能实现]

### 讨论记录

[记录讨论要点]
