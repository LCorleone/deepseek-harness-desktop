# tools/company-skills —— 公司 skill 打包/校验（P6 批① + 容器升级，2026-09-10）

把一批常用 skill 做成「市场可分发的插件」的**纯工具层**：作者机器上读 skill 目录 → 校验 →
加密 → 写 blob 产物。**一个插件装很多 skill**，所以发布的 artifact 是 §2.0 的**容器**。
批①**零客户端改动**：这里没有任何插件、没有 `package.json`、没有 cordis
补丁，只有格式定义、打包器、自查器和守卫。容器插件在批②，脚本执行通道在批③，首批 skill 收编在批④。

任务书：`dev-log/briefs/2026-09-10-p6-company-skills.md`。

## 1. 产物形态

一个插件装很多 skill，所以发布的 artifact 是**容器**（一个 blob 装 N 个 skill）。产物形态由
`--out` 扩展名决定：

| 扩展名 | 形态 | 用途 |
| --- | --- | --- |
| `.js` / `.mjs` / `.ts` / `.mts` | 生成模块，单个 ESM 导出 `COMPANY_SKILL_BUNDLE_BLOB` | 进插件 `files` 白名单 |
| 其他 | 裸 base64 文本（一行，尾随换行） | 自查、离线比对、CI 校验 |

默认输出 `tools/company-skills/out/<name>.bundle.js`（该目录已 gitignore，只用于本地 scratch；
`<name>` 在容器模式下是 skills 根目录的名字）。

生成模块没有时间戳、没有随机数、没有源文件 mtime；**同输入两次打包逐字节相同**，所以「未改动的
skill 重新打包」是空 diff，可以直接据此判断 blob 是否需要更新。

## 2. 格式

### 2.0 容器（发布形态）

```jsonc
{
  "version": 1,                    // 容器格式版本；本工具只写 1、只读 1
  "skills":  [ /* N 个 §2.1 的单 skill 文档，元素形态完全不变 */ ]
}
```

- 顶层字段**恰好** `version` + `skills` 两个（多一个少一个都拒）。
- `skills` 至少一个；**skill `name` 必须全局唯一**（批② provider 按 name 建表）。空容器拒：
  0 个 skill 只可能是根目录指错，不是一个能装的 artifact（选型见 §6 测试说明）。
- 每个元素逐条跑 § 2.2 的全部既有校验（kebab-case / description 上限 / 单文件 8 MiB）。
- 容器自身另有一条总体积上限：规范化 JSON ≤ **128 MiB**（= 2 × 单 skill 上限；首批真实容器
  ppt-designer + skill-creator 实测 ≈ 43 MiB）。
- `skills` 按 `name` 码点排序后才编码，所以 artifact 与目录读取顺序无关。
- 单 skill 文档（批①形态）仍然可读：`unpack` 按顶层字段自动判别；`pack --skill` 保留为兼容入口，
  但插件应发**容器**。批②解码器同样按顶层 `version`+`skills` 判别两种形态。

### 2.1 单 skill 文档（容器元素 / `--skill` 兼容形态）

```jsonc
{
  "name":        "fixture-hello",              // kebab-case，必须合法
  "description": "一句话路由描述",              // 索引用，脱敏，≤ 500
  "body":        "\n# …",                       // SKILL.md 正文（frontmatter 之后逐字节原样）
  "scripts":     [{ "path": "scripts/hello.mjs", "content": "<base64>" }],
  "assets":      [{ "path": "reference/pptd.md", "content": "<base64>" }]
}
```

- 顶层字段**恰好**这 5 个（多一个少一个都拒），`scripts`/`assets` 元素**恰好** `path` + `content`。
- `path` 一律是**bundle 根相对**的 POSIX 路径（不是 skill 目录相对），且按**源 skill 相对位置逐字键控**：脚本要读数据文件就写
  `reference/pptd.md`，不要写 `../reference/pptd.md` —— 批②的 provider 用 `resourceBase: opaque`
  解析，消费方零改动（`docs/subsystems/skills.md:231`）；批③执行器把每个条目物化回同一相对路径。
- `body` 与每个 `content` 解码后都 ≤ 8 MiB（收编的 ppt-designer 带看 4.9 MiB 字体表与 2.4 MiB WASM）；
  整个规范化 JSON ≤ 64 MiB（ppt-designer 实测 ≈ 43 MiB）。
- 整个文档 UTF-8 JSON → 固定 key 循环 XOR → 标准 base64 → 单块 blob。

