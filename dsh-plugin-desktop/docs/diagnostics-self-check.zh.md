# 诊断自检报告（P4-1）

[English](diagnostics-self-check.md)

每个诊断导出都携带 `self-check-report.json`：导出时刻构建自身安全姿态的机器可读快照。它服务于公司安全评审员——而非客户端——用于回答「这台安装实际加载了什么、在哪个策略之下？」，且不依赖日志文本。

报告**恒定不签名（unsigned），这是设计决定**（评审方向 B）：客户端签名不是抗伪造控制，因为能改客户端的攻击者同样能提取或摘除其签名私钥。篡改信号是报告的**缺失**——被改的客户端可以压制报告或伪造一份 unsigned 报告，但伪造报告的内容要与公司公布的策略摘要、manifest sequence 对得上才有用，而彻底压制报告本身就是手册（P4-2）据以处置的信号。

## 报告内容

| 字段 | 含义 |
| --- | --- |
| `reportVersion` | 报告语法版本（`1.0.0`）。 |
| `generatedAt`、`appVersion`、`platform`、`arch`、`nodeVersion` | 导出运行时刻与产出构建。 |
| `policy` | 内嵌策略资产自测量：`locked` 标志、对 `desktop-policy.json` 精确字节的 SHA-256、字节长度、钉死的公司 catalog 信任根。`available: false`（带 `reason`）表示资产读不到或严格解析失败。 |
| `nodeRuntime` | 捆绑 Node 运行时自检（P3-1）：`verified`（命令与打包 sha256 清单相符）、`development`（未打包运行）或 `failed`（带原因）。 |
| `bootVerification` | 记录启动的第三方 bundle 裁决（P2-4）：`manifestTrusted`、`manifestSequence`、`keyId`、`manifestFailure` 与完整 `allowed`/`refused` 列表。`available: false` 说明原因（解锁构建，或导出先于任何一次启动完成）。allowed 条目带 `resolved`（boot 证据等级 `receipt`/`manifest-only`/`signed-tree`、manifest sequence、key）与 `decided: {allowedBy: 'signed-company-manifest'}`；refused 条目带 `decided: {refusedBy: 'boot-verification', reason}` —— RFC 0004 证据词汇（`dsh-community-fabric`《Provenance, Validation, Diagnostics, and the Effect Ledger》§4），与 market receipt v2（`MarketEvidenceClass`）对齐。`signed-tree` 是 manifest 权威化等级：条目签名的 `treeDigest` 与实测安装树一致，全程未参考任何用户可写 receipt。 |
| `signing.viewKeys` | 本构建钉死的诊断 view key 的 keyId 与 SHA-256 指纹（当前为空；为中心化重签服务的未来物料）。 |
| `signature` / `unsigned` | 二者恰一非空。当前所有报告携带 `unsigned: {reason: 'client-side signing is not a forge-resistant control; absence of the report is the tamper signal'}`。`signature` 块（内嵌签名公钥的 detached ed25519）在语法中保留，供未来中心化重签服务使用；验签脚本遇到时仍会验证。 |

Electron 启动器在 profile 组合完成后立即把每次启动的裁决持久化到 `<user-data>/boot-verification.json`；导出读取该快照，因此托盘、恢复窗口与 headless `--export-diagnostics` 导出内嵌的都是同一次记录启动（`recordedAt` 标明是哪一次）。

## 完整性模型（方向 B）

报告体是 canonical JSON（键排序、无多余空白、仅安全整数——从 `dsh-community-market` 公共导出面导入的 `canonicalJsonText`），归档文件字节就是验签者解析后重新序列化的字节：验证绑定报告的精确内容，重签报告的任何内容改动都会破坏其签名。

客户端签名已被移除：随客户端分发的私钥恰恰能被它想约束的攻击者提取，因此不提供任何抗伪造能力。`src/diagnostic-self-check.ts` 的 `DIAGNOSTICS_SIGNING_PUBLIC_KEYS` 保留严格的 `{keyId, publicKey}` view-key 形状（携带密钥体而非仅指纹，因为自包含的重签报告必须携带它）作为未来物料：中心化重签服务——公司侧持有私钥——将来可对导出报告签名并公布公钥半边，而报告语法与手册无需破坏性变更。轮换与其他通道一样为双钥重叠，手册的指纹表随每次发布更新。

## 验证

`scripts/verify-diagnostics-report.mjs` 在任意原生 Node 上零依赖运行，接受提取出的报告或整个诊断 ZIP：

```sh
node scripts/verify-diagnostics-report.mjs diagnostics-<timestamp>-<id>.zip
# 或 `unzip -p diagnostics-*.zip self-check-report.json > report.json` 之后：
node scripts/verify-diagnostics-report.mjs report.json

# 强制手册指纹与轮换槽位（重签报告）：
node scripts/verify-diagnostics-report.mjs diagnostics.zip --fingerprint <64 位小写十六进制> --key-id <id>
```

脚本职责是**内容篡改验证**。unsigned 报告是预期形态而非脚本错误：脚本打印醒目的 `UNSIGNED` 行、复述记录原因并以 exit 0 退出——报告缺失或被压制才是控制信号，UNSIGNED 导出是否构成发现项由评审员按手册（P4-2）裁量。签名块若存在，则证明报告内容在内嵌 ed25519 密钥下字节完好；把该密钥绑定到公司是评审员的步骤——将打印的 `fingerprint` 与操作手册公布的指纹比对，或传 `--fingerprint` 让脚本强制执行。

退出码：`0` 签名验证通过，或 unsigned 报告以 UNSIGNED 警示标记；`1` 验证失败（内容被篡改、报告畸形、或报告缺失/不可读）；`2` 用法错误。
