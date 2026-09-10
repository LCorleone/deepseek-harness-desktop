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

/** A well-formed SKILL.md for one container member. */
const containerManifest = (name) => `---\nname: ${name}\ndescription: The ${name} fixture.\n---\n\n# ${name}\n\nNo sibling references here.\n`

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

test('an un-carried reference is a pack-time warning, not a rejection', () => {
  // Collected third-party skills mention example paths in prose
  // (skill-creator's guide is full of them), so a dangling `scripts/…`/
  // `assets/…` mention packs successfully and is reported on stderr.
  workspace((root) => {
    const skillDir = join(root, 'needy-skill')
    writeSkillTree(skillDir, {
      'SKILL.md': CLEAN_MANIFEST.replace('No sibling references here.', 'Read `assets/gone.json`.'),
      'scripts/run.mjs': "readFileSync('assets/gone.json')\n",
    })
    const outDir = join(root, 'out')
    const artifact = join(outDir, 'x.bundle.js')
    const result = run(PACK, ['--skill', skillDir, '--out', artifact])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /references "assets\/gone.json", which the bundle does not carry/u)
    assert.equal(existsSync(artifact), true, 'the artifact is written despite the lint')
    const verify = run(UNPACK, ['--in', artifact])
    assert.equal(verify.status, 0, verify.stderr)
    assert.match(verify.stdout, /^skill demo-skill$/mu)
  })
})

