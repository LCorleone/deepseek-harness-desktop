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
import { assembleUnsignedManifest, signUnsignedManifest, verifyManifestText } from '../lib/pipeline.mjs'
import { validateAllowlistEntry } from '../lib/allowlist.mjs'
import { createEphemeralKeyPair, rawPublicKeyBytes } from '../lib/keys.mjs'
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
  runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
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
    runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
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

// ---------------------------------------------------------------------------
// Entry descriptions (2026-09-10): the optional allowlist `description`
// one-liner is signed verbatim into the entry; entries without one keep the
// exact previous byte shape (no `description` key at all).
// ---------------------------------------------------------------------------

test('a reviewed description is signed verbatim into the entry on both channels', async () => {
  const market = await loadMarketLibrary()
  const text = '常驻侧边栏：上下文用量、会话与工具状态一目了然'
  const tarball = tarballEntry({
    description: text,
    source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), integrity: INTEGRITY },
  })
  const npm = {
    packageName: 'plain-plugin',
    version: '1.0.0',
    description: '另一个插件的描述',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/plain-plugin',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
  }
  const dists = new Map([['plain-plugin@1.0.0', { integrity: 'sha512-xyz', repository: { url: 'https://github.com/example/plain-plugin' } }]])
  const { packages } = assemble(market, { entries: [tarball, npm], dists })
  const signedTarball = packages.find((entry) => entry.packageName === 'company-hardened-plugin')
  const signedNpm = packages.find((entry) => entry.packageName === 'plain-plugin')
  assert.equal(signedTarball.description, text)
  assert.equal(signedNpm.description, '另一个插件的描述')
})

test('entries without a description keep the exact previous shape — the key never appears', async () => {
  const market = await loadMarketLibrary()
  const entries = [
    tarballEntry({ source: { kind: 'tarball', url: tarballUrl('company-hardened-plugin-2.1.0.tgz'), integrity: INTEGRITY } }),
    {
      packageName: 'plain-plugin',
      version: '1.0.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/plain-plugin',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
    },
  ]
  const dists = new Map([['plain-plugin@1.0.0', { integrity: 'sha512-xyz', repository: { url: 'https://github.com/example/plain-plugin' } }]])
  const { packages } = assemble(market, { entries, dists })
  assert.equal(packages.length, 2)
  for (const signed of packages) {
    assert.equal('description' in signed, false)
    assert.equal(JSON.stringify(signed).includes('"description"'), false)
  }
})

test('the allowlist validator accepts only a non-empty string description and normalizes it through', () => {
  const base = {
    packageName: 'plain-plugin',
    version: '1.0.0',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/plain-plugin',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
  }
  const good = validateAllowlistEntry({ ...base, description: '一句话描述' }, 'entry[0]')
  assert.equal(good.ok, true)
  assert.equal(good.value.description, '一句话描述')
  const absent = validateAllowlistEntry({ ...base }, 'entry[0]')
  assert.equal(absent.ok, true)
  assert.equal('description' in absent.value, false)
  assert.equal(validateAllowlistEntry({ ...base, description: '' }, 'entry[0]').ok, false)
  assert.equal(validateAllowlistEntry({ ...base, description: 42 }, 'entry[0]').ok, false)
})

test('a description-carrying manifest round-trips the tool verifier (source-free npm channel included)', async () => {
  const market = await loadMarketLibrary()
  const { privateKey, publicKey } = createEphemeralKeyPair()
  const keyId = 'description-spec-key'
  const fingerprint = market.ed25519PublicKeyFingerprint(rawPublicKeyBytes(publicKey))
  const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`
  const entries = [{
    packageName: 'plain-plugin',
    version: '1.0.0',
    description: '一句话描述',
    bundlePatch: './cordis.patch.yml',
    repository: 'https://github.com/example/plain-plugin',
    revoked: false,
    runtime: { dshRuntimeVersion: '^0.1.2-rc.1' },
  }]
  const dists = new Map([['plain-plugin@1.0.0', { integrity, repository: { url: 'https://github.com/example/plain-plugin' } }]])
  const unsigned = assembleUnsignedManifest({ market, sequence: 4, expiresAt: new Date('2030-01-01T00:00:00Z'), entries, dists })
  const { manifest, text } = signUnsignedManifest(market, unsigned, privateKey, keyId)
  assert.equal(manifest.packages[0].description, '一句话描述')
  assert.equal(text.includes('"description"'), true)
  // The tool-side mirror accepts the extension, and the legacy cross-check
  // scopes itself to extension-free documents: a description-only npm
  // manifest is NOT market-verifiable (one unknown key), so verifying it
  // through verifyManifestText must not abort as a mirror divergence.
  const verification = await verifyManifestText(market, text, { fingerprint, keyId })
  assert.equal(verification.ok, true)
  assert.equal(verification.manifest.packages[0].description, '一句话描述')
})
