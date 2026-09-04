# Agent 笔记：公司插件市场 · 交接与开发指南（精简版）

Status: Implemented（2026-09-04，P7 闭环：dsh-free-search 0.4.182 经 tarball 通道上线，已部署清单 sequence 12）

[English](2026-09-04-company-market-owner-handover.md) | 中文

本文是英文主文档的精简版，全部路径/命令/哈希已对 master `e4490c3f82` 实况核对；细节与论证以英文版与 `tools/company-catalog/README.md` 为准。

## 1. 所有权地图

| 区域 | 职责 | 入口 |
| --- | --- | --- |
| `dsh-plugin-desktop/` | 客户端安装/验证/boot 复验/CLI 闸门 | `src/desktop-market.ts`（provider 钉死＋双通道严格验证器 `verifyDesktopCompanyManifest`＋受控 tarball 暂存/安装）· `src/company-market-install.ts`（市场 UI 接线：验证缝＋pnpm 分流钩）· `src/boot-verification.ts`（`verifyDesktopBootBundles`＋`computeDesktopBootTreeRootDigest`）· `src/cli-install-channel.ts`（锁定终端 add 闸门）· `src/company-tarball-handoff.ts`（受信交接）· `src/pnpm.ts`（pnpm 边界，唯一可构造 `file:` 目标）· `src/policy/desktop-policy.release.json`（锁定策略＋trustRoots） |
| `dsh-community-market/` | 市场 UI 服务＋签名/验证库＋catalog provider 注入面 | `src/catalog/company-provider.ts`（`CompanyCatalogProvider`）· `src/index.ts`（`desktopCompanyManifestVerifier` capability 注入点）· `docs/schemas/company-manifest.schema.json`（`additionalProperties:false`） |
| `tools/company-catalog/` | 发布管线（allowlist→pack→measure→sign→publish）＋收编插件源码真身 | `cli.mjs` · `measure.mjs` · `publish-local.mjs` · `e2e-tarball.mjs` · `allowlist.json`（唯一人工输入）· `state/last-sequence.json`（现值 12）· `plugin-sources/dsh-free-search-0.4.182/`（收编源真身）· `fixtures/fixture-hello/` |
| GitLab `julu/dsh-desktop-config` | 部署面（员工机实读） | `catalog-manifest.json`（master raw，URL 已钉进策略）＋ `packages/<name>-<version>.tgz` |
| CI | 运维三工作流＋门禁 | `company-catalog-publish.yml`（手动、Windows、dry-run 默认开；只签名上传，绝不碰 GitLab）· `company-catalog-digest.yml`（手动，Windows 参考树摘要，只测不签）· `windows-package.yml`（fleet 构建装机烟测）＋ `company-catalog.yml`（管线自测）/`ci.yml` |

路由口诀：客户端执法→desktop；市场 UI/验证库→market（不得 import desktop 实现，架构门禁）；产出与发布信任→tools/company-catalog；GitLab 配置仓只经 `publish-local.mjs` 写入。

## 2. 信任模型与红线

一句话：评审合入的 `allowlist.json` → 规范 JSON 清单 → detached ed25519 签名 → 内网 GitLab 分发；客户端只装清单钉住的条目，且每次启动对已装树复验。

