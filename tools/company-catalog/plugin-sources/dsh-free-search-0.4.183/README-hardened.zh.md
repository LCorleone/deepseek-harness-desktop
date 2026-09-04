# dsh-free-search 收编记录（hardened 形态 · tarball 通道）

P7 首个上架插件：上游社区插件 `dsh-free-search` 的公司加固收编版。本文是
剥离清单与改造说明的权威记录；打包、签名、分发走公司目录 tarball 通道
（`tools/company-catalog`，见该目录 README 的「Install channels」）。

## 溯源

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/DDDMUC/dsh-free-search |
| 钉住版本 | **v0.4.18**（tag commit `36c6446211cd2a759cf59de87a1ba6a893c34ebd`） |
| 为什么钉 0.4.18 | v0.4.19+ 改用 0.1.2-alpha.2 的 `sctx.settings.installSection` API；我们钉住的 harness `0.1.1-rc.2` 没有该 API，装上即崩。v0.4.18 用导出函数 `installSettingsSection`（rc.2 的 `@deepseek-ai/dsh-settings` 里有，已核对源码），兼容。 |
| 本包版本 | 当前 `0.4.183` = 上游 `0.4.18` + 公司构建 3（构建 1 = `0.4.181`，因包内 `dsh.bundle.patch` 前缀失配真机装机全败而作废；构建 2 = `0.4.182`，首次真机装机成功，后因引擎链改版被取代——均见下方「版本推进记录」）。tarball 通道的清单只签稳定 semver（`STABLE_VERSION_PATTERN`，禁止 prerelease/build 元数据——任务原文的 `0.4.18-company.1` 拼法会被 allowlist 校验与 pack 器双重拒绝），因此用第 4 位补丁号编码「同源剥离版」：后续公司构建依次 0.4.182、0.4.183…；该号段高于上游全部已发布 0.4.x，永不与 npm 上的字节混淆。 |
| 上游 README | 原样保留于 `docs/README-upstream.md`（不进打包产物，`files` 白名单不含 docs/）。 |

## 剥离清单（红线，逐项验证）

### a. 自更新旁路（更新只走公司市场）

上游位置：`lib/index.js`（v0.4.18）`fetchLatestVersion` / `compareVersions`
/ `detectInstallMode` / bridge handlers `checkUpdate` + `updatePlugin` /
`exec("pnpm add dsh-free-search@latest")`（约 1155 行）与常量
`NPM_REGISTRY_URL` / `PLUGIN_NPM_URL`；`lib/client.js` 的「检查更新 / 升级」
按钮与 `bridgeCheckUpdate` / `runUpdate`。全部删除：加固版没有版本探测、
没有一键升级、没有对 registry.npmjs.org 的任何请求。测试断言：vendored 树
内无 `pnpm add`、无 `child_process`、无 `npmjs.com`、无 `check-update`/`/update`
路由。客户端 I18N 键集随之收窄为「仍被引用的键」：曾因收窄误删仍被脏状态
指示器引用的 `unsaved`（zh `未保存` / en `unsaved`，渲染 undefined）——
已修复回补，并有断言钉住 client.js 引用的全部 `t.<key>` 在两语言字典
均存在，防再丢。

### b. tools/ 旁路（本地 4789 HTTP server 直写 profile patch）

上游 `tools/` 目录整体不收编：`server.mjs`（127.0.0.1:4789 的引擎切换
HTTP server，直接读写 `~/.dsh/profiles/web/cordis.patch.yml`）、
`switch-engine.html` / `switch-engine.ps1`、两个 `启动*.cmd`。测试断言：
vendored 树无 `tools/` 目录、无 `.cmd`/`.ps1`、无 `4789`、lib/ 内无
`node:fs`/`node:path`/`node:child_process` 导入（服务端插件不再有任何
直写文件路径的能力）。

### c. 遥测 / 外联收敛

对 `lib/*.js` 做 URL 全量收集，允许的外联恰好等于链内三引擎端点：
`api.tavily.com`、`api.exa.ai`、`api.anysearch.com`。被剥离的外联面：npm registry
（版本探测，见 a）、SearXNG 公共实例列表 / Keenable REST+MCP / Perplexity /
DeepSeek 官方 API（引擎收敛，见下）、exa 与 tavily 的 keyless 匿名端点
（`mcp.exa.ai`、`x-tavily-access-mode` 头）、platform_search 的八个平台 API
（github / v2ex / bilibili / reddit / hn / stackexchange / wikipedia / npm——不在
评审源口径内，整体剥除，`platform_search` 工具与 `platforms` 设置随之删除）。
bing（`www.bing.com` HTML 抓取）与 ddg（`html.duckduckgo.com` HTML 抓取）在
0.4.183 随三键制改版整体移除（见版本推进记录）。注：AnySearch 在 0.4.181/
0.4.182 收编时随上游十引擎面剥离，0.4.183 以 keyed REST 形态重新入链
（公司集成，非上游原样收编）。无统计上报、无 CDN 引用（上游本就没有，
已核对）。

