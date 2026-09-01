July，收到决策。已补验三处关键事实：`bin.ts:11-124` 确认支持 `--export-diagnostics`；receipt 存于 `dsh-community-market` settings namespace（`host/routes.ts:42,56,1408`，`applies: 'live'`）——证实其用户可写、必须降级为缓存提示；诊断导出链路（`diagnostic-export.ts` 的 `exportDesktopDiagnostics`）可作为签名报告载体。以下是无 IT 终态的**完整修订版实施计划**（自包含，可直接开卡；标注了与上一版的差异）。

---

# DSH Desktop 公司市场与客户端锁定 · 实施计划 v2（无 IT 合作版）

**已签收的安全上限**（本计划的验收基线）：
> 任何不修改 DSH Desktop 应用本体的手段都无法让未签名插件加载；修改应用本体可绕过全部校验，但会留下可识别的诊断证据缺失。专业用户防不住，小白用户全部路径封死。

**设计三支柱**：① 封死默认路径（易用性攻击面归零）② 抬高绕过成本（必须改应用本体）③ 留下篡改证据（诊断签名报告）。所有客户端校验按「磁盘上一切皆敌意输入」处理：`<DSH_HOME>`、`<userData>`、settings 文档全部不可信；唯一信任锚 = ed25519 签名 catalog manifest（公钥内嵌应用）。

**全程红线**：不改 `deepseek-harness/`；兼容模式不 override 上游默认客户端；`dsh-community-market` 源码不得依赖 Desktop 实现（architecture 门禁强制，策略只能构造注入）。

---

## Phase 1 · L1 客户端策略锁定（6 卡，与 v1 基本一致）

#### P1-1 策略源模块
- **目标**：随应用分发、构建期内嵌、只读的策略源；默认锁定；fail-closed。
- **文件**：新建 `dsh-plugin-desktop/src/desktop-policy.ts`、`dsh-plugin-desktop/tests/desktop-policy.spec.ts`；`src/index.ts` 导出；`scripts/clean.mjs`/构建配置携带策略 JSON 资产。
- **要点**：① `DesktopPolicy` 接口：`locked`、`companyCatalogOrigin`（可空 = catalog-as-content 模式）、`companyManifestUrl`、`allowHomePatch:false`、`allowManualPluginAdd:false`、`trustRoots`（ed25519 公钥指纹数组，含 keyId，支持双钥重叠）；② 策略 JSON 随 `lib/` 分发（仿 `packaged-runtime-path.ts` 资产定位），严格 schema 解析（仿 `desktop-market.ts` 的 `parseDesktopMarketState` 风格），异常即抛；③ dev 构建允许 `unlocked`，公司发布构建注入 `locked`（`package:*/dist:*` 脚本选型）；④ 纯函数 + 可注入参数，供单测与 market 侧使用。
- **验收**：新 spec 覆盖合法/缺字段/损坏 JSON/默认值；`corepack yarn workspace dsh-plugin-desktop check` 绿。**参考模板：dataelement/dsh-desktop `src/main/security-policy.ts`（34 行）——小而转注的 URL/permission 门禁纯函数模式，接口风格可借鉴**（注意：该项目asar:false+零验签，仅参考代码风格，不参考安全姿态）。
- **依赖**：无。**红线**：无。

#### P1-2 Market provider 钉死
- **目标**：生效 provider 由策略派生，用户可写的 `<userData>/desktop-market/state.json` 不再影响 effective。
- **文件**：`dsh-plugin-desktop/src/desktop-market.ts`；`tests/desktop-market.spec.ts`。
- **要点**：① `snapshot()` 处改派生：锁定下 effective 恒为公司 provider，requested 仅作诊断记录；② 写入函数保留但文档化不影响 effective；③ 注意该模块目前无 main.ts 运行时消费者（已读码确认），接线在 P1-6/P2-2；④ `desktopMarketStateConstants` 冻结导出保持兼容。
- **验收**：锁定下写 `community-market` → effective 不变；损坏 state → fail-closed；包 check 绿。
- **依赖**：P1-1。**红线**：无。

