/**
 * Company catalog publishing CLI (P2-6).
 *
 * Signs the reviewed allowlist into the canonical, ed25519-signed company
 * manifest consumed by DSH Desktop (schema:
 * dsh-community-market/docs/schemas/company-manifest.schema.json). Plain
 * Node script: no build step, no dependencies beyond Node built-ins and the
 * built dsh-community-market workspace package.
 *
 * Signing material comes only from the environment:
 *   COMPANY_CATALOG_SIGNING_KEY      base64 PKCS#8 DER ed25519 private key
 *   COMPANY_CATALOG_KEY_ID           keyId written into the signature block
 *   COMPANY_CATALOG_KEY_FINGERPRINT  optional pinned trust-root fingerprint
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyTreeDigests,
  applyRevocation,
  entryKey,
  loadAllowlist,
  loadTreeDigestFile,
  repositoryFromPackument,
  saveAllowlist,
  validateAllowlistEntry,
} from './lib/allowlist.mjs'
import { generateSigningMaterial, loadSigningKeyFromEnv } from './lib/keys.mjs'
import { loadMarketLibrary } from './lib/market.mjs'
import { fetchPackageDist } from './lib/registry.mjs'
import {
  expiryFromDays,
  nextSequenceFromSources,
  publishManifest,
  readDeployedSequence,
  readLastSequence,
  verifyManifestText,
} from './lib/pipeline.mjs'
import { runSelftest } from './lib/selftest.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

const USAGE = `Usage: node tools/company-catalog/cli.mjs <command> [options]

Commands:
  build                        Fetch dist integrity for every allowlist entry from
                               registry.npmjs.org, assemble, sign, verify, and publish
                               the manifest (sequence = persisted + 1).
  measure-and-publish          Fill measured tree digests (--digest-file) into a
                               runtime copy of the allowlist, then build (sequence
                               floor: --sequence-from or the local state file)
                               and verify; the signed manifest is written to --out
                               and its metadata to --meta-out for the publishing
                               workflow. The reviewed allowlist.json is never
                               modified.
  revoke <pkg>[@<version>]     Mark allowlist entries revoked:true and reissue the
                               manifest with a higher sequence (entries are kept).
  verify [path]                Verify a manifest file end to end
                               (default: out/catalog-manifest.json).
  keygen                       Generate an ed25519 key pair and print the pipeline
                               environment values (private material — handle with care).
  selftest                     End-to-end smoke test with an ephemeral key; never
                               publishes, never touches state/ or out/.
  help                         Show this help.

Options:
  --allowlist <path>     Allowlist file   (default: tools/company-catalog/allowlist.json)
  --out <path>           Manifest output  (default: tools/company-catalog/out/catalog-manifest.json)
  --state-dir <path>     Sequence state   (default: tools/company-catalog/state)
  --sequence <n>         Explicit sequence; must strictly exceed the persisted one
  --sequence-from <src>  Deployed manifest URL or file: its sequence is the floor
                         for the next one (wins over the local state file, which
                         stays the fallback when this is omitted)
  --digest-file <path>   measure-and-publish: measured tree digests
                         [{packageName, version, treeDigest}] (see measure.mjs)
  --meta-out <path>      measure-and-publish: write publish metadata next to the
                         manifest (sequence, keyId, fingerprint, manifestSha256,
                         entries with measured flags; CI adds gitSha/runId)
  --expires-days <n>     expiresAt horizon in days (default: 90)
  --force-offline        selftest only: skip the npm registry segment

Signing environment:
  COMPANY_CATALOG_SIGNING_KEY       base64 PKCS#8 DER ed25519 private key, single line;
                                    read from the environment only, never from files
  COMPANY_CATALOG_KEY_ID            keyId embedded in the signature block
  COMPANY_CATALOG_KEY_FINGERPRINT   optional 64-hex sha256 of the raw public key; a
                                    mismatch aborts publishing`

const fail = (message) => {
  console.error(`company-catalog: ${message}`)
  process.exitCode = 1
}

/** Minimal hand-rolled parser: `--flag value`, `--flag=value`, positionals. */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  const valueFlags = new Set(['allowlist', 'out', 'state-dir', 'sequence', 'sequence-from', 'digest-file', 'meta-out', 'expires-days'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const equals = argument.indexOf('=')
    const name = (equals === -1 ? argument.slice(2) : argument.slice(2, equals))
    if (!valueFlags.has(name)) {
      if (equals !== -1) throw new Error(`--${name} does not take a value`)
      flags[name] = true
      continue
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1)
    if (value === undefined) throw new Error(`--${name} requires a value`)
    if (equals === -1) index += 1
    flags[name] = value
  }
  return { positionals, flags }
}

