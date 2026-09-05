/**
 * verify-handoff tests: the owner-side mechanical gate for staged plugin
 * submissions. Pure and offline — the reference-install measurement is
 * injected (the real `npm pack` → measure chain is e2e-tarball.mjs / the
 * acceptance run), so every red path (tamper, identity drift, compat
 * mismatch, symlink escape, schema violations) pins its own failing step
 * and the green path proves the full ten-step sequence, verdict.md, the
 * staged artifact, and the paste-ready allowlist entry.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { validateAllowlistEntry } from '../lib/allowlist.mjs'
import { validateJsonSchema } from '../lib/handoff-schema.mjs'
import { buildDeterministicTarball } from '../lib/tarball.mjs'
import { compareSemver, parseSemver, rangesIntersect } from '../lib/version-range.mjs'
import { verifyHandoffSubmission } from '../lib/verify-handoff.mjs'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_PATH = join(TOOL_DIR, 'docs', 'handoff', 'handoff.schema.json')
const CATALOG_ORIGIN = 'https://gitlab.company.example'
const FIXED_DIGEST = 'a'.repeat(64)
const OTHER_DIGEST = 'b'.repeat(64)

const PINNED_DSH_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const PINNED_DESKTOP = '2.0.3'
const PINNED_RUNTIME_RANGE = '^0.1.1-rc.2'

const fileEntry = (path, data) => ({ path, type: 'file', mode: 0o644, mtime: 1234567890, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })
const symlinkEntry = (path, linkName) => ({ path, type: 'symlink', mode: 0o755, mtime: 1234567890, linkName })

/** The pinned compat contract fixture (mirrors docs/handoff/compat.json's shape). */
const compatContract = (overrides = {}) => ({
  schemaVersion: 1,
  updated: '2026-09-05',
  dsh: {
    version: '0.1.1-rc.2',
    commit: PINNED_DSH_COMMIT,
    runtimeRange: PINNED_RUNTIME_RANGE,
    ...overrides.dsh,
  },
  desktop: { version: PINNED_DESKTOP, ...overrides.desktop },
  catalog: {
    sequence: 13,
    manifestUrl: `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json`,
    ...overrides.catalog,
  },
})

/** A minimal packed-plugin tarball (npm pack layout: the package/ prefix). */
function pluginTarball({ name = 'fixture-hello', version = '1.0.0', patch = './cordis.patch.yml', extra = [] } = {}) {
  const manifest = {
    name,
    version,
    description: 'submission fixture',
    license: 'MIT',
    main: 'index.js',
    repository: { type: 'git', url: 'https://github.com/example/fixture-hello.git' },
    ...(patch === null ? {} : { dsh: { bundle: { patch } } }),
  }
  return buildDeterministicTarball([
    fileEntry('package/package.json', `${JSON.stringify(manifest, null, 2)}\n`),
    fileEntry('package/index.js', "'use strict'\nmodule.exports = { greet: () => 'hello' }\n"),
    fileEntry('package/cordis.patch.yml', '[]\n'),
    ...extra,
  ])
}

/** A schema-valid handoff sheet for the fixture above. */
const handoffSheet = (overrides = {}) => ({
  schemaVersion: 1,
  plugin: { packageName: 'fixture-hello', version: '1.0.0' },
  compat: {
    dshRuntimeVersion: PINNED_RUNTIME_RANGE,
    dshCommit: PINNED_DSH_COMMIT,
    desktopVersion: PINNED_DESKTOP,
  },
  artifact: { file: 'fixture-hello-1.0.0.tgz', sha256: '0'.repeat(64), sizeBytes: 1 },
  submitter: { name: '张三', gitlabHandle: '@zhangsan', submittedAt: '2026-09-05' },
  evidence: {
    summary: 'dev workspace 安装无错，设置页保存与重启后保持，查询返回结构化结果。',
    checks: ['install-in-dev-workspace', 'client-face-renders'],
  },
  changes: 'initial submission fixture for the verify-handoff tests',
  ...overrides,
})

/**
 * Materialize one submission workspace: `<root>/submissions/<name>-<version>/`
 * with handoff.json + tgz, plus compat.json and (optionally) an allowlist the
 * audit compares against, and an in-repo (gitignored) packages out dir.
 */
function submissionWorkspace({ tarball, handoff = handoffSheet(), compat = compatContract(), allowlist, name = 'fixture-hello', version = '1.0.0', dirName = `${name}-${version}`, recomputeArtifact = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-handoff-test-'))
  const submissionDir = join(root, 'submissions', dirName)
  mkdirSync(submissionDir, { recursive: true })
  const bytes = typeof tarball === 'function' ? tarball() : tarball
  const file = handoff.artifact.file
  writeFileSync(join(submissionDir, file), bytes)
  // By default the sheet's fingerprint matches the artifact (green paths);
  // the tamper reds opt out to keep their deliberately-wrong declarations.
  const sheet = recomputeArtifact
    ? { ...handoff, artifact: { ...handoff.artifact, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength } }
    : handoff
  writeFileSync(join(submissionDir, 'handoff.json'), `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
  const compatPath = join(root, 'compat.json')
  writeFileSync(compatPath, `${JSON.stringify(compat, null, 2)}\n`, 'utf8')
  const workspace = { root, submissionDir, compatPath, sheet }
  if (allowlist !== undefined) {
    const allowlistPath = join(root, 'allowlist.json')
    writeFileSync(allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`, 'utf8')
    workspace.allowlistPath = allowlistPath
  }
  return workspace
}

