/**
 * Tarball-push planning for the intranet publisher (P7 2b): the GitLab raw-URL
 * contract parse (origin/project/ref/path derivation), the push planner that
 * verifies artifact bytes against the SIGNED integrity and refuses duplicate
 * hosted addresses, and the capped body reader. Pure functions — no GitLab,
 * no network.
 */

import assert from 'node:assert/strict'
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  TARBALL_MAX_BYTES,
  parseTarballSourceUrl,
  planTarballPushes,
  readBytesWithLimit,
  sha512IntegrityOf,
} from '../lib/tarball-publish.mjs'

const ORIGIN = 'https://gitlab.company.example'
const PROJECT = 'julu/dsh-desktop-config'
const BRANCH = 'master'
const rawUrl = (filename, { origin = ORIGIN, project = PROJECT, branch = BRANCH } = {}) =>
  `${origin}/${project}/-/raw/${branch}/packages/${filename}`

const entry = (overrides = {}) => ({
  packageName: 'company-hardened-plugin',
  version: '2.1.0',
  repository: 'https://github.com/example/company-hardened-plugin',
  runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
  ...overrides,
})

const parse = (url, opts) => parseTarballSourceUrl(url, { origin: ORIGIN, project: PROJECT, branch: BRANCH, at: 'entry[0]', ...opts })

test('parseTarballSourceUrl derives the in-repo packages path and filename from the signed url', () => {
  const result = parse(rawUrl('company-hardened-plugin-2.1.0.tgz'))
  assert.deepEqual(result, {
    repoPath: PROJECT,
    filePath: 'packages/company-hardened-plugin-2.1.0.tgz',
    filename: 'company-hardened-plugin-2.1.0.tgz',
  })
})

test('parseTarballSourceUrl refuses any address outside the deployment being pushed to', () => {
  for (const [url, hint] of [
    [rawUrl('x.tgz', { origin: 'https://other.company.example' }), 'origin'],
    [rawUrl('x.tgz', { project: 'someone/else' }), 'path must be'],
    [rawUrl('x.tgz', { branch: 'main' }), 'path must be'],
    ['not a url', 'not a parseable URL'],
    [rawUrl('../../etc/passwd'), 'path must be'],
    [`${ORIGIN}/${PROJECT}/-/raw/${BRANCH}/not-packages/x.tgz`, 'must address exactly packages/'],
    [`${ORIGIN}/${PROJECT}/-/raw/${BRANCH}/packages/a/b.tgz`, 'must address exactly packages/'],
    [`${ORIGIN}/${PROJECT}/-/raw/${BRANCH}/packages/foo.txt`, 'must address exactly packages/'],
    [`${ORIGIN}/${PROJECT}/-/raw/${BRANCH}/packages/../evil.tgz`, 'must address exactly packages/'],
  ]) {
    assert.throws(() => parse(url), new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), `url '${url}' must be refused (${hint})`)
  }
})

/** A minimal web Response stand-in: a ReadableStream-less body the reader walks. */
function fakeResponse(chunks, { contentLength = null } = {}) {
  let index = 0
  return {
    headers: { get: (name) => (name === 'content-length' ? contentLength : null) },
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined }),
        releaseLock: () => undefined,
        cancel: async () => undefined,
      }),
    },
  }
}