#### P1-3 安装目标白名单 ★语义修订
- **目标**（v2 修订）：白名单核心从「registry origin」改为「**目标包的 integrity 必须命中签名 manifest 条目**」；origin 钉死降级为纵深防御项。P2 落地前 = 拒绝一切安装。
- **文件**：`dsh-plugin-desktop/src/pnpm.ts`；`dsh-community-market/src/install/service.ts`、`src/index.ts`；测试 `tests/pnpm.spec.ts`、`tests/market-pnpm-integration.spec.ts`、market 侧 `tests/market-install.spec.ts`。
- **要点**：① `pnpm.ts` 的 `installPlugin()`/`runPluginInstall()` 增加 `pnpmOptions` 审计：`--registry`、`--<scope>:registry`、`--config.*`、`.npmrc` 类开关一律拒绝；② `service.ts` 的 `NPM_REGISTRY_ORIGIN` 硬编码改为 `createNpmRegistryVerifier(http, { allowedRegistryOrigin })` 注入；`installOptions()`、`officialNpmTarball()` 用注入值；③ `index.ts` 的 `createRestrictedHttpClient({ syntheticProxyHostnames })` 同步策略化；④ 定义 `InstallTargetAuthority` 接口（P2 前实现为「全拒绝」，P2 后实现为「签名 manifest 查询」）——本卡只做接口 + 拒绝实现 + 双端接线。
- **验收**：非白名单目标/integrity 不在清单 → `verification-failed`；恶意 pnpmOptions 被拒；根 `corepack yarn check` 绿（含 architecture 门禁）。**参考实现：dataelement/dsh-desktop（第四范式独立桌面壳）的 `packages/dsh-desktop-market-installer/`（index.js 731 行 + client.js 712 行）已解决同批 pnpm 工程坑**：中断残留清理（`_tmp_`/SIDELINE_MARKER 目录递归扫描）、Windows 锁定 rename 恢复、`ELECTRON_RUN_AS_NODE` 传给 pnpm 子进程、15 分钟操作超时、manifest 快照不因卸载失败回滚——P2-3/P2-5 实现时直接对照。
- **依赖**：P1-1。**红线**：无。

#### P1-4 拒绝 home 级 patch
- **目标**：锁定下 `<home>/cordis.patch.yml` 存在即拒绝启动（fail-loud）。
- **文件**：`dsh-plugin-desktop/src/profile.ts`；`tests/profile.spec.ts`；错误呈现如需则 `src/startup-failure-routing.ts`。
- **要点**：① 门禁点 = `prepareDesktopProfile()` 内 `loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME))` 之前；策略经可选参数注入保持纯函数风格；② **不改** patch 组合顺序与 `advanced` 模式行校验；③ profile 清单 bundle 列表校验留给 P2-4。
- **验收**：锁定 + home patch → 抛错；解锁 → 现有用例全部不变；`verify:profile`/`verify:loader` 绿。
- **依赖**：P1-1。**红线**：**低风险触碰**——只收窄输入面；评审盯 diff 无顺序改动。

#### P1-5 CLI 门禁（`dsh plugin add`）
- **目标**：锁定下终端 `plugin add` 在触达受管 pnpm 前被策略拒绝（P2-5 替换为签名通道）。
- **文件**：`dsh-plugin-desktop/src/desktop-cli.ts`；`tests/desktop-cli.spec.ts`。
- **要点**：① 插入点 = `runDesktopDshCli()` 内 `pluginAddProfile(argv.slice(2))` 判定之后、`loadWithInstallRecovery`/`load()` 之前；② 拒绝 = stderr 明确文案 + `process.exitCode = 1` + 直接 return（不 import 上游 CLI、不进 recovery 事务）；③ `plugin remove` 等其他子命令不动。
- **验收**：锁定下 `plugin add x@1.0.0` → exitCode 1 且 DSH 入口未被 import（现有 fake-load 断言模式）；解锁 → 现有用例不变。
- **依赖**：P1-1。**红线**：无。

#### P1-6 Market 设置面与 source 面锁定
- **目标**：catalog source 锁定为公司 source；sources 增删改 API 拒绝。
- **文件**：`dsh-community-market/src/catalog/source-store.ts`、`src/host/routes.ts`（`ROUTE_SOURCES` 等）、`src/index.ts`；测试 `tests/source-store.spec.ts`、`tests/host-routes.spec.ts`、`tests/market-settings-persistence.spec.ts`。
- **要点**：① 策略经 `index.ts` 的 `apply()` 以 options 注入（不得 import desktop）；② 锁定时 `SettingsCatalogSourceStore.load()` 强制返回内建公司 source 记录（忽略 settings 存储），`save()` 拒绝；source 管理端点返回 403 语义；③ `desktop-plugins.ts` 的 `IMMUTABLE_BUNDLES` 已含 `dsh-community-market`（已读码确认），补「公司市场不可禁用」单测；④ P1-2 的 effective provider 在此接线。
- **验收**：锁定下 POST source 变更被拒、GET 只含公司记录；根 check 全绿。
- **依赖**：P1-1、P1-2。**红线**：无。

