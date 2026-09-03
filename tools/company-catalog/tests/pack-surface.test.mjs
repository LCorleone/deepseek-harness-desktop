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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('measure --tarball is not combinable with --allowlist', () => {
  const result = run(MEASURE, ['--tarball', join(FIXTURE, '..', 'fixture-hello-1.0.0.tgz'), '--allowlist', join(TOOL_DIR, 'allowlist.json')])
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /do not combine/u)
})
