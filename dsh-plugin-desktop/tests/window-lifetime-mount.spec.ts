/**
 * Mount-point proof (window-lifetime review P2): the guard module being
 * correct is worthless if main.ts stops calling it — exactly the
 * "module right, never attached" class the #66 gap belongs to. Mirrors the
 * `desktop-installer-quit.spec.ts` source-assertion pattern.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts')

describe('window-lifetime guard is actually mounted', () => {
  it('main.ts installs the guard right after app.whenReady and never disposes it', () => {
    const source = readFileSync(MAIN, 'utf8')
    const readyAt = source.indexOf('await app.whenReady()')
    expect(readyAt).toBeGreaterThan(-1)
    const mountAt = source.indexOf('installWindowLifetimeGuard(app)')
    expect(mountAt).toBeGreaterThan(readyAt)
    // Never disposed anywhere: a dispose would reintroduce the boot-gap quit.
    expect(source).toContain("import { installWindowLifetimeGuard } from './window-lifetime.ts'")
    expect(source.match(/installWindowLifetimeGuard\(/gu)).toHaveLength(1)
  })
})
