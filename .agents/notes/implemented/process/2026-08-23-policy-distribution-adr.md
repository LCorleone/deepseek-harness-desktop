# Agent Note: Desktop policy distribution through one parsed authority

Status: implemented

English | [中文](2026-08-23-policy-distribution-adr.zh.md)

## Problem

The embedded desktop policy document (`lib/policy/desktop-policy.json`) reaches runtime code through five parallel channels, each with its own acquisition rule:

1. **Main-process asar reads.** `readDesktopPolicy()` parses the asar-embedded asset and is invoked at six call sites: the boot wiring in `main.ts`, the development fallback in `desktop-cli.ts`, and the four market-selection helpers in `desktop-market.ts`.
2. **CLI environment hand-off.** Bundled-Node CLI children cannot read inside `app.asar` and the unpacked policy copy is user-writable, so the launcher injects four variables (`DSH_DESKTOP_POLICY_LOCKED`, `_CATALOG_ORIGIN`, `_MANIFEST_URL`, `_TRUST_ROOTS`) that `desktopPolicyFromEnvironment` decodes strictly.
3. **Market capability.** The market bundle reads a narrow `desktopPolicy` capability view (`locked`, `trustRoots`, `companyCatalogOrigin`, `companyManifestUrl`) provided by the host; the market package never imports the desktop policy definition.
4. **Profile composition parameters.** `prepareDesktopProfile` and the boot-verification input assembly receive the already-parsed policy as parameters.
5. **Compiled registry pin.** `PINNED_NPM_REGISTRY` in `pnpm.ts` is a build constant, not document content.

Five acquisition rules with no stated authority invite drift: one channel re-parsing or re-interpreting the document could disagree with the rest about whether a build is locked or which trust roots bind the company catalog.

## Decision

`readDesktopPolicy()` called once in the Electron main process (`main.ts`) is the **single authority**: the one place the document bytes become a parsed policy. Every other channel is a **projection** of that parsed value, never an independent parse of the document:

- the CLI child receives the environment entries derived from it (`desktopPolicyEnvironmentEntries`), and its direct asset read stays a development-checkout fallback only — a packaged launch without the hand-off fails closed;
- the market capability (`hostCtx.provide('desktopPolicy', policy)`) carries fields copied from it, narrowed to the market's own `DesktopPolicyView`;
- profile composition and boot-verification inputs receive it as parameters (composition itself performs no policy I/O — the one origin-mode manifest fetch runs before composition in `main.ts`);
- the registry pin stays compiled in `pnpm.ts` because it pins build infrastructure, not deployment policy.

## Alternatives considered

**Let every consumer parse the embedded document itself.** This maximizes independence but multiplies parse surfaces and lets channels disagree; the CLI child cannot read the archive at all, so it would depend on the user-writable unpacked copy.

**Re-publish the parsed policy through a settings-style store.** A runtime-writable copy reintroduces exactly the tamper surface the embedded document avoids.

## Consequences

A policy field change touches the one parser plus only the projections that need the field; channel disagreement becomes a visible wiring defect instead of silent drift. The CLI child's four-variable hand-off remains the one projection with its own encoding, so its decoder tests stay paired with the parser's.

## Verification

`yarn workspace dsh-plugin-desktop typecheck` and the `cli-install-channel`, `boot-verification`, and `profile` suites cover the projections; the market wiring spec (`market-wired-company-catalog.spec.ts`) covers the capability view.
