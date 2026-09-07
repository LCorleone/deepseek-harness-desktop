# 插件上架 SOP（同事 tgz → 全公司可装）

从同事自建 tgz 到员工机器可安装的完整操作手册。照着敲即可；每步标注了
「谁/机器还是人脑/出错了怎么办」。前置文档：权限与信任边界见交接指南
（.agents/notes/implemented/process/2026-09-04-company-market-owner-handover.md），
提交规则见 staging 仓 README。

## 角色与权限（一眼版）

```
同事   Developer @ gitlab julu/dsh-desktop-plugins（只能开 MR，推不了 master）
你     Maintainer 同上 + desktop 仓 owner + GitLab julu/dsh-desktop-config 写权
       + GitHub Secrets（签名私钥，永远不离开）
员工   无任何 GitLab 权限；客户端只读 dsh-desktop-config 的签名清单
```

## 同事侧五步（模板已给，他们照做）

```
1. npm pack 打出 <名>-<版本>.tgz
2. agent 按 compat.json 搭同版本环境自验（dsh commit+桌面版都钉在那份文件）
3. 算 sha256+字节数，填 handoff.json（严格按 handoff.schema.json）
4. 拉 submissions/<名>-<版本> 分支，放提交目录，推分支
5. 开 MR 到 master（标题=插件名@版本），等 verdict
```

## 你侧六步（收到 MR 通知后）

```
① 拉 MR 分支
   git -C <staging 克隆> fetch origin merge-requests/<MR号>/head:mr-<MR号> && git checkout mr-<MR号>

② 机器验证（十步闸门，~分钟级）
   node tools/company-catalog/cli.mjs verify-handoff <staging克隆>/submissions/<名>-<版本>
   → 全绿出 PASS verdict；任何一步红=在 MR 上回 verdict 并说明

③ 人脑判断（唯一需要你的判断）
   读 verdict 的内容审计段：依赖清单/安装期脚本/注入面/随包 URL 域名/
   同名版本差。决定收不收。高权限面（系统权限/敏感域名）→ 拒，转源码审计通道。

④ 受理落库
   node tools/company-catalog/cli.mjs accept-handoff <同一提交目录> [--repository <url>]
   → 回执须本机 verify 产生：accept 先对照本机 out/verdict-receipts/ 的指纹记录，
     预制回执、调包回执、别台机器验证过的回执一律拒（换机器受理前先在本机重跑 ②）
   → 自动校验 PASS+防陈旧（tgz sha 复核）→ 写 allowlist.json → 生成 commit
   （缺 repository 字段必须补 --repository；同版本不同字节会被拒——不可变红线）
   然后：合并同事的 MR（GitLab 上点），push desktop 仓的 accept commit。

⑤ 签名发布——先 beta 灰度（名单：你+sebtang+lizywu）
   a. CI 产签名产物：
      gh workflow run "Company catalog publish" -f dry-run=false -f channel=beta
   b. 下载产物并推送到 GitLab（CI 不碰内网；不推 = 名单机器看不到）：
      gh run download <run-id>   # 得 company-catalog-signed/ 目录
      NODE_TLS_REJECT_UNAUTHORIZED=0 GITLAB_TOKEN=<你的token> \
        node tools/company-catalog/publish-local.mjs \
        --artifact-dir <产物目录> --channel beta --insecure-tls
   c. 名单机器市场刷新可见，浸泡观察（建议 ≥2 个工作日或首个真实使用反馈）；
      名单外机器完全不受影响（行为与无 beta 一致，有测试钉死）
   ⚠ 浸泡期禁令：此时其他插件的 stable 发布会被守卫拦（防把浸泡中的包
      从 stable 清单抹掉）——先 promote 浸泡件，或确实要下架先 revoke，
      有意移除用 --allow-package-removal 显式过闸。

⑥ 转正 + 部署
   node tools/company-catalog/cli.mjs promote <名>@<版本>   # 同字节进 stable 清单
   → 走既有发布：publish workflow → 产物 → 本机 publish-local.mjs 推 dsh-desktop-config
   → 全公司市场可见；员工安装链三验（签名/allowlist/treeDigest）全程生效
```

## 异常路径

```
验证失败      verdict 会写明失败步+retest 指引 → MR 评论告知 → 同事修后升版本重开 MR
同版本重提    不可变：内容变=必须升版本（机器闸门双保险：verify 与 accept 都拒）
发布后出问题  revoke 子命令吊销（自动传导 beta 清单，名单机器同步失效）
              → 客户端下次市场刷新即不可装；已装机器重启校验拦截加载
紧急全员回退  revoke + publish-local；此路径演练过（见交接指南 §5 战例）
想改测试名单  beta-roster --add/--remove <邮箱>（重签 beta 清单，秒级，零客户端发版）
              ⚠ 退名单卫生：该机器若装着 beta-only 插件（stable 没钉的），
                退出后 boot 校验找不到钉定→插件不再加载（fail-closed）。
                先让其卸载 beta-only 插件，或先 promote 再退。
beta 撤条目    同理：测试者还装着的 beta-only 条目不要直接从 beta 撤——
              先 promote（stable 永久钉定）再撤，否则装机者开机加载被拦。
版本升级=硬切换  promote 后旧版装机下次启动被 boot 校验拒绝（清单只钉新版，
              无宽限期无自动更新）。**promote 前在群里预告**「插件升 X，
              重启后请到市场重装」。（后续可选增强：拒绝时发待更新通知/角标。）
```

## 文件地图（哪份文件管什么）

```
staging 仓（julu/dsh-desktop-plugins）
  README.md            同事规则（MR 流程/agent 模板）        ← 同事读
  compat.json          兼容契约（dsh+桌面钉死版本）          ← 双方 agent 读
  handoff.schema.json  提交单格式（additionalProperties:false）
  submissions/…        提交目录+verdict.md 归档

desktop 仓（你）
  tools/company-catalog/allowlist.json   上架决定（唯一人工维护输入）
  tools/company-catalog/state/           sequence 棘轮+beta 名单（beta-testers.json）
  tools/company-catalog/docs/handoff/    本 SOP+契约权威副本
  dsh-plugin-desktop/src/policy/         客户端信任根（动=发版）

正式仓（julu/dsh-desktop-config，publish-local 唯一写入）
  catalog-manifest.json / catalog-manifest.beta.json   签名清单（stable/beta）
  packages/*.tgz                                       插件字节
```

## 发布速查

四类发布（首发 beta/转正/名单/吊销）的照抄命令见同目录 **RELEASE.zh.md**——
本 SOP 讲流程与判断，那份只放命令。

## 修改记录
- 2026-09-06 初版（MR 模式定稿后；accept-handoff 命令落地同日）
- 2026-09-06 晚：⑤ 补 publish-local 部署步（CI 只产产物不推送）+ 浸泡期
  stable 发布禁令（横切评审 P1 守卫）；横幅方向校验与撤销粘滞对齐见当日 commit；回执指纹本机记录闸门（out/verdict-receipts/）同日补上：回执须本机 verify 产生
