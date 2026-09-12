# Catalog Publishing Runbook (Unified Authority)

[中文](RELEASE.zh.md)

> As of 2026-09-12 this page is the **single operational authority** for company
> catalog publishing: environment prerequisites, the four daily chains, gate
> semantics, post-publish observation, drills, and error recovery all live here
> (the former "release cheat sheet" was folded in and upgraded). Division of
> labor (linked, not duplicated):
> - Process authority and human-review criteria = **SOP.zh.md** in this
>   directory;
> - MR-session cold-start copy-paste edition = **MR-HANDLING.zh.md**;
> - Pipeline internals and field semantics = **tools/company-catalog/README.md**;
> - Full trust model and red lines =
>   `.agents/notes/implemented/process/2026-09-04-company-market-owner-handover.md`.
>
> All commands run from the desktop repository root. Standing facts (true for
> every publish):
> - The signing private key lives only in GitHub Secrets (CI side) — **the local
>   machine never holds a key**; any signing step that cannot run locally goes
>   through CI;
> - CI only signs and uploads the artifact — it **never touches the intranet
>   GitLab**; the push always happens from your machine via publish-local
>   (no push = nobody sees anything);
> - stable and beta share one monotonic sequence ratchet; a beta sequence above
>   stable is a legitimate steady state (beta ⊇ stable, sequence ≥ stable).

## 0. Prerequisites: the publisher machine

### 0.1 Machine and permissions (one-time check)

| Item | Requirement |
| --- | --- |
| Network | One machine reaching both GitHub (gh API + artifact download) and the intranet GitLab `gitlab.s.dai.deloitte.cn` |
| Repository | A master clone of the desktop repo (GitHub `LCorleone/deepseek-harness-desktop`) with push rights, clean worktree |
| GitHub side | `gh` authenticated (`gh auth login`): can dispatch workflows, read runs/artifacts |
| GitLab side | A PAT for `julu/dsh-desktop-config`: **write on this one project only, no API scope** (the manifest travels by git push; the web editor breaks the verified bytes) |
| Signing key | Not on this machine — CI Secrets hold it (SIGNING_KEY / KEY_ID / optional FINGERPRINT; see the owner guide §7) |

### 0.2 The corporate CA bundle (the intranet GitLab sits behind TLS inspection)

The publisher machine's Node (fetch) and git do not trust the corporate
inspection CA. One-time extraction — take the CA certs from the served chain,
drop the leaf:

```bash
openssl s_client -connect gitlab.s.dai.deloitte.cn:443 -servername gitlab.s.dai.deloitte.cn -showcerts </dev/null 2>/dev/null \
| python3 -c "import sys,re; b=re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----',sys.stdin.read(),re.S); print('\n'.join(b[1:]))" \
> .deloitte-ca-bundle.pem
```

- The result is `.deloitte-ca-bundle.pem` at the repository root (2026-09-12
  reality: 3 Deloitte SHA2 CAs); it is pinned in `.gitignore` — **never commit
  it**;
- Prefix every publish-local invocation with
  `NODE_EXTRA_CA_CERTS=.deloitte-ca-bundle.pem` (append semantics: Node keeps
  its built-in roots and adds the corporate CAs) — note this configures
  **Node's fetch only**;
- ⚠ the git transport does NOT read that variable: the real `git` spawned
  inside publish-local needs the **machine's git itself** to trust the
  corporate CA (Windows schannel backends usually do; an OpenSSL-backed git
  needs `git config --global http.sslCAInfo .deloitte-ca-bundle.pem` or the
  `GIT_SSL_CAINFO` env, or the clone/push stage fails TLS). Symptom split:
  `fetch failed` at the fetch stage = Node side; an SSL certificate error at
  the git stage = git side;
- After a corporate cert rotation the symptom is TLS handshake failure /
  `fetch failed` — re-run the one-liner to refresh the bundle;
- Emergency alternative: `--insecure-tls` (equivalent to
  `NODE_TLS_REJECT_UNAUTHORIZED=0`; trust is carried by signature
  verification) — prefer the CA bundle whenever it works; publish-local warns
  the same way.

### 0.3 Credential discipline

- Fetch `GITLAB_TOKEN` from the credential store (delivered by the owner
  through the corporate credential channel); use it **only as an environment
  variable of the current shell**, discard afterwards; the env var wins over
  `--token` (which exposes the PAT in argv / process listings);
