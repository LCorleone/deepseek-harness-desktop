/**
 * Intranet-side company catalog publisher.
 *
 * The GitHub runner that measures, signs, and verifies the catalog manifest
 * cannot reach the intranet GitLab (verified empirically), so publishing is
 * split: the workflow uploads the signed bytes as the `company-catalog-signed`
 * artifact, and this script — run on a machine that can reach both GitHub and
 * the intranet — performs the actual deployment:
 *
 *   1. download the artifact (`gh run download`, or --artifact-dir to replay
 *      a local copy laid out the same way),
 *   2. integrity: the meta sidecar's manifestSha256 must match the bytes,
 *   3. trust: the signature must verify against the artifact's trust root,
 *      which must equal the deployment trust root pinned in the desktop
 *      policy (the fleet's actual trust decision) — and, when set, the
 *      COMPANY_CATALOG_KEY_FINGERPRINT env pin,
 *   4. ratchet: artifact.sequence must equal the deployed manifest's
 *      sequence + 1 (both values printed on mismatch — no skipping, no
 *      replaying, no double push),
 *   5. clone the GitLab config repo, overwrite catalog-manifest.json with the
 *      artifact bytes verbatim (canonical single line; the GitLab web editor
 *      would reformat them — the manifest only ever moves through git push),
 *   6. commit (message carries sequence/fingerprint/run id) and push,
 *   7. re-read the raw URL until it serves HTTP 200 with the pushed
 *      sequence (≤ 5 minutes), then print the completion summary.
 *
 * Every failure is fail-closed: nothing is pushed unless the artifact is
 * present, byte-intact, signature-valid under the fleet's trust root, and
 * exactly one step ahead of what is deployed. `--dry-run` runs steps 1-4 and
 * prints the push plan, stopping before the clone. The GitLab PAT comes from
 * --token or the GITLAB_TOKEN environment variable and is passed to git
 * through GIT_CONFIG_* environment injection (an http.* extraheader) — it
 * never appears in argv, in the clone's config, or in error output.
 *
 * Plain Node (built-ins only) + `gh` and `git` on PATH. After a successful
 * master publish, commit the GitHub-side state bump:
 * tools/company-catalog/state/last-sequence.json → the published sequence.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMarketLibrary } from './lib/market.mjs'
import { readDeployedSequence, verifyManifestText } from './lib/pipeline.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
/** The fleet's trust decision: release policy trustRoots the desktop pins. */
const RELEASE_POLICY_PATH = resolve(REPO_ROOT, 'dsh-plugin-desktop', 'src', 'policy', 'desktop-policy.release.json')

const DEFAULT_GITHUB_REPO = 'LCorleone/deepseek-harness-desktop'
const DEFAULT_WORKFLOW = 'company-catalog-publish.yml'
const ARTIFACT_NAME = 'company-catalog-signed'
const DEFAULT_GITLAB_ORIGIN = 'gitlab.s.dai.deloitte.cn'
const DEFAULT_GITLAB_PROJECT = 'julu/dsh-desktop-config'
const MANIFEST_FILE = 'catalog-manifest.json'
const META_FILE = 'publish-meta.json'
/** Hard cap on the manifest an artifact may carry (the pipeline bound is 1 MiB). */
const MANIFEST_MAX_BYTES = 2_097_152
const RECHECK_TIMEOUT_MS = 5 * 60_000
const RECHECK_INTERVAL_MS = 15_000

