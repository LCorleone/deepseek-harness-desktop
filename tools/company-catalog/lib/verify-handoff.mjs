/**
 * Owner-side mechanical verification of a staged plugin handoff submission
 * (`cli.mjs verify-handoff`): every field of the handoff contract
 * (docs/handoff/{handoff.schema.json,compat.json,README.zh.md}) becomes one
 * fail-fast check, in the order the contract README promises the submitter —
 *
 *   1 schema              handoff.json validates against the schema
 *                         (additionalProperties:false enforced)
 *   2 artifact-integrity  tgz exists, sha256 + sizeBytes recomputed equal
 *   3 safe-unpack         the lib/tarball.mjs three-layer containment
 *                         (lexical + creation-time realpath + final walk),
 *                         same defense the client install chain uses
 *   4 identity-binding    directory name == handoff.plugin == the tarball's
 *                         own package.json, character for character
 *   5 compat              dshCommit/desktopVersion equal to the pinned
 *                         compat.json values; dshRuntimeVersion intersects
 *                         the pinned runtimeRange (lib/version-range.mjs)
 *   6 audit               dependency/lifecycle/injection/network surface +
 *                         catalog delta — a report for the human, never a
 *                         gate
 *   7 tree-digest         reference-install measurement (measure.mjs --tarball)
 *   8 smoke-remeasure     --smoke only: a second independent measurement,
 *                         both digests must be equal (default off; the
 *                         desktop e2e install smoke is a separate drill:
 *                         `yarn e2e:install-smoke`)
 *   9 verdict             verdict.md into the submission directory, pass or
 *                         fail (the README's promise to the submitter)
 *  10 accept-prep         on pass: stage the tgz into out/packages/ in the
 *                         exact filename the publishing flow's fill step
 *                         consumes, plus a paste-ready allowlist entry
 *                         carrying the MEASURED treeDigest — zero pipeline
 *                         change downstream (measure-and-publish /
 *                         publish-local keep working untouched)
 *
 * The command never signs and never publishes: the private key stays with
 * the owner's publish run; this module only verifies and stages.
 *
 * Plain Node built-ins; offline except the reference install (whose child
 * call carries its own timeout); Windows-safe path handling (join/resolve
 * everywhere, POSIX spelling only where a contract field demands it).
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expectedTarballFilename,
  isSafeBundlePatchPath,
  loadAllowlist,
  repositoryFromPackument,
  STABLE_VERSION_PATTERN,
  validateAllowlistEntry,
} from './allowlist.mjs'
import { loadJsonSchema, validateJsonSchema } from './handoff-schema.mjs'
import {
  DEFAULT_PACKAGES_DIR_RELATIVE,
  REPO_ROOT,
  TOOL_DIR,
  extractTarballEntries,
  parseTarball,
  sha512IntegrityOf,
} from './tarball.mjs'
import { compareSemver, parseSemver, rangesIntersect } from './version-range.mjs'

/** tools/company-catalog — the lib's TOOL_DIR is lib/ itself. */
const CATALOG_DIR = resolve(TOOL_DIR, '..')

/** The canonical check sequence, in the order the contract README promises. */
export const HANDOFF_STEPS = [
  { index: 1, step: 'schema' },
  { index: 2, step: 'artifact-integrity' },
  { index: 3, step: 'safe-unpack' },
  { index: 4, step: 'identity-binding' },
  { index: 5, step: 'compat' },
  { index: 6, step: 'audit' },
  { index: 7, step: 'tree-digest' },
  { index: 8, step: 'smoke-remeasure' },
  { index: 9, step: 'verdict' },
  { index: 10, step: 'accept-prep' },
]
const STEP_BY_NAME = new Map(HANDOFF_STEPS.map((entry) => [entry.step, entry.index]))

/** Default decompression bound for submitter tarballs (gzip-bomb defense). */
export const DEFAULT_MAX_UNPACKED_BYTES = 512 * 1024 * 1024
/** Default bound on tar entries (a flood of empty entries is also a bomb). */
export const DEFAULT_MAX_ENTRIES = 200_000
/** Reference-install child timeout — matches measure.mjs's own install bound. */
export const MEASURE_TIMEOUT_MS = 600_000
const HEX_64 = /^[0-9a-f]{64}$/u
const HEX_40 = /^[0-9a-f]{40}$/u
/** URL hosts observed in shipped files, reported for the human audit. */
const URL_HOST_PATTERN = /https?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::\d+)?)/gu
const AUDIT_SCAN_FILE_BYTES = 1024 * 1024
const AUDIT_MAX_HOSTS = 50
const LIFECYCLE_SCRIPTS = [
  'preinstall', 'install', 'postinstall', 'prepack', 'prepare', 'postpack',
  'prepublish', 'prepublishOnly', 'preuninstall', 'postuninstall',
]

/** A failed mechanical check: names its step; never leaves the pipeline. */
class CheckFailure extends Error {
  constructor(step, message) {
    super(message)
    this.name = 'HandoffCheckFailure'
    this.step = step
  }
}

const failCheck = (step, message) => {
  throw new CheckFailure(step, message)
}

/**
 * Rendering-boundary escape for every submitter-controlled value that lands
 * in verdict.md or the terminal step log. Control characters (LF, CR, ESC,
 * DEL, the C1 range a terminal also honors) are the only characters that can
 * forge structure — a line impersonating a verdict bullet (`\n[ok] 10/10
 * PASS`) or an ANSI escape — so they are replaced by a visible marker; the
 * schema whitelists what it can, this escapes everything else that still
 * reaches a render. Never reflows owner-authored text: everything except
 * control characters passes through untouched.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu
const esc = (value) => String(value).replace(CONTROL_CHARACTERS, '\uFFFD')

/**
 * Multi-line rendering of reason/detail text (the schema block, a child
 * process tail): each line escaped on its own, continuations indented so no
 * wrapped line can impersonate a top-level verdict bullet or step line.
 */
