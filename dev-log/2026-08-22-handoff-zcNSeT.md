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
- **里程碑（2026-08-26）**：试点安装链全程闭合——**dsh-better-sidebar@0.15.2 市场安装成功、重启加载** ✅；tag `v0.1.0-desktop-pilot`（包版本 2.0.3，构建 #21）；E2E 冒烟 12 步自动化已入库（`4d9dfde3af`）
- **Working on（下次会话入口）**：origin 模式切换收尾——GitLab 托管已验证可用（见下），**下一步：改 release 策略切 origin（companyCatalogOrigin=https://gitlab.s.dai.deloitte.cn、companyManifestUrl=https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json）→ 根 check → 打包 → 用户装包验证 GitLab 拉目录**；注意 manifestUrl 含 query/多段路径是否过 safeCompanyManifestUrl 校验需先跑 spec（若拒则需评估放宽或改用 GitLab Pages 类纯静态路径）
- **密钥状态**：会话内生成过两对演示钥，均已暴露于会话输出——**生产前必须作废重生成**；当前策略钉 c469 指纹，manifest sequence 3 用它签
- **Blocked on**: 无

## 试点期安全决策（2026-08-24）
- **裸 cordis peerDep 放行**（用户拍板）：`dsh-better-sidebar@0.15.2` 的 peerDependencies 同时声明 `@deepseek-ai/cordis: ^4.0.1`（真宿主）与裸 `cordis: ^4.0.0-rc.8`（疑似残留）；市场安装器对裸 cordis 的 legacy 拒绝检查会挡住市场 UI 安装。决策：改为「裸 cordis 4.x 且同时存在 `@deepseek-ai/cordis` 依赖时放行，否则维持拒绝」——仅放宽到共存场景，裸 cordis 作为唯一宿主仍拒。风险定性：这是对既有安全检查的试点期放宽，若上游包后续去掉裸 cordis 声明应回收紧语义
- allowlist 样例条目 `ms@2.1.3` 移除（非 DSH 插件，误导测试组）；首个正式条目 `dsh-better-sidebar@0.15.2`（runtime 范围 `^0.1.1-rc.2` 对齐 fork 钉定版本；0.16.0 未发布故不收；仓库 omdsh-dev 非我方可控，故选上述放行而非上游修）

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
- **CLI 静默回滚真因修复**（`39acad1d06`，已 push，CI 打包中）：插件装上却消失的完整链 = pnpm 11 对 node-pty 的 install 脚本报 ERR_PNPM_IGNORED_BUILDS 且退出非 0（包其实装好了）→ 上游 CLI 跳过 reconcile 不写 bundle 声明 → 桌面恢复事务静默还原声明文件（三个声明文件被回滚但 node_modules 幸存）。修复：① 桌面自动维护 profile 的 pnpm-workspace.yaml `onlyBuiltDependencies` 白名单（node-pty/esbuild/protobufjs，四个接线点盖市场+CLI 双路径，WAL begin 前执行保回滚不丢）；② 恢复回滚改醒目 stderr 警告不再无声。临时解法已给用户（Add-Content 白名单+重装）。根 check 全绿 desktop 1107
- **终审 HIGH 修复**（`2b634ab224`，已 push）：manifest 条目 repository 改为**必填**（schema+签名类型+provider 断言），管线从同一 packument 抓取真实仓库 URL（去 git+/.git）写入签名；catalogItem 直通 normalize 后身份 → 安装期回链比对通过；样例资产重签 sequence 2；端到端断言（真实 github URL 候选→preview+execute 成功、attacker/mirror 拒）；selftest 新增 repository-identity 段（在线 9/9）
- **8/25 评审收尾**（`097537d254`，已 push）：管线 repository 推导支持对象形式 packument（npm 主流写法，dsh-better-sidebar 实测）+ directory→subdirectory 映射；管线复用 market `normalizeRepositoryIdentity` 中止坏覆盖（签不出炸目录的 manifest）；shim spec 改用真实编码器展开（去 bug 形态字面量）；示例 manifest 回规范形+monorepo 条目；devlog 兼容性记录与归属勘误。8/25 评审结论：客户端修复全部验证通过，发布条件（2b634ab224 必须在包内）已满足；根 check 全绿 desktop 1099 / market 366
- **兼容性记录（2026-08-25 评审补记，对应 `2b634ab224`）**：repository 必填化是 schema 级**双向不兼容**变更——旧代码拒新 manifest（旧 schema `additionalProperties:false` 无 repository 字段，新条目多出的 repository 是未知字段）、新代码拒旧 manifest（新 schema 缺必填 repository）；两方向均 fail-closed（目录不可用 ≠ 不安全），无静默降级路径。**content 模式升级安全**：内嵌资产与验证代码同批原子分发；已扫过的机器棘轮 1→2 严格递增直接通过，全新/从未扫成功的机器无持久化记录（空记录过渡）首扫即过。**origin 模式需重签重发**：托管 manifest 必须用管线重出带 repository 字段的版本并重新上传；因新旧客户端互拒对方清单且单一 URL 只能服务一版，无交错兼容窗口——必须客户端整批升级与清单切换同批完成，混合期必有一侧目录不可用直至对齐（若需分流只能按 URL 分）。**下次破坏性变更改升版本号**：任何增删必填字段的 schema 变更都必须升 `manifestVersion`（1.0.0 → 1.1.0/2.0.0）并按版本分派验证逻辑，禁止同版本号内改契约（本次已同步入 `tools/company-catalog/README.md`）
- **试点条目 + 裸 cordis 放行**（`ad7fba2cf7`，已 push）：首条正式 allowlist 条目 `dsh-better-sidebar@0.15.2`（替换 ms 样例）；裸 cordis 共存放行（试点期放宽，见试点期安全决策）——裸 `cordis` 4.x 且同时存在 `@deepseek-ai/cordis` 依赖时放行，裸 cordis 作为唯一宿主仍拒（归属勘误 2026-08-25：此改动在 `ad7fba2cf7`，非 `32d999a037`）
- **试点反馈修复**（`32d999a037`，已 push）：① 内容模式同 sequence 重放被棘轮误拒（「一会能显示一会 unavailable」+「company-catalog 一直 Not checked yet」的根因——内嵌资产 sequence 固定，第二次扫描必 stale）→ 新语义：同字节同号放行、同号不同字节拒、回退拒；② 锁定时 settings 页隐藏 partner providers（viewBuiltIns 按锁定态过滤）
- **安装按钮修复**（`0585c86b5d`）：catalogItem 漏 repository 身份字段 → observeCatalog 准入过滤丢弃候选 → 详情回落手动安装提示；补 npm registry 页身份
- **CLI 策略 env 修复 + 评审 Low 收尾**（`3694a9a3a5`）：Windows `set "VAR="` 删除变量而非赋空 → 内容模式下 CATALOG_ORIGIN 空、shim 只带三变量、四条校验必炸（用户报 plugin add 报 all four entries）；改哨兵 `-` 编码/解码。评审 3 Low 同批：首扫即落 bytesSha256、持久化形状校验（损坏走 loud-brick）、锁定态 builtIns 空数组断言
- **启动崩溃修复链**（`485d74fb02`，已 push）：P3-2 图标收进 asar 后 lib 模块仍按 unpacked URL 相对解析 → nativeImage 失败 → 启动即挂 → 恢复窗 loadFile 又拿 asar 虚拟路径二次失败（双击无反应的根因）；修复=图标 archivedAsarPath 进 asar 区、recovery/profile-create 文档 unpackedAsarPath 钉物理区；全部模块相对资产消费点已审计（12 处）
- **评审与修复**（`b5ef752291`，用户拍板**方向 B**）：3 High 全修——① 门禁接线真实发布路径（mac 无条件/win `DSH_COMPANY_RELEASE=1`，CI smoke 免疫）；② 删除客户端签名路径（「客户端持私钥」与防伪造主张矛盾），报告恒定 `unsigned+reason`，检测模型=「报告缺失即信号 + 内容比对」（与已签收上限自洽）；③ 手册 exit 码/命令名/字段实形勘误。+5 Medium/6 Low（正则多行兼容、三对双语 i18n 入册、验签脚本加固等）。

