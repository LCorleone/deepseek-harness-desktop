# MR 处理指南（pi session 冷启动版）

> 给专门处理同事 MR 的 pi session。2026-09-07 定稿。权威流程=SOP.zh.md，
> 发布命令=RELEASE.zh.md，本页=两者合一的操作直抄版 + session 冷启动上下文。
> 位置：tools/company-catalog/docs/handoff/MR-HANDLING.zh.md

## 0. 冷启动：先读这四样

```
tools/company-catalog/docs/handoff/SOP.zh.md      流程权威（角色/判断/异常路径）
tools/company-catalog/docs/handoff/RELEASE.zh.md  发布四类命令直抄
tools/company-catalog/docs/handoff/README.zh.md   同事视角（他们看到什么）
dev-log/2026-08-22-handoff-zcNSeT.md 的 2026-09-07 三节   今天的状态快照
```

**环境事实**（2026-09-07）：

- 插件仓：`http://10.173.59.30:9080/pluginpuller/dsh-desktop-plugins`（master
  Maintainer-only；同事推 `submissions/<名>-<版本>` 分支开 MR）
- 仓 token：向 July 要（pluginpuller 用户的 PAT，scope=api）——**永不写进
  任何 commit/文件**，只在当次命令环境变量用
- config 仓（客户端真源，另一条线，MR 处理不碰）：
  gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config，token 同样向 July 要
- 工作目录：`/opt/july/pi_tasks/deepseek-harness-desktop`（desktop 仓 master）
- 示例：仓库 MR !1 = 完整活示例（含三次被闸门咬的教学评论）

## 1. 有新 MR 到达

```bash
# 列开着的 MR
curl -s -H "PRIVATE-TOKEN: $TOK" \
  "http://10.173.59.30:9080/api/v4/projects/pluginpuller%2Fdsh-desktop-plugins/merge_requests?state=opened" \
  | python3 -m json.tool | grep -E '"iid"|"title"|"source_branch"'

# 拉下来验
cd /tmp && rm -rf mr-review && git clone \
  "http://oauth2:$TOK@10.173.59.30:9080/pluginpuller/dsh-desktop-plugins.git" mr-review
cd mr-review && git checkout <source_branch>
cd /opt/july/pi_tasks/deepseek-harness-desktop
node tools/company-catalog/cli.mjs verify-handoff /tmp/mr-review/submissions/<名>-<版本>
```

**FAIL** → verdict.md 已在提交目录里；把要点贴 MR 评论让同事改（参考 MR !1
评论的写法），分支上 `git push` 即更新 MR。常见咬点：checks 用自造值（封闭
枚举七选）/ 目录套两层（必须平铺 `submissions/<名>-<版本>`）/ 重报已发布版本
（同版本内容不可变）/ v2 三字段缺失（author/description/type）。

**PASS** → 下一步。

## 2. PASS 后：人审三点（看 verdict.md 的审计节）

```
① 注入面：clientInject/clientPlatform/cordis.patch 合理吗（对照 SOP 判断标准）
② 网络域：network hosts 列表里有没有超出插件功能解释的域
③ 依赖与生命周期脚本：lifecycle scripts 必须为「无」；依赖漂移问一句
（evidence/checks 自报不核验——人审只审上三点，不向同事索要运行证明）
有问题 → MR 评论提出；没问题 → July 拍板 merge
```

## 3. merge 与采纳

```bash
# merge（Maintainer；merge 语义=accept 备料完成）
curl -s -X PUT -H "PRIVATE-TOKEN: $TOK" \
  "http://10.173.59.30:9080/api/v4/projects/pluginpuller%2Fdsh-desktop-plugins/merge_requests/<iid>/merge"

# 采纳到发布流（回执指纹在本机 out/verdict-receipts——verify 与 accept 必须同机）
node tools/company-catalog/cli.mjs accept-handoff <名>@<版本>
```

accept 产出：out/packages/ 的 tgz + allowlist 条目片段（贴入
tools/company-catalog/allowlist.json，同版本字节闸自动核对）。
repository 惯例：插件 package.json 自带则用其值；否则统一填 config 仓包页
`https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/blob/master/packages/<名>-<版本>.tgz`
（2026-09-08 定，详见 SOP ④）。
条目描述（2026-09-10）：allowlist 条目可加可选 `description`（一句话中文，非空），
管线会原样签进条目、市场卡片直接显示；无则键不出现（卡片回退英文占位符）。
同事 handoff.json v2 的 plugin.description 是现成素材——采纳时人工提炼一句贴进
allowlist 条目（评审面=MR/allowlist 本身，不做本地化框架；5 条现有草稿见
2026-09-10 brief，定稿人 July）。空串/非字符串会被 allowlist 校验拒绝。

## 4. 发布（细节全在 RELEASE.zh.md，此处索引）

⚠ **顺序雷（2026-09-10 定）**：目录校验是严格形状——携带 `description` 的新清单
在旧客户端（≤b88）上会**整单被拒**（一个未知键拒整份目录）。代码已进 b89；
**fleet 四台全部升到 b89 之前，任何人不得发 seq26**（首个可携带描述的清单）。
当前 allowlist 的描述为草稿，待 July 确认后才随 seq26 发出。

```
beta 首发   RELEASE §A（CI 签名 → publish-local --channel beta → state 棘轮推进）
浸泡        ≥2 工作日或首个真实反馈；期间 stable 发布别动该包（守卫自动拦）
转正        RELEASE §B（群预告 → CI stable → publish-local --channel stable）
```

**多版本钉扎三行语义（P15，转正时照此判断）**：

- **promote＝加条目保留旧钉**：转正只加新钉版，旧钉版留在 stable 清单，老客
  户端照常命中旧条目，发布即断老客户端的时代结束。
- **retire＝显式下窗（＋群通知）**：旧钉版要下窗必须显式——先
  `revoke <名>@<版本>` 并推送，再 `retire <名>@<版本>`（命令见 RELEASE §D2）；
  静默删旧版条目会被 publish-local 版本下窗守卫拦红。
- **保留策略**：上一条 runtime 线的最新版默认保留直至显式 retire；不确定就
  留着，manifest 体积微增可忽略。
- **市场视图按客户端 runtime 展示（P15 Phase 2）**：多版本目录下，客户端市场
  列表每包只显示与本机 runtime 兼容的最高钉版——老客户端只见兼容版，整包无
  兼容钉版即不出列表（详见 RELEASE §D2）；处理 MR 时同事问「为什么我看不到
  新版」，答案就是「先升 DSH Desktop」。

## 5. 纪律红线（每次过一遍）

```
· token 不落盘不进 commit；用完即弃
· 同版本不可变：内容变=升版本（verify/accept/publish 三处闸门一致）
· 多版本钉扎：promote 加条目保留旧钉；旧钉下窗走显式 revoke→retire
  （先群通知）；静默删旧版条目会被 publish-local 拦红（RELEASE §D2）
· state/last-sequence.json 每次发布后手动推进+commit
· 浸泡期 stable 禁令：P1 守卫会拦，被拦=先转正浸泡包或加 --allow-package-removal
  （后者=真下架，需 July 明确点头）
· 吊销用 cli revoke；名单进出用 beta-roster（见 RELEASE §C/D）
· 每一步的回执都贴回 MR 评论（同事看得见=流程可信）
· 完事 dev-log 记一行（滚动文档纪律）
```