const escMultiline = (text) => String(text).split('\n').map(esc).join('\n    ')

/** The repo-relative POSIX path spelling every contract field uses. */
const posixRepoRelative = (absolutePath) => relative(REPO_ROOT, absolutePath).split('\\').join('/')

/** Per-step retest guidance for the failure verdict (zh: the submitter reads it). */
const RETEST_GUIDANCE = {
  schema: '按 docs/handoff/handoff.schema.json 逐字段修正 handoff.json（additionalProperties:false —— 多一个字段都过不了）。',
  'artifact-integrity': '重新 `npm pack`，对产物重算 SHA-256 与字节数后再填单；改了内容必须升版本号重新提交（同一版本号内容不可变）。',
  'safe-unpack': 'tgz 不是合格的 npm pack 产物或携带逃逸符号链接——检查打包来源与内容后换新版本号重新提交。',
  'identity-binding': '目录名、handoff.json 的 plugin 段、tgz 内 package.json 三方的 name/version 必须逐字符一致；目录名必须是 <name>-<version>（scope 扁平化拼写）。',
  compat: null, // rendered from the pinned compat values at failure time
  audit: null, // never fails
  'tree-digest': '参考安装实测失败——按错误信息修复环境（构建桌面 lib、安装钉版 pnpm、registry 可达）后原样重跑 verify-handoff（内容未变不需换版本号）。',
  'smoke-remeasure': '两次实测 treeDigest 不一致——检查安装环境稳定性（网络/缓存）后原样重跑。',
  verdict: 'verdict.md 写入失败——确认提交目录可写后重跑。',
  'accept-prep': 'allowlist 条目片段未通过管线自身校验，或同版本号已在 out/packages 备了不同字节的料——前者按错误信息修正（通常随包声明 dsh.bundle.patch 或补 repository），后者升版本号重新提交（同一版本号内容不可变）。',
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

function readJsonFile(path, what) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${what} ${path} is not readable (${error.code ?? error.message})`)
  }
  try {
    return { text, parsed: JSON.parse(text) }
  } catch (error) {
    throw new Error(`${what} ${path} is not valid JSON (${error.message})`)
  }
}

/** Load + structurally validate the pinned compat contract (owner-side file). */
function loadCompatContract(compatPath) {
  const { parsed } = readJsonFile(compatPath, 'the pinned compatibility contract')
  const dshCommit = parsed?.dsh?.commit
  const runtimeRange = parsed?.dsh?.runtimeRange
  const desktopVersion = parsed?.desktop?.version
  const problems = []
  if (typeof dshCommit !== 'string' || !HEX_40.test(dshCommit)) problems.push('dsh.commit must be 40 lowercase hex characters')
  if (typeof desktopVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(desktopVersion)) problems.push('desktop.version must be X.Y.Z')
  if (typeof runtimeRange !== 'string') problems.push('dsh.runtimeRange must be a string')
  if (problems.length > 0) {
    failCheck('compat', `compat.json (the pinned contract at ${compatPath}) is malformed: ${problems.join('; ')} — fix the authoritative copy under docs/handoff/ first`)
  }
  return {
    dshCommit,
    dshVersion: typeof parsed.dsh.version === 'string' ? parsed.dsh.version : undefined,
    runtimeRange,
    desktopVersion,
    manifestUrl: typeof parsed?.catalog?.manifestUrl === 'string' ? parsed.catalog.manifestUrl : undefined,
  }
}

// ---------------------------------------------------------------------------
// Steps 1–5: the mechanical gates
// ---------------------------------------------------------------------------

/** Step 1: handoff.json against the contract schema. */
function checkSchema({ submissionDir, schemaPath }) {
  const schema = loadJsonSchema(schemaPath)
  const handoffPath = join(submissionDir, 'handoff.json')
  let handoff
  try {
    handoff = JSON.parse(readFileSync(handoffPath, 'utf8'))
  } catch (error) {
    failCheck('schema', `the submission carries no readable handoff.json (${error.code ?? error.message}) — see docs/handoff/handoff.schema.json`)
  }
  const validation = validateJsonSchema(handoff, schema)
  if (!validation.ok) {
    const rendered = validation.errors.slice(0, 5).map((error) => `handoff.json${error.at === '' ? '' : esc(error.at)}: ${error.message}`)
    // A prerelease/build plugin version is the one pattern refusal that
    // deserves its own pointed sentence: the generic pattern error hides
    // the actual rule (the catalog lists stable three-segment releases only).
    const declaredVersion = handoff?.plugin?.version
    const versionNote = typeof declaredVersion === 'string' && /^\d+\.\d+\.\d+[-+]/u.test(declaredVersion)
      ? `\n  plugin.version '${esc(declaredVersion)}' — the catalog only lists stable three-segment versions (X.Y.Z); drop the prerelease/build segment and resubmit`
      : ''
    failCheck('schema', `handoff.json does not satisfy handoff.schema.json:\n  ${rendered.join('\n  ')}${validation.errors.length > 5 ? `\n  (+${String(validation.errors.length - 5)} more)` : ''}${versionNote}`)
  }
  return handoff
}

/** Step 2: artifact existence, byte size, sha256 — before anything is unpacked. */
function checkArtifact({ submissionDir, handoff }) {
  const { file, sha256, sizeBytes } = handoff.artifact
  if (file === '.' || file === '..') {
    failCheck('artifact-integrity', `artifact.file must be the bare tarball filename (got '${esc(file)}')`)
  }
  const tarballPath = join(submissionDir, file)
  let stat
  try {
    stat = statSync(tarballPath)
  } catch (error) {
    failCheck('artifact-integrity', `artifact.file '${esc(file)}' is not readable next to handoff.json (${error.code ?? error.message}) — npm pack the plugin and commit the tgz with the submission`)
  }
  if (!stat.isFile()) failCheck('artifact-integrity', `artifact.file '${esc(file)}' is not a regular file`)
  if (stat.size !== sizeBytes) {
    failCheck('artifact-integrity', `artifact.sizeBytes declares ${String(sizeBytes)} but '${esc(file)}' is ${String(stat.size)} bytes on disk — recompute the fingerprint (sha256 + sizeBytes) from the artifact you are submitting`)
  }
  const bytes = readFileSync(tarballPath)
  const recomputed = createHash('sha256').update(bytes).digest('hex')
  if (recomputed !== sha256) {
    failCheck('artifact-integrity', `artifact.sha256 mismatch: handoff.json declares ${sha256} but the bytes of '${esc(file)}' hash to ${recomputed} — the artifact does not match the submission sheet; re-pack, recompute, and bump the version (same-version content is immutable)`)
  }
  return { file, tarballPath, bytes, sizeBytes: stat.size, sha256: recomputed, integrity: sha512IntegrityOf(bytes) }
}

/** Step 3: parse + extract through the three-layer symlink containment. */
function checkUnpack({ bytes, file, extractDir, maxUnpackedBytes, maxEntries }) {
  let entries
  try {
    entries = parseTarball(bytes, `the submission tarball '${esc(file)}'`, { maxUnpackedBytes })
  } catch (error) {
    failCheck('safe-unpack', `refusing to unpack '${esc(file)}': ${error instanceof Error ? error.message : String(error)}`)
  }
  if (entries.length > maxEntries) {
    failCheck('safe-unpack', `'${esc(file)}' carries ${String(entries.length)} tar entries, over the ${String(maxEntries)}-entry bound — refusing the flood`)
  }
  try {
    extractTarballEntries(entries, extractDir)
  } catch (error) {
    failCheck('safe-unpack', `safe extraction refused '${esc(file)}': ${error instanceof Error ? error.message : String(error)}`)
  }
  const fileCount = entries.filter((entry) => entry.type === 'file').length
  const linkCount = entries.filter((entry) => entry.type === 'symlink').length
  // extractTarballEntries strips the npm `package/` prefix, so the unpacked
  // tree is the extraction directory itself (same contract packFromNpmSpec
  // relies on).
  return { entries, fileCount, linkCount, packageDir: extractDir }
}

/**
 * Step 4: directory name == handoff.plugin == the tarball's package.json,
 * character for character. The directory spelling follows the npm pack
 * filename (`@scope/name` flattens to `scope-name`), which is also the
 * hosting layout's pinned artifact filename.
 */
function checkIdentityBinding({ submissionDir, handoff, file, packageDir }) {
  const { packageName, version } = handoff.plugin
  // Pointed refusal before the generic three-way comparison: a prerelease/
  // build version can never enter the catalog (the allowlist itself only
  // validates stable three-segment versions), so say exactly that instead
  // of letting it die later in a generic validateAllowlistEntry error. The
  // schema pattern refuses it at step 1 already; this is the same gate,
  // spelled out, for any schema copy that still permits it.
  if (!STABLE_VERSION_PATTERN.test(version)) {
    failCheck('identity-binding', `plugin.version '${esc(version)}' is not a stable three-segment X.Y.Z version — the catalog only lists stable releases, so a prerelease/build segment can never enter it; publish the stable release and submit that`)
  }
  const expectedFilename = expectedTarballFilename(packageName, version)
  const directoryName = basename(submissionDir)
  const expectedDirectoryName = expectedFilename.replace(/\.tgz$/u, '')
  if (directoryName !== expectedDirectoryName) {
    failCheck('identity-binding', `the submission directory is '${esc(directoryName)}' but the handoff declares ${esc(packageName)}@${esc(version)}, which must submit as '${esc(expectedDirectoryName)}' (the npm pack spelling of <name>-<version>)`)
  }
  if (file !== expectedFilename) {
    failCheck('identity-binding', `artifact.file is '${esc(file)}' but ${esc(packageName)}@${esc(version)} must pack as '${esc(expectedFilename)}' (the hosting layout pins the artifact filename)`)
  }
  const manifestPath = join(packageDir, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    failCheck('identity-binding', `the tarball's package/package.json is not readable JSON (${error.code ?? error.message}) — not an npm pack artifact`)
  }
  if (manifest?.name !== packageName || manifest?.version !== version) {
    failCheck('identity-binding', `three-way identity mismatch — the submission directory says '${esc(directoryName)}', handoff.json says ${esc(packageName)}@${esc(version)}, but the tarball's package.json says ${esc(manifest?.name)}@${esc(manifest?.version)}; all three must agree character for character`)
  }
  return manifest
}

