/**
 * Owner-side acceptance of a verified staging handoff (`cli.mjs
 * accept-handoff`): the one command that turns a verify-handoff PASS into
 * allowlist state plus its commit — the manual "paste the snippet after
 * review" step, minus the hand-editing.
 *
 * The receipt pair verify-handoff leaves in the submission directory —
 * verdict.md (the human summary, the README's promise) and verdict.json
 * (the machine-readable receipt) — is the submission-side input, but never
 * the trust anchor:
 *
 *   0 local record   the very first gate: the sha256 of the submission's
 *                    verdict.json must equal the fingerprint a
 *                    verify-handoff run on THIS machine recorded in
 *                    out/verdict-receipts/<name>-<version>.json
 *                    (gitignored — the record never rides an MR), with the
 *                    same generatedAt. A pre-forged receipt pair + matching
 *                    tgz — however internally consistent — has no local
 *                    record and refuses here, and a verdict.json swapped
 *                    after the local verify run (the verify→accept TOCTOU
 *                    window) no longer hashes to the recorded fingerprint
 *   1 receipt      both files must exist, record PASS, and agree with each
 *                  other (same header, same checked timestamp) — anything
 *                  else fail-closes with a pointer back to verify-handoff
 *   2 freshness    the tgz is re-fingerprinted (sha256 + sizeBytes) and
 *                  must equal the receipt's record — a submission that
 *                  changed after verification is refused outright
 *   3 entry        the receipt's allowlist entry is revalidated through
 *                  validateAllowlistEntry and cross-checked against the
 *                  receipt's own identity/digest; a missing repository pin
 *                  must come from --repository (fail-closed when neither
 *                  the package nor the flag provides one)
 *   4 merge        one ACTIVE version per plugin (the catalog's existing
 *                  shape — every entry in today's allowlist is the single
 *                  active version of its plugin): the entry REPLACES the
 *                  package's active entries; revoked entries stay verbatim
 *                  (revocation is a state, not a deletion — the signed
 *                  audit trail), and a same name@version collision is the
 *                  immutability red line: refused on digest disagreement
 *                  and on any attempt to un-revoke. Idempotency is a
 *                  canonical (key-order-insensitive) deep comparison, so a
 *                  same-content replay of a hand-written entry whose key
 *                  order differs from the normalizer's is a no-op — never a
 *                  pure key-reordering commit; when a write IS needed it
 *                  stays minimal: untouched entries keep their reviewed
 *                  spelling, and the applied entry inherits the key order
 *                  of the entry it replaces. --keep-both is deliberately
 *                  absent: the catalog has never carried two active
 *                  versions of one plugin (YAGNI).
 *   5 commit       `git add` of the allowlist file ONLY — refused up front
 *                  while the allowlist carries uncommitted changes (the
 *                  acceptance commit must carry exactly the accepted entry,
 *                  never swept-along local edits) — then a
 *                  pathspec-limited commit `catalog: accept <name>@<version>
 *                  (staging handoff)`; a missing git (CI without a
 *                  checkout) is fail-closed, and a git failure after the
 *                  write restores the previous bytes — an entry is never
 *                  applied without its commit. --dry-run prints the entry
 *                  and the diff and touches nothing.
 *
 * Never signs, never publishes, never pushes: measure-and-publish (beta
 * first) and publish-local stay the two steps it prints at the end.
 *
 * Plain Node built-ins; offline; Windows-safe path handling (join/resolve
 * everywhere, POSIX spelling only at the git pathspec boundary).
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  CATALOG_ORIGIN_ENV,
  entryKey,
  loadAllowlist,
  normalizeRepositoryUrl,
  PACKAGE_NAME_PATTERN,
  STABLE_VERSION_PATTERN,
  validateAllowlistEntry,
} from './allowlist.mjs'
import { REPO_ROOT, TOOL_DIR } from './tarball.mjs'
import { DEFAULT_VERDICT_RECEIPTS_DIR, verdictReceiptRecordPath } from './verify-handoff.mjs'

/** tools/company-catalog — lib/tarball.mjs's TOOL_DIR is lib/ itself. */
const CATALOG_DIR = resolve(TOOL_DIR, '..')

/** The receipt pair, as verify-handoff writes it into the submission directory. */
export const VERDICT_MD_FILENAME = 'verdict.md'
export const VERDICT_JSON_FILENAME = 'verdict.json'
/** How the markdown half of a receipt must open (renderPass/renderFailVerdict's pinned header). */
const PASS_HEADER = '# verify-handoff · PASS'
const FAIL_HEADER = '# verify-handoff · FAIL'
const HEX_64 = /^[0-9a-f]{64}$/u
/** Git child bound — a hung git must not hang the acceptance. */
const GIT_TIMEOUT_MS = 120_000

