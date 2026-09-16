# [Feature] #042 启动优化线：boot_phase仪表化→画像→优化(#879半颗候选)

**Issue ID**: #042
**Status**: Open
**Priority**: Medium
**Type**: feature
**Created**: 2026-09-15
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


### 2026-09-16
- Phase2 定向更新（2026-09-16）：b97 相位图实证 host 组装=19.5-22s 主菜（60%）→主修=#879 之后的 #829 选择性 ASAR，已立 #044 观察模式卡（July 谨慎重：先盯上游 v2.0.11+ 变动，三步闸门方案冻结待解冻）。本卡剩余活跃项=T1 并行化（python_check 3.7s+渲染 2.8s 可重叠，预期-4~5s，零打包风险）。仪表化遗留小bug：process_start 事件未入库（两靴均缺，缓冲flush待查）随下批修。

### 2026-09-15 HH:MM
- [ ] 完成需求分析
- [ ] 完成技术设计
- [ ] 实现基础功能
- [ ] 实现高级功能
- [ ] 编写测试
- [ ] 更新文档
- 开卡背景（2026-09-15，July 口令『优化启动速度，内核不升级』）：

【已测得的画像第一层】203 启动会话（7天）：SSO门→点同意 5.2s(人机混合)；★点同意→python_runtime 20.5s 中位(p10 15.9/p90 36.9)=纯机器链大头；pyrt→目录刷新 9.0s(网络)。b96 无回归，lucy b96 换新 profile 后 14.1s 反而最快。
【测量死路】客户端日志无行级时间戳（lucy.log 实证），遥测事件只有两端锚点——20.5s 内部构成不可见。
【回滚锚】tag checkpoint/pre-startup-opt-20260915。

Phase1=仪表化（本批）：①boot_phase 遥测事件：process start/boot-verify start+end/gate shown/disclaimer agreed/profile boot start+end/host composed/window ready/python check/catalog fetch start+end，phase+elapsedMs 进 detail，走既有 client-event 通道；②dsh-plugin-desktop 日志行加 ISO 时间戳前缀（顺车修观测盲区）。验收=fleet 冷启一屏能看出 20.5s 花在哪；测试=事件形状 spec+时间戳前缀 spec。
Phase2=按画像定靶（候选已登记）：#879 前半（启动期客户端模块/Profile 解析降本，上游已证收益）；boot-verify 哈希并行化（若占大头，安全评审约束：不得跳过/弱化校验）；profile pnpm 启动期成本；asar 校验成本（小切法才动，否则留 #005 窗口）。
- 静态拆解存档（2026-09-15，scout-f3b49a7f，全 file:line 锚定）：

【20.5s 链的真相=全串行+主进程同步 FS】点同意后逐步：①登录壳捕获(Unix)→②企业 env 注入/marker/诊断(廉)→③runtime-bootstrap：【node.exe 80-120MiB 每次启动全量 sha256】（desktop-node-runtime.ts:179,221-236，缓存仅 per-process）→④Python：【捆绑 CPython ~40MiB 全树 digest 每次走】（desktop-python-runtime.ts:12-15,89-96）+健康态仍 spawn python --version（shared-env :327-334）→⑤profile 选择/换新→⑥boot 校验：manifest 网络取（异步但链上串行 await）+【逐 bundle 串行全树 walk】——receipt 用途有 stat 指纹缓存（boot-verification.ts:581-641）但 signed-tree 权威【刻意绕缓存】（:566-580 防伪缓存行注记），缓存命中也重 stat 全树（:502-521）→⑦host boot（模块图加载）→⑧渲染器。全链无任何重叠。

【结论：Phase 2 靶点排序】
T1 并行化/重叠（零安全代价，预期最大）：node/python digest 与 manifest fetch 与窗口绘制本可并行——现在全串行阻塞主进程（同步 readFileSync+sha256 阻塞事件循环）。python --version 探测也该挪出关键路径。
T2 #879 前半适配（scout 划定移植范围）：①client-modules 补丁 newlineCount→indexOf——我们钉同版本 @deepseek-ai/dsh-client-modules@0.1.2-rc.1，patches/ 无此补丁，干净新增；②module-resolution 的 node: 内建快速路径——我们文件已分叉（145 行），只移植思想（resolve hook :103 与 overlayResolveFilename :83 顶加 node: 直通）。LAN-HTTPS 半边确认无对应物（全树无 lan-https*/desktop-network）——不移植。profile-channel-admission 无 setup wizard——N/A。electron-runtime/shell 等 hunks=特性翻搅，排除。
T3（需 July 安全拍板，默认不做）：node.exe/python digest 的跨启动 stat 指纹缓存——同 receipt 缓存 tradeoff（本地写者可伪 mtime+size），tamper-evidence 弱化，等画像数据确认 T1+T2 不够再议。

【pnpm 澄清】正常启动不跑 pnpm（仅 fresh-profile 重建/恢复时 materializeProfileWithRetry）——排除嫌疑。
- Phase1 完成（2026-09-15）：boot_phase 仪表化落地——boot-phase-recorder.ts（缓冲式相位计时器，timeOrigin 基准）+ 12 锚点（process_start/gate_shown/disclaimer_agreed/python_check[dur]/boot_verify[dur]/catalog_fetch[dur]/profile_boot[dur]/host_composed/window_ready）+ 日志 ISO 时间戳前缀（desktop-logger 单点）。reviewer APPROVED（typecheck 5 tsconfig 0 错、72/72 spec 绿、零启动行为变更实证：锚点全同步 fire-and-forget，flush 落点非抛出）；P3×2——①注释措辞 offline=静默丢弃（已修）②process_start 锚点位置在 start() 顶部而非字面 t=0（elapsedMs 用 timeOrigin 所以数值仍真，仅提示勿误读锚点位置，无需改）。语义注记：gate_shown 静默 SSO 成功靴缺席；catalog_fetch 仅 origin-mode；disclaimer_agreed 每靴都发（已 ack 秒过）=统一时间线边界；boot_verify_end 含 beta-overlay await 尾巴。fleet DDL 无需变更（~12 行/靴）。
- T2 完成（2026-09-15）：#879 前半移植——①patches/dsh-client-modules@0.1.2-rc.1.patch 字节级对齐上游（xxd 校验含尾字节），resolutions 双键走兄弟补丁的 npm%3A 形（上游 file%3A vendored 形已适配性改写），yarn.lock 条目形状与 dsh-app-boot 同款（hash=3e66d0），安装产物实证 indexOf 形在/旧循环不在；②module-resolution.ts node: 快路径——reviewer 深验行为保持：URL.canParse('node:fs')=true 故 packageNameFromSpecifier 本就返回 undefined，新旧路径都直通 previousResolveFilename/nextResolve；':' 非法字符故无包名碰撞；CJS 测试用 profile-manifest parent（唯一可能走 overlay 的父）钉死『永不咨询 overlay』。reviewer APPROVED 零 P0-P2（P3=dist 陈旧产物，打包时自刷）。门禁：typecheck 5 tsconfig/桌面全套 2476/touched specs 63/check:layout 全绿。未取部分（有意）：canonicalModuleKeys 缓存（我们文件已分叉）、bare 内建名覆盖（按 scout 范围）、LAN-HTTPS 全部、0.1.3-alpha.2 孪生补丁、electron-runtime 翻搅。

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
