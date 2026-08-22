# Agent Note: 公司市场与客户端锁定

Status: Proposed

[English](2026-08-22-company-market-and-client-lockdown.md) | 中文

## 背景与目标

DSH Desktop 以内部公司构建形式分发：`dsh-plugin-desktop/` 中的 Electron 外壳，围绕 `deepseek-harness/` 中被 pin 的上游检出，且该子模块绝不允许被修改。公司安全要求：

1. 用户只能从公司内部市场安装插件，并在安装时对每个插件做指纹与签名校验。
2. 用户不能修改客户端配置来绕过该市场。

本笔记的目标是在任何实现开始之前，记录分层设计、按文件列出的具体改动点以及分阶段计划。目前尚未实现任何内容。

## 威胁模型

两类攻击者，按客户端/操作系统边界区分：

| | 普通用户 | 对抗性用户 |
|---|---|---|
| 能力 | 编辑配置文件、使用 UI 与内置终端 | 完整本地账户、任意写文件、启动进程、访问 npm |
| 被什么阻止 | L1 客户端策略锁定 | 安装/启动时的 L2 签名（部分）；完全阻止只有 L3+L4 |
| 不被什么阻止 | — | 任何单纯的客户端检查（代码在磁盘上以明文存在） |

客户端以用户身份运行。客户端读取或执行的一切校验，具有管理员权限的用户都可以改写：应用目录对用户可写、核心代码以明文解包释放、且 `runAsNode` 是被刻意启用的。客户端侧的执行（L1–L3）能阻止普通用户，并提高其他人的攻击成本；它无法阻止拥有本地管理员权限的坚定用户。正因为存在这条边界，L4 作为 IT 层控制存在，也正因为 L2 启动校验，篡改是可被检测的，而非不可能发生。

## 现状事实

当前安装路径（`dsh-plugin-desktop/src/profile.ts` 的 `prepareDesktopProfile()`）：解析 DSH home，读取 `<home>/profiles/<name>/package.json`（`dsh.profile.bundles`），加载每个 bundle 的 `dsh.bundle.patch`，组合 bundle patch、launcher 自身的 `cordis.patch.yml`（插入在 `@deepseek-ai/dsh-web-app` 之后）、可选且用户可编辑的 home 级 patch `<home>/cordis.patch.yml`（`PROFILE_PATCH_FILENAME`），以及 profile patch。

安装入口：

- Market UI（`dsh-community-market` 设置页 "Plugin market" 与侧边栏 overlay），调用 `desktopPnpm.installPlugin()`（`dsh-plugin-desktop/src/pnpm.ts`），在 `<DSH_HOME>/profiles/desktop/node_modules` 中执行受管的 `pnpm add pkg@exact --save-exact`。
- 内置终端中的 `dsh plugin add`（`dsh-plugin-desktop/src/desktop-cli.ts` 强制 `--profile`；通过 RunAsNode 运行上游 dsh CLI）。
- npm SHA-512 integrity、官方 registry tarball 与 bundle patch 校验已存在于 `dsh-community-market/src/install/service.ts`；受管 pnpm 路径已阻止 lifecycle script。
- 插件启用/禁用状态仅支持禁用，位于 `<userData>/plugin-management/state.json`（`dsh-plugin-desktop/src/main.ts`、`dsh-plugin-desktop/src/desktop-plugins.ts`）。

市场脚手架：`dsh-community-market/docs/market-shell.md` 记录 Phase 0–2 已交付；"updates and release hardening" 与 "stronger verification signals based on independently specified evidence" 属于规划，尚未实现。今天的信任来源 = npm registry 身份 + SHA-512 integrity + 仓库回链 + lifecycle-script 禁令（`dsh-community-market/docs/install-and-uninstall.md`）；`dsh-community-market/SECURITY.md` 明确声明不提供插件安全审查。`dsh-community-market/docs/schemas/catalog-*.json` 中的 catalog schema 只是线上传输格式。`dsh-community-fabric/docs/rfcs/0004-provenance-validation-and-diagnostics.md` 勾勒了 declared/resolved/decided/observed 证据词汇并与不可变 artifact 身份绑定——仅是概念，没有运行时。

Market provider 选择保存在 `<userData>/desktop-market/state.json`，取值 `disabled | community-market | dsh-market`，默认 `disabled`（`dsh-plugin-desktop/src/desktop-market.ts`）。

