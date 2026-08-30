/**
 * Intranet-side company catalog publisher.
 *
 * The GitHub runner that measures, signs, and verifies the catalog manifest
 * cannot reach the intranet GitLab (verified empirically), so publishing is
 * split: the workflow uploads the signed bytes as the `company-catalog-signed`
 * artifact and additionally mirrors them to the `catalog-artifacts` git
 * branch (some intranet environments cannot reach GitHub's artifact blob
 * storage — where `gh run download` fetches from — while GitHub's git
 * transport works fine). This script — run on a machine that can reach both
 * GitHub and the intranet — performs the actual deployment:
 *
 *   1. acquire the artifact pair: `gh run download` (default), the
 *      catalog-artifacts git branch (--from-git forces it; --run falls back
 *      to it automatically when the download fails), or --artifact-dir to
 *      replay a local copy laid out the same way. Transport is only
 *      transport — whichever channel delivered the bytes, they go through
 *      the identical sha256/signature/ratchet gauntlet below, so a tampered
 *      mirror branch fails closed at the same checks,
 *   2. integrity: the meta sidecar's manifestSha256 must match the bytes,
 *   3. trust: the signature must verify against the artifact's trust root,
 *      which must equal the deployment trust root pinned in the desktop
 *      policy (the fleet's actual trust decision) — and, when set, the
 *      COMPANY_CATALOG_KEY_FINGERPRINT env pin,
 *   4. ratchet: artifact.sequence must equal the deployed manifest's
 *      sequence + 1 (both values printed on mismatch — no skipping, no
 *      replaying, no double push), plus the fleet-upgrade gate: when an
 *      artifact entry carries an optional authority field (treeDigest /
 *      approvedBuilds) the deployed manifest's same entry does not, this is
 *      the first authoritative publish — clients built before the field
 *      existed verify with additionalProperties:false and would reject the
 *      ENTIRE manifest (the whole catalog goes dark on them), so publishing
 *      requires the explicit --confirm-fleet-upgraded acknowledgement that
 *      every client already runs a field-aware build (README "Fleet upgrade
 *      ordering (publication gate)"),
 *   5. clone the GitLab config repo, overwrite catalog-manifest.json with the
 *      artifact bytes verbatim (canonical single line; the GitLab web editor
 *      would reformat them — the manifest only ever moves through git push),
 *   6. commit (message carries sequence/fingerprint/run id) and push,
 *   7. re-read the raw URL until it serves HTTP 200 with both the pushed
 *      sequence and the exact pushed bytes (sha256(body) === the sidecar's
 *      manifestSha256; ≤ 5 minutes), then print the completion summary.
 *
 * Every failure is fail-closed: nothing is pushed unless the artifact is
 * present, byte-intact, signature-valid under the fleet's trust root, and
 * exactly one step ahead of what is deployed. `--dry-run` runs steps 1-4 and
 * prints the push plan, stopping before the clone. The GitLab PAT comes from
 * --token or the GITLAB_TOKEN environment variable and is passed to git
 * through GIT_CONFIG_* environment injection (an http.* extraheader) — it
 * never appears in a git subprocess's argv, in the clone's config, or in
 * error output. Honest caveat: --token does put the PAT in this script's own
 * argv (visible to a local `ps` for the script's lifetime); prefer the
 * GITLAB_TOKEN environment variable, which keeps it out of argv entirely.
 *
 * Plain Node (built-ins only) + `gh` and `git` on PATH. After a successful
 * master publish, commit the GitHub-side state bump:
 * tools/company-catalog/state/last-sequence.json → the published sequence.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMarketLibrary } from './lib/market.mjs'
import { fetchDeployedManifest, verifyManifestText } from './lib/pipeline.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
/** The fleet's trust decision: release policy trustRoots the desktop pins. */
const RELEASE_POLICY_PATH = resolve(REPO_ROOT, 'dsh-plugin-desktop', 'src', 'policy', 'desktop-policy.release.json')

