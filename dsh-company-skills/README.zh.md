# DSH Company Skills

[English](README.md)

DSH Company Skills 是把一批公司常用 skill 作为**一个混淆 bundle** 分发、并通过 DeepSeek Harness
skill registry 接缝发布出去的容器插件。它是 P6 批②/③的交付物：批①定义并写出 bundle 格式
（`tools/company-skills`），本包负责读，批③加零明文脚本执行通道，批④收编首批真实 skill。

> **当前状态：以占位容器形态落地。** asset 里装的是两个 fixture skill（`fixture-hello`、
> `fixture-notes`），所以本包无密钥也能构建、typecheck、测试。真实容器在批④重新打包，包内其余部分不变。

## 它是什么

一个 Cordis 插件、一个 provider、一个面向模型的工具：

- **插件** `company-skills`：模块初始化时读取并解密 `assets/skills.bundle` 一次，然后通过 skill registry
  接缝注册一个 provider。
- **Provider** `company-skills`：`list()` 只返回解密后的索引（name、description、rank、opaque locator），
  **绝不返回正文**；`get()` 才校验并物化 locator 指向的那一个 skill。
- **工具** `company_skill_run`：执行某个已声明的 `scripts/…` 条目，脚本正文经解释器 **stdin** 送达，
  因此字节被真正执行却从不落盘（见[脚本执行通道](#脚本执行通道零明文通道)）。
- **优先级**：每个 skill 都报 `source: 'bundled'` 与 `BUNDLED_SKILL_RANK`（600），即打包根 rank。
  同名时项目级（`.dsh/skills`、`.agents/skills`）与用户级（`$DSH_HOME/skills`、`~/.agents/skills`）
  skill 依然胜出：公司目录始终可用，但绝不会悄悄覆盖仓库或用户明确写下的 skill。
- **resourceBase**：`{ kind: 'opaque', description: … }`。引用的脚本与资产随插件走，不在本地磁盘上，
  所以上游 loader 渲染的是 opaque 提示而不是目录或 URL，现有消费方零改动。正文永不截断
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

## 脚本执行通道：零明文通道

`company_skill_run` 是执行 bundle 里 `scripts/…` 条目的唯一入口。引擎（`src/execute.ts`）刻意不依赖桌面：它按
`DSH_DESKTOP_NODE_EXECUTABLE` / `DSH_DESKTOP_PYTHON_EXECUTABLE`（桌面在运行时发布的绝对命令）→ 子进程
`PATH` → 宿主可执行文件自身（仅 Node：`process.execPath` 配 `ELECTRON_RUN_AS_NODE=1`，CLI 宿主即 node，
桌面宿主即 Electron-as-node）的顺序解析解释器，并通过宿主的 `ctx.subprocess.spawn` 接缝 spawn。因此打包后的
Windows 机器即使 `PATH` 上只有 shell-less spawn 跑不了的 `.cmd` 垫片，也能跑 `.mjs` 与 `.py` 脚本。

- **参数**：`skill`（公司 skill 名）、`script`（bundle 根相对路径，必须**恰好等于该 skill 自己的**某个
  `scripts[]` 路径，如 `scripts/report.mjs`）、可选 `args`（额外 argv，原样追加在解释器的 `-` 脚本标记之后）。
- **送达**：解密后的脚本正文写入子进程 **stdin**（`node -` / `python -`）；绝不写入文件，也绝不出现在日志、
  遥测事件或错误信息里。Node 的 stdin 模块探测让 `require` 与 `import` 两种写法都能跑。
- **解释器**：按扩展名选择解释器家族（`.mjs`/`.js` → Node，`.py` → Python）并按上述顺序解析；解析不到在
  spawn 前以清晰错误拒绝，非法 UTF-8 正文也拒绝而不是有损解码；其它扩展名在 spawn 之前就拒掉。
- **寻址**：`script` 与已校验的 bundle 条目做精确相等比较，绝不拼进文件系统路径，所以 `../`、绝对路径、
  未声明名字都在 spawn 之前拒掉。
- **资产**：skill 带 assets 时，解到一个私有 `mkdtemp` 目录（`$TMPDIR/dsh-skill-assets-*`）代表 bundle 根
  （`assets/notes.md` → `<dir>/assets/notes.md`），以 `DSH_SKILL_ASSETS` 传给子进程，并在运行一结束就于
  `finally` 里删除——超时、取消、失败同样删除。清理失败（Windows 上刚退出的子进程可能仍持有句柄而报
  EPERM）只记 warning，绝不改变已结算的结果。无 assets 的 skill 不建目录，也不设该环境变量。
- **边界**：每条流只保留有界尾部（默认 64 KiB，溢出报 `truncated`），每次运行有独立的 120 s 死线并与调用方
  signal 融合，同一会话最多 1 个运行在飞。所有拒绝都是 `SkillRunError`，只含 skill 名与脚本路径。
- **返回**：`{ skill, script, exitCode, stdout, stderr, stdoutTruncated, stderrTruncated }`；非零退出码是数据，
  不是抛出的错误。

零落盘保证由脚本自己在 `tests/execute.spec.ts` 里断言：测试脚本在运行期间遍历临时根目录，以及（被固定的）
默认临时根的顶层，统计含自身源码 canary 的文件数，必须是 `0`。`tests/tool.spec.ts` 再把制品里的
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
      "assets":  [{ "path": "assets/notes.md", "content": "<base64>" }] }
  ]
}
```

- 每个元素恰好是一个批① skill bundle。
- 外层规则对齐写侧 `validateContainer`：只接受 version 1、顶层恰好 `version` 与 `skills`、
  至少一个 skill、skill 名唯一、规范化 JSON ≤ 16 MiB。
- 元素规则对齐 `validateBundle`：字段集合精确、kebab-case 名称、单行且 ≤ 500 字符的 description
  （catalog 截断口径）、非空 body、条目为 bundle 根相对的 POSIX 路径且分别位于 `scripts/`、`assets/`
  之下、content 为规范 base64。
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
目录的人；挡不住会读 shipped JS 的人。本批接受的底线是「让普通用户的明文不落盘」，共享单一固定 key
的缺口与升级路径（每-skill 派生 key，或非对称包装）已记录并签收在 `tools/company-skills/README.zh.md`。

两条 P6 已签收的残余披露在这里原样适用：skill 的 `description` 进 catalog、`body` 加载后进会话历史——
从那一刻起就是明文。

## 命令

```bash
corepack yarn workspace dsh-company-skills build          # tsdown bundle + tsc 声明
corepack yarn workspace dsh-company-skills typecheck
corepack yarn workspace dsh-company-skills test           # vitest，50 个用例
corepack yarn workspace dsh-company-skills verify:bundle  # assets/skills.bundle 与 fixtures/ 一致
corepack yarn workspace dsh-company-skills check          # build + verify + typecheck + test

