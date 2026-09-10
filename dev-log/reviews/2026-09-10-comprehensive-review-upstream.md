# 上游更新参考面调研评审（deepseek-harness）

**日期** 2026-09-10 23:00 · **性质** 只读调研报告，未改任何源码、未 commit（子模块仅 `git fetch origin`，工作区仍钉在 a66e470204，`git status` 干净）

## 结论（先行）

1. **上游已长出官方 Electron 桌面端**（`apps/desktop` + `apps/desktop-host`，0.1.5 线）：无监听端口、捆绑 Node/pnpm、独占 profile、自带打包/签名/公证/自动更新。与我们产品正面重叠，是最重要的战略信号，也是最好的免费参考面。
2. **升 pin 有三颗已确认的雷**：agent-presets 新默认字段（教训⑦ 同类）、session 格式 v2/v3 三个 `!` 破坏性提交（升后不可回滚）、默认模型改 V41 Flash。全部可控，但都必须进升级清单。
3. **一次升 pin 建议直接对 0.1.5-rc.2**（跳过 0.1.3-alpha 死线），分四波；时机上建议等 rc.3/GA——本周上游出现「feature 当天 revert」（图表预览、同会话编辑），抖动未平。

## 0. 增量盘点

- **窗口**：pin a66e470204（0.1.2-rc.1，2026-09-03）→ origin/master c291e7961a（0.1.5-rc.2，2026-09-10）。共 1629 提交（非合并 1084；非 test/ci/docs 628；fix 386 / feat 95 / perf 15）。途经 tag：0.1.3-alpha.1/2（死线）、0.1.5-alpha.1/2、0.1.5-rc.1/2。
- **client/ui**（~912 文件、+52k 行）：侧栏体系大改（tab 导航、文件树、文档/图片预览、dockkit 可停靠引擎）、feedback 对话框、composer 菜单重组；图表预览与同会话消息编辑上线后即被 revert。
- **desktop（新增主题）**：官方 Electron 壳——`dsh-app://` 协议 + 分帧字节管道承载 Fetch（不开端口）、内置上游 Node/pnpm、`$DSH_HOME/profiles/desktop` 独占与单实例锁、插件管理渲染进程、electron-builder 全平台签名/公证（并行化）/自动更新（块复用）。
- **sandbox/subprocess**：73 个 fix(subprocess)（Linux 取消/清理竞态、native containment 契约收口）；fs 有界字节窗口（local + e2b 可取消）。
- **skill**：Playwright 录浏览器 GIF、侧栏 skill 预览、共享 fuzzy 候选排序。
- **plugin API/manifest**：manifest 新增可选 `manifestVersion`/`categories`/`engines.dsh`（现不强制）；manifest 类型集中到 `dsh-package-manifest`；desktop 插件管理器 UI。
- **市场（对位）**：上游无市场；对位物是插件管理 UI + categories/engines 元数据。
- **安全**：无 CVE 级修复；相关项=公证校验收紧、win32 native containment 缺口、http-proxy 拒绝值不下传 `NODE_USE_ENV_PROXY`。
- **性能**：session v2 嵌入 assistant 流 + 迁移流式化、settled 流不重放、mac 公证并行、bundle 提速、IPC 优化。
- **session/persistence**：v2 嵌入流（`!`）、released 迁移（`!`）、V2→V3 身份迁移、跨进程写租约、**同步事件读取废弃**（#3828）。

## 1. 值得抄的（8 项）

| # | 上游 | 解决什么 | 我们的现状 | 成本/风险 |
|---|---|---|---|---|
| 1 | `acceptIdentity`（llm-deepseek/translate.ts） | 空/null tool-call id/name 不再清空已建立身份 | 我们有等价但更弱的补丁 `patches/dsh-llm-deepseek@0.1.2-rc.1.patch`（`if (call.id)`） | **升 pin 时直接删补丁**，零成本 |
| 2 | manifest `engines.dsh`/`categories`（220678e57d，12 行） | 插件声明宿主兼容与分类 | `dsh-plugin-desktop/src/desktop-market.ts:318` 清单无该字段 | 低：市场卡片加显示即可；上游暂不强制，无雷 |
| 3 | `modeSelectionEnabled:false`（#3870 + agent-presets） | 部署可强制 config.default 并藏 preset 选择器 | 我们靠删除持久选择（`src/profile.ts:274-291`）+ includeShippedRoot（:1136-1142） | 低：随升 pin 在锁定层显式置 false，比现行删值更干净 |
| 4 | apps/desktop 无端口架构 | 消灭端口归属/认证/CORS/暴露面 | 我们 host 起 HTTP（`patches/dsh-web-app` openBrowser:false）+ Electron 加载 URL | 高：整条 boot 链重构；先立项预研，随大版本升 pin 落地 |
| 5 | mac 公证并行化（9c14f2785f）+ 更新块复用（22461aedb0/d5363c8839） | 发布耗时、增量更新体积 | `dsh-plugin-desktop/package.json:387` notarize:true（串行）；`src/update-download.ts:232` 全量 stateVersion | 中：借 `apps/desktop/scripts/notarize-macos-disk-images.mjs` 思路，不动子模块 |
| 6 | 启动恢复可重试（d55b2b3dad） | 包重建/恢复失败可重试而非死路 | `src/startup-failure-routing.ts:23-26` 仅 last-known-good 单向 | 低-中：抄状态机思路到我们的恢复窗 |
| 7 | settled assistant 流不重放 + 迁移流式化（84c11c7243 等 7 个 perf） | 长会话 UI 卡顿 | `src/session-projcache-recovery.ts:21` 有投影缓存恢复，但无「不重放」 | 只能随 pin（与格式 v2/v3 耦合，不可单摘） |
| 8 | skills Playwright GIF（e57e7dc57f） | 技能文档配浏览器操作动图 | `dsh-company-skills`（skill-creator）纯文本步骤 | 中：公司技能包增强，独立于 pin |

