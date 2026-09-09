/**
 * The stable package-removal guard (cross-review P1, the soak-window trap).
 *
 * publish-local.mjs refuses a stable push whose manifest omits a packageName
 * the deployed stable manifest still pins unrevoked — the canonical trap is
 * the beta soak window: while a package's only allowlist entry carries the
 * beta flag (free-search 0.4.184), every stable publish assembles a stable
 * manifest WITHOUT the package, and pushing it would silently remove the
 * package from every machine's catalog. The guard compares packageName sets
 * (a version bump keeps the package and never triggers it), treats an
 * all-revoked deployed entry as the legal removal path (revocation IS
 * removal), never fires on the beta channel (roster/soak dynamics may
 * legitimately shrink the beta file), runs in --dry-run so drills surface
 * the trap before a real push, and yields only to an explicit
 * --allow-package-removal acknowledgement.
 *
 * Everything runs offline: tarball-channel-only allowlist entries with
 * inline reviewed integrity (no registry round trip), a local --deployed
 * baseline, and --dry-run (an overridden ratchet source requires it).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEphemeralKeyPair, fingerprintOfRawPublicKey, rawPublicKeyBytes } from '../lib/keys.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const CLI = join(TOOL_DIR, '..', 'cli.mjs')
const PUBLISH_LOCAL = join(TOOL_DIR, '..', 'publish-local.mjs')
const ORIGIN = 'https://gitlab.company.example'
const GITLAB_ORIGIN = 'gitlab.company.example'
const PROJECT = 'julu/dsh-desktop-config'

const keyPair = createEphemeralKeyPair()
const SIGNING_KEY = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const KEY_ID = 'removal-guard-test-key'
const FINGERPRINT = fingerprintOfRawPublicKey(rawPublicKeyBytes(keyPair.publicKey))
const SIGN_ENV = {
  COMPANY_CATALOG_SIGNING_KEY: SIGNING_KEY,
  COMPANY_CATALOG_KEY_ID: KEY_ID,
  COMPANY_CATALOG_ORIGIN: ORIGIN,
}

/** Deterministic fixture tarball bytes + their sha512 integrity for one entry. */
function tarballFixture(packageName, version) {
  const bytes = Buffer.from(`${packageName}@${version} removal-guard fixture tarball bytes\n`, 'utf8')
  return { bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
}

/**
 * One tarball-channel allowlist entry (the offline shape: an inline reviewed
 * integrity, no registry round trip). `channel: 'beta'` holds the entry back
 * from every stable manifest. `runtime` pins the version's compat window —
 * the field every multi-version entry carries its own (P15: a client picks
 * the entry whose runtime range covers its own).
 */
function entry({ packageName, version, revoked = false, channel, runtime = '^0.1.2-rc.1' }) {
  const { integrity } = tarballFixture(packageName, version)
  return {
    packageName,
    version,
    bundlePatch: './cordis.patch.yml',
    repository: `https://github.com/example/${packageName}`,
    revoked,
    runtime: { dshRuntimeVersion: runtime },
    source: { kind: 'tarball', url: `${ORIGIN}/${PROJECT}/-/raw/master/packages/${packageName}-${version}.tgz`, integrity },
    ...(channel === undefined ? {} : { channel }),
  }
}

/** One offline workspace: shared state ratchet, allowlist, drill policy. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'company-catalog-removal-guard-'))
  const stateDir = join(root, 'state')
  const allowlistPath = join(root, 'allowlist.json')
  const digestFilePath = join(root, 'tree-digests.json')
  const policyPath = join(root, 'drill-policy.json')
  writeFileSync(digestFilePath, '[]\n', 'utf8')
  writeFileSync(policyPath, `${JSON.stringify({ trustRoots: [{ keyId: KEY_ID, fingerprint: FINGERPRINT }] })}\n`, 'utf8')
  const writeAllowlist = (entries) => writeFileSync(allowlistPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  writeAllowlist([])
  return { root, stateDir, allowlistPath, digestFilePath, policyPath, writeAllowlist }
}

/** Sign one channel's manifest + meta sidecar into `outDir` on the shared ratchet. */
function publish(workspace_, entries, outDir, channel = 'stable') {
  const manifestFile = channel === 'beta' ? 'catalog-manifest.beta.json' : 'catalog-manifest.json'
  workspace_.writeAllowlist(entries)
  const probe = spawnSync(process.execPath, [CLI,
    'measure-and-publish',
    ...(channel === 'stable' ? [] : ['-f', `channel=${channel}`]),
    '--allowlist', workspace_.allowlistPath,
    '--state-dir', workspace_.stateDir,
    '--out', join(outDir, manifestFile),
    '--meta-out', join(outDir, 'publish-meta.json'),
    '--digest-file', workspace_.digestFilePath,
  ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...SIGN_ENV } })
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
  assert.equal(probe.status, 0, `measure-and-publish failed:\n${output}`)
  return join(outDir, manifestFile)
}