/** The commit message this command pins (read back in git history and reviews). */
export const commitMessageFor = (entry) => `catalog: accept ${entry.packageName}@${entry.version} (staging handoff)`

/** A fail-closed refusal: names the reason; nothing was applied. */
class AcceptanceRefusal extends Error {
  constructor(message) {
    super(message)
    this.name = 'AcceptanceRefusal'
  }
}

const refuse = (message) => {
  throw new AcceptanceRefusal(message)
}

/**
 * Rendering-boundary escape for receipt-derived values that land in refusal
 * messages (a forged `\n[ok] …` inside a verdict.json field may only ever
 * render inline, never as a line of its own) — same rule verify-handoff
 * applies to verdict.md and the step log.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu
const esc = (value) => String(value).replace(CONTROL_CHARACTERS, '\uFFFD')

/**
 * The real git channel: every call output-captured and time-bounded.
 * Returns `{status, stdout, stderr, error?}` — `status:null` means git
 * could not run at all (ENOENT, timeout): the fail-closed CI case.
 */
export function spawnGitRunner(arguments_, { cwd, env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const probe = spawnSync('git', arguments_, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
  if (probe.error !== undefined) {
    return { status: null, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '', error: probe.error.message }
  }
  if (probe.status === null) {
    return { status: null, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '', error: `timed out after ${String(Math.round(timeoutMs / 1000))}s` }
  }
  return { status: probe.status, stdout: probe.stdout ?? '', stderr: probe.stderr ?? '' }
}

/** One git call that must succeed, or the acceptance refuses with git's own tail output. */
function runGit(git, arguments_, { cwd, env, what }) {
  const result = git(arguments_, { cwd, env })
  if (result.status !== 0) {
    const tail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n').slice(-3).join(' | ')
    refuse(`${what} failed (${result.status === null ? `git could not run: ${esc(result.error ?? 'no diagnostics')}` : `git exited ${String(result.status)}`}${tail.length > 0 ? `: ${esc(tail)}` : ''})`)
  }
  return (result.stdout ?? '').trim()
}

// ---------------------------------------------------------------------------
// Step 0: the local receipt record — the trust anchor
// ---------------------------------------------------------------------------

/**
 * The gate before every other gate: a PASS verdict.json is only acceptable
 * when its exact bytes were issued by a verify-handoff run on THIS machine —
 * the recomputed sha256 must equal the fingerprint that run recorded in the
 * owner-local channel (out/verdict-receipts/, gitignored: the record never
 * rides an MR), with the same generatedAt. A pre-forged receipt pair plus a
 * matching tgz is exactly what a forged submission would carry — internally
 * consistent, self-agreeing, and with no local record; and a verdict.json
 * swapped for another run's after the local verify (the verify→accept
 * TOCTOU window) no longer hashes to the recorded fingerprint.
 *
 * Missing, unparseable, or FAIL receipts fall through to the step-1
 * classification, which refuses with the more specific message (the gate
 * protects the accept path — PASS receipts — and nothing else needs it).
 */
function checkLocalReceiptRecord({ submissionDir, receiptsDir }) {
  let bytes
  try {
    bytes = readFileSync(join(submissionDir, VERDICT_JSON_FILENAME))
  } catch {
    return // no verdict.json — readVerdictReceipt classifies it
  }
  let receipt
  try {
    receipt = JSON.parse(bytes.toString('utf8'))
  } catch {
    return // invalid JSON — readVerdictReceipt classifies it
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.ok !== true) {
    return // a FAIL receipt — validatePassReceipt refuses it naming the step
  }
  const identity = receipt.identity
  if (identity === null || typeof identity !== 'object' || typeof identity.packageName !== 'string' || typeof identity.version !== 'string'
    || !PACKAGE_NAME_PATTERN.test(identity.packageName) || !STABLE_VERSION_PATTERN.test(identity.version)) {
    return // malformed identity — validatePassReceipt names the exact problem
  }
  const pointer = 'receipt not issued by a local verify-handoff run — run verify-handoff on this machine first'
  const fingerprint = createHash('sha256').update(bytes).digest('hex')
  let record
  try {
    record = JSON.parse(readFileSync(verdictReceiptRecordPath(receiptsDir, identity.packageName, identity.version), 'utf8'))
  } catch {
    refuse(`${esc(identity.packageName)}@${esc(identity.version)}: ${pointer} (no receipt record in ${receiptsDir} — the submitter-side verdict files are exactly what a forged submission would carry)`)
  }
  if (typeof record.fingerprint !== 'string' || !HEX_64.test(record.fingerprint)) {
    refuse(`${esc(identity.packageName)}@${esc(identity.version)}: ${pointer} (the local receipt record is unusable — re-run verify-handoff to reissue it)`)
  }
  if (record.fingerprint !== fingerprint) {
    refuse(`${esc(identity.packageName)}@${esc(identity.version)}: ${pointer} (verdict.json hashes to ${fingerprint} but the local record pins ${record.fingerprint} — the file is not the one the local verify run wrote: it changed after verification, or came from another run)`)
  }
  if (record.generatedAt !== receipt.generatedAt) {
    refuse(`${esc(identity.packageName)}@${esc(identity.version)}: ${pointer} (verdict.json records generatedAt '${esc(receipt.generatedAt)}' but the local record pins '${esc(String(record.generatedAt))}' — the two do not come from the same local run)`)
  }
}

// ---------------------------------------------------------------------------
// Step 1: the receipt pair
// ---------------------------------------------------------------------------

/** Read verdict.json + verdict.md, classifying every missing shape fail-closed. */
function readVerdictReceipt(submissionDir) {
  const receiptPath = join(submissionDir, VERDICT_JSON_FILENAME)
  const verdictPath = join(submissionDir, VERDICT_MD_FILENAME)
  let receiptText = null
  let verdictText = null
  try {
    receiptText = readFileSync(receiptPath, 'utf8')
  } catch {
    // Classified below — against the markdown half, when it exists.
  }
  try {
    verdictText = readFileSync(verdictPath, 'utf8')
  } catch {
    // Classified below.
  }
  if (receiptText === null) {
    if (verdictText === null) {
      refuse(`no verdict in ${submissionDir} — run verify-handoff on the submission first; accept-handoff only applies a PASS verdict`)
    }
    if (verdictText.includes(FAIL_HEADER)) {
      refuse(`the recorded verdict is FAIL — fix the submission (bump the version when content changed), re-run verify-handoff, then accept the fresh verdict`)
    }
    refuse(`${VERDICT_JSON_FILENAME} is missing while ${VERDICT_MD_FILENAME} says PASS — the verdict predates the machine-readable receipt; re-run verify-handoff (the two files are written by the same run)`)
  }
  let receipt
  try {
    receipt = JSON.parse(receiptText)
  } catch (error) {
    refuse(`${receiptPath} is not valid JSON (${esc(error.message)}) — re-run verify-handoff and accept the fresh receipt`)
  }
  return { receipt, receiptPath, verdictText, verdictPath }
}

/** The PASS receipt's mandatory shape — anything else is a stale or forged receipt. */
function validatePassReceipt(receipt, receiptPath) {
  const at = `${receiptPath}`
  const problems = []
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    refuse(`${at} must be a JSON object — re-run verify-handoff and accept the fresh receipt`)
  }
  if (receipt.ok !== true) {
    const failed = receipt.failedStep
    const where = failed !== null && typeof failed === 'object' && typeof failed.step === 'string'
      ? ` (${String(failed.index)}/10 ${esc(failed.step)})`
      : ''
    refuse(`the recorded verdict is FAIL${where} — fix the submission (bump the version when content changed), re-run verify-handoff, then accept the fresh verdict`)
  }
  const identity = receipt.identity
  if (identity === null || typeof identity !== 'object' || typeof identity.packageName !== 'string' || typeof identity.version !== 'string') {
    problems.push('identity must be {packageName, version} strings')
  }
  const artifact = receipt.artifact
  if (artifact === null || typeof artifact !== 'object' || typeof artifact.file !== 'string' || typeof artifact.sha256 !== 'string' || !HEX_64.test(artifact.sha256) || Number.isSafeInteger(artifact.sizeBytes) !== true || artifact.sizeBytes <= 0) {
    problems.push('artifact must be {file, sha256 (64 lowercase hex), sizeBytes (positive integer)}')
  }
  if (typeof receipt.treeDigest !== 'string' || !HEX_64.test(receipt.treeDigest)) {
    problems.push('treeDigest must be 64 lowercase hex characters')
  }
  if (receipt.allowlistEntry === null || typeof receipt.allowlistEntry !== 'object' || Array.isArray(receipt.allowlistEntry)) {
    problems.push('allowlistEntry must be an object')
  }
  if (typeof receipt.generatedAt !== 'string' || receipt.generatedAt.length === 0) {
    problems.push('generatedAt must be a non-empty string')
  }
  if (problems.length > 0) {
    refuse(`${at} is not a usable PASS receipt (${problems.join('; ')}) — re-run verify-handoff and accept the fresh receipt`)
  }
}

/** The two halves must come from the same PASS run (header + shared timestamp). */
function checkReceiptAgreement({ verdictText, receipt, verdictPath }) {
  if (verdictText === null) {
    refuse(`${verdictPath} is missing while ${VERDICT_JSON_FILENAME} exists — the two are written by the same verify-handoff run; re-run verify-handoff`)
  }
  const header = verdictText.split('\n')[0]?.trim()
  if (header !== PASS_HEADER) {
    refuse(`${VERDICT_MD_FILENAME} opens with '${esc(header)}' but ${VERDICT_JSON_FILENAME} records ok:true — the two verdict files disagree; re-run verify-handoff`)
  }
  if (!verdictText.includes(receipt.generatedAt)) {
    refuse(`${VERDICT_MD_FILENAME} and ${VERDICT_JSON_FILENAME} carry different verification timestamps — they do not come from the same run; re-run verify-handoff`)
  }
}

// ---------------------------------------------------------------------------
// Step 2: freshness — the tgz must still be the bytes the verdict measured
// ---------------------------------------------------------------------------

function recheckArtifactFreshness({ submissionDir, artifact }) {
  if (isAbsolute(artifact.file) || artifact.file.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')) {
    refuse(`the receipt's artifact.file '${esc(artifact.file)}' does not name a file inside the submission directory — re-run verify-handoff`)
  }
  const tarballPath = resolve(submissionDir, artifact.file)
  if (relative(resolve(submissionDir), tarballPath).startsWith('..')) {
    refuse(`the receipt's artifact.file '${esc(artifact.file)}' escapes the submission directory — re-run verify-handoff`)
  }
  let stat
  try {
    stat = statSync(tarballPath)
  } catch {
    refuse(`submission changed after verification — '${esc(artifact.file)}' is no longer readable in ${submissionDir}; re-run verify-handoff`)
  }
  if (!stat.isFile()) {
    refuse(`submission changed after verification — '${esc(artifact.file)}' is not a regular file; re-run verify-handoff`)
  }
  if (stat.size !== artifact.sizeBytes) {
    refuse(`submission changed after verification — '${esc(artifact.file)}' is ${String(stat.size)} bytes but the verdict recorded ${String(artifact.sizeBytes)}; re-run verify-handoff`)
  }
  const sha256 = createHash('sha256').update(readFileSync(tarballPath)).digest('hex')
  if (sha256 !== artifact.sha256) {
    refuse(`submission changed after verification — '${esc(artifact.file)}' hashes to ${sha256} but the verdict recorded ${artifact.sha256}; re-run verify-handoff`)
  }
}

// ---------------------------------------------------------------------------
// Step 3: the entry — revalidated, cross-checked, repository pinned
// ---------------------------------------------------------------------------

function resolveVerifiedEntry({ receipt, repositoryOverride, companyCatalogOrigin }) {
  // The entry is re-derived from the receipt's JSON (a fresh object, so the
  // override below never mutate the receipt), then cross-checked against the
  // receipt's own identity and digest — a hand-edited verdict.json whose
  // entry disagrees with its verdict facts is refused, not trusted.
  const entry = JSON.parse(JSON.stringify(receipt.allowlistEntry))
  if (entry.packageName !== receipt.identity.packageName || entry.version !== receipt.identity.version) {
    refuse(`the receipt is inconsistent — the allowlist entry says ${esc(entry.packageName)}@${esc(entry.version)} but the verdict identity says ${esc(receipt.identity.packageName)}@${esc(receipt.identity.version)}; re-run verify-handoff`)
  }
  if (entry.treeDigest !== receipt.treeDigest) {
    refuse(`the receipt is inconsistent — the allowlist entry's treeDigest does not equal the verdict's measured treeDigest; re-run verify-handoff`)
  }
  if (repositoryOverride !== undefined) {
    const normalized = normalizeRepositoryUrl(repositoryOverride)
    if (normalized === undefined) {
      refuse(`--repository '${esc(repositoryOverride)}' is not a credential-free https URL (npm git+https://…git spellings accepted)`)
    }
    entry.repository = normalized
  }
  if (entry.repository === undefined) {
    refuse(`the verified entry carries no repository pin (the submitted package.json declared none — verify-handoff flagged it as a warning in the verdict) — pass --repository <https-url>: the tarball channel's build refuses an entry without the explicit override`)
  }
  const validation = validateAllowlistEntry(entry, `the verified entry for ${esc(entryKey(entry))}`, {
    ...(companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin }),
  })
  if (!validation.ok) {
    refuse(`the verified entry does not pass the pipeline's own validation: ${validation.reason}${companyCatalogOrigin === undefined && entry.source?.kind === 'tarball' ? ` — pass --catalog-origin or set ${CATALOG_ORIGIN_ENV}, the same origin every build uses` : ' — re-run verify-handoff'}`)
  }
  return validation.value
}

