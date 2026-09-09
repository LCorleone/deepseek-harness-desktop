# Client event telemetry — SSO login / catalog refresh / plugin install / boot events

## 1. Goal & background

用量上报（P5，`dsh_model_call_events`）已上线。本任务补**低频客户端事件**上报到同一
MySQL 库（新表 `dsh_client_events`，**已建好**，勿再动 DDL）：老板要观测 fleet 健康
与发布传播。四类事件一次做完，随 #62 发版。

隐私红线（延续 P5 姿势）：只记**分类元数据**——谁/何时/结果码/版本/包名。永远不上报
对话内容、文件路径、工作区名、prompt、token 明文。

## 2. Code map（2026-09-07 上午，commit e9fdd3782b，行号近似）

**dsh-plugin-desktop（Electron main，可直接 import 新模块）**
- `src/model-usage-reporter.ts` — **照抄的模块范式**：DSN 解析
  （`resolveUsageReportDbDsn`，blob+env）、队列/flush（50 行/10s 双触发）、
  mysql2 连接注入接口（tests 用 fake connection）、退避重连、日志只出计数不出内容。
  新模块应复用 `resolveUsageReportDbDsn` 与连接工厂姿势，**不新建 DSN 逻辑**。
- `src/company-sso.ts:149` — `SsoLoginResult` 联合（ok:true+session | ok:false+reason）；
  `silentSsoLogin` L1140 / `browserSsoLogin` L1227；调用点 `src/main.ts:585,601`。
  **事件**：`sso_login`，detail={result:'success'|'failure', reason?（失败一句话，
  已有的 silentReason 词汇）, mode:'silent'|'browser'}；email 取 session，失败可 null。
- `src/beta-channel.ts:153-157,239-265` — 目录刷新忽略码 `'fetch-failed' |
  'no-sso-identity' | 'not-a-tester'` + 成功路径 "beta catalog applied (sequence N)"。
  **事件**：`catalog_refresh`，detail={outcome:'applied'|<忽略码>, sequence?, entries?,
  channel:'stable'|'beta-overlay'}。stable-only 机器的成功路径在 boot-verification 或
  desktop-market 侧（scout 确认，勿漏：**每类 outcome 都要有事件**）。
- `src/boot-verification.ts:261-283` — 8 个拒绝码联合
  `'not-pinned-newer-pinned'|'revoked'|'digest-mismatch'|'signature-invalid'|
  'compat-unsupported'|'manifest-missing'|'manifest-invalid'|'other'`。
  **事件**：`boot_verify`，detail={rejected:[{packageName,code}], loaded:N}（每 boot 一行，
  仅在有 rejected 或按需——**默认仅 rejected>0 时上报**+成功不打扰，减噪声）。
  **[2026-09-10 P15 Phase 1 补记]**：触发条件扩为 rejected>0 **或 deferredUpdates>0**；
  detail 增可选 `deferredUpdates:[{packageName, requiredRuntime}]`（client-update-required
  延迟窗：已装版按安装回执继续加载、等客户端升级才能更新，**loaded 计数含延迟
  bundle**）；拒绝码 9 个（增 `client-update-required`；本段早期草拟的码名与实现
  不符，实际联合以 dsh-plugin-desktop/docs/telemetry.zh.md §2 为准）。
- `src/desktop-market.ts` — 市场编排（含 findDesktopCompanyManifestPackageWithBeta）。

**dsh-community-market（独立包，红线：不得 import dsh-plugin-desktop）**
- `src/install/service.ts` — `assertInstallOverlay`（直装替换）+ WAL 回滚。
  **事件**：`plugin_install`，detail={packageName, version, channel:'stable'|'beta',
  outcome:'installed'|'updated-in-place'|'rolled-back'|'failed', reason?}。
  **跨包缝**：参照该包现有拿到 SSO 身份的注入缝（company-provider 的 no-sso-identity
  判定依赖某 desktop 提供的服务/接口——找到同一缝，加一个可选 telemetry sink 接口
  （desktop 侧实现，market 侧 inject + 缺省 no-op）。Cordis 语义：**inject 必须声明**，
  否则运行时抛 cannot get property without inject。上游 `session-telemetry` 服务名已占
  （重复注册抛错）——**不要**注册第二个 'telemetry' 服务；用独立名
  （如 `client-event-reporter`）。
- 已有消费先例：desktop 侧横幅/合并键在 `src/catalog/company-provider.ts`。

**表结构（已建，测试用 fake 不碰真库）**
`dsh_client_events(id PK, event_type VARCHAR(64), user_email VARCHAR(320) NULL,
client_version VARCHAR(64) NULL, detail JSON NULL, created_at DATETIME(3),
KEY idx_type_time(event_type,created_at), KEY idx_user_time(user_email,created_at))`

## 3. Conventions & constraints

- 复用 model-usage-reporter 的测试姿势：fake connection 注入、不连真库、
  计数日志断言；**永不把 detail 内容打进日志**（只打 type+count）。
- 事件上报**永不阻塞/永不抛**到宿主流程（SSO 失败≠上报失败≠boot 崩）。
  上报器自身 fail 静默降级（沿用 P5 的 degradation 姿势）。
- 低频事件**不搞批量队列**：单条 fire-and-forget 即可，但连接失败要有界重试或直接丢
  （选直接丢+计数，注释说明低频容忍）。与 model-usage-reporter **共享连接**还是独立
  ——scout 评估，倾向独立轻实现（用量表高频连接池别被事件搅）。
- electron main 是唯一 MySQL 触点（渲染端 Node-free 门禁不动）。
- 双语注释按仓内惯例（英文主文件注释即可，docs 双语只在 docs/）。
- vitest+typecheck 双跑（#56 教训）；worker 长命令设 timeout。

## 4. Decisions made & failed attempts

- 表已由 orchestrator 建好（DDL 见上）——worker 不碰真库、不改 DDL。
- 新 DSN（DSH_LOG@10.173.59.16）已入 blob（commit e9fdd3782b，未 push）。
- 'telemetry' Cordis 服务名被上游占用，重复注册抛错 → 用独立服务名。
- 模型错误上报（provider 失败面）**本批不做**（用户圈定范围外，留待下批）。
- 上游 session-telemetry/OTLP 链路**不复用**（mode=DISABLED，语义不同）。

## 5. Acceptance criteria

1. 四类事件各至少：真实挂钩点（人审路径核对）+ 单测（成功/失败/降级三姿势）。
2. `corepack yarn workspace dsh-plugin-desktop vitest run` + `typecheck` 全绿；
   market 包同跑。新增测试数报数。
3. 渲染端零依赖新增（Node-free 门禁扫描绿）。
4. 不改 deepseek-harness/ 子模块、不改 DDL、不动 staging。
5. 单 commit（或按包拆两 commit），不 push，等 orchestrator 评审。
