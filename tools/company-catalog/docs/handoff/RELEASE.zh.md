# 目录发布 Runbook（统一权威版）

[English](RELEASE.md)

> 2026-09-12 起本页是公司目录发布的**唯一操作权威**：环境前置、四条日常链、
> 门禁语义、发布后观察、演练与纠错都在这一份里（原「发布速查」已并入并升级）。
> 分工（不重复，只链接）：
> - 流程权威与人审判断标准 = 同目录 **SOP.zh.md**；
> - MR session 冷启动直抄版 = 同目录 **MR-HANDLING.zh.md**；
> - 管线内部机理与字段语义 = **tools/company-catalog/README.md**；
> - 信任模型与红线全图 = `.agents/notes/implemented/process/2026-09-04-company-market-owner-handover.zh.md`。
>
> 所有命令在桌面仓根目录跑。共同事实（每次发布都成立）：
> - 签名私钥只在 GitHub Secrets（CI 侧）——**本地永远不持钥**，本地跑不了的
>   签名步骤一律走 CI；
> - CI 只签名上传产物，**绝不碰内网 GitLab**——推送永远发生在你本机
>   publish-local（不推 = 谁也看不到）；
> - stable 与 beta 两份清单共享一个单调 sequence 棘轮；beta 序号高于 stable
>   是合法稳态（beta ⊇ stable 且序号 ≥ stable）。

## 0. 前置：发布机环境

### 0.1 机器与权限（一次性确认）

| 项 | 要求 |
| --- | --- |
| 网络 | 同机可达 GitHub（gh API + artifact 下载）与内网 GitLab `gitlab.s.dai.deloitte.cn` |
| 仓库 | 桌面仓（GitHub `LCorleone/deepseek-harness-desktop`）master 克隆 + push 权，工作树干净 |
| GitHub 侧 | `gh` 已 `gh auth login`：可 dispatch workflow、读 run/artifact |
| GitLab 侧 | `julu/dsh-desktop-config` 的 PAT：**仅此一仓写权限、无 API scope**（清单只走 git push；网页编辑器会破坏验签字节） |
| 签名钥 | 不在本机——CI Secrets 持有（SIGNING_KEY / KEY_ID / 可选 FINGERPRINT，见 owner 指南 §7） |

### 0.2 企业 CA bundle（内网 GitLab 走 TLS 检查）

发布机上的 Node（fetch）与 git 不认公司检查 CA。一次性提取——从服务端证书链
取 CA 证书、丢弃叶证书：

```bash
openssl s_client -connect gitlab.s.dai.deloitte.cn:443 -servername gitlab.s.dai.deloitte.cn -showcerts </dev/null 2>/dev/null \
| python3 -c "import sys,re; b=re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',sys.stdin.read(),re.S); print('\n'.join(b[1:]))" \
> .deloitte-ca-bundle.pem
```

- 产物在仓库根 `.deloitte-ca-bundle.pem`（2026-09-12 实况 = 3 张 Deloitte SHA2
  CA），已被 `.gitignore` 钉住——**绝不提交**；
- 之后每条 publish-local 命令前缀 `NODE_EXTRA_CA_CERTS=.deloitte-ca-bundle.pem`
  （追加语义：Node 保留内置根再加公司 CA；**只配置 Node 的 fetch**）；
- ⚠ git 传输不吃这个变量：publish-local 内部 spawn 的真 `git` 需要**本机 git 自身信任公司 CA**
  （Windows schannel 后端通常已信任；OpenSSL 后端的 git 需另配
  `git config --global http.sslCAInfo .deloitte-ca-bundle.pem` 或环境变量
  `GIT_SSL_CAINFO`，否则 clone/push 阶段 TLS 失败）。症状区分：fetch 阶段报
  `fetch failed` 是 Node 侧；git 阶段报 SSL 证书错误是 git 侧；
- 公司证书轮换后的症状 = TLS 握手失败 / `fetch failed`——重跑上面一行刷新
  bundle 即可；
- 应急替代：`--insecure-tls`（等价 `NODE_TLS_REJECT_UNAUTHORIZED=0`；信任由
  验签承担）——能用 CA bundle 就别用它，publish-local 自己也会这么警告。

### 0.3 凭据纪律

- `GITLAB_TOKEN` 从凭据存放处（所有者经公司凭据管理渠道交付）取，**仅当次
  shell 环境变量**，用完即弃；env 优先于 `--token`（后者暴露在 argv / 进程
  列表）；
