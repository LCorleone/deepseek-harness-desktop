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

import { createPublicKey } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  resolveTarballArtifacts,
  saveAllowlist,
  validateAllowlistEntry,
  validateCatalogOrigin,
  CATALOG_ORIGIN_ENV,
} from './lib/allowlist.mjs'
import {
  applyBetaRosterChanges,
  loadBetaTesters,
  saveBetaTesters,
} from './lib/beta-roster.mjs'
import { generateSigningMaterial, loadSigningKeyFromEnv, fingerprintOfRawPublicKey, rawPublicKeyBytes } from './lib/keys.mjs'
import { loadMarketLibrary } from './lib/market.mjs'
import { fetchPackageDist } from './lib/registry.mjs'
import {
  assembleRepublishPackages,
  commitVerifiedManifest,
  expiryFromDays,
  nextSequenceFromSources,
  prepareVerifiedManifest,
  publishManifest,
  readDeployedSequence,
  readLastSequence,
  republishManifestPackages,
  verifyManifestText,
} from './lib/pipeline.mjs'
import { runSelftest } from './lib/selftest.mjs'
import { verifyHandoffSubmission } from './lib/verify-handoff.mjs'
import {
  assertBundlePatchDeclaration,
  declaredBundlePatchOfTarball,
  DEFAULT_PACKAGES_DIR_RELATIVE,
  DEFAULT_PLUGIN_SOURCES_DIR_RELATIVE,
  REPO_ROOT,
  packFromNpmSpec,
  packPluginSource,
} from './lib/tarball.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