test('planTarballPushes verifies artifact bytes against the signed integrity and plans the push', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-publish-plan-'))
  try {
    const filename = 'company-hardened-plugin-2.1.0.tgz'
    const bytes = Buffer.from('the signed intranet tarball bytes\n')
    const integrity = sha512IntegrityOf(bytes)
    mkdirSync(join(dir, 'packages'), { recursive: true })
    writeFileSync(join(dir, 'packages', filename), bytes)
    const manifest = {
      packages: [
        entry({ source: { kind: 'tarball', url: rawUrl(filename), integrity } }),
        // A source-free npm entry must be ignored by the tarball planner.
        entry({ packageName: 'plain-plugin', version: '1.0.0' }),
      ],
    }
    const pushes = planTarballPushes({ manifest, artifactDir: dir, origin: ORIGIN, project: PROJECT, branch: BRANCH })
    assert.equal(pushes.length, 1)
    assert.equal(pushes[0].filename, filename)
    assert.equal(pushes[0].filePath, `packages/${filename}`)
    assert.equal(pushes[0].integrity, integrity)
    assert.equal(pushes[0].sizeBytes, bytes.byteLength)
    assert.deepEqual(pushes[0].bytes, bytes)
    assert.equal(pushes[0].packageName, 'company-hardened-plugin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planTarballPushes fails closed on missing, mismatched, or ambiguous artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tarball-publish-fail-'))
  try {
    const filename = 'company-hardened-plugin-2.1.0.tgz'
    const bytes = Buffer.from('correct bytes\n')
    const integrity = sha512IntegrityOf(bytes)
    mkdirSync(join(dir, 'packages'), { recursive: true })
    writeFileSync(join(dir, 'packages', filename), bytes)

    // Missing artifact.
    const missing = { packages: [entry({ source: { kind: 'tarball', url: rawUrl('missing-1.0.0.tgz'), integrity } })] }
    assert.throws(() => planTarballPushes({ manifest: missing, artifactDir: dir, origin: ORIGIN, project: PROJECT, branch: BRANCH }), /missing from the artifact/u)

    // Bytes that do not hash to the signed integrity.
    const mismatched = { packages: [entry({ source: { kind: 'tarball', url: rawUrl(filename), integrity: sha512IntegrityOf(Buffer.from('other bytes\n')) } })] }
    assert.throws(() => planTarballPushes({ manifest: mismatched, artifactDir: dir, origin: ORIGIN, project: PROJECT, branch: BRANCH }), /hashes to/u)

    // Two entries claiming one hosted address.
    const duplicate = {
      packages: [
        entry({ source: { kind: 'tarball', url: rawUrl(filename), integrity } }),
        entry({ packageName: 'other-plugin', version: '3.0.0', source: { kind: 'tarball', url: rawUrl(filename), integrity } }),
      ],
    }
    assert.throws(() => planTarballPushes({ manifest: duplicate, artifactDir: dir, origin: ORIGIN, project: PROJECT, branch: BRANCH }), /already claimed by/u)

    // A tarball source that does not describe a signable entry.
    const bare = { packages: [entry({ source: { kind: 'tarball' } })] }
    assert.throws(() => planTarballPushes({ manifest: bare, artifactDir: dir, origin: ORIGIN, project: PROJECT, branch: BRANCH }), /without url\/integrity/u)

    // An artifact over the hosted byte bound (sparse file, cheap).
    const bigPath = join(dir, 'packages', 'huge-1.0.0.tgz')
    const fd = openSync(bigPath, 'w')
    ftruncateSync(fd, TARBALL_MAX_BYTES + 1)
    closeSync(fd)
    const oversized = { packages: [entry({ source: { kind: 'tarball', url: rawUrl('huge-1.0.0.tgz'), integrity } })] }
    assert.throws(() => planTarballPushes({ manifest: oversized, artifactDir: dir, origin: ORIGIN, project: PROJECT, branch: BRANCH }), /over the .*byte bound/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readBytesWithLimit reads a stream under a hard byte cap and cancels on overrun', async () => {
  const bytes = Buffer.from('some tarball body')
  // Under the cap: the full body comes back.
  assert.deepEqual(await readBytesWithLimit(fakeResponse([bytes.subarray(0, 5), bytes.subarray(5)]), 1024, 'the body'), bytes)
  // The declared content-length alone can trip the cap before reading.
  await assert.rejects(() => readBytesWithLimit(fakeResponse([bytes], { contentLength: '9999' }), 100, 'the body'), /declares 9999 bytes, over the 100-byte bound/u)
  // Bytes flowing past the cap abort the read.
  await assert.rejects(() => readBytesWithLimit(fakeResponse([bytes]), 4, 'the body'), /exceeds the 4-byte bound/u)
  // An empty body is refused.
  await assert.rejects(() => readBytesWithLimit(fakeResponse([], { contentLength: '0' }), 1024, 'the body'), /returned an empty body/u)
})
