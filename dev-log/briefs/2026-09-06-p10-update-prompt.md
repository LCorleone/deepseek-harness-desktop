# P10：插件待更新提示（boot 拒绝分类 + 通知 + 市场更新横幅）

## 1. Goal & background
版本替换=硬切换：promote 后旧版装机下次启动被 boot 校验拒绝，插件「静默消失」
（SOP 已记预告纪律）。本任务把 a 类拒绝（清单钉新版、本地旧版）变成看得见的
升级引导：桌面通知 + 市场页更新横幅。**执法层零改动**——拒绝依旧 fail-closed，
只新增分类与提示。

## 2. Code map（master f2ce6e315d）
- `dsh-plugin-desktop/src/boot-verification.ts` — `verifyDesktopBootBundles` 返回
  `rejected: DesktopBootRejectedBundle[]`（现只有字符串 reason；各拒绝分支见
  「is not in the signed company manifest」/「pins X but Y is installed」/
  「is revoked」/integrity/treeDigest 各分支）。**加结构化 code 字段**：
  `code: 'not-pinned-newer-pinned' | 'not-in-manifest' | 'revoked' | 'integrity-mismatch' | 'tree-mismatch' | 'unresolved' | 'no-lock-integrity'`，
  reason 字符串保留（兼容现有测试/日志）。a 类=not-pinned-newer-pinned
  （现文案「the signed company manifest pins X@new, but old is installed」）。
  注意 beta 回退查找（findDesktopCompanyManifestPackageWithBeta）后 pinned 存在
  但 version 不等 → a 类；pinned 不存在 → not-in-manifest。
- `dsh-plugin-desktop/src/notifications.ts`（desktop-notifications 插件）——桌面通知
  先例；boot 后何处消费 verification 结果找现有调用方（main.ts/profile 启动路径）。
- 市场 UI：`dsh-plugin-desktop/src/desktop-market.ts` + `src/company-market-install.ts`
  + `dsh-community-market`（market 页 shell）。市场页顶部横幅的挂点看 market 页
  现有 UI 结构（community-market 的页面组件/注入面）。
- 测试：boot-verification 现有 spec（原因字符串被断言的地方）、desktop-market/
  company-market-install spec、market 侧 spec 400 例。

## 3. 实现要求
1. boot-verification：拒绝条目加 code（枚举如上）；现有 reason 文案与全部现有
   测试不动。新断言：a 类场景 code 正确。
2. 启动消费：boot 验证完成后，把 a 类拒绝聚合成 `{packageName, installedVersion,
   pinnedVersion}[]` 交给通知插件：桌面通知「N 个插件有新版本，点击打开市场更新」
   （N=1 时带插件名；点击行为=打开市场页——复用现有打开市场的入口，查 main.ts
   现有 open-market 通道；没有就只弹通知不带点击）。b/c/d 类**不**发更新通知
   （保持现状日志即可——本批不做它们的用户面提示）。
3. 市场页更新横幅：市场页顶部当「已装版本 < 清单钉定版本」非空时显示
   「N 个插件可更新」横幅，逐条「插件名 旧版本 → 新版本 [更新]」按钮=[更新]
   直接走现有市场安装流（装新版即替换 lockfile；安装流已有）。已装版本来源=
   boot 验证输入的 bundles（或 profile lockfile 读已装集——看哪条现成）。
   c/d/revoked 不进横幅。
4. 通知/横幅文案双语（zh/en，市场现有 locale 惯例）。
5. 幂等：同一会话通知只发一次；横幅随状态实时（安装完成后消失）。

## 4. Conventions & constraints
- 执法零改动：不改任何 reject 分支的判定逻辑；code 只是附加元数据。
- 渲染端 Node-free 门禁照旧；零新依赖；Windows CI 安全。
- 不动 staging/policy/管线。单 commit `feat(desktop+market): pending-plugin-update prompt — boot rejection classification, notification, market update banner`，
  不 push。

## 5. Acceptance criteria
- boot-verification：每拒绝分支 code 断言入链（含 a 类 beta 回退路径）。
- 通知：a 类触发/非 a 类不触发（测试钉死 revoked 与 tree-mismatch 不发）。
- 横幅：装旧钉新显示、安装后消失、revoked/篡改不显示（测试钉死）。
- `corepack yarn check` exit 0（desktop/market 基线 1857+7skip/411+新增）。
- 返回：code 枚举与各分支映射表、通知与横幅挂点行号、测试清单、check 结果。
