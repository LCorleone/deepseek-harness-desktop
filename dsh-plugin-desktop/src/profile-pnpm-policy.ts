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
 * across pnpm generations: ≤11.22 reads `onlyBuiltDependencies` (a name
 * list) while ≥11.23 reads `allowBuilds` (a name→boolean map) and actively
 * deletes the legacy key, so Desktop maintains BOTH spellings; pnpm keeps
 * the one it knows and ignores the other. node-pty ships prebuilds its
 * install script merely copies (the terminal panel depends on it), and
 * esbuild/protobufjs are the two most common harmless build-time
 * dependencies — approving these keeps ordinary plugin installs from
 * derailing on pnpm's build firewall.
 */
const DESKTOP_APPROVED_BUILD_DEPENDENCIES: readonly string[] = [
  'node-pty',
  'esbuild',
  'protobufjs',
]

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
    const block = [key, ...names.map(name => `${DEFAULT_LIST_INDENT}- ${name}`)]
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
    lines.splice(keyIndex, 1, key, ...merged.map(name => `${DEFAULT_LIST_INDENT}- ${name}`))
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
    lines.splice(lastItemIndex + 1, 0, ...missing.map(name => `${itemIndent}- ${name}`))
  }
}

/** Merge one block of `key:\n  name: true` map entries, appending missing names in place. */
function mergeMapBlock(lines: string[], key: string, names: readonly string[]): void {
  const keyIndex = lines.findIndex(line => line.startsWith(key))
  if (keyIndex === -1) {
    const block = [key, ...names.map(name => `${DEFAULT_LIST_INDENT}${name}: true`)]
    if (lines.at(-1) === '') lines.splice(lines.length - 1, 0, ...block)
    else lines.push('', ...block)
    return
  }
  const existing: string[] = []
  let entryIndent = DEFAULT_LIST_INDENT
  let lastEntryIndex = keyIndex
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const match = MAP_ENTRY_PATTERN.exec(lines[index]!)
    if (match === null) break
    const name = listItemName(match[2] ?? '')
    if (name.length > 0) existing.push(name)
    if (lastEntryIndex === keyIndex) entryIndent = match[1] ?? DEFAULT_LIST_INDENT
    lastEntryIndex = index
  }
  const missing = names.filter(name => !existing.includes(name))
  if (missing.length > 0) {
    lines.splice(lastEntryIndex + 1, 0, ...missing.map(name => `${entryIndent}${name}: true`))
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
 * warns instead of failing the install.
 */
function withDesktopApprovedBuilds(content: string): string {
  const lines = content.split('\n')
  mergeListBlock(lines, ONLY_BUILT_DEPENDENCIES_KEY, DESKTOP_APPROVED_BUILD_DEPENDENCIES)
  mergeMapBlock(lines, ALLOW_BUILDS_KEY, DESKTOP_APPROVED_BUILD_DEPENDENCIES)
  ensureLenientStrictDepBuilds(lines)
  return lines.join('\n')
}

/**
 * Ensure the profile's pnpm-workspace.yaml pre-approves Desktop's trusted
 * dependency build scripts, creating the file from the upstream template
 * when absent. Idempotent: an already-approved workspace is not rewritten,
 * and every other key keeps its bytes.
 * @param profileDir - the profile directory, as resolved by upstream `resolveProfileDir`.
 */
export function ensureProfilePnpmBuildApproval(profileDir: string): void {
  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  const current = existsSync(workspacePath)
    ? readFileSync(workspacePath, 'utf8')
    : TEMPLATE_PNPM_WORKSPACE
  const updated = withDesktopApprovedBuilds(current)
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