/** The offline measurement stub: a fixed digest, call-counted. */
const stubMeasure = (calls = [], digest = FIXED_DIGEST) => (tarballPath) => {
  calls.push(tarballPath)
  return { packageName: 'fixture-hello', version: '1.0.0', treeDigest: digest }
}

/** Run the verification against a workspace with the stubbed measurement. */
async function verifyWorkspace(workspace, { measure, ...rest } = {}) {
  const calls = []
  return verifyHandoffSubmission({
    submissionDir: workspace.submissionDir,
    schemaPath: SCHEMA_PATH,
    compatPath: workspace.compatPath,
    ...(workspace.allowlistPath === undefined ? {} : { allowlistPath: workspace.allowlistPath }),
    packagesDir: workspace.packagesDir,
    measureTarball: measure ?? stubMeasure(calls),
    ...rest,
  })
}

// The packages out dir must live inside the repository (the allowlist
// source.path form signs a repo-relative path), so the shared fixture uses a
// gitignored directory under tools/company-catalog/out/.
const PACKAGES_ROOT = mkdtempSync(join(TOOL_DIR, 'out', 'verify-handoff-test-'))
test.after(() => {
  rmSync(PACKAGES_ROOT, { recursive: true, force: true })
})
const withPackagesDir = (workspace) => {
  workspace.packagesDir = join(PACKAGES_ROOT, `packages-${Math.random().toString(36).slice(2, 8)}`)
  return workspace
}

// ---------------------------------------------------------------------------
// The green path
// ---------------------------------------------------------------------------

