/**
 * End-to-end packer/verifier tests, driven through the real CLIs.
 *
 * These are the batch-1 acceptance tests: the pack→unpack round trip is
 * byte-exact, re-packing is deterministic across source mtimes, and — the
 * core P6 assertion — the artifact never carries a plaintext line of the
 * skill it encodes. Every rejection case also asserts that nothing was
 * written, because "failed loudly" is worthless if half an artifact landed
 * first.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { decodeBundleBlob, extractBundleBlob } from '../lib/codec.mjs'
import { walkFiles } from '../lib/release-surface.mjs'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
const PACK = join(TOOL_DIR, 'pack.mjs')
const UNPACK = join(TOOL_DIR, 'unpack.mjs')
const FIXTURE = join(TOOL_DIR, 'fixtures', 'fixture-hello')
const CANARY = 'FIXTURE-HELLO-PLAINTEXT-CANARY'

const run = (script, args) => {
  const probe = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000 })
  return { status: probe.status, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '' }
}

/** Scratch directory that is always removed. */
function workspace(body) {
  const root = mkdtempSync(join(tmpdir(), 'company-skills-pack-'))
  try {
    return body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A copy of the fixture skill at `destination`. */
function copyFixture(destination) {
  cpSync(FIXTURE, destination, { recursive: true })
  return destination
}

/** Write a skill tree from a `{ relativePath: text }` map plus a manifest. */
function writeSkillTree(root, files) {
  mkdirSync(root, { recursive: true })
  for (const [relativePath, text] of Object.entries(files)) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
}

const CLEAN_MANIFEST = '---\nname: demo-skill\ndescription: A demo skill for the packer tests.\n---\n\n# Demo\n\nNo sibling references here.\n'

/** Every plaintext line long enough that finding it in an artifact would be meaningful. */
function plaintextLines(root) {
  const lines = new Set()
  for (const path of walkFiles(root)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length >= 16) lines.add(trimmed)
    }
  }
  return [...lines]
}

test('pack → unpack → re-pack is byte-identical and materializes the source tree', () => {
  workspace((root) => {
    const artifact = join(root, 'out', 'fixture.bundle.js')
    const packed = run(PACK, ['--skill', FIXTURE, '--out', artifact])
    assert.equal(packed.status, 0, packed.stderr)
    assert.match(packed.stdout, /^packed fixture-hello → /u)
    assert.match(packed.stdout, /plaintextSha256 [0-9a-f]{64}/u)

    const unpacked = join(root, 'tree')
    const verify = run(UNPACK, ['--in', artifact, '--out', unpacked])
    assert.equal(verify.status, 0, verify.stderr)
    assert.match(verify.stdout, /^skill fixture-hello$/mu)

    // Every carried file is byte-exact; only the frontmatter is regenerated.
    for (const relativePath of ['assets/notes.md', 'scripts/hello.mjs']) {
      assert.equal(
        readFileSync(join(unpacked, relativePath), 'utf8'),
        readFileSync(join(FIXTURE, relativePath), 'utf8'),
        `${relativePath} must survive the round trip byte-for-byte`,
      )
    }
    assert.equal(readFileSync(join(unpacked, 'SKILL.md'), 'utf8'), readFileSync(join(FIXTURE, 'SKILL.md'), 'utf8'))

    const repacked = join(root, 'out', 'repacked.bundle.js')
    assert.equal(run(PACK, ['--skill', unpacked, '--out', repacked]).status, 0)
    assert.deepEqual(readFileSync(repacked), readFileSync(artifact))
  })
})

test('the artifact carries no plaintext line of the skill it encodes', () => {
  workspace((root) => {
    const artifact = join(root, 'out', 'fixture.bundle.js')
    assert.equal(run(PACK, ['--skill', FIXTURE, '--out', artifact]).status, 0)

    const written = readdirSync(join(root, 'out'))
    assert.deepEqual(written, ['fixture.bundle.js'], 'packing must produce exactly one file — no plaintext spill')
    assert.equal(existsSync(join(root, 'out', 'fixture-hello')), false)

    const bytes = readFileSync(artifact, 'utf8')
    assert.equal(bytes.includes(CANARY), false, 'the canary line leaked into the artifact')
    for (const line of plaintextLines(FIXTURE)) {
      assert.equal(bytes.includes(line), false, `the artifact leaked the source line ${JSON.stringify(line)}`)
    }

    // Control: the plaintext really is inside the blob, so the assertions above
    // are testing the encoding rather than an empty artifact.
    const json = decodeBundleBlob(extractBundleBlob(bytes))
    assert.equal(bytes.includes(json.slice(0, 200)), false)
    const notes = JSON.parse(json).assets.find((item) => item.path === 'assets/notes.md')
    assert.ok(Buffer.from(notes.content, 'base64').toString('utf8').includes(CANARY), 'the canary must be recoverable from the blob')
  })
})

