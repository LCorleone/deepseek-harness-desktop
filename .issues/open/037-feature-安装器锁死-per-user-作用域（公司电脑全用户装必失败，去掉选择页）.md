# [Feature] #037 安装器锁死 per-user 作用域（公司电脑全用户装必失败，去掉选择页）

**Issue ID**: #037
**Status**: Open
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-15
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

### 2026-09-15 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- scout 已完成（2026-09-15，可行性强）：①选择页=assisted 模式 PAGE_INSTALL_MODE（oneClick:false+perMachine:false 必现）②应用零处读 HKLM/HKCU，作用域无关，锁死零运行时影响 ③推荐方案=installer.nsh 加 customInstallMode 宏强制 isForceCurrentInstall=1（官方钩子，只跳作用域页，向导其余保留；oneClick:true 丢目录/许可证页不取；allowElevation:false 是假锁）④唯一风险=覆盖升级到全用户安装机会出双副本；动手前先查 DB volume-diagnostics 的 execPath 有无 Program Files 路径 ⑤测试面=package.spec:796 nsis 块钉 + installer-nsh.spec 补宏断言；CI smoke 本就 per-user 无影响。July 拍板：放一放，暂不实施。

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
