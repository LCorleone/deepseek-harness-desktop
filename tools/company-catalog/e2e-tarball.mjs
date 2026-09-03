/**
 * End-to-end fixture drill of the tarball publish channel (P7 batch 2b).
 *
 * Exercises the whole publishing chain against the in-repo fixture plugin
 * (fixtures/fixture-hello) with an ephemeral signing key, entirely offline:
 *
 *   1. pack:        cli.mjs pack-tarball --source-dir fixtures/fixture-hello
 *                   (npm pack semantics → deterministic container → sha512 +
 *                   measured treeDigest via measure.mjs --tarball),
 *   2. allowlist:   runtime allowlist entry with source
 *                   {kind:'tarball', path, url} (path → the packed artifact,
 *                   url → the GitLab raw address the channel hosts),
 *   3. build:       cli.mjs measure-and-publish — resolve the path form to a
 *                   signed {kind,url,integrity}, fill the measured treeDigest,
 *                   sign, round-trip verify, write the manifest + publish-meta,
 *   4. publish:     publish-local.mjs --artifact-dir --deployed <local file>
 *                   --dry-run — the GitLab push is replaced by the local
 *                   dry-run byte gauntlet: sidecar sha256, fleet trust root
 *                   (a generated drill policy), signature, sequence ratchet,
 *                   the fleet-upgrade gate (refused, then acknowledged), and
 *                   the tarball bytes hashed against the SIGNED integrity
 *                   (plus a tampered-bytes refusal),
 *   5. verify:      cli.mjs verify, and the desktop-side cross-check — the
 *                   compiled verifyDesktopCompanyManifest must accept the
 *                   exact manifest bytes the tool verifier produced and parse
 *                   the same source/treeDigest (both verifiers agree).
 *
 * Nothing here touches a network: no registry (the allowlist is tarball-only),
 * no GitHub, no GitLab (the drill ratchet is a local file and the push stops
 * at the plan). Requires the built market + desktop libs and the installed
 * pinned pnpm; prints `e2e: SKIP` and exits 0 when they are absent (the yarn
 * check chain runs this after the builds, where the full chain executes).
 *
 * Usage: node tools/company-catalog/e2e-tarball.mjs [--keep]
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createEphemeralKeyPair, fingerprintOfRawPublicKey, rawPublicKeyBytes } from './lib/keys.mjs'
import { loadMarketLibrary } from './lib/market.mjs'
import { REPO_ROOT } from './lib/tarball.mjs'

/** tools/company-catalog (the lib module reports its own directory). */
const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

const FIXTURE_DIR = join(TOOL_DIR, 'fixtures', 'fixture-hello')
const CATALOG_ORIGIN = 'https://gitlab.company.example'
const GITLAB_ORIGIN = CATALOG_ORIGIN.slice('https://'.length)
const PROJECT = 'julu/dsh-desktop-config'
const KEY_ID = 'e2e.company-catalog'

const fail = (message) => {
  console.error(`e2e-tarball: ${message}`)
  process.exitCode = 1
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** Resolve one exported function from a compiled lib chunk by its original name. */
function exportedFunctionFromNamespace(moduleNamespace, name) {
  for (const value of Object.values(moduleNamespace)) {
    if (typeof value === 'function' && value.name === name) return value
  }
  throw new Error(`the compiled lib module does not export a function named ${name}`)
}

/** Find one compiled chunk file below a lib tree by name prefix. */
function libChunk(libDir, prefix) {
  if (!existsSync(libDir)) return undefined
  const candidate = readdirSync(libDir).find((entry) => new RegExp(`^${prefix}.*\\.js$`, 'u').test(entry))
  return candidate === undefined ? undefined : join(libDir, candidate)
}

/** Run one node script, fail with its captured output. */
function runNode(scriptPath, args, { env = {} } = {}) {
  const probe = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 900_000,
    env: { ...process.env, ...env },
  })
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
  if (probe.status !== 0) {
    throw new Error(`node ${basename(scriptPath)} ${args.join(' ')} exited ${String(probe.status)}:\n${output.trim().split('\n').slice(-12).join('\n')}`)
  }
  return output
}