const DEFAULT_GITHUB_REPO = 'LCorleone/deepseek-harness-desktop'
const DEFAULT_WORKFLOW = 'company-catalog-publish.yml'
const ARTIFACT_NAME = 'company-catalog-signed'
/** The branch the workflow mirrors each non-dry-run's signed pair to (`<run-id>/…`). */
const ARTIFACTS_BRANCH = 'catalog-artifacts'
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
  --run <id>            GitHub Actions run id (default: the latest run whose
                        ${ARTIFACT_NAME} artifact is downloadable in --repo,
                        resolved through the GitHub API; fallback: the latest
                        successful ${DEFAULT_WORKFLOW} run — which may be a
                        dry-run with no artifact at all)
  --repo <owner/name>   GitHub repository (default: ${DEFAULT_GITHUB_REPO})
  --artifact-dir <dir>  skip gh: publish from a local directory already laid
                        out like the download (${MANIFEST_FILE} + ${META_FILE})
                        — offline replay/testing
  --from-git <run-id>   skip gh: shallow-fetch the ${ARTIFACTS_BRANCH} git
                        branch and read <run-id>/ from it (the workflow
                        mirrors every non-dry-run's signed pair there for
                        environments that cannot reach GitHub's artifact
                        blob storage; --run falls back to this automatically)
  --branch <name>       GitLab branch to push (default: master — the
                        production line; use a temp branch only for drills)
  --token <pat>         GitLab PAT (default: env GITLAB_TOKEN — preferred:
                        --token exposes the PAT in this script's argv)
  --gitlab <origin>     GitLab origin (default: ${DEFAULT_GITLAB_ORIGIN})
  --project <path>      GitLab project (default: ${DEFAULT_GITLAB_PROJECT})
  --confirm-fleet-upgraded
                        acknowledge the fleet-upgrade gate: every client
                        already runs a build that knows the optional
                        authority fields — required when the artifact carries
                        a treeDigest/approvedBuilds the deployed manifest's
                        same entry does not (older clients reject the entire
                        manifest; see the README publication gate)
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
  const valueFlags = new Set(['run', 'repo', 'artifact-dir', 'from-git', 'branch', 'token', 'gitlab', 'project'])
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
    encoding: options.buffer === true ? 'buffer' : 'utf8',
    env: options.env ?? process.env,
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 120_000,
  })
  if (result.error !== undefined) {
    throw new Error(`${command} could not be executed (${result.error.message}) — is it on PATH?`)
  }
  if (result.status !== 0) {
    const raw = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `exit ${String(result.status)}`
    const detail = typeof raw === 'string' ? raw : raw.toString('utf8')
    throw new Error(`${command} ${args.join(' ')} failed:\n${redact(detail)}`)
  }
  return result.stdout
}

/**
 * The PAT/header actually in use, kept at module scope so redact() can strip
 * them: they are only ever injected into git subprocess environments (never
 * into this process's own environment), so process.env would always miss
 * them — redact() must reference the values that were really used.
 */
const injectedSecrets = { token: undefined, header: undefined }

/** Strip anything shaped like the PAT or its base64 header from git output. */
function redact(text) {
  let cleaned = text
  const token = injectedSecrets.token
  if (token !== undefined && token.length > 0) cleaned = cleaned.split(token).join('«token»')
  const header = injectedSecrets.header
  if (header !== undefined && header.length > 0) cleaned = cleaned.split(header).join('«auth-header»')
  return cleaned
}

