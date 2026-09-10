/**
 * The unpack release-surface guard.
 *
 * `unpack.mjs` is the only tool here that turns a blob back into plaintext,
 * so it is the one file that must never reach a shipped artifact. The guard
 * under test walks every `package.json` in the repository, resolves what its
 * `files`/`bin`/`main` entries would publish, and fails when any `unpack.mjs`
 * would ride along; a second rule rejects the layout mistake that makes the
 * first rule possible (an `unpack.mjs` sharing a directory with a
 * `package.json`). The walk deliberately descends into build-output directory
 * names (`lib`, `dist`, `out`, `.build`), because this repository's real
 * plugin tarballs publish `lib/**`.
 *
 * The red cases run against throwaway fixture repositories, so the mutation
 * this test exists to catch — adding `unpack.mjs` to a plugin `files`
 * whitelist — is covered permanently in the suite rather than only in a
 * one-off drill.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  FORBIDDEN_ARTIFACT_BASENAME,
  filesEntryMatcher,
  findUnpackPublishViolations,
  walkFiles,
} from '../lib/release-surface.mjs'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
const PACK = join(TOOL_DIR, 'pack.mjs')
const UNPACK = join(TOOL_DIR, 'unpack.mjs')
const FIXTURE = join(TOOL_DIR, 'fixtures', 'fixture-hello')

/** Scratch fixture repository; always removed. */
function fixtureRepo(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'company-skills-guard-'))
  try {
    for (const [relativePath, text] of Object.entries(files)) {
      const target = join(root, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
    return body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const manifest = (extra) => `${JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.js', ...extra }, null, 2)}\n`
const byKind = (violations, kind) => violations.filter((violation) => violation.kind === kind)

test('the real repository publishes no unpack.mjs', () => {
  assert.deepEqual(findUnpackPublishViolations(REPO_ROOT), [])
  // The layout rule that makes the guard possible: the tools tree is not a package.
  assert.equal(walkFiles(TOOL_DIR).some((path) => path === join(TOOL_DIR, 'package.json')), false)
})

test('the verifier itself carries the never-ship banner', () => {
  const source = readFileSync(UNPACK, 'utf8')
  assert.match(source, /⚠ THIS SCRIPT MUST NEVER SHIP\./u)
  assert.match(source, /refuses to start when its own directory carries/u)
  assert.match(readFileSync(join(TOOL_DIR, 'pack.mjs'), 'utf8'), /not wired into any CI/u)
})

test('a files whitelist that names unpack.mjs is a violation', () => {
  fixtureRepo({ 'pkg/package.json': manifest({ files: ['index.js', 'unpack.mjs'] }), 'pkg/index.js': '', 'pkg/unpack.mjs': '' }, (root) => {
    const violations = byKind(findUnpackPublishViolations(root), 'files')
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'pkg/package.json')
    assert.match(violations[0].detail, /would ship unpack\.mjs/u)
  })
})

test('build-output directory names are walked, so a package lib/unpack.mjs is visible', () => {
  // The real plugin tarballs publish `lib/**`; pruning that directory name
  // made the guard blind to the most plausible leak site.
  fixtureRepo(
    {
      'lib/unpack.mjs': '',
      'dist/unpack.mjs': '',
      'out/unpack.mjs': '',
      '.build/unpack.mjs': '',
      'node_modules/unpack.mjs': '',
    },
    (root) => {
      const seen = walkFiles(root).map((path) => relative(root, path).split('\\').join('/')).sort()
      assert.deepEqual(seen, ['.build/unpack.mjs', 'dist/unpack.mjs', 'lib/unpack.mjs', 'out/unpack.mjs'])
    },
  )
  fixtureRepo({ 'pkg/package.json': manifest({ files: ['lib/**'] }), 'pkg/lib/index.js': '', 'pkg/lib/unpack.mjs': '' }, (root) => {
    const violations = byKind(findUnpackPublishViolations(root), 'files')
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'pkg/package.json')
    assert.match(violations[0].detail, /"lib\/\*\*" would ship lib\/unpack\.mjs/u)
  })
})

test('a main entry that points at unpack.mjs is a violation', () => {
  fixtureRepo({ 'pkg/package.json': manifest({ main: 'tools/unpack.mjs' }), 'pkg/tools/unpack.mjs': '' }, (root) => {
    const violations = byKind(findUnpackPublishViolations(root), 'files')
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'pkg/package.json')
    assert.match(violations[0].detail, /"tools\/unpack\.mjs" would ship tools\/unpack\.mjs/u)
  })
})

