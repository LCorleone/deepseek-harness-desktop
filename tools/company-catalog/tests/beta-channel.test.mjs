/**
 * Beta catalog channel (P9): the three pipeline subcommands and the beta
 * manifest schema, pinned end to end against the real market library.
 *
 * - `measure-and-publish -f channel=beta` writes catalog-manifest.beta.json
 *   (signed testers roster from state/beta-testers.json, the initial three
 *   when the file does not exist) while the stable manifest is not touched;
 *   the stable channel holds beta-flagged allowlist entries back.
 * - `promote <name>@<version>` moves the beta entry into the stable manifest
 *   verbatim (same integrity, same fields — zero re-verification), re-signs
 *   both manifests on the shared ratchet, and is an idempotent no-op when
 *   the stable manifest already pins the same entry.
 * - `beta-roster --add/--remove` changes the signed roster (validated,
 *   lowercased) and re-signs the beta manifest with the entries verbatim; a
 *   no-op change consumes no sequence.
 *
 * The schema half pins the one-extension rule: `channel: 'beta'` admits the
 * optional top-level `testers` array (well-formed emails, normalized to
 * lowercase — an uppercase entry is a spelling variant, not a forgery), and
 * the stable channel keeps the exact previous key set, so a
 * testers-carrying document never verifies as stable.
 *
 * Everything runs offline: the allowlists are tarball-channel-only with
 * reviewed inline integrity (no registry round trip), and the CLI runs as a
 * subprocess with an ephemeral in-memory signing key — exactly the e2e
 * drill's discipline, at unit speed.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEphemeralKeyPair, fingerprintOfRawPublicKey, rawPublicKeyBytes } from '../lib/keys.mjs'
import { loadMarketLibrary } from '../lib/market.mjs'
import {
  assembleRepublishPackages,
  assembleUnsignedManifest,
  prepareVerifiedManifest,
  republishManifestPackages,
  verifyManifestText,
} from '../lib/pipeline.mjs'
import { validateCompanyManifestShapeWithSources } from '../lib/manifest-shape.mjs'
import { loadSemverRangeChecker } from '../lib/market.mjs'
import {
  INITIAL_BETA_TESTERS,
  applyBetaRosterChanges,
  loadBetaTesters,
} from '../lib/beta-roster.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const CLI = join(TOOL_DIR, '..', 'cli.mjs')
const ORIGIN = 'https://gitlab.company.example'
const PROJECT = 'julu/dsh-desktop-config'
const INTEGRITY_A = `sha512-${Buffer.alloc(64, 0).toString('base64')}`
const INTEGRITY_B = `sha512-${(() => { const bytes = Buffer.alloc(64, 0); bytes[63] = 1; return bytes.toString('base64') })()}`
const tarballUrl = (filename) => `${ORIGIN}/${PROJECT}/-/raw/master/packages/${filename}`
const EXPIRY = new Date('2030-01-01T00:00:00Z')

const keyPair = createEphemeralKeyPair()
const SIGNING_KEY = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const KEY_ID = 'beta-test-key'
const SIGN_ENV = {
  COMPANY_CATALOG_SIGNING_KEY: SIGNING_KEY,
  COMPANY_CATALOG_KEY_ID: KEY_ID,
  COMPANY_CATALOG_ORIGIN: ORIGIN,
}

/** One offline workspace: state, out, allowlist — nothing touches the repo tree. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'company-catalog-beta-'))
  const stateDir = join(root, 'state')
  const outDir = join(root, 'out')
  const allowlistPath = join(root, 'allowlist.json')
  const stableOut = join(outDir, 'catalog-manifest.json')
  const betaOut = join(outDir, 'catalog-manifest.beta.json')
  const digestFile = join(root, 'digestsests.json')
  return {
    root,
    stateDir,
    outDir,
    allowlistPath,
    stableOut,
    betaOut,
    digestFile,
    writeAllowlist(entries) {
      writeFileSync(allowlistPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    },
  }
}

const stableEntry = () => ({
  packageName: 'corp-stable-plugin',
  version: '1.0.0',
  bundlePatch: './cordis.patch.yml',
  repository: 'https://github.com/example/corp-stable-plugin',
  revoked: false,
  runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
  source: { kind: 'tarball', url: tarballUrl('corp-stable-plugin-1.0.0.tgz'), integrity: INTEGRITY_A },
})

const betaEntry = () => ({
  packageName: 'corp-beta-plugin',
  version: '0.9.0',
  channel: 'beta',
  bundlePatch: './cordis.patch.yml',
  repository: 'https://github.com/example/corp-beta-plugin',
  revoked: false,
  runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
  treeDigest: '648b218888dce4f35b4ab642273f808089e81b5c3bd93e8b42e605117b824237',
  source: { kind: 'tarball', url: tarballUrl('corp-beta-plugin-0.9.0.tgz'), integrity: INTEGRITY_B },
})

/** Run the CLI as a subprocess with the ephemeral signing environment. */
function runCli(args) {
  const probe = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...SIGN_ENV },
  })
  return { status: probe.status, output: `${probe.stdout ?? ''}\n${probe.stderr ?? ''}` }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

