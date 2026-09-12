# Plugin Ecosystem and Distribution

[中文](plugin-ecosystem.md) | English

DSH composes its capabilities from plugins. The more plugins there are, the more their ability to work together matters: if every plugin assumes or overrides another plugin's internals, installing a few plugins starts to conflict. This page states the three conventions of the company plugin ecosystem and how a plugin travels from its author to every machine.

## Three conventions

1. **Composition first**: compose capabilities through official slots, services, and patches; never assume or override another plugin's internals.
2. **Declare clearly**: state the services and slots you depend on; do not rely on runtime coincidences.
3. **Compatibility first**: keep upgrades backward compatible and never break existing compositions.

The desktop shell itself is the worked example of the first convention: desktop capabilities plug in as ordinary Cordis plugins on the same composition path as upstream and company plugins, with no special privileges.

## Distribution model (the company signed catalog)

Plugins do not reach employee machines through the public ecosystem; they go through the signed catalog:

- The only human-authored input is the reviewed [`tools/company-catalog/allowlist.json`](../tools/company-catalog/allowlist.json); each entry pins a package name, an exact version, and integrity.
- Colleagues submit plugins as MRs in the intranet GitLab handoff repository (`submissions/<name>-<version>`, `handoff.json` + tgz); the owner runs the `verify-handoff` / `accept-handoff` mechanical gates and applies a content audit before accepting.
- CI assembles the allowlist into a canonical-JSON manifest with a detached ed25519 signature; `publish-local.mjs` pushes the signed artifacts to the intranet GitLab origin.
- Clients trust only the signed manifest: they install only entries it pins (npm channel or intranet tarball channel) and re-verify the installed plugin tree at every boot; a monotonic sequence ratchet blocks rollbacks.
- **Listing is not a security endorsement**: the gates are mechanical verification plus an owner-side content audit; trust in the install chain comes from signatures and pinning, not from submitter claims.

## Beta channel

New entries first ship on the beta manifest to a signed tester roster (`state/beta-testers.json`) for soaking, then move byte-for-byte into the stable manifest via `promote`. Roster changes re-sign and take effect immediately, without a client release.

## Authoritative runbooks

Process and commands are defined by [`tools/company-catalog/README.md`](../tools/company-catalog/README.md) and [`tools/company-catalog/docs/handoff/`](../tools/company-catalog/docs/handoff/) (SOP / RELEASE / MR-HANDLING); this page describes the model only.

## Interoperability draft

[`dsh-community-fabric/`](../dsh-community-fabric/README.md) is the repository's private plugin-interoperability RFC draft (manifests, capabilities, event contracts) — documentation only, with no loadable entry points; plugins today still use the existing DSH/Cordis interfaces.

## Further reading

- Writing plugins: [Plugin development](plugin-development.en.md)
- Daily use: [User guide](user-guide.en.md) · [FAQ](faq.en.md)