### 2.2 作者侧目录布局（逐字保留源 skill 根）

```
<skills-root>/            # --skills：一个容器（N 个 skill）
  <skill-dir>/            # 每个子目录 = 一个 skill，名字与 frontmatter name 无关
    SKILL.md              # 必须
    scripts/**            # 可选——可执行寻址索引，打包为 scripts[]
    <其它任意条目>/**      # 可选——其余资源按源相对路径打包为 assets[]
                          #（editor/index.html、reference/pptd.md、LICENSE.txt）

<skill-dir>/              # --skill：单 skill 兼容入口（同上）
  SKILL.md
  scripts/**
  <其它任意条目>/**
```

- skills 根**只允许目录**，且每个目录必须是一个合法 skill（子目录缺 `SKILL.md` 就拒）；
  根下的散文件、symlink 一律拒。
- 顶层布局**逐字保留**：除 `SKILL.md` 外的每个普通文件/目录按自己的源相对路径进 bundle，所以收编来的
  `editor/`、`reference/`、`pptd-template/`、`LICENSE.txt` 原位落进 staged 根，`__file__` 定位根与
  `SKILL_DIR/editor/index.html` 免改动可用。
- `scripts/` 之下的一切都进 `scripts[]`（可执行寻址索引）；其余一切进 `assets[]`，两者不重叠。
- **剪枝清单**：名为 `__pycache__` 的目录在任意深度直接跳过不打包（解释器的机器本地字节码缓存——收编来的
  skill 可能带着别的 CPython 版本的 `.pyc`，既不是源码也不是资源，不该进 bundle）。
- 只读普通文件：symlink、空文件一律拒。
- 目录允许**任意深度嵌套**（收编 skill 带 `scripts/local-export/…`、`editor/neo-ppt/…` 深树）。
- `SKILL.md` 必须 LF 行尾，frontmatter 必须闭合，`name`/`description` 必须存在。
- `body` = 闭合 `---` 那一行的换行之后的**全部字节**，所以 `unpack --out` 重建出的 `SKILL.md`
  与源文件逐字节一致（frontmatter 是重新规范化生成的）。限定：规范化后的 frontmatter 一定不带引号——`description: "…"` 这种写法里引号是 YAML 语法而非内容，解析时剥掉（`parseFrontmatter`），重建时也不再补回，所以只有未加引号的规范化源文件才逐字节一致。

### 2.3 校验规则（单 skill 元素）

| 规则 | 口径 |
| --- | --- |
| `name` | `^[a-z0-9]+(?:-[a-z0-9]+)*$`，与上游 registry 同一常量（`packages/skill/skill/src/index.ts:21`） |
| `description` | 非空、单行、无控制字符、无首尾空白、≤ **500** |
| `body` | 非空、≤ 8 MiB |
| `path` | 相对、POSIX、已规范化（无 `.`/`..`/空段）、≤ 200 字符、按源相对路径键控：`scripts[]` 必须在 `scripts/` 之下，`assets[]` 反之（两数组不重叠、各自唯一）、字符集 `[A-Za-z0-9._@%+~/-]` |
| `content` | 规范标准 base64（可往返）、解码后非空且 ≤ 8 MiB |
| 引用闭包 | **打包期 lint（警告不拒）**：`body` 与每个脚本正文里出现的 `scripts/…`、`assets/…` 字面路径若不在
  bundle 里，`pack` 在 stderr 逐条报 `warning`（`danglingReferences`）。收编的第三方 skill 散文里合法地提到
  示例路径（skill-creator 指南里的 `assets/logo.png` 等），所以不再硬拒；安全相关规则（帧/字段/路径/base64/
  体积）仍然硬拒。`assets` 正文**不**参与扫描——资产是数据，不是引用源（`referenceScanTargets` 只取 `body` + `scripts[]`） |
| 体积 | 规范化 JSON ≤ 64 MiB |

`description` 的 500 对齐上游 catalog 截断口径：`catalogDescriptionMaxLength` 默认 500
（`docs/subsystems/skills.md:231`），打包器拒绝作者写一个会被 catalog 悄悄截掉的描述。

## 3. 命令

```bash
# 打包容器（作者机器；skills 根下 N 个 skill 目录）
node tools/company-skills/pack.mjs --skills <skills-root> [--out <file>]
# 打包单个 skill（兼容入口；产出的仍是单 skill 文档，插件应发上面的容器）
node tools/company-skills/pack.mjs --skill <skill-dir> [--out <file>]

# 自查/校验（默认只打元信息摘要：容器列 N 个 skill 的 name/description/脚本数；
# 正文不落屏，只有显式 --out 才写回目录，容器写 <out>/<name>/）
node tools/company-skills/unpack.mjs --in <blob> [--out <dir>] [--expect-sha256 <hex>]
```