# 改完 fixtures/（批④换成真实 skill）后重新生成制品 asset
node dsh-company-skills/scripts/build-bundle-asset.mjs
```

生成器是批①打包器的一层薄包装（`tools/company-skills/pack.mjs --skills dsh-company-skills/fixtures
--out assets/skills.bundle`），所以写侧仍只有一处实现，本包只拥有读侧。它确定性：无时间戳、容器按名排序，
因此 `--check` 就是纯字节比较，CI 无密钥也能跑。

## 测试

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/container.spec.ts` | 11 | codec 常量与打包器一致；制品 asset 解出每个 fixture 一条索引；打包器→解码器交叉一致（规范化文档与源码树均逐字节）；裸 blob 与生成模块两种形态；确定性；制品无明文（附解码反向对照）且发布的插件文件也无明文；坏 frame / 坏元素与打包器同拒；发布面白名单 |
| `tests/provider.spec.ts` | 11 | `inject(['skills'])` 反应式注册与随插件卸载；注册表后挂载；裸 `ctx.skills` 抛；源码形态钉测；`list()` 仅索引（无正文、无 `content`）；`get()` 只物化一个正文；未知名与不可用 locator；payload 损坏仍可列但拒载；asset 缺失/损坏退化不抛；退化目录在活宿主上；模块导出 |
| `tests/execute.spec.ts` | 23 | 解释器选择与解析（注入命令 → PATH → 宿主可执行文件）；真实 `node -` 经 stdin 运行（输出、args 透传、非零退出当数据）；零落盘（脚本自身遍历注入根与默认临时根顶层找不到自身源码副本、staged assets 被删除、结果不含 canary、清理失败只记 warning）；未知 skill / 未声明脚本 / 路径穿越 / 无解释器 / 非法 UTF-8 均在 spawn 前拒绝；死线、输出尾部截断、调用方取消、启动抛错均清理 staged assets；会话并发上限与槽位释放；接缝透传（argv、stdin 正文、cwd、grace、signal） |
| `tests/tool.spec.ts` | 5 | 工具 schema、输出形状、预算与 `presentCall`；从执行上下文解析 cwd/session/signal；render 与 `toRunValue`；在 tools 接缝上的反应式注册与卸载；制品 fixture 脚本经真实插件端到端运行并清理 staged assets |

