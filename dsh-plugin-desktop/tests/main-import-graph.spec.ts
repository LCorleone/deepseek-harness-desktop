/**
 * Main-process import-graph guard (2026-09-08, the #65 boot crash).
 *
 * The packaged main bundle crashed at boot with `The requested module
 * 'electron' does not provide an export named 'contextBridge'`: a main-side
 * module had imported a PRELOAD module (for a channel constant), pulling
 * preload-only electron exports into the main graph. Unit mocks mask this
 * forever — only an import-graph assertion catches it before packaging.
 *
 * Rule: a `*-preload.ts` module may be imported ONLY by itself, its renderer
 * document, and the tsdown entry list. Any main/src import of one is a bug.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(PKG, 'src')

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, files)
    else if (name.endsWith('.ts')) files.push(full)
  }
  return files
}

const PRELOAD_MODULES = derivePreloadModules()

/** Derive the preload-module list from the tsdown entry map itself — a
 * hand-copied list would go blind exactly when a new preload is added
 * (review P2: the guard's single point of failure). */
function derivePreloadModules(): string[] {
  const text = readFileSync(join(PKG, 'tsdown.config.ts'), 'utf8')
  const names: string[] = []
  for (const match of text.matchAll(/'([^']*-preload)\.ts'/gu)) {
    names.push(`${match[1]}.ts`)
  }
  if (names.length === 0) throw new Error('main-import-graph guard: no preload entries found in tsdown.config.ts — the derivation is broken')
  return names
}

describe('main-process import graph excludes preload modules', () => {
  it('no src module outside a preload itself imports a *-preload.ts', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (PRELOAD_MODULES.some(name => file.endsWith(`/${name}`))) continue
      const text = readFileSync(file, 'utf8')
      for (const name of PRELOAD_MODULES) {
        const spec = `./${name}`
        if (text.includes(spec)) offenders.push(`${file} imports ${spec}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