**Phase 1 测试**：单测如上；冒烟 `verify:loader/profile/cli`；手动（`corepack yarn package:dir`）：home patch 拒启、篡改 state.json 无效、终端 add 拒绝、Market source 切换拒绝。
**Phase 1 风险**：① 策略资产在 asarUnpack 明文区（P3-2 才收口，L1 阶段明示）；② dev 工作流回归；③ P1-2 无消费者易漏接线（P1-6 合并验收兜底）。

---

## Phase 2 · L2 签名体系 + 公司市场（7 卡，P2-4/P2-6 重构）

#### P2-1 签名验证库（ed25519）★增强
- **目标**：验签原语 + 公司 manifest 规范，**含单调序列号与 `expiresAt`**（无服务端吊销环境下的防回滚手段）。
- **文件**：新建 `dsh-community-market/src/signing/`（manifest schema、`node:crypto` ed25519 验签、keyId 指纹匹配、双钥重叠）；新增 `dsh-community-market/docs/schemas/company-manifest.schema.json`；新建 `tests/signing.spec.ts`。
- **要点**：① 零新依赖，`crypto.verify('ed25519',…)`；签名 = canonical JSON 的 detached 签名 + keyId；② manifest 条目绑定：包名 + 精确版本 + sha512-integrity + bundlePatch 路径 + `revoked` 位 + runtime 兼容范围（把 `service.ts` 硬编码的 `DSH_RUNTIME_VERSION` 等常量的权威来源移到 manifest 侧，客户端只比对）；③ manifest 顶层：`sequence`（单调递增，客户端持久化见过的最大值，防回滚）、`expiresAt`（过期即整目录失效，倒逼密钥/目录滚动）；④ receipt 证据字段复用 `dsh-community-fabric` RFC 0004 词汇（`resolved`/`decided`），fabric 仅文档引用。
- **验收**：正确签名过、篡改拒、错 key 拒、双钥均过、sequence 回滚拒、过期拒。
- **依赖**：P1-1。**红线**：无。

#### P2-2 公司 catalog provider（客户端）
- **目标**：签名 manifest 成为 catalog 唯一来源；**托管降级链**：团队静态托管 → 无托管则 manifest 随应用包分发。
- **文件**：`dsh-community-market/src/adapters/standard-http.ts`（`assertStandardSourceTrustRoot` 之上加验签层）、`src/catalog/service.ts`、`src/index.ts`；测试仿 `tests/dshfind-adapter.spec.ts` 新增 company-provider 用例。
- **要点**：① 公司 manifest = `docs/schemas/catalog-snapshot.schema.json` 线格式 + 条目 integrity + 顶层签名块；拉取后先验签（含 sequence/expiresAt 检查）再 `parseCatalogSnapshot`；② catalog-as-content 模式：策略 `companyManifestUrl` 为空 → 从打包资产读内嵌 manifest（插件上新节奏绑定应用发版，写进运维说明）；③ 验签失败 = 整目录丢弃 + UI「市场目录不可信」，绝不降级；④ `observeCatalog` 候选流不变。
- **验收**：假 key/篡改/回滚/过期全拒；正常 manifest 产出可安装候选；根 check 绿。
- **依赖**：P2-1、P1-6。**红线**：无。

