# DSH Desktop 关键不变量逻辑正确性评审（2026-09-10 23:00 定时任务）

**范围**：七组「坏了出用户可见事故」机制，先读测试断言再读实现找双盲洞（崩溃时点/并发/Windows 语义/部分失败）。基线 HEAD `df8ac25426`。只评审不改码不 commit。
**总裁决**：**NEEDS CHANGES（1×P1、1×P2、5×P3）**——七机制中六组逻辑与测试闭环质量高；唯一真洞在机制 1×2 的**交互缝隙**（换新不清安装恢复 WAL），一次「装完插件不重启就升级」+换新后首启失败即硬砖。

## 1. fresh-profile.ts — 除交互缝隙外闭环

- **[P1] 版本换新成功后遗留的安装恢复 WAL 会把「换新后首启失败」升级为永久拒启砖**。
  `main.ts:1351-1358`（reset→swap 先执行）→ `main.ts:1432`（claim 后执行）；`fresh-profile.ts:676-743`（swap 只清 checkpoint+回执，不碰 WAL）；`install-recovery.ts:712-713`（restore 失配→manual-recovery-required）；`main.ts:1453`（此后每次启动直接 throw）。
  链条：装插件→WAL 密封 `awaiting-restart`（等重启验证）→用户不重启先升级→P14 换新把 profile 整体重建（`profileIdentity`=路径哈希，WAL 仍匹配新 profile）→若重建后首启失败（如 materialize 失败/离线），`commitFailure` 走 `protected-install-recovery`→recovery-pending→恢复窗选恢复→磁盘文件既非 before 也非 after→manual-recovery-required→**之后每次启动拒启**，无自助路径（begin 也拒 supersede）。注意：重建后首启**健康**时 `markHealthy` 自愈（verifying 相位不比对文件哈希），故触发面=「升级+未重启安装+换新后首启失败」三连，概率低但 fleet 每次版本升级必撒一轮骰子。恢复窗手动换新同样不清 WAL（`main.ts:1846` 一带）。
  建议：swap 成功路径（自动+手动两处）清空/宣告满足绑定该 profile 的 WAL；补「swap 时存在 awaiting-restart WAL」集成测试（fresh-profile-wiring.spec 现无此面）。
- 版本分级（无记录=首次观测）、EBUSY 六步退避+deferred、keep/retry/drop（仅 policy 解锁才 drop）、`profileExists===false`+restore-snapshot 双闸清回执：逻辑自洽，fresh-profile.spec 1013 行+wiring 16 例全钉住，无发现。
- **[P3]** 回执清单里一条非法行（手改 settings.yaml）令市场全部读写面 `persistence-failed` 且无自愈（`dsh-community-market/src/install/service.ts:1621-1626`），与「读不到≠报错」的既修姿态不一致——同类手改事故（手删 profiles\desktop）已真机发生过一次。建议：读侧隔离非法行（降级+warn），或至少提供一键清理。

## 2. install-recovery.ts — 相位机本体闭环

- beginLocked 相位分派（仅本 profile 的 awaiting-restart/verified/rolled-back 可链式取代；真待恢复相位、异 profile 一律拒）、先采集 preimage→writeState 原子取代→最后删旧 preimage（零 WAL 窗口已消除，失败回滚正确）、回滚前先验全部备份防半回滚、并发串行化测试齐：无发现。
- **[P3]** 孤儿 backupDir 清扫仅在「state.json 存在且匹配当前 profile」时运行（`install-recovery.ts:369,390`）：clearLocked 在 `unlink` 后、`rm` 前崩溃留下的孤儿，在下一次安装创建新 WAL 前永远不扫。有界泄漏，建议 read() 对「state 缺失但 backups 目录非空」也触发一次清扫。

## 3. market install/service.ts + host/routes.ts — 闭环

- listVerifiedReceipts 快照读不到→warn+返 `[]`（`service.ts:1139-1163`），abort 正确穿透不误报；陈旧回执三处清理闸（安装 overlay `service.ts:921-926`、卸载预览 `service.ts:1486-1505`、boot 侧 record 分支）语义一致；routes 500 兜底带 `installFailureDetail` 帧级诊断且 abort/destroyed 双闸不误写。无发现（P3 见 §1 第三条）。

