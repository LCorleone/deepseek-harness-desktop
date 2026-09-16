# [Feature] #044 选择性ASAR打包优化（host组装19.5s主菜）——观察模式：盯上游变动，数据先行三步闸

**Issue ID**: #044
**Status**: Open
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-16
**Updated**: 2026-09-16
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

### 2026-09-16 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- 任务简报（2026-09-16 立卡，July 拍板：先观察上游后续变动，谨慎不动手）：

【实证依据（b97 boot_phase 首批数据，julu 两靴）】稳态靴 37.1s 中 host 组装段占 19.5s（60%），装后首靴 22.0s/总 61.7s；boot 校验仅 440ms（receipt 缓存有效，静态拆解的高估方向洗清）；python 检查 3.7s。host 段病灶=asarUnpack 含 node_modules/**+lib/**+agent-presets/**（package.json:326-333）=上游 #804 同款散文件模块图加载病。

【上游坑图（2026-08-28→09-13 四次形态变动）】①v2.0.4 index-only asar+23k 散文件→安装/首启地狱；②2.0.5β 选择性雏形→解析器 asar 图同步 realpath 13.4s；③#829/v2.0.6 成熟形态（JS入asar+smartUnpack+窄白名单+三回归修复+A/B实验室，性能实测过）；④v2.0.10 弃 asar 改 no-ASAR——动机=正确性（捆绑技能真 fs 元数据踩 ASAR Stats BigInt），打包时长未测。对我们 no-ASAR 三输（安装慢/首启慢/拆 asar integrity 承重墙）永不跟。

【三步闸门方案（开工时执行，现已全部冻结）】
S1 零风险测量：移植 NSIS A/B 计时实验室（scripts/build-windows-nsis-ab.ts+ps1+schema）+ b97 boot_phase 为启动基线
S2 CI 实验变体（零 fleet 暴露）：选择性 ASAR 构建跑全套门禁（verify-packaged-runtime/boot 校验/e2e 安装冒烟/2476 测试）+坑3逐面排查（presets/原生.node/ripgrep/pnpm 留 asarUnpack 白名单，仅纯 JS 模块图入 asar）+A/B 实测
S3 数据拍板：July 看数字决定 beta 名单浸泡与否；回退=旧安装包

【观察触发器（经 #041 滚动盯）】上游 v2.0.11+ 是否：补测打包时长/回退 no-ASAR 性能问题；ASAR Stats 正确性问题是否有官方修法；他们 A/B 数据或社区安装时长反馈。任一出现→本卡解冻评审。
【冻结期替代小项】#042 T1 并行化（python 3.7s 与校验/_profile 重叠，上限 ~4-5s，零打包风险）可独立小批做，不等本卡。

【验收标准（解冻后）】□A/B 前后数字齐（安装时长+冷启相位图对比）□门禁全绿□asarUnpack 白名单逐项有『为何必须真 fs』注记□beta 浸泡≥2 工作日□July 终审数字拍板
【约束】观察期内不动 package.json 打包面；上游动作只记账（#041）。
- 补充决定（2026-09-16 July）：Defender 排除的 IT 请求【搁置】——小范围测试期 IT 不会批；触发条件改为 fleet 规模化后（届时一并排除路径清单已成稿）。locales/.map 小修剪不单独立卡，随下次打包面变动（本卡解冻或 #005 升级批）顺手带走。客户端侧现阶段无安装提速可做项，本卡收束为纯观察模式。

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
