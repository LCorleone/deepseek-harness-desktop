# 企业网络环境自注入——给沙箱 shell 的代理与 CA bundle

[English](2026-09-05-corporate-network-env.md)

状态：**已实现**（分支 `corporate-network-env`，基于 `d6c989ae87` 的提交链）。本 note 记录用户真机上诊断出的公司网络模型、不改 runtime 修复沙箱 shell HTTPS 的自注入设计、维护点、以及这一近似方案的诚实边界。

## 公司网络模型（2026-09-05 诊断）

公司网络对出站 HTTPS 强制**两道关卡**：

1. **强制代理**——直连 TCP 443 能完成 TCP 握手，但 TLS 会话永远协商不起来（中间盒掐断）；只有走公司代理的流量能出网。代理配置可能经 PAC 下发，而非固定主机。
2. **TLS 检查**——代理用公司检查 CA 重签证书。不信任该 CA 的客户端即便代理用对了也会握手失败。

谁过哪道关：

| 角色 | 代理关 | 信任关 | 原因 |
|---|---|---|---|
| 浏览器 / Electron 的 Chromium（`net.fetch`、agent browser） | ✅ | ✅ | 走**系统代理解析器**（WinINET/WinHTTP，含 PAC）与**系统证书库**——两关都是 OS 服务 |
| PowerShell `Invoke-WebRequest` | ✅ | ✅ | 同样走这两个 OS 服务（.NET 遵循系统代理+系统库） |
| 桌面插件（host 进程 `fetch`） | ✅ | ✅ | 同——跑在已过两关的 Electron/Node host 里 |
| 沙箱 shell：`curl`（git 版）、OpenSSL 系工具 | ❌ | ❌ | 只认代理 **env 变量**，校验用**随包 CA 文件**——两个 OS 服务都不用 |
| 沙箱 shell：捆绑 Node 的 `fetch`（undici） | ❌ | ❌ | 默认无代理 env；校验用**编译内置 Mozilla 根** |

用户真机症状（DNS 通、ping 通、TCP/443 通、所有 HTTPS「underlying connection closed」）正是这个组合：TCP 可达、TLS 被掐——因为 shell 子进程**两关全不过**。「浏览器行」「PowerShell 行」是红鲱鱼：它们根本不面对 shell 子进程面对的关卡。

## 修法：Electron 主进程自注入

`src/corporate-network-env.ts`（desktop 插件）用 OS 解析同样两个事实并返回为**普通 env 键值**；`src/main.ts` 在 `app.whenReady()` 之后、**任何子进程 spawn 之前**（早于 pnpm runtime 安装、Host boot、profile 物化）合并进 `process.env`：

```
resolveCorporateNetworkEnv(app)
├── 代理：  session.defaultSession.resolveProxy('https://registry.npmjs.org/')
│           → Chromium 经系统解析器回答（含 PAC）
│           → "PROXY host:port;PROXY …;DIRECT" → 取首个指令 → http(s)://host:port
└── CA：    spawn PowerShell（主进程直启，非沙箱）
            → 导出 Cert:\LocalMachine\Root + Cert:\CurrentUser\Root + Cert:\LocalMachine\CA
            → 按 thumbprint 去重，PEM（每证书 base64 DER）
            → <userData>/corporate-ca-bundle.pem（每次启动经临时文件+改名重导出）
```

### 注入键集（终稿）

| 键 | 值 | 条件 |
|---|---|---|
| `HTTPS_PROXY` / `HTTP_PROXY` | 解析出的代理 URL，如 `http://10.172.64.36:80` | 检测到代理（取首个指令；`DIRECT` → 不注入） |
| `NO_PROXY` | 内网绕行清单（见下） | 检测到代理 |
| `NODE_USE_ENV_PROXY` | `1` | 检测到代理**且** URL scheme 为 http/https（见边界） |
| `NODE_EXTRA_CA_CERTS` | `<userData>/corporate-ca-bundle.pem` | bundle 导出成功且非空 |
| `SSL_CERT_FILE` | 同一路径 | 同上 |
| `CURL_CA_BUNDLE` | 同一路径 | 同上 |

`NODE_EXTRA_CA_CERTS` 是**追加**（Node 保留内置根再加 bundle）；`SSL_CERT_FILE` 与 `CURL_CA_BUNDLE` 对 OpenSSL/curl 消费者是**替换**——这里恰好正确：导出的 Windows 证书库本来就含公共根 + 公司检查 CA。

`NODE_USE_ENV_PROXY=1` 让代理变量对捆绑 Node 运行时真正生效：undici 的
`fetch` **只在**该 flag 被设置时才读 `HTTP(S)_PROXY`/`NO_PROXY`（支持落地于
Node v22.21.0 与 v24.0.0；捆绑运行时为 v22.23.2，已内置，每个沙箱 `node`
子进程都能用上）。该 flag 只随 `http://`/`https://` 代理 URL 注入——Node 的
环境代理不认 socks scheme，SOCKS 解析结果仍会为 curl/git/npm 注入代理变量，
但以一条日志代替该 flag（见边界）。

### 为什么写进 `process.env` 能到沙箱

继承链，逐环已验证：