#### P2-3 安装时签名校验 + receipt 重定位 ★修订
- **目标**：安装校验链 = 签名 manifest 条目 ∩ registry 元数据 ∩ 安装后实测；**receipt 降级为缓存提示与卸载对账凭证，永不作为放行依据**。
- **文件**：`dsh-community-market/src/install/service.ts`、`src/api-types.ts`、`src/catalog/source-store.ts`；测试 `tests/market-install.spec.ts`、`tests/market-settings-persistence.spec.ts`。
- **要点**：① 校验链：P2-2 候选（带签名 integrity）→ P1-3 注入 origin 的 verifier 逐字段核（现有 `createNpmRegistryVerifier` 逻辑保留）→ `executeInstall` 现有二次 verify 模式不变，签名比对纳入；② **安装时计算包目录树摘要**（包内文件相对路径 + 内容哈希的确定性清单，从 tarball 解压确定性对齐），存入 receipt —— 供 P2-4 启动校验；③ receipt v2 schema（keyId、manifest sequence、树摘要、`resolved`/`decided` 证据）；`validReceipt()` 严格校验；④ 用户手写假 receipt 无效：放行判定只看「签名 manifest 条目 ∩ 实测树摘要」，receipt 缺失/伪造只影响卸载对账体验。
- **验收**：无签名候选不可预览；签名+integrity+树摘要全符才可执行；receipt round-trip；伪造 receipt 不影响拒载判定（专项用例）。
- **依赖**：P2-1、P2-2、P1-3。**红线**：无。

#### P2-4 启动校验（承重墙）★重构
- **目标**：每次启动以签名 manifest 为准校验全部第三方 bundle + 目录树摘要；未签名/不匹配/被篡改 → 显式拒载。
- **文件**：新建 `dsh-plugin-desktop/src/boot-verification.ts`（纯函数）；`dsh-plugin-desktop/src/profile.ts`（`prepareDesktopProfile` 组合前调用）；`src/desktop-plugins.ts`（拒载状态入清单）；测试 `tests/profile.spec.ts`、`tests/plugin.spec.ts`、新建 `tests/boot-verification.spec.ts`。
- **要点**：
  1. 输入 = profile manifest bundles + pnpm-lock + node_modules 实测树摘要 + 签名 manifest（内嵌资产或缓存，均验签）+ receipt（仅加速查找）；复用 `service.ts` 的 `assertProfileLockRecord` 思路在 desktop 侧重实现或经合法方向 import market 可复用部分。
  2. **只过滤第三方**：`desktopPluginBundleMutable()` 判定；`REQUIRED_BUNDLES` + `dsh-plugin-desktop` + `dsh-community-market` 永不过滤——上游默认客户端必须始终可启动（红线）。
  3. **覆盖外部 CLI 旁路**（无 IT 关键场景）：用户自装公开 npm 的上游 `dsh` CLI 直写同一 `DSH_HOME` → 安装动作拦不住，但下次启动拒载。专项集成测试：用真实上游 CLI 对测试 home 装一个包，断言本应用拒载。
  4. 拒载呈现：剔除 layers + 显式拒载列表 + 日志/诊断（P4-1 证据来源）；manifest 过期/缺失时第三方全拒（fail-closed）+ 上游 web 行照常启动。
- **验收**：篡改已装包文件、改 lock integrity、删/伪造 receipt、外部 CLI 直装 → 各自拒载且上游 web 行保留；`verify:loader`/`verify:profile` 绿。
- **依赖**：P2-3、P1-4。**红线**：**高敏感**——单测强制断言上游 bundle 完整保留。

#### P2-5 CLI `plugin add` 签名通道
- **目标**：终端 `plugin add pkg@ver` 走与 Market 相同签名校验，通过才放行。
- **文件**：`dsh-plugin-desktop/src/desktop-cli.ts`；`tests/desktop-cli.spec.ts`。
- **要点**：① 替换 P1-5 拒绝为校验通道：解析 `pkg@ver` → 查签名 manifest（内嵌资产或缓存；发起 HTTP 仅当在线模式）→ 验签 + integrity 比对 → 生成 receipt（含树摘要，与 Market 安装同一 `InstallTargetAuthority` 实现）；② 校验通过才进现有 `loadWithInstallRecovery` 事务；③ 失败（未签名/不在目录/网络不可达 fail-closed）= exitCode 1 + 原因；超时 ≤ 数秒。
- **验收**：签名通过 → load 被调用；未签名/离线 → exitCode 1 且不 load；根 check 绿。
- **依赖**：P2-3、P1-5。**红线**：无。

