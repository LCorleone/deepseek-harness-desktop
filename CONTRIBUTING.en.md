# Contributing (company internal)

This repository is the single source of DSH Desktop, maintained for the fleet and for colleagues who pick it up next. How work flows: `.issues/` tracks the work ledger, `dev-log/` records session logs, and `.agents/notes/` holds the architecture and process accounts. Align with those three before you start, and open an issue before any change of direction.

## Getting started

- Prerequisites: Node `^22.19.0 || >=24.0.0` and Corepack-enabled Yarn `4.18.0`.
- Initialize the pinned upstream submodule with `git submodule update --init --recursive`, then `corepack yarn install --immutable`.
- A fully green `corepack yarn check` is the hard gate: layout/bilingual/architecture gates + build, typecheck, and tests of every owned package + the catalog-pipeline selftest.
- `corepack yarn dev` needs a graphical session; builds, typechecks, unit tests, and smoke checks stay headless-safe.

## Red lines (full text in AGENTS.md)

- `deepseek-harness/` is the pinned upstream submodule: **never edit it in place**. Upstream updates land only through separate pin commits, kept apart from behavior changes (`upstream.json` records the pin).
- Upstream commands run only through the root `upstream:*` scripts; the submodule keeps its own pnpm workspace while the outer repository uses the root Yarn release.
- `dsh-community-market/` must not import Desktop implementations (the architecture gate enforces the dependency direction); policy reaches it only through injection.
- `dsh-community-fabric/` stays documentation-only with no loadable entry points.
- Commit once before major changes of direction, so retreat and archaeology stay cheap.

## Commit conventions

- Conventional commits (for example `fix(desktop): ...`, `docs: ...`).
- After changing production dependencies, run `corepack yarn workspace dsh-plugin-desktop verify:notices` and commit the updated `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md`.
- Change bilingual documents in pairs and re-record their blob hashes with `git hash-object` in the matching `.i18n.yaml` (the root entry pair lives in `README.i18n.yaml`).
- Merge after review with all gates green; describe the change, its motivation, and how it was verified.

## Publishing a plugin

Plugins do not ship directly from this repository. Colleague plugins go through the intranet GitLab handoff repository as MRs (`submissions/<name>-<version>`); the desktop owner lands them into the allowlist via `verify-handoff` / `accept-handoff`, and the signing pipeline publishes them to the company catalog. The authoritative steps are the SOPs in [`tools/company-catalog/docs/handoff/`](tools/company-catalog/docs/handoff/); the model overview is in [README · How plugins ship](README.en.md#how-plugins-ship).

## Working atmosphere

Stay respectful and stick to the topic; the full [code of conduct](CODE_OF_CONDUCT.en.md) applies to all project spaces.