test('the packer prunes interpreter caches (__pycache__) wherever they appear', () => {
  workspace((root) => {
    const skillDir = join(root, 'cached-skill')
    writeSkillTree(skillDir, {
      'SKILL.md': CLEAN_MANIFEST,
      'scripts/run.py': 'print("ok")\n',
      'scripts/__pycache__/run.cpython-310.pyc': 'stale bytecode from another interpreter',
    })
    const artifact = join(root, 'out', 'cached.bundle.js')
    const packed = run(PACK, ['--skill', skillDir, '--out', artifact])
    assert.equal(packed.status, 0, packed.stderr)
    const document = JSON.parse(decodeBundleBlob(extractBundleBlob(readFileSync(artifact, 'utf8'))))
    assert.deepEqual(document.scripts.map((entry) => entry.path), ['scripts/run.py'], 'the cache must not ride along')

    const verify = run(UNPACK, ['--in', artifact, '--out', join(root, 'tree')])
    assert.equal(verify.status, 0, verify.stderr)
    assert.equal(existsSync(join(root, 'tree', 'scripts', '__pycache__')), false)
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

test('a three-skill container round-trips byte-identically and rebuilds every skill', () => {
  workspace((root) => {
    const skillsRoot = join(root, 'skills')
    const names = ['alpha-skill', 'beta-skill', 'gamma-skill']
    for (const name of names) {
      writeSkillTree(join(skillsRoot, name), {
        'SKILL.md': containerManifest(name),
        'assets/notes.md': `# ${name} notes\n`,
        'scripts/run.mjs': `// ${name}\n`,
      })
    }
    const artifact = join(root, 'out', 'company.bundle.js')
    const packed = run(PACK, ['--skills', skillsRoot, '--out', artifact])
    assert.equal(packed.status, 0, packed.stderr)
    assert.match(packed.stdout, /^packed container 3 skills → /u)
    assert.match(packed.stdout, /  skills 3  scripts 3  assets 3\n/u)
    const digest = packed.stdout.match(/plaintextSha256 ([0-9a-f]{64})/u)[1]

    const unpacked = join(root, 'tree')
    const verify = run(UNPACK, ['--in', artifact, '--out', unpacked, '--expect-sha256', digest])
    assert.equal(verify.status, 0, verify.stderr)
    assert.match(verify.stdout, /^unpacked container 3 skills → /mu)
    for (const name of names) {
      for (const relativePath of ['SKILL.md', 'assets/notes.md', 'scripts/run.mjs']) {
        assert.deepEqual(
          readFileSync(join(unpacked, name, relativePath)),
          readFileSync(join(skillsRoot, name, relativePath)),
          `${name}/${relativePath} must survive the round trip byte-for-byte`,
        )
      }
    }

    const repacked = join(root, 'out', 'repacked.bundle.js')
    assert.equal(run(PACK, ['--skills', unpacked, '--out', repacked]).status, 0)
    assert.deepEqual(readFileSync(repacked), readFileSync(artifact), 'a rebuilt tree must re-pack to the same bytes')
    const again = join(root, 'out', 'again.bundle.js')
    assert.equal(run(PACK, ['--skills', skillsRoot, '--out', again]).status, 0)
    assert.deepEqual(readFileSync(again), readFileSync(artifact), 're-packing unchanged sources must be identical')
  })
})

test('a container artifact carries no plaintext line from any skill', () => {
  workspace((root) => {
    const skillsRoot = join(root, 'skills')
    const names = ['alpha-skill', 'beta-skill', 'gamma-skill']
    for (const name of names) {
      writeSkillTree(join(skillsRoot, name), {
        'SKILL.md': `${containerManifest(name)}\n${name.toUpperCase()}-CONTAINER-CANARY\n`,
        'assets/notes.md': `${name.toUpperCase()}-CONTAINER-CANARY\n`,
      })
    }
    const artifact = join(root, 'out', 'company.bundle.js')
    assert.equal(run(PACK, ['--skills', skillsRoot, '--out', artifact]).status, 0)
    assert.deepEqual(readdirSync(join(root, 'out')), ['company.bundle.js'], 'packing must produce exactly one file')

    const bytes = readFileSync(artifact, 'utf8')
    for (const line of plaintextLines(skillsRoot)) {
      assert.equal(bytes.includes(line), false, `the artifact leaked ${JSON.stringify(line)}`)
    }
    for (const name of names) assert.equal(bytes.includes(`${name.toUpperCase()}-CONTAINER-CANARY`), false)

    // Control: every canary really is inside the blob, so the assertions above
    // test the encoding rather than an empty artifact.
    const document = JSON.parse(decodeBundleBlob(extractBundleBlob(bytes)))
    assert.deepEqual(Object.keys(document), ['version', 'skills'])
    for (const name of names) {
      const skill = document.skills.find((entry) => entry.name === name)
      const notes = skill.assets.find((entry) => entry.path === 'assets/notes.md')
      assert.ok(Buffer.from(notes.content, 'base64').toString('utf8').includes(`${name.toUpperCase()}-CONTAINER-CANARY`))
    }
  })
})

test('container packing rejects duplicate names, an empty root, a root file, and one bad member', () => {
  workspace((root) => {
    const duplicate = join(root, 'duplicate')
    writeSkillTree(join(duplicate, 'one'), { 'SKILL.md': containerManifest('same-skill') })
    writeSkillTree(join(duplicate, 'two'), { 'SKILL.md': containerManifest('same-skill') })
    const duplicateOut = join(root, 'duplicate-out')
    const duplicateRun = run(PACK, ['--skills', duplicate, '--out', join(duplicateOut, 'x.bundle.js')])
    assert.equal(duplicateRun.status, 1)
    assert.match(duplicateRun.stderr, /skill name "same-skill" is duplicated/u)
    assert.equal(existsSync(duplicateOut), false)

    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    const emptyOut = join(root, 'empty-out')
    const emptyRun = run(PACK, ['--skills', empty, '--out', join(emptyOut, 'x.bundle.js')])
    assert.equal(emptyRun.status, 1)
    assert.match(emptyRun.stderr, /carries no skill directories/u)
    assert.equal(existsSync(emptyOut), false)

    writeSkillTree(empty, { 'README.md': 'stray\n' })
    assert.equal(run(PACK, ['--skills', empty, '--out', join(root, 'stray-out', 'x.bundle.js')]).status, 1)
    assert.equal(existsSync(join(root, 'stray-out')), false)

    const mixed = join(root, 'mixed')
    writeSkillTree(join(mixed, 'good'), { 'SKILL.md': containerManifest('good-skill') })
    writeSkillTree(join(mixed, 'bad'), { 'SKILL.md': containerManifest('bad-skill').replace('bad-skill', 'Bad_Skill') })
    const mixedRun = run(PACK, ['--skills', mixed, '--out', join(root, 'mixed-out', 'x.bundle.js')])
    assert.equal(mixedRun.status, 1)
    assert.match(mixedRun.stderr, /name must be kebab-case/u)
    assert.equal(existsSync(join(root, 'mixed-out')), false)
  })
})

test('a container member with un-carried references packs with warnings', () => {
  workspace((root) => {
    const dangling = join(root, 'dangling')
    writeSkillTree(join(dangling, 'good-skill'), { 'SKILL.md': containerManifest('good-skill') })
    writeSkillTree(join(dangling, 'needy-skill'), {
      'SKILL.md': containerManifest('needy-skill').replace('No sibling references here.', 'Read `assets/gone.json`.'),
    })
    const artifact = join(root, 'dangling-out', 'x.bundle.js')
    const danglingRun = run(PACK, ['--skills', dangling, '--out', artifact])
    assert.equal(danglingRun.status, 0, danglingRun.stderr)
    assert.match(danglingRun.stderr, /needy-skill: body references "assets\/gone.json", which the bundle does not carry/u)
    assert.equal(existsSync(artifact), true)
  })
})

test('the container summary lists every skill and never prints a body line', () => {
  workspace((root) => {
    const skillsRoot = join(root, 'skills')
    writeSkillTree(join(skillsRoot, 'alpha-skill'), {
      'SKILL.md': `${containerManifest('alpha-skill')}\nBODY-SUMMARY-CANARY-ALPHA\n`,
      'assets/notes.md': '{}\n',
    })
    writeSkillTree(join(skillsRoot, 'beta-skill'), {
      'SKILL.md': containerManifest('beta-skill'),
      'scripts/run.mjs': 'run\n',
    })
    const artifact = join(root, 'out', 'company.bundle.js')
    const packed = run(PACK, ['--skills', skillsRoot, '--out', artifact])
    assert.equal(packed.status, 0, packed.stderr)
    const digest = packed.stdout.match(/plaintextSha256 ([0-9a-f]{64})/u)[1]

    const summary = run(UNPACK, ['--in', artifact])
    assert.equal(summary.status, 0, summary.stderr)
    assert.match(summary.stdout, /^container 2 skills$/mu)
    assert.match(summary.stdout, /^skill alpha-skill  scripts 0  assets 1  description The alpha-skill fixture\.$/mu)
    assert.match(summary.stdout, /^skill beta-skill  scripts 1  assets 0  description The beta-skill fixture\.$/mu)
    assert.match(summary.stdout, new RegExp(`plaintextSha256 ${digest}`, 'u'))
    assert.equal(summary.stdout.includes('BODY-SUMMARY-CANARY-ALPHA'), false, 'the summary must not print a body')
    assert.equal(summary.stdout.includes('# alpha-skill'), false)

    assert.equal(run(UNPACK, ['--in', artifact, '--expect-sha256', digest]).status, 0)
    assert.equal(run(UNPACK, ['--in', artifact, '--expect-sha256', 'a'.repeat(64)]).status, 1)
  })
})

test('unknown arguments abort instead of guessing a destination', () => {
  const unknown = run(PACK, ['--skill', FIXTURE, '--output', '/tmp/nope.bundle.js'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown argument "--output"/u)
  assert.equal(run(PACK, []).status, 1)
  assert.match(run(PACK, ['--skill', FIXTURE, '--skills', FIXTURE]).stderr, /exactly one of --skill or --skills/u)
  assert.match(run(UNPACK, []).stderr, /--in is required/u)
  assert.equal(run(UNPACK, ['--in']).status, 1)
  assert.equal(run(PACK, ['--skill', FIXTURE, '--help']).stdout.includes('--skill <dir>'), true)

  // The documented relative path in the error output stays repo-relative.
  assert.equal(relative(REPO_ROOT, PACK), 'tools/company-skills/pack.mjs')
})