1. **签名链**：keyId `company-catalog-2026-08`，指纹 `c46940234dc854ad3964d561ee4e52adf20dc73cb578e26b98f120aec1049af6`（钉在 `trustRoots`）；私钥只存在于 CI secrets，只经环境变量读取，绝不落盘。
2. **tgz 不可变**：打包确定性，签名 sha512 绑定精确字节；内容变=新版本（新文件名/新 integrity/新 treeDigest/更高 sequence）。
3. **sequence 单调棘轮（双侧）**：GitHub 侧以入库 state 文件为下限；内网侧 `publish-local` 独立对拍 `artifact.sequence == GitLab 已部署 + 1`；计数器不可回退，坏发布只能被更高 sequence 覆盖。
4. **fleet 门禁**：`source`/`treeDigest`/`approvedBuilds` 对签名者可选、对 fleet 不是——旧客户端 `additionalProperties:false` 一个未知键拒收**整份**清单。`source` 意义上的 field-aware = 三消费者（boot 验证 / 锁定 add 闸门 / 市场 provider）全部走 `verifyDesktopCompanyManifest`；全员升级前不得发布携带新字段的清单，`--confirm-fleet-upgraded` 是操作者显式确认。下次破坏性变更必须升 `manifestVersion`。
5. **CLI 红线**：用户参数永远造不出受控 tarball 目标（pnpm 边界拒一切用户 tarball 参数、锁定闸门拒手敲 `file:`）。唯一例外 `DSH_COMPANY_TARBALL_HANDOFF`：由受信主进程构造、逐 spawn 注入（不入终端 shim、不遗传给 pnpm 子进程）、CLI 引导期即从环境移除，且闸门**双验**后才放行（重绑签名条目＋对暂存字节现算哈希=签名 sha512）。红线测试：`tests/company-market-locked-cli-install.spec.ts`。
6. **绝不动 `deepseek-harness/` 子模块**（layout 门禁核对）；市场源码不得依赖 desktop 实现。
7. **插件包目录运行时不可变**：boot 树摘要（`computeDesktopBootTreeRootDigest`）对包目录**全量文件哈希、零排除**——插件运行时写自身包目录（配置/缓存/日志）会在下次启动被树复验拒绝（fail-closed，与外部篡改不可区分，刻意为之）。运行时状态必须走 ctx 设置节（settings.yaml）/userData/`~/.dsh`；这与 pnpm 管理权一致（装卸本会重置包目录，写进去本就活不过更新）。free-search 引擎 key 存自身设置节（`installSettingsSection`）是正面范例。

另：吊销是状态不是删除（`revoked:true` 条目留签审计）；一个包名不允许双通道同时活跃（迁移=先 revoke 旧通道）；npm 条目禁带 url；npm 通道只认 `registry.npmjs.org`（重打包镜像破坏绑定，拒）。

## 3. 上架全流程（free-search 0.4.182 范式，sequence 12，treeDigest `adce37b4…`）

1. **收编审查**：安全审查＋剥旁路（自更新/本地 server/凭据中心/多余外联引擎）＋声明 `runtime.dshRuntimeVersion`（今为 `^0.1.1-rc.2`）；公司改版用第 4 位补丁号（`0.4.182`， prerelease 拼法被拒签）。**审查清单必含 §2.7 运行时不可变项**：状态走设置节/userData/`~/.dsh`，不得写自身包目录（自写自毙于下次 boot）。
2. **源码入库**：`plugin-sources/<name>-<version>/`（`--from-allowlist` 的 stem 约定）——此目录是真身，tgz 是构建产物。
3. **allowlist 条目**：`source:{kind:"tarball", url:<GitLab raw>, path:<out/packages 路径>}`；integrity 由打包时计算（path/integrity 互斥），`treeDigest` 留空待测；`bundlePatch` 必须与包内 `dsh.bundle.patch` 声明逐字节一致（含 `./` 前缀，管线已建签名前一致性断言）。
4. **打包**：`node tools/company-catalog/cli.mjs pack-tarball --from-allowlist`。
5. **测摘要**：正常路径=digest workflow（手动触发，Windows 参考安装：钉版 pnpm 11.8.0＋electron 运行时三件套＋编译版 `computeDesktopBootTreeRootDigest`）。**惯例：Windows 值为 fleet 参考，Linux 本地 `measure.mjs` 应对拍一致**（0.4.182 双平台一致）；不一致先查环境/缓存，绝不手挑值。
6. **实测值评审入 `allowlist.json`**（人工 commit；管线只签运行时副本）。
7. **CI 发布**：手动触发 publish workflow；dry-run（默认）只测签验不上传；取消勾选才上传 `company-catalog-signed` 产物并镜像 `catalog-artifacts` 分支、打印内网命令。
8. **内网发布**（同达 GitHub+GitLab 的机器，`GITLAB_TOKEN` 环境变量优先于 `--token`）：
   ```sh
   node tools/company-catalog/publish-local.mjs --run <run-id> --confirm-fleet-upgraded
   ```
   新字段首发必须 `--confirm-fleet-upgraded`（§2.4）。坑：内网 Node fetch 不认企业 TLS→`--insecure-tls`（即 `NODE_TLS_REJECT_UNAUTHORIZED=0`，信任由验签承担；可用 `NODE_EXTRA_CA_CERTS` 更优）；artifact blob 不通时自动回退 `catalog-artifacts` 分支（或 `--from-git`）。