const USAGE = `Usage: node tools/company-catalog/publish-local.mjs [options]

Intranet-side publisher: download the signed company-catalog artifact from
GitHub, re-verify it, ratchet-check the sequence against the manifest
deployed on GitLab, push the canonical bytes, and re-read the raw URL.

Options:
  --run <id>            GitHub Actions run id (default: the latest successful
                        run of the ${DEFAULT_WORKFLOW} workflow in --repo)
  --repo <owner/name>   GitHub repository (default: ${DEFAULT_GITHUB_REPO})
  --artifact-dir <dir>  skip gh: publish from a local directory already laid
                        out like the download (${MANIFEST_FILE} + ${META_FILE})
                        — offline replay/testing
  --branch <name>       GitLab branch to push (default: master — the
                        production line; use a temp branch only for drills)
  --token <pat>         GitLab PAT (default: env GITLAB_TOKEN)
  --gitlab <origin>     GitLab origin (default: ${DEFAULT_GITLAB_ORIGIN})
  --project <path>      GitLab project (default: ${DEFAULT_GITLAB_PROJECT})
  --dry-run             verify + ratchet-check + print the push plan; stop
                        before the clone
  --insecure-tls        pilot parity: disable TLS verification for the raw
                        fetch and the git transport (same posture the desktop
                        accepts intranet-side); prefer exporting
                        NODE_EXTRA_CA_CERTS with the corporate root instead
  --help                show this help`

const fail = (message) => {
  console.error(`publish-local: ${message}`)
  process.exitCode = 1
}

/** 64 lowercase hex characters — fingerprints and sha256s share the shape. */
const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)

/** Scratch directories removed however the run ends. */
const tempDirs = []