// ---------------------------------------------------------------------------
// Step 4: the merge — one ACTIVE version per plugin, revoked history kept
// ---------------------------------------------------------------------------

/**
 * Merge the verified entry into the reviewed entries:
 *
 *   - same name@version already listed with a DIFFERENT treeDigest → the
 *     immutability red line (a published name@version never changes);
 *   - same name@version listed revoked → refused: accept-handoff never
 *     un-revokes (that is a deliberate hand edit, not a one-command replay);
 *   - the package's ACTIVE entries are replaced by this one (the catalog's
 *     single-active-version shape), REVOKED entries stay verbatim for the
 *     signed audit trail.
 */
function mergeIntoEntries({ entries, entry }) {
  const samePackage = []
  entries.forEach((existing, index) => {
    if (existing.packageName === entry.packageName) samePackage.push({ existing, index })
  })
  const sameVersion = samePackage.find(({ existing }) => existing.version === entry.version)
  if (sameVersion !== undefined) {
    if (sameVersion.existing.revoked) {
      refuse(`${entryKey(entry)} is revoked in the allowlist — accept-handoff never un-revokes (revocation is a state, not a deletion); re-list the plugin deliberately by hand after review, or bump the version and accept that`)
    }
    if (sameVersion.existing.treeDigest !== entry.treeDigest) {
      refuse(`${entryKey(entry)} is already listed with ${sameVersion.existing.treeDigest === undefined ? 'no treeDigest' : `treeDigest ${sameVersion.existing.treeDigest}`} but the verdict measured ${entry.treeDigest} — a listed name@version is immutable; bump the version and resubmit`)
    }
  }
  const replaced = samePackage.filter(({ existing }) => !existing.revoked).map(({ existing }) => entryKey(existing))
  const keptRevoked = samePackage.filter(({ existing }) => existing.revoked).map(({ existing }) => entryKey(existing))
  const merged = []
  const insertionIndex = samePackage.length > 0 ? samePackage[0].index : entries.length
  entries.forEach((existing, index) => {
    if (index === insertionIndex) merged.push(entry)
    if (existing.packageName !== entry.packageName || existing.revoked) merged.push(existing)
  })
  if (samePackage.length === 0) merged.push(entry)
  return { merged, replaced, keptRevoked }
}