#### P2-6 签名目录发布管线 ★缩减
- **目标**：CI 管线生成并签名公司 manifest；无常驻服务、无内部 registry 依赖。
- **文件**：客户端外新基础设施（根工作区外 `tools/company-catalog/` 或独立仓库；不进三个 DSH 包）；根 `package.json` 可加只读占位脚本。
- **要点**：① 管线：内部 allowlist（JSON 清单，人工评审合入）→ 从 npmjs/镜像抓元数据与 integrity → 生成 catalog snapshot（过 `catalog-snapshot.schema.json` 校验）→ ed25519 签名（sequence 单调、expiresAt 短周期如 90 天）→ 发布静态托管；无托管时合入应用仓库随构建内嵌；② 吊销 = 重发 manifest（条目 `revoked:true` + sequence 递增）；③ CI 内置 round-trip 冒烟（生成 → P2-1 库验签）；④ 明确记录：integrity 取自 npm dist 元数据，代理镜像若重打包 tarball 会破坏一致性——管线断言直连 npmjs 或可信镜像。
- **验收**：CI 全链路（生成/验签/吊销/sequence 递增）；按 runbook 发布一个测试插件，锁定客户端安装成功。
- **依赖**：P2-1、P2-2。**红线**：无。

#### P2-7 密钥管理（CI secrets 定案）
- **目标**：密钥生成/保管/轮换/吊销流程定案；信任根随策略包闭环。
- **文件**：`.agents/notes/` 设计文档升级 implemented + `dsh-community-market/SECURITY.md` 增补公司部署章节；CI 配置（外部仓库）。
- **要点**：① 定案 = 专用发布环境 CI secrets + 最小人员 + 与代码仓库权限隔离；② 轮换 = 双钥重叠（策略 `trustRoots` 内嵌新旧公钥 → 新 key 签发 → 策略更新 → 旧 key 下线），全程无需客户端发版窗口外操作；③ **更新通道密钥独立**于 catalog 密钥（P3-3）；④ HSM/KMS 留为未来升级路径（客户端只认公钥，零改动可迁）。
- **验收**：真实演练一次轮换（双钥 → 收回）+ 一次吊销；密钥从不落盘到客户端可见位置。
- **依赖**：P2-6。**红线**：无。

**Phase 2 测试**：单测见各卡；冒烟 = `package:dir` + fixture 公司 catalog（本地静态文件或内嵌模式），全链路「浏览 → 预览 → 安装 → 重启加载 → 卸载 → 吊销后拒装」；手动：离线启动已验插件正常加载（boot 校验不依赖网络）、篡改已装插件 → 拒载、外部 CLI 直装 → 拒载。
**Phase 2 风险**：① receipt v1 存量全部拒载（无灰度基础设施，写进发布说明 + 重装引导 UI 文案）；② 树摘要与 tarball 解压确定性对齐（npm tarball 的 mtime/权限归一化规则要钉死，跨平台一致）；③ catalog-as-content 模式下插件上新慢（运营预期管理）；④ expiresAt 过短会在发布断档时把第三方全拒——过期阈值与发布节奏联动设计。

---

## Phase 3 · L3 打包加固（4 卡，重心 = 捆绑 Node）

#### P3-1 捆绑 Node 运行时，关闭 runAsNode fuse ★升为核心
- **目标**：消除「exe 即 Node」攻击面——v1 的 P3-4 前移为首卡。
- **文件**：`dsh-plugin-desktop/package.json`（`electronFuses.runAsNode: false`；extraResources 捆绑 Node）；`src/pnpm.ts`（`DesktopPnpmBootstrap` 改用捆绑 node 跑 pnpm/CLI，`ELECTRON_RUN_AS_NODE` 环境注入退役）；`src/desktop-cli.ts`（in-proc RunAsNode → 捆绑 node 子进程，保留 `DESKTOP_INSTALL_RECOVERY_STATE_ENV` 与 `DSH_DESKTOP_DEFAULT_PROFILE` 语义）；`src/desktop-terminal.ts`/`src/terminal.ts`（终端复用 node 的调用点）；`src/main.ts`（bootstrap 路径解析）；`scripts/verify-cli-runtime.mjs`、`scripts/verify-runtime-closure.mjs`、`scripts/verify-packaged-runtime.ts`（门禁同步，grep 级排查 `ELECTRON_RUN_AS_NODE` 全部出现点）；测试 `tests/desktop-cli.spec.ts`、`tests/pnpm.spec.ts`、`tests/desktop-terminal.spec.ts`。
- **要点**：① `npm_config_runtime/disturl`（electron headers）语义不变；② `clearEnvironmentPath` preload 随之退役或简化；③ 分两步落地：先捆绑 node 并切换三个调用方（runAsNode 仍 true，可回滚）→ 冒烟全绿 → 再翻 fuse false（不可逆点单独 commit）；④ 捆绑 node 本身无签名锚——其完整性靠 P3-2 asar integrity 所不能及的 **P2-4 思想延伸：启动时对捆绑 node 二进制做摘要自检**（摘要存 asar 内），改 = 报警拒启（advisory 定性，改应用本体可绕过，但小白改不了）。
- **验收**：根 check 全绿；手动冒烟：终端/`plugin add`/Market 安装三面可用；VM 验证 `ELECTRON_RUN_AS_NODE=1 ./app` 不再进 Node 模式。
- **依赖**：P2-5（CLI 通道产品化后再动进程模型）。**红线**：无，但改动面全计划最广。

