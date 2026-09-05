# Agent Note: Company plugin market — owner handover and development guide

Status: Implemented (2026-09-04, P7 closed loop: dsh-free-search 0.4.182 live over the tarball channel, deployed manifest sequence 12)

English | [中文](2026-09-04-company-market-owner-handover.zh.md)

This is the cold-start document for whoever (person or AI agent) takes over
the company plugin-market subsystem. Everything below was verified against
the tree at master `e4490c3f82` on 2026-09-04 — paths, commands, workflow
names, and hashes were checked against the repository, not recalled.
Companion reading, in order of authority: `tools/company-catalog/README.md`
(the bilingual pipeline manual), the P7 card in
`dev-log/2026-08-22-company-market-lockdown-plan-v2.md` (implementation
history including today's four real-device pitfalls), and the module header
comments cited in §1.

## 1. Ownership map — who owns what

Five ownership areas. Nothing in the market crosses them accidentally: each
boundary is enforced by a gate (layout gate, architecture gate, CI split).

| Area | Owns | Key entry points (one line each) |
| --- | --- | --- |
| `dsh-plugin-desktop/` | The Electron client: install chain, verification, boot re-verification, CLI gate | `src/desktop-market.ts` — provider pin + the dual-channel strict verifier `verifyDesktopCompanyManifest` + controlled tarball staging/install · `src/company-market-install.ts` — the market UI wiring (verifier seam + pnpm diversion hook) · `src/boot-verification.ts` — `verifyDesktopBootBundles` and `computeDesktopBootTreeRootDigest` · `src/cli-install-channel.ts` — the locked terminal add gate `authorizeLockedPluginAdd` · `src/company-tarball-handoff.ts` — the `DSH_COMPANY_TARBALL_HANDOFF` trusted hand-off · `src/pnpm.ts` — the pnpm boundary with the one constructible `file:` target · `src/desktop-policy.ts` + `src/policy/desktop-policy.release.json` — the locked policy and pinned `trustRoots` |
| `dsh-community-market/` | The market UI service + the signing/verification library + the catalog-provider injection surface | `src/catalog/company-provider.ts` — `CompanyCatalogProvider` (fail-closed scan; origin/content acquisition modes) · `src/index.ts` — the `desktopCompanyManifestVerifier` capability the desktop host injects (line ~333) · `docs/schemas/company-manifest.schema.json` — the signed wire schema (`additionalProperties: false`) · the signing library exports (`verifyCompanyManifest`, `createCompanyManifestSignature`, canonical JSON) used by the tooling |
| `tools/company-catalog/` | The publishing pipeline (allowlist → pack → measure → sign → publish) **and the true source of vendored plugins** | `cli.mjs` — keygen/build/pack-tarball/measure-and-publish/revoke/verify/selftest · `measure.mjs` — reference-install treeDigest measurement · `publish-local.mjs` — the intranet-side publisher · `e2e-tarball.mjs` — the offline full-chain drill · `allowlist.json` — the only human-authored input (review-only) · `state/last-sequence.json` — the GitHub-side sequence ratchet (currently 12) · `plugin-sources/dsh-free-search-0.4.183/` — the hardened vendored source of truth (see its `README-hardened.zh.md`) · `fixtures/fixture-hello/` — the drill fixture |
| GitLab `julu/dsh-desktop-config` | The deployment surface employees' machines actually read | `catalog-manifest.json` on `master` (raw URL pinned in the desktop policy: `https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`) · `packages/<name>-<version>.tgz` — the tarball-channel artifacts |
| CI (`.github/workflows/`) | The operational workflow trio + CI gates | `company-catalog-publish.yml` ("Company catalog publish", manual dispatch, `windows-latest`, dry-run default **true**) — measure → fill → sign → verify → artifact + `catalog-artifacts` branch mirror; never touches GitLab · `company-catalog-digest.yml` ("Company catalog digest (Windows)", manual dispatch) — Windows reference treeDigest measurement, never signs or publishes · `windows-package.yml` ("Windows Package", manual dispatch) — the fleet build (installer + install/E2E smoke) · plus `company-catalog.yml` ("Company catalog", manual) for the pipeline selftest/tests/e2e and `ci.yml` for pushes |

Rule of thumb for routing work: anything the **client enforces** lands in
`dsh-plugin-desktop`; anything the **market UI serves or verifies** lands in
`dsh-community-market` (which must never import desktop implementation — the
architecture gate enforces the dependency direction); anything that
**produces or publishes trust** lands in `tools/company-catalog`; the
GitLab config repo is written only by `publish-local.mjs`.

## 2. Trust model and red lines — what must never break

**The chain in one sentence:** a reviewed `allowlist.json` is assembled into
a canonical-JSON manifest, signed with a detached ed25519 signature, and
served from the intranet GitLab; clients verify the manifest against pinned
trust roots and install only what it pins — npm-channel entries from
`registry.npmjs.org`, tarball-channel entries from the same GitLab origin —
then re-verify the installed tree at every boot.

1. **Ed25519 signature chain.** keyId `company-catalog-2026-08`, public-key
   fingerprint `c46940234dc854ad3964d561ee4e52adf20dc73cb578e26b98f120aec1049af6`
   (pinned in `dsh-plugin-desktop/src/policy/desktop-policy.release.json`
   `trustRoots`; the manifest verifies against pinned roots only). The
   private key exists only in CI secrets, read from the environment, never
   on disk, never in any artifact.
2. **Tarballs are immutable.** The pack is deterministic; the signed sha512
   binds the exact bytes. Any content change — even one line — is a **new
   version** with a new filename, new integrity, new treeDigest, higher
   sequence. Re-publishing different bytes under the same version is not a
   supported operation anywhere in the pipeline.
3. **The sequence ratchet is monotonic and two-sided.** Every publish must
   strictly exceed the previous sequence; the counter never rolls back, so a
   bad publish can only be superseded, never un-published. GitHub floors at
   the committed `state/last-sequence.json`; `publish-local.mjs`
   independently requires `artifact.sequence == deployed + 1` against the
   manifest GitLab actually serves. A stale or jumped state file fails
   closed on the intranet side.
4. **The fleet gate (schema evolution discipline).** `source`,
   `treeDigest`, and `approvedBuilds` are optional to the *signer*, not to
   the fleet: old clients verify with `additionalProperties: false`, so one
   unknown key makes them reject the **entire** manifest and the whole
   catalog goes dark on those machines. "Field-aware for `source`" means
   **three consumers** all verify through `verifyDesktopCompanyManifest`:
   boot verification (`verifyDesktopBootBundles`), the locked terminal add
   gate (`authorizeLockedPluginAdd`), and the locked market catalog provider
   (`CompanyCatalogProvider`, fed by the `desktopCompanyManifestVerifier`
   capability injection). Until the whole fleet runs such builds, no
   `source`-carrying manifest may be published;
   `publish-local --confirm-fleet-upgraded` is the operator's explicit
   assertion that it does. The next breaking change must bump
   `manifestVersion`, never mutate `1.0.0`.
5. **The CLI red line.** A user argument can never construct a controlled
   tarball target: the pnpm boundary rejects every user-argument tarball
   path, and the locked terminal gate denies user-typed `file:` targets.
   The **one** exception is the trusted hand-off
   `DSH_COMPANY_TARBALL_HANDOFF`: constructed by the trusted Electron main
   process, injected per spawn (never in the generation-wide policy
   hand-off, never persisted in a terminal shim), consumed — removed from
   the environment — by the CLI bootstrap before the upstream import so
   pnpm children never inherit it, and admitted **only after double
   verification**: the hand-off must re-bind to a signed catalog entry
   (name@version + signed sha512 + the deterministic staging path inside
   the profile) and a fresh hash of the staged bytes must equal the signed
   sha512. Red-line tests live in
   `dsh-plugin-desktop/tests/company-market-locked-cli-install.spec.ts`.
6. **Never touch `deepseek-harness/`.** The upstream submodule stays
   byte-identical (the layout gate checks it); all client work lives in
   `dsh-plugin-desktop` and `dsh-community-market`. Same discipline:
   market source must not depend on desktop implementation.
7. **The plugin package directory is runtime-immutable.** Boot tree
   verification (`computeDesktopBootTreeRootDigest` in
   `boot-verification.ts`) hashes **every** file of the installed package
   directory — zero exclusions: files by content, symlinks by target text,
   sorted records, root digest over the `sha256:<path>\n<digest>\n` lines.
   A plugin that writes into its own package directory at runtime
   (config/cache/logs) changes the tree and is **refused at the next boot**
   — fail-closed, deliberately indistinguishable from external tampering.
   Runtime state belongs in the plugin's ctx settings section
   (`settings.yaml`), `userData`, or `~/.dsh` state directories. This is
   also simply consistent with pnpm's ownership: install/uninstall resets
   the package directory, so anything written there would not survive an
   update anyway — the digest mechanism just turns the ecosystem
   convention into an enforced invariant.

Also standing: revocation is a state, not a deletion (`revoked: true`
entries stay signed for audit); one package name never straddles both
channels with active entries (`loadAllowlist` refuses the mix; migrate by
revoking the old channel first); npm entries must never carry a `url`; the
npm channel installs only from `registry.npmjs.org` — repacking mirrors
break the integrity binding and are rejected.

## 3. Listing a plugin end to end — the free-search paradigm

The reference run is `dsh-free-search` 0.4.182 (deployed at sequence 12,
treeDigest `adce37b46c7f255ab82cce45fb2309b6ac3bf29b8d7f45add2efaff5a2fa6a0b`).
The order below is the order that works; the README holds the full command
detail, this section gives the sequence and the judgment calls.

1. **Ingest and review (收编).** Security-review the source, strip bypass
   surfaces (self-update paths, local HTTP servers, credential-center
   integrations, unused outbound engines — see
   `plugin-sources/dsh-free-search-0.4.183/README-hardened.zh.md` for the
   worked example), and declare the runtime match:
   `runtime.dshRuntimeVersion` must match the pinned harness range
   (`^0.1.1-rc.2` today). Company revisions encode as a fourth patch digit
   (`0.4.182`, not `0.4.18-company.1` — the schema's stable-version pattern
   refuses prerelease spellings). **The review checklist includes the
   runtime-immutability rule from §2.7:** runtime state must go through the
   ctx settings section (`settings.yaml`) / `userData` / `~/.dsh`, never
   into the plugin's own package directory — the boot tree digest has zero
   exclusions and a self-writing plugin bricks itself at the next boot.
   free-search storing its engine keys in its own settings section
   (`installSettingsSection` from `@deepseek-ai/dsh-settings`) is the
   positive example.
2. **Vendor the reviewed source** into
   `tools/company-catalog/plugin-sources/<name>-<version>/` — the stem
   convention `pack-tarball --from-allowlist` resolves. This directory is
   the source of truth; the tarball is a build artifact.
3. **Add the allowlist entry** (PR + review). Tarball channel:
   `source: {kind: "tarball", url: "<GitLab raw packages url>", path:
   "tools/company-catalog/out/packages/<name>-<version>.tgz"}` — the
   `integrity` is computed at pack time (never hand-entered; `path` and
   `integrity` are mutually exclusive in the allowlist), `treeDigest` left
   **absent** pending measurement. `bundlePatch` must equal the package's
   own `dsh.bundle.patch` declaration byte-for-byte (`"./cordis.patch.yml"`
   — the pipeline now refuses drifted spellings at sign time; see pitfall ④
   in §5).
4. **Pack** — `node tools/company-catalog/cli.mjs pack-tarball
   --from-allowlist` (or `--source-dir` for a one-off) produces the
   deterministic `out/packages/<name>-<version>.tgz`.
5. **Measure the treeDigest** in the reference environment. The normal path
   is the **digest workflow** (manual dispatch of "Company catalog digest
   (Windows)"): it packs, installs through the same reference matrix the
   fleet deploys (repository-pinned pnpm 11.8.0, hoisted profile scaffold,
   build-approval merge, the electron runtime env trio), hashes with the
   compiled `computeDesktopBootTreeRootDigest`, and uploads `digest.json`
   plus the packed tarballs for byte forensics. **Convention:** the Windows
   value is the fleet's reference; a Linux `measure.mjs` run should agree
   (0.4.182 agreed on both platforms at `adce37b4…`). Disagreement means
   investigate (stale cache, environment drift) — never hand-pick a value.
   The pipeline never derives digests from local disk state alone.
6. **Review the measured value into `allowlist.json`** — a human review
   commit; the pipeline only ever signs a runtime copy.
7. **CI publish** — manual dispatch of "Company catalog publish". `dry-run`
   (default) runs the identical measure → fill → sign → verify chain and
   uploads nothing. Uncheck `dry-run` to upload the `company-catalog-signed`
   artifact (`catalog-manifest.json` + `publish-meta.json` +
   `packages/*.tgz`) and mirror it to the `catalog-artifacts` branch; the
   summary prints the intranet command. The runner never pushes to GitLab.
8. **Intranet publish** — on a machine that reaches both GitHub and the
   intranet GitLab (`gh` + `git` on PATH), with `GITLAB_TOKEN` exported
   (prefer the env var over `--token`: the flag puts the PAT in the
   script's own argv):
   ```sh
   node tools/company-catalog/publish-local.mjs --run <run-id> --confirm-fleet-upgraded
   ```
   `--confirm-fleet-upgraded` is required for the first authoritative
   publish of a new field (§2.4). Known intranet pitfalls: Node's fetch
   rejects the corporate TLS chain — pass `--insecure-tls` (it sets
   `NODE_TLS_REJECT_UNAUTHORIZED=0`; trust is carried by the signature
   gauntlet, but prefer `NODE_EXTRA_CA_CERTS` with the corporate root when
   available); if GitHub artifact blob storage is unreachable, the
   `catalog-artifacts` branch fallback engages automatically (or
   `--from-git <run-id>` explicitly). `publish-local` re-verifies
   everything (sidecar sha256, signature, ratchet) before the byte-exact
   push and re-reads the raw URL until it serves the exact pushed bytes.
9. **Commit the state bump** — `tools/company-catalog/state/last-sequence.json`
   → the published sequence (12 today). This is the GitHub-side ratchet for
   the next build; forgetting it makes the next run sign a too-low sequence
   that fails closed intranet-side.

Emergency reversal at any point: `node tools/company-catalog/cli.mjs
revoke <pkg>[@<version>]`, then reissue and publish exactly as above
(§7). Note the aborted sequence 11 (0.4.181) in the history: superseded by
12, never reused — that is the ratchet working as designed.

## 4. The client install chain — five gates

For a tarball-channel entry, the market install passes five gates, each
fail-closed with a readable reason:

1. **Signed manifest verification.** `verifyDesktopCompanyManifest`:
   canonical-JSON byte equality, strict shape (unknown keys reject the
   whole manifest), trust-root binding (keyId + fingerprint), the detached
   ed25519 signature, the anti-rollback sequence floor, expiry, and
   per-entry channel resolution.
2. **Controlled download.** `stageCompanyMarketTarball` fetches the entry's
   url (must live on the policy `companyCatalogOrigin`), verifies the
   **signed sha512 over the downloaded bytes**, and stages the file inside
   the profile's controlled staging area — never a user-chosen path.
3. **The pnpm controlled `file:` target.** The install runs through the
   package-manager boundary's single constructible tarball target — the
   market channel's own request, crossing the CLI gate via the trusted
   `DSH_COMPANY_TARBALL_HANDOFF` (double-verified, §2.5). A user argument
   can never reach this target.
4. **Post-install bundle assertions.** After pnpm materializes the tree:
   bundle identity, the `bundlePatch` **strict equality** (the package's
   `dsh.bundle.patch` declaration must equal the signed entry byte-for-byte
   — including the `./` prefix), and the installed tree re-measured against
   the signed `treeDigest`. Divergence rolls the install back and settles
   the handle with the readable reason.
5. **Boot re-verification.** Every startup re-runs
   `verifyDesktopBootBundles`: the signed `treeDigest` is the authoritative
   expectation (the market receipt is demoted to an advisory cache —
   deleting or forging it changes nothing), the full package tree is
   re-hashed with zero exclusions, and a mismatch refuses **that bundle**
   (never the whole startup — the upstream web client always boots; missing
   third-party bundles load as manifest-only until anchored).

**Failure surface.** The market UI shows the one-line reason; the desktop
log keeps the full assertion detail (name + expected-vs-actual — that
logging rode the §5.②/③ fixes). Logs live at
`%APPDATA%\DSH Desktop\logs` (`<userData>/logs`, files
`dsh-YYYY-MM-DD.log` with `.error` and numbered segments). For field
triage hand the user `dev-log/grab-dsh-logs.ps1` (right-click → Run with
PowerShell; collects the newest `dsh-*.log` under `%APPDATA%`/
`%LOCALAPPDATA%` and `~/.dsh` into a `dsh-logs-<timestamp>.txt` on the
Desktop). `--export-diagnostics` bundles logs and the verification
evidence for deeper cases.

## 5. Real-device war stories — the four pitfalls of 2026-09-04 (and one cache lesson)

All four surfaced installing free-search 0.4.181 (sequence 11) on a real
company Windows machine; all are fixed in-tree and covered by tests.

**① The CLI gate shot the market's own channel.**
*Symptom:* market install of the tarball entry fails with the locked-add
denial text — the gate rejecting a `file:` target it was supposed to carry.
*Root cause:* the market's controlled install path executes through the
packaged CLI child (`dsh plugin add … file:<staged path>`), and the P2-5
terminal gate denies **every** `file:` argument — including the market
channel's own. *Fix:* the trusted hand-off `DSH_COMPANY_TARBALL_HANDOFF`
(`26f1ecb4dc`): the launcher hands the one allowed target across the
process boundary; the gate admits it only after re-binding it to the
signed catalog entry and re-hashing the staged bytes. User-typed `file:`
targets stay denied. *Prevention:* the red-line tests in
`company-market-locked-cli-install.spec.ts` pin both directions (hand-off
admitted, user argument refused).

**② EPERM atomic-rename race (Windows AV).**
*Symptom:* random fatal crash at startup or install — `EPERM` on an atomic
rename of `settings.yaml`. *Root cause:* antivirus/indexers transiently
hold handles; upstream `@deepseek-ai/dsh-atomic-write` had no retry.
*Fix:* a yarn patch —
`.yarn/patches/@deepseek-ai-dsh-atomic-write-npm-0.1.1-rc.2-be3f055a11.patch`
— adds bounded backoff retries, plus bundle-assertion failure logging
(`600228a0c1`). Every atomic-write consumer benefits; one whole class of
"random" Windows crashes is gone. *Prevention:* when a transient Windows
file error appears, check the patch is still applied after dependency
bumps before suspecting the caller.

**③ A bare catch swallowed the assertion cause.**
*Symptom:* install failed with a generic exit-code line; neither the UI nor
the log said which assertion or what was expected. *Root cause:* the
market service caught the install-assertion failure and dropped the cause.
*Fix:* inline cause detail everywhere (`59dd5086c0`,
`600228a0c1`): the package-manager child's stderr is bridged live into the
channel's stderr, assertion names and expected-vs-actual land in the
desktop log via the `logError` sink, and the market UI surfaces the
readable tail. *Prevention:* never land a bare `catch` on an install
assertion — the log enhancement took three iterations; the current state
(full detail in `error.log` and UI) is the standard to keep.

**④ The `./` prefix mismatch on `bundlePatch`.**
*Symptom:* post-install assertion failure on a freshly built hardened
package — the package's `dsh.bundle.patch` declared `cordis.patch.yml`
while the signed entry pinned `./cordis.patch.yml`; strict equality fails.
*Root cause:* the hardened vendoring drifted from the ecosystem spelling
the verifier enforces. *Fix:* 0.4.182 realigns the declaration, and the
pipeline gained a **build-time consistency assertion** — a prefix-drifted
spelling is now refused at pack/sign time (visible in the e2e output:
"the 0.4.181 failure class, now caught at build time"). *Prevention:* the
pipeline-level gate; review `bundlePatch` spellings against the package
declaration when touching either side.

**Cache lesson — stale `out/` artifacts lie.** During the 0.4.182 digest
cross-check, a stale packed tarball left in `tools/company-catalog/out/`
produced an apparent Windows/Linux digest divergence that vanished after
cleaning the cache and re-packing. Before treating a digest disagreement
as real: `rm -rf tools/company-catalog/out` (or force a fresh
`pack-tarball`) and re-measure. The digest workflow now packs its own
tarballs into its artifact precisely so divergences can be byte-forensiced
instead of guessed at (`27759e38e0`).

Build-line context: the fleet gate was satisfied with every client ≥ #47;
build **#50** carries all four fixes and is the known-good client for
0.4.182 (everything after #50 was catalog/pipeline-side only).

## 6. Testing and verification

Baseline, freshly verified on master `e4490c3f82` (2026-09-04) with
`corepack yarn check` — green end to end:

- `dsh-community-market`: 400 tests (24 files) · `dsh-plugin-desktop`:
  1789 passed + 7 skipped · `tools/company-catalog`: 70 tests ·
  e2e `PASS` · bilingual gate: 46 records / 92 documents consistent.

How to run the pieces:

- **Full gate:** `corepack yarn check` (root `package.json` chains layout →
  fabric → market → desktop → company-catalog; ~5–10 min).
- **Tools unit tests:** `corepack yarn test:company-catalog` — or directly
  `node --test tools/company-catalog/tests/allowlist-tarball.test.mjs …`
  (six files, explicitly listed). **Pitfall:** `node --test
  tools/company-catalog/tests/` — the directory form — does **not** work on
  the Node 22 toolchain (verified on v22.22.3; CI pins v22.23.2): Node treats
  the directory as a module path and dies with `MODULE_NOT_FOUND`; that is
  why the script spells every file out.
- **Offline full-chain drill:** `node tools/company-catalog/e2e-tarball.mjs`
  (needs the built market + desktop libs; runs as the tail of
  `check:company-catalog`). It packs the `fixture-hello` fixture, signs
  with an ephemeral key, dry-run publishes, and cross-verifies with the
  compiled desktop verifier — no network at all.
- **Real-composition combo smoke (P8 surface, same harness):**
  `dsh-plugin-desktop/tests/agent-browser-composition.spec.ts` runs
  `scripts/agent-browser-smoke.mjs` under `DSH_XVFB=1`; the manual form is
  `xvfb-run -a node_modules/electron/dist/electron --no-sandbox
  --disable-gpu scripts/agent-browser-smoke.mjs` after `corepack yarn
  build`. This is the only place real Electron/CDP behavior runs end to
  end.
- **Digest cross-check:** dispatch the digest workflow and compare its
  Windows digests against a local Linux `measure.mjs` run — agreement is
  the norm (see §3.5 and the §5 cache lesson).
- **Pipeline selftest:** `node tools/company-catalog/cli.mjs selftest`
  (ephemeral key; never publishes, never touches `state/`, `out/`, or
  `allowlist.json`).

## 7. Operations quick reference

- **Revoke a plugin:** `node tools/company-catalog/cli.mjs revoke
  <pkg>[@<version>]` → reissue and publish through the normal §3 chain.
  Effect: market rows disappear within the catalog scan TTL
  (`DEFAULT_CATALOG_SCAN_CACHE_TTL_MS`, ~5 min); already-installed copies
  are refused at the next boot (restart required); diagnostics keep the
  record. Entries stay signed (`revoked: true`) — revocation is a state,
  not a deletion. Verified live in the sequence 8/9 drill.
- **Key rotation (dual-key overlap):** run `keygen` once per rotation →
  update the CI secrets (`COMPANY_CATALOG_SIGNING_KEY`,
  `COMPANY_CATALOG_KEY_ID`) → add the **new** fingerprint to
  `trustRoots` in `desktop-policy.release.json` (app release; both keys
  verify during the overlap) → publish manifests signed by the new key →
  remove the old fingerprint in the next release. Zero client action
  beyond normal app updates; the update-channel key is separate (P3-3).
- **GitLab config repo:** `julu/dsh-desktop-config`. The PAT
  (`GITLAB_TOKEN` on the intranet publish host) holds write access to
  exactly this one repository, no API scope. The manifest moves only
  through `git push` (`publish-local` writes canonical bytes; the GitLab
  web editor would break verification). A leaked PAT's blast radius is a
  rewritten manifest that every client still rejects on signature.
- **Secrets inventory.** CI (repository secrets, referenced only by the
  publish workflow): `COMPANY_CATALOG_SIGNING_KEY` (base64 PKCS#8 DER
  ed25519, single line), `COMPANY_CATALOG_KEY_ID` (`company-catalog-2026-08`),
  `COMPANY_CATALOG_KEY_FINGERPRINT` (optional pinned fingerprint). Intranet
  publish host: `GITLAB_TOKEN` (env var preferred over `--token` for argv
  hygiene). Local development: **none** — selftest and the e2e drill use
  ephemeral keys. The dev log also records a `GITLAB_TOKEN` repository
  secret from the early setup; the workflows never reference it.
- **Sequence recovery:** if the intranet publish refuses on a sequence
  mismatch, the two values are printed — trust the deployed one; the state
  file catches up via the post-publish bump. Never hand-edit a sequence
  down.

## The staging handoff channel (colleague-built tarballs, 2026-09-05)

A second listing track for low-privilege plugins, beside the source-audit
track (§3): colleagues build their own `npm pack` tarballs, self-validate
compatibility, and stage them on GitLab `julu/dsh-desktop-plugins`
(internal). The owner verifies each submission byte-for-byte and is the
only path into the signed catalog. Nothing here weakens the trust chain:
the signing key never leaves the owner's GitHub Secrets, and the official
`julu/dsh-desktop-config` repo stays owner-written only.

Topology and contract files (authoritative copies live in
`tools/company-catalog/docs/handoff/`; the staging repo mirrors them at
its root — do not edit the staging copies, owner re-syncs on change):

- `README.md` — the submitter guide: one directory per submission
  (`submissions/<name>-<version>/` with `handoff.json` + the tarball), the
  three-step flow, and the agent instruction template for self-validation.
- `handoff.schema.json` — the submission manifest schema
  (`additionalProperties: false`; package name / version / directory name
  are bound three ways; `artifact.sha256` pins the tarball bytes).
- `compat.json` — the single source of truth for "compatible": pinned dsh
  version + commit (`0.1.1-rc.2` / `b150a551…` as of 2026-09-05), desktop
  build (`2.0.3`), catalog sequence. Updated by the owner on every upstream
  bump; submitter agents must re-read it, never hardcode.
- `example/handoff.json` — a filled example.

Flow: colleague self-validates against `compat.json` (their agent checks
out the pinned dsh commit, installs the plugin in that workspace, smoke
tests) → pushes the submission directory → owner runs
`node tools/company-catalog/cli.mjs verify-handoff <dir>` (schema →
sha256 → safe unpack with symlink-escape defenses → three-way name
binding → compat assertions → content audit report → measured
treeDigest → optional smoke) → the command writes `verdict.md` beside the
submission (pass: digest + a ready allowlist entry snippet; fail: the
failing step + retest guidance) and, on pass, stages the tarball into
`out/packages/` so the EXISTING publish flow consumes it unchanged —
owner pastes the snippet into `allowlist.json` and publishes as usual
(§Publishing below).

Boundaries: same-version-immutable (content change ⇒ version bump);
high-privilege plugins (system permissions / sensitive domains) stay on
the source-audit track; the desktop client never reads the staging repo —
employees only ever see the signed catalog.

Access notes: the staging repo is GitLab `internal` — colleagues need
membership (Developer+ to push); agents read the contract via `git clone`
(the raw endpoint 302s for narrow-scope tokens — verified the hard way).

## Publishing an approved uploaded tarball (current manual path)

For plugins that arrive as reviewed `.tgz` uploads (future web-market
intake) rather than vendored source, no pipeline changes are required
today — use the safe manual path:

1. **Safe-extract the upload**: unpack the reviewed tarball through the
   company-catalog tar parser/extractor (`tools/company-catalog/lib/tarball.mjs`
   — the three-layer defense rejects symlink escapes, absolute targets,
   and truncated archives before anything lands on disk). Never unpack
   untrusted bytes with `tar` directly.
2. **Vendor the extracted tree**: place the contents under
   `tools/company-catalog/plugin-sources/<name>-<version>/` and add the
   allowlist entry exactly like a source-curated plugin (runtime range,
   bundle patch consistency — the pipeline assertion runs on pack).
3. **Publish through the standard flow** (section 3). The repacked tarball
   differs byte-wise from the upload but is content-identical — the
   signed manifest pins OUR packed sha512 + treeDigest, and the trust
   chain is indifferent to where the bytes originated.

Decision point (deferred): a `source.artifact` allowlist form plus a
`--from-artifact` verify-without-repack path are deliberate **future
work**, to be built when the web market's upload volume justifies it —
not before. The manual path above is safe and complete until then.

## 8. Cold-start checklist — your first day

**Read (in this order):**

1. This guide (you are here).
2. `tools/company-catalog/README.md` — the pipeline manual (bilingual; the
   authority on every CLI flag and the fleet-gate mechanics).
3. The P7 card in `dev-log/2026-08-22-company-market-lockdown-plan-v2.md`
   — the design decisions, the launch history, today's four pitfalls.
4. Module headers: `dsh-plugin-desktop/src/desktop-market.ts`,
   `company-market-install.ts`, `boot-verification.ts`,
   `cli-install-channel.ts`, `company-tarball-handoff.ts`; then
   `dsh-community-market/src/catalog/company-provider.ts`.

**Run (expect the §6 baseline):**

```sh
corepack yarn check                                   # full gate, green
node tools/company-catalog/e2e-tarball.mjs            # fixture-hello, offline full chain
```

**Try (hands-on drill, no network, no secrets):** pack and publish the
`fixture-hello` fixture yourself — `node tools/company-catalog/cli.mjs
pack-tarball --source-dir tools/company-catalog/fixtures/fixture-hello`,
then re-run the e2e and read its step output until each line (pack →
allowlist → gate → sign → publish dry-run → dual verify → boot) maps to a
source file you have opened. When that mapping feels natural, you own the
subsystem.

**Non-document handover items (ask your predecessor/manager):** repository
and GitLab permissions, CI secrets ownership (signing key `c469…` /
`GITLAB_TOKEN`), and the fleet-upgrade discipline — the gate is mechanical
(`--confirm-fleet-upgraded`), but the "is the fleet actually upgraded"
judgment is a human one.
