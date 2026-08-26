/** Desktop-managed pnpm build-script approval for plugin profiles. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Dependency build scripts Desktop pre-approves in every profile workspace.
 * pnpm ≥10 refuses to run a dependency's install/preinstall/postinstall
 * script unless its package name is listed under `onlyBuiltDependencies` in
 * pnpm-workspace.yaml, and pnpm 11 turns "build scripts were ignored" into a
 * nonzero exit that fails the entire `dsh plugin add` (the upstream profile
 * template cannot ship such a list). node-pty ships prebuilds its install
 * script merely copies (the terminal panel depends on it), and
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
const DEFAULT_LIST_INDENT = '  '
const LIST_ITEM_PATTERN = /^(\s*)-\s*(.*?)\s*(?:#.*)?$/u

/** Strip YAML quoting and trailing comments from one list-item token. */
function listItemName(item: string): string {
  const stripped = item.replace(/\s+#.*$/u, '').trim()
  const quoted = /^(['"])(.*)\1$/u.exec(stripped)
  return quoted?.[2] ?? stripped
}

/**
 * Merge Desktop's approved build dependencies into pnpm-workspace.yaml text.
 * Deliberately minimal text processing (no YAML dependency): a top-level
 * `onlyBuiltDependencies` block gains the missing entries in place, a
 * flow-style inline list is expanded to block form, and a file without the
 * key gets the block appended after its existing keys.
 */
function withDesktopApprovedBuilds(content: string): string {
  const lines = content.split('\n')
  const keyIndex = lines.findIndex(line => line.startsWith(ONLY_BUILT_DEPENDENCIES_KEY))
  if (keyIndex === -1) {
    const block = [
      ONLY_BUILT_DEPENDENCIES_KEY,
      ...DESKTOP_APPROVED_BUILD_DEPENDENCIES.map(name => `${DEFAULT_LIST_INDENT}- ${name}`),
    ]
    return lines.at(-1) === ''
      ? [...lines.slice(0, -1), ...block, ''].join('\n')
      : [...lines, '', ...block].join('\n')
  }
  const inline = lines[keyIndex]!.slice(ONLY_BUILT_DEPENDENCIES_KEY.length).trim()
  const inlineValue = inline.startsWith('#') ? '' : inline.replace(/\s+#.*$/u, '').trim()
  const existing: string[] = []
  let itemIndent = DEFAULT_LIST_INDENT
  let lastItemIndex = keyIndex
  if (inlineValue.length > 0) {
    for (const token of inlineValue.replace(/^\[/u, '').replace(/\]$/u, '').split(',')) {
      const name = listItemName(token)
      if (name.length > 0) existing.push(name)
    }
  } else {
    for (let index = keyIndex + 1; index < lines.length; index += 1) {
      const match = LIST_ITEM_PATTERN.exec(lines[index]!)
      if (match === null) break
      const name = listItemName(match[2] ?? '')
      if (name.length > 0) existing.push(name)
      if (lastItemIndex === keyIndex) itemIndent = match[1] ?? DEFAULT_LIST_INDENT
      lastItemIndex = index
    }
  }
  const missing = DESKTOP_APPROVED_BUILD_DEPENDENCIES.filter(name => !existing.includes(name))
  if (missing.length === 0) return content
  if (inlineValue.length > 0) {
    lines.splice(keyIndex, 1, ONLY_BUILT_DEPENDENCIES_KEY,
      ...[...existing, ...missing].map(name => `${itemIndent}- ${name}`))
    return lines.join('\n')
  }
  lines.splice(
    lastItemIndex + 1,
    0,
    ...missing.map(name => `${itemIndent}- ${name}`),
  )
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
  writeFileSync(workspacePath, updated)
}
