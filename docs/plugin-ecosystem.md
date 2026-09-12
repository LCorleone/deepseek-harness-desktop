# 插件生态与分发

[English](plugin-ecosystem.en.md) | 中文

DSH 的能力以插件组合。插件越多，它们能否协同工作就越重要：如果每个插件都假设甚至覆盖其他插件的内部实现，装几个插件就会开始冲突。本页给出公司插件生态的三条约定，以及一个插件如何从作者到达全员机器。

## 三条约定

1. **组合优先**：通过官方 slot、service 和 patch 组合能力，不假设、不覆盖其他插件的内部实现。
2. **声明清晰**：明确声明依赖的 service 和 slot，不依赖运行时巧合。
3. **兼容优先**：升级保持向后兼容，不破坏已有组合。

桌面壳本身是第一条约定的范例：桌面能力作为普通 Cordis 插件接入，与上游和公司插件走同一条组合路径，没有任何特权。

## 分发模型（公司签名目录）

插件不经公开生态直达员工机器，而是走签名目录：

- 唯一的人工输入是经评审合入的 [`tools/company-catalog/allowlist.json`](../tools/company-catalog/allowlist.json)，每条钉住包名、精确版本与完整性。
- 同事插件在内网 GitLab 插件交接仓提交（`submissions/<名>-<版本>`，`handoff.json` + tgz）开 MR；所有者跑 `verify-handoff` / `accept-handoff` 机械闸门，并做内容审计后受理。
- CI 把 allowlist 组装成规范 JSON 清单并以 detached ed25519 签名；`publish-local.mjs` 把签名产物推送到内网 GitLab origin。
- 客户端只信签名清单：只安装清单钉住的条目（npm 通道或内网 tarball 通道），并在每次启动对已装插件树复验；单调 sequence 棘轮防回滚。
- **上架不等于安全背书**：闸门是机械验证加所有者内容审计；安装链的信任来自签名与钉定，不来自提交人自述。

## beta 渠道

新条目先以 beta 清单发布给签名测试者名单（`state/beta-testers.json`）浸泡观察，之后经 `promote` 原字节转正进 stable 清单。名单增删即时重签生效，不需要客户端发版。

## 权威 runbook

流程与命令以 [`tools/company-catalog/README.md`](../tools/company-catalog/README.md) 与 [`tools/company-catalog/docs/handoff/`](../tools/company-catalog/docs/handoff/)（SOP / RELEASE / MR-HANDLING）为准；本页只讲模型，不复述操作。

## 互操作草案

[`dsh-community-fabric/`](../dsh-community-fabric/README.zh.md) 是仓库私有的插件互操作 RFC 草案（manifest、capability、事件契约），纯文档、无可加载入口点；当前插件仍使用现有 DSH/Cordis 接口。

## 延伸阅读

- 编写插件：[插件开发](plugin-development.md)
- 日常使用：[用户指南](user-guide.md) · [常见问题](faq.md)