// ---------------------------------------------------------------------------
// Idempotency + minimal-diff serialization
// ---------------------------------------------------------------------------

/**
 * Canonical JSON for key-order-insensitive deep comparison: object keys
 * sorted recursively, so `{source, treeDigest}` and `{treeDigest, source}`
 * canonicalize equal. Idempotency must not depend on key order — hand-
 * written history entries may spell a different order than the normalizer
 * emits (dsh-free-search@0.4.183 lists `source` before `treeDigest`), and a
 * same-content replay of such an entry is a no-op, never a pure
 * key-reordering commit.
 */
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Re-key `entry` into the field order of `reference` (the reviewed entry
 * being replaced): reviewed keys first in their reviewed order, then any
 * field this entry adds, in the entry's own order. Returns `entry` as-is
 * when there is nothing to inherit (a brand-new package).
 */
function reorderEntryKeys(entry, reference) {
  if (reference === null || typeof reference !== 'object' || Array.isArray(reference)) return entry
  const ordered = {}
  for (const key of Object.keys(reference)) {
    if (Object.hasOwn(entry, key)) ordered[key] = entry[key]
  }
  for (const key of Object.keys(entry)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = entry[key]
  }
  return ordered
}

/**
 * Serialize the merge over the file's own entries (`rawEntries`, the direct
 * parse of the reviewed bytes — key order as written): untouched and
 * revoked entries keep their reviewed spelling (and thus their exact
 * bytes), and the applied entry — re-keyed to the order of the entry it
 * replaces, preferring a same name@version match — lands at the same
 * insertion point {@link mergeIntoEntries} chose. The written diff is the
 * content change alone.
 */
