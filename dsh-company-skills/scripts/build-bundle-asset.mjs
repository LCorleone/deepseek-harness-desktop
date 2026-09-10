#!/usr/bin/env node
/**
 * Generate (or verify) `assets/skills.bundle` — the one obfuscated block the
 * plugin ships.
 *
 *   node scripts/build-bundle-asset.mjs            # write the asset
 *   node scripts/build-bundle-asset.mjs --check    # fail if it is stale
 *
 * This is the author-side assembly step of P6 batch 2. It does not implement
 * the container at all: it runs the batch-1.5 packer over the `fixtures/`
 * skills root — the same command a human would type
 *
 *   node tools/company-skills/pack.mjs --skills dsh-company-skills/fixtures --out assets/skills.bundle
 *
 * so the *writer* stays in one place (`tools/company-skills`) and this package
 * owns only the reader. `--check` re-packs into a temporary file and compares
 * bytes, which is what CI runs: no key material is involved, the packer has no
 * timestamps, and the container encoder sorts by name, so an unchanged fixture
 * tree re-produces byte-identical bytes.
 *
 * The packer deliberately stays a dev-time dependency: the shipped plugin
 * imports nothing outside its own `src/`, and every plaintext source under
 * `fixtures/` is excluded from the package `files` whitelist.
 *
 * @module dsh-company-skills/scripts/build-bundle-asset
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(PACKAGE_ROOT)
const PACKER = join(REPO_ROOT, 'tools', 'company-skills', 'pack.mjs')
const FIXTURES_DIR = join(PACKAGE_ROOT, 'fixtures')
export const ASSET_PATH = join(PACKAGE_ROOT, 'assets', 'skills.bundle')

/**
 * Run the batch-1.5 packer over the fixture skills root.
 * @param destination - artifact path the packer writes.
 * @returns the artifact text.
 */
export function packSkillsRoot(destination) {
  execFileSync(process.execPath, [PACKER, '--skills', FIXTURES_DIR, '--out', destination], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return readFileSync(destination, 'utf8')
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const unknown = args.filter((argument) => argument !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`build-bundle-asset: unknown argument "${unknown[0]}"\n`)
    process.exit(1)
  }

  if (!check) {
    const text = packSkillsRoot(ASSET_PATH)
    process.stdout.write(`build-bundle-asset: wrote assets/skills.bundle (${String(text.length)} bytes) from fixtures/\n`)
    return
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-company-skills-asset-'))
  try {
    const expected = packSkillsRoot(join(scratch, 'skills.bundle'))
    if (readFileSync(ASSET_PATH, 'utf8') !== expected) {
      process.stderr.write(
        'build-bundle-asset: assets/skills.bundle is stale — run `node scripts/build-bundle-asset.mjs` '
        + 'and commit the result\n',
      )
      process.exit(1)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  process.stdout.write('build-bundle-asset: assets/skills.bundle matches fixtures/\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
