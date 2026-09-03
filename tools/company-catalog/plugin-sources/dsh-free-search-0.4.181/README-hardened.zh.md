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
| 本包版本 | `0.4.181` = 上游 `0.4.18` + 公司构建 1。tarball 通道的清单只签稳定 semver（`STABLE_VERSION_PATTERN`，禁止 prerelease/build 元数据——任务原文的 `0.4.18-company.1` 拼法会被 allowlist 校验与 pack 器双重拒绝），因此用第 4 位补丁号编码「同源剥离版」：后续公司构建依次 0.4.182…；该号段高于上游全部已发布 0.4.x，永不与 npm 上的字节混淆。 |
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

对 `lib/*.js` 做 URL 全量收集，允许的外联恰好等于链内四引擎端点：
`api.tavily.com`、`api.exa.ai`、`www.bing.com`、`html.duckduckgo.com`。
被剥离的外联面：npm registry（版本探测，见 a）、AnySearch / SearXNG 公共
实例列表 / Keenable REST+MCP / Perplexity / DeepSeek 官方 API（引擎收敛，
见下）、exa 与 tavily 的 keyless 匿名端点（`mcp.exa.ai`、
`x-tavily-access-mode` 头）、platform_search 的八个平台 API（github / v2ex
/ bilibili / reddit / hn / stackexchange / wikipedia / npm——不在评审源口径
内，整体剥除，`platform_search` 工具与 `platforms` 设置随之删除）。无统计
上报、无 CDN 引用（上游本就没有，已核对）。

## 引擎链（公司源口径，2026-09-03 定案）

```
tavily（配 key 才入链）→ exa（配 key 才入链）→ bing 直连 → ddg 兜底
```

- 实现：`lib/engines.js`（纯逻辑、无 DSH 依赖、无网络），`resolveEngineChain`
  按 key 有无生成链，`runEngineChain` 串行走链。零 key 时链 = `bing → ddg`
  （开箱即用）；公司 Tavily/Exa key 后续在设置节插入即自动升链。
- key 经插件自身设置节配置（v0.4.18 `installSettingsSection`，命名空间
  `free-search`，`tavilyApiKey`/`exaApiKey` 带 `role("secret")` 脱敏），或
  `TAVILY_API_KEY`/`EXA_API_KEY` 环境变量回退。明文只存在运行时内存与本机
  settings.yaml；打包产物（`files` 白名单：lib/index.js、lib/client.js、
  lib/engines.js、cordis.patch.yml）不含任何 key 物料。
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
  （`searchProvider: ddg`）——对 base 层零损失，不触碰 `web-runtime`/
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

- 源码目录落位 `tools/company-catalog/plugin-sources/dsh-free-search-0.4.181/`
  ——`--from-allowlist` 的 workflow 约定是
  `<sources-root>/<tarball-stem>/`（stem = `dsh-free-search-0.4.181`），
  目录名即按此命名，CI 打包零管线改动。（任务原文写的
  `plugins/dsh-free-search/` 与该约定不兼容：workflow 在
  `plugin-sources/<stem>/` 找不到源会直接失败。）
- 产物 `tools/company-catalog/out/packages/dsh-free-search-0.4.181.tgz` +
  同名 `.pack.json`（sha512 / treeDigest / signable path）。
- allowlist 条目（`tools/company-catalog/allowlist.json`）用
  `source:{kind:'tarball', url, path}` pack-artifact 形态，
  `repository` 显式钉上游，url 指向真实源
  `https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/packages/`
  （与 `desktop-policy.release.json` 的 `companyCatalogOrigin` 一致；测试对拍
  两文件，防示例域再混入）。**未携带 `treeDigest`**——首发权威发布时落值：
  参考环境（Windows fleet 矩阵）实测后按流程评审落值；本仓 Linux 环境测出的
  digest 不作为评审值入库。
- 真发布仍按 fleet 门禁顺序：全员升级 field-aware 构建 → 参考环境实测
  treeDigest → 评审落值 → 更高 sequence 重签 → publish-local 推 GitLab。

## 留存与后续

- 上游 LICENSE 与署名原样保留（MIT）。
- 后续升级上游新版的口径：等 harness 升到含 `installSection` 的版本后再
  评估，收编时以本文清单为准逐项重验。
