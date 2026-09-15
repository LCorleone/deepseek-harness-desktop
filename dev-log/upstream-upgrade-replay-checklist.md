# 上游升级重放点活清单（upstream upgrade replay checklist）

> **活文档：随每次接缝新增更新本清单。** 任何新卡落地时若引入对上游的新接触面（语义补丁、CLI overlay、API 消费、打包钩子、运行时捆绑），同一批必须在此追加一节重放点——评审 checklist 加一项「本文档已更新」。
>
> - **来源**：2026-09-10 全面评审 P2-3（`dev-log/reviews/2026-09-10-comprehensive-review-arch.md:30-31`）——旧清单定格在 lockdown-plan-v2「升级工作量估算」段（2026-09-02），漏了其后新增的 8 类接缝；issue #010，2026-09-15 拍板**只更新文档、零代码改动**。
> - **与旧文档的关系**：`dev-log/2026-08-22-company-market-lockdown-plan-v2.md:233` 的估算段仍是**工作量框架**（批次数/风险分级/顺序铁则）；本文档是**接缝明细权威**。下次升级专项（0.1.5，issue #005，8-12 批）开批前逐项过本文档。
> - **行文约定**：每节四要素=接缝 × 位置（file:line，2026-09-15 用 rg 逐一验证过）× 升级时重放/复验动作 × 已有守卫（无守卫处明确写「无守卫」）。

---

## Step 0 · 升级前 diff 上游 defaults/接触面（先于一切补丁重放，必做）

**动机案例——includeShippedRoot 事故（2026-09-08）**：上游 0.1.2 线在 agent-presets schema 新增 `includeShippedRoot`，zod 默认 **true**；我们的锁定补丁只写 `roots:[公司目录]`（0.1.1 下足以隐藏上游 preset）⇒ shipped 根仍被扫描、不可选 preset 冒进锁定组合。GUI 侧修复（`dsh-plugin-desktop/src/profile.ts:1138-1144` 显式 `includeShippedRoot:false`）后，评审又抓出 **CLI lock overlay 同病**（`dsh-plugin-desktop/src/cli-lock/desktop-cli-lock.patch.yml:78-81` 同键补写）。全程靠一次性人工核查发现，**无系统性守卫**——上游默认值翻转可以静默穿透补丁面。完整档案：`dev-log/2026-08-22-handoff-zcNSeT.md:480`；同型雷的破坏面预警另见 `dev-log/reviews/2026-09-10-comprehensive-review-upstream.md` §2。

**程序**（对上游仓 old→new tag 全量 diff 执行；纪律：对上游只 fetch 不 checkout）：

1. **圈出上游 defaults/接触面变化**：diff 我们补丁与 overlay 触碰的包（`patches/` 下 15 个语义补丁：app-builder-lib + 14 个 `dsh-*@0.1.2-rc.1`），重点扫 schema 新字段与默认值（`z.boolean()/z.object()/…`、`.default(...)`、`default:`）。includeShippedRoot 事故后已人工核过的同型面（inspector / plugin-inventory / subagent-sdk）每轮重核——「上轮不在接触面」不代表本轮不在。
2. **与我方写入面求交集**：我方显式写配置的面 = GUI 锁定层 `dsh-plugin-desktop/src/profile.ts`、CLI overlay `dsh-plugin-desktop/src/cli-lock/desktop-cli-lock.patch.yml`、`dsh-plugin-desktop/src/desktop-policy.ts`。对每个上游新默认问一句：**我们是否显式钉住？** 未钉住 = 行为漂移。
3. **双写面成对核对**：GUI 与 CLI overlay 是同一语义的两处实现，改一处必查另一处（事故教训：GUI 修完 CLI 漏，靠评审兜底）。
4. **产出物**：defaults-diff 清单附到升级专项卡，逐项标注「显式钉住 / 接受新默认 / 需人工判断」；人工判断项不得静默通过。
5. **守卫现状**：**无守卫**（本步是人工程序；这正是它被固化为 Step 0 的原因）。

---

## 重放点清单（P2-3 全部 8 类）

### 1. P11 捆绑 Python（运行时自包含）

- **位置**：
  - `dsh-plugin-desktop/src/desktop-shared-python-environment.ts`（运行期共享 Python 环境解析）
  - `dsh-plugin-desktop/scripts/bundled-python.ts`（get-pip 钉扎：`:63-77` `BUNDLED_PYTHON_GETPIP_URL` + sha256 固定 bytes）
  - `dsh-plugin-desktop/scripts/prepare-bundled-python.ts`、`scripts/prepare-bundled-runtimes.ts`（staging 管线）
  - `dsh-plugin-desktop/package.json:344-345`：`beforePack`=`scripts/prepare-bundled-runtimes.ts`、`afterPack`=`scripts/verify-packaged-runtime.ts`（digest 门禁）
