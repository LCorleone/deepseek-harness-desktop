/**
 * accept-handoff tests: the one command that applies a verify-handoff PASS
 * verdict to the allowlist (entry + commit). Offline like the verify-handoff
 * suite — the reference measurement is stubbed, so a "PASS submission" is
 * materialized by running verifyHandoffSubmission itself against fixture
 * bytes; the git side runs against real throwaway repositories (init → seed
 * → accept), so the green path proves the actual commit (message, single-file
 * pathspec, clean tree), and every red pins its own refusal.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { acceptHandoffVerdict, canonicalJson, commitMessageFor, unifiedTextDiff } from '../lib/accept-handoff.mjs'
import { verifyHandoffSubmission } from '../lib/verify-handoff.mjs'
import { buildDeterministicTarball, REPO_ROOT } from '../lib/tarball.mjs'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA_PATH = join(TOOL_DIR, 'docs', 'handoff', 'handoff.schema.json')
const CATALOG_ORIGIN = 'https://gitlab.company.example'
const FIXED_DIGEST = 'a'.repeat(64)
const OTHER_DIGEST = 'b'.repeat(64)
const PINNED_DSH_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const PINNED_DESKTOP = '2.0.4'
const PINNED_RUNTIME_RANGE = '^0.1.2-rc.1'

// The allowlist under test lives in a throwaway git repository, committed
// under a nested path (proving the repo-relative pathspec handling).
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'catalog-accept-tests',
  GIT_AUTHOR_EMAIL: 'catalog-accept-tests@example.invalid',
  GIT_COMMITTER_NAME: 'catalog-accept-tests',
  GIT_COMMITTER_EMAIL: 'catalog-accept-tests@example.invalid',
}
const gitIn = (cwd, arguments_) => {
  const probe = spawnSync('git', arguments_, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_IDENTITY } })
  assert.equal(probe.status, 0, `git ${arguments_.join(' ')} failed: ${probe.stderr}`)
  return (probe.stdout ?? '').trim()
}

// The staged-artifact out dir must live inside the repository (the snippet
// signs a repo-relative source.path), so the fixture uses a gitignored
// directory under tools/company-catalog/out/.
const PACKAGES_ROOT = mkdtempSync(join(TOOL_DIR, 'out', 'accept-handoff-test-'))
test.after(() => {
  rmSync(PACKAGES_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fixtures (the same minimal shapes the verify-handoff suite uses)
// ---------------------------------------------------------------------------

const fileEntry = (path, data) => ({ path, type: 'file', mode: 0o644, mtime: 1234567890, data: Buffer.from(data, 'utf8') })

const compatContract = () => ({
  schemaVersion: 1,
  updated: '2026-09-06',
  dsh: { version: '0.1.1-rc.2', commit: PINNED_DSH_COMMIT, runtimeRange: PINNED_RUNTIME_RANGE },
  desktop: { version: PINNED_DESKTOP },
  catalog: { sequence: 13, manifestUrl: `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/catalog-manifest.json` },
})

function pluginTarball({ withRepository = true } = {}) {
  const manifest = {
    name: 'fixture-hello',
    version: '1.0.0',
    description: 'acceptance fixture',
    license: 'MIT',
    ...(withRepository ? { repository: { type: 'git', url: 'https://github.com/example/fixture-hello.git' } } : {}),
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  return buildDeterministicTarball([
    fileEntry('package/package.json', `${JSON.stringify(manifest, null, 2)}\n`),
    fileEntry('package/index.js', "'use strict'\nmodule.exports = { greet: () => 'hello' }\n"),
    fileEntry('package/cordis.patch.yml', '[]\n'),
  ])
}

const handoffSheet = (bytes) => ({
  schemaVersion: 2,
  plugin: { packageName: 'fixture-hello', version: '1.0.0', author: 'zhangsan', description: 'A minimal hello plugin used as the suite fixture.', type: 'tool' },
  compat: { dshRuntimeVersion: PINNED_RUNTIME_RANGE, dshCommit: PINNED_DSH_COMMIT, desktopVersion: PINNED_DESKTOP },
  artifact: { file: 'fixture-hello-1.0.0.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength },
  submitter: { name: '张三', gitlabHandle: '@zhangsan', submittedAt: '2026-09-06' },
  evidence: { summary: 'dev workspace 安装无错，设置页保存与重启后保持。', checks: ['install-in-dev-workspace', 'client-face-renders'] },
  changes: 'initial submission fixture for the accept-handoff tests',
})

/** A submission workspace whose verify run PASSes (offline stubbed measurement). */
async function verifiedSubmission({ tarball = pluginTarball(), allowlist, packagesDir, now, receiptsDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accept-handoff-sub-'))
  const submissionDir = join(root, 'submissions', 'fixture-hello-1.0.0')
  mkdirSync(submissionDir, { recursive: true })
  writeFileSync(join(submissionDir, 'fixture-hello-1.0.0.tgz'), tarball)
  writeFileSync(join(submissionDir, 'handoff.json'), `${JSON.stringify(handoffSheet(tarball), null, 2)}\n`, 'utf8')
  const compatPath = join(root, 'compat.json')
  writeFileSync(compatPath, `${JSON.stringify(compatContract(), null, 2)}\n`, 'utf8')
  const resolvedPackagesDir = packagesDir ?? join(PACKAGES_ROOT, `packages-${Math.random().toString(36).slice(2, 8)}`)
  const resolvedReceiptsDir = receiptsDir ?? join(root, 'verdict-receipts')
  const verdict = await verifyHandoffSubmission({
    submissionDir,
    schemaPath: SCHEMA_PATH,
    compatPath,
    ...(allowlist === undefined ? {} : { allowlistPath: allowlist.path }),
    packagesDir: resolvedPackagesDir,
    receiptsDir: resolvedReceiptsDir,
    ...(now === undefined ? {} : { now }),
    measureTarball: () => ({ packageName: 'fixture-hello', version: '1.0.0', treeDigest: FIXED_DIGEST }),
  })
  return { root, submissionDir, verdict, packagesDir: resolvedPackagesDir, compatPath, receiptsDir: resolvedReceiptsDir }
}

/** A throwaway git repository whose reviewed allowlist is committed at a nested path. */
function gitAllowlistRepo(entries) {
  const root = mkdtempSync(join(tmpdir(), 'accept-handoff-repo-'))
  const allowlistPath = join(root, 'tools', 'company-catalog', 'allowlist.json')
  mkdirSync(dirname(allowlistPath), { recursive: true })
  writeFileSync(allowlistPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  gitIn(root, ['init'])
  gitIn(root, ['add', '--', '.'])
  gitIn(root, ['commit', '-m', 'chore: seed the reviewed allowlist'])
  return { root, path: allowlistPath }
}

const OLD_ACTIVE_ENTRY = {
  packageName: 'fixture-hello',
  version: '0.9.0',
  bundlePatch: './cordis.patch.yml',
  repository: 'https://github.com/example/fixture-hello',
  revoked: false,
  runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
}

const accept = (options) => acceptHandoffVerdict({ companyCatalogOrigin: CATALOG_ORIGIN, ...options })
const refusalOf = async (run) => {
  try {
    await run()
  } catch (error) {
    return error
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Green: the happy path
// ---------------------------------------------------------------------------

test('green: a PASS verdict replaces the old version, commits allowlist.json alone, and reports next steps', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  const logLines = []
  try {
    assert.equal(submission.verdict.ok, true, JSON.stringify(submission.verdict.steps, null, 2))
    assert.equal(submission.verdict.verdictJsonPath, join(submission.submissionDir, 'verdict.json'))
    const result = accept({
      submissionDir: submission.submissionDir,
      allowlistPath: allowlist.path,
      receiptsDir: submission.receiptsDir,
      gitEnv: GIT_IDENTITY,
      log: (line) => logLines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.alreadyAccepted, undefined)
    assert.equal(result.dryRun, false)
    assert.deepEqual(result.replaced, ['fixture-hello@0.9.0'])
    assert.deepEqual(result.keptRevoked, [])
    assert.equal(result.message, 'catalog: accept fixture-hello@1.0.0 (staging handoff)')
    // The allowlist now carries exactly one fixture-hello entry: 1.0.0, with
    // the measured digest, the tarball channel, and the repo-relative staged path.
    const entries = JSON.parse(readFileSync(allowlist.path, 'utf8'))
    assert.equal(entries.length, 1)
    assert.equal(entries[0].packageName, 'fixture-hello')
    assert.equal(entries[0].version, '1.0.0')
    assert.equal(entries[0].treeDigest, FIXED_DIGEST)
    assert.equal(entries[0].repository, 'https://github.com/example/fixture-hello')
    assert.equal(entries[0].source.kind, 'tarball')
    assert.equal(entries[0].source.url, `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/packages/fixture-hello-1.0.0.tgz`)
    assert.match(entries[0].source.path, /^tools\/company-catalog\/out\/accept-handoff-test-[^/]+\/packages-[^/]+\/fixture-hello-1\.0\.0\.tgz$/u)
    assert.equal(entries[0].runtime.dshRuntimeVersion, PINNED_RUNTIME_RANGE)
    // The commit: exact message, exactly the one file, clean tree afterwards.
    assert.match(result.commitSha, /^[0-9a-f]{7,40}$/u)
    assert.equal(gitIn(allowlist.root, ['log', '-1', '--format=%s']), result.message)
    assert.equal(gitIn(allowlist.root, ['show', '--name-only', '--format=', 'HEAD']), 'tools/company-catalog/allowlist.json')
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
    assert.equal(gitIn(allowlist.root, ['rev-parse', 'HEAD']), gitIn(allowlist.root, ['rev-parse', result.commitSha]))
    // The terminal log tells the two-step story (beta first).
    assert.match(logLines.join('\n'), /replaces fixture-hello@0\.9\.0/u)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('green: re-accepting the same verdict is an idempotent no-op (no second commit)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY })
    const headAfterFirst = gitIn(allowlist.root, ['rev-parse', 'HEAD'])
    const again = accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY })
    assert.equal(again.alreadyAccepted, true)
    assert.equal(again.commitSha, undefined)
    assert.equal(gitIn(allowlist.root, ['rev-parse', 'HEAD']), headAfterFirst)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('green: --repository fills the missing pin (verified snippet carried none)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ tarball: pluginTarball({ withRepository: false }), allowlist })
  try {
    assert.equal(submission.verdict.ok, true)
    assert.equal(submission.verdict.allowlistEntry.repository, undefined)
    assert.equal(submission.verdict.allowlistWarnings.length, 1)
    const result = accept({
      submissionDir: submission.submissionDir,
      allowlistPath: allowlist.path,
      receiptsDir: submission.receiptsDir,
      gitEnv: GIT_IDENTITY,
      repository: 'https://github.com/example/fixture-hello',
    })
    assert.equal(result.ok, true)
    const entries = JSON.parse(readFileSync(allowlist.path, 'utf8'))
    assert.equal(entries[0].repository, 'https://github.com/example/fixture-hello')
    // An npm-style spelling normalizes to the same signed form.
    const npmSpelling = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
    const npmSubmission = await verifiedSubmission({ tarball: pluginTarball({ withRepository: false }), allowlist: { path: npmSpelling.path } })
    try {
      const normalized = accept({
        submissionDir: npmSubmission.submissionDir,
        allowlistPath: npmSpelling.path,
        receiptsDir: npmSubmission.receiptsDir,
        gitEnv: GIT_IDENTITY,
        repository: 'git+https://github.com/example/fixture-hello.git',
      })
      assert.equal(normalized.entry.repository, 'https://github.com/example/fixture-hello')
    } finally {
      rmSync(npmSubmission.root, { recursive: true, force: true })
      rmSync(npmSpelling.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('green: a revoked older version stays verbatim for the audit trail while the active entry is replaced', async () => {
  const allowlist = gitAllowlistRepo([{ ...OLD_ACTIVE_ENTRY, revoked: true }])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const result = accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY })
    assert.equal(result.ok, true)
    assert.deepEqual(result.replaced, [])
    assert.deepEqual(result.keptRevoked, ['fixture-hello@0.9.0'])
    const entries = JSON.parse(readFileSync(allowlist.path, 'utf8'))
    assert.equal(entries.length, 2)
    const active = entries.find((entry) => !entry.revoked)
    const revoked = entries.find((entry) => entry.revoked)
    assert.equal(`${active.packageName}@${active.version}`, 'fixture-hello@1.0.0')
    assert.equal(`${revoked.packageName}@${revoked.version}`, 'fixture-hello@0.9.0')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('green: a brand-new package appends without replacing anything', async () => {
  const otherEntry = {
    packageName: 'dsh-other-plugin',
    version: '2.3.4',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/other',
    revoked: false,
    runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
  }
  const allowlist = gitAllowlistRepo([otherEntry])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const result = accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY })
    assert.equal(result.ok, true)
    assert.deepEqual(result.replaced, [])
    const entries = JSON.parse(readFileSync(allowlist.path, 'utf8'))
    assert.equal(entries.length, 2)
    assert.equal(entries[1].packageName, 'fixture-hello')
    assert.equal(entries[0].packageName, 'dsh-other-plugin')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Reds: the receipt gate (no verdict / FAIL / stale / forged receipts)
// ---------------------------------------------------------------------------

test('red: no verdict at all refuses with the run-verify-handoff pointer', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    rmSync(join(submission.submissionDir, 'verdict.md'))
    rmSync(join(submission.submissionDir, 'verdict.json'))
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /no verdict .* — run verify-handoff on the submission first/u)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a FAIL verdict refuses (fail-closed; only PASS applies)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  // A submission whose sheet lies about the artifact hash fails step 2.
  const root = mkdtempSync(join(tmpdir(), 'accept-handoff-sub-'))
  const submissionDir = join(root, 'submissions', 'fixture-hello-1.0.0')
  mkdirSync(submissionDir, { recursive: true })
  const bytes = pluginTarball()
  writeFileSync(join(submissionDir, 'fixture-hello-1.0.0.tgz'), bytes)
  const sheet = handoffSheet(bytes)
  sheet.artifact.sha256 = 'f'.repeat(64)
  writeFileSync(join(submissionDir, 'handoff.json'), `${JSON.stringify(sheet, null, 2)}\n`, 'utf8')
  const compatPath = join(root, 'compat.json')
  writeFileSync(compatPath, `${JSON.stringify(compatContract(), null, 2)}\n`, 'utf8')
  try {
    const verdict = await verifyHandoffSubmission({
      submissionDir,
      schemaPath: SCHEMA_PATH,
      compatPath,
      allowlistPath: allowlist.path,
      packagesDir: join(PACKAGES_ROOT, `packages-${Math.random().toString(36).slice(2, 8)}`),
      measureTarball: () => ({ packageName: 'fixture-hello', version: '1.0.0', treeDigest: FIXED_DIGEST }),
    })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.failedStep.step, 'artifact-integrity')
    const error = await refusalOf(() => accept({ submissionDir, allowlistPath: allowlist.path, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /the recorded verdict is FAIL \(2\/10 artifact-integrity\)/u)
    assert.match(error.message, /re-run verify-handoff/u)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: the tgz swapped after verification refuses (freshness recheck)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    // Size branch: appended bytes change the length first.
    writeFileSync(join(submission.submissionDir, 'fixture-hello-1.0.0.tgz'), Buffer.concat([pluginTarball(), Buffer.from('\nswapped after verification\n')]))
    const sizeError = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(sizeError.message, /submission changed after verification .* is 395 bytes but the verdict recorded 367; re-run verify-handoff/us)
    // Hash branch: same length, different bytes.
    const swapped = pluginTarball()
    swapped[20] ^= 0xff
    writeFileSync(join(submission.submissionDir, 'fixture-hello-1.0.0.tgz'), swapped)
    const hashError = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(hashError.message, /submission changed after verification .* hashes to [0-9a-f]{64} but the verdict recorded [0-9a-f]{64}; re-run verify-handoff/us)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a PASS verdict.md without verdict.json (an older verify run) refuses', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    rmSync(join(submission.submissionDir, 'verdict.json'))
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /verdict\.json is missing while verdict\.md says PASS .* re-run verify-handoff/us)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a hand-edited receipt refuses at the local-record gate (the bytes are no longer the ones verify issued)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const receiptPath = join(submission.submissionDir, 'verdict.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    receipt.allowlistEntry.version = '9.9.9'
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /receipt not issued by a local verify-handoff run — run verify-handoff on this machine first/u)
    assert.match(error.message, /hashes to [0-9a-f]{64} but the local record pins [0-9a-f]{64}/u)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a hand-edited receipt whose fingerprints still match (a forged record) hits the entry cross-check and refuses', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    // The attacker model here: local write access to the record channel —
    // the gate passes (fingerprint + generatedAt match the forged bytes),
    // so the deeper cross-check must refuse the inconsistent receipt.
    const receiptPath = join(submission.submissionDir, 'verdict.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    receipt.allowlistEntry.version = '9.9.9'
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`
    writeFileSync(receiptPath, receiptText, 'utf8')
    const record = JSON.parse(readFileSync(join(submission.receiptsDir, 'fixture-hello-1.0.0.json'), 'utf8'))
    record.fingerprint = createHash('sha256').update(receiptText, 'utf8').digest('hex')
    writeFileSync(join(submission.receiptsDir, 'fixture-hello-1.0.0.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /the receipt is inconsistent .* re-run verify-handoff/us)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a FAIL verdict.json beside a PASS verdict.md refuses (the pair must agree)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const receiptPath = join(submission.submissionDir, 'verdict.json')
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    receipt.ok = false
    receipt.failedStep = { index: 7, step: 'tree-digest', reason: 'forged' }
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /FAIL/u)
    assert.match(error.message, /re-run verify-handoff/u)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Reds: the local receipt record — the trust anchor before every other gate
// (a forged receipt pair + matching tgz is exactly what a forged submission
// carries; only the sha256 a local verify-handoff run recorded accepts it)
// ---------------------------------------------------------------------------

test('red: a pre-forged self-consistent PASS receipt pair (matching tgz, no local record) refuses', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  // Hand-built, never touched by verify-handoff on this machine: the tgz
  // matches the receipt's fingerprint, verdict.md agrees with verdict.json,
  // the entry is internally consistent — every LATER gate would pass it.
  const root = mkdtempSync(join(tmpdir(), 'accept-handoff-forged-'))
  const submissionDir = join(root, 'submissions', 'fixture-hello-1.0.0')
  mkdirSync(submissionDir, { recursive: true })
  const bytes = pluginTarball()
  writeFileSync(join(submissionDir, 'fixture-hello-1.0.0.tgz'), bytes)
  writeFileSync(join(submissionDir, 'handoff.json'), `${JSON.stringify(handoffSheet(bytes), null, 2)}\n`, 'utf8')
  const generatedAt = '2026-09-06T02:03:04.000Z'
  const receipt = {
    ok: true,
    generatedAt,
    identity: { packageName: 'fixture-hello', version: '1.0.0' },
    artifact: { file: 'fixture-hello-1.0.0.tgz', sizeBytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') },
    treeDigest: FIXED_DIGEST,
    allowlistEntry: {
      packageName: 'fixture-hello',
      version: '1.0.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/fixture-hello',
      revoked: false,
      runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
      source: {
        kind: 'tarball',
        url: `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/packages/fixture-hello-1.0.0.tgz`,
        path: 'tools/company-catalog/out/packages/fixture-hello-1.0.0.tgz',
      },
      treeDigest: FIXED_DIGEST,
    },
  }
  writeFileSync(join(submissionDir, 'verdict.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  writeFileSync(join(submissionDir, 'verdict.md'), [
    '# verify-handoff · PASS',
    '',
    `- 提交（submission）：\`${submissionDir}\``,
    `- 校验时间（checked）：${generatedAt}`,
    `- 身份（identity）：fixture-hello@1.0.0`,
    '',
  ].join('\n'), 'utf8')
  const receiptsDir = join(root, 'empty-verdict-receipts')
  try {
    const headBefore = gitIn(allowlist.root, ['rev-parse', 'HEAD'])
    const error = await refusalOf(() => accept({ submissionDir, allowlistPath: allowlist.path, receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /receipt not issued by a local verify-handoff run — run verify-handoff on this machine first/u)
    assert.match(error.message, /no receipt record in .*empty-verdict-receipts/u)
    // Nothing was applied and nothing was written.
    assert.equal(gitIn(allowlist.root, ['rev-parse', 'HEAD']), headBefore)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a verdict.json swapped for another run\'s after the local verify refuses (the TOCTOU window)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    // Run A's receipt bytes, saved before a second local run overwrites them.
    const verdictJsonPath = join(submission.submissionDir, 'verdict.json')
    const runAJson = readFileSync(verdictJsonPath, 'utf8')
    const runB = await verifyHandoffSubmission({
      submissionDir: submission.submissionDir,
      schemaPath: SCHEMA_PATH,
      compatPath: submission.compatPath,
      allowlistPath: allowlist.path,
      packagesDir: submission.packagesDir,
      receiptsDir: submission.receiptsDir,
      now: new Date('2026-09-06T09:00:00.000Z'),
      measureTarball: () => ({ packageName: 'fixture-hello', version: '1.0.0', treeDigest: FIXED_DIGEST }),
    })
    assert.equal(runB.ok, true)
    // The local record now pins run B's fingerprint — put run A's verdict.json
    // back into the directory: internally it is a perfectly good receipt of
    // a real local run, but it is not the run the record pins.
    writeFileSync(verdictJsonPath, runAJson, 'utf8')
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /receipt not issued by a local verify-handoff run — run verify-handoff on this machine first/u)
    assert.match(error.message, /verdict\.json hashes to [0-9a-f]{64} but the local record pins [0-9a-f]{64}/u)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: verdict.md from one run stitched with verdict.json from another refuses (the pair must be same-run)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    // Two real local runs of the same submission (different clocks → different
    // generatedAt). The local record and the directory's verdict.json both
    // come from run B — the gate correctly passes — but verdict.md is run A's:
    // only the md↔json agreement check can catch the stitched pair.
    const verdictMdPath = join(submission.submissionDir, 'verdict.md')
    const runAMd = readFileSync(verdictMdPath, 'utf8')
    const runB = await verifyHandoffSubmission({
      submissionDir: submission.submissionDir,
      schemaPath: SCHEMA_PATH,
      compatPath: submission.compatPath,
      allowlistPath: allowlist.path,
      packagesDir: submission.packagesDir,
      receiptsDir: submission.receiptsDir,
      now: new Date('2026-09-06T10:00:00.000Z'),
      measureTarball: () => ({ packageName: 'fixture-hello', version: '1.0.0', treeDigest: FIXED_DIGEST }),
    })
    assert.equal(runB.ok, true)
    assert.notEqual(runB.generatedAt, submission.verdict.generatedAt)
    writeFileSync(verdictMdPath, runAMd, 'utf8')
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /verdict\.md and verdict\.json carry different verification timestamps — they do not come from the same run; re-run verify-handoff/u)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('green: the normal verify→accept flow passes the local-record gate on the verifying machine', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    // The record the verify run wrote is exactly what the gate wants…
    assert.equal(existsSync(join(submission.receiptsDir, 'fixture-hello-1.0.0.json')), true)
    const result = accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY })
    assert.equal(result.ok, true)
    assert.match(result.commitSha, /^[0-9a-f]{7,40}$/u)
    // …and pointing accept at any other record channel still refuses: the
    // gate is bound to THIS machine's records, not to the receipt's content.
    const elsewhere = await refusalOf(() => accept({
      submissionDir: submission.submissionDir,
      allowlistPath: allowlist.path,
      receiptsDir: join(submission.root, 'other-receipts'),
      gitEnv: GIT_IDENTITY,
    }))
    assert.match(elsewhere.message, /receipt not issued by a local verify-handoff run/u)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Reds: the entry gate (missing repository / immutability / un-revoking)
// ---------------------------------------------------------------------------

test('red: a missing repository pin without --repository refuses, naming the flag', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ tarball: pluginTarball({ withRepository: false }), allowlist })
  try {
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /carries no repository pin .* pass --repository <https-url>/us)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
    // An unusable flag value is its own refusal.
    const badFlag = await refusalOf(() => accept({
      submissionDir: submission.submissionDir,
      allowlistPath: allowlist.path,
      receiptsDir: submission.receiptsDir,
      gitEnv: GIT_IDENTITY,
      repository: 'ftp://not-https.example/x',
    }))
    assert.match(badFlag.message, /--repository 'ftp:\/\/not-https\.example\/x' is not a credential-free https URL/u)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: same name@version already listed with a different treeDigest refuses (immutability)', async () => {
  const allowlist = gitAllowlistRepo([{ ...OLD_ACTIVE_ENTRY, version: '1.0.0', treeDigest: OTHER_DIGEST }])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /fixture-hello@1\.0\.0 is already listed with treeDigest b{64} but the verdict measured a{64}/u)
    assert.match(error.message, /immutable.*bump the version/us)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a revoked same name@version refuses (accept-handoff never un-revokes)', async () => {
  const allowlist = gitAllowlistRepo([{ ...OLD_ACTIVE_ENTRY, version: '1.0.0', revoked: true, treeDigest: FIXED_DIGEST }])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /fixture-hello@1\.0\.0 is revoked in the allowlist — accept-handoff never un-revokes/u)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Idempotency across key orders (hand-written history entries) and the
// minimal-diff write
// ---------------------------------------------------------------------------

test('red: re-accepting the reviewed entry spelled in another key order is a canonical no-op (no key-reordering commit)', async () => {
  // The reviewed entry spells `source` before `treeDigest` — the key order
  // of the hand-written dsh-free-search@0.4.183 entry in the real allowlist,
  // which differs from the normalizer's output order. A same-content replay
  // must be a no-op: zero commits, zero byte changes.
  const packagesDir = join(PACKAGES_ROOT, `packages-${Math.random().toString(36).slice(2, 8)}`)
  const sourcePath = `${relative(REPO_ROOT, packagesDir).split('\\').join('/')}/fixture-hello-1.0.0.tgz`
  const reviewedEntry = {
    packageName: 'fixture-hello',
    version: '1.0.0',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/fixture-hello',
    revoked: false,
    runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
    source: {
      kind: 'tarball',
      url: `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/raw/master/packages/fixture-hello-1.0.0.tgz`,
      path: sourcePath,
    },
    treeDigest: FIXED_DIGEST,
  }
  assert.ok(Object.keys(reviewedEntry).indexOf('source') < Object.keys(reviewedEntry).indexOf('treeDigest'), 'fixture premise: source precedes treeDigest')
  const allowlist = gitAllowlistRepo([reviewedEntry])
  const submission = await verifiedSubmission({ allowlist, packagesDir })
  try {
    assert.equal(submission.verdict.ok, true)
    const bytesBefore = readFileSync(allowlist.path, 'utf8')
    const headBefore = gitIn(allowlist.root, ['rev-parse', 'HEAD'])
    const result = accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY })
    assert.equal(result.ok, true)
    assert.equal(result.alreadyAccepted, true)
    assert.equal(result.commitSha, undefined)
    assert.equal(readFileSync(allowlist.path, 'utf8'), bytesBefore, 'zero byte changes — key order is not a change')
    assert.equal(gitIn(allowlist.root, ['rev-parse', 'HEAD']), headBefore, 'no key-reordering commit')
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('green: a real write keeps the reviewed key order (untouched entries verbatim, the applied entry inherits the replaced order)', async () => {
  // Two reviewed entries with a non-normalizer key order (`revoked` after
  // `runtime`): the write must carry the version change alone.
  const otherEntry = {
    packageName: 'dsh-other-plugin',
    version: '2.3.4',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/other',
    runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
    revoked: false,
  }
  const oldActive = {
    packageName: 'fixture-hello',
    version: '0.9.0',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/fixture-hello',
    runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
    revoked: false,
  }
  const allowlist = gitAllowlistRepo([otherEntry, oldActive])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const result = accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY })
    assert.equal(result.ok, true)
    const entries = JSON.parse(readFileSync(allowlist.path, 'utf8'))
    assert.equal(entries.length, 2)
    // The untouched entry keeps its reviewed spelling byte-for-byte.
    const other = entries.find((entry) => entry.packageName === 'dsh-other-plugin')
    assert.deepEqual(Object.keys(other), Object.keys(otherEntry))
    // The applied entry inherits the replaced entry's field order (revoked
    // after runtime), with its new fields (treeDigest, source) appended.
    const applied = entries.find((entry) => entry.packageName === 'fixture-hello')
    assert.deepEqual(Object.keys(applied), [...Object.keys(oldActive), 'treeDigest', 'source'])
    assert.equal(applied.version, '1.0.0')
    assert.equal(applied.treeDigest, FIXED_DIGEST)
    assert.equal(applied.source.kind, 'tarball')
    // And the commit is exactly the one file.
    assert.equal(gitIn(allowlist.root, ['show', '--name-only', '--format=', 'HEAD']), 'tools/company-catalog/allowlist.json')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Reds: dry-run and the git fail-closed paths
// ---------------------------------------------------------------------------

test('red: --dry-run prints the entry and the diff but touches no file and commits nothing', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const headBefore = gitIn(allowlist.root, ['rev-parse', 'HEAD'])
    const bytesBefore = readFileSync(allowlist.path, 'utf8')
    const logLines = []
    const result = accept({
      submissionDir: submission.submissionDir,
      allowlistPath: allowlist.path,
      receiptsDir: submission.receiptsDir,
      dryRun: true,
      log: (line) => logLines.push(line),
    })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.commitSha, undefined)
    assert.equal(readFileSync(allowlist.path, 'utf8'), bytesBefore)
    assert.equal(gitIn(allowlist.root, ['rev-parse', 'HEAD']), headBefore)
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
    const printed = logLines.join('\n')
    assert.match(printed, /the entry that would be written:/u)
    assert.match(printed, /"packageName": "fixture-hello"/u)
    assert.match(printed, /"treeDigest": "a{64}"/u)
    assert.match(printed, /^@@ -\d+,\d+ \+\d+,\d+ @@$/mu)
    assert.match(printed, /-    "version": "0\.9\.0"/u)
    assert.match(printed, /\+    "version": "1\.0\.0"/u)
    assert.match(printed, /dry-run: .* untouched, nothing committed/u)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: no git available fails closed and writes nothing (the CI case)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    const bytesBefore = readFileSync(allowlist.path, 'utf8')
    const error = await refusalOf(() => accept({
      submissionDir: submission.submissionDir,
      allowlistPath: allowlist.path,
      receiptsDir: submission.receiptsDir,
      git: () => ({ status: null, stdout: '', stderr: '', error: 'spawn git ENOENT' }),
    }))
    assert.match(error.message, /git is not available .* fail-closes where git is missing/us)
    assert.equal(readFileSync(allowlist.path, 'utf8'), bytesBefore)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: an allowlist with uncommitted changes refuses (nothing swept into the acceptance commit)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  try {
    // Local, unreviewed edits sitting in the worktree: they must never ride
    // the `catalog: accept …` commit silently.
    const dirtyEntries = [OLD_ACTIVE_ENTRY, {
      packageName: 'dsh-sneaky-plugin',
      version: '9.9.9',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/sneaky',
      revoked: false,
      runtime: { dshRuntimeVersion: PINNED_RUNTIME_RANGE },
    }]
    const dirtyText = `${JSON.stringify(dirtyEntries, null, 2)}\n`
    writeFileSync(allowlist.path, dirtyText, 'utf8')
    const headBefore = gitIn(allowlist.root, ['rev-parse', 'HEAD'])
    const error = await refusalOf(() => accept({ submissionDir: submission.submissionDir, allowlistPath: allowlist.path, receiptsDir: submission.receiptsDir, gitEnv: GIT_IDENTITY }))
    assert.match(error.message, /allowlist has uncommitted changes — commit or stash first/u)
    assert.match(error.message, /nothing was applied/u)
    // The dirty bytes are untouched — not applied, not committed, not reverted.
    assert.equal(readFileSync(allowlist.path, 'utf8'), dirtyText)
    assert.equal(gitIn(allowlist.root, ['rev-parse', 'HEAD']), headBefore)
    assert.match(gitIn(allowlist.root, ['status', '--porcelain']), /allowlist\.json/u)
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

test('red: a commit failure after the write restores the previous bytes (fail-atomic)', async () => {
  const allowlist = gitAllowlistRepo([OLD_ACTIVE_ENTRY])
  const submission = await verifiedSubmission({ allowlist })
  const bytesBefore = readFileSync(allowlist.path, 'utf8')
  const realGit = (arguments_, options) => spawnSync('git', arguments_, {
    cwd: options?.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(options?.env ?? {}) },
  })
  try {
    const error = await refusalOf(() => accept({
      submissionDir: submission.submissionDir,
      allowlistPath: allowlist.path,
      receiptsDir: submission.receiptsDir,
      gitEnv: GIT_IDENTITY,
      git: (arguments_, options) => {
        if (arguments_[0] === 'commit') return { status: 128, stdout: '', stderr: 'fatal: empty ident name not allowed' }
        const probe = realGit(arguments_, options)
        return probe.error !== undefined
          ? { status: null, stdout: '', stderr: '', error: probe.error.message }
          : { status: probe.status, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '' }
      },
    }))
    assert.match(error.message, /the allowlist was written but its commit failed .* previous bytes were restored/us)
    assert.equal(readFileSync(allowlist.path, 'utf8'), bytesBefore)
    // The staged pathspec was unstaged too: the tree reports clean.
    assert.equal(gitIn(allowlist.root, ['status', '--porcelain']), '')
  } finally {
    rmSync(submission.root, { recursive: true, force: true })
    rmSync(allowlist.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Unit pins: the message template and the diff helper
// ---------------------------------------------------------------------------

test('the commit message template is pinned', () => {
  assert.equal(commitMessageFor({ packageName: 'fixture-hello', version: '1.0.0' }), 'catalog: accept fixture-hello@1.0.0 (staging handoff)')
  assert.equal(commitMessageFor({ packageName: '@company/scoped-plugin', version: '0.9.0' }), 'catalog: accept @company/scoped-plugin@0.9.0 (staging handoff)')
})

test('the canonical comparison: key order never counts, content and array order do', () => {
  // The dsh-free-search@0.4.183 spelling (source before treeDigest) against
  // the normalizer's (treeDigest before source) — same entry.
  assert.equal(
    canonicalJson({ packageName: 'dsh-free-search', version: '0.4.183', source: { kind: 'tarball', url: 'u', path: 'p' }, treeDigest: 'd' }),
    canonicalJson({ packageName: 'dsh-free-search', version: '0.4.183', treeDigest: 'd', source: { path: 'p', url: 'u', kind: 'tarball' } }),
  )
  assert.notEqual(canonicalJson({ treeDigest: 'a'.repeat(64) }), canonicalJson({ treeDigest: 'b'.repeat(64) }))
  assert.notEqual(canonicalJson([{ v: 1 }, { w: 2 }]), canonicalJson([{ w: 2 }, { v: 1 }]), 'array order is significant')
  assert.equal(canonicalJson(null), 'null')
  assert.equal(canonicalJson('x'), '"x"')
})

test('the dry-run diff helper: hunks, context, and the identical-text null', () => {
  const before = ['[', '  {', '    "a": 1,', '    "b": 2,', '    "c": 3,', '    "d": 4,', '    "e": 5,', '    "f": 6,', '    "g": 7,', '    "h": 8', '  }', ']', ''].join('\n')
  const after = ['[', '  {', '    "a": 1,', '    "b": 2,', '    "c": 3,', '    "d": 4,', '    "e": 5,', '    "f": 6,', '    "g": 7,', '    "h": 88', '  }', ']', ''].join('\n')
  assert.equal(unifiedTextDiff(before, before, { fromLabel: 'x', toLabel: 'x' }), null)
  const diff = unifiedTextDiff(before, after, { fromLabel: 'a/allowlist.json', toLabel: 'b/allowlist.json' }).split('\n')
  assert.equal(diff[0], '--- a/allowlist.json')
  assert.equal(diff[1], '+++ b/allowlist.json')
  // The change sits on line 10; three lines of context on each side fold it
  // into one hunk covering lines 7–12 (standard unified shape).
  assert.equal(diff[2], '@@ -7,6 +7,6 @@')
  assert.deepEqual(diff.slice(3), [
    '     "e": 5,',
    '     "f": 6,',
    '     "g": 7,',
    '-    "h": 8',
    '+    "h": 88',
    '   }',
    ' ]',
  ])
  // A pure insertion keeps the surrounding context in the hunk.
  const inserted = unifiedTextDiff('a\nb\nc\n', 'a\nb\nX\nc\n', { fromLabel: 'l', toLabel: 'r' }).split('\n')
  assert.equal(inserted[2], '@@ -1,3 +1,4 @@')
  assert.deepEqual(inserted.slice(3), [' a', ' b', '+X', ' c'])
})
