# Agent 笔记：P8 Agent 网页操作能力（agent-browser）

状态：Proposed

2026-09-03 按 P8 设计评审修订：guest partition 落点（P0）、重定向执法点、截图保留口径、persist UUID 生命周期、快照成本与 generation 纪律；改动处标 *(rev: 2026-09-03 review)*。

[English](2026-09-03-agent-browser.md) | 中文

## 结论速览

P8 = 让 agent 能操作真实网页：嵌入式 webview 页面 + 最小 CDP 面（DOM/Runtime/Input/Page 四域）+ 人机协作接管。参照 Minke 路线但不烧子模块，全部走 dsh-plugin-desktop 动态 host 插件；吸收 scout-cua 的动作规范化与上下文管理结论，拒绝其薄弱的危险确认。目标 CDP 层 <1000 行。

## 八节要点

1. **窗口/挂载**：独立 native-ui BrowserWindow（sso-gate 先例），主窗口 `webviewTag` 保持 false；新窗口 `webviewTag:true + sandbox + contextIsolation`（窗口级不设 partition——那只会选中嵌入器自身会话）；**partition 落在 guest**：`<webview partition="…">` 属性随视图模型动态渲染，`will-attach-webview` 处理器（本就要装）改写 `webPreferences.partition` 兜底并消毒，未设 partition 的 webview 会静默落入应用默认会话；partition 仅首次导航前可设，与 persist 开关 restart-applied 正好互洽；guest 拒弹窗；默认 1120x760 / min 720x540；v1 单窗口单 webview、工具互斥、先到会话持有。Electron 43 webview 仍可用；embedder 永不脚本化 guest（自动化全走主进程 CDP）。*(rev: 2026-09-03 review)*
2. **IPC 与拓扑**（已核实代码修正前提）：host 树由 main.ts `boot()` 直接跑在 Electron 主进程，与 `ElectronDesktopRuntime` 同进程——工具→执行器是进程内调用，新增 `desktopAgentBrowser` capability（main.ts provide，desktopActions 同款）。真实 IPC 仅两段：浏览器窗口用新 preload contextBridge + `webContents.send`；Web 客户端横幅用同源 loopback 路由 + SSE（directory-picker 先例）。截图经 `attachments.saveImage`→ImageBlock，日志不落 base64。
3. **最小 CDP**：四域命令表见英文版；**ref=backendNodeId（e<base36>），generation 单调计数器**（仅主框架导航、open/navigate 完成与人工释放接管时 +1；DOM mutation 只标脏、下次快照前失效 ref 缓存——活跃 SPA 上逐事件自增会让 act 调用大面积 STALE 假阳性；单个元素的真失效信号是 ref 生命期即 resolveNode 校验），act 工具校验 generation，过期返回 STALE_SNAPSHOT 错误回灌。getDocument depth 默认收紧 12–16、超预算即浅层重取（截断标记只封输出文本，不封主进程事件循环上的输入转换/遍历成本），快照计时入 B1 验收。观察零注入（DOM 域树遍历），isolated world 仅用于受审计的 act 助手（focus/scroll/读非敏感值）。不需要 Runtime.addBinding（流程全 host 发起，下载/弹窗走 Electron 原生事件）。坐标用 CSS px + 截图声明尺寸，cua 的分辨率对齐问题构造性规避；**backendNodeId 优先、坐标兜底**。*(rev: 2026-09-03 review)*
4. **工具集与提示词**：`browser_open/navigate/snapshot/click/type/scroll/wait/screenshot/claim_control` 九件（host 全局层注册，locked 构建单 preset 等价可见）；OBSERVE→RESOLVE→ACT→VERIFY 纪律 + 动态上下文（当前 URL/generation/claim 态）经 `ctx.systemPrompt.section/context` 注入。**动作 normalizer**（cua 教训①）：execute 内纯函数规范化别名参数（left_click/coordinate/ref_id/无 scheme url 等）~150 行。错误分型：STALE/REF_NOT_FOUND 自纠回灌、OPERATOR_HAS_CONTROL 快速失败、瞬时 CDP 错误退避重试（≤3 次 ≤2s）。**页面文本一律视为不可信数据**，不执行页面内嵌指令（防 prompt injection；结构性缓解已在：URL deny、跨源 ask、claimControl）；截图 presentationMeta 的保留 hint 仅作未来标记，0.1.1-rc.2 无消费方。*(rev: 2026-09-03 review)*
5. **安全红线落地**：①危险动作（跨源导航/表单提交）走 `tools/pre-execute`→ask，注册表自动路由审批 seam 至现有 ApprovalService 审批 UI（插件无需自取服务），不新建面；下载 v1 在 will-download 直接取消并上报——对卡片「下载走审批门」的有意更安全偏离（取消时可能残留 .crdownload 临时文件，属临时清理范畴）；②partition 落在 guest（见第 1 节），默认一次性随机 token；`persist:` 需 policy `agentBrowser.allowPersistLogin` + 用户显式开启，persist UUID 在开启时一次铸造、存 Desktop settings 文档、跨启动复用（按浏览器会话铸造会静默击穿持久化）；清除流程 = 关窗口释放 guest → `session.fromPartition(p).clearStorageData()` → 删分区目录 → 轮换新 UUID（Windows 文件锁/service worker 残留使删活目录不可靠）；③密码框三重屏蔽：快照 host 侧过滤 + isolated world 提取白名单不读 value + browser_type 硬拒并指引 claimControl（截图靠原生圆点）；VERIFY 读非密码值会把 claimed 期间人录明文带进上下文——与截图等价的有意接受面；④claimControl 三入口（窗口按钮/客户端横幅/模型工具），claimed 态 act 快速失败、in-flight 走 signal 中止、光标高亮由 overlay 层画（getBoxModel 坐标，零页面注入）；⑤desktop-policy 新增 `agentBrowser{enabled,allowOrigins,allowPersistLogin}` 键（严格解析器 9→10、环境交接 6→7、两个 policy JSON + spec），locked 默认暗、dev 默认 `*`；执法点全部提交前：open/navigate 前 + guest `will-navigate`（渲染器主框架导航）+ `will-redirect`（服务端 30x，preventDefault 整链阻断），`frameNavigated` 降为事后兜底检测；allowlist 只管主框架，iframe/子资源可触达非白名单源（页内外泄属页面行为）；违规导航 deny。*(rev: 2026-09-03 review)*
6. **渲染端边界**：client/native-ui 全部 Node-free，既有 renderer-node-globals 机器门自动覆盖新文件；webview 是 guest 进程 DOM 元素不在门禁语义内。
7. **批次**：B1 只读闭环（第 1 天先做半天 fallback spike：验证 sandbox 嵌入器下 webview 可挂载 + debugger 可 attach；窗口+CDP+快照/screenshot+prompt section+policy 骨架，4–5d；验收含：guest session partition == token、浏览后默认会话目录零新增、快照计时预算）→ B2 动作闭环（click/type/scroll+normalizer+审批+密码拒绝+overlay+claim 状态机，4–5d）→ B3 人机协作+登录态（SSE+横幅+claim_control+partition/persistLogin，3–4d）→ B4 策略+打磨（allowlist/重定向/下载、截图保留 hint 存在且被记录、红线测试、fallback 决策备注，3–4d）。每批文件清单与验收测试见英文版。*(rev: 2026-09-03 review)*
8. **风险与量级**：webview「不推荐」姿态（适配器隔离，spike 已前移 B1 第 1 天，WebContentsView fallback）；快照成本落在共享主进程事件循环（depth 收紧 + 浅层重取 + 计时验收缓解）；DevTools 抢 debugger（detach 重连一次）；四域 CDP 稳定；0.1.2 耦合 = 5 个稳定 seam + policy 环境交接条数；合计 **14–18 人日**。*(rev: 2026-09-03 review)*

