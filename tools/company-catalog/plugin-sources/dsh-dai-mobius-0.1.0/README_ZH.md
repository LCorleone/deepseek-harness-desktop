<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

# dsh-dai-mobius

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的顺序研究/分析工作流插件。Mobius 把一个研究目标拆成有序流水线：每一步由专属的可持续子 Agent 执行，前序步骤的结果自动喂给后续步骤，工作流自动推进——最终产出结论，并由一名严格的独立评审 Agent 把关，不合格会带着具体意见打回重写。

它是 AgentTeams 的独立对位实现：不做多智能体团队，而是用「执行阶段（stage）」来表达并行度的**顺序研究流水线**。

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-dai-mobius"><img src="https://img.shields.io/npm/v/dsh-dai-mobius?style=flat-square&amp;color=5B4CF0" alt="npm 版本"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT 许可证"></a>
</p>

## 为什么用 Mobius？

| 能力 | 作用 |
| --- | --- |
| **顺序研究流水线** | 一个目标 → 有序步骤；每步由专属可持续子 Agent 执行，结果自动向前传递。 |
| **阶段并行** | 同一 `stage` 的步骤并行（各跑独立子 Agent）；阶段串行推进——独立工作扇出、依赖工作保持有序。 |
| **自动推进** | `mobius_done` 完成一步后自动派发下一阶段（或完成整个工作流）。 |
| **Eureka 模式**（尤里卡） | 运行中的步骤 Agent 可发现新观点并自行调整尚未开始的后续步骤（`mobius_discover`）：增/删/改，在下一阶段推进时自动生效。 |
| **结论评审循环** | `mobius_finalize` 提交结论给独立评审；`needs_revision` 判定会带着具体意见返回供你重写并再次提交（至多 `maxReviewRounds` 轮）。 |
| **工作流复用** | 任何工作流都可导出为可移植的 `.mobius.json` 模板并重新导入，或下载为 Skill（zip：`SKILL.md` + `workflow.json`）。 |
| **运行护栏** | 单步超时、最大 stage 数上限、网页搜索纪律，防止流水线失控。 |
| **实时活动面板** | Web 浮层按阶段渲染步骤与状态、自动推进时间线——已完成绿、失败红、中断灰。 |

会话内卡片与活动面板跟随主机的实时语言（英文 / 简体中文）。

## 安装

在 profile 中加 bundle 与补丁行，然后用 pnpm 安装（把路径换成你的 tar 包）：

```bash
# cordis.patch.yml 添加一行 loader
- id: mobius
```

```bash
pnpm install file:/path/to/dsh-dai-mobius-0.1.16.tgz
```

插件会注册 `mobius_*` 工具、`/mobius` 斜杠命令，以及 Web 活动面板路由。重启 `dsh web` 即可加载。

## 使用

用自然语言提出研究目标（如「研究一下 xxx」「我研究一下 xxxxx」），或直接输入：

```
/mobius <目标>
```

随后流程：

1. **规划**：先规划有序步骤列表（收集 → 分析 → 综合 → 结论）并用 `mobius_create` 进入暂存——此刻什么都不跑。
2. **你评审**：在 Web 面板里审阅暂存计划（启动 / 调整 / 放弃），批准后用 `mobius_start` 启动。
3. **自动运行**：每步派生独立子 Agent；阶段扇出/推进；结果向前传递。
4. **`mobius_status`** 用于监控；`mobius_finalize` 汇总结论，并由独立评审把关。
5. **复用**：从卡片导出菜单下载 `.mobius.json` 模板或 Skill zip。

### 选项

- **同一 `stage` 的步骤**并行执行；阶段串行。未设 stage 则按顺序单步阶段执行。
- **Eureka 模式**允许运行中的步骤 Agent 自行调整后续步骤。**默认关闭。**
- **网页搜索**（`web_search`/`web_fetch`）**默认关闭**；需要实时检索时按工作流启用。
- **最大 stage 数**限制一个工作流最多有多少个执行阶段。

## 配置

| key | 默认 | 含义 |
| --- | --- | --- |
| `stateDir` | `.agent-teams` | captain 工作区下的状态目录 |
| `memberProvider` | `spawn` | 步骤 Agent 的子 Agent provider |
| `maxMembers` | `8` | 最大并发派生的步骤 Agent 数 |
| `maxStepRetries` | `1` | 失败步骤自动重试次数 |
| `maxReviewRounds` | `2` | 结论评审循环上限 |
| `timeoutMs` | – | 默认单步超时 |
| `stepSearchLimit` | `3` | 每步网页检索的软上限 |
| `maxStageCount` | `0` | 执行阶段数硬上限（0 = 不限） |
| `promptSectionOrder` | `117` | 使用策略提示顺序 |

## 文档

- [docs/usage.md](./docs/usage.md) —— 详细流程
- [docs/quality-gates.md](./docs/quality-gates.md) —— 质量契约（需求 → 实现 → 验证 → 评审 → 集成）
- [docs/developing-dsh-plugins.md](./docs/developing-dsh-plugins.md) —— 构建与打包说明
- [release-notes/](./release-notes) —— 各版本说明

## 作者与许可

- **作者**：[Tang, Sebastain Yiyang](https://github.com/zhubidatou?tab=repositories)
- **部门**：Deloitte AI Institute（德勤人工智能研究院）
- **许可证**：[MIT](./LICENSE)
