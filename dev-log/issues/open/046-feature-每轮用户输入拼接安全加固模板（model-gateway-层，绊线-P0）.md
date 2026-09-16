# [Feature] #046 每轮用户输入拼接安全加固模板（model-gateway 层，绊线 P0）

**Issue ID**: #046
**Status**: Open
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-16
**Updated**: 2026-09-16
**Assignee**: Unassigned
**Labels**: feature

---

## 描述

**需求（July，2026-09-16 21:29）**：在每一轮调 LLM 时，把一段固定的安全加固 prompt 模板拼接到用户输入上（不是 system prompt 一次性，是每轮）。目的：防 agent 执行危险操作。

**定位（July 已确认的架构原则）**：绊线（detection/probabilistic），不是门（guarantee）。防手滑有效、防对抗性注入有限；不替代 #040 的 8/9/11（确定性门）。

**实现面（唯一合规接缝）**：`dsh-plugin-desktop/src/model-gateway.ts`——锁定构建所有模型流量必经的公司侧网关（我们自己的代码，不是公司 LLM 路由器；路由器与子模块都不碰）。在网关转发前改写请求体：找 messages 里最后一条 role=user 的消息，把固定模板拼在其内容前面。

## Code Map
- 注入点：dsh-plugin-desktop/src/model-gateway.ts（请求转发路径；找 chat-completions 类请求体改写点）
- 现有测试：dsh-plugin-desktop/tests/model-gateway.spec.ts
- 模板存放（2026-09-16 21:38 方案定稿，July 拍板）：
  - 内嵌默认：desktop-owned 常量（b102 带出厂兜底，离线/字段未发布时用它）
  - 远程更新：manifest 新增顶层可选字段（如 securityPrompt），**走既有签名管道**
    （ed25519 + trust roots + sequence 棘轮 + beta 名单浸泡），改模板=发新 manifest 序列，零构建零发版
  - ⚠ 明确否决的方案：GitLab 裸文件（无签名=GitLab 写权限即全 fleet 注入面，绕过发布纪律，比威胁本身更糟）
  - 字段纪律=仓内「一次加一键」：stable 验证器加键需 fleet 全过 b102（b90×3/b93×8 未过闸前 stable 不得携带该字段，否则老构建整拒 manifest=目录全黑）；
    beta 通道验证器先加键（testers 字段同款先例），名单机即刻获得远程更新能力
  - 模板更新权限=manifest 发布权限（CI 签名），不是手推 GitLab——模板自身即投毒目标
  - 不进渲染层、不落日志/遥测

## 约束
- 每轮注入只改【最后一条】user 消息 → 保住供应商前缀缓存（之前上下文不变）
- 幂等：同一请求体内不重复拼接（防网关内部重试双拼）；网关外重试由 harness 重发原始体，天然安全
- 非锁定/dev 构建保持不动（managed 模型路径才有网关）
- 模板固定字符串 v1（双语一句话级，不搞配置化）；内容 July 起草中（2026-09-16 21:38），落卡后冻结为内嵌默认
- 不碰 deepseek-harness/ 子模块；不改公司路由器
- 模板内容不得进入遥测/日志（命令只出 16hex hash 的既有纪律）

## 验收标准（含远程更新通道）
1. 锁定构建：每轮 managed 模型请求的末条 user 消息=模板+原输入，原文完整保留
2. agent 内部工具续轮（role=user 的 tool result 轮）同样被覆盖
3. 前缀缓存不破坏（只改末条消息，之前 messages 字节不变——测试断言）
4. 非锁定路径零改动（现有测试全绿）
5. 幂等：单请求体内至多拼一次
6. model-gateway.spec 新增覆盖以上全部；desktop 全套+typecheck 绿
7. 远程通道：manifest 携带 securityPrompt 时验证通过并覆盖内嵌默认；未携带时用内嵌默认；篡改/回滚（序列倒退）拒绝并回退内嵌默认
8. 字段闸门：stable 验证器在 fleet 未过闸前拒绝携带该字段的 stable manifest（复用 description/source 的 field-aware 门），beta 验证器经 channel 选项放行
9. 启动拉取复用既有 catalog fetch（不得新增独立启动网络依赖）；离线/拉取失败=缓存或内嵌默认，不阻塞启动


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

### 2026-09-16 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- July 口令：先别做（2026-09-16 21:31）。卡面为完整设计存档，待 July 明确开工口令再派 worker。定位提醒：绊线层，不关 #040 的 8/9/11 排队。
- 方案定稿（2026-09-16 21:38，July 拍板）：远程更新=manifest 新顶层字段走既有签名管道（零构建更新模板；否决 GitLab 裸文件方案——无签名=投毒面）；beta 通道先带字段（testers 先例），stable 等 fleet 过 b102 闸；内嵌默认出厂兜底；拉取复用 catalog fetch。模板内容 July 起草中，卡面验收标准已扩到 9 条。仍等 July 开工口令。

## 验收标准（含远程更新通道）

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
