# Agent Note: Company marketplace and client lockdown

Status: Proposed

English | [中文](2026-08-22-company-market-and-client-lockdown.zh.md)

## Background and goals

DSH Desktop is distributed as an internal company build: the Electron shell in `dsh-plugin-desktop/` around the pinned upstream checkout in `deepseek-harness/`, which must never be edited. Company security requirements:

1. Users may only install plugins from a company-internal marketplace, with per-plugin fingerprint and signature verification at install time.
2. Users cannot change client configuration to bypass the marketplace.

The goal of this note is to record the layered design, the concrete change points per file, and the phased plan, before any implementation starts. Nothing here is implemented yet.

## Threat model

Two attacker profiles, separated at the client/OS boundary:

| | Casual user | Adversarial user |
|---|---|---|
| Capability | Edits config files, uses UI and built-in terminal | Full local account, file writes, process spawn, npm access |
| Stopped by | L1 client policy lock | Only L2 signatures at install/boot, partially; fully only L3+L4 |
| Not stopped by | — | Any client-side check alone (code is plaintext on disk) |

The client runs as the user. Anything the client reads or enforces, an admin-capable user can rewrite: the app directory is per-user writable, core code is unpacked plaintext, and `runAsNode` is deliberately enabled. Client-side enforcement (L1–L3) stops normal users and raises the cost for everyone else; it cannot stop a determined user with local administrator rights. That boundary is why L4 exists as an IT-level control, and why L2 boot verification makes silent tampering detectable rather than impossible.

## Current state facts

Install path today (`dsh-plugin-desktop/src/profile.ts` `prepareDesktopProfile()`): resolves DSH home, reads `<home>/profiles/<name>/package.json` (`dsh.profile.bundles`), loads each bundle's `dsh.bundle.patch`, composes bundle patches plus the launcher's own `cordis.patch.yml` (inserted after `@deepseek-ai/dsh-web-app`), plus the optional user-editable home-level patch `<home>/cordis.patch.yml` (`PROFILE_PATCH_FILENAME`), plus the profile patch.

Install surfaces:

- Market UI (`dsh-community-market` settings tab "Plugin market" and sidebar overlay) calling `desktopPnpm.installPlugin()` (`dsh-plugin-desktop/src/pnpm.ts`), which runs a managed `pnpm add pkg@exact --save-exact` into `<DSH_HOME>/profiles/desktop/node_modules`.
- `dsh plugin add` in the built-in terminal (`dsh-plugin-desktop/src/desktop-cli.ts` forces `--profile`; runs the upstream dsh CLI through RunAsNode).
- npm SHA-512 integrity, official-registry tarball, and bundle-patch checks exist in `dsh-community-market/src/install/service.ts`; lifecycle scripts are blocked by the managed pnpm path.
- Plugin enable/disable state is disable-only, at `<userData>/plugin-management/state.json` (`dsh-plugin-desktop/src/main.ts`, `dsh-plugin-desktop/src/desktop-plugins.ts`).

Market scaffold: `dsh-community-market/docs/market-shell.md` records Phases 0–2 as delivered; "updates and release hardening" and "stronger verification signals based on independently specified evidence" are planned, not implemented. Trust today = npm registry identity + SHA-512 integrity + repository backlink + lifecycle-script ban (`dsh-community-market/docs/install-and-uninstall.md`); `dsh-community-market/SECURITY.md` explicitly disclaims plugin security review. Catalog schemas in `dsh-community-market/docs/schemas/catalog-*.json` are wire shapes only. `dsh-community-fabric/docs/rfcs/0004-provenance-validation-and-diagnostics.md` sketches a declared/resolved/decided/observed evidence vocabulary bound to immutable artifact identity — concepts, no runtime.

Market provider selection lives in `<userData>/desktop-market/state.json` with values `disabled | community-market | dsh-market`, default `disabled` (`dsh-plugin-desktop/src/desktop-market.ts`).