#### P3-2 asar integrity fuse + 收缩 asarUnpack（advisory）
- **目标**：核心代码回到 asar 内受 integrity 覆盖；定性为「拦脚本与不知情者」，非强制。
- **文件**：`dsh-plugin-desktop/package.json`（fuses 增 `onlyLoadAppFromAsar`、`enableEmbeddedAsarIntegrityValidation`；`asarUnpack` 收缩至 native 最小集）；`scripts/verify-packaged-runtime.ts`（afterPack 断言 asar 清单与 unpack 集合精确匹配）；`tests/package.spec.ts`。
- **要点**：① 现状 `asarUnpack` 全量明文（`package.json`、`cordis.patch.yml`、`build/**`、`lib/**`、`node_modules/**`——已读码确认）；收缩后策略 JSON + 核心 lib 落回 asar（策略信任根内嵌于 asar，受 Win embed integrity 保护）；② native 保留集：node-pty、koffi、sharp/@img、ripgrep（参考 mac `x64ArchFiles` 列表）；③ 每收缩一步跑全量打包门禁；④ 无 Authenticode 时 fuse 可被翻回——文档明示这是成本项；⑤ **参考实现：Minke（lencx/Minke，同为 Electron 43 + pinned harness submodule）已在生产配置跑通 `embeddedAsarIntegrityValidation + onlyLoadAppFromAsar` + NodeOptions/CliInspect 关闭（forge.config.ts），且其 harness 以 Electron-as-Node 子进程运行不受阻——证明该 fuse 组合与 harness 子进程模式兼容，P3-2/P3-4 可直接借鉴其配置**。
- **验收**：`check:win-package` + afterPack 断言；手动：篡改 asar 内文件 → 拒启。
- **依赖**：P1-1、P3-1（unpack 集合稳定后收口）。**红线**：无。

#### P3-3 签名更新通道
- **目标**：更新产物 ed25519 验签（独立密钥），防恶意降级与劫持；自动更新同时承担「全网客户端保持锁定版」职责（无 IT 推送时这是唯一版本治理手段）。
- **文件**：`dsh-plugin-desktop/src/update-download.ts`（现有 `koly`/PE 魔数之上加 detached 签名验证——已读码确认现状无密码学校验）；`src/update-checker.ts`（端点钉死进策略/构建常量）；`src/updates.ts`；测试 `tests/update-checker.spec.ts`、`tests/update-download.spec.ts`。
- **要点**：① 签名 key 与 catalog key 独立（P2-7 已决策）；② 验签失败与魔数失败同一错误面；③ 1 GiB 上限与原子写不变；④ 更新元数据（版本清单）同样带 sequence 防回滚。
- **验收**：篡改产物拒、错 key 拒、回滚清单拒；手动完整升级一轮。
- **依赖**：P2-7。**红线**：无。

#### P3-4 Fuse 全集与发布门禁收口（advisory）
- **文件**：`dsh-plugin-desktop/package.json`（fuses：cookieEncryption、nodeCliInspect:false、nodeOptions:false 等）；`scripts/verify-packaged-runtime.ts`（fuse 位断言）；`tests/package.spec.ts`、`tests/package-mac.spec.ts`、`tests/release-preflight.spec.ts`。
- **要点**：① 公司发布构建启用全集，dev 构建维持宽松（nodeCliInspect 等对开发的影响）；② mac（已 notarize+hardenedRuntime，读码确认）与 Win 门禁矩阵进 `release-preflight`；③ **条件附录**（写进文档不排期）：若未来拿到预算/IT——补 Authenticode（P3-1/3-2 客户端零改动即可升级为强制语义）与 perMachine 安装；④ **fuse 全集参照 Minke forge.config.ts 已验证组合**（RunAsNode 除外——Minke 保留 true 因其 harness 子进程靠它，我们 P3-1 关闭后对齐）。
- **验收**：`check:win-package`/`check:mac-package` + `@electron/fuses` 读回断言。
- **依赖**：P3-1、P3-2。**红线**：无。

