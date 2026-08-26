# 安装与卸载

[English](install-and-uninstall.md)

本文说明 DSH Community Market 的 package 操作边界。

## 视图

| 视图 | 事实来源 | 可用操作 |
| --- | --- | --- |
| 发现 | 当前目录来源的标准化数据 | 查看详情并请求安装 preview |
| 可安装 | 提供唯一 npm package 身份的目录条目 | 请求安装 preview |
| 已安装 | 当前 Profile 的直接依赖和 bundle 列表 | 卸载可移除依赖；核心 bundle 只读 |
| 来源 | 用户拥有的目录来源设置 | 添加、选择、排序和移除来源 |

已安装状态与当前目录来源无关，也与最初由哪个市场安装无关。

## 安装流程

1. 用户选择目录条目，Renderer 只发送 `sourceRecordId` 和 `itemId`。
2. Host 解析自己此前观察到的标准化 npm package 身份。
3. Host 先要求经过审核、且绑定精确 release 的 `installPolicy.mode: automatic`，再请求 `https://registry.npmjs.org/<package>/latest`，并要求返回相同 package name、同一个经过审核的稳定版本、合法的 `dsh.bundle.patch` 声明，同时没有直接安装生命周期脚本或原生 `gypfile` 要求。
4. 确认框展示 package、精确版本、当前 Profile 和 preview 过期时间。
5. 用户确认后，Host 消费一次性 `previewId`，使用自己拥有的 argv 调用 `desktopPnpm.run()`，执行精确版本的 `pnpm add`。
6. Host 把 package 写入 `dsh.profile.bundles`，并确认它已经成为 Profile 直接依赖。

来源列出的版本永远不会成为安装目标。经过审核的构建策略证据控制条目能否进入自动 preview，当前 npm lifecycle metadata 也可以在修改前停止 preview。仓库是否一致、deprecated metadata、engine 范围、integrity metadata 和普通 provider 徽章本身不会授予安装权限；provider 命令字符串会被丢弃。

Market 安装不会创建 receipt、checkpoint、重试、清理或回滚 operation。结果状态由 Desktop 普通的 Profile checkpoint 统一覆盖。

## 自动安装条件

目录条目只有满足以下条件才能进入自动安装 preview：

- 条目能标准化出且只标准化出一个合法 npm package name；
- 经过审核的本地 adapter 为这个身份输出带精确审核版本的 `installPolicy.mode: automatic`；
- package 不是 `dsh-plugin-desktop` 或 `dsh-community-market`；
- npm `latest` 对同一 package 返回与 adapter 审核结果相同的精确稳定版本；以及
- npm manifest 声明安全的相对 DSH bundle patch 路径；以及
- 当前 manifest 没有 `preinstall`、`install`、`postinstall`、`prepare`、`prepack` 或原生 `gypfile` 要求。

失败时条目仍可浏览，也可以显示只用于展示的手动命令。

## 卸载流程

1. Desktop 读取当前 Profile 的 `dependencies` 和 `dsh.profile.bundles`。
2. 每个直接 bundle 获得当前 generation 有效的不透明 `bundleId`。产品自有 bundle 只读，其他直接依赖可以移除。
3. Renderer 只提交该 `bundleId`。
4. Host 根据当前清单重新解析目标，确认 package 仍是直接依赖，并返回一次性确认。
5. 用户确认后，Host 调用 `desktopPnpm.run(['remove', packageName])`，移除 bundle 条目，并确认 Profile 不再引用该 package。

无论插件由 Community Market、其他插件市场还是 DSH CLI 安装，都使用同一流程。Market 不提供启用或禁用操作。

## 手动兜底

需要构建许可或没有经过审核的构建策略时，Host 会根据标准化身份构造一条有界且只用于展示的命令。详情弹窗说明原因并提供**打开 DSH 终端**；该操作只打开终端，不会提交 package 命令、路径、许可或 Profile，也不会执行修改。用户在图形流程之外检查 pnpm 提示的构建脚本许可需求并自行决定。

## 失败行为

| 故障 | 结果 |
| --- | --- |
| 无法解析 npm latest，或它不是稳定 DSH 插件 | 不启动 package 操作 |
| 受审策略要求构建许可、npm latest 已变化，或 release 新增安装/构建 hook | 不提供自动安装；保留手动终端指令 |
| Preview 后 Profile 发生变化 | 拒绝一次性 preview |
| pnpm 失败 | 报告错误；Market 不自动清理或回滚 |
| pnpm 后 Profile reconcile 失败 | 报告错误，供诊断或显式恢复 checkpoint |
| 用户确认后 Renderer 关闭 | Host 持有的 package 操作继续，仅可能丢失响应 |

修改成功后，用户可以立即重启或稍后重启；重启绝不会静默进行。