## 引擎链（公司源口径，2026-09-05 三键制定案）

```
tavily（配 key 才入链）→ exa（配 key 才入链）→ anysearch（配 key 才入链）
```

- **纯三键制**：三个引擎全部「配 key 才入链」，没有免费兜底引擎。0.4.183
  移除了 bing（HTML 直抓）与 ddg（HTML 直抓）两个免费引擎（决策与理由见
  下方版本推进记录）。
- **无 key 引导而非静默空链**：一个 key 都没配时，`search` 不跑空链、不报
  空失败，而是返回配置引导文案（三个引擎的免费额度、注册入口与配置位
  置：设置节或对应环境变量），agent 可直接转述给用户完成自注册。
- 实现：`lib/engines.js`（纯逻辑、无 DSH 依赖、无网络），`resolveEngineChain`
  按 key 有无生成链（无 key → 空链），`runEngineChain` 串行走链（进入每
  引擎前预检外部 signal 已取消——fetchHtml 移除后，评审 P3 预检上移到链
  执行器，对全部引擎生效）。
- AnySearch 集成（公司新增，非上游原样）：`POST
  https://api.anysearch.com/v1/search`，`Authorization: Bearer <key>`，JSON
  体 `{query, max_results}`（最小请求面，domain/zone 等可选参数不收编）；
  响应 `code===0` → `data.results[]`（title/url/snippet 实测形态，另备
  content 字段兼容）；`code!==0` → 可读错误。时间过滤不支持（忽略）。
- key 经插件自身设置节配置（v0.4.18 `installSettingsSection`，命名空间
  `free-search`，`tavilyApiKey`/`exaApiKey`/`anysearchApiKey` 带
  `role("secret")` 脱敏），或 `TAVILY_API_KEY`/`EXA_API_KEY`/
  `ANYSEARCH_API_KEY` 环境变量回退。明文只存在运行时内存与本机
  settings.yaml；打包产物（`files` 白名单：lib/index.js、lib/client.js、
  lib/engines.js、cordis.patch.yml）不含任何 key 物料。**key 政策 = 用户
  自注册免费额度**（2026-09-05 用户拍板）：客户端持有必可提取，公司不代
  理持钥、不随插件分发；三引擎免费额度：Tavily 1,000 次/月、Exa 注册送
  $20+每月 $10（约 1,400 次/月）、AnySearch 1,000 次/天，链天然支持混配。
- 上游的「首选引擎」（`provider` 设置、`advanced_search` 的 `engine` 强制
  参数、设置页引擎下拉、`/free-search-engine` 弹出命令）整体剥离：链序是
  公司口径，不是用户偏好。
- 容错红线（社区 Discussion #1884 防御实践）：`runEngineChain` 对每个引擎
  调用 try/catch 包住、失败（含 0 结果）降级下一引擎、全链失败**返回可读
  文本**（`content` 说明各引擎失败原因，指引 agent 告知用户暂不可用），
  绝不向调用方抛顶层异常——单进程 harness 不因搜索链抖动而崩。
- 上游凭据中心集成（`ctx.get("credentials")`、`KEY_REF_MAP`、
  credentials-status/set/unset 桥、`keyStorage` 设置与客户端 UI）整体剥
  离：未 inject 的服务在 Cordis proxy 上 get 即抛（`?.` 救不了），加固版
  的服务端代码不再有任何 `ctx.get` 访问。

## 与官方 web 插件共存（cordis.patch 排布）

上游 patch 整行替换 `web` 行 config 抢占 searchProvider（还带
`fetchProvider: http`）。核对钉住 harness 后改为最小共存 patch：

- 官方 base bundle 的 `web` 行 config **只有一个键**
  （`searchProvider: deepseek-official`，见钉住子模块
  `packages/bundle/base/cordis.patch.yml`）；
- patch 语义是整行替换 config，因此加固 patch 以同样的单键形态重述该行
  （`searchProvider: free-search`，0.4.183 起；0.4.182 及以前为 `ddg`——
  引擎移除后旧 id 失去指称，改为中性的插件名 id，一处定义于
  lib/index.js 的 `PROVIDER_ID`，与 patch 值保持一致）——对 base 层零损
  失，不触碰 `web-runtime`/
  `webserver`/desktop 层任何行，官方 web 插件的 seam、web_fetch 工具面与
  其余行为不变；卸载即还原官方默认；
- 插件运行时保留上游的让位兜底：`web.searchProviderId` 未指向任何
  provider 时才接管，显式配置了其他 provider 则不动。

