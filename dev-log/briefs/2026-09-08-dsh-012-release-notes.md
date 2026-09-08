[中文](#cn-v0.1.2-rc.1) | [English](#en-v0.1.2-rc.1)

作为 0.1.2 系列的首个候选版本，本版本汇总了自 v0.1.1-rc.2 以来的主要用户和开发者相关变更。

> oh-my-dsh 开源社区推出了帮助插件作者随着 DSH 版本升级插件代码的 skill： https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill. 欢迎 DSH 插件作者试用并参与开源共建。oh-my-dsh 与 DeepSeek AI 没有隶属关系，相关项目非 DeepSeek 官方出品。

<h3 id="cn-v0.1.2-rc.1">新增功能</h3>

* 会话流默认在每个已完成回答前折叠过程内容，并默认折叠的「System prompt」 @07akioni, @lsdsjy
* 会话流正文宽度可自适应或拖拽调整 @yixiangihsiang
* 回答末尾显示 token 用量和耗时，可展开查看精确用量与详细统计 @hypatiamay, @ZiyaZhang, @Yifffan
* 会话视图提供覆盖完整历史的回合导航，可预览并跳转尚未载入的轮次 @LegGasai
* 统一界面次级文字层级，会话流支持字号调节，Markdown 表格随正文字号缩放 @yixiangihsiang
* 插件支持在模型设置页添加提供方登录配置 @LegGasai
* 界面支持第三方语言，并统一权限分类和标签的本地化表达 @tianyicui, @LegGasai, @imccyu, @ZiyaZhang
* 子代理模型选择支持 Agent 在授权范围内自主选择，也支持调用方指定提供方、模型、推理力度和最大输出长度，以及为 Claude Code、Codex 配置模型 @Dudu-0223, @pku-xht
* Python SDK runtime 新增 Windows x64 发行包 @tianyicui
* ACP 补齐标准会话控制、模型设置、MCP、权限和取消能力 @tianyicui, @pku-xht
* DeepSeek 官方适配器默认随请求提供已启用插件的包名和版本，可在配置中关闭 @tianyicui
* DeepSeek 官方适配器新增可选的 Session 日志增量上传，默认关闭 @tianyicui
* 新增实验性 Inspector 工具 @imccyu
* 新增实验性 Web Preview @imccyu
* 界面显示连接状态，容忍短暂服务端卡顿，并支持连接中断后的自动重试或立即重连 @imccyu
* 会话标题区域支持在不同视口宽度下查看活动的定时计划 @pku-xht
* 父 Agent 与可持续子 Agent 可通过 `send_message` 双向传递后续消息，取代单向 `report` 工具 @Dudu-0223

<h3>体验优化</h3>

* 减少页面启动和会话初始化中的代码加载、数据传输与解析开销 @lsdsjy, @imccyu, @Kingwl, @kermanx
* 改善会话记录占用的磁盘空间 @Magolor
* 优化 `/` 与 `@` 菜单的图标、目录加载和文件搜索，支持通过鼠标在目录层级间导航 @Yifffan, @LegGasai
* 会话运行中存在草稿时主按钮切换为「发送」，消息排队发送 @lsdsjy
* 输入框中的文件和会话引用在相邻文字编辑后仍保持有效 @LegGasai
* 切换会话后仍保留未提交的提问卡片草稿 @LegGasai
* 会话流中的流式回复代码块在生成期间持续显示语法高亮 @07akioni
* 会话流中的提问历史显示为可读的问答卡片，并标明取消或中断后的未提交状态 @LegGasai
* 图片发送后立即显示，压缩和上传在后台继续 @CreatixChu
* 上下文压缩会计入图片占用 @CreatixChu
* 轨迹视图支持展示用户、助手和工具结果中的图片 @CreatixChu
* 在本地文件系统模式下，模型可定位上传图片，并通过 `read_image` 读取没有扩展名的附件路径 @CreatixChu
* 调整图片压缩策略，压缩更快、上传体积更小，并改善超长截图的清晰度 @CreatixChu
* 会话日志截断尾部自动修复时输出警告并注明受影响会话 @turtle1999
* 插件列表按会话插件和全局插件分组，可切换 Agent Preset 查看组合、搜索其他预设 @LegGasai
* 改善会话与输入界面的菜单显示、滚动条、工具文件链接与 diff 统计 @Yifffan
* 减少 macOS 和 Linux 加载会话时不必要的文件系统检查 @LegGasai
* 提升长会话和密集实时消息的处理效率，降低内存占用以及流式回复、代码高亮、布局和导航预览的渲染开销 @Dudu-0223, @imccyu, @07akioni
* `web_search` 失败时报告实际端点和错误明细 @CreatixChu
* 调整首页标志的动画效果 @Yifffan
* 自定义模型发现复用 Profile 请求头；模型目录支持搜索和筛选 @LegGasai

<h3>问题修复</h3>

* 修复 macOS 和 Linux 上持久 PowerShell 启动过早、输出不完整的问题 @tianyicui
* 修复 Linux 持久 Bash 在管道内部读取时提前返回空输出的问题 @LegGasai
* 修复 Bash 命令派生大量子进程时 macOS 宿主卡顿的问题 @LegGasai
* 修复 Windows 目录选择器截断含「开」等特定编码字符路径的问题 @tianyicui
* 修复会话视图中持久 Bash 与 PowerShell 结果无法展开的问题 @LegGasai
* 修复 Profile 配置的 Agent Preset 目录在启动时丢失的问题 @LegGasai
* 无法加载的 Agent Preset 会提前标记，并在切换失败时说明原因 @LegGasai
* Minimal preset 不再显示不适用的 `/goal` 命令 @Magolor
* 文件编辑工具接受当前操作未使用字段的 `null` 占位值 @lsdsjy
* PTC Mode 的 SDK 功能只能通过 `run_code` 调用，不再被模型当作普通工具直接调用 @CreatixChu
* 网关定期发送 WebSocket 心跳，避免空闲连接中断 @lsdsjy
* 修复新建空会话挤掉 Workspace 折叠列表已有会话的问题 @lsdsjy
* 修复系统提示词 workflow 分区顺序 @LegGasai
* 优化 NPM 包中的 peer dependency 依赖以改善包管理解析成本 @imccyu
* 修复 Node.js 24.0–24.11.1 上启动可能失败且 HMR 失效的问题 @imccyu
* 关闭设置窗口后，键盘焦点会返回设置入口 @LegGasai
* 会话运行中追加或排队发送的图片可正确回显并可靠投递；持续子代理的后续消息也支持图片 @CreatixChu
* 命令菜单打开时，`Tab` 可补全当前高亮的斜杠命令 @mektpoy

<h3>其他变更</h3>

* 更新 [安全说明](SAFETY.zh.md)：DeepSeek Harness 尚未接受安全审计，沙箱、审批与权限控制不能保证隔离 @turtle1999
* 调整模型提示词顺序，使 Shell 使用指南稳定出现在其他工具指南之前 @LegGasai
* Remote 网关统一远程调用 API 与异常分发，旧版 APIProxy 已迁移并移除 @imccyu
* 会话视图工程大幅拆分，请面向诉求分层导入合适模块 @imccyu
* 网络访问 Web 界面时启用链接中的一次性 token 认证鉴权 @tianyicui
* 应用统一通过 `dsh` Profile 启动，包括 Python SDK、ACP 模式等 @tianyicui
* pi-ai 模型支持更新，并增加 vLLM 思考预算等配置 @tianyicui
* Headless 运行期间向 stderr 流式输出进度，stdout 只输出最终结果 @lsdsjy
* Code Mode 统一更名为 PTC mode，现有会话记录仍可读取 @tianyicui
* 默认启用公网 WebFetch（内置 SSRF 防护，公网请求不再逐次审批） @Dudu-0223
* 移除可选的 SQLite Session 持久化后端；已有内容不会删除，请使用旧版本导出 @tianyicui
* Python SDK、Headless、ACP 与自定义 Profile 默认提供 `web_fetch` @koalazf99
* Web PTC Mode 默认不再向模型提供通用 `workflow` 工具 @koalazf99
* `Session.events` 被按需读取 API `seq`、`eventAt()` 和 `snapshotEvents()` 取代 @kermanx
* `SessionSeq` 与 `SessionLogOffset` 使用强类型区分，本改造保持向前兼容 @tianyicui, @imccyu

---

This first release candidate for v0.1.2 summarizes the major user- and developer-facing changes since v0.1.1-rc.2.

> The oh-my-dsh open-source community has launched a skill to help plugin authors upgrade their plugin code alongside DSH version updates: https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill. DSH plugin authors are welcome to try it out and participate in open-source contribution. The oh-my-dsh org is not affiliated with DeepSeek AI, and their projects are not official DeepSeek products.

<h3 id="en-v0.1.2-rc.1">New Features</h3>

* By default, fold process details and the System prompt before each completed answer in the conversation stream by @07akioni, @lsdsjy
* Make conversation-stream content width adaptive and drag-resizable by @yixiangihsiang
* Show token usage and elapsed time at the end of each answer, with expandable exact usage and detailed statistics by @hypatiamay, @ZiyaZhang, @Yifffan
* Provide full-history turn navigation in the conversation view, including previews and jumps to unloaded turns by @LegGasai
* Align secondary text styling, add conversation font sizing, and scale Markdown tables with body text by @yixiangihsiang
* Let plugins add provider sign-in controls to Models settings by @LegGasai
* Support third-party interface languages and consistent localized permission categories and labels by @tianyicui, @LegGasai, @imccyu, @ZiyaZhang
* Support subagent model selection through agent-authorized choices, caller-specified provider, model, reasoning effort, and maximum output length, and configured models for Claude Code and Codex by @Dudu-0223, @pku-xht
* Publish the Python SDK runtime for Windows x64 by @tianyicui
* Complete ACP support for standard session controls, model settings, MCP, permissions, and cancellation by @tianyicui, @pku-xht
* Include enabled plugin package names and versions in official DeepSeek requests; deployments can turn this off by @tianyicui
* Add opt-in incremental Session-log uploads to official DeepSeek requests by @tianyicui
* Add an experimental Inspector tool by @imccyu
* Add an experimental Web Preview by @imccyu
* Show connection status, tolerate temporary host stalls, and support automatic retries or immediate reconnection after a disconnect by @imccyu
* Show active schedules in the conversation header across viewport sizes by @pku-xht
* Let parent Agents and continuable child Agents exchange follow-up messages through `send_message`, replacing the one-way `report` tool by @Dudu-0223

<h3>Improvements</h3>

* Reduce code loading, data transfer, and parsing during page startup and conversation initialization by @lsdsjy, @imccyu, @Kingwl, @kermanx
* Reduce the disk space used by conversation records by @Magolor
* Improve icons, directory loading, and file search in the `/` and `@` menus, with pointer-based directory navigation by @Yifffan, @LegGasai
* Switch the primary action to Send and queue the message when a draft is entered during a running turn by @lsdsjy
* Keep file and conversation references valid when adjacent composer text is edited by @LegGasai
* Preserve unfinished question-card drafts when switching conversations by @LegGasai
* Keep code blocks syntax-highlighted while responses stream in the conversation view by @07akioni
* Render question history as readable question-and-answer cards with clear cancelled and interrupted states by @LegGasai
* Show images immediately while compression and upload continue in the background by @CreatixChu
* Count image usage during context compaction by @CreatixChu
* Show images from users, assistants, and tool results in Trajectory by @CreatixChu
* In local-filesystem mode, let the model locate uploaded images and read extensionless attachment paths through `read_image` by @CreatixChu
* Improve image compression speed, reduce upload size, and preserve more detail in very tall or wide images by @CreatixChu
* Warn when automatically repairing a truncated conversation-log tail and identify the affected conversation by @turtle1999
* Group plugins by conversation and global scope, with Agent Preset switching and cross-preset search by @LegGasai
* Improve menus, scrolling, tool file links, and diff statistics in the conversation and composer UI by @Yifffan
* Reduce unnecessary filesystem checks when loading conversations on macOS and Linux by @LegGasai
* Improve processing efficiency for long conversations and dense live messages while reducing memory use and rendering overhead from streaming responses, syntax highlighting, layout, and navigation previews by @Dudu-0223, @imccyu, @07akioni
* Report the effective endpoint and error details when `web_search` fails by @CreatixChu
* Refine the home-page logo animation by @Yifffan
* Reuse Profile request headers for custom model discovery; add search and filtering to the model catalog by @LegGasai

<h3>Bug Fixes</h3>

* Fix persistent PowerShell starting too early and returning incomplete output on macOS and Linux by @tianyicui
* Fix persistent Bash returning empty output early during pipeline reads on Linux by @LegGasai
* Fix host stalls on macOS when Bash commands spawn many subprocesses by @LegGasai
* Fix the Windows directory picker truncating paths that contain characters such as 「开」 by @tianyicui
* Fix persistent Bash and PowerShell results not expanding in the conversation view by @LegGasai
* Fix Profile-configured Agent Preset directories being lost at startup by @LegGasai
* Flag Agent Presets that cannot load and explain why switching failed by @LegGasai
* Remove the unsupported `/goal` command from the Minimal preset by @Magolor
* Accept `null` placeholders for file-edit fields unused by the selected operation by @lsdsjy
* Keep PTC Mode SDK features inside `run_code` instead of exposing them as directly callable tools by @CreatixChu
* Send periodic WebSocket heartbeats to keep idle connections alive by @lsdsjy
* Keep a new blank conversation from displacing existing conversations in the collapsed Workspace list by @lsdsjy
* Fix the workflow section order in the system prompt by @LegGasai
* Reduce npm package-resolution cost by trimming unnecessary peer dependencies by @imccyu
* Fix startup failures and broken HMR on Node.js 24.0–24.11.1 by @imccyu
* Return keyboard focus to the Settings trigger after the dialog closes by @LegGasai
* Correctly echo and reliably deliver images added or queued while a conversation is running; follow-up messages to continuable subagents also support images by @CreatixChu
* Complete highlighted slash commands with `Tab` while the command menu is open by @mektpoy

<h3>Chores</h3>

* Update the [Safety Notice](SAFETY.md): DeepSeek Harness has not been security-audited, and sandboxing, approvals, and permissions do not guarantee isolation by @turtle1999
* Keep Shell guidance ahead of other tool instructions in the model prompt by @LegGasai
* Use the Remote gateway as the unified remote-call API and error-dispatch mechanism, with the legacy APIProxy removed by @imccyu
* Split the conversation UI into focused modules so developers can import the layer that owns each capability by @imccyu
* Require the one-time token in the launch URL when accessing the Web interface over a network by @tianyicui
* Launch applications through `dsh` Profiles, including Python SDK and ACP modes by @tianyicui
* Update pi-ai model support and add controls such as the vLLM thinking budget by @tianyicui
* Stream progress to stderr during headless runs while keeping stdout limited to the final result by @lsdsjy
* Rename Code Mode to PTC mode while keeping existing conversation records readable by @tianyicui
* Enable public WebFetch by default with SSRF protection and no per-request approval for public network access by @Dudu-0223
* Remove the optional SQLite Session persistence backend; existing content is not deleted, so use an older version to export it by @tianyicui
* Enable `web_fetch` by default for the Python SDK, Headless, ACP, and custom Profiles by @koalazf99
* Stop exposing the general-purpose `workflow` tool by default in Web PTC Mode by @koalazf99
* Replace `Session.events` with on-demand read APIs: `seq`, `eventAt()`, and `snapshotEvents()` by @kermanx
* Distinguish `SessionSeq` from `SessionLogOffset` with strong types while preserving forward compatibility by @tianyicui, @imccyu

---

Full Changelog: https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.1-rc.2...dsh-v0.1.2-rc.1