function renderMergedAllowlist({ rawEntries, entry }) {
  const samePackageIndexes = []
  rawEntries.forEach((existing, index) => {
    if (existing.packageName === entry.packageName) samePackageIndexes.push(index)
  })
  const sameVersionIndex = samePackageIndexes.find((index) => rawEntries[index].version === entry.version)
  const firstActiveIndex = samePackageIndexes.find((index) => rawEntries[index].revoked !== true)
  const orderedEntry = reorderEntryKeys(entry, rawEntries[sameVersionIndex ?? firstActiveIndex ?? -1])
  const insertionIndex = samePackageIndexes.length > 0 ? samePackageIndexes[0] : rawEntries.length
  const rendered = []
  rawEntries.forEach((existing, index) => {
    if (index === insertionIndex) rendered.push(orderedEntry)
    if (existing.packageName !== entry.packageName || existing.revoked === true) rendered.push(existing)
  })
  if (samePackageIndexes.length === 0) rendered.push(orderedEntry)
  return rendered
}

// ---------------------------------------------------------------------------
// The dry-run diff (preview only, never parsed, never applied)
// ---------------------------------------------------------------------------

/**
 * Minimal line-based unified diff (LCS + 3 lines of context). Hand-rolled on
 * purpose: --dry-run must preview without spawning git, and the allowlist is
 * a small line-oriented JSON file. Returns null when the texts are equal.
 */
