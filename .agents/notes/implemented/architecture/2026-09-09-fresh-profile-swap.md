# Agent Note: Fresh-Profile swap (P14) — automatic version-change reset and the recovery window's manual action

[中文](2026-09-09-fresh-profile-swap.zh.md)

Status: **implemented** (commit chain `27af02223a` implementation →
`a06a83e0b7`/`6180184964` review fixes → `39a6ff6bc4`/`7fcd67b9a7` Windows
EBUSY → `75b604bced` version grading → `e7f515da08` content-move revert and
re-review fixes). This note records the one rebuild primitive, the trigger
rules, the deferred semantics, the market-receipt clearing, the rejected
alternatives, and how the three outcomes were verified.

## Problem

A Desktop Profile accumulates third-party plugins across builds. When the
build identity changes — above all when a build carries a DSH runtime
upgrade — a Profile whose plugin set was composed against the previous
runtime can straddle two builds: one installer would then serve a fleet
whose plugin sets are mixed. The existing profile machinery only *selects*
among Profiles (`2026-08-15-desktop-profile-management.md`); nothing rebuilt
one. A bad install with no build-identity change had no way out either,
short of hand-deleting the Profile directory — which is unsupported (see the
residual-risk register, R9). On Windows a second constraint applies: the OS
refuses a directory rename for as long as any process holds a handle inside
the tree, so a rebuild that starts with a rename can be blocked by a
transient external lock.

## Decision: one rebuild primitive behind both layers

`freshProfileSwap` (`dsh-plugin-desktop/src/fresh-profile.ts:631`) is the
single primitive; the automatic layer and the recovery window's manual
action both call it through the same `runFreshProfileSwap` wrapper
(`main.ts:1034`). A swap:

1. renames the active Profile directory aside to
   `profiles/<name>.bak-<UTC stamp>` (`profileBackupPath`,
   `fresh-profile.ts:343`) — never deletes it, so it stays available for
   forensics and manual rollback;
2. recreates the Profile through the shipped first-run mechanism
   (`ensureDesktopProfile` / `createDesktopWebProfile`);
3. invalidates that Profile's health checkpoint (the checkpoint is keyed by
   Profile *path*, which a swap does not change, so a stale snapshot would
   otherwise be restored into the rebuilt tree by the next failed startup);
4. clears that Profile's market install receipts;
5. runs one dependency synchronization (`pnpm install --frozen-lockfile`).

No package-manager surgery runs: `pnpm remove` on a damaged tree is exactly
the fragile path this module exists to avoid.

Set-aside directories are bounded: `pruneProfileBackups`
(`fresh-profile.ts:589`) keeps the newest `MAX_PROFILE_BACKUPS = 2`
(`fresh-profile.ts:59`) per Profile and removes older ones best-effort by a
task detached from the swap — a multi-hundred-megabyte removal must never
delay the startup path that spawned it.

## Trigger rules (automatic layer)

The automatic layer runs at startup after the SSO and disclaimer gates and
before host boot: the decision block sits in the `profile-selection` stage
(`main.ts:916`), and host boot begins at `main.ts:1704`. The deferred-marker
read is earlier still (`main.ts:808`), before the pnpm runtime install and
before any Profile or selection file is opened.

`freshProfileResetDecision` (`fresh-profile.ts:307`) decides per boot:

| Condition | Decision |
|---|---|
| Policy not locked | `unchanged` — byte-identical behavior; not even the record is written |
| `pluginResetOnVersionChange` **true** (a build carrying a DSH-base upgrade) | compare the **full build identity**; any change (`2.0.3+b78` → `2.0.3+b79`) resets |
| `pluginResetOnVersionChange` **false** (default, 2.0.4 on) | compare the **product-version base** only; a build-counter bump keeps the Profile, `2.0.3` → `2.0.4` resets |
| Missing record, forced rule | reset when a Profile manifest exists, record when it does not (genuinely fresh install) |
| Missing record, version rule | record — a first observation, not a straddle (builds with the switch off wrote no record before this one) |
| Recorded product version differs | reset (even without a manifest — the record proves another build managed this home) |

The record is `last-profile-generation.json` in the Desktop user-data
directory (`profileGenerationStatePath`, `fresh-profile.ts:128`) and carries
both `appVersion` and `appBuildVersion`. A record written before
`appVersion` existed is read back through `buildVersionProductBase`
(`fresh-profile.ts:108`), which strips the `+bNNN` suffix, so an old record
stays a valid record without a schema bump.

## Deferred semantics (Windows EBUSY)

