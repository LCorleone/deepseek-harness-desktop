/** Desktop-managed pnpm build-script approval for plugin profiles. */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/**
 * Dependency build scripts Desktop pre-approves in every profile workspace.
 * pnpm ≥10 refuses to run a dependency's install/preinstall/postinstall
 * script unless it is allowlisted, and pnpm 11 turns "build scripts were
 * ignored" into a nonzero exit that fails the entire `dsh plugin add` (the
 * upstream profile template cannot ship such a list). The spelling moved
 * across pnpm generations: pnpm 10.0–10.25 reads `onlyBuiltDependencies`
 * (a name list), 10.26+ also reads `allowBuilds` (a name→boolean map), and
 * pnpm 11 silently ignores the legacy key entirely (11.23 additionally
 * deletes it when writing), so Desktop maintains BOTH spellings; each pnpm
 * keeps the one it knows and ignores the other. node-pty ships prebuilds its
 * install script merely copies (the terminal panel depends on it), and
 * esbuild/protobufjs are the two most common harmless build-time
 * dependencies — approving these keeps ordinary plugin installs from
 * derailing on pnpm's build firewall.
 *
 * Plugins whose signed company catalog entry carries `approvedBuilds`
 * extend this list per install — see
 * {@link ProfilePnpmBuildApprovalOptions.approvedBuildDependencies}. This
 * module stays a pure text policy: it never reads the manifest itself, so
 * callers without market context keep the built-in triple only.
 */
const DESKTOP_APPROVED_BUILD_DEPENDENCIES: readonly string[] = [
  'node-pty',
  'esbuild',
  'protobufjs',
]

/** npm dependency name grammar accepted for approved build dependencies. */
const BUILD_DEPENDENCY_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/**
 * Options for {@link ensureProfilePnpmBuildApproval}. The default — no
 * options — approves exactly the built-in triple everywhere.
 */
export interface ProfilePnpmBuildApprovalOptions {
  /**
   * Additional dependency names to approve beside the built-in triple:
   * the `approvedBuilds` list of the signed catalog entry being installed,
   * passed in by the market install boundary after the signed allow decision
   * and before pnpm materializes the dependency tree. Names are unioned with
   * (never a replacement for) the built-in list, so a signed entry can widen
   * the approvals of one install but never shrink another profile's.
   */
  readonly approvedBuildDependencies?: readonly string[]
}

/**
 * Render one dependency name as a YAML scalar. pnpm's approval keys accept
 * scoped names (`@scope/native`), but `@` is a YAML reserved indicator that
 * may not start a plain scalar, so scoped names are single-quoted; the
 * reader (`listItemName`) already strips that quoting.
 */
function yamlScalar(name: string): string {
  return name.startsWith('@') ? `'${name}'` : name
}

/** Validated approved-build list: built-in triple first, extras deduped after. */
function approvedBuildList(extra: readonly string[] | undefined): readonly string[] {
  if (extra === undefined) return DESKTOP_APPROVED_BUILD_DEPENDENCIES
  const merged = [...DESKTOP_APPROVED_BUILD_DEPENDENCIES]
  for (const name of extra) {
    if (typeof name !== 'string' || !BUILD_DEPENDENCY_NAME_PATTERN.test(name)) {
      throw new TypeError(`approved build dependency names must be npm names (scoped allowed, lowercase): ${JSON.stringify(name)}`)
    }
    if (!merged.includes(name)) merged.push(name)
  }
  return merged
}

/**
 * pnpm 11 defaults `strictDepBuilds` to true: any ignored build script
 * fails the install. The allowlist above covers the trusted set, but a
 * catalog plugin may legitimately pull another build dependency; the pilot
 * answer is the documented transitional setting that restores pnpm 10's
 * warning behavior (the warning still surfaces through the stderr tail).
 */
const STRICT_DEP_BUILDS_KEY = 'strictDepBuilds:'

/**
 * The upstream profile template (packages/boot/app-boot/src/profile.ts
 * PROFILE_PNPM_WORKSPACE, which upstream does not export) used as the base
 * when a profile's pnpm-workspace.yaml does not exist yet. Keep
 * byte-for-byte in sync: pnpm reads its linker settings from this file and
 * boot verification relies on the hoisted linker it configures.
 */
const TEMPLATE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

