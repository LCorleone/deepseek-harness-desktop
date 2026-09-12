# DSH Desktop FAQ

[中文](faq.md)

Quick answers for company-internal users. The shipped scope follows the fleet builds distributed internally; the [user guide](user-guide.en.md) covers daily use in more detail.

## What is DSH Desktop?

The company-internal DSH desktop client: it packages the local Web UI, Host service, and plugin system of a pinned upstream DeepSeek Harness into a native desktop application, with the company lockdown policy and signed plugin catalog on top. The product is for company-internal use only and is not published externally.

## Which platforms are supported? Do I need to install a runtime?

The company distribution target is Windows x64. The installer bundles Electron, Node, pnpm, and the pinned DSH dependencies, so users install and launch directly without Node.js or any command-line setup.

## Where do I get the app and plugins?

Installers are distributed internally (CI Windows fleet builds); there is no public download site. Plugins install through the built-in company market; the market portal is <https://plugin-market.s.dai.deloitte.cn/>.

## Can I install any npm plugin?

No. Locked builds install only entries pinned by the company signed catalog: market installs verify the signed manifest first, the terminal `dsh plugin add` is gated, and the installed plugin tree is re-verified at every boot. To ship a self-built plugin, follow the handoff SOP — see [Plugin ecosystem and distribution](plugin-ecosystem.en.md).

## Is there a beta channel for plugins?

Yes. New plugins first ship on the beta manifest to a signed tester roster for soaking; after promotion (`promote`) they enter the stable manifest and become visible to everyone. Machines outside the roster are unaffected by beta.

## How does the app update?

New fleet builds are distributed internally; the upgrade cadence follows the internal release rhythm. The built-in update check currently still points at the public endpoint inherited from the upstream product (replacing it with a company-owned update source is on the work ledger in `.issues/`).

## Where is data stored?

Sessions, profiles, and settings stay on the local machine. Release builds report model-usage metering per the locked policy (SSO email, model, bucketed token counts, latency, version, and similar runtime metadata — never conversation content); details are in [`dsh-plugin-desktop/README.md`](../dsh-plugin-desktop/README.md).

## Something is broken — what now?

Check the [user guide](user-guide.en.md) first. If the problem remains, export a diagnostics bundle from the tray (**Export Diagnostics**) and report it through the internal support channel. Developers should also see the [architecture notes](architecture.en.md) and the `dev-log/` session log.
