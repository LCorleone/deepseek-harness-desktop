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
 * pinned pnpm; prints `e2e: SKIP` and exits 0 when they are absent. The yarn
 * check chain runs this last (`yarn check:company-catalog`, after the
 * workspace checks have built the libs and yarn install put the pinned pnpm
 * in place), and the Company catalog workflow exercises it on CI; on a fresh
 * checkout run it after `corepack yarn install --immutable && corepack yarn
 * build` (or a full `corepack yarn check`).
 *
 * Usage: node tools/company-catalog/e2e-tarball.mjs [--keep]
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createEphemeralKeyPair, fingerprintOfRawPublicKey, rawPublicKeyBytes } from './lib/keys.mjs'
import { loadMarketLibrary } from './lib/market.mjs'
import { parseTarball, REPO_ROOT } from './lib/tarball.mjs'

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

/** Resolve one exported function from a compiled lib chunk by its original name (namespace objects included). */
function exportedFunctionFromNamespace(moduleNamespace, name) {
  for (const value of Object.values(moduleNamespace)) {
    if (typeof value === 'function' && value.name === name) return value
    if (value !== null && typeof value === 'object') {
      const nested = value[name]
      if (typeof nested === 'function' && nested.name === name) return nested
    }
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
    assert(record.bundlePatch === './cordis.patch.yml', `the pack record must carry the in-package declaration (got ${JSON.stringify(record.bundlePatch)})`)
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
    // 3a. Consistency gate, negative first: the 0.4.181 real-incident shape —
    // an allowlist entry whose bundlePatch spelling diverges from the packed
    // package's own declaration — must abort the publish before anything is
    // signed, naming both values. (The fixture declares './cordis.patch.yml';
    // the drifted entry drops the prefix — the same strict-equality class as
    // the incident, from the other side.) The aligned entry below then runs
    // the same chain to green.
    const driftAllowlistPath = join(workspace, 'allowlist-drift.json')
    writeFileSync(driftAllowlistPath, `${JSON.stringify([{ ...allowlist[0], bundlePatch: 'cordis.patch.yml' }], null, 2)}\n`, 'utf8')
    const driftRefusal = spawnSync(process.execPath, [join(TOOL_DIR, 'cli.mjs'),
      'measure-and-publish',
      '--digest-file', digestFilePath,
      '--allowlist', driftAllowlistPath,
      '--state-dir', join(workspace, 'state-drift'),
      '--out', join(runDir, 'drift-manifest.json'),
      '--catalog-origin', CATALOG_ORIGIN,
    ], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, COMPANY_CATALOG_SIGNING_KEY: signingKey, COMPANY_CATALOG_KEY_ID: KEY_ID } })
    const driftOutput = `${driftRefusal.stdout ?? ''}\n${driftRefusal.stderr ?? ''}`
    assert(driftRefusal.status !== 0
      && driftOutput.includes('declares "./cordis.patch.yml"')
      && driftOutput.includes('the allowlist entry bundlePatch is "cordis.patch.yml"'),
    `a prefix-drifted entry must abort measure-and-publish before signing:\n${driftOutput}`)
    assert(!existsSync(join(runDir, 'drift-manifest.json')), 'the drifted publish must write no manifest')
    console.log('[3] gate:      prefix-drifted bundlePatch spelling refused before signing (packed "./cordis.patch.yml" vs entry "cordis.patch.yml") — the 0.4.181 failure class, now caught at build time')
    // 3b. The aligned shape (the real form: './'-prefixed on both sides) signs.
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

    // --- 6. install + boot re-verification (P7 2c) -------------------------------
    // The client half of the channel, entirely offline: stage the signed
    // tarball through the real staging step (the download boundary is the
    // packed artifact bytes, no socket), simulate what the market install
    // orchestration + its pnpm `file:` target leave behind in a profile
    // (a hand-written fixture of the pnpm 11 lockfile spelling — the real
    // pinned pnpm is exercised by dsh-plugin-desktop's
    // tests/company-market-install.spec.ts "real pinned pnpm" suite, which
    // runs an actual `pnpm add file:<staged>` and feeds the generated
    // lockfile through boot recognition, the market lock-record assert, and
    // the staging GC), and re-verify that profile through the real
    // boot-verification functions against the same signed manifest — then
    // break the staged file and watch the same boot step refuse the bundle
    // with the pointed repair reason instead of silently allowing it.
    const bootModule = await import(pathToFileURL(libChunk(desktopLibDir, 'boot-verification-') ?? join(desktopLibDir, 'boot-verification-CHUNK.js')).href)
    const pnpmModule = await import(pathToFileURL(libChunk(desktopLibDir, 'pnpm') ?? join(desktopLibDir, 'pnpm.js')).href)
    const stageCompanyMarketTarball = exportedFunctionFromNamespace(desktopMarketModule, 'stageCompanyMarketTarball')
    const desktopBootLockIntegrity = exportedFunctionFromNamespace(bootModule, 'desktopBootLockIntegrity')
    const desktopBootControlledTarballPinProblem = exportedFunctionFromNamespace(bootModule, 'desktopBootControlledTarballPinProblem')
    const readDesktopBootLockfile = exportedFunctionFromNamespace(bootModule, 'readDesktopBootLockfile')
    const verifyDesktopBootBundles = exportedFunctionFromNamespace(bootModule, 'verifyDesktopBootBundles')
    const desktopMarketTarballStagingPath = exportedFunctionFromNamespace(pnpmModule, 'desktopMarketTarballStagingPath')
    const profileDir = join(workspace, 'boot-profile')
    mkdirSync(profileDir, { recursive: true })
    const stagedPath = desktopMarketTarballStagingPath(profileDir, record.packageName, record.version)
    const staged = await stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: signedEntry.source,
      packageName: record.packageName,
      version: record.version,
      profileDir,
      request: async (url, init) => {
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
        if (url !== signedEntry.source.url) return new Response('not found', { status: 404 })
        return new Response(new Uint8Array(originalBytes), {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        })
      },
    })
    assert(staged.integrity === integrity && readFileSync(staged.stagedPath).equals(originalBytes), 'the real staging step did not land the signed bytes at the controlled path')
    // The market orchestration's install target: the unpacked tarball under
    // node_modules, the `file:` dependency pin, and the hand-written lockfile
    // fixture of a file: install mirroring pnpm 11's spelling (absolute
    // specifier, profile-relative resolution, the tarball's own sha512 as
    // the recorded integrity — proven against the real pinned pnpm by the
    // desktop workspace's "real pinned pnpm" integration suite).
    const packageDir = join(profileDir, 'node_modules', record.packageName)
    mkdirSync(packageDir, { recursive: true })
    for (const entry of parseTarball(originalBytes, 'the packed fixture')) {
      const target = join(packageDir, entry.path.replace(/^package\//u, ''))
      if (entry.type === 'directory') {
        mkdirSync(target, { recursive: true })
        continue
      }
      assert(entry.type === 'file', `the fixture tarball carries a ${entry.type} entry the drill does not materialize`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data)
    }
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'drill-profile',
      dependencies: { [record.packageName]: `file:${stagedPath}` },
      dsh: { profile: { bundles: [record.packageName] } },
    })}\n`)
    const relativeStaged = relative(profileDir, stagedPath).split(sep).join('/')
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      `      ${record.packageName}:`,
      `        specifier: file:${stagedPath}`,
      `        version: file:${relativeStaged}`,
      'packages:',
      `  ${record.packageName}@file:${relativeStaged}:`,
      `    resolution: {integrity: ${integrity}, tarball: file:${relativeStaged}}`,
      `    version: ${record.version}`,
      'snapshots:',
      `  ${record.packageName}@file:${relativeStaged}: {}`,
      '',
    ].join('\n'))
    const drillLockfile = readDesktopBootLockfile(profileDir)
    assert(drillLockfile !== undefined, 'the drill lockfile did not parse')
    const lockIntegrity = desktopBootLockIntegrity(drillLockfile, record.packageName, record.version, { profileDir: profileDir })
    assert(lockIntegrity === integrity, `boot lock-integrity resolved ${String(lockIntegrity)} instead of the signed tarball sha512`)
    const bootVerdict = verifyDesktopBootBundles(manifestText, [
      { packageName: record.packageName, version: record.version, lockIntegrity, packageDir },
    ], { trustRoots: [{ keyId: KEY_ID, fingerprint }], companyCatalogOrigin: CATALOG_ORIGIN })
    assert(bootVerdict.rejected.length === 0, `boot re-verification rejected the simulated install: ${JSON.stringify(bootVerdict.rejected)}`)
    assert(bootVerdict.allowed.length === 1 && bootVerdict.allowed[0].evidence === 'signed-tree', `boot re-verification did not allow the bundle with signed-tree evidence: ${JSON.stringify(bootVerdict.allowed)}`)
    console.log('[6] boot:      staged tarball (real staging) + file: pin (hand-written lockfile fixture; real-pnpm proof lives in the desktop tests) → lock-integrity = signed sha512 → boot allowed (signed-tree)')
    // Negative: the staged file no longer matches the pinned sha512 (the
    // GC/loss case) — the same boot step refuses the bundle by name with the
    // reinstall repair reason, never a silent allow.
    const tamperedStaged = Buffer.from(originalBytes)
    tamperedStaged[tamperedStaged.length - 1] ^= 0xFF
    writeFileSync(stagedPath, tamperedStaged)
    const brokenLockfile = readDesktopBootLockfile(profileDir)
    assert(desktopBootLockIntegrity(brokenLockfile, record.packageName, record.version, { profileDir: profileDir }) === undefined, 'a tampered staged tarball still passed the boot lock-integrity step')
    const problem = desktopBootControlledTarballPinProblem(brokenLockfile, record.packageName, record.version, { profileDir: profileDir })
    assert(typeof problem === 'string' && problem.includes('reinstall the plugin from the company market'), `the broken pin did not produce the pointed repair reason: ${String(problem)}`)
    const brokenVerdict = verifyDesktopBootBundles(manifestText, [
      { packageName: record.packageName, version: record.version, lockIntegrity: undefined, lockProblem: problem, packageDir },
    ], { trustRoots: [{ keyId: KEY_ID, fingerprint }], companyCatalogOrigin: CATALOG_ORIGIN })
    assert(brokenVerdict.allowed.length === 0 && brokenVerdict.rejected.length === 1, `the broken staged tarball did not refuse exactly its own bundle: ${JSON.stringify(brokenVerdict)}`)
    assert(String(brokenVerdict.rejected[0].reason).includes('reinstall the plugin from the company market'), `the refusal did not point at the repair path: ${brokenVerdict.rejected[0].reason}`)
    console.log('[6] boot:      tampered staged tarball → lock-integrity fails, bundle refused by name with the reinstall repair reason')

    console.log('')
    console.log('e2e: PASS — pack → allowlist → sign → publish dry-run → dual-verifier verify → install + boot re-verification, all offline')
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
