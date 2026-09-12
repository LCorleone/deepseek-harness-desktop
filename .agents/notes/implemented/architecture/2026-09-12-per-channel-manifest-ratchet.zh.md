# Agent Note：公司 manifest 棘轮分通道——beta 水位可合法高于 stable

[English](2026-09-12-per-channel-manifest-ratchet.md)

状态：**已实现**（提交链 `32ca244325` 棘轮分轨，评审 P3 → `dd65b8d845`
stable 持久化 writer + 完整读侧扫描地板，评审 P2 → `351516c6e5` e2e 钉住
地板推导）。本 note 是设计账：为什么两个目录通道各自保有**独立**的反回滚
高水位、为什么 beta 序号高于 stable 是合法状态而非回滚、以及从 legacy
单棘轮迁移保证了什么。b91 真机叙事见
`dev-log/briefs/2026-09-11-cli-stale-staged-manifest-p1.md`（§4 晚间复盘）。

## 缺陷：一条混合地板

`32ca244325` 之前，锁定 `dsh plugin add` gate 对每次清单校验都用同一个
混合数当地板：`max(最高安装回执, 持久化棘轮)`（`desktop-cli.ts`，当时的
`lockedPluginAddSequenceFloor`，b90 `3ce59e41c5` 并入）。持久化记录
（共享市场 settings 文档里的 `companyManifest.sequence`）不带通道归属，
于是在 beta overlay 推进过的 tester 机器上，地板被 beta 抬高（事发设备
beta 29 / stable 27）。stable staged 字节——launcher 的开机快照、内嵌
asset——拿去和这条地板比对，**每次**受限安装都被 `stale-sequence` 拒绝。
那条 stale-staged 网络重试也永远救不回来：最新 stable 清单*就是* 27，
合法低于被 beta 抬高的地板，重试无新字节可取；8s 上限只封顶等待时间。
fail-closed、快速、且直到 stable 追上之前永久如此——b91 真机事件
（2026-09-11，唯一 b91 用户）。

## 决策：每通道一条高水位

两个通道**共享一个发布序列空间，但不共享发布节奏**：发布管线在同一
序列棘轮上把 beta 清单签成 stable 的超集，因此 beta 序号高于 stable 是
tester 机器的正常稳态，绝不是 stable 回滚的证据（`cli-install-channel.ts`
模块文档；`tools/company-catalog/README.md`）。评审 P3 起每处序列比较都
分通道：

- gate 的 **stable** 字节（`DSH_COMPANY_MANIFEST_FILE`、内嵌 asset、或
  stale 重试的网络字节）只对 **stable** 地板（`lastSeenSequence` →
  `authorizeLockedPluginAdd`，`cli-install-channel.ts`）；staged **beta
  hand-off** 字节只对 **beta** 地板（`lastSeenBetaSequence`，按
  `channel: 'beta'` 校验），并叠加反降级规则 beta ≥ 刚校验过的 stable 序号、
  且 = handoff 自报的序号；
- 两条地板都是 `max(最高回执序号, 该通道的持久化棘轮)`
  （`lockedPluginAddSequenceFloors`，`desktop-cli.ts`）；回执记录的是允许
  安装的 **stable** 序号，故回执地板同时下界两个通道，而棘轮逐通道合并；
- boot 校验只把回执与 **stable** 棘轮合并
  （`desktopBootVerificationInputsFromSettings`）；市场扫描的 overlay 对
  `max(beta 地板, 刚校验的 stable 序号)`（`acquireManifest`，
  `company-market-install.ts`）。

每条地板单调不降：`raiseMarketManifestChannelRatchet`
（`boot-verification.ts`）在 settings 文档写锁下原子写
`max(已记录, sequence)`——beta overlay 校验过后调
`raiseMarketBetaManifestRatchet`，stable 扫描校验过后调
`raiseMarketStableManifestRatchet`（接线在 `main.ts`）。

## 迁移是纯读；legacy 一代自闭合

`marketManifestChannelRatchetsFromSettings`（`boot-verification.ts`）读
legacy 记录旁的新记录 `companyManifestChannels: { stable?, beta? }`，迁移
期间绝不写。`betaRatchet = splitBeta ?? stableRatchet`——split beta 记录
缺失即 beta 从未生效，beta 地板从 stable 水位起步（每个已发布的 beta 都
发布在 stable 之上，故该起步合法）。`stableRatchet = splitStable ??
legacyStableClamp`——stable-only 机器保留 legacy 原值（任何机器的地板
不降）；有 beta 证据的机器钳到 `min(legacy, 最高回执)`，从回执证据播种、
绝不高于 stable 实际到过的位置——高于一切 stable 观测的 legacy 值本来就
不是 stable 通道合法到达的，钳回可证明的界是在恢复通道正确的下界，不是
放松防回滚。

分轨后 `companyManifestChannels.stable` 一度没有 writer，每次读取都在从
无归属的 legacy 值猜。`dd65b8d845` 关掉它：扫描在合法推进处持久化 stable
棘轮，且扫描地板是**完整读侧地板**（`marketStableManifestScanFloorFromSettings`）
= `max(回执, 持久化 stable 记录, legacy 钳制)`，低于地板的签名清单在它
能校验、持久化、re-stage 之前就被拒——若只从回执播种 writer，回执水位与
legacy 水位之间的合法签名 stable 重放就会被持久化、把 boot 侧地板长期
拉低。扫描在 boot 读者宽容处 fail-closed（算不出地板即抛错），每次操作
把校验过的字节 re-stage 进 `DSH_COMPANY_MANIFEST_FILE`，终端 gate 的
stale-staged 重试保留但受 8s 上限约束
（`STALE_STAGED_MANIFEST_RETRY_TIMEOUT_MS = 8_000`）。钳制留下的 split 前
重放残余因此被限定在 legacy 一代，首次持久化 stable 写入即永久闭合。

## 给未来读者的约束

- **绝不把 stable 序号与 beta 派生的地板相比，反之亦然。** e2e 场景 e3a
  （`scripts/e2e-market-reliability.mjs`）用真实
  `lockedPluginAddSequenceFloors` 对事发机器形状的文档跑推导，任何把
  两通道重新合并回一条地板的推导都会在 CI 大声红掉。
- 发布不变式 **beta ⊇ stable 且序号 ≥ stable 的**，正是 beta 下界可靠的
  根基（beta 地板允许从 stable 水位起步）；发布必须保持它。
- promote stable 到 ≥ beta 重新变回纯发版决策，不再是客户端解锁前置。
  settings 文档仍用户可写——棘轮只抬重放成本，与已签收的 R3 残余一致
  （`2026-08-22-residual-risk-acceptance.md`）。

## 验证

Focused 测试：`desktop-cli.spec.ts`（beta 抬高机器按分通道地板放行今天
的 stable 字节；stable 自身地板之下的真回滚仍拒）、`boot-verification.spec.ts`
（beta 抬高的单棘轮迁移为 beta 29 / stable 27；持久化 stable 值取代钳制；
boot stable 地板与 beta 棘轮隔离）、`company-market-install.spec.ts`
（stable 棘轮从扫描路径抬升；低于 legacy 的重放在 writer 能持久化前被拒；
算不出地板即拒扫描）。e2e `e2e:market-reliability` 是产品 CI 门。
