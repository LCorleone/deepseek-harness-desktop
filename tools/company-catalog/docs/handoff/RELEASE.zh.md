# 发布速查（照抄命令，不用读代码）

所有命令在桌面仓根目录跑。发布分四类：**首发 beta / 转正 stable / 改名单 / 吊销**。
共同事实：签名私钥只在 GitHub Secrets——本地永远不持钥；CI 只产产物不碰
GitLab（部署永远走你本机 publish-local）；两清单共享一个单调 sequence。

## 前置（每次发布前 30 秒确认）

```bash
git pull && git status --short        # 工作树干净
cat tools/company-catalog/state/last-sequence.json   # 当前序号
# allowlist 里待发布条目就位（版本/source/digest 状态）
```

## A. 首发到 beta（灰度，名单机器可见）

```bash
# 1. CI 签名产物（先干跑看一眼，再真发）
gh workflow run "Company catalog publish" --repo LCorleone/deepseek-harness-desktop \
  --ref master -f channel=beta                       # 默认 dry-run
# 确认 run 绿后真发：
gh workflow run "Company catalog publish" --repo LCorleone/deepseek-harness-desktop \
  --ref master -f channel=beta -f dry-run=false
gh run watch   # 或去 Actions 页等绿（~3 分钟）

# 2. 下载产物并推送（CI 不碰内网；不推=名单机器看不到）
gh run download <run-id>    # 得 company-catalog-signed/
NODE_TLS_REJECT_UNAUTHORIZED=0 GITLAB_TOKEN=<你的token> \
  node tools/company-catalog/publish-local.mjs \
  --artifact-dir <产物目录> --channel beta --insecure-tls

# 3. 推进仓库侧 state 棘轮（publish-local 完成提示会写明目标值）
#    改 tools/company-catalog/state/last-sequence.json → commit → push

# 4. 名单机器刷新市场验证 + 日志 "beta catalog applied (sequence N"
```

## B. 转正 stable（beta 浸泡完 → 全员）

**先做两件事**：群里预告「插件 X 升 Y，重启后请到市场更新」；确认浸泡期间
没有别的包要发 stable（守卫会拦，见下）。

```bash
# 1. CI 产 stable 产物（allowlist 无 beta 旗标的条目自动进 stable；
#    同一 tgz 重打包=同字节同 digest，等价于 promote 稳态）
gh workflow run "Company catalog publish" --repo LCorleone/deepseek-harness-desktop \
  --ref master -f channel=stable -f dry-run=false
gh run download <run-id>

# 2. 本机推送（两道门禁的既定过闸旗标见「门禁速查」）
NODE_TLS_REJECT_UNAUTHORIZED=0 GITLAB_TOKEN=<你的token> \
  node tools/company-catalog/publish-local.mjs \
  --artifact-dir <产物目录> --channel stable --insecure-tls --confirm-fleet-upgraded \
  --dry-run          # 先干跑！看 push plan 与 sequence
# 确认后去掉 --dry-run 真推

# 3. state 棘轮推进（同 A.3）
# 4. 验证：
curl -sk "https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json"
# sequence 与条目对上即成
```

**跳号是正常的**：stable 可能从 13 直接跳 16（beta 消耗了 14/15）——
共享棘轮设计如此，publish-local 会打一行 "skips past deployed … legitimate"。

## C. 改测试名单（加/减 beta 可见者，零发版）

```bash
node tools/company-catalog/cli.mjs beta-roster -f add=<邮箱小写>
node tools/company-catalog/cli.mjs beta-roster -f remove=<邮箱小写>
# 本地无钥时此命令跑不了签名 → 需在 CI 跑（同 A 的 workflow 起法，
# 或者用 A 流程重发 beta 清单——roster 变更随 beta 清单签名生效）
# ⚠ 退名单卫生：该机器装着 beta-only 插件时先卸载或先转正，否则重启被拦
```

## D. 吊销（紧急下架）

```bash
node tools/company-catalog/cli.mjs revoke <名>@<版本>
# 吊销自动传导 beta 清单；重签后按 A/B 流程推送对应清单
# 客户端下次市场刷新即不可装；已装机器重启时 boot 拦截加载
```

## D2. 显式 retire（撤单版本下窗，P15）

**多版本钉扎三行语义（P15 Phase 0）**：

- **promote＝加条目保留旧钉**：新版本转正后旧钉版仍在 stable 清单里，老客户端按
  名@版本 精确 boot 照常命中，永不因发布而断。
- **retire＝显式下窗（＋群通知）**：旧钉版离开清单必须走显式流程——先
  `revoke <名>@<版本>` 并发布（签名吊销记录即下窗凭证），再
  `retire <名>@<版本>`；下窗会拒载仍在用旧版的机器，执行前群里预告。
