# 残余风险签收声明——无 IT 接入的公司锁定（P4-3）

[English](2026-08-22-residual-risk-acceptance.md)

状态：**待管理层签字**。本 note 记录 Phase 1–4（commits `3103531c8b`..P4-4）落地后公司市场锁定的已签收安全上限、剩余残余风险、以及未来获得公司 IT 支持时的零改动升级点。

## 已签收的安全上限（原文）

> 任何不修改 DSH Desktop 应用本体的手段都无法让未签名插件加载。修改应用本体可绕过全部客户端校验，但会留下可识别的诊断证据缺失。专业用户防不住，小白用户全部路径封死。

## 当下已强制的项

- 锁定构建钉死：生效 market provider、catalog source、安装 authority（签名 manifest 三链收敛）、终端 `dsh plugin add` 通道、启动时 bundle 校验（P1/P2）。
- 打包加固：捆绑钉版 sha256 的 Node 运行时（启动自检）、fuse 全集（含 `runAsNode:false`）、asar 分区 integrity、签名更新通道（P3，含评审修复）。
- 诊断自检报告 + 篡改证据链手册（P4-1/2，评审方向 B：报告恒定 unsigned——检测控制是报告缺失加与公司公布值的内容比对，并为中心化重签保留格式）。

## 残余风险登记表

| # | 风险 | 暴露面 | 处置状态 |
|---|---|---|---|
| R1 | 本地同用户修改 unpacked 资产（`lib/**`、`node-runtime/`；绕过摘要须改 asar） | 改 JS 即可关掉客户端校验；策略 JSON 廉价通道已封（CLI 策略 env 注入、asar 侧摘要），代码级修改仍在 | 已签收上限；检测靠报告缺失与内容比对（P4-2 §3） |
| R2 | 外部上游 CLI 直装进 `DSH_HOME` | 安装动作拦不住（不可达）；插件永不加载（boot 校验拒载） | 设计如此（拒载不拦装） |
| R3 | 内嵌 manifest 资产在 per-user 安装下用户可写；receipts 序列下限只抬成本 | 有效期内旧 manifest 重放仅限公司签名内容；registry integrity 仍钉死 | P2 评审修复已缓解；代码签名后彻底关闭（未来） |
| R4 | CI 签名私钥失陷 | catalog 与更新通道密钥独立；轮换=双钥重叠；吊销=sequence 重发 | 架构 note 有 runbook；待真实密钥演练 |
| R5 | 升级前 v1 receipts 用户全部拒载 | 用户可感知的重装负担 | 发布说明引导（dev-log 风险①） |
| R6 | Linux 目标 asar integrity fuse 为 no-op | Linux 构建仅靠 L1/L2 | 已在 README 打包节标注 |
| R7 | 自建魔改客户端不可检测 | 无 OS 级强制则无法覆盖 | 见升级路径 |

## 未来 IT 升级点（客户端零改动）

- **Authenticode / 公证代码签名 + perMachine 安装 + 机器 ACL**：把 P3-1/P3-2 的 advisory fuse 升级为强制语义；对无管理员权限的本地攻击者关闭 R1/R3。
- **WDAC/AppLocker 策略覆盖应用与捆绑 Node**：唯一能约束对抗性管理员用户的层；关闭 R7。
- **签名密钥迁 KMS/HSM**：客户端只钉公钥指纹。
- **受管 `DSH_HOME` / 公司 registry 镜像**：关闭 R2 的安装侧。

## 签收

| 角色 | 姓名 | 日期 | 签字 |
|---|---|---|---|
| 项目负责人 | | | |
| 安全评审 | | | |
| 管理层 | | | |
