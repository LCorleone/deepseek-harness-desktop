/**
 * Skills-bundle pack-time guards (issue #011): `assets/skills.bundle` became
 * a deterministic rebuild output — untracked and gitignored, with the two
 * legacy v1-era staging pins staying committed until their catalog entries
 * are revoked→retired — so these tests pin the fail-closed / no-op / re-measure
 * seams that keep that world honest:
 *
 *  - packing refuses a skills tree without the asset, with the one-command
 *    rebuild guidance (both the `--from-allowlist` staging-tree form and the
 *    direct `--source-dir` form), and never emits an artifact;
 *  - the CI pre-pack helper (`ensure-skills-bundles.mjs` → lib) maps staging
 *    trees to package names via package.json (never the stem spelling),
 *    no-ops without invoking the builder when nothing is missing, copies the
 *    freshly built asset into exactly the trees that lack one, and leaves
 *    the `.bundle-rebuilt` marker only there; the marker never ships in the
 *    packed tgz;
 *  - the measure selection rule (lib `needsTreeDigestMeasurement`): entries
 *    pinning a treeDigest stay skipped (the committed legacy shape) unless
 *    their staging bundle was provisioned this run (marker → re-measure from
 *    the CI-packed bytes); digest-less entries always measure;
 *  - the .gitignore rules: source-tree and 0.1.2+ staging bundles ignored,
 *    the two legacy staging pins trackable, the marker ignored (asserted
 *    through `git check-ignore`, the same engine git itself uses).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ensureSkillsBundles, needsTreeDigestMeasurement, SKILLS_BUNDLE_RELATIVE_PATH, SKILLS_BUNDLE_REBUILT_MARKER_FILENAME, SKILLS_PACKAGE_NAME, skillsBundleStagingTrees, stagingBundleWasProvisioned, stagingTreeForTarballSourcePath } from '../lib/skills-bundle.mjs'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// tools/company-catalog/tests → tools/company-catalog → tools → repository root.
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
const CLI = join(TOOL_DIR, 'cli.mjs')
const FIXTURE = join(TOOL_DIR, 'fixtures', 'fixture-hello')
const ORIGIN = 'https://gitlab.company.example'
const PROJECT = 'julu/dsh-desktop-config'

const run = (args, { cwd = REPO_ROOT } = {}) => {
  const probe = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 120_000 })
  return { status: probe.status, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '' }
}

/** A sources-root workspace holding one skills-package staging tree WITHOUT the bundle. */
function stageBundlelessSkillsSources() {
  const workspace = mkdtempSync(join(tmpdir(), 'skills-bundle-pack-'))
  const sourcesRoot = join(workspace, 'sources')
  const stem = `${SKILLS_PACKAGE_NAME}-1.0.0`
  cpSync(FIXTURE, join(sourcesRoot, stem), { recursive: true })
  const pkgPath = join(sourcesRoot, stem, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  // The staging tree deliberately carries no assets/skills.bundle — the
  // post-#011 fresh-checkout shape.
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, name: SKILLS_PACKAGE_NAME, version: '1.0.0' }, null, 2)}\n`)
  const entry = {
    packageName: SKILLS_PACKAGE_NAME,
    version: '1.0.0',
    bundlePatch: './cordis.patch.yml',
    repository: `https://plugin-market.company.example/packages/${SKILLS_PACKAGE_NAME}`,
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
    source: {
      kind: 'tarball',
      url: `${ORIGIN}/${PROJECT}/-/raw/master/packages/${SKILLS_PACKAGE_NAME}-1.0.0.tgz`,
      path: `tools/company-catalog/out/packages/${SKILLS_PACKAGE_NAME}-1.0.0.tgz`,
    },
  }
  const allowlistPath = join(workspace, 'allowlist.json')
  writeFileSync(allowlistPath, `${JSON.stringify([entry], null, 2)}\n`)
  return { workspace, sourcesRoot, stem, stagingDir: join(sourcesRoot, stem), allowlistPath, outDir: join(workspace, 'packages') }
}