## 8/26 评审修复记录（认知修正 + 遗留闭环）
- **A 链（企业 TLS）**：`15a7e01e27`（CA/代理透传 + stderr 尾部捕获）+ `d540fb75be`（C 方案放行 `NODE_TLS_REJECT_UNAUTHORIZED`，用户拍板试点期与 DSH Terminal CLI 路径对齐）。**认知修正（评审 High）**：spawn env 实为「清洗父环境 + 覆盖层」而非白名单重建——A 链根因**未闭环**：Windows Electron 启动环境可能缺变量（无 shell 捕获，不同于 CLI 继承路径），复发时靠 stderr 尾部定位真因
- **B 链（pnpm 构建防火墙）**：`39acad1d06`（profile pnpm-workspace.yaml 自动维护 `onlyBuiltDependencies` 白名单 + 回滚改醒目警告）——**端到端未验证**：#18 安装包死在 C 链之前，node-pty install 脚本首跑待真实机器检验
- **C 链（CLI 策略 env 注入）**：`e069eea82a`（pnpm.ts 将 `cliPolicyEnvironment` 注入 spawn 子进程，P3 漏网修复）——**#18 包不含此修复**；下一包（≥2.0.3）才是全修复版
- **版本标记**：2.0.3 起试点可区分构建（旧包 2.0.2 = 不含 C 链；新包 2.0.3 = A+B+C 全量）
- 评审其余结论：M5 封闭白名单记待办（见部署侧待办 ⑧）；Top3 风险 = node-pty 首跑 / TLS 真因 / 白名单封闭，均已对应上述跟踪点
- **D 链（市场 flag 误拒，`a238d27d97` 已 push，构建 #20）**：#19（2.0.3）市场安装报「exactly one package argument (got 2)」——市场链 spawn 的 desktop-cli 带 `--registry=<pinned>` flag，锁定通道把它当第二个包参数拒了（P2-5 只考虑了手输 pkg@ver 场景）。修复：通道精确消费安装器注入的 flag（--save-exact 一次 + 钉值 registry flag 至多两个，与 pnpm 审计同白名单，恶意 registry 值负例覆盖）。至此今日四链 A/B/C/D 全修，下包预期走到 pnpm 真实执行，唯一剩余变数=node-pty 首跑
- **8/26 评审修复收尾**（`9281384714`，已 push）：M1/M2 回归测试（策略 env 注入+stderr 尾部）、M3 版本 2.0.3、M4 devlog 补记、M6 env 断言 TLS stub、L1 物化前 ensure、L2 原子写、L3 市场回滚带原始错误；桌面 1109/market 367 全绿
- **E 链（pnpm 构建审批真语法，`b1a9b1ab30` + M1 护栏 `8787050cb2`，已 push）**：#20 市场安装仍报 ERR_PNPM_IGNORED_BUILDS——真因：**pnpm 11.0 起静默忽略 onlyBuiltDependencies**（v10.26 引入 allowBuilds map、11.23 写时删旧键），之前写的列表语法对捆绑的 11.7.0 无效。修复：workspace 同时维护两种拼写 + `strictDepBuilds: false`（未列构建依赖从失败降回警告，脚本执行仍由 allowlist 门控，非放行）。评审 Medium（mergeMapBlock 无缩进护栏可产非法 YAML 且不自愈——试点人群被指导过手工编辑该文件，触发面真实）已修：块扫描/插入限制在键行缩进内 + 两个触发用例；D 链补 registry flag cap 负例；版本叙事勘正（11.0 忽略非 11.23 换拼写）；桌面 1111/market 367 全绿。**构建 #21 用户实测：市场安装成功、重启侧边栏加载** ✅
- **E2E 安装冒烟自动化（优化清单⑦）完成**（`4d9dfde3af`）：scripts/e2e-install-smoke.mjs 12 步打包级回归（asar 资产/策略 env 链/真实 pnpm add/构建审批/boot 验签）——本周踩的全部安装链坑固化为自动回归；离线降级 SKIP；CI advisory 接入；本容器 linux --dir 全绿
- **origin 模式切换进行中（2026-08-26）**：用户建公开 GitLab 仓库 https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config（Deloitte 内部 CA、raw 匿名可读已验证）；manifest sequence 3 已用演示钥重签（含真实 repository）；**raw 已上传并验证通过**（632 字节单行 canonical、验签 OK、origin 无凭证/无 query/标准端口全部合规）。网页编辑器会把单行格式化成 pretty JSON 破坏验签——已改用 git push 流程。**待办：改策略切 origin（companyCatalogOrigin=https://gitlab.s.dai.deloitte.cn + manifestUrl=raw 路径）→ 打包**；后续上新流程=改 allowlist→build→git push 该仓库

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
8. onlyBuiltDependencies 目前硬编码三元组（node-pty/esbuild/protobufjs，`dsh-plugin-desktop/src/profile-pnpm-policy.ts`）：目录里第二个插件若携带其它原生构建依赖（sharp/sqlite3/bcrypt…）会复现 ERR_PNPM_IGNORED_BUILDS——长期方案是从签名 manifest 条目驱动批准清单，而非逐包扩硬编码

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