- Never write it into a commit, file, dev-log, or MR comment;
- The staging repo token (`http://10.173.59.30:9080/pluginpuller/dsh-desktop-plugins`)
  is a **different** PAT (scope=api), same discipline.

### 0.4 Thirty seconds before every publish

```bash
git pull && git status --short      # clean, not behind
cat tools/company-catalog/state/last-sequence.json   # current ratchet value
```

Eyeball the pending allowlist entries: version / channel / revoked /
description.

### 0.5 The skills bundle (a rebuild output since #011)

`dsh-company-skills`'s `assets/skills.bundle` is a deterministic repack of
`dsh-company-skills/skills/` (byte-stable within one Node version) and is no
longer committed since #011 (`.gitignore` pins the source-tree path and every
0.1.2+ staging path). **Transitional exception**: the two legacy v1-era
staging pins (0.1.0/0.1.1) stay committed until their catalog entries are
revoked→retired (the background and bytes-gate consequences live in 1.F).
Rebuild it once before packing the skills package locally, or before a local
`yarn check` can pass verify:bundle (~1–2 minutes, brotli-11):

```bash
node dsh-company-skills/scripts/build-bundle-asset.mjs
# When repacking a skills tree under plugin-sources, copy the asset into
# that staging tree:
cp dsh-company-skills/assets/skills.bundle \
   tools/company-catalog/plugin-sources/dsh-company-skills-<version>/assets/skills.bundle
```

CI needs no manual action: the publish and digest workflows each run an
`ensure-skills-bundles` step before packing that rebuilds the asset and
copies the fresh bytes into every skills staging tree that genuinely lacks
one (matched by the staging tree's package.json name; the committed
0.1.0/0.1.1 v1 pins make it a no-op for those two trees), leaving a
`.bundle-rebuilt` marker so the measure step re-measures those entries from
this run's packed bytes; packing a bundle-less skills tree fails closed,
with the same one-command guidance in the error.

## 1. The four daily chains

### 1.A Accepting a new version (colleague MR → verify → accept → ready to publish)

Details and cold-start context in MR-HANDLING.zh.md (review judgment in SOP
steps ②–④); here is the command sequence:

```bash
# ① Fetch the MR branch into the staging clone (curl for listing MRs: MR-HANDLING §1)
git -C <staging-clone> fetch origin 'merge-requests/<iid>/head:mr-<iid>'
git -C <staging-clone> checkout mr-<iid>

# ② Mechanical verification (ten-gate check, minutes) — the receipt must land on THIS machine
node tools/company-catalog/cli.mjs verify-handoff <staging-clone>/submissions/<name>-<version> \
  --description "one-line Chinese"      # --description required since 2026-09-10 (market card)

# ③ Human review, three points (verdict.md audit section: injection surface /
#    network domains / deps & scripts) → the owner merges the MR

# ④ Accept into the catalog (receipt must come from a verify on this machine;
#    pass --repository when the snippet carries none — convention in SOP ④)
node tools/company-catalog/cli.mjs accept-handoff <same-submission-dir> [--repository <url>]

# ⑤ Land the CI pack source (the step that is easy to miss — see below)
mkdir -p tools/company-catalog/plugin-sources/<name>-<version>
tar -xzf tools/company-catalog/out/packages/<name>-<version>.tgz \
    -C tools/company-catalog/plugin-sources/<name>-<version> --strip-components=1
git add tools/company-catalog/plugin-sources/<name>-<version>

# ⑥ Push (④'s allowlist commit + ⑤'s plugin-sources commit) → publish via 1.B
```

**Intermediate artifacts**: ② writes `verdict.md` + `verdict.json` (the machine
receipt) into the submission directory, records the receipt sha256 in the local
`out/verdict-receipts/`, and stages the tgz into `out/packages/`; ④ writes the
entry into the allowlist as a **standalone commit** (`catalog: accept
<name>@<version> (staging handoff)`); ⑤'s directory is the source CI repacks
(message convention: `catalog: plugin-sources for <name>@<version> (accepted
staging handoff — CI pack source)`).

