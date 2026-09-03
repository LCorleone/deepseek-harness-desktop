/**
 * Tarball-channel allowlist + artifact-resolution tests (P7 2b): the
 * `source:{kind:'tarball', path, url}` pack-artifact form, the one-channel-
 * per-name rule, and the build-time resolution that turns the path into the
 * signed sha512.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  applyTreeDigests,
  entryKey,
  loadAllowlist,
  resolveTarballArtifacts,
  saveAllowlist,
  validateAllowlistEntry,
} from '../lib/allowlist.mjs'
import { sha512IntegrityOf } from '../lib/tarball.mjs'

const CATALOG_ORIGIN = 'https://gitlab.company.example'
const PROJECT = 'julu/dsh-desktop-config'
const tarballUrl = (filename) => `${CATALOG_ORIGIN}/${PROJECT}/-/raw/master/packages/${filename}`

const baseEntry = {
  packageName: 'company-hardened-plugin',
  version: '2.1.0',
  bundlePatch: './cordis.patch.yml',
  repository: 'https://github.com/example/company-hardened-plugin',
  revoked: false,
  runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
}

const validate = (entry, options = { companyCatalogOrigin: CATALOG_ORIGIN }) =>
  validateAllowlistEntry(entry, 'entry[0]', options)

test('the pack-artifact source form validates and keeps the path for the build-time resolution', () => {
  const result = validate({ ...baseEntry, source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), path: 'tools/company-catalog/out/packages/company-hardened-plugin-2.1.0.tgz' } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.source, {
    kind: 'tarball',
    url: tarballUrl('company-hardened-plugin-2.1.0.tgz'),
    path: 'tools/company-catalog/out/packages/company-hardened-plugin-2.1.0.tgz',
  })
  // The reviewed inline-integrity form keeps working verbatim.
  const inline = validate({ ...baseEntry, source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' } })
  assert.equal(inline.ok, true)
  assert.deepEqual(inline.value.source, { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' })
})

test('the tarball source accepts exactly one truth: path or reviewed integrity', () => {
  const url = tarballUrl('company-hardened-plugin-2.1.0.tgz')
  const path = 'tools/company-catalog/out/packages/company-hardened-plugin-2.1.0.tgz'
  for (const [source, hint] of [
    [{ kind: 'tarball', url }, 'requires either path'],
    [{ kind: 'tarball', url, path, integrity: 'sha512-' + 'A'.repeat(86) + '==' }, 'both path and integrity'],
    [{ kind: 'tarball', url, path: '/abs/x.tgz' }, 'repository-relative POSIX path'],
    [{ kind: 'tarball', url, path: '../escape.tgz' }, 'dot segments'],
    [{ kind: 'tarball', url, path: 'tools/out/artifact.tar' }, '.tgz'],
    [{ kind: 'tarball', url, path: 'a\\b.tgz' }, 'backslash'],
  ]) {
    const result = validate({ ...baseEntry, source })
    assert.equal(result.ok, false, `source ${JSON.stringify(source)} must be rejected`)
    assert.match(result.reason, new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `reason must mention '${hint}'`)
  }
})

test('one package name never straddles both channels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-tarball-test-'))
  try {
    const mixed = [
      { ...baseEntry, version: '1.0.0' },
      {
        ...baseEntry,
        version: '2.0.0',
        source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.0.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' },
      },
    ]
    const allowlistPath = join(dir, 'allowlist.json')
    saveAllowlist(allowlistPath, mixed)
    assert.throws(() => loadAllowlist(allowlistPath, { companyCatalogOrigin: CATALOG_ORIGIN }), /both the npm and the tarball channel/u)
    // Same channel, several versions, stays fine; the npm|npm and tarball|tarball
    // duplicates by exact version keep their existing refusal.
    const sameChannel = [mixed[1], { ...mixed[1], version: '2.1.0' }]
    saveAllowlist(allowlistPath, sameChannel)
    assert.equal(loadAllowlist(allowlistPath, { companyCatalogOrigin: CATALOG_ORIGIN }).length, 2)
    saveAllowlist(allowlistPath, [sameChannel[0], sameChannel[0]])
    assert.throws(() => loadAllowlist(allowlistPath, { companyCatalogOrigin: CATALOG_ORIGIN }), /duplicate entry/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a revoked old-channel entry does not block the new channel (the npm → tarball migration path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allowlist-migration-test-'))
  try {
    const allowlistPath = join(dir, 'allowlist.json')
    // The migration shape: every npm entry revoked (the signed audit trail
    // stays), new tarball-channel entries active — loadAllowlist must accept it.
    const migrated = [
      { ...baseEntry, version: '1.0.0', revoked: true },
      { ...baseEntry, version: '1.5.0', revoked: true },
      {
        ...baseEntry,
        version: '2.0.0',
        source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.0.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' },
      },
    ]
    saveAllowlist(allowlistPath, migrated)
    const loaded = loadAllowlist(allowlistPath, { companyCatalogOrigin: CATALOG_ORIGIN })
    assert.equal(loaded.length, 3)
    assert.deepEqual(loaded.map((entry) => entry.revoked), [true, true, false])
    // The same migration in reverse (tarball revoked → npm active) is the one
    // path back, and equally accepted.
    const reversed = [
      {
        ...baseEntry,
        version: '1.0.0',
        revoked: true,
        source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-1.0.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' },
      },
      { ...baseEntry, version: '2.0.0' },
    ]
    saveAllowlist(allowlistPath, reversed)
    assert.equal(loadAllowlist(allowlistPath, { companyCatalogOrigin: CATALOG_ORIGIN }).length, 2)
    // Two ACTIVE channels remain refused even when revoked history sits next
    // to them: revoking one npm version is not enough to migrate.
    const stillStraddling = [
      { ...baseEntry, version: '1.0.0', revoked: true },
      { ...baseEntry, version: '1.5.0' },
      {
        ...baseEntry,
        version: '2.0.0',
        source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.0.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' },
      },
    ]
    saveAllowlist(allowlistPath, stillStraddling)
    assert.throws(() => loadAllowlist(allowlistPath, { companyCatalogOrigin: CATALOG_ORIGIN }), /both the npm and the tarball channel/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTarballArtifacts computes the signed sha512 from the packed bytes and never trusts a reviewed value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-tarball-test-'))
  try {
    const filename = 'company-hardened-plugin-2.1.0.tgz'
    const bytes = Buffer.from('packed artifact bytes — deterministic container placeholder\n')
    writeFileSync(join(dir, filename), bytes)
    const entry = {
      ...baseEntry,
      source: { kind: 'tarball', url: tarballUrl(filename), path: filename },
    }
    const { entries, resolved, passthrough } = resolveTarballArtifacts([entry], { repoRoot: dir })
    assert.deepEqual(resolved, [{
      packageName: entry.packageName,
      version: entry.version,
      filename,
      path: filename,
      url: tarballUrl(filename),
      integrity: sha512IntegrityOf(bytes),
      sizeBytes: bytes.byteLength,
    }])
    assert.deepEqual(passthrough, [])
    assert.deepEqual(entries[0].source, { kind: 'tarball', url: tarballUrl(filename), integrity: sha512IntegrityOf(bytes) })
    // The signed shape never carries the local path.
    assert.equal(entries[0].source.path, undefined)
    assert.equal(JSON.stringify(entries[0]).includes('"path"'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTarballArtifacts fails closed on missing artifacts and url/filename divergence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-tarball-test-'))
  try {
    const filename = 'company-hardened-plugin-2.1.0.tgz'
    const entry = (pathFilename, urlFilename) => ({
      ...baseEntry,
      source: { kind: 'tarball', url: tarballUrl(urlFilename), path: pathFilename },
    })
    assert.throws(() => resolveTarballArtifacts([entry(filename, filename)], { repoRoot: dir }), /run pack-tarball/u)
    writeFileSync(join(dir, filename), Buffer.from('bytes'))
    assert.throws(() => resolveTarballArtifacts([entry(filename, 'different-1.0.0.tgz')], { repoRoot: dir }), /url ends with 'different-1\.0\.0\.tgz' but the packed artifact is 'company-hardened-plugin-2\.1\.0\.tgz'/u)
    // The reviewed inline-integrity form passes through untouched.
    const inline = { ...baseEntry, source: { kind: 'tarball', url: tarballUrl(filename), integrity: 'sha512-' + 'A'.repeat(86) + '==' } }
    const { entries, resolved, passthrough } = resolveTarballArtifacts([inline], { repoRoot: dir })
    assert.equal(resolved.length, 0)
    assert.deepEqual(passthrough, [entryKey(inline)])
    assert.equal(entries[0].source.integrity, 'sha512-' + 'A'.repeat(86) + '==')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveTarballArtifacts binds every tarball artifact filename and url to the entry’s name@version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-tarball-bind-'))
  try {
    // A path form filed under ANOTHER name — url agreeing with the file — is
    // a mis-filed artifact, not an alternative address (same-name-different-
    // bytes / swapped-package review attacks both need this refusal).
    writeFileSync(join(dir, 'other-plugin-9.9.9.tgz'), Buffer.from('some other package’s bytes'))
    const misfiledName = {
      ...baseEntry,
      source: { kind: 'tarball', url: tarballUrl('other-plugin-9.9.9.tgz'), path: 'other-plugin-9.9.9.tgz' },
    }
    assert.throws(
      () => resolveTarballArtifacts([misfiledName], { repoRoot: dir }),
      /company-hardened-plugin@2\.1\.0 source\.path must end in 'company-hardened-plugin-2\.1\.0\.tgz'.*but is 'other-plugin-9\.9\.9\.tgz'/u,
    )
    // Version drift inside the same name is the same mis-filing.
    const misfiledVersion = {
      ...baseEntry,
      source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.0.9.tgz'), path: 'company-hardened-plugin-2.0.9.tgz' },
    }
    assert.throws(
      () => resolveTarballArtifacts([misfiledVersion], { repoRoot: dir }),
      /source\.path must end in 'company-hardened-plugin-2\.1\.0\.tgz'.*but is 'company-hardened-plugin-2\.0\.9\.tgz'/u,
    )
    // The reviewed inline-integrity form is bound through its url basename.
    const misfiledInline = { ...baseEntry, source: { kind: 'tarball', url: tarballUrl('stolen-name-1.0.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' } }
    assert.throws(
      () => resolveTarballArtifacts([misfiledInline], { repoRoot: dir }),
      /company-hardened-plugin@2\.1\.0 source\.url must host 'company-hardened-plugin-2\.1\.0\.tgz'.*but ends with 'stolen-name-1\.0\.0\.tgz'/u,
    )
    // The well-formed shape passes — including a scoped name, whose binding
    // runs through npm's pack flattening (@scope/name → scope-name).
    const scopedBytes = Buffer.from('scoped artifact bytes')
    writeFileSync(join(dir, 'company-hardened-plugin-3.0.0.tgz'), scopedBytes)
    const scoped = {
      ...baseEntry,
      packageName: '@company/hardened-plugin',
      version: '3.0.0',
      source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-3.0.0.tgz'), path: 'company-hardened-plugin-3.0.0.tgz' },
    }
    const { resolved, entries } = resolveTarballArtifacts([scoped], { repoRoot: dir })
    assert.deepEqual(resolved.map((record) => record.filename), ['company-hardened-plugin-3.0.0.tgz'])
    assert.equal(entries[0].source.integrity, sha512IntegrityOf(scopedBytes))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the digest fill treats resolved tarball entries like any other entry', () => {
  const entry = { ...baseEntry, treeDigest: 'c'.repeat(64), source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), integrity: 'sha512-' + 'A'.repeat(86) + '==' } }
  const filled = applyTreeDigests([entry], [{ packageName: entry.packageName, version: entry.version, treeDigest: 'c'.repeat(64) }])
  assert.deepEqual(filled.unchanged, [entryKey(entry)])
})