9. **state bump**：`state/last-sequence.json` → 已发布 sequence 并 commit（GitHub 侧棘轮；忘 bump 下次内网侧 fail-closed）。

应急：`cli.mjs revoke <pkg>[@<version>]` 后按同链重发（见 §7）。历史注记：sequence 11（0.4.181）真机暴露四坑后作废，由 12 覆盖——棘轮按设计工作。

## 4. 客户端安装链（五道关卡）

1. **签名清单验证**：canonical JSON 字节等值＋严格形状＋信任根绑定＋detached ed25519＋防回滚 sequence 下限＋过期＋逐条目通道解析。
2. **受控下载**：仅策略 `companyCatalogOrigin` 上的 url，对下载字节验**签名 sha512**，暂存进 profile 受控暂存区。
3. **pnpm 受控 `file:` 目标**：经 `DSH_COMPANY_TARBALL_HANDOFF` 过 CLI 闸门（双验）；用户参数不可达。
4. **装后断言**：bundle 身份＋`bundlePatch` 严格相等（含 `./` 前缀）＋实测树=签名 `treeDigest`；分歧即回滚并给出可读原因。
5. **boot 复验**：每次启动重跑 `verifyDesktopBootBundles`——签名 `treeDigest` 为权威期望（receipt 降级 advisory，删/伪造均无效），全量零排除复测；失配只拒**该 bundle**（上游 web 行恒可启动）。

失败面：市场 UI 一行原因；桌面日志留断言名与期望/实际值（%APPDATA%\DSH Desktop\logs，`dsh-YYYY-MM-DD.log`/.error/分段）。现场排障发 `dev-log/grab-dsh-logs.ps1`（右键 Run with PowerShell，汇总最新 `dsh-*.log` 到桌面 `dsh-logs-<ts>.txt`）；深度用 `--export-diagnostics`。

## 5. 真机排障四坑（2026-09-04，全部修复入库）＋缓存教训

1. **CLI 闸门误伤市场通道**：症状=市场装 tarball 条目被锁定 add 拒绝文案挡下；根因=市场受控安装本身经打包 CLI 子进程跑 `file:<暂存路径>`，而闸门拒一切 `file:`；修复=受信交接 env（`26f1ecb4dc`）＋闸门双验放行，手敲仍拒；预防=红线测试双向钉死。
2. **EPERM 原子写竞态**：症状=Windows 随机致命崩溃（杀软瞬时锁 `settings.yaml` 等）；根因=上游 dsh-atomic-write 无重试；修复=yarn 补丁 `.yarn/patches/@deepseek-ai-dsh-atomic-write-npm-0.1.1-rc.2-be3f055a11.patch` 退避重试＋断言失败落日志（`600228a0c1`）；预防=依赖升级后确认补丁仍在。
3. **裸 catch 吞断言原因**：症状=只有泛化退出码，看不到哪个断言/期望值；根因=market service 裸 catch；修复=内联 cause＋子进程 stderr 实时桥接＋`logError` 落桌面日志（`59dd5086c0`/`600228a0c1`）；预防=安装断言上永不落裸 catch。
4. **bundle patch `./` 前缀失配**：症状=装后断言失败（包声明 `cordis.patch.yml` vs 签名条目 `./cordis.patch.yml`）；修复=0.4.182 对齐生态形态＋**管线级签名前一致性断言**（漂移拼写构建期即拒，e2e 可见）；预防=改任一侧时对拍拼写。
5. **缓存教训**：旧 `out/` 包缓存曾致 Windows/Linux 摘要假分歧——发布/对拍前清 `out/` 重打包；digest workflow 已携带 tarball 产物供字节取证（`27759e38e0`）。

