# Handoff — 2026-09-02

## Purpose
继续 DSH Desktop（LCorleone/deepseek-harness-desktop）公司定制工作。下一仗大概率是 P6 skill 资产防护（等用户三问拍板）或触发式待办。

## What Was Done
- **GitGuardian 泄露事故完整闭环**：SSO app_key 明文检出（公开仓）→ 当前树 blob 化（`src/sso-app-key-blob.ts` + 生成器 `scripts/make-sso-app-key-blob.mjs`，明文只经 env）→ git filter-repo 全历史重写（master/catalog-artifacts/标签，key 字符串零残留）→ 运维轮换 1007→1008（新 key 仅 blob，仓库零明文；`BUILTIN_APP_ID='1008'`）→ #43 装机直通验证。**仓库公开但凭据只以混淆 blob 存在是既定形态**；轮换=重跑生成器+发版。
- **私有仓迁移尝试后回退**：fork 公开仓无法转私有 → 迁私有仓因 Actions 计费未开通（workflows 全断）回退公开仓；私有仓残留改名 `deepseek-harness-desktop-private-obsolete` **用户拍板保留不删**。
- **P5 模型 usage 上报全链路闭环**：`src/model-usage-reporter.ts`（双事件订阅/四桶 total/队列 INSERT IGNORE/DSN blob/policy 第 9 键 usageReport）→ MySQL `dsh_usage.dsh_model_call_events` 实机入库（#42/#44 双验证，字段全对）。**口径定案**：vLLM 网关不返回 cache/reasoning details 且 pi-ai 把 reasoning 折进 output——三列恒 0 属正常，思考已计入 output/total，用户签收。
- **#10 甲 CLI 硬钳制 + #11 lint 守护落地**：`4a5881d6d3`+`ba51d552ff`（锁定 overlay 资产 `src/cli-lock/`、desktop-cli.ts 注入、fail-closed、GUI 环境抹除、row-id 钉扎测试）；`e6494eed9c`（`tests/renderer-node-globals.spec.ts` AST 剥注释+双视图）。评审批准，#44 装机回归通过+usage 实时入库。
- **P6 卡已开**（plan-v2 文档 Phase 6）：scout 五问全绿，路线 B 定调=容器插件 `ctx.skills.registerProvider()` + `resourceBase: opaque`（参照 skill-badge 65 行）。卡在三问：①脚本 stdin 管道 ②description 脱敏 ③会话明文签收或加码。
- 用户待办批注：双钥轮换**签收不换**（demo 钮 c469 继续）；GitGuardian/IT 回复 done；测试组扩面进行中。

## Current State
- **Working on**: 无进行中代码。全部已 push（master=a6a14b8fc0），#44 已装机验证。
- **Blocked on**: P6 三问（用户在想）；logo（等 SVG）；上游 0.1.2（等发版）。
- **Known issues**: origin remote=anywhere-labs 上游（223 commit 分叉警告是正常噪音，push 目标是 fork）；GitHub 对重写历史 ~90 天 reflog 可达（已轮换兜底）；devlog 里引用的旧 SHA（重写前）是幽灵引用；CI secrets 四个已恢复在公开仓（签名钥 c469 逐位验证）。

## Artifacts
- `dev-log/2026-08-22-handoff-zcNSeT.md` — 主 devlog（事故三节/轮换/批注/#10#11 落地记录）
- `dev-log/2026-08-22-company-market-lockdown-plan-v2.md` — 卡表（Phase 5 完结+运行口径 / Phase 6 开卡+scout 裁决）
- `dsh-plugin-desktop/src/` — model-usage-reporter / cli-lock / sso-app-key-blob / usage-report-db-blob
- DB：10.173.46.21:3306 `dsh_usage.dsh_model_call_events`（root 口令在会话交接；report_writer 仅 INSERT）

## Suggested Skills
- 无特定技能；继续沿用 worker/scout/reviewer-code 后台委派模式（用户明确要求 reviewer 后台跑）。

## Decisions Log
- 凭据入库形态=混淆 blob（gateway/DSN/SSO key 三处同模式），明文只经 env/会话；轮换=重跑生成器。
- 仓库保持公开（Actions 免费且用户接受 blob 软屏障）；私有仓路线因计费放弃。
- usage 三列恒 0 口径签收（网关不报+pi-ai 折叠），不做客户端估算。
- demo 签名钥不轮换（用户拍板）；-obsolete 私有仓保留。
- CLI 钳制=甲路线（spawn 侧）已做；乙（执行器纵深+堵 resume 旧 full-access 事件）留卡未做。
- 渲染端禁 Node 全局已是机器守门（lint 测试），评审员不再需要人肉 grep。
