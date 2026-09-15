# [Feature] #036 installable 视图行级「已安装/可更新」徽章（方案B：保留四tab）

**Issue ID**: #036
**Status**: Closed ✅
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-15
**Updated**: 2026-09-15
**Closed**: 2026-09-15
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

### 2026-09-15 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- July 拍板方案B（2026-09-15）：保留四 tab，installable 网格行加徽章——已装插件显示「已安装 vX.Y.Z」、目录版本高于已装时显示「可更新 →vA.B.C」；discover/installed/sources 不动，顶部更新横幅保留。积木现成：matchingInstallation(:109-128 按行匹配 managed→external/immutable 回退) + pendingUpdates(:592-619) 的 compareStableVersions 方向闸——下放到 PluginCard 行渲染。注意 exactOptionalPropertyTypes、双语 locales、market-settings-tab.spec 既有渲染断言模式。
- 已实现+评审 APPROVED（P3×2 记档：跨源横幅/行徽章分歧=诚实设计；行级重算开销可忽略）。commit 2bcf40ea69，攒 b95。

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