红绿证（本批实测）：

- 把 `apply()` 里的 inject 子 fiber 换成直接 `ctx.skills.registerProvider()` → **红**：
  `expect(source).not.toMatch(/\bctx\.skills\./)`。（运行期用例仍绿，因为静态 `inject` 声明能解析出服务；
  真正拦住这个捷径的就是这条形态钉测。）
- 把容器文档本身写进 `assets/skills.bundle`（即明文发布）→ **红**：
  `artifact.includes('# Fixture hello')` 报 `expected false, received true`。
- 去掉读 asset 的 `try/catch` → **红**：退化用例以 `ENOENT` 失败，而不是空目录。
- 改解码器的 key 字符串 → **红**：打包器→解码器交叉一致用例立刻失败。
- 把脚本正文写进文件并 spawn 该文件（而不是走 stdin）→ **红**：零落盘用例自己的扫描报 `SCRIPT-SOURCE-HITS=1`
  而非 `0`，且临时根目录不再为空。
- 取 bundle 首个条目代替按声明路径匹配 `script` → **红**：所有穿越/未声明名字用例开始 spawn，
  `carries no script` 断言失败。
- 去掉 `AbortSignal`/死线融合、只靠宿主超时 → **红**：执行器的 `timed out after … ms` 与 `was cancelled`
  分类永不触发。
- 忽略 `DSH_DESKTOP_NODE_EXECUTABLE`、直接 spawn PATH 裸名 → **红**：注入命令用例看到的是 `node` 而不是发布
  的绝对路径。
- 去掉 staged-assets 目录的 `finally` 清理 → **红**：超时、取消、启动抛错三条用例都留下非空的临时根目录。
- 让清理 `rm` 的失败逃出 `finally` → **红**：一次清理遇 EPERM 的成功运行被报成失败，而不是返回结果。

## 目录

```
dsh-company-skills/
  src/index.ts          插件：模块初始化读目录 + inject 子 fiber 注册
  src/provider.ts       provider：仅索引的 list()、按需的 get()
  src/catalog.ts        加载策略、索引、逐 skill 物化
  src/container.ts      容器 frame 解码（独立于 tools/）
  src/bundle.ts         单个 skill bundle 的字段规则（独立于 tools/）
  src/codec.ts          XOR+base64 解码器与 key 常量
  src/execute.ts        stdin 管道脚本执行器：寻址、资产、边界
  src/tool.ts           company_skill_run 定义、render、presentCall
  assets/skills.bundle  随包发布的容器块（在 files 里）
  cordis.patch.yml      组合行（在 files 里）
  scripts/              asset 生成器与 clean（永不发布）
  fixtures/             明文 fixture skill（永不发布）
  tests/                vitest 与本地 spawn 接缝（永不发布）
```

## 后续

- **批④**把 fixture 容器换成首批真实 skill，走市场 handoff（`type: 'skill'`），并做一次真机安装验收。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