- 永不写进 commit、文件、dev-log、MR 评论；
- staging 仓（`http://10.173.59.30:9080/pluginpuller/dsh-desktop-plugins`）的
  token 是**另一张**（scope=api），同样只在当次命令环境变量用。

### 0.4 每次发布前 30 秒

```bash
git pull && git status --short      # 干净、不落后
cat tools/company-catalog/state/last-sequence.json   # 当前棘轮值
```

allowlist 待发条目逐项过一眼：version / channel / revoked / description。

## 1. 四条日常链

### 1.A 新版本受理（同事 MR → verify → accept → 发布就绪）

细节与冷启动上下文见 MR-HANDLING.zh.md（流程判断见 SOP ②–④）；这里是
命令序列：

```bash
# ① 拉 MR 分支到 staging 克隆（列 MR 的 curl 见 MR-HANDLING §1）
git -C <staging克隆> fetch origin 'merge-requests/<iid>/head:mr-<iid>'
git -C <staging克隆> checkout mr-<iid>

# ② 机器验证（十步闸门，分钟级）——回执必须落在本机
node tools/company-catalog/cli.mjs verify-handoff <staging克隆>/submissions/<名>-<版本> \
  --description "一句话中文"        # --description 2026-09-10 起必填（市场卡片）

# ③ 人审三点（verdict.md 审计节：注入面/网络域/依赖与脚本）→ July 拍板 merge MR

# ④ 受理落库（回执须本机 verify 产生；缺 repository 字段补 --repository，惯例见 SOP ④）
node tools/company-catalog/cli.mjs accept-handoff <同一提交目录> [--repository <url>]

# ⑤ 落 CI 打包源（容易漏的一步，见下）
mkdir -p tools/company-catalog/plugin-sources/<名>-<版本>
tar -xzf tools/company-catalog/out/packages/<名>-<版本>.tgz \
    -C tools/company-catalog/plugin-sources/<名>-<版本> --strip-components=1
git add tools/company-catalog/plugin-sources/<名>-<版本>

# ⑥ push（④的 allowlist commit + ⑤的 plugin-sources commit）→ 走 1.B 发 beta
```

**中间产物**：② 在提交目录写 `verdict.md` + `verdict.json`（机器回执），本机
`out/verdict-receipts/` 记录回执 sha256，tgz 备料到 `out/packages/`；④ 把条目
写进 allowlist 并**单独 commit**（`catalog: accept <名>@<版本> (staging handoff)`）；
⑤ 的目录就是 CI 重打包的源（消息惯例：`catalog: plugin-sources for <名>@<版本>
(accepted staging handoff — CI pack source)`）。

**为什么必须 ⑤**：CI 的 pack 步（`pack-tarball --from-allowlist`）从
`plugin-sources/<名>-<版本>/` 重打包；`out/` 是 gitignored，本机备料的 tgz 到
不了 runner——漏了这步 CI 干跑就红（2026-09-09 实坑）。

**fail-closed**：schema → sha256 → 安全解包 → 三方绑定 → compat，verify 与
accept 双闸一致；同版本不同字节一律拒（不可变红线）。accept 额外要求回执指纹
= 本机 verify 记录（换机受理先重跑 ②）。

**纠错**：accept 前发现问题——什么都没签名，丢弃即可；accept 后、发布前——
revert 两个 commit 即净；已发布——走 1.D revoke。

### 1.B 发布 stable / beta（CI 签名 → 内网推送 → 回读 → 棘轮 bump）

```bash
# ① 前置：allowlist 改动已 commit+push（受理链产物，或手工评审改动）

# ② CI 签名产物（默认 dry-run=true 只测签不上传；拿不准可先干跑一轮看 summary）
gh workflow run "Company catalog publish" --repo LCorleone/deepseek-harness-desktop \
  --ref master -f channel=<stable|beta> -f dry-run=false
gh run list --workflow "Company catalog publish" --repo LCorleone/deepseek-harness-desktop --limit 1   # 拿 run id
gh run watch    # 或 Actions 页等绿（Windows runner，约 3 分钟）

# ③ 内网推送（CI 永不碰 GitLab）
NODE_EXTRA_CA_CERTS=.deloitte-ca-bundle.pem GITLAB_TOKEN=<凭据> \
  node tools/company-catalog/publish-local.mjs --channel <stable|beta> --run <run-id>

# ④ 操作者回读复核（§3）——publish-local 自带 re-check，这步是独立确认

# ⑤ 棘轮 bump（publish-local 结尾的 follow-up 行会写明目标值）
#    tools/company-catalog/state/last-sequence.json → { "lastSequence": <N> }
git commit -am "catalog: ratchet last-sequence to <N> after the <channel> seq<N> publish (<事由>)" && git push
```