构建线注记：fleet 门禁按全员 ≥#47 确认；**#50** 为已知良好客户端（四修复齐，其后修复均目录/清单侧）。

## 6. 测试与验证（2026-09-04 于 `e4490c3f82` 实测基线）

- `corepack yarn check` 全绿：market 400 · desktop 1789 pass＋7 skip · tools 70 · e2e PASS · 双语门禁 46 records/92 docs。
- `corepack yarn test:company-catalog`；**坑**：`node --test tools/company-catalog/tests/`（目录形式）在 Node 22 上直接 `MODULE_NOT_FOUND`（实测 v22.22.3，CI 钉 v22.23.2）——必须显式列六个文件（package.json 即如此）。
- `node tools/company-catalog/e2e-tarball.mjs`：fixture-hello 离线全链（打包→签名→dry-run 发布→双验证器对拍→boot 复验；需先构建 market+desktop lib）。
- DSH_XVFB 组合冒烟：`tests/agent-browser-composition.spec.ts` 以 `DSH_XVFB=1` 跑 `scripts/agent-browser-smoke.mjs`（真 Electron/CDP）；手动式 `xvfb-run -a node_modules/electron/dist/electron --no-sandbox --disable-gpu scripts/agent-browser-smoke.mjs`。
- digest workflow 对拍：Windows 参考值 vs Linux `measure.mjs` 应一致（见 §3.5 与 §5 缓存教训）。
- 管线自测：`cli.mjs selftest`（临时密钥，绝不发布、绝不动 state/out/allowlist）。

## 7. 运维速查

- **撤销**：`node tools/company-catalog/cli.mjs revoke <pkg>[@<version>]`→按 §3 重发。生效面：市场行 ≤5 分钟（`DEFAULT_CATALOG_SCAN_CACHE_TTL_MS`）；已装副本下次启动拒载（需重启）；诊断留痕；条目留签审计。sequence 8/9 已实机验证。
- **密钥轮换（双钥重叠）**：`keygen`→更新 CI secrets（SIGNING_KEY/KEY_ID）→新指纹入 `trustRoots`（发版，重叠期双钥可验）→新钥签发→下次发版移除旧指纹；客户端零额外操作。更新通道密钥独立（P3-3）。
- **GitLab 配置仓**：`julu/dsh-desktop-config`；PAT 仅此一仓写权限、无 API scope；manifest 只走 git push（网页编辑器会破坏验签）。PAT 泄漏影响面=清单可被改写，但客户端验签兜底拒收。
- **secrets 清单**：CI 仓 secrets=COMPANY_CATALOG_SIGNING_KEY（单行 base64 PKCS#8 DER）/COMPANY_CATALOG_KEY_ID（`company-catalog-2026-08`）/COMPANY_CATALOG_KEY_FINGERPRINT（可选钉扎）；内网发布机=GITLAB_TOKEN（env 优先于 `--token`）；本地开发=无（selftest/e2e 用临时密钥）。
- **sequence 不符**：内网侧拒发会打印两侧值——信已部署值；state 经发布后 bump 追平，绝不手工调低。

## 8. 冷启动清单（第一天）

**读**：本指南→`tools/company-catalog/README.md`（管线手册）→P7 卡（`dev-log/2026-08-22-company-market-lockdown-plan-v2.md`）→模块头注释（`desktop-market.ts`/`company-market-install.ts`/`boot-verification.ts`/`cli-install-channel.ts`/`company-tarball-handoff.ts`→`company-provider.ts`）。

**跑**：`corepack yarn check`（对照 §6 基线）＋ `node tools/company-catalog/e2e-tarball.mjs`。

**练**：亲自走一遍 fixture-hello——`cli.mjs pack-tarball --source-dir tools/company-catalog/fixtures/fixture-hello` 后重读 e2e 逐步输出，直到每行（pack→allowlist→gate→sign→publish dry-run→双验→boot）都能对应到你打开过的源码文件；做到这一点即完成接手。

**非文档交接项**：仓库与 GitLab 权限、CI secrets 所有权（签名钥 `c469…`/GITLAB_TOKEN）、fleet 升级纪律（门禁是机械的，「fleet 是否真升级了」是人的判断）。