export function unifiedTextDiff(beforeText, afterText, { fromLabel, toLabel }) {
  if (beforeText === afterText) return null
  const before = beforeText.endsWith('\n') ? beforeText.slice(0, -1).split('\n') : beforeText.split('\n')
  const after = afterText.endsWith('\n') ? afterText.slice(0, -1).split('\n') : afterText.split('\n')
  // LCS table (allowlists are tens of lines; O(n·m) is nothing).
  const table = Array.from({ length: before.length + 1 }, () => new Array(after.length + 1).fill(0))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ type: ' ', text: before[i], beforeLine: i + 1, afterLine: j + 1 })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: '-', text: before[i], beforeLine: i + 1 })
      i += 1
    } else {
      ops.push({ type: '+', text: after[j], afterLine: j + 1 })
      j += 1
    }
  }
  while (i < before.length) {
    ops.push({ type: '-', text: before[i], beforeLine: i + 1 })
    i += 1
  }
  while (j < after.length) {
    ops.push({ type: '+', text: after[j], afterLine: j + 1 })
    j += 1
  }
  // Group the changed lines into hunks with 3 lines of context around each.
  const touched = new Set()
  ops.forEach((op, index) => {
    if (op.type === ' ') return
    for (let k = Math.max(0, index - 3); k <= Math.min(ops.length - 1, index + 3); k += 1) touched.add(k)
  })
  const previousBeforeLine = (groupStart) => {
    for (let k = groupStart - 1; k >= 0; k -= 1) {
      if (ops[k].beforeLine !== undefined) return ops[k].beforeLine
    }
    return 0
  }
  const previousAfterLine = (groupStart) => {
    for (let k = groupStart - 1; k >= 0; k -= 1) {
      if (ops[k].afterLine !== undefined) return ops[k].afterLine
    }
    return 0
  }
  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`]
  let index = 0
  while (index < ops.length) {
    if (!touched.has(index)) {
      index += 1
      continue
    }
    const start = index
    while (index < ops.length && touched.has(index)) index += 1
    const group = ops.slice(start, index)
    const beforeLines = group.filter((op) => op.beforeLine !== undefined)
    const afterLines = group.filter((op) => op.afterLine !== undefined)
    const beforeStart = beforeLines.length > 0 ? beforeLines[0].beforeLine : previousBeforeLine(start) + 1
    const afterStart = afterLines.length > 0 ? afterLines[0].afterLine : previousAfterLine(start) + 1
    lines.push(`@@ -${String(beforeStart)},${String(beforeLines.length)} +${String(afterStart)},${String(afterLines.length)} @@`)
    for (const op of group) lines.push(`${op.type}${op.text}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Step 5: the commit — the allowlist change and its commit are one step
// ---------------------------------------------------------------------------

/**
 * git preflight: git must run, and the allowlist must live inside a git work
 * tree (its repo-relative POSIX path is the pathspec every later git call
 * pins), and the allowlist must be CLEAN — no staged or unstaged edits, no
 * untracked spelling: uncommitted local changes would be silently swept
 * into the `catalog: accept …` commit, and the acceptance commit must carry
 * exactly the accepted entry. Refused BEFORE anything is written — e.g. the
 * CI case, where publish artifacts exist but no checkout does.
 */