async function main() {
  const keep = process.argv.includes('--keep')
  if (!existsSync(FIXTURE_DIR)) throw new Error(`the fixture plugin ${FIXTURE_DIR} is missing`)
  const marketLibDir = join(REPO_ROOT, 'dsh-community-market', 'lib')
  const desktopLibDir = join(REPO_ROOT, 'dsh-plugin-desktop', 'lib')
  const pinnedPnpm = join(REPO_ROOT, 'dsh-plugin-desktop', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
  const missing = [
    ...(existsSync(marketLibDir) ? [] : ['market lib (corepack yarn workspace dsh-community-market build)']),
    ...(existsSync(desktopLibDir) ? [] : ['desktop lib (corepack yarn workspace dsh-plugin-desktop build)']),
    ...(existsSync(pinnedPnpm) ? [] : ['pinned pnpm (corepack yarn install --immutable)']),
  ]
  if (missing.length > 0) {
    console.log(`e2e: SKIP — the build prerequisites are missing: ${missing.join(', ')}; run them (or the full 'corepack yarn check') to exercise the chain`)
    return
  }
  await loadMarketLibrary()

  // Workspace: inside the repo (gitignored out/) so the packed artifact has
  // the repo-relative source.path spelling the allowlist form signs.
  const workspace = mkdtempSync(join(TOOL_DIR, 'out', 'e2e-tarball-'))
  const packagesDir = join(workspace, 'packages')
  const runDir = join(workspace, 'run')
  try {
    // --- 1. pack the fixture ---------------------------------------------------
    const packOut = runNode(join(TOOL_DIR, 'cli.mjs'), [
      'pack-tarball',
      '--source-dir', FIXTURE_DIR,
      '--pack-out', packagesDir,
      '--catalog-origin', CATALOG_ORIGIN,
    ])
    const recordPath = join(packagesDir, 'fixture-hello-1.0.0.tgz.pack.json')
    assert(existsSync(recordPath), 'pack-tarball wrote no pack record sidecar')
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert(record.packageName === 'fixture-hello' && record.version === '1.0.0', `unexpected pack record ${JSON.stringify(record)}`)
    const tarballPath = join(packagesDir, record.filename)
    assert(!record.path.startsWith('/'), `the pack record path ${record.path} must be the repo-relative spelling`)
    assert(existsSync(join(REPO_ROOT, record.path)), `the pack record path ${record.path} does not resolve from the repository root`)
    const originalBytes = readFileSync(tarballPath)
    const integrity = `sha512-${createHash('sha512').update(originalBytes).digest('base64')}`
    assert(integrity === record.integrity, 'the pack record integrity does not match the artifact bytes')
    assert(/^[0-9a-f]{64}$/u.test(packOut.match(/treeDigest:\s+([0-9a-f]{64})/u)?.[1] ?? ''), 'pack-tarball printed no measured treeDigest')
    const treeDigest = packOut.match(/treeDigest:\s+([0-9a-f]{64})/u)[1]
    console.log(`[1] pack:      ${record.filename} ${String(record.sizeBytes)} B · integrity ${record.integrity.slice(0, 20)}… · treeDigest ${treeDigest.slice(0, 16)}… (measured)`)

    // --- 2. runtime allowlist + digest file -------------------------------------
    const url = `${CATALOG_ORIGIN}/${PROJECT}/-/raw/master/packages/${record.filename}`
    const allowlist = [{
      packageName: record.packageName,
      version: record.version,
      bundlePatch: './cordis.patch.yml',
      repository: 'https://github.com/example/fixture-hello',
      revoked: false,
      runtime: { dshRuntimeVersion: '^0.1.1-rc.2' },
      source: { kind: 'tarball', url, path: record.path },
    }]
    const allowlistPath = join(workspace, 'allowlist.json')
    writeFileSync(allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`, 'utf8')
    const digestFilePath = join(workspace, 'tree-digests.json')
    writeFileSync(digestFilePath, `${JSON.stringify([{ packageName: record.packageName, version: record.version, treeDigest }])}\n`, 'utf8')
    console.log(`[2] allowlist: runtime entry source {kind:'tarball', path:'${record.path}', url …/${record.filename}}`)

    // --- 3. sign: measure-and-publish --------------------------------------------
    const { privateKey, publicKey } = createEphemeralKeyPair()
    const signingKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const fingerprint = fingerprintOfRawPublicKey(rawPublicKeyBytes(publicKey))
    mkdirSync(runDir, { recursive: true })
    runNode(join(TOOL_DIR, 'cli.mjs'), [
      'measure-and-publish',
      '--digest-file', digestFilePath,
      '--allowlist', allowlistPath,
      '--state-dir', join(workspace, 'state'),
      '--out', join(runDir, 'catalog-manifest.json'),
      '--meta-out', join(runDir, 'publish-meta.json'),
      '--catalog-origin', CATALOG_ORIGIN,
    ], { env: {
      COMPANY_CATALOG_SIGNING_KEY: signingKey,
      COMPANY_CATALOG_KEY_ID: KEY_ID,
    } })
    const manifestText = readFileSync(join(runDir, 'catalog-manifest.json'), 'utf8')
    const meta = JSON.parse(readFileSync(join(runDir, 'publish-meta.json'), 'utf8'))
    const manifest = JSON.parse(manifestText)
    const signedEntry = manifest.packages[0]
    assert(signedEntry.source.kind === 'tarball' && signedEntry.source.url === url && signedEntry.source.integrity === integrity, 'the signed source does not carry the resolved url + artifact sha512')
    assert(signedEntry.treeDigest === treeDigest && signedEntry.source.path === undefined, 'the signed entry must carry the measured treeDigest and never the local path')
    // The workflow layout: the artifact carries the tarballs under packages/
    // next to the signed pair — mirror that for the publisher replay.
    mkdirSync(join(runDir, 'packages'), { recursive: true })
    writeFileSync(join(runDir, 'packages', record.filename), originalBytes)
    console.log(`[3] sign:      sequence ${String(manifest.sequence)} · ${String(manifest.packages.length)} entry · source {kind:'tarball'} signed (path form resolved, path itself never signed)`)

    // --- 4. publish-local dry-run gauntlet ----------------------------------------
    const baselinePath = join(workspace, 'baseline-deployed.json')
    writeFileSync(baselinePath, `${JSON.stringify({ sequence: 0 })}\n`, 'utf8')
    const drillPolicyPath = join(workspace, 'drill-policy.json')
    writeFileSync(drillPolicyPath, `${JSON.stringify({ trustRoots: [{ keyId: KEY_ID, fingerprint }] })}\n`, 'utf8')
    const publisherArgs = (extra) => [
      '--artifact-dir', runDir,
      '--deployed', baselinePath,
      '--dry-run',
      '--gitlab', GITLAB_ORIGIN,
      '--project', PROJECT,
      '--policy', drillPolicyPath,
      ...extra,
    ]
    // 4a. the fleet-upgrade gate must refuse the first authoritative publish.
    const refused = spawnSync(process.execPath, [join(TOOL_DIR, 'publish-local.mjs'), ...publisherArgs([])], { encoding: 'utf8', timeout: 120_000 })
    const refusedOutput = `${refused.stdout ?? ''}\n${refused.stderr ?? ''}`
    assert(refused.status !== 0 && refusedOutput.includes('fleet-upgrade gate'), `the fleet gate did not refuse the first authoritative publish:\n${refusedOutput}`)
    console.log('[4] publish:   fleet-upgrade gate refused the unacknowledged first publish (source field) — as designed')
    // 4b. acknowledged: the full dry-run must verify bytes and print the plan.
    const plan = runNode(join(TOOL_DIR, 'publish-local.mjs'), publisherArgs(['--confirm-fleet-upgraded']))
    assert(plan.includes('tarballs:  1 artifact(s) verified against the signed integrity'), 'the dry-run did not verify the tarball bytes against the signed integrity')
    assert(plan.includes(`packages/${record.filename}`), 'the push plan does not carry the hosted tarball path')
    assert(plan.includes('dry-run: stopped before the clone'), 'the dry-run did not stop before the clone')
    console.log('[4] publish:   dry-run verified sidecar sha256 + fleet trust root + ratchet 0→1 + tarball sha512 = signed integrity; plan printed')
    // 4c. tampered bytes must fail closed.
    const tampered = Buffer.from(originalBytes)
    tampered[tampered.length - 1] ^= 0xFF
    writeFileSync(tarballPath, tampered)
    writeFileSync(join(runDir, 'packages', record.filename), tampered)
    const refusedTamper = spawnSync(process.execPath, [join(TOOL_DIR, 'publish-local.mjs'), ...publisherArgs(['--confirm-fleet-upgraded'])], { encoding: 'utf8', timeout: 120_000 })
    const tamperOutput = `${refusedTamper.stdout ?? ''}\n${refusedTamper.stderr ?? ''}`
    assert(refusedTamper.status !== 0 && tamperOutput.includes('hashes to') && tamperOutput.includes('signed'), `tampered artifact bytes were not refused:\n${tamperOutput}`)
    writeFileSync(tarballPath, originalBytes)
    writeFileSync(join(runDir, 'packages', record.filename), originalBytes)
    const restored = `sha512-${createHash('sha512').update(readFileSync(tarballPath)).digest('base64')}`
    assert(restored === integrity, 'the tampered artifact could not be restored to the signed bytes')
    console.log('[4] publish:   tampered tarball bytes refused (sha512 ≠ signed integrity) — fail closed')

    // --- 5. verify: CLI + desktop cross-check -------------------------------------
    runNode(join(TOOL_DIR, 'cli.mjs'), ['verify', join(runDir, 'catalog-manifest.json'), '--catalog-origin', CATALOG_ORIGIN], { env: {
      COMPANY_CATALOG_KEY_FINGERPRINT: fingerprint,
    } })
    console.log('[5] verify:    cli verify VERIFIED (trust root pinned, channels parsed)')
    const desktopMarketModule = await import(pathToFileURL(libChunk(desktopLibDir, 'desktop-market-')).href)
    const verifyDesktopCompanyManifest = exportedFunctionFromNamespace(desktopMarketModule, 'verifyDesktopCompanyManifest')
    const desktopVerification = verifyDesktopCompanyManifest(manifestText, {
      trustRoots: [{ keyId: KEY_ID, fingerprint }],
      companyCatalogOrigin: CATALOG_ORIGIN,
    })
    assert(desktopVerification.ok, `verifyDesktopCompanyManifest rejected the tool-signed manifest (${desktopVerification.code}: ${desktopVerification.reason})`)
    const desktopEntry = desktopVerification.manifest.packages[0]
    assert(desktopEntry.source.kind === 'tarball' && desktopEntry.source.url === url && desktopEntry.source.integrity === integrity, 'the desktop verifier parsed a different source than the tool signed')
    assert(desktopEntry.treeDigest === treeDigest, 'the desktop verifier parsed a different treeDigest than the tool signed')
    const wrongOrigin = verifyDesktopCompanyManifest(manifestText, {
      trustRoots: [{ keyId: KEY_ID, fingerprint }],
      companyCatalogOrigin: 'https://other.company.example',
    })
    assert(!wrongOrigin.ok, 'the desktop verifier must reject the tarball url outside the pinned catalog origin')
    console.log('[5] verify:    desktop verifyDesktopCompanyManifest accepts the exact bytes (source + treeDigest parsed identically; wrong origin rejected)')

    console.log('')
    console.log('e2e: PASS — pack → allowlist → sign → publish dry-run → dual-verifier verify, all offline')
  } finally {
    if (keep === true || process.env.DSH_E2E_KEEP === '1') {
      console.log(`e2e: kept the workspace ${workspace}`)
    } else {
      rmSync(workspace, { recursive: true, force: true })
    }
  }
}

try {
  await main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
