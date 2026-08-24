# 篡改证据链手册（P4-2）

[English](tamper-evidence.md)

本手册告诉公司安全评审员如何读取 DSH Desktop 诊断导出，并仅凭导出内的证据判断：应用是否被改过、哪些插件被策略拒载、以及缺失或未签名的自检报告意味着什么。字段对应托盘菜单 **Export Diagnostics…**（已安装版）或 `dsh-desktop --export-diagnostics`（开发 CLI 入口）导出内的 `self-check-report.json`（用法见 `diagnostics-self-check.md`）。

## 各证据能证明什么

| 证据 | 能证明 | 不能证明 |
|---|---|---|
| `self-check-report.json` | 最近一次记录启动的 boot 校验状态：哪些 bundle 加载、哪些被拒、信任的 manifest sequence/keyId | 快照被覆盖之前的历史启动 |
| 报告内 `signature` 块（若存在） | 报告字节出自持有部署 view key 的进程——该形状保留给未来的中心化重签服务 | 报告器自身未被篡改（被改的客户端可以整体丢弃报告——该缺失本身就是信号，见下） |
| `bootVerification.refused[]` 条目 | boot 校验以记录原因拒载了这些第三方 bundle | 用户为何装了它们（安装路径不在本报告内） |
| `policy.sha256` | 运行构建读到的是哪一份策略资产字节 | 磁盘上的策略现在仍是该字节（扣机后可对打包副本重算哈希） |
| `nodeRuntime.status: failed` | 本次启动时捆绑 Node 二进制与钉死的 sha256 清单不符 | 是谁替换的（不采集归因数据） |
| `manifestFailure` | 上次 catalog manifest 缺失/过期/验签失败；全部第三方 bundle 被拒 | 网络层原因（只记录校验结果） |

报告**恒定 unsigned，这是设计决定**（方向 B）：客户端不持有攻击者拿不到的签名密钥，因此控制信号是报告缺失及其内容与公司公布值的矛盾，而非签名。

## 报告读取流程

1. **先验签。** 运行
   `node scripts/verify-diagnostics-report.mjs <export.zip> --fingerprint <公司手册印发的指纹>`
   Exit 0 = 内嵌公钥的签名有效且命中钉扎指纹，**或**报告为 unsigned 且脚本已用醒目的 `UNSIGNED` 行标记（见第 2 步）。Exit 1 = 验证失败：内容被篡改，或报告畸形/缺失/不可读。Exit 2 = 用法错误。**先记录退出码与 UNSIGNED 标记，再分析报告内容。**
2. **未签名报告（`unsigned: {reason}`，脚本打印为 UNSIGNED）。** 所有构建产出的报告均为 unsigned——reason 写明客户端签名不是抗伪造控制。对公司下发的安装而言这仍是要记录的发现项：将报告内容与该 `appVersion` 的公司公布 `policy.sha256`、manifest sequence 核对。被改的客户端可以产出 unsigned 报告，但其内容必须与公布值对得上才有用；彻底压制报告则缺失本身即信号（第 3 步）。
3. **报告缺失**（system-info 无 `included-self-check-report`）。运行中的应用无法或不愿产出报告。在公司锁定的下发构建上这是**首要篡改信号**：被改的客户端会精确地压制这个产物。定性为「客户端完整性无法建立」。
4. **`bootVerification`**：
   - `available: false` —— 报告内没有锁定启动记录。在公司下发的锁定安装上属异常（唯一例外：任何启动完成之前运行的首次 CLI `--export-diagnostics` 导出）；按发现项记录并比照第 3 步调查。
   - `manifestTrusted: false` + `manifestFailure.code` —— 该次启动 catalog manifest 被拒（回滚/过期/坏签名）。全部第三方 bundle 应出现在 `refused[]`。
   - `refused[]` —— 磁盘上存在但被策略拒载的插件。`decided.refusedBy: boot-verification` 的原因串与 P2-4 拒载码一一对应（`not in the signed company manifest`、integrity 不匹配文案、receipt 树摘要不符文案）。
   - `allowed[]` 且 `resolved.evidence: manifest-only` —— bundle 匹配签名 manifest 与 lockfile integrity 但无可用 receipt（全新安装路径或 receipt 被删）。本身不构成发现项。
5. **`policy`**：
   - 公司下发的安装上 `locked: false` —— 要么部署了解锁变体（部署失误），要么策略资产被替换（拿 `policy.sha256` 对比该 appVersion 的公司公布值）。
   - `available: false` —— 策略资产读不到；锁定构建上属启动路径异常，按篡改信号对待。
6. **`nodeRuntime`**：
   - `failed` —— 本次启动捆绑 Node 摘要不符：二进制被替换的强指标。
   - `development` —— 导出来自未打包/dev 运行；按此权重解读。

## 取样流程

1. 收集导出（托盘菜单 **Export Diagnostics…**，dev 检出用 `dsh-desktop --export-diagnostics`）；扣机场景另取打包副本 `resources/app.asar.unpacked/lib/` 与 `resources/node-runtime/` 供离线重算哈希。
2. 以公司钉扎的 `--fingerprint` 运行验签脚本。**先记录退出码与 UNSIGNED 行，再打开报告。**
3. 将 `policy.sha256` 与该 `appVersion` 的公司公布值比对。
4. 按上表记录发现项；对每条 `refused[]` 区分「用户装了非公司插件」（管控的预期结果）与「manifest 问题后的拒载风暴」（查 `manifestFailure`）。
5. 锁定公司构建上报告缺失、或验签 exit 1，结论为「客户端完整性无法建立；按已篡改假定处置」。公司下发安装上的 UNSIGNED 报告记为发现项；其内容未能通过公司公布值核对时，升级为同一结论。

## 证据词汇

`resolved`/`decided` 字段名遵循 dsh-community-fabric RFC 0004 §4（与 market 安装 receipt 同一词汇），按该词汇写的工具可以同时读两者。