**Phase 3 测试**：打包门禁为主 + VM 手动矩阵：runAsNode 失效、asar 篡改拒启、捆绑 node 摘要自检、签名升级链路、三面冒烟。
**Phase 3 风险**：① P3-1 横切面最大——分两步 commit + 每步全量门禁；② asarUnpack 收缩踩 native 加载/mac universal——步进式收；③ 捆绑 node 体积与许可合规（THIRD_PARTY_NOTICES 更新，`verify:licenses` 门禁会拦）；④ 无签名锚下一切 fuse 均为成本项——文档与签收声明中反复明示。

---

## Phase 4 · 检测、取证与残余风险签收（4 卡，替换原 IT 交接）

#### P4-1 签名诊断自检报告
- **目标**：`--export-diagnostics` 输出扩展为带 ed25519 签名的安全自检报告。
- **文件**：`dsh-plugin-desktop/src/diagnostic-export.ts`/`diagnostics.ts`（扩展导出内容）；复用 P2-1 验证库（desktop → market 依赖方向合法）；`src/bin.ts`（通道已存在，`bin.ts:11-124` 已确认）；测试 `tests/diagnostic-export.spec.ts`、`tests/diagnostics.spec.ts`。
- **要点**：① 报告内容：本次启动加载/拒载的 bundle 清单、校验结果（`resolved`/`decided`）、校验器与策略资产自身摘要、manifest sequence；② 导出签名用独立 view-key（同 P2-1 库，密钥对由发布管线持有）；③ 攻击者改了客户端也伪造不出有效签名报告——报告缺失/验签失败本身就是篡改信号（签收声明的证据基础）。
- **验收**：正常导出可验签；篡改报告内容验签失败；`bin.ts --export-diagnostics` 手动跑通。
- **依赖**：P2-4、P2-1。**红线**：无。

#### P4-2 篡改证据链文档
- **目标**：安全事件响应可用的证据手册。
- **文件**：`dsh-plugin-desktop/docs/`（或 `.agents/notes/implemented/`）新文档 + 双语（仓库 bilingual 门禁强制）。
- **要点**：① 哪些日志/诊断字段可证明「客户端被改」「插件被拒载过」「签名报告缺失的含义」；② 取样流程（导出诊断 → 验签 → 比对策略资产摘要）；③ 与 P4-1 报告字段一一对应。
- **验收**：一次演练：手工篡改测试机客户端 → 按手册取样 → 结论正确。
- **依赖**：P4-1。**红线**：无。

#### P4-3 残余风险签收声明
- **目标**：管理层签字的正式上限声明。
- **文件**：`.agents/notes/` 新 note（双语）。
- **要点**：原文收录上限声明 + 残余风险表（外部 CLI 直装被 boot 校验拦截但安装动作本身不拦 / 改应用本体可绕过一切但留证据缺失 / CI 密钥被盗的轮换预案 / 自建魔改客户端不可检测）+ 「未来接 IT 后的升级路径」（Authenticode、perMachine、WDAC——客户端已预留零改动升级点）。
- **验收**：签字归档。
- **依赖**：P4-2。**红线**：无。

#### P4-4 发布合规收口
- **目标**：公司发布构建的最终门禁清单。
- **文件**：`dsh-plugin-desktop/scripts/release-preflight.ts`（扩展断言：锁定策略资产存在、fuse 全集、签名更新配置、诊断签名 key 就位）；`tests/release-preflight.spec.ts`。
- **要点**：任何一项缺失 → 发布阻断；清单与 P4-3 声明互引。
- **验收**：`release-preflight` 在缺任一项时失败；完整公司构建全绿。
- **依赖**：P3-4、P4-1。**红线**：无。

---

## Phase 5 · 模型调用上报（新增企业工作流，2026-09-01 开卡）

> 独立于 L1-L3 锁定，属「公司级企业定制」扩大的目标。目的：记录用户实际调用模型，发现用户在用默认模型还是自配置。**合规硬约束：不记录任何用户内容/会话内容，仅 token 与元数据。**