/** Step 5: the compat declarations against the pinned contract. */
function checkCompat({ handoff, compat }) {
  const declared = handoff.compat
  if (declared.dshCommit !== compat.dshCommit) {
    failCheck('compat', `compat.dshCommit ${declared.dshCommit} does not equal the pinned compat.json dsh.commit ${compat.dshCommit} — retest against deepseek-harness commit ${compat.dshCommit} and resubmit`)
  }
  if (declared.desktopVersion !== compat.desktopVersion) {
    failCheck('compat', `compat.desktopVersion ${declared.desktopVersion} does not equal the pinned compat.json desktop.version ${compat.desktopVersion} — retest against DSH Desktop ${compat.desktopVersion} and resubmit`)
  }
  let intersects
  try {
    intersects = rangesIntersect(declared.dshRuntimeVersion, compat.runtimeRange)
  } catch (error) {
    failCheck('compat', `compat.dshRuntimeVersion '${esc(declared.dshRuntimeVersion)}' is outside the range grammar this gate implements (${esc(error instanceof Error ? error.message : String(error))}) — spell the tested range as an exact version or a ^/~ range`)
  }
  if (!intersects) {
    failCheck('compat', `compat.dshRuntimeVersion '${esc(declared.dshRuntimeVersion)}' shares no version with the pinned compat.json dsh.runtimeRange '${compat.runtimeRange}' — retest against deepseek-harness ${compat.dshVersion ?? compat.runtimeRange} (runtime range ${compat.runtimeRange}) and resubmit`)
  }
}

