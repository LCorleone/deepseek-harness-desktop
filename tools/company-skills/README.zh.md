# tools/company-skills —— 公司 skill 打包/校验（P6 批①，2026-09-10）

把一批常用 skill 做成「市场可分发的插件」的**纯工具层**：作者机器上读 skill 目录 → 校验 →
加密 → 写 blob 产物。批①**零客户端改动**：这里没有任何插件、没有 `package.json`、没有 cordis
补丁，只有格式定义、打包器、自查器和守卫。容器插件在批②，脚本执行通道在批③，首批 skill 收编在批④。

任务书：`dev-log/briefs/2026-09-10-p6-company-skills.md`。

## 1. 产物形态

一个 skill 一个 artifact，形态由 `--out` 扩展名决定：

| 扩展名 | 形态 | 用途 |
| --- | --- | --- |
| `.js` / `.mjs` / `.ts` / `.mts` | 生成模块，单个 ESM 导出 `COMPANY_SKILL_BUNDLE_BLOB` | 进插件 `files` 白名单 |
| 其他 | 裸 base64 文本（一行，尾随换行） | 自查、离线比对、CI 校验 |

默认输出 `tools/company-skills/out/<name>.bundle.js`（该目录已 gitignore，只用于本地 scratch）。

生成模块没有时间戳、没有随机数、没有源文件 mtime；**同输入两次打包逐字节相同**，所以「未改动的
skill 重新打包」是空 diff，可以直接据此判断 blob 是否需要更新。

## 2. bundle 格式（最小设计）

```jsonc
{
  "name":        "fixture-hello",              // kebab-case，必须合法
  "description": "一句话路由描述",              // 索引用，脱敏，≤ 500
  "body":        "\n# …",                       // SKILL.md 正文（frontmatter 之后逐字节原样）
  "scripts":     [{ "path": "scripts/hello.mjs", "content": "<base64>" }],
  "assets":      [{ "path": "assets/notes.md",   "content": "<base64>" }]
}
```

- 顶层字段**恰好**这 5 个（多一个少一个都拒），`scripts`/`assets` 元素**恰好** `path` + `content`。
- `path` 一律是**bundle 根相对**的 POSIX 路径（不是 skill 目录相对）：脚本要读数据文件就写
  `assets/data.json`，不要写 `../assets/data.json` —— 批②的 provider 用 `resourceBase: opaque`
  解析，消费方零改动（`docs/subsystems/skills.md:231`）。
- `body` 与每个 `content` 解码后都 ≤ 1 MiB；整个规范化 JSON ≤ 4 MiB。
- 整个文档 UTF-8 JSON → 固定 key 循环 XOR → 标准 base64 → 单块 blob。

### 2.1 作者侧目录布局（只接受这一种）

```
<skill-dir>/
  SKILL.md        # YAML frontmatter: name, description（其他 frontmatter 键解析后忽略）
  scripts/**      # 可选
  assets/**       # 可选
```

- 顶层除 `SKILL.md` 外只能有 `scripts/` 和 `assets/` 两个目录，多一个文件就拒（`README.md` 也不行）。
- 只读普通文件：symlink、目录套目录、空文件一律拒。
- `SKILL.md` 必须 LF 行尾，frontmatter 必须闭合，`name`/`description` 必须存在。
- `body` = 闭合 `---` 那一行的换行之后的**全部字节**，所以 `unpack --out` 重建出的 `SKILL.md`
  与源文件逐字节一致（frontmatter 是重新规范化生成的）。

### 2.2 校验规则

| 规则 | 口径 |
| --- | --- |
| `name` | `^[a-z0-9]+(?:-[a-z0-9]+)*$`，与上游 registry 同一常量（`packages/skill/skill/src/index.ts:21`） |
| `description` | 非空、单行、无控制字符、无首尾空白、≤ **500** |
| `body` | 非空、≤ 1 MiB |
| `path` | 相对、POSIX、已规范化（无 `.`/`..`/空段）、≤ 200 字符、前缀分别为 `scripts/` 与 `assets/`、全局唯一、字符集 `[A-Za-z0-9._@%+~/-]` |
| `content` | 规范标准 base64（可往返）、解码后非空且 ≤ 1 MiB |
| 引用闭包 | `body` 与每个脚本正文里出现的 `scripts/…`、`assets/…` 字面路径**必须**真的在 bundle 里；否则拒（批② `resourceBase: opaque` 只按需解析，引用落空就是运行期报错） |
| 体积 | 规范化 JSON ≤ 4 MiB |

`description` 的 500 对齐上游 catalog 截断口径：`catalogDescriptionMaxLength` 默认 500
（`docs/subsystems/skills.md:231`），打包器拒绝作者写一个会被 catalog 悄悄截掉的描述。

