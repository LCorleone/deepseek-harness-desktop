# DSH Company Skills

[中文说明](README.zh.md)

DSH Company Skills is the container plugin that ships a set of curated company skills as **one obfuscated bundle** and publishes them through the DeepSeek Harness skill registry. It is the P6 batch-2 deliverable: batch 1 defines and writes the bundle format (`tools/company-skills`), this package reads it, batch 3 adds the script-execution channel, and batch 4 lands the first real skill set.

> **Current status: shipped as a placeholder container.** The asset carries two fixture skills (`fixture-hello`, `fixture-notes`) so the package builds, typechecks, and tests without any key material. The real container is repacked in batch 4; nothing else in the package changes.

## What it is

One Cordis plugin, one provider:

- **Plugin** `company-skills` — reads and decodes `assets/skills.bundle` once at module initialization and registers one provider through the skill registry seam.
- **Provider** `company-skills` — `list()` returns the decrypted index (name, description, rank, opaque locator) and never a body; `get()` validates and materializes exactly the skill that locator names.
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
}
```

A bare `ctx.skills` read inside a plugin fiber throws (`cannot get property "skills" without inject` under Cordis reflective contexts) — the failure mode a real third-party plugin hit, documented in `tools/company-catalog/plugin-sources/dsh-dai-engramory-0.2.4/README.md`. Registering straight from `apply()` would work, but it binds the registration to this plugin's own fiber instead of a disposable child; the child fiber's `effect()` owns the lifecycle, so unmounting the plugin unregisters the provider and invalidates the catalog caches.

`tests/provider.spec.ts` pins both halves: the bare read really does throw, and the plugin's source contains the `ctx.inject(['skills'], …)` form with no direct `ctx.skills.` use.

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
corepack yarn workspace dsh-company-skills test           # vitest, 22 cases
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

Red-green evidence (measured in this batch):

- Replace the inject child fiber in `apply()` with a direct `ctx.skills.registerProvider()`, then run the seam pin → **red**: `expect(source).not.toMatch(/\bctx\.skills\./)`. (Runtime tests still pass, because the static `inject` declaration resolves; the pin is what keeps the disposable-child lifecycle honest.)
- Write the container document itself to `assets/skills.bundle` (i.e. ship plaintext) → **red**: `expected false, received true` on `artifact.includes('# Fixture hello')`.
- Drop the `try/catch` around the asset read → **red**: the degrade test fails with `ENOENT` instead of an empty catalog.
- Change the decoder's key string → **red**: the packer→decoder cross-consistency test fails immediately.

## Layout

```
dsh-company-skills/
  src/index.ts          plugin: module-init catalog load + inject-child registration
  src/provider.ts       provider: index-only list(), on-demand get()
  src/catalog.ts        load policy, index, per-skill materialization
  src/container.ts      container frame decode (independent of tools/)
  src/bundle.ts         one skill bundle's field rules (independent of tools/)
  src/codec.ts          XOR+base64 decoder, key constants
  assets/skills.bundle  the shipped container block (in files)
  cordis.patch.yml      the composition row (in files)
  scripts/              asset generator + clean (never published)
  fixtures/             plaintext fixture skills (never published)
  tests/                vitest (never published)
```

## What comes next

- **Batch 3** adds the script-execution channel: `ctx.tools.register` plus `ctx.subprocess.spawn` with the script body on stdin, so `scripts/…` entries run without ever touching disk. This package already carries the script bytes in the bundle but does not execute them.
- **Batch 4** replaces the fixture container with the first real skill set, lands it in the market handoff (`type: 'skill'`), and verifies a real installation end to end.

## License

MIT — see [LICENSE](LICENSE).