## 外部参照取舍记录

- 采 Minke：webview+debugger 路线、DOM 域快照+resolveNode、Input 真实输入、Page 截图；不采烧录子模块与 4.8k 行 CDP。
- 采 cua：动作 normalizer（OperatorNormalizerCallback 同型）、策略挂生命周期钩子（映射到 dsh 既有 tools/execute 包装器、post-execute、compaction 折叠、systemPrompt.context，不建新机制）、瞬时/致命错误分型、backendNodeId 优先坐标兜底；**截图保留不按 cua 方案落地**——上游 pruner 只按字符预算修剪、非文本块永不被剪，v1 = compaction 整体折叠 + 截图节俭提示纪律，presentationMeta hint 留作未来标记。*(rev: 2026-09-03 review)*
- 不学 cua：危险动作确认自建（其 URL 黑名单仍是 TODO）；human_tool 人肉队列过重不采用。

## 文件级改动清单

见英文版「File-level change list」：新增 `src/agent-browser-{contract,cdp,session,window,preload,normalize,policy}.ts`、`src/agent-browser.ts`、`src/native-ui/agent-browser/*`、`src/client/agent-browser-ui.tsx` 及配套 specs；修改 `package.json`、`tsdown.config.ts`、`vite.native-ui.config.ts`、`cordis.patch.yml`、`src/desktop-policy.ts`、`src/policy/*.json`、`src/main.ts`、`src/client/index.ts`。不动子模块、不动 dsh-community-market 运行时、不动主窗口 webPreferences、不动 preset pruner 配置（截图保留不靠 pruner）。*(rev: 2026-09-03 review)*
