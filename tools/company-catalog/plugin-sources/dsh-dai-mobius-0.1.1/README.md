<p align="right">
  <strong>English</strong> · <a href="./README_ZH.md">简体中文</a>
</p>

# dsh-dai-mobius

Mobius lets you launch and research an entire topic: you give a research goal, and the system automatically breaks it into an ordered research pipeline, executed step by step by dedicated AI sub-agents — each step's result feeds the next — and finally consolidates everything into a complete, independently reviewed conclusion.

### Features & Highlights

- **Sequential research pipeline**: one goal becomes an ordered list of steps, each run by a dedicated sub-agent whose result is passed forward to the next until a final conclusion.
- **Stage parallelism**: steps in the same stage run concurrently (each as its own sub-agent); dependent stages run serially — independent work fans out, dependent work stays ordered.
- **Eureka mode**: when enabled, running step agents actively discover new angles and self-adjust the pipeline — automatically adding, splitting, rewriting, or trimming still-upcoming steps to make the research deeper and more complete. Off by default; opt in as needed.
- **Review before you start**: the plan is presented in the Web panel, and only starts after you click "Start" — it never goes online or runs without your approval.
- **Independent review gate**: the final conclusion is judged by an independent reviewer sub-agent; it bounces back with concrete findings until it passes.
- **Live activity panel**: a top-right floater shows each step's progress and status by stage in real time — green complete, red failed, grey halted.
- **Export & reuse**: any workflow can be exported as a portable template file (`.mobius.json`) or downloaded as a Skill and re-imported anytime; an interrupted run can be resumed whenever.

### Use Cases

- **In-depth, stage-by-stage research**: background gathering first, then analysis from each angle, then synthesis into a full research report.
- **Layered, progressive analysis**: from data collection → structure parsing → insight extraction → final write-up, each step feeds the next.
- **Reusable, rigorous workflows**: encode a proven research flow and apply the same steps to any topic for repeatable results.

### How to Use

1. Search for and install this plugin in the Deloitte plugin marketplace.
2. Type `/mobius` in the chat, or simply describe your research goal (e.g. "research xxx", "analyze xxx").
3. Review the plan in the Web panel and click "Start"; the step sub-agents begin working.
4. Track each step's progress and the final conclusion anytime via the top-right floater.

---

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
