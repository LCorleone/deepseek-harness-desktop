/**
 * Deterministic tarball-channel packing primitives (P7 2b): the sha512
 * integrity spelling, the npm pack filename derivation, the pack spec
 * grammar, the hand-rolled ustar/gzip reader (解包) and the deterministic
 * re-serializer that keeps re-packs byte-identical, plus the staging/extract
 * helpers. Pure and offline — the real `npm pack` → normalize → measure
 * chain is the e2e-tarball drill (it needs the built desktop lib + pinned
 * pnpm), while these tests pin the container invariant directly.
 */

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  buildDeterministicTarball,
  extractTarballEntries,
  normalizeTarballFile,
  parsePackSpec,
  parseTarball,
  sha512IntegrityOf,
  stageSourceDirectory,
} from '../lib/tarball.mjs'
import { expectedTarballFilename } from '../lib/allowlist.mjs'

/** Independent oracle: `sha512-<base64(sha512(bytes))>`. */
const referenceIntegrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const fileEntry = (path, data, { mode = 0o644 } = {}) => ({ path, type: 'file', mode, mtime: 1234567890, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })

const symlinkEntry = (path, linkName, { mode = 0o755 } = {}) => ({ path, type: 'symlink', mode, mtime: 1234567890, linkName })

/**
 * lstat without the throw: `null` when the node does not exist. existsSync
 * follows symlinks, so it cannot prove a DANGLING link was never created —
 * the escape tests assert absence of relocated links and need this oracle.
 */
