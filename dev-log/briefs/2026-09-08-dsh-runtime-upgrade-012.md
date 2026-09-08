# Brief — DSH 运行时升级 0.1.1-rc.2 → 0.1.2-rc.1（2026-09-08 立项）

## 1. Goal & background

动机=获取上游 1735 commits 修复/安全积压（用户拍板；档3 首拒弹窗已证不存在于 0.1.2-rc.1/0.1.3-alpha.2，不做）。上游 anywhere-labs/dsh-desktop v2.0.5 stable 已带 0.1.2-rc.1=上游自己认为可用。我们桌面基线 2.0.3 行（上游 v2.0.4 代际）。

**红线**：子模块 deepseek-harness/ 内容=上游的，绝不改（升级=只动 pin 指向新 tag）；我们的锁定层/门/守卫/policy 永远赢。

## 2. Code map（scout 报告 2026-09-08 22:29，行号近似）

- **子模块**：现 pin b150a551（dsh-v0.1.1-rc.2）→ dsh-v0.1.2-rc.1（commit a66e470204，子模块本地已有该 tag；origin=anywhere-labs/deepseek-harness）。diff=1735 commits/7633 文件/55 包；breaking：CallId→ToolCallId、cross-package runtime relays 移除、approval/question 移入新包 ui-approval/ui-session、agent-presets 打包路径迁移。
- **版本钉扎**：dsh-plugin-desktop/package.json 依赖+resolutions 33 处 rc.2→rc.1；伴生小版本 cordis 4.0.1→4.0.2 等 5 个（以 npm 实际解析为准）。
- **新增依赖**：dsh-client-ui-session、dsh-client-ui-approval。
- **补丁**：patches/×15 + .yarn/patches/×2 全部针对 lib/ 产物→重做+改名（0.1.1-rc.2→0.1.2-rc.1 后缀）；**新增必需补丁** dsh-settings@0.1.2-rc.1.patch（上游 16 行恢复 settingsNamespace，否则 src/index.ts:80-83、notifications.ts:13 断链）。注意 client-runtime 补丁上下文（pending.ts 已被上游删）可能整体消失→重定位到新包。
- **src 适配**（抄上游两笔：17ad0d0802+8794279cb7）：AdvancedFrame.tsx details slot 包 SessionProvider；scripts/verify-packaged-runtime.ts:135-137 presets 路径迁移；agent-preset-compat PTC preset 改名。
- **测试/工具**：tests/package.spec.ts 45 处等 14 个 spec；company-catalog allowlist.json/compat.json/e2e-tarball.mjs；THIRD_PARTY_NOTICES。
- **上游免费地图**：v2.0.4→v2.0.5 共 370 commits，但 runtime 强制适配集中 17ad0d0802（settingsNamespace）+8794279cb7（SessionProvider/presets 路径/preset 改名），其余 70+ 文件是其产品功能不跟。

## 3. Conventions & constraints

- **原子单 commit**（避免混合版本中间态），分支内按 pin→补丁→src→tests 顺序推进，每步跑 `corepack yarn workspace dsh-plugin-desktop verify:closure`/loader/profile 门。
- **dshmarket 兼容专项**（风险 1）：我们市场锁定层（dsh-community-market，dshmarket 1.17.1）vs 0.1.2 客户端——上游同步升到 1.38.1 未验；升级后必须跑 market 全量 441 基线+适配说明，失败则评估 dshmarket 升级或兼容层，**宁可慢不可带病**。
- edit 工具改码；vitest/typecheck timeout 900；不 push、不构建。
- 基线：desktop **2058+7skip** / market **441** / catalog tests；typecheck 5 tsconfig 0。
- 允许测试数随上游自带测试增减，不允许 fail；补丁重放每个给一句「语义等价」说明。

## 4. Decisions made & failed attempts

- 档3 落空不做（escalation 语义未变）。
- 姿势=原子 commit（上游 8794279cb7 同款），内部分步+逐步门禁。
- P11 python 捆绑排在升级后（同一地基原则）。

## 5. Acceptance criteria

- 子模块 pin=dsh-v0.1.2-rc.1 且**零内容改动**（`git diff b150a551 a66e470204 -- . ':!package.json'` 之类证据：pin 变更仅指针）。
- yarn check 全绿（desktop/market/catalog 全量+typecheck）；verify:closure/loader/profile 过；e2e-install-smoke 过。
- 15+2 补丁全部重放+改名+语义等价说明+新增 settings patch 落位。
- dshmarket 兼容专项结论成文（过/适配了什么）。
- 报告含真机验证清单（升级后首启/插件链路 boot_verify/市场安装/终端）。