撞名防御：设置节命名空间 `free-search` 与客户端插槽 key 不与任何官方
section 冲突；注册工具统一 `free_search_` 前缀（上游的
`advanced_search`→`free_search_advanced`，`platform_search` 删除，
`free_search_test` 保持）。

## Discussion #1884 防御清单逐条对照

1. **inject 一维字符串数组** — 服务端 `inject = ["web"]`，客户端
   `inject = ["slots"]`，package.json `dsh.client.inject =
   ["@deepseek-ai/dsh-client-runtime"]`，均为一维字符串数组。✓
2. **未 inject 服务 get 即抛** — 唯一的 `ctx.get` 访问（credentials）已随
   凭据中心集成整体剥离；现有代码只用 `ctx.inject([...], …)` 声明式注入
   webServer/settings/tools/systemPrompt。✓
3. **parameters 完整 JSON Schema** — 两个工具都经 `defineTool`
   （ParameterSchemaSpec per-property map）；已核对钉住 0.1.1-rc.2 的
   `dsh-tools`：`parameterSchemaSpecToJsonSchema` 把 map 投影为顶层
   `type:'object'` 的完整 JSON Schema 后才进注册面，裸 map 不会到达
   provider。`output.schema` 本就是完整 schema。✓
4. **引擎链不抛顶层** — `runEngineChain` 全包 try/catch、逐级降级、全败
   返回可读文本（见上），离线单测覆盖「每引擎都抛仍 resolve 不 reject」。✓
5. **撞名防御** — 见上节。✓
6. **零原生依赖** — dependencies 仅 `@deepseek-ai/schemastery`（纯 JS），
   与上游一致；无 sharp/node-pty 类。✓
7. **无构建脚本** — package.json 无 `scripts` 键，纯 JS 无 prepare；
   pnpm ≥10 构建拦截不适用，也不需要 `approvedBuilds`。✓

## 打包与上架（本地验证形态）

```sh
corepack yarn catalog pack-tarball \
  --from-allowlist \
  --catalog-origin https://gitlab.s.dai.deloitte.cn   # 或 COMPANY_CATALOG_ORIGIN
```

- 源码目录落位 `tools/company-catalog/plugin-sources/dsh-free-search-0.4.183/`
  ——`--from-allowlist` 的 workflow 约定是
  `<sources-root>/<tarball-stem>/`（stem = `dsh-free-search-0.4.183`），
  目录名即按此命名，CI 打包零管线改动。（任务原文写的
  `plugins/dsh-free-search/` 与该约定不兼容：workflow 在
  `plugin-sources/<stem>/` 找不到源会直接失败。）
- 产物 `tools/company-catalog/out/packages/dsh-free-search-0.4.183.tgz` +
  同名 `.pack.json`（sha512 / treeDigest / signable path）。
- allowlist 条目（`tools/company-catalog/allowlist.json`）用
  `source:{kind:'tarball', url, path}` pack-artifact 形态，
  `repository` 显式钉上游，url 指向真实源
  `https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/packages/`
  （与 `desktop-policy.release.json` 的 `companyCatalogOrigin` 一致；测试对拍
  两文件，防示例域再混入）。**未携带 `treeDigest`**（0.4.183 现行形态：
  与 0.4.182 首发时同口径——参考环境（Windows runner 的 digest 产出）实测
  后按流程评审落值；本仓 Linux 环境测出的 digest 不作为评审值入库。
  0.4.182 曾评审入 Windows 实测值 adce37b4…（双平台对拍一致），随该条目
  被 0.4.183 取代一并移除；0.4.181 的实测值同此前惯例随作废移除。
- 真发布仍按 fleet 门禁顺序：全员升级 field-aware 构建 → 参考环境实测
  treeDigest → 评审落值 → 更高 sequence 重签 → publish-local 推 GitLab。

## 版本推进记录（0.4.181 → 0.4.182）

0.4.181 是首次收编形态，**从未在任何真机装机成功**，根因是 bundle patch
声明前缀失配：

- 包内 `package.json` 的 `dsh.bundle.patch` 沿用上游原样声明
  `"cordis.patch.yml"`（无 `./` 前缀）；allowlist/签名条目的
  `bundlePatch` 则是生态惯例拼写 `"./cordis.patch.yml"`（better-sidebar
  同形态）。
- 桌面市场安装的装机后断言链（`dsh-community-market`
  `src/install/service.ts` 的 `assertInstalledBundleFromSnapshot`）要求包内
  声明与签名条目**严格相等**；`safeBundlePatch` 校验时会把可选的 `./`
  前缀归一化——两种拼写各自合法，但永远不相等，于是每台真机都在装机后
  断言处以 `bundle patch missing` 失败并回滚。
- 更糟的是该失败当时被安装编排的裸 `catch {}` 吞掉真实原因，只报通用的
  「plugin bundle was invalid」，导致盲排。两处均已修复：断言消息现在
  内联两侧拼写值，回滚分支把底层原因并入拒因文本。