**Why ⑤ is mandatory**: the CI pack step (`pack-tarball --from-allowlist`)
repacks from `plugin-sources/<name>-<version>/`; `out/` is gitignored, so the
locally staged tgz never reaches the runner — skip this step and the CI dry-run
goes red (real trap, 2026-09-09). Skills-package exception
(`dsh-company-skills`): the extracted `assets/skills.bundle` is pinned in
`.gitignore` (a #011 rebuild output) — `git add` skips it automatically;
never force-add it (CI rebuilds it itself, see 0.5). (The two legacy
0.1.0/0.1.1 v1 pins are the committed, explicitly negated exception — see
1.F; new versions never commit the bundle.)

**Fail-closed**: schema → sha256 → safe unpack → three-way identity binding →
compat, enforced identically by verify and accept; same version with different
bytes is always refused (the immutability red line). accept additionally
requires the receipt fingerprint to match this machine's verify record (on a
different machine, re-run ② first).

**Recovery**: a problem found before accept — nothing is signed, discard;
after accept but before publish — revert the two commits; after publish —
revoke via 1.D.

### 1.B Publishing stable / beta (CI signs → intranet push → re-read → ratchet bump)

```bash
# ① Prerequisite: the allowlist change is committed+pushed (accept-chain output,
#    or a hand-reviewed edit)

# ② CI signs the artifact (default dry-run=true signs and uploads nothing;
#    optionally dry-run first and read the summary)
gh workflow run "Company catalog publish" --repo LCorleone/deepseek-harness-desktop \
  --ref master -f channel=<stable|beta> -f dry-run=false
gh run list --workflow "Company catalog publish" --repo LCorleone/deepseek-harness-desktop --limit 1   # get the run id
gh run watch    # or wait for green on the Actions page (Windows runner, ~3 min)

# ③ Intranet push (CI never touches GitLab)
NODE_EXTRA_CA_CERTS=.deloitte-ca-bundle.pem GITLAB_TOKEN=<credential> \
  node tools/company-catalog/publish-local.mjs --channel <stable|beta> --run <run-id>

# ④ Operator re-read (§3) — publish-local re-checks on its own; this is the
#    independent confirmation

# ⑤ Ratchet bump (the follow-up line at the end of publish-local names the value)
#    tools/company-catalog/state/last-sequence.json → { "lastSequence": <N> }
git commit -am "catalog: ratchet last-sequence to <N> after the <channel> seq<N> publish (<what>)" && git push
```

**Intermediate artifacts**: ② produces the `company-catalog-signed` artifact
(`catalog-manifest[.beta].json` + `publish-meta.json` + `packages/*.tgz`) and
mirrors it to the `catalog-artifacts` branch under `<run-id>/` (same layout);
the run summary carries the treeDigest table. ③ prints, line by line,
`integrity: sha256 … matches publish-meta.json` → `ratchet: artifact sequence N
= deployed M + 1 ✓` → `signature: VERIFIED (… = fleet trust root)` → (gate
acknowledgment lines, §2) → `push: catalog-manifest… → master` → `re-check: …
exact pushed bytes … deployment confirmed` → the `publish complete:` block.

**`--run` semantics**: when omitted, the newest run with a downloadable
`company-catalog-signed` artifact is picked automatically (fallback: the
latest successful run, which may be a dry-run with no artifact) — **passing
`--run` explicitly is safer**. Environments where the gh artifact download
times out fall back to the `catalog-artifacts` branch automatically (same
run-id), or take it explicitly via `--from-git <run-id>` (§4).