const lstatSyncOptional = (path) => {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** Raw ustar builder for the shape-violation negatives (the module accepts only ustar). */
function rawTar(entries) {
  const blocks = []
  for (const e of entries) {
    const header = Buffer.alloc(512)
    Buffer.from(e.name, 'utf8').subarray(0, 100).copy(header, 0)
    const mode = e.mode ?? 0o644
    const size = e.data?.byteLength ?? 0
    header.write(mode.toString(8).padStart(6, '0') + '\0', 100, 'binary')
    header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'binary')
    header.write('00000000000\0', 136, 'binary')
    header.write('        ', 148, 'binary')
    header.write(e.type ?? '0', 156, 'binary')
    if (e.linkName !== undefined) Buffer.from(e.linkName, 'utf8').subarray(0, 100).copy(header, 157)
    Buffer.from(e.magic ?? 'ustar\0', 'binary').copy(header, 257)
    header.write('00', 263, 'binary')
    if (e.prefix !== undefined) Buffer.from(e.prefix, 'utf8').subarray(0, 155).copy(header, 345)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'binary')
    blocks.push(header)
    const data = e.data ?? Buffer.alloc(0)
    blocks.push(data)
    const pad = (512 - (data.byteLength % 512)) % 512
    if (pad > 0) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const tarballFromRaw = (entries, what = 'raw tarball') => gzipSync(rawTar(entries))

test('sha512IntegrityOf writes the standard-base64 SHA-512 integrity spelling', () => {
  const bytes = Buffer.from('the tarball bytes', 'utf8')
  assert.equal(sha512IntegrityOf(bytes), referenceIntegrity(bytes))
  assert.match(sha512IntegrityOf(bytes), /^sha512-[A-Za-z0-9+/]{86}==$/u)
  // Deterministic and distinct for different bytes.
  assert.equal(sha512IntegrityOf(bytes), sha512IntegrityOf(Buffer.from('the tarball bytes', 'utf8')))
  assert.notEqual(sha512IntegrityOf(bytes), sha512IntegrityOf(Buffer.from('the tarball bytes!', 'utf8')))
})

test('expectedTarballFilename mirrors npm pack spelling for plain and scoped names', () => {
  assert.equal(expectedTarballFilename('fixture-hello', '1.0.0'), 'fixture-hello-1.0.0.tgz')
  assert.equal(expectedTarballFilename('@scope/name', '2.3.4'), 'scope-name-2.3.4.tgz')
})

test('parsePackSpec accepts exact pinned versions and refuses ranges/tags/bad names', () => {
  assert.deepEqual(parsePackSpec('@scope/name@1.2.3'), { packageName: '@scope/name', version: '1.2.3' })
  assert.deepEqual(parsePackSpec('plain-0.0.1@0.0.1'), { packageName: 'plain-0.0.1', version: '0.0.1' })
  for (const [spec, hint] of [
    ['', 'must be <package>@<exact stable version>'],
    ['no-version', 'must be <package>@<exact stable version>'],
    ['@scope/@1.2.3', 'not an npm package name'],
    ['name@^1.0.0', 'not an exact stable semver'],
    ['name@1.0', 'not an exact stable semver'],
    ['name@1.0.0-beta.1', 'not an exact stable semver'],
  ]) {
    assert.throws(() => parsePackSpec(spec), new RegExp(hint), `parsePackSpec('${spec}') must refuse`)
  }
})

test('buildDeterministicTarball is byte-identical across runs and normalizes mode/mtime', () => {
  const entries = [
    fileEntry('package/index.js', 'module.exports = 1\n'),
    fileEntry('package/bin/cli.js', '#!/usr/bin/env node\n', { mode: 0o755 }),
    fileEntry('package/package.json', '{"name":"fixture-hello","version":"1.0.0"}\n'),
    symlinkEntry('package/link.js', 'index.js'),
  ]
  const a = buildDeterministicTarball(entries)
  const b = buildDeterministicTarball(entries)
  assert.deepEqual(a, b, 're-packing the same entries must produce byte-identical output')
  // Determinism includes the gzip header (mtime 0), so the bytes are stable.
  assert.equal(a.byteLength, b.byteLength)

  const parsed = parseTarball(a)
  const byPath = new Map(parsed.map((entry) => [entry.path, entry]))
  assert.deepEqual([...byPath.keys()].sort(), ['package/bin/cli.js', 'package/index.js', 'package/link.js', 'package/package.json'])
  // The executable bit survives; everything else collapses to 644. mtime is pinned to 0.
  assert.equal(byPath.get('package/bin/cli.js').mode, 0o755)
  assert.equal(byPath.get('package/index.js').mode, 0o644)
  assert.equal(byPath.get('package/package.json').mode, 0o644)
  assert.equal(byPath.get('package/index.js').mtime, 0)
  assert.equal(byPath.get('package/link.js').type, 'symlink')
  assert.equal(byPath.get('package/link.js').linkName, 'index.js')
  assert.equal(byPath.get('package/package.json').data.toString('utf8'), '{"name":"fixture-hello","version":"1.0.0"}\n')
  // Directories are implicit in the deterministic container; a re-pack mangles nothing.
  assert.equal(parsed.some((entry) => entry.type === 'directory'), false)
})

test('parseTarball (解包) round-trips the normalized container and rejects malformed input', () => {
  const original = fileEntry('package/index.js', 'const x = 1\n')
  const tarball = buildDeterministicTarball([original])
  const unpacked = parseTarball(tarball, 'the unit tarball')
  assert.equal(unpacked.length, 1)
  assert.equal(unpacked[0].path, 'package/index.js')
  assert.deepEqual(unpacked[0].data, original.data)

  for (const [bytes, hint] of [
    [Buffer.from('not gzip at all'), 'not valid gzip'],
    [gzipSync(Buffer.alloc(100)), 'not a tar archive'],
  ]) {
    assert.throws(() => parseTarball(bytes), new RegExp(hint), `parseTarball must refuse: ${hint}`)
  }

  // A broken checksum is a hard error (a mangled header must not be silently read).
  const good = rawTar([{ name: 'package/index.js', type: '0', data: Buffer.from('abc') }])
  const corrupt = Buffer.from(good)
  corrupt[105] ^= 0xFF // inside the mode field, outside the checksum field: the sum changes, the stored value does not
  assert.throws(() => parseTarball(gzipSync(corrupt)), /broken checksum/u)
})

test('parseTarball fails closed on unsafe or non-ustar entry shapes', () => {
  const cases = [
    [{ name: '/package/index.js', type: '0', data: Buffer.from('x') }, 'unsafe tar entry path'],
    [{ name: 'package/../evil.js', type: '0', data: Buffer.from('x') }, 'unsafe tar entry path'],
    [{ name: 'package/./x.js', type: '0', data: Buffer.from('x') }, 'unsafe tar entry path'],
    [{ name: 'node_modules/package/x.js', type: '0', data: Buffer.from('x') }, 'does not sit under the npm'],
    [{ name: 'package/index.js', magic: 'xyz\0', type: '0', data: Buffer.from('x') }, 'non-ustar tar entry'],
    [{ name: 'package/index.js', type: 'L', data: Buffer.alloc(0) }, 'GNU/pax extension headers'],
    [{ name: 'package/link', type: '2', linkName: '../escape', data: Buffer.alloc(0) }, 'unsafe link target'],
  ]
  for (const [entry, hint] of cases) {
    assert.throws(
      () => parseTarball(tarballFromRaw([entry])),
      new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
      `entry ${entry.name} must be refused (${hint})`,
    )
  }
})

test('parseTarball refuses symlink targets that escape the package/ root (P1: absolute/empty/../ targets)', () => {
  // The review's PoC class: an absolute link target plus a later entry
  // written through the link — writeFileSync follows symlinks, so without
  // the refusal this is an arbitrary-path write at extraction time. The
  // container is built with the pipeline's own writer to prove the reader
  // (the trust boundary for registry tarballs) is what refuses it.
  const poc = buildDeterministicTarball([
    symlinkEntry('package/escape-link', '/tmp/company-catalog-poc-target'),
    fileEntry('package/escape-link/pwned.js', 'arbitrary-path write\n'),
  ])
  assert.throws(() => parseTarball(poc), /unsafe link target '\/tmp\/company-catalog-poc-target'.*outside the package\/ root/u)

  for (const [entry, hint] of [
    [{ name: 'package/link', type: '2', linkName: '/etc/passwd', data: Buffer.alloc(0) }, 'unsafe link target'],
    [{ name: 'package/link', type: '2', data: Buffer.alloc(0) }, 'unsafe link target'],
    [{ name: 'package/sub/link', type: '2', linkName: '../../escape', data: Buffer.alloc(0) }, 'unsafe link target'],
    [{ name: 'package/link', type: '2', linkName: 'a/../../escape', data: Buffer.alloc(0) }, 'unsafe link target'],
    [{ name: 'package/link', type: '2', linkName: 'C:\\evil', data: Buffer.alloc(0) }, 'unsafe link target'],
  ]) {
    assert.throws(
      () => parseTarball(tarballFromRaw([entry])),
      /unsafe link target/u,
      `link target ${JSON.stringify(entry.linkName)} must be refused`,
    )
  }

  // Legitimate relative targets survive: same-directory, subdirectory, and
  // a `..` that stays inside package/ (package/sub/x → package/y).
  const legit = buildDeterministicTarball([
    fileEntry('package/index.js', 'main\n'),
    fileEntry('package/lib/deep.js', 'deep\n'),
    symlinkEntry('package/link.js', 'index.js'),
    symlinkEntry('package/sub/peer.js', '../lib/deep.js'),
  ])
  const parsed = parseTarball(legit)
  const byPath = new Map(parsed.map((entry) => [entry.path, entry]))
  assert.equal(byPath.get('package/link.js').linkName, 'index.js')
  assert.equal(byPath.get('package/sub/peer.js').linkName, '../lib/deep.js')
})

test('extractTarballEntries keeps every produced node inside the target directory (root-containment net)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-extract-containment-'))
  try {
    const target = join(dir, 'extracted')
    const tarball = buildDeterministicTarball([
      fileEntry('package/lib/deep.js', 'deep\n'),
      symlinkEntry('package/link.js', 'lib/deep.js'),
      // A symlink pointing at a directory inside the tree: contained.
      symlinkEntry('package/dir-link', 'lib'),
    ])
    extractTarballEntries(parseTarball(tarball), target)
    assert.equal(readFileSync(join(target, 'lib', 'deep.js'), 'utf8'), 'deep\n')
    assert.equal(readFileSync(join(target, 'link.js'), 'utf8'), 'deep\n')
    assert.equal(readFileSync(join(target, 'dir-link', 'deep.js'), 'utf8'), 'deep\n')

    // Defense in depth: hand-built entries bypass parseTarball's lexical
    // validation (layer 1), so the creation-time realpath guard (layer 2) is
    // the one that refuses this link — before it exists on disk, hence
    // before the write-through entry can do anything with it.
    const escapeRoot = join(dir, 'escape-target')
    mkdirSync(escapeRoot, { recursive: true })
    assert.throws(
      () => extractTarballEntries([
        symlinkEntry('package/escape-link', escapeRoot),
        fileEntry('package/escape-link/pwned.js', 'escaped\n'),
      ], join(dir, 'extracted-2')),
      /refusing to create the link/u,
    )
    assert.equal(existsSync(join(escapeRoot, 'pwned.js')), false)

    // Layer 3 proper — the final walk: a symlink PRE-EXISTING in the target
    // directory is not a tar entry, so no creation-time guard ever sees it;
    // the write routes through it and only the realpath walk over what
    // landed catches the escape.
    const outside = join(dir, 'preexisting-outside')
    mkdirSync(outside, { recursive: true })
    const poisoned = join(dir, 'extracted-3')
    mkdirSync(poisoned, { recursive: true })
    symlinkSync(outside, join(poisoned, 'escape-link'))
    assert.throws(
      () => extractTarballEntries([fileEntry('package/escape-link/pwned.js', 'escaped\n')], poisoned),
      /lies outside the extraction directory/u,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractTarballEntries refuses a symlink relocated through an earlier symlink before creating it (two-hop escape)', () => {
  // The review's P1 PoC: safeLinkTarget's lexical `..` counting assumes the
  // link sits where its entry path says it does, but symlinkSync resolves
  // the destination through any symlink an earlier entry left in the parent
  // chain. `x/y` → `../q` means `x/y/inner` is physically created at
  // `<root>/q/inner` — one level shallower than the lexical check assumed —
  // so its `../../land` target resolves OUTSIDE the extraction root, and a
  // later write-through entry lands outside before assertExtractionContained
  // ever runs (the walk skips dangling links by design). The creation-time
  // guard must refuse the link before it exists; every assertion below
  // checks the FILE SYSTEM, not just the throw.
  const dir = mkdtempSync(join(tmpdir(), 'tarball-twohop-'))
  try {
    const target = join(dir, 'extracted')
    const tarball = buildDeterministicTarball([
      // Makes package/q a real directory first (tar order), so x/y's target
      // resolves and the second hop gets created through it.
      fileEntry('package/q/anchor.js', 'q\n'),
      symlinkEntry('package/x/y', '../q'), // hop 1: legal, lexically and physically inside
      symlinkEntry('package/x/y/inner', '../../land'), // hop 2: physically at <root>/q/inner → escapes
      fileEntry('package/x/y/inner/pwned.js', 'arbitrary-path write\n'),
    ])
    assert.throws(
      () => extractTarballEntries(parseTarball(tarball), target),
      /symlink 'package\/x\/y\/inner' → '\.\.\/\.\.\/land'.*refusing to create the link/u,
    )
    // Nothing landed outside the root: no land/ beside it, no pwned.js.
    assert.equal(existsSync(join(dir, 'land')), false)
    assert.equal(existsSync(resolve(dir, 'land', 'pwned.js')), false)
    // The escaping link itself was never created — the refusal precedes
    // symlinkSync (existsSync would follow it, so lstat is the oracle).
    assert.equal(lstatSyncOptional(join(target, 'q', 'inner')), null)
    // The legal prefix of the extraction did land: the anchor and hop 1,
    // which still resolves inside the root.
    assert.equal(readFileSync(join(target, 'q', 'anchor.js'), 'utf8'), 'q\n')
    assert.equal(readFileSync(join(target, 'x', 'y', 'anchor.js'), 'utf8'), 'q\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractTarballEntries refuses a deep chain whose last link escapes from a relocated parent', () => {
  // Deeper shape: every link except the last is legal on its own —
  // `a/b/c/d` legitimately resolves back to `<root>/a` — but it relocates
  // `a/b/c/d/e`'s physical parent two levels shallower, so the last link's
  // `../../../../q` walks out of the extraction root even though the
  // lexical layer counted it safely inside package/.
  const dir = mkdtempSync(join(tmpdir(), 'tarball-deeplink-'))
  try {
    const target = join(dir, 'extracted')
    const tarball = buildDeterministicTarball([
      fileEntry('package/a/anchor.js', 'anchor\n'),
      symlinkEntry('package/a/b/c/d', '../..'), // legal: resolves back to <root>/a, two levels shallower
      symlinkEntry('package/a/b/c/d/e', '../../../../q'), // physical parent is <root>/a → escapes
      fileEntry('package/a/b/c/d/e/pwned.js', 'arbitrary-path write\n'),
    ])
    assert.throws(
      () => extractTarballEntries(parseTarball(tarball), target),
      /symlink 'package\/a\/b\/c\/d\/e'.*refusing to create the link/u,
    )
    // The escaped target never materialized, and the last link was never
    // created (its physical parent is <root>/a, so it would sit at
    // <root>/a/e pointing outside). resolve(<root>/a, ../../../../q) is
    // exactly where the guard counted the target — assert nothing is there.
    assert.equal(existsSync(resolve(join(target, 'a'), '..', '..', '..', '..', 'q')), false)
    assert.equal(lstatSyncOptional(join(target, 'a', 'e')), null)
    // The legal link survives: d resolves back to <root>/a, so content is
    // reachable through the whole legal prefix.
    assert.equal(readFileSync(join(target, 'a', 'b', 'c', 'd', 'anchor.js'), 'utf8'), 'anchor\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractTarballEntries still accepts legitimate relative symlinks, including under a legal parent link', () => {
  // Regression for the creation-time guard: links whose targets stay inside
  // the extraction root when counted against their REAL parent must keep
  // extracting — same-directory targets, `..` targets that stay inside, and
  // a link created UNDER a symlinked parent (hop 1 of the escape PoC is a
  // legal link in its own right, and the guard must not blanket-reject
  // links whose parent directory is a symlink).
  const dir = mkdtempSync(join(tmpdir(), 'tarball-legitlinks-'))
  try {
    const target = join(dir, 'extracted')
    const tarball = buildDeterministicTarball([
      fileEntry('package/index.js', 'main\n'),
      fileEntry('package/lib/deep.js', 'deep\n'),
      fileEntry('package/q/anchor.js', 'q\n'),
      symlinkEntry('package/link.js', 'index.js'), // same-directory target
      symlinkEntry('package/sub/peer.js', '../lib/deep.js'), // a `..` that stays inside
      symlinkEntry('package/x/y', '../q'), // hop 1 of the PoC — legal on its own
      // Physically lands at <root>/q/sibling.js; `../q/anchor.js` counted
      // from that real parent stays inside, so it passes the guard.
      symlinkEntry('package/x/y/sibling.js', '../q/anchor.js'),
    ])
    extractTarballEntries(parseTarball(tarball), target)
    assert.equal(readFileSync(join(target, 'link.js'), 'utf8'), 'main\n')
    assert.equal(readFileSync(join(target, 'sub', 'peer.js'), 'utf8'), 'deep\n')
    assert.equal(readFileSync(join(target, 'x', 'y', 'anchor.js'), 'utf8'), 'q\n')
    assert.equal(readFileSync(join(target, 'x', 'y', 'sibling.js'), 'utf8'), 'q\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseTarball refuses a truncated archive instead of clamping the last entry short', () => {
  const full = rawTar([{ name: 'package/index.js', type: '0', data: Buffer.alloc(1536, 0x78) }])
  assert.equal(full.length % 512, 0)
  // Cut away the tail (payload padding + end-of-archive blocks): the header
  // now claims 1536 data bytes that are no longer there. Buffer#subarray
  // would clamp silently — the parser must refuse the truncation instead.
  const truncated = full.subarray(0, 512 + 512)
  assert.equal(truncated.length % 512, 0)
  assert.throws(() => parseTarball(gzipSync(truncated)), /claims 1536 data bytes.*truncated/u)
  // A header whose payload was cut mid-block (padding region missing) is the
  // same refusal.
  assert.throws(() => parseTarball(gzipSync(full.subarray(0, 512 + 100))), /not a tar archive|truncated/u)
})

test('normalizeTarballFile is an idempotent byte-stable re-serialization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-normalize-test-'))
  try {
    const tarballPath = join(dir, 'fixture-hello-1.0.0.tgz')
    const original = buildDeterministicTarball([
      fileEntry('package/package.json', '{"name":"fixture-hello","version":"1.0.0"}\n'),
      fileEntry('package/index.js', 'module.exports = 1\n'),
    ])
    writeFileSync(tarballPath, original)
    const first = normalizeTarballFile(tarballPath)
    const afterFirstBytes = readFileSync(tarballPath)
    assert.equal(afterFirstBytes.byteLength, original.byteLength)
    assert.deepEqual(afterFirstBytes, original, 'normalizing the deterministic container must not change its bytes')
    assert.equal(first.integrity, sha512IntegrityOf(original))
    assert.equal(first.sizeBytes, original.byteLength)
    assert.equal(first.fileCount, 2)
    // Idempotent: running the normalizer again is a no-op on the bytes.
    const second = normalizeTarballFile(tarballPath)
    assert.equal(second.integrity, first.integrity)
    assert.equal(second.sizeBytes, first.sizeBytes)
    assert.deepEqual(readFileSync(tarballPath), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractTarballEntries materializes the "package/" prefix away as files and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-extract-test-'))
  try {
    const target = join(dir, 'extracted')
    const tarball = buildDeterministicTarball([
      fileEntry('package/lib/deep.js', 'deep\n'),
      symlinkEntry('package/link.js', 'lib/deep.js'),
    ])
    parseTarball(tarball).forEach((entry) => extractTarballEntries([entry], target))
    assert.equal(readFileSync(join(target, 'lib', 'deep.js'), 'utf8'), 'deep\n')
    // The symlink is recreated relative to its own directory.
    assert.equal(readFileSync(join(target, '.', 'link.js'), 'utf8'), 'deep\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stageSourceDirectory copies content but never node_modules/.git or a stale top-level tarball', () => {
  const source = mkdtempSync(join(tmpdir(), 'tarball-stage-src-'))
  const target = mkdtempSync(join(tmpdir(), 'tarball-stage-dst-'))
  try {
    writeFileSync(join(source, 'index.js'), 'main\n')
    writeFileSync(join(source, 'package.json'), '{"name":"x","version":"1.0.0"}\n')
    mkdirSync(join(source, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(source, 'node_modules', 'dep', 'index.js'), 'dep\n')
    mkdirSync(join(source, '.git'), { recursive: true })
    writeFileSync(join(source, '.git', 'HEAD'), 'ref\n')
    writeFileSync(join(source, 'stale.tgz'), 'must-not-ship\n')
    stageSourceDirectory(source, join(target, 'pkg'))
    const staged = join(target, 'pkg')
    assert.equal(readFileSync(join(staged, 'index.js'), 'utf8'), 'main\n')
    assert.equal(readFileSync(join(staged, 'package.json'), 'utf8'), '{"name":"x","version":"1.0.0"}\n')
    assert.equal(existsSync(join(staged, 'node_modules')), false)
    assert.equal(existsSync(join(staged, '.git')), false)
    // The stale top-level tarball must be filtered out of the staged tree —
    // npm packs top-level *.tgz files, so shipping one would nest the stale
    // artifact inside the published tarball.
    assert.equal(existsSync(join(staged, 'stale.tgz')), false)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})