## 3. 命令

```bash
# 打包（作者机器；默认输出 tools/company-skills/out/<name>.bundle.js）
node tools/company-skills/pack.mjs --skill <skill-dir> [--out <file>]

# 自查/校验（默认只打元信息摘要，正文不落屏；--out 才会写回目录）
node tools/company-skills/unpack.mjs --in <blob> [--out <dir>] [--expect-sha256 <hex>]
```

- `pack` 的 stdout 只有三行：目标路径、计数与 key id、明文字节数 + `plaintextSha256`。
  这个 digest 是后续 handoff / allowlist 记录的输入（批④）。
- `pack` 失败一律 exit 1，**不创建输出目录**（测试断言「拒绝即无产物」）。
- `unpack` 的摘要包含 `name`、`description`、各文件路径与字节数；`--out` 用于和源目录 diff；
  `--expect-sha256` 用于 CI 侧断言「这个 blob 解出来的就是评审过的那份明文」。
- 两个 CLI 都拒绝未知参数，绝不猜测目标路径。

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

1. `lib/release-surface.mjs` 审计仓库里**每一个** `package.json` 的 `files` / `bin` 白名单，
   用 npm 的 glob 语义算出「会不会把某个 `unpack.mjs` 发布出去」，命中即红
   （`tests/unpack-release-guard.test.mjs`，含 `*.mjs` / `**/*.mjs` / 目录前缀 / `bin` 四种扫入方式）。
   第二条规则更粗但更根本：**放着 `unpack.mjs` 的目录不允许有 `package.json`** ——
   这正是 `tools/company-skills/`（与 `tools/company-catalog/` 一样）不是 workspace、没有 manifest 的原因。
2. `unpack.mjs` 启动时自检同目录有没有 `package.json`，有就拒绝运行。

红绿证：把 `tools/company-skills/package.json` 写成 `{"files":["unpack.mjs"]}`，守卫测试第 1 条立刻红。

## 6. 测试

```bash
node --test tools/company-skills/tests/                # 29 个用例
yarn test:company-skills                               # 同一组，已挂进 yarn check
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/bundle-format.test.mjs`（15） | 字段/名称/描述/体积/路径/base64/引用闭包全部拒绝路径；codec 往返；`SKILL.md` 解析与目录读取的布局拒绝 |
| `tests/pack-roundtrip.test.mjs`（6） | ① pack→unpack→re-pack 逐字节一致且重建目录与源逐字节一致；② 缺资源/非法名/超长描述/杂散文件拒且无产物；③ artifact 不含源文件任一特征行（含 canary，附「blob 内确实能解出 canary」的反向对照）；④ 同输入两次打包逐字节相同、且与源 mtime 无关；digest 校验与篡改拒绝 |
| `tests/unpack-release-guard.test.mjs`（8） | ⑤ 真仓库无违规 + 四种 `files`/`bin` 扫入方式与目录规则的红用例（fixture 仓，常驻回归） |

红绿证（本批实测）：

- 把 `packBundle` 里 `encodeBundleBlob(json)` 改回 `json`（即明文落盘）→
  ③ 红：`the artifact leaked the source line "This fixture exists only so the packer tests have a real skill directory: one"`。
- 加 `tools/company-skills/package.json` 且 `files: ["unpack.mjs"]` → ⑤ 红：`the real repository publishes no unpack.mjs`。

## 7. 文件清单

```
tools/company-skills/
  pack.mjs                      打包器（作者机器，不进 CI 链）
  unpack.mjs                    自查/校验器（禁止进产物，见 §5）
  lib/codec.mjs                 XOR+base64 编解码、模块渲染/解析、key 常量
  lib/bundle.mjs                格式定义：校验、规范化、目录读取、重建
  lib/release-surface.mjs       unpack 发布面守卫
  fixtures/fixture-hello/       绿用例的源 skill（含一条明文 canary）
  tests/*.test.mjs              node --test（对齐 tools/company-catalog/tests/）
  out/                          本地 scratch（gitignore）
```

## 8. 交给批②的接口契约

- 解码：XOR 循环 key `dsh-company-skill-bundle-obfuscation-key-v1`（三钥之一），
  `base64 → XOR → UTF-8 → JSON.parse`，然后按 §2.2 复刻字段校验（解码器不能 import 本工具）。
- `list()` 只吐 `name` + `description`；`get()` 才解码 `body`；`resourceBase` 用
  `{ kind: 'opaque', description }`；相对路径按 §2 的 bundle 根相对语义解析。
- blob 产物的文件名与导出一致：`COMPANY_SKILL_BUNDLE_BLOB`。
