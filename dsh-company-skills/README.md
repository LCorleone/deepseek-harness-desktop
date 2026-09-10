# DSH Company Skills

[中文说明](README.zh.md)

DSH Company Skills is the container plugin that ships a set of curated company skills as **one obfuscated bundle** and publishes them through the DeepSeek Harness skill registry. It is the P6 batch-2/3 deliverable: batch 1 defines and writes the bundle format (`tools/company-skills`), this package reads it, batch 3 adds the zero-plaintext script-execution channel, and batch 4 lands the first real skill set.

> **Current status: shipped as a placeholder container.** The asset carries two fixture skills (`fixture-hello`, `fixture-notes`) so the package builds, typechecks, and tests without any key material. The real container is repacked in batch 4; nothing else in the package changes.

## What it is

One Cordis plugin, one provider, and one model-facing tool:

- **Plugin** `company-skills` — reads and decodes `assets/skills.bundle` once at module initialization and registers one provider through the skill registry seam.
- **Provider** `company-skills` — `list()` returns the decrypted index (name, description, rank, opaque locator) and never a body; `get()` validates and materializes exactly the skill that locator names.
- **Tool** `company_skill_run` — runs one declared `scripts/…` entry with the script source on the interpreter's stdin, so the bytes are executed without ever being written to disk (see [Script execution](#script-execution-the-zero-plaintext-channel)).
- **Precedence** — every skill reports `source: 'bundled'` and `BUNDLED_SKILL_RANK` (600), the packaged-root rank. A project (`.dsh/skills`, `.agents/skills`) or a user (`$DSH_HOME/skills`, `~/.agents/skills`) skill of the same name keeps winning: the company catalog is always available but never silently overrides a skill a repository or a user deliberately wrote down.
- **Resource base** — `{ kind: 'opaque', description: … }`. The referenced scripts and assets travel inside the plugin, not on local disk, so the upstream loader renders an opaque hint instead of a directory or URL and every existing consumer needs zero changes. Bodies are never truncated (only catalog descriptions are bounded, at the catalog's own 500 characters, which the packer already enforces).

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
  })
}
```

A bare `ctx.skills` read inside a plugin fiber throws (`cannot get property "skills" without inject` under Cordis reflective contexts) — the failure mode a real third-party plugin hit, documented in `tools/company-catalog/plugin-sources/dsh-dai-engramory-0.2.4/README.md`. Registering straight from `apply()` would work, but it binds the registration to this plugin's own fiber instead of a disposable child; the child fiber's `effect()` owns the lifecycle, so unmounting the plugin unregisters the provider and invalidates the catalog caches.

`tests/provider.spec.ts` pins both halves: the bare read really does throw, and the plugin's source contains the `ctx.inject(['skills'], …)` form with no direct `ctx.skills.` use. The tool rides the same reactive form on `['tools', 'subprocess']`, so a profile without those services still gets the provider and gets the tool as soon as they mount later.

## Script execution: the zero-plaintext channel

`company_skill_run` is the only way to execute a bundle's `scripts/…` entries. The engine (`src/execute.ts`) is deliberately independent of the desktop: it resolves the interpreter from `DSH_DESKTOP_NODE_EXECUTABLE` / `DSH_DESKTOP_PYTHON_EXECUTABLE` (the absolute commands the desktop publishes at runtime), then from the child's `PATH`, and — for Node only — from the host executable itself (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, which is Node in a CLI host and Electron-as-Node in the desktop). It spawns through the host's `ctx.subprocess.spawn` seam, so a packaged Windows machine whose PATH carries only `.cmd` shims (unusable by a shell-less spawn) still runs `.mjs` and `.py` scripts.

- **Parameters** — `skill` (a company skill name), `script` (a bundle-relative path that must equal one of *that skill's own* `scripts[]` paths, e.g. `scripts/report.mjs`), and optional `args` (extra argv, appended verbatim after the interpreter's `-` script marker).
- **Delivery** — the decoded script text is written to the child's **stdin** (`node -` / `python -`); it is never written to a file and never appears in a log, a telemetry event, or an error message. Node's stdin module detection means both `require`-style and `import`-style scripts work.
- **Interpreter** — extension-selected family (`.mjs` / `.js` → Node, `.py` → Python), resolved as above; an unresolved interpreter rejects before anything spawns, and an invalid-UTF-8 body is rejected instead of being decoded lossily. Any other extension is rejected before anything spawns.
- **Addressing** — `script` is compared for exact equality against the validated bundle entries, never joined into a filesystem path, so `../`, absolute paths, and undeclared names all reject without spawning.
- **Assets** — when the skill carries assets they are materialized under one private `mkdtemp` directory (`$TMPDIR/dsh-skill-assets-*`) that stands in for the bundle root (`assets/notes.md` → `<dir>/assets/notes.md`), published to the child as `DSH_SKILL_ASSETS`, and deleted in a `finally` block as soon as the run settles — including on timeout, cancellation, and failure. A cleanup failure (Windows can report EPERM while the just-exited child still holds a handle) is logged as a warning and never changes the settled result. A skill with no assets stages nothing and the variable is never set.
- **Bounds** — each stream is retained as a bounded tail (64 KiB by default, overflow reported as `truncated`), the run has its own 120 s deadline fused with the caller's signal, and at most one run per session may be in flight. Every rejection is a `SkillRunError` naming the skill and script path only.
- **Return** — `{ skill, script, exitCode, stdout, stderr, stdoutTruncated, stderrTruncated }`; a non-zero exit code is data, not a thrown error.

The zero-disk guarantee is asserted by the script itself in `tests/execute.spec.ts`: the test script walks the temp root — plus the top level of the (pinned) default temp root — while it runs and reports the number of files containing its own source canary, which must be `0`. `tests/tool.spec.ts` then runs the shipped `fixture-hello/scripts/hello.mjs` end to end through the real plugin wiring.

## Bundle formats

`assets/skills.bundle` is a single XOR+base64 block (the codec of `tools/company-skills/lib/codec.mjs`) whose decoded document is a **container**:

```jsonc
{
  "version": 1,
  "skills": [
    { "name": "…", "description": "…", "body": "…",
      "scripts": [{ "path": "scripts/run.mjs", "content": "<base64>" }],
      "assets":  [{ "path": "assets/notes.md", "content": "<base64>" }] }
  ]
}
```

- Each element is exactly one batch-1 skill bundle.
- Frame rules mirror the writer's `validateContainer`: version 1 only, exactly `version` and `skills`, at least one skill, unique skill names, ≤ 16 MiB of canonical JSON.
- Element payload rules mirror `validateBundle`: exact field sets, kebab-case names, a ≤ 500-character single-line description (the catalog truncation bound), a non-empty body, and entries that are bundle-root-relative POSIX paths under `scripts/` or `assets/` with canonical base64 content.
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

Obfuscation is **not** encryption. The XOR key is a shipped constant, so it only keeps skill bodies out of plaintext greps, out of `strings` on the asset, and out of casual copies of the profile directory; it does not resist anyone who reads the shipped JavaScript. The accepted bar is "keep plaintext off disk for ordinary users", and the shared single-key gap is recorded and signed off in `tools/company-skills/README.zh.md` together with the upgrade path (per-skill derived keys, or asymmetric wrapping).

Two residual disclosures already signed off for P6 apply here unchanged: a skill's `description` reaches the catalog, and its `body` reaches session history once loaded — both are plaintext from that point on.

## Commands

```bash
corepack yarn workspace dsh-company-skills build          # tsdown bundle + tsc declarations
corepack yarn workspace dsh-company-skills typecheck
corepack yarn workspace dsh-company-skills test           # vitest, 50 cases
corepack yarn workspace dsh-company-skills verify:bundle  # assets/skills.bundle matches fixtures/
corepack yarn workspace dsh-company-skills check          # build + verify + typecheck + test