## 4. desktop-market.ts — 闭环，一处跨机制观察

- 签名目录严格形状（未知键整拒、条目级 `source`/`description` 按序放行、tarball url 锁 origin、`source.integrity`===entry.integrity、testers 仅 beta 通道、expiresAt 逐字节镜像 ajv-formats）、canonical 字节相等+ed25519+keyId/指纹双绑、revoked 跨 beta/stable 按 name@version 粘滞：无发现。
- **[P2] boot 验证与锁定 CLI add 的 anti-rollback 地板是回执派生（`boot-verification.ts:1288-1291`、`desktop-cli.ts:271-281`），而回执清单是会被正常清空的**：单 profile 机器每次产品版本换新即清空全部回执（§1 swap），地板归 0；市场目录扫描有独立持久化棘轮（company-provider sequenceStore），但 boot/CLI 不消费它。攻击面=目录源被控重放旧签名清单（ revoked 条目复活进 boot 放行面）。纵深弱化而非直接破口——建议把持久化 sequence ratchet（或 boot 侧独立持久 floor）并入 `lastSeenSequence` 注入。

## 5. pnpm settle + profile-pnpm-policy — 闭环

- whole-tree liveness 宽限（15s）超时放闸+补 terminate+warn+恢复事务照常 seal/rollback，四例测试钉住（超时/终止/超时仍 seal/超时仍回滚）：无发现。
- **[P3]** 宽限到期分支 `active.child.terminate()` 后**不等 reap 即放闸**（`pnpm.ts:885-890`，注释称"reaps it before the gate releases"与代码不符）：下一个安装可能与垂死孤儿树的文件句柄竞争（Windows EBUSY/EPERM）。建议 terminate 后再 `waitForExit` 一次（有界）。
- profile-pnpm-policy：双拼写+缩进守卫+内联数组转块+EPERM/EACCES/EINVAL 重试 ladder，幂等；无发现。

## 6. pwsh-sandbox / pip-gate / shared-pyenv — 闭环

- 升权弹窗：挂主窗（loopback URL 判定）+托盘/最小化先 reveal+macOS app.show；abort 竞速即时 settle 'cancelled'、迟到的 Allow 被忽略、cancelled 不记 dedupe（重试可再弹）、pendingPromptKeys 防叠窗、每命令每会话一次真决策+suppressed 单行：语义与测试（abort 安全 3 例）齐。判据盲区（read-only 不改 TEMP→gate 误判沙箱外）已在模块注释如实记档。无新发现。
- **[P3]** cancelled 后原生对话框仍留屏（Electron 无法关箱），agent 重试同命令会叠出第二个框（安全无害但困扰用户）——`windows-pwsh-sandbox.ts:387`。建议重试前复用/清点残留框。
- **[P3]** shared pyenv 两级基底（本地 `venv --copies`→捆绑 `virtualenv --always-copy`）+坏境探测自愈+全 spawn `PYTHONDONTWRITEBYTECODE` 闭环；但**两个桌面实例并发 provisioning 无互斥**（`desktop-shared-python-environment.ts:250+`），败者静默降级捆绑别名。建议加 userData 侧文件锁。

## 7. dsh-company-skills execute.ts — 闭环，无发现

- 寻址=条目级严格等值（`findScript`/`findEntry`，无路径算术）+bundle 校验钉死规范相对路径（禁 `..`/反斜杠/盘符/冒号）；物化 staging 0700 根+0600 文件、finally 五路径（staging 失败自清、launch 失败、done 拒绝、超时、取消、成功）全部收敛到单一 finally+slot release；read 禁穿越/超限拒/二进制 fatal-UTF-8 拒且错误永不带正文；解释器注入值存在性探测防陈旧 env、win32 只认 .exe/.com；并发/截断/清理失败/警告 sink 抛错均有测试。未找到实现与测试都没想到的洞。

## 结论

单点机制质量高（fail-closed、崩溃窗有序、测试钉关键分支）；**唯一必须修的是 P1 交互缝隙**——换新与安装恢复 WAL 各自正确、组合出砖，恰是 P14 上线后 fleet 每次版本升级的常态化路径。P2 棘轮纵深建议随下次安全批落地；P3 记档排期。
