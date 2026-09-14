<p align="right">
  <strong>English</strong> · <a href="./README_ZH.md">简体中文</a>
</p>

# dsh-dai-mobius

A sequential research/analysis workflow plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Mobius turns one research goal into an ordered pipeline of dedicated step sub-agents: each step runs as its own continuable agent, the result of every earlier step feeds the next, and the workflow advances automatically — ending with a final conclusion that a strict independent reviewer pass can bounce back for revision.

It is a self-contained counterpart to AgentTeams: instead of a multi-agent team, Mobius runs a **sequenced research pipeline** where parallelism is expressed as execution *stages*.

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-dai-mobius"><img src="https://img.shields.io/npm/v/dsh-dai-mobius?style=flat-square&amp;color=5B4CF0" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B7285?style=flat-square" alt="MIT license"></a>
</p>

## Why Mobius?

| Capability | What it changes |
| --- | --- |
| **Sequential research pipeline** | One goal → ordered steps; each runs as a dedicated continuable sub-agent. Results flow forward automatically. |
| **Stage parallelism** | Steps sharing a `stage` run concurrently as parallel sub-agents; stages run serially, so independent work fans out while dependent work stays ordered. |
| **Auto-advance** | `mobius_done` completes a step and automatically dispatches the next stage (or finishes the workflow). |
| **Eureka mode** (尤里卡) | While running, each step agent may discover new viewpoints and self-adjust still-pending future steps (`mobius_discover`) — add / remove / refine — which auto-apply on the next stage advance. |
| **Conclusion review loop** | `mobius_finalize` submits a conclusion to an independent reviewer; a `needs_revision` verdict returns concrete findings for you to rewrite and resubmit (up to `maxReviewRounds`). |
| **Workflow reuse** | Export any workflow as a portable `.mobius.json` template and re-import it, or download it as a Skill (a zip of `SKILL.md` + `workflow.json`). |
| **Run guards** | Per-workflow step timeout, max-stage cap, and web-search discipline keep runaway pipelines in check. |
| **Live activity panel** | A Web floater renders stages, per-step status, and a single auto-advancing timeline — green done, red failed, grey halted. |

The in-conversation card and the activity panel follow the host's live locale (English / Simplified Chinese).

## Install

Add the bundle and patch row to your profile, then install via pnpm (replace the path with your tarball):

```bash
# cordis.patch.yml adds a loader row
- id: mobius
```

```bash
pnpm install file:/path/to/dsh-dai-mobius-0.1.16.tgz
```

The plugin registers `mobius_*` tools, a `/mobius` slash command, and the Web activity-panel routes. Restart `dsh web` to load it.

## Usage

Ask for research in natural language (e.g. *"研究一下 xxx"* / *"我研究一下 xxxxx"*), or type:

```
/mobius <目标>
```

The captain then:

1. **Plans** an ordered step list (gathering → analysis → synthesis → conclusion) and stages it with `mobius_create` — nothing runs yet.
2. **You review** the staged plan (start / adjust / discard) in the Web panel, then approve to `mobius_start`.
3. **It runs automatically**: each step spawns its own sub-agent; stages fan out / advance; results flow forward.
4. **`mobius_status`** lets you monitor; `mobius_finalize` consolidates the conclusion, which an independent reviewer judges.
5. **Reuse**: export `.mobius.json` templates or download a Skill zip from the card's export menu.

### Options

- **Steps in the same `stage`** run in parallel; stages run serially. No stage = sequential single-step stages.
- **Eureka mode** lets running step agents self-adjust future steps. **Off by default.**
- **Web search** (`web_search`/`web_fetch`) is **off by default**; enable it per-workflow when you want live lookups.
- **Max stage count** caps how many execution stages a workflow may have.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `stateDir` | `.agent-teams` | state directory under the captain workspace |
| `memberProvider` | `spawn` | sub-agent provider for step agents |
| `maxMembers` | `8` | max concurrently spawned step agents |
| `maxStepRetries` | `1` | auto-retry a failed step this many times |
| `maxReviewRounds` | `2` | conclusion-review loop ceiling |
| `timeoutMs` | – | default per-step timeout |
| `stepSearchLimit` | `3` | soft cap on web lookups per step |
| `maxStageCount` | `0` | hard cap on execution stages (0 = unlimited) |
| `promptSectionOrder` | `117` | usage-policy prompt order |

## Activities & docs

- [docs/usage.md](./docs/usage.md) — detailed workflow walkthrough
- [docs/quality-gates.md](./docs/quality-gates.md) — quality contracts (requirements → implementation → verification → review → integration)
- [docs/developing-dsh-plugins.md](./docs/developing-dsh-plugins.md) — build & bundle notes
- [release-notes/](./release-notes) — per-version notes

## Author & License

- **Author**: [Tang, Sebastain Yiyang](https://github.com/zhubidatou?tab=repositories)
- **Department**: Deloitte AI Institute（德勤人工智能研究院）
- **License**: [MIT](./LICENSE)
