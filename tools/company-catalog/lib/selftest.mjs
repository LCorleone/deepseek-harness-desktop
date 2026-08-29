/**
 * CI smoke test: one ephemeral key, one temp state/output directory, the
 * real allowlist, and — when registry.npmjs.org is reachable — the real
 * dist integrity fetch. Nothing here publishes: the real state/, out/, and
 * allowlist.json are never touched. Offline runs skip only the network
 * segment (synthetic integrity, clearly labeled) and still exercise the
 * full signing chain.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRevocation, applyTreeDigests, entryKey, loadAllowlist, loadTreeDigestFile, repositoryFromPackument, validateAllowlistEntry } from './allowlist.mjs'
import { createEphemeralKeyPair, fingerprintOfRawPublicKey, rawPublicKeyBytes } from './keys.mjs'
import { fetchPackageDist, probeRegistry } from './registry.mjs'
import {
  assembleUnsignedManifest,
  nextSequenceFromSources,
  publishManifest,
  readDeployedSequence,
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
    // Segment: the signed repository identity — every published entry carries
    // the https repository identity that install-time verification back-links
    // against live npm metadata. Expected values go through the same market
    // normalization the build applies (github owner/repository lowercased,
    // git+/.git stripped), so the assertion compares identity, not spelling.
    for (const entry of entries) {
      const raw = entry.repository !== undefined
        ? { url: entry.repository }
        : dists.get(entryKey(entry))?.repository
      const signed = first.manifest.packages.find((pkg) => pkg.packageName === entry.packageName && pkg.version === entry.version)
      assert(signed !== undefined, `entry ${entryKey(entry)} missing from the published manifest`)
      assert(
        typeof signed.repository?.url === 'string' && signed.repository.url.length > 0,
        `published entry ${entryKey(entry)} carries no repository identity`,
      )
      if (raw !== undefined) {
        assert(
          JSON.stringify(signed.repository) === JSON.stringify(market.normalizeRepositoryIdentity(raw)),
          `published entry ${entryKey(entry)} signed repository ${JSON.stringify(signed.repository)} instead of the market-normalized identity of ${JSON.stringify(raw)}`,
        )
      }
    }
    // Fixed offline fixture (no network): the dominant npm packument object
    // form ({url, type, directory}) must parse and flow through the whole
    // assembly chain, with the monorepo `directory` mapped to `subdirectory`.
    const monoEntry = {
      packageName: 'company-mono-plugin',
      version: '1.0.0',
      bundlePatch: './cordis.patch.yml',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
    }
    const monoDist = {
      integrity: `sha512-${createHash('sha512').update('company-mono-plugin selftest dist').digest('base64')}`,
      repository: repositoryFromPackument({
        type: 'git',
        url: 'git+https://github.com/Example/Company-Mono.git',
        directory: 'packages/company-mono-plugin',
      }),
    }
    assert(
      JSON.stringify(monoDist.repository) === JSON.stringify({
        url: 'https://github.com/Example/Company-Mono',
        subdirectory: 'packages/company-mono-plugin',
      }),
      'repositoryFromPackument mishandled the object form (directory must map to subdirectory, git+/.git stripped)',
    )
    const monoUnsigned = assembleUnsignedManifest({
      market,
      sequence: 90,
      expiresAt: new Date(Date.now() + DAY_MS),
      entries: [monoEntry],
      dists: new Map([[entryKey(monoEntry), monoDist]]),
    })
    assert(
      JSON.stringify(monoUnsigned.packages[0].repository) === JSON.stringify({
        url: 'https://github.com/example/company-mono',
        subdirectory: 'packages/company-mono-plugin',
      }),
      'the object packument form did not flow through assembly with directory→subdirectory',
    )
    ok(
      'repository-identity',
      `${String(entries.length)} signed entr${entries.length === 1 ? 'y carries' : 'ies carry'} the market-normalized repository identity; object packument form + directory→subdirectory verified on a fixed offline fixture`,
    )

    // Segment: the optional authority fields (treeDigest, approvedBuilds)
    // flow from the allowlist into the signed manifest verbatim, and entries
    // without them keep the gradual-enablement baseline (no defaulted keys).
    // The values are never derived here: a tree digest is only meaningful
    // when measured in a clean reference environment, so the pipeline signs
    // exactly what review put in the allowlist — nothing.
    const treeDigest = 'b7c1e0d94a2f6d3c5e8f4a6d0c1b9e7d5f3a8c2b6e4d0f9a7c5b3e1d24680ace'
    const authorityEntry = {
      packageName: 'company-authority-plugin',
      version: '2.0.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/company-authority-plugin',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
      treeDigest,
      approvedBuilds: ['sharp', '@scope/native-helper'],
    }
    const authorityDist = {
      integrity: `sha512-${createHash('sha512').update('company-authority-plugin selftest dist').digest('base64')}`,
    }
    const authorityUnsigned = assembleUnsignedManifest({
      market,
      sequence: 91,
      expiresAt: new Date(Date.now() + DAY_MS),
      entries: [authorityEntry],
      dists: new Map([[entryKey(authorityEntry), authorityDist]]),
    })
    const authoritySigned = signUnsignedManifest(market, authorityUnsigned, privateKey, keyId)
    const authorityVerified = verifyManifestText(market, authoritySigned.text, { ...trustRoot, lastSeenSequence: 90 })
    assert(authorityVerified.ok, `an entry carrying treeDigest + approvedBuilds must sign and verify (${why(authorityVerified)})`)
    const signedAuthorityEntry = authorityVerified.manifest.packages[0]
    assert(
      signedAuthorityEntry.treeDigest === treeDigest
        && JSON.stringify(signedAuthorityEntry.approvedBuilds) === JSON.stringify(authorityEntry.approvedBuilds),
      'the signed authority fields differ from the allowlist values',
    )
    const baselineUnsigned = assembleUnsignedManifest({
      market,
      sequence: 91,
      expiresAt: new Date(Date.now() + DAY_MS),
      entries: [monoEntry],
      dists: new Map([[entryKey(monoEntry), monoDist]]),
    })
    assert(
      !('treeDigest' in baselineUnsigned.packages[0]) && !('approvedBuilds' in baselineUnsigned.packages[0]),
      'entries without the authority fields must not gain defaulted keys',
    )
    for (const [field, bad, hint] of [
      ['treeDigest', 'XYZ', '64 lowercase hex'],
      ['treeDigest', 'ab'.repeat(31), '64 lowercase hex'],
      ['approvedBuilds', [], 'non-empty array'],
      ['approvedBuilds', ['ok', ''], 'npm dependency names'],
      ['approvedBuilds', ['dup', 'dup'], 'must not repeat'],
      ['approvedBuilds', ['sharp', 'n'.repeat(215)], 'at most 214 characters'],
      ['packageName', 'p'.repeat(215), 'at most 214 characters'],
    ]) {
      const result = validateAllowlistEntry({ ...authorityEntry, [field]: bad }, 'entry[0]')
      assert(
        result.ok === false && result.reason.includes(hint),
        `the allowlist accepted a malformed ${field} (${JSON.stringify(bad)}): ${result.ok === true ? 'accepted' : result.reason}`,
      )
    }
    ok(
      'authority-fields',
      'treeDigest + approvedBuilds pass through allowlist → assembly → signature verbatim; entries without them stay unchanged; malformed values (shape, duplicates, and the 214-character name bound) are refused at load time',
    )

    // Segment: measured tree digests fill a runtime copy of the allowlist —
    // the measure-and-publish step between the measure script and the signed
    // manifest. Everything here is offline: fixed digest values exercised
    // through the exact functions the CLI command calls.
    const measuredDigest = 'c'.repeat(64)
    const filled = applyTreeDigests(entries, entries.map((entry) => ({
      packageName: entry.packageName,
      version: entry.version,
      treeDigest: measuredDigest,
    })))
    assert(
      filled.filled.length === entries.length && filled.missing.length === 0,
      `every real allowlist entry must gain the measured digest (filled ${String(filled.filled.length)}/${String(entries.length)})`,
    )
    assert(
      filled.entries.every((entry) => entry.treeDigest === measuredDigest),
      'a filled entry must carry the measured digest verbatim',
    )
    assert(
      JSON.stringify(entries) === JSON.stringify(loadAllowlist(allowlistPath)),
      'applyTreeDigests must not mutate the loaded allowlist entries in place',
    )
    const alreadyPinned = {
      packageName: 'company-pinned-plugin',
      version: '1.4.0',
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/company-pinned-plugin',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
      treeDigest: measuredDigest,
    }
    const pinnedResult = applyTreeDigests([alreadyPinned], [{
      packageName: alreadyPinned.packageName,
      version: alreadyPinned.version,
      treeDigest: measuredDigest,
    }])
    assert(
      pinnedResult.unchanged.length === 1 && pinnedResult.entries[0].treeDigest === measuredDigest,
      're-measuring an entry whose reviewed digest equals the measured value must be idempotent',
    )
    let conflicted = false
    try {
      applyTreeDigests([alreadyPinned], [{
        packageName: alreadyPinned.packageName,
        version: alreadyPinned.version,
        treeDigest: 'd'.repeat(64),
      }])
    } catch (error) {
      conflicted = error instanceof Error
        && error.message.includes('never overwrites a reviewed digest')
        && error.message.includes('company-pinned-plugin@1.4.0')
    }
    assert(conflicted, 'a digest file disagreeing with a reviewed treeDigest must abort, naming the entry')
    let unmatched = false
    try {
      applyTreeDigests([], [{ packageName: 'ghost-plugin', version: '0.0.1', treeDigest: measuredDigest }])
    } catch (error) {
      unmatched = error instanceof Error && error.message.includes('ghost-plugin@0.0.1')
    }
    assert(unmatched, 'a digest record matching no allowlist entry must abort, listing it (never silent)')
    const digestFilePath = join(tempDir, 'tree-digests.json')
    writeFileSync(digestFilePath, `${JSON.stringify([{ packageName: 'x', version: '1.0.0', treeDigest: 'e'.repeat(64) }])}\n`, 'utf8')
    assert(
      loadTreeDigestFile(digestFilePath).length === 1,
      'a well-formed digest file must load',
    )
    for (const [body, hint] of [
      ['{}', 'array'],
      ['[{"packageName":"x","version":"1.0.0","treeDigest":"XYZ"}]', '64 lowercase hex'],
      ['[{"packageName":"x","version":"^1","treeDigest":"' + 'e'.repeat(64) + '"}]', 'exact stable semver'],
      ['[{"packageName":"x","version":"1.0.0","treeDigest":"' + 'e'.repeat(64) + '","extra":1}]', 'unknown field'],
      ['[{"packageName":"x","version":"1.0.0","treeDigest":"' + 'e'.repeat(64) + '"},{"packageName":"x","version":"1.0.0","treeDigest":"' + 'e'.repeat(64) + '"}]', 'duplicate'],
    ]) {
      writeFileSync(digestFilePath, body, 'utf8')
      let refused = false
      try {
        loadTreeDigestFile(digestFilePath)
      } catch (error) {
        refused = error instanceof Error && error.message.includes(hint)
      }
      assert(refused, `the digest file accepted a malformed body (${hint})`)
    }
    ok(
      'digest-fill',
      'measured digests fill a runtime allowlist copy (idempotent when equal, abort on reviewed-value conflicts, unmatched records listed); digest-file shape is validated (hex, semver, unknown fields, duplicates)',
    )

    // Segment: assembly must refuse an entry with no repository identity from
    // either source — such packages can never pass the install back-link.
    const anonymous = { ...structuredClone(entries[0]), repository: undefined }
    let rejected = false
    try {
      assembleUnsignedManifest({
        market,
        sequence: 2,
        expiresAt: new Date(Date.now() + DAY_MS),
        entries: [anonymous],
        dists: new Map([[entryKey(anonymous), { integrity: dists.get(entryKey(entries[0])).integrity }]]),
      })
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('no resolvable repository identity')
    }
    assert(rejected, 'assembly accepted an entry without any repository identity')
    // Same refusal for a repository the market identity contract rejects: a
    // github tree URL or any query string would sign, verify as a manifest,
    // then brick the whole catalog on every desktop at the representable-entry
    // check — so the build must abort, naming the entry and the rejected URL.
    for (const override of ['https://github.com/o/r/tree/main', 'https://github.com/o/r?ref=main']) {
      const unrepresentable = { ...structuredClone(entries[0]), repository: override }
      let aborted = false
      try {
        assembleUnsignedManifest({
          market,
          sequence: 2,
          expiresAt: new Date(Date.now() + DAY_MS),
          entries: [unrepresentable],
          dists,
        })
      } catch (error) {
        aborted = error instanceof Error
          && error.message.includes(entryKey(unrepresentable))
          && error.message.includes(override)
      }
      assert(aborted, `assembly accepted a repository the market identity contract rejects (${override})`)
    }
    ok(
      'build-sign-verify',
      'sequence 1 manifest signed and verified from disk (canonical bytes, schema, trust root, signature); assembly aborts on missing and market-unrepresentable repository identities',
    )

    // Segment: the sequence floor — strictly lower is stale, equal replays.
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
    const replay = verifyManifestText(market, first.text, { ...trustRoot, lastSeenSequence: 1 })
    assert(replay.ok, `an equal floor must replay the same-sequence manifest (${why(replay)})`)
    const stale = verifyManifestText(market, first.text, { ...trustRoot, lastSeenSequence: 2 })
    assert(!stale.ok && stale.code === 'stale-sequence', `a lower sequence must be rejected as stale-sequence (${why(stale)})`)
    ok('sequence', 'reissue 1→2 verifies; the sequence-1 manifest replays against floor 1 and is rejected as stale-sequence against floor 2')

    // Segment: the deployed manifest as the sequence source (--sequence-from).
    // The GitLab raw URL is exercised by the publishing workflow; offline this
    // segment uses local files through the exact reader the CLI uses,
    // including the just-signed sequence-1 manifest bytes.
    const deployedPath = join(tempDir, 'deployed-manifest.json')
    writeFileSync(deployedPath, first.text, 'utf8')
    assert(
      (await readDeployedSequence(deployedPath)).sequence === 1,
      'the sequence-1 manifest just signed must read back as sequence 1',
    )
    writeFileSync(deployedPath, `${JSON.stringify({ sequence: 41, manifestVersion: '1.0.0' })}\n`, 'utf8')
    assert(
      (await readDeployedSequence(deployedPath)).sequence === 41,
      'a plain deployed-sequence document must parse',
    )
    for (const [body, hint] of [
      ['{oops', 'not valid JSON'],
      ['[]', 'manifest object'],
      ['{"sequence":"41"}', 'non-negative integer sequence'],
      ['{"sequence":-1}', 'non-negative integer sequence'],
    ]) {
      writeFileSync(deployedPath, body, 'utf8')
      let refused = false
      try {
        await readDeployedSequence(deployedPath)
      } catch (error) {
        refused = error instanceof Error && error.message.includes(hint)
      }
      assert(refused, `the deployed sequence source accepted a malformed body (${hint})`)
    }
    let missingSource = false
    try {
      await readDeployedSequence(join(tempDir, 'definitely-not-here.json'))
    } catch (error) {
      missingSource = error instanceof Error && error.message.includes('not readable')
    }
    assert(missingSource, 'an unreadable sequence source must abort, not silently fall back')
    const composed = nextSequenceFromSources({
      deployedSequence: 6,
      deployedSource: 'https://example.invalid/raw/catalog-manifest.json',
      persistedSequence: 3,
    })
    assert(
      composed.sequence === 7 && composed.source.includes('deployed manifest'),
      `the deployed sequence must win over a behind local state (got ${String(composed.sequence)}, source '${composed.source}')`,
    )
    const aheadState = nextSequenceFromSources({ deployedSequence: 3, deployedSource: 'file', persistedSequence: 6 })
    assert(
      aheadState.sequence === 7 && aheadState.source.includes('higher floor'),
      `a locally-ahead state must raise the floor above the deployed sequence (got ${String(aheadState.sequence)})`,
    )
    const localOnly = nextSequenceFromSources({ persistedSequence: 4 })
    assert(
      localOnly.sequence === 5 && localOnly.source.includes('local state'),
      'without a remote the local state stays the fallback sequence source',
    )
    const explicit = nextSequenceFromSources({ explicit: 9, deployedSequence: 6, deployedSource: 'file', persistedSequence: 3 })
    assert(explicit.sequence === 9, 'an explicit sequence must still win when it exceeds every floor')
    let staleExplicit = false
    try {
      nextSequenceFromSources({ explicit: 6, deployedSequence: 6, deployedSource: 'file' })
    } catch (error) {
      staleExplicit = error instanceof Error && error.message.includes('does not exceed')
    }
    assert(staleExplicit, 'an explicit sequence at or below the deployed floor must be refused')
    ok(
      'deployed-sequence',
      '--sequence-from reads the deployed manifest under size/time bounds (local file here); malformed or unreadable sources abort; composition: deployed wins, locally-ahead state raises the floor, explicit must strictly exceed it',
    )

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
      market,
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
