/** Embed one desktop policy variant into `lib/` as a build-time asset. */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Available policy variants. `release` is the default so that any packaging
 * path which forgets to select a variant still ships the locked posture.
 */
const VARIANTS = Object.freeze({
  dev: {
    source: 'desktop-policy.dev.json',
    locked: false,
    managedModels: false,
    pluginResetOnVersionChange: false,
    requireSso: false,
    usageReport: false,
  },
  release: {
    source: 'desktop-policy.release.json',
    locked: true,
    managedModels: true,
    // P14 发版纪律（2026-09-09 定稿）：此值为【按构建翻转】——仅载 DSH 底座升级
    // （或需强制插件换血）的那一版构建翻 true（改本表 + 改 policy 文件，两处一致），
    // 其余构建保持 false（产品版本号变化才换新）。改这里=有意识的发布动作。
    pluginResetOnVersionChange: false,
    requireSso: true,
    usageReport: true,
  },
})

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const requested = process.argv[2] ?? 'release'
const variant = VARIANTS[requested]
if (variant === undefined) {
  throw new Error(
    `dsh-plugin-desktop: unknown desktop policy variant '${requested}'; expected ${
      Object.keys(VARIANTS).join(' or ')
    }`,
  )
}

const sourcePath = join(packageRoot, 'src', 'policy', variant.source)
const document = JSON.parse(readFileSync(sourcePath, 'utf8'))
if (document.locked !== variant.locked) {
  throw new Error(
    `dsh-plugin-desktop: ${requested} desktop policy must have locked=${String(variant.locked)}`,
  )
}
if (document.managedModels !== variant.managedModels) {
  throw new Error(
    `dsh-plugin-desktop: ${requested} desktop policy must have managedModels=${String(variant.managedModels)}`,
  )
}
if (document.requireSso !== variant.requireSso) {
  throw new Error(
    `dsh-plugin-desktop: ${requested} desktop policy must have requireSso=${String(variant.requireSso)}`,
  )
}
if (document.usageReport !== variant.usageReport) {
  throw new Error(
    `dsh-plugin-desktop: ${requested} desktop policy must have usageReport=${String(variant.usageReport)}`,
  )
}
if (document.pluginResetOnVersionChange !== variant.pluginResetOnVersionChange) {
  throw new Error(
    `dsh-plugin-desktop: ${requested} desktop policy must have pluginResetOnVersionChange=${String(variant.pluginResetOnVersionChange)}`,
  )
}

const targetDirectory = join(packageRoot, 'lib', 'policy')
mkdirSync(targetDirectory, { recursive: true })
copyFileSync(sourcePath, join(targetDirectory, 'desktop-policy.json'))
console.log(
  `dsh-plugin-desktop: embedded the ${requested} desktop policy (locked=${String(variant.locked)}, managedModels=${String(variant.managedModels)}, requireSso=${String(variant.requireSso)}, usageReport=${String(variant.usageReport)}, pluginResetOnVersionChange=${String(variant.pluginResetOnVersionChange)}) at lib/policy/desktop-policy.json`,
)