test('a glob, a directory prefix, and a bin entry all sweep unpack.mjs in', () => {
  const cases = [
    ['glob', manifest({ files: ['*.mjs'] })],
    ['recursive glob', manifest({ files: ['**/*.mjs'] })],
    ['directory prefix', manifest({ files: ['tools'] })],
    ['bin', manifest({ bin: './unpack.mjs' })],
  ]
  for (const [label, packageJson] of cases) {
    const tree = label === 'directory prefix'
      ? { 'tools/unpack.mjs': '', 'package.json': packageJson }
      : { 'unpack.mjs': '', 'package.json': packageJson }
    fixtureRepo(tree, (root) => {
      assert.equal(byKind(findUnpackPublishViolations(root), 'files').length, 1, `${label} must be caught`)
    })
  }
})

test('a clean whitelist and an unrelated package are not violations', () => {
  fixtureRepo(
    {
      'package.json': manifest({ files: ['index.js', 'lib'] }),
      'index.js': '',
      'lib/index.js': '',
      'plugins/other/package.json': manifest({ files: ['unpacker.mjs'] }),
      'plugins/other/unpacker.mjs': '',
    },
    (root) => {
      assert.deepEqual(findUnpackPublishViolations(root), [])
    },
  )
})

test('an unpack.mjs sharing a directory with a package.json is a violation', () => {
  fixtureRepo({ 'package.json': manifest({ files: ['index.js'] }), 'index.js': '', 'unpack.mjs': '' }, (root) => {
    const violations = byKind(findUnpackPublishViolations(root), 'package-directory')
    assert.equal(violations.length, 1)
    assert.equal(violations[0].file, 'unpack.mjs')
    assert.match(violations[0].detail, /must not live in a directory that carries a package\.json/u)
  })
})

test('the files matcher implements npm include semantics', () => {
  assert.equal(filesEntryMatcher('unpack.mjs')('unpack.mjs'), true)
  assert.equal(filesEntryMatcher('./unpack.mjs')('unpack.mjs'), true)
  assert.equal(filesEntryMatcher('tools')('tools/unpack.mjs'), true)
  assert.equal(filesEntryMatcher('tools/')('tools/nested/unpack.mjs'), true)
  assert.equal(filesEntryMatcher('*.mjs')('unpack.mjs'), true)
  assert.equal(filesEntryMatcher('**/*.mjs')('nested/unpack.mjs'), true)
  assert.equal(filesEntryMatcher('*.js')('unpack.mjs'), false)
  assert.equal(filesEntryMatcher('lib')('unpack.mjs'), false)
  assert.equal(filesEntryMatcher('lib/*.mjs')('nested/unpack.mjs'), false)
  assert.equal(filesEntryMatcher('')('unpack.mjs'), false)
})

test('a packed artifact never mentions the verifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'company-skills-guard-pack-'))
  try {
    const artifact = join(root, 'fixture.bundle.js')
    const packed = spawnSync(process.execPath, [PACK, '--skill', FIXTURE, '--out', artifact], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000 })
    assert.equal(packed.status, 0, packed.stderr)
    const bytes = readFileSync(artifact, 'utf8')
    assert.equal(bytes.includes('unpack'), false, 'the shipped artifact must not reference the verifier')
    assert.equal(bytes.includes(FORBIDDEN_ARTIFACT_BASENAME), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