/** Stage every entry's fixture tarball into the artifact's packages/ layout. */
function stageTarballs(entries, outDir) {
  const packagesDir = join(outDir, 'packages')
  mkdirSync(packagesDir, { recursive: true })
  for (const allowlistEntry of entries) {
    const { bytes } = tarballFixture(allowlistEntry.packageName, allowlistEntry.version)
    writeFileSync(join(packagesDir, `${allowlistEntry.packageName}-${allowlistEntry.version}.tgz`), bytes)
  }
}

/**
 * Run publish-local as a dry-run drill against one deployed baseline.
 * --confirm-fleet-upgraded acknowledges the orthogonal first-`source`-publish
 * gate (these fixtures all carry tarball sources) so the removal guard is
 * the only gate under test.
 */
function runPublisher({ work, artifactDir, deployedPath, extra = [], channel = 'stable' }) {
  const probe = spawnSync(process.execPath, [PUBLISH_LOCAL,
    '--artifact-dir', artifactDir,
    '--deployed', deployedPath,
    '--dry-run',
    '--channel', channel,
    '--gitlab', GITLAB_ORIGIN,
    '--project', PROJECT,
    '--policy', work.policyPath,
    '--confirm-fleet-upgraded',
    ...extra,
  ], { encoding: 'utf8', timeout: 120_000 })
  return { status: probe.status, output: `${probe.stdout ?? ''}\n${probe.stderr ?? ''}` }
}