#### P5-1 上报数据表（DB 已建）
- **目标**：公司 MySQL（10.173.46.21:3306，库 `dsh_usage`）落表。
- **现状（2026-09-01 已做）**：新表 `dsh_model_call_events`（明细，一次调用一行）已建。字段：`user_email`(AAD email 用户标记)、`provider/model/base_url`、六 token（input/cache_read/cache_write/output/reasoning/total）、`tokens_per_second`(tps)、`ttft_ms`、`latency_ms`、`session_id`(可选关联)、`created_at`。索引 `(user_email,created_at)`、`(model)`、`(created_at)`。**已删聚合表**（用户：只要明细上报，不做比对字段，故 no `is_default_model`）。库存旧表 `conversation_summary/usage`（上游遗留，不触碰）。
- **待办**：建低权账号 `dsh_report_writer`（仅 INSERT dsh_usage，无 SELECT/其他库，绝不用 root）；删已建/确认 `is_default_model` 不再需要（用户拍板不做比对，若表里有该列则 DROP）。

#### P5-2 主进程 usage 采集模块`
- **目标**：订阅 `session/event` → `assistant/message` 的 `data.usage`（scout 已证：`TokenUsage` 五字段 input/output/cacheRead/cacheWrite/reasoning，互斥统计；`packages/llm/llm/src/types.ts:135-142`）。桌面已有先例 `dsh-plugin-desktop/src/notifications.ts:132`。`total_tokens`=求和；`tps/ttft/latency` 不在负载里，需按 session-stats projection 公式从事件时间戳派生（`session-stats/src/projection.ts:126-160`）。
- **要点**：注入事件/DB 依赖做成可单测纯函数核心；AAD email 从 SSO 会话取；model/base_url 实现时实测从事件字段拿还是从插件自持网关配置断定；**零内容落库（测试断言覆盖）**；批量 INSERT 缓冲 + 断连重试 + 不阻塞聊天。

#### P5-3 写库路径与凭据
- **传输**：主进程直连 MySQL，`mysql2` 纯 JS（无原生编译，进 Electron main）。**绝不用 root 口令打包进客户端**。
- **凭据**：DSN（低权 `dsh_report_writer`）走混淆 blob 分发（同 model gateway key，仓库零明文）；env 覆盖口 `DSH_REPORT_DB_*` unpackaged-only 忽略（沿用 SSO/网关模式）。

#### P5-4 开关与验收
- **待定（需用户拍板）**：上报是否受 `policy.usageReport` 控（release 开/dev 关，推荐）还是构建后恒定开；DSN blob 自动分发（推荐）还是 env 每台手动。
- **验收**：mock 事件/DB 单测（字段投影全、tps/ttft/latency 算式、零内容断言、批量写、开关关闭不写）；根 `corepack yarn check` 绿；构建 #41 装机实测入库一行。

### P5 状态
- 开卡 2026-09-01。P5-3/P5-4 的 3 个拍板点等用户：①Step0 现在做？（删列+建 account）②开关 policy 控 vs 恒定开 ③DSN blob vs env。

---

## 兼容模式红线汇总

| 卡 | 触碰 |
|---|---|
| P1-4 | 低风险：只门禁输入，不动组合顺序；评审盯 diff |
| P2-4 | **高风险**：过滤必须永远保留 `REQUIRED_BUNDLES` + `dsh-plugin-desktop` + `dsh-community-market`；单测强制断言上游 web 行存在 |
| 其余 | 不触 patch 组合/模式持久化/重启策略 |

## 关键路径与并行度

- 关键路径：P1-1 → P1-3 → P2-1 → P2-2 → P2-3 → P2-4 → P3-1 → P3-4 → P4-4。
- 可并行：P1-2/P1-4/P1-5（互不依赖）；P2-5 与 P2-4；P2-6/P2-7（服务端/密钥，与客户端卡零耦合，**建议最早启动**——密钥与托管决策是 P2 全系的输入）；P4-1 骨架可与 P3 并行。
- 里程碑验收：Phase 1 出口 = 锁定客户端拒绝所有非公司入口；Phase 2 出口 = 未签名插件装不上、装了重启拒载（含外部 CLI 直装场景）；Phase 3 出口 = 打包门禁全绿 + runAsNode 关闭；Phase 4 出口 = 签字归档。

**下一步**：开 P1-1（策略源模块）和 P2-7（密钥决策）——一张是客户端根卡，一张是签名体系的组织前置，两者都不阻塞彼此。