/** Minimal hand-rolled parser: `--flag value`, `--flag=value`, no positionals. */
function parseArgs(argv) {
  const flags = {}
  const valueFlags = new Set(['run', 'repo', 'artifact-dir', 'branch', 'token', 'gitlab', 'project'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument '${argument}'`)
    const equals = argument.indexOf('=')
    const name = (equals === -1 ? argument.slice(2) : argument.slice(2, equals))
    if (name === 'help') {
      flags.help = true
      continue
    }
    const isValueFlag = valueFlags.has(name)
    if (equals !== -1 && !isValueFlag) throw new Error(`--${name} does not take a value`)
    if (!isValueFlag) {
      flags[name] = true
      continue
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1)
    if (value === undefined) throw new Error(`--${name} requires a value`)
    if (equals === -1) index += 1
    flags[name] = value
  }
  return flags
}

/** Run a command, capture output, fail closed with the captured stderr. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 120_000,
  })
  if (result.error !== undefined) {
    throw new Error(`${command} could not be executed (${result.error.message}) — is it on PATH?`)
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `exit ${String(result.status)}`
    throw new Error(`${command} ${args.join(' ')} failed:\n${redact(detail)}`)
  }
  return result.stdout
}

/** Strip anything shaped like the PAT or its base64 header from git output. */
function redact(text) {
  let cleaned = text
  const token = process.env.DSH_PUBLISH_LOCAL_TOKEN
  if (token !== undefined && token.length > 0) cleaned = cleaned.split(token).join('«token»')
  const header = process.env.DSH_PUBLISH_LOCAL_HEADER
  if (header !== undefined && header.length > 0) cleaned = cleaned.split(header).join('«auth-header»')
  return cleaned
}

/** git env with the PAT injected through GIT_CONFIG_* (never argv/config). */
function gitEnvironment(token, insecureTls = false) {
  const basic = Buffer.from(`oauth2:${token}`, 'utf8').toString('base64')
  const header = `Authorization: Basic ${basic}`
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: insecureTls ? '2' : '1',
    GIT_CONFIG_KEY_0: `http.https://${gitlabOrigin}/.extraheader`,
    GIT_CONFIG_VALUE_0: header,
    ...(insecureTls ? { GIT_CONFIG_KEY_1: 'http.sslVerify', GIT_CONFIG_VALUE_1: 'false' } : {}),
    DSH_PUBLISH_LOCAL_TOKEN: token,
    DSH_PUBLISH_LOCAL_HEADER: header,
  }
}

let gitlabOrigin = DEFAULT_GITLAB_ORIGIN

/** Read a small JSON file with a hard byte cap; every failure is descriptive. */
function readJsonCapped(path, capBytes, what) {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    throw new Error(`${what} is missing from the artifact (${error.code ?? error.message}) — re-download the artifact or fix the directory layout`)
  }
  if (!stat.isFile()) throw new Error(`${what} is not a file`)
  if (stat.size > capBytes) throw new Error(`${what} is ${String(stat.size)} bytes, over the ${String(capBytes)}-byte bound`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${what} is not valid JSON (${error.message})`)
  }
}

/** Structural validation of the meta sidecar; returns the normalized meta. */
function loadMeta(metaPath) {
  const meta = readJsonCapped(metaPath, 65_536, `the publish metadata (${META_FILE})`)
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(`${META_FILE} must be a JSON object`)
  }
  if (!Number.isSafeInteger(meta.sequence) || meta.sequence < 1) {
    throw new Error(`${META_FILE} carries no safe positive integer sequence — the sequence must never be guessed`)
  }
  if (typeof meta.keyId !== 'string' || meta.keyId.length === 0) {
    throw new Error(`${META_FILE} carries no keyId`)
  }
  if (!isHex64(meta.fingerprint)) {
    throw new Error(`${META_FILE} fingerprint must be 64 lowercase hex characters (got '${String(meta.fingerprint)}')`)
  }
  if (!isHex64(meta.manifestSha256)) {
    throw new Error(`${META_FILE} manifestSha256 must be 64 lowercase hex characters — the handoff integrity hash is mandatory`)
  }
  if (!Array.isArray(meta.entries) || meta.entries.length === 0) {
    throw new Error(`${META_FILE} carries no entries array`)
  }
  for (const [index, entry] of meta.entries.entries()) {
    if (entry === null || typeof entry !== 'object' || typeof entry.packageName !== 'string' || typeof entry.version !== 'string') {
      throw new Error(`${META_FILE} entry ${String(index)} must carry packageName and version`)
    }
    if (entry.treeDigest !== undefined && !isHex64(entry.treeDigest)) {
      throw new Error(`${META_FILE} entry ${entry.packageName} treeDigest must be 64 lowercase hex characters`)
    }
  }
  return meta
}

/** The desktop release policy trustRoots — what the fleet will actually accept. */
function loadFleetTrustRoots() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(RELEASE_POLICY_PATH, 'utf8'))
  } catch (error) {
    throw new Error(
      `the desktop release policy ${RELEASE_POLICY_PATH} could not be read (${error.code ?? error.message}) — ` +
      'the fleet trust root is what decides whether the artifact is publishable; refusing to guess it',
    )
  }
  const roots = parsed?.trustRoots
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(`${RELEASE_POLICY_PATH} carries no trustRoots — cannot confirm the fleet would accept this artifact`)
  }
  return roots
}

async function main() {
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    console.error('')
    console.error(USAGE)
    return
  }
  if (flags.help === true) {
    console.log(USAGE)
    return
  }

  gitlabOrigin = typeof flags.gitlab === 'string' && flags.gitlab.length > 0 ? flags.gitlab : DEFAULT_GITLAB_ORIGIN
  const project = typeof flags.project === 'string' && flags.project.length > 0 ? flags.project : DEFAULT_GITLAB_PROJECT
  const branch = typeof flags.branch === 'string' && flags.branch.length > 0 ? flags.branch : 'master'
  const repo = typeof flags.repo === 'string' && flags.repo.length > 0 ? flags.repo : DEFAULT_GITHUB_REPO
  const dryRun = flags['dry-run'] === true
  if (flags['insecure-tls'] === true) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    console.log('publish-local: WARNING — --insecure-tls: TLS verification disabled for this run (pilot parity); prefer NODE_EXTRA_CA_CERTS with the corporate root')
  }

  const masterRawUrl = `https://${gitlabOrigin}/${project}/-/raw/master/${MANIFEST_FILE}`

  // --- 1. acquire the artifact -------------------------------------------------
  let artifactDir
  let runId
  if (typeof flags['artifact-dir'] === 'string') {
    artifactDir = resolve(process.cwd(), flags['artifact-dir'])
    runId = 'local-artifact'
    console.log(`artifact: local directory ${artifactDir} (--artifact-dir — skipping gh)`)
  } else {
    run('gh', ['--version'])
    if (typeof flags.run === 'string' && /^[0-9]+$/.test(flags.run)) {
      runId = flags.run
    } else {
      if (flags.run !== undefined) throw new Error(`--run must be a numeric GitHub Actions run id (got '${flags.run}')`)
      const listing = JSON.parse(run('gh', ['run', 'list', '--workflow', DEFAULT_WORKFLOW, '--repo', repo, '--status', 'success', '--limit', '1', '--json', 'databaseId,displayTitle']))
      if (!Array.isArray(listing) || listing.length === 0) {
        throw new Error(`no successful run of ${DEFAULT_WORKFLOW} found in ${repo} — run the workflow with dry-run unchecked first, or pass --run <id>`)
      }
      runId = String(listing[0].databaseId)
      console.log(`run: latest successful ${DEFAULT_WORKFLOW} run in ${repo}: ${runId} (${listing[0].displayTitle})`)
    }
    artifactDir = mkdtempSync(join(tmpdir(), 'company-catalog-artifact-'))
    tempDirs.push(artifactDir)
    run('gh', ['run', 'download', runId, '--repo', repo, '--name', ARTIFACT_NAME, '--dir', artifactDir])
    console.log(`artifact: downloaded ${ARTIFACT_NAME} from run ${runId} → ${artifactDir}`)
  }

  // --- 2. integrity: bytes must hash to the sidecar's manifestSha256 -----------
  const manifestPath = join(artifactDir, MANIFEST_FILE)
  let manifestStat
  try {
    manifestStat = statSync(manifestPath)
  } catch (error) {
    throw new Error(`${MANIFEST_FILE} is missing from the artifact (${error.code ?? error.message}) — the artifact is incomplete`)
  }
  if (manifestStat.size > MANIFEST_MAX_BYTES) {
    throw new Error(`${MANIFEST_FILE} is ${String(manifestStat.size)} bytes, over the ${String(MANIFEST_MAX_BYTES)}-byte bound`)
  }
  const manifestBytes = readFileSync(manifestPath)
  const meta = loadMeta(join(artifactDir, META_FILE))
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  if (manifestSha256 !== meta.manifestSha256) {
    throw new Error(
      `artifact integrity failure: ${MANIFEST_FILE} hashes to ${manifestSha256} but ${META_FILE} pins ${meta.manifestSha256} — ` +
      'the bytes changed between signing and download; re-run the workflow',
    )
  }
  const manifestText = manifestBytes.toString('utf8')
  const manifest = JSON.parse(manifestText)
  if (manifest.sequence !== meta.sequence) {
    throw new Error(`${MANIFEST_FILE} carries sequence ${String(manifest.sequence)} but ${META_FILE} says ${String(meta.sequence)} — the sidecar does not describe these bytes`)
  }
  if (manifest.signature?.keyId !== meta.keyId) {
    throw new Error(`${MANIFEST_FILE} signature.keyId '${String(manifest.signature?.keyId)}' does not match ${META_FILE} keyId '${meta.keyId}'`)
  }
  const packages = Array.isArray(manifest.packages) ? manifest.packages : []
  if (meta.entries.length !== packages.length) {
    throw new Error(`${META_FILE} lists ${String(meta.entries.length)} entries but ${MANIFEST_FILE} signs ${String(packages.length)} — the sidecar does not describe these bytes`)
  }
  for (const entry of meta.entries) {
    const signed = packages.find((candidate) => candidate.packageName === entry.packageName && candidate.version === entry.version)
    if (signed === undefined) {
      throw new Error(`${META_FILE} entry ${entry.packageName}@${entry.version} is not signed in ${MANIFEST_FILE}`)
    }
    if ((signed.treeDigest ?? undefined) !== entry.treeDigest) {
      throw new Error(`${META_FILE} treeDigest for ${entry.packageName}@${entry.version} does not match the signed manifest entry`)
    }
  }
  console.log(`integrity: sha256 ${manifestSha256} matches ${META_FILE}; sequence ${String(meta.sequence)}, ${String(meta.entries.length)} entries described by the sidecar`)

  // --- 3. trust: signature must verify under the fleet's trust root ------------
  const fleetRoots = loadFleetTrustRoots()
  const fleetRoot = fleetRoots.find((root) => root?.keyId === meta.keyId && root?.fingerprint === meta.fingerprint)
  if (fleetRoot === undefined) {
    throw new Error(
      `trust-root mismatch: the artifact was signed by keyId '${meta.keyId}' fingerprint ${meta.fingerprint}, but the desktop release policy pins ` +
      `${fleetRoots.map((root) => `${root?.keyId}/${root?.fingerprint}`).join(', ')} — the fleet would reject this manifest; refusing to push`,
    )
  }
  const pinned = process.env.COMPANY_CATALOG_KEY_FINGERPRINT
  if (pinned !== undefined && pinned !== meta.fingerprint) {
    throw new Error(`COMPANY_CATALOG_KEY_FINGERPRINT pins ${pinned} but the artifact was signed by ${meta.fingerprint} — key rotation in flight? Refusing to push`)
  }

  // --- 4. ratchet: artifact must be exactly one step ahead of the deployment ----
  const deployed = await readDeployedSequence(masterRawUrl)
  if (meta.sequence !== deployed.sequence + 1) {
    throw new Error(
      `sequence ratchet failure: the artifact carries sequence ${String(meta.sequence)} but GitLab has ${String(deployed.sequence)} deployed ` +
      `(${masterRawUrl}); required artifact.sequence == deployed + 1 (== ${String(deployed.sequence + 1)}). ` +
      (meta.sequence <= deployed.sequence
        ? 'this artifact is stale — clients have already seen its sequence or newer; rebuild from a bumped state file'
        : 'the state file used for the build jumped ahead of the deployment — publish the pending artifact first, then rebuild'),
    )
  }
  const market = await loadMarketLibrary()
  const verification = verifyManifestText(market, manifestText, { fingerprint: meta.fingerprint, keyId: meta.keyId, lastSeenSequence: deployed.sequence })
  if (!verification.ok) {
    throw new Error(`signature verification failed (${verification.code}): ${verification.reason}`)
  }
  console.log(`signature: VERIFIED (keyId ${meta.keyId}, fingerprint ${meta.fingerprint} = fleet trust root; expiry ${String(verification.manifest?.expiresAt)})`)
  console.log(`ratchet: artifact sequence ${String(meta.sequence)} = deployed ${String(deployed.sequence)} + 1 ✓`)

  // --- 5. the push plan (dry-run stops here) ------------------------------------
  const commitMessage = `catalog: sequence ${String(meta.sequence)} via GitHub run ${runId} (keyId ${meta.keyId}, fingerprint ${meta.fingerprint}, publish-local)`
  const planLines = [
    'push plan:',
    `  target:      https://${gitlabOrigin}/${project}.git → ${branch}`,
    `  file:        ${MANIFEST_FILE} (${String(manifestBytes.byteLength)} bytes, canonical single line, sha256 ${manifestSha256})`,
    `  sequence:    ${String(deployed.sequence)} → ${String(meta.sequence)}`,
    `  commit:      ${commitMessage}`,
    `  entries:     ${meta.entries.map((entry) => `${entry.packageName}@${entry.version}${entry.treeDigest === undefined ? '' : ` treeDigest ${entry.treeDigest.slice(0, 12)}…`}`).join(', ')}`,
  ]
  for (const line of planLines) console.log(line)
  if (dryRun) {
    console.log('dry-run: stopped before the clone — nothing was fetched from or pushed to GitLab beyond the read-only raw manifest')
    return
  }

  // --- 6. clone, overwrite byte-for-byte, commit, push ---------------------------
  const token = typeof flags.token === 'string' && flags.token.length > 0 ? flags.token : process.env.GITLAB_TOKEN
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('no GitLab token: pass --token <pat> or export GITLAB_TOKEN — refusing to publish (fail closed; nothing was pushed)')
  }
  const gitEnv = gitEnvironment(token, flags['insecure-tls'] === true)
  const cloneDir = mkdtempSync(join(tmpdir(), 'company-catalog-gitlab-'))
  tempDirs.push(cloneDir)
  try {
    const repositoryUrl = `https://${gitlabOrigin}/${project}.git`
    run('git', ['clone', '--quiet', '--depth', '1', repositoryUrl, cloneDir], { env: gitEnv, timeoutMs: 300_000 })
    console.log(`clone: ${repositoryUrl} (branch ${branch}, depth 1)`)
    writeFileSync(join(cloneDir, MANIFEST_FILE), manifestBytes)
    run('git', ['-C', cloneDir, 'add', MANIFEST_FILE], { env: gitEnv })
    const diff = spawnSync('git', ['-C', cloneDir, 'diff', '--cached', '--quiet'], { encoding: 'utf8', env: gitEnv })
    if (diff.status === 0) {
      throw new Error(
        `catalog-manifest.json is unchanged on ${branch} at sequence ${String(meta.sequence)} — impossible when the sequence ratchet advanced; ` +
        'inspect the GitLab repository before retrying (fail closed; nothing was pushed)',
      )
    }
    if (diff.status !== 1) {
      throw new Error(`git diff --cached failed with exit ${String(diff.status)}:\n${redact((diff.stderr ?? '').trim())}`)
    }
    run('git', ['-C', cloneDir, '-c', 'user.name=DSH catalog pipeline', '-c', 'user.email=catalog-pipeline@dsh-desktop.local', 'commit', '--quiet', '-m', commitMessage], { env: gitEnv })
    run('git', ['-C', cloneDir, 'push', 'origin', `HEAD:refs/heads/${branch}`], { env: gitEnv, timeoutMs: 300_000 })
    console.log(`push: ${MANIFEST_FILE} at sequence ${String(meta.sequence)} → ${branch} (commit: ${commitMessage})`)

    // --- 7. re-read the raw URL until it serves the pushed sequence ---------------
    const branchRawUrl = `https://${gitlabOrigin}/${project}/-/raw/${branch}/${MANIFEST_FILE}`
    const deadline = Date.now() + RECHECK_TIMEOUT_MS
    while (true) {
      let served
      try {
        served = await readDeployedSequence(`${branchRawUrl}?t=${String(Date.now())}`)
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(`post-push re-check failed: ${branchRawUrl} did not serve a readable manifest within 5 minutes (last error: ${error.message})`)
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, RECHECK_INTERVAL_MS))
        continue
      }
      if (served.sequence === meta.sequence) {
        console.log(`re-check: ${branchRawUrl} serves HTTP 200 with sequence ${String(served.sequence)} — deployment confirmed`)
        break
      }
      if (Date.now() >= deadline) {
        throw new Error(`post-push re-check failed: ${branchRawUrl} serves sequence ${String(served.sequence)}, expected ${String(meta.sequence)} within 5 minutes`)
      }
      console.log(`re-check: deployed sequence is ${String(served.sequence)}, waiting for ${String(meta.sequence)}...`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, RECHECK_INTERVAL_MS))
    }
  } finally {
    // tempDirs are removed by the top-level finally, however the run ends
  }

  console.log('')
  console.log('publish complete:')
  console.log(`  sequence:    ${String(meta.sequence)} (deployed ${String(deployed.sequence)} → ${String(meta.sequence)} on ${branch})`)
  console.log(`  keyId:       ${meta.keyId}`)
  console.log(`  fingerprint: ${meta.fingerprint}`)
  console.log(`  manifest:    ${String(manifestBytes.byteLength)} bytes, sha256 ${manifestSha256}`)
  console.log(`  source:      GitHub run ${runId}${meta.gitSha === undefined ? '' : ` (commit ${meta.gitSha})`}`)
  if (branch === 'master') {
    console.log(`  follow-up:   commit the GitHub-side state bump — tools/company-catalog/state/last-sequence.json → { "lastSequence": ${String(meta.sequence)} }`)
  } else {
    console.log(`  note:        pushed to the temp branch '${branch}', NOT master — delete it after the drill`)
  }
}

try {
  await main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
}
