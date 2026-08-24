# Diagnostics self-check report (P4-1)

[中文](diagnostics-self-check.zh.md)

Every diagnostics archive carries `self-check-report.json`: a machine-readable snapshot of the build's own security posture at export time. It exists for the company security administrator — not the client — to answer "what did this installation actually load, and under which policy?" without trusting log text.

Reports are generated **unsigned, by design** (review direction B): a client-side signature is not a forge-resistant control, because an attacker who can modify the client can extract or strip its signing key. The tamper signal is the report's **absence** — a modified client can suppress the report or forge an unsigned one, but a forged report's content then has to contradict the company-published policy digests and manifest sequences to be useful, and suppressing the report entirely is itself the signal the runbook (P4-2) acts on.

## Report contents

| Field | Meaning |
| --- | --- |
| `reportVersion` | Report grammar version (`1.0.0`). |
| `generatedAt`, `appVersion`, `platform`, `arch`, `nodeVersion` | When the export ran and which build produced it. |
| `policy` | Self-measurement of the embedded policy asset: `locked` flag, SHA-256 over the exact `desktop-policy.json` bytes, byte length, and the pinned company-catalog trust roots. `available: false` (with `reason`) means the asset could not be read or strictly parsed. |
| `nodeRuntime` | Bundled Node runtime self-check (P3-1): `verified` (command matched its packaged sha256 manifest), `development` (unpackaged run), or `failed` (with reason). |
| `bootVerification` | The recorded boot's third-party bundle decision (P2-4): `manifestTrusted`, `manifestSequence`, `keyId`, `manifestFailure`, and the full `allowed`/`refused` lists. `available: false` explains why (unlocked build, or export before any boot completed). Allowed entries carry `resolved` (boot evidence grade `receipt`/`manifest-only`, manifest sequence, key) and `decided: {allowedBy: 'signed-company-manifest'}`; refused entries carry `decided: {refusedBy: 'boot-verification', reason}` — the RFC 0004 evidence vocabulary (`dsh-community-fabric`, "Provenance, Validation, Diagnostics, and the Effect Ledger" §4), aligned with market receipt v2 (`MarketEvidenceClass`). |
| `signing.viewKeys` | keyIds and SHA-256 fingerprints of the diagnostics view keys this build pins (empty today; future material for the centralized re-signing service). |
| `signature` / `unsigned` | Exactly one is non-null. Today every report carries `unsigned: {reason: 'client-side signing is not a forge-resistant control; absence of the report is the tamper signal'}`. The `signature` block (detached ed25519 with the signing public key embedded) is retained in the grammar for a future centralized re-signing service; verifiers still check it when present. |

The Electron launcher persists each boot's decision to `<user-data>/boot-verification.json` right after profile composition; exports read that snapshot, so tray, recovery-window, and headless `--export-diagnostics` exports all embed the same recorded boot (`recordedAt` states which one).

## Integrity model (direction B)

The report body is canonical JSON (sorted keys, no insignificant whitespace, safe integers only — `canonicalJsonText` imported from the public `dsh-community-market` export face), so the archived file bytes are exactly the bytes a verifier re-serializes after parsing: verification binds to the report's exact content, and any content change to a re-signed report breaks its signature.

Client-side signing was removed: a private key shipped inside the client is extractable by exactly the attacker it would claim to bound, so it added no forge resistance. `DIAGNOSTICS_SIGNING_PUBLIC_KEYS` in `src/diagnostic-self-check.ts` keeps the strict `{keyId, publicKey}` view-key shape (the key body, not just a fingerprint, because a self-contained re-signed report must carry it) as future material: a centralized re-signing service — company-side, holding the private key — can later sign exported reports and publish the public halves, without a report-grammar or runbook break. Rotation would be dual-key overlap like the other channels, and the manual's fingerprint table is updated with each release.

## Verifying

`scripts/verify-diagnostics-report.mjs` runs on a stock Node with zero dependencies and accepts either the extracted report or the whole diagnostics ZIP:

```sh
node scripts/verify-diagnostics-report.mjs diagnostics-<timestamp>-<id>.zip
# or, after `unzip -p diagnostics-*.zip self-check-report.json > report.json`:
node scripts/verify-diagnostics-report.mjs report.json

# enforce the manual's fingerprint and rotation slot (re-signed reports):
node scripts/verify-diagnostics-report.mjs diagnostics.zip --fingerprint <64 lowercase hex> --key-id <id>
```

The script's job is **content-tamper verification**. An unsigned report is the expected shape, not a script error: the script prints a prominent `UNSIGNED` line, restates the recorded reason, and exits 0 — absence or suppression of the report is the control signal, and whether an UNSIGNED export is a finding is the reviewer's call per the runbook (P4-2). A signature block, when present, proves the report content is byte-intact under the ed25519 key embedded beside it; binding that key to the company is the administrator's step — compare the printed `fingerprint` against the fingerprint published in the operations manual, or pass `--fingerprint` to make the script enforce it.

Exit codes: `0` signature verified, or unsigned report flagged with an UNSIGNED warning; `1` verification failed (tampered content, malformed report, or a missing/unreadable report); `2` usage error.