**Fail-closed**: any red line = zero bytes pushed (every gate carries "fail
closed; nothing was pushed"). Optionally lead with `--dry-run`: verify +
ratchet check + push plan, stopping before the clone.

**Recovery**: a ratchet refusal (stale artifact) = the state file is stale →
re-run CI; a wrong manifest pushed = the next higher sequence supersedes it
(the ratchet never rolls back, §5); removing an entry goes through 1.D.

**Sequence gaps are normal**: stable may jump 13 → 16 (beta consumed 14/15) —
that is the shared-ratchet design, and publish-local logs
`skips past deployed … legitimate`. A first beta publish with no deployed beta
file (404) bootstraps against the stable baseline automatically.

### 1.C promote (beta soak done → stable fleet-wide)

**Two preconditions**: the soak is complete (≥2 working days or the first real
usage feedback); and the **group announcement** "plugin X goes to Y, reinstall
from the market after restarting" — a version upgrade is a hard cutover: after
promote, machines on the old version are boot-refused on next start (the
manifest pins only the new version; no grace period, no auto-update).

The practiced path (keyless operator machine; the 2026-09-10 first stable
promote used exactly this):

```bash
# ① Flip the allowlist flag: delete the entry's "channel": "beta" (reviewed
#    commit+push; message convention: catalog: channel flags for … — <who is
#    promoted / who stays beta>)
# ② Publish via 1.B channel=stable (repacking the same tgz = same bytes, same
#    digest — equivalent to the promote steady state)
#    ⚠ First time the entry carries source/treeDigest/description/
#      approvedBuilds on stable → --confirm-fleet-upgraded (§2)
# ③ Publish via 1.B channel=beta again to re-sign the beta manifest forward
#    (beta is a superset; the entry stays; testers see nothing change)
```

One equivalent command in a signing-key environment (CI / key-custody machine):

```bash
node tools/company-catalog/cli.mjs promote <name>@<version>
```

— moves the signed bytes verbatim into stable (zero re-verification), re-signs
both manifests (stable first, then beta — one sequence each on the shared
ratchet), and flips the allowlist flag; already promoted with identical fields
= idempotent no-op (no sequence consumed).

**Semantics (P15 multi-version pinning)**: promote = **add a pin, keep the old
ones** — the old pinned version stays in the stable manifest and older clients
keep booting by exact name@version; taking an old pin out of the window is the
explicit retire flow in 1.D.

**Fail-closed / recovery**: a stable publish stopped by the package-removal
guard = the soak-window trap (promote the package first, or revoke for a real
removal — §2); promote is a manifest-side action, a wrong push is superseded by
the next higher sequence.

### 1.D revoke / retire (withdrawal and window removal)

**revoke (revocation is a state, not a deletion; the entry stays for signed
audit)**

```bash
# ① Record the revocation in the allowlist
node tools/company-catalog/cli.mjs revoke <name>[@<version>]
#    Keyless machine: after the allowlist is marked revoked:true, the local
#    re-sign step fails — that is the expected path (the command tail points
#    you at the publish re-sign); the revocation is recorded. Continue at ②.

# ② commit+push (message convention: catalog: revoke <name>@<version> (<why>))

# ③ Re-sign via 1.B: a beta-only entry = channel beta; a stable entry = stable
#    first, then beta (revoke propagates to the beta manifest; both files need
#    a re-publish)

# ④ Ratchet bump (as 1.B ⑤)
```

**Effect**: the market row disappears within ~5 minutes (scan cache TTL);
installed copies are boot-refused on the **next restart**; `boot_verify`
telemetry leaves a trail.

**retire (explicit window removal, P15) — revoke first, two steps**

Preconditions: the version **is revoked and that revocation is published** (the
signed revoked:true record IS the retire record the removal guard trusts); and
the **group announcement** is out (window removal boot-refuses machines still
on the old version).

```bash
# ① Remove from the window (signing-key environment required)
node tools/company-catalog/cli.mjs retire <name>@<version>
#    Removes the window entry from the allowlist + re-signs both manifests; a
#    channel with no signed file / no such pin is skipped without consuming a
#    sequence

# ② Publish the re-signed manifests via 1.B (a revoked version leaving passes
#    the guard with no flag)
```

**Fail-closed / recovery**: silently hand-deleting an old allowlist entry is
stopped red by the version-retire guard — by design (clients boot by exact
name@version; a silently dropped pin bricks machines); only a deliberate
immediate drop uses `--allow-version-retire` (= an explicit owner decision).

### 1.E Changing the beta roster (beta-roster, zero client release)

```bash
node tools/company-catalog/cli.mjs beta-roster -f add=<lowercase-email>
node tools/company-catalog/cli.mjs beta-roster -f remove=<lowercase-email>
```

- The roster lives **in the signed manifest** (not policy/settings): roster
  state is `state/beta-testers.json` (local scratch, gitignored; a missing
  file = the initial trio julu/sebtang/lizywu); a change = re-sign the beta
  manifest + advance the shared ratchet, effective in seconds;
- The command needs a signing key; the keyless equivalent = edit the state
  file, then re-publish the beta manifest via 1.B channel=beta (the roster
  takes effect with the manifest's signature);
- **Roster-exit hygiene (fail-closed)**: a machine with a beta-only plugin
  installed (not pinned in stable) loses its pin on exit → boot verification
  no longer loads it. Have it uninstall beta-only plugins first, or promote
  first. Removing a beta entry is symmetric: promote a beta-only entry testers
  still have installed (stable pins it permanently) before withdrawing it.

### 1.F Version-bump repack (same version cannot be republished → bump the version)

**Hard fact (proven with dai-context 0.41.4, 2026-09-09)**: a hosted catalog
tarball's content is immutable. Republishing the same version is stopped
fail-closed by publish-local's bytes gate:

> packages/&lt;name&gt;-&lt;version&gt;.tgz already exists on master with different bytes
> (hosted sha512-…, artifact sha512-…) — &lt;name&gt;-&lt;version&gt; was already
> published and a hosted tarball is immutable; publish changed content as a
> new version (fail closed; nothing was pushed)

The root cause is not a content change but **packer-generation drift**: the
archive bytes depend on the Node/zlib the CI run links against (stable within
one Node/zlib pair), so the same source under a new packer cannot reproduce
the bytes hosted back then. **The only correct move = bump the version and
repack** (dai-context 0.41.3 → 0.41.4). Steps (old → new):

```bash
# 1. Rename the directory (content untouched)
git mv tools/company-catalog/plugin-sources/<name>-<old> tools/company-catalog/plugin-sources/<name>-<new>
# 2. Bump version inside the directory's package.json
# 3. Update the allowlist entry's version / repository / source.url /
#    source.path, and drop the old entry's treeDigest (optional field; omit
#    until measured)
# 4. CI dry-run (default) → real run → push via 1.B → ratchet bump
```

Note: a version bump = a new entry; an old version still in the manifest needs
its own revoke; keep the new package beta-only when it should only gray-launch
(dai-context 0.41.4 stayed beta-only, stable untouched).

**Skills-package note after #011 (review correction)**: 0.1.0/0.1.1 are
beta-only entries whose staging bundles are md5-pinned to the **hosted**
tgz bytes (v1 wire, 60,022,105 B). The first #011 cut untracked all three
bundles — on a fresh CI checkout the two v1 staging blobs would then be
absent, CI would copy today's v2 asset in, both path-pinned entries would
repack to drifted bytes on every run, the bytes gate would refuse, and
**every beta publish would be blocked** (stable is unaffected — it carries
neither entry); the drifted tgz would be semantically broken anyway
(0.1.0/0.1.1 ship v1-only decoders that cannot read a v2 bundle). Hence
the transitional rule: the two v1 staging pins **stay committed** (explicit
`.gitignore` negations; drop them once the entries are revoked→retired out
of the window); from 0.1.2 on, staging bundles are always CI-reproduced
(the ensure-skills-bundles step) and never committed. The post-0.1.2 steady
dstate differs from this section's dai-context packer drift: a version bump
is no longer the unblock move — reproduction is deterministic on the pinned
Node, so repacking an unchanged tree yields stable bytes and needs no bump;
the real guard is the measure re-check (the ensure step leaves a
`.bundle-rebuilt` marker in every staging tree it provisioned, and measure
re-measures marked entries' treeDigest from **this run's packed bytes** —
equality confirms the pin, a mismatch fails closed, and applyTreeDigests
never silently overwrites a reviewed digest either).

## 2. Gate semantics (when publish-local stops you)

| Gate | When it fires | Key message fragment | Correct move |
| --- | --- | --- | --- |
| sequence ratchet | artifact sequence ≤ the channel's deployed sequence (stale artifact) | `sequence ratchet failure … stale — rebuild from a bumped state file` | stale state → re-run CI; **never hand-edit state** |
| fleet-upgrade gate | an entry first carries `source` / `treeDigest` / `approvedBuilds` / `description` on the channel (old clients reject the whole manifest on one unknown key, `additionalProperties:false`) | `fleet-upgrade gate … blacks out the whole catalog` | only `--confirm-fleet-upgraded` once the whole fleet runs field-aware builds (true since #47) |
| package-removal guard | stable would drop an unrevoked **package** (the classic soak-window trap: the package's only entry is beta-flagged) | `package-removal guard … soak-window trap` | promote the package first; revoke for a real removal; only a deliberate removal uses `--allow-package-removal` |
| version-retire guard | stable would drop an unrevoked **version** of a package it still lists (a silent window shrink) | `version-retire guard … silently shrink` | keep the old pin by default (promote does); explicit removal = revoke→publish→retire (1.D); only a deliberate immediate drop uses `--allow-version-retire` |
| tarball bytes gate | the same name@version is already hosted with different bytes | `already exists … a hosted tarball is immutable` | bump the version and repack (1.F) |
| first beta publish | the beta file 404s (first publication) | `ratchet: no deployed beta manifest` | automatic fallback to the stable baseline; no action |

All fail-closed: any gate stopping you = zero bytes pushed; fix and re-run,
there is no half-pushed state.

## 3. Observation and verification (confirming it actually landed)

**Portal side (GitLab config repo `julu/dsh-desktop-config`)** — manifest
re-read (sequence + entry flags; raw responses are cached, break it with
`?t=`):

```bash
curl -s --cacert .deloitte-ca-bundle.pem \
  "https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/raw/master/catalog-manifest.beta.json?t=$(date +%s)" \
| python3 -c "import json,sys; m=json.load(sys.stdin); print('sequence', m['sequence']); [print(' ', e['packageName']+'@'+e['version'], 'revoked' if e.get('revoked') else 'active') for e in m['packages']]"
```

(for stable, switch the filename to `catalog-manifest.json`). Package bytes
page:
`https://gitlab.s.dai.deloitte.cn/julu/dsh-desktop-config/-/blob/master/packages/<name>-<version>.tgz`.

**Client side (`catalog_refresh` telemetry)** — database: the corporate MySQL
`DSH_LOG@10.173.59.16:3306`, table `dsh_client_events` (field dictionary and
timezone notes in `dsh-plugin-desktop/docs/telemetry.zh.md`; `created_at` is
stored UTC). Publish propagation (who has seen seq N):

```sql
SELECT user_email, MAX(created_at) FROM dsh_client_events
WHERE event_type='catalog_refresh'
  AND JSON_EXTRACT(detail,'$.sequence')>=<N>
  AND JSON_EXTRACT(detail,'$.channel')='<stable|beta-overlay>'
GROUP BY user_email;
```

Event semantics: `detail.channel` = `stable` / `beta-overlay`; only
`outcome=applied` carries `sequence`/`entries`; the abnormal outcomes
(`stale-sequence` / `not-a-tester` / `fetch-failed` / `bad-signature` …) are
the troubleshooting entries. Install outcomes live in `plugin_install`, boot
refusals in `boot_verify` (same dictionary).

**Desktop logs (single-machine forensics)**: the beta application line
`beta catalog applied (sequence N, …)`; logs live in
`%APPDATA%\DSH Desktop\logs\dsh-YYYY-MM-DD.log`, field-collection script
`dev-log/grab-dsh-logs.ps1`. A manual market refresh on a roster machine is
the final eyeball check.

**Chain diagnostics**:

```bash
node tools/company-catalog/cli.mjs verify <manifest-file>   # end-to-end verify one manifest
node tools/company-catalog/e2e-tarball.mjs                 # offline full-chain selfcheck (fixture)
```

## 4. Drill and offline options

| Flag | Meaning |
| --- | --- |
| `--branch <name>` | push a temporary GitLab branch instead of master (drills only; only a master push prints the ratchet-bump follow-up, and the tail reminds you to delete the branch) |
| `--deployed <file\|url>` | override the ratchet source (local file/URL) — **requires `--dry-run`**: a drill never pushes |
| `--dry-run` | verify + ratchet check + print the push plan, stopping before the clone |
| `--artifact-dir <dir>` | skip gh: offline replay from a local directory already laid out like the download (manifest + publish-meta.json + packages/) |
| `--from-git <run-id>` | take the artifact straight from the `catalog-artifacts` mirror branch (for environments that cannot reach GitHub's artifact blob storage; `--run` falls back to it automatically on download failure; mirror bytes pass the identical verification gauntlet) |

## 5. Error recovery (the correct posture when the ratchet cannot roll back)

- **The ratchet only moves forward, by design**: GitHub floors signatures at
  the committed state, the intranet side independently checks the deployed
  value; a bad publish **can only be superseded by a higher sequence** — the
  manifest is immutable but forward-fixable. Never attempt to "roll back to
  the previous number".
- **state vs deployed mismatch**: the intranet refusal prints both values —
  **trust the deployed value**; reconcile state via the post-publish bump;
  never hand-lower it (that would reissue a sequence clients may have seen).
- **Forgotten ratchet bump**: the next artifact is stale → the ratchet refuses
  → re-run CI; no damage done.
- **Wrong/bad manifest pushed**: the next higher sequence supersedes it;
  removing an entry goes through 1.D revoke.
- **User-side install failure**: WAL auto-rollback; the user is unharmed and
  can retry.
- **Receipt on another machine**: accept-handoff only honors verify receipts
  from this machine's `out/verdict-receipts/` — re-run verify-handoff locally
  before accepting from a different machine.

## 6. Worked example: 2026-09-12 seq30 (engramory withdrawn from beta)

Background: `dsh-dai-engramory@0.2.4` was a beta-only soak entry, withdrawn
following the b91 real-machine uninstall incident. The operator machine is
keyless; that morning was the first use of the CA bundle (previously
`--insecure-tls`). Before the publish: stable seq27 / beta seq29 / ratchet 29.

```bash
# ① Record the revocation in the allowlist (local re-sign failure = expected;
#    the revocation is recorded)
node tools/company-catalog/cli.mjs revoke dsh-dai-engramory@0.2.4
#    allowlist: dsh-dai-engramory@0.2.4 marked revoked:true (entry kept; …)
git commit -am "catalog: revoke dsh-dai-engramory@0.2.4 (remove from beta soak)" && git push
#    → bbf9da30e6 (allowlist.json, one line: revoked false → true)

# ② CI signs the beta artifact
gh workflow run "Company catalog publish" --repo LCorleone/deepseek-harness-desktop \
  --ref master -f channel=beta -f dry-run=false
#    → run 34656749412 green

# ③ Intranet push (corporate CA via the bundle)
NODE_EXTRA_CA_CERTS=.deloitte-ca-bundle.pem GITLAB_TOKEN=<credential> \
  node tools/company-catalog/publish-local.mjs --channel beta --run 34656749412
#    ratchet: 29 → 30; push: catalog-manifest.beta.json …;
#    re-check: … exact pushed bytes … deployment confirmed; publish complete: sequence 30

# ④ Operator re-read (the §3 command): sequence 30, 8 entries,
#    dsh-dai-engramory@0.2.4 revoked ✓

# ⑤ Ratchet bump
#    tools/company-catalog/state/last-sequence.json → { "lastSequence": 30 }
git commit -am "catalog: ratchet last-sequence to 30 after the beta seq30 publish (revoke dsh-dai-engramory@0.2.4)" && git push
#    → 22f1195fc8
```

End state: stable seq27 (5 entries) untouched; beta seq30 (8 entries, engramory
revoked and kept for signed audit). Effect = the 3 testers stop seeing
engramory in the market after their next refresh (provable via `catalog_refresh`
beta-overlay applied sequence 30). Open follow-ups: confirm sebtang/lizywu see
it hidden after refresh; whether to retire it out of the window (needs the
group announcement — issue #003).

## Change log

- 2026-09-07 first version (four-type release cheat sheet: beta/stable/roster/
  revoke + gate cheat sheet).
- 2026-09-09 added "same version cannot be republished → version-bump repack"
  (proven with dai-context 0.41.4).
- 2026-09-10 added P15: the explicit retire flow, multi-version pinning
  semantics, the version-retire gate.
- 2026-09-12 unified runbook (#023): folded in the publisher-machine
  environment (CA bundle extraction and `NODE_EXTRA_CA_CERTS`, credential
  discipline), the accept chain's plugin-sources step, observation and
  verification (portal re-read / `catalog_refresh` telemetry / DSH_LOG
  queries), drill options, and the seq30 worked example; `--run` direct
  artifact fetch replaces gh run download + `--artifact-dir` as the primary
  path (the latter demoted to offline replay); the CA bundle replaces
  `--insecure-tls` as the default posture. The Chinese primary RELEASE.zh.md
  and the bilingual record RELEASE.i18n.yaml were established alongside.
- 2026-09-12 #011: skills.bundle left the repository as a deterministic
  rebuild output — added 0.5 (one local rebuild command; CI rebuilds and
  copies before packing); 1.A ⑤ note that the extracted bundle is
  gitignored and must never be force-added; 1.F note on repack byte drift
  for historical skills versions.
- 2026-09-12 #011 review correction: the two v1 pins (the 0.1.0/0.1.1
  staging bundles) transitionally re-committed (explicit .gitignore
  negations, until revoked→retired) — otherwise a fresh checkout's CI would
  copy the v2 asset in and the bytes gate would block every beta publish;
  added the `.bundle-rebuilt` marker chain (ensure leaves a marker on every
  copy → measure re-measures those treeDigests from this run's packed
  bytes); 0.5/1.A/1.F rewritten as the transitional rule + the post-0.1.2
  steady state.
