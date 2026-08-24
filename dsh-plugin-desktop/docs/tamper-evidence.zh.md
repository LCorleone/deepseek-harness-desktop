# 篡改证据链手册（P4-2）

[English](tamper-evidence.md)

本手册告诉公司安全评审员如何读取 DSH Desktop 诊断导出，并仅凭导出内的证据判断：应用是否被改过、哪些插件被策略拒载、以及缺失或未签名的自检报告意味着什么。字段对应 `dsh desktop --export-diagnostics` 导出内的 `self-check-report.json`（用法见 `diagnostics-self-check.md`）。

## 各证据能证明什么

| 证据 | 能证明 | 不能证明 |
|---|---|---|
| `self-check-report.json`（已签名） | 最近一次锁定启动的 boot 校验状态：哪些 bundle 加载、哪些被拒、信任的 manifest sequence/keyId | 快照被覆盖之前的历史启动 |
| 报告内 `signature` 块 | 报告字节出自持有部署 view key 的进程 | 报告器自身未被篡改（被改的客户端可以整体丢弃报告——该缺失本身就是信号，见下） |
| `bootVerification.refused[]` 条目 | boot 校验以记录原因拒载了这些第三方 bundle | 用户为何装了它们（安装路径不在本报告内） |
| `policy.sha256` | 运行构建读到的是哪一份策略资产字节 | 磁盘上的策略现在仍是该字节（扣机后可对打包副本重算哈希） |
| `nodeRuntime.status: failed` | 本次启动时捆绑 Node 二进制与钉死的 sha256 清单不符 | 是谁替换的（不采集归因数据） |
| `manifestFailure` | 上次 catalog manifest 缺失/过期/验签失败；全部第三方 bundle 被拒 | 网络层原因（只记录校验结果） |

## 报告读取流程

1. **先验签。** 运行
   `node scripts/verify-diagnostics-report.mjs <export.zip> --fingerprint <公司手册印发的指纹>`
   Exit 0 = 内嵌公钥的签名有效且命中钉扎指纹。Exit 1 = 签名后被篡改。Exit 2 = 报告缺失/未签名。**绝不在验签前先分析报告内容。**
2. **未签名报告（`unsigned: true`）。** 构建未携带部署 view key（开发构建）或占位未替换。对公司下发的安装而言这本身就是发现项：要么 dev 构建跑在了应为公司构建的位置，要么导出来自密钥配置之前的构建。
3. **报告缺失**（system-info 无 `included-self-check-report`）。运行中的应用无法或不愿产出报告。在公司锁定的下发构建上这是**首要篡改信号**：被改的客户端会精确地压制这个产物——因为伪造它需要私钥。定性为「客户端完整性无法建立」。
4. **`bootVerification`**：
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

1. 收集导出（`dsh desktop --export-diagnostics`）；扣机场景另取打包副本 `resources/app.asar.unpacked/lib/` 与 `resources/node-runtime/` 供离线重算哈希。
2. 以公司钉扎的 `--fingerprint` 运行验签脚本。**先记录退出码，再打开报告。**
3. 将 `policy.sha256` 与该 `appVersion` 的公司公布值比对。
4. 按上表记录发现项；对每条 `refused[]` 区分「用户装了非公司插件」（管控的预期结果）与「manifest 问题后的拒载风暴」（查 `manifestFailure`）。
5. 锁定公司构建上报告缺失、或验签 exit 1，结论为「客户端完整性无法建立；按已篡改假定处置」。

## 证据词汇

`resolved`/`decided` 字段名遵循 dsh-community-fabric RFC 0004 §4（与 market 安装 receipt 同一词汇），按该词汇写的工具可以同时读两者。