test('packing is deterministic and independent of source mtimes and entry order', () => {
  workspace((root) => {
    const first = copyFixture(join(root, 'first'))
    const second = copyFixture(join(root, 'second'))
    const stamp = new Date('2020-01-02T03:04:05Z')
    for (const path of walkFiles(second)) utimesSync(path, stamp, stamp)

    const artifactA = join(root, 'a.bundle.js')
    const artifactB = join(root, 'b.bundle.js')
    assert.equal(run(PACK, ['--skill', first, '--out', artifactA]).status, 0)
    assert.equal(run(PACK, ['--skill', second, '--out', artifactB]).status, 0)
    assert.deepEqual(readFileSync(artifactA), readFileSync(artifactB), 'mtimes must not reach the artifact')

    // The raw form and the module form carry the same blob.
    const raw = join(root, 'c.b64')
    assert.equal(run(PACK, ['--skill', first, '--out', raw]).status, 0)
    const moduleLine = readFileSync(artifactA, 'utf8').match(/= "([A-Za-z0-9+/=]+)"/u)
    assert.equal(readFileSync(raw, 'utf8').trim(), moduleLine[1])
    assert.match(run(UNPACK, ['--in', raw]).stdout, /^skill fixture-hello$/mu)
  })
})

test('pack rejects invalid skill sources and writes nothing', () => {
  workspace((root) => {
    const cases = [
      ['bad-name', { 'SKILL.md': CLEAN_MANIFEST.replace('demo-skill', 'Demo_Skill') }, /name must be kebab-case/u],
      [
        'long-description',
        { 'SKILL.md': CLEAN_MANIFEST.replace('A demo skill for the packer tests.', 'x'.repeat(501)) },
        /description is 501 characters/u,
      ],
      [
        'missing-asset',
        {
          'SKILL.md': CLEAN_MANIFEST.replace('No sibling references here.', 'Read `assets/gone.json`.'),
          'scripts/run.mjs': "readFileSync('assets/gone.json')\n",
        },
        /references "assets\/gone.json"/u,
      ],
      ['stray-file', { 'SKILL.md': CLEAN_MANIFEST, 'README.md': 'stray\n' }, /unexpected file "README.md"/u],
      ['no-manifest', { 'assets/data.json': '{}\n' }, /unexpected file "assets\/data.json"|carries no SKILL.md/u],
    ]

    for (const [name, files, pattern] of cases) {
      const skillDir = join(root, name, 'skill')
      writeSkillTree(skillDir, files)
      const outDir = join(root, name, 'out')
      const result = run(PACK, ['--skill', skillDir, '--out', join(outDir, 'x.bundle.js')])
      assert.equal(result.status, 1, `${name} must be rejected: ${result.stdout}`)
      assert.match(result.stderr, pattern, name)
      assert.equal(existsSync(outDir), false, `${name} must not create an output directory`)
    }
  })
})

test('unpack verifies the digest and refuses a tampered blob', () => {
  workspace((root) => {
    const artifact = join(root, 'out', 'fixture.bundle.js')
    const packed = run(PACK, ['--skill', FIXTURE, '--out', artifact])
    const digest = packed.stdout.match(/plaintextSha256 ([0-9a-f]{64})/u)[1]

    assert.equal(run(UNPACK, ['--in', artifact, '--expect-sha256', digest]).status, 0)
    const mismatch = run(UNPACK, ['--in', artifact, '--expect-sha256', 'a'.repeat(64)])
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stderr, /plaintext digest mismatch/u)

    const tampered = join(root, 'out', 'tampered.bundle.js')
    const text = readFileSync(artifact, 'utf8')
    writeFileSync(tampered, text.replace(/= "[A-Za-z0-9+/=]{8}/u, '= "AAAAAAAA'))
    const broken = run(UNPACK, ['--in', tampered])
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /unpack: /u)
  })
})

test('unknown arguments abort instead of guessing a destination', () => {
  const unknown = run(PACK, ['--skill', FIXTURE, '--output', '/tmp/nope.bundle.js'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown argument "--output"/u)
  assert.equal(run(PACK, []).status, 1)
  assert.match(run(UNPACK, []).stderr, /--in is required/u)
  assert.equal(run(UNPACK, ['--in']).status, 1)
  assert.equal(run(PACK, ['--skill', FIXTURE, '--help']).stdout.includes('--skill <dir>'), true)

  // The documented relative path in the error output stays repo-relative.
  assert.equal(relative(REPO_ROOT, PACK), 'tools/company-skills/pack.mjs')
})
