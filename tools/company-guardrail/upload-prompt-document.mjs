/**
 * Intranet-side security-prompt document uploader (#046, publish side).
 *
 * The GitHub runner that signs and verifies the guardrail security-prompt
 * document cannot reach the intranet GitLab (the same network split the
 * catalog pipeline verified empirically), so publishing is split: the
 * workflow uploads the signed bytes as the `security-prompt-signed`
 * artifact and this script — run locally, on a machine that CAN reach the
 * intranet GitLab — performs the actual deployment of
 * security-prompt.json / security-prompt.beta.json:
 *
 *   1. shape: the file parses, carries a safe positive revision, and its
 *      base name matches the channel (beta → security-prompt.beta.json,
 *      stable → security-prompt.json — the exact URLs the desktop derives
 *      from the policy's stable manifest URL);
 *   2. trust: the signature re-verifies against the DESKTOP RELEASE
 *      POLICY trust roots through the same desktop-client verification
 *      seam the signer used (src/company-guardrail.ts — never a fork), so
 *      what ships is exactly what the fleet will accept;
 *   3. ratchet: the deployed document's revision must be strictly BELOW
 *      the new one (anti-rollback floor, mirroring publish-local.mjs's
 *      stance: no replaying, no rolling back — a template change is a new
 *      revision, always). A GET that cannot establish the deployed state
 *      (network failure, unexpected status, unparseable body) is a warning
 *      that requires --force to proceed — never a silent guess;
 *   4. push: the GitLab commits API (POST /api/v4/projects/<id>/repository/
 *      commits, one create/update file action carrying the exact canonical
 *      bytes base64-encoded — the document only ever moves through the API
 *      verbatim, never through a web editor or a reformatted commit);
 *   5. confirm: re-read the raw URL once and compare the sha256, then
 *      print the file URL and the commit sha.
 *
 * Every failure is fail-closed: nothing is pushed unless the document is
 * byte-intact, signature-valid under the fleet's trust roots, and strictly
 * ahead of the deployed revision. `--dry-run` runs steps 1-3 and prints
 * the push plan. The GitLab PAT comes from --gitlab-token or the
 * GITLAB_TOKEN environment variable and is sent only as the PRIVATE-TOKEN
 * request header. Honest caveat: --gitlab-token does put the PAT in this
 * script's own argv (visible to a local `ps` for the script's lifetime);
 * prefer the GITLAB_TOKEN environment variable, which keeps it out of
 * argv entirely.
 *
 * Plain Node (built-ins only) + the desktop verification seam. Usage:
 *   node tools/company-guardrail/upload-prompt-document.mjs \
 *     --file run/security-prompt.beta.json --channel beta [--dry-run]
 */

import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifyWithDesktopClient } from './lib/verify-seam.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')
/** The fleet's trust decision: release policy trustRoots the desktop pins. */
export const DEFAULT_POLICY_PATH = resolve(
  REPO_ROOT, 'dsh-plugin-desktop', 'src', 'policy', 'desktop-policy.release.json',
)

export const DEFAULT_GITLAB_ORIGIN = 'https://gitlab.s.dai.deloitte.cn'
/** URL-encoded project path — the commits API accepts the encoded path as the project id. */
export const DEFAULT_GITLAB_PROJECT = 'julu%2Fdsh-desktop-config'
/** The beta roster soaks here before stable; the branch mirrors the catalog config repo. */
const DEFAULT_BRANCH = 'master'

const CHANNEL_FILENAMES = { beta: 'security-prompt.beta.json', stable: 'security-prompt.json' }
/** Document byte bound (the client's COMPANY_SECURITY_PROMPT_MAX_BYTES). */
const MAX_DOCUMENT_BYTES = 64 * 1024
const DEPLOYED_TIMEOUT_MS = 15_000
const COMMIT_TIMEOUT_MS = 60_000

