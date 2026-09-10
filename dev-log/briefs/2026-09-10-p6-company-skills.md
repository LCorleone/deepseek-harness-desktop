# P6「公司 skill 当插件发」— 任务 brief（2026-09-10 解冻，轻防护版）

## 1. 目标与背景
把一批常用 skill（**大部分带脚本**）做成**市场可分发的插件**：安装/更新走现有 allowlist→handoff→CI→sequence 管线，**不用等桌面发版**。防护定位=「防普通用户」：**明文不落盘**即可；Phase 6 原方案的三层重防护（prompt 墙/输出过滤/水印）砍掉。已签收残余：description 索引与 skill 正文进会话历史即明文（同「进上下文即可套话」级别）。

## 2. 代码地图（scout-skill-plugin 2026-09-10 15:00）
- **provider 接缝**：`packages/skill/skill/src/index.ts:212` SkillProvider{name,list,get}、`:265` control{signal,invalidate}、`:347` registerProvider（apply 期同步注册，按 scope 分层）。参考实现 `packages/skill/skill-badge/src/index.ts`（49 行）。**必须 `ctx.inject(['skills'], inner => inner.effect(() => inner.skills.registerProvider(...)))`**——裸读 `ctx.skills` 会抛（先例证据 `plugin-sources/dsh-dai-engramory-0.2.4/README.md:137`、其 `index.js:225`）。
- **resourceBase**：`opaque` 时消费方零改动（`skill/src/index.ts:206-210` 只渲染 hint；`tool-skill/README.md:246`）；正文无截断，仅 catalog description 默认 500（`docs/subsystems/skills.md:230`）。
- **插件形态**：`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`（`profile.ts:501-508`）；**blob 必须进 `files`**（`lib/tarball.mjs:9-13`）；安装落 `$DSH_HOME/profiles/<name>/node_modules`。
- **脚本执行**：`ctx.tools.register(defineTool({name,description,execute,presentCall}))`（`docs/subsystems/tools.md:504`，先例 `extensions/tool-cordis/src/index.ts:44`）+ `ctx.subprocess.spawn({argv,cwd,stdio:{stdin:{data}},graceMs,signal,env})`（`subprocess/subprocess/src/types.ts:64,75`）→ `[node,'-']`/`[python,'-']` 正文走 stdin，**零落盘**。解释器定位：桌面 `resolveDesktopNodeExecutable()`（`desktop-node-runtime.ts:277`）、`resolveDesktopPythonExecutable()`（`desktop-python-runtime.ts:387`）。**该通道不经沙箱**（`subprocess-local/src/index.ts:146`）→ 不受写限制；仅 read-only 沙箱模式才需临时目录/弹窗。
- **密钥先例**：`dsh-plugin-desktop/scripts/make-model-gateway-blob.mjs`（固定混淆 key + 明文仅经 env → 生成 `src/model-gateway-blob.ts` 并提交；生成器不进 CI 自动链）。同样先例：sso-app-key / usage-report。
- **分发链**：零管线改动即可承载带 blob 插件；`plugin.type` 的 11 枚举**已含 `skill`**（`docs/handoff/README.zh.md:45`）。

## 3. 约定与约束
- 不改 deepseek-harness 子模块；插件与打包脚本放我们仓（`tools/company-catalog/plugin-sources/` + 新打包脚本）。
- bundle 最小设计：`{name, description(脱敏), body, scripts[], assets[]}` → 单块 XOR+base64 落 `assets/` 或 `lib/`（**进 files**）；打包脚本在作者/我们机器上跑（读目录→校验→加密→写 blob 模块）。
- **日志/缓存/临时文件不得出现明文正文**（落盘即失效）。
- 密钥缺口须写明：现有先例是全体共享单一固定 key → 任一副本可解他人 bundle；本批先接受（与「防普通用户」定位一致），**设计文档里明示**，后续可升级每-skill 派生 key。
- opaque 下相对路径读文件：优先内存传参；退路=落 workspace 临时目录用后即删（workspace-write 下可行，无需弹窗）。

