# Brief — lockfile peer 后缀剥离修复（市场安装校验，2026-09-08）

## 1. Goal & background

同事首 MR 插件 dsh-dai-context@0.41.3（beta seq17）真机安装两次均 rolled-back（operation-failed，UI 报「lockfile integrity mismatch」）。另一 session 已完成完整 debug 与复现（勿重做）。本卡=落地修复+回归测试+评审。

## 2. Code map（行号近似，HEAD≈cf730f71a9）

- `dsh-community-market/src/install/service.ts` — `assertProfileLockRecord`（~720-730 附近）：file:（tarball）通道拿 importer `dependency.version` 拼 key 查 lockfile `packages:` 段。**bug：pnpm 在 profile 树已含可解析 peer 时给 version 挂后缀**，如 `file:.dsh-market-tarballs/dsh-dai-context-0.41.3.tgz(@deepseek-ai/schemastery@3.18.2)`，而 `packages:` 段 key 永远是裸 key → 查不到 → integrity 比对失败 → 回滚。
- 同文件 registry 通道已有正确先例：`exactLockResolution` 里 `value.startsWith(version + '(')`（后缀容忍）。
- 复现（已验证，勿重跑）：profile 先装 free-search（带进 schemastery@3.18.2）再装 dai-context（peer `^3.18.1`）→ lockfile importer 出现带后缀 version。空 profile 或机械路径 integrity 全对。

## 3. Conventions & constraints

- 修法：file: 通道 key 查找剥掉 version 自第一个 `(` 起的后缀再查（或裸/带后缀双 key 都试，取与 registry 通道姿势最一致的）。**只动查找逻辑，绝不动 integrity 值本身或信任根语义**——integrity 仍必须逐字匹配签名清单。
- 回归测试：market 包 vitest 习语，fixture 形如「importer version 带后缀 + packages 段裸 key + integrity 匹配 → 通过」+ 负向「integrity 真不匹配 → 仍拒」。
- 代码编辑一律 edit 工具；vitest/typecheck timeout 900。
- 跑 `corepack yarn workspace dsh-community-market vitest run` + 该 workspace typecheck；若改签名共享类型再跑 desktop 包测试。
- 不 push、不构建、不动子模块。

## 4. Decisions made & failed attempts

- 根因定位与复现全记录在 MR session（2026-09-07T10-14-51）；本地实验证明机械路径无问题——勿再验。
- #69 与并行上游摘取 batch 均排除（时间线+diff 面）。
- 影响面=任何 peers 与 profile 树相交的插件（非 dai-context 特有）；free-search 首装未踩是历史巧合。
- 用户已批准修复（2026-09-08 12:49「你看看怎么修复」）。

## 5. Acceptance criteria

- service.ts file: 通道后缀剥离落地，registry 先例姿势对齐。
- 新回归测试红绿证（改前红改后绿，报告里注明）。
- market vitest 全绿（基线以当前 master 实跑为准）+ typecheck 0。
- 之后主会话安排 reviewer 评审（安装信任链必审）。
