/**
 * The desktop build identity: the upstream-pinned product version plus our own
 * build counter as semver build metadata.
 *
 * - The installer/updater face keeps the plain product version (2.0.3 …) so
 *   the same-version reinstall upgrade path and upstream version tracking
 *   are untouched.
 * - Client-visible surfaces that must distinguish builds (telemetry
 *   `client_version`, the disclaimer gate's per-build re-prompt, the log
 *   header) use {@link desktopBuildVersion}: `2.0.3+b63` when CI baked a
 *   build number, plain `2.0.3` in unpackaged runs (seq 0).
 */

import { readFileSync } from 'node:fs'

import { DSH_BUILD_SEQ } from './build-seq.generated.ts'

/** Plain product version from the package manifest (the installer's version). */
export function desktopProductVersionBase(moduleUrl: string = import.meta.url): string {
  // reads dsh-plugin-desktop/package.json beside the built module
  const manifest: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'))
  if (manifest === null || typeof manifest !== 'object'
    || typeof (manifest as { version?: unknown }).version !== 'string') {
    throw new Error('dsh-plugin-desktop: package.json has no product version')
  }
  return (manifest as { version: string }).version
}

/** Build-distinguishing identity: `2.0.3+b63` when a build seq was baked in. */
export function desktopBuildVersion(moduleUrl: string = import.meta.url): string {
  const base = desktopProductVersionBase(moduleUrl)
  return DSH_BUILD_SEQ > 0 ? `${base}+b${String(DSH_BUILD_SEQ)}` : base
}