User-touchable config surfaces: `<DSH_HOME>/settings.yaml` (or JSON) via `@deepseek-ai/dsh-settings-file`, read for `dsh-desktop.mode`/`port`; the home-level `cordis.patch.yml` loaded at boot (arbitrary plugin-row injection); profile manifests `<home>/profiles/*/package.json` directly editable. The npm launcher `dsh-plugin-desktop/src/bin.ts` accepts only `--export-diagnostics`, `-h`, `-V`, but the packaged app exposes the upstream dsh CLI, including `plugin add`, through RunAsNode.

Packaging/hardening facts (`dsh-plugin-desktop/package.json` build config): NSIS `perMachine: false` (per-user, user-writable install directory); `asar: true` but `asarUnpack` includes `package.json`, `cordis.patch.yml`, `build/**`, `lib/**`, `node_modules/**`, so core code is plaintext on disk; `electronFuses.runAsNode: true` is deliberate (`dsh-plugin-desktop/src/pnpm.ts` sets `ELECTRON_RUN_AS_NODE=1` for pnpm; terminal and desktop-cli reuse the exe as Node). Updates use a fixed endpoint with fixed URLs, a 1 GiB cap, atomic write, and DMG `koly` / Win PE magic-byte checks only — no cryptographic signature (`dsh-plugin-desktop/src/update-checker.ts`, `dsh-plugin-desktop/src/update-download.ts`). `dsh-plugin-desktop/scripts/verify-packaged-runtime.ts` (afterPack) is a build-time presence check, not runtime enforcement. Windows already has pwsh sandbox, ACL runner, and agent-preset guards, plus the loopback-only webserver invariant.

## Design

Four layers. L1–L3 are changes in `dsh-plugin-desktop/` and `dsh-community-market/` only; the upstream submodule is untouched. L4 is a documented IT handoff, not client code.

### L1 — client policy enforcement

Introduces a read-only policy source bundled with the app (not under `<DSH_HOME>` or `<userData>`). Defaults locked. Concrete change points:

- **Market provider pin**: `dsh-plugin-desktop/src/desktop-market.ts` — effective provider comes from policy, not the user-writable `state.json`; the company provider replaces `community-market` as the only non-`disabled` selection.
- **Registry allowlist**: `dsh-plugin-desktop/src/pnpm.ts` managed installs and `dsh-community-market/src/install/service.ts` verification — only the company registry endpoint is accepted; npm.js as a source is refused.
- **Home patch rejection**: `dsh-plugin-desktop/src/profile.ts` — `<home>/cordis.patch.yml` is refused unless policy allows it; profile manifest bundle lists are validated against signed receipts (see L2).
- **CLI gate**: `dsh-plugin-desktop/src/desktop-cli.ts` `plugin add` path routes through the same signature verification as Market installs before the managed pnpm run.
- **Settings surface**: `dsh-desktop` namespace remains restart-scoped; any setting that could re-open the above paths is policy-owned, not user-owned.

### L2 — company signing and marketplace service

Company-maintained ed25519 keys. The company catalog service serves a signed manifest: per-plugin entries bind plugin identity + version + npm SHA-512 integrity, and the manifest itself carries a company signature. Client verifies at install time (both Market UI and `dsh plugin add`) and verifies installed bundles at every boot — an unsigned or mismatched bundle is refused at load, not silently skipped. Install receipts record the verified signature alongside the existing receipt data, reusing the `dsh-community-fabric` RFC 0004 evidence vocabulary where it fits (`resolved` for digests resolved from immutable inputs, `decided` for policy outcomes). No HSM or key-rotation design is decided yet (see Open questions).

### L3 — packaging hardening

- NSIS `perMachine: true` with an ACL-protected install directory, extending the existing Windows ACL runner approach.
- Code signing of installers with the company Authenticode certificate.
- Enable the Electron asar integrity validation fuse; shrink `asarUnpack` to the minimum that keeps native modules loading.
- Flip `runAsNode` off by shipping a bundled Node runtime used by pnpm, the built-in terminal, and desktop-cli, replacing the reuse-the-exe design in `dsh-plugin-desktop/src/pnpm.ts` and `dsh-plugin-desktop/src/desktop-cli.ts`.
- Pin the update channel and require signed update artifacts; extend the magic-byte checks in `dsh-plugin-desktop/src/update-download.ts` with signature verification.

