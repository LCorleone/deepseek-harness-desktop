/** Embed one desktop policy variant into `lib/` as a build-time asset. */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Available policy variants. `release` is the default so that any packaging
 * path which forgets to select a variant still ships the locked posture.
 */
const VARIANTS = Object.freeze({
  dev: { source: 'desktop-policy.dev.json', locked: false, managedModels: false },
  release: { source: 'desktop-policy.release.json', locked: true, managedModels: true },
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

const targetDirectory = join(packageRoot, 'lib', 'policy')
mkdirSync(targetDirectory, { recursive: true })
copyFileSync(sourcePath, join(targetDirectory, 'desktop-policy.json'))
console.log(
  `dsh-plugin-desktop: embedded the ${requested} desktop policy (locked=${String(variant.locked)}, managedModels=${String(variant.managedModels)}) at lib/policy/desktop-policy.json`,
)
