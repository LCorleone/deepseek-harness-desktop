# Diagnostics self-check report (P4-1)

Every diagnostics archive carries `self-check-report.json`: a signed, machine-readable snapshot of the build's own security posture at export time. It exists for the company security administrator — not the client — to answer "what did this installation actually load, and under which policy?" without trusting log text.

## Report contents

| Field | Meaning |
| --- | --- |
| `reportVersion` | Report grammar version (`1.0.0`). |
| `generatedAt`, `appVersion`, `platform`, `arch`, `nodeVersion` | When the export ran and which build produced it. |
| `policy` | Self-measurement of the embedded policy asset: `locked` flag, SHA-256 over the exact `desktop-policy.json` bytes, byte length, and the pinned company-catalog trust roots. `available: false` (with `reason`) means the asset could not be read or strictly parsed. |
| `nodeRuntime` | Bundled Node runtime self-check (P3-1): `verified` (command matched its packaged sha256 manifest), `development` (unpackaged run), or `failed` (with reason). |
| `bootVerification` | The recorded boot's third-party bundle decision (P2-4): `manifestTrusted`, `manifestSequence`, `keyId`, `manifestFailure`, and the full `allowed`/`refused` lists. `available: false` explains why (unlocked build, or export before any boot completed). Allowed entries carry `resolved` (boot evidence grade `receipt`/`manifest-only`, manifest sequence, key) and `decided: {allowedBy: 'signed-company-manifest'}`; refused entries carry `decided: {refusedBy: 'boot-verification', reason}` — the RFC 0004 evidence vocabulary (`dsh-community-fabric`, "Provenance, Validation, Diagnostics, and the Effect Ledger" §4), aligned with market receipt v2 (`MarketEvidenceClass`). |
| `signing.viewKeys` | keyIds and SHA-256 fingerprints of the diagnostics view keys this build pins. |
| `signature` / `unsigned` | Exactly one is non-null: the detached ed25519 signature block (with the signing public key embedded, making the report self-contained), or the recorded reason the export is unsigned. |

The Electron launcher persists each boot's decision to `<user-data>/boot-verification.json` right after profile composition; exports read that snapshot, so tray, recovery-window, and headless `--export-diagnostics` exports all embed the same recorded boot (`recordedAt` states which one).

## Signature scheme

The report body is canonical JSON (sorted keys, no insignificant whitespace, safe integers only — `canonicalJsonText` imported from the public `dsh-community-market` export face). The signature is detached ed25519 over the canonical serialization of the report **minus its `signature` member**; the archived file bytes are exactly that canonical text, so any reformatting is detectable.

Signing uses a dedicated diagnostics **view key** — the same ed25519 trust-root shape as the company catalog (P2-1) and update (P3-3) channels, but a completely independent key held by the release pipeline. `DIAGNOSTICS_SIGNING_PUBLIC_KEYS` in `src/diagnostic-self-check.ts` pins the public halves as `{keyId, publicKey}` entries (the key body, not just a fingerprint, because the self-contained report must carry it). The constant ships empty in development builds: those exports are `unsigned` with an explanatory reason, exactly like the empty `ARTIFACT_TRUST_ROOTS` placeholder. The P4-4 release gate owns replacing the array.

## Verifying

`scripts/verify-diagnostics-report.mjs` runs on a stock Node with zero dependencies and accepts either the extracted report or the whole diagnostics ZIP:

```sh
node scripts/verify-diagnostics-report.mjs diagnostics-<timestamp>-<id>.zip
# or, after `unzip -p diagnostics-*.zip self-check-report.json > report.json`:
node scripts/verify-diagnostics-report.mjs report.json

# enforce the manual's fingerprint and rotation slot:
node scripts/verify-diagnostics-report.mjs diagnostics.zip --fingerprint <64 lowercase hex> --key-id <id>
```

A valid signature proves the report is byte-intact under the key embedded beside it. Binding that key to the company is the administrator's step: compare the printed `fingerprint` against the fingerprint published in the operations manual (P4-2), or pass `--fingerprint` to make the script enforce it. Exit codes: `0` verified, `1` verification failed (tampered content, malformed report, or unsigned development report), `2` usage error.

Rotation is dual-key overlap like the other channels: append the new view key, publish reports signed under it, remove the old entry in a later release. The manual's fingerprint table is updated with each release; a fingerprint that appears in no published row must be treated as untrusted.
