# [Feature] #041 上游桌面仓(anywhere-labs/dsh-desktop)MR观察线：逐版普查+摘录候选(性能优先)

**Issue ID**: #041
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
- 首期普查存档（2026-09-15，scout-290c25a3，v2.0.4→master 08-28~09-15）：

【定位】我们 fork 基线 v2.0.4(08-28)；上游已到 v2.0.10(09-13)+master。战略分歧=他们全平台拆 ASAR(#972/#973)，我们靠 asar integrity 加固——永不跟。每次上游 release/master 推进跑同款普查（本卡滚动追加）。

【PR#990 判定 DIFFERENT-DESIGN】无 RunAsNode trampoline（加固移除，tests/package.spec.ts:134 钉无导出、verify-runtime-closure.mjs:20 禁 ELECTRON_RUN_AS_NODE）；ACL runner 直接用 sha256 捆绑 node.exe（windows-pwsh-sandbox.ts:68-87 + desktop-node-runtime.ts:175-204）。0xC0000142 前置条件（受限子进程自建 console）不存在。watch×2：①node.exe 自动 console 可能可见闪窗（SW_HIDE patch 只盖受限子进程）——真机确认；②可加回归测试钉『ACL spawn 无 windowsHide/win32-detached』。

【摘录候选榜（性能优先，等 July 指令）】
TOP3：#879(perf,M)懒生成 LAN-HTTPS 证书+启动解析降本——对准冷启 21-23s；#902(M)打包后 preset 依赖误判缺失→会话创建/回滚失败，我方同款 resolver 形状；#809(S-M)打包后 pnpm PATH 抢占 exit 9009，pnpm.ts 同款。
次级：#841+#824(S)后台 Node 重入抢焦点+ready-to-show 一次性显示；#926(M)内置插件识别修复（摘时剥远程控制入口）；#869/#880 崩溃渲染进程自恢复（先核对 renderer-recovery.ts 覆盖）；#792/#850 系恢复线（desktop-boot-recovery.ts 部分已有）；#829(L)兼容 ASAR 的选择性打包 perf。
不适用现在：#927/#931/#932 win 子进程 Node 模式修复（rc.1 无 Windows Job runner，0.1.5 升级时回看）；#970/#908/#898/#891 DSH 0.1.5-rc 运行时升级（绑定 #005 专项）；#883 市场时序（我们市场已换血）。
禁入（锁定版新出网面）：#885 内置 Agents-Anywhere+手机连接；#894-897/#914/#901 AA 子模块/构建管线；#919/#912 AA bridge 同步部分；#926 的远程控制标题栏入口。
无害跳过：#920/#916/#915/#875-873/#836/#845/#843/#811/#810/#812 化妆/文档。

【流程】上游新 release → API 拉新增 merged PR → 分类(perf/win/打包/功能/文档) → 对照我方树判适用性 → 候选进本卡候选榜 → July 点名才摘。

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