const integerFlag = (flags, name) => {
  const value = flags[name]
  if (value === undefined) return undefined
  if (!/^-?[0-9]+$/u.test(value)) throw new Error(`--${name} must be an integer (got '${value}')`)
  return Number.parseInt(value, 10)
}

function defaultPaths(flags) {
  // Explicit paths are cwd-relative (or absolute); defaults live in the tool.
  const fromCwd = (value) => resolve(process.cwd(), value)
  return {
    allowlistPath: flags.allowlist !== undefined ? fromCwd(flags.allowlist) : resolve(TOOL_DIR, 'allowlist.json'),
    outPath: flags.out !== undefined ? fromCwd(flags.out) : resolve(TOOL_DIR, join('out', 'catalog-manifest.json')),
    stateDir: flags['state-dir'] !== undefined ? fromCwd(flags['state-dir']) : resolve(TOOL_DIR, 'state'),
  }
}

/** Resolve registry dist for every allowlist entry; hard-fails on any error. */
async function resolveDists(entries) {
  const dists = new Map()
  for (const entry of entries) {
    const dist = await fetchPackageDist(entry.packageName, entry.version)
    const repository = entry.repository ?? dist.repository?.url
      ?? 'none resolvable (set repository in the allowlist or fix the npm metadata)'
    console.log(`registry: ${entryKey(entry)} → ${dist.integrity} (tarball ${dist.tarball}; repository ${repository})`)
    dists.set(entryKey(entry), dist)
  }
  return dists
}

/** Shared tail of `build` and `revoke`: publish the current allowlist. */
async function publishFromAllowlist(flags, allowlistPathOverride) {
  const market = await loadMarketLibrary()
  const { privateKey, keyId, expectedFingerprint } = loadSigningKeyFromEnv()
  const { allowlistPath, outPath, stateDir } = defaultPaths(flags)
  const effectiveAllowlistPath = allowlistPathOverride ?? allowlistPath
  const entries = loadAllowlist(effectiveAllowlistPath)
  const dists = await resolveDists(entries)
  const sequenceFrom = flags['sequence-from']
  const persistedSequence = readLastSequence(stateDir)
  let deployedSequence
  let deployedSource
  if (sequenceFrom !== undefined) {
    ;({ sequence: deployedSequence, source: deployedSource } = await readDeployedSequence(sequenceFrom))
  }
  const { sequence, floor, source: sequenceSource } = nextSequenceFromSources({
    explicit: integerFlag(flags, 'sequence'),
    ...(deployedSequence === undefined ? {} : { deployedSequence, deployedSource }),
    persistedSequence,
  })
  const { manifest, fingerprint } = publishManifest({
    market,
    entries,
    dists,
    sequence,
    expiresAt: expiryFromDays(integerFlag(flags, 'expires-days') ?? 90),
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence: floor,
    outPath,
    stateDir,
  })
  const revoked = manifest.packages.filter((entry) => entry.revoked).length
  console.log('published company manifest:')
  console.log(`  sequence:    ${String(manifest.sequence)} (sequence source: ${sequenceSource})`)
  console.log(`  expiresAt:   ${manifest.expiresAt}`)
  console.log(`  packages:    ${String(manifest.packages.length)} (${String(revoked)} revoked)`)
  console.log(`  keyId:       ${keyId}`)
  console.log(`  fingerprint: ${fingerprint}`)
  console.log(`  manifest:    ${outPath}`)
  console.log(`  state:       ${resolve(stateDir, 'last-sequence.json')}`)
  return { manifest, fingerprint, outPath, sequenceSource }
}

async function commandBuild(flags) {
  await publishFromAllowlist(flags)
}

/**
 * `measure-and-publish`: fill measured tree digests into a runtime copy of
 * the allowlist, build against the deployed sequence, and verify the written
 * manifest once more from disk. The reviewed allowlist.json is never touched —
 * committing digests into it stays a human review step; the only publish
 * artifact is the manifest at --out (the workflow pushes it to GitLab).
 */
/**
 * Write the publish-metadata sidecar for the workflow artifact: everything
 * the intranet-side publisher (publish-local.mjs) needs to identify, trust,
 * and audit the manifest — the sequence, the trust root used, a sha256 over
 * the exact bytes on disk (handoff integrity; signatures never travel
 * without one), and the per-entry digest state. CI later adds gitSha/runId.
 */