A `renameSync` refused with `EBUSY`/`EPERM`/`ENOTEMPTY`/`EACCES` is retried
over six backoff steps — 100/200/400/800/1600/3200 ms, ~6.3 s total
(`RENAME_RETRY_DELAYS_MS`, `fresh-profile.ts:72`). If every step is refused,
the swap does **not** fail. It returns a deferred result, and the desktop:

- writes `fresh-profile-pending.json` in userData;
- reports `plugin_reset.outcome=deferred`;
- **does not write the build-identity record**, so the version change stays
  pending;
- keeps booting the existing Profile.

The next startup retries the rename at its earliest point, before any
component opens the Profile, and holds a visible loading surface for the
wait when the boot owns no disclaimer window (`main.ts:1169-1188`). A marker that
names a Profile which is not active this boot is **kept** and the retry is
skipped — dropping it would lose the pending rebuild permanently, because
the deferred path never recorded the marked Profile's identity. The marker is
dropped only when the policy is unlocked, since an unlocked build can never
perform the rebuild (`freshProfilePendingAction`, `fresh-profile.ts:270`).
The manual recovery window turns a deferred outcome into "the rebuild is
queued and will complete automatically after DSH Desktop restarts" rather
than a failure the user would retry by pressing the button again
(`main.ts:1691`).

**Root cause, evidenced:** the lock is an external process holding a
directory handle inside the Profile. A user editor opening a file inside the
Profile keeps a watcher handle on the directory: child entries are
individually renamable while the directory itself is not. That is why a
Linux test suite can be fully green and the same code fails on Windows.

## Market install receipts

A swap clears the swapped Profile's own receipts from the shared home
`settings.yaml` (`clearMarketInstallReceipts`, `fresh-profile.ts:360`). The
ledger is home-wide and each receipt names its Profile, so clearing only this
Profile's receipts returns its catalog entries to the installable state
without degrading a sibling Profile's installed bundles. The edit is a YAML
AST round trip under the document owner's writer lock, committed with the
same atomic replace, so comments and every other setting survive.

The `record` branch clears residual receipts when no Profile manifest exists
at boot (`clearFreshProfileRecordReceipts`, `fresh-profile.ts:416`). That
shape covers a genuinely fresh install and a Profile directory the user
deleted by hand: in both, any receipt still naming the Profile can never
verify against an empty directory and would pin the market's installed list
to an error. The **manifest fact** gates this, never the decision string —
the version rule also returns `record` for a Profile that still has its
manifest and plugins, and clearing there would hide real installs. Failures
are logged and swallowed: a ledger that cannot be rewritten must never block
the boot.

## Verification

- Telemetry: `plugin_reset {trigger, profileName, outcome, materialized,
  receiptsCleared, rule}` (`client-event-reporter.ts:643`), where `trigger`
  is `version-change` or `recovery-window` and `outcome` is `swapped`,
  `failed`, or `deferred`. `rule` is `forced` or `version` and is omitted for
  the manual action.
- All three outcomes (`swapped`/`failed`/`deferred`) were exercised on a real
  machine, including the b77 first-trigger `EBUSY` incident that motivated
  the retry/defer path.
- Focused tests: `fresh-profile.spec.ts` (decision rules for both switches,
  record round-trip, backup naming and retention, receipt clearing under the
  writer lock) and `fresh-profile-wiring.spec.ts` (early automatic layer,
  locked-policy gate, marker read/retry ordering, cross-Profile marker
  retention, visible loading surface, deferred write recording no identity,
  checkpoint invalidation, manual action token guard, telemetry, and that a
  failure never crashes the boot).

## Alternatives considered (rejected — do not re-walk)

**Content-level move.** Move the Profile's child entries into the set-aside
directory instead of renaming the directory itself. This was implemented and
then reverted by user decision (`e7f515da08`): the real scenario is rare, and
after the move the live directory still exists, so it collides with
`createDesktopWebProfile`'s "already exists" check
(`profile-manager.ts:220`).

**`pnpm remove` surgical cleanup.** Early evidence showed it is fragile — a
missing tarball aborts it with `ENOENT`. This is the path the module was
written to avoid.

**Junction re-pointing.** The rename is equally restricted by the same
directory-handle lock, so re-pointing a junction does not remove the
failure mode.

## Consequences

One installer now serves a fleet whose plugin sets can never straddle two
builds, and a rollback lands on a clean tree too. A Windows directory lock
degrades to a one-boot delay instead of a failed upgrade, and the version
change stays pending until the retry lands. The launcher gains one persisted
generation record, one deferred marker, a bounded set of set-aside
directories, and one Host-side rebuild primitive shared by the automatic and
manual layers.
