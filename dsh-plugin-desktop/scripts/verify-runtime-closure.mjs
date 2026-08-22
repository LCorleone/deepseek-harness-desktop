import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import { loadInstalledPackage, verifyRuntimeClosure } from './runtime-closure.mjs'

const manifestPath = resolve(import.meta.dirname, '../package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const result = await verifyRuntimeClosure(manifest, loadInstalledPackage, manifestPath)

if (result.failures.length > 0) {
  console.error('verify-runtime-closure: required first-party peers are missing from dsh-plugin-desktop dependencies:')
  for (const failure of result.failures) console.error(`  ${failure}`)
  process.exit(1)
}

// Process-model closure (P3-1): every package-manager and CLI child runs the
// bundled Node distribution, so the Electron-only node-mode marker must not
// appear in production source. Tests and build scripts keep their defensive
// references; only the shipped `src/` tree is scanned.
const forbiddenMarker = 'ELECTRON_RUN_AS_NODE'
const sourceRoot = resolve(import.meta.dirname, '../src')
const offenders = []
for (const entry of await readdir(sourceRoot, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
  const filename = resolve(entry.parentPath, entry.name)
  const contents = await readFile(filename, 'utf8')
  if (contents.includes(forbiddenMarker)) offenders.push(relative(sourceRoot, filename))
}
if (offenders.length > 0) {
  console.error(`verify-runtime-closure: ${forbiddenMarker} must not appear in production source:`)
  for (const offender of offenders) console.error(`  src/${offender}`)
  process.exit(1)
}

console.log(`verify-runtime-closure: ${result.packageCount} first-party nodes form a closed reachable runtime graph.`)