**中间产物**：② 产出 `company-catalog-signed` artifact（`catalog-manifest[.beta].json`
+ `publish-meta.json` + `packages/*.tgz`），并镜像到 `catalog-artifacts` 分支
`<run-id>/`（同款布局）；run summary 带 treeDigest 表。③ 逐行打印
`integrity: sha256 … matches publish-meta.json` → `ratchet: artifact sequence N =
deployed M + 1 ✓` → `signature: VERIFIED (… = fleet trust root)` →（门禁确认行，
见 §2）→ `push: catalog-manifest… → master` → `re-check: … exact pushed bytes …
deployment confirmed` → `publish complete:` 块。

**`--run` 语义**：省略时自动选最新一个可下载 `company-catalog-signed` 产物的
run（回退 = 最近成功 run，可能是 dry-run 无产物）——**显式 `--run` 更稳**。
gh artifact 下载超时的环境会自动回落 `catalog-artifacts` 分支（同 run-id），
也可显式 `--from-git <run-id>`（§4）。

**fail-closed**：任何一步红 = 零字节推送（所有门禁都带 "fail closed; nothing
was pushed"）。可选先 `--dry-run`：验证 + 棘轮对拍 + 打印 push plan，clone 前
停。

**纠错**：ratchet 拒发（stale artifact）= state 旧了 → 重跑 CI；推错清单 =
下一发更高 sequence 覆盖（棘轮不可回退，§5）；要移除条目走 1.D。

**跳号正常**：stable 可能从 13 直接跳 16（beta 消耗了 14/15）——共享棘轮设计
如此，publish-local 会打一行 `skips past deployed … legitimate`。beta 首推无
基线（404）时自动回落 stable 基线，无需动作。

### 1.C promote（beta 浸泡完 → stable 全员）

**先决两件事**：浸泡完成（≥2 个工作日或首个真实使用反馈）；**群预告**
「插件 X 升 Y，重启后请到市场更新」——版本升级 = 硬切换：promote 后旧版装机
下次启动被 boot 校验拒绝（清单只钉新版，无宽限期无自动更新）。

实践路径（无签名钥的操作机；2026-09-10 首次 stable promote 即此路径）：

```bash
# ① 摘 allowlist 旗标：删掉条目的 "channel": "beta"（评审 commit+push；
#    消息惯例：catalog: channel flags for … — <谁转正/谁留 beta>）
# ② 走 1.B channel=stable（同一 tgz 重打包 = 同字节同 digest，等价 promote 稳态）
#    ⚠ 条目首次带 source/treeDigest/description/approvedBuilds 上 stable →
#      --confirm-fleet-upgraded（§2）
# ③ 再走 1.B channel=beta 把 beta 清单重签推进（beta=超集，条目仍在，名单机器无感）
```

有签名钥的环境（CI / 密钥托管机）一条命令等价：

```bash
node tools/company-catalog/cli.mjs promote <名>@<版本>
```

——原字节并入 stable（零重验）、双清单重签（先 stable 后 beta，共享棘轮各占
一号）、allowlist 旗标自动翻转；已转正且字段相同 = 幂等 no-op（不耗 sequence）。

**语义（P15 多版本钉扎）**：promote = **加条目保留旧钉**——旧钉版留在 stable
清单，老客户端按 名@版本 精确 boot 照常命中，永不因发布而断；旧钉下窗必须走
1.D 的显式 retire。

**fail-closed / 纠错**：stable 发布被 package-removal guard 拦 = 浸泡窗口陷阱
（先 promote 该包，或真下架先 revoke，见 §2）；promote 只是清单侧动作，推错 =
更高 sequence 覆盖。

### 1.D revoke / retire（吊销与撤窗）

**revoke（吊销 = 状态不是删除；条目留签审计）**

```bash
# ① 吊销落 allowlist
node tools/company-catalog/cli.mjs revoke <名>[@<版本>]
#    本机无签名钥：allowlist 已标 revoked:true 后的重签步失败是预期路径
#    （命令尾会提示走发布重签）——撤销已记录，继续 ②。

# ② commit+push（消息惯例：catalog: revoke <名>@<版本> (<事由>)）

# ③ 走 1.B 重签发布：beta-only 条目 = channel beta；stable 条目 = 先 stable
#    后 beta（revoke 自动传导 beta 清单，两份都要重发）

# ④ 棘轮 bump（同 1.B ⑤）
```

