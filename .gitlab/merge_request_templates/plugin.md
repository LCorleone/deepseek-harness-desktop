<!-- 插件提交 MR 模板 · 同步副本（新建 MR 时自动带出）。
     source of truth = desktop 仓 tools/company-catalog/docs/handoff/plugin.md
     （与 README.zh.md / handoff.schema.json / example.handoff.json 同目录的
     契约权威副本）。改模板：先改权威副本，再把正文（本说明以下的部分）
     字节一致地同步过来。模板=人读引导，handoff.json=机器闸门——不重复
     事实源，但两处必须一致。 -->

## 提交信息（须与提交目录 handoff.json 逐字段一致）

| 项 | 值 |
| --- | --- |
| 插件名（packageName） | `dsh-…` |
| 版本 | `X.Y.Z`（稳定三段式，与目录名 / tgz / handoff.json 一致） |
| 作者（author） | 插件作者（≠提交人，可代交） |
| 一句话描述（description） | |

## 插件类型（type，单选一个英文值——与 handoff.json 的 plugin.type 完全一致）

- [ ] `tool` — 工具
- [ ] `skill` — 技能
- [ ] `docs-and-rendering` — 文档与渲染
- [ ] `vision-and-multimodal` — 视觉与多模态
- [ ] `voice-and-audio` — 语音与音频
- [ ] `memory` — 记忆
- [ ] `workflow-and-automation` — 工作流与自动化
- [ ] `git-and-code-review` — Git与代码审查
- [ ] `interface-ui` — 界面与UI
- [ ] `browser-and-network` — 浏览器与网络
- [ ] `other` — 其他

## 测试情况（真实跑过的才勾）

- [ ] 安装：dev workspace 安装无报错
- [ ] 基本功能：client/host 双面核心场景跑通
- [ ] 设置持久化：设置保存并重启后保持

## 一致性确认

- [ ] 本 MR 上述描述与 handoff.json 一致（名 / 版本 / 作者 / 描述 / 类型）——不一致会被机器闸门直接拒绝