- **升级时重放/复验**：Python 发行版版本升级时重放钉扎+sha256 链；Electron/electron-builder 大版本跳跃后 afterPack digest 门禁必须在新打包链上重跑（`check:win-package` / `check:mac-package` 链尾）；get-pip 上游（bootstrap.pypa.io）换 payload 时重算 sha256。
- **守卫**：`dsh-plugin-desktop/tests/bundled-python.spec.ts`、`tests/desktop-shared-python-environment.spec.ts`、`tests/verify-packaged-runtime.spec.ts`（后两者已编入 `package.json:148-149` 的 win/mac package check 链）。

### 2. P14 generation / pending marker（profile 换新标记）

- **位置**：`dsh-plugin-desktop/src/fresh-profile.ts:55`（`PROFILE_GENERATION_FILENAME`=`last-profile-generation.json`）、`:178`（`FRESH_PROFILE_PENDING_FILENAME`=`fresh-profile-pending.json`）。
- **升级时重放/复验**：核对上游 userData/profile 目录布局与身份语义未变（已知根因面：profileIdentity=路径哈希，评审 P3-5）；marker schema 若随上游变化需迁移复验；**「升级时存在 awaiting-restart WAL/pending marker」的交叉面**（评审 P1-1 建议）需人工演练——现无该面集成测试。
- **守卫**：`dsh-plugin-desktop/tests/fresh-profile.spec.ts`、`tests/fresh-profile-wiring.spec.ts`；升级×pending 交叉面=**无守卫**。

### 3. P15 boot 分类 + runtime 谓词（评审已认可 parity ✓）

- **位置**：
  - `dsh-plugin-desktop/src/boot-verification.ts:182`（`DESKTOP_BOOT_DSH_RUNTIME_VERSION`）、`:1575`（`bootClassificationCandidates`）、`:1598`（`entryAcceptsDshRuntime`——对签名 manifest 的 `runtime.dshRuntimeVersion` range 做 semver 判定）
  - 对偶 pin：`dsh-community-market/src/install/service.ts:50`（`DSH_RUNTIME_VERSION`，安装门槛分类）
  - build identity 客户可见面：`dsh-plugin-desktop/src/desktop-build-version.ts`
- **升级时重放/复验**：升 pin 时**两处 runtime 常量同步改**并跑 parity 测试；boot 分类对 beta overlay 合并后的候选集、新 manifest 字段（如上游 `engines.dsh`）语义复验。
- **守卫**：`scripts/dsh-runtime-version-parity.test.mjs`（repo 根；断言两 pin 相等——P2-3 认可的既有 parity ✓）、`dsh-plugin-desktop/tests/boot-verification.spec.ts`（分类 + dshRuntimeVersion range 断言）。

### 4. P16 pwsh 适配器 + dsh-pip 事前闸

- **位置**：
  - `dsh-plugin-desktop/src/windows-pwsh-sandbox.ts`（Windows ACL sandbox 的 pwsh executor 接线与升权弹窗，`:317` 附近 `electronSandboxEscalationPrompt` 契约）
  - `dsh-plugin-desktop/src/desktop-pip-gate.ts`（`dsh-pip` 事前闸：以 TEMP/TMP 含 `dsh-<6 随机字符>` mkdtemp 形状判定「在 workspace-write 沙箱内」，把 pip 挂死转成即时拒绝；透明 pass-through 语义）
- **升级时重放/复验**：上游 win32-process/sandbox 包结构变化时按源码注释重放 adapter（review-upstream 雷 6：模式枚举 `'read-only'|'workspace-write'|'danger-full-access'` 未动，契约稳）；**沙箱自检判据依赖上游两个实现点**——`packages/sandbox/sandbox-windows-acl/src/runner.ts` 的 TEMP/TMP 重写与 `packages/sandbox/sandbox-local/src/index.ts` 的 `mkdtempSync(join(tmpdir(),'dsh-'))`——上游动这两处必须复验判据仍成立（含已知边界：read-only 模式下 gate 判「沙箱外」直通，源码已诚实标注）。
- **守卫**：`dsh-plugin-desktop/tests/windows-pwsh-sandbox.spec.ts`、`tests/desktop-pip-gate.spec.ts`（均编入 `check:win-package` 链）。

### 5. P6 skills provider 接缝（`inject(['skills'])`）

- **位置**：`dsh-company-skills/src/index.ts:8`（文档化接缝：`ctx.inject(['skills'], inner => inner.effect(() => inner.skills.registerProvider(...)))`——裸读 `ctx.skills` 会抛）、`:64`（实装）；`dsh-company-skills/src/provider.ts`（list/get + `resourceBase:{kind:'opaque'}`）。
- **升级时重放/复验**：上游 skills 子系统 API（`SkillProvider` 形状、`registerProvider` 注册期语义、opaque resourceBase 渲染契约）变化时重对设计——lockdown-plan-v2 P5 状态段早有预警「registerProvider 缝隙若变形需重对并补钉扎测试（同 CLI 钳制先例）」。
- **守卫**：`dsh-company-skills/tests/`（provider / container / execute / tool 等全套行为测试）；**接缝形状本身无钉扎守卫**——上游 API 变形只能靠编译失败+测试重锚暴露（升级批次⑤覆盖），钉扎测试待补。

