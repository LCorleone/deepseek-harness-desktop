# [Feature] #035 启动/重启死区无反馈：极早轻量 splash 转圈窗（双击+立即重启两场景）

**Issue ID**: #035
**Status**: Closed ✅
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-14
**Updated**: 2026-09-14
**Closed**: 2026-09-14
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

### 2026-09-14 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- 需求（July 2026-09-14）：双击客户端或装插件后「立即重启」，到首个可交互窗口出现前有 4-12s 死区无任何视觉反馈，用户疑惑/重复点击。要一个立刻出现的简单转圈等待窗，视觉语言复用可选、简单优先。scout 结论：①日常启动（SSO 静默过+须知已确认）全程无窗直到 shell ready-to-show（main.ts:689→1955→electron-shell-generation.ts:152）；重活=SSO 探测(1-6s)/共享Python(0.5-3s)/boot verify(0.5-3s网络)/Host boot(1-3s)/shell 加载(1-3s)。②disclaimer 窗已有第二身份=loading 面（disposeDisclaimerLoading + onFirstVisibleSurface 缝，main.ts:627/648/735/2533 已四点调用）——正确先例，直接泛化。③重启=app.relaunch 无参→同一 run() 冷路径→一个 splash 免费覆盖两场景。④实现缝：whenReady+lifetime 守卫后立刻建 splash（SSO 静默探测前）；静态 splash.html 内联 CSS 转圈（零构建零 preload，native-ui 管线已有拷贝）；skip 当 disclaimer 窗在场（它已覆盖）；快启闪窗→show 延迟 ~300ms 或 ready-to-show。约束：SSO 块故意先于任何窗运行（安全），splash 必须内容空白化（仅 wordmark+转圈，无公司内容）；沙箱窗同款 hardening（contextIsolation/sandbox/独立 partition/dark bg）；second-instance 链 re-show；window-lifetime 已防提前销毁致退出。测试仿 disclaimer-window.spec（vi.hoisted electron fake + 断言窗选项/loadURL/dispose）。
- 已实现+三轮评审（NEEDS CHANGES→修→NEEDS CHANGES→修→APPROVED）。终态：内容空白化静态 splash（零脚本/零 preload/CSP default-src none）、whenReady 后立即建、300ms 防闪双旗、showInactive 不抢焦点、disclaimer 面在场则跳过、onFirstVisibleSurface 链退场（含 P14 重试缝新退点）、second-instance 重显/重建（活引用幂等守卫）、will-navigate 保险带。vite 一行输入。19 新测试。b94 验收：双击/重启死区有转圈、快启不闪窗。

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
