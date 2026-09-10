# DSH Desktop 架构合理性全面评审（2026-09-10 23:00 定时任务）

**范围**：dsh-plugin-desktop 为主，兼顾 dsh-community-market / dsh-company-skills / tools/company-catalog；基线 HEAD `df8ac25426`（desktop 2339+8skip / market 467 / skills 70 / catalog 186）。只评审不改码。
**总裁决**：**APPROVED（带 1×P1、4×P2）**——架构基本面显著高于同类内网产品：fail-closed 一致贯彻、依赖方向门禁、交叉断言守值、WAL/棘轮/回执三账本各有明确 owner。主要风险不在设计而在**两个子系统（P14 换新 × 安装恢复 WAL）的交互缝隙**、组合根持续增肥、升级清单与发布协作未随 P7-P16 增量同步。

## 五维结论（先行）

1. **分层与依赖**：模块层职责划分健康（110 文件、均 ~390 行、单一主题）；耦合集中在 `main.ts`（2466 行、`start()` 单函数 ~1960 行、74 个 import、~40 个闭包状态变量）与 `desktop-market.ts`（1779 行三职责混装）。market→desktop 禁 import 有 CI 门禁 ✓。
2. **状态与一致性**：WAL 单写者+相位机+先备份后原子取代+回滚前备份校验，质量高；发现唯一跨子系统缝隙见 P1。profile 代际（generation 记录/deferred marker/规则分级）自洽且有测试钉住。
3. **安全边界**：唯一信任锚=签名 manifest 的姿态贯彻到位（严格形状、损坏即响亮砖、receipt 除 deferral 外无决策权、revoked 跨 beta/stable 粘滞、fuse 全集+asar integrity 已落地）；剩余口子=deferral 锚点（P2-2）与上游事实「插件 host 侧代码不在沙箱内」（已记档，非新增）。
4. **可维护性**：补丁面（15+2 语义补丁）有生成管线；runtime 常量与谓词双份复制用 parity 测试+绝对期望表守值（好范式）；**升级重放点清单已过期**（P2-3）；测试金字塔顶面薄（唯一 e2e 在 CI 是 advisory，P3-1）。
5. **规模演进**：同事 MR 提交流程成文（SOP/MR-HANDLING/verify--description 必填闸），但发布权威仍是单点设计（P2-4）。

## P1 — 会真发生

### P1-1 fresh-profile 换新不清理安装恢复 WAL：升级+未重启安装 ⇒ 恢复窗死循环/硬砖
**位置**：`main.ts:1316/1355`（换新）→ `main.ts:1432`（WAL claim）；`fresh-profile.ts:676-743`（swap 只清 checkpoint+回执，不碰 WAL）；`install-recovery.ts:413-418`（supersede 判定）、`:713-716`（mismatch→manual-recovery-required）、`main.ts:1465-1468`（terminal 抛错拒启）。
**场景**：用户装插件 → WAL 密封为 `awaiting-restart`（等下次启动验证）→ 用户不重启先升级客户端（版本变化触发 P14 自动换新，换新先于 claim 执行）→ 新 profile 落在同一路径（`profileIdentity`=路径哈希，`install-recovery.ts:173`，换新不可辨）→ claim 进入 verifying → 密封的 after 哈希 vs 全新文件失配 → `startup-unconfirmed` 恢复窗；选回滚则当前文件既非 before 也非 after → `manual-recovery-required` → 下次启动直接抛「requires manual repair」**拒启**；选重试则永久循环。受害群体恰是 P14 要保护的电脑小白，且恢复窗的「一键换新」动作同样不清 WAL，救不了。
**为什么重要**：fleet 每次产品版本升级都有一定概率命中（装过插件未重启者），后果是无自助路径的开机失败。
**建议**：换新成功路径（自动+手动两处）同步清空/宣告满足绑定该 profile 的 WAL；或 materialize 时在 profile 内写一次性 nonce 进 WAL 身份，使换新后 claim 走 profile-mismatch 丢弃而非验证；补「升级时存在 awaiting-restart WAL」集成测试（现有 fresh-profile-wiring.spec 无此面）。

## P2 — 真脚枪

### P2-1 main.ts 组合根过载
**位置**：`main.ts:442-2401`。P5/P8/P11/P14/P16/P9 接线全部内联进同一线性函数，评审与回归靠长注释而非结构。**为什么重要**：每个新 P 卡继续往里加，diff 面与启动顺序耦合持续膨胀，改动碰撞面升级时会放大（上游 0.1.2 正式版外壳适配正是改这类文件）。**建议**：按既有自然分段（SSO+声明门、启动恢复编排、boot 验证接线、市场/CLI 桥、窗口/托盘生命周期）抽 phase 模块，`start()` 只留顺序骨架；闭包状态改显式启动状态对象。

