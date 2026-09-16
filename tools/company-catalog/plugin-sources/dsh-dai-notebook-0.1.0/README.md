# DAI Notebook

DAI Notebook is a DeepSeek Harness (dsh) web plugin derived from the
[`dsh-agent-teams`](https://github.com/NanmiCoder/dsh-agent-teams) floating-capsule
pattern. It puts a **global floating capsule** on the dsh web GUI for **quick
note-taking and task tracking**, styled to sit naturally beside the dsh web app.

## What it does

- **Global floating capsule** — a small round pill (bottom-right) that shows
  today's open-task count and expands into a lightweight panel. Drag it to a
  position you like; it stays there.
- **Notes** — quick-add freeform notes (plain text + light markdown), inline
  edit (double-click a title), tags, pin, archive, delete.
- **Tasks** — quick-add with `待办: …` syntax, completion checkbox (line-through
  + grey, with the capsule badge updating), priority, due date, tags, pin,
  archive, delete.
- **Today overview** — today's due tasks, in-progress count, note count, and
  recent daily auto-summaries.
- **Search + tag filters** — one search across notes and tasks, plus tag pills.
- **Export** — one-click Markdown export of the active notebook.
- **Chat ↔ capsule synergy** — the same notebook is reachable from the chat
  through `notebook_*` host tools, so you can say *"帮我记一条：…"* or *"把我的
  任务标完成"* and the capsule updates, and vice versa.
- **Daily summary** — per-day auto-summary (items added / tasks completed /
  tasks overdue), generated from the notebook data.
- **Light/dark** — follows the dsh web theme via design tokens.

## Installation

```bash
dsh plugin --profile web add /path/to/dsh-dai-notebook
# restart the web profile
```

## Structure

```
dsh-dai-notebook/
├── package.json          # dsh plugin manifest (+ client declaration)
├── cordis.patch.yml      # bundle patch (mounts the host plugin row)
├── tsconfig.json         # host program
├── tsconfig.client.json  # client program
├── tsdown.config.ts      # client bundle build (ModuleLoader closure-factory)
├── src/
│   ├── index.ts          # host entry: config, system prompt, HTTP routes
│   ├── tools.ts          # notebook_* host tools (chat drive)
│   ├── store.ts          # file persistence + daily summary
│   ├── web-routes.ts     # authenticated route helpers
│   ├── types.ts          # shared domain types
│   └── client/
│       ├── index.tsx     # browser entry (shell-overlay registration)
│       ├── NotebookCapsule.tsx   # the capsule + panel UI
│       ├── notebook-api.ts       # polling + mutation client
│       ├── panel-geometry.ts     # capsule position rules
│       └── NotebookCapsule.module.css
└── scripts/verify.mjs    # offline smoke verification
```

## Build & verify

```bash
pnpm build       # tsc host → tsc client → tsdown (lib/client.js)
pnpm verify      # offline store/logic verification (temp dir, self-cleaning)
```

## Note

This plugin is a focused sibling of agent-teams: it reuses the
shell-overlay + HTTP-snapshot plugin pattern but is a standalone notebook,
with no team/subagent orchestration.