```
Electron 主进程 process.env
  └─（Host 进程内 boot；所有 spawn 传 process.env 或默认继承）
runtime / Host 进程
  └─（dsh-subprocess childEnv = scrubbedParentEnv() + 调用方覆盖）
沙箱 pwsh / curl / node 子进程
```

唯一可能丢名字的环节是 `scrubbedParentEnv()`（`@deepseek-ai/dsh-subprocess`）：
它只删凭证形状的名字（`KEY|PASSWORD|SECRET|TOKEN`，大小写不敏感）和所有
`DSH_*` 名字。八个注入名**构造上全部幸存**——**零 runtime 改动**（本次工作的硬边界）。

### 失败语义——条条路径都能启动

- 非 win32 → `{}`；不探测、不 spawn（macOS 开发与 CI 完全不变）。
- Windows 未检测到代理（`DIRECT`）→ 只注入 CA 键。
- CA 导出失败（无 PowerShell、非零退出、超时 10 s、证书库为空）→ 只注代理键；一条 `logError`；**上一次启动留下的旧 bundle 刻意不信任**（只有本次导出成功才证明本次证书库）。
- 接线处任何意外异常 → `main.ts` 捕获，一条 `logError`，裸启动——行为与今天非公司机器完全一致。

## 维护点：内网绕行清单

`src/corporate-network-env.ts` 的 `INTRANET_NO_PROXY_ENTRIES` 是内网域名演进时的唯一改动点。当前内容：环回、RFC1918 网段、公司域名、已知主机（`gitlab.s.dai.deloitte.cn`、`sdp.deloitre.com.cn`、`ai.deloitre.com.cn`）。

每个通配域名拼三种写法（`*.deloitte.cn`、`deloitte.cn`、`.deloitte.cn`），因为 NO_PROXY 消费者各执一词：libcurl 对裸域名做后缀匹配、IP 段认 CIDR；Go 的 httpproxy 与 npm 认 `*.` 前缀；undici 的环境代理 agent 认前导点。多余拼写会被不需要它的消费者忽略。

## 排障：公司机器上 shell HTTPS 挂了

1. **查注入行**：桌面启动日志里的 `corporate network environment injected (HTTPS_PROXY, …)`——Windows 上若没有，说明网络解析为 DIRECT 或各步降级（看配套的 `logError` 行）。
2. **在沙箱 shell 里查三个事实**：
   `Get-ChildItem Env: | Where-Object Name -match 'PROXY|CA_CERTS|SSL_CERT_FILE|CURL_CA_BUNDLE'`
   ——键都在即链路保住了。
3. **查 bundle**：`<userData>/corporate-ca-bundle.pem` 必须存在且非空（几百 KB 的 `BEGIN CERTIFICATE` 块）；缺失则找 `corporate CA export failed: …` 日志行看原因（无 PowerShell、非零退出、超时）。
4. **隔离关卡**：`curl.exe -v https://registry.npmjs.org/`——代理 CONNECT 成功但报证书错误=只挂信任关（CA）；CONNECT 中「connection closed」=代理可达性或检查中间盒。

## 诚实边界

- **PAC 网络下静态 env 是近似。** Chromium 只对**一个**探测 URL（`registry.npmjs.org`）回答代理问题。PAC 若对其他目标路由不同、或在多个代理间故障转移，`HTTPS_PROXY` 表达不了；只注入解析结果的**首个**指令。对观测到的网络（单一代理承载全部出站）这是精确的。
- **绕行清单要随内网演进。** 不在 `NO_PROXY` 上的内网主机会被推给公司代理并通常死在那里；修法是 `INTRANET_NO_PROXY_ENTRIES` 加一行。
- **NO_PROXY 通配语义因消费者而异**——所以三重拼写；若有第四种方言的工具仍可能不匹配。
- **bundle 新鲜度按启动计。** bundle 每次启动重写；会话中途下发的新证书要等下次桌面重启生效。长会话持有启动时的信任集。
- **bundle 篡改面：同用户=已接受。** bundle 在用户可写的 `userData` 里存留整个会话；同用户进程可在导出后换掉它，此后每个沙箱子进程都会经 `SSL_CERT_FILE`/`CURL_CA_BUNDLE`（替换语义）信任攻击者的 CA。`userData` 有按用户 ACL，且同用户攻击者本就拥有本应用（PATH、配置、DLL 预置），故这是已接受的风险而非权限越界。导出先写同目录 `.tmp` 再改名到位，子进程不会观察到写一半的 bundle，导出失败时上一次的文件原样保留；stat→注入之间的替换窗口收窄到改名本身。
- **SOCKS-only 网络下沙箱 Node `fetch` 仍走直连。** socks 解析时不注入 `NODE_USE_ENV_PROXY`，因为 Node 的环境代理（undici）不支持任何 socks scheme；沙箱 `curl`/`git`/`pnpm` 仍会走 socks 代理，并有一条日志记录该保留。这不是回归——检查网络下直连 TLS 本就会被中间盒掐断。
- **curl 小写 nuances**：curl 对明文 HTTP 代理只读小写 `http_proxy`；Windows OS 环境本身大小写不敏感，注入的大写对 Windows 查询可解析，但忽略 `HTTP_PROXY` 大写的、大小写敏感的 curl 移植版需要补小写拼写。
- **范围**：不改变 Electron/Chromium 网络栈本身（它本就用 OS 服务），不改沙箱策略，不动 runtime 仓库。