### P2-2 client-update-required 的 deferral 锚点是用户可写回执
**位置**：`boot-verification.ts:92-110`（deferral 文档）、`:679-703`（receipt 仅形状校验）。正常路径锚=签名 manifest treeDigest；deferral 路径锚=用户可写 settings 里的 receipt.rootDigest——本地写者改插件树+照文档算法重算摘要+改回执即可让篡改内容通过。**为什么重要**：「receipt 永不作放行依据」是 v2 计划的承重决策，P15 在窗外包上实质破了它；文档写了「信任语义收窄」但**伪造回执后果未进残余风险签收表**。**建议**：至少把该窄化补进 residual-risk-acceptance 表（对齐 R3 风格）；可选加固=回执根摘要镜像一份到 Desktop-private 追加文件提高篡改成本（诚实标注仍非密码学锚）。

### P2-3 升级重放点清单未随 P7-P16 更新
**位置**：`dev-log/2026-08-22-company-market-lockdown-plan-v2.md:233`（估算定格 2026-09-02，未含其后新增接缝）。缺失项：P11 捆绑 Python（beforePack/afterPack/digest 门禁/get-pip 钉扎）、P14 generation/pending marker schema、P15 boot 分类+runtime 谓词（此条已有 parity 断言 ✓）、P16 pwsh 适配器+dsh-pip 事前闸、P6 skills provider（`inject(['skills'])`）接缝、P7 tarball 通道、P9 beta overlay、dshmarket 1.17.1 兼容复验。**为什么重要**：下一次 0.1.2 正式版升级是既定 8-12 批专项，清单缺项=批次估算失真+接缝漏改。**另**：隐式耦合无系统性守卫——`includeShippedRoot` 事故（上游 zod 默认值翻转穿透补丁面）靠一次性人工核查，建议 runbook 固化「diff 上游 defaults/接触面」一步，并把重放点做成活 checklist 文档。

### P2-4 目录发布协作是单点设计
**位置**：`tools/company-catalog/docs/handoff/MR-HANDLING.zh.md`（verify/accept 回执指纹**必须同机**、token 向 July 个人要）+ TODO 快照「手工棘轮」（sequence ratchet 以 commit 进 desktop 仓 master）+ 残余风险表 R4（demo 签名钥 c469 未轮换，触发条件=推广）。**为什么重要**：同事已能提 MR 但采纳/发布/密钥全集中一人一机，扩到多发布者即瓶颈与 bus factor；棘轮 commit 进应用仓也把插件发布节奏耦合进桌面发版仓。**建议**：多人协作前把 ratchet/publish 全量移入 CI（已有 CI 签名先例，publish-local 仅留演练），回执指纹仓化/工件化；demo 钥轮换触发条件显式挂到 fleet 规模阈值跟踪。

## P3 — 值得记

- **P3-1 唯一 e2e 在 CI 是 advisory**：`.github/workflows/windows-package.yml:80` `continue-on-error: true`；事故台账「单测绿打包死第五连」（2026-09-08）正是金字塔顶面薄的实证。建议：installer 链路结构性断言（a/b 段）转阻断，仅网络依赖段留 advisory。
- **P3-2 desktop-market.ts 三职责**：state 快照/pinning + manifest schema 与验签 + tarball 暂存安装通道混在 1779 行；建议按 manifest-verify / tarball-channel / state 三拆（纯搬运，接口已自然分界）。
- **P3-3 sandbox_escalation 遥测疑似死线**：真机走上游 `sandbox_permissions` 授权路，我方适配器休眠（TODO 已记「累计 0 条」，接上游 approval 事件或裁掉，二选一尽快定，避免 fleet 误读为「零升权」）。
- **P3-4 双 MySQL 采集器并行**：model-usage-reporter 与 client-event-reporter 各自连接/队列/掩码逻辑；行为均有测试，但 flush/退避/丢弃语义两份实现，后续漂移风险——至少互引文档化。
- **P3-5 `profileIdentity`=路径哈希**：同路径重建不可辨（P1-1 的根因之一），随 P1 一并考虑 nonce 化。

## 做得好的（保持）

- **诚实边界的注释纪律**：每个安全接缝写明威胁模型、失效语义与不防什么（cli-lock patch 头部、boot-verification 模块头是范本）——这是本项目最可维护的资产。
- **交叉断言用绝对期望表**（`scripts/dsh-runtime-version-parity.test.mjs`）：双份谓词漂移对称也能抓，优于仅互相一致。
- **WAL 先采集备份、writeState 原子取代、回滚前备份全量校验**；settings 子树整体替换防 merge 复活（company-provider 注释）。
- **fail-closed 的一致性**：损坏 ratchet 响亮砖、manifest 损坏整目录丢弃、deferral 无回执即拒。
- **测试红证/变异验证惯例**与残余风险签收表（R1-R4）流程。

## 已核对且无需重开的既定决策（引据）

- 序列棘轮存用户可写 settings=已签收（residual-risk R3：仅限公司签名内容回放，registry integrity 仍钉死）。
- skill-filesystem 默认根保留（本地投放=用户逃生口，上游测试钉 parity）+ 公司 skill 共享混淆 key 缺口（README 明示）。
- CLI 锁 overlay=软屏障（构造即诚实：不防本有 shell 权限的用户）。
- `DSH_PERMISSION_MODE` 全拼写删除先于任何评估点（main.ts:585-597）。
