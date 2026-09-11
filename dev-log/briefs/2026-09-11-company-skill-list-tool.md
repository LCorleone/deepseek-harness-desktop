# Brief: `company_skill_list` —— 让 agent 能发现公司 skill 的资源清单（2026-09-11）

## 1. Goal & background

真机反馈：装上 `dsh-company-skills@0.1.0`（beta seq28）后，agent（客户端模型）**能读** bundle 里的资源
（`reference/pptd.md` 等都验证 OK），但对 `reference/design_system/**` 全部报
`carries no resource` —— 因为它在**盲猜文件名**（investment/equity/deep-blue 都不存在；
真实名是 black-gold-ledger、prospect-annual…）。打包本身完整（335 assets 全在）。

根因是**可发现性缺口**：SKILL.md 指示模型「列出 `reference/design_system/<category>/` 下的预设」，
原 skill 本地环境有文件系统可列目录；我们的插件只有 `company_skill_read`（精确路径读，无枚举）。
July 拍板（14:2x）：**加一个 list 工具**。

## 2. Code map（HEAD `9baed88233`，行号近似）

- `dsh-company-skills/src/tool.ts`（252 行）
  - `:80` `COMPANY_SKILL_READ_TOOL_NAME = 'company_skill_read'`
  - `:110-…` `companySkillReadTool(executor)` → `defineTool({name, description, parameters, execute})`
  - `:179-…` `company_skill_run`（脚本执行）
  - 工具都是「thin」风格：execute 走 executor，不碰明文落盘
- `dsh-company-skills/src/bundle.ts`（238 行）——容器解码/条目表（scripts[] + assets[]，按源相对路径键控）
- `dsh-company-skills/src/catalog.ts`（149 行）——skill 名册（name → 条目）
- `dsh-plugin-desktop/src/index.ts` 的插件 host 面：工具注册处（先例 `ctx.tools.register`）——
  找 `company_skill_read` 在哪里被注册进 host，list 工具同点位注册
- 测试：`dsh-company-skills/tests/tool.spec.ts`（read/run 的行为钉子，照此风格写 list 的）
- 已发布版本 `0.1.0`（beta seq28，treeDigest `26fd3c70…`）——**不可变**，本卡出 **0.1.1**

## 3. 设计要求（July 口径 + 既有约束）

- **工具名**：`company_skill_list`，参数 `skill`（必填，同 read 的校验）+ `path`（可选，
  bundle 根相对目录前缀，默认根 = 列全部）。**只返回路径名，不返回内容**（不新增明文暴露面）。
- 返回形态：排序后的**相对路径**列表（含 scripts/ 与 assets/ 全部条目；目录不单列，由路径前缀体现）。
  建议纯文本行列表 + 头部一行计数；**上限截断要显式标注**（如 1000 条后写
  `… truncated, N more — narrow the path prefix`，防 335+ 条把上下文打爆时可控）。
- 空结果语义：`path` 前缀无任何匹配条目 → 正常返回空列表并说明（`no entries under "<path>"`），
  不要报错——发现的本质就是试探。
- `skill` 不在名册 → 报错文案与 read 一致。
- 工具 description 要**教模型用法**：先 list 再 read（`Use company_skill_list to discover the
  exact paths a company skill carries, then company_skill_read to load one`）；
  同时把 `company_skill_read` 的 description 末尾补一句指向 list（互相引导）。
- 红线不动：源 skill 树只读（本卡不碰 `skills/`）；明文不落盘（list 只有名字，本来就不落内容）；
  `deepseek-harness/` 子模块零改动；`edit` 工具改代码。
- 版本：`package.json` 0.1.0 → **0.1.1**；plugin-sources staging 副本与发布链（pack-tarball →
  verify/accept → beta 发布）**本卡不做**，由 orchestrator 在评审通过后跑（worker 只改代码+测试）。

## 4. Decisions made & failed attempts

- 否决「在 SKILL.md 正文里注入清单」：正文必须逐字保留源 skill（收编红线）。
- 否决「list 返回内容摘要/前 N 字节」：扩大明文暴露面，无必要。
- 已确认 bundle 完整（335/335），本卡与打包无关，纯工具面缺口。
- 先例参考：上游 skill 在本地环境的可发现性靠文件系统；我们用显式 list 工具补齐。

## 5. Acceptance criteria

1. `company_skill_list(skill='ppt-designer')`（fixture 或真实 bundle）返回排序路径表，
   含 `reference/design_system/finance/black-gold-ledger/design.md` 等真实条目；计数行正确。
2. `path='reference/design_system/finance'` → 只返回该前缀下条目（6 个 design.md）。
3. `path='reference/nope'` → 正常空列表文案，不抛错、不落内容。
4. 未知 skill → 与 read 同款错误。
5. 截断：条目数超上限时显式标注（测试用小上限注入验证，不靠 335 条真跑）。
6. read 工具 description 增加了指向 list 的引导；两条工具都注册进 host 面（如适用，钉子测试）。
7. `corepack yarn workspace dsh-company-skills check`（build+verify bundle+typecheck+test）全绿；
   报告改动文件清单 + 每个 AC 对应测试名。不 commit（working tree 留给 orchestrator）。