- `pack` 的 stdout 只有三行：目标路径、计数与 key id、明文字节数 + `plaintextSha256`（容器模式计数
  聚合成 `skills N  scripts N  assets N`）。这个 digest 是后续 handoff / allowlist 记录的输入（批④）。
- `pack` 失败一律 exit 1，**不创建输出目录**（测试断言「拒绝即无产物」）。
- `unpack` 的摘要：单 skill 文档列 `name`、`description`、各文件路径与字节数；容器列 N 个 skill 的
  `name` / `scripts` / `assets` 计数与 `description`（**从不打印正文**）；`--out` 用于和源目录 diff；
  `--expect-sha256` 用于 CI 侧断言「这个 blob 解出来的就是评审过的那份明文」。
- 两个 CLI 都拒绝未知参数，绝不猜测目标路径；`pack` 要求 `--skill`/`--skills` 恰好一个。

## 4. 密钥策略与已知缺口（**必读**）

### 4.1 沿用先例的三钥形态

固定混淆 key 常量：`dsh-company-skill-bundle-obfuscation-key-v1`（key id `company-skill-bundle-v1`），
循环 XOR + 标准 base64。**同一个 key 串按构造存在三份**：

1. 作者侧打包器（`lib/codec.mjs:28`）；
2. 生成出来的 blob 模块；
3. 批②容器插件里的运行期解码器（尚未落地）。

三份必须**逐字节一致**，否则解码立刻失败——这正是 `dsh-plugin-desktop/scripts/make-model-gateway-blob.mjs`
（及其 SSO app key、usage-report DSN 两个同类先例）的形态。key 只以源码常量形式存在：**不读 key 文件、
不接受环境变量覆盖**（运行期解码器是随包常量，env 选 key 只会产出没人能解的 bundle）。

明文输入只存在于作者机器：读目录 → 内存编码 → 只写 blob。**不写临时文件、不落缓存、不写日志正文**；
`pack` 输出目录里只允许出现那一个 artifact（测试断言）。

### 4.2 缺口明示（brief §3 要求写进设计文档）

- **全体共享单一固定 key。** key 就在随包发布的解码器里，所以任意一个拿到插件的用户
  都能解开**任何**一份 bundle，包括并非发给他的那份。混淆不是加密：它挡的是明文 grep、
  `strings`、误粘贴、随手翻 profile 目录的人，不挡会读 shipped JS 的人。
- **本批接受这个缺口**，理由与定位一致：P6 的目标是「防普通用户 + 明文不落盘」，不是防逆向。
  与 model-gateway / SSO / usage-report 三个已签收先例同级，残余风险同样已签收。
- **后续升级路径（不在本批）**：每-skill 派生 key（用 bundle `name` + 发布期 secret 做 HKDF，
  解码器侧仍只带一份派生 salt），或非对称包装（发布方持私钥、客户端只持公钥）。
  升级会改变 blob 字节，必须整批重打；`OBFUSCATION_KEY_ID` 就是留给那次切换的判别位。

同理已签收的残余：`description` 进 catalog、`body` 进会话历史后即明文（与「进上下文即可套话」同级）。

## 5. `unpack.mjs` 禁令

`unpack.mjs` 是这里唯一会把 blob 变回明文的工具。**它禁止进任何发布产物**，两道守卫：

1. `lib/release-surface.mjs` 审计仓库里**每一个** `package.json` 的 `files` / `bin` / `main`
   条目（`main` 即使不在 `files` 里 npm 也会发，且可以是任意路径），
   用 npm 的 glob 语义算出「会不会把某个 `unpack.mjs` 发布出去」，命中即红
   （`tests/unpack-release-guard.test.mjs`，含 `*.mjs` / `**/*.mjs` / 目录前缀 / `bin` / `main` 五种扫入方式）。
   遍历**不**剪掉 `lib` / `dist` / `out` / `.build`——本仓真实发布包恰恰发 `lib/**`，
   所以 `pkg/lib/unpack.mjs` 这类最可能的泄漏点必须可见（只剪 `node_modules`/`.git`/`.yarn`/`deepseek-harness`）。
   第二条规则更粗但更根本：**放着 `unpack.mjs` 的目录不允许有 `package.json`** ——
   这正是 `tools/company-skills/`（与 `tools/company-catalog/` 一样）不是 workspace、没有 manifest 的原因。
