/**
 * `pack-tarball` command surface (P7 2b): the CLI entry that turns a patched
 * plugin source (or a registry version plus a patch) into the deterministic
 * npm-compatible .tgz, computes its sha512, and (by default) measures the
 * treeDigest. These tests run the real command offline against the in-repo
 * fixture with `--no-measure` (the treeDigest reference install needs the
 * built desktop lib + pinned pnpm — that is the e2e-tarball drill), so they
 * pin the deterministic container, the pack record sidecar, and the reviewed
 * allowlist source block. The measure command's input surface is covered as
 * a negative (its `--tarball` mode is not combinable with `--allowlist`).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// tools/company-catalog/tests → tools/company-catalog → tools → repository root.
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
const CLI = join(TOOL_DIR, 'cli.mjs')
const MEASURE = join(TOOL_DIR, 'measure.mjs')
const FIXTURE = join(TOOL_DIR, 'fixtures', 'fixture-hello')
const ORIGIN = 'https://gitlab.company.example'
const PROJECT = 'julu/dsh-desktop-config'

const run = (script, args, { cwd = REPO_ROOT, env = {} } = {}) => {
  const probe = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env }, timeout: 120_000 })
  return { status: probe.status, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '' }
}

test('pack-tarball --source-dir packs a deterministic artifact and emits the allowlist source block', () => {
  const workspace = mkdtempSync(join(TOOL_DIR, 'out', 'pack-surface-src-'))
  try {
    const packOut = join(workspace, 'packages')
    const result = run(CLI, ['pack-tarball', '--source-dir', FIXTURE, '--pack-out', packOut, '--no-measure', '--catalog-origin', ORIGIN])
    assert.equal(result.status, 0, `pack-tarball exited ${String(result.status)}:\n${result.stderr}`)
    const recordPath = join(packOut, 'fixture-hello-1.0.0.tgz.pack.json')
    assert.equal(existsSync(recordPath), true, 'pack-tarball wrote no pack record sidecar')
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(record.packageName, 'fixture-hello')
    assert.equal(record.version, '1.0.0')
    assert.equal(record.filename, 'fixture-hello-1.0.0.tgz')
    assert.equal(record.fileCount, 4)
    // The path is the repo-relative spelling (the signable form), never absolute.
    assert.equal(record.path.startsWith('/'), false)
    assert.equal(record.path.endsWith('fixture-hello-1.0.0.tgz'), true)
    assert.equal(existsSync(join(REPO_ROOT, record.path)), true, 'the repo-relative path does not resolve from the repository root')
    const tarballBytes = readFileSync(join(REPO_ROOT, record.path))
    assert.equal(record.integrity, `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`)
    assert.equal(record.sizeBytes, tarballBytes.byteLength)
    // The reviewed source block names the hosted raw url and the pack path.
    assert.match(result.stdout, new RegExp(`"url":"${ORIGIN}/${PROJECT}/-/raw/master/packages/fixture-hello-1\\.0\\.0\\.tgz"`, 'u'))
    assert.match(result.stdout, new RegExp(`"path":"${record.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'u'))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('pack-tarball re-packing the same source yields byte-identical artifacts', () => {
  const workspace = mkdtempSync(join(TOOL_DIR, 'out', 'pack-surface-det-'))
  try {
    const a = join(workspace, 'a')
    const b = join(workspace, 'b')
    for (const packOut of [a, b]) {
      const result = run(CLI, ['pack-tarball', '--source-dir', FIXTURE, '--pack-out', packOut, '--no-measure', '--catalog-origin', ORIGIN])
      assert.equal(result.status, 0, `pack-tarball exited ${String(result.status)}:\n${result.stderr}`)
    }
    assert.deepEqual(readFileSync(join(a, 'fixture-hello-1.0.0.tgz')), readFileSync(join(b, 'fixture-hello-1.0.0.tgz')))
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('pack-tarball takes exactly one input mode and refuses a mixture', () => {
  const result = run(CLI, ['pack-tarball', '--source-dir', FIXTURE, '--npm', 'fixture-hello@1.0.0', '--no-measure'])
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /pack-tarball takes exactly one input mode/u)
})

/** A sources-root workspace whose <stem>/ directory carries the given declaration. */
function stageSourcesRoot(patchDeclaration) {
  const workspace = mkdtempSync(join(TOOL_DIR, 'out', 'pack-surface-allowlist-'))
  const sourcesRoot = join(workspace, 'sources')
  const stem = 'fixture-drift-1.0.0'
  cpSync(FIXTURE, join(sourcesRoot, stem), { recursive: true })
  const pkgPath = join(sourcesRoot, stem, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, name: 'fixture-drift', version: '1.0.0', dsh: { bundle: { patch: patchDeclaration } } }, null, 2)}\n`)
  const entry = {
    packageName: 'fixture-drift',
    version: '1.0.0',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/fixture-drift',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    source: { kind: 'tarball', url: `${ORIGIN}/${PROJECT}/-/raw/master/packages/fixture-drift-1.0.0.tgz`, path: 'tools/company-catalog/out/packages/fixture-drift-1.0.0.tgz' },
  }
  const allowlistPath = join(workspace, 'allowlist.json')
  writeFileSync(allowlistPath, `${JSON.stringify([entry], null, 2)}\n`)
  return { workspace, sourcesRoot, allowlistPath, outDir: join(workspace, 'packages') }
}

test('pack-tarball --from-allowlist refuses an entry whose source declares a drifted bundle patch (and never emits the artifact)', () => {
  // The 0.4.181 real-incident shape: the package declares the upstream bare
  // spelling, the reviewed entry the ecosystem './' spelling. Individually
  // both pass path validation; the desktop's post-install assert compares
  // them strictly, so the pipeline must refuse the artifact at pack time.
  const { workspace, sourcesRoot, allowlistPath, outDir } = stageSourcesRoot('cordis.patch.yml')
  try {
    const result = run(CLI, [
      'pack-tarball', '--from-allowlist',
      '--allowlist', allowlistPath,
      '--sources-root', sourcesRoot,
      '--pack-out', outDir,
      '--no-measure',
      '--catalog-origin', ORIGIN,
    ])
    assert.notEqual(result.status, 0, 'the drifted pack must fail the command')
    const output = result.stdout + result.stderr
    assert.match(output, /fixture-drift@1\.0\.0 declares "cordis\.patch\.yml"/u, 'the refusal must name the declared spelling')
    assert.match(output, /the allowlist entry bundlePatch is "\.\/cordis\.patch\.yml"/u, 'the refusal must name the entry spelling')
    assert.match(output, /byte-identical/u)
    assert.equal(existsSync(join(outDir, 'fixture-drift-1.0.0.tgz')), false, 'no artifact may be produced for a drifted entry')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('pack-tarball --from-allowlist packs the aligned shape and records the declared bundle patch', () => {
  const { workspace, sourcesRoot, allowlistPath, outDir } = stageSourcesRoot('./cordis.patch.yml')
  try {
    const result = run(CLI, [
      'pack-tarball', '--from-allowlist',
      '--allowlist', allowlistPath,
      '--sources-root', sourcesRoot,
      '--pack-out', outDir,
      '--no-measure',
      '--catalog-origin', ORIGIN,
    ])
    assert.equal(result.status, 0, `the aligned pack must succeed:\n${result.stderr}`)
    const record = JSON.parse(readFileSync(join(outDir, 'fixture-drift-1.0.0.tgz.pack.json'), 'utf8'))
    assert.equal(record.bundlePatch, './cordis.patch.yml', 'the pack record carries the declared (and gate-checked) spelling')
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('measure --tarball is not combinable with --allowlist', () => {
  const result = run(MEASURE, ['--tarball', join(FIXTURE, '..', 'fixture-hello-1.0.0.tgz'), '--allowlist', join(TOOL_DIR, 'allowlist.json')])
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /do not combine/u)
})