// --- shared-ratchet skip: a stable artifact may legitimately jump past
// deployed+1 when the beta channel consumed the intervening sequence numbers
// (the live case: stable 13 → beta 14,15 → stable 16). Stale (≤ deployed)
// stays a hard refusal.
test('shared ratchet: a stable artifact skipping past deployed+1 passes; stale does not', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    // Deployed stable at sequence 1.
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' })], deployedDir)
    // Advance the shared state twice WITHOUT deploying stable (beta consumed 2 and 3).
    stageTarballs([entry({ packageName: 'soak-a', version: '1.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' })], join(work.root, 'beta-consume-1'), 'beta')
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' })], join(work.root, 'beta-consume-2'), 'beta')
    // The stable artifact now carries sequence 4 against deployed 1 — a legal skip.
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' })], artifactDir)
    const skip = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.equal(skip.status, 0, `the shared-racket skip was refused:\n${skip.output}`)
    assert.match(skip.output, /skips past deployed/u, 'the skip is logged as legitimate')
    // Stale: the very artifact that is already deployed (sequence 1 vs 1).
    const stale = runPublisher({ work, artifactDir: deployedDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.notEqual(stale.status, 0, 'a stale (already-deployed) artifact was admitted')
    assert.match(stale.output, /stale/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('red: a stable artifact dropping an unrevoked deployed package is refused, before any push plan (dry-run reports it)', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    // Deployed stable: A@1.0.0 + B@1.0.0, both unrevoked (sequence 1).
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-b', version: '1.0.0' })], deployedDir)
    // The soak-window shape: the artifact (sequence 2) carries only A@2.0.0 —
    // B's allowlist entry is beta-flagged, so the stable assembly dropped it.
    stageTarballs([entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '2.0.0' }), entry({ packageName: 'soak-b', version: '1.0.0', channel: 'beta' })], artifactDir)

    const refusal = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.notEqual(refusal.status, 0, `the removal guard admitted the soak-window artifact:\n${refusal.output}`)
    assert.match(refusal.output, /package-removal guard/u, 'the refusal must name the guard')
    assert.match(refusal.output, /soak-b/u, 'the refusal must name the dropped package')
    assert.match(refusal.output, /--allow-package-removal/u, 'the refusal must name the acknowledgement flag')
    assert.match(refusal.output, /promote/u, 'the refusal must point at the promote path for a soaking upgrade')
    assert.match(refusal.output, /revoke/u, 'the refusal must point at the revoke path for a real removal')
    assert.doesNotMatch(refusal.output, /push plan:/u, 'a refused publish must never print a push plan')
    assert.doesNotMatch(refusal.output, /dry-run: stopped before the clone/u, 'the refusal must precede the plan/clone stage')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('the same artifact publishes as a dry-run plan with --allow-package-removal (explicit acknowledgement)', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-b', version: '1.0.0' })], deployedDir)
    // P15: the upgrade keeps the old pin (soak-a 1.0.0 + 2.0.0 both ride
    // stable) — the only disappearance is soak-b, the acknowledged one.
    stageTarballs([entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-a', version: '2.0.0' }), entry({ packageName: 'soak-b', version: '1.0.0', channel: 'beta' })], artifactDir)

    const acknowledged = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json'), extra: ['--allow-package-removal'] })
    assert.equal(acknowledged.status, 0, `the acknowledged removal must pass the dry-run gauntlet:\n${acknowledged.output}`)
    assert.match(acknowledged.output, /removal guard: --allow-package-removal acknowledged for soak-b/u)
    assert.doesNotMatch(acknowledged.output, /version-retire guard/u, 'no version dropped — the dual-pin upgrade keeps the old pin')
    assert.match(acknowledged.output, /push plan:/u)
    assert.match(acknowledged.output, /dry-run: stopped before the clone/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('a deployed entry pinned revoked:true may disappear without the flag — revocation is the supported removal path', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    // Deployed stable: B is already revoked (sequence 1) — a later manifest
    // without B is the steady state after a revocation, not a removal.
    publish(work, [
      entry({ packageName: 'soak-a', version: '1.0.0' }),
      entry({ packageName: 'soak-b', version: '1.0.0', revoked: true }),
    ], deployedDir)
    // P15: the upgrade keeps soak-a's old pin, so the only disappearance
    // is the revoked soak-b.
    stageTarballs([entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)

    const published = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.equal(published.status, 0, `a revoked package leaving the manifest must not trip the guard:\n${published.output}`)
    assert.doesNotMatch(published.output, /package-removal guard/u)
    assert.doesNotMatch(published.output, /version-retire guard/u)
    assert.match(published.output, /push plan:/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('a version bump that keeps the old pin never trips any guard — P15 promote adds an entry and keeps the old ones', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' })], deployedDir)
    // The P15 shape: 1.0.0 stays pinned next to 2.0.0 (the compat window).
    stageTarballs([entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)

    const upgraded = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.equal(upgraded.status, 0, `a dual-pin upgrade must never trip any guard:\n${upgraded.output}`)
    assert.doesNotMatch(upgraded.output, /package-removal guard/u)
    assert.doesNotMatch(upgraded.output, /version-retire guard/u)
    assert.match(upgraded.output, /push plan:/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('the guard is stable-channel only: a beta artifact omitting a stable package never trips it', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact-beta')
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' }), entry({ packageName: 'soak-b', version: '1.0.0' })], deployedDir)
    // A beta publication carrying only A (sequence 2, ratcheting against the
    // deployed stable baseline via --deployed): roster/soak dynamics may
    // legitimately shrink the beta file — the guard must stay silent.
    stageTarballs([entry({ packageName: 'soak-a', version: '1.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' })], artifactDir, 'beta')

    const beta = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json'), channel: 'beta' })
    assert.equal(beta.status, 0, `a beta publication must not face the stable removal guard:\n${beta.output}`)
    assert.doesNotMatch(beta.output, /package-removal guard/u)
    assert.match(beta.output, /push plan:/u)
    assert.match(beta.output, /beta channel; the stable catalog-manifest\.json is not touched by this push/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

// --- P15 Phase 0: the multi-version compat window ---------------------------------
//
// One package may pin several versions at once (the sidebar 0.15.2 + 0.18.1
// shape): promote adds an entry and keeps the old pins, clients boot by
// exact name@version, and a pin leaving the manifest boot-refuses every
// machine still on it. The chain below proves the whole pipeline carries
// two versions of one name (allowlist → digest keying → assembly → signing
// → verification → the publish gauntlet) and that a version never leaves
// silently: only the explicit retire flow (revoke → publish → retire) or
// the --allow-version-retire acknowledgement drops it.

test('multi-version pins: two versions of one package ride the whole pipeline green, each with its own runtime window', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    // The sidebar shape: 0.15.2 pinned for the ^0.1.1 runtime line,
    // 0.18.1 for ^0.1.2 — one allowlist, one manifest, both signed.
    const oldPin = entry({ packageName: 'sidebar', version: '0.15.2', runtime: '^0.1.1' })
    const newPin = entry({ packageName: 'sidebar', version: '0.18.1', runtime: '^0.1.2-rc.1' })
    publish(work, [oldPin, newPin], deployedDir)

    // The manifest carries BOTH versions, each with its own runtime range —
// and an old client's boot lookup (exact name@version) hits the old pin.
    const manifest = JSON.parse(readFileSync(join(deployedDir, 'catalog-manifest.json'), 'utf8'))
    const keys = manifest.packages.map((manifestEntry) => `${manifestEntry.packageName}@${manifestEntry.version}`)
    assert.deepEqual(keys, ['sidebar@0.15.2', 'sidebar@0.18.1'], 'assembly sorts by (name, version); both pins present')
    const bootLookup = manifest.packages.find((manifestEntry) => manifestEntry.packageName === 'sidebar' && manifestEntry.version === '0.15.2')
    assert.notEqual(bootLookup, undefined, 'an old client booting by exact name@version finds its pin')
    assert.equal(bootLookup.runtime.dshRuntimeVersion, '^0.1.1', 'the old pin keeps its own runtime window')
    assert.equal(bootLookup.revoked, false)
    const bootLookupNew = manifest.packages.find((manifestEntry) => manifestEntry.packageName === 'sidebar' && manifestEntry.version === '0.18.1')
    assert.equal(bootLookupNew.runtime.dshRuntimeVersion, '^0.1.2-rc.1', 'the new pin carries the new runtime window')

    // The re-publication of the same two pins passes the publish gauntlet.
    stageTarballs([oldPin, newPin], artifactDir)
    publish(work, [oldPin, newPin], artifactDir)
    const green = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.equal(green.status, 0, `a dual-pin stable artifact must pass the gauntlet:\n${green.output}`)
    assert.doesNotMatch(green.output, /package-removal guard/u)
    assert.doesNotMatch(green.output, /version-retire guard/u)
    assert.match(green.output, /push plan:/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('red: a stable artifact silently dropping one unrevoked version of a package it still lists is refused', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    const oldPin = entry({ packageName: 'sidebar', version: '0.15.2', runtime: '^0.1.1' })
    const newPin = entry({ packageName: 'sidebar', version: '0.18.1', runtime: '^0.1.2-rc.1' })
    publish(work, [oldPin, newPin], deployedDir)
    // The silent drop: a hand edit deleting the "old" allowlist entry — the
    // package stays (0.18.1), the old pin silently leaves the window.
    stageTarballs([newPin], artifactDir)
    publish(work, [newPin], artifactDir)

    const refusal = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.notEqual(refusal.status, 0, `the version-retire guard admitted the silent version drop:\n${refusal.output}`)
    assert.match(refusal.output, /version-retire guard/u, 'the refusal must name the guard')
    assert.match(refusal.output, /sidebar@0\.15\.2/u, 'the refusal must name the dropped version')
    assert.match(refusal.output, /revoke/u, 'the refusal must point at the revoke → retire flow')
    assert.match(refusal.output, /retire/u)
    assert.match(refusal.output, /--allow-version-retire/u, 'the refusal must name the acknowledgement flag')
    assert.doesNotMatch(refusal.output, /push plan:/u, 'a refused publish must never print a push plan')
    assert.doesNotMatch(refusal.output, /dry-run: stopped before the clone/u, 'the refusal must precede the plan/clone stage')
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('the same artifact publishes as a dry-run plan with --allow-version-retire (explicit acknowledgement)', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    const oldPin = entry({ packageName: 'sidebar', version: '0.15.2', runtime: '^0.1.1' })
    const newPin = entry({ packageName: 'sidebar', version: '0.18.1', runtime: '^0.1.2-rc.1' })
    publish(work, [oldPin, newPin], deployedDir)
    stageTarballs([newPin], artifactDir)
    publish(work, [newPin], artifactDir)

    const acknowledged = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json'), extra: ['--allow-version-retire'] })
    assert.equal(acknowledged.status, 0, `the acknowledged version retire must pass the dry-run gauntlet:\n${acknowledged.output}`)
    assert.match(acknowledged.output, /removal guard: --allow-version-retire acknowledged for sidebar@0\.15\.2/u)
    assert.match(acknowledged.output, /push plan:/u)
    assert.match(acknowledged.output, /dry-run: stopped before the clone/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('a deployed version pinned revoked:true may leave without any flag — revoke → publish → retire is the supported retire flow', () => {
  const work = workspace()
  try {
    // Deployed steady state after the flow's first half: 0.15.2 revoked
    // (the signed retire record), 0.18.1 still pinned.
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    publish(work, [
      entry({ packageName: 'sidebar', version: '0.15.2', runtime: '^0.1.1', revoked: true }),
      entry({ packageName: 'sidebar', version: '0.18.1', runtime: '^0.1.2-rc.1' }),
    ], deployedDir)
    const newPin = entry({ packageName: 'sidebar', version: '0.18.1', runtime: '^0.1.2-rc.1' })
    stageTarballs([newPin], artifactDir)
    publish(work, [newPin], artifactDir)

    const published = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.equal(published.status, 0, `a revoked version leaving the manifest must not trip any guard:\n${published.output}`)
    assert.doesNotMatch(published.output, /package-removal guard/u)
    assert.doesNotMatch(published.output, /version-retire guard/u)
    assert.match(published.output, /push plan:/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

/** Run one CLI subcommand against the workspace (allowlist/state/out wired in). */
function runCli(work, arguments_, outDir) {
  const probe = spawnSync(process.execPath, [CLI, ...arguments_,
    '--allowlist', work.allowlistPath,
    '--state-dir', work.stateDir,
    '--out', join(outDir, 'catalog-manifest.json'),
  ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...SIGN_ENV } })
  return { status: probe.status, output: `${probe.stdout ?? ''}\n${probe.stderr ?? ''}` }
}

test('the explicit retire flow: retire refuses an unrevoked pin, and revoke → retire removes the version from both allowlist and manifest, publishing green', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const revokedDir = join(work.root, 'revoked')
    const retiredDir = join(work.root, 'retired')
    const oldPin = entry({ packageName: 'sidebar', version: '0.15.2', runtime: '^0.1.1' })
    const newPin = entry({ packageName: 'sidebar', version: '0.18.1', runtime: '^0.1.2-rc.1' })
    publish(work, [oldPin, newPin], deployedDir)

    // retire before revoke = red: the window never loses an unrevoked pin
    // through the retire command either.
    work.writeAllowlist([oldPin, newPin])
    const premature = runCli(work, ['retire', 'sidebar@0.15.2'], retiredDir)
    assert.notEqual(premature.status, 0, 'retire must refuse an unrevoked pin')
    assert.match(premature.output, /sidebar@0\.15\.2 is not revoked — revoke it first/u)
    // A versionless retire spec is refused too (the CLI spec parser names
    // it before applyRetirement's own versionless guard ever runs).
    const versionless = runCli(work, ['retire', 'sidebar'], retiredDir)
    assert.notEqual(versionless.status, 0)
    assert.match(versionless.output, /is not a <name>@<version> spec/u)

    // Half one: revoke records the signed retire record (entry stays, revoked).
    const revocation = runCli(work, ['revoke', 'sidebar@0.15.2'], revokedDir)
    assert.equal(revocation.status, 0, `revoke failed:\n${revocation.output}`)
    const revokedManifest = JSON.parse(readFileSync(join(revokedDir, 'catalog-manifest.json'), 'utf8'))
    const revokedEntry = revokedManifest.packages.find((manifestEntry) => manifestEntry.version === '0.15.2')
    assert.equal(revokedEntry.revoked, true, 'the revocation is signed into the manifest')

    // The out file retire re-signs must already exist (retire moves signed
    // bytes verbatim, zero re-derivation — like promote): publish the
    // revoked-carrying allowlist into the retire output directory first.
    publish(work, [entry({ packageName: 'sidebar', version: '0.15.2', runtime: '^0.1.1', revoked: true }), newPin], retiredDir)

    // Half two: retire removes the window entry — the allowlist loses it and
    // the re-signed manifest no longer contains the version at all.
    const retirement = runCli(work, ['retire', 'sidebar@0.15.2'], retiredDir)
    assert.equal(retirement.status, 0, `retire failed:\n${retirement.output}`)
    assert.match(retirement.output, /allowlist: sidebar@0\.15\.2 retired/u)
    const retiredManifest = JSON.parse(readFileSync(join(retiredDir, 'catalog-manifest.json'), 'utf8'))
    const retiredKeys = retiredManifest.packages.map((manifestEntry) => `${manifestEntry.packageName}@${manifestEntry.version}`)
    assert.deepEqual(retiredKeys, ['sidebar@0.18.1'], 'the retired version left the manifest; the package stays')
    const allowlistAfter = JSON.parse(readFileSync(work.allowlistPath, 'utf8'))
    assert.deepEqual(allowlistAfter.map((allowlistEntry) => `${allowlistEntry.packageName}@${allowlistEntry.version}`), ['sidebar@0.18.1'])
    assert.ok(retiredManifest.sequence > revokedManifest.sequence, 'the retire re-sign advances the shared ratchet')

    // And the retired artifact publishes green against the revoked deployed
    // baseline — the revoke record is what the guard trusts.
    const artifactDir = join(work.root, 'artifact')
    stageTarballs([newPin], artifactDir)
    publish(work, [newPin], artifactDir)
    const green = runPublisher({ work, artifactDir, deployedPath: join(revokedDir, 'catalog-manifest.json') })
    assert.equal(green.status, 0, `the retired artifact must publish green against the revoked baseline:\n${green.output}`)
    assert.doesNotMatch(green.output, /package-removal guard/u)
    assert.doesNotMatch(green.output, /version-retire guard/u)
    assert.match(green.output, /push plan:/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('the guard text is wired: the flag exists in the usage and the guard block reads the deployed manifest', () => {
  const source = readFileSync(PUBLISH_LOCAL, 'utf8')
  assert.ok(source.includes('--allow-package-removal'), 'the flag appears in the source (usage + guard)')
  assert.ok(source.includes('--allow-version-retire'), 'the P15 flag appears in the source (usage + guard)')
  assert.ok(source.match(/channel === 'stable'/u), 'the guard is scoped to the stable push path')
  const usage = spawnSync(process.execPath, [PUBLISH_LOCAL, '--help'], { encoding: 'utf8', timeout: 30_000 })
  const help = `${usage.stdout ?? ''}\n${usage.stderr ?? ''}`
  assert.match(help, /--allow-package-removal/u, 'the usage text documents the flag')
  assert.match(help, /--allow-version-retire/u, 'the usage text documents the P15 flag')
  assert.match(help, /soak/u, 'the usage text explains the soak-window trap')
})
