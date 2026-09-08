# Brief — boot 验证 peer 后缀剥离 + 拒绝可见化（2026-09-08）

## 1. Goal & background

市场装好的 beta 插件 dsh-dai-context@0.41.3 真机每次启动被 boot 验证静默拒绝（DB boot_verify detail：`rejected:[{packageName:'dsh-dai-context',code:'no-lock-integrity'}]`，dsh-*.log 零痕迹）。根因=安装链同款 pnpm peer 后缀盲区的**第二处**（第一处 service.ts 已修 32bfaf522d）：lockfile importer `version` 挂后缀 `file:…tgz(@peer@ver)`，而 boot 验证两处比较都用带后缀串对裸值。修复+补可见性（trace-dai-context 建议：boot 拒绝必须写日志）。

## 2. Code map（HEAD≈bc07909295）

- `dsh-plugin-desktop/src/boot-verification.ts`
  - `desktopBootLockIntegrity`（~796-820）：registry 快路径 `exactLockResolution` 已容忍后缀；tarball 慢路径 `desktopBootTarballLockIntegrity`（905-929）：
    - 917-923：`desktopMarketFileSpecPosixPath(resolve(profileDir, resolvedSpelling.slice(5)))` 与 stagedPath 严格相等——**后缀盲区①**
    - 924：`lockEntry(packages, [packageName+'@'+resolvedSpelling])` 单 key 查——**后缀盲区②**
  - pnpm 后缀固定形态：`(@scope/name@ver)` 或 `(@a@1,@b@2)`，总在串尾、以 `)` 结束；staged 路径与安全包名/版本**禁括号**（controlledTarballSpecifierStagedPath 同一前提）。
- 拒绝可见化挂点：`prepareDesktopProfile`（profile.ts ~908-913）把 `bootVerification.rejected` 并入 disabled 处——此处在 desktop 主进程侧，可拿 electronLogger？**注意**：profile.ts 是否能 import logger 要查现有结构（别引 preload/渲染面）；若 profile.ts 无日志面，就在 main.ts 消费 rejected 的地方打（rg rejected 找消费点）。日志一行格式：`dsh-plugin-desktop: boot verification rejected <pkg>@<ver> (code=<code>): <reason 首句>`——reason 可能含盘符路径，过 maskSecrets 同款路径遮蔽（复用现有 mask 或只打 code 不打 reason，取小）。

## 3. Conventions & constraints

- 修法与 service.ts 32bfaf522d 姿势对齐：resolvedSpelling 剥后缀（尾 `)` 且含 `(` → 截到首个 `(`）得 bare；两处比较均用 bare；lockEntry key 用 Set{bare, 原串} 双试。**integrity 校验语义零改动**（staged tarball 实测 sha512 逐字节 timingSafeEqual 保留）。
- `desktopBootControlledTarballPinProblem`（修复指引文案）同步受益即可，不必改。
- 回归测试（boot-verification 现有 spec 习语）：带后缀 resolvedSpelling + 裸 packages key + integrity 匹配 staged → 通过；负向：staged 实 hash 不匹配 → 仍 undefined。再补「拒绝写日志」断言（若挂 main 消费点则查该处日志调用可测性；测不动就源码钉）。
- edit 工具改码；vitest/typecheck timeout 900；跑 desktop 全量。
- 不 push、不构建、不动子模块。

## 4. Decisions made & failed attempts

- 根因链完整：安装链（已修）≠boot 链（本卡）；free-search 未踩=stable+当时树无相交 peers；对照实验（原版 dsh-context seq18）同样会中招——修复后两者应同时恢复，对照留作修复后回归。
- 后缀剥离安全性论证沿 service.ts 评审结论（staging 名禁括号→首 `(` 剥离无歧义）。
- 拒绝可见化只加一行 error 级日志，不改行为（仍拒绝仍禁用）。

## 5. Acceptance criteria

- 后缀 fixture 红绿证（改前红改后绿，报告注明）。
- desktop vitest 全绿（基线 2022+7skip 之上只增不减）+ typecheck 0。
- 拒绝日志行存在且被测试钉住（行为测或源码钉，二选一说明）。
- 一个 commit：`fix(desktop): boot verification peer-suffix tolerance + visible rejection logging`。