function writePublishMeta({ metaOutPath, manifest, fingerprint, outBytes }) {
  const meta = {
    sequence: manifest.sequence,
    keyId: manifest.signature.keyId,
    fingerprint,
    manifestSha256: createHash('sha256').update(outBytes).digest('hex'),
    entries: manifest.packages.map((entry) => ({
      packageName: entry.packageName,
      version: entry.version,
      ...(entry.treeDigest === undefined ? {} : { treeDigest: entry.treeDigest }),
      measured: entry.treeDigest !== undefined,
    })),
    generatedAt: new Date().toISOString(),
  }
  mkdirSync(dirname(metaOutPath), { recursive: true })
  writeFileSync(metaOutPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return metaOutPath
}

async function commandMeasureAndPublish(flags) {
  const digestFilePath = flags['digest-file']
  if (digestFilePath === undefined) throw new Error('measure-and-publish requires --digest-file <path> (the measure script output)')
  const { allowlistPath } = defaultPaths(flags)
  const digests = loadTreeDigestFile(resolve(process.cwd(), digestFilePath))
  const entries = loadAllowlist(allowlistPath)
  const { entries: filledEntries, filled, unchanged, missing } = applyTreeDigests(entries, digests)
  const runtimeDir = mkdtempSync(join(tmpdir(), 'company-catalog-measure-publish-'))
  let result
  try {
    const runtimeAllowlistPath = join(runtimeDir, 'allowlist.json')
    saveAllowlist(runtimeAllowlistPath, filledEntries)
    console.log(`allowlist: runtime copy — ${filled.length > 0 ? `${filled.join(', ')} gained measured treeDigest; ` : ''}${unchanged.length > 0 ? `${unchanged.join(', ')} already pinned (measured equal); ` : ''}${missing.length > 0 ? `${missing.join(', ')} still without treeDigest (gradual enablement)` : 'every entry carries a treeDigest'} — reviewed ${allowlistPath} untouched`)
    result = await publishFromAllowlist(flags, runtimeAllowlistPath)
    // Belt and braces: re-read the written bytes and verify them exactly the
    // way an operator audit would, before anything may push this manifest.
    const market = await loadMarketLibrary()
    const text = readFileSync(result.outPath, 'utf8')
    const reparsed = JSON.parse(text)
    const signature = reparsed?.signature
    if (reparsed === null || typeof reparsed !== 'object' || typeof signature?.keyId !== 'string') {
      throw new Error(`manifest ${result.outPath} carries no readable signature.keyId after publish`)
    }
    const fingerprint = market.ed25519PublicKeyFingerprint(Buffer.from(signature.publicKey ?? '', 'base64'))
    const verification = verifyManifestText(market, text, { fingerprint, keyId: signature.keyId })
    if (!verification.ok) {
      throw new Error(`re-verification of the written manifest failed (${verification.code}): ${verification.reason}`)
    }
    console.log(`re-verified manifest ${result.outPath} from disk: sequence ${String(verification.manifest.sequence)}, ${String(verification.manifest.packages.length)} packages — ready to publish`)
    const metaOutPath = flags['meta-out']
    if (metaOutPath !== undefined) {
      const written = writePublishMeta({
        metaOutPath: resolve(process.cwd(), metaOutPath),
        manifest: verification.manifest,
        fingerprint,
        outBytes: readFileSync(result.outPath),
      })
      console.log(`publish meta: ${written}`)
    }
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
  return result
}

async function commandRevoke(positionals, flags) {
  if (positionals.length !== 1) throw new Error("revoke takes exactly one argument: <package>[@<version>]")
  const spec = positionals[0]
  const { allowlistPath } = defaultPaths(flags)
  const entries = loadAllowlist(allowlistPath)
  const { entries: updated, matches } = applyRevocation(entries, spec)
  saveAllowlist(allowlistPath, updated)
  console.log(`allowlist: ${matches.join(', ')} marked revoked:true (entry kept; revocation is a state, not a deletion)`)
  try {
    await publishFromAllowlist(flags)
  } catch (error) {
    console.error('company-catalog: allowlist updated, but the reissue failed; the revocation stays recorded — run build again once the cause is fixed.')
    fail(error instanceof Error ? error.message : String(error))
  }
}

async function commandVerify(positionals, flags) {
  const market = await loadMarketLibrary()
  const { outPath, stateDir } = defaultPaths(flags)
  const path = positionals.length > 0 ? resolve(process.cwd(), positionals[0]) : outPath
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read manifest ${path} (${error.code ?? error.message})`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`manifest ${path} is not valid JSON: ${error.message}`)
  }
  const signature = parsed?.signature
  if (parsed === null || typeof parsed !== 'object' || typeof signature?.keyId !== 'string') {
    throw new Error(`manifest ${path} carries no readable signature.keyId`)
  }
  const pinned = process.env.COMPANY_CATALOG_KEY_FINGERPRINT
  let fingerprint
  if (pinned !== undefined) {
    fingerprint = pinned
  } else {
    const publicKey = Buffer.from(signature.publicKey ?? '', 'base64')
    fingerprint = market.ed25519PublicKeyFingerprint(publicKey)
    console.log('note: COMPANY_CATALOG_KEY_FINGERPRINT is unset — trusting the key embedded in the file (structural check, not a trust decision)')
  }
  // Anti-rollback is a client-side replay concern; an operator checking an
  // artifact verifies its integrity (canonical bytes, schema, trust root,
  // signature, expiry) and is told how its sequence relates to the state.
  const persistedSequence = readLastSequence(stateDir)
  const verification = verifyManifestText(market, text, { fingerprint, keyId: signature.keyId })
  if (!verification.ok) {
    throw new Error(`verification failed (${verification.code}): ${verification.reason}`)
  }
  const sequenceRelation = verification.manifest.sequence === persistedSequence
    ? `matches the persisted sequence ${String(persistedSequence)}`
    : verification.manifest.sequence > persistedSequence
      ? `is ahead of the persisted sequence ${String(persistedSequence)} (state is behind this artifact)`
      : `is below the persisted sequence ${String(persistedSequence)} — clients that saw the newer manifest will reject this artifact as stale-sequence (fine when auditing old artifacts)`
  console.log(`manifest ${path}: VERIFIED`)
  console.log(`  keyId:       ${verification.keyId}`)
  console.log(`  fingerprint: ${verification.fingerprint}`)
  console.log(`  sequence:    ${String(verification.manifest.sequence)} (${sequenceRelation})`)
  console.log(`  expiresAt:   ${verification.manifest.expiresAt}`)
  console.log(`  packages:    ${String(verification.manifest.packages.length)} (${String(verification.manifest.packages.filter((e) => e.revoked).length)} revoked)`)
}

async function commandKeygen() {
  const material = generateSigningMaterial()
  console.log('company catalog signing key (ed25519) — PRIVATE MATERIAL below; store it in a secret manager.')
  console.log('')
  console.log(`COMPANY_CATALOG_SIGNING_KEY=${material.signingKey}`)
  console.log(`COMPANY_CATALOG_KEY_ID=${material.suggestedKeyId}`)
  console.log(`COMPANY_CATALOG_KEY_FINGERPRINT=${material.fingerprint}`)
  console.log('')
  console.log('deployment-policy trust root (dsh-plugin-desktop policy.trustRoots entry):')
  console.log(`  { "keyId": "${material.suggestedKeyId}", "fingerprint": "${material.fingerprint}" }`)
  console.log(`raw public key (base64): ${material.publicKey}`)
  console.log('the private key is only ever passed through the environment; this tool never reads or writes key files.')
}

async function commandSelftest(flags) {
  const market = await loadMarketLibrary()
  const segments = await runSelftest({
    toolDir: TOOL_DIR,
    market,
    forceOffline: flags['force-offline'] === true,
  })
  const skipped = segments.filter((segment) => segment.status === 'skip')
  const summary = skipped.length === 0
    ? `selftest: PASS — ${String(segments.length)}/${String(segments.length)} segments ok`
    : `selftest: PASS — ${String(segments.length - skipped.length)}/${String(segments.length)} segments ok, skipped: ${skipped.map((segment) => segment.name).join(', ')}`
  console.log('')
  console.log(summary)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }
  let flags
  let positionals
  try {
    ;({ positionals, flags } = parseArgs(rest))
  } catch (error) {
    fail(error.message)
    console.error('')
    console.error(USAGE)
    return
  }
  try {
    if (command === 'build') await commandBuild(flags)
    else if (command === 'measure-and-publish') await commandMeasureAndPublish(flags)
    else if (command === 'revoke') await commandRevoke(positionals, flags)
    else if (command === 'verify') await commandVerify(positionals, flags)
    else if (command === 'keygen') await commandKeygen()
    else if (command === 'selftest') await commandSelftest(flags)
    else fail(`unknown command '${command}'\n\n${USAGE}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

await main()
