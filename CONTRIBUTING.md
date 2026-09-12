# 参与贡献（公司内部）

本仓库是 DSH Desktop 的唯一源，面向 fleet 与后续接手的同事。工作方式：`.issues/` 立项跟踪、`dev-log/` 记录会话过程、`.agents/notes/` 沉淀架构与流程决策；动手前先对齐这三处，方向性问题先开卡再动工。

## 上手

- 前提：Node `^22.19.0 || >=24.0.0`，Corepack 启用的 Yarn `4.18.0`。
- 初始化固定的上游子模块：`git submodule update --init --recursive`，然后 `corepack yarn install --immutable`。
- `corepack yarn check` 全绿是硬门槛：布局/双语/架构门禁 + 各自有包的构建、类型检查与测试 + 目录管线自测。
- `corepack yarn dev` 需要图形环境；构建、类型检查、单元测试与冒烟检查保持 headless-safe。

## 红线（全文见 AGENTS.md）

- `deepseek-harness/` 是 pin 死的上游子模块：**绝不就地修改**；上游更新只走单独的 pin 提交，并与行为改动分开提交（`upstream.json` 同步记录 pin）。
- 上游命令只经根 `upstream:*` 脚本执行；子模块保持自己的 pnpm workspace，外层统一用根 Yarn release。
- `dsh-community-market/` 不得 import Desktop 实现（依赖方向由架构门禁强制）；策略只能经注入构造。
- `dsh-community-fabric/` 保持纯文档，无可加载入口点。
- 方向性调整前先提交一次存档，便于回退与追溯。

## 提交约定

- Conventional commits（例如 `fix(desktop): ...`、`docs: ...`）。
- 改动生产依赖后运行 `corepack yarn workspace dsh-plugin-desktop verify:notices`，并提交更新后的 `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md`。
- 双语文档成对修改，并用 `git hash-object` 更新对应 `.i18n.yaml` 的 blob hash 记录（根入口是 `README.i18n.yaml`）。
- 评审通过、门禁全绿后合入；描述里写清改动、动机和验证方式。

## 想发布插件

不在本仓库直接发布。同事插件走内网 GitLab 插件交接仓的 MR 交接（`submissions/<名>-<版本>`），所有者经 `verify-handoff` / `accept-handoff` 受理进 allowlist，再由签名管线发布到公司目录。权威步骤见 [`tools/company-catalog/docs/handoff/`](tools/company-catalog/docs/handoff/) 的 SOP；模型概览见 [README · 插件如何上架](README.md#插件如何上架)。

## 协作氛围

保持尊重、就事论事；完整的[参与者公约](CODE_OF_CONDUCT.md)适用于所有项目空间。
