# DSH Company Skills

[English](README.md)

DSH Company Skills 是把一批公司常用 skill 作为**一个混淆 bundle** 分发、并通过 DeepSeek Harness
skill registry 接缝发布出去的容器插件。它是 P6 批②/③的交付物：批①定义并写出 bundle 格式
（`tools/company-skills`），本包负责读，批③加零明文脚本执行通道，批④收编首批真实 skill。

> **当前状态：已装载首批真实收编 skill（批④）。** asset 里装的是 `ppt-designer` 与 `skill-creator` ——从
> skills hub **只读**收编到 `skills/`（见 `scripts/collect-skills.mjs`）后重新打包进 `assets/skills.bundle`。
> 收编**逐字保留源 skill 根的布局**（`editor/`、`reference/`、`pptd-template/`、`scripts/`、`SKILL.md`），
> 所以 staged 树精确重建原 skill 目录。
> 两个 fixture skill 退回 `fixtures/` 作为纯测试面，不再随包发布。

## 它是什么

一个 Cordis 插件、一个 provider、三个面向模型的工具：

- **插件** `company-skills`：模块初始化时读取并解密 `assets/skills.bundle` 一次，然后通过 skill registry
  接缝注册一个 provider。
- **Provider** `company-skills`：`list()` 只返回解密后的索引（name、description、rank、opaque locator），
  **绝不返回正文**；`get()` 才校验并物化 locator 指向的那一个 skill。
