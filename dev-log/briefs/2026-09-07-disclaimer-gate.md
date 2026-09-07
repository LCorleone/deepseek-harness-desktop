# 内测声明弹窗 — 装后/更新后首启一次，拒绝即退出，决策入遥测

## 1. Goal & background

老板拍板（2026-09-07 20:49）：SSO 登录成功后弹「内测声明」；同意才进桌面，
不同意直接退出（本次会话不可用）；决策上报 dsh_client_events。
触发判定=**按版本一次**（本地 ack 记录 版本+声明文本哈希：无记录=刚装、
版本变=刚更新、哈希变=声明改版——三者都弹，日常启动零打扰）。

## 2. 声明文案（v2 定稿逐字；无「更多」折叠）

内测声明
1.您输入的内容和上传的文档不能涉及个人敏感信息及高度保密信息。
2.您使用本工具进行的处理活动应遵守德勤中国的数据处理要求，不得使用本工具进行重要数据的处理。
3.您应确保相关文档自合法来源收集，并您有权使用和处理相关文件及内容。
4.本工具依赖于大模型算法，答案的准确性和完整性可能会受到多种因素的影响，您应当自行判断并确保所生成内容的准确性、合法性、道德性及可靠性，并承担使用本工具所带来的所有风险和责任。
5.您在使用上要严格遵守德勤及相关法律法规、监管要求及国家相关标准的指引及要求，包括但不限于以下：
国家互联网信息办公室：关于《生成式人工智能服务管理暂行办法》的通知
德勤亚太：关于生成式人工智能（包括ChatGPT）的临时使用指引
生成式AI合规指引(第一版)
6.此工具仅限于德勤内部学习及办公辅助用途，用户若将本工具用于向具体客户交付项目，必须事先咨询 PIC 及业务风险团队。
7.如有任何关于Deloitte Deepseek Harness的相关问题，请联系 cndchatgen@deloittecn.com.cn。

按钮：「不同意」「同意」。
**风格=品牌风（老板拍板）**：Deloitte 品牌绿主按钮+品牌字体气质，
复用 agent-browser-styles.ts 的设计令牌体系（--dsw-alias-brand-primary 等，
worker 把该模块的 token 注入方式借到 disclaimer 窗口），顶部品牌标识
（可用 build/ 现有 icon 资产或纯字标 DSH Desktop，worker 判断，无 logo 图
则用品牌绿字标，不引入新资产文件）。

## 3. Code map（2026-09-07 21:00，master 6448da36c1，行号近似）

**弹窗窗口范式（照抄）**：`src/native-ui/sso-gate/`（App.tsx+main.tsx+html）
+ `src/sso-gate-window.ts`（native 窗口宿主，CSP/同源结构）——新
`src/native-ui/disclaimer/`（App.tsx+main.tsx）+ `src/disclaimer-window.ts`。
vite closeBundle 守门：html 引用不得逃层（P8 教训）。
**挂点**：`src/main.ts:610` adoptSession（SSO 成功后、主窗 mount 前）——
silent/browser 两条路径都汇到 adoptSession，插在此处天然「AAD 之后」。
不同意 → 走与 X 退出同款优雅退出链（app.quit→before-quit teardown，
参考 electron-shell-generation.ts 的 requestShellWindowClose 模式）。
**ack 存储**：`app.getPath('userData')/disclaimer-ack.json`
（electron-runtime.ts:150 已有同目录 state 先例）。形状
`{ clientVersion: string, textHash: string, acknowledgedAt: string }`。
写入仅同意时。判定函数纯化导出（`needsDisclaimer(current, ack?)`）供测。
**遥测**：`src/client-event-reporter.ts`——新 event_type `'disclaimer'`，
detail `{ decision:'agree'|'disagree', clientVersion, textHash }`；user_email
归因用现 attribution；照抄 pluginInstall 的投影+collector 方法模式；
**telemetry.zh.md §2 加一行**（文档同步）。
**声明文本哈希**：sha256(文案 JSON 常量)——文案常量放
`src/disclaimer-text.ts`（导出条目数组+标题），哈希计算纯函数导出供测。

## 4. 设计定案（不重开）

- 老板三项拍板（2026-09-07 20:54）：拒绝丢行=接受；风格=品牌风；文案 v2（上方）。
- 拒绝路径：**也上报**（disagree 行落库后才退）——上报 fire-and-forget，
  退出不等 flush（可能丢行：接受，注释说明； collector 单行独立连接，
  10s 内无 flush 队列——给 agree/disagree 都立即发一次即可，丢行容忍）。
- 判定时机：adoptSession 后同步判定；需弹时挂起主窗 mount 流程
  （await 窗口结果），拒绝=退出，同意=写 ack+继续。SSO gate 窗口先关。
- 免打扰面：dev/unpackaged 也生效（规则一致，便于真机验证）。
- 文案在代码常量（不走 blob）——非机密，改版=改代码=发版，可接受。
- 窗口样式：对齐 sso-gate 的朴素风（标题+滚动区+两按钮，同意为主按钮）。

## 5. Conventions & constraints

- 渲染端 Node-free 门禁；file:// 同源结构；CSP 沿用 sso-gate 模板。
- 不动子模块/staging；单 commit 不 push；vitest+typecheck 双跑。
- 遥测隐私线照旧（本事件 detail 无自由文本，纯枚举+哈希）。

## 6. Acceptance criteria

1. 判定函数测：无 ack→弹；ack 版本同+哈希同→不弹；版本变→弹；哈希变→弹。
2. 集成测（fake 窗口注入）：同意→ack 写盘+agree 事件+流程继续；
   拒绝→disagree 事件+退出链调用+无 ack。
3. 事件投影测：detail 形状钉死（三字段+枚举）。
4. native-ui 结构过 vite 守门（build 冒烟）；渲染端零 node 依赖。
5. telemetry.zh.md §2 行已加。
6. desktop vitest 全绿+typecheck 0，报新增测试数。
