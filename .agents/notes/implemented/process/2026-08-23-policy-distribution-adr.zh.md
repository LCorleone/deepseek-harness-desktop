# Agent Note: 桌面策略经由单一解析权威分发

Status: implemented

[English](2026-08-23-policy-distribution-adr.md) | 中文

## Problem

内嵌的桌面策略文档（`lib/policy/desktop-policy.json`）通过五条并行通道抵达运行时代码，每条通道有自己的获取规则：

1. **主进程 asar 读取。** `readDesktopPolicy()` 解析 asar 内嵌资产，共有六个调用点：`main.ts` 的启动接线、`desktop-cli.ts` 的开发回退，以及 `desktop-market.ts` 的四个市场选择 helper。
2. **CLI 环境交接。** 捆绑 Node 的 CLI 子进程无法读取 `app.asar` 内部，且 unpacked 策略副本用户可写，因此启动器注入四个变量（`DSH_DESKTOP_POLICY_LOCKED`、`_CATALOG_ORIGIN`、`_MANIFEST_URL`、`_TRUST_ROOTS`），由 `desktopPolicyFromEnvironment` 严格解码。
3. **Market capability。** 市场 bundle 读取由宿主提供的窄 `desktopPolicy` capability 视图（`locked`、`trustRoots`、`companyCatalogOrigin`、`companyManifestUrl`）；市场包从不导入桌面策略定义。
4. **Profile 组装参数。** `prepareDesktopProfile` 与启动验证输入组装接收的是已解析策略作为参数。
5. **编译期 registry pin。** `pnpm.ts` 中的 `PINNED_NPM_REGISTRY` 是构建常量，不是文档内容。

五套获取规则若不声明权威就会引入漂移：某条通道自行重新解析或重新解释文档，就可能与其余通道在「构建是否锁定」「哪个信任根绑定公司目录」上产生分歧。

## Decision

Electron 主进程（`main.ts`）中调用一次的 `readDesktopPolicy()` 是**唯一权威**：文档字节变成已解析策略的唯一场所。其余每条通道都是该已解析值的**投影**，绝不独立解析文档：

- CLI 子进程接收由它派生的环境条目（`desktopPolicyEnvironmentEntries`），其直接资产读取仅保留为开发 checkout 的回退——没有交接的打包启动一律 fail-closed；
- market capability（`hostCtx.provide('desktopPolicy', policy)`）携带从它复制的字段，并收窄为市场自己的 `DesktopPolicyView`；
- profile 组装与启动验证输入以参数形式接收它（组装本身不做策略 I/O——唯一的 origin 模式 manifest 拉取在 `main.ts` 组装之前完成）；
- registry pin 保留编译在 `pnpm.ts`，因为它 pin 的是构建基础设施而非部署策略。

## Alternatives considered

**让每个消费者自行解析内嵌文档。** 独立性最大化，但解析面成倍增加且通道间可能不一致；CLI 子进程根本读不到归档，只能依赖用户可写的 unpacked 副本。

**把解析后的策略发布到 settings 式存储。** 运行时可写的副本会重新引入内嵌文档刻意规避的篡改面。

## Consequences

策略字段的变更只需触及唯一解析器加上需要该字段的投影；通道间不一致从静默漂移变成可见的接线缺陷。CLI 子进程的四变量交接是唯一自带编码的投影，因此其解码器测试与解析器测试保持成对。

## Verification

`yarn workspace dsh-plugin-desktop typecheck` 以及 `cli-install-channel`、`boot-verification`、`profile` 套件覆盖各投影；市场接线测试（`market-wired-company-catalog.spec.ts`）覆盖 capability 视图。