- **工具** `company_skill_run`：执行某个已声明的 `scripts/…` 条目——每次运行把整个 skill（scripts+assets）按各自相对路径物化进一个私有
  `mkdtemp` 目录（POSIX 上根目录 0700、条目目录默认 0755、文件 0600；Windows 上 `mode` 基本无效）、从那里执行、结算即在 `finally` 里删除，明文**不留驻**
  （见[脚本执行通道](#脚本执行通道staged按运行物化通道)）。
- **工具** `company_skill_read`：按精确 bundle 路径解码一个随包文本资源（`reference/pptd.md`、`references/workflows.md`）并以文本返回。这是这些资源唯一的文本通道：bundle 对工作区不透明，`read`/`bash` 看不到任何东西。被寻址条目只在调用期间物化，`finally` 即删；二进制与超限条目直接拒绝（见[读取资源](#读取资源不透明文本通道)）。
- **工具** `company_skill_list`：列出一个 skill 携带的条目路径，只含名字，可用 bundle 根相对的 `path` 前缀收窄。它补的是发现缺口：模型无法枚举不透明的 bundle，猜出来的路径（如 `reference/design_system/finance/investment/design.md`）在 `company_skill_read` 里和拼写错误一样拒绝。列目录永不解码、不物化任何条目；无匹配前缀返回正常的空清单——试探本就是发现的方式。用法教成先 list 再 read（见[发现资源](#发现资源只含名字的清单)）。
- **优先级**：每个 skill 都报 `source: 'bundled'` 与 `BUNDLED_SKILL_RANK`（600），即打包根 rank。
  同名时项目级（`.dsh/skills`、`.agents/skills`）与用户级（`$DSH_HOME/skills`、`~/.agents/skills`）
  skill 依然胜出：公司目录始终可用，但绝不会悄悄覆盖仓库或用户明确写下的 skill。
- **resourceBase**：`{ kind: 'opaque', description: … }`。引用的脚本与资源随插件走，不在本地磁盘上，
  所以上游 loader 渲染的是 opaque 提示而不是目录或 URL，现有消费方零改动；提示里点名了三个公司-skill 工具，
  因为它们是够到这些资源的唯一途径。正文永不截断
  （只有 catalog description 受 catalog 自己的 500 字符上限约束，打包器已前置强制）。

## 注册接缝

```ts
export const inject = ['skills']

export function apply(ctx: Context): void {
  const provider = createProvider(catalog, (message) => { ctx.logger.warn(message) })
  ctx.inject(['skills'], (inner) => {
    inner.effect(() => inner.skills.registerProvider(() => provider))
  })
  ctx.inject(['tools', 'subprocess'], (inner) => {
    const executor = createScriptExecutor({ catalog, spawn: (spec) => inner.subprocess.spawn(spec) })
    inner.effect(() => inner.tools.register(createCompanySkillRunTool(executor)))
    inner.effect(() => inner.tools.register(createCompanySkillReadTool(executor)))
    inner.effect(() => inner.tools.register(createCompanySkillListTool(executor)))
  })
}
```

插件 fiber 里裸读 `ctx.skills` 会抛（Cordis 反射上下文下为
`cannot get property "skills" without inject`）—— 这是真实第三方插件踩过并记录在
`tools/company-catalog/plugin-sources/dsh-dai-engramory-0.2.4/README.md` 的失败模式。直接在
`apply()` 里注册虽然能跑，但会把注册绑在插件自己的 fiber 上，而不是一个可丢弃的子 fiber；
子 fiber 的 `effect()` 持有生命周期，所以卸载插件会注销 provider 并使 catalog 缓存失效。

`tests/provider.spec.ts` 把两半都钉住：裸读确实会抛，且插件源码里是 `ctx.inject(['skills'], …)` 形态、
不存在直接的 `ctx.skills.` 用法。工具走同一个反应式形态（`['tools', 'subprocess']`），所以没有这两个服务的
profile 依然能拿到 provider，等服务后挂载时再自动拿到工具。

## 脚本执行通道：staged（按运行物化）通道

`company_skill_run` 是执行 bundle 里 `scripts/…` 条目的唯一入口。引擎（`src/execute.ts`）刻意不依赖桌面：它按
`DSH_DESKTOP_NODE_EXECUTABLE` / `DSH_DESKTOP_PYTHON_EXECUTABLE`（桌面在运行时发布的绝对命令）→ 子进程
`PATH` → 宿主可执行文件自身（仅 Node：`process.execPath` 配 `ELECTRON_RUN_AS_NODE=1`，CLI 宿主即 node，
桌面宿主即 Electron-as-node）的顺序解析解释器，并通过宿主的 `ctx.subprocess.spawn` 接缝 spawn。因此打包后的
Windows 机器即使 `PATH` 上只有 shell-less spawn 跑不了的 `.cmd` 垫片，也能跑 `.mjs` 与 `.py` 脚本。

- **参数**：`skill`（公司 skill 名）、`script`（bundle 根相对路径，必须**恰好等于该 skill 自己的**某个
  `scripts[]` 路径，如 `scripts/export_pptx.py`）、可选 `args`（额外 argv，原样追加在物化后的脚本路径之后）。
- **物化**：所有 `scripts[]` 与 `assets[]` 条目在内存解码后按**各自相对路径**物化进同一个私有按运行目录
  （`$TMPDIR/dsh-skill-assets-*`），代表 skill 根：`scripts/export_pptx.py` 落在
  `<dir>/scripts/export_pptx.py`、`reference/pptd.md` 落在 `<dir>/reference/pptd.md`、
  `editor/index.html` 落在 `<dir>/editor/index.html`。解释器直接指向物化文件
  （`argv = [<解释器>, <dir>/scripts/export_pptx.py, …]`），子进程 `cwd` 即该根，并以 `DSH_SKILL_ASSETS` 发布给子进程。
  运行一结束（超时、取消、失败同样）就在 `finally` 里整目录删除——**明文不留驻**；
  物化失败也先把半成品目录删干净再报错。落盘权限实测而非假设：`mkdtemp` 在 POSIX 上把根建为 0700，逐条目创建的嵌套目录按进程 umask 默认 0755，
  每个文件写 0600；Windows 基本忽略 `mode`，那里的保证是「私有目录 + `finally` 即删」。清理失败（Windows 上刚退出的子进程可能仍持有句柄而报 EPERM）只记
  warning，绝不改变已结算的结果；warning 回调自身抛错也会被吞掉，不会顶掉已结算结果。
- **为什么物化而不是 stdin 管道**：这是上游 `code-runtime-python` 范式，正是让收编来的 skill **免改动**可跑的关键——
  `__file__` 定位 skill 根（`Path(__file__).parent.parent`，ppt-designer 的 `export_pptx.py` 就是这么算的）、
  兄弟 import 走 `sys.path[0]`、bundle 相对引用（`reference/pptd.md`、`editor/index.html`）按 cwd 直接解析。
  瞬时落盘的暴露面与旧管道实质同等（同样短生命周期、同样私有目录），这是 P6 已签收的红线：**明文不留驻**。
- **解释器**：按扩展名选择解释器家族（`.mjs`/`.js` → Node，`.py` → Python）并按上述顺序解析；解析不到在
  spawn 前以清晰错误拒绝，非法 UTF-8 脚本也拒绝而不是有损解码；其它扩展名在 spawn 之前就拒掉。
- **寻址**：`script` 与已校验的 bundle 条目做精确相等比较，绝不拼进文件系统路径，所以 `../`、绝对路径、
  未声明名字都在 spawn 之前拒掉；解释器真正执行的就是 `<staged>/<同名路径>`。非法 UTF-8 脚本在物化前就拒（收编 skill 在 `scripts/` 下合法地带一个非文本二进制——ppt-designer 的 WASM writer——但只有被寻址的条目必须是文本）。
- **边界**：每条流只保留有界尾部（默认 64 KiB，溢出报 `truncated`），每次运行有独立的 120 s 死线并与调用方
  signal 融合，同一会话最多 1 个运行在飞。所有拒绝都是 `SkillRunError`，只含 skill 名与脚本路径——正文一个字节
  也不进消息、warning 或结算结果。
- **返回**：`{ skill, script, exitCode, stdout, stderr, stdoutTruncated, stderrTruncated }`；非零退出码是数据，
  不是抛出的错误。

### 读取资源：不透明文本通道

`company_skill_read` 用来加载 bundle 里携带的资源，因为上游消费方只渲染 `resourceBase` 提示——工作区 `read`、
`bash` 一概看不到。它的 `path` 必须精确等于某个携带条目（`reference/pptd.md`、`references/workflows.md`、
`editor/index.html`，或某个 `scripts/…` 条目）；比较是精确相等而非路径拼接，所以 `../`、绝对路径、未声明名字
都会拒绝。被寻址条目物化到同一 staging 根下的私有目录，读回 UTF-8 文本，`finally` 里删除该目录，资源同样不留驻。

### 发现资源：只含名字的清单

`company_skill_list` 补上 `company_skill_read` 精确匹配规则留下的发现缺口：skill 正文常常指向目录（「列出 `reference/design_system/<category>/` 下的预设」），没有清单时模型只能猜名字。`path` 是 bundle 根相对前缀（`/reference/design_system` 与 `reference/design_system/` 都指向 `reference/design_system`）；返回该前缀下排序后的携带路径加一行计数，仅此而已——没有大小、没有字节、不物化任何东西。空结果是正常答案，不是错误。

- **参数**：`skill`、`path`（精确携带条目）、可选 `maxBytes`。
- **边界**：超过读取上限的条目（默认 256 KiB，单次可用 `maxBytes` 上调）直接拒绝而不截断；二进制条目（非法
  UTF-8）拒绝；两种拒绝都只含 skill 名与路径，绝不含正文一个字节。
- **返回**：`{ skill, path, text, bytes }`。

「不留驻」由 `tests/execute.spec.ts` 断言：脚本证明自己确实从物化文件运行（从磁盘读自己的源码），`__file__`
定位根与 Python 兄弟 import 真跑真验，运行一结算 staged 根即消失、临时根为空。`tests/tool.spec.ts` 再把制品里的
`fixture-hello/scripts/hello.mjs` 经真实插件接线端到端跑一遍。

## bundle 格式

`assets/skills.bundle` 是单块 XOR+base64（即 `tools/company-skills/lib/codec.mjs` 的 codec），
解密后的文档是**容器**：

```jsonc
{
  "version": 1,
  "skills": [
    { "name": "…", "description": "…", "body": "…",
      "scripts": [{ "path": "scripts/run.mjs", "content": "<base64>" }],
      "assets":  [{ "path": "reference/pptd.md", "content": "<base64>" }] }
  ]
}
```

- 每个元素恰好是一个批① skill bundle。
- 外层规则对齐写侧 `validateContainer`：只接受 version 1、顶层恰好 `version` 与 `skills`、
  至少一个 skill、skill 名唯一、规范化 JSON ≤ 128 MiB（= 2 × 单 skill 64 MiB；本制品实测 ≈ 43 MiB）。
- 元素规则对齐 `validateBundle`：字段集合精确、kebab-case 名称、单行且 ≤ 500 字符的 description
  （catalog 截断口径）、非空 body、条目为按**源 skill 相对位置**键控的 bundle 根相对 POSIX 路径——
  `scripts[]` 是可执行寻址索引（`scripts/` 之下），`assets[]` 携带其余全部条目且保持各自路径
  （`editor/index.html`、`reference/pptd.md`、`LICENSE.txt`），允许嵌套目录——content 为规范 base64 且单文件 ≤ 8 MiB。
- 解码器同时接受两种产物形态：裸 base64 asset 或 `pack.mjs` 生成的模块。
- 运行期**故意不**复查引用闭包：那是打包器在写 blob 前强制的作者侧不变式，在这里重推只会多一处
  两套实现可以互相分歧的地方。

插件内的解码器是**独立实现**：绝不 import `tools/`。`tests/container.spec.ts` 补上这条缝——它用真实
打包器 CLI 打包 fixtures，用本包解码器解密产物，断言解出的元素与打包器的规范化文档逐字节一致，
并能还原出与 fixture 目录逐字节相同的源码树。

## 加载策略：坏 asset 绝不炸宿主

缺失、不可读、损坏、空、或版本超前的 asset 一律**退化为带原因的空目录**，绝不抛异常。因此模块可以在
任何 profile 上被 import 并注册 provider，哪怕它的 asset 已丢失或被篡改：插件 import 期抛异常会让整个
profile 组合失败，那比空目录糟得多。退化后 `list()` 返回空、`get()` 返回 `undefined`，而这正是 registry
对「无货 provider」已有的处理方式。

原因随 catalog 走，而不在 import 期打日志（那时还没有 context logger）；provider 在第一次 `list()` 时
记一次，每个装不出来的 skill 各记一次。容器内部是**逐 skill** 切的：索引在加载期校验，payload 在 `get()`
校验。payload 损坏的 skill 照样出现在索引里，只是拒绝加载——一个坏 skill 不能清空整个目录。单块 XOR 解完
后字节必然全在内存（块不可分割），所以这里的「按需」指**按需物化**：调用方点名之前，没有任何 body、
script、asset 被解析、校验或交给 registry。

## 打包与发布面

- `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`；补丁只 insert 一行
  （`id: company-skills`、`name: dsh-company-skills`）且不带 config —— 加 skill 是重新打包 asset，
  不是改组合。
- `files` 白名单只发 `assets/skills.bundle`，**不含任何明文**。`fixtures/**`、`tests/**`、`scripts/**`
  都被排除，且有测试断言白名单里没有任何条目命中这三个目录下的文件（复用批①的发布面匹配器），
  所以未来改 `files` 不会悄悄开始发布 skill 源码。
- 只发训练后的产物：`lib/**`（tsdown bundle 加 `tsc` 声明）、asset、补丁、许可证与本双语文档。

## 安全定位

混淆**不是**加密。XOR key 是随包常量，它挡的只是明文 grep、asset 上的 `strings`、以及随手翻 profile
目录的人；挡不住会读 shipped JS 的人。本批接受的底线是「让普通用户的明文**不留驻**」（脚本/资源允许瞬时落盘于
私有 `mkdtemp` 目录——POSIX 上根 0700、文件 0600，Windows 忽略 mode——`finally` 即删），共享单一固定 key
的缺口与升级路径（每-skill 派生 key，或非对称包装）已记录并签收在 `tools/company-skills/README.zh.md`。

两条 P6 已签收的残余披露在这里原样适用：skill 的 `description` 进 catalog、`body` 加载后进会话历史——
从那一刻起就是明文。

## 命令

```bash
corepack yarn workspace dsh-company-skills build          # tsdown bundle + tsc 声明
corepack yarn workspace dsh-company-skills typecheck
corepack yarn workspace dsh-company-skills test           # vitest，70 个用例
corepack yarn workspace dsh-company-skills verify:bundle  # assets/skills.bundle 与 skills/ 一致
corepack yarn workspace dsh-company-skills check          # build + verify + typecheck + test

# 刷新收编副本（对 skills hub 只读），若 SKILL.md 有变需手工重加 ppt-designer 的 description 裁剪，再重新生成：
node dsh-company-skills/scripts/collect-skills.mjs
node dsh-company-skills/scripts/build-bundle-asset.mjs
```

生成器是批①打包器的一层薄包装（`tools/company-skills/pack.mjs --skills dsh-company-skills/skills
--out assets/skills.bundle`），所以写侧仍只有一处实现，本包只拥有读侧。它确定性：无时间戳、容器按名排序，
因此 `--check` 就是纯字节比较，CI 无密钥也能跑。打包器的悬空引用 lint（收编 skill 的散文会提到示例路径）
在 stderr 报警告，绝不阻断产物。

## 测试

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/container.spec.ts` | 11 | codec 常量与打包器一致；制品 asset 解出每个收编 skill 一条索引（含 description 与明文源一致）；打包器→解码器交叉一致（规范化文档与源码树均逐字节）；裸 blob 与生成模块两种形态；确定性（含制品 = skills/ 根重打包逐字节）；制品无明文（附解码反向对照 + 4.9 MiB 字体表字节数对照）且发布的插件文件也无明文；坏 frame / 坏元素与打包器同拒；发布面白名单（含 skills/） |
| `tests/collected-layout.spec.ts` | 3 | 收编 bundle 按源相对路径键控条目（`editor/index.html`、`reference/pptd.md`、`pptd-template/…`、`LICENSE.txt`）且无合成 `assets/` 前缀；真实收编的 `scripts/export_pptx.py` 作为兄弟模块 import 后，用它自己的 `resolve_editor_root()` 解析出 `<staged>/editor/index.html` |
| `tests/collect.spec.ts` | 3 | 收编器的 skill 名闸（只允许 kebab-case；`..`、路径分隔符、绝对路径一律拒，使 `rmSync` 永远出不了 `skills/`）；参数解析；逐字布局复制并剪掉 `__pycache__` |
| `tests/provider.spec.ts` | 11 | `inject(['skills'])` 反应式注册与随插件卸载；注册表后挂载；裸 `ctx.skills` 抛；源码形态钉测；`list()` 仅索引（无正文、无 `content`）；`get()` 只物化一个正文；未知名与不可用 locator；payload 损坏仍可列但拒载；asset 缺失/损坏退化不抛；退化目录在活宿主上；模块导出 |
| `tests/execute.spec.ts` | 36 | 解释器选择与解析（注入命令 → PATH → 宿主可执行文件）；真实物化 `node` 运行（输出、args 透传、非零退出当数据、脚本从磁盘读到自身源码）；code-runtime-python 范式真跑（`__file__` 定位根等于 staged 根与 `DSH_SKILL_ASSETS`、Python 兄弟 import 走 `sys.path[0]`、cwd 相对资产读取）；资源读取（嵌套文本条目、`scripts/` 条目、单条目私有 staging 在 `finally` 删除、未知/穿越路径与未知 skill 不物化、超限拒绝、二进制拒绝、非法上限）；不留驻（结算后 staged 根消失、临时根为空、结果不含正文 canary、清理失败或 warning 回调抛错都只记 warning）；未知 skill / 未声明脚本 / 路径穿越 / 无解释器 / 非法 UTF-8 均在 spawn 前拒绝且无残留；死线、输出尾部截断、调用方取消、启动抛错均清理 staged 根；会话并发上限与槽位释放；接缝透传（物化 argv、staged cwd、env、grace、signal） |
| `tests/tool.spec.ts` | 6 | 两个工具的 schema、输出形状、预算与 `presentCall`；从执行上下文解析 session/signal；render 与 `toRunValue`；读取工具的参数与转交；在 tools 接缝上的反应式注册与卸载；制品 fixture 脚本经真实插件端到端运行并清理 staged 根 |

红绿证（本批实测）：

- 把 `apply()` 里的 inject 子 fiber 换成直接 `ctx.skills.registerProvider()` → **红**：
  `expect(source).not.toMatch(/\bctx\.skills\./)`。（运行期用例仍绿，因为静态 `inject` 声明能解析出服务；
  真正拦住这个捷径的就是这条形态钉测。）
- 把容器文档本身写进 `assets/skills.bundle`（即明文发布）→ **红**：
  `artifact.includes('# Fixture hello')` 报 `expected false, received true`。
- 去掉读 asset 的 `try/catch` → **红**：退化用例以 `ENOENT` 失败，而不是空目录。
- 改解码器的 key 字符串 → **红**：打包器→解码器交叉一致用例立刻失败。
- 把物化执行改回 `[解释器, '-']` 走 stdin 管道 → **红**：范式用例报 `OWN-SOURCE-READ=false`、`__file__` 定位根
  比对失败（管道脚本没有真实路径）。
- 去掉 staged 目录的 `finally` 清理 → **红**：结算、超时、取消、启动抛错用例都留下非空的临时根目录。
- 取 bundle 首个条目代替按声明路径匹配 `script` → **红**：所有穿越/未声明名字用例开始 spawn，
  `carries no script` 断言失败。
- 去掉 `AbortSignal`/死线融合、只靠宿主超时 → **红**：执行器的 `timed out after … ms` 与 `was cancelled`
  分类永不触发。
- 忽略 `DSH_DESKTOP_NODE_EXECUTABLE`、直接 spawn PATH 裸名 → **红**：注入命令用例看到的是 `node` 而不是发布
  的绝对路径。
- 让清理 `rm` 的失败逃出 `finally` → **红**：一次清理遇 EPERM 的成功运行被报成失败，而不是返回结果。
- 把非 scripts 条目重新归入 `assets/`（批④的旧做法）→ **红**：`tests/collected-layout.spec.ts` 报
  `EDITOR-INDEX=<staged>/assets/editor/index.html`，收编的 `resolve_editor_root()` 抛 `EDITOR_MISSING_HINT`，正是本批修掉的故障。
- 去掉 `company_skill_read` 或 `company_skill_list` 注册（或它的工具构造器）→ **红**：注册用例期望 `['company_skill_run', 'company_skill_read', 'company_skill_list']`，读取/列运用例失去表面。

## 目录

```
dsh-company-skills/
  src/index.ts          插件：模块初始化读目录 + inject 子 fiber 注册
  src/provider.ts       provider：仅索引的 list()、按需的 get()
  src/catalog.ts        加载策略、索引、逐 skill 物化
  src/container.ts      容器 frame 解码（独立于 tools/）
  src/bundle.ts         单个 skill bundle 的字段规则（独立于 tools/）
  src/codec.ts          XOR+base64 解码器与 key 常量
  src/execute.ts        staged 按运行物化脚本执行器：寻址、物化、边界
  src/tool.ts           company_skill_run / company_skill_read 定义、render、presentCall
  assets/skills.bundle  随包发布的容器块（在 files 里）
  cordis.patch.yml      组合行（在 files 里）
  scripts/              asset 生成器、skill 收编器、clean（永不发布）
  skills/               收编的公司 skill 明文源（永不发布）
  fixtures/             明文 fixture skill，纯测试面（永不发布）
  tests/                vitest 与本地 spawn 接缝（永不发布）
```

## 收编 skill

`skills/` 是本包的发布集，从 skills hub（`/opt/july/skills-hub/skills`，**只读、绝不写入**）收编：

- **ppt-designer**：33 MiB 资源全部随包（离线 neo-ppt 编辑器镜像、Deloitte PPTD 模板、设计参考、
  导出脚本）。其 frontmatter description 在本副本里裁剪到 500 字符 catalog 上限，其余与源逐字节一致。
- **skill-creator**：逐字发布（其 `references/` 指南与上游 Apache-2.0 `LICENSE.txt` 保持各自根相对路径）。

收编逐字保留源 skill 根的布局：`editor/`、`reference/`、`pptd-template/`、`references/`、`scripts/`、
`LICENSE.txt` 与 `SKILL.md` 各自保持相对路径，打包器也按同一路径键控每个 bundle 条目，因此 staged 根精确重建
原 skill 目录（`__file__` 定位根、兄弟 import、`reference/pptd.md` 读取、以及 ppt-designer 的
`SKILL_DIR/editor/index.html` 查找全部免改动可用——批④把它归入合成 `assets/` 前缀、导致该查找失败的做法已移除）。
`__pycache__` 剪枝。上游 `resourceBase: { kind: 'opaque' }` 提示照旧渲染：消费方经 catalog 与两个公司-skill
工具寻址这些 skill，而不是当本地路径读。

## 后续

- 市场链路：handoff（`type: 'skill'`）→ MR → 真机安装验收（市场装 → 两个 skill 出现在 catalog →
  `company_skill_run` 跑通一个收编脚本 → 事后 staged 根消失、磁盘无明文留驻）。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。收编的 `skill-creator` 在其 bundle 内以 `LICENSE.txt`
携带上游 Apache-2.0 许可证。