用户可触碰的配置面：`<DSH_HOME>/settings.yaml`（或 JSON），经 `@deepseek-ai/dsh-settings-file` 读取 `dsh-desktop.mode`/`port`；启动时加载的 home 级 `cordis.patch.yml`（可注入任意 plugin row）；profile 清单 `<home>/profiles/*/package.json` 可被直接编辑。npm launcher `dsh-plugin-desktop/src/bin.ts` 只接受 `--export-diagnostics`、`-h`、`-V`，但打包后的应用通过 RunAsNode 暴露上游 dsh CLI，包括 `plugin add`。

打包/加固事实（`dsh-plugin-desktop/package.json` 的 build 配置）：NSIS `perMachine: false`（按用户安装目录，用户可写）；`asar: true` 但 `asarUnpack` 包含 `package.json`、`cordis.patch.yml`、`build/**`、`lib/**`、`node_modules/**`，因此核心代码在磁盘上是明文；`electronFuses.runAsNode: true` 是刻意为之（`dsh-plugin-desktop/src/pnpm.ts` 为 pnpm 设置 `ELECTRON_RUN_AS_NODE=1`；terminal 与 desktop-cli 复用该 exe 作为 Node）。更新使用固定端点与固定 URL、1 GiB 上限、原子写入，仅做 DMG `koly` / Win PE 魔数检查——没有密码学签名（`dsh-plugin-desktop/src/update-checker.ts`、`dsh-plugin-desktop/src/update-download.ts`）。`dsh-plugin-desktop/scripts/verify-packaged-runtime.ts`（afterPack）是构建期存在性检查，不是运行时强制。Windows 已有 pwsh 沙箱、ACL runner 与 agent preset 防护，以及仅回环 webserver 不变量。

## 设计

共四层。L1–L3 只改 `dsh-plugin-desktop/` 与 `dsh-community-market/`；上游子模块不动。L4 是面向 IT 的文档交接，不是客户端代码。

### L1 — 客户端策略强制

引入随应用分发、只读的策略源（不放在 `<DSH_HOME>` 或 `<userData>` 之下）。默认锁定。具体改动点：

- **Market provider 钉死**：`dsh-plugin-desktop/src/desktop-market.ts` —— 生效 provider 来自策略而非用户可写的 `state.json`；公司 provider 取代 `community-market`，成为唯一非 `disabled` 的选择。
- **Registry 白名单**：`dsh-plugin-desktop/src/pnpm.ts` 的受管安装与 `dsh-community-market/src/install/service.ts` 的校验 —— 只接受公司 registry 端点；拒绝 npm.js 作为来源。
- **拒绝 home patch**：`dsh-plugin-desktop/src/profile.ts` —— 除非策略允许，否则拒绝 `<home>/cordis.patch.yml`；profile 清单的 bundle 列表对照签名 receipt 校验（见 L2）。
- **CLI 门禁**：`dsh-plugin-desktop/src/desktop-cli.ts` 的 `plugin add` 路径在受管 pnpm 运行前，先通过与 Market 安装相同的签名校验。
- **Settings 面**：`dsh-desktop` namespace 仍是 restart 作用域；任何可能重新打开上述路径的设置项归策略所有，而非用户所有。

### L2 — 公司签名与市场服务

公司维护的 ed25519 密钥。公司 catalog 服务提供已签名的 manifest：每个插件条目绑定插件身份 + 版本 + npm SHA-512 integrity，manifest 本身携带公司签名。客户端在安装时校验（Market UI 与 `dsh plugin add` 两者），并在每次启动时校验已安装 bundle —— 未签名或不匹配的 bundle 在加载时被拒绝，而不是被静默跳过。安装 receipt 在现有数据之外记录已验证的签名，并在合适处复用 `dsh-community-fabric` RFC 0004 的证据词汇（`resolved` 对应从不可变输入解析出的摘要，`decided` 对应策略结论）。HSM 与密钥轮换设计尚未决定（见开放问题）。

### L3 — 打包加固

