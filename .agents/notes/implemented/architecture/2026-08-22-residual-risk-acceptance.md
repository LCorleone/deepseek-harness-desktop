# Residual-risk acceptance — company lockdown without IT integration (P4-3)

[中文](2026-08-22-residual-risk-acceptance.zh.md)

Status: **pending management signature**. This note records the accepted
security ceiling of the company-market lockdown as implemented in Phases 1–4
(commits `3103531c8b`..P4-4), the residual risks that remain after those
phases, and the zero-change upgrade points for when company IT support
becomes available.

## Accepted security ceiling (verbatim)

> Any means that does not modify the DSH Desktop application itself cannot
> make an unsigned plugin load. Modifying the application itself can bypass
> every client-side check, but leaves identifiable evidence absence
> (diagnostics). Professional users cannot be stopped; casual users are
> blocked on every path.

## What is enforced today

- Locked builds pin the effective market provider, catalog source, install
  authority (signed-manifest three-chain convergence), terminal
  `dsh plugin add` channel, and boot-time bundle verification (P1/P2).
- Packaging hardening: bundled pinned-sha256 Node runtime with startup
  self-check, full fuse set including `runAsNode:false`, asar integrity over
  the archive partition, signed update channel (P3, review fixes included).
- Diagnostics self-check report with tamper-evidence runbook (P4-1/2,
  review direction B: reports are unsigned by design — the detection
  control is report absence plus content comparison against
  company-published values, with a reserved format for future centralized
  re-signing).

## Residual risk register

| # | Risk | Exposure | Mitigation status |
|---|---|---|---|
| R1 | Local same-user modification of unpacked assets (`lib/**`, `node-runtime/`; bypassing the pinned digests requires an asar edit) | Client checks can be disabled by editing JS; policy JSON cheap-channel closed (env-injected CLI policy, asar-side digests), but code-level modification remains | Accepted ceiling; detection via report absence and content comparison (P4-2 §3) |
| R2 | External upstream CLI direct-install into `DSH_HOME` | Install action is not blocked (out of reach); the plugin never loads (boot verification refuses) | By design (拒载不拦装) |
| R3 | Embedded manifest asset is user-writable (per-user installs); receipts sequence floor raises cost only | Replay of still-valid older manifest limited to company-signed content; registry integrity still pinned | Reduced by P2 review fixes; fully closed by code signing (future) |
| R4 | CI signing-key compromise | Catalog and update channels use separate keys; rotation = dual-key overlap; revocation = sequence reissue | Runbook in architecture note; drill pending real keys |
| R5 | v1 receipts from pre-upgrade installs are all refused after upgrade | User-visible reinstall burden | Release-notes guidance (dev-log risk ①) |
| R6 | Linux targets: asar integrity fuse is a no-op | Linux builds rely on L1/L2 only | Documented in README packaging section |
| R7 | Self-built modified client is undetectable | Out of scope without OS-level enforcement | See upgrade path |
| R8 | Fresh-Profile swap (P14): the set-aside rename is refused because an external process holds a directory handle inside the Profile (Windows `EBUSY`) | The rebuild does not happen on that boot; the version change stays pending | Accepted: the swap defers instead of failing (six backoff steps, then a `fresh-profile-pending.json` marker and `plugin_reset.outcome=deferred`), the existing Profile keeps booting (no brick), and the next startup retries the rename before any component opens the Profile. Root cause is evidenced — a user editor opening a file inside the Profile keeps a watcher handle on the directory: child entries are individually renamable while the directory itself is not. Rare; the manual recovery window states the rebuild completes after restart |
| R9 | External manual deletion or modification of a Profile directory is unsupported | A colleague's hand-deletion of `profiles\desktop` left market install receipts naming it, which pinned the market's installed list in an error state no restart cleared | Degraded, not promised: the record branch now clears a Profile's residual receipts when no manifest exists at boot (`fresh-profile.ts` `clearFreshProfileRecordReceipts`). Manual edits to a Profile's contents remain outside the supported surface |

## Future IT upgrade points (zero client change)

- **Authenticode / notarized code signing + perMachine install + machine
  ACLs**: turns P3-1/P3-2 advisory fuses into enforced semantics; closes R1/R3
  for local attackers without administrator reach.
- **WDAC/AppLocker policy for the app and bundled Node**: the only layer that
  binds an adversarial admin user; closes R7.
- **KMS/HSM for signing keys**: client pins public-key fingerprints only.
- **Managed `DSH_HOME` / company registry mirror**: closes R2's install side.

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Project owner | | | |
| Security reviewer | | | |
| Management | | | |
