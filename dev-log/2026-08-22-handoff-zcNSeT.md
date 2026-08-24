# Handoff — 2026-08-22

## Purpose
继续 DSH Desktop「公司插件市场 + 客户端锁定」项目的实施（Phase 1 起），以及跟进 Windows CI 安装包的 decompress 报错排查。

## What Was Done
- Windows 打包 workflow 已建成并推到 fork（LCorleone/deepseek-harness-desktop，master）：`.github/workflows/windows-package.yml`。跑通（跳过根 `yarn check`，因上游 `module-resolution.spec.ts` 在 Windows 上必挂——POSIX 断言写死，是上游 bug）
- 已加静默安装冒烟测试 + 产物 SHA256 步骤（commit `3956a571a8`），用于定位用户机器 "failed to decompress files" 报错
- 安全方案讨论定案：4 层模型（L1 策略锁定/L2 签名市场/L3 打包加固/L4 检测取证替代 IT 交接）；用户已接受安全上限——小白用户全路径封死，专业用户只能被抬高成本+留篡改证据
- 设计文档（EN+zh 成对，98 行×2）：`.agents/notes/proposed/architecture/2026-08-22-company-market-and-client-lockdown.md`(+.zh.md)，**未 commit**
- 实施计划 v2 已由 herdr planner 面板产出并验收通过：21 卡（P1×6/P2×7/P3×4/P4×4），依赖图无环，cited 文件 23/23 核实存在。全文已存 `dev-log/2026-08-22-company-market-lockdown-plan-v2.md`
- 勘误：P3-1 直接依赖是 P2-5（非 P2-4）
- 技术选型二次确认：调研了竞品 Minke（lencx/Minke，同为 harness 桌面壳）——插件零验签、来源硬编码（npm+github）、7 天库龄，不适合企业锁定场景，维持 DSH Desktop；但其 forge fuse 配置（asar integrity + OnlyLoadAppFromAsar + 关 CliInspect/NodeOptions）已验证与 harness 子进程模式兼容，已补入计划 P3-2/P3-4 作参考实现
- 第二个竞品 dataelement/dsh-desktop（第四范式独立实现，v0.1.1）：market-installer 已实现但零验签、asar:false、14 个 patch 直改上游包（违反「上游不可改」红线）——结论参考不采用；其 pnpm 安装工程细节已补入 P1-3/P2-3 参考，security-policy.ts 风格已补入 P1-1。克隆件在 /tmp/dshd-research（临时）
- 上游 v2.0.2 已合入 fork master（067805a799，含 Windows 安装器 Unicode 解压修复 9d18856dde，实为 useZip:false 一行修复）——用户本地「failed to decompress files」根因即此上游 bug
- 用户机器环境情报已闭环：NSIS「failed to decompress files」根因 = 上游 v2.0.2 已修的 useZip bug（fork 已合入）；fork CI 新版（含安装冒烟）已正常安装到用户本地，**安装耗时也恢复正常——EDR/同步软件嫌疑解除归档**；官方签名包对照实验不再需要；推广前同事机器实测安装耗时仍保留为 P3 阶段待办

## Current State
- **Working on**: 全部 21 卡完成（Phase 1-4，含三轮评审修复）；待 push 最后两个 commit（P4-1 `8c713a4fae` + P4-2/3/4 `bd7e9e7eba`）
- **Blocked on**: 无（CI 由用户盯；P4-3 签字、密钥演练、发布管线真实运行属部署侧待办）
- **Known issues**: gh CLI 已恢复可用；上游 CI 有失败记录（Action required，不影响本仓）

## Phase 1 实施记录（2026-08-22 追加）
- 全部 6 卡 commits：P1-1 `3103531c8b` / P1-4 `940078b52f` / P1-5 `7acd0f8aba` / P1-2 `dc4d87eb7f` / P1-3 `fda4e2c336` / P1-6 `be1f800f96` + 接线 `dcdbbb22b5`

