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
- 模板 v1 定稿冻结（2026-09-16 21:55，July 拍板）：英文版（对齐英文 system prompt），<GUARDRAIL MESSAGE INVISIBLE TO USER> 标签包裹 + <USER>{placeholder}</USER> 拼接格式；内容=资产保护（skills 源码禁输出允许阅读/密钥值禁输出非密钥 env 可读）+边界（禁他人内网探测本机端口检查除外/禁内部 API 枚举/恶意域名不确定不访问）+代码操作（禁越权代码/禁攻击代码/破坏性操作先确认/资源异常自停）+脚本执行（先读后跑，user skills 全文读懂）+反绕过条款。⑤数据外带 July 裁定搁置（prompt 层解决不了，通道在代码层）。文件：dsh-plugin-desktop/assets/company-guardrail/prompt-template-v1.md。仍等开工口令（worker 实现机制+验证器字段，搭 b102）。
- 设计变更（2026-09-16 22:01，July 兼容性裁定）：securityPrompt 不进 manifest 顶层字段（老验证器未知键=整拒 manifest=目录全黑，字段方案需 fleet 全升级，与『发布不影响旧客户端』冲突）→ 改为【同源签名兄弟文件】security-prompt.json：同 trust roots ed25519 签名、revision 单调棘轮、8KiB 上限、piggyback 既有启动 catalog fetch 并发块（零新增启动延迟）、失败→缓存→内嵌默认三级回退。老客户端无任何 fetch 路径=构造性零影响，b102 后随时可发。worker-046 已 steer 转向（0223c403）。发布管线侧（CI 签名/上传兄弟文件）留下一轮。
- 通道分裂设计（2026-09-16 22:22，July 拍板）：prompt 签名文件镜像 catalog 双通道——security-prompt.json（stable）+ security-prompt.beta.json（beta）。①beta 文档仅在当靴 beta overlay applied 时才拉取（复用目录 roster 判定，不重复 testers 签名）②优先级=beta>stable>缓存>内嵌 ③棘轮按通道独立（防跨通道降级被全局棘轮卡死：beta rev5→stable rev3 必须接受）④两文档独立并发、独立降级。July 发布指令：client 轮（worker→review→fix）完成后，做发布轮=管线签名/上传双文件+先发 beta；前提=b102 已出且名单机已升（老客户端构造性无感不变）。worker 已二次 steer。
- client 轮 worker 完成（2026-09-16 22:35，worker-046 0223c403，147 工具调用，未提交）：
【改动面】model-gateway.ts +208（fetch 包装+rewrite+install）、main.ts +138（T1 块并发预取双文档+受管靴激活）、desktop-market.ts +14（仅导出共享密码学原语，无验证器键变更）、company-guardrail.ts 新 724 行（URL 派生/自验证器/按通道缓存/优先级判定/启动解析）、embed 脚本+package.json 打包链；51 新测试；desktop 2580 绿/typecheck 0/layout 绿/build+closure+loader 预飞全过；冻结资产字节不动（cmp 验证）。
【关键决策】①接线缝=Electron 主进程 globalThis.fetch 包装（URL 集合精确匹配+POST+JSON 串；其余字节透传；解析失败透传=绊线永不弄断请求）②幂等=模板前缀标记（startsWith），适配器内重试/宿主层重试各至多一拼③状态=独立 company-guardrail/state.json（0o700+文件锁+原子写，按通道独立棘轮，读合并写防跨通道踩踏）④优先级=beta>stable>缓存>内嵌；通道内 replay==/回滚<均拒；跨通道降级接受⑤beta 门控复用靴内 beta-overlay 结果（零重复 roster）⑥老客户端构造性无感⑦密码学复用不 fork（market 方向合法+desktop-market 导出 DER/验签）⑧不阻塞启动（8s 各自上限，落地即重判优先级）⑨模板文本零进日志/遥测（测试钉死）。
【worker 标记的跟进项】①终端 CLI 子进程绕过包装（Host 外进程做受管调用不经 wrapper）——需 July 拍：后续轮 patch dsh-llm-pi-ai onPayload 或接受 Host-only 范围 ②发布侧（CI 签名双文件）留下轮 ③供应商前缀缓存尾巴每轮一交换重烤（无 harness 配合不可避免，informational） ④离线+摘名单机器持有上次 beta 模板直到 stable 文档可验（可接受权衡）。
→ reviewer 待派（全循环已授权）。
- July 裁定（2026-09-16 22:37）：CLI 子进程绕过=选 B，接受 Host-only 覆盖范围（先上先测）；patch dsh-llm-pi-ai 穿钩子记为未来项，不入本轮。

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