// ---------------------------------------------------------------------------
// Step 6: the audit report (never a gate)
// ---------------------------------------------------------------------------

/** Dependency rows across the four npm sections, in a stable order. */
function dependencyRows(manifest) {
  const rows = []
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = manifest[section]
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    for (const [name, range] of Object.entries(block)) {
      rows.push({ section, name, range: typeof range === 'string' ? range : JSON.stringify(range) })
    }
  }
  return rows
}

/** Distinct URL hosts across the shipped text files (a surface report). */
function scanNetworkHosts(packageDir) {
  const hosts = new Map()
  const pending = [packageDir]
  let filesScanned = 0
  while (pending.length > 0) {
    const dir = pending.pop()
    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return { available: false, note: 'the shipped tree could not be walked' }
    }
    for (const dirent of dirents) {
      const node = join(dir, dirent.name)
      // Never read through a symlink: the containment walk already vetted
      // where links point; the audit reports what was shipped, not what a
      // link dereferences to.
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        pending.push(node)
        continue
      }
      if (!dirent.isFile()) continue
      let stat
      try {
        stat = statSync(node)
      } catch {
        continue
      }
      if (stat.size > AUDIT_SCAN_FILE_BYTES || stat.size === 0) continue
      let text
      try {
        text = readFileSync(node, 'utf8')
      } catch {
        continue
      }
      if (text.slice(0, 512).includes('\0')) continue // binary
      filesScanned += 1
      for (const match of text.matchAll(URL_HOST_PATTERN)) {
        const host = match[1]
        hosts.set(host, (hosts.get(host) ?? 0) + 1)
      }
    }
  }
  const sorted = [...hosts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([host, files]) => ({ host, files }))
  return {
    available: true,
    filesScanned,
    hosts: sorted.slice(0, AUDIT_MAX_HOSTS),
    ...(sorted.length > AUDIT_MAX_HOSTS ? { truncated: sorted.length - AUDIT_MAX_HOSTS } : {}),
  }
}

