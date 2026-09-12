# DSH Desktop

**公司内部（Deloitte）的 DSH 桌面客户端产品**：围绕一个固定 pin 的上游 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 子模块，加上公司自有的桌面壳、锁定策略与签名插件目录，面向 fleet（员工 Windows 装机）分发。本仓库是产品的唯一源；不开源、不对外发布，也没有社区渠道。

中文 · [English](README.en.md)

- 插件市场门户：<https://plugin-market.s.dai.deloitte.cn/>
- 想改代码：先看[开发](#开发)与 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 想上架插件：看[插件如何上架](#插件如何上架)。

## 这个仓库是什么

| 位置 | 角色 |
| --- | --- |
| `deepseek-harness/` | **固定 pin 的上游子模块**（pin 记录在根 `upstream.json`）。红线：绝不就地修改；上游更新只通过单独的 pin 提交落地。 |
| `dsh-plugin-desktop/` | Electron 宿主与客户端：窗口、托盘、终端、更新，以及公司锁定层——内嵌只读策略（`src/policy/desktop-policy.release.json`）、安装链验证、每次启动的 boot 复验、终端 `dsh plugin add` 门禁。 |
| `dsh-community-market/` | 公司插件市场的 Host 与 Client：市场 UI、签名/验证库、公司目录 provider 注入面（目录名沿用历史名称）。 |
| `dsh-company-skills/` | 公司技能容器插件：以单一混淆 bundle 携带公司技能集，经技能注册表发布。 |
| `dsh-community-fabric/` | 私有插件互操作 RFC 草案库：纯文档，无可加载入口点。 |
| `tools/company-catalog/` | 签名目录发布管线：allowlist → 组装签名 → 内网发布。 |

一句话架构：Electron 壳在 main 进程启动上游 DSH Host，Host 经 loopback HTTP/WebSocket 提供上游 Web UI；桌面能力与公司市场都作为普通 Cordis 插件组合进同一个运行时（「一切皆插件」）。详见[架构说明](docs/architecture.md)。

## 与上游的关系

- 上游拥有核心的 agent、模型、工具、会话与插件系统；本仓库只拥有桌面产品层，不改上游源码。
- `deepseek-harness/` 子模块保持上游自己的 pnpm workspace；上游操作一律经根 `upstream:*` 脚本执行（如 `corepack yarn upstream:build`）。
- 外层仓库与全部自有包统一使用根 Yarn release（Corepack，`yarn@4.18.0`）。

## 开发

前提：Node `^22.19.0 || >=24.0.0`，Corepack Yarn `4.18.0`。

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn dev     # 构建 market 并启动桌面开发流（需要图形环境）
corepack yarn check   # 完整 headless gate
```

常用任务：`corepack yarn build / test / typecheck`。构建、类型检查、单元测试与冒烟检查必须保持 headless-safe。仓库规则的权威全文见 [AGENTS.md](AGENTS.md)。

## 插件如何上架

链条一句话：**评审合入的 `tools/company-catalog/allowlist.json` → `verify-handoff` / `accept-handoff` 机械闸门 → CI 签名（detached ed25519 规范 JSON 清单）→ `publish-local.mjs` 推送到内网 GitLab origin → 客户端对签名清单验签、只安装清单钉住的条目，并在每次启动复验已装插件树。**

- 同事提交插件：在内网 GitLab 插件交接仓按 `submissions/<名>-<版本>` 开 MR（`handoff.json` + tgz），由桌面端所有者受理。
- beta 渠道：新条目先发给签名测试者名单（`state/beta-testers.json`）浸泡，`promote` 转正后进 stable，全员市场可见。
- 权威 runbook 是 [`tools/company-catalog/README.md`](tools/company-catalog/README.md) 与 [`tools/company-catalog/docs/handoff/`](tools/company-catalog/docs/handoff/)（SOP / RELEASE / MR-HANDLING）；本 README 不复述细节。

## 文档导航

| 想做什么 | 入口 |
| --- | --- |
| 使用产品（profile、模式、终端、更新） | [用户指南](docs/user-guide.md) |
| 快速答疑 | [常见问题](docs/faq.md) |
| 了解产品为什么这样设计 | [为什么做 DSH Desktop](docs/why-desktop.md) |
| 理解架构 | [架构说明](docs/architecture.md) |
| 编写插件 | [插件开发](docs/plugin-development.md) · [插件生态与分发](docs/plugin-ecosystem.md) |
| 包级细节 | [`dsh-plugin-desktop/README.md`](dsh-plugin-desktop/README.md) · [`dsh-community-market/README.md`](dsh-community-market/README.md) · [`dsh-company-skills/README.md`](dsh-company-skills/README.md) |
| 追溯决策与历史 | `dev-log/`（会话日志）· `.agents/notes/`（架构与流程记录）· `.issues/`（工作台账） |

## 受众与边界

- 本仓库与产品仅供公司内部使用：不接受外部贡献，不对外分发。
- 核心能力来自固定的上游子模块与 Cordis 插件模型；「DeepSeek」是深度求索公司的商标，名称仅用于描述技术来源。
- 根目录保留上游生态的 MIT [`LICENSE`](LICENSE)；仓库本身按公司内部资产管理。
