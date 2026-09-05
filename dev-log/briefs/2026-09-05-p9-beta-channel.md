# P9：插件预发双通道（beta 清单+签名 SSO 邮箱名单）

## 1. Goal & background
设计定案见 dev-log/2026-08-22-company-market-lockdown-plan-v2.md 的 P9 卡（必读，含定案
理由与验收标准）。一句话：单一 manifest=发布即全公司，需要小范围浸泡通道；签名名单制
（SSO 邮箱 ∈ beta 清单 testers 才让 beta 条目生效），无开关无 UI，测试者零配置。
首批名单：julu@deloittecn.com.cn、sebtang@deloittecn.com.cn、lizywu@deloittecn.com.cn。
信任链不变：同一密钥签名；beta 条目完整性验证与 stable 完全一致；名单只控可见性。

## 2. Code map（master 0a498d9bf3）
- `dsh-plugin-desktop/src/desktop-market.ts` — 公司市场 provider 注入与 manifest 拉取
  （stable URL 来自 policy 钉死的 origin；beta URL=同 origin + catalog-manifest.beta.json，
  派生即可，**不改 policy 资产=不用发客户端**）。
- `dsh-community-market/src/catalog/company-provider.ts` — fail-closed 扫描/origin 获取；
  `docs/schemas/company-manifest.schema.json` — 签名 wire schema（additionalProperties:false）；
  `src/signing/verify.ts` — 清单验签。beta 清单=同 schema 增可选 `testers: string[]`
  （小写邮箱，格式校验）；**stable 清单的 schema/字节零变化**。
- `dsh-plugin-desktop/src/company-sso.ts` — SSO 身份（邮箱）在主进程的来源；市场 provider
  跑在主进程侧，拿当前登录邮箱做名单比对（小写规范化，精确匹配；身份未解析=非测试者，
  fail-closed 用 stable）。
- `tools/company-catalog/cli.mjs` + `lib/` — 发布管线（measure-and-publish/revoke/
  verify-handoff 先例）；`state/last-sequence.json` 单一 sequence ratchet（beta/stable 共享，
  全局单调）。
- 测试链：market vitest 400 例、catalog node:test 108 例、desktop vitest 1829+7skip、
  e2e-tarball.mjs 离线全链。

## 3. 实现要求
**管线**（tools/company-catalog）：
- `measure-and-publish -f channel=beta`：产物写 catalog-manifest.beta.json（含 testers，
  名单源=state/beta-testers.json，首次创建含上述三邮箱）+ tarball 照常；stable 不动。
- `promote -f entry=<name>@<version>`：把 beta 条目（同字节同 digest）并入 stable 清单，
  双清单重签，sequence 共享单调；目标已是同 digest=幂等 no-op。
- `beta-roster --add <email> --remove <email>`：改 state/beta-testers.json → 重签 beta 清单
  （testers 变更）→ sequence+1。校验邮箱格式，小写规范化。
- dry-run 语义沿用（默认 true）；publish-local 侧对应支持 beta 文件推送。
**客户端**（dsh-plugin-desktop + dsh-community-market）：
- 市场刷新：拉 stable（现状不变）→ 顺手拉 beta（同 origin 派生 URL；404/损坏/验签失败=
  静默只用 stable，行为与今天一致）→ 验签 → SSO 邮箱 ∈ testers（精确小写）→ beta 条目
  叠加生效（同包同版本：beta 优先？——不，**beta 只增条目**：beta 中出现的 name@version
  若 stable 也有同 digest 则无差异，若 stable 没有/不同 → 用 beta 的；名单外机器完全无视
  beta 内容）。身份未解析/邮箱空 → 无视 beta。
- 日志：beta 命中/无视各一行（排障用，不泄露名单内容）。
**测试**：四验收场景钉死——非名单机器无视 beta 条目（变异即红）；名单机器生效；
promote 后全员同 digest；beta 清单缺失/坏签/坏 testers 字段=回退 stable 行为。管线三
子命令各红绿证。schema 对 testers 的负例（非邮箱/大写拒或规范化——选规范化并测试）。

## 4. Conventions & constraints
- 不动 stable 清单 schema 与既有条目字节；不动 policy 资产；不动 staging 仓。
- beta 清单也是「同版本不可变」：testers 之外的条目内容变=sequence+1 新版本。
- 长命令 timeout；Windows CI 路径安全；零新运行时依赖。
- 单 commit `feat(desktop+catalog): beta catalog channel with signed SSO roster (P9)`，不 push。

## 5. Acceptance criteria
- P9 卡验收四场景全绿（测试钉死）+ catalog/market/desktop 三链全绿（基线 108/400/1829+7）。
- `corepack yarn check` exit 0；e2e-tarball 演练仍过。
- 返回：子命令用法、客户端生效/无视判定点行号、四场景测试名、check 结果、偏差清单。
