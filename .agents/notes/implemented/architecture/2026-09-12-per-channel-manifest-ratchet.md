# Agent Note: Per-channel company-manifest ratchet — beta watermarks may legitimately run above stable

[中文](2026-09-12-per-channel-manifest-ratchet.zh.md)

Status: **implemented** (commit chain `32ca244325` per-channel split, review P3 →
`dd65b8d845` stable writer + full read-side scan floor, review P2 → `351516c6e5` e2e pinning
the derivation). This note is the design account for why the two catalog channels keep
**independent** anti-rollback high-water marks, why a beta sequence above stable's is
legitimate rather than a rollback, and what migration from the legacy single ratchet
guarantees. The b91 device narrative lives in
`dev-log/briefs/2026-09-11-cli-stale-staged-manifest-p1.md` (§4 晚间复盘).

## The flaw: one mixed floor

Until `32ca244325`, the locked `dsh plugin add` gate floored every manifest verification
against one mixed number: `max(highest install receipt, persisted ratchet)`
(`desktop-cli.ts`, then `lockedPluginAddSequenceFloor`, joined in b90 `3ce59e41c5`). The
persisted record (`companyManifest.sequence` in the shared market settings document) carried
no channel attribution, so on a tester whose beta overlay had advanced, the floor was
beta-raised (beta 29 / stable 27 on the incident device). Stable staged bytes — the
launcher's boot snapshot, the embedded asset — verified against that floor and were denied
`stale-sequence` on **every** gated install. The one stale-staged network retry could never
succeed either: the true latest stable manifest *is* 27, legitimately below a beta-raised
floor, so there is nothing fresher to fetch; the 8s bound only caps the wait. Fail-closed,
fast, and permanent until stable caught up — the b91 incident (2026-09-11, sole b91 user).

## Decision: one high-water mark per channel

The two channels **share one publishing sequence space but not one publication cadence**:
the pipeline signs the beta manifest as a superset of stable on the shared sequence ratchet,
so a beta sequence above stable's is the normal tester steady state, never evidence of a
stable rollback (`cli-install-channel.ts` module docs; `tools/company-catalog/README.md`).
Since review P3 every sequence comparison is per channel:

- the gate's **stable** bytes (`DSH_COMPANY_MANIFEST_FILE`, the embedded asset, or the stale
  retry's network bytes) face the **stable** floor only (`lastSeenSequence` →
  `authorizeLockedPluginAdd`, `cli-install-channel.ts`); the staged **beta hand-off** bytes face
  the **beta** floor only (`lastSeenBetaSequence`, verified `channel: 'beta'`), stacked on the
  anti-downgrade rules beta ≥ the just-verified stable sequence and = the hand-off's sequence
  claim;
- both floors are `max(highest receipt sequence, that channel's persisted ratchet)`
  (`lockedPluginAddSequenceFloors`, `desktop-cli.ts`); receipts record the **stable** sequence
  that allowed each install, so the receipt floor lower-bounds both channels, and the ratchets
  join per channel;
- boot verification joins receipts with the **stable** ratchet only
  (`desktopBootVerificationInputsFromSettings`); the market scan's overlay faces `max(beta
  floor, just-verified stable sequence)` (`acquireManifest`, `company-market-install.ts`).

Each floor is monotonic: `raiseMarketManifestChannelRatchet` (`boot-verification.ts`) writes
`max(recorded, sequence)` under the settings document's writer lock, atomically —
`raiseMarketBetaManifestRatchet` after a beta overlay verifies,
`raiseMarketStableManifestRatchet` after a stable scan verifies (wired in `main.ts`).

## Migration is a pure read; the legacy generation closes itself

`marketManifestChannelRatchetsFromSettings` (`boot-verification.ts`) reads the new
`companyManifestChannels: { stable?, beta? }` record beside the legacy one and never writes
during migration. `betaRatchet = splitBeta ?? stableRatchet` — an absent split beta record
means beta was never applied, and the beta floor seeds at the stable mark (sound because
every published beta rides at or above stable). `stableRatchet = splitStable ??
legacyStableClamp` — on a stable-only machine the legacy value is kept intact (no machine's
floor decreases); on a beta-evidence machine it is clamped to `min(legacy, highest
receipt)`, seeded from receipts evidence and never above what stable provably reached — a
legacy value above every stable observation was never legitimately reached by the stable
channel, so the clamp restores the channel-correct bound rather than weakening it.

After the split, `companyManifestChannels.stable` briefly had no writer, so every read kept
guessing from the unattributable legacy value. `dd65b8d845` closed that: the scan persists
the stable ratchet where it legitimately advances, and its floor is the **full read-side
floor** (`marketStableManifestScanFloorFromSettings`) = `max(receipts, persisted stable
record, legacy clamp)`, so a below-floor signed manifest is refused *before* it can verify,
persist, or re-stage — seeding the writer from the receipts alone would let a signed stable
replay between the receipts mark and the legacy mark persist and durably lower the boot-side
floor. The scan is fail-closed where boot readers are tolerant (an uncomputable floor
throws), re-stages the verified bytes into `DSH_COMPANY_MANIFEST_FILE` per operation, and
leaves the terminal gate's stale-staged retry armed but bounded
(`STALE_STAGED_MANIFEST_RETRY_TIMEOUT_MS = 8_000`). The pre-split replay residual that clamp
leaves open is thereby bounded to the one legacy generation and closes for good on the first
persisted stable write.

## Consequences for future readers

- **Never compare a stable sequence against a beta-derived floor, or vice versa.** e2e
  scenario e3a (`scripts/e2e-market-reliability.mjs`) drives the real
  `lockedPluginAddSequenceFloors` against the affected-machine document shape, so a derivation
  that recombines the channels fails CI loudly.
- The publishing invariant **beta ⊇ stable at a sequence ≥ stable's** is what keeps the beta
  lower bound sound (the beta floor may seed at the stable mark); publishing must preserve it.
- Promoting stable to ≥ beta is a pure publishing decision again, not a client-unlock
  prerequisite. The settings document stays user-writable — ratchets raise replay cost only,
  unchanged from the signed-off R3 residual (`2026-08-22-residual-risk-acceptance.md`).

## Verification

Focused: `desktop-cli.spec.ts` (beta-raised machine admits today's stable bytes per-channel;
genuine stable rollback below its own floor still denies), `boot-verification.spec.ts`
(beta-raised single ratchet migrates to beta 29 / stable 27; persisted stable value
supersedes the clamp; boot stable floor isolated from the beta ratchet),
`company-market-install.spec.ts` (stable ratchet raised from the scan path; below-legacy
replay refused before the writer can persist; uncomputable floor refuses the scan). e2e
`e2e:market-reliability` gates the product CI.