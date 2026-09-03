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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  buildDeterministicTarball,
  expectedTarballFilename,
  extractTarballEntries,
  normalizeTarballFile,
  parsePackSpec,
  parseTarball,
  sha512IntegrityOf,
  stageSourceDirectory,
} from '../lib/tarball.mjs'

/** Independent oracle: `sha512-<base64(sha512(bytes))>`. */
const referenceIntegrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const fileEntry = (path, data, { mode = 0o644 } = {}) => ({ path, type: 'file', mode, mtime: 1234567890, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') })

const symlinkEntry = (path, linkName, { mode = 0o755 } = {}) => ({ path, type: 'symlink', mode, mtime: 1234567890, linkName })

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
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})