test('pack-tarball --from-allowlist refuses a skills staging tree without the bundle, with the rebuild guidance', () => {
  const { workspace, sourcesRoot, allowlistPath, outDir, stagingDir } = stageBundlelessSkillsSources()
  try {
    const result = run([
      'pack-tarball', '--from-allowlist',
      '--allowlist', allowlistPath,
      '--sources-root', sourcesRoot,
      '--pack-out', outDir,
      '--no-measure',
      '--catalog-origin', ORIGIN,
    ])
    assert.notEqual(result.status, 0, 'the bundle-less pack must fail the command')
    const output = result.stdout + result.stderr
    assert.match(output, /deterministic rebuild required/u, 'the refusal must carry the rebuild guidance')
    assert.match(output, /node dsh-company-skills\/scripts\/build-bundle-asset\.mjs/u, 'the guidance must name the rebuild command')
    assert.match(output, new RegExp(`copy the asset to ${join(stagingDir, SKILLS_BUNDLE_RELATIVE_PATH).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'the guidance must name the copy target (the staging tree, not a tmp dir)')
    assert.match(output, /CI does this automatically/u, 'the guidance must point at the CI behavior')
    assert.match(output, /nothing was packed/u, 'the refusal must be explicitly fail-closed')
    assert.equal(existsSync(join(outDir, `${SKILLS_PACKAGE_NAME}-1.0.0.tgz`)), false, 'no artifact may be produced for a bundle-less skills tree')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('pack-tarball --source-dir refuses the skills source tree itself without the bundle', () => {
  const { workspace, stagingDir, outDir } = stageBundlelessSkillsSources()
  try {
    const result = run(['pack-tarball', '--source-dir', stagingDir, '--pack-out', outDir, '--no-measure', '--catalog-origin', ORIGIN])
    assert.notEqual(result.status, 0, 'the bundle-less direct pack must fail the command')
    const output = result.stdout + result.stderr
    assert.match(output, /deterministic rebuild required/u)
    assert.match(output, /writes dsh-company-skills\/assets\/skills\.bundle in place/u, 'the direct-source guidance must say no copy is needed')
    assert.equal(existsSync(join(outDir, `${SKILLS_PACKAGE_NAME}-1.0.0.tgz`)), false, 'no artifact may be produced')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

/** A plugin-sources fixture root: skills tree without bundle, skills tree with, unrelated tree without, manifest-less dir. */
function stageSourcesRootFixture() {
  const root = mkdtempSync(join(tmpdir(), 'skills-bundle-mapping-'))
  const skillsWithout = join(root, 'dsh-company-skills-0.9.9')
  const skillsWith = join(root, 'dsh-company-skills-1.2.3')
  const unrelated = join(root, 'fixture-hello-1.0.0')
  const manifestLess = join(root, 'not-a-package')
  for (const dir of [skillsWithout, skillsWith, unrelated]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: dir === unrelated ? 'fixture-hello' : SKILLS_PACKAGE_NAME,
      version: dir.split('-').pop(),
    }, null, 2)}\n`)
  }
  mkdirSync(join(skillsWith, 'assets'), { recursive: true })
  writeFileSync(join(skillsWith, 'assets', 'skills.bundle'), 'committed-shape-bytes\n')
  mkdirSync(manifestLess, { recursive: true })
  return { root, skillsWithout, skillsWith, unrelated, manifestLess }
}

test('staging-tree classification matches package names from package.json, never stem spellings', () => {
  const { root, skillsWithout, skillsWith } = stageSourcesRootFixture()
  try {
    const { missing, present } = skillsBundleStagingTrees(root)
    assert.deepEqual(missing.map((tree) => tree.dir), [skillsWithout], 'exactly the skills tree lacking the bundle is missing')
    assert.deepEqual(present, ['dsh-company-skills-1.2.3'], 'the skills tree carrying the asset is present')
    // A root that does not exist is an empty world, not an error (the CI step
    // logs a no-op; the pack step then finds no path-pinned entry either).
    assert.deepEqual(skillsBundleStagingTrees(join(root, 'no-such-root')), { missing: [], present: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureSkillsBundles is a logged no-op that never invokes the builder when nothing is missing', () => {
  const { root, skillsWith } = stageSourcesRootFixture()
  try {
    // Remove the bundle-less skills tree: nothing is missing anymore (the
    // committed-legacy-pin shape — 0.1.0/0.1.1 on a fresh CI checkout).
    rmSync(join(root, 'dsh-company-skills-0.9.9'), { recursive: true, force: true })
    const logs = []
    const result = ensureSkillsBundles({
      repoRoot: root,
      pluginSourcesRoot: root,
      buildAsset: () => {
        throw new Error('the builder must not run when no staging tree lacks the asset')
      },
      log: (line) => logs.push(line),
    })
    assert.deepEqual(result, { rebuilt: [], copied: [] })
    assert.equal(logs.some((line) => line.includes('nothing to rebuild')), true, `the no-op must be logged: ${logs.join(' | ')}`)
    assert.equal(existsSync(join(skillsWith, 'assets', 'skills.bundle')), true, 'the present asset is untouched')
    assert.equal(stagingBundleWasProvisioned(skillsWith), false, 'a no-op leaves no provisioning marker — the measure step keeps skipping digest-pinned entries')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureSkillsBundles rebuilds once and copies the fresh asset into exactly the trees that lack one', () => {
  const { root, skillsWithout, skillsWith, unrelated } = stageSourcesRootFixture()
  try {
    const logs = []
    let builds = 0
    const result = ensureSkillsBundles({
      repoRoot: root,
      pluginSourcesRoot: root,
      buildAsset: () => {
        builds += 1
        // The real builder writes the source-tree asset; the stub mirrors that.
        mkdirSync(join(root, SKILLS_PACKAGE_NAME, 'assets'), { recursive: true })
        writeFileSync(join(root, SKILLS_PACKAGE_NAME, 'assets', 'skills.bundle'), 'freshly-built-bytes\n')
      },
      log: (line) => logs.push(line),
    })
    assert.equal(builds, 1, 'the rebuild runs exactly once however many trees need a copy')
    assert.deepEqual(result.copied, [{ stem: 'dsh-company-skills-0.9.9', bytes: readFileSync(join(skillsWithout, 'assets', 'skills.bundle')).byteLength }])
    assert.equal(readFileSync(join(skillsWithout, 'assets', 'skills.bundle'), 'utf8'), 'freshly-built-bytes\n', 'the missing tree receives the freshly built bytes')
    assert.equal(stagingBundleWasProvisioned(skillsWithout), true, 'a provisioned tree carries the .bundle-rebuilt marker for the measure step')
    assert.equal(existsSync(join(skillsWithout, SKILLS_BUNDLE_REBUILT_MARKER_FILENAME)), true, 'the marker sits at the staging-tree root')
    assert.equal(readFileSync(join(skillsWith, 'assets', 'skills.bundle'), 'utf8'), 'committed-shape-bytes\n', 'the tree that already carried the asset keeps its own bytes')
    assert.equal(stagingBundleWasProvisioned(skillsWith), false, 'a tree that already carried the asset gets no marker — the measure step keeps its reviewed digest')
    assert.equal(existsSync(join(unrelated, 'assets')), false, 'a non-skills tree is never touched')
    assert.equal(logs.some((line) => line.includes('dsh-company-skills-0.9.9') && line.includes('rebuilding')), true, 'the rebuild decision must be logged with the stem')
    assert.equal(logs.some((line) => line.startsWith('skills-bundle: copied') && line.includes(join(skillsWithout, 'assets', 'skills.bundle'))), true, 'each copy must be logged with its target')
    assert.equal(logs.some((line) => line.includes(SKILLS_BUNDLE_REBUILT_MARKER_FILENAME)), true, 'the marker left behind must be logged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the gitignore rules keep the legacy staging pins trackable and ignore source-tree, 0.1.2+ staging bundles, and the marker', () => {
  // `git check-ignore` is the engine git itself uses; exit 0 = ignored,
  // 1 = not ignored. Run from the repository root so the tracked .gitignore
  // applies (check-ignore evaluates patterns, so the paths need not exist).
  const ignoredOrNot = (path) => {
    const probe = spawnSync('git', ['check-ignore', '-q', path], { encoding: 'utf8', cwd: REPO_ROOT })
    assert.equal(probe.status === 0 || probe.status === 1, true, `git check-ignore failed for ${path}: ${probe.stderr}`)
    return probe.status === 0
  }
  // The transitional rule (#011 review): the source-tree asset and every
  // 0.1.2+ staging bundle are rebuild outputs (ignored), while the two
  // legacy v1-era staging pins stay committed — md5-pinned to the PUBLISHED
  // 0.1.0/0.1.1 tgz bytes — until their catalog entries are revoked→retired.
  for (const ignored of [
    'dsh-company-skills/assets/skills.bundle',
    // The pattern is version-agnostic on purpose: a future staging tree is
    // covered without touching .gitignore again — including the very next
    // real one, 0.1.2.
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.2/assets/skills.bundle',
    'tools/company-catalog/plugin-sources/dsh-company-skills-9.9.9/assets/skills.bundle',
    // The provisioning marker is CI-run bookkeeping, never committed.
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.0/.bundle-rebuilt',
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.2/.bundle-rebuilt',
  ]) {
    assert.equal(ignoredOrNot(ignored), true, `${ignored} must be ignored`)
  }
  for (const tracked of [
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.0/assets/skills.bundle',
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.1/assets/skills.bundle',
  ]) {
    assert.equal(ignoredOrNot(tracked), false, `${tracked} must stay trackable (legacy v1-era pin, committed until revoked→retired)`)
  }
  for (const kept of [
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.0/package.json',
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.0/cordis.patch.yml',
    'tools/company-catalog/plugin-sources/dsh-company-skills-0.1.1/lib/codec.d.ts',
    // Other assets in staging trees (the agent-teams ui.png shape) stay tracked.
    'tools/company-catalog/plugin-sources/dsh-dai-agent-teams-0.1.16/assets/ui.png',
    'tools/company-catalog/plugin-sources/dsh-dai-agent-teams-0.1.16/readme/notes.md',
    'dsh-company-skills/package.json',
    'dsh-company-skills/skills/ppt-designer/skill.md',
    'dsh-company-skills/assets/manifest.json',
  ]) {
    assert.equal(ignoredOrNot(kept), false, `${kept} must stay trackable`)
  }
})

test('needsTreeDigestMeasurement: digest-pinned entries skip unless their staging bundle was provisioned this run', () => {
  const { root, skillsWithout, skillsWith } = stageSourcesRootFixture()
  try {
    // The CI-provisioned world: ensure-skills-bundles copied the fresh bytes
    // into the bundle-less tree and left the marker at its root.
    mkdirSync(join(skillsWithout, 'assets'), { recursive: true })
    writeFileSync(join(skillsWithout, 'assets', 'skills.bundle'), 'provisioned-bundle-bytes\n')
    writeFileSync(join(skillsWithout, SKILLS_BUNDLE_REBUILT_MARKER_FILENAME), '2026-09-12T00:00:00.000Z\n')
    // The allowlist shape of the two worlds: a legacy committed-pin entry
    // (staging tree carries the committed bundle, no marker) and a
    // CI-provisioned entry (staging tree freshly provisioned → marker).
    const legacyEntry = {
      packageName: SKILLS_PACKAGE_NAME,
      version: '1.2.3',
      treeDigest: 'a'.repeat(64),
      source: { kind: 'tarball', path: 'tools/company-catalog/out/packages/dsh-company-skills-1.2.3.tgz' },
    }
    const provisionedEntry = {
      packageName: SKILLS_PACKAGE_NAME,
      version: '0.9.9',
      treeDigest: 'b'.repeat(64),
      source: { kind: 'tarball', path: 'tools/company-catalog/out/packages/dsh-company-skills-0.9.9.tgz' },
    }
    // The staging-tree mapping is the pack step's stem convention.
    assert.equal(stagingTreeForTarballSourcePath(legacyEntry.source.path, root), skillsWith)
    assert.equal(stagingTreeForTarballSourcePath(provisionedEntry.source.path, root), skillsWithout)
    // Legacy shape (this is what 0.1.0/0.1.1 look like on a fresh checkout:
    // the committed v1 pins make ensure-skills-bundles a no-op — no marker).
    assert.equal(needsTreeDigestMeasurement(legacyEntry, root), false, 'a digest-pinned entry with a committed staging bundle stays skipped (the reviewed digest matches the repacked bytes)')
    // Provisioned shape: the marker forces a re-measure from this run's
    // packed bytes (equality confirms the pin; a mismatch fails measure).
    assert.equal(needsTreeDigestMeasurement(provisionedEntry, root), true, 'a digest-pinned entry whose staging bundle was provisioned this run must be re-measured')
    // A digest-less entry always measures, marker or not (the usual fill).
    assert.equal(needsTreeDigestMeasurement({ ...legacyEntry, treeDigest: undefined }, root), true)
    assert.equal(needsTreeDigestMeasurement({ ...provisionedEntry, treeDigest: undefined }, root), true)
    // Non-tarball entries have no staging tree and keep the plain rule.
    assert.equal(needsTreeDigestMeasurement({ packageName: 'x', version: '1.0.0', treeDigest: 'c'.repeat(64) }, root), false, 'an npm/registry entry pinning a digest stays skipped')
    assert.equal(needsTreeDigestMeasurement({ packageName: 'x', version: '1.0.0', treeDigest: 'c'.repeat(64), source: { kind: 'tarball', url: 'https://example/x-1.0.0.tgz' } }, root), false, 'an inline-integrity tarball entry (no source.path) stays skipped — nothing local to re-measure')
    // A path whose staging tree does not exist (a not-yet-staged entry)
    // behaves like the legacy shape: skipped, never a phantom re-measure.
    assert.equal(needsTreeDigestMeasurement({ ...legacyEntry, source: { kind: 'tarball', path: 'tools/company-catalog/out/packages/dsh-company-skills-7.7.7.tgz' } }, root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the .bundle-rebuilt marker never ships inside the packed tarball', async () => {
  const { workspace, stagingDir, outDir } = stageBundlelessSkillsSources()
  try {
    // The post-ensure CI shape: bundle provisioned + marker at the root. The
    // staged manifest drops its `files` allowlist so npm pack would happily
    // ship every top-level file — the marker's absence then proves the
    // stageSourceDirectory filter, not an allowlist accident (the real
    // staging trees' `files` lists never name it either; this is the
    // defense-in-depth pin).
    const pkgPath = join(stagingDir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    delete pkg.files
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    mkdirSync(join(stagingDir, 'assets'), { recursive: true })
    writeFileSync(join(stagingDir, 'assets', 'skills.bundle'), 'provisioned-bundle-bytes\n')
    writeFileSync(join(stagingDir, SKILLS_BUNDLE_REBUILT_MARKER_FILENAME), '2026-09-12T00:00:00.000Z\n')
    const result = run(['pack-tarball', '--source-dir', stagingDir, '--pack-out', outDir, '--no-measure', '--catalog-origin', ORIGIN])
    assert.equal(result.status, 0, `the provisioned-tree pack must succeed:\n${result.stderr}`)
    const { parseTarball } = await import('../lib/tarball.mjs')
    const entries = parseTarball(readFileSync(join(outDir, `${SKILLS_PACKAGE_NAME}-1.0.0.tgz`)), 'the packed skills tarball')
    const paths = entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)
    assert.equal(paths.includes(`package/${SKILLS_BUNDLE_RELATIVE_PATH}`), true, `the provisioned bundle must ship: ${paths.join(', ')}`)
    assert.equal(paths.some((path) => path.endsWith(SKILLS_BUNDLE_REBUILT_MARKER_FILENAME)), false, `the marker is CI bookkeeping and must never ship: ${paths.join(', ')}`)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
