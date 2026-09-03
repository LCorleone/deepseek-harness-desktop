/**
 * Manifest-assembly contract for the tarball channel (P7 2b): `assembleUnsignedManifest`
 * signs the tarball entry's resolved `{kind,url,integrity}` (never the local pack
 * path), requires an explicit repository override (the intranet tarball has no
 * registry metadata to derive the identity from), refuses the unresolved
 * pack-artifact path form, and keeps npm entries in their exact previous
 * source-free shape. This is the "mantest" half of the tarball allowlist
 * validation — what actually reaches the signed manifest — pinned against the
 * real market library (the identity contract).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleUnsignedManifest } from '../lib/pipeline.mjs'
import { loadMarketLibrary } from '../lib/market.mjs'

const ORIGIN = 'https://gitlab.company.example'
const PROJECT = 'julu/dsh-desktop-config'
const tarballUrl = (filename) => `${ORIGIN}/${PROJECT}/-/raw/master/packages/${filename}`
const INTEGRITY = 'sha512-' + 'A'.repeat(86) + '=='

const tarballEntry = (overrides = {}) => ({
  packageName: 'company-hardened-plugin',
  version: '2.1.0',
  bundlePatch: './cordis.patch.yml',
  repository: 'https://github.com/example/company-hardened-plugin',
  revoked: false,
  runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
  ...overrides,
})

const assemble = (market, { entries, dists = new Map(), sequence = 7, expiresAt = new Date('2030-01-01T00:00:00Z') } = {}) =>
  assembleUnsignedManifest({ market, sequence, expiresAt, entries, dists })

test('a tarball entry is signed as {kind,url,integrity} with the repository override, never the pack path', async () => {
  const market = await loadMarketLibrary()
  const entry = tarballEntry({ source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), integrity: INTEGRITY } })
  const { packages } = assemble(market, { entries: [entry] })
  assert.equal(packages.length, 1)
  const signed = packages[0]
  assert.deepEqual(signed.source, { kind: 'tarball', url: entry.source.url, integrity: INTEGRITY })
  assert.equal(typeof signed.source.path, 'undefined')
  assert.equal(JSON.stringify(signed).includes('"path"'), false)
  assert.deepEqual(signed.repository, { url: 'https://github.com/example/company-hardened-plugin' })
  assert.equal(signed.integrity, INTEGRITY)
  assert.equal(signed.version, '2.1.0')
})

test('a tarball entry with no repository override is refused (no registry metadata to derive identity)', async () => {
  const market = await loadMarketLibrary()
  const entry = tarballEntry({ repository: undefined, source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), integrity: INTEGRITY } })
  assert.throws(() => assemble(market, { entries: [entry] }), /tarball channel and has no repository override/u)
})

test('a tarball entry carrying the unresolved pack-artifact path form is refused before assembly', async () => {
  const market = await loadMarketLibrary()
  const entry = tarballEntry({ source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), path: 'tools/company-catalog/out/packages/company-hardened-plugin-2.1.0.tgz' } })
  assert.throws(() => assemble(market, { entries: [entry] }), /pack-artifact source form \(path\) with no resolved integrity/u)
})

test('npm entries keep the exact source-free shape and take their integrity from the registry dist', async () => {
  const market = await loadMarketLibrary()
  const npm = {
    packageName: 'plain-plugin',
    version: '1.0.0',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/plain-plugin',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
  }
  const dists = new Map([['plain-plugin@1.0.0', { integrity: 'sha512-xyz', repository: { url: 'https://github.com/example/plain-plugin' } }]])
  const { packages } = assemble(market, { entries: [npm], dists })
  assert.equal(packages[0].integrity, 'sha512-xyz')
  assert.equal('source' in packages[0], false)
})

test('manifest packages are sorted by (packageName, version) for deterministic reviewing', async () => {
  const market = await loadMarketLibrary()
  const entries = [
    tarballEntry({ packageName: 'zeta-plugin', version: '1.0.0', source: { kind: 'tarball', url: tarballUrl('zeta-plugin-1.0.0.tgz'), integrity: INTEGRITY } }),
    tarballEntry({ packageName: 'alpha-plugin', version: '2.0.0', source: { kind: 'tarball', url: tarballUrl('alpha-plugin-2.0.0.tgz'), integrity: INTEGRITY } }),
    tarballEntry({ packageName: 'alpha-plugin', version: '1.5.0', source: { kind: 'tarball', url: tarballUrl('alpha-plugin-1.5.0.tgz'), integrity: INTEGRITY } }),
  ]
  const { packages } = assemble(market, { entries })
  assert.deepEqual(packages.map((p) => `${p.packageName}@${p.version}`), [
    'alpha-plugin@1.5.0',
    'alpha-plugin@2.0.0',
    'zeta-plugin@1.0.0',
  ])
})