## 2. 破坏面预警（教训⑦同类雷排查）

1. **[教训⑦同类] agent-presets schema 变形**：`default` 可选→必填，**新增 `modeSelectionEnabled` 注册默认 true**——不显式处理时，用户旧选择/可见选择器继续左右新会话默认 preset（与 includeShippedRoot 完全同型：zod 新默认字段静默改行为）。同位雷我们处理过（`src/profile.ts:1136`），升级时锁定层必须显式置 false 并核对 CLI lock overlay（`src/cli-lock/desktop-cli-lock.patch.yml:78-81` 同病先例）。
2. **[教训⑦同类] 默认模型 → DeepSeek V41 Flash**（bc5fd3b8dc）+ 图片 token 官方 v41 计算器（a64dc3a690）：我们 model-gateway 隐藏 llm-deepseek 目录、只发 DSV4-DSH（`src/model-gateway.ts:33-34`、`profile.ts:274-291` 删用户默认选择）——门应能挡住 Chat Completions 默认值，但**图片定价/估算口径变化会穿透 token-meter**，须专项回归。
3. **session 格式三个 `!`**（f99b06eaed 嵌入流 / d1521ea783 迁移 / bec6805d6a 写路径重构）+ **V2→V3 身份迁移**：会话库单向迁移，**升 pin 后不可回滚到 0.1.2**；`agent-default-model`/selection 语义可能随迁移变动。
4. **token-meter stateVersion 上游自发演进**（contextBreakdown 2→4）：我们的 `patches/dsh-token-meter`（2→3/4→5 clamp）必须对上游新版本重推导，且首启要做投影状态迁移演练（衔接 session-projcache-recovery）。
5. **session-controller client 拆包**（client.ts → client/sessions/service.ts，api/ +10k 行）：我们 1 行 selection patch 落点漂移（`if (persisted !== undefined) this.selection.set({})` 现在在 service.ts:634），history.ts +123 行。
6. **win32-process 大改**（subprocess +7397 行、native containment、STARTF_* 常量化）：我们的 dwFlags 257 patch 需按 `abi.*` 重写；**但 adapter 依赖的模式枚举未动**（sandbox 包仅 96 行插入，`'read-only'|'workspace-write'|'danger-full-access'` 原样）——`src/windows-pwsh-sandbox.ts:317` 契约本身稳，升 pin 时按注释重放即可。
7. **同步 session 事件读取废弃**（#3828）：我们 `model-usage-reporter.ts:991`、`notifications.ts:133` 用的是订阅流非历史读，**现无影响**；属观察项。
8. **client/ui 全面重构**（ui-conversation +1499、ui-primitives +1701 行）：5 个 client-ui 补丁（拖放 data 属性等）全部需重放，工作量集中在批 2。
9. **图表预览、同会话消息编辑已被上游自己 revert**——不要摘，也不要自研撞车。

## 3. pin 升级路线建议（下一次升 pin = 0.1.5 线，跳过 0.1.3-alpha）

- **批 0（现在即可，不动 pin）**：市场清单加 `engines.dsh`/categories 显示（#2）；公证并行脚本思路评估（#5）；无端口架构预研立项（#4）。
- **批 1（pin 升到 0.1.5-rc.2+，低风险补丁波）**：`dsh-settings`（上游 src 零改动，重放即过）、`dsh-llm-deepseek`（**删**，被 acceptIdentity 取代）、`dsh-app-boot`（null 守卫，核对仍需要）、`dsh-web-app`（openBrowser/ELECTRON_RUN_AS_NODE）；同步做 agent-presets `modeSelectionEnabled:false`（#3）+ 保留 includeShippedRoot + 模型默认门回归（雷 1/2）。
- **批 2（同批后半，重放波）**：token-meter（对齐 contextBreakdown v4，雷 4）、api-session-controller（拆包后重定位，雷 5）、agent-loop（EMPTY_TOOL_NAME 30 行核对 loop seam）、win32-process（abi 常量重写，雷 6）、client-ui×5（雷 8）。
- **批 3（等/随大版本）**：session v3 写路径与一次性迁移演练（明确「升后不可回滚」并留备份，雷 3）；workspace-files/资源 API 到位后评估**替换**我们的 file-path-bridge 与 directory-picker-browse 补丁（73 行那个可能整体消失）。
- **时机**：rc.2 仅 1 天新且有 revert 抖动，建议 rc.3 或 GA 后动手；全程对上游只 fetch 不 checkout。

## 4. 方法与证据

- 增量清单：`git log --oneline HEAD..origin/master`（默认分支 origin/master）；主题归类基于 628 条非测试提交逐类 grep + 关键 diff 抽查（translate/agent-presets/token-meter/sandbox/manifest/session-controller/win32-process 均已核对到行）。
- 上游桌面端：`git show origin/master:apps/desktop/README.zh.md`（关键决策表）+ `apps/desktop/scripts/*`。
- 我们侧引用均为主仓文件（子模块内容未做任何修改）。
