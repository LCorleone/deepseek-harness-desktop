/**
 * Bundle format tests: the field rules, the codec, and the directory reader —
 * everything `pack.mjs` and `unpack.mjs` share. Pure and offline: no CLI, no
 * filesystem beyond the fixture tree and a temporary scratch directory.
 *
 * Each red case pins the exact rejection a skill author would hit, because
 * the packer is the only gate between a hand-written skill directory and a
 * blob that no one can inspect after the fact.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  BUNDLE_MAX_BYTES,
  CONTAINER_MAX_BYTES,
  CONTAINER_VERSION,
  DESCRIPTION_MAX_LENGTH,
  FILE_MAX_BYTES,
  bundlePlaintextJson,
  collectReferences,
  containerPlaintextJson,
  parseSkillManifest,
  readSkillDirectory,
  readSkillsDirectory,
  renderSkillManifest,
  validateBundle,
  validateContainer,
} from '../lib/bundle.mjs'
import { decodeBundleBlob, encodeBundleBlob, extractBundleBlob, renderBundleModule } from '../lib/codec.mjs'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = join(TOOL_DIR, 'fixtures', 'fixture-hello')

const encodeText = (text) => Buffer.from(text, 'utf8').toString('base64')
const entry = (path, text) => ({ path, content: encodeText(text) })
const bundleFixture = (overrides = {}) => ({
  name: 'demo-skill',
  description: 'A demo skill used by the format tests.',
  body: '\n# Demo\n\nNothing in this body references a sibling resource.\n',
  scripts: [],
  assets: [entry('assets/data.json', '{}\n')],
  ...overrides,
})

/** Write a temporary skill directory from a `{ relativePath: text }` map. */
function writeSkillTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'company-skills-format-'))
  for (const [relative, text] of Object.entries(files)) {
    const target = join(root, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  return root
}

const withSkillTree = (files, body) => {
  const root = writeSkillTree(files)
  try {
    return body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const MINIMAL_MANIFEST = '---\nname: demo-skill\ndescription: A demo skill.\n---\n\n# Demo\n'

/** A container holding two valid bundles with distinct names. */
const containerFixture = (overrides = {}) => ({
  version: CONTAINER_VERSION,
  skills: [
    validateBundle(bundleFixture({ name: 'alpha-skill', description: 'The alpha fixture.' })),
    validateBundle(bundleFixture({ name: 'beta-skill', description: 'The beta fixture.' })),
  ],
  ...overrides,
})

test('the fixture skill directory reads into the canonical bundle shape', () => {
  const bundle = readSkillDirectory(FIXTURE)
  assert.deepEqual(Object.keys(bundle), ['name', 'description', 'body', 'scripts', 'assets'])
  assert.equal(bundle.name, 'fixture-hello')
  assert.deepEqual(bundle.scripts.map((item) => item.path), ['scripts/hello.mjs'])
  assert.deepEqual(bundle.assets.map((item) => item.path), ['assets/notes.md'])
  assert.ok(bundle.body.startsWith('\n# Fixture hello'))
  assert.deepEqual(bundle, validateBundle(JSON.parse(bundlePlaintextJson(bundle))))
})

test('pack→unpack of the codec is byte-identical and canonicalizes entry order', () => {
  const bundle = validateBundle(bundleFixture())
  const shuffled = validateBundle({
    ...bundle,
    scripts: [entry('scripts/b.mjs', 'b\n'), entry('scripts/a.mjs', 'a\n')],
    assets: [entry('assets/z.json', '{}\n'), entry('assets/a.json', '[]\n')],
  })
  const json = bundlePlaintextJson(shuffled)
  assert.equal(decodeBundleBlob(encodeBundleBlob(json)), json)
  assert.deepEqual(shuffled.scripts.map((item) => item.path), ['scripts/a.mjs', 'scripts/b.mjs'])
  assert.deepEqual(shuffled.assets.map((item) => item.path), ['assets/a.json', 'assets/z.json'])
  // Re-validating a different input order lands on the same blob.
  const reordered = validateBundle({
    ...bundle,
    scripts: [...shuffled.scripts].reverse(),
    assets: [...shuffled.assets].reverse(),
  })
  assert.equal(encodeBundleBlob(bundlePlaintextJson(reordered)), encodeBundleBlob(json))
})

test('the codec rejects anything that is not canonical base64', () => {
  assert.throws(() => decodeBundleBlob('not base64!'), /standard base64/u)
  assert.throws(() => decodeBundleBlob('QUJD\n'), /standard base64/u)
  assert.throws(() => decodeBundleBlob(''), /non-empty/u)
  assert.throws(() => encodeBundleBlob(''), TypeError)
  assert.throws(() => extractBundleBlob('#!/bin/sh\necho hi\n'), /neither a generated bundle module/u)
})

test('the generated module wraps the blob in one deterministic export', () => {
  const bundle = validateBundle(bundleFixture())
  const blob = encodeBundleBlob(bundlePlaintextJson(bundle))
  const module = renderBundleModule(blob)
  assert.match(module, /^\/\*\*\n \* GENERATED FILE — do not edit by hand\./u)
  assert.equal(extractBundleBlob(module), blob)
  assert.equal(extractBundleBlob(`${blob}\n`), blob)
  for (const line of bundle.body.split('\n')) {
    if (line.length >= 8) assert.ok(!module.includes(line), `module leaked body line ${JSON.stringify(line)}`)
  }
})

test('the skill name must be kebab-case', () => {
  for (const name of ['Demo', 'demo_skill', '-demo', 'demo-', 'demo--skill', 'demo skill', 'demo.skill', '', 42, null]) {
    assert.throws(() => validateBundle(bundleFixture({ name })), /name must be kebab-case|document must carry/u, `accepted ${JSON.stringify(name)}`)
  }
  assert.equal(validateBundle(bundleFixture({ name: 'a-1-b' })).name, 'a-1-b')
})

test('the description is bounded to the catalog truncation limit', () => {
  assert.equal(validateBundle(bundleFixture({ description: 'x'.repeat(DESCRIPTION_MAX_LENGTH) })).description.length, DESCRIPTION_MAX_LENGTH)
  assert.throws(
    () => validateBundle(bundleFixture({ description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1) })),
    /description is 501 characters/u,
  )
  assert.throws(() => validateBundle(bundleFixture({ description: '' })), /description must be a non-empty string/u)
  assert.throws(() => validateBundle(bundleFixture({ description: 'two\nlines' })), /single line/u)
  assert.throws(() => validateBundle(bundleFixture({ description: ' padded ' })), /leading or trailing whitespace/u)
  assert.throws(() => validateBundle(bundleFixture({ description: 7 })), /description must be a non-empty string/u)
})

test('the body must carry content and stay inside the per-file bound', () => {
  assert.throws(() => validateBundle(bundleFixture({ body: '' })), /body must be a non-empty string/u)
  assert.throws(() => validateBundle(bundleFixture({ body: 12 })), /body must be a non-empty string/u)
  assert.throws(() => validateBundle(bundleFixture({ body: 'a'.repeat(FILE_MAX_BYTES + 1) })), /body exceeds/u)
})

test('the document must carry exactly the five bundle fields', () => {
  assert.throws(() => validateBundle(null), /must be an object/u)
  assert.throws(() => validateBundle([]), /must be an object/u)
  const missing = bundleFixture()
  delete missing.assets
  assert.throws(() => validateBundle(missing), /must carry exactly name, description, body, scripts, assets/u)
  assert.throws(() => validateBundle({ ...bundleFixture(), version: 1 }), /must carry exactly/u)
})

test('entry paths must be normalized bundle-relative POSIX paths under the right prefix', () => {
  const rejected = [
    ['assets/../data.json', /normalized relative path|characters the loader/u],
    ['/assets/data.json', /must be relative/u],
    ['assets\\data.json', /must be relative/u],
    ['./assets/data.json', /normalized relative path/u],
    ['assets//data.json', /normalized relative path/u],
    ['scripts/data.json', /must live under assets\//u],
    ['data.json', /must live under assets\//u],
    ['assets/a b.json', /characters the loader cannot address/u],
    [`assets/${'a'.repeat(250)}.json`, /longer than the 200-character bound/u],
  ]
  for (const [path, pattern] of rejected) {
    assert.throws(() => validateBundle(bundleFixture({ assets: [entry(path, 'x')] })), pattern, `accepted ${path}`)
  }
  assert.throws(
    () => validateBundle(bundleFixture({ assets: [entry('assets/a.json', '1'), entry('assets/a.json', '2')] })),
    /duplicates an earlier entry/u,
  )
  assert.throws(() => validateBundle(bundleFixture({ assets: [{ path: 'assets/a.json', extra: 1, content: encodeText('x') }] })), /exactly path and content/u)
  assert.throws(() => validateBundle(bundleFixture({ assets: 'nope' })), /must be an array/u)
})

test('entry content must be canonical non-empty base64 inside the per-file bound', () => {
  assert.throws(() => validateBundle(bundleFixture({ assets: [{ path: 'assets/a.json', content: 'not base64!' }] })), /standard base64/u)
  assert.throws(() => validateBundle(bundleFixture({ assets: [{ path: 'assets/a.json', content: '' }] })), /non-empty standard base64/u)
  const oversized = Buffer.alloc(FILE_MAX_BYTES + 1, 0x61).toString('base64')
  assert.throws(() => validateBundle(bundleFixture({ assets: [{ path: 'assets/a.json', content: oversized }] })), /per-file bound/u)
})

test('references from the body and from scripts must resolve inside the bundle', () => {
  assert.deepEqual(collectReferences('run scripts/run.mjs then read assets/a.json.'), ['assets/a.json', 'scripts/run.mjs'])
  assert.deepEqual(collectReferences('put things in scripts/ or assets/'), [])

  assert.throws(
    () => validateBundle(bundleFixture({ scripts: [entry('scripts/run.mjs', "readFile('assets/missing.json')\n")] })),
    /script "scripts\/run.mjs" references "assets\/missing.json"/u,
  )
  assert.throws(
    () => validateBundle(bundleFixture({ body: '\nSee `assets/gone.json`.\n' })),
    /body references "assets\/gone.json"/u,
  )
  // The asset exists → accepted.
  assert.equal(
    validateBundle(bundleFixture({ scripts: [entry('scripts/run.mjs', "readFile('assets/data.json')\n")] })).scripts.length,
    1,
  )
})

test('a bundle larger than the document bound is rejected', () => {
  const chunk = Buffer.alloc(FILE_MAX_BYTES, 0x61).toString('base64')
  const assets = Array.from({ length: 4 }, (_, index) => ({ path: `assets/blob-${String(index)}.bin`, content: chunk }))
  let tiny = 0
  try {
    validateBundle(bundleFixture({ assets }))
  } catch (error) {
    tiny = 1
    assert.match(error.message, new RegExp(`the bound is ${String(BUNDLE_MAX_BYTES)}`, 'u'))
  }
  assert.equal(tiny, 1, 'a four-megabyte payload must exceed the bundle bound')
})

test('the manifest parser keeps the body byte-exact and rejects malformed frontmatter', () => {
  const parsed = parseSkillManifest(MINIMAL_MANIFEST)
  assert.deepEqual(parsed, { name: 'demo-skill', description: 'A demo skill.', body: '\n# Demo\n' })
  assert.equal(renderSkillManifest(parsed), MINIMAL_MANIFEST)
  assert.equal(parseSkillManifest('---\nname: "quoted"\ndescription: \'q\'\n---\nbody').name, 'quoted')

  assert.throws(() => parseSkillManifest('# No frontmatter\n'), /must open with a "---" frontmatter block/u)
  assert.throws(() => parseSkillManifest('---\r\nname: a\r\n---\r\n'), /must use LF line endings/u)
  assert.throws(() => parseSkillManifest('---\nname: a\n'), /never closed/u)
  assert.throws(() => parseSkillManifest('---\nnot a pair\n---\n'), /must be a "key: value" pair/u)
  assert.throws(() => parseSkillManifest('---\nname: a\nname: b\n---\n'), /repeats the frontmatter key/u)
  assert.throws(() => parseSkillManifest('---\ndescription: d\n---\n'), /requires a name/u)
  assert.throws(() => parseSkillManifest('---\nname: a\n---\n'), /requires a description/u)
})

test('frontmatter quotes are syntax, so rendering never re-adds them', () => {
  // A quoted source description parses to the unquoted value and the
  // regenerated manifest is the normalized (unquoted) form.
  assert.equal(parseSkillManifest('---\nname: demo-skill\ndescription: "A demo skill."\n---\nbody').description, 'A demo skill.')
  assert.equal(
    renderSkillManifest({ name: 'demo-skill', description: 'A demo skill.', body: 'body' }),
    '---\nname: demo-skill\ndescription: A demo skill.\n---\nbody',
  )
  // Known, accepted edge (only reachable from a hand-written bundle): a
  // description whose *content* starts and ends with quotes is normalized away
  // by the same YAML-quoting rule when the manifest is regenerated.
  const quoted = renderSkillManifest({ name: 'demo-skill', description: '"A demo skill."', body: 'body' })
  assert.equal(quoted, '---\nname: demo-skill\ndescription: "A demo skill."\n---\nbody')
  assert.equal(parseSkillManifest(quoted).description, 'A demo skill.')
})

test('a container carries exactly version and skills, one validated bundle each', () => {
  const container = validateContainer(containerFixture())
  assert.deepEqual(Object.keys(container), ['version', 'skills'])
  assert.equal(container.version, CONTAINER_VERSION)
  assert.deepEqual(container.skills.map((skill) => skill.name), ['alpha-skill', 'beta-skill'])
  assert.equal(containerPlaintextJson(container), JSON.stringify(container))
  // A single-element container is legitimate: a one-skill plugin still ships
  // the container shape, so batch 2 never has to branch on array length.
  assert.equal(validateContainer({ version: CONTAINER_VERSION, skills: [bundleFixture({ name: 'only-skill' })] }).skills.length, 1)

  assert.throws(() => validateContainer([]), /must be an object/u)
  assert.throws(() => validateContainer({ version: CONTAINER_VERSION }), /must carry exactly version, skills/u)
  assert.throws(() => validateContainer({ ...containerFixture(), extra: 1 }), /must carry exactly/u)
  assert.throws(() => validateContainer(containerFixture({ version: 2 })), /version must be 1/u)
  assert.throws(() => validateContainer(containerFixture({ skills: 'nope' })), /must be an array/u)
  // Empty is rejected: a container that carries nothing is a mis-pointed root,
  // not a shippable artifact.
  assert.throws(() => validateContainer(containerFixture({ skills: [] })), /at least one skill/u)
  // Every per-skill rule still applies, and the message names the element.
  assert.throws(
    () => validateContainer({ version: CONTAINER_VERSION, skills: [{ ...bundleFixture(), extra: 1 }] }),
    /skills\[0\]: .*must carry exactly name, description, body, scripts, assets/u,
  )
  assert.throws(
    () => validateContainer({ version: CONTAINER_VERSION, skills: [bundleFixture({ name: 'Bad' })] }),
    /skills\[0\]: .*name must be kebab-case/u,
  )
  assert.throws(() => validateContainer({ version: CONTAINER_VERSION, skills: [bundleFixture(), bundleFixture()] }), /"demo-skill" is duplicated/u)
})

test('the container is canonical by name and bounded as a whole', () => {
  const shuffled = validateContainer({
    version: CONTAINER_VERSION,
    skills: [bundleFixture({ name: 'zeta-skill' }), bundleFixture({ name: 'alpha-skill' })],
  })
  assert.deepEqual(shuffled.skills.map((skill) => skill.name), ['alpha-skill', 'zeta-skill'])
  assert.equal(
    containerPlaintextJson(shuffled),
    containerPlaintextJson({ ...shuffled, skills: [...shuffled.skills].reverse() }),
  )

  // Five skills, each inside its own 4 MiB bound, together exceed the
  // container bound — the container bound is a real extra gate.
  const chunk = Buffer.alloc(900 * 1024, 0x61).toString('base64')
  const bulk = Array.from({ length: 5 }, (_, index) => validateBundle(bundleFixture({
    name: `bulk-${String(index)}-skill`,
    assets: [0, 1, 2].map((slot) => ({ path: `assets/blob-${String(slot)}.bin`, content: chunk })),
  })))
  assert.throws(
    () => validateContainer({ version: CONTAINER_VERSION, skills: bulk }),
    new RegExp(`the bound is ${String(CONTAINER_MAX_BYTES)}`, 'u'),
  )
})

test('the skills root reader takes one directory per skill and rejects anything else', () => {
  const alpha = MINIMAL_MANIFEST.replace('demo-skill', 'alpha-skill')
  const beta = MINIMAL_MANIFEST.replace('demo-skill', 'beta-skill').replace('A demo skill.', 'Beta.')
  withSkillTree({ 'alpha-skill/SKILL.md': alpha, 'beta-skill/SKILL.md': beta }, (root) => {
    assert.deepEqual(readSkillsDirectory(root).skills.map((skill) => skill.name), ['alpha-skill', 'beta-skill'])
  })
  withSkillTree({ 'README.md': 'nope\n' }, (root) => {
    assert.throws(() => readSkillsDirectory(root), /may only contain skill directories/u)
  })
  withSkillTree({}, (root) => {
    assert.throws(() => readSkillsDirectory(root), /carries no skill directories/u)
  })
  withSkillTree({ 'real-skill/SKILL.md': alpha }, (root) => {
    symlinkSync(join(root, 'real-skill'), join(root, 'linked-skill'))
    assert.throws(() => readSkillsDirectory(root), /symlink/u)
  })
  withSkillTree({ 'alpha-skill/assets/data.json': '{}\n' }, (root) => {
    assert.throws(() => readSkillsDirectory(root), /carries no SKILL\.md/u)
  })
})

test('the directory reader rejects every layout the format does not declare', () => {
  assert.equal(readSkillDirectory(FIXTURE).name, 'fixture-hello')

  withSkillTree({ 'SKILL.md': MINIMAL_MANIFEST.replace('name: demo-skill', 'name: Bad') }, (root) => {
    assert.throws(() => readSkillDirectory(root), /name must be kebab-case/u)
  })
  withSkillTree({ 'SKILL.md': MINIMAL_MANIFEST, 'README.md': 'nope\n' }, (root) => {
    assert.throws(() => readSkillDirectory(root), /unexpected file "README.md"/u)
  })
  withSkillTree({ 'SKILL.md': MINIMAL_MANIFEST, 'scripts/nested/deep.mjs': 'x\n' }, (root) => {
    assert.throws(() => readSkillDirectory(root), /unexpected directory "scripts\/nested"/u)
  })
  withSkillTree({ 'SKILL.md': MINIMAL_MANIFEST, 'scripts/.gitkeep': '' }, (root) => {
    assert.throws(() => readSkillDirectory(root), /"scripts\/.gitkeep" is empty/u)
  })
  withSkillTree({ 'README.md': 'no manifest\n' }, (root) => {
    assert.throws(() => readSkillDirectory(root), /unexpected file "README.md"|carries no SKILL.md/u)
  })
  withSkillTree({ 'SKILL.md': MINIMAL_MANIFEST, 'scripts/hello.mjs': 'run\n' }, (root) => {
    symlinkSync(join(root, 'scripts', 'hello.mjs'), join(root, 'scripts', 'link.mjs'))
    assert.throws(() => readSkillDirectory(root), /symlink/u)
  })
})

test('the fixture directory has no leftover plaintext outside the declared layout', () => {
  const listed = readFileSync(join(FIXTURE, 'SKILL.md'), 'utf8')
  assert.ok(listed.includes('FIXTURE-HELLO') === false)
  assert.match(readFileSync(join(FIXTURE, 'assets', 'notes.md'), 'utf8'), /FIXTURE-HELLO-PLAINTEXT-CANARY/u)
})