const USAGE = `Usage: node tools/company-catalog/cli.mjs <command> [options]

Commands:
  build                        Fetch dist integrity for every allowlist entry from
                               registry.npmjs.org, assemble, sign, verify, and publish
                               the manifest (sequence = persisted + 1).
  pack-tarball                 Pack a plugin source tree (or an exact registry version
                               plus a patch script) into the deterministic npm-compatible
                               .tgz the tarball channel hosts, and measure its
                               treeDigest (--no-measure skips the reference install).
  measure-and-publish          Fill measured tree digests (--digest-file) into a
                               runtime copy of the allowlist, then build (sequence
                               floor: --sequence-from or the local state file)
                               and verify; the signed manifest is written to --out
                               and its metadata to --meta-out for the publishing
                               workflow. The reviewed allowlist.json is never
                               modified. -f channel=beta publishes the beta
                               manifest instead (default --out: out/catalog-
                               manifest.beta.json): every allowlist entry plus the
                               signed tester roster from state/beta-testers.json;
                               the stable manifest file is not touched.
  promote <name>@<version>     Promote one beta entry into the stable manifest:
                               the entry's signed bytes and digest move verbatim
                               (zero re-verification of upstream facts), both
                               manifests are re-signed (stable first, then beta)
                               on the shared sequence ratchet, and the allowlist
                               entry's beta flag is flipped. Idempotent no-op when
                               the stable manifest already pins the same entry.
  beta-roster [-f add=<email>] [-f remove=<email>]
                               Change the signed tester roster: state/beta-
                               testers.json is updated (validated, lowercased), the
                               beta manifest is re-signed with the new roster
                               (entries verbatim), and the shared sequence ratchet
                               advances — roster changes reach testers without a
                               client release. A no-op change re-signs nothing.
  revoke <pkg>[@<version>]     Mark allowlist entries revoked:true and reissue the
                               manifest with a higher sequence (entries are kept).
                               The beta manifest re-signs in the same operation
                               (P9): the matched entry is forced revoked:true
                               there too — the beta superset carries soak entries
                               the stable manifest never pinned.
  verify [path]                Verify a manifest file end to end
                               (default: out/catalog-manifest.json).
  verify-handoff <dir>         Owner-side mechanical verification of a staged
                               plugin submission (submissions/<name>-<version>:
                               handoff.json + tgz): schema, sha256/size, safe
                               unpack, three-way identity binding, compat pins,
                               dependency/domain audit, measured treeDigest;
                               writes verdict.md into the submission directory, stages
                               the tgz into out/packages/, and prints the
                               paste-ready allowlist entry. Verifies and stages
                               only — never signs, never publishes.
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
  --catalog-origin <o>   Bare https origin every tarball source url must live on
                         (default: the COMPANY_CATALOG_ORIGIN environment value);
                         required before any entry uses the tarball channel
  --force-offline        selftest only: skip the npm registry segment

pack-tarball options:
  --source-dir <dir>     Pack this patched plugin source directory (staged copy;
                         node_modules/.git and stale top-level *.tgz never ship)
  --npm <name>@<version> Pack this exact public-registry version instead, applying
                         --patch <command> inside the unpacked tree before repacking
  --from-allowlist       Pack every allowlist entry whose source pins a path, from
                         <sources-root>/<tarball-stem>/ (the workflow convention)
  --sources-root <dir>   --from-allowlist source root
                         (default: tools/company-catalog/plugin-sources)
  --pack-out <dir>       Artifact output (default: tools/company-catalog/out/packages)
  --no-measure           Skip the treeDigest reference install (integrity still
                         computed; measure.mjs can measure the artifact later)

verify-handoff options:
  --smoke                Re-run the reference install a second time and require
                         both treeDigests equal (re-verification; default off —
                         the desktop e2e install smoke is a separate drill:
                         yarn e2e:install-smoke)
  --json                 Print the machine-readable result document as JSON
  --catalog-origin <o>   Origin of the snippet's source.url (default: the
                         COMPANY_CATALOG_ORIGIN env value, else the origin of
                         compat.json's catalog.manifestUrl)
  --project <p>          Formal repo path of the snippet's source.url
                         (default: julu/dsh-desktop-config)

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

/** Minimal hand-rolled parser: `--flag value`, `--flag=value`, positionals. `-f` is the single-dash alias of `--` (the runbook's `-f channel=beta` spelling). */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  const valueFlags = new Set(['allowlist', 'out', 'state-dir', 'sequence', 'sequence-from', 'digest-file', 'meta-out', 'expires-days', 'catalog-origin', 'source-dir', 'npm', 'patch', 'sources-root', 'pack-out', 'url', 'project', 'channel', 'entry', 'add', 'remove'])
  for (let index = 0; index < argv.length; index += 1) {
    let argument = argv[index]
    if (argument.startsWith('--')) {
      // pass through to the flag parsing below
    } else if (argument === '-f' || argument.startsWith('-f') ) {
      // `-f name=value` / `-fname=value` / `-f name value` → `--name=value`
      if (argument === '-f') {
        index += 1
        argument = `--${argv[index]}`
      } else {
        argument = `--${argument.slice(2)}`
      }
      if (argument === '--undefined') throw new Error('-f requires a flag name')
    } else {
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

/**
 * Resolve the next sequence above every known floor (explicit > deployed >
 * persisted), shared by every signing path — stable and beta alike (P9: one
 * global ratchet, so a beta publication can never collide with a stable
 * sequence clients have already seen).
 */
async function resolveNextSequence(flags, stateDir) {
  const sequenceFrom = flags['sequence-from']
  const persistedSequence = readLastSequence(stateDir)
  let deployedSequence
  let deployedSource
  if (sequenceFrom !== undefined) {
    ;({ sequence: deployedSequence, source: deployedSource } = await readDeployedSequence(sequenceFrom))
  }
  return nextSequenceFromSources({
    explicit: integerFlag(flags, 'sequence'),
    ...(deployedSequence === undefined ? {} : { deployedSequence, deployedSource }),
    persistedSequence,
  })
}

function defaultPaths(flags) {
  // Explicit paths are cwd-relative (or absolute); defaults live in the tool.
  const fromCwd = (value) => resolve(process.cwd(), value)
  const channel = resolveChannelFlag(flags)
  return {
    allowlistPath: flags.allowlist !== undefined ? fromCwd(flags.allowlist) : resolve(TOOL_DIR, 'allowlist.json'),
    outPath: flags.out !== undefined
      ? fromCwd(flags.out)
      : channel === 'beta'
        ? resolve(TOOL_DIR, join('out', 'catalog-manifest.beta.json'))
        : resolve(TOOL_DIR, join('out', 'catalog-manifest.json')),
    stateDir: flags['state-dir'] !== undefined ? fromCwd(flags['state-dir']) : resolve(TOOL_DIR, 'state'),
  }
}

/** The publication channel flag (P9): `stable` (default) or `beta`. */
function resolveChannelFlag(flags) {
  const raw = flags.channel
  if (raw === undefined) return 'stable'
  if (raw !== 'stable' && raw !== 'beta') {
    throw new Error(`--channel must be 'stable' or 'beta' (got '${raw}')`)
  }
  return raw
}

/** The two channel file names the deployment hosts side by side. */
const STABLE_MANIFEST_FILENAME = 'catalog-manifest.json'
const BETA_MANIFEST_FILENAME = 'catalog-manifest.beta.json'

/**
 * The paired manifest paths for the two-file operations (`promote`,
 * `beta-roster`): they read and write BOTH channel files, so `--out` names
 * the stable slot and the beta file is its sibling — exactly how the
 * deployment hosts them (one directory, `catalog-manifest.json` +
 * `catalog-manifest.beta.json`).
 */
function pairedManifestPaths(flags) {
  const stableOutPath = flags.out !== undefined
    ? resolve(process.cwd(), flags.out)
    : resolve(TOOL_DIR, join('out', STABLE_MANIFEST_FILENAME))
  return { stableOutPath, betaOutPath: join(dirname(stableOutPath), BETA_MANIFEST_FILENAME) }
}

/**
 * Resolve the company catalog origin for tarball-channel entries: the
 * `--catalog-origin` flag wins, the COMPANY_CATALOG_ORIGIN environment value
 * is the fallback, and `undefined` means the deployment uses the npm channel
 * only (a tarball entry then fails validation with guidance). The value is
 * validated as a bare https origin, mirroring the desktop policy field the
 * desktop's verification pins (`companyCatalogOrigin`).
 */
function resolveCatalogOrigin(flags) {
  const raw = flags['catalog-origin'] !== undefined ? flags['catalog-origin'] : process.env[CATALOG_ORIGIN_ENV]
  return raw === undefined ? undefined : validateCatalogOrigin(raw)
}

/** Resolve registry dist for every npm-channel allowlist entry; hard-fails on any error. Tarball-channel entries are skipped: their signed integrity is the reviewed tarball sha512, not registry metadata. */
async function resolveDists(entries) {
  const dists = new Map()
  for (const entry of entries) {
    if (entry.source !== undefined && entry.source.kind === 'tarball') {
      console.log(`tarball:  ${entryKey(entry)} → ${entry.source.url} (${entry.source.integrity}) — intranet tarball channel, no registry lookup`)
      continue
    }
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
  const channel = resolveChannelFlag(flags)
  const { allowlistPath, outPath, stateDir } = defaultPaths(flags)
  const effectiveAllowlistPath = allowlistPathOverride ?? allowlistPath
  const companyCatalogOrigin = resolveCatalogOrigin(flags)
  const allEntries = loadAllowlist(effectiveAllowlistPath, { companyCatalogOrigin })
  // Publication channel (P9): the stable manifest signs only stable-flagged
  // entries; the beta manifest is the superset (stable + beta-flagged) plus
  // the signed tester roster, so a beta soak entry is invisible to every
  // non-roster machine until `promote` flips the allowlist flag.
  const betaRoster = channel === 'beta' ? loadBetaTesters(stateDir) : undefined
  if (channel === 'beta' && !betaRoster.existed) {
    console.log(`beta roster: ${betaRoster.path} does not exist yet — using the initial first test group (${String(betaRoster.testers.length)} testers); run beta-roster --add/--remove to persist changes`)
  }
  const entries = channel === 'stable'
    ? allEntries.filter((entry) => entry.channel !== 'beta')
    : allEntries
  if (channel === 'stable' && allEntries.length !== entries.length) {
    console.log(`channel:  ${String(allEntries.length - entries.length)} beta-flagged entr${allEntries.length - entries.length === 1 ? 'y' : 'ies'} held back to the beta manifest (promote flips the allowlist flag) — ${String(entries.length)} stable entries published`)
  }
  // Tarball channel, pack-artifact form: the signed sha512 comes from the
  // packed file's actual bytes (never a reviewed local value), exactly like
  // the npm channel's integrity comes from the registry response.
  const artifacts = resolveTarballArtifacts(entries, { repoRoot: REPO_ROOT })
  for (const packed of artifacts.resolved) {
    console.log(`tarball:  ${packed.packageName}@${packed.version} → ${packed.path} (${String(packed.sizeBytes)} B) ${packed.integrity} → ${packed.url}`)
  }
  if (artifacts.passthrough.length > 0) {
    console.log(`tarball:  ${artifacts.passthrough.join(', ')} carry reviewed inline integrity (no pack artifact resolved)`)
  }
  // Cross-side consistency gate (real-incident regression, 0.4.181): the
  // packed artifact's in-manifest `dsh.bundle.patch` declaration must equal
  // the allowlist entry's `bundlePatch` strictly — the desktop's post-install
  // assert enforces byte equality, and a './'-prefix drift would fail every
  // install after this manifest shipped. pack-tarball refuses the artifact at
  // pack time; this build-side check also catches artifacts packed earlier.
  const entryByKey = new Map(artifacts.entries.map((entry) => [entryKey(entry), entry]))
  for (const packed of artifacts.resolved) {
    const entry = entryByKey.get(entryKey(packed))
    const declared = declaredBundlePatchOfTarball(readFileSync(resolve(REPO_ROOT, ...packed.path.split('/'))), packed.path)
    assertBundlePatchDeclaration({ declared, expected: entry.bundlePatch, at: entryKey(entry), source: `the packed artifact ${packed.path}` })
  }
  const dists = await resolveDists(artifacts.entries)
  const { sequence, floor, source: sequenceSource } = await resolveNextSequence(flags, stateDir)
  const { manifest, fingerprint } = await publishManifest({
    market,
    entries: artifacts.entries,
    dists,
    sequence,
    expiresAt: expiryFromDays(integerFlag(flags, 'expires-days') ?? 90),
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence: floor,
    outPath,
    stateDir,
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
    channel,
    ...(betaRoster === undefined ? {} : { testers: betaRoster.testers }),
  })
  const revoked = manifest.packages.filter((entry) => entry.revoked).length
  const tarballChannel = manifest.packages.filter((entry) => entry.source !== undefined).length
  console.log(`published company manifest${channel === 'beta' ? ' (beta channel)' : ''}:`)
  console.log(`  sequence:    ${String(manifest.sequence)} (sequence source: ${sequenceSource}; the ratchet is shared with ${channel === 'beta' ? 'stable' : 'beta'})`)
  console.log(`  expiresAt:   ${manifest.expiresAt}`)
  console.log(`  packages:    ${String(manifest.packages.length)} (${String(revoked)} revoked, ${String(tarballChannel)} tarball channel)${manifest.testers === undefined ? '' : `, ${String(manifest.testers.length)} testers`}`)
  console.log(`  keyId:       ${keyId}`)
  console.log(`  fingerprint: ${fingerprint}`)
  console.log(`  manifest:    ${outPath}`)
  console.log(`  state:       ${resolve(stateDir, 'last-sequence.json')}`)
  if (tarballChannel > 0) {
    console.log('  fleet gate:  this manifest carries the `source` field — every client must already run a field-aware build:')
    console.log('                boot verification, the locked terminal add gate, AND the market catalog provider')
    console.log('                (through the injected verifier) all verify through verifyDesktopCompanyManifest')
    console.log('                (see publish-local --confirm-fleet-upgraded and the README publication gate)')
  }
  return { manifest, fingerprint, outPath, sequenceSource }
}

async function commandBuild(flags) {
  await publishFromAllowlist(flags)
}

/**
 * `pack-tarball`: produce the deterministic npm-compatible .tgz for one
 * plugin — from a patched source directory, from an exact registry version
 * plus a patch script, or (the workflow convention) from every allowlist
 * entry whose source pins a pack path. The record printed and written next
 * to the artifact carries everything the allowlist entry needs: the signable
 * repo-relative path, the sha512, and (by default) the measured treeDigest.
 */
async function commandPackTarball(flags) {
  const modes = ['source-dir', 'npm', 'from-allowlist'].filter((mode) => flags[mode] !== undefined)
  if (modes.length !== 1) {
    throw new Error(`pack-tarball takes exactly one input mode (--source-dir <dir>, --npm <name>@<version> [--patch <command>], or --from-allowlist); got ${modes.length === 0 ? 'none' : modes.join(', ')}`)
  }
  const outDir = flags['pack-out'] !== undefined
    ? resolve(process.cwd(), flags['pack-out'])
    : resolve(REPO_ROOT, ...DEFAULT_PACKAGES_DIR_RELATIVE.split('/'))
  const log = (line) => console.log(line)
  let records = []
  if (flags['source-dir'] !== undefined) {
    records = [packPluginSource({ sourceDir: resolve(process.cwd(), flags['source-dir']), outDir, log })]
  } else if (flags.npm !== undefined) {
    records = [packFromNpmSpec({
      spec: flags.npm,
      ...(flags.patch === undefined ? {} : { patchCommand: flags.patch }),
      outDir,
      log,
    })]
  } else {
    const sourcesRoot = flags['sources-root'] !== undefined
      ? resolve(process.cwd(), flags['sources-root'])
      : resolve(REPO_ROOT, ...DEFAULT_PLUGIN_SOURCES_DIR_RELATIVE.split('/'))
    const { allowlistPath } = defaultPaths(flags)
    const entries = loadAllowlist(allowlistPath, { companyCatalogOrigin: resolveCatalogOrigin(flags) })
    const packEntries = entries.filter((entry) => entry.source?.kind === 'tarball' && entry.source.path !== undefined)
    if (packEntries.length === 0) {
      console.log(`pack-tarball: no allowlist entry pins a source.path artifact — nothing to pack (the tarball channel's pack-artifact form is the only one that packs here)`)
    }
    for (const entry of packEntries) {
      const stem = entry.source.path.split('/').pop().replace(/\.tgz$/u, '')
      const sourceDir = resolve(sourcesRoot, stem)
      log(`pack-tarball: ${entryKey(entry)} ← ${sourceDir} (sources-root convention)`)
      // The alignment gate rides inside the pack: a source whose declared
      // dsh.bundle.patch differs from the entry's bundlePatch (even by the
      // optional './' prefix) never yields an artifact.
      const record = packPluginSource({ sourceDir, outDir, log, expectedBundlePatch: entry.bundlePatch, at: entryKey(entry) })
      if (record.packageName !== entry.packageName || record.version !== entry.version) {
        throw new Error(
          `the source at ${sourceDir} packed ${record.packageName}@${record.version}, but the allowlist entry is ${entryKey(entry)} — ` +
          'the plugin-sources directory must match the entry (rename the directory or fix the allowlist)',
        )
      }
      records.push(record)
    }
  }
  const companyCatalogOrigin = resolveCatalogOrigin(flags)
  const project = flags.project ?? 'julu/dsh-desktop-config'
  const measure = flags['no-measure'] !== true
  for (const [index, record] of records.entries()) {
    // treeDigest: measured through the exact reference install measure.mjs
    // applies to tarball entries (staged pnpm install of the artifact, digest
    // from the compiled boot-verification chunk).
    let treeDigest
    if (measure) {
      const digestFile = join(tmpdir(), `company-catalog-pack-digest-${String(process.pid)}-${String(index)}.json`)
      const probe = spawnSync(process.execPath, [
        join(TOOL_DIR, 'measure.mjs'),
        '--tarball', resolve(outDir, record.filename),
        '--out', digestFile,
      ], { encoding: 'utf8', timeout: 600_000 })
      const probeOutput = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim()
      if (probe.status !== 0) {
        throw new Error(`measuring ${record.filename} failed:\n${probeOutput.split('\n').slice(-6).join('\n')}\n(re-run with --no-measure to pack without a treeDigest, then measure separately)`)
      }
      const measured = JSON.parse(readFileSync(digestFile, 'utf8'))
      rmSync(digestFile, { force: true })
      treeDigest = measured[0]?.treeDigest
      if (typeof treeDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(treeDigest)) {
        throw new Error(`measure.mjs returned no usable treeDigest for ${record.filename}`)
      }
    }
    const sourceSnippet = companyCatalogOrigin === undefined || record.path.startsWith('/') ? undefined : {
      kind: 'tarball',
      url: flags.url ?? `${companyCatalogOrigin}/${project}/-/raw/master/packages/${record.filename}`,
      path: record.path,
    }
    console.log('')
    console.log(`packed:   ${record.packageName}@${record.version} → ${resolve(outDir, record.filename)}`)
    console.log(`  size:        ${String(record.sizeBytes)} bytes (${String(record.fileCount)} files)`)
    console.log(`  integrity:   ${record.integrity}`)
    if (treeDigest !== undefined) console.log(`  treeDigest:  ${treeDigest}`)
    if (sourceSnippet !== undefined) {
      console.log('  allowlist source block (review into the allowlist entry):')
      console.log(`    ${JSON.stringify(sourceSnippet)}`)
    }
  }
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
function writePublishMeta({ metaOutPath, manifest, fingerprint, outBytes, channel = 'stable' }) {
  const meta = {
    channel,
    sequence: manifest.sequence,
    keyId: manifest.signature.keyId,
    fingerprint,
    manifestSha256: createHash('sha256').update(outBytes).digest('hex'),
    ...(manifest.testers === undefined ? {} : { testers: [...manifest.testers] }),
    entries: manifest.packages.map((entry) => ({
      packageName: entry.packageName,
      version: entry.version,
      ...(entry.treeDigest === undefined ? {} : { treeDigest: entry.treeDigest }),
      ...(entry.source === undefined ? {} : { sourceKind: entry.source.kind }),
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
  const companyCatalogOrigin = resolveCatalogOrigin(flags)
  const digests = loadTreeDigestFile(resolve(process.cwd(), digestFilePath))
  const entries = loadAllowlist(allowlistPath, { companyCatalogOrigin })
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
    const channel = resolveChannelFlag(flags)
    const market = await loadMarketLibrary()
    const text = readFileSync(result.outPath, 'utf8')
    const reparsed = JSON.parse(text)
    const signature = reparsed?.signature
    if (reparsed === null || typeof reparsed !== 'object' || typeof signature?.keyId !== 'string') {
      throw new Error(`manifest ${result.outPath} carries no readable signature.keyId after publish`)
    }
    const fingerprint = market.ed25519PublicKeyFingerprint(Buffer.from(signature.publicKey ?? '', 'base64'))
    const verification = await verifyManifestText(market, text, {
      fingerprint,
      keyId: signature.keyId,
      ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
      channel,
    })
    if (!verification.ok) {
      throw new Error(`re-verification of the written manifest failed (${verification.code}): ${verification.reason}`)
    }
    console.log(`re-verified manifest ${result.outPath} from disk: sequence ${String(verification.manifest.sequence)}, ${String(verification.manifest.packages.length)} packages${channel === 'beta' ? `, ${String(verification.manifest.testers?.length ?? 0)} testers (beta channel)` : ''} — ready to publish`)
    const metaOutPath = flags['meta-out']
    if (metaOutPath !== undefined) {
      const written = writePublishMeta({
        metaOutPath: resolve(process.cwd(), metaOutPath),
        manifest: verification.manifest,
        fingerprint,
        outBytes: readFileSync(result.outPath),
        channel,
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
  const entries = loadAllowlist(allowlistPath, { companyCatalogOrigin: resolveCatalogOrigin(flags) })
  const { entries: updated, matches } = applyRevocation(entries, spec)
  saveAllowlist(allowlistPath, updated)
  console.log(`allowlist: ${matches.join(', ')} marked revoked:true (entry kept; revocation is a state, not a deletion)`)
  try {
    const stableResult = await publishFromAllowlist(flags)
    // P9 review fix (layer 1): revocation must reach BOTH channel files in
    // one operation. The stable reissue above derives from the just-revoked
    // allowlist; the beta manifest — the superset, which carries the entry
    // even when stable never pinned it (a beta-flagged soak entry) — is
    // re-signed from its own verified packages with the revoked name@version
    // forced revoked:true. A beta-roster or promote re-sign then keeps it
    // there (the alignment below is the layer-2 guarantee).
    if (resolveChannelFlag(flags) === 'stable') {
      await reissueBetaWithRevocation(flags, { revokedKeys: matches, stablePackages: stableResult.manifest.packages })
    }
  } catch (error) {
    console.error('company-catalog: allowlist updated, but the reissue failed; the revocation stays recorded — re-run measure-and-publish (and -f channel=beta when a beta manifest exists) once the cause is fixed.')
    fail(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Re-sign the beta manifest so a just-recorded revocation reaches testers'
 * machines (P9 review fix, layer 1): the verified beta packages keep moving
 * verbatim except that every entry matching the revocation spec — and every
 * entry the current stable manifest already pins as revoked (layer 2) — is
 * forced revoked:true. A missing beta file simply has nothing to re-sign.
 */
async function reissueBetaWithRevocation(flags, { revokedKeys, stablePackages }) {
  const { stateDir } = defaultPaths(flags)
  const { betaOutPath } = pairedManifestPaths(flags)
  if (!existsSync(betaOutPath)) {
    console.log(`beta:     no beta manifest at ${betaOutPath} — nothing to re-sign (the revocation reached the stable manifest)`)
    return
  }
  const market = await loadMarketLibrary()
  const { privateKey, keyId, expectedFingerprint } = loadSigningKeyFromEnv()
  const fingerprint = expectedFingerprint
    ?? fingerprintOfRawPublicKey(rawPublicKeyBytes(createPublicKey(privateKey)))
  const companyCatalogOrigin = resolveCatalogOrigin(flags)
  const betaVerification = await readVerifiedManifestFile(market, betaOutPath, {
    keyId,
    fingerprint,
    channel: 'beta',
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
  })
  const wanted = new Set(revokedKeys)
  const betaPackages = alignPackagesWithStableRevocation(
    betaVerification.manifest.packages.map((entry) => (wanted.has(entryKey(entry)) && entry.revoked !== true
      ? { ...entry, revoked: true }
      : entry)),
    stablePackages,
  )
  const { sequence } = await resolveNextSequence(flags, stateDir)
  const result = await republishManifestPackages({
    market,
    packages: betaPackages,
    sequence,
    expiresAt: expiryFromDays(integerFlag(flags, 'expires-days') ?? 90),
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence: sequence - 1,
    outPath: betaOutPath,
    stateDir,
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
    channel: 'beta',
    testers: betaVerification.manifest.testers ?? [],
  })
  console.log(`beta:     re-signed ${betaOutPath} at sequence ${String(result.manifest.sequence)} — ${revokedKeys.join(', ')} revoked:true (${String(result.manifest.packages.length)} packages, ${String(result.manifest.testers?.length ?? 0)} testers)`)
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
  // A manifest carrying a top-level `testers` roster is a beta manifest
  // (P9): verify it under the beta channel's one-extension schema.
  const channel = parsed?.testers !== undefined ? 'beta' : 'stable'
  const persistedSequence = readLastSequence(stateDir)
  const verification = await verifyManifestText(market, text, {
    fingerprint,
    keyId: signature.keyId,
    companyCatalogOrigin: resolveCatalogOrigin(flags),
    channel,
  })
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
  if (channel === 'beta') {
    console.log(`  channel:     beta (${String(verification.manifest.testers?.length ?? 0)} testers: ${(verification.manifest.testers ?? []).join(', ')})`)
  }
  const channelSummary = verification.manifest.packages.reduce(
    (counts, entry) => {
      const kind = entry.source === undefined ? 'npm' : entry.source.kind
      counts[kind] = (counts[kind] ?? 0) + 1
      return counts
    },
    {},
  )
  console.log(`  packages:    ${String(verification.manifest.packages.length)} (${String(verification.manifest.packages.filter((e) => e.revoked).length)} revoked; channels: ${Object.entries(channelSummary).map(([kind, count]) => `${kind} ${String(count)}`).join(', ')})`)
  if ((channelSummary.tarball ?? 0) > 0) {
    console.log('  note:        this manifest carries `source` entries — field-unaware clients reject it whole (fleet-upgrade publication gate)')
  }
}

/**
 * `verify-handoff`: the owner-side gate for staged plugin submissions. Every
 * field of the handoff contract becomes one mechanical check (fail-fast,
 * verdict.md always written); a pass stages the artifact plus the allowlist
 * entry for the existing publishing flow — this command never signs.
 */
/** Read and verify one manifest file from disk under the operator's key. */
async function readVerifiedManifestFile(market, path, { keyId, fingerprint, channel, companyCatalogOrigin, lastSeenSequence }) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read manifest ${path} (${error.code ?? error.message})`)
  }
  const verification = await verifyManifestText(market, text, { fingerprint, keyId, channel, companyCatalogOrigin, lastSeenSequence })
  if (!verification.ok) {
    throw new Error(`manifest ${path} failed verification (${verification.code}): ${verification.reason}`)
  }
  return verification
}

/** Parse a `<name>@<version>` spec (scoped names allowed). */
function parseEntrySpec(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`'${spec}' is not a <name>@<version> spec (scoped names allowed)`)
  }
  return { packageName: spec.slice(0, at), version: spec.slice(at + 1) }
}

/** Whether two signed manifest entries are field-for-field identical. */
function signedEntriesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Sticky revocation across channels (P9 review fix, layer 2 — defense in
 * depth): every name@version the CURRENT stable manifest pins as
 * revoked:true must leave any re-signed beta manifest revoked:true, even
 * when the beta source file still carries the pre-revocation false — a
 * stale beta publication re-signed verbatim (beta-roster, promote) would
 * otherwise resurrect a revoked entry on testers' machines, because the
 * beta channel is additive and the client merge lets a divergent beta
 * entry win. Applied on every beta-side re-sign path.
 */
function alignPackagesWithStableRevocation(betaPackages, stablePackages) {
  const revokedKeys = new Set(stablePackages.filter((entry) => entry.revoked === true).map(entryKey))
  if (revokedKeys.size === 0) return betaPackages
  return betaPackages.map((entry) =>
    entry.revoked === true || !revokedKeys.has(entryKey(entry)) ? entry : { ...entry, revoked: true })
}

/**
 * The verified stable packages for the beta-side revocation alignment, or
 * `[]` when no stable manifest exists yet (the beta-first rollout order).
 * A stable file that exists but fails verification aborts the operation:
 * re-signing beta while unable to read stable's revocation state is exactly
 * the resurrection window the alignment exists to close.
 */
async function readStablePackagesForAlignment(market, { stableOutPath, keyId, fingerprint, companyCatalogOrigin }) {
  if (!existsSync(stableOutPath)) return []
  const stableVerification = await readVerifiedManifestFile(market, stableOutPath, {
    keyId,
    fingerprint,
    channel: 'stable',
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
  })
  return stableVerification.manifest.packages
}

/**
 * `promote <name>@<version>` (P9): move one beta entry into the stable
 * manifest. The entry's signed bytes and digest move verbatim — zero
 * re-verification of upstream facts — both manifests are re-signed on the
 * shared ratchet (stable first, then beta, two sequences), and the
 * allowlist entry's beta flag is flipped so the next stable build keeps the
 * entry. Idempotent when the stable manifest already pins the same entry.
 *
 * Prepare-then-commit (P9 review fix): both re-signed artifacts are built
 * and verified in memory first; only after every step succeeded may the
 * allowlist flip, the manifest files, and the sequence state be written —
 * a failure anywhere in the re-sign path leaves zero repository residue
 * (the allowlist beta flag, both manifest files, and the ratchet untouched).
 */
async function commandPromote(positionals, flags) {
  if (positionals.length !== 1) throw new Error('promote takes exactly one argument: <name>@<version>')
  const { packageName, version } = parseEntrySpec(positionals[0])
  const spec = `${packageName}@${version}`
  const market = await loadMarketLibrary()
  const { privateKey, keyId, expectedFingerprint } = loadSigningKeyFromEnv()
  // The verification trust root for reading the current pair is the operator's
  // own signing key — promote re-signs with it, so both files must already be
  // signed by exactly this key (or the re-sign would silently change the
  // trust identity of the catalog).
  const fingerprint = expectedFingerprint
    ?? fingerprintOfRawPublicKey(rawPublicKeyBytes(createPublicKey(privateKey)))
  const companyCatalogOrigin = resolveCatalogOrigin(flags)
  const { allowlistPath, stateDir } = defaultPaths(flags)
  const { stableOutPath, betaOutPath } = pairedManifestPaths(flags)
  const stableVerification = await readVerifiedManifestFile(market, stableOutPath, {
    keyId,
    fingerprint,
    channel: 'stable',
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
  })
  const betaVerification = await readVerifiedManifestFile(market, betaOutPath, {
    keyId,
    fingerprint,
    channel: 'beta',
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
  })
  const betaEntry = betaVerification.manifest.packages.find((entry) => entry.packageName === packageName && entry.version === version)
  if (betaEntry === undefined) {
    throw new Error(`${spec} is not in the beta manifest ${betaOutPath} — publish it on the beta channel first (measure-and-publish -f channel=beta)`)
  }
  const stableEntry = stableVerification.manifest.packages.find((entry) => entry.packageName === packageName && entry.version === version)
  if (stableEntry !== undefined) {
    if (!signedEntriesEqual(stableEntry, betaEntry)) {
      throw new Error(
        `${spec} is already in the stable manifest with DIFFERENT signed fields — a published name@version is immutable; ` +
        'promote cannot change it (publish changed content as a new version)',
      )
    }
    console.log(`promote: ${spec} is already promoted (identical signed fields) — idempotent no-op, no sequence consumed`)
    return
  }
  // The reviewed allowlist must know the entry; promote flips its beta flag
  // so the next stable build keeps what is being promoted — but only AFTER
  // both re-signed artifacts verified (the commit block below).
  const entries = loadAllowlist(allowlistPath, { companyCatalogOrigin })
  const allowlistIndex = entries.findIndex((entry) => entry.packageName === packageName && entry.version === version)
  if (allowlistIndex === -1) {
    throw new Error(
      `${spec} has no allowlist entry (${allowlistPath}) — the allowlist is the reviewed source of truth; ` +
      're-add the entry before promoting',
    )
  }
  const expiresAt = expiryFromDays(integerFlag(flags, 'expires-days') ?? 90)
  const { sequence: stableSequence } = await resolveNextSequence(flags, stateDir)
  // Both signings are prepared before anything is written, so the beta
  // sequence is derived up front: the shared ratchet hands stable the next
  // sequence and beta the one after it (two signing events, stable first).
  const betaSequence = stableSequence + 1
  const stablePackages = [
    ...stableVerification.manifest.packages.filter((entry) => !(entry.packageName === packageName && entry.version === version)),
    betaEntry,
  ]
  // Prepare phase — nothing below may touch the allowlist, the manifest
  // files, or the sequence state.
  const stablePrepared = await prepareVerifiedManifest({
    market,
    unsigned: assembleRepublishPackages({ packages: stablePackages, sequence: stableSequence, expiresAt, channel: 'stable' }),
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence: stableSequence - 1,
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
    channel: 'stable',
  })
  const promoted = stablePrepared.manifest.packages.find((entry) => entry.packageName === packageName && entry.version === version)
  if (promoted === undefined || !signedEntriesEqual(promoted, betaEntry)) {
    throw new Error(`internal inconsistency: the promoted stable entry for ${spec} is not byte-identical to the beta entry — refusing to continue`)
  }
  // Sticky revocation (P9 review fix, layer 2): the beta re-sign aligns with
  // the stable manifest being written — every entry the new stable manifest
  // pins as revoked:true stays revoked in the beta output even when the
  // stale beta file still said false.
  const betaPackages = alignPackagesWithStableRevocation(betaVerification.manifest.packages, stablePrepared.manifest.packages)
  const betaPrepared = await prepareVerifiedManifest({
    market,
    unsigned: assembleRepublishPackages({
      packages: betaPackages,
      sequence: betaSequence,
      expiresAt,
      channel: 'beta',
      testers: betaVerification.manifest.testers ?? [],
    }),
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence: betaSequence - 1,
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
    channel: 'beta',
  })
  // Commit phase — every artifact verified end to end. The allowlist flips
  // FIRST (a crash between commits then converges by re-running promote,
  // which replays the full path), then both files, then the ratchet.
  if (entries[allowlistIndex].channel === 'beta') {
    entries[allowlistIndex] = { ...entries[allowlistIndex] }
    delete entries[allowlistIndex].channel
    saveAllowlist(allowlistPath, entries)
    console.log(`allowlist: ${spec} beta flag cleared — the next stable build keeps the promoted entry`)
  }
  commitVerifiedManifest({ prepared: stablePrepared, outPath: stableOutPath, stateDir })
  commitVerifiedManifest({ prepared: betaPrepared, outPath: betaOutPath, stateDir })
  console.log(`promoted ${spec} to the stable manifest (same digest, zero re-verification):`)
  console.log(`  stable:  sequence ${String(stablePrepared.manifest.sequence)} → ${stableOutPath} (${String(stablePrepared.manifest.packages.length)} packages)`)
  console.log(`  beta:    sequence ${String(betaPrepared.manifest.sequence)} → ${betaOutPath} (entries verbatim, ${String(betaPrepared.manifest.testers?.length ?? 0)} testers)`)
  console.log(`  state:   ${resolve(stateDir, 'last-sequence.json')} (shared ratchet)`)
  console.log('  push:    publish-local pushes both files (stable, then beta — see the README beta runbook)')
}

/**
 * `beta-roster --add <email> --remove <email>` (P9): change the signed tester
 * roster. The state file is validated and lowercased, the beta manifest is
 * re-signed with the new roster (entries verbatim), and the shared ratchet
 * advances — the roster reaches testers without a client release. A change
 * that changes nothing re-signs nothing (no sequence consumed). Every beta
 * re-sign also re-aligns the entries with the stable manifest's revocation
 * state (see {@link alignPackagesWithStableRevocation}): a revoked
 * name@version can never ride back into a signed beta manifest as
 * installable, whatever the stale beta source file still claims.
 */
async function commandBetaRoster(flags) {
  const add = flags.add
  const remove = flags.remove
  if (add === undefined && remove === undefined) {
    throw new Error('beta-roster takes --add <email> and/or --remove <email> (at least one)')
  }
  const { stateDir } = defaultPaths(flags)
  const current = loadBetaTesters(stateDir)
  const { testers, changed } = applyBetaRosterChanges(current.testers, {
    ...(add === undefined ? {} : { add }),
    ...(remove === undefined ? {} : { remove }),
  })
  console.log(`beta roster: ${String(current.testers.length)} → ${String(testers.length)} testers (${current.existed ? current.path : `${current.path} (first write — the initial test group is the missing-file default)`})`)
  if (!changed) {
    // A change that changes nothing consumes no sequence; a missing state
    // file is still materialized so the operator sees the effective roster.
    if (!current.existed) saveBetaTesters(stateDir, testers)
    console.log('beta roster: no effective change — nothing re-signed, no sequence consumed')
    return
  }
  const market = await loadMarketLibrary()
  const { privateKey, keyId, expectedFingerprint } = loadSigningKeyFromEnv()
  const fingerprint = expectedFingerprint
    ?? fingerprintOfRawPublicKey(rawPublicKeyBytes(createPublicKey(privateKey)))
  const companyCatalogOrigin = resolveCatalogOrigin(flags)
  const { stableOutPath, betaOutPath } = pairedManifestPaths(flags)
  const betaVerification = await readVerifiedManifestFile(market, betaOutPath, {
    keyId,
    fingerprint,
    channel: 'beta',
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
  })
  const betaPackages = alignPackagesWithStableRevocation(
    betaVerification.manifest.packages,
    await readStablePackagesForAlignment(market, { stableOutPath, keyId, fingerprint, companyCatalogOrigin }),
  )
  saveBetaTesters(stateDir, testers)
  const { sequence } = await resolveNextSequence(flags, stateDir)
  const result = await republishManifestPackages({
    market,
    packages: betaPackages,
    sequence,
    expiresAt: expiryFromDays(integerFlag(flags, 'expires-days') ?? 90),
    privateKey,
    keyId,
    expectedFingerprint,
    lastSeenSequence: sequence - 1,
    outPath: betaOutPath,
    stateDir,
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
    channel: 'beta',
    testers,
  })
  console.log(`beta roster: re-signed the beta manifest at sequence ${String(result.manifest.sequence)} (entries verbatim) → ${betaOutPath}`)
  console.log(`  state:   ${resolve(stateDir, 'last-sequence.json')} (shared ratchet)`)
}

async function commandVerifyHandoff(positionals, flags) {
  if (positionals.length !== 1) {
    throw new Error("verify-handoff takes exactly one argument: <submission-dir> (the staging clone's submissions/<name>-<version> directory)")
  }
  const json = flags.json === true
  const result = await verifyHandoffSubmission({
    submissionDir: resolve(process.cwd(), positionals[0]),
    smoke: flags.smoke === true,
    catalogOrigin: resolveCatalogOrigin(flags),
    ...(flags.project === undefined ? {} : { project: flags.project }),
    log: json ? undefined : console.log,
  })
  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('')
    console.log(`verify-handoff: ${result.ok ? 'PASS' : `FAIL at ${String(result.failedStep.index)}/10 ${result.failedStep.step}`}`)
    console.log(`  verdict: ${result.verdictPath}`)
    if (result.ok) console.log(`  staged:  ${result.packageRepoPath}`)
  }
  if (!result.ok) process.exitCode = 1
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
    else if (command === 'pack-tarball') await commandPackTarball(flags)
    else if (command === 'measure-and-publish') await commandMeasureAndPublish(flags)
    else if (command === 'revoke') await commandRevoke(positionals, flags)
    else if (command === 'promote') await commandPromote(positionals, flags)
    else if (command === 'beta-roster') await commandBetaRoster(flags)
    else if (command === 'verify') await commandVerify(positionals, flags)
    else if (command === 'verify-handoff') await commandVerifyHandoff(positionals, flags)
    else if (command === 'keygen') await commandKeygen()
    else if (command === 'selftest') await commandSelftest(flags)
    else fail(`unknown command '${command}'\n\n${USAGE}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

await main()