test('measure-and-publish -f channel=beta signs the beta manifest (initial roster) and leaves stable alone', () => {
  const work = workspace()
  try {
    work.writeAllowlist([stableEntry(), betaEntry()])
    writeFileSync(work.digestFile, '[]\n', 'utf8')
    const beta = runCli([
      'measure-and-publish', '-f', 'channel=beta',
      '--allowlist', work.allowlistPath,
      '--state-dir', work.stateDir,
      '--out', work.betaOut,
      '--digest-file', work.digestFile,
    ])
    assert.equal(beta.status, 0, beta.output)
    const manifest = readJson(work.betaOut)
    assert.deepEqual(manifest.testers, INITIAL_BETA_TESTERS)
    assert.equal(manifest.packages.length, 2, 'the beta manifest is the superset: stable + beta-flagged entries')
    assert.ok(manifest.packages.some((entry) => entry.packageName === 'corp-beta-plugin'))
    assert.equal(manifest.sequence, 1)
    assert.equal(existsSync(work.stableOut), false, 'the stable manifest file is not created by a beta publication')
    assert.equal(readJson(join(work.stateDir, 'last-sequence.json')).lastSequence, 1, 'the shared ratchet advanced')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('the stable channel holds beta-flagged entries back; the beta file is untouched', () => {
  const work = workspace()
  try {
    // Beta first (the rollout order), then a stable publication must leave
    // the beta file byte-identical and sign only the stable-flagged entries.
    work.writeAllowlist([stableEntry(), betaEntry()])
    writeFileSync(work.digestFile, '[]\n', 'utf8')
    assert.equal(runCli([
      'measure-and-publish', '-f', 'channel=beta',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.betaOut, '--digest-file', work.digestFile,
    ]).status, 0)
    const betaBytesBefore = readFileSync(work.betaOut)
    const stable = runCli([
      'measure-and-publish',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut, '--digest-file', work.digestFile,
    ])
    assert.equal(stable.status, 0, stable.output)
    const stableManifest = readJson(work.stableOut)
    assert.equal(stableManifest.sequence, 2, 'the shared ratchet: stable signs the next sequence')
    assert.deepEqual(
      stableManifest.packages.map((entry) => entry.packageName),
      ['corp-stable-plugin'],
      'the beta-flagged entry is held back from the stable manifest',
    )
    assert.equal(stableManifest.testers, undefined, 'the stable manifest never carries a testers key')
    assert.ok(readFileSync(work.betaOut).equals(betaBytesBefore), 'the beta file is byte-identical after a stable publication')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('an invalid channel flag is rejected (red)', () => {
  const work = workspace()
  try {
    work.writeAllowlist([stableEntry()])
    writeFileSync(work.digestFile, '[]\n', 'utf8')
    const bad = runCli([
      'measure-and-publish', '-f', 'channel=gamma',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.betaOut, '--digest-file', work.digestFile,
    ])
    assert.notEqual(bad.status, 0)
    assert.match(bad.output, /--channel must be 'stable' or 'beta'/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

/** Publish both channel files into the workspace: stable first, then beta. */
function publishBoth(work) {
  work.writeAllowlist(work.entries ?? [stableEntry(), betaEntry()])
  writeFileSync(work.digestFile, '[]\n', 'utf8')
  const stable = runCli([
    'measure-and-publish',
    '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
    '--out', work.stableOut, '--digest-file', work.digestFile,
  ])
  if (stable.status !== 0) throw new Error(`stable publish failed: ${stable.output}`)
  const beta = runCli([
    'measure-and-publish', '-f', 'channel=beta',
    '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
    '--out', work.betaOut, '--digest-file', work.digestFile,
  ])
  if (beta.status !== 0) throw new Error(`beta publish failed: ${beta.output}`)
}

test('promote moves the beta entry verbatim, re-signs both manifests on the shared ratchet, and flips the allowlist', async () => {
  const market = await loadMarketLibrary()
  const work = workspace()
  try {
    publishBoth(work)
    const betaBefore = readJson(work.betaOut)
    const promoted = runCli([
      'promote', 'corp-beta-plugin@0.9.0',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(promoted.status, 0, promoted.output)
    const stableManifest = readJson(work.stableOut)
    const betaManifest = readJson(work.betaOut)
    const promotedEntry = stableManifest.packages.find((entry) => entry.packageName === 'corp-beta-plugin')
    const betaSourceEntry = betaBefore.packages.find((entry) => entry.packageName === 'corp-beta-plugin')
    assert.ok(promotedEntry !== undefined, 'the promoted entry is in the stable manifest')
    assert.deepEqual(promotedEntry, betaSourceEntry, 'same bytes, same digest — the entry moved verbatim (zero re-verification)')
    assert.equal(promotedEntry.integrity, INTEGRITY_B)
    assert.equal(stableManifest.sequence, 3, 'stable re-signs first on the shared ratchet (stable 1, beta 2, promote 3+4)')
    assert.equal(betaManifest.sequence, 4, 'beta re-signs next on the shared ratchet')
    assert.deepEqual(betaManifest.testers, INITIAL_BETA_TESTERS, 'the roster rides the beta re-sign unchanged')
    assert.deepEqual(
      betaManifest.packages.find((entry) => entry.packageName === 'corp-beta-plugin'),
      betaSourceEntry,
      'the beta entry itself is unchanged by promotion',
    )
    assert.equal(readJson(join(work.stateDir, 'last-sequence.json')).lastSequence, 4)
    const allowlist = readJson(work.allowlistPath)
    assert.equal(allowlist.find((entry) => entry.packageName === 'corp-beta-plugin').channel, undefined, 'the allowlist beta flag is cleared')
    // Both written files verify under their own channel with the real verifier.
    const stableText = readFileSync(work.stableOut, 'utf8')
    const stableVerification = await verifyManifestText(market, stableText, { fingerprint: fingerprintOfKey(), keyId: KEY_ID, companyCatalogOrigin: ORIGIN, channel: 'stable' })
    assert.equal(stableVerification.ok, true, JSON.stringify(stableVerification))
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('promote is an idempotent no-op when the stable manifest already pins the same entry', () => {
  const work = workspace()
  try {
    publishBoth(work)
    assert.equal(runCli([
      'promote', 'corp-beta-plugin@0.9.0',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ]).status, 0)
    const stateAfterPromote = readJson(join(work.stateDir, 'last-sequence.json')).lastSequence
    const stableBytesAfterPromote = readFileSync(work.stableOut)
    const again = runCli([
      'promote', 'corp-beta-plugin@0.9.0',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(again.status, 0, again.output)
    assert.match(again.output, /idempotent no-op/u)
    assert.equal(readJson(join(work.stateDir, 'last-sequence.json')).lastSequence, stateAfterPromote, 'no sequence consumed')
    assert.ok(readFileSync(work.stableOut).equals(stableBytesAfterPromote), 'the stable manifest is untouched')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('promote refuses an entry that is on neither manifest (red)', () => {
  const work = workspace()
  try {
    publishBoth(work)
    const missing = runCli([
      'promote', 'ghost-plugin@9.9.9',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.notEqual(missing.status, 0)
    assert.match(missing.output, /is not in the beta manifest/u)
    assert.equal(readJson(join(work.stateDir, 'last-sequence.json')).lastSequence, 2, 'a refused promote consumes no sequence')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('beta-roster --add re-signs the beta manifest with the normalized roster, entries verbatim', () => {
  const work = workspace()
  try {
    publishBoth(work)
    const before = readJson(work.betaOut)
    const roster = runCli([
      'beta-roster', '-f', 'add=New.Tester@DeloitteCN.com.cn',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(roster.status, 0, roster.output)
    const after = readJson(work.betaOut)
    assert.deepEqual(
      after.testers,
      [...INITIAL_BETA_TESTERS, 'new.tester@deloittecn.com.cn'],
      'the added address is normalized (lowercased) into the signed roster',
    )
    assert.deepEqual(after.packages, before.packages, 'the entries are re-signed verbatim — only the roster changed')
    assert.equal(after.sequence, before.sequence + 1, 'the shared ratchet advanced by exactly one')
    const state = loadBetaTesters(work.stateDir)
    assert.equal(state.existed, true, 'the roster state file is materialized on first change')
    assert.deepEqual(state.testers, after.testers)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('beta-roster --remove takes an address out; a no-op change consumes no sequence', () => {
  const work = workspace()
  try {
    publishBoth(work)
    const bytesBefore = readFileSync(work.betaOut)
    const noOp = runCli([
      'beta-roster', '-f', 'add=JULU@deloittecn.com.cn',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(noOp.status, 0, noOp.output)
    assert.match(noOp.output, /no effective change/u)
    assert.ok(readFileSync(work.betaOut).equals(bytesBefore), 'an add that changes nothing re-signs nothing')
    const remove = runCli([
      'beta-roster', '-f', 'remove=sebtang@deloittecn.com.cn',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(remove.status, 0, remove.output)
    assert.deepEqual(
      readJson(work.betaOut).testers,
      ['julu@deloittecn.com.cn', 'lizywu@deloittecn.com.cn'],
    )
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('beta-roster refuses a malformed address without touching anything (red)', () => {
  const work = workspace()
  try {
    publishBoth(work)
    const bytesBefore = readFileSync(work.betaOut)
    const bad = runCli([
      'beta-roster', '-f', 'add=not-an-email',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.notEqual(bad.status, 0)
    assert.match(bad.output, /not a usable email address/u)
    assert.ok(readFileSync(work.betaOut).equals(bytesBefore))
    assert.equal(existsSync(join(work.stateDir, 'beta-testers.json')), false, 'the state file is not created by a refused change')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('the beta channel schema normalizes uppercase testers entries instead of rejecting them', async () => {
  const market = await loadMarketLibrary()
  const validRange = await loadSemverRangeChecker()
  const unsigned = assembleUnsignedManifest({
    market,
    sequence: 5,
    expiresAt: EXPIRY,
    entries: [stableEntry()],
    dists: new Map(),
    channel: 'beta',
    testers: ['Julu@DeloitteCN.com.cn'],
  })
  assert.deepEqual(unsigned.testers, ['julu@deloittecn.com.cn'], 'assembly normalizes the roster to lowercase')
  const { text } = await republishManifestPackages({
    market,
    packages: unsigned.packages,
    sequence: 6,
    expiresAt: EXPIRY,
    privateKey: keyPair.privateKey,
    keyId: KEY_ID,
    lastSeenSequence: 5,
    outPath: join(tmpdir(), `beta-shape-${process.pid}.json`),
    stateDir: join(tmpdir(), `beta-shape-state-${process.pid}`),
    companyCatalogOrigin: ORIGIN,
    channel: 'beta',
    testers: ['Julu@DeloitteCN.com.cn'],
  })
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed.testers, ['julu@deloittecn.com.cn'], 'the signed bytes carry the normalized lowercase roster')
  const shape = validateCompanyManifestShapeWithSources(parsed, { validRange, companyCatalogOrigin: ORIGIN, channel: 'beta' })
  assert.deepEqual(shape.testers, ['julu@deloittecn.com.cn'])
})

test('the beta channel schema rejects non-email testers entries and duplicates (red)', async () => {
  const validRange = await loadSemverRangeChecker()
  const base = {
    manifestVersion: '1.0.0',
    sequence: 5,
    expiresAt: '2030-01-01T00:00:00.000Z',
    packages: [],
    signature: { keyId: KEY_ID, publicKey: 'A'.repeat(43) + '=', value: 'B'.repeat(86) + '==' },
  }
  assert.throws(
    () => validateCompanyManifestShapeWithSources({ ...base, testers: ['no-at-sign'] }, { validRange, channel: 'beta' }),
    /well-formed email/u,
  )
  assert.throws(
    () => validateCompanyManifestShapeWithSources({ ...base, testers: ['a@b.co', 'A@B.co'] }, { validRange, channel: 'beta' }),
    /must not repeat/u,
  )
  assert.throws(
    () => validateCompanyManifestShapeWithSources({ ...base, testers: 'a@b.co' }, { validRange, channel: 'beta' }),
    /array of email/u,
  )
})

test('the stable channel rejects a testers key whole — the stable schema is unchanged (red line)', async () => {
  const validRange = await loadSemverRangeChecker()
  const base = {
    manifestVersion: '1.0.0',
    sequence: 5,
    expiresAt: '2030-01-01T00:00:00.000Z',
    packages: [],
    signature: { keyId: KEY_ID, publicKey: 'A'.repeat(43) + '=', value: 'B'.repeat(86) + '==' },
  }
  assert.throws(
    () => validateCompanyManifestShapeWithSources({ ...base, testers: ['a@b.co'] }, { validRange, channel: 'stable' }),
    /unknown field\(s\) testers/u,
    'a testers-carrying document never verifies as stable',
  )
  const market = await loadMarketLibrary()
  const unsigned = assembleUnsignedManifest({ market, sequence: 7, expiresAt: EXPIRY, entries: [stableEntry()], dists: new Map() })
  assert.equal(unsigned.testers, undefined, 'the stable assembly output carries no testers key at all')
})

test('assembleUnsignedManifest holds beta-flagged entries back from the stable channel and includes them on beta', async () => {
  const market = await loadMarketLibrary()
  const stable = assembleUnsignedManifest({ market, sequence: 8, expiresAt: EXPIRY, entries: [stableEntry(), betaEntry()], dists: new Map() })
  assert.deepEqual(stable.packages.map((entry) => entry.packageName), ['corp-stable-plugin'])
  const beta = assembleUnsignedManifest({ market, sequence: 9, expiresAt: EXPIRY, entries: [stableEntry(), betaEntry()], dists: new Map(), channel: 'beta', testers: ['a@b.co'] })
  assert.equal(beta.packages.length, 2)
  assert.deepEqual(beta.testers, ['a@b.co'])
})

test('the roster state helpers validate, normalize, and default to the initial test group', () => {
  const work = workspace()
  try {
    const missing = loadBetaTesters(work.stateDir)
    assert.deepEqual(missing.testers, INITIAL_BETA_TESTERS)
    assert.equal(missing.existed, false)
    const changed = applyBetaRosterChanges(INITIAL_BETA_TESTERS, { add: ' New@Example.CO ' })
    assert.deepEqual(changed.testers, [...INITIAL_BETA_TESTERS, 'new@example.co'])
    assert.equal(changed.changed, true)
    const noOp = applyBetaRosterChanges(INITIAL_BETA_TESTERS, { remove: 'nobody@elsewhere.io' })
    assert.deepEqual(noOp.testers, INITIAL_BETA_TESTERS)
    assert.equal(noOp.changed, false)
    assert.throws(() => applyBetaRosterChanges(INITIAL_BETA_TESTERS, { add: 'still-not-an-email' }), /not a usable email/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('revoke re-signs the beta manifest too: the matched entry is revoked:true on both channels (P9 review fix)', async () => {
  const market = await loadMarketLibrary()
  const work = workspace()
  try {
    publishBoth(work)
    const revoked = runCli([
      'revoke', 'corp-stable-plugin@1.0.0',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(revoked.status, 0, revoked.output)
    const stable = readJson(work.stableOut)
    const beta = readJson(work.betaOut)
    assert.equal(stable.packages.find((entry) => entry.packageName === 'corp-stable-plugin').revoked, true)
    assert.equal(
      beta.packages.find((entry) => entry.packageName === 'corp-stable-plugin').revoked,
      true,
      'the revocation reached the beta manifest (the superset), not just stable',
    )
    assert.equal(stable.sequence, 3, 'the stable reissue consumes the next shared sequence')
    assert.equal(beta.sequence, 4, 'the beta re-sign consumes the one after it')
    assert.deepEqual(beta.testers, INITIAL_BETA_TESTERS, 'the beta re-sign keeps the signed roster')
    const betaVerification = await verifyManifestText(market, readFileSync(work.betaOut, 'utf8'), {
      fingerprint: fingerprintOfKey(), keyId: KEY_ID, companyCatalogOrigin: ORIGIN, channel: 'beta',
    })
    assert.equal(betaVerification.ok, true, JSON.stringify(betaVerification))
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('after a revoke, beta-roster add/remove re-signs with the entry still revoked:true (P9 review fix, red)', () => {
  const work = workspace()
  try {
    publishBoth(work)
    // Revoke a beta-flagged soak entry: stable never pinned it, so the beta
    // manifest is the ONLY channel that can carry the revocation to testers.
    const revoked = runCli([
      'revoke', 'corp-beta-plugin@0.9.0',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(revoked.status, 0, revoked.output)
    assert.equal(
      readJson(work.betaOut).packages.find((entry) => entry.packageName === 'corp-beta-plugin').revoked,
      true,
      'a beta-only entry is revoked in the beta manifest',
    )
    const roster = runCli([
      'beta-roster', '-f', 'add=Fourth.Tester@DeloitteCN.com.cn',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(roster.status, 0, roster.output)
    const beta = readJson(work.betaOut)
    assert.equal(
      beta.packages.find((entry) => entry.packageName === 'corp-beta-plugin').revoked,
      true,
      'the verbatim roster re-sign keeps the revoked entry revoked — it must not resurrect it',
    )
    assert.deepEqual(beta.testers, [...INITIAL_BETA_TESTERS, 'fourth.tester@deloittecn.com.cn'])
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

/**
 * Reproduce the incident shape the defense-in-depth alignment exists for:
 * the allowlist revocation reached the STABLE manifest only (the old revoke
 * behavior), leaving the deployed beta file stale with revoked:false. Every
 * later beta re-sign (beta-roster, promote) must re-align before signing.
 */
function publishStaleBetaWorkspace(work) {
  publishBoth(work)
  const allowlist = readJson(work.allowlistPath)
  allowlist.find((entry) => entry.packageName === 'corp-stable-plugin').revoked = true
  work.writeAllowlist(allowlist)
  const stable = runCli([
    'measure-and-publish',
    '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
    '--out', work.stableOut, '--digest-file', work.digestFile,
  ])
  if (stable.status !== 0) throw new Error(`stable publish failed: ${stable.output}`)
  const stableManifest = readJson(work.stableOut)
  const betaManifest = readJson(work.betaOut)
  assert.equal(
    stableManifest.packages.find((entry) => entry.packageName === 'corp-stable-plugin').revoked,
    true,
    'control: the stable manifest carries the revocation',
  )
  assert.equal(
    betaManifest.packages.find((entry) => entry.packageName === 'corp-stable-plugin').revoked,
    false,
    'control: the beta file is stale — it still says revoked:false',
  )
}

test('beta-roster aligns a stale beta file with the stable revocation state (defense in depth, red)', () => {
  const work = workspace()
  try {
    publishStaleBetaWorkspace(work)
    const roster = runCli([
      'beta-roster', '-f', 'add=fifth.tester@deloittecn.com.cn',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(roster.status, 0, roster.output)
    assert.equal(
      readJson(work.betaOut).packages.find((entry) => entry.packageName === 'corp-stable-plugin').revoked,
      true,
      'a stable-revoked name@version is forced revoked:true by every beta re-sign, even from a stale source file',
    )
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('promote aligns the beta re-sign with the stable revocation state (defense in depth, red)', () => {
  const work = workspace()
  try {
    publishStaleBetaWorkspace(work)
    const promoted = runCli([
      'promote', 'corp-beta-plugin@0.9.0',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(promoted.status, 0, promoted.output)
    const beta = readJson(work.betaOut)
    assert.equal(
      beta.packages.find((entry) => entry.packageName === 'corp-stable-plugin').revoked,
      true,
      'the beta re-sign during promote forces the stable-revoked entry back to revoked:true',
    )
    assert.equal(
      readJson(work.stableOut).packages.find((entry) => entry.packageName === 'corp-beta-plugin') !== undefined,
      true,
      'control: the promotion itself succeeded',
    )
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('promote leaves zero residue when the re-sign path fails (allowlist untouched, red)', () => {
  const work = workspace()
  try {
    publishBoth(work)
    const allowlistBefore = readFileSync(work.allowlistPath)
    const stableBefore = readFileSync(work.stableOut)
    const betaBefore = readFileSync(work.betaOut)
    // An explicit sequence at the persisted floor fails inside the re-sign
    // path, AFTER both manifests verified — exactly the window that used to
    // sit between the allowlist flip and the signings.
    const failed = runCli([
      'promote', 'corp-beta-plugin@0.9.0',
      '--sequence', '1',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.notEqual(failed.status, 0)
    assert.match(failed.output, /does not exceed the persisted/u)
    assert.ok(readFileSync(work.allowlistPath).equals(allowlistBefore), 'the allowlist beta flag is untouched')
    assert.ok(readFileSync(work.stableOut).equals(stableBefore), 'the stable manifest is untouched')
    assert.ok(readFileSync(work.betaOut).equals(betaBefore), 'the beta manifest is untouched')
    assert.equal(readJson(join(work.stateDir, 'last-sequence.json')).lastSequence, 2, 'no sequence consumed')
    // The same workspace still promotes cleanly afterwards.
    const clean = runCli([
      'promote', 'corp-beta-plugin@0.9.0',
      '--allowlist', work.allowlistPath, '--state-dir', work.stateDir,
      '--out', work.stableOut,
    ])
    assert.equal(clean.status, 0, clean.output)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('prepareVerifiedManifest raises a wrong-key signing failure before anything may be written (red)', async () => {
  const market = await loadMarketLibrary()
  const work = workspace()
  try {
    publishBoth(work)
    const wrongKey = createEphemeralKeyPair()
    await assert.rejects(
      () => prepareVerifiedManifest({
        market,
        unsigned: assembleRepublishPackages({
          packages: readJson(work.betaOut).packages,
          sequence: 99,
          expiresAt: EXPIRY,
          channel: 'beta',
          testers: ['a@b.co'],
        }),
        privateKey: wrongKey.privateKey,
        keyId: KEY_ID,
        // The pin names the deployment key, so verification of the inputs
        // succeeds while the wrong key cannot sign: the failure a prepare-
        // then-commit promote must surface before any commit.
        expectedFingerprint: fingerprintOfKey(),
        lastSeenSequence: 2,
        companyCatalogOrigin: ORIGIN,
        channel: 'beta',
      }),
      /does not match the pinned/u,
    )
    assert.equal(readJson(join(work.stateDir, 'last-sequence.json')).lastSequence, 2, 'the ratchet is untouched')
    assert.equal(readJson(work.betaOut).sequence, 2, 'the beta manifest is untouched')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

/** Fingerprint of the ephemeral key, as the verification trust root pins it. */
const fingerprintOfKey = () => fingerprintOfRawPublicKey(rawPublicKeyBytes(keyPair.publicKey))