**生效面**：市场行 ≤5 分钟（扫描缓存 TTL）消失；已装机器**下次启动**被 boot
拦截加载（需重启）；`boot_verify` 遥测留痕。

**retire（显式撤窗，P15）——revoke-first 两步走**

前置：该版本**已 revoke 且该吊销已发布**（签名 revoked:true 记录就是下窗
凭证，publish-local 的 removal guard 认它）；且**群公告**已发（撤窗会拒载仍在
用旧版的机器）。

```bash
# ① 移出窗口（需签名钥环境）
node tools/company-catalog/cli.mjs retire <名>@<版本>
#    allowlist 移除窗口条目 + 双清单重签；某通道没签/没钉该条目则跳过、不耗 sequence

# ② 走 1.B 推送重签清单（已吊销版本离开 = 守卫放行，无需旗标）
```

**fail-closed / 纠错**：静默手删 allowlist 旧版条目会被 version-retire guard
拦红——这正是设计（clients boot by exact name@version，静默丢钉 = 砖机）；
确属有意立即撤版才 `--allow-version-retire`（= 所有者明确拍板的事）。

### 1.E 改 beta 名单（beta-roster，零客户端发版）

```bash
node tools/company-catalog/cli.mjs beta-roster -f add=<邮箱小写>
node tools/company-catalog/cli.mjs beta-roster -f remove=<邮箱小写>
```

- 名单住**签名清单**（不是 policy / 设置）：roster 状态在
  `state/beta-testers.json`（本地 scratch、gitignored；缺失 = 首批三人组
  julu/sebtang/lizywu）；变更 = 重签 beta 清单 + 共享棘轮前进，秒级生效；
- 命令需签名钥；无钥操作机等价路径 = 改 state 后走 1.B channel=beta 重发
  beta 清单（roster 随清单签名生效）；
- **退名单卫生（fail-closed）**：该机器若装着 beta-only 插件（stable 没钉
  的），退出后 boot 校验找不到钉定 → 插件不再加载。先让其卸载 beta-only
  插件，或先 promote 再退。从 beta 撤条目同理：测试者还装着的 beta-only
  条目先 promote（stable 永久钉定）再撤。

### 1.F 换版重打包（同版本不可重发 → 必须 bump 版本）

**硬事实（dai-context 0.41.4 实证，2026-09-09）**：公司目录的托管 tarball
内容不可变。同版本重发会被 publish-local 的字节闸 fail-closed 挡下：

> packages/&lt;名&gt;-&lt;版本&gt;.tgz already exists on master with different bytes
> (hosted sha512-…, artifact sha512-…) — &lt;名&gt;-&lt;版本&gt; was already
> published and a hosted tarball is immutable; publish changed content as a
> new version (fail closed; nothing was pushed)

根因不是内容改了，而是**打包器换代漂移**：容器字节取决于当次 CI 链接的
Node/zlib（同一 Node/zlib 内字节稳定），同一份源码在新打包器下也产不出托管
文件当年的字节。**唯一正确做法 = 换版本号重打包**（dai-context 0.41.3 →
0.41.4 即如此）。步骤（以 旧→新 为例）：

```bash
# 1. 目录换版（内容不动）
git mv tools/company-catalog/plugin-sources/<名>-<旧版本> tools/company-catalog/plugin-sources/<名>-<新版本>
# 2. 目录内 package.json 的 version 改新版本
# 3. allowlist 条目改 version / repository / source.url / source.path，
#    并去掉旧条目的 treeDigest（该字段可选，未测前应省略）
# 4. CI 干跑看产物（默认 dry-run）→ 真发 → 1.B 推送 → 棘轮 bump
```

注意：换版 = 新条目，旧版本若仍在清单里需单独 revoke；只想让新包灰度时保持
beta-only（dai-context 0.41.4 即 beta-only，stable 未动）。

## 2. 门禁语义表（publish-local 会拦你时）

