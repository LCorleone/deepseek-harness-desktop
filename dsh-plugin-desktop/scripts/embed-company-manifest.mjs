/** Embed one company catalog manifest into `lib/` as a build-time asset. */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// Source candidates, first hit wins: an explicit path (company publishing),
// the repository-root pipeline output, or a checked-in sample manifest that
// keeps local release builds reproducible without publishing secrets.
const requested = process.argv[2]
const candidates = requested !== undefined
  ? [requested]
  : [
      join(packageRoot, '..', 'tools', 'company-catalog', 'out', 'catalog-manifest.json'),
      join(packageRoot, 'assets', 'company-market', 'catalog-manifest.json'),
    ]

const source = candidates.find(path => existsSync(path))
if (source === undefined) {
  throw new Error(
    `dsh-plugin-desktop: no company catalog manifest found (tried ${candidates.join(', ')}); pass one explicitly or run tools/company-catalog first`,
  )
}

const targetDirectory = join(packageRoot, 'lib', 'company-market')
mkdirSync(targetDirectory, { recursive: true })
copyFileSync(source, join(targetDirectory, 'catalog-manifest.json'))
console.log(`dsh-plugin-desktop: embedded the company catalog manifest from ${source} at lib/company-market/catalog-manifest.json`)
