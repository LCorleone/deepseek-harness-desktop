# DSH Company Skills

[中文说明](README.zh.md)

DSH Company Skills is the container plugin that ships a set of curated company skills as **one obfuscated bundle** and publishes them through the DeepSeek Harness skill registry. It is the P6 batch-2/3 deliverable: batch 1 defines and writes the bundle format (`tools/company-skills`), this package reads it, batch 3 adds the staged per-run script-execution channel, and batch 4 lands the first real skill set.

> **Current status: shipped with the first real collected skill set (batch 4).** The asset carries `ppt-designer` and `skill-creator` — collected read-only from the skills hub into `skills/` (see `scripts/collect-skills.mjs`) and repacked into `assets/skills.bundle`. Collection preserves each source skill root's layout verbatim (`editor/`, `reference/`, `pptd-template/`, `scripts/`, `SKILL.md`), so the staged tree reconstructs the original skill directory exactly. The fixture skills stay under `fixtures/` as a test-only surface and are no longer shipped.

## What it is

One Cordis plugin, one provider, and two model-facing tools:

- **Plugin** `company-skills` — reads and decodes `assets/skills.bundle` once at module initialization and registers one provider through the skill registry seam.
- **Provider** `company-skills` — `list()` returns the decrypted index (name, description, rank, opaque locator) and never a body; `get()` validates and materializes exactly the skill that locator names.
- **Tool** `company_skill_run` — runs one declared `scripts/…` entry from a per-run staged copy of the skill: the whole bundle (scripts and assets) is materialized at each entry's own relative path into a private `mkdtemp` directory (0700 on POSIX; entry directories default to 0755, files are written 0600, and `mode` is a no-op on Windows), executed from there, and deleted in a `finally` block the moment the run settles, so plaintext never persists (see [Script execution](#script-execution-the-staged-per-run-channel)).
- **Tool** `company_skill_read` — decodes one carried text resource (`reference/pptd.md`, `references/workflows.md`) by exact bundle path and returns it as text. This is the only text channel for those resources: the bundle is opaque, so a workspace `read` or `bash` sees nothing. The addressed entry is materialized for the duration of the call and removed in a `finally` block; binaries and entries over the read bound are refused (see [Reading resources](#reading-resources-the-opaque-text-channel)).
- **Precedence** — every skill reports `source: 'bundled'` and `BUNDLED_SKILL_RANK` (600), the packaged-root rank. A project (`.dsh/skills`, `.agents/skills`) or a user (`$DSH_HOME/skills`, `~/.agents/skills`) skill of the same name keeps winning: the company catalog is always available but never silently overrides a skill a repository or a user deliberately wrote down.
- **Resource base** — `{ kind: 'opaque', description: … }`. The referenced scripts and resources travel inside the plugin, not on local disk, so the upstream loader renders an opaque hint instead of a directory or URL and every existing consumer needs zero changes; the hint names the two company-skill tools, since they are the only way to reach those resources. Bodies are never truncated (only catalog descriptions are bounded, at the catalog's own 500 characters, which the packer already enforces).

## Registration seam

```ts
export const inject = ['skills']

export function apply(ctx: Context): void {
  const provider = createProvider(catalog, (message) => { ctx.logger.warn(message) })
  ctx.inject(['skills'], (inner) => {
    inner.effect(() => inner.skills.registerProvider(() => provider))
  })
  ctx.inject(['tools', 'subprocess'], (inner) => {
    const executor = createScriptExecutor({ catalog, spawn: (spec) => inner.subprocess.spawn(spec) })
    inner.effect(() => inner.tools.register(createCompanySkillRunTool(executor)))
    inner.effect(() => inner.tools.register(createCompanySkillReadTool(executor)))
  })
}
```

A bare `ctx.skills` read inside a plugin fiber throws (`cannot get property "skills" without inject` under Cordis reflective contexts) — the failure mode a real third-party plugin hit, documented in `tools/company-catalog/plugin-sources/dsh-dai-engramory-0.2.4/README.md`. Registering straight from `apply()` would work, but it binds the registration to this plugin's own fiber instead of a disposable child; the child fiber's `effect()` owns the lifecycle, so unmounting the plugin unregisters the provider and invalidates the catalog caches.

`tests/provider.spec.ts` pins both halves: the bare read really does throw, and the plugin's source contains the `ctx.inject(['skills'], …)` form with no direct `ctx.skills.` use. The tool rides the same reactive form on `['tools', 'subprocess']`, so a profile without those services still gets the provider and gets the tool as soon as they mount later.

## Script execution: the staged per-run channel

`company_skill_run` is the only way to execute a bundle's `scripts/…` entries. The engine (`src/execute.ts`) is deliberately independent of the desktop: it resolves the interpreter from `DSH_DESKTOP_NODE_EXECUTABLE` / `DSH_DESKTOP_PYTHON_EXECUTABLE` (the absolute commands the desktop publishes at runtime), then from the child's `PATH`, and — for Node only — from the host executable itself (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, which is Node in a CLI host and Electron-as-Node in the desktop). It spawns through the host's `ctx.subprocess.spawn` seam, so a packaged Windows machine whose PATH carries only `.cmd` shims (unusable by a shell-less spawn) still runs `.mjs` and `.py` scripts.

- **Parameters** — `skill` (a company skill name), `script` (a bundle-relative path that must equal one of *that skill's own* `scripts[]` paths, e.g. `scripts/export_pptx.py`), and optional `args` (extra argv, appended verbatim after the materialized script path).
- **Staging** — every `scripts[]` and `assets[]` entry is decoded in memory and materialized at its own bundle-relative path into one private per-run directory (`$TMPDIR/dsh-skill-assets-*`) that stands in for the skill root: `scripts/export_pptx.py` at `<dir>/scripts/export_pptx.py`, `reference/pptd.md` at `<dir>/reference/pptd.md`, `editor/index.html` at `<dir>/editor/index.html`. The interpreter is pointed at the materialized file (`argv = [<interpreter>, <dir>/scripts/export_pptx.py, …]`), the child's `cwd` is the staged root, and the root is published as `DSH_SKILL_ASSETS`. The directory is removed in a `finally` block as soon as the run settles — including on timeout, cancellation, and failure — so plaintext does not persist; a failed staging leaves nothing behind either. On-disk modes are measured, not assumed: `mkdtemp` makes the root 0700 on POSIX, the nested directories created per entry default to 0755 under the process umask, and each file is written 0600; `mode` is effectively ignored on Windows, where a private per-user directory plus `finally`-removal is the guarantee. A cleanup failure (Windows can report EPERM while the just-exited child still holds a handle) is logged as a warning and never changes the settled result; a throwing warning sink is caught too, so it cannot replace a settled run.
- **Why staging instead of a stdin pipe** — this is the upstream `code-runtime-python` paradigm, and it is what lets collected skills run unmodified: `__file__` locates the skill root (`Path(__file__).parent.parent`, exactly what ppt-designer's `export_pptx.py` computes), sibling imports resolve through `sys.path[0]`, and bundle-relative reads (`reference/pptd.md`, `editor/index.html`) resolve against the `cwd`. The transient-disk exposure is equivalent to the old pipe (same lifetime, same private directory), which is the signed-off P6 red line: *plaintext must not persist*.
- **Interpreter** — extension-selected family (`.mjs` / `.js` → Node, `.py` → Python), resolved as above; an unresolved interpreter rejects before anything spawns, and an invalid-UTF-8 script is rejected instead of being decoded lossily. Any other extension is rejected before anything spawns.
- **Addressing** — `script` is compared for exact equality against the validated bundle entries, never joined into a filesystem path, so `../`, absolute paths, and undeclared names all reject without spawning; the file the interpreter runs is `<staged>/<that same path>`. A script that is not valid UTF-8 is rejected before staging (collected skills legitimately carry a non-text binary under `scripts/` — ppt-designer's WASM writer — but only the addressed entry must decode as text).
- **Bounds** — each stream is retained as a bounded tail (64 KiB by default, overflow reported as `truncated`), the run has its own 120 s deadline fused with the caller's signal, and at most one run per session may be in flight. Every rejection is a `SkillRunError` naming the skill and script path only — never a byte of the body, in a message, a warning, or the settled result.
- **Return** — `{ skill, script, exitCode, stdout, stderr, stdoutTruncated, stderrTruncated }`; a non-zero exit code is data, not a thrown error.

### Reading resources: the opaque text channel

`company_skill_read` loads a resource the bundle carries, because the upstream consumer renders only the `resourceBase` hint — a workspace `read` or `bash` sees nothing. Its `path` must equal one carried entry exactly (`reference/pptd.md`, `references/workflows.md`, `editor/index.html`, or a `scripts/…` entry); it is compared for equality, never joined into a filesystem path, so `../`, absolute paths, and undeclared names reject. The addressed entry is materialized into a private directory under the same staging root, read back as UTF-8 text, and the directory is removed in a `finally` block, so the resource does not persist either.

- **Parameters** — `skill`, `path` (exact carried entry), and optional `maxBytes`.
- **Bound** — an entry over the read bound (default 256 KiB, per-call `maxBytes`) is refused rather than truncated, and a binary entry (invalid UTF-8) is refused; both rejections name the skill and path only, never a byte of the body.
- **Return** — `{ skill, path, text, bytes }`.

The nothing-persists guarantee is asserted in `tests/execute.spec.ts`: the script proves it really runs from its staged file (it reads its own source from disk), `__file__`-based root discovery and a Python sibling import are exercised for real, and once the run settles the staged root is gone and the temp root is empty. `tests/tool.spec.ts` then runs a shipped collected script (skill-creator's `scripts/init_skill.py`) end to end through the real plugin wiring, and `tests/collected-layout.spec.ts` runs the collected ppt-designer's own `resolve_editor_root()` against the staged tree.

## Bundle formats

`assets/skills.bundle` is a single XOR+base64 block (the codec of `tools/company-skills/lib/codec.mjs`) whose decoded document is a **container**:

```jsonc
{
  "version": 1,
  "skills": [
    { "name": "…", "description": "…", "body": "…",
      "scripts": [{ "path": "scripts/run.mjs", "content": "<base64>" }],
      "assets":  [{ "path": "reference/pptd.md", "content": "<base64>" }] }
  ]
}
```

- Each element is exactly one batch-1 skill bundle.
- Frame rules mirror the writer's `validateContainer`: version 1 only, exactly `version` and `skills`, at least one skill, unique skill names, ≤ 128 MiB of canonical JSON (2 × the 64 MiB per-skill bound; the shipped container measures ≈ 43 MiB).
- Element payload rules mirror `validateBundle`: exact field sets, kebab-case names, a ≤ 500-character single-line description (the catalog truncation bound), a non-empty body, and entries that are bundle-root-relative POSIX paths keyed by their **source-skill-relative** location — `scripts[]` is the executable addressing index (paths under `scripts/`), `assets[]` carries every other entry at its own path (`editor/index.html`, `reference/pptd.md`, `LICENSE.txt`), nested directories allowed — with canonical base64 content, each ≤ 8 MiB.
- The decoder accepts both shipped forms: a raw base64 asset or a generated `pack.mjs` module.
- Deliberately not re-checked at runtime: the packed-reference closure. That is an authoring invariant the packer enforces before the blob is written; re-deriving it here would only create a second place for the two implementations to disagree.

The plugin decoder is an **independent implementation**: it never imports `tools/`. `tests/container.spec.ts` closes that gap — it packs the fixtures through the real packer CLI, decrypts the artifact with this package's decoder, asserts the decoded element is byte-identical to the packer's canonical document, and materializes it back into the fixture directory byte for byte.

## Load policy: a bad asset never kills the host

A missing, unreadable, corrupt, empty, or future-versioned asset degrades to an **empty catalog with a reason**, never an exception. The module can therefore be imported and the provider registered on any profile, even one whose asset was lost or tampered with: a throw during plugin import fails the whole profile composition, which is far worse than an empty catalog. `list()` then returns nothing and `get()` returns `undefined`, which is exactly what the registry already handles for a provider with nothing to offer.

The reason travels with the catalog instead of being logged at import time (no context logger exists yet); the provider logs it once at its first `list()`, and once per unloadable skill. Within a container, the split is per skill: the index is validated at load, the payload at `get()`. A skill whose payload is corrupt still lists and simply refuses to load — one broken skill cannot empty the catalog. The bytes are already in memory once the single XOR block is decoded (a block is indivisible), so "on demand" means *materialized on demand*: no body, script, or asset is parsed, validated, or handed to the registry until a caller asks for that exact skill.

## Packaging and release surface

- `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`; the patch inserts exactly one row (`id: company-skills`, `name: dsh-company-skills`) with no config — adding a skill repacks the asset rather than changing the composition.
- The `files` whitelist ships `assets/skills.bundle` and **nothing plaintext**. `fixtures/**`, `tests/**`, and `scripts/**` are excluded, and a test asserts that no whitelist entry matches any file under them (using the batch-1 release-surface matcher), so a future `files` edit cannot quietly start publishing skill sources.
- Only the trained artifact ships: `lib/**` (tsdown bundle plus `tsc` declarations), the asset, the patch, the license, and these documents.

## Security posture

Obfuscation is **not** encryption. The XOR key is a shipped constant, so it only keeps skill bodies out of plaintext greps, out of `strings` on the asset, and out of casual copies of the profile directory; it does not resist anyone who reads the shipped JavaScript. The accepted bar is "plaintext must not persist for ordinary users" (scripts and resources may touch disk transiently inside a private `mkdtemp` directory — 0700 root and 0600 files on POSIX, mode ignored on Windows — deleted in `finally`), and the shared single-key gap is recorded and signed off in `tools/company-skills/README.zh.md` together with the upgrade path (per-skill derived keys, or asymmetric wrapping).

Two residual disclosures already signed off for P6 apply here unchanged: a skill's `description` reaches the catalog, and its `body` reaches session history once loaded — both are plaintext from that point on.

## Commands

```bash
corepack yarn workspace dsh-company-skills build          # tsdown bundle + tsc declarations
corepack yarn workspace dsh-company-skills typecheck
corepack yarn workspace dsh-company-skills test           # vitest, 70 cases
corepack yarn workspace dsh-company-skills verify:bundle  # assets/skills.bundle matches skills/
corepack yarn workspace dsh-company-skills check          # build + verify + typecheck + test

# refresh the collected copies (READ-ONLY on the skills hub), then re-apply the
# ppt-designer description trim by hand if SKILL.md changed, then regenerate:
node dsh-company-skills/scripts/collect-skills.mjs
node dsh-company-skills/scripts/build-bundle-asset.mjs
```

The generator is a thin wrapper over the batch-1 packer (`tools/company-skills/pack.mjs --skills dsh-company-skills/skills --out assets/skills.bundle`), so the writer stays in one place and this package owns only the reader. It is deterministic: no timestamps, name-sorted container, so `--check` is a pure byte comparison that runs in CI with no key material. The packer's dangling-reference lint (collected skills mention example paths in prose) warns on stderr and never blocks the artifact.

## Tests

| File | Cases | Coverage |
| --- | --- | --- |
| `tests/container.spec.ts` | 11 | codec constants shared with the packer; shipped asset decodes to one entry per collected skill (descriptions equal to the plaintext sources); packer→decoder cross-consistency (canonical document and source tree, byte for byte); raw blob and generated module; determinism (including shipped asset = a fresh pack of `skills/`); no plaintext in the artifact (with a decoded positive control and the 4.9 MiB font table's byte size) and none in any shipped plugin file; malformed frame and element rejection parity with the packer; release-surface whitelist covering `skills/` |
| `tests/collected-layout.spec.ts` | 3 | the collected bundle keys entries by source-relative path (`editor/index.html`, `reference/pptd.md`, `pptd-template/…`, `LICENSE.txt`) with no synthetic `assets/` prefix; the real collected `scripts/export_pptx.py`, imported as a sibling, resolves `<staged>/editor/index.html` through its own `resolve_editor_root()` |
| `tests/collect.spec.ts` | 3 | the collector's skill-name guard (kebab-case only; `..`, separators, absolute paths refused so `rmSync` can never leave `skills/`); arg parsing; a verbatim layout copy with `__pycache__` pruned |
| `tests/provider.spec.ts` | 11 | reactive `inject(['skills'])` registration plus disposal; late-mounted registry; bare `ctx.skills` throws; source-shape pin; `list()` index-only (no body, no `content`); `get()` materializes exactly one body; unknown name and unusable locator; a broken payload lists but refuses; missing/corrupt asset degrades without throwing; degraded catalog on a live host; module exports |
| `tests/execute.spec.ts` | 36 | interpreter selection and resolution (injected command → PATH → host executable); real materialized `node` runs (output, args passthrough, non-zero exit as data, the script reads its own staged source); the code-runtime-python paradigm for real (`__file__`-based root discovery equals the staged root and `DSH_SKILL_ASSETS`, a Python sibling import through `sys.path[0]`, cwd-relative asset reads); resource reads (nested text entry, a `scripts/` entry, one-entry private staging removed in `finally`, unknown/traversal path and unknown skill with no staging, over-bound rejection, binary rejection, malformed bound); nothing persists (staged root gone once settled, temp root empty, no body canary in the result, a failing cleanup — or a throwing warning sink — only warns); unknown skill / undeclared script / traversal / missing interpreter / invalid UTF-8 all reject before spawning with no residue; deadline, output-tail truncation, caller cancellation, launch failure — each removing the staged root; per-session concurrency bound and slot release; seam passthrough (materialized argv, staged cwd, env, grace, signal) |
| `tests/tool.spec.ts` | 6 | tool schemas, output shapes, budget, and `presentCall` for both tools; session/signal resolution from the execution context; render/`toRunValue`; the read tool's parameters and delegation; reactive registration on the tools seam and disposal; a shipped fixture script run end to end through the real plugin with staged-root cleanup |

Red-green evidence (measured in this batch):

- Replace the inject child fiber in `apply()` with a direct `ctx.skills.registerProvider()`, then run the seam pin → **red**: `expect(source).not.toMatch(/\bctx\.skills\./)`. (Runtime tests still pass, because the static `inject` declaration resolves; the pin is what keeps the disposable-child lifecycle honest.)
- Write the container document itself to `assets/skills.bundle` (i.e. ship plaintext) → **red**: `expected false, received true` on `artifact.includes('# Fixture hello')`.
- Drop the `try/catch` around the asset read → **red**: the degrade test fails with `ENOENT` instead of an empty catalog.
- Change the decoder's key string → **red**: the packer→decoder cross-consistency test fails immediately.
- Spawn `[interpreter, '-']` with the body on stdin instead of the staged file → **red**: the paradigm tests report `OWN-SOURCE-READ=false` and the `__file__`-root comparison fails, because a piped script has no real path.
- Drop the `finally` cleanup of the staged directory → **red**: the settled-run, timeout, cancellation, and launch-failure cases leave the temp root non-empty.
- Resolve `script` by taking the first bundle entry instead of matching the declared path → **red**: every traversal/undeclared-name case starts spawning and the `carries no script` assertions fail.
- Drop the `AbortSignal`/deadline fusion and rely on the host timeout only → **red**: the executor's `timed out after … ms` and `was cancelled` classifications never fire.
- Ignore `DSH_DESKTOP_NODE_EXECUTABLE` and launch the bare PATH name → **red**: the injected-command test sees `node` instead of the published absolute path.
- Let the cleanup `rm` reject out of the `finally` → **red**: a successful run whose removal hits EPERM is reported as a failure instead of returning its result.
- Map every non-script entry back under `assets/` (the batch-4 remap) → **red**: `tests/collected-layout.spec.ts` reports `EDITOR-INDEX=<staged>/assets/editor/index.html` and the collected `resolve_editor_root()` raises `EDITOR_MISSING_HINT`, exactly the failure this batch fixed.
- Drop the `company_skill_read` registration (or its tool builder) → **red**: the registration test expects `['company_skill_run', 'company_skill_read']`, and the read cases have no surface.

## Layout

```
dsh-company-skills/
  src/index.ts          plugin: module-init catalog load + inject-child registrations
  src/provider.ts       provider: index-only list(), on-demand get()
  src/catalog.ts        load policy, index, per-skill materialization
  src/container.ts      container frame decode (independent of tools/)
  src/bundle.ts         one skill bundle's field rules (independent of tools/)
  src/codec.ts          XOR+base64 decoder, key constants
  src/execute.ts        staged per-run script executor: addressing, materialization, bounds
  src/tool.ts           company_skill_run definition, render, presentCall
  assets/skills.bundle  the shipped container block (in files)
  cordis.patch.yml      the composition row (in files)
  scripts/              asset generator, skill collector, clean (never published)
  skills/               collected plaintext company skills (never published)
  fixtures/             plaintext fixture skills, test-only (never published)
  tests/                vitest + the local spawn seam (never published)
```

## Collected skills

`skills/` holds this package's shipped set, collected **read-only** from the
skills hub (`/opt/july/skills-hub/skills` — never written to):

- **ppt-designer** — 33 MiB of resources ride along (the offline neo-ppt editor
  mirror, the Deloitte PPTD template, design references, and the export
  scripts). Its frontmatter description is trimmed to the 500-character
  catalog bound in this copy; everything else is byte-identical to the source.
- **skill-creator** — shipped verbatim (its `references/` guide and its
  upstream Apache-2.0 `LICENSE.txt` keep their own root-relative paths).

Collection preserves each source skill root's layout **verbatim**: `editor/`,
`reference/`, `pptd-template/`, `references/`, `scripts/`, `LICENSE.txt`, and
`SKILL.md` keep their own relative paths, and the packer keys every bundle
entry by that same path, so the staged root reconstructs the original skill
directory exactly (`__file__`-based root discovery, sibling imports,
`reference/pptd.md` reads, and ppt-designer's `SKILL_DIR/editor/index.html`
lookup all work unmodified — the batch-4 remap under a synthetic `assets/`
prefix, which broke that lookup, is gone). `__pycache__` directories are
pruned. The upstream `resourceBase: { kind: 'opaque' }` hint still renders:
consumers address these skills through the catalog and the two company-skill
tools, never as local paths.

## What comes next

- Market handoff (`type: 'skill'`), MR, and a real-machine install
  verification: market install → the two skills appear in the catalog →
  `company_skill_run` executes a collected script → the staged root is gone
  afterwards and no plaintext persists on disk.

## License

MIT — see [LICENSE](LICENSE). The collected `skill-creator` carries its
upstream Apache-2.0 license as `assets/LICENSE.txt` inside its bundle.
