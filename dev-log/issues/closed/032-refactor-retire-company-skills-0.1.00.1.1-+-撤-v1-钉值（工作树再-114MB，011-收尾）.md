# [Refactor] #032 retire company-skills 0.1.0/0.1.1 + 撤 v1 钉值（工作树再 -114MB，#011 收尾）

**Issue ID**: #032
**Status**: Closed ✅
**Priority**: Medium
**Type**: refactor
**Created**: 2026-09-14
**Updated**: 2026-09-16
**Closed**: 2026-09-16
**Assignee**: Unassigned
**Labels**: refactor

---

## 描述

[详细描述需要重构的内容]

## 当前问题

[说明当前代码存在的问题]

### 技术债务

1. 问题 1
2. 问题 2
3. 问题 3

### 影响

- 影响 1
- 影响 2

## 重构目标

[说明重构后要达成的目标]

### 改进点

1. 改进点 1
2. 改进点 2
3. 改进点 3

## 技术方案

### 当前设计

```rust
// 当前的实现
pub struct OldDesign {
    // ...
}
```

### 新设计

```rust
// 重构后的实现
pub struct NewDesign {
    // ...
}
```

### 重构步骤

1. **步骤 1**: 描述
2. **步骤 2**: 描述
3. **步骤 3**: 描述

## 影响范围

### 修改的文件

- `path/to/file1.rs` - 修改说明
- `path/to/file2.rs` - 修改说明

### 影响的模块

- 模块 1
- 模块 2

### 向后兼容性

- [ ] 完全兼容
- [ ] 需要迁移
- [ ] Breaking Change

## 测试计划

### 单元测试

- [ ] 测试用例 1
- [ ] 测试用例 2

### 集成测试

- [ ] 测试场景 1
- [ ] 测试场景 2

### 回归测试

- [ ] 确保现有功能正常

## 实现计划

### Phase 1: 准备工作（估计 X 小时）
- [ ] 分析现有代码
- [ ] 设计新架构
- [ ] 编写测试

### Phase 2: 重构实施（估计 X 小时）
- [ ] 重构模块 1
- [ ] 重构模块 2
- [ ] 更新测试

### Phase 3: 验证和清理（估计 X 小时）
- [ ] 运行所有测试
- [ ] 性能测试
- [ ] 删除旧代码

## 相关文件

- `path/to/file1.rs`
- `path/to/file2.rs`

## 相关 Issue

- Blocks: #XXX
- Related: #XXX

## 进展记录


### 2026-09-16
- 前置查证 PASS（2026-09-16 07:16）：全史 company-skills 事件 12 条——0.1.0×2 / 0.1.1×3 全部是 julu 测试机（最后一条 09-12 07:00），0.1.2×7 为其后全部；同事零旧版安装。升级路径安全性：已装旧版者 boot 校验会看到同名 runtime 兼容条目 0.1.2 → 走正常更新非 deferral。放行执行。
- 执行中（2026-09-16 07:30）：①前置 PASS；②revoke 0.1.0/0.1.1 → beta seq36 已签发上线（publish-local --confirm-fleet-upgraded——beta 读者仅名单三人 julu/sebtang b96 + lizywu b93 全 field-aware，安全）；③无钥 retire 照 #003 先例（fb13e0badb，RELEASE.zh.md §1.D）：allowlist 手工摘两 entry（11→9， skills 仅剩 0.1.2）+ ratchet 置 36，待 CI 重签 seq37。
- 完成（2026-09-16 07:40）：revoke→beta seq36 上线（--confirm-fleet-upgraded，beta 读者=名单三人全 field-aware）→ 无钥 retire（#003 先例路径）→ CI 重签 beta seq37（9 entries，skills 仅 0.1.2）→ publish-local 上线 → 验证回读 tarballs 7 hosted（旧两包已不在托管清单）→ ratchet 37。本地 out/packages 删 0.1.0/0.1.1 tgz+pack.json（−82MB，gitignored 本地产物；#011 台账的『工作树 -114MB』口径含 git 历史快照与 v1 bundle 工件，实际可删部分即此 82MB——v1 bundle 22MB×2 版本生产物已随 CI 不再产出）。stable 清单全程未动（0.1.0/0.1.1 从未进 stable），内嵌兜底 seq35 无需刷新。验收：beta 窗 9 entries 与 stable 对齐、skills 0.1.2 唯一在窗、fleet 零旧版在装。

### 2026-09-14 HH:MM
- [ ] 完成现有代码分析
- [ ] 完成新设计
- [ ] 实现重构
- [ ] 更新测试
- [ ] 更新文档
- 触发条件：0.1.2 stable 浸泡干净 ~2 天（stable seq33 于 09-14 14:35 上线，约 09-16 评估）+ 遥测确认无 0.1.0/0.1.1 重装需求。步骤：①beta 清单 revoke 0.1.0/0.1.1（1.D 链）→ ②git 撤两份 v1 staging 钉值 + 删 gitignore 显式取反 + 扩 gitignore 测试 → ③#011 的 57MB 源树退库收尾合计达 -171MB。注意：retire 后旧版本不可再装（0.1.2 更新链已全员验证）。

## 验收标准

- [ ] 所有测试通过
- [ ] 代码质量提升
- [ ] 性能无退化
- [ ] 文档已更新
- [ ] Code Review 通过

## 风险评估

- **风险 1**: 描述及缓解措施
- **风险 2**: 描述及缓解措施

---

## 备注

### 参考资料

- [设计模式文档]
- [最佳实践指南]

### 讨论记录

[记录技术讨论要点]

## 解决总结

完成于 2026-09-16：revoke+retire 双版本经 beta seq36/37 两轮签发上线（keyless retire 先例复用），本地产物清理 −82MB，stable/内嵌清单零扰动。
