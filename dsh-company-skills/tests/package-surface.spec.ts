/**
 * Package-surface guard (P6 batch 4).
 *
 * The published tarball ships the *encrypted* bundle only: the collected
 * plaintext under `skills/` is a build input, never package content. The
 * `files` whitelist alone does not achieve that — npm/yarn packers always
 * include files named `README*` / `LICENSE*` in any directory, so the two
 * README files under `skills/` rode along until an explicit negation was
 * added (spotted while packing the first release, 2026-09-11). This test
 * pins the negation so the leak cannot come back unnoticed.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  files: string[]
}

describe('company-skills package surface', () => {
  it('ships the encrypted bundle as its only skill payload', () => {
    expect(manifest.files).toContain('assets/skills.bundle')
  })

  it('excludes the collected plaintext from the tarball', () => {
    // A whitelist entry for skills/** would ship every plaintext source file;
    // the always-included README files ship regardless unless negated.
    expect(manifest.files.some(entry => entry.startsWith('!') && entry.includes('skills'))).toBe(true)
    expect(manifest.files).not.toContain('skills/**')
  })
})
