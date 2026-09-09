# Brief — #73 打包态三雷修复（2026-09-09 立项，#73 DOA 事故）

## 1. Goal & background

#73（DSH 0.1.2-rc.1 升级，commit e4f3aa26f7，run 34296642974）**打包态全灭**：真机（用户 Win 机）启动失败，解包态门禁全绿（2052+7skip/closure/loader/profile）=第六次「单测绿打包死」，本次最大。已回滚 b72（现场已恢复）。四缺陷（前三个必修，第四个同批）：

- **雷A 渲染器打包态死亡（2026-09-09 11:41 决定性实锤）**：全新 profile 零插件实验——host-boot 干净走完 17.2s 无任何插件错误，renderer 仍 30s 超时 pluginCount 0（诊断包 diagnostics-1788925313543-*.zip，容器 /opt/july/pi_tasks/tmp_sessions/dsh-desktop-asserts/）。**与插件无关，打包态客户端组合本身死**。怀疑升级的注入改向（dsh.client.inject client-runtime→client-ui-renderer）或 client 组合在 asar 布局下没落对。诊断素材：用户机诊断包 diagnostics-1788921150039-*.zip（C:\Users\julu\AppData\Roaming\DSH Desktop\diagnostics\，容器侧路径 /opt/july/pi_tasks/tmp_sessions/dsh-desktop-asserts/ 有 1788920221111 那份）；**asar 取证管道**（先例：py7zr offset 232861→7z→app.asar header json_len@12/JSON@16/align4→unpacked lib/ 镜像）从 #73 Setup.exe（/tmp/dsh73/）抽 app.asar 静态核对 client 组合。
- **雷B 恢复窗打包态 ERR_FAILED**：`failed to open startup recovery window: ERR_FAILED (-2) loading file:///...app.asar.unpacked/lib/native-ui/recovery.html?state=...`——兜底 UI 死。疑 asarUnpack/REQUIRED_UNPACKED_RUNTIME_ENTRIES（verify-packaged-runtime.ts）在升级的 presets 路径迁移后错位。#72 好的=升级打包回归。
- **雷C 检查点内容物策略（2026-09-09 11:06 案情修正）**：tarball 蒸发+回执丢失真凶=用户手动删整个 .dsh；恢复机制从 userData 健康检查点把 profile 救活（四插件复活 loaded:4）=**按设计工作，是英雄**；复活已卸载插件=回滚到健康态的正确语义，不是 bug。缩窄后的真问题：①检查点不含市场回执与 .dsh-market-tarballs→恢复后插件能跑但市场「Installed another way」不认账——设计题：检查点是否应含 tarballs（非信任数据，倾向含）；回执=装权证明不可凭空重建，丢失走 another way 诚实标注+重装恢复，不自动造信任 ②「restored profile dependency synchronization failed」半残链加固（重试/降级语义）③健康检查点确实随成功 boot 滚动刷新（本轮实证：复活态=最后健康态）。
- **雷D（降级为低成本纵深）**：10:01 炸树时 agent-teams 实为【通过】验证（验证器不查 API 兼容性，签名/完整性全对）→剔除救不了不兼容插件（真防线=插件适配+安装时 runtime 门）。仍做：unresolved 等拒绝分类→loader include 剔除加固（防「磁盘上解析不了还进 include」的边角），定性次要。

## 2. Code map（HEAD=7aa3229d8c，升级 commit=e4f3aa26f7）

- 打包链：`dsh-plugin-desktop/package.json`（beforePack/extraResources/asarUnpack ~317-323）·`scripts/verify-packaged-runtime.ts`（REQUIRED_UNPACKED_RUNTIME_ENTRIES ~131，presets 路径迁移处 135-137）·`scripts/e2e-install-smoke.mjs`
- 客户端组合：`dsh-plugin-desktop/package.json` dsh.client.inject（client-runtime→client-ui-renderer 改向）·子模块 packages/client 0.1.2-rc.1（a66e470204）
- 恢复窗：`src/startup-recovery-window.ts`（loadFile recovery.html）·`src/native-ui/recovery.html`
- profile 恢复：rg "profile restore|restoreLastKnownGood|healthy profile checkpoints|checkpoints" src/（main.ts「startup diagnostics saved before profile restore」触发链）；`.dsh-market-tarballs` 引用：company-market-install.ts/desktop-market.ts
- boot 剔除：`src/boot-verification.ts`（rejected→disabled merge）·`src/profile.ts` prepareDesktopProfile（~908）·loader include 清单改写点（rg "include" profile.ts/company-market-install.ts）

## 3. Conventions & constraints

- 红线不动：子模块内容绝不改（补丁可以，pin 不动）；锁定层/policy/门语义不弱化。
- **打包态验证必须真做**：修复后 `corepack yarn build`（或等价）产本地包→asar 取证管道抽查关键落位（client 组合/recovery.html/native-ui 清单）——教训就是解包态门禁盖不住；允许 worker 本地构建（**不推 CI 不发版**）。
- 雷C 语义改动先在报告里给设计（检查点策略三选项+推荐）再动手。
- edit 工具；vitest/typecheck timeout 900；desktop 基线 2052+7skip、market 441；不 push。
- 两个 commit 分离：`fix(desktop): packaged client composition + recovery window for 0.1.2`（雷A+B）；`fix(desktop): boot rejection excludes loader entries + checkpoint restore hygiene`（雷C+D）。

## 4. Decisions made & failed attempts

- #73 不修不重发——直接在 master 上修出 #74。
- 用户机已回 b72（现场恢复，勿再动用户机）。
- 事故台账入 devlog（第六次单测绿打包死：解包门禁的系统性盲区=client asar 组合/asarUnpack 落位，verify-packaged-runtime 需扩面）。
- fleet 冻结 b72 直至 #74 打包态验证+真机过。

## 5. Acceptance criteria

- 雷A：asar 抽查 client 注入组合逐项落位+新 packaged 冒烟（或扩 verify-packaged-runtime 断言）钉死；报告含根因一句话。
- 雷B：recovery.html（及五窗 native-ui 全集）asarUnpack 落位断言+修复。
- 雷C：设计段+实现：回滚不删 tarballs/不复活卸载/失败链不再半残；测试覆盖三场景。
- 雷D：拒绝（含 unresolved）→loader include 剔除；坏插件只禁自己不炸树；测试红绿。
- 全量门禁绿+本地打包 asar 抽查通过。
