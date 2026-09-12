# DSH Desktop 常见问题

[English](faq.en.md)

面向公司内部使用者的快速答疑。功能范围以当前经内部分发的 fleet 构建为准；更完整的日常使用说明见[用户指南](user-guide.md)。

## DSH Desktop 是什么？

公司内部的 DSH 桌面客户端：把固定版本上游 DeepSeek Harness 的本地 Web UI、Host 服务和插件系统装进原生桌面应用，并叠加公司锁定策略与签名插件目录。产品仅供公司内部使用，不对外发布。

## 支持哪些平台？需要自装运行环境吗？

公司分发目标是 Windows x64。安装包已内置 Electron、Node、pnpm 和固定版本的 DSH 依赖，普通使用者安装后即可启动，不需要另行安装 Node.js 或配置命令行环境。

## 从哪里获取安装包和插件？

安装包经公司内部分发（CI 的 Windows fleet 构建），没有公开下载渠道。插件经应用内置的公司市场安装，市场门户：<https://plugin-market.s.dai.deloitte.cn/>。

## 可以安装任意 npm 插件吗？

不可以。锁定构建只安装公司签名目录钉住的条目：市场安装前对签名清单验签，终端 `dsh plugin add` 受门禁拦截，且每次启动都对已装插件树复验。想上架自建插件，走交接 SOP，见[插件生态与分发](plugin-ecosystem.md)。

## 插件有 beta 渠道吗？

有。新插件先以 beta 清单发给签名测试者名单浸泡观察，转正（`promote`）后才进入 stable 清单、全员市场可见；名单外机器不受 beta 影响。

## 应用如何更新？

通过公司内部分发新的 fleet 构建，升级节奏以内部发布为准。内置的更新检查当前仍指向继承自上游产品的公共端点（替换为公司自有更新源的事项已立项，见 `.issues/` 工作台账）。

## 数据保存在哪里？

会话、profile 与设置都在本机。发布构建按锁定策略上报模型调用计量（SSO 邮箱、模型、分桶 token 数、时延与版本等运行元数据，不含对话内容），明细见 [`dsh-plugin-desktop/README.md`](../dsh-plugin-desktop/README.md)。

## 遇到问题怎么办？

先查[用户指南](user-guide.md)；仍无法解决时，从托盘 **Export Diagnostics** 导出诊断包并走内部支持渠道反馈。开发者另见[架构说明](architecture.md)与 `dev-log/` 会话日志。