const ONLY_BUILT_DEPENDENCIES_KEY = 'onlyBuiltDependencies:'
const ALLOW_BUILDS_KEY = 'allowBuilds:'
const DEFAULT_LIST_INDENT = '  '
const LIST_ITEM_PATTERN = /^(\s*)-\s*(.*?)\s*(?:#.*)?$/u
const MAP_ENTRY_PATTERN = /^(\s*)([^:#]+):\s*(.*?)\s*(?:#.*)?$/u

/** Strip YAML quoting and trailing comments from one list-item token. */
function listItemName(item: string): string {
  const stripped = item.replace(/\s+#.*$/u, '').trim()
  const quoted = /^(['"])(.*)\1$/u.exec(stripped)
  return quoted?.[2] ?? stripped
}

/** Merge one block of `key:\n  - name` list entries, appending missing names in place. */
function mergeListBlock(lines: string[], key: string, names: readonly string[]): void {
  const keyIndex = lines.findIndex(line => line.startsWith(key))
  if (keyIndex === -1) {
    const block = [key, ...names.map(name => `${DEFAULT_LIST_INDENT}- ${yamlScalar(name)}`)]
    if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, ...block)
    else lines.push('', ...block)
    return
  }
  const inline = lines[keyIndex]!.slice(key.length).trim()
  const inlineValue = inline.startsWith('#') ? '' : inline.replace(/\s+#.*$/u, '').trim()
  if (inlineValue.length > 0) {
    const existing: string[] = []
    for (const token of inlineValue.replace(/^\[/u, '').replace(/\]$/u, '').split(',')) {
      const name = listItemName(token)
      if (name.length > 0) existing.push(name)
    }
    const merged = [...existing, ...names.filter(name => !existing.includes(name))]
    lines.splice(keyIndex, 1, key, ...merged.map(name => `${DEFAULT_LIST_INDENT}- ${yamlScalar(name)}`))
    return
  }
  const existing: string[] = []
  let itemIndent = DEFAULT_LIST_INDENT
  let lastItemIndex = keyIndex
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const match = LIST_ITEM_PATTERN.exec(lines[index]!)
    if (match === null) break
    const name = listItemName(match[2] ?? '')
    if (name.length > 0) existing.push(name)
    if (lastItemIndex === keyIndex) itemIndent = match[1] ?? DEFAULT_LIST_INDENT
    lastItemIndex = index
  }
  const missing = names.filter(name => !existing.includes(name))
  if (missing.length > 0) {
    lines.splice(lastItemIndex + 1, 0, ...missing.map(name => `${itemIndent}- ${yamlScalar(name)}`))
  }
}

/** Merge one block of `key:\n  name: true` map entries, appending missing names in place. */
function mergeMapBlock(lines: string[], key: string, names: readonly string[]): void {
  const keyIndex = lines.findIndex(line => line.startsWith(key))
  if (keyIndex === -1) {
    const block = [key, ...names.map(name => `${DEFAULT_LIST_INDENT}${yamlScalar(name)}: true`)]
    if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, ...block)
    else lines.push('', ...block)
    return
  }
  // Indentation guard: only lines strictly more indented than the key line
  // belong to this block. Without it, a following top-level key (or a block
  // appended later in this pass) would match the entry pattern and the
  // splice would corrupt the file with entries inside the wrong block —
  // invalid YAML pnpm refuses and ensure does not self-heal.
  const blockIndent = lines[keyIndex]!.length - lines[keyIndex]!.trimStart().length
  const existing: string[] = []
  let entryIndent = DEFAULT_LIST_INDENT
  let lastEntryIndex = keyIndex
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim().length > 0) {
      const indent = line.length - line.trimStart().length
      if (indent <= blockIndent) break
    }
    const match = MAP_ENTRY_PATTERN.exec(line)
    if (match === null) continue
    const name = listItemName(match[2] ?? '')
    if (name.length > 0) existing.push(name)
    if (lastEntryIndex === keyIndex) entryIndent = match[1] ?? DEFAULT_LIST_INDENT
    lastEntryIndex = index
  }
  const missing = names.filter(name => !existing.includes(name))
  if (missing.length > 0) {
    lines.splice(lastEntryIndex + 1, 0, ...missing.map(name => `${entryIndent}${yamlScalar(name)}: true`))
  }
}

/** Ensure a `strictDepBuilds: false` line exists so unknown builds warn instead of failing. */
function ensureLenientStrictDepBuilds(lines: string[]): void {
  if (lines.some(line => line.startsWith(STRICT_DEP_BUILDS_KEY))) return
  if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, STRICT_DEP_BUILDS_KEY, '  false')
  else lines.push('', STRICT_DEP_BUILDS_KEY, '  false')
}

/**
 * Merge Desktop's approved build dependencies into pnpm-workspace.yaml text.
 * Deliberately minimal text processing (no YAML dependency): maintains BOTH
 * pnpm spellings (`onlyBuiltDependencies` list for ≤11.22 and the
 * `allowBuilds` map for ≥11.23, which deletes the legacy key on write) plus
 * the transitional `strictDepBuilds: false` so an unlisted build dependency
 * warns instead of failing the install. `names` is the validated union of
 * the built-in triple and (when a signed entry supplied one) its
 * `approvedBuilds` list.
 */
function withDesktopApprovedBuilds(content: string, names: readonly string[]): string {
  const lines = content.split('\n')
  mergeListBlock(lines, ONLY_BUILT_DEPENDENCIES_KEY, names)
  mergeMapBlock(lines, ALLOW_BUILDS_KEY, names)
  ensureLenientStrictDepBuilds(lines)
  return lines.join('\n')
}

/**
 * Ensure the profile's pnpm-workspace.yaml pre-approves Desktop's trusted
 * dependency build scripts, creating the file from the upstream template
 * when absent. Idempotent: an already-approved workspace is not rewritten,
 * and every other key keeps its bytes.
 * @param profileDir - the profile directory, as resolved by upstream `resolveProfileDir`.
 * @param options - optional extra approved names (the signed entry's `approvedBuilds`), unioned after the built-in triple; never read from the manifest here.
 */
export function ensureProfilePnpmBuildApproval(
  profileDir: string,
  options: ProfilePnpmBuildApprovalOptions = {},
): void {
  const approved = approvedBuildList(options.approvedBuildDependencies)
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  const current = existsSync(workspacePath)
    ? readFileSync(workspacePath, 'utf8')
    : TEMPLATE_PNPM_WORKSPACE
  const updated = withDesktopApprovedBuilds(current, approved)
  if (updated === current) return
  mkdirSync(profileDir, { recursive: true })
  // Write through a sibling temporary file and rename it into place: a crash
  // mid-write can never leave a truncated pnpm-workspace.yaml behind, which
  // pnpm would refuse on every later plugin operation. Node's same-directory
  // rename is atomic on every supported platform.
  const temporaryPath = `${workspacePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, updated)
    renameSync(temporaryPath, workspacePath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}
