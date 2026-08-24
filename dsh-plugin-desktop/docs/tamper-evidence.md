# Tamper evidence runbook (P4-2)

[中文](tamper-evidence.zh.md)

This runbook tells a company security reviewer how to read a DSH Desktop
diagnostics export and decide, from evidence inside the export alone, whether
the application was modified, whether plugins were refused by policy, and what
a missing or unsigned self-check report means. Fields refer to
`self-check-report.json` inside the export produced by the tray menu's
**Export Diagnostics…** (installed app) or `dsh-desktop --export-diagnostics`
(the development CLI entry; see `diagnostics-self-check.md`).

## What each artifact proves

| Artifact | Proves | Does not prove |
|---|---|---|
| `self-check-report.json` | The boot verification state of the most recently recorded start: which bundles loaded, which were refused, which manifest sequence/keyId was trusted | Anything about starts that happened before the snapshot was rewritten |
| `signature` block in the report (if present) | The report bytes were produced by a process holding the deployment view key — the shape reserved for the future centralized re-signing service | That the reporter itself was untampered (a modified client can drop the report entirely — that absence is the signal, see below) |
| `bootVerification.refused[]` entries | Boot verification rejected those third-party bundles with the recorded reason | Why the user installed them (install path is outside this report) |
| `policy.sha256` | Which exact policy asset the running build read | That the on-disk policy is still that bytes (re-hash the packaged copy if seized) |
| `nodeRuntime.status: failed` | The bundled Node binary did not match the pinned sha256 manifest at that start | Who replaced it (no attribution data is collected) |
| `manifestFailure` | The last catalog manifest was missing, expired, or failed verification; all third-party bundles were refused | Network-level causes (only the verification outcome is recorded) |

Reports are generated **unsigned by design** (direction B): the client holds no
signing key an attacker could not also hold, so the report's absence — plus
content that contradicts company-published values — is the control signal, not
a signature.

## Reading a report

1. **Verify first.** Run
   `node scripts/verify-diagnostics-report.mjs <export.zip> --fingerprint <printed-in-company-runbook>`
   Exit 0 = the signature is valid for the embedded key and the pinned
   fingerprint, **or** the report is unsigned and the script flagged it with a
   prominent `UNSIGNED` line (see step 2). Exit 1 = verification failed:
   tampered content, or a malformed/missing/unreadable report. Exit 2 = usage
   error. **Never analyze the report content before recording the exit code
   and any UNSIGNED flag.**
2. **Unsigned report (`unsigned: {reason}`, printed as UNSIGNED).** Every
   build produces unsigned reports — the reason states that client-side
   signing is not a forge-resistant control. On a company-issued install this
   is still a finding to record: confirm the report's content against the
   company-published `policy.sha256` and manifest sequences for the reported
   `appVersion`. A modified client can produce an unsigned report, but its
   content then has to contradict those published values to be useful;
   suppressing the report entirely makes the absence itself the signal
   (step 3).
3. **Missing report** (system-info lacks `included-self-check-report`). The
   running application could not or would not produce the report. On a
   company-issued locked build this is the primary tamper signal: a modified
   client suppresses exactly this artifact. Treat as «client integrity cannot
   be established».
4. **`bootVerification`**:
   - `available: false` — no locked-boot record is in the report. On a
     company-issued locked install this is an anomaly (the sole exception: a
     first-launch CLI `--export-diagnostics` that ran before any boot
     completed); treat as a finding and investigate like step 3.
   - `manifestTrusted: false` + `manifestFailure.code` — the catalog manifest
     was rejected at that start (rolled back, expired, bad signature). All
     third-party bundles were refused (`refused[]` should list them).
   - `refused[]` — plugins present on disk that the policy refused to load.
     `decided.refusedBy: boot-verification` with reason strings maps 1:1 to
     the P2-4 rejection codes (`not in the signed company manifest`,
     integrity-mismatch texts, receipt tree-digest mismatch).
   - `allowed[]` with `resolved.evidence: manifest-only` — the bundle matched
     the signed manifest and lockfile integrity but had no usable receipt
     (fresh install path or deleted receipt). Not a finding by itself.
5. **`policy`**:
   - `locked: false` on a company-issued install — either an unlocked build
     variant is deployed (deployment error) or the policy asset was replaced
     (compare `policy.sha256` against the value shipped for that app version).
   - `available: false` — the policy asset could not be read; on a locked
     build this is a startup-path anomaly, treat as tamper signal.
6. **`nodeRuntime`**:
   - `failed` — bundled Node digest mismatch at that start: strong indicator
     the binary was replaced.
   - `development` — the export came from an unpackaged/dev run; weigh
     accordingly.

## Sampling procedure

1. Collect the export (tray menu **Export Diagnostics…**, or
   `dsh-desktop --export-diagnostics` for a dev checkout), plus — when a
   machine is seized — the packaged copy of
   `resources/app.asar.unpacked/lib/` and `resources/node-runtime/` for
   offline re-hashing.
2. Run the verify script with the company-pinned `--fingerprint`. Record the
   exit code and any UNSIGNED line before opening the report.
3. Compare `policy.sha256` with the company-published value for the reported
   `appVersion`.
4. Record findings against the table above; for every `refused[]` entry,
   decide «user installed a non-company plugin» (expected outcome of the
   control) versus «refusal storm after manifest issue» (check
   `manifestFailure`).
5. A missing report on a locked company build, or an exit-1 verification
   result, concludes «client integrity cannot be established; assume
   modified». An UNSIGNED report on a company-issued install is recorded as a
   finding and escalates to that conclusion when its content fails the
   company-published comparison.

## Evidence vocabulary

`resolved`/`decided` field names follow dsh-community-fabric RFC 0004 §4
(the same vocabulary as market install receipts), so tooling written against
one vocabulary reads both.