test('green path: ten steps, verdict.md, staged tgz, validated allowlist entry', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball({ extra: [fileEntry('package/lib/client.js', "fetch('https://api.tavily.com/search')\n")] }),
    allowlist: [{
      packageName: 'fixture-hello',
      version: '0.9.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/fixture-hello',
      revoked: false,
      runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
    }],
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
    // The ten steps, in the contract's order; 8 skips without --smoke.
    assert.deepEqual(result.steps.map((step) => [step.index, step.step]), [
      [1, 'schema'], [2, 'artifact-integrity'], [3, 'safe-unpack'], [4, 'identity-binding'],
      [5, 'compat'], [6, 'audit'], [7, 'tree-digest'], [8, 'smoke-remeasure'],
      [9, 'verdict'], [10, 'accept-prep'],
    ])
    assert.deepEqual(result.steps.map((step) => step.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'skip', 'ok', 'ok'])
    assert.equal(result.treeDigest, FIXED_DIGEST)
    // verdict.md: written into the submission directory, carries the digest and the snippet.
    const verdictPath = join(workspace.submissionDir, 'verdict.md')
    assert.equal(result.verdictPath, verdictPath)
    const verdict = readFileSync(verdictPath, 'utf8')
    assert.match(verdict, /PASS/u)
    assert.match(verdict, new RegExp(FIXED_DIGEST, 'u'))
    assert.match(verdict, /allowlist/u)
    // The tgz landed in the packages dir under the pinned npm filename.
    const stagedPath = join(workspace.packagesDir, 'fixture-hello-1.0.0.tgz')
    assert.equal(result.packagePath, stagedPath)
    assert.equal(readFileSync(stagedPath).byteLength, readFileSync(join(workspace.submissionDir, 'fixture-hello-1.0.0.tgz')).byteLength)
    assert.equal(result.packageRepoPath, result.packageRepoPath.split('\\').join('/'))
    assert.match(result.packageRepoPath, /^tools\/company-catalog\/out\/verify-handoff-test-[^/]+\/packages-[^/]+\/fixture-hello-1\.0\.0\.tgz$/u)
    // The snippet is paste-ready: it passes the pipeline's own entry validation.
    assert.equal(result.allowlistEntry.treeDigest, FIXED_DIGEST)
    assert.equal(result.allowlistEntry.source.kind, 'tarball')
    assert.equal(result.allowlistEntry.source.url, `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/packages/fixture-hello-1.0.0.tgz`)
    const validation = validateAllowlistEntry(result.allowlistEntry, 'the snippet', { companyCatalogOrigin: CATALOG_ORIGIN })
    assert.equal(validation.ok, true, JSON.stringify(validation))
    // The audit saw the dependency-free fixture, its network host, and the catalog delta.
    assert.equal(result.audit.dependencies.length, 0)
    assert.ok(result.audit.networkHosts.hosts.some((host) => host.host === 'api.tavily.com'), JSON.stringify(result.audit.networkHosts))
    assert.equal(result.audit.catalogDelta.relation, 'upgrade')
    assert.ok(result.audit.catalogDelta.note.includes('0.9.0'))
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('green path with --smoke: a second measurement must agree (and the desktop e2e stays a separate drill)', async () => {
  const calls = []
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball() }))
  try {
    const result = await verifyWorkspace(workspace, { smoke: true, measure: stubMeasure(calls) })
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
    assert.equal(calls.length, 2)
    assert.equal(result.smokeDigest, FIXED_DIGEST)
    assert.equal(result.steps.find((step) => step.step === 'smoke-remeasure').status, 'ok')
    assert.match(readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8'), /--smoke 复测：一致/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('scoped packages bind through the flattened npm pack spelling', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    name: '@company/scoped-plugin',
    version: '0.9.0',
    dirName: 'company-scoped-plugin-0.9.0',
    tarball: pluginTarball({ name: '@company/scoped-plugin', version: '0.9.0' }),
    handoff: handoffSheet({
      plugin: { packageName: '@company/scoped-plugin', version: '0.9.0' },
      artifact: { file: 'company-scoped-plugin-0.9.0.tgz', sha256: '0'.repeat(64), sizeBytes: 1 },
    }),
  }))
  try {
    const result = await verifyWorkspace(workspace, {
      measure: () => ({ packageName: '@company/scoped-plugin', version: '0.9.0', treeDigest: FIXED_DIGEST }),
    })
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
    assert.equal(result.identity.packageName, '@company/scoped-plugin')
    assert.equal(result.allowlistEntry.source.path.endsWith('company-scoped-plugin-0.9.0.tgz'), true)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The three red proofs (tamper / identity drift / compat mismatch)
// ---------------------------------------------------------------------------

test('red: sha256 tamper fails step 2 with the recomputed value, verdict names the step, nothing is staged', async () => {
  const bytes = pluginTarball()
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: bytes,
    recomputeArtifact: false,
    handoff: handoffSheet({ artifact: { file: 'fixture-hello-1.0.0.tgz', sha256: 'f'.repeat(64), sizeBytes: bytes.byteLength } }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'artifact-integrity')
    assert.equal(result.failedStep.index, 2)
    assert.match(result.failedStep.reason, new RegExp(`hash to ${createHash('sha256').update(bytes).digest('hex')}`, 'u'))
    assert.match(result.failedStep.reason, /f{64}/u)
    const verdict = readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8')
    assert.match(verdict, /FAIL/u)
    assert.match(verdict, /2\/10 artifact-integrity/u)
    assert.match(verdict, /retest|复测/u)
    assert.equal(existsSync(join(workspace.packagesDir, 'fixture-hello-1.0.0.tgz')), false)
    // sizeBytes drift fails the same step.
    const sizeWorkspace = withPackagesDir(submissionWorkspace({
      tarball: bytes,
      recomputeArtifact: false,
      handoff: handoffSheet({ artifact: { file: 'fixture-hello-1.0.0.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength + 1 } }),
    }))
    try {
      const sizeResult = await verifyWorkspace(sizeWorkspace)
      assert.equal(sizeResult.failedStep.step, 'artifact-integrity')
      assert.match(sizeResult.failedStep.reason, /sizeBytes declares/u)
    } finally {
      rmSync(sizeWorkspace.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: directory-name vs package identity fails step 4 (three-way binding)', async () => {
  // The directory says 2.0.0; everything inside says 1.0.0.
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball(), dirName: 'fixture-hello-2.0.0' }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'identity-binding')
    assert.equal(result.failedStep.index, 4)
    assert.match(result.failedStep.reason, /fixture-hello-2\.0\.0/u)
    assert.match(result.failedStep.reason, /must submit as 'fixture-hello-1\.0\.0'/u)
    assert.match(readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8'), /4\/10 identity-binding/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: handoff plugin identity vs the tarball manifest fails step 4', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    dirName: 'fixture-hello-1.0.1',
    handoff: handoffSheet({ plugin: { packageName: 'fixture-hello', version: '1.0.1' }, artifact: { file: 'fixture-hello-1.0.1.tgz', sha256: '0'.repeat(64), sizeBytes: 1 } }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.failedStep.step, 'identity-binding')
    assert.match(result.failedStep.reason, /three-way identity mismatch/u)
    assert.match(result.failedStep.reason, /fixture-hello@1\.0\.1/u)
    assert.match(result.failedStep.reason, /fixture-hello@1\.0\.0/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: artifact.file under a foreign filename fails step 4 (hosting layout pins the name)', async () => {
  const bytes = pluginTarball()
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: bytes,
    handoff: handoffSheet({ artifact: { file: 'renamed-artifact.tgz', sha256: '0'.repeat(64), sizeBytes: 1 } }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.failedStep.step, 'identity-binding')
    assert.match(result.failedStep.reason, /must pack as 'fixture-hello-1\.0\.0\.tgz'/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: compat dshCommit mismatch fails step 5 and points at the pinned value to retest against', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    handoff: handoffSheet({ compat: { dshRuntimeVersion: PINNED_RUNTIME_RANGE, dshCommit: '0'.repeat(40), desktopVersion: PINNED_DESKTOP } }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'compat')
    assert.equal(result.failedStep.index, 5)
    assert.match(result.failedStep.reason, /retest against deepseek-harness commit b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/u)
    assert.match(readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8'), /5\/10 compat/u)
    // desktopVersion drift fails the same step with its own pinned value.
    const desktopWorkspace = withPackagesDir(submissionWorkspace({
      tarball: pluginTarball(),
      handoff: handoffSheet({ compat: { dshRuntimeVersion: PINNED_RUNTIME_RANGE, dshCommit: PINNED_DSH_COMMIT, desktopVersion: '2.0.2' } }),
    }))
    try {
      const desktopResult = await verifyWorkspace(desktopWorkspace)
      assert.equal(desktopResult.failedStep.step, 'compat')
      assert.match(desktopResult.failedStep.reason, /retest against DSH Desktop 2\.0\.3/u)
    } finally {
      rmSync(desktopWorkspace.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: runtime range without intersection fails step 5 (retest against the pinned range)', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    handoff: handoffSheet({ compat: { dshRuntimeVersion: '^9.0.0', dshCommit: PINNED_DSH_COMMIT, desktopVersion: PINNED_DESKTOP } }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.failedStep.step, 'compat')
    assert.match(result.failedStep.reason, /retest against deepseek-harness 0\.1\.1-rc\.2 \(runtime range \^0\.1\.1-rc\.2\)/u)
    // A range outside the implemented grammar is refused loudly, never guessed.
    const grammarWorkspace = withPackagesDir(submissionWorkspace({
      tarball: pluginTarball(),
      handoff: handoffSheet({ compat: { dshRuntimeVersion: 'latest', dshCommit: PINNED_DSH_COMMIT, desktopVersion: PINNED_DESKTOP } }),
    }))
    try {
      const grammarResult = await verifyWorkspace(grammarWorkspace)
      assert.equal(grammarResult.failedStep.step, 'compat')
      assert.match(grammarResult.failedStep.reason, /range grammar/u)
    } finally {
      rmSync(grammarWorkspace.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Safe unpack reds (the brief's symlink-escape fixture at the command level)
// ---------------------------------------------------------------------------

test('red: an escaping symlink fails step 3 before anything is written through it', async () => {
  // Lexical escape: the link target walks out of package/.
  const lexical = pluginTarball({ patch: null, extra: [symlinkEntry('package/escape-link', '../../outside')] })
  const workspace = withPackagesDir(submissionWorkspace({ tarball: lexical }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.failedStep.step, 'safe-unpack')
    assert.match(result.failedStep.reason, /unsafe link target|escaping|outside the package/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
  // Chained (two-hop) escape: every link is lexically legal, the second link
  // is relocated through the first and would land outside the root.
  const chained = buildDeterministicTarball([
    fileEntry('package/package.json', `${JSON.stringify({ name: 'fixture-hello', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })}\n`),
    fileEntry('package/cordis.patch.yml', '[]\n'),
    fileEntry('package/q/anchor.js', 'q\n'),
    symlinkEntry('package/x/y', '../q'),
    symlinkEntry('package/x/y/inner', '../../land'),
    fileEntry('package/x/y/inner/pwned.js', 'escaped\n'),
  ])
  const chainedWorkspace = withPackagesDir(submissionWorkspace({ tarball: chained }))
  try {
    const chainedResult = await verifyWorkspace(chainedWorkspace)
    assert.equal(chainedResult.failedStep.step, 'safe-unpack')
    assert.match(chainedResult.failedStep.reason, /refusing to create the link/u)
  } finally {
    rmSync(chainedWorkspace.root, { recursive: true, force: true })
  }
})

test('red: a gzip bomb fails step 3 at the decompression bound', async () => {
  // A tiny archive that expands past a deliberately small bound.
  const bomb = gzipSync(Buffer.alloc(512 * 1024, 0x61))
  const workspace = withPackagesDir(submissionWorkspace({ tarball: bomb }))
  try {
    const result = await verifyWorkspace(workspace, { maxUnpackedBytes: 64 * 1024 })
    assert.equal(result.failedStep.step, 'safe-unpack')
    assert.match(result.failedStep.reason, /unpacks? beyond|expands beyond/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: an entry flood fails step 3 at the entry bound', async () => {
  const entries = [
    fileEntry('package/package.json', `${JSON.stringify({ name: 'fixture-hello', version: '1.0.0' })}\n`),
  ]
  for (let index = 0; index < 50; index += 1) entries.push(fileEntry(`package/flood-${String(index)}.js`, 'x'.repeat(10)))
  const workspace = withPackagesDir(submissionWorkspace({ tarball: buildDeterministicTarball(entries) }))
  try {
    const result = await verifyWorkspace(workspace, { maxEntries: 10 })
    assert.equal(result.failedStep.step, 'safe-unpack')
    assert.match(result.failedStep.reason, /51 tar entries, over the 10-entry bound/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Step 1 (schema) reds — additionalProperties:false must bite
// ---------------------------------------------------------------------------

test('red: an unexpected top-level field fails step 1 naming the field', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    handoff: handoffSheet({ extraField: 'not in the contract' }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.failedStep.step, 'schema')
    assert.match(result.failedStep.reason, /\/extraField.*additionalProperties/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: an unexpected nested field and enum drift fail step 1', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    handoff: handoffSheet({ plugin: { packageName: 'fixture-hello', version: '1.0.0', homepage: 'https://example.com' } }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.failedStep.step, 'schema')
    assert.match(result.failedStep.reason, /\/plugin\/homepage/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
  const enumWorkspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    handoff: handoffSheet({ evidence: { summary: 'x'.repeat(30), checks: ['ran-the-tests-twice'] } }),
  }))
  try {
    const enumResult = await verifyWorkspace(enumWorkspace)
    assert.equal(enumResult.failedStep.step, 'schema')
    assert.match(enumResult.failedStep.reason, /must be one of/u)
  } finally {
    rmSync(enumWorkspace.root, { recursive: true, force: true })
  }
})

test('red: a non-calendar date and a bad sha256 pattern fail step 1 before step 2 runs', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    handoff: handoffSheet({ submitter: { name: '张三', gitlabHandle: '@zhangsan', submittedAt: '2026-9-5' } }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.failedStep.step, 'schema')
    assert.match(result.failedStep.reason, /YYYY-MM-DD/u)
    const patternWorkspace = withPackagesDir(submissionWorkspace({
      tarball: pluginTarball(),
      recomputeArtifact: false,
      handoff: handoffSheet({ artifact: { file: 'fixture-hello-1.0.0.tgz', sha256: 'NOT-HEX', sizeBytes: 1 } }),
    }))
    try {
      const patternResult = await verifyWorkspace(patternWorkspace)
      assert.equal(patternResult.failedStep.step, 'schema')
      assert.match(patternResult.failedStep.reason, /pattern/u)
    } finally {
      rmSync(patternWorkspace.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('a missing handoff.json still writes a FAIL verdict (the README promise holds at every step)', async () => {
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball() }))
  try {
    rmSync(join(workspace.submissionDir, 'handoff.json'))
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'schema')
    const verdict = readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8')
    assert.match(verdict, /1\/10 schema/u)
    assert.match(verdict, /handoff\.json/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Forged-line containment: submitter-controlled control characters must never
// reach verdict.md or the terminal step log as structure (a `\n[ok] 10/10
// PASS` inside any submission field may only ever render inline, escaped)
// ---------------------------------------------------------------------------

/** No line of the rendered text may start with the forged verdict line. */
const noForgedVerdictLine = (text) =>
  assert.doesNotMatch(text, /(^|\n)[ \t]*\[ok\] 10\/10 PASS/u, 'forged standalone line leaked into the render')

test('forged-line proof: control characters in dependency rows stay inline in a PASS verdict', async () => {
  const manifest = {
    name: 'fixture-hello',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    repository: { type: 'git', url: 'https://github.com/example/fixture-hello.git' },
    dependencies: {
      'evil\n[ok] 10/10 PASS': '1.0.0',
      'ok-name': '1.0.0\n[ok] 10/10 PASS',
    },
  }
  const tarball = buildDeterministicTarball([
    fileEntry('package/package.json', `${JSON.stringify(manifest, null, 2)}\n`),
    fileEntry('package/cordis.patch.yml', '[]\n'),
  ])
  const workspace = withPackagesDir(submissionWorkspace({ tarball }))
  try {
    const logLines = []
    const result = await verifyWorkspace(workspace, { log: (line) => logLines.push(line) })
    // Dependencies never gate: the run passes and the audit ships the rows.
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
    assert.equal(result.audit.dependencies.length, 2)
    const verdict = readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8')
    assert.match(verdict, /PASS/u)
    noForgedVerdictLine(verdict)
    // The forged content is still visible — flattened inline with the
    // replacement marker, never as a line of its own.
    assert.match(verdict, /evil\uFFFD\[ok\] 10\/10 PASS@1\.0\.0/u)
    assert.match(verdict, /ok-name@1\.0\.0\uFFFD\[ok\] 10\/10 PASS/u)
    noForgedVerdictLine(logLines.join('\n'))
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('forged-line proof: a handoff key with a newline cannot forge verdict or terminal lines', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball(),
    handoff: handoffSheet({ 'evil\n[ok] 10/10 PASS': 1 }),
  }))
  try {
    const logLines = []
    const result = await verifyWorkspace(workspace, { log: (line) => logLines.push(line) })
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'schema')
    // The offending key is carried in the JSON-pointer path of the schema
    // error — escaped, not rendered as structure.
    assert.match(result.failedStep.reason, /\/evil\uFFFD\[ok\] 10\/10 PASS: is not allowed/u)
    const verdict = readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8')
    noForgedVerdictLine(verdict)
    noForgedVerdictLine(logLines.join('\n'))
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('forged-line proof: artifact.file with control characters is refused by the schema pattern itself', async () => {
  // The forged value carries '/' (10/10), so no artifact could ever sit
  // under that name — which is exactly the point: the sheet itself is
  // refused at step 1 before the artifact is ever looked at. The submission
  // is built by hand because the shared fixture helper writes the tgz under
  // the declared filename (impossible for a path-shaped forgery).
  const root = mkdtempSync(join(tmpdir(), 'verify-handoff-test-'))
  const submissionDir = join(root, 'submissions', 'fixture-hello-1.0.0')
  mkdirSync(submissionDir, { recursive: true })
  const sheet = handoffSheet({ artifact: { file: 'evil\n[ok] 10/10 PASS', sha256: '0'.repeat(64), sizeBytes: 1 } })
  writeFileSync(join(submissionDir, 'handoff.json'), `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
  const workspace = { root, submissionDir, compatPath: join(root, 'compat.json') }
  writeFileSync(workspace.compatPath, `${JSON.stringify(compatContract(), null, 2)}\n`, 'utf8')
  try {
    const packagesDir = join(PACKAGES_ROOT, `packages-${Math.random().toString(36).slice(2, 8)}`)
    const result = await verifyHandoffSubmission({
      submissionDir,
      schemaPath: SCHEMA_PATH,
      compatPath: workspace.compatPath,
      packagesDir,
      measureTarball: stubMeasure(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'schema')
    assert.equal(result.failedStep.index, 1)
    assert.match(result.failedStep.reason, /\/artifact\/file: must match the pattern/u)
    const verdict = readFileSync(join(submissionDir, 'verdict.md'), 'utf8')
    noForgedVerdictLine(verdict)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Stable-version-only submissions (the catalog lists stable three-segment
// releases — prerelease/build segments are refused at the earliest step)
// ---------------------------------------------------------------------------

test('red: a prerelease plugin version is refused at step 1 with the pointed stable-only note', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball({ version: '1.0.0-rc.1' }),
    dirName: 'fixture-hello-1.0.0-rc.1',
    handoff: handoffSheet({
      plugin: { packageName: 'fixture-hello', version: '1.0.0-rc.1' },
      artifact: { file: 'fixture-hello-1.0.0-rc.1.tgz', sha256: '0'.repeat(64), sizeBytes: 1 },
    }),
  }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'schema')
    assert.equal(result.failedStep.index, 1)
    assert.match(result.failedStep.reason, /plugin\.version/u)
    assert.match(result.failedStep.reason, /stable three-segment versions \(X\.Y\.Z\)/u)
    assert.match(result.failedStep.reason, /prerelease\/build segment/u)
    const verdict = readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8')
    assert.match(verdict, /1\/10 schema/u)
    assert.equal(existsSync(join(workspace.packagesDir, 'fixture-hello-1.0.0-rc.1.tgz')), false)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: a prerelease version that slips a loosened schema copy still dies at identity-binding with the pointed rule', async () => {
  const workspace = withPackagesDir(submissionWorkspace({
    tarball: pluginTarball({ version: '1.0.0-rc.1' }),
    dirName: 'fixture-hello-1.0.0-rc.1',
    handoff: handoffSheet({
      plugin: { packageName: 'fixture-hello', version: '1.0.0-rc.1' },
      artifact: { file: 'fixture-hello-1.0.0-rc.1.tgz', sha256: '0'.repeat(64), sizeBytes: 1 },
    }),
  }))
  try {
    // The old permissive pattern (prerelease allowed) — the identity check
    // must still refuse the version on its own, with the pointed message.
    const loosened = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
    loosened.properties.plugin.properties.version.pattern = '^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9.-]+)?$'
    const loosenedPath = join(workspace.root, 'loosened.schema.json')
    writeFileSync(loosenedPath, `${JSON.stringify(loosened, null, 2)}\n`, 'utf8')
    const result = await verifyWorkspace(workspace, { schemaPath: loosenedPath })
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'identity-binding')
    assert.equal(result.failedStep.index, 4)
    assert.match(result.failedStep.reason, /'1\.0\.0-rc\.1' is not a stable three-segment X\.Y\.Z version/u)
    assert.match(result.failedStep.reason, /catalog only lists stable releases/u)
    assert.match(readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8'), /4\/10 identity-binding/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Steps 7/8/10 reds
// ---------------------------------------------------------------------------

test('red: a failing reference install fails step 7 with the cause surfaced', async () => {
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball() }))
  try {
    const result = await verifyWorkspace(workspace, {
      measure: () => { throw new Error('pnpm add exited 1: no matching version') },
    })
    assert.equal(result.failedStep.step, 'tree-digest')
    assert.match(result.failedStep.reason, /pnpm add exited 1/u)
    assert.equal(existsSync(join(workspace.packagesDir, 'fixture-hello-1.0.0.tgz')), false)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: a measurement of another identity fails step 7', async () => {
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball() }))
  try {
    const result = await verifyWorkspace(workspace, {
      measure: () => ({ packageName: 'other-package', version: '1.0.0', treeDigest: FIXED_DIGEST }),
    })
    assert.equal(result.failedStep.step, 'tree-digest')
    assert.match(result.failedStep.reason, /other-package@1\.0\.0.*fixture-hello@1\.0\.0/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: --smoke divergence fails step 8', async () => {
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball() }))
  try {
    let call = 0
    const result = await verifyWorkspace(workspace, {
      smoke: true,
      measure: () => { call += 1; return { packageName: 'fixture-hello', version: '1.0.0', treeDigest: call === 1 ? FIXED_DIGEST : OTHER_DIGEST } },
    })
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'smoke-remeasure')
    assert.match(result.failedStep.reason, new RegExp(`${OTHER_DIGEST}.*${FIXED_DIGEST}`, 'u'))
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('red: a tarball without a dsh.bundle.patch declaration fails accept-prep (the entry could never load)', async () => {
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball({ patch: null }) }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'accept-prep')
    assert.equal(result.failedStep.index, 10)
    assert.match(result.failedStep.reason, /dsh\.bundle\.patch/u)
    // The verdict was still written (step 9 ran before the staging).
    assert.match(readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8'), /10\/10 accept-prep/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Same-version staging immutability (the publish-local hosted-tarball rule,
// mirrored at the staging step)
// ---------------------------------------------------------------------------

test('red: restaging a version already staged with different bytes fails accept-prep, staged bytes untouched', async () => {
  const bytes = pluginTarball()
  const workspace = withPackagesDir(submissionWorkspace({ tarball: bytes }))
  try {
    // A previous run staged this <name>-<version> — with other bytes.
    const stagedPath = join(workspace.packagesDir, 'fixture-hello-1.0.0.tgz')
    mkdirSync(workspace.packagesDir, { recursive: true })
    writeFileSync(stagedPath, 'the bytes a previous run staged for this version')
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, false)
    assert.equal(result.failedStep.step, 'accept-prep')
    assert.equal(result.failedStep.index, 10)
    assert.match(result.failedStep.reason, /same version already staged with different bytes/u)
    assert.match(result.failedStep.reason, /immutable per version.*bump the version|bump the version.*immutable per version/us)
    // The refusal happened before the verdict: the verdict names step 10 as
    // the failure, and the previously staged bytes are untouched.
    const verdict = readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8')
    assert.match(verdict, /FAIL/u)
    assert.match(verdict, /10\/10 accept-prep/u)
    assert.equal(readFileSync(stagedPath, 'utf8'), 'the bytes a previous run staged for this version')
    assert.equal(result.packagePath, undefined)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('green: restaging identical bytes is an idempotent pass (same-version content, same artifact)', async () => {
  const bytes = pluginTarball()
  const workspace = withPackagesDir(submissionWorkspace({ tarball: bytes }))
  try {
    const stagedPath = join(workspace.packagesDir, 'fixture-hello-1.0.0.tgz')
    mkdirSync(workspace.packagesDir, { recursive: true })
    writeFileSync(stagedPath, bytes)
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
    const step10 = result.steps.find((step) => step.step === 'accept-prep')
    assert.equal(step10.status, 'ok')
    assert.match(step10.detail, /identical bytes.*idempotent|idempotent.*identical bytes/us)
    assert.equal(result.packagePath, stagedPath)
    assert.ok(readFileSync(stagedPath).equals(bytes))
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Audit details
// ---------------------------------------------------------------------------

test('the audit reports same-version catalog entries with the immutability note, and degrades on an unreadable allowlist', async () => {
  const sameVersionAllowlist = [{
    packageName: 'fixture-hello',
    version: '1.0.0',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/fixture-hello',
    revoked: false,
    runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
  }]
  const workspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball(), allowlist: sameVersionAllowlist }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, true)
    assert.equal(result.audit.catalogDelta.relation, 'same-version')
    assert.match(result.audit.catalogDelta.note, /immutable/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
  const brokenWorkspace = withPackagesDir(submissionWorkspace({ tarball: pluginTarball() }))
  try {
    writeFileSync(join(brokenWorkspace.root, 'allowlist.json'), '{not json', 'utf8')
    brokenWorkspace.allowlistPath = join(brokenWorkspace.root, 'allowlist.json')
    const result = await verifyWorkspace(brokenWorkspace)
    assert.equal(result.ok, true, 'a degraded audit never gates the run')
    assert.equal(result.audit.catalogDelta.available, false)
    assert.match(result.audit.catalogDelta.note, /skipped/u)
  } finally {
    rmSync(brokenWorkspace.root, { recursive: true, force: true })
  }
})

test('the audit lists dependencies and lifecycle scripts of a heavier plugin', async () => {
  const manifest = {
    name: 'fixture-hello',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' }, engines: { dsh: '>=0.1.1-rc.1' } },
    repository: { type: 'git', url: 'https://github.com/example/fixture-hello.git' },
    dependencies: { '@deepseek-ai/schemastery': '^3.18.1' },
    peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.0-rc.6' },
    scripts: { postinstall: 'node build.js' },
  }
  const tarball = buildDeterministicTarball([
    fileEntry('package/package.json', `${JSON.stringify(manifest, null, 2)}\n`),
    fileEntry('package/cordis.patch.yml', '[]\n'),
    fileEntry('package/build.js', '// postinstall\n'),
  ])
  const workspace = withPackagesDir(submissionWorkspace({ tarball }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, true)
    assert.deepEqual(result.audit.dependencies, [
      { section: 'dependencies', name: '@deepseek-ai/schemastery', range: '^3.18.1' },
      { section: 'peerDependencies', name: '@deepseek-ai/dsh-tools', range: '>=0.1.0-rc.6' },
    ])
    assert.deepEqual(result.audit.lifecycleScripts, ['postinstall'])
    assert.deepEqual(result.audit.dshSurface.clientInject, ['@deepseek-ai/dsh-client-runtime'])
    assert.equal(result.audit.dshSurface.enginesDsh, '>=0.1.1-rc.1')
    assert.equal(result.allowlistWarnings.length, 0)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('a tarball without a usable repository yields the pin-it-yourself warning (never a silent snippet)', async () => {
  const manifest = { name: 'fixture-hello', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  const tarball = buildDeterministicTarball([
    fileEntry('package/package.json', `${JSON.stringify(manifest, null, 2)}\n`),
    fileEntry('package/cordis.patch.yml', '[]\n'),
  ])
  const workspace = withPackagesDir(submissionWorkspace({ tarball }))
  try {
    const result = await verifyWorkspace(workspace)
    assert.equal(result.ok, true)
    assert.equal(result.allowlistEntry.repository, undefined)
    assert.equal(result.allowlistWarnings.length, 1)
    assert.match(result.allowlistWarnings[0], /repository/u)
    assert.match(readFileSync(join(workspace.submissionDir, 'verdict.md'), 'utf8'), /注意（warnings）/u)
  } finally {
    rmSync(workspace.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The handoff-schema subset validator (generic behavior beyond the contract)
// ---------------------------------------------------------------------------

test('the schema subset validator: unknown keywords fail closed, const/enum/bounds work', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['n'],
    properties: {
      n: { type: 'integer', minimum: 1, maximum: 3 },
      s: { type: 'string', minLength: 2, pattern: '^a+$' },
      c: { const: 1 },
      e: { enum: ['x', 'y'] },
      arr: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' } },
    },
  }
  assert.equal(validateJsonSchema({ n: 2, s: 'aaa', c: 1, e: 'y', arr: ['q'] }, schema).ok, true)
  const invalid = validateJsonSchema({ n: 0, s: 'ab', c: 2, e: 'z', arr: [], extra: 1 }, schema)
  assert.equal(invalid.ok, false)
  const messages = invalid.errors.map((error) => `${error.at}: ${error.message}`).join('\n')
  assert.match(messages, /\/n: must be >= 1/u)
  assert.match(messages, /\/s: must match the pattern/u)
  assert.match(messages, /\/c: must equal the constant/u)
  assert.match(messages, /\/e: must be one of/u)
  assert.match(messages, /\/arr: must carry at least 1/u)
  assert.match(messages, /\/extra: is not allowed/u)
  // An unimplemented keyword is a schema-side error, never a silent pass.
  assert.throws(() => validateJsonSchema({ n: 1 }, { properties: { n: { maxLength: 5, if: {} } } }), /if.*does not implement/u)
})

// ---------------------------------------------------------------------------
// The range grammar (unit pins for the compat check)
// ---------------------------------------------------------------------------

test('semver precedence: prerelease ordering and identifier classes', () => {
  const ordered = ['0.1.1-alpha', '0.1.1-alpha.1', '0.1.1-alpha.beta', '0.1.1-beta', '0.1.1-beta.2', '0.1.1-beta.11', '0.1.1-rc.1', '0.1.1']
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(compareSemver(parseSemver(ordered[index - 1]), parseSemver(ordered[index])) < 0, `${ordered[index - 1]} < ${ordered[index]}`)
  }
  assert.equal(compareSemver(parseSemver('1.2.3+built.1'), parseSemver('1.2.3')), 0)
})

test('range intersection: the caret/exact/comparator/hyphen table', () => {
  for (const [left, right, expected] of [
    ['^0.1.1-rc.2', '0.1.1-rc.2', true],
    ['^0.1.1-rc.2', '^0.2.0', false],
    ['^0.1.1-rc.2', '>= 0.1.1-rc.2 < 0.2.0', true],
    ['0.1.1-rc.1', '^0.1.1-rc.2', false],
    ['^0.2.0', '<0.2.5', true],
    ['0.2.5', '<0.2.5', false],
    ['0.2.5', '<=0.2.5', true],
    ['*', '1.2.3', true],
    ['1.2.3 - 2.0.0', '2.0.0', true],
    ['1.2.3 - 2.0.0', '>2.0.0', false],
    ['1.2.3 - 2.3', '2.3.9', true],
    ['1.2.3 - 2.3', '2.4.0', false],
    ['1.x', '2.0.0', false],
    ['1.2', '1.2.9', true],
    ['~1.2.3', '1.3.0', false],
    ['~1.2.3', '1.2.9', true],
    ['^1.2.3 || ^2.0.0', '1.9.9 || 2.5.0', true],
    ['^1.2.3 || ^2.0.0', '^3.0.0', false],
    ['^0.0.3', '0.0.4', false],
    ['^0', '0.9.0', true],
    ['>=2 <1', '1.5.0', false],
  ]) {
    assert.equal(rangesIntersect(left, right), expected, `${left} ∩ ${right}`)
    assert.equal(rangesIntersect(right, left), expected, `${right} ∩ ${left}`)
  }
  for (const garbage of ['latest', '~>1.2', '1.2.3.4', '^1.2.3 ||']) {
    assert.throws(() => rangesIntersect(garbage, '1.0.0'), /range|version/u, `the grammar must refuse '${garbage}'`)
  }
})
