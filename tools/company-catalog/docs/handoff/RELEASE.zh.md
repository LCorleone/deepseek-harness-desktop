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

## 门禁速查（publish-local 会拦你时的过闸姿势）

| 拦截信息 | 含义 | 过闸 |
|---|---|---|
| fleet-upgrade gate | 条目首次带 source/treeDigest 上 stable | `--confirm-fleet-upgraded`（前提：全 fleet 已是 field-aware 构建——#47 起都是） |
| package-removal guard | stable 将丢一个未吊销的包（浸泡窗口陷阱） | 先转正该包，或真下架先 revoke；有意移除 `--allow-package-removal` |
| sequence ratchet … stale | 产物序号 ≤ 已部署 | 重新跑 CI（state 旧了） |
| first beta publish | beta 首推无基线 | 自动回落 stable 基线，无需动作 |

## 出错恢复

- 安装失败 WAL 自动回滚（用户侧无损，重试即可）
- 推错清单：下一发更高 sequence 覆盖（清单不可变但可前进）；吊销用 D
- 验证链诊断：`node tools/company-catalog/cli.mjs verify` + e2e-tarball.mjs