/** git env with the PAT injected through GIT_CONFIG_* (never argv/config). */
function gitEnvironment(token, insecureTls = false) {
  const basic = Buffer.from(`oauth2:${token}`, 'utf8').toString('base64')
  const header = `Authorization: Basic ${basic}`
  injectedSecrets.token = token
  injectedSecrets.header = header
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: insecureTls ? '2' : '1',
    GIT_CONFIG_KEY_0: `http.https://${gitlabOrigin}/.extraheader`,
    GIT_CONFIG_VALUE_0: header,
    ...(insecureTls ? { GIT_CONFIG_KEY_1: 'http.sslVerify', GIT_CONFIG_VALUE_1: 'false' } : {}),
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

/**
 * Pick the run to publish when --run is omitted. The GitHub artifact-listing
 * API names exactly the runs that produced a company-catalog-signed artifact —
 * the only runs worth publishing from, because dry-run (the workflow's
 * default input) uploads nothing. Only when the API cannot be reached does
 * the fallback select the latest successful workflow run, which may be a
 * dry-run (the download failure then spells that out). Returns
 * { runId, source: 'artifact-api' | 'run-list' }.
 */
function resolveDefaultRunId(repo) {
  let raw
  try {
    raw = run('gh', ['api', `repos/${repo}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=20`])
  } catch (error) {
    console.log(`run: the GitHub artifact-listing API is unavailable (${(error instanceof Error ? error.message : String(error)).split('\n')[0]}) — falling back to the latest successful ${DEFAULT_WORKFLOW} run (may be a dry-run)`)
    return latestSuccessfulRun(repo)
  }
  let listing
  try {
    listing = JSON.parse(raw)
  } catch (error) {
    throw new Error(`the GitHub artifact-listing API returned a body that is not JSON (${error.message})`)
  }
  const artifacts = Array.isArray(listing?.artifacts) ? listing.artifacts : []
  const usable = artifacts
    .filter((artifact) => artifact?.expired !== true && Number.isSafeInteger(artifact?.workflow_run?.id))
    .sort((a, b) => Number(b.id) - Number(a.id))
  if (usable.length === 0) {
    throw new Error(
      `no downloadable ${ARTIFACT_NAME} artifact exists in ${repo} — the artifact-listing API answered but listed none; ` +
      `every ${DEFAULT_WORKFLOW} run so far was probably a dry-run (dry-run is the workflow's default input and uploads no artifact). ` +
      'Re-run the workflow with dry-run unchecked, or pass --run <id>',
    )
  }
  const artifact = usable[0]
  const runId = String(artifact.workflow_run.id)
  console.log(`run: newest ${ARTIFACT_NAME} artifact (id ${String(artifact.id)}, created ${String(artifact.created_at)}) belongs to run ${runId} in ${repo}`)
  return { runId, source: 'artifact-api' }
}

/** The pre-API fallback: the latest successful workflow run, whatever it uploaded. */
function latestSuccessfulRun(repo) {
  const listing = JSON.parse(run('gh', ['run', 'list', '--workflow', DEFAULT_WORKFLOW, '--repo', repo, '--status', 'success', '--limit', '1', '--json', 'databaseId,displayTitle']))
  if (!Array.isArray(listing) || listing.length === 0) {
    throw new Error(`no successful run of ${DEFAULT_WORKFLOW} found in ${repo} — run the workflow with dry-run unchecked first, or pass --run <id>`)
  }
  const runId = String(listing[0].databaseId)
  console.log(`run: latest successful ${DEFAULT_WORKFLOW} run in ${repo}: ${runId} (${listing[0].displayTitle})`)
  return { runId, source: 'run-list' }
}

/** Byte caps the artifact path already enforces, applied before writing mirror blobs. */
const MIRROR_FILE_CAPS = { [MANIFEST_FILE]: MANIFEST_MAX_BYTES, [META_FILE]: 65_536 }

/**
 * The most informative single line of a run() failure: the message starts
 * with the command echo (`gh … failed:`) and carries the real reason on the
 * next line — log lines and combined errors should quote that reason.
 */
function failureReason(error) {
  const lines = (error instanceof Error ? error.message : String(error)).split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  return lines[lines.length > 1 ? 1 : 0] ?? String(error)
}

/**
 * Acquire the artifact pair from the catalog-artifacts git branch: the
 * workflow mirrors every non-dry-run's signed catalog-manifest.json +
 * publish-meta.json to `<run-id>/` on that branch, so environments that
 * cannot reach GitHub's artifact blob storage (where `gh run download`
 * fetches from) but can reach GitHub over git still publish hands-free.
 * Transport is only transport —
 * the bytes face the identical sha256 + signature + ratchet gauntlet, so a
 * tampered branch fails closed exactly like a tampered artifact. Files are
 * read as raw blobs (`git show`) so no local eol/smudge config can reformat
 * them, each under its byte cap before touching disk. Returns the directory
 * carrying the two files, laid out like the artifact download.
 */
function fetchArtifactsFromGitBranch(repo, runId) {
  const repositoryUrl = `https://github.com/${repo}.git`
  const branchDir = mkdtempSync(join(tmpdir(), 'company-catalog-git-'))
  tempDirs.push(branchDir)
  try {
    run('git', ['clone', '--quiet', '--depth', '1', '--branch', ARTIFACTS_BRANCH, repositoryUrl, branchDir], { timeoutMs: 300_000 })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.includes('not found')) {
      throw new Error(
        `the ${ARTIFACTS_BRANCH} branch does not exist in ${repositoryUrl} yet — the workflow creates it when a non-dry-run mirrors ` +
        'its signed pair (the mirror step is auxiliary; runs before it existed never landed there)',
      )
    }
    throw new Error(`${failureReason(error)} — the ${ARTIFACTS_BRANCH} git mirror of ${repositoryUrl} is unreachable`)
  }
  const outDir = join(branchDir, 'files')
  mkdirSync(outDir, { recursive: true })
  for (const file of [MANIFEST_FILE, META_FILE]) {
    const blobRef = `HEAD:${runId}/${file}`
    let sizeBytes
    try {
      sizeBytes = Number.parseInt(run('git', ['-C', branchDir, 'cat-file', '-s', blobRef]).toString('utf8').trim(), 10)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.includes('does not exist')) {
        throw new Error(
          `run ${runId} has no ${file} on the ${ARTIFACTS_BRANCH} branch — the mirror carries only runs of non-dry-run workflows ` +
          'since the mirror step existed; pass the run id of such a run, or use --artifact-dir',
        )
      }
      throw error
    }
    const cap = MIRROR_FILE_CAPS[file]
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error(`git cat-file -s ${blobRef} did not report a byte size — refusing to guess`)
    }
    if (sizeBytes > cap) {
      throw new Error(`${file} on the ${ARTIFACTS_BRANCH} branch is ${String(sizeBytes)} bytes, over the ${String(cap)}-byte bound`)
    }
    // Raw blob read (buffer, never decoded): the sha256 integrity check must
    // see the exact committed bytes.
    const blob = run('git', ['-C', branchDir, 'show', blobRef], { buffer: true })
    if (blob.byteLength !== sizeBytes) {
      throw new Error(`${file} on the ${ARTIFACTS_BRANCH} branch: cat-file reported ${String(sizeBytes)} bytes but the blob read ${String(blob.byteLength)} — refusing mismatched reads`)
    }
    writeFileSync(join(outDir, file), blob)
  }
  return outDir
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
  /** How the bytes arrived — printed in the completion summary's source line. */
  let acquireChannel
  if (typeof flags['artifact-dir'] === 'string') {
    if (flags['from-git'] !== undefined) throw new Error('--artifact-dir and --from-git are alternative acquisition modes — pass one')
    artifactDir = resolve(process.cwd(), flags['artifact-dir'])
    runId = 'local-artifact'
    acquireChannel = `local directory (--artifact-dir)`
    console.log(`artifact: local directory ${artifactDir} (--artifact-dir — skipping gh)`)
  } else if (typeof flags['from-git'] === 'string') {
    if (flags.run !== undefined) throw new Error('--run and --from-git are alternative acquisition modes — pass one (--from-git already names the run)')
    if (!/^[0-9]+$/.test(flags['from-git'])) throw new Error(`--from-git must be a numeric GitHub Actions run id (got '${flags['from-git']}')`)
    runId = flags['from-git']
    run('git', ['--version'])
    artifactDir = fetchArtifactsFromGitBranch(repo, runId)
    acquireChannel = `${ARTIFACTS_BRANCH} git branch (--from-git)`
    console.log(`artifact: fetched run ${runId} from the ${ARTIFACTS_BRANCH} branch of ${repo} (--from-git — skipping gh)`)
  } else {
    run('gh', ['--version'])
    let runSource
    if (typeof flags.run === 'string' && /^[0-9]+$/.test(flags.run)) {
      runId = flags.run
      runSource = 'explicit'
    } else {
      if (flags.run !== undefined) throw new Error(`--run must be a numeric GitHub Actions run id (got '${flags.run}')`)
      ;({ runId, source: runSource } = resolveDefaultRunId(repo))
    }
    artifactDir = mkdtempSync(join(tmpdir(), 'company-catalog-artifact-'))
    tempDirs.push(artifactDir)
    try {
      run('gh', ['run', 'download', runId, '--repo', repo, '--name', ARTIFACT_NAME, '--dir', artifactDir])
      acquireChannel = `${ARTIFACT_NAME} artifact download`
      console.log(`artifact: downloaded ${ARTIFACT_NAME} from run ${runId} → ${artifactDir}`)
    } catch (downloadError) {
      // gh run download fetches from GitHub's Azure blob storage, which some
      // intranet environments cannot reach at all (TLS handshake timeout) —
      // while GitHub's git transport works. The workflow mirrors every
      // signed pair to the catalog-artifacts branch for exactly this case:
      // fall back to it (same run id), then report both channels if it also
      // fails. The artifact stays authoritative; the fallback changes only
      // the transport, never any downstream check.
      console.log(`artifact: gh run download failed (${failureReason(downloadError)}) — falling back to the ${ARTIFACTS_BRANCH} git branch (same run ${runId})`)
      try {
        artifactDir = fetchArtifactsFromGitBranch(repo, runId)
      } catch (mirrorError) {
        const dryRunHint = runSource === 'run-list'
          ? ` — note: the latest successful ${DEFAULT_WORKFLOW} run may be a dry-run (dry-run is the workflow's default input and uploads no artifact): pick a run that produced the ${ARTIFACT_NAME} artifact and pass --run <id>`
          : ''
        throw new Error(
          `artifact acquisition failed on both channels: gh run download (${failureReason(downloadError)}) and the ${ARTIFACTS_BRANCH} git branch (${failureReason(mirrorError)})${dryRunHint}`,
        )
      }
      acquireChannel = `${ARTIFACTS_BRANCH} git branch (automatic fallback after gh run download failed)`
      console.log(`artifact: fallback accepted — fetched run ${runId} from the ${ARTIFACTS_BRANCH} branch of ${repo}`)
    }
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
  const deployed = await fetchDeployedManifest(masterRawUrl)
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

  // --- 4b. fleet-upgrade gate: the first authoritative publish of an optional
  // authority field must be an acknowledged one. Clients built before the
  // field existed verify with additionalProperties:false — one unknown key
  // makes them reject the ENTIRE manifest, so pushing now would black out
  // the whole catalog (and every installed plugin from it) on every machine
  // not yet upgraded. The README pins the order: upgrade the fleet → measure
  // → re-sign with a higher sequence → push; the flag is the operator's
  // assertion that step one is done. "Fleet upgrade ordering (publication
  // gate)" / 「fleet 升级顺序（发布门禁）」 in tools/company-catalog/README.md.
  const deployedPackages = Array.isArray(deployed.manifest.packages) ? deployed.manifest.packages : []
  const gatedEntries = packages.flatMap((signed) => {
    const newly = ['treeDigest', 'approvedBuilds'].filter((field) => signed[field] !== undefined)
    if (newly.length === 0) return []
    const current = deployedPackages.find((candidate) => candidate?.packageName === signed.packageName && candidate?.version === signed.version)
    const firsts = current === undefined ? newly : newly.filter((field) => current[field] === undefined)
    return firsts.length === 0 ? [] : [`${signed.packageName}@${signed.version} (+${firsts.join(', ')})`]
  })
  if (gatedEntries.length > 0 && flags['confirm-fleet-upgraded'] !== true) {
    fail(
      `fleet-upgrade gate: this artifact would be the first authoritative publish of ${gatedEntries.join('; ')} — ` +
      `the deployed manifest at ${masterRawUrl} does not carry those fields on the same entries. ` +
      'Older clients verify with additionalProperties:false and reject the ENTIRE manifest on a single unknown key: pushing now ' +
      'blacks out the whole catalog on every machine not yet upgraded to a field-aware build. ' +
      'The publication order is fixed (tools/company-catalog/README.md, "Fleet upgrade ordering (publication gate)" / 「fleet 升级顺序（发布门禁）」): ' +
      '(1) upgrade the whole fleet to builds that know treeDigest/approvedBuilds, (2) only then publish. ' +
      'Re-run with --confirm-fleet-upgraded once every client is upgraded to acknowledge the gate.',
    )
    return
  }
  if (gatedEntries.length > 0) {
    console.log(`fleet gate: --confirm-fleet-upgraded acknowledged for ${gatedEntries.join('; ')} — every client must already run a field-aware build (README publication gate)`)
  }

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

    // --- 7. re-read the raw URL until it serves the pushed bytes exactly --------
    // Sequence alone is not deployment confirmation: only sha256(body) ===
    // the sidecar's manifestSha256 proves GitLab serves the exact canonical
    // bytes this artifact was verified against (a reformatted or partial
    // serve must keep failing, not pass on the matching sequence).
    const branchRawUrl = `https://${gitlabOrigin}/${project}/-/raw/${branch}/${MANIFEST_FILE}`
    const deadline = Date.now() + RECHECK_TIMEOUT_MS
    while (true) {
      let served
      try {
        served = await fetchDeployedManifest(`${branchRawUrl}?t=${String(Date.now())}`)
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(`post-push re-check failed: ${branchRawUrl} did not serve a readable manifest within 5 minutes (last error: ${error.message})`)
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, RECHECK_INTERVAL_MS))
        continue
      }
      const servedSha256 = createHash('sha256').update(Buffer.from(served.text, 'utf8')).digest('hex')
      if (served.sequence === meta.sequence && servedSha256 === manifestSha256) {
        console.log(`re-check: ${branchRawUrl} serves HTTP 200 with sequence ${String(served.sequence)} and the exact pushed bytes (sha256 ${servedSha256} = ${META_FILE} manifestSha256) — deployment confirmed`)
        break
      }
      if (Date.now() >= deadline) {
        throw new Error(`post-push re-check failed: ${branchRawUrl} serves sequence ${String(served.sequence)} (expected ${String(meta.sequence)}) hashing to ${servedSha256} (expected ${manifestSha256}) — not the pushed bytes, within 5 minutes`)
      }
      console.log(`re-check: served sequence ${String(served.sequence)}, sha256 ${servedSha256.slice(0, 12)}… — waiting for sequence ${String(meta.sequence)} with sha256 ${manifestSha256.slice(0, 12)}…`)
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
  console.log(`  source:      GitHub run ${runId} via ${acquireChannel}${meta.gitSha === undefined ? '' : ` (commit ${meta.gitSha})`}`)
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
