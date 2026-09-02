/** Embed the locked CLI clamp overlay into `lib/` as a build-time asset. */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(packageRoot, 'src', 'cli-lock', 'desktop-cli-lock.patch.yml')
const targetDirectory = join(packageRoot, 'lib', 'cli-lock')

// Face markers: the entry lines the clamp's runtime behavior and its tests
// depend on. A hand edit that drops or breaks a locked face fails the build
// here instead of first surfacing as an unlocked CLI child; the full
// loader-dialect validation (parse through `loadOverlayPatches`, patch
// structure, expression nodes) lives in tests/desktop-cli.spec.ts.
const text = readFileSync(sourcePath, 'utf8')
for (const marker of [
  '- id: sandbox-policy',
  'mode: workspace-write',
  'workspaceRoot: !!js process.cwd()',
  '- id: approval',
  'policy: ask',
  '- id: permission',
  'sandbox: read-only',
  'sandbox: workspace-write',
  '- id: agent-presets',
  'disabled: true',
  'default: deloitte-standard',
  'name: dsh-plugin-desktop/company-agent-presets',
  'trust: system',
  'path: !!js process.env.DSH_DESKTOP_LOCK_PRESET_ROOT',
]) {
  if (!text.includes(marker)) {
    throw new Error(`dsh-plugin-desktop: the CLI lock overlay no longer contains '${marker}'`)
  }
}
// The removed preset must stay removed: a table key would render exactly this
// line, while the explanatory prose around it never carries the colon.
if (text.includes('danger-full-access:')) {
  throw new Error('dsh-plugin-desktop: the CLI lock overlay must not ship a danger-full-access preset entry')
}

mkdirSync(targetDirectory, { recursive: true })
copyFileSync(sourcePath, join(targetDirectory, 'desktop-cli-lock.patch.yml'))
console.log('dsh-plugin-desktop: embedded the locked CLI clamp overlay at lib/cli-lock/desktop-cli-lock.patch.yml')