function gitPreflight({ git, allowlistPath, gitEnv }) {
  const probe = git(['--version'], {})
  if (probe.status !== 0) {
    refuse(`git is not available (${probe.status === null ? esc(probe.error ?? 'git could not run') : `git --version exited ${String(probe.status)}`}) — accept-handoff applies a PASS verdict only through a commit, so it fail-closes where git is missing (e.g. a CI job without the repository checkout); run it in the repository checkout`)
  }
  const inside = runGit(git, ['rev-parse', '--is-inside-work-tree'], { cwd: dirname(allowlistPath), env: gitEnv, what: 'checking that the allowlist lives in a git work tree' })
  if (inside !== 'true') {
    refuse(`the allowlist's directory is not inside a git work tree — accept-handoff applies a PASS verdict only through a commit, so it refuses to run outside one`)
  }
  const toplevel = runGit(git, ['rev-parse', '--show-toplevel'], { cwd: dirname(allowlistPath), env: gitEnv, what: 'locating the git work tree root' })
  const repoRelative = relative(toplevel, allowlistPath).split('\\').join('/')
  if (repoRelative.startsWith('../') || isAbsolute(repoRelative) || repoRelative === '') {
    refuse(`the allowlist ${allowlistPath} does not live inside the git work tree ${toplevel} — accept-handoff commits exactly this one file, so it must be a repo-relative path`)
  }
  const dirty = git(['status', '--porcelain', '--', repoRelative], { cwd: toplevel, env: gitEnv })
  if (dirty.status !== 0) {
    refuse(`checking ${repoRelative} for uncommitted changes failed (${dirty.status === null ? `git could not run: ${esc(dirty.error ?? 'no diagnostics')}` : `git exited ${String(dirty.status)}`}) — nothing was applied`)
  }
  if ((dirty.stdout ?? '').trim().length > 0) {
    refuse(`allowlist has uncommitted changes — commit or stash first (${repoRelative} differs from HEAD; the acceptance commit must carry exactly the accepted entry, never swept-along local edits) — nothing was applied`)
  }
  return { toplevel, repoRelative }
}

/**
 * Write + commit, fail-atomic: if anything after the write fails, the
 * previous bytes are restored and the pathspec unstaged, so an entry is
 * never applied without its commit.
 */
