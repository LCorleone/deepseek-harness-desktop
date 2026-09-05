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
- **里程碑（2026-08-30）：公司定制 UI 三批落地 + tag `v0.2.0-desktop-curated`** ✅——①左上角联名字样：鲸鱼 + 绿色 "Deloitte DeepSeek" + HARNESS 徽章（`5c66876fc8`，slot priority -1 压官方注册；评审 P1 修复 `8d35dd4a43`：textLength=124 钉死活字宽度防 DejaVu 溢出 + maxWidth 等比缩放防窄侧栏裁剪）②锁定构建设置收敛（`af3ef21e07`）：policy.locked 信号链（同更新止血源）→ Profile/Market/Presentation 三区块隐藏 + 托盘模式切换移除 + mode 运行时钉 compatibility 不落盘 ③设置头部双按钮 CSS 隐藏（`04adb7af7b`）：URL 参数 dsh-desktop-locked → html 类 → 借上游文档化锚点 `[data-slot='settings.action']` 一条规则盖掉 Open Configuration File + Open DSH Terminal（!important 对抗内联 display:contents）。**安全结论（用户问证）**：settings.yaml 无任何安全字段，全部防护读构建内嵌 policy/签名链，改配置最坏 DoS 自己；真正残余面=改插件文件（权威模式拦）与改应用 JS（asar 熔丝/签名域）。**构建 #32 用户验收通过（2026-08-30）：设置头部双按钮（Open Configuration File / Open DSH Terminal）确认消失**——公司定制 UI 全部上机闭环；#31 侧同时实测：明暗主题、最窄侧边栏字样等比不截断（P1 修复实证）、三区块隐藏、托盘无切换、seq10 无感。tag `v0.2.0-desktop-curated` 已 force 移至 c5e427a367（#32 精确 commit，说明含 Verified in build #32；tag 无其他消费者，安全）。desktop 1186+5skip / market 388 基线更新。
- **流程规则（2026-08-28 用户拍板）**：不主动 push、不主动触发构建——commit 本地可以，push/构建必须等用户确认后再执行（用户授权的修复-发布批次除外）
- **里程碑（2026-08-29 下午）：全自动上架链路首跑成功 + sidebar 权威模式实机生效** ✅——① GitHub workflow「Company catalog publish」（windows runner 测量+签名+artifact，3 分钟）② 容器内 publish-local（拉产物→验签→fleet 门禁→序列对拍→push GitLab→回读 sha 复核）③ sequence 7 上线（sidebar treeDigest 47e34732… 签入）④ 用户 #29 重启实测：**evidence: signed-tree**（诊断确认）——本地篡改/删伪造 receipt 三路绕过全部关闭。发布成本从 20 分钟构建+装机 → 3 分钟+重启。**首次发布实操笔记**：容器到 GitHub Azure blob 域不通（artifact 需用户浏览器下载后 --artifact-dir）；Node fetch 不认内网 CA（需 NODE_TLS_REJECT_UNAUTHORIZED=0，信任由验签承担）；发布后必须 bump state（已入待办流程）；#30 为纯工具链版本（客户端零改动，#29≡#30）
- **#28 用户验收通过（2026-08-29）**：市场三栏稳定（死锁修复生效）、Deloitte 文案生效 ✅
- **#29 用户验收通过（2026-08-29）**：安装提速（in-place 解压）+ 升级健壮性 + 更新检查止血（不弹上游提示）+ 市场照常 ✅——安装器批次与止血闭环
- **安装器批次 + 更新检查止血（2026-08-29，`06c3a7e7eb`/`1a45b88827`/`d02cdf79de` 三件套 + `59666bb796` 止血，已 commit 待 push）**：三件套上游摘取（grace 12→60 / in-place 解压[#515 终局，patch 6 hunk 双组共存：我们的 GetFileName 精确匹配 + 上游 extractAppPackage] / legacy code 2 继续）；止血：locked 构建禁用更新检查（三层 gate + 下载前重校验，adapter.locked 全程 fail-closed，手动入口「更新由公司管理」双语），端点与签名通道保留待选项 A。desktop 1168/market 388/E2E 12/12。**评审通过，已签收取舍**：M1 in-place 解压丢失重试面——CHECK_APP_RUNNING 在解压前运行且不复查，解压瞬间启动 app/AV 锁文件 → 混合版本静默成功（版本漂移非签名绕过，前置 30s 有序停机已消除最大占用源；后续可加 post-install 版本校验）；M2（grace/code-2 与既有时序自洽性细节，评审确认当前组合无冲突）
- **上游观察（2026-08-29）**：外层 +223（2.0.4、安装器批、设置向导功能批——只摘安装器）；**子模块 0.1.2-alpha.1（+1079，ptc 大重命名）——钉死不动，等正式版**
- **里程碑（2026-08-28 晚）：市场三日悬案告破**——settings update() 深合并残留 content 时代 digest（#24 origin 保存不带 digest 字段，旧 {seq2,e59f9c00} 残留到 seq6 记录）→ 每次 scan 正确 digest 66e404≠残留值 → 同序列重放防线死锁目录；观测性补丁（错误码透出+扫描日志+digest 双值）逐层定位。修复 `78c4f3f59e`：mutate set-op 原子替换 + 验签完整通过时 digest 不符 warn+自愈刷新（低 seq 硬拒不松）；market 388 全绿；构建 #28 已触发（含 Deloitte 显示文案 + 本修复）待用户验收
- **里程碑（2026-08-26）**：试点安装链全程闭合——**dsh-better-sidebar@0.15.2 市场安装成功、重启加载** ✅；tag `v0.1.0-desktop-pilot`（包版本 2.0.3，构建 #21）；E2E 冒烟 12 步自动化已入库（`4d9dfde3af`）
- **里程碑（2026-08-27）**：上游安全批（pnpm 11.8.0 CVE + 安装器运行中升级 #618 + 三稳定性修复 + P1 补丁，构建 #23）**用户实测通过：开着应用直接升级成功、市场 sidebar 照常** ✅；E2E 冒烟抓到自身 Windows asar 分隔符 bug 已修（`9fe06c3f8e`，下包验证全绿）
- **密钥与凭据状态（2026-08-29 用户签收，机器安全）**：① demo 签名钥 c469 指纹（manifest sequence 7 用它签）直接用于 CI 自动发布（私钥暴露面=会话记录，已知悉接受）② GitHub secrets 已配置四个：COMPANY_CATALOG_SIGNING_KEY / COMPANY_CATALOG_KEY_ID（company-catalog-2026-08）/ COMPANY_CATALOG_KEY_FINGERPRINT（runner 侧指纹钉扎）/ GITLAB_TOKEN（GitLab PAT，git clone+push 验证通过，仅 dsh-desktop-config 一仓写权限，无 API scope）③ 双钥轮换保留为随时可做的卡（待办②），换钥无需重做基建；PAT 若泄漏影响面=该仓库 manifest 可被改写（但客户端验签兜底，伪造 manifest 会被拒）
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
- **上游安全/稳定性摘取（2026-08-27，`7ad37183e1..45831b0482` 6 commit，已 push 构建 #22）**：上游 origin/master 184 新 commit 全量评估（37 文件冲突，功能批不摘）；按用户拍板摘 5 个：pnpm 11.7.0→11.8.0（高危路径穿越 GHSA-qrv3-253h-g69c）、session projcache 撑爆启动防护、token-meter 旧缓存砖化修复、空名工具调用死循环修复、安装器运行中升级（#618/`46decd44b6`）。评审抓 P1：installer.nsh 依赖先决 commit `edc9574f44`（PR #471）未随批摘——已补入 GetFileName 精确匹配 hunk + 3 条 spec 断言（`45831b0482`）。desktop 1122/market 367 全绿；E2E 冒烟 12/12；子模块未动；fork 资产零丢失（评审验证）。
- **上游观察项**：① #515 安装提速（`0df4795f42`，20分钟→16秒）——第一版 8/23 进 master 当天被 revert，重做版在 `build/windows-latest-20260824` 分支验证中，**未进 master**；上游合并后立即摘 ② 市场安装失败透出包管理器输出（`6fc5ec0f13`）与我们 D 链 stderr tail 重叠，未来同步时二选一 ③ setup wizard/browser access 功能批不摘
- **E2E 安装冒烟自动化（优化清单⑦）完成**（`4d9dfde3af`）：scripts/e2e-install-smoke.mjs 12 步打包级回归（asar 资产/策略 env 链/真实 pnpm add/构建审批/boot 验签）——本周踩的全部安装链坑固化为自动回归；离线降级 SKIP；CI advisory 接入；本容器 linux --dir 全绿
- **F 链（市场「时好时坏」三日悬案，2026-08-27~28，五段修复全链）**：origin 模式实机验收暴露连环问题，逐层剥洋葱：
  1. **棘轮相等语义**（`470f374765`+#28 随包）：静态目录同 sequence 重复拉取被「严格递增」语义拒绝（每次 bump 只能用一次）；修为下界语义（严格更小才拒，相等放行+字节 digest 校验），CLI receipts 棘轮同修；跟进 selftest 断言/安装权限重臂/残留窗口钉测（`28425cbb22`）
  2. **观测性补丁**（`767a1e6024`+`34f2bb955e`）：UI 错误码透出（[code] 后缀）+ host 扫描失败落日志 + digest 双值进报错——后续破案全靠它
  3. **根因告破**：settings `update()` 深合并——#24 origin 保存不带 bytesSha256，content 时代 {seq2, e59f9c00} 的 digest 残留到 seq6 记录 → 每次 scan 正确 digest 66e404 ≠ 残留值 → 同序列重放防线死锁（实机日志 recorded e59****/computed 66e**** 定案）
  4. **修复**（`78c4f3f59e`）：SettingsCompanyManifestSequenceStore.save 改 mutate set-op 子树原子替换（无 mutate 环境回退 replace 保兄弟字段）+ 验签完整通过时 digest 不符 warn+自愈刷新（内容权威=签名链；低 sequence 硬拒不松）；market 388（+5 含实机场景回归）
  5. **诊断方法沉淀**：--export-diagnostics + 日志错误码是定位链；用户侧无 DevTools，观测必须进产品
  同期：Deloitte 显示文案（`d38418dd30`，窗口/托盘/市场双语，显示层 only——productName/安装器/路径零变化原地升级）；构建 #28 携带全部待用户验收
- **origin 模式实施（2026-08-27 晚，`2d1ab3a3cd` + 评审修复 `006fcff96c`）**：release 策略切 GitLab 托管；dev 保持 content。TLS 适配：主进程 net.fetch（Chromium 读系统证书库，redirect:'error' 单层真实生效，防御层保留但 Electron 43 Response 无 redirected 标志已如实注明）；CLI 子进程经 DSH_COMPANY_MANIFEST_FILE staged 字节（generation 作用域 0600 原子写，读前 fstat ≤4MiB，验签链不变）；市场 provider 经 desktopCompanyCatalogHttp capability 注入（评审 High：restricted node:https 私网黑名单拒 10/8+Node CA 不认内网根会确定性击断市场目录——注入复用 boot net.fetch 边界，origin 严格棘轮不变）。desktop 1165/market 374 全绿；E2E 12/12。后续上新流程：改 allowlist→build→git push 该仓库（网页编辑器会格式化破坏验签，永远用 git push）
- **origin 模式验收通过（2026-08-28 上午，构建 #24 实测）+ 棘轮相等语义修复（`470f374765`，待随 #25 发布）**：装包→市场目录从 GitLab 拉取正常；sequence 3→5→6 全部被客户端实时感知（git push 即生效，零发版）；坏签名 drill（sequence 5 转抄多 1 字符）意外验证了 fail-closed 全链：schema 违规→market 双栏 unavailable+已装插件拒载，自检报告给出精确诊断（signature/value pattern）——三个症状一根因。**随后暴露实机 bug：origin 稳态重放被拒**（verify.ts `<=` 语义：同 sequence 第二次 scan 即 stale → tabs「刚正常又坏」，静态托管+严格递增=每次 bump 只能用一次）；修复：下界语义（严格更小才拒、相等放行+字节指纹硬校验/回填，origin 持久化 bytesSha256），CLI receipts 棘轮同修（同目录第二次安装不再要求 bump）。market 378/desktop 1166 全绿，E2E 12/12。**待补：真 revoked 语义实机验证**（可选）；**流程教训：签名值禁止人手转抄**，manifest 交接必须带 sha256 校验步骤（已实践）；**残留风险已签收**：legacy 无 digest 记录允许一次相等序列未知字节放行后钉死（制造需签名钥，等价于本就可发更高序列）；评审 Low 已记录

### 模型网关托管模式 ✅ 完成（2026-08-31，`f8da3b48a6` + 评审 P2 修复 `dfbe33a603`，评审批准无 P0/P1）
policy `managedModels`（严格 7 键，CLI 交接 5 键同步）；混淆 blob（URL+token，仓库零明文，worker 实测 gateway HTTP 200）；provider 走 llm-pi-ai composition base 内存注册（settings.yaml 零痕迹，真机 host boot 实证默认模型 dsh-company-gateway/DSV4-DSH）；token 仅 env 注入（main.ts 于 loadLayeredEnv 前；shim 只固化 policy 键，token 永不落盘）；让位语义用上游同源解析器探测（.env 层结构性不可能携带 DSH_*——上游启动即拒）；默认模型迁移镜像 permission 先例；Models 页双门控隐藏。**评审确认要点**：让位/分层语义逐条对上游源码成立；mask-secrets 补 UUID+具名模式（纵深防御）；已知面（用户手改 llm-pi-ai 段可按字段覆盖 base 层、真 token 亦进 dev 构建——软屏障已签收）。check 基线 1260+5skip。
### SSO 启动门禁 ✅ 实装完成（2026-09-01，`cf52ba956e` + 评审修复 `84067e28cd`）
评审两轮：首轮 P1×2（SignEntity 键名 snake→camelCase 对齐 nova 生产形状+完整键序字面量钉死；token POST 默认 45s 超时防无窗挂死）+ P2×2（verify_auth_code 确认往返忠实移植——code 单次消费兜底；APP_ID/KEY env 覆盖收紧 unpackaged-only，堵「设环境变量自签过门」）全修。评审确认：门无旁路（单实例锁第一句/恢复路径/二次实例/更新重启全过门）、金向量独立重算非恒真、token 零落盘、门窗继承 recovery 窗生产级配置、未要求 SSO 时 URL/标题等价。check 1336+6skip。
**诚实边界（评审补记）**：①安装目录 desktop-cli.js 可手跑绕过启动门（六键交接非秘密）——归入既有「CLI/执行器硬钳制」待办卡；②认证成功 email 进 userData 日志（7 天留存）——与托盘/标题/徽章同敏感级，数据清单记一笔；③pnpm.spec 的 proxy 环境清洗为 test-only 夹带（良性）。**SSO 终态评审（2026-09-01，review-sso2 独立复核，master 通过）**：门序列正确（在一切 surface 前）、token 永不落盘/日志/URL、渲染端零 Node 全局、打包三清单同步、红线干净。**签收/记录项**：
- **角落徽章 → Settings General 用户信息卡**（用户 2026-09-01 拍板选 B）：侧边栏角落徽章移除，完整邮箱展示收敛到设置 General 卡 + 托盘「Signed in」+ 窗口标题后缀——原「侧边栏角落显示 email」需求按此定稿。
- **CLI 子进程旁路（含 SSO 门）**：desktop-cli.js 可绕过 requireSso 直接跑（六键交接非秘密）——并入既有「CLI/执行器硬钳制」卡（触发条件不变）。
- **P3 记录**：门窗口关窗时浏览器登录 in-flight 的浮点 promise（app 退出中，无安全影响，可留清理项）。

**待实机验证**：camelCase 键名与静默路径的真身份验证（#36 装机即测）。

### #36 实机首验 + 门户协议排障（2026-09-01）
**#36 结果**：门控链路工作（未认证不放行、关窗=退出实证），但 ①静默路径被门户拒：「此应用对应配置不存在」②门窗口黑屏。排障全程（容器+用户机双网实证）：
- **黑屏**：打包资产齐全（unpacked 镜像验证）；本地同款资产正常渲染；复现路径=畸形 state 使 `COPY[locale]` undefined 崩溃。用户机黑屏根因未最终定位（本地无法复现真实形态），以三道防线+观测收口（见下）
- **门户协议发现（重要）**：SignEntity 的配置检查按 **(appId, appName) 成对匹配**——实证 1005+coWork.Nova 过检查（返回 Invalid username）、1007+任意名都配置不存在；运维注册表记录 app_name='DSH'；**运维调整后 1007+DSH 实测 code 200 + 换到 token**（容器直打验证）
- **静默路径安全本质再确认**：假身份（"Julu Test"+真实形邮箱）也能换到 token——SignEntity=app_key 握手+身份声明，非真 SSO；门禁安全重心在浏览器回调路径（设计如此，无修正需要）
- **排障工具**：容器探针脚本（SignEntity 构造+getEncodeStr+签名，NODE_TLS_REJECT_UNAUTHORIZED=0 旁路容器不认的公司 CA）——门户侧问题速诊利器，模式记此可随时重建
- **运维协作记录**：appName 必须逐字符匹配注册名（我们发 'DSH Desktop' vs 注册 'DSH' 差一步）；注册表有记录 ≠ 门户运行时可见（本次运维侧同步修复）

### SSO 观测加固批次（2026-09-01，`94bb25d16b`，#37 发车）
黑屏三道防线：①decodeState 严格校验（locale/phase/errorDetail 非法 → 可见 fallback 卡，`state=e30` 崩溃路径已断）②SsoGateErrorBoundary（渲染抛错显示中英错误卡）③门窗口四类 webContents 事件（console/render-gone/did-fail-load/unresponsive）masked 回传主进程日志（`grep "dsh-plugin-desktop: sso gate"`）。appName 可配置（BUILTIN='DSH'，DSH_SSO_APP_NAME unpackaged-only 覆盖）。静默失败带门户 code 入日志/门 errorDetail。check 1346+6skip。**#37 待用户装机验证：静默认证直通（不弹门）+ 徽章三处 + 黑屏不再。**

### SSO 线完整收官（2026-09-01 下午）
**#37/#38 实机验证通过**：appName='DSH' 后静默认证直通（1007+DSH 门户实测 code 200）；#37 暴露渲染端 Buffer 崩溃（client environment 用了 Node 全局，单测跑在 Node 测不出——教训：**渲染端代码禁 Node 全局，CI 盲区**，后续可加 lint 守护）→ #38 TextEncoder 修复后正常打开。**徽章形态改版（用户拍板）**：侧边栏 footer.action 是横排 flex、邮箱与 Plugin Market 同行挤截断 → 移除侧边栏徽章（`ea4a8057f9`），完整邮箱改 Settings→General「用户信息」卡（settings.general.item 槽，数据流：主进程 session → settings view 投影 token-free → 卡仅 authenticated 时渲染；`88548a9f65` 补 readSso 邮箱校验防坏邮箱炸 Settings 整页）+ 托盘/标题保留。**三轮评审全记录**：主体批（P1×2 修复）→ 增量批（渲染端 Node 残留清零确认）→ 终审（批准，P2 状态机零测试 + P3×3）→ 尾巴批（`f382370793`：门状态机 5 例生命周期测试[变异验证]、回调 idle timer 竞态修复[确认阶段不再被 10min 边界误杀]、tsconfig 残留清理；P3-c 托盘 email 对称钳制按设计保留不做）。**SSO 线终态**：#39 构建成功（用户信息卡形态），check 1354+6skip。HTML 汇报同步更新（攻击视角 8 问答卡，`97f1f6d03e`）。

### 用户信息卡改版（2026-09-01 傍晚，#40）
#39 实机正常。用户两条反馈：①只留「当前登录 / Signed in as：email」一行（删认证方式/状态）；②样式与 General 其他条目统一。改 `8b6b6a6222`：调研发现 General 页本身无行组件，真实形制在各 occupant 包（LanguageRow/PermissionRow/AgentPresetRow/EnterBehaviorRow 共用 Setting-Cell：gap8/pad16/0/l2 分隔/14·400·22 primary）；插件无法跨工作区引用哈希类名，故按回退路径保留自有类名但 DOM+视觉参数逐项照抄，value 加 overflow-wrap:anywhere 防长邮箱溢出。渲染语义不变（view.sso、authenticated 才显示、email??'—'）。清理 7 个失效 userInfo locale key 与旧 section/dl 卡片样式。check 1353+6skip。**#40 构建中（run 33486457236）**，装完确认行对齐即可收尾。
### SSO app_key 泄露事故处置·当前树抹密（2026-09-02）
**检出**：GitGuardian 在公开仓报警——SSO `app_key` 明文三处：`src/company-sso.ts` BUILTIN 常量、`tests/company-sso.spec.ts` 金向量常量、`dev-log/2026-08-22-handoff-zcNSeT.md` 设计段（本文件下方，已标注 REDACTED）。**确认**：真实凭据非误判（2026-08-31 运维下发的 DSH Desktop 专属 key；GitGuardian 的 Laravel 标签属引擎分类噪声，凭据本身真实有效）。
**私有仓迁移回退决策**：报警后先迁私有仓止血，但组织 Actions 计费未开通（私有仓 workflows 全断，发布链路连带死）→ 拍板回退公开仓，改走三件套处置（仓库公开的前提 = 凭据彻底离开仓库）。
**处置三件套**：① 当前树 blob 化（本 commit）：仿 `model-gateway-blob.ts`/`usage-report-db-blob.ts` 同模式新增 `src/sso-app-key-blob.ts`（XOR+base64，密钥不入仓）+ 生成器 `scripts/make-sso-app-key-blob.mjs`（`DSH_SSO_APP_KEY` 环境变量供明文，轮换时重跑即换 blob）；运行语义零变化（解出值与原 BUILTIN 逐字节一致，`DSH_SSO_APP_KEY` unpackaged-only 覆盖不动）；blob 损坏降级对照 usage-report 模式——登录失败+边界处单行脱敏日志，不崩启动（loopback 回调处理器非守护调用点已加 reason-union 防护，专项 spec `company-sso-corrupt-blob.spec.ts` 钉死）。② `git filter-repo` 历史重写：随后另做，本 commit 不含（含本 dev-log 全历史）。③ 运维轮换新 key：待办；轮换后只需重跑生成器，客户端零代码改动。测试金向量同步与真实凭据解耦（32 位字母数字合成假 key 重算，不再断言真实值；「与 BUILTIN 一致」用例改为「blob 解码成功且形状合法」+ 解码器与 ssoAppKey 一致性）。check 全绿：desktop 1422+6skip（基线 1404+6skip，净增 18 = blob 编解码/形状 13 + 损坏降级 5），根 check（fabric/market 388）同绿。

### SSO app_key 泄露事故处置·历史重写与仓库回归（2026-09-02 续，完结）
**② git filter-repo 历史重写（已执行）**：克隆重写（`--replace-text`：`zI9t…`→`[REDACTED-SO-APP-KEY-2026-09-02]`），覆盖 master/catalog-artifacts/全标签；验证：重写后全历史 `-S` 搜索与前 50 commit 树 grep 双零命中；force-push 后远端 master = `d40e7470bb`（树内容与重写前 tip 逐字节等价——worker 抹密在前，重写只清历史），本地已 reset 同步。**仓库状态终局**：公开仓回归原名 `LCorleone/deepseek-harness-desktop`（原名/原工作流/原 secrets 全在，Actions 免费）；私有仓残留改名 `deepseek-harness-desktop-private-obsolete`（含旧 key 历史快照，**待用户网页删除**，delete_repo scope 需交互授权）；#42 验证构建中。**影响评估（用户问过，存档）**：桌面客户端零影响——已装包不追 commit、插件信任链是 ed25519 指纹+treeDigest 非 SHA、子模块 pin 指向 upstream 另一仓未重写、构建树内容不变。仅两残余：devlog 里引用的旧 SHA 变幽灵引用（事故记录佐证）；GitHub 对被重写历史 ~90 天 reflog 可达（轮换兑底）。**待办**：③ 运维轮换 1007 key（新值→重跑 make-sso-app-key-blob 生成器→构建发版即闭环）；用户网页删除 -obsolete 仓；GitGuardian 面板 resolve finding；给 IT 的回复稿在会话中。

### CLI 硬钳制路线甲 + 渲染端 lint 守护落地（2026-09-02 下午，#10/#11 闭环）
用户拍板 10/11 先做、9（自有更新源）待定。**scout 裁决**：拉起链路全在自有代码（openDesktopTerminal→shim→desktop-cli.js=src/desktop-cli.ts，shim 本嵌 env 注入）；路线甲（spawn 侧注入）为主、乙（执行器纵深）留第二批。**#11 lint 守护（`e6494eed9c`）**：tests/renderer-node-globals.spec.ts——AST 剥注释+双视图（说明符/代码），7 组变异全红（含 #37 原始形态），零白名单零误报；Buffer 教训从此机器守门。**#10 甲（`4a5881d6d3`+评审尾巴 `ba51d552ff`）**：锁定钳制 overlay 资产（permission 无 danger/sandbox+approval 字面钉死/preset 禁上行+插公司行经 DSH_DESKTOP_LOCK_PRESET_ROOT 注路径）；desktop-cli.ts 注入（peek 不消费、boot 形态注 --patch、plugin add 分支不回归）；**fail-closed**（打包态手跑不带六键=按锁定）；GUI 启动器同款缝补上（scrubInheritedPermissionModeOverride 大小写不敏感抹继承 DSH_PERMISSION_MODE）；row-id 漂移钉扎测试（warn sink 断言空+三组变异红）。评审（review-guard-clamp）批准：2 P2 已修、P3 注释已补；评审员用 app-boot composeEntries 实证五面全锁定（env 硬设 danger-full-access 仍合成 workspace-write）。**诚实边界**：钳制覆盖=经 DSH Desktop 拉起/引导的子进程；自带 Node 直跑上游 bin.js 不可防（=本有 shell）；home 层可写故为软屏障。check 1442+6skip。乙（bash-sandbox 子包拒 full-access+堵 resume 旧事件）**经用户拍板不做，残余签收**（2026-09-02 关卡）。#44 构建验证中。

### 待办批注落账（2026-09-02 午，用户 review 待办表批示）
-obsolete 私有仓**保留不删**（放着）；GitGuardian 已 resolve；IT 已回复；P4 双钥轮换**签收不换**（demo 钮 c469 继续，已改卡表）；测试组扩面**进行中**（用户主导）；P6 三问仍待定；自有更新源**待定**；CLI 硬钳制当日已做（甲）+乙签收不做（2026-09-02 关卡）；lint 守护当日已落地（`e6494eed9c`）。

### SSO key 轮换落地（2026-09-02 上午，③ 完成）
运维重发凭据：**app_id 1007→1008**（app_name 仍 'DSH'），新 app_key 仅进混淆 blob（会话交接，仓库/devlog 零明文——blob 生成器 env 供值）。代码改动：`BUILTIN_APP_ID` 切 1008 + 测试 6 处默认值/code_challenge 期望参数同步（`code_challenge`=sha256(redirectUri&&&appId&&&ts) 随 appId 变更属预期）；`src/sso-app-key-blob.ts` 重生成。check 1422+6skip 全绿。**泄漏事故至此完整闭环**：当前树无明文（blob）+ 历史重写 + 旧 key 作废。待装机验证 1008+DSH 门户静默认证直通。

### 上游摘取批 + 简报 v3 收官（2026-09-02 晚）
**上游摘取批落地**（scout 三档分拣→worker 摘 7 项→评审通过「教科书级冲突解」→**#45 用户装机全 OK**）：失败报告保留（81b62aec09 冲突解，保我方 recovery 结构+failureNote 双语段）/ 会话恢复（af54bf0dbb，localStorage 选择态，鉴权后列表门控，SSO 正交）/ 目录能力透传（6d567aefb5，与托管目录屏蔽**正交验证**：禁用行不入 catalog）/ 模型搜索批量（7cb2d9fa64，3057 行工件重建）/ 遮罩冲突（d1bbc1ce9e）/ 目录选择器跳损坏项（537d124740）/ 标题栏滚动后拖动（ec528b0835，保 AdvancedFrame 几何）+ 孤儿补丁清理（5bddd4e045）。NSIS 长路径 patch-id 验证**早已在树**。check 1450+6skip。台账（挂起待需/绝对别碰）入 plan-v2。**简报 v3**（b10672e5b2）：去隐患 10 处（ch6 残余风险整章/摘要指标/Q5Q6 理论残余句，违禁词零命中）+ 新 ch6 领导视角安全问答 8 卡（全部实装背书）。
**tag `v0.3.0-desktop-enterprise`** 打于本日终态（#45=企业定制集大成：SSO 门禁+模型网关托管+usage 审计+CLI 钳制+上游摘取）。

### 2026-09-03 全天：P7 双通道 + P8 agent-browser 双卡并进
**P7 公司市场双通道（npm+tarball）**：开卡→批1 客户端（manifest source:{kind:'tarball',url,integrity}→受控下载 sha512→pnpm 受控目标→treeDigest 复验，+56 测试）→批2a 三消费者切双通道验证器（boot/锁定add/市场provider 注入式）+fleet 门禁定义→批2b 发布管线（pack-tarball/allowlist/manifest/GitLab 推送+catalog-artifacts 镜像/CI 接线/测试入链/e2e 入 check 链尾）。评审连环抓漏：CLI 塞 tarball 面/信任链 origin 三处绑定/**tar symlink 逃逸两轮 PoC**（绝对目标放行→多跳词法≠物理深度→最终三层防御：词法快失败+创建时 realpath 父目录断言+末层 walk 定稿）/npm→tarball 迁移路径（revoked 不播种）。**master e00902a06b 全本地未 push**。
**P8 agent 网页操作**：Minke/cua 双调研（采 webview+CDP 路线+normalizer+错误分型+截图保留纪律；拒烧录子模块/薄弱危险确认）→设计（评审修订 P0 partition 落点等 4 项）→B1 只读闭环（37 文件已 push 50629c9f1f；冒烟实弹：UA shadow 密码明文→子树封死）→B2 动作闭环（click/type/scroll+审批 ask+claim+overlay，三轮评审修复：提交按钮含子元素 closest 分类/协议门/隔离世界）。B2 链未 push。
**其他**：univer 遥测深挖（匿名计数可关，降级非阻断）；free-search 源定案（tavily/exa 可选→bing→ddg，key 不阻塞）；pi-web-access 调查（DDG 零 key 兜底先例）；模型 quota 中断一次（glm-5.3 503，deepseek 接续）。
**明日入口**：P7 遗留（filename 绑定 P2/GitLab 真推送演练/free-search 收编实装）；P8 B3/B4；全部本地 commit 等用户决定 push 时机。

### P8 完结 + #47 验收（2026-09-03 夜~09-04 晨）
**#47 构建成功并装机验收**（smoke 13/0/0；usage 上报 10:07 两行实收入库；用户报告 skill-catalog 注入=上游 dsh-tool-skill 原生技能目录，良性，即 P6 研究面）。
**P8 agent-browser 四批全部闭环**（夜间自主：做一批评审一批）：B1 只读（已 push）→ B2 动作（提交按钮 ask 含子元素 closest/协议门/隔离世界）→ B3 人机协作+登录态（claim 竞态/persist policy 执法）→ B4 策略执法（双路 will-navigate/redirect/链终检/下载取消/label 转发）。终态 check **1745+7skip**、真浏览器 smoke **17/17**、xvfb 组合 14/14。设计文档翻 Implemented。B4 前任 worker 死于 quota（进度保留+resume 接力模式跑通）。
**P7 尾巴自动化**：ci-digest-measure worker 进行中（Windows runner 测 treeDigest 替代人工）。
**待办快照**：P8/P7 本地 commit 链等 push 决策 · free-search 真发布（等 treeDigest 落值+fleet 升级 #47+）· 上游 0.1.2 正式版升级专项 · 自有更新源 · P6/logo 搁置。

### P7 首单上线（2026-09-04 全天）
**free-search 0.4.182 真机安装+搜索可用**——tarball 通道全链闭环（收编→签名→GitLab 分发→受控安装→boot 复验→运行）。发布 sequence 12。真机排障四坑全修：CLI 闸门误伤（受信交接 env）/EPERM 原子写竞态（yarn 补丁退避重试）/吞错误裸 catch/patch 前缀失配（0.4.182+管线一致性断言）。构建线 #47 smoke 修复→#48 闸门修复→#49→#50 EPERM+日志（客户端停在 #50 即可装 0.4.182，后续修复均目录/清单侧）。老板页 2026-09-04-boss-architecture-overview.html 六轮迭代完成（8 卡成对防线/加密细解章 Ed25519+SHA-512+绕过 5 卡/考卷节 8 道真题）等用户终审 push。**既定发布顺序下一步=用户确认搜索稳定后 P8 发版翻 policy 真机测试**。

### P7 交接与设计边界讨论（2026-09-04 晚）
**发布流程口径定稿（用户复述确认+三精确化）**：审源码入库（plugin-sources 真身）→ 构建打指纹（tgz sha512+树摘要）→ 签**清单**（非逐包签，指纹入清单整体 Ed25519）→ GitLab 分发 → 客户端三验。自动步骤：CI Windows 参考环境测树摘要入清单；manifest sequence 单调+fleet 门禁。无人工搬运字节环节。
**运行时不可变边界（用户提问定案）**：树摘要对包目录全量哈希零排除——插件运行时写自身包目录（配置/缓存）= 下次启动复验拒绝（与篡改不可区分，fail-closed 刻意为之）。正确姿势：状态走 ctx 设置节（settings.yaml，free-search 引擎 key 范例）/userData/~/.dsh；且 pnpm 装卸本会重置包目录，生态约定如此，摘要机制将其变强制。**已入上架审查清单与交接指南**。
**市场子系统交接启动**：market-handover-doc worker 撰写八节双语指南（.agents/notes/implemented/process/2026-09-04-company-market-owner-handover.md）：所有权地图/信任模型红线/上架全流程/客户端五道关卡/真机四坑战例/测试/运维速查/冷启动清单。交接三非文档项：仓库与 GitLab 权限、CI secrets 所有权（签名钥 c469…/GITLAB_TOKEN）、fleet 纪律口头强调。

### 搜索源定案与尾巴清理（2026-09-05 晨）
**用户真机反馈**：bing 免费抓取质量差（"这一周上海天气"实测）；ddg 公司网络封禁；用户机器曾自设 TAVILY_API_KEY 环境变量致 tavily「意外可用」（env 回退设计行为，已删变量验证）。**免费源实测三连**：百度 HTML=验证码拦死、搜狗=反爬墙、**360（so.com）=完整结果页无验证码且质量好**（上海天气查询命中真实温度数据）——免费兜底唯一可行源，待用户拍板是否入链 0.4.183（so360 引擎+限速+跳转链接处理）。**付费 key 定案（用户拍板）**：key 不进客户端默认配置（客户端持有=必可提取，数学不可防——选项阶梯 D 限损/C 自注册/B 公司代理持钥已陈明）；**用户选 C：让用户自注册免费额度**。已核实（官网 2026-09）：Tavily 免费档 1,000 credits/月无需信用卡；Exa 注册送 $20+每月送 $10（约 1,400 次/月）——链设计天然支持混配。**尾巴 5/6/7 清理落地**（78def35d9a）：logError 回滚安全化/CLI 侧 rename 重试/GitLab 0.4.181 残件删除（404 验证+manifest 未动）。check 1792+7skip。

**沙箱 shell HTTPS 发现（2026-09-05，待查小项）**：用户真机实测 DNS/Ping/TCP443 全通，但沙箱内 shell 的应用层 HTTPS（curl/Invoke-WebRequest）全部「underlying connection closed」=透明 TLS 检查掐握手。不影响插件（host 进程 fetch，tavily 已实证）与 P8 浏览器（Chromium 用系统证书库天然过）；影响 agent 用 shell 联网。待查：沙箱子进程代理 env 是否被 scrub 剥掉/需注入企业代理。
**anysearch 实测（容器）**：key 有效，POST /v1/search 200+真实结果（上海天气命中气象局逐日温度），2.2s。0.4.183 三键制改版进行中（fs-183）。

### free-search 0.4.183 + 沙箱网络修复（2026-09-05 上午双线收官）
**free-search 0.4.183 三键制**（用户拍板）：链=tavily→exa→anysearch 纯键制（配 key 才入链），**bing/ddg 移除**（bing 质量差实测/ddg 公司封禁/抓取源全否——百度验证码、搜狗反爬、360 可行但被否）；anysearch 引擎实装（POST /v1/search Bearer，code:0/data.results 形态实测对齐）；零 key=引导文案（三引擎免费额度+注册入口）；设置页三键+注册指引卡（tavily 1,000/月、exa $20+$10/月、anysearch 1,000/天）。评审通过+修复（引擎测试 15s 超时防黑洞挂死/结果钳 20）。
**沙箱 shell 网络自注入**（corp-net-inject）：Electron 主进程启动时自注入系统代理（resolveProxy，PAC 兼容）→HTTPS_PROXY 等+NODE_USE_ENV_PROXY=1（Node 24 才读 env 代理——评审 P1 抓的）+PowerShell 导出 Root/CA 证书 PEM→NODE_EXTRA_CA_CERTS/SSL_CERT_FILE/CURL_CA_BUNDLE+NO_PROXY 内网清单；后代继承零改 runtime，win32 gate，全失败路径降级裸启动。架构 note 双语（含 CA 投毒面评估/PAC 近似/清单维护点）。合并 master f05b981a84，合并树 check 全绿 1815+7skip/market 400。
**待**：#51 构建（带网络修复）→用户装机验证沙箱联网；插件 sequence 13 发布（digest 对拍→落值→publish）→用户填 key 实测三引擎。

### #51 + free-search 0.4.183 真机验收通过（2026-09-05 午）
用户装机全测 OK：①沙箱联网修复实证（curl 过 TLS 检查，对照上次全灭）②0.4.183 经 sequence 13 一次装成 ③anysearch key 配置后引擎实测可用。**两线闭环：沙箱 shell 网络自注入（corp-net-inject）+ free-search 三键制**。发布履历：sequence 13（0.4.183，treeDigest 648b2188…Windows/Linux 对拍一致）。构建履历：#51=corp-net-inject+NODE_USE_ENV_PROXY 修复。既定发布顺序已完成「free-search 发布→测试」段——**下一步=用户拍板 P8 发版翻 agentBrowser policy 真机测试**。#51 产物留档 tmp_sessions/dsh-desktop-asserts/（SHA256 2daa65c5…）。

### P8 上线：release 翻 agentBrowser policy（2026-09-05 午后）
**用户拍板真机测试**（既定发布顺序末段启动）。desktop-policy.release.json 翻亮：`agentBrowser = {enabled:true, allowOrigins:["*"], allowPersistLogin:false}`——测试期口径全放开 http(s) 源，审批门仍护（跨源导航 ask/表单提交 ask/下载取消），persist 登录态暂不开=一次性 partition token。断言同步：desktop-policy.spec 双形态各补 agentBrowser 终值断言（dev/release 均 enabled+通配，persistLogin 关）；agent-browser-tools.spec「locked 零暴露」负向断言翻向=新增读真 release 资产验「release 默认注册九工具+段+live context」，负向面保留为注入显式 disabled policy 验零暴露（零暴露归因 enabled:false，不再归因 locked）；agent-browser-policy.spec inert 子策略变量更名 disabled。e2e-install-smoke/composition 冒烟核实零硬编码 release 期望（全动态读内嵌资产）无需动。架构 note 状态行维持 Implemented。check 终态 **1816+7skip**（+1 即新 release 默认注册断言）/market 400，全绿。单 commit `feat(desktop): enable the agent browser in release builds for the field test`，不 push。

### P8 首亮机事故与修复（2026-09-05 午后）
**#52 fleet 破坏性构建**：policy 翻亮激活 agent-browser → `ctx.systemPrompt` 访问即抛（inject 数组漏声明）→ 插件树加载失败 → boot 失败循环 → 恢复窗黑屏。用户日志实锤（13:48 装 #52 首启即崩）。**根因深层语义（fix-inject worker 实证 Cordis reflect.ts/fiber.ts）**：provide() 写提供方 fiber 自己的 store，代理 walk 只走**祖先** fiber——祖先服务裸访问合法，**sibling 服务必须 inject**；systemPrompt/tools 正是 sibling 条目。fake ctx 非严格 Proxy 是测试漏网原因。**修复（880959924b）**：inject=['systemPrompt','tools'] + 全 ctx 访问面审计 + 严格 Proxy 守门测试（变异验证：去任一 inject 即红——单测可抓此类错）+ xvfb 组合冒烟。语义注记：无模型面组合中该 fiber 由早退变 PENDING（同 tool-web 契约，boot 不受影响）。**#53 已触发（run 33949239700）修复版**。教训：policy 翻亮=激活，激活路径必须有真语义测试覆盖。
**同批确认**：corp-net-inject 真机工作（"corporate network environment injected" 日志行）；usage 健康含 retry 自愈实证。

### 沙箱越界「不弹窗」定案（2026-09-05 傍晚，investigate-ask）
用户疑问：workspace-write 下 agent 越界（写 /tmp EACCES）不弹审批窗。**结论=上游本如此，非 bug**：①首次越界=执行器直接拒+提示模型带 sandbox_permissions+justification 重试（不弹）；②弹窗在模型的升级重试（ApprovalPanel，上游 e2e 自证）；③我们审批链路逐行等价未动（compatibility 原版 client+钳制钉 approval='ask'）。特例：越界目标 ~/.dsh/应用自身→persona 明令拒绝不升级（预期防护）。排查口诀：看越界工具结果有无 denial marker+escalation hint（有=链路健康）；模型不重试=纯模型行为。**P8 webview 同源修复（#54）**：真因=agent-browser.html 嵌套子目录引用 ../assets/* 逃出 file:// 同源子树（Chromium 边界=同目录及以下）+打包态 grantFileProtocolExtraPrivileges fuse 显式关（开发态默认开→xvfb 冒烟过真机挂）。修=html 挪 native-ui 根与 sso-gate 同构（ca8d6239dd）+vite closeBundle 逃层守门插件。挂死 worker 遗产复盘纠偏一次（我给错假设、worker 实证推翻——读遗书的价值）。

## 会话收尾快照（2026-09-02 收工，下一会话冷启动入口）
**当日闭环**：GitGuardian 泄露事故四层处置（blob 化→历史重写→1008 轮换→#43 直通）/ P5 usage 上报双构建实机入库 / #10 甲 CLI 钳制 + #11 lint 守护（评审批准，#44 回归通过）。master=1a8c03005c（全 push），工作树净。
**进行中/阻塞**：无进行中代码。P6 卡在三问（脚本管道/description 脱敏/会话明文口径，用户在想）；logo 等 SVG；上游 0.1.2 等发版；测试组扩面用户主导中。
**Gotchas**：origin=anywhere-labs 上游（223 分叉警告=噪音，push 目标是 fork）；GitHub 对重写历史 ~90 天 reflog 可达（轮换已兜底）；devlog 旧 SHA（2026-09-02 重写前）为幽灵引用；CI 四 secrets 已恢复（签名钥 c469 逐位验证）。
**当日决策**（防重议）：凭据入库一律混淆 blob（明文只经 env/会话，轮换=重跑生成器）；仓库保持公开（私有仓因 Actions 计费放弃，-obsolete 残仓保留不删）；usage 三列恒 0 口径签收（网关不报+pi-ai 折叠，思考已计入 output）；demo 签名钥不轮换；CLI 钳制卡**整体关闭**（甲路线已做；乙执行器纵深/resume 旧 full-access 事件残余经用户 2026-09-02 拍板签收不做——威胁面=历史上开过 full-access 的会话被 resume 才触发，前提极窄）；渲染端 Node 全局已机器守门。
**冷启动指引**：卡表与 P5/P6 细节见 dev-log/2026-08-22-company-market-lockdown-plan-v2.md；本文件各节按时间序含全部实现细节；DB 10.173.46.21:3306 dsh_usage（root 口令在会话交接，report_writer 仅 INSERT）。

## 企业定制第三批·SSO 启动门禁（2026-08-31 设计定稿，暂缓实施）
**机制来源**：参考 cowork-nova-tauri（dowork 移植）实测代码。公司 SSO 门户 sdp.deloitte.com.cn。**凭据（2026-08-31 运维下发，DSH Desktop 专属，替代原复用 nova 1005 的方案）：app_id=1007，app_key=[REDACTED 2026-09-02：GitGuardian 检出，历史重写+轮换处置]**（与 demo 签名钥/PAT 同级：会话+私有仓库存量已知悉；最终嵌入客户端为软屏障）。两路径：A 静默（whoami /upn → SignEntity POST /web/dai/token，注意本质是 app_key 握手非真 SSO，只做便捷加速）；B 浏览器手动（loopback 回调 + code_challenge + 回调签名校验 verify=sha256(token+ts+username+app_key+email)，±10min）= 真 SSO，门禁以此为准。
**定稿设计**：policy 新开关 requireSso（与 managedModels 同款快速开关）；locked && requireSso 时启动序列=先静默（5s 预算）→ 失败出登录门窗口（复用 recovery window 基建）→ 浏览器 B 路径认证 → 过门才 boot 主窗口/host（含 CLI/市场全在门后）。会话内存态不落盘。**用户标识徽章**（用户要求，SSO 卡一部分）：认证后侧边栏角落显示 email 徽章（client 插件 slot，同品牌字样机制）+ 托盘「已登录」项。**诚实边界**：门禁为进程级软屏障，A 路径防不住提取 app_key 者（已签收威胁模型内）。
**关键实现备忘**：SignEntity 的 jsonData 键序必须精确（服务端校验 Node 插入序）；Electron net.fetch 走系统 CA；nova 参考 code 在 /opt/july/pi_tasks/tmp_sessions/dsh-desktop-asserts/cowork-nova-tauri-master.zip。
## 企业定制第二批（2026-08-30 立项，讨论定案）
**① 权限级别**：锁定构建从 permission presets 配置表（host 组合 base/cordis.patch.yml 的 permission 行）删除 danger-full-access（服务级删除，UI+写路径同步）。**已知残余（用户签收暂不处理，评审扩大范围后 2026-08-30 复签）**：①预设表管 UI 与正常写路径，直接调 loopback API 裸注入 sandbox 事件理论可绕；②**内置终端 dsh CLI 子进程旁路（评审 P1-b 实证）**：CLI 子进程自行重新组合 profile——preset roots 指回上游（四模式全回、无公司条款）、权限表带 danger-full-access、DSH_PERMISSION_MODE 环境变量直起全访问，两个锁定在 CLI 路径同时失效（零成本正常路径）；③旧会话 resume 已记录的 full-access 事件在执行器侧继续生效（评审 P2 确认）。缓解：终端入口已隐藏、CLI 需故意手跑、无提权（等价用户本有 shell）。**统一挂「CLI/执行器硬钳制」待办卡**：desktop-cli 注入锁定 patch + 执行器（bash-sandbox）最高沙箱钳制调查，触发条件：出现真实绕过尝试或正式推广前复审。
**② Deloitte Standard 模式**：desktop 自有 preset 目录 + 复制 standard 组合（~200 行 YAML，上游升级需 diff 重同步——维护账已记）改 persona 行注入公司安全条款；锁定构建 roots 指向我们目录（standard/code/cordis 全隐藏，minimal 已有 Windows 过滤）+ defaultId=deloitte-standard；旧会话温和迁移（继续可用直到关闭）。**定位诚实记**：persona 是指导层非硬栅栏，硬栅栏=沙箱权限+插件签名链。
**③ 系统提示词前言移除（2026-08-31，`2c3d3d251b`）**：锁定构建 patch system-prompt 行（includeHarnessIdentity:false）+ web-runtime 行（surfaceContext:false）——三段前言全灭（identity/-100、checkout 路径/-99、GUI URL+HMR/-98，DSH_WEB_URL 变量同删）；fail-closed 防上游改组回流；未锁定 sha256 逐字节一致。**web_search 决策（用户拍板保留）**：源=DeepSeek 官方 API 服务端搜索（api.deepseek.com/anthropic/v1 + web_search_20250305，复用 DEEPSEEK_API_KEY）；与对话同端点同密钥，**不新增外发目的地**，删除无安全收益只损功能；fetch:false 无 SSRF 面。**工具说明书段落（read/write/glob/grep/goal/workflow 等）保留**：中性功能指令，非环境自曝。
## 下一阶段计划（2026-08-29 制定，试点三大目标已全部达成后）
**已完成基线**：① 插件只能来自公司签名目录（origin 实机稳定）② 装了不能被本地篡改（signed-tree 权威模式生效）③ 上下架全自动（3 分钟+重启）

| # | 事项 | 内容 | 触发条件/依赖 | 规模 |
|---|---|---|---|---|
**P1 已完成（2026-08-29，sequence 8/9 双向实操）**：吊销链路实机验证三处全符预期（市场两栏消失/Installed 拒载/诊断可查）；恢复链路 sequence 9 上线待用户重启确认。**时效修正**：市场侧生效受 5 分钟 scan TTL 缓冲（DEFAULT_CATALOG_SCAN_CACHE_TTL_MS，可调）；boot 拒载需重启。自动发布链路第三次实操（全流程 ~6 分钟含人工下载 artifact）。

| P1 | **真 revoked 语义演练** | 用新自动链路走一遍：allowlist revoked→publish→用户重启验证市场消失+已装拒载→恢复 publish。既验证吊销路径又是自动链路第二次实操 | 无，随时（10 分钟） | S |
| P2 | ~~扩面物料~~ **挂起（2026-08-30 用户拍板不做）** | 理由：①receipt 迁移文案已死项（唯一旧机器已迁移，同事全新装）；②RUNBOOK 在 N=3-5 不如口头支持，凭想象写的文档没价值。**复活触发条件：用户第三次回答同一个问题时** | 触发式 | S |
| P3 | **测试组扩面** | 3-5 台同事机器（待办⑤ GUI 三面冒烟顺带做）；收集安装/市场/升级反馈；旧包机器注意 M2 门禁（≤#23 机器必须先升 #29+）| P1 P2 完成 | 用户主导 |
| P4 | **双钥轮换演练**（待办②）**签收不换（2026-09-02 用户拍板：demo 钥 c469 继续用，懒得换）** | 正式钥 keygen→策略双指纹→新钥 publish→下版策略收旧钥；PAT 一并轮换。演示钥泄漏完整利用链=私钥+PAT 双泄漏，当前泄漏面有界（你我环境），测试组规模风险不变。**触发条件：正式推广/装机量超出可盯范围；天然搭下次发版** | 推广决策触发 | M |
| P5 | **上游 0.1.2 正式版评估** | 子模块现钉 0.1.1-rc.2；0.1.2-alpha(+1079 ptc 重命名)——等正式版后评估升级窗口（allowlist runtime 范围、补丁面、回归）| 上游发正式版 | M |
| P6 | **自有更新源**（待办⑩选项 A）**挂起（2026-08-30）** | GitLab 托管签名 update-manifest + ARTIFACT_TRUST_ROOTS 替换 → fleet 自动升级（git push 即发版）。挂起理由：当前装机量手动升级可控；技术风险三项里最高（electron-updater 格式非自有 schema，信任根替换需仔细做）。**触发条件：装机量让手动升级变痛/正式推广；建议与 P4 同批发版** | 推广决策触发 | M |
| P7 | **技术尾巴** | ①E2E origin 稳态步——**挂起**（单测已覆盖+实机数周稳定，下次动 E2E 顺手）②blob 下载备选——**✅ 完成（2026-08-30，`35830b899d`+评审修复 `d50f066018`）并全链路首验通过**：workflow mirror job 把签名产物镜像到 catalog-artifacts 分支（快进 push+rebase 重试，保留 5 个 run）；publish-local --run 在 gh 下载失败（blob 域 TLS）时自动回退 git 分支拉取。首验 run 33291765023：seq 10 全自动发布（验签→棘轮→GitLab push→回读复核），**发布流程零人工环节达成**。评审实证：伪造签名在 git 通道同样 fail-closed③M1 post-install 校验——**挂起**（低概率+后果非安全+下次升级自愈，等真实案例） | ②进行中 | S |

| 新 | **SSO 启动门禁**（2026-08-31 设计定稿） | 详见上方第三批设计段：静默优先+浏览器兜底、requireSso 快速开关、认证徽章（侧边栏+托盘）。nova 参考码路径在案 | 用户说启动 |
| 新 | **logo 更换**（2026-08-31 记）**搁置（2026-09-02 用户拍板先不做）** | 一个 SVG master 三处同源：托盘（tray-icon.svg 进生成管线）/应用图标（512 渲染→app-icon.png→mac 派生）/应用内左上角（替换鲸鱼 slot，同品牌字样机制）。设计要求：16px 剪影可辨、撑得起正方形、宜单双色。纯资产零签名影响 | 等用户给 SVG |

**扩面前检查单**：P1 ✓ → P2 ✓ → 测试机全部 ≥#29（M2 门禁）→ GitHub secrets/PAT 在效期 → GitLab 匿名 raw 正常。

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
10. **[待办 2026-08-29] 自有更新源（选项 A，随正式密钥批次做）**：更新检查现指向上游 dshdesktop.cn（update-checker.ts 硬编码端点）——locked 构建已止血禁用；正式批次时：GitLab 托管签名 update-manifest（复用 P3-3 签名通道 + ARTIFACT_TRUST_ROOTS 公司构建替换）→ 客户端提示下载我们自己的安装器，与插件目录同模式「git push 即发版」
9. **[已立卡 2026-08-27 → 已实施同日 `8feab767be` + 评审修复 `d59ff089f7`，已 commit 未 push]「manifest 权威化」**：交付 D1 schema（treeDigest hex64 + approvedBuilds，渐进可选，旧 sequence-3 目录零影响）/ D2 锚点迁移（条目带签名 treeDigest → 磁盘实测对签名值，receipt 降级无决策权缓存，删/伪造均不能跳测或降级；新证据等级 signed-tree）/ D3 构建批准驱动（内置三元组 ∪ 签名 approvedBuilds，安装链 WAL 快照前合入）。评审修复：H1 权威条目绕过 stat 指纹缓存（缓存用户可写、命中返回记录值非实测值——伪造缓存旁路已堵，缓存仅加速 receipt 模式；安全注释改写为如实版本 + 3 条攻击向测试含变异验证）/ M2 fleet 升级顺序入册 README 双语（旧客户端 additionalProperties:false 整批拒收新清单——顺序：升 fleet→实测→重签→push）/ M3 approvedBuilds 语义勘误（profile 全局/回滚后驻留/跨条目生效）/ L4 锁定 CLI 通道同样消费签名 approvedBuilds / L5 allowlist 214 长度上限。测试 desktop 1140（+18）/ market 372 全绿；E2E 冒烟 12/12。**已实机启用（2026-08-29）**：sidebar treeDigest 经全自动链路签入 sequence 7，#29 实测 evidence: signed-tree；后续插件上架自动获得权威模式。原背景与 staged install 备选项见下：
   - 背景：用户装认可插件后本地改实现——只改文件被启动验签拒，但删/伪造 receipt 可绕（receipt 在用户可写 settings 且是期望摘要唯一记录）；manifest-only 拒载的策略决策仍挂起（等误报数据）；OS 级签名仍是 R1 路线
   - staged install 备选（暂不做）：市场下载 tarball→对签名 manifest 验 sha512→暂存→pnpm 装本地文件，消除对 pinned registry 在线不可变性的依赖并把 TLS 摘出安装关键路径；触发条件=切内部 registry/网络环境恶化

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
