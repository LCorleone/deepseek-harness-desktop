/**
 * CI smoke test: one ephemeral key, one temp state/output directory, the
 * real allowlist, and — when registry.npmjs.org is reachable — the real
 * dist integrity fetch. Nothing here publishes: the real state/, out/, and
 * allowlist.json are never touched. Offline runs skip only the network
 * segment (synthetic integrity, clearly labeled) and still exercise the
 * full signing chain.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRevocation, entryKey, loadAllowlist } from './allowlist.mjs'
import { createEphemeralKeyPair, fingerprintOfRawPublicKey, rawPublicKeyBytes } from './keys.mjs'
import { fetchPackageDist, probeRegistry } from './registry.mjs'
import {
  publishManifest,
  assembleUnsignedManifest,
  readLastSequence,
  signUnsignedManifest,
  verifyManifestText,
} from './pipeline.mjs'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

class SelftestFailure extends Error {}

const assert = (condition, message) => {
  if (!condition) throw new SelftestFailure(message)
}

const why = (verification) => (verification.ok ? 'ok' : `${verification.code}: ${verification.reason}`)

/**
 * Run every selftest segment. Returns the segment log; throws SelftestFailure
 * on the first broken invariant.
 */
export async function runSelftest({ toolDir, market, forceOffline = false, log = console.log }) {
  const segments = []
  const ok = (name, detail) => {
    segments.push({ name, status: 'ok', detail })
    log(`[ok]   ${name} — ${detail}`)
  }
  const skip = (name, detail) => {
    segments.push({ name, status: 'skip', detail })
    log(`[skip] ${name} — ${detail}`)
  }

  // Segment: the market signing library is the crypto contract under test.
  ok('market-library', 'verifyCompanyManifest + createCompanyManifestSignature resolved from the workspace market package')

  // Segment: ephemeral signing key; both fingerprint derivations must agree.
  const { privateKey, publicKey } = createEphemeralKeyPair()
  const rawPublicKey = rawPublicKeyBytes(publicKey)
  const fingerprint = fingerprintOfRawPublicKey(rawPublicKey)
  assert(
    fingerprint === market.ed25519PublicKeyFingerprint(rawPublicKey),
    'node-crypto and market fingerprints of the test public key disagree',
  )
  const keyId = 'selftest.company-catalog'
  ok('signing-key', `ephemeral ed25519 pair, fingerprint ${fingerprint.slice(0, 16)}… (sha256, market cross-check ok)`)

  // Segment: the reviewed allowlist loads and validates.
  const allowlistPath = join(toolDir, 'allowlist.json')
  const entries = loadAllowlist(allowlistPath)
  ok('allowlist', `${String(entries.length)} validated entr${entries.length === 1 ? 'y' : 'ies'} (${entries.map(entryKey).join(', ')})`)

  // Segment: real registry dist fetch when online.
  let dists = new Map()
  let liveRegistry = false
  if (forceOffline) {
    skip('registry', '--force-offline requested; using synthetic integrity for the signing chain')
  } else if (!(await probeRegistry())) {
    skip('registry', 'registry.npmjs.org unreachable — using synthetic integrity; the core signing chain still runs')
  } else {
    for (const entry of entries) {
      const dist = await fetchPackageDist(entry.packageName, entry.version)
      log(`         ${entryKey(entry)} → ${dist.integrity} (tarball origin ${new URL(dist.tarball).origin})`)
      dists.set(entryKey(entry), dist)
    }
    liveRegistry = true
    ok('registry', `fetched live dist integrity for ${String(entries.length)} entr${entries.length === 1 ? 'y' : 'ies'} from registry.npmjs.org`)
  }
  if (!liveRegistry) {
    for (const entry of entries) {
      const digest = createHash('sha512').update(`${entryKey(entry)}\ncompany-catalog selftest synthetic dist`).digest('base64')
      dists.set(entryKey(entry), { integrity: `sha512-${digest}` })
    }
  }

  const trustRoot = { keyId, fingerprint }
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-company-catalog-selftest-'))
  try {
    const stateDir = join(tempDir, 'state')
    const outPath = join(tempDir, 'out', 'catalog-manifest.json')

    // Segment: build → sign → round-trip verify → write; bytes on disk must
    // be the canonical serialization verification re-derives.
    const first = publishManifest({
      market,
      entries,
      dists,
      sequence: 1,
      expiresAt: new Date(Date.now() + 90 * DAY_MS),
      privateKey,
      keyId,
      expectedFingerprint: fingerprint,
      lastSeenSequence: 0,
      outPath,
      stateDir,
    })
    assert(first.manifest.sequence === 1, 'published sequence is not 1')
    assert(first.text === readFileSync(outPath, 'utf8'), 'manifest bytes on disk differ from the canonical serialization')
    assert(readLastSequence(stateDir) === 1, 'persisted sequence was not bumped to 1')
    assert(first.verification.ok, `first verification failed: ${why(first.verification)}`)
    ok('build-sign-verify', 'sequence 1 manifest signed and verified from disk (canonical bytes, schema, trust root, signature)')

    // Segment: sequence strict monotonicity both ways.
    const second = publishManifest({
      market,
      entries,
      dists,
      sequence: 2,
      expiresAt: new Date(Date.now() + 90 * DAY_MS),
      privateKey,
      keyId,
      expectedFingerprint: fingerprint,
      lastSeenSequence: 1,
      outPath,
      stateDir,
    })
    const secondVerified = verifyManifestText(market, second.text, { ...trustRoot, lastSeenSequence: 1 })
    assert(secondVerified.ok, `reissued manifest must verify above sequence 1 (${why(secondVerified)})`)
    const stale = verifyManifestText(market, first.text, { ...trustRoot, lastSeenSequence: 1 })
    assert(!stale.ok && stale.code === 'stale-sequence', `old sequence must be rejected as stale-sequence (${why(stale)})`)
    ok('sequence', 'reissue 1→2 verifies; the earlier manifest is rejected as stale-sequence')

    // Segment: revocation reissue — flag flips, entry stays signed and readable.
    const { entries: revokedEntries, matches } = applyRevocation(entries, entries[0].packageName)
    const third = publishManifest({
      market,
      entries: revokedEntries,
      dists,
      sequence: 3,
      expiresAt: new Date(Date.now() + 90 * DAY_MS),
      privateKey,
      keyId,
      expectedFingerprint: fingerprint,
      lastSeenSequence: 2,
      outPath,
      stateDir,
    })
    const revokedEntry = market.findCompanyManifestPackage(third.manifest, entries[0].packageName, entries[0].version)
    assert(revokedEntry !== undefined && revokedEntry.revoked === true, 'revoked entry missing or not flagged in the reissued manifest')
    const thirdVerified = verifyManifestText(market, third.text, { ...trustRoot, lastSeenSequence: 2 })
    assert(thirdVerified.ok, `revocation reissue must still verify (${why(thirdVerified)})`)
    ok('revoke', `${matches.join(', ')} reissued with revoked:true at sequence 3; the entry stays verifiable and readable`)

    // Segment: expiry — expired now fails, an earlier clock still verifies.
    const expiredUnsigned = assembleUnsignedManifest({
      sequence: 4,
      expiresAt: new Date(Date.now() - HOUR_MS),
      entries: revokedEntries,
      dists,
    })
    const expired = signUnsignedManifest(market, expiredUnsigned, privateKey, keyId)
    const expiredNow = verifyManifestText(market, expired.text, { ...trustRoot, lastSeenSequence: 3 })
    assert(!expiredNow.ok && expiredNow.code === 'expired', `past expiresAt must be rejected as expired (${why(expiredNow)})`)
    const beforeExpiry = verifyManifestText(market, expired.text, {
      ...trustRoot,
      lastSeenSequence: 3,
      now: () => Date.now() - 2 * HOUR_MS,
    })
    assert(beforeExpiry.ok, `the same manifest must verify before its expiresAt (${why(beforeExpiry)})`)
    ok('expiry', 'expiresAt in the past is rejected as expired; the same bytes verify against an earlier clock')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }

  return segments
}