## Phase 2 实施记录（2026-08-22 追加）
- P3-1 捆绑 Node 两步完成：`e7c8819d96`（step 1：node v22.23.2 钦定 sha256 经 beforePack 下载落 extraResources `node-runtime/`；pnpm/desktop-cli/materializer/终端 shim/Win ACL runner 五类调用方全切捆绑 node；ELECTRON_RUN_AS_NODE 从 src/ 零出现并由 verify-runtime-closure 门禁钉死；dev 态回退 PATH node；DSH_BUNDLED_NODE_ARCHIVE 离线覆盖）+ `afdb5f0c8a`（step 2 不可逆点：runAsNode fuse false，门禁+spec 同步）
- P3-1 验收：根 check 全绿 desktop 929；worker 实跑 electron-builder --dir 全链（beforePack 下载→extraResources→afterPack 门禁→捆绑 node --version=v22.23.2→CLI 冒烟 0.1.1-rc.2）；fuse 线读数确认第一步 true（回滚点）已验，第二步 false 待 CI 打包验证
- P3-1 待办：① GUI 三面冒烟（终端/plugin add/Market，无 GUI 环境留 CI+人工）；② fuse 第二步后 VM 验证 `ELECTRON_RUN_AS_NODE=1 ./app` 不进 node 模式；③ mac 签名机确认 node 二进制被签；④ README i18n hash 已刷新（worker 遗漏我补）；⑤ g++ 不支持 gnu++20 的 npmRebuild 失败属本容器限制，发布构建用 `--config.npmRebuild=false`
- P3 剩余：P3-2（asar integrity + 收缩 asarUnpack，依赖 P1-1✅/P3-1✅ 可开）、P3-3（签名更新通道，依赖 P2-7✅ 可开）、P3-4（fuse 全集，依赖 P3-1✅/P3-2）
- P2-1 签名库 `51d45e8f6c`（canonical JSON + detached ed25519 + sequence/expiresAt，零新依赖，market 包 src/signing/）
- P2-2 公司 provider `e99f5a8472`（fail-closed 整目录拒、revoked 排除、sequence 先持久化再产目录、origin/content 双模式）
- P2-3 安装签名校验 `a07d97eac7`（三链收敛：签名 integrity=registry integrity=实测树摘要；authority 纯内存零网络；不可信闭锁至更新 sequence；receipt v2 仅作对账凭证，放行永不读）
- P2-4 启动校验 + P2-5 CLI 签名通道 `66057db924`（承重墙：第三方 bundle 全验、拒载不入 Loader 图、上游永远可启动；CLI 仅放行精确 pkg@ver 验签条目；market d.ts 双 cordis 副本问题用类型门面 src/market-signing-types.ts + tsconfig paths 解决）
- 根 check 全绿：market 352 + desktop 894（P2-4/5 后 desktop +76）
- P2-6 发布管线 `bcc80441af` + P2-7 文档 `f4cb6043e8`：`tools/company-catalog/`（cli.mjs：build/revoke/verify/keygen/selftest；零依赖；密钥仅环境变量；selftest 8 段含离线模式；根 package.json 加 catalog 占位脚本；.github/workflows/company-catalog.yml 手动触发 selftest）——注意 bundlePatch 是必填非空字段，pipeline 已按 schema 对齐
- **Phase 2 全部 7 卡完成 ✅**（commits：51d45e8f6c / e99f5a8472 / a07d97eac7 / 66057db924 / bcc80441af / f4cb6043e8）；根 check 全绿
- 待办：① push 触发 CI；② P2-6 真实 registry 段 selftest（本地离线跳过）；③ P2-7 演练（轮换+吊销各一次，待真实密钥就位）；④ receipts v1 存量用户升级后全部拒载 → 发布说明需引导重装（计划已记风险①）
- Phase 2 评审（reviewer-code，2026-08-22）：红线全过；发现 2 High + 2 Medium + 2 Low：**A** CLI 批准通道装完被 boot 拒（`^1.2.3` specifier vs 严格相等断言）；**B** bootVerificationInputs 生产未接线；**C** 内嵌资产 per-user 可写 + CLI 门无序列下限；**D** 畸形 v2 receipt throw；**E/F** 双实现无防漂移护栏 → 全部修复于 `c9e8c773e4`（--save-exact 注入、main.ts 生产接线 receipts+manifest 字节、CLI 门 receipts 棘轮、畸形 receipt 降级 manifest-only、门面/树摘要护栏 spec）；修复后 desktop 914 用例、根 check 全绿；已 push（894e82223f..c9e8c773e4）
- P2-7 密钥定案（随 `f4cb6043e8` 提交）：设计文档 EN+zh「决策记录 — 密钥管理」章节；`dsh-community-market/SECURITY.md/.zh.md`「公司部署（锁定构建）」章节；SECURITY.i18n.yaml hash 刷新、docs 门禁绿
- Phase 1 接线期发现并修正：P1-2 worker 初版把公司 provider 钉在 `dsh-market`（上游内嵌市场，安装路径不受策略管控）——已改为 `community-market`（本仓市场壳，source 锁 + install authority 全在此生效），单测同步
- 接线机制：desktop main.ts 启动时 `readDesktopPolicy()` → 贯穿 market snapshot / profile 准备 → `hostCtx.provide('desktopPolicy', policy)`（boot 回调先于 Loader 组包，顺序有保证）；market index.ts `ctx.get('desktopPolicy')` 同步读，缺能力 = 独立部署不锁（market 零 desktop import，架构门禁绿）
- pnpm 审计精确化：`--registry`/`--<scope>:registry` 仅当值精确等于 `https://registry.npmjs.org/` 时放行（market 默认 flags 保持兼容），其余一律拒
- Phase 1 锁定语义：source 锁死公司占位源（内建 dshfind，P2-2 换签名公司目录）+ 安装 reject-all（P2-3 换签名 manifest 查询）+ CLI add 拒绝 + home patch 拒启
- 本地环境补课：deepseek-harness 子模块已 init（b150a551b8），根 `corepack yarn check` 全绿（285+815 用例）
- Phase 1 评审（reviewer-code，2026-08-22）：红线全过；发现 Critical（provider 钉死未贯通组合层，升级路径可让上游 dshmarket 在锁定构建启动并打开无审计 external install 边界）+ 2 Medium（pnpm 审计 deny-list 可被 -C/--dir 类绕过；installPlugin 接受位置参数夹带包目标）+ 1 Low（锁定可持久化 dsh-market 请求）→ 已全部修复并提交 `894e82223f`（组合分支改用 effective + 回归测试含反向验证、审计改 allow-list、锁定拒绝非公司 provider 持久化）；**遗留不修已记录**：`pnpm.ts` PINNED_NPM_REGISTRY 硬编码与 P2 market `allowedRegistryOrigin` 注入互斥，P2 接线时改为从 DesktopPolicy 派生并双向对齐

