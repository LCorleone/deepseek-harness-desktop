/** Lifecycle hooks that package managers may execute as part of installation. */
export const INSTALL_BUILD_SCRIPT_NAMES = Object.freeze([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepack',
] as const)

type PackageManifest = Readonly<Record<string, unknown>>

/**
 * Detect direct package metadata that requires an explicit local-code decision.
 * Transitive safety still comes from the reviewed catalog build policy; this
 * check prevents a changed npm release from silently widening that policy.
 */
export function packageRequiresBuildApproval(manifest: PackageManifest): boolean {
  if (manifest.gypfile === true) return true
  const scripts = manifest.scripts
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return false
  const record = scripts as Readonly<Record<string, unknown>>
  return INSTALL_BUILD_SCRIPT_NAMES.some(name => (
    typeof record[name] === 'string' && record[name].trim().length > 0
  ))
}
