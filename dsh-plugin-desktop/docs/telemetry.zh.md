# 桌面端上报（遥测）——数据字典与运维手册

> 2026-09-07 定稿。适用 DSH Desktop ≥ #62 构建。库：公司 MySQL `DSH_LOG@10.173.59.16:3306`。
> 换库/换址 = 重新生成 `usage-report-db-blob` 随版本发布（见文末）。

## 0. 隐私红线（先读这个）

只记**分类元数据**：谁（SSO 邮箱）、何时、结果码、包名、版本、计数。
**永远不上报**：对话内容、prompt、搜索词、文件路径、token 明文。
失败原因文本双层清洗（秘密形掩码 + 路径形遮蔽 `‹path›`），`operation-failed`
类只报错误码不带文本。上报失败**静默丢弃**（计数），绝不阻塞登录/启动/安装。

## 1. 两张表

### dsh_model_call_events — 模型用量（P5，高频）

一次模型调用一行。列：`user_email, provider, model, base_url,
input/cache_read/cache_write/output/reasoning/total_tokens, tokens_per_second,
ttft_ms, latency_ms, session_id, turn, step, client_version, created_at`。
写入节奏：内存队列 50 行或 10 秒双触发批量 flush；连不上退避重连（1s→60s），
队列上限 5000 行溢出丢最老。

### dsh_client_events — 客户端事件（2026-09-07，低频）

列：`event_type, user_email, client_version, detail(JSON), created_at`，
索引 `(event_type,created_at)` + `(user_email,created_at)`。
每事件独立新连接、单行 fire-and-forget、失败即丢。

## 2. 事件字典（dsh_client_events）

| event_type | 触发 | detail 字段 |
|---|---|---|
| `sso_login` | 每次登录尝试（静默+浏览器两条路径） | `result` success/failure · `mode` silent/browser · `reason`（失败时，掩码+240 上限） |
| `catalog_refresh` | 每次启动各通道目录解析（稳定+beta 叠加各一条） | `outcome` applied/fetch-failed/no-sso-identity/not-a-tester… · `sequence` · `entries`（applied 时） · `channel` stable/beta-overlay |
| `plugin_install` | 安装/升级/卸载/回滚/失败 | `packageName` · `version` · `outcome` installed/updated-in-place/**uninstalled**/rolled-back/failed · `channel`（**uninstalled 无此字段**——被删版本的交付渠道不可知，不猜） · `reasonCode`（失败码） · `reason`（仅固定词汇安全码才有） |
| `boot_verify` | **仅当启动有插件被拒**（成功不打扰） | `rejected:[{packageName, code}]`（8 码：not-pinned-newer-pinned/revoked/digest-mismatch/signature-invalid/compat-unsupported/manifest-missing/manifest-invalid/other）· `loaded` |

## 3. 常用查询（老板面板直抄）

```sql
-- 每日活跃（谁今天开过客户端）
SELECT DATE(created_at) d, COUNT(DISTINCT user_email) DAU
FROM dsh_client_events WHERE event_type='sso_login' AND result=1  -- JSON 里看 detail
GROUP BY d ORDER BY d DESC;
-- 注：result 在 detail JSON 里，用
SELECT d, COUNT(DISTINCT user_email) FROM dsh_client_events
WHERE event_type='sso_login' AND JSON_EXTRACT(detail,'$.result')='success'
GROUP BY d ORDER BY d DESC;

-- 发布传播（seq 16 推到了谁）
SELECT user_email, MAX(created_at) FROM dsh_client_events
WHERE event_type='catalog_refresh'
  AND JSON_EXTRACT(detail,'$.sequence')>=16
GROUP BY user_email;

-- 谁还没更新到 0.4.184（装了但版本旧）
SELECT user_email, MAX(JSON_UNQUOTE(JSON_EXTRACT(detail,'$.version')))
FROM dsh_client_events WHERE event_type='plugin_install'
  AND JSON_EXTRACT(detail,'$.outcome') IN ('installed','updated-in-place')
GROUP BY user_email;

-- 插件流失（卸载信号）
SELECT user_email, created_at, detail FROM dsh_client_events
WHERE event_type='plugin_install'
  AND JSON_EXTRACT(detail,'$.outcome')='uninstalled'
ORDER BY created_at DESC;

-- 启动被拒排查（版本硬切换/吊销的落地观测）
SELECT * FROM dsh_client_events WHERE event_type='boot_verify'
ORDER BY created_at DESC LIMIT 20;
```

## 4. 换库 / 换地址 / 换账号

```bash
# 1. 新库建两张表（DDL 见 dev-log/2026-09-07 或本文 §1 列清单镜像）
# 2. 重生成 blob（明文只活在当次环境变量里）
DSH_REPORT_DB_HOST=… DSH_REPORT_DB_PORT=3306 DSH_REPORT_DB_USER=… \
DSH_REPORT_DB_PASSWORD=… DSH_REPORT_DB_DATABASE=… \
  node dsh-plugin-desktop/scripts/make-usage-report-blob.mjs
# 3. 更新 tests/model-usage-reporter.spec.ts 钉值测试（host/user/database）
# 4. commit → 构建 → 全员换装。旧库在 fleet 换完前别停（双写期）
```

开发态免发版调试：`DSH_REPORT_DB_HOST/_PORT/_USER/_PASSWORD/_DATABASE`
环境变量覆盖（仅未打包运行生效）。

## 5. 加一个新事件类型（工程师清单）

1. `client-event-reporter.ts`：detail 类型 + 投影纯函数 + collector 方法
   （类型白名单字段，不透传大对象）；
2. 挂钩点 fire-and-forget（**永不 await 阻塞宿主**，永不抛）；
3. 若事件源在 market 包：走 `desktopClientEventReporter` 注入能力
   （缺省 no-op），不得 import desktop；
4. 测三姿势：成功投影 / 降级（policy off、连接失败）/ 隐私（无路径无秘密）；
5. 本文档 §2 加一行。低频原则：每 boot/每用户操作 ≤1 行，高频进用量表。

## 6. 事实速查

- 账号 `july` 当前为建表级权限——上报只需 INSERT，建议换只写账号（遗留项）
- 双连接隔离：用量表（池+退避）与事件表（单行单连）互不影响
- policy `usageReport:false` = 两条链路整体不接线（合规开关）
- 真机实证：2026-09-07 四类事件全落库（#62，julu 机器）
- 遗留 P3：`conflict` 码 reason 在 Linux 自定义 profile 目录下可漏目录名
  （desktop 侧路径遮蔽盖默认布局）；`/var`、`/srv` 前缀不在遮蔽表
