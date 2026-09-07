# 公司插件交接仓（pluginpuller/dsh-desktop-plugins）

同事向 DSH Desktop 公司插件市场**提交自建插件的唯一入口**：一个插件版本 = `submissions/` 下一个目录（`handoff.json` 提交单 + `npm pack` 的 tgz），经 MR 交桌面端所有者（julu）做字节级验证与兼容复验，通过后签名发布到正式目录——本仓内容**不会**直接到达员工机器。

## 快速开始（五步）

```
1. npm pack 打出 <名>-<版本>.tgz
2. agent 按 compat.json 搭同版本环境自验（dsh commit + 桌面版都钉在那份文件，别硬编码）
3. 算 sha256 + 字节数，填 handoff.json（严格按 handoff.schema.json v2：
   plugin 段必填 author / description / type）
4. 拉 submissions/<名>-<版本> 分支，放提交目录，推分支
5. 开 MR 到 master（标题 = 插件名@版本），等 verdict
```

第 2 步可直接发给你的 agent（用你的 GitLab 凭据 clone——同提交走同一通道）：

> git clone http://10.173.59.30:9080/pluginpuller/dsh-desktop-plugins.git 并读 compat.json，
> 按 `dsh.commit` 检出 deepseek-harness，安装我方插件（pnpm，workspace 内），
> 启动 client/host 双面验证；对照 `desktop.version` 用该版桌面端做一次冒烟
> （dev workspace 侧载）。测试结果记入 handoff.json 的 evidence，没跑的不要勾。

审查节奏、异常处理等由仓库维护者负责，提交侧按本页五步走即可；有问题在 MR 里留言。

## 契约文件与 handoff.json 字段

| 文件 | 作用 |
| --- | --- |
| `handoff.schema.json` | 提交单格式（v2，`additionalProperties:false`——多一个字段都过不了） |
| `compat.json` | 兼容契约：钉死 dsh commit / runtime 区间 / 桌面版，每次自验前重读 |
| `example.handoff.json` | 填写示例（free-search） |
| `README.zh.md`（本文件） | 仓库首页 + 提交规则 |

以上契约文件由所有者维护（在保护 master 上），MR 里携带对它们的改动会被直接拒绝。

`handoff.json` 字段一览（全部必填）：

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 固定 `2`（本仓强制 v2 契约，v1 提交单直接拒绝） |
| `plugin.packageName` | 与 tgz 内 package.json 的 name 逐字一致 |
| `plugin.version` | 稳定三段式 `X.Y.Z`（拒绝 `-rc` / `+meta` 段） |
| `plugin.author` | **作者**，简单字符串：`"sebtang"` 或 `"sebtang@…"` 均可；作者 ≠ 提交人，可代交 |
| `plugin.description` | **一两句话**说明插件做什么（市场列表 / MR 展示用，须与 MR 描述一致） |
| `plugin.type` | **类型**，11 选 1 英文枚举：`tool` / `skill` / `docs-and-rendering` / `vision-and-multimodal` / `voice-and-audio` / `memory` / `workflow-and-automation` / `git-and-code-review` / `interface-ui` / `browser-and-network` / `other`（中文对照见 MR 模板） |
| `compat.dshRuntimeVersion` / `dshCommit` / `desktopVersion` | 须与 compat.json 钉死值相符（区间需有交集，commit/桌面版精确等） |
| `artifact.file` / `sha256` / `sizeBytes` | tgz 裸文件名 + SHA-256 + 字节数（所有者会重算，不符当场拒） |
| `submitter.name` / `gitlabHandle` / `submittedAt` | 提交人姓名 / `@handle` / 日期 |
| `evidence.summary` + `checks` | 实际跑过的场景与结果；checks 只勾真实执行过的项 |
| `changes` | 相对已上架最新版的一段变更说明（或 `initial submission`） |

## MR 规范

- 开 MR 时选 **plugin** 模板（`.gitlab/merge_request_templates/plugin.md` 自动带出）：插件名 / 版本 / 作者 / 类型（11 枚举中文对照）/ 一句话描述 / 测试勾选——**handoff.json 与模板描述必须一致**，不一致过不了机器闸门。
- verdict 回执机制：所有者验证后在 MR 上回 verdict（PASS/FAIL + 原因与 retest 指引），修好后往同一分支继续推 commit 即重新触发；**MR 合并 ≠ 上架**，上架仍需所有者验证 + 签名发布。
- 同一版本号内容不可变：改了内容必须升版本重开 MR。
- 高权限插件（申请系统权限 / 敏感域名的）不适用此快速通道，需走源码审计通道（联系所有者）。

## 新实例注意事项

- 本仓在新的 GitLab 实例 **10.173.59.30:9080**：同事（及 sebtang / lizywu）需先在该实例有账号（找 pluginpuller 管理员开通）；旧实例 `gitlab.s.dai.deloitte.cn` 的账号与 token 在新实例**无效**。
- 新实例走 **HTTP（内网明文）**：clone 地址 `http://10.173.59.30:9080/pluginpuller/dsh-desktop-plugins.git`；个人 token 注意保管，避免明文渠道外泄。
