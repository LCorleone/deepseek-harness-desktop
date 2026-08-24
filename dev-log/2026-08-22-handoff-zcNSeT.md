# Handoff — 2026-08-22

## Purpose
DSH Desktop「公司插件市场 + 客户端锁定」项目实施。**本会话已交付完成**：21 卡计划（Phase 1-4）全部落地、四轮安全评审及修复闭环、全部 push。本文档为终态归档。

## 交付总览

**计划**：`dev-log/2026-08-22-company-market-lockdown-plan-v2.md`（21 卡，P1×6/P2×7/P3×4/P4×4）
**终态**：fork master = `b5ef752291`（LCorleone/deepseek-harness-desktop）；根 `corepack yarn check` 全绿（desktop 1087 + market 352 用例）；子模块零改动；解锁/dev 全程零回归。

| Phase | 范围 | Commits |
|---|---|---|
| P1 策略锁定（L1） | 策略源/provider 钉死/安装白名单/home patch 拒启/CLI 门禁/source 锁 | 3103531c8b, 940078b52f, 7acd0f8aba, dc4d87eb7f, fda4e2c336, be1f800f96, dcdbbb22b5 |
| P2 签名体系（L2） | ed25519 签名库/公司 provider/安装三链收敛/启动承重墙/CLI 签名通道/发布管线/密钥定案 | 51d45e8f6c, e99f5a8472, a07d97eac7, 66057db924, bcc80441af, f4cb6043e8 |
| P3 打包加固（L3） | 捆绑 Node+runAsNode 关/asar integrity/签名更新/fuse 全集 | e7c8819d96, afdb5f0c8a, 99905c571a, 28ffdb85df, cbede6754b |
| P4 检测取证（L4′） | 签名诊断报告→缺失即信号模型/证据链手册/残余风险签收单/发布门禁 | 8c713a4fae, bd7e9e7eba |
| 评审修复 ×4 | 详见各 Phase 段 | 894e82223f, c9e8c773e4, e9c2785877, b5ef752291 |

## Current State
- **Working on**: 无——计划交付完成
- **Blocked on**: 无（CI 由用户盯，最后一批 = `e9c2785877..b5ef752291`）
- **Known issues**: 上游 CI 有失败记录（Action required，不影响本仓）；本容器 npmRebuild 失败（g++ 无 gnu++20），发布构建用 `--config.npmRebuild=false` 绕过

## Phase 1 · L1 客户端策略锁定
- 6 卡 + 接线（见上表）。锁定语义：策略资产构建期内嵌（dev/release 双变体，release=locked 为默认）；effective provider 钉死 `community-market`（本仓市场壳）；source 锁死公司源；安装 reject-all（P2 前全拒绝）；CLI add 拒绝；home patch 拒启。
- 接线机制：main.ts `readDesktopPolicy()` → market snapshot/profile → `hostCtx.provide('desktopPolicy')`（boot 回调先于 Loader）；market `ctx.get()` 同步读、零 desktop import。
- pnpm 审计：allow-list（`--save-exact`/`--reporter=ndjson`/registry=精确 npmjs 值，其余全拒含位置参数与 `-C/--dir` 类）。
- **评审与修复**（`894e82223f`）：Critical = provider 钉死未贯通组合层（升级路径可启动上游 dshmarket + 无审计 external install 边界）→ 组合分支改用 `effective`；2 Medium（审计 deny-list 绕过/位置参数夹带）+ 1 Low（锁定可持久化 dsh-market 请求）同批修复。
- 遗留已记录：PINNED_NPM_REGISTRY 硬编码 vs P2 `allowedRegistryOrigin` 注入互斥——P2 接线时对齐（后续 P2-3 实现时 registry 注入默认 npmjs，实际兼容）。

## Phase 2 · L2 签名体系 + 公司市场
- **P2-1** 签名库：canonical JSON（键 UTF-16 排序、零空白、逐字节重序列化校验防搬运）+ detached ed25519（Node `algorithm=null` 坑已注释）+ sequence 单调 + expiresAt；零新依赖。
- **P2-2** 公司 provider：验签失败整目录丢弃（fail-closed 不降级）；revoked 排除出候选但保留可查；sequence 先持久化再产目录（跨进程防回滚）；origin/content 双模式（content 用 `.invalid` 占位 finalUrl）。
- **P2-3** 安装三链收敛：签名 integrity = registry dist integrity = 安装后实测树摘要；authority 纯内存零网络；不可信状态闭锁至严格更新 sequence；receipt v2（树摘要+RFC 0004 证据词汇）仅作对账凭证，**放行判定零读 receipt**。
- **P2-4** 启动承重墙：第三方 bundle 全验（manifest 条目∩lock integrity∩receipt 树摘要），拒载不入 Loader 图，上游永远可启动；覆盖外部 CLI 直装（拒载不拦装）；无 receipt = manifest-only 放行（evidence 标注）。**P2-5** CLI 签名通道：仅放行精确 `pkg@ver` 验签条目，拒绝先于 import 上游 CLI。
- **P2-6** 发布管线 `tools/company-catalog/`：build/revoke/verify/keygen/selftest，零依赖，密钥仅环境变量（`COMPANY_CATALOG_SIGNING_KEY` base64 PKCS#8），tarball origin 钉 npmjs。**P2-7** 密钥定案：CI secrets + 双钥重叠轮换 + 吊销重发 + 更新密钥独立（决策记录入设计文档与 SECURITY.md 双语）。
- **评审与修复**（`c9e8c773e4`）：High A = CLI 批准安装装完被 boot 拒（`^1.2.3` specifier，fixture 掩盖）→ `--save-exact` 注入；High B = bootVerificationInputs 生产未接线（receipt 对账+棘轮死代码）→ main.ts 接线；C/D/E/F 同批修复（CLI 序列下限、畸形 receipt 降级、门面/树摘要防漂移 spec）。

