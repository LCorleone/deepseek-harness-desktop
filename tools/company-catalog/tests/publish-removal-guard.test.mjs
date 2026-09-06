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
 * from every stable manifest.
 */
function entry({ packageName, version, revoked = false, channel }) {
  const { integrity } = tarballFixture(packageName, version)
  return {
    packageName,
    version,
    bundlePatch: './cordis.patch.yml',
    repository: `https://github.com/example/${packageName}`,
    revoked,
    runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
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
    stageTarballs([entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '2.0.0' }), entry({ packageName: 'soak-b', version: '1.0.0', channel: 'beta' })], artifactDir)

    const acknowledged = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json'), extra: ['--allow-package-removal'] })
    assert.equal(acknowledged.status, 0, `the acknowledged removal must pass the dry-run gauntlet:\n${acknowledged.output}`)
    assert.match(acknowledged.output, /removal guard: --allow-package-removal acknowledged for soak-b/u)
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
    stageTarballs([entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)

    const published = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.equal(published.status, 0, `a revoked package leaving the manifest must not trip the guard:\n${published.output}`)
    assert.doesNotMatch(published.output, /package-removal guard/u)
    assert.match(published.output, /push plan:/u)
  } finally {
    rmSync(work.root, { recursive: true, force: true })
  }
})

test('a version bump keeps the package present — the guard compares packageNames, never name@version', () => {
  const work = workspace()
  try {
    const deployedDir = join(work.root, 'deployed')
    const artifactDir = join(work.root, 'artifact')
    publish(work, [entry({ packageName: 'soak-a', version: '1.0.0' })], deployedDir)
    stageTarballs([entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)
    publish(work, [entry({ packageName: 'soak-a', version: '2.0.0' })], artifactDir)

    const upgraded = runPublisher({ work, artifactDir, deployedPath: join(deployedDir, 'catalog-manifest.json') })
    assert.equal(upgraded.status, 0, `an in-place version bump must never trip the guard:\n${upgraded.output}`)
    assert.doesNotMatch(upgraded.output, /package-removal guard/u)
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

test('the guard text is wired: the flag exists in the usage and the guard block reads the deployed manifest', () => {
  const source = readFileSync(PUBLISH_LOCAL, 'utf8')
  assert.ok(source.includes('--allow-package-removal'), 'the flag appears in the source (usage + guard)')
  assert.ok(source.match(/channel === 'stable'/u), 'the guard is scoped to the stable push path')
  const usage = spawnSync(process.execPath, [PUBLISH_LOCAL, '--help'], { encoding: 'utf8', timeout: 30_000 })
  const help = `${usage.stdout ?? ''}\n${usage.stderr ?? ''}`
  assert.match(help, /--allow-package-removal/u, 'the usage text documents the flag')
  assert.match(help, /soak/u, 'the usage text explains the soak-window trap')
})