const USAGE = `Usage: node tools/company-guardrail/upload-prompt-document.mjs [options]

Intranet-side uploader: verify a signed security-prompt document against
the fleet's trust roots, ratchet-check its revision against the deployed
file, and push the exact canonical bytes to the GitLab config repository.

Options:
  --file <path>          Signed document to publish (required); its base
                         name must match the channel: beta →
                         security-prompt.beta.json, stable →
                         security-prompt.json
  --channel <beta|stable>
                         Which deployed file this is (default: stable)
  --gitlab-token <pat>   GitLab PAT (default: env GITLAB_TOKEN — preferred:
                         --gitlab-token exposes the PAT in this script's
                         argv)
  --origin <url>         GitLab origin (default: ${DEFAULT_GITLAB_ORIGIN})
  --project <path>       GitLab project path, URL-encoded or plain
                         (default: ${DEFAULT_GITLAB_PROJECT})
  --branch <name>        Branch to commit to (default: ${DEFAULT_BRANCH} —
                         the production line; use a temp branch only for
                         drills)
  --policy <path>        Trust-root policy file the fleet check pins
                         against (default: the desktop release policy in
                         this repo)
  --dry-run              verify + ratchet-check + print the push plan; stop
                         before the commit API call
  --force                proceed when the deployed revision could not be
                         read (network failure, unexpected status, or an
                         unparseable deployed body) — never bypasses the
                         anti-rollback refusal itself
  --insecure-tls         disable TLS verification for this run (pilot
                         parity); prefer NODE_EXTRA_CA_CERTS with the
                         corporate root instead
  --help                 show this help`

/** The deployed file name of one channel (mirrors the client constants). */
export function channelFilename(channel) {
  const filename = CHANNEL_FILENAMES[channel]
  if (filename === undefined) throw new Error(`--channel must be 'beta' or 'stable' (got '${String(channel)}')`)
  return filename
}