| 门禁 | 什么时候拦 | 拦截信息关键句 | 正确姿势 |
| --- | --- | --- | --- |
| sequence ratchet | 产物序号 ≤ 该通道已部署序号（stale artifact） | `sequence ratchet failure … stale — rebuild from a bumped state file` | state 旧了 → 重跑 CI；**绝不手工调 state** |
| fleet-upgrade gate | 条目首次带 `source` / `treeDigest` / `approvedBuilds` / `description` 上该通道（老客户端 `additionalProperties:false` 一个未知键拒整份清单） | `fleet-upgrade gate … blacks out the whole catalog` | 全 fleet 已是 field-aware 构建（#47 起都是）才 `--confirm-fleet-upgraded` |
| package-removal guard | stable 将丢一个未吊销的**包**（典型 = 浸泡窗口陷阱：某包唯一条目带 beta 旗标） | `package-removal guard … soak-window trap` | 先 promote 该包；真下架先 revoke；有意移除才 `--allow-package-removal` |
| version-retire guard | stable 将丢同包一个未吊销**版本**（静默撤窗） | `version-retire guard … silently shrink` | 默认保留旧钉（promote 即如此）；显式下窗走 revoke→发布→retire（1.D）；有意立即撤才 `--allow-version-retire` |
| tarball 字节闸 | 同 名@版本 已托管且字节不同 | `already exists … a hosted tarball is immutable` | 换版本号重打包（1.F） |
| beta 首推无基线 | beta 文件 404（首次发布） | `ratchet: no deployed beta manifest` | 自动回落 stable 基线，无需动作 |

全部 fail-closed：任何一门拦下 = 零字节推送，修完重跑即可，不存在半推状态。

## 3. 观察与验证（发布后怎么确认真的生效）

**门户侧（GitLab 配置仓 `julu/dsh-desktop-config`）**——清单回读（sequence +
条目旗标；raw 有缓存，加 `?t=` 破缓存）：

```bash
curl -s --cacert .deloitte-ca-bundle.pem \
  "https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/catalog-manifest.beta.json?t=$(date +%s)" \
| python3 -c "import json,sys; m=json.load(sys.stdin); print('sequence', m['sequence']); [print(' ', e['packageName']+'@'+e['version'], 'revoked' if e.get('revoked') else 'active') for e in m['packages']]"
```

（stable 把文件名换成 `catalog-manifest.json`。）包字节页：
`https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/blob/master/packages/<名>-<版本>.tgz`。

**客户端侧（`catalog_refresh` 遥测）**——库：公司 MySQL `DSH_LOG@10.173.59.16:3306`，
表 `dsh_client_events`（字段字典与时区注意见 `dsh-plugin-desktop/docs/telemetry.zh.md`；
`created_at` 存 UTC）。发布传播（seq N 推到了谁）：

```sql
SELECT user_email, MAX(created_at) FROM dsh_client_events
WHERE event_type='catalog_refresh'
  AND JSON_EXTRACT(detail,'$.sequence')>=<N>
  AND JSON_EXTRACT(detail,'$.channel')='<stable|beta-overlay>'
GROUP BY user_email;
```

事件语义：`detail.channel` = `stable` / `beta-overlay`；`outcome=applied` 才带
`sequence`/`entries`；异常 outcome（`stale-sequence` / `not-a-tester` /
`fetch-failed` / `bad-signature`…）即排障入口。装机效果看 `plugin_install`、
boot 拒载看 `boot_verify`（同字典）。

**桌面日志（单机取证）**：beta 生效行 `beta catalog applied (sequence N, …)`；
日志在 `%APPDATA%\DSH Desktop\logs\dsh-YYYY-MM-DD.log`，现场抓取脚本
`dev-log/grab-dsh-logs.ps1`。名单机器市场页人工刷新 = 最后一道肉眼确认。

**链路诊断**：

```bash
node tools/company-catalog/cli.mjs verify <清单文件>   # 端到端验一份清单
node tools/company-catalog/e2e-tarball.mjs            # 离线全链自检（fixture）
```

## 4. 演练与离线选项

| 旗标 | 语义 |
| --- | --- |
| `--branch <名>` | 推 GitLab 临时分支而非 master（演练专用；只有 master 推送才提示棘轮 bump，结尾会提醒删分支） |
| `--deployed <file\|url>` | 换棘轮读源（本地文件/URL）——**强制要求 `--dry-run`**：演练永不真推 |
| `--dry-run` | 验证 + 棘轮对拍 + 打印 push plan，clone 之前停 |
| `--artifact-dir <dir>` | 跳过 gh：从已按产物布局摆好的本地目录离线重放（清单 + publish-meta.json + packages/） |
| `--from-git <run-id>` | 直取 `catalog-artifacts` 镜像分支（gh artifact blob 不通的环境；`--run` 下载失败时也会自动回退到它；镜像字节过同一套验签闸） |