### 6. P7 tarball 通道（公司市场双通道之一）

- **位置**：
  - 发布侧：`tools/company-catalog/lib/tarball.mjs`（含 symlink 逃逸三层防御：`:133` 起词法快失败 + 创建时 realpath 父目录断言 + 末层 walk）、`lib/tarball-publish.mjs`（`expectedTarballFilename` 一处定义三处共用）
  - 客户端安装链：`dsh-plugin-desktop/src/desktop-market.ts`（tarball 下载→sha512 校验→pnpm add 本地 tarball→装后 treeDigest 复验）、`dsh-plugin-desktop/src/cli-install-channel.ts`（双通道验证器 + `DSH_COMPANY_TARBALL_HANDOFF` 受信交接 env，`:22`）
- **升级时重放/复验**：manifest schema 版本兼容（旧客户端未知键拒收整个 manifest 的 fleet 门禁模式 `--confirm-fleet-upgraded`）；打包/tar 工具链变化后 symlink 逃逸防御复验（PoC 形态全拒）；CLI 锁定 add 闸门不误伤市场通道自己的 `file:` 目标（真机四坑①的回归面）。
- **守卫**：`dsh-plugin-desktop/tests/company-market-tarball.spec.ts`、`tests/company-market-install.spec.ts`、`tools/company-catalog/tests/tarball.test.mjs`（symlink PoC 用例）、market workspace 全量套件（`yarn workspace dsh-community-market test`，含 tarball-channel / signed-manifest-install）。

### 7. P9 beta overlay（beta 频道覆盖层）

- **位置**：
  - `dsh-plugin-desktop/src/beta-channel.ts`（launcher 侧：`COMPANY_BETA_MANIFEST_FILENAME`=`catalog-manifest.beta.json` `:65`、beta tester 匹配 `:103-122`）
  - `dsh-plugin-desktop/src/cli-install-channel.ts`（beta-aware CLI 双通道：roster 机器的 verified beta overlay 携带条目、launcher-staged beta manifest bytes、verified sequence 相等断言）
  - roster 侧：`tools/company-catalog/lib/beta-roster.mjs`（签名 roster，`state/beta-testers.json`）
- **升级时重放/复验**：beta overlay 与 stable manifest 的合并语义、npm 通道条目校验、beta-only 条目的完整安装路径（真机事故面：beta-only 市场安装曾死在 CLI 验证器）。
- **守卫**：`dsh-plugin-desktop/tests/beta-channel.spec.ts`、`tests/cli-install-channel.spec.ts`。

### 8. dshmarket 1.17.1 兼容复验（锁定构建外的上游市场包）

- **位置**：
  - `dsh-plugin-desktop/src/desktop-market.ts:70-73`（`dshMarket` identity，packageName=`dshmarket`）、`:98-103`（锁定构建下上游 dshmarket bundle 被 policy 排除的承重注释）
  - 兼容保障：`patches/dsh-settings@0.1.2-rc.1.patch`（恢复 `installSettingsSection`/`settingsNamespace` legacy 导出——dshmarket 1.17.1 的 `lib/settings.js` 直接 import 这两个 0.1.2 已移除的 API）
  - 结论档案（复验程序模板）：`dev-log/2026-09-08-dshmarket-1.17.1-compat-012.md`
- **升级时重放/复验**（照档案程序重跑专项）：①上游是否动了 dshmarket 的 resolutions 版本；②dsh-settings legacy 恢复补丁是否仍覆盖 1.17.1 的 import 面；③peer 警告复查（1.17.1 peerRange 不含新运行时，resolutions 强制同版本）。
- **守卫**：`yarn workspace dsh-community-market test` 全量（2026-09-08 基线 441 例，覆盖 dshmarket 安装路由/设置持久化）；「dshmarket 在新运行时下的兼容性」**无独立守卫测试**——复验靠本节专项重跑。

---

## 维护规则

1. 新接缝落地（新 P 卡、新补丁、新捆绑运行时、新上游 API 消费）→ 同批在本文档追加一节，四要素齐全；无守卫时如实写「无守卫」，不得留空。
2. 升级专项开批 → Step 0 先行，产出 defaults-diff 清单；然后按 1-8 节逐项重放/复验，逐项在专项卡记结论。
3. 每次更新本文档时顺手复核一遍全部 file:line 锚点（rg 重验）——漂移的锚点按当次 HEAD 修正。
