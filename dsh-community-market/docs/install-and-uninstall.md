# Install and uninstall

[中文说明](install-and-uninstall.zh.md)

This guide describes the package-operation boundary used by DSH Community Market.

## Views

| View | Source of truth | Available operations |
| --- | --- | --- |
| Discover | Normalized selected catalog source | Browse details and request install preview |
| Installable | Catalog entries with one npm package identity | Request install preview |
| Installed | Active Profile direct dependencies and bundle list | Uninstall removable dependencies; core bundles are read-only |
| Sources | User-owned catalog source settings | Add, select, order, and remove sources |

Installed state is independent of the selected catalog and of which market performed the installation.

## Install flow

1. The user selects a catalog item. The Renderer sends only `sourceRecordId` and `itemId`.
2. The Host resolves the normalized npm package identity it previously observed.
3. The Host first requires a reviewed `installPolicy.mode: automatic` bound to an exact release, then requests `https://registry.npmjs.org/<package>/latest` and requires the same package name, the same reviewed stable version, a valid `dsh.bundle.patch` declaration, and no direct install lifecycle or native `gypfile` requirement.
4. The confirmation shows the package, exact version, current Profile, and preview expiry.
5. On confirmation, the Host consumes the one-shot `previewId` and calls `desktopPnpm.run()` with Host-owned argv for an exact `pnpm add`.
6. The Host reconciles the package into `dsh.profile.bundles` and confirms that it is now a direct Profile dependency.

The source's listed version is never used as the install target. Reviewed build-policy evidence gates entry into automatic preview, and current npm lifecycle metadata can stop preview before mutation. Repository equality, deprecation metadata, engine ranges, integrity metadata, and generic provider badges do not independently grant install authority. Provider command strings are discarded.

Market installation creates no receipt, checkpoint, retry, cleanup, or rollback operation. Desktop's ordinary Profile checkpoints cover the resulting state.

## Automatic-install conditions

A catalog entry can reach automatic install preview only when:

- exactly one valid npm package name is normalized from the entry;
- a reviewed local adapter emits `installPolicy.mode: automatic` with an exact reviewed version for that identity;
- the package is not `dsh-plugin-desktop` or `dsh-community-market`;
- npm `latest` is the same exact stable version reviewed by the adapter; and
- the npm manifest declares a safe relative DSH bundle patch path; and
- the current manifest declares no `preinstall`, `install`, `postinstall`, `prepare`, `prepack`, or native `gypfile` requirement.

Failure keeps the item browseable and may expose a display-only manual command.

## Uninstall flow

1. Desktop reads the active Profile's `dependencies` and `dsh.profile.bundles`.
2. Each direct bundle receives a generation-scoped opaque `bundleId`. Product-owned bundles are read-only; other direct dependencies are removable.
3. The Renderer submits only that `bundleId`.
4. The Host resolves it again against current inventory, verifies that the package is still a direct dependency, and returns a one-shot confirmation.
5. On confirmation, the Host calls `desktopPnpm.run(['remove', packageName])`, removes the bundle entry, and confirms that the Profile no longer references the package.

This flow applies equally to plugins installed by Community Market, another plugin market, or the DSH CLI. Market offers no enable or disable action.

## Manual fallback

If build approval is required or no reviewed build policy exists, the Host constructs a bounded display-only command from normalized identity. The details dialog explains the reason and offers **Open DSH Terminal**. That action opens the terminal only; it sends no package command, path, approval, or Profile and performs no mutation. The user reviews any build-script permission requested by pnpm and decides outside the graphical flow.

## Failure behavior

| Failure | Result |
| --- | --- |
| npm latest cannot be resolved or is not a stable DSH plugin | No package operation starts |
| The reviewed policy requires build approval, npm latest changed, or the release now declares an install/build hook | Automatic installation is withheld; the manual terminal instruction remains available |
| Profile changes after preview | The one-shot preview is rejected |
| pnpm fails | The error is reported; Market performs no automatic cleanup or rollback |
| Profile reconciliation fails after pnpm | The error is reported for diagnosis or explicit Recovery checkpoint restore |
| Renderer closes after confirmation | The Host-owned package operation continues; only the response may be lost |

After a successful mutation, the user may restart now or later. Restart is never silent.