### L4 — OS/IT-level enforcement (handoff, not client code)

A document for IT: WDAC/AppLocker policy for the app and the bundled Node runtime, machine ACLs, and a managed `DSH_HOME`. L4 is the only layer that actually binds an adversarial admin user. Whether employee machines are company-managed determines whether L4 is mandatory (see Open questions).

## Phased implementation plan

| Phase | Scope | Exit condition |
|---|---|---|
| 1 | L1 policy pack: provider pin, registry allowlist, home-patch rejection, CLI gate; boot verification skeleton | Locked client refuses every non-company install surface with tests |
| 2 | L2 signing infra, company catalog service, signed receipts, boot verification of installed bundles | Unsigned plugin cannot load after restart |
| 3 | L3 packaging: perMachine + ACLs, Authenticode, asar integrity fuse, reduced asarUnpack, bundled Node runtime, signed updates | Packaged build passes all fuse and signing gates |
| 4 | L4 IT handoff document | IT sign-off on WDAC/AppLocker and managed-home runbook |

Phase 3's bundled Node runtime is the largest single change because the terminal, desktop-cli, and pnpm all currently reuse the exe as Node; it lands after L1/L2 so the locked client is provable first.

## Non-goals

- The upstream submodule `deepseek-harness/` stays untouched; all changes live in `dsh-plugin-desktop/` and `dsh-community-market/` (plus new signing/service infrastructure outside the client).
- Compatibility mode and the advanced shell are unchanged; this design does not alter presentation, mode persistence, or restart policy.
- No general plugin sandboxing or capability enforcement is proposed here; that remains the separate `dsh-community-fabric` RFC track.

## Open questions

- Are employee machines company-managed? This decides whether L4 is mandatory or optional, and how much L3 hardening is worth its cost.
- Key management venue: CI secrets versus an HSM; rotation and revocation procedure for the ed25519 catalog key. **Resolved 2026-08-22: CI secrets.**
- Where is the pinned update channel hosted, and does it share the company catalog service's signing key or get a separate one? **Resolved 2026-08-22: separate update-channel key (see P3-3).**

## Decision record — key management (P2-7, resolved 2026-08-22)

**Decision: dedicated publishing environment with CI secrets; no KMS/HSM in this phase.**

- **Venue**: a dedicated publishing environment (separate CI environment from the code CI), with the ed25519 catalog signing key stored only in that environment's secrets. Minimum personnel; permissions on the secrets are isolated from the code repository's write access. The key never exists on a client machine or in any artifact.
- **Rationale**: the trust anchor is the fingerprint pinned in the immutable `DesktopPolicy.trustRoots` (shipped inside the app); the venue only protects the private key, and CI secrets with access isolation meet the accepted security ceiling (L1–L4 model; professional users who can modify the app binary bypass all client checks anyway, with diagnostic evidence left behind).
- **Rotation**: dual-key overlap. Add the new key's fingerprint to `trustRoots` (app release) → publish manifests signed by the new key → remove the old fingerprint in the next app release. No client-side action outside normal app updates; overlap windows can be arbitrarily long.
- **Revocation**: republish the manifest with the entry `revoked: true` and a strictly greater `sequence` (the P2-6 pipeline's `revoke` command). Key compromise additionally advances rotation.
- **Update channel**: signed with a **separate** key (P3-3); compromising one channel never breaks the other.
- **Future upgrade path**: the client only pins public-key fingerprints, so migrating the private key to a KMS/HSM later requires zero client changes.
- **Runbook drill (to be executed once the P2-6 pipeline lands)**: one rotation rehearsal (dual key → withdraw old) and one revocation rehearsal on a test manifest, both recorded in the dev log.