## Phase 3 · L3 打包加固
- **P3-1** 捆绑 Node v22.23.2（sha256 钉死下载/缓存/离线覆盖同强度校验）两步落地：step1 五类调用方（pnpm/desktop-cli/materializer/终端 shim/Win ACL runner）全切捆绑 node、`ELECTRON_RUN_AS_NODE` 从 src/ 清零（closure 门禁钉死）；step2 runAsNode fuse false（不可逆点独立 commit）。
- **P3-2** asar integrity 三件套启用；**卡片「native 最小集」假设不成立**（终端/pnpm/诊断 worker 经捆绑 node 消费 lib+node_modules，ENOTDIR 实证必须物理）——实际收缩仅 build/** 图标入 asar + archive-only 分区门禁；附带修 P3-1 真 bug（dshBootstrapPath asar 虚拟路径）。
- **P3-3** 签名更新通道：独立密钥 detached 验签（原始字节，无 canonical 需求）；验签失败→invalid-artifact 且 `.partial` 清理绝不落盘；清单 sequence 拒更旧（userData 持久化，损坏仅削弱防回滚永不放行）。
- **P3-4** fuse 全集 8 项（runAsNode/cookieEncryption/nodeOptions/nodeCliInspect/asarIntegrity/onlyLoadAppFromAsar/v8Snapshot/filePrivileges）+ verifyCompanyReleaseChecklist；electron-builder 无双配置，fuse 只作用打包二进制、dev 走未打包 Electron。
- **评审与修复**（`e9c2785877`）：High ① 策略资产未收口（unpacked JSON 可改 trustRoots，integrity 实际只保护图标）→ 主进程读 asar 路径 + CLI 策略改 4 变量 env 注入（打包态缺 env fail-closed）；High ② 捆绑 node 零运行时校验 → 启动期 sha256 自检（lipo 预合并保 universal 一致；mtime+size 缓存；PATH 回退删除）；Medium → @electron/fuses 实读二进制（发现 electron-builder 在 afterPack 后才翻 fuse，门禁内先 flip 再读）+ checklist 改读打包树。
- **诚实残余定性**：lib/** 双存使 asar 路径非硬边界；env 注入后攻击面=改 unpacked desktop-cli.js——修复消除廉价 JSON 通道，硬保证仍需代码签名（签收单 R1/R3）。

## Phase 4 · 检测取证与签收
- **P4-1**（`8c713a4fae`）：boot 快照持久化 `<userData>/boot-verification.json`（unlocked 写 null 清除）→ 诊断导出内嵌 self-check-report.json（allowed/refused 全量 + RFC 0004 词汇 + 策略 sha256 + node 自检状态 + manifest sequence/keyId）+ 零依赖验签脚本。
- **P4-2/3/4**（`bd7e9e7eba`）：双语篡改证据链手册（字段→能证明/不能证明表、取样流程）；双语残余风险签收单（R1-R7 + 零改动 IT 升级点，**待管理层签字**）；release-preflight 公司门禁。
- **Windows Package CI 修复链（2026-08-24）**：① `5e7090bad9` zip member 加版本目录前缀（nodejs.org win zip 嵌套结构，本地 fixture 掩盖、CI 干净环境炸 ADM-ZIP Entry doesn't exist）；② `2322954f6a` 真钥匙指纹钉入 release 策略 + embed-company-manifest.mjs 构建步骤（管线产物/assets 样例双候选入 lib/company-market/）+ files 白名单补 lib/company-market/*.json；③ 门禁 spec 对齐新缺口顺序。run 32708698357 绿（8m28s），安装包含 L2 全链 + 真签名 manifest（样例条目 ms@2.1.3）。用户问询「怎么装插件」已答：用户=市场 UI / CLI 精确版本两路；管理员=allowlist→管线 build→内嵌或托管发布；限制=仅 npmjs 公开包、审核责任在公司
- **评审与修复**（`b5ef752291`，用户拍板**方向 B**）：3 High 全修——① 门禁接线真实发布路径（mac 无条件/win `DSH_COMPANY_RELEASE=1`，CI smoke 免疫）；② 删除客户端签名路径（「客户端持私钥」与防伪造主张矛盾），报告恒定 `unsigned+reason`，检测模型=「报告缺失即信号 + 内容比对」（与已签收上限自洽）；③ 手册 exit 码/命令名/字段实形勘误。+5 Medium/6 Low（正则多行兼容、三对双语 i18n 入册、验签脚本加固等）。

## 部署侧待办（运营项，代码已备）
- **终审（2026-08-23）**：整体评价工程质量高，但发现 P0 交付完整性缺口：① L2 主链路未接线②发布门禁盲区 → **已全部修复于 `d63c85e88d`（已 push）**：market 锁定+有根时构造签名目录全链（provider content/origin 双模式 + sequence store + 签名 authority + 不可信闭锁，替换 dshfind 占位与 rejectAll；锁定无根 = 占位 + 显式警告 + 门禁拦截，启动永不因市场失败）；desktop CLI/boot 补 origin 模式；boot 树摘要持久化指纹缓存（命中跳过全量哈希，6 用例验证）；门禁补盲（trustRoots 非空 + content 模式打包树 manifest 构建期验签）；策略分发 ADR（main.ts 解析一次=唯一权威，其余通道皆投影，EN+zh+i18n 入册）。worker 被 API 限流打断一次，由第二个 worker 盘点半成品后续完；根 check 全绿 desktop 1100 / market 358
- ③ 签收单「已执行」表述待同步勘正（接线后基本成立，待我复核措辞）；P1 余项（⑥signing subpath 根治门面/⑦E2E 链路/⑧清单对账）与 P2 四条已记入优化清单待后续迭代
1. P4-3 签收单管理层签字归档
2. 密钥生成（catalog + update 各一对）→ P2-7 演练：轮换（双钥→收回）+ 吊销各一次
3. P2-6 管线真实密钥跑通 + selftest 完整段（含真实 registry）+ 托管/内嵌发布选型
4. 公司发布构建：`DSH_COMPANY_RELEASE=1`（win）+ preflight 占位密钥替换（`ARTIFACT_TRUST_ROOTS`）后验证门禁拦截
5. GUI 三面冒烟（终端/plugin add/Market）+ 诊断导出人工验证（CLI headless 已通）
6. VM 验证 `ELECTRON_RUN_AS_NODE=1 ./app` 不进 node 模式；mac 签名机确认捆绑 node 二进制被签
7. v1 receipt 升级引导文案（存量用户全部拒载后重装）；推广前同事机器安装实测

## Artifacts
- `dev-log/2026-08-22-company-market-lockdown-plan-v2.md` — 实施计划 v2（唯一权威版）
- `.agents/notes/proposed/architecture/2026-08-22-company-market-and-client-lockdown.md`(+.zh) — 设计文档 + P2-7 密钥决策记录
- `.agents/notes/implemented/architecture/2026-08-22-residual-risk-acceptance.md`(+.zh+i18n) — P4-3 签收单（待签）
- `dsh-plugin-desktop/docs/tamper-evidence.md`(+.zh+i18n) — P4-2 取证手册；`diagnostics-self-check.md`(+.zh+i18n)
- `tools/company-catalog/` — P2-6 发布管线（README runbook）
- `.github/workflows/windows-package.yml` / `company-catalog.yml`
- planner 会话：`/root/.pi/agent/sessions/--opt-july-pi_tasks-deepseek-harness-desktop--/2026-08-22T01-39-21-753Z_*.jsonl`

## Decisions Log
- 唯一信任锚 = ed25519 签名 catalog manifest（公钥指纹内嵌策略）；npm registry 降级为传输层；receipt 永不作放行依据
- manifest 单调 sequence + expiresAt（防回滚/倒逼滚动）
- P2-4 承重墙只过滤第三方；`REQUIRED_BUNDLES` + desktop + market 永不过滤（兼容模式红线）；外部 CLI 直装=拒载不拦装
- market 零 desktop import（架构门禁）；策略一律构造注入
- P2-7 密钥：**CI secrets**（专用发布环境+最小人员+权限隔离）；更新密钥独立；KMS 零改动可迁
- P3-2 卡片「native 最小集」假设被实证推翻——lib/node_modules 必须物理（捆绑 node 子进程消费）
- P4 评审方向 B（用户拍板）：诊断检测模型 = 报告缺失即信号 + 内容比对；客户端签名路径删除（私钥可提取，签名主张不成立）
- 无 Authenticode 下一切 fuse 均为成本项（文档已明示）；Authenticode/perMachine/WDAC 留签收单升级路径（客户端零改动）
- 不 commit 除非用户明说（本会话已获准逐卡 commit + push fork）

## Suggested Skills
- handoff — 本文档为终态归档；后续新会话以此为入口