function writeAndCommit({ git, gitEnv, allowlistPath, originalText, nextText, toplevel, repoRelative, message }) {
  writeFileSync(allowlistPath, nextText, 'utf8')
  try {
    runGit(git, ['add', '--', repoRelative], { cwd: toplevel, env: gitEnv, what: `staging ${repoRelative}` })
    runGit(git, ['commit', '-m', message, '--', repoRelative], { cwd: toplevel, env: gitEnv, what: `committing ${repoRelative} (${message})` })
  } catch (error) {
    writeFileSync(allowlistPath, originalText, 'utf8')
    try {
      git(['reset', '--', repoRelative], { cwd: toplevel, env: gitEnv })
    } catch {
      // Best effort: the restored bytes are authoritative; the index note
      // rides in the refusal below.
    }
    if (error instanceof AcceptanceRefusal) {
      refuse(`the allowlist was written but its commit failed (${error.message}) — the previous bytes were restored, nothing applied; fix the cause (often the git identity or a locked index) and re-run`)
    }
    throw error
  }
  return runGit(git, ['rev-parse', '--short', 'HEAD'], { cwd: toplevel, env: gitEnv, what: 'reading the new commit' })
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Accept one verified submission into the allowlist. Throws
 * {@link AcceptanceRefusal} on every fail-closed path (nothing was applied);
 * on success returns:
 *
 *   { ok: true, submissionDir, receiptPath, identity, entry, replaced,
 *     keptRevoked, dryRun, alreadyAccepted?, commitSha?, message,
 *     allowlistPath, repoRelative?, diff? }
 *
 * Options: submissionDir (required), allowlistPath (the tool default),
 * receiptsDir (the owner-local record channel verify-handoff writes — the
 * tool default), repository (the --repository pin), dryRun,
 * companyCatalogOrigin (the same origin every build validates tarball urls
 * against), git (injectable git channel, default spawnGitRunner), gitEnv
 * (extra git child environment), log.
 */
export function acceptHandoffVerdict(options) {
  const submissionDir = resolve(options.submissionDir)
  let stat
  try {
    stat = statSync(submissionDir)
  } catch (error) {
    throw new Error(`the submission directory ${submissionDir} does not exist (${error.code ?? error.message}) — point accept-handoff at the staging clone's submissions/<name>-<version> directory`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`${submissionDir} is not a directory — accept-handoff takes the submissions/<name>-<version> directory carrying the verify-handoff verdict`)
  }
  const allowlistPath = resolve(options.allowlistPath ?? join(CATALOG_DIR, 'allowlist.json'))
  const receiptsDir = resolve(options.receiptsDir ?? DEFAULT_VERDICT_RECEIPTS_DIR)
  const log = options.log ?? (() => {})
  const git = options.git ?? spawnGitRunner
  const gitEnv = options.gitEnv

  // 0 — the local receipt record: the trust anchor before anything else.
  // The PASS verdict.json bytes must be the ones a verify-handoff run on
  // THIS machine issued (and the receipt pair alone is never enough).
  checkLocalReceiptRecord({ submissionDir, receiptsDir })

  // 1 — the receipt pair.
  const { receipt, receiptPath, verdictText, verdictPath } = readVerdictReceipt(submissionDir)
  validatePassReceipt(receipt, receiptPath)
  checkReceiptAgreement({ verdictText, receipt, verdictPath })
  log(`verdict:  PASS · ${esc(receipt.identity.packageName)}@${esc(receipt.identity.version)} · checked ${esc(receipt.generatedAt)} (verdict.json + verdict.md agree)`)

  // 2 — freshness.
  recheckArtifactFreshness({ submissionDir, artifact: receipt.artifact })
  log(`fresh:    '${esc(receipt.artifact.file)}' re-fingerprinted equal (sha256 ${receipt.artifact.sha256.slice(0, 16)}… · ${String(receipt.artifact.sizeBytes)} B)`)

  // 3 — the entry.
  const entry = resolveVerifiedEntry({
    receipt,
    ...(options.repository === undefined ? {} : { repositoryOverride: options.repository }),
    companyCatalogOrigin: options.companyCatalogOrigin,
  })
  log(`entry:    ${entryKey(entry)} validated (measured treeDigest ${entry.treeDigest.slice(0, 16)}…)`)

  // 4 — the merge.
  const entries = loadAllowlist(allowlistPath, {
    ...(options.companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin: options.companyCatalogOrigin }),
  })
  const { merged, replaced, keptRevoked } = mergeIntoEntries({ entries, entry })
  const message = commitMessageFor(entry)
  let originalText
  try {
    originalText = readFileSync(allowlistPath, 'utf8')
  } catch (error) {
    throw new Error(`the allowlist ${allowlistPath} is not readable (${error.code ?? error.message})`)
  }
  // Idempotency is the canonical deep comparison (key order does not
  // count): a same-content replay of an entry whose reviewed spelling —
  // key order — differs from the normalizer's output is a no-op, never a
  // pure key-reordering commit.
  if (canonicalJson(entries) === canonicalJson(merged)) {
    log(`merge:    ${entryKey(entry)} already is the reviewed entry (canonically identical — nothing to change, no commit)`)
    return {
      ok: true,
      submissionDir,
      receiptPath,
      identity: receipt.identity,
      entry,
      replaced: [],
      keptRevoked,
      dryRun: false,
      alreadyAccepted: true,
      message,
      allowlistPath,
    }
  }
  // A real change: serialize over the file's own entries so the written
  // diff is the content change alone — untouched entries keep their
  // reviewed spelling, and the applied entry inherits the key order of the
  // entry it replaces.
  const nextText = `${JSON.stringify(renderMergedAllowlist({ rawEntries: JSON.parse(originalText), entry }), null, 2)}\n`
  const diff = unifiedTextDiff(originalText, nextText, { fromLabel: allowlistPath, toLabel: allowlistPath })
  if (replaced.length > 0) log(`merge:    replaces ${replaced.join(', ')} (one active version per plugin — the catalog's existing shape)`)
  else log(`merge:    new package ${entry.packageName} (appended)`)
  if (keptRevoked.length > 0) log(`merge:    keeps revoked ${keptRevoked.join(', ')} verbatim (revocation is a state, not a deletion)`)

  // 5 — the commit (or its dry-run preview).
  if (options.dryRun === true) {
    log('')
    log('the entry that would be written:')
    log(JSON.stringify(entry, null, 2))
    log('')
    log(diff)
    log('')
    log(`dry-run: ${allowlistPath} untouched, nothing committed (the real run commits '${message}')`)
    return {
      ok: true,
      submissionDir,
      receiptPath,
      identity: receipt.identity,
      entry,
      replaced,
      keptRevoked,
      dryRun: true,
      message,
      allowlistPath,
      diff,
    }
  }
  const { toplevel, repoRelative } = gitPreflight({ git, allowlistPath, gitEnv })
  const commitSha = writeAndCommit({ git, gitEnv, allowlistPath, originalText, nextText, toplevel, repoRelative, message })
  log(`commit:   ${commitSha} ${message} (${repoRelative} only)`)

  // Non-gating note: the tarball channel's fill step needs the staged
  // artifact verify-handoff left in out/packages/ before any build runs.
  if (entry.source?.path !== undefined && !existsSync(resolve(REPO_ROOT, ...entry.source.path.split('/')))) {
    log(`note:     the staged artifact ${entry.source.path} is not present in this checkout — verify-handoff stages it on the machine that verified; the build's fill step needs it before measure-and-publish`)
  }
  return {
    ok: true,
    submissionDir,
    receiptPath,
    identity: receipt.identity,
    entry,
    replaced,
    keptRevoked,
    dryRun: false,
    commitSha,
    message,
    allowlistPath,
    repoRelative,
  }
}
