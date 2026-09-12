# DSH Desktop

**The company-internal (Deloitte) DSH desktop client product**: a locked-down desktop application built around a pinned upstream [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) submodule, plus company-owned desktop shell, lockdown policy, and signed plugin catalog, distributed to the fleet (employee Windows machines). This repository is the single source of the product; it is not open source, is not published externally, and has no community channels.

[中文](README.md) · English

- Plugin market portal: <https://plugin-market.s.dai.deloitte.cn/>
- Want to change code: start with [Development](#development) and [CONTRIBUTING.en.md](CONTRIBUTING.en.md).
- Want to ship a plugin: see [How plugins ship](#how-plugins-ship).

## What this repository is

| Location | Role |
| --- | --- |
| `deepseek-harness/` | **Pinned upstream submodule** (pin recorded in the root `upstream.json`). Red line: never edited in place; upstream updates land only through separate pin commits. |
| `dsh-plugin-desktop/` | Electron host and client: window, tray, terminal, updates, plus the company lockdown layer — embedded read-only policy (`src/policy/desktop-policy.release.json`), install-chain verification, boot re-verification on every start, and the terminal `dsh plugin add` gate. |
| `dsh-community-market/` | Host and Client of the company plugin market: market UI, signing/verification library, and the company-catalog provider injection surface (directory name kept for historical reasons). |
| `dsh-company-skills/` | Company skills container plugin: ships a curated skill set as one obfuscated bundle through the skill registry. |
| `dsh-community-fabric/` | Private plugin-interoperability RFC scaffold: documentation only, no loadable entry points. |
| `tools/company-catalog/` | Signed-catalog publishing pipeline: allowlist → assemble and sign → intranet publish. |

Architecture in one sentence: the Electron shell starts the upstream DSH Host in the main process; the Host serves the upstream Web UI over loopback HTTP/WebSocket; desktop capabilities and the company market both compose into the same runtime as ordinary Cordis plugins ("everything is a plugin"). See the [architecture notes](docs/architecture.en.md).

## Relationship to upstream

- Upstream owns the core agent, models, tools, sessions, and plugin system; this repository owns only the desktop product layer and does not modify upstream source.
- The `deepseek-harness/` submodule keeps its own pnpm workspace; upstream operations always run through the root `upstream:*` scripts (for example `corepack yarn upstream:build`).
- The outer repository and every owned package use the root Yarn release through Corepack (`yarn@4.18.0`).

## Development

Prerequisites: Node `^22.19.0 || >=24.0.0` and Corepack Yarn `4.18.0`.

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn dev     # build the market and start the desktop dev flow (needs a graphical session)
corepack yarn check   # full headless gate
```

Common tasks: `corepack yarn build / test / typecheck`. Builds, typechecks, unit tests, and smoke checks must stay headless-safe. The authoritative repository rules live in [AGENTS.md](AGENTS.md).

## How plugins ship

The chain in one sentence: **the reviewed `tools/company-catalog/allowlist.json` → the `verify-handoff` / `accept-handoff` mechanical gates → CI signs the canonical-JSON manifest with a detached ed25519 signature → `publish-local.mjs` pushes it to the intranet GitLab origin → clients verify the signed manifest, install only entries it pins, and re-verify the installed plugin tree at every boot.**

- Colleague submissions: open an MR in the intranet GitLab handoff repository as `submissions/<name>-<version>` (`handoff.json` + tgz); the desktop owner processes it.
- Beta channel: new entries first reach the signed tester roster (`state/beta-testers.json`) for soaking; `promote` moves them into stable and the whole fleet sees them.
- The authoritative runbooks are [`tools/company-catalog/README.md`](tools/company-catalog/README.md) and [`tools/company-catalog/docs/handoff/`](tools/company-catalog/docs/handoff/) (SOP / RELEASE / MR-HANDLING); this README does not duplicate them.

## Documentation map

| Goal | Entry point |
| --- | --- |
| Use the product (profiles, modes, terminal, updates) | [User guide](docs/user-guide.en.md) |
| Quick answers | [FAQ](docs/faq.en.md) |
| Understand why the product is shaped this way | [Why DSH Desktop](docs/why-desktop.en.md) |
| Understand the architecture | [Architecture](docs/architecture.en.md) |
| Write plugins | [Plugin development](docs/plugin-development.en.md) · [Plugin ecosystem and distribution](docs/plugin-ecosystem.en.md) |
| Package-level detail | [`dsh-plugin-desktop/README.md`](dsh-plugin-desktop/README.md) · [`dsh-community-market/README.md`](dsh-community-market/README.md) · [`dsh-company-skills/README.md`](dsh-company-skills/README.md) |
| Trace decisions and history | `dev-log/` (session log) · `.agents/notes/` (architecture and process accounts) · `.issues/` (work ledger) |

## Audience and boundaries

- This repository and the product are for company-internal use only: no external contributions, no external distribution.
- Core capabilities come from the pinned upstream submodule and the Cordis plugin model; "DeepSeek" is a trademark of DeepSeek AI, used here only to describe technical origin.
- The root keeps the upstream ecosystem's MIT [`LICENSE`](LICENSE); the repository itself is managed as a company-internal asset.