0.4.182 的变化（内容变了，托管不可变规则要求新版本号）：

1. 包内声明对齐生态惯例：`dsh.bundle.patch` → `"./cordis.patch.yml"`
   （`safeBundlePatch` 不强制前缀，两种写法均合法；选择包侧对齐，与
   better-sidebar 及仓库全部 fixture/测试一致）。
2. 版本号 0.4.181 → 0.4.182：目录名、`package.json`、allowlist 条目的
   `version`/`source.path`/`source.url` 末段同步。0.4.181 条目从 allowlist
   删除（从未装机成功，无需 revoked 记录）；其 Windows 实测 treeDigest
   随条目移除，0.4.182 的 treeDigest 留空，待发布时参考环境实测评审落值。
3. 防再犯：管线在 `pack-tarball --from-allowlist` 与构建（`build`/
   `measure-and-publish`）两处新增对拍断言——打包/签包前读包内
   `dsh.bundle.patch`，与 allowlist 条目 `bundlePatch` 严格相等才允许出制品，
   不等即报错指出两侧拼写值。

## 版本推进记录（0.4.182 → 0.4.183，三键制改版）

0.4.182 是首个真机装机成功的形态（sequence 12 上线），但运营一周后免费链
实际不可用，用户拍板改版（2026-09-05）：

- **决策**：引擎链改为**纯三键制** `tavily → exa → anysearch`，三个引擎全
  部「配 key 才入链」；**删除 bing 与 ddg 两个免费抓取引擎**（用户拍板：
  不要免费抓取源）。
- **理由**：bing HTML 直抓质量差（「这一周上海天气」实测不可用），ddg 被
  公司网络封禁（真机全不可达）——零 key 的「开箱即用」链实际是零 key 的
  「开箱即坏」。免费兜底候选实测三连（百度=验证码拦死、搜狗=反爬墙、
  360=可用但需限速与跳转处理）后，用户选择不收编任何免费抓取源；搜索源
  口径定为**用户自注册免费额度**（客户端持有必可提取，公司不代理持钥），
  三引擎免费额度足够日常：Tavily 1,000 次/月、Exa 注册送 $20+每月 $10、
  AnySearch 1,000 次/天，链天然支持混配。
- **无 key 行为变更**：一个 key 都没配时，`search` 返回配置引导文案（免费
  额度、注册入口、配置位置：设置节或环境变量），不再静默跑空链/免费链。
  系统提示词、设置卡（三 key 输入 + 注册指引卡）同步。
- **新增 AnySearch 引擎**（公司集成，非上游原样）：keyed REST，`POST
  /v1/search`、Bearer、`{query, max_results}` 最小请求面；`code===0` 解析
  `data.results[]`，`code!==0` 可读错误；设置键 `anysearchApiKey` +
  `ANYSEARCH_API_KEY` 环境回退（与既有两键同 `resolveApiKey` 路径）。
- **随 bing/ddg 一并移除**：fetchHtml/fetchHtmlWithRetry 抓取路径与 UA/
  语言头、`safeSearch`/`region`/`bingMarket` 设置（设置卡同删）、DDG/Bing
  的 URL 常量与解析器；`searchBing`/`searchDdgHtml` 导出面消失（测试 grep
  断言钉死：包内无 `BING_URL`/`DDG_HTML_URL`）。fetchHtml 移除后，「进入
  时 signal 已取消」预检（评审 P3）上移到 `runEngineChain` 链执行器。
- **provider 基 id 更换**：`ddg`（引擎已删，id 失去指称）→ 中性
  `free-search`，一处定义（lib/index.js `PROVIDER_ID`），cordis.patch.yml
  的 `searchProvider` 重定向值同步；升级 0.4.183 时 base 层官方默认
  `deepseek-official` 的让位/接管规则不变。
- **版本号 0.4.182 → 0.4.183**：目录名、`package.json`（含 keywords 去
  duckduckgo/bing、增 anysearch）、allowlist 条目的 `version`/
  `source.path`/`source.url` 末段同步。0.4.182 条目从 allowlist 删除
  （已被真机 fleet 安装，由更高 sequence 的 0.4.183 覆盖更新，无需 revoked
  ——吊销是恶意/ compromised 场景，不是版本演进）；其 treeDigest 随条目
  移除，0.4.183 留空待参考环境实测评审落值。发布顺序照旧：digest
  workflow（Windows）实测 → 评审落值 → sequence 13 重签 → publish-local
  推 GitLab。

## 留存与后续

- 上游 LICENSE 与署名原样保留（MIT）。
- 后续升级上游新版的口径：等 harness 升到含 `installSection` 的版本后再
  评估，收编时以本文清单为准逐项重验。