/** Minimal hand-rolled parser: `--flag value`, `--flag=value`, no positionals. */
function parseArgs(argv) {
  const flags = {}
  const valueFlags = new Set(['file', 'channel', 'gitlab-token', 'origin', 'project', 'branch', 'policy'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument '${argument}'`)
    const equals = argument.indexOf('=')
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
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

/** Decode a --project value that may arrive URL-encoded or plain; never throws. */
function decodeProjectPath(project) {
  try {
    return decodeURIComponent(project)
  } catch {
    return project
  }
}

/** Read a response body under the document byte bound; cancels on overrun. */
async function readBodyWithLimit(response, maxBytes, label) {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number.parseInt(declared, 10) > maxBytes) {
    throw new Error(`${label} declares ${declared} bytes, over the ${String(maxBytes)}-byte bound`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error(`${label} returned no body`)
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error(`${label} exceeds the ${String(maxBytes)}-byte bound`)
      }
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks)
}

/**
 * Run the whole upload flow. Returns `{ exitCode }` (0 = pushed or dry-run
 * clean, 1 = refused/failed) and prints its own report through the sinks —
 * importable by tests, which inject `fetchImpl` to script the deployed GET
 * and the commits API without any network.
 *
 * @param options flags-shaped inputs; `fetchImpl` defaults to the global
 * fetch, `log`/`warn` default to console.
 */
export async function runPromptDocumentUpload(options) {
  const log = options.log ?? ((line) => console.log(line))
  const warn = options.warn ?? ((line) => console.error(line))
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const channel = options.channel ?? 'stable'
  const filename = channelFilename(channel)
  const origin = options.origin ?? DEFAULT_GITLAB_ORIGIN
  const decodedProject = decodeProjectPath(options.project ?? DEFAULT_GITLAB_PROJECT)
  const branch = options.branch ?? DEFAULT_BRANCH
  const dryRun = options.dryRun === true
  const force = options.force === true
  if (options.insecureTls === true) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    warn('upload-prompt-document: WARNING — --insecure-tls: TLS verification disabled for this run (pilot parity); prefer NODE_EXTRA_CA_CERTS with the corporate root')
  }
  if (typeof options.file !== 'string' || options.file.length === 0) {
    warn('upload-prompt-document: --file is required (the signed document to publish)')
    return { exitCode: 1 }
  }

  // --- 1. shape: filename↔channel, parseable document, revision ≥ 1 --------
  if (basename(options.file) !== filename) {
    warn(
      `upload-prompt-document: --file's base name must be ${filename} for channel ${channel} (got '${basename(options.file)}') — ` +
      'the desktop derives the document URL from the policy manifest URL mechanically; a mismatched name would deploy to a URL no client fetches',
    )
    return { exitCode: 1 }
  }
  let stat
  try {
    stat = statSync(options.file)
  } catch (error) {
    warn(`upload-prompt-document: ${options.file} is not readable (${error.code ?? error.message})`)
    return { exitCode: 1 }
  }
  if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) {
    warn(`upload-prompt-document: ${options.file} is not a file within the ${String(MAX_DOCUMENT_BYTES)}-byte document bound`)
    return { exitCode: 1 }
  }
  const documentBytes = readFileSync(options.file)
  let document
  try {
    document = JSON.parse(documentBytes.toString('utf8'))
  } catch (error) {
    warn(`upload-prompt-document: ${options.file} is not valid JSON (${error.message})`)
    return { exitCode: 1 }
  }
  if (!Number.isSafeInteger(document?.revision) || document.revision < 1) {
    warn('upload-prompt-document: the document carries no safe positive integer revision — refusing to publish')
    return { exitCode: 1 }
  }
  const revision = document.revision

  // --- 2. trust: the fleet's own verifier, through the desktop seam --------
  const verdict = verifyWithDesktopClient(options.file, options.policyPath ?? DEFAULT_POLICY_PATH)
  if (verdict.ok !== true) {
    warn(
      `upload-prompt-document: the document does not verify against the fleet trust roots (${String(verdict.code)}: ${String(verdict.reason)}) — ` +
      'the fleet would reject these bytes; nothing was pushed',
    )
    return { exitCode: 1 }
  }
  log(`verify:   ${basename(options.file)} verified by the desktop client (keyId ${String(verdict.keyId)}, fingerprint ${String(verdict.fingerprint)}, revision ${String(verdict.revision)}, expires ${String(verdict.expiresAt)})`)

  // Review P3 (2026-09-17): the verifier seam re-reads the path itself, so a
  // writer racing this run could make the pushed bytes differ from the
  // verified bytes. Re-read and pin: the bytes that verify are exactly the
  // bytes that ship (the catalog's publish-local verifies the same in-memory
  // text it pushes; this closes the same window for a two-read tool).
  const rereadBytes = readFileSync(options.file)
  if (!rereadBytes.equals(documentBytes)) {
    warn('upload-prompt-document: the file changed between the initial read and the verification — refusing to push unverified bytes; retry the upload')
    return { exitCode: 1 }
  }

  // Review P3 (2026-09-17): the artifact carries a `<file>.meta.json`
  // sidecar from the signer; when it travels with the document, its channel
  // must agree with this run's --channel — file names alone make the
  // cross-channel mistake unlikely, this makes it structurally impossible
  // (the catalog uploader added the same guard for the same hazard).
  const metaPath = `${options.file}.meta.json`
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (meta?.channel !== undefined && meta.channel !== channel) {
        warn(`upload-prompt-document: the meta sidecar says channel ${String(meta.channel)} but this run targets ${channel} — refusing the cross-channel deploy`)
        return { exitCode: 1 }
      }
      if (meta?.revision !== undefined && meta.revision !== revision) {
        warn(`upload-prompt-document: the meta sidecar says revision ${String(meta.revision)} but the document carries ${String(revision)} — refusing the mismatched pair`)
        return { exitCode: 1 }
      }
    } catch (error) {
      warn(`upload-prompt-document: the meta sidecar ${basename(metaPath)} is unreadable (${error instanceof Error ? error.message : String(error)}) — refusing; re-download the artifact pair`)
      return { exitCode: 1 }
    }
  }

  // --- 3. ratchet: the deployed revision must be strictly below ------------
  const rawUrl = `${origin}/${decodedProject}/-/raw/${branch}/${filename}`
  let deployedRevision
  let deployedAction = 'update'
  let deployedKnown = false
  try {
    const response = await fetchImpl(rawUrl, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DEPLOYED_TIMEOUT_MS),
    })
    if (response.status === 404) {
      deployedKnown = true
      deployedAction = 'create'
      log(`ratchet:  ${rawUrl} answers 404 — first publish of the ${channel} document`)
    } else if (response.status === 200) {
      const body = await readBodyWithLimit(response, MAX_DOCUMENT_BYTES, `the deployed document at ${rawUrl}`)
      let deployed
      try {
        deployed = JSON.parse(body.toString('utf8'))
      } catch (error) {
        throw new Error(`the deployed document at ${rawUrl} is not valid JSON (${error.message})`)
      }
      if (!Number.isSafeInteger(deployed?.revision) || deployed.revision < 0) {
        throw new Error(`the deployed document at ${rawUrl} carries no safe revision — the deployed state cannot be established`)
      }
      deployedRevision = deployed.revision
      deployedKnown = true
      log(`ratchet:  ${rawUrl} serves revision ${String(deployedRevision)}; this document carries ${String(revision)}`)
    } else {
      throw new Error(`the deployed document at ${rawUrl} answered HTTP ${String(response.status)}`)
    }
  } catch (error) {
    if (!force) {
      warn(
        `upload-prompt-document: the deployed document could not be read (${error instanceof Error ? error.message : String(error)}) — ` +
        'the anti-rollback floor is unknown, so nothing was pushed; re-run when the raw URL is reachable, or pass --force to proceed without a floor check',
      )
      return { exitCode: 1 }
    }
    warn(`ratchet:  WARNING — the deployed document could not be read (${error instanceof Error ? error.message : String(error)}); --force acknowledged: proceeding without a floor check (the commit will use the update action)`)
  }
  if (deployedKnown && deployedRevision !== undefined && deployedRevision >= revision) {
    warn(
      `upload-prompt-document: anti-rollback refusal: the deployed ${channel} document is revision ${String(deployedRevision)} and this document carries ${String(revision)} — ` +
      `a publish must be strictly greater (deployed < new). ${deployedRevision === revision ? 'an identical revision is a replay; a template change needs a new revision' : 'rolling back would strand machines that cached the higher revision'}; ` +
      'nothing was pushed (this refusal is not bypassable with --force)',
    )
    return { exitCode: 1 }
  }

  const bytesSha256 = createHash('sha256').update(documentBytes).digest('hex')
  const commitMessage = `guardrail: security-prompt ${channel} revision ${String(revision)} (keyId ${String(verdict.keyId)}, fingerprint ${String(verdict.fingerprint)})`
  log('plan:')
  log(`  target:   ${origin}/${decodedProject}.git → ${branch}`)
  log(`  file:     ${filename} (${String(documentBytes.byteLength)} bytes, canonical single line, sha256 ${bytesSha256})`)
  log(`  revision: ${deployedKnown && deployedRevision !== undefined ? `${String(deployedRevision)} → ` : 'none → '}${String(revision)}${channel === 'beta' ? ' (beta channel; the stable security-prompt.json is not touched by this push)' : ''}`)
  log(`  commit:   ${commitMessage}`)
  if (dryRun) {
    log('dry-run:  stopped before the commit API — nothing was pushed')
    return { exitCode: 0 }
  }

  // --- 4. push through the GitLab commits API ------------------------------
  const token = typeof options.gitlabToken === 'string' && options.gitlabToken.length > 0
    ? options.gitlabToken
    : process.env.GITLAB_TOKEN
  if (typeof token !== 'string' || token.length === 0) {
    warn('upload-prompt-document: no GitLab token: pass --gitlab-token <pat> or export GITLAB_TOKEN — refusing to publish (fail closed; nothing was pushed)')
    return { exitCode: 1 }
  }
  const apiProjectId = encodeURIComponent(decodedProject)
  const commitsUrl = `${origin}/api/v4/projects/${apiProjectId}/repository/commits`
  const payload = {
    branch,
    commit_message: commitMessage,
    actions: [
      {
        action: deployedAction,
        file_path: filename,
        // base64 keeps the canonical bytes exact through the API (no eol
        // normalization, no editor reformatting can touch them).
        content: documentBytes.toString('base64'),
        encoding: 'base64',
      },
    ],
  }
  let commit
  try {
    const response = await fetchImpl(commitsUrl, {
      method: 'POST',
      headers: { 'private-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(COMMIT_TIMEOUT_MS),
    })
    const body = await readBodyWithLimit(response, 1_048_576, `the GitLab commits API at ${commitsUrl}`)
    if (!response.ok) {
      const detail = (() => { try { return JSON.parse(body.toString('utf8'))?.message ?? body.toString('utf8') } catch { return body.toString('utf8') } })()
      throw new Error(`the GitLab commits API answered HTTP ${String(response.status)}: ${String(detail).slice(0, 400)}`)
    }
    commit = JSON.parse(body.toString('utf8'))
  } catch (error) {
    warn(`upload-prompt-document: the commit failed (${error instanceof Error ? error.message : String(error)}) — fail closed; the deployed file was not changed by this run`)
    return { exitCode: 1 }
  }
  if (typeof commit?.id !== 'string' || commit.id.length === 0) {
    warn('upload-prompt-document: the GitLab commits API answered without a commit id — treating as failure; inspect the repository before retrying')
    return { exitCode: 1 }
  }
  log(`push:     ${filename} at revision ${String(revision)} → ${branch} (commit ${commit.id.slice(0, 12)})`)

  // --- 5. confirm: re-read the raw URL once and compare the exact bytes ----
  const blobUrl = `${origin}/${decodedProject}/-/blob/${branch}/${filename}`
  try {
    const served = await fetchImpl(`${rawUrl}?t=${String(Date.now())}`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(DEPLOYED_TIMEOUT_MS),
    })
    if (served.status === 200) {
      const servedBytes = await readBodyWithLimit(served, MAX_DOCUMENT_BYTES, `the deployed document at ${rawUrl}`)
      const servedSha256 = createHash('sha256').update(servedBytes).digest('hex')
      if (servedSha256 === bytesSha256) {
        log(`confirm:  ${rawUrl} serves the exact pushed bytes (sha256 ${servedSha256}) — deployment confirmed`)
      } else {
        // Review P3 (2026-09-17): parseable-but-different bytes so soon after
        // the push are NOT cache lag — the commit landed, so the raw URL
        // serves what the repo holds. That is a real divergence: fail the run
        // (pure transport failures below stay warnings, matching the
        // catalog's hard-failure stance on a served-but-different body).
        warn(`confirm:  ${rawUrl} serves different bytes after the push (sha256 ${servedSha256}, expected ${bytesSha256}) — the commit landed but the deployed file diverges; investigate before announcing`)
        return { exitCode: 1 }
      }
    } else {
      warn(`confirm:  ${rawUrl} answered HTTP ${String(served.status)} so soon after the push — GitLab raw caching may lag; re-check the URL before announcing`)
    }
  } catch (error) {
    warn(`confirm:  the post-push re-read failed (${error instanceof Error ? error.message : String(error)}) — the commit ${commit.id.slice(0, 12)} landed; re-check ${rawUrl} before announcing`)
  }

  log('')
  log('upload complete:')
  log(`  revision:   ${String(revision)} (${channel})`)
  log(`  keyId:      ${String(verdict.keyId)}`)
  log(`  fingerprint: ${String(verdict.fingerprint)}`)
  log(`  document:   ${String(documentBytes.byteLength)} bytes, sha256 ${bytesSha256}`)
  log(`  raw url:    ${rawUrl}`)
  log(`  blob url:   ${blobUrl}`)
  log(`  commit:     ${commit.id}`)
  return { exitCode: 0 }
}

/** Parse argv into runPromptDocumentUpload options; --help prints usage. */
function optionsFromFlags(flags) {
  return {
    file: flags.file,
    channel: flags.channel,
    gitlabToken: flags['gitlab-token'],
    origin: flags.origin,
    project: flags.project,
    branch: flags.branch,
    policyPath: flags.policy === undefined ? undefined : resolve(process.cwd(), flags.policy),
    dryRun: flags['dry-run'] === true,
    force: flags.force === true,
    insecureTls: flags['insecure-tls'] === true,
  }
}

async function cliMain() {
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`upload-prompt-document: ${error instanceof Error ? error.message : String(error)}`)
    console.error('')
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (flags.help === true) {
    console.log(USAGE)
    return
  }
  const { exitCode } = await runPromptDocumentUpload(optionsFromFlags(flags))
  process.exitCode = exitCode
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  await cliMain()
}