## 5. 出错恢复（棘轮不可回退条件下的正确姿势）

- **棘轮只进不退是设计**：GitHub 侧以入库 state 为签名下限，内网侧独立对拍
  已部署值；坏发布**只能被更高 sequence 覆盖**，清单不可变但可前进。绝不试图
  「回退到上一个版本号」。
- **state 与 deployed 不符**：内网侧拒发会打印两侧值——**信已部署值**，state
  经发布后 bump 追平；绝不手工调低（调低 = 客户端可能见过的序号被重发）。
- **忘 bump 棘轮**：下次产物 stale → ratchet 拒发 → 重跑 CI 即恢复，无损失。
- **推错清单 / 坏内容**：下一发更高 sequence 覆盖；要移除条目走 1.D revoke。
- **用户侧安装失败**：WAL 自动回滚，用户无损，重试即可。
- **回执换机**：accept-handoff 只认本机 `out/verdict-receipts/` 的 verify
  回执——换机受理前先在本机重跑 verify-handoff。

## 6. 实战范例：2026-09-12 seq30（engramory 从 beta 下架）

背景：`dsh-dai-engramory@0.2.4` 为 beta-only 浸泡条目，随 b91 真机卸载事件
决定下架。操作机 = 无签名钥的发布机；当天首次启用 CA bundle（此前用
`--insecure-tls`）。发布前：stable seq27 / beta seq29 / 棘轮 29。

```bash
# ① 吊销落 allowlist（本机重签失败 = 预期，撤销已记录）
node tools/company-catalog/cli.mjs revoke dsh-dai-engramory@0.2.4
#    allowlist: dsh-dai-engramory@0.2.4 marked revoked:true (entry kept; …)
git commit -am "catalog: revoke dsh-dai-engramory@0.2.4 (remove from beta soak)" && git push
#    → bbf9da30e6（allowlist.json 单行：revoked false → true）

# ② CI 签 beta 产物
gh workflow run "Company catalog publish" --repo LCorleone/deepseek-harness-desktop \
  --ref master -f channel=beta -f dry-run=false
#    → run 34656749412 绿

# ③ 内网推送（企业 CA 走 bundle）
NODE_EXTRA_CA_CERTS=.deloitte-ca-bundle.pem GITLAB_TOKEN=<凭据> \
  node tools/company-catalog/publish-local.mjs --channel beta --run 34656749412
#    ratchet: 29 → 30；push: catalog-manifest.beta.json …；
#    re-check: … exact pushed bytes … deployment confirmed；publish complete: sequence 30

# ④ 回读复核（§3 命令）：sequence 30，8 条，dsh-dai-engramory@0.2.4 revoked ✓

# ⑤ 棘轮 bump
#    tools/company-catalog/state/last-sequence.json → { "lastSequence": 30 }
git commit -am "catalog: ratchet last-sequence to 30 after the beta seq30 publish (revoke dsh-dai-engramory@0.2.4)" && git push
#    → 22f1195fc8
```

结果态：stable seq27（5 条）不动；beta seq30（8 条，engramory revoked 留签
审计）。生效面 = 3 台 tester 下次刷新后市场隐藏 engramory（`catalog_refresh`
beta-overlay applied sequence 30 可证）。后续未完项：确认 sebtang/lizywu
刷新后隐藏；是否 retire 出窗（需群公告，issue #003）。

## 修改记录

- 2026-09-07 初版（四类发布速查：beta/stable/名单/吊销 + 门禁速查）。
- 2026-09-09 补「同版本不可重发 → 换版重打包」（dai-context 0.41.4 实证）。
- 2026-09-10 补 P15：D2 显式 retire、多版本钉扎三行语义、version-retire 门禁。
- 2026-09-12 统一 runbook 化（#023）：并入发布机环境前置（CA bundle 提取与
  `NODE_EXTRA_CA_CERTS`、凭据纪律）、受理链的 plugin-sources 落源步、观察与
  验证（门户回读 / `catalog_refresh` 遥测 / DSH_LOG 查询）、演练选项、seq30
  实战范例；`--run` 直取产物取代 gh run download + `--artifact-dir` 成主路径
  （后者降级为离线重放选项）；CA bundle 取代 `--insecure-tls` 成默认姿势。
  同日建立英文镜像 RELEASE.md 与双语记录 RELEASE.i18n.yaml。