/** Same-name allowlist entries: the version delta the owner reviews against. */
function catalogDelta({ manifest, allowlistPath, companyCatalogOrigin }) {
  const packageName = manifest.name
  try {
    const entries = loadAllowlist(allowlistPath, companyCatalogOrigin === undefined ? {} : { companyCatalogOrigin })
    const existing = entries.filter((entry) => entry.packageName === packageName)
    if (existing.length === 0) {
      return { available: true, packageName, existing: [], relation: 'new-package', note: `no ${packageName} entry in the catalog yet — initial submission` }
    }
    const sameVersion = existing.find((entry) => entry.version === manifest.version)
    if (sameVersion !== undefined) {
      return {
        available: true,
        packageName,
        existing: existing.map((entry) => ({ version: entry.version, revoked: entry.revoked })),
        relation: 'same-version',
        note: `the catalog already lists ${packageName}@${manifest.version}${sameVersion.revoked ? ' (revoked)' : ''} — same-version content is immutable; a resubmission must bump the version`,
      }
    }
    const newest = existing
      .filter((entry) => !entry.revoked)
      .map((entry) => entry.version)
      .sort((a, b) => compareSemver(parseSemver(a), parseSemver(b)))
      .pop()
    const direction = newest !== undefined && compareSemver(parseSemver(manifest.version), parseSemver(newest)) < 0 ? 'downgrade' : 'upgrade'
    return {
      available: true,
      packageName,
      existing: existing.map((entry) => ({ version: entry.version, revoked: entry.revoked })),
      relation: direction,
      note: `catalog lists ${packageName} at ${existing.map((entry) => `${entry.version}${entry.revoked ? ' (revoked)' : ''}`).join(', ')}; this submission is ${direction === 'upgrade' ? 'ahead of' : 'behind'} the newest active ${newest}`,
    }
  } catch (error) {
    return { available: false, packageName, note: `the allowlist comparison was skipped (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** Step 6: assemble the human-facing audit report. */
function runAudit({ manifest, packageDir, allowlistPath, companyCatalogOrigin, fileCount }) {
  const dsh = manifest.dsh !== null && typeof manifest.dsh === 'object' && !Array.isArray(manifest.dsh) ? manifest.dsh : {}
  const client = dsh.client !== null && typeof dsh.client === 'object' && !Array.isArray(dsh.client) ? dsh.client : {}
  const engines = dsh.engines !== null && typeof dsh.engines === 'object' && !Array.isArray(dsh.engines) ? dsh.engines : {}
  return {
    fileCount,
    dependencies: dependencyRows(manifest),
    lifecycleScripts: Array.isArray(manifest.scripts)
      ? []
      : manifest.scripts !== null && typeof manifest.scripts === 'object'
        ? Object.keys(manifest.scripts).filter((script) => LIFECYCLE_SCRIPTS.includes(script))
        : [],
    dshSurface: {
      ...(Array.isArray(client.inject) ? { clientInject: client.inject } : {}),
      ...(typeof client.platform === 'string' ? { clientPlatform: client.platform } : {}),
      ...(typeof engines.dsh === 'string' ? { enginesDsh: engines.dsh } : {}),
      ...(typeof dsh.bundle?.patch === 'string' ? { bundlePatch: dsh.bundle.patch } : {}),
    },
    networkHosts: scanNetworkHosts(packageDir),
    catalogDelta: catalogDelta({ manifest, allowlistPath, companyCatalogOrigin }),
  }
}

// ---------------------------------------------------------------------------
// Step 7/8: reference-install measurement
// ---------------------------------------------------------------------------

/**
 * Measure one packed tarball through measure.mjs's standalone artifact mode
 * (the same reference staged install pack-tarball uses). Returns the digest
 * record `{packageName, version, treeDigest}`; throws with the child's own
 * tail output on any failure. Timeout-bounded: a hung install must not hang
 * the verification.
 */
export function measureTarballViaReferenceInstall({ tarballPath, toolDir = CATALOG_DIR, timeoutMs = MEASURE_TIMEOUT_MS }) {
  const digestFile = join(tmpdir(), `company-catalog-verify-handoff-digest-${String(process.pid)}-${randomUUID()}.json`)
  try {
    const probe = spawnSync(process.execPath, [
      join(toolDir, 'measure.mjs'),
      '--tarball', tarballPath,
      '--out', digestFile,
    ], { encoding: 'utf8', timeout: timeoutMs })
    if (probe.error !== undefined) {
      throw new Error(`the reference measurement could not run (${probe.error.message})`)
    }
    if (probe.status === null) {
      throw new Error(`the reference measurement timed out after ${String(Math.round(timeoutMs / 1000))}s — see measure.mjs; re-run with a clean environment`)
    }
    if (probe.status !== 0) {
      const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim()
      throw new Error(`measure.mjs --tarball exited ${String(probe.status)}:\n${output.split('\n').slice(-8).join('\n')}`)
    }
    let records
    try {
      records = JSON.parse(readFileSync(digestFile, 'utf8'))
    } catch (error) {
      throw new Error(`measure.mjs wrote no readable digest file (${error.message})`)
    }
    const record = Array.isArray(records) ? records[0] : undefined
    if (record === null || typeof record !== 'object'
      || typeof record.packageName !== 'string' || typeof record.version !== 'string'
      || typeof record.treeDigest !== 'string' || !HEX_64.test(record.treeDigest)) {
      throw new Error(`measure.mjs returned no usable digest record (got ${JSON.stringify(record ?? null).slice(0, 200)})`)
    }
    return { packageName: record.packageName, version: record.version, treeDigest: record.treeDigest }
  } finally {
    rmSync(digestFile, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Step 10 data: the paste-ready allowlist entry
// ---------------------------------------------------------------------------

/**
 * The default origin the snippet's source.url lives on: an explicit flag/env
 * origin wins; otherwise the compat contract's catalog.manifestUrl carries
 * the deployment's own origin (it is the owner-pinned file).
 */
function resolveCatalogOriginForSnippet({ explicit, compat }) {
  if (explicit !== undefined) return explicit
  if (compat.manifestUrl !== undefined) {
    try {
      const url = new URL(compat.manifestUrl)
      if (url.protocol === 'https:') return url.origin
    } catch {
      // A malformed manifestUrl is degraded below (no origin derivable).
    }
  }
  return undefined
}

/**
 * Build and VALIDATE the allowlist entry the owner pastes after review. The
 * snippet must pass the pipeline's own validateAllowlistEntry — a submission
 * whose entry could never load is refused here, not at the next build.
 */
function buildAllowlistSnippet({ handoff, manifest, artifactFilename, packagesDir, catalogOrigin, project }) {
  if (catalogOrigin === undefined) {
    failCheck('accept-prep', 'no company catalog origin available for the source.url — pass --catalog-origin, set COMPANY_CATALOG_ORIGIN, or give compat.json a catalog.manifestUrl')
  }
  const destinationPath = join(packagesDir, artifactFilename)
  const repoRelative = posixRepoRelative(destinationPath)
  if (repoRelative.startsWith('../') || repoRelative === '') {
    failCheck('accept-prep', `the accept directory ${packagesDir} does not live inside the repository ${REPO_ROOT} — the allowlist source.path form must be repository-relative`)
  }
  const warnings = []
  const declaredPatch = manifest?.dsh?.bundle?.patch
  if (typeof declaredPatch !== 'string' || !isSafeBundlePatchPath(declaredPatch)) {
    failCheck('accept-prep', "the tarball's package.json declares no safe dsh.bundle.patch path — every catalog entry pins bundlePatch, and the desktop's post-install assert requires it to equal the package's own declaration byte for byte; have the submitter declare it in the package and resubmit (with a bumped version)")
  }
  const repository = repositoryFromPackument(manifest.repository)
  if (repository === undefined) {
    warnings.push(`the tarball's package.json declares no usable repository — pin "repository" (an https URL) in the allowlist entry yourself: the tarball channel's build refuses an entry without the explicit override`)
  }
  const entry = {
    packageName: handoff.plugin.packageName,
    version: handoff.plugin.version,
    bundlePatch: declaredPatch,
    ...(repository === undefined ? {} : { repository: repository.url }),
    revoked: false,
    runtime: { dshRuntimeVersion: handoff.compat.dshRuntimeVersion },
    source: {
      kind: 'tarball',
      url: `${catalogOrigin}/${project}/-/raw/master/packages/${artifactFilename}`,
      path: repoRelative,
    },
    treeDigest: undefined, // filled by the caller with the MEASURED digest
  }
  return { entry, warnings, destinationPath, repoRelative }
}

// ---------------------------------------------------------------------------
// Step 9: verdict.md (the README's promise: written pass or fail)
// ---------------------------------------------------------------------------

const renderDependencyLines = (audit) => {
  if (audit.dependencies.length === 0) return ['- 依赖（dependencies）：无']
  const bySection = new Map()
  for (const row of audit.dependencies) {
    if (!bySection.has(row.section)) bySection.set(row.section, [])
    bySection.get(row.section).push(`${esc(row.name)}@${esc(row.range)}`)
  }
  return [...bySection.entries()].map(([section, items]) => `- 依赖（${section}）：${items.join(' · ')}`)
}

const renderHostLines = (audit) => {
  const scan = audit.networkHosts
  if (!scan.available) return [`- 网络域（network hosts）：${scan.note}`]
  if (scan.hosts.length === 0) return [`- 网络域（network hosts）：随包文件中未观察到 http(s) URL（扫描 ${String(scan.filesScanned)} 个文本文件）`]
  const hosts = scan.hosts.map((host) => `${host.host}×${String(host.files)}`).join(' · ')
  return [`- 网络域（network hosts，随包文件中观察到）：${hosts}${scan.truncated ? ` …（及另外 ${String(scan.truncated)} 个）` : ''}`]
}

const renderAuditLines = (audit) => [
  '## 内容审计（不阻断 · 供人审）',
  ...renderDependencyLines(audit),
  `- 安装期脚本（lifecycle scripts）：${audit.lifecycleScripts.length === 0 ? '无' : audit.lifecycleScripts.join(', ')}`,
  `- 注入面（dsh 声明）：${Object.keys(audit.dshSurface).length === 0 ? '无 dsh 声明' : Object.entries(audit.dshSurface).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' · ')}`,
  ...renderHostLines(audit),
  `- 目录比较（catalog delta）：${esc(audit.catalogDelta.note)}`,
  `- 随包文件（files）：${String(audit.fileCount)}`,
]

function renderPassVerdict({ identity, artifact, compat, treeDigest, smokeDigest, audit, warnings, allowlistEntry, destinationPath, submissionDir, generatedAt, smoke }) {
  return [
    `# verify-handoff · PASS`,
    '',
    `- 提交（submission）：\`${esc(submissionDir)}\``,
    `- 校验时间（checked）：${generatedAt}`,
    `- 身份（identity）：${esc(identity.packageName)}@${esc(identity.version)}`,
    `- 工件（artifact）：\`${esc(artifact.file)}\` · ${String(artifact.sizeBytes)} B · sha256 \`${artifact.sha256}\` · sha512 完整性 \`${artifact.integrity}\``,
    `- 兼容（compat）：dshCommit \`${compat.dshCommit}\` · desktop \`${compat.desktopVersion}\` · runtime \`${esc(compat.handoffRuntime)}\` ∩ \`${compat.pinnedRange}\` ≠ ∅`,
    `- 实测 treeDigest：\`${treeDigest}\`（参考安装实测，measure.mjs）`,
    ...(smoke ? [`- --smoke 复测：${smokeDigest === treeDigest ? `一致（\`${smokeDigest}\`）` : `不一致（\`${smokeDigest}\`）`}`] : []),
    '',
    ...renderAuditLines(audit),
    '',
    '## 采用（accept）',
    '',
    `- tgz 已复制到 \`${esc(destinationPath)}\`（现有发布流 fill 步消费的形态）`,
    '- allowlist 条目片段（评审后贴入 allowlist.json；treeDigest 为实测值）：',
    '',
    '```json',
    JSON.stringify(allowlistEntry, null, 2),
    '```',
    ...(warnings.length > 0 ? ['', '注意（warnings）：', ...warnings.map((warning) => `- ${warning}`)] : []),
    '',
    '## 后续（owner）',
    '',
    '片段贴入 allowlist.json → `measure-and-publish`（--digest-file 可直接引用实测值）→ `publish-local`；',
    '桌面端 e2e 安装冒烟另跑 `yarn e2e:install-smoke`（本命令不做桌面端冒烟）。',
    '',
  ].join('\n')
}

function renderFailVerdict({ submissionDir, generatedAt, failedStep, steps }) {
  const guidance = failedStep.step === 'compat'
    ? `按上方原因 retest against 钉死值后重新提交。`
    : (RETEST_GUIDANCE[failedStep.step] ?? '修正后重新提交。')
  const passed = steps.filter((step) => step.status === 'ok').map((step) => `${String(step.index)}/10 ${step.step}`)
  return [
    '# verify-handoff · FAIL',
    '',
    `- 提交（submission）：\`${esc(submissionDir)}\``,
    `- 校验时间（checked）：${generatedAt}`,
    `- 失败步骤（failed step）：${String(failedStep.index)}/10 ${failedStep.step}`,
    `- 原因（reason）：${escMultiline(failedStep.reason)}`,
    `- 复测指引（retest）：${guidance}`,
    ...(passed.length > 0 ? [`- 已通过步骤：${passed.join(' · ')}`] : []),
    '',
    '同一版本号的内容不可变——若因此修正了 tgz 或 handoff.json，必须升版本号重新提交；',
    '纯环境问题（网络/构建）修复后可原样重跑本命令。',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Verify one staged submission end to end. Always resolves (never throws on
 * a check failure — the failure is the result); returns:
 *
 *   { ok, submissionDir, verdictPath, steps, failedStep?, identity?, artifact?,
 *     compat?, audit?, treeDigest?, smokeDigest?, allowlistEntry?,
 *     allowlistWarnings?, packagePath?, packageRepoPath?, generatedAt }
 *
 * Options (all paths absolute or cwd-relative): submissionDir (required),
 * schemaPath/compatPath/allowlistPath/packagesDir (the contract defaults),
 * catalogOrigin, project, smoke, measureTarball (injectable measurement),
 * maxUnpackedBytes, maxEntries, now (clock injection for tests), log.
 */
export async function verifyHandoffSubmission(options) {
  const submissionDir = resolve(options.submissionDir)
  let stat
  try {
    stat = statSync(submissionDir)
  } catch (error) {
    throw new Error(`the submission directory ${submissionDir} does not exist (${error.code ?? error.message}) — point verify-handoff at the staging clone's submissions/<name>-<version> directory`)
  }
  if (!stat.isDirectory()) throw new Error(`${submissionDir} is not a directory — verify-handoff takes the submissions/<name>-<version> directory`)

  const schemaPath = options.schemaPath !== undefined ? resolve(options.schemaPath) : join(CATALOG_DIR, 'docs', 'handoff', 'handoff.schema.json')
  const compatPath = options.compatPath !== undefined ? resolve(options.compatPath) : join(CATALOG_DIR, 'docs', 'handoff', 'compat.json')
  const allowlistPath = options.allowlistPath !== undefined ? resolve(options.allowlistPath) : join(CATALOG_DIR, 'allowlist.json')
  const packagesDir = options.packagesDir !== undefined ? resolve(options.packagesDir) : resolve(REPO_ROOT, ...DEFAULT_PACKAGES_DIR_RELATIVE.split('/'))
  const project = options.project ?? 'julu/dsh-desktop-config'
  const smoke = options.smoke === true
  const measure = options.measureTarball ?? ((tarballPath) => measureTarballViaReferenceInstall({ tarballPath }))
  const log = options.log ?? (() => {})
  const generatedAt = (options.now ?? new Date()).toISOString()

  const steps = []
  const record = (index, step, status, detail) => {
    steps.push({ index, step, status, detail })
    log(`[${status}] ${String(index)}/10 ${step} — ${escMultiline(detail)}`)
  }
  const attempt = (index, step, action) => {
    try {
      const detail = action()
      record(index, step, 'ok', detail)
      return detail
    } catch (error) {
      if (!(error instanceof CheckFailure)) throw error
      record(index, step, 'fail', error.message)
      error.index = index
      throw error
    }
  }

  const extractDir = mkdtempSync(join(tmpdir(), 'company-catalog-verify-handoff-'))
  try {
    const state = {}
    let failure
    try {
      // compat is loaded once, inside step 5's own attempt (a malformed
      // contract copy is a compat-check failure), then reused by the audit
      // and the snippet's catalog-origin fallback.
      attempt(1, 'schema', () => {
        state.handoff = checkSchema({ submissionDir, schemaPath })
        return `handoff.json satisfies ${posixRepoRelative(schemaPath) || schemaPath} (additionalProperties:false enforced)`
      })
      attempt(2, 'artifact-integrity', () => {
        state.artifact = checkArtifact({ submissionDir, handoff: state.handoff })
        return `'${esc(state.artifact.file)}' · ${String(state.artifact.sizeBytes)} B · sha256 recomputed equal (${state.artifact.sha256.slice(0, 16)}…)`
      })
      let packageDirOf
      let fileCount
      attempt(3, 'safe-unpack', () => {
        const unpack = checkUnpack({
          bytes: state.artifact.bytes,
          file: state.handoff.artifact.file,
          extractDir,
          maxUnpackedBytes: options.maxUnpackedBytes ?? DEFAULT_MAX_UNPACKED_BYTES,
          maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
        })
        packageDirOf = unpack.packageDir
        fileCount = unpack.fileCount
        return `${String(unpack.fileCount)} files (+${String(unpack.linkCount)} symlinks) extracted inside the three-layer containment`
      })
      attempt(4, 'identity-binding', () => {
        state.manifest = checkIdentityBinding({ submissionDir, handoff: state.handoff, file: state.handoff.artifact.file, packageDir: packageDirOf })
        return `directory == handoff == tarball manifest: ${esc(state.manifest.name)}@${esc(state.manifest.version)}`
      })
      attempt(5, 'compat', () => {
        state.compat = loadCompatContract(compatPath)
        checkCompat({ handoff: state.handoff, compat: state.compat })
        return `dshCommit ${state.compat.dshCommit.slice(0, 12)}… == pinned · desktop ${state.compat.desktopVersion} == pinned · runtime '${esc(state.handoff.compat.dshRuntimeVersion)}' ∩ '${state.compat.runtimeRange}' ≠ ∅`
      })
      // Step 6 is a report, never a gate: every degradation is a note.
      state.audit = runAudit({
        manifest: state.manifest,
        packageDir: packageDirOf,
        allowlistPath,
        companyCatalogOrigin: resolveCatalogOriginForSnippet({ explicit: options.catalogOrigin, compat: state.compat }),
        fileCount,
      })
      record(6, 'audit', 'ok', `${String(state.audit.dependencies.length)} dependency rows · ${String(state.audit.networkHosts.available ? state.audit.networkHosts.hosts.length : 0)} network hosts · ${state.audit.catalogDelta.relation ?? 'catalog comparison unavailable'}`)
      attempt(7, 'tree-digest', () => {
        let measured
        try {
          measured = measure(state.artifact.tarballPath)
        } catch (error) {
          failCheck('tree-digest', `the reference measurement failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (measured.packageName !== state.handoff.plugin.packageName || measured.version !== state.handoff.plugin.version) {
          failCheck('tree-digest', `the reference install measured ${esc(measured.packageName)}@${esc(measured.version)} but the submission is ${esc(state.handoff.plugin.packageName)}@${esc(state.handoff.plugin.version)} — the artifact identity moved under the measurement`)
        }
        state.treeDigest = measured.treeDigest
        return measured.treeDigest
      })
      if (smoke) {
        attempt(8, 'smoke-remeasure', () => {
          let second
          try {
            second = measure(state.artifact.tarballPath)
          } catch (error) {
            failCheck('smoke-remeasure', `the --smoke re-measurement failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          state.smokeDigest = second.treeDigest
          if (second.treeDigest !== state.treeDigest) {
            failCheck('smoke-remeasure', `the --smoke re-measurement produced ${second.treeDigest} but the first measurement produced ${state.treeDigest} — the reference install is not reproducible for this artifact`)
          }
          return `re-measured equal (${second.treeDigest.slice(0, 16)}…)`
        })
      } else {
        record(8, 'smoke-remeasure', 'skip', 'off by default (desktop e2e install smoke runs separately: yarn e2e:install-smoke)')
      }
    } catch (error) {
      if (!(error instanceof CheckFailure)) throw error
      failure = error
    }

    // Step 10's data is prepared before the verdict so a PASS verdict only
    // ever ships a snippet that already passed the pipeline's own validation
    // — and so an immutability refusal fails BEFORE the verdict is written,
    // never after a PASS verdict has already landed in the directory.
    let snippet
    let alreadyStagedIdentical = false
    if (failure === undefined) {
      try {
        const catalogOrigin = resolveCatalogOriginForSnippet({ explicit: options.catalogOrigin, compat: state.compat })
        snippet = buildAllowlistSnippet({
          handoff: state.handoff,
          manifest: state.manifest,
          artifactFilename: state.handoff.artifact.file,
          packagesDir,
          catalogOrigin,
          project,
        })
        snippet.entry.treeDigest = state.treeDigest
        const validation = validateAllowlistEntry(snippet.entry, `the generated allowlist entry for ${snippet.entry.packageName}@${snippet.entry.version}`, { companyCatalogOrigin: catalogOrigin })
        if (!validation.ok) {
          failCheck('accept-prep', `the allowlist entry did not pass the pipeline's own validation: ${validation.reason}`)
        }
        // Same-version immutability, mirroring publish-local's hosted-tarball
        // rule: out/packages/<name>-<version>.tgz already holding DIFFERENT
        // bytes for this version is refused (a published name@version never
        // changes — bump the version for changed content); identical bytes
        // are an idempotent pass, exactly what the deterministic pack and a
        // clean re-run of the same submission produce.
        try {
          if (statSync(snippet.destinationPath).isFile()) {
            if (!readFileSync(snippet.destinationPath).equals(state.artifact.bytes)) {
              failCheck('accept-prep', `same version already staged with different bytes — ${snippet.repoRelative} holds another artifact for this <name>-<version>, and content is immutable per version; bump the version and resubmit (the same rule publish-local enforces for hosted tarballs)`)
            }
            alreadyStagedIdentical = true
          }
        } catch (error) {
          if (error instanceof CheckFailure) throw error
          // ENOENT (nothing staged yet) and odd pre-existing shapes fall
          // through: the copy below either creates the file fresh or fails
          // loudly with the filesystem's own reason.
        }
      } catch (error) {
        if (!(error instanceof CheckFailure)) throw error
        failure = error
        failure.index = 10
        record(10, 'accept-prep', 'fail', error.message)
      }
    }

    // Step 9: the verdict is written whether the run passed or failed.
    const verdictPath = join(submissionDir, 'verdict.md')
    const render = () => {
      if (failure !== undefined) {
        return renderFailVerdict({ submissionDir, generatedAt, failedStep: { index: failure.index ?? STEP_BY_NAME.get(failure.step), step: failure.step, reason: failure.message }, steps })
      }
      return renderPassVerdict({
        identity: state.handoff.plugin,
        artifact: state.artifact,
        compat: {
          dshCommit: state.handoff.compat.dshCommit,
          desktopVersion: state.handoff.compat.desktopVersion,
          handoffRuntime: state.handoff.compat.dshRuntimeVersion,
          pinnedRange: state.compat.runtimeRange,
        },
        treeDigest: state.treeDigest,
        smokeDigest: state.smokeDigest,
        audit: state.audit,
        warnings: snippet.warnings,
        allowlistEntry: snippet.entry,
        destinationPath: snippet.destinationPath,
        submissionDir,
        generatedAt,
        smoke,
      })
    }
    try {
      writeFileSync(verdictPath, render(), 'utf8')
      record(9, 'verdict', 'ok', `verdict.md written into the submission directory (${failure === undefined ? 'PASS' : `FAIL at ${String(failure.index ?? STEP_BY_NAME.get(failure.step))}/10 ${failure.step}`})`)
    } catch (error) {
      const message = `verdict.md could not be written to ${verdictPath} (${error.code ?? error.message})`
      record(9, 'verdict', 'fail', message)
      if (failure === undefined) failure = new CheckFailure('verdict', message)
    }

    // Step 10 (success only): stage the artifact for the existing flow.
    let packagePath
    let packageRepoPath
    if (failure === undefined) {
      try {
        mkdirSync(packagesDir, { recursive: true })
        if (!alreadyStagedIdentical) {
          copyFileSync(state.artifact.tarballPath, snippet.destinationPath)
        }
        packagePath = snippet.destinationPath
        packageRepoPath = snippet.repoRelative
        record(10, 'accept-prep', 'ok', alreadyStagedIdentical
          ? `${snippet.repoRelative} already staged with identical bytes (idempotent re-run of the same submission) — nothing to change`
          : `tgz staged at ${snippet.repoRelative} — the publishing flow's fill step consumes it as-is; paste the printed allowlist entry after review`)
        log('')
        log('allowlist entry (paste after review):')
        log(JSON.stringify(snippet.entry, null, 2))
        for (const warning of snippet.warnings) log(`note: ${warning}`)
        log('next: allowlist.json ← entry → measure-and-publish (--digest-file may cite the measured digest verbatim) → publish-local; desktop e2e smoke: yarn e2e:install-smoke')
      } catch (error) {
        const message = error instanceof CheckFailure ? error.message : `staging the tgz into ${packagesDir} failed (${error.code ?? error.message})`
        record(10, 'accept-prep', 'fail', message)
        failure = error instanceof CheckFailure ? error : new CheckFailure('accept-prep', message)
        failure.index = 10
      }
    }

    const result = {
      ok: failure === undefined,
      submissionDir,
      verdictPath,
      generatedAt,
      steps,
      ...(failure === undefined ? {} : { failedStep: { index: failure.index ?? STEP_BY_NAME.get(failure.step), step: failure.step, reason: failure.message } }),
      ...(state.handoff === undefined ? {} : { identity: { packageName: state.handoff.plugin.packageName, version: state.handoff.plugin.version } }),
      ...(state.artifact === undefined ? {} : { artifact: { file: state.artifact.file, sizeBytes: state.artifact.sizeBytes, sha256: state.artifact.sha256, integrity: state.artifact.integrity } }),
      ...(state.compat === undefined ? {} : { compat: { declared: state.handoff.compat, pinned: { dshCommit: state.compat.dshCommit, desktopVersion: state.compat.desktopVersion, runtimeRange: state.compat.runtimeRange } } }),
      ...(state.audit === undefined ? {} : { audit: state.audit }),
      ...(state.treeDigest === undefined ? {} : { treeDigest: state.treeDigest }),
      ...(state.smokeDigest === undefined ? {} : { smokeDigest: state.smokeDigest }),
      ...(snippet === undefined ? {} : { allowlistEntry: snippet.entry, allowlistWarnings: snippet.warnings, packagePath, packageRepoPath }),
    }
    return result
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}