- **保留策略**：上一条 runtime 线的最新版默认保留直至显式 retire（静默删
  旧版条目会被 publish-local 的版本下窗守卫拦红；确属有意立即撤版用
  `--allow-version-retire` 过闸）。
- **旧钉字节随每次 artifact 携带**：多版本窗口内，仍在清单里的旧钉条目，
  其 `packages/<名>-<旧版本>.tgz` 原始字节必须随**每次**发布产物一并携带
  （不得缺省、不得重打包）——publish-local 的 4d 完整性闸按「托管 sha512 ＝
  artifact sha512 ＝ 签名 source.integrity」fail-closed 对拍，旧钉缺字节或
  换字节即整次发布拦红（同版本不可重发，见 E）。
- **市场视图按客户端 runtime 展示（P15 Phase 2）**：市场列表每包只显示
  与本机 DSH runtime 兼容的最高钉版，整包无兼容钉版即不出列表；对不
  兼容钉版的安装会被安装闸以「需先升级客户端」（client-update-required）
  明确拒绝。

```bash
node tools/company-catalog/cli.mjs revoke <名>@<旧版本>   # 第一步：签名吊销记录
# 按 B 流程推送该清单（守卫看到已吊销版本离开=合法）
node tools/company-catalog/cli.mjs retire <名>@<旧版本>   # 第二步：移出窗口
# 再推送重签清单；manifest 不再含该版本，包的其他版本不受影响
```

## E. 同版本不可重发 → 必须 bump 版本（换版重打包）

**硬事实（dai-context 0.41.4 实证，2026-09-09）**：公司目录的托管 tarball 内容
不可变。同版本重发会被 publish-local 的字节闸 fail-closed 挡下（`publish-local.mjs:865-877`）：

> packages/&lt;名&gt;-&lt;版本&gt;.tgz already exists on master with different bytes
> (hosted sha512-QXcxeFB…, artifact sha512-kDYAj+…) — &lt;名&gt;@&lt;版本&gt; was already
> published and a hosted tarball is immutable; publish changed content as a
> new version (fail closed; nothing was pushed)

根因不是内容改了，而是**打包器换代漂移**：容器字节取决于当次 CI 链接的
Node/zlib（`lib/tarball.mjs:45-51`——同一 Node/zlib 内字节稳定，换 zlib 版本
deflate 流与 gzip OS 字节都可能变），所以同一份源码在新打包器下也产不出
托管文件当年的字节。**唯一正确做法=换版本号重打包**（dai-context 0.41.3 →
0.41.4 即如此）。

步骤（以 0.41.3 → 0.41.4 为范例）：

```bash
# 1. 目录换版（内容不动，只动版本号）
git mv tools/company-catalog/plugin-sources/<名>-<旧版本> \
       tools/company-catalog/plugin-sources/<名>-<新版本>
# 2. 目录内 package.json 的 version 改新版本
# 3. allowlist 条目改 version / repository / source.url / source.path，
#    并去掉旧条目的 treeDigest（该字段可选，未测前应省略；lib/allowlist.mjs:326-331）
# 4. CI 干跑看签名产物（默认 dry-run）
gh workflow run "Company catalog publish" -f channel=beta
# 5. 真发 → gh run download → publish-local 推送（同 A.2；
#    fleet-upgrade 门禁按「门禁速查」过闸）
# 6. state 棘轮推进（本次 21 -> 22，同 A.3）
```

**注意**：换版=新条目，旧版本若仍在清单里需单独 revoke；只想让新包灰度时
保持 beta-only（dai-context 0.41.4 即 beta-only，stable 未动）。

## 门禁速查（publish-local 会拦你时的过闸姿势）

| 拦截信息 | 含义 | 过闸 |
|---|---|---|
| fleet-upgrade gate | 条目首次带 source/treeDigest/description 上 stable | `--confirm-fleet-upgraded`（前提：全 fleet 已是 field-aware 构建——#47 起都是） |
| package-removal guard | stable 将丢一个未吊销的包（浸泡窗口陷阱） | 先转正该包，或真下架先 revoke；有意移除 `--allow-package-removal` |
| version-retire guard | stable 将丢同包一个未吊销版本（静默撤版） | 默认保留旧钉（promote 即如此）；显式下窗走 revoke→发布→retire（见 D2）；有意立即撤 `--allow-version-retire` |
| sequence ratchet … stale | 产物序号 ≤ 已部署 | 重新跑 CI（state 旧了） |
| first beta publish | beta 首推无基线 | 自动回落 stable 基线，无需动作 |

## 出错恢复

- 安装失败 WAL 自动回滚（用户侧无损，重试即可）
- 推错清单：下一发更高 sequence 覆盖（清单不可变但可前进）；吊销用 D
- 验证链诊断：`node tools/company-catalog/cli.mjs verify` + e2e-tarball.mjs