## Phase 3 实施记录（2026-08-22 追加）
- P3-1 捆绑 Node 两步完成：`e7c8819d96`（step 1：node v22.23.2 钦定 sha256 经 beforePack 下载落 extraResources `node-runtime/`；pnpm/desktop-cli/materializer/终端 shim/Win ACL runner 五类调用方全切捆绑 node；ELECTRON_RUN_AS_NODE 从 src/ 零出现并由 verify-runtime-closure 门禁钉死；dev 态回退 PATH node）+ `afdb5f0c8a`（step 2 不可逆点：runAsNode fuse false，门禁+spec 同步）
- P3-1 验收：根 check 全绿 desktop 929；worker 实跑 electron-builder --dir 全链（beforePack 下载→extraResources→afterPack 门禁→捆绑 node --version=v22.23.2→CLI 冒烟 0.1.1-rc.2）；fuse 第一步 true 回滚点已验，第二步 false 待 CI 打包验证
- P3-1 待办：① GUI 三面冒烟（终端/plugin add/Market，留 CI+人工）；② fuse 第二步后 VM 验证 `ELECTRON_RUN_AS_NODE=1 ./app` 不进 node 模式；③ mac 签名机确认 node 二进制被签；④ 本容器 npmRebuild 失败（g++ 不支持 gnu++20）属环境限制，发布构建 `--config.npmRebuild=false`
- P3 剩余：P3-2（asar integrity + 收缩 asarUnpack）、P3-3（签名更新通道）、P3-4（fuse 全集）
- P3-2 `99905c571a`：fuse 三件套启用（onlyLoadAppFromAsar + embeddedAsarIntegrity + runAsNode:false）；**卡片「native 最小集」假设不成立**（读码+ENOTDIR 实证：终端 dsh CLI/pnpm/诊断 worker 都经捆绑 node 加载 lib+node_modules，必须物理）——实际收缩只移 build/** 图标入 asar，新增 archive-only 分区门禁（禁止物理泄漏）；附带修 P3-1 遗留 bug（dshBootstrapPath 传 asar 虚拟路径给捆绑 node 打包态必炸）；README 双语 advisory（无 Authenticode 时 fuse 可翻回=成本项）；--dir 实打包全链验过
- P3-3 `28ffdb85df`：更新产物+清单独立密钥 ed25519 detached 验签（ARTIFACT_TRUST_ROOTS 占位，P3-4 替换）；验签失败→invalid-artifact 且 .partial 清理不落盘；清单 sequence 拒更旧（best-effort 持久化，损坏仅削弱防回滚永不放行）；端点钉死+可注入；P3-4 需接 sequenceStatePath 到 electron 层
- P3 进度 3/4 时点记录（后续已全部完成并 push）
- P3-4 `cbede6754b`：fuse 全集（8 项）+ verifyCompanyReleaseChecklist 门禁组 + P3-3 遗留接线；--dir 实读 fuse wire 全对；**Phase 3 全部 4 卡完成 ✅**；根 check 全绿 desktop 1016 用例
- Phase 3 评审（reviewer-code，2026-08-22）：红线全过；供应链钉扎/验签链/门禁体系评价高。发现 2 High + 2 Medium + 3 Low：① P3-2 策略资产未收口（unpacked desktop-policy.json 可改 trustRoots/locked，asar integrity 实际只保护图标）② 捆绑 node 零运行时校验（计划 P3-1④ 摘要自检未实现；打包态缺失静默回退 PATH）③ fuse 门禁只比对配置不读二进制 + checklist 读 src/ 而非打包树 ④ 信任根文本匹配可绕、Linux integrity no-op 未标注
- Phase 3 评审修复 `e9c2785877`（已 push）：主进程策略/摘要清单改走 asar integrity 路径；CLI 策略改 env 注入（4 变量烘焙进 shim，打包态缺 env fail-closed，dev 回退读文件）；捆绑 node 启动期 sha256 自检（lipo 预合并保 universal 一致；mtime+size 缓存；PATH 回退已删）；门禁升级：@electron/fuses 实读二进制 fuse wire（实测发现 electron-builder 在 afterPack 后才翻 fuse，门禁内先 flip 再读）+ checklist 改读打包树真实策略资产 + 信任根跨行正则；Linux integrity no-op 双语标注。根 check 全绿 desktop 1053 用例；--dir 门禁链 exit 0；实机篡改/删除 node 均拒启。**残余面（诚实定性）**：lib/** 双存使主进程 asar 路径非硬边界；env 注入后攻击面=改 unpacked desktop-cli.js（与改 JS 同权限）——修复消除的是廉价 JSON 篡改通道，硬保证仍需代码签名（未来 Authenticode 升级点，写 P4-3 签收单）

## Phase 4 实施记录（2026-08-22 追加）
- P4-1 `8c713a4fae`：诊断导出新增 self-check-report.json（boot 全量 allowed/refused + RFC 0004 证据词汇 + 策略资产 sha256 + node 自检状态 + manifest sequence/keyId）；canonical detached ed25519 签名（view-key 占位数组，dev 态 unsigned+警告）；scripts/verify-diagnostics-report.mjs 零依赖验签工具（--fingerprint/--key-id 钉扎）；boot 快照持久化 <userData>/boot-verification.json（unlocked 写 null 清除）；根 check 全绿 desktop 1074；待办：GUI 三面导出人工验证（CLI headless 已通）
- P4 剩余：P4-2 证据链手册、P4-3 残余风险签收单、P4-4 发布门禁收口（均为文档/门禁卡）
- P4-2/3/4 `bd7e9e7eba`（我直接实施）：P4-2 双语篡改证据链手册（docs/tamper-evidence.md/.zh.md：字段→能证明/不能证明表、先验签后分析流程、报告缺失=首要篡改信号）；P4-3 双语签收声明（.agents/notes/implemented/architecture/2026-08-22-residual-risk-acceptance.md/.zh.md：R1-R7 残余登记表 + 零改动 IT 升级点，待管理层签字）；P4-4 release-preflight 新增 assertCompanyReleaseConfiguration（打包前拦：锁定策略变体、更新/诊断信任根非空、fuse 全集 8 位，可注入 override 全测）
- **21/21 卡全部完成 ✅**；根 check 全绿 desktop 1080 / market 352；待 push
- Phase 4 评审（reviewer-code，2026-08-22）：红线全过、P4-1 代码评价「教科书级 fail-safe」；发现 3 High + 5 Medium + 6 Low：① P4-4 门禁零调用者（无构建路径接它）② 公司签名路径生产不可达且「客户端持私钥」设计矛盾 ③ 手册 exit 码/命令名与代码不符（+preflight 正则误拦多行/双语文档未进门禁等）→ **用户拍板方向 B**：删除客户端签名路径，显式降级为「报告缺失即信号」模型（与已签收上限自洽）；已派 worker 修复（70328d9d）：门禁接线发布路径（smoke 免疫）、手册勘误、正则/i18n/脚本加固全套

## Artifacts
- `dev-log/2026-08-22-company-market-lockdown-plan-v2.md` — 实施计划 v2 全文（唯一权威版，勿用 v1）
- `.agents/notes/proposed/architecture/2026-08-22-company-market-and-client-lockdown.md` + `.zh.md` — 设计文档（已提交 `f4cb6043e8`，含 P2-7 决策记录）
- `tools/company-catalog/` — 签名目录发布管线（P2-6，README 含 runbook）
- `.github/workflows/windows-package.yml` — Windows 打包 CI；`company-catalog.yml` — 管线 selftest
- planner 会话文件：`/root/.pi/agent/sessions/--opt-july-pi_tasks-deepseek-harness-desktop--/2026-08-22T01-39-21-753Z_*.jsonl`

## Suggested Skills
- herdr — planner 面板（w2:p3，名字 planner）还活着，可继续用 `herdr_prompt` 问计划细节或派生新卡
- handoff — 本文档；继续滚动存档

## Decisions Log
- 唯一信任锚 = ed25519 签名 catalog manifest（公钥内嵌应用）；npm registry 降级为传输层；receipt 只作缓存提示，永不作放行依据（存于用户可写 settings scope，可伪造）
- manifest 含单调 sequence + expiresAt（防回滚/倒逼滚动）
- P2-4 启动校验为承重墙：只过滤第三方 bundle，`REQUIRED_BUNDLES`(profile.ts:49) + `dsh-plugin-desktop` + `dsh-community-market` 永不过滤（兼容模式红线）；覆盖「用户自装上游 CLI 直写 DSH_HOME」旁路（拒载不拦装）
- P3-1 捆绑 Node 运行时 + 关 runAsNode fuse 为打包加固核心；Authenticode/perMachine 砍掉留条件附录（无 IT 合作，拿不到证书预算）
- market 包不得依赖 desktop 实现（architecture 门禁）——策略一律构造注入
- 用户本地无环境：所有构建/验证走 GitHub Actions（fork：LCorleone/deepseek-harness-desktop，remote 名 `fork`）
- 不 commit 除非用户明说（本会话已获准逐卡 commit）；设计文档已随 P2-7 提交
- P2-7 密钥定案（2026-08-22 用户拍板「先简单一些」）：**CI secrets 方案**——专用发布环境 + 最小人员 + 与代码仓库权限隔离；KMS/HSM 留为未来升级路径（客户端只认公钥指纹，零改动可迁）；更新通道密钥独立于 catalog 密钥