- NSIS `perMachine: true` 并用 ACL 保护安装目录，扩展现有 Windows ACL runner 方案。
- 使用公司 Authenticode 证书对安装器做代码签名。
- 启用 Electron asar integrity 校验 fuse；把 `asarUnpack` 收缩到保持 native module 可加载的最小集合。
- 通过随应用捆绑 Node 运行时来关闭 `runAsNode` fuse，供 pnpm、内置终端与 desktop-cli 使用，取代 `dsh-plugin-desktop/src/pnpm.ts` 与 `dsh-plugin-desktop/src/desktop-cli.ts` 中复用 exe 的设计。
- 钉死更新通道并要求签名更新产物；在 `dsh-plugin-desktop/src/update-download.ts` 的魔数检查之上增加签名校验。

### L4 — 操作系统/IT 层强制（交接，不是客户端代码）

面向 IT 的文档：针对应用与捆绑 Node 运行时的 WDAC/AppLocker 策略、机器级 ACL、以及受管 `DSH_HOME`。L4 是唯一真正能约束对抗性管理员用户的层。员工机器是否受公司管理，决定 L4 是否强制（见开放问题）。

## 分阶段实施计划

| 阶段 | 范围 | 退出条件 |
|---|---|---|
| 1 | L1 策略包：provider 钉死、registry 白名单、拒绝 home patch、CLI 门禁；启动校验骨架 | 被锁定的客户端拒绝所有非公司安装入口，并有测试覆盖 |
| 2 | L2 签名基础设施、公司 catalog 服务、签名 receipt、已安装 bundle 的启动校验 | 未签名插件在重启后无法加载 |
| 3 | L3 打包：perMachine + ACL、Authenticode、asar integrity fuse、收缩 asarUnpack、捆绑 Node 运行时、签名更新 | 打包构建通过全部 fuse 与签名门禁 |
| 4 | L4 IT 交接文档 | IT 确认 WDAC/AppLocker 与受管 home 的操作手册 |

阶段 3 的捆绑 Node 运行时是最大的单项改动，因为 terminal、desktop-cli 与 pnpm 目前都复用该 exe 作为 Node；它排在 L1/L2 之后，以便先证明客户端已被锁定。

## 非目标

- 上游子模块 `deepseek-harness/` 保持不动；所有改动都在 `dsh-plugin-desktop/` 与 `dsh-community-market/`（外加客户端之外的新的签名/服务基础设施）。
- 兼容模式与高级外壳保持不变；本设计不改变呈现、模式持久化或重启策略。
- 不在此提出通用插件沙箱或能力强制；那仍是独立的 `dsh-community-fabric` RFC 轨道。

## 开放问题

- 员工机器是否受公司管理？这决定 L4 是强制还是可选，也决定 L3 加固值不值得其成本。
- 密钥管理场所：CI secrets 还是 HSM；ed25519 catalog 密钥的轮换与吊销流程。**已于 2026-08-22 决：CI secrets。**
- 钉死的更新通道托管在哪里？它与公司 catalog 服务共用签名密钥，还是使用独立密钥？**已于 2026-08-22 决：独立更新密钥（见 P3-3）。**

## 决策记录 — 密钥管理（P2-7，2026-08-22 决）

**决策：专用发布环境 + CI secrets；本期不用 KMS/HSM。**

- **场所**：专用发布环境（与代码 CI 分离的 CI 环境），ed25519 catalog 签名私钥仅存于该环境 secrets；最小人员；secrets 权限与代码仓库写权限隔离。密钥从不出现在客户端机器或任何产物中。
- **理由**：信任锚是钉死在不可变 `DesktopPolicy.trustRoots`（随应用分发）里的指纹；场所只保护私钥，在已签收的安全上限（L1–L4 模型，能改应用本体的专业用户本就绕过一切客户端校验、仅留诊断证据）下，带权限隔离的 CI secrets 足够。
- **轮换**：双钥重叠。新钥指纹先加入 `trustRoots`（应用发版）→ 新钥签发 manifest → 下一次应用发版移除旧指纹。客户端无需正常发版窗口之外的动作；重叠窗口可任意长。
- **吊销**：重发 manifest（条目 `revoked: true` + `sequence` 严格递增，P2-6 管线的 `revoke` 命令）；密钥泄露另加轮换。
- **更新通道**：使用**独立**密钥（P3-3）；单通道失陷不波及另一通道。
- **未来升级路径**：客户端只钉公钥指纹，私钥迁移 KMS/HSM 时客户端零改动。
- **演练（待 P2-6 管线落地后执行一次）**：一次轮换演练（双钥 → 收回旧钥）+ 一次测试 manifest 吊销演练，均记入 dev log。