## 4. 已做决策与失败尝试

- **批④ 决策（2026-09-10 20:19，July 拍板）**：首批装 **skill-creator + ppt-designer** 两个。
  · **源路径只读**：/opt/july/skills-hub/skills/{ppt-designer,skill-creator} **严禁修改**——打包=只读复制，适配一律在我们仓侧。
  · **红线放宽**：「明文不落盘」→「明文不留驻」：脚本/资源允许瞬时落盘于 0600 mkdtemp、finally 即删（与 stdin 管道实质同等暴露面；依据=上游 code-runtime-python 范式，调研见 devlog 2026-09-10 夜间补记）。
  · **执行改型（code-runtime-python 范式）**：execute.ts 从 stdin 管道改为**物化执行**——把 bundle 的 scripts+assets 全部物化进同一个 per-run 0600 临时目录，`argv=[解释器, <tmp>/scripts/xxx.py]`、cwd=临时根。收益：`__file__` 定位 skill 根天然工作（export_pptx.py:38 无需改动）、兄弟 import 走 sys.path[0] 天然工作（package_skill.py 无需改动）、`OPEN_KIMI_PPT_EDITOR` 可不改 skill 直接指 staged 目录。旧 stdin 路径删除，错误信息仍不得含脚本正文。
  · **剪枝补丁**：pack 剪枝清单加 `__pycache__`（skill-creator 带着 cpython-310 的 .pyc，我们是 3.12）。
  · **agent-browser/Chrome 降级可选**：pptx 导出本体走本地 WASM 不依赖；不预装、不改动。
  · **PyYAML 依赖**：skill-creator 的 quick_validate 要 yaml——不预装，agent 首次可走 dsh-pip 授权装共享 pyenv（P16 链）。
  · 插件条目 description（必填闸）：`公司技能包：skill 创建指南与 PPT 设计器（PPTD）`。
- 路线 B（原生 provider）已裁决（2026-09-02 scout-skill-seam），路线 A（自造 load 工具）否决。
- 2026-09-02 用户曾把 P6 整体搁置；2026-09-10 因「想内置常用 skill + 防普通用户」解冻，**砍 P6-3 三层重防护**，保留 P6-1（加密 bundle 插件）+ P6-2（脚本通道）。
- 无失败尝试记录。

## 5. 分四批与验收
- **批①（S）bundle 格式 + 打包/校验脚本 + key 策略**：`tools/company-skills/pack.mjs`（读 skill 目录 → 校验（名称 kebab-case、description 长度、脚本声明）→ 加密 → 写 blob 模块/文件）+ `unpack.mjs`（作者自查/CI 校验，禁止进产物）＋格式文档；测试：往返（pack→unpack 逐字节一致）、名称/大小/缺字段拒、blob 无明文断言（grep 原始 markdown 关键句不在产物里）、确定性（同输入同字节）。零客户端改动。
- **批②（M）容器插件 `company-skills`**：`cordis.patch.yml` insert + `inject(['skills'])` → `registerProvider`（list 解密索引/get 内存解全文/resourceBase opaque）；`package.json.dsh.bundle.patch` + files 白名单；测试：registerProvider 接缝钉测、list/get 行为、opaque resourceBase、`ctx.skills` 裸读反例（应抛）。
- **批③（M）脚本执行工具**：`ctx.tools.register` + `ctx.subprocess.spawn` stdin 管道；node/python 解释器定位（优先客户端捆绑，回退 PATH）；workspace-write 下零落盘实测；read-only 下退路设计。
- **批④（S-M）首批 3-5 skill 收编**：`plugin-sources/` 落位 + handoff（`type: 'skill'`）+ MR 流程 + 真机安装验收（市场装 → skill 目录出现 → 脚本可跑 → 明文不在磁盘上）。

每批独立 review。
