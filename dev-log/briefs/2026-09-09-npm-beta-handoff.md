# Brief — npm 通道 beta 条目安装缺口（2026-09-09 事故）

## 1. Goal & background

真机：b75（0.1.2 客户端）在市场点装 `dsh-better-sidebar@0.18.1`（beta 条目，npm 通道）→ 受控子进程闸拒：`dsh-better-sidebar@0.18.1 is not in the signed company plugin catalog`（且报错无「beta hand-off was ignored」后缀=根本没收到 handoff）。根因：**#59 的 beta 清单 handoff 只接进了 tarball 通道**，npm 条目走裸 registry 路径，子进程闸只见 stable 清单 → beta-only 的 npm 条目永远装不上。sidebar 是首个 npm 通道 beta 条目（free-search 是 tarball 所以此前没暴露）。

## 2. Code map（HEAD=a8be22a0c5）

- `dsh-plugin-desktop/src/pnpm.ts:678-690`：`controlledTarballEnvironment = request.marketTarball === undefined ? undefined : { [DESKTOP_COMPANY_TARBALL_HANDOFF_ENV]: companyTarballHandoffText({packageName, version, integrity, path, ...(betaManifestPath, betaSequence)}) }` —— **npm 安装（marketTarball===undefined）不注入 handoff**。
- `dsh-plugin-desktop/src/company-market-install.ts:254,273`：diversion hook `if (source === undefined || source.kind !== 'tarball') return undefined` → npm 条目不进 tarball 分支，`:318-321` 的 beta 清单 stage（`desktopBetaManifestHandoffStagingPath`+`writeFileAtomic`）不执行。
- `dsh-plugin-desktop/src/cli-install-channel.ts:334-420`：子进程闸——读 handoff → 验 stable 清单 → 若 `handoff.betaManifestPath/betaSequence` 存在则再验 beta 清单（签名/origin/sequence 绑定/降级闸）→ `findDesktopCompanyManifestPackageWithBeta(manifest, betaPackages, packageName, version)` 查条目。**闸本身已支持 beta 对任意 target**（不区分 npm/tarball），只是没收到 handoff。
- `dsh-plugin-desktop/src/company-tarball-handoff.ts`：handoff 文本 schema（`companyTarballHandoffText` 生成、`parseCompanyTarballHandoff` 解析；integrity/path 与 beta 对的字段约束/长度上限在此）。

## 3. 设计要求（worker 细化，原则固定）

1. **npm 通道 beta 条目**：market 解析出 `fromBeta===true` 且 entry 无 `source`（npm）时，也 stage beta 清单并给子进程注入 handoff——但**不能伪造 tarball 语义**（无 integrity/path 不得触发 tarball 分支）。方案建议：handoff 增可选变体或放宽必填字段（`integrity`/`path` 仅在 tarball 目标时必填），子进程解析时按 target 形态校验（npm：`name@version` 走 registry 校验+stable∪beta 查找；tarball：原样）。
2. **信任零扩大**：beta 清单仍由子进程独立验签+origin 绑定+序列绑定（≥stable、与 handoff 一致）；handoff 长度上限/字段白名单沿用；staged 路径仍限 profile 的确定性 staging 位；**roster 明文清理**（装完即删 staged beta 清单）在 npm 路径同样执行。
3. **fail-closed**：handoff 缺失/被拒 → 退回 stable-only（现状）；拒绝信息保留「beta hand-off was ignored: <原因>」。
4. **不得回归**：tarball 路径字节级行为不变（含 #59 既有测试）；stable npm 安装零变化。

## 4. Acceptance

- 红绿：npm beta 条目在 b75 语义下可装（子进程闸放行）——改前红改后绿；stable npm 目标仍按 stable 清单；伪造/降级 beta handoff 仍拒。
- 既有全量门禁绿：desktop 基线 2081+7skip 只增不减、typecheck 0。
- 报告含真机验证步骤（装 sidebar 0.18.1 → 成功 + roster 明文 staged 文件装后即删证据）。
- 一个 commit：`fix(desktop): npm-channel beta installs — beta manifest hand-off for source-less targets`。不 push 不构建。