# regenerate the shipped asset after editing fixtures/ (or, in batch 4, the real skills)
node dsh-company-skills/scripts/build-bundle-asset.mjs
```

The generator is a thin wrapper over the batch-1 packer (`tools/company-skills/pack.mjs --skills dsh-company-skills/fixtures --out assets/skills.bundle`), so the writer stays in one place and this package owns only the reader. It is deterministic: no timestamps, name-sorted container, so `--check` is a pure byte comparison that runs in CI with no key material.

## Tests

| File | Cases | Coverage |
| --- | --- | --- |
| `tests/container.spec.ts` | 11 | codec constants shared with the packer; shipped asset decodes to one entry per fixture; packer→decoder cross-consistency (canonical document and source tree, byte for byte); raw blob and generated module; determinism; no plaintext in the artifact (with a decoded positive control) and none in any shipped plugin file; malformed frame and element rejection parity with the packer; release-surface whitelist |
| `tests/provider.spec.ts` | 11 | reactive `inject(['skills'])` registration plus disposal; late-mounted registry; bare `ctx.skills` throws; source-shape pin; `list()` index-only (no body, no `content`); `get()` materializes exactly one body; unknown name and unusable locator; a broken payload lists but refuses; missing/corrupt asset degrades without throwing; degraded catalog on a live host; module exports |
| `tests/execute.spec.ts` | 23 | interpreter selection and resolution (injected command → PATH → host executable); real `node -` runs over stdin (output, args passthrough, non-zero exit as data); zero plaintext on disk (the script's own walk of the injected root and the default temp root finds no copy of its source, staged assets are removed, the result carries no canary, a failing cleanup only warns); unknown skill / undeclared script / traversal / missing interpreter / invalid UTF-8 all reject before spawning; deadline, output-tail truncation, caller cancellation, launch failure — each removing staged assets; per-session concurrency bound and slot release; seam passthrough (argv, stdin body, cwd, grace, signal) |
| `tests/tool.spec.ts` | 5 | tool schema, output shape, budget, and `presentCall`; cwd/session/signal resolution from the execution context; render/`toRunValue`; reactive registration on the tools seam and disposal; a shipped fixture script run end to end through the real plugin with staged-asset cleanup |

Red-green evidence (measured in this batch):

- Replace the inject child fiber in `apply()` with a direct `ctx.skills.registerProvider()`, then run the seam pin → **red**: `expect(source).not.toMatch(/\bctx\.skills\./)`. (Runtime tests still pass, because the static `inject` declaration resolves; the pin is what keeps the disposable-child lifecycle honest.)
- Write the container document itself to `assets/skills.bundle` (i.e. ship plaintext) → **red**: `expected false, received true` on `artifact.includes('# Fixture hello')`.
- Drop the `try/catch` around the asset read → **red**: the degrade test fails with `ENOENT` instead of an empty catalog.
- Change the decoder's key string → **red**: the packer→decoder cross-consistency test fails immediately.
- Write the script body to a file and spawn the file (instead of piping it to stdin) → **red**: the zero-disk test's own scan reports `SCRIPT-SOURCE-HITS=1` instead of `0`, and the temp root is not left empty.
- Resolve `script` by taking the first bundle entry instead of matching the declared path → **red**: every traversal/undeclared-name case starts spawning and the `carries no script` assertions fail.
- Drop the `AbortSignal`/deadline fusion and rely on the host timeout only → **red**: the executor's `timed out after … ms` and `was cancelled` classifications never fire.
- Ignore `DSH_DESKTOP_NODE_EXECUTABLE` and launch the bare PATH name → **red**: the injected-command test sees `node` instead of the published absolute path.
- Remove the `finally` cleanup of the staged-assets directory → **red**: the timeout, cancellation, and launch-failure cases leave the temp root non-empty.
- Let the cleanup `rm` reject out of the `finally` → **red**: a successful run whose removal hits EPERM is reported as a failure instead of returning its result.

## Layout

```
dsh-company-skills/
  src/index.ts          plugin: module-init catalog load + inject-child registrations
  src/provider.ts       provider: index-only list(), on-demand get()
  src/catalog.ts        load policy, index, per-skill materialization
  src/container.ts      container frame decode (independent of tools/)
  src/bundle.ts         one skill bundle's field rules (independent of tools/)
  src/codec.ts          XOR+base64 decoder, key constants
  src/execute.ts        stdin-piped script executor: addressing, assets, bounds
  src/tool.ts           company_skill_run definition, render, presentCall
  assets/skills.bundle  the shipped container block (in files)
  cordis.patch.yml      the composition row (in files)
  scripts/              asset generator + clean (never published)
  fixtures/             plaintext fixture skills (never published)
  tests/                vitest + the local spawn seam (never published)
```

## What comes next

- **Batch 4** replaces the fixture container with the first real skill set, lands it in the market handoff (`type: 'skill'`), and verifies a real installation end to end.

## License

MIT — see [LICENSE](LICENSE).