2. `unpack.mjs` 启动时自检同目录有没有 `package.json`，有就拒绝运行。

红绿证：把 `tools/company-skills/package.json` 写成 `{"files":["unpack.mjs"]}`，守卫测试第 1 条立刻红。

## 6. 测试

```bash
node --test tools/company-skills/tests/                # 42 个用例
yarn test:company-skills                               # 同一组，已挂进 yarn check
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/bundle-format.test.mjs`（19） | 单 skill 字段/名称/描述/体积/路径/base64 全部拒绝路径；引用闭包降级为 lint 后的返回值断言；容器字段/版本/非空/重名/总体积与按名规范化；codec 往返；frontmatter 引号规范化；`SKILL.md` 解析与单 skill/skills 根两种目录读取的布局拒绝（含嵌套目录接受 + 根外目录拒绝） |
| `tests/pack-roundtrip.test.mjs`（13） | ① pack→unpack→re-pack 逐字节一致且重建目录与源逐字节一致；② 非法名/超长描述/杂散文件拒且无产物；②b 缺引用降级为警告：产物照写、stderr 点名、unpack 可验证；③ artifact 不含源文件任一特征行（含 canary，附「blob 内确实能解出 canary」的反向对照）；④ 同输入两次打包逐字节相同、且与源 mtime 无关；digest 校验与篡改拒绝；⑥ N=3 容器往返逐字节一致 + 重建目录重打同字节 + 确定性；⑦ 容器产物不含任一 skill 的明文行；⑧ 容器重名/空根/根下散文件/单个非法成员均拒且无产物，带缺引用成员的容器改为警告通过；⑨ 容器摘要列全 N 个 skill 且不打印正文；⑩ `__pycache__` 剪枝：任意深度跳过，产物与重建目录都不含缓存 |
| `tests/unpack-release-guard.test.mjs`（10） | ⑤ 真仓库无违规 + `files`/`bin`/`main` 与目录规则的红用例，含「发布面覆盖 `lib/**`」与「`lib`/`dist`/`out`/`.build` 不剪枝」两条回归 |

红绿证（本批实测）：

- 把 `packBundle` 里 `encodeBundleBlob(json)` 改回 `json`（即明文落盘）→
  ③ 红：`the artifact leaked the source line "This fixture exists only so the packer tests have a real skill directory: one"`。
- 加 `tools/company-skills/package.json` 且 `files: ["unpack.mjs"]` → ⑤ 红：`the real repository publishes no unpack.mjs`。
- 把 `unpack.mjs` 放进某个 `files` 覆盖 `lib/**` 的包里 → ⑤ 红：`"lib/**" would ship lib/unpack.mjs`
  （修复前剪枝掉 `lib`，此用例绿=漏报，即 P1）。
- 把包的 `main` 指向 `tools/unpack.mjs` → ⑤ 红：`"tools/unpack.mjs" would ship tools/unpack.mjs`。

## 7. 文件清单

```
tools/company-skills/
  pack.mjs                      打包器（作者机器，不进 CI 链）
  unpack.mjs                    自查/校验器（禁止进产物，见 §5）
  lib/codec.mjs                 XOR+base64 编解码、模块渲染/解析、key 常量
  lib/bundle.mjs                格式定义：单 skill 校验、容器校验、规范化、目录读取、重建
  lib/release-surface.mjs       unpack 发布面守卫
  fixtures/fixture-hello/       绿用例的源 skill（含一条明文 canary）
  tests/*.test.mjs              node --test（对齐 tools/company-catalog/tests/）
  out/                          本地 scratch（gitignore）
```

## 8. 交给批②的接口契约

- 解码：XOR 循环 key `dsh-company-skill-bundle-obfuscation-key-v1`（三钥之一），
  `base64 → XOR → UTF-8 → JSON.parse`。顶层含 `version` + `skills` → 容器（本批主路径）；否则按单 skill
  文档处理（批①兼容）。然后按 §2.0 容器规则 + §2.3 元素字段规则复刻校验（解码器不能 import 本工具）。
- `list()` 遍历容器 `skills`，只吐 `name` + `description`；`get()` 才解码 `body`；`resourceBase` 用
  `{ kind: 'opaque', description }`；相对路径按 §2 的 bundle 根相对语义解析。name 已保证唯一，直接建表。
- blob 产物的文件名与导出一致：`COMPANY_SKILL_BUNDLE_BLOB`。
