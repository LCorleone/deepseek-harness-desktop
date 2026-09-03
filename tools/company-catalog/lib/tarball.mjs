/**
 * Tarball-channel packing (P7 batch 2b): turn a patched plugin source tree
 * — or an exact public-registry version plus a patch script — into the
 * npm-pack-compatible .tgz the intranet GitLab hosts at
 * `packages/<name>-<version>.tgz` inside the julu/dsh-desktop-config repo
 * (the same repo that serves catalog-manifest.json, so the raw-URL prefix is
 * the one publish-local.mjs already derives).
 *
 * `npm pack` owns the content selection (the `files` whitelist, the
 * always-included set, npm's default excludes) — reimplementing those rules
 * would drift — but its container is not byte-stable: tar entry metadata
 * follows the source files' mtimes and npm's gzip header varies per run.
 * The pipeline re-serializes npm's output into a deterministic ustar+gzip
 * container (fixed mtime/uid/gid/modes, sorted entries, gzip mtime 0), so
 * re-packing the same reviewed source yields byte-identical artifacts. That
 * determinism is what makes the hosted tarball effectively immutable: a
 * later CI re-run that re-packs an unchanged entry produces the exact bytes
 * already deployed, and publish-local's existing-file byte check passes
 * instead of fail-closing on a timestamp-only difference.
 *
 * Plain Node built-ins only (tar reader/writer hand-rolled on the 512-byte
 * ustar format npm itself emits; gzip via node:zlib).
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { PACKAGE_NAME_PATTERN, STABLE_VERSION_PATTERN } from './allowlist.mjs'

export const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
// lib/ → company-catalog/ → tools/ → repository root (the base the
// `source.path` form resolves against; cli.mjs's own TOOL_DIR is one level up).
export const REPO_ROOT = resolve(TOOL_DIR, '..', '..', '..')
/** Default artifact directory (repo-relative, inside the gitignored out/). */
export const DEFAULT_PACKAGES_DIR_RELATIVE = 'tools/company-catalog/out/packages'
/** Default in-repo root of the patched plugin sources the workflow packs from. */
export const DEFAULT_PLUGIN_SOURCES_DIR_RELATIVE = 'tools/company-catalog/plugin-sources'
/** One hosted tarball's byte bound (mirrored by publish-local's artifact caps). */
export const TARBALL_MAX_BYTES = 128 * 1024 * 1024
const NPM_REGISTRY = 'https://registry.npmjs.org/'
// Determinism premise: gzipSync's bytes come from the zlib the running Node
// links against. Within one Node/zlib build the container below is
// byte-stable (mtime 0, fixed level, sorted entries); a different zlib
// version may emit a different deflate stream — and a different gzip OS
// byte — so re-packing a deployed artifact must happen on the same pinned
// CI Node image, never ad hoc on arbitrary hosts. The signed integrity pin
// makes any such divergence fail loudly instead of silently forking bytes.
const GZIP_LEVEL = 9

/** Standard-base64 SHA-512 integrity of exact bytes — the value the manifest signs. */
export function sha512IntegrityOf(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** npm's pack filename spelling: `@scope/name` → `scope-name-<version>.tgz`. */
export function expectedTarballFilename(packageName, version) {
  return `${packageName.replace(/^@/u, '').replace(/\//gu, '-')}-${version}.tgz`
}

/** Parse an exact `<name>@<stable version>` pack spec (the pipeline never packs ranges). */
export function parsePackSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) throw new Error('pack spec must be <package>@<exact stable version>')
  const at = spec.lastIndexOf('@')
  if (at <= 0) throw new Error(`pack spec '${spec}' must be <package>@<exact stable version>`)
  const packageName = spec.slice(0, at)
  const version = spec.slice(at + 1)
  if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error(`'${packageName}' is not an npm package name`)
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(`'${version}' is not an exact stable semver (X.Y.Z) — the tarball channel only hosts pinned versions`)
  }
  return { packageName, version }
}

/** Run `npm pack --json --ignore-scripts` and return npm's own pack report. */
function runNpmPack({ cwd, spec, packDestination, log }) {
  const args = [
    'pack', '--json', '--ignore-scripts',
    '--registry', NPM_REGISTRY,
    '--pack-destination', packDestination,
    ...(spec === undefined ? [] : [spec]),
  ]
  const probe = spawnSync('npm', args, { encoding: 'utf8', cwd, timeout: 300_000 })
  if (probe.error !== undefined) {
    throw new Error(`npm pack could not be executed (${probe.error.message}) — is npm on PATH?`)
  }
  if (probe.status !== 0) {
    const detail = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim().split('\n').slice(-8).join(' | ')
    throw new Error(`npm pack${spec === undefined ? '' : ` ${spec}`} exited ${String(probe.status)}: ${detail.slice(0, 600)}`)
  }
  let report
  try {
    report = JSON.parse(probe.stdout)
  } catch (error) {
    throw new Error(`npm pack --json printed unparseable output (${error.message})`)
  }
  const entry = Array.isArray(report) ? report[0] : undefined
  if (entry === null || typeof entry !== 'object' || typeof entry.filename !== 'string') {
    throw new Error('npm pack --json printed no filename — refusing to guess the artifact name')
  }
  if (log !== undefined) log(`npm pack: ${entry.filename} (${String(entry.size ?? '?')} bytes packed, ${String(entry.unpackedSize ?? '?')} unpacked)`)
  return entry
}

// ---------------------------------------------------------------------------
// Minimal ustar reader/writer (the container npm pack emits). Only the
// shapes npm itself produces are accepted; anything exotic (GNU long names,
// pax headers, hardlinks) fails loudly instead of being silently mangled.
// ---------------------------------------------------------------------------

const BLOCK = 512
const USTAR_MAGIC = Buffer.from('ustar\0', 'binary')
const GNU_OR_USTAR = (magic) => magic.subarray(0, 5).toString('binary') === 'ustar'

const octal = (value, length) => `${value.toString(8).padStart(length - 1, '0')}\0`
const readOctal = (block, offset, length) => {
  const text = block.subarray(offset, offset + length).toString('binary')
  const trimmed = text.replace(/[\0 ].*$/u, '').trim()
  if (trimmed.length === 0) return 0
  if (!/^[0-7]+$/u.test(trimmed)) throw new Error(`tar header carries a non-octal field ('${trimmed}')`)
  return Number.parseInt(trimmed, 8)
}

const safeEntryPath = (path) => typeof path === 'string'
  && path.length > 0
  && !path.includes('\\')
  && !path.startsWith('/')
  && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

/**
 * Validate a symlink target against its entry's directory: the target must
 * be a non-empty relative path that lexically resolves back inside the
 * `package/` root. Absolute targets (and empty ones) are refused outright;
 * any `..` walk that would leave `package/` is an escape — extraction writes
 * files with writeFileSync, which follows symlinks, so a link resolving
 * outside the tree turns a later entry into an arbitrary-path write. The
 * containment is checked lexically at parse time; extractTarballEntries adds
 * an independent realpath-based safety net over what actually landed.
 */
function safeLinkTarget(entryPath, linkName) {
  if (typeof linkName !== 'string' || linkName.length === 0 || linkName.startsWith('/') || linkName.includes('\\')) {
    return false
  }
  const segments = dirname(entryPath).split('/')
  for (const segment of linkName.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      if (segments.length === 0) return false
    } else {
      segments.push(segment)
    }
  }
  const resolved = segments.join('/')
  return resolved === 'package' || resolved.startsWith('package/')
}

/** Parse a .tgz into normalized entries; every violation of the npm layout fails loudly. */
export function parseTarball(bytes, what = 'the tarball') {
  let tar
  try {
    tar = gunzipSync(bytes)
  } catch (error) {
    throw new Error(`${what} is not valid gzip (${error.message})`)
  }
  if (tar.length === 0 || tar.length % BLOCK !== 0) {
    throw new Error(`${what} is not a tar archive (its size is not a multiple of ${String(BLOCK)} bytes)`)
  }
  const entries = []
  for (let offset = 0; offset < tar.length; offset += BLOCK) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    // Checksum: the header's own checksum field reads as spaces while summing.
    const stored = readOctal(header, 148, 8)
    const signed = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0)
    if (stored !== signed) throw new Error(`${what} has a tar header with a broken checksum at byte ${String(offset)}`)
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '')
    const path = prefix.length > 0 ? `${prefix}/${rawName}` : rawName
    const mode = readOctal(header, 100, 8)
    const size = readOctal(header, 124, 12)
    const mtime = readOctal(header, 136, 12)
    // ustar typeflag is at byte 156 (the writer emits it there and the
    // linkname follows at 157); reading the devmajor field instead would
    // collapse every symlink to a file entry.
    const type = String.fromCharCode(header[156] ?? 0x30)
    const linkName = header.subarray(157, 257).toString('utf8').replace(/\0.*$/u, '')
    if (!GNU_OR_USTAR(header.subarray(257, 265))) {
      throw new Error(`${what} carries a non-ustar tar entry ('${path}') — refusing to mangle it`)
    }
    if (type === 'L' || type === 'K' || type === 'x' || type === 'g' || type === 'X') {
      throw new Error(`${what} uses GNU/pax extension headers ('${type}') — the deterministic normalizer supports plain ustar only`)
    }
    if (!safeEntryPath(path)) {
      throw new Error(`${what} carries an unsafe tar entry path '${path}' (absolute, dot segment, or backslash)`)
    }
    if (!path.startsWith('package/') && path !== 'package') {
      throw new Error(`${what} entry '${path}' does not sit under the npm 'package/' prefix — not an npm pack artifact`)
    }
    // The claimed data — header block + padded payload — must exist in full
    // inside the archive: Buffer#subarray clamps silently, so a header whose
    // size overruns the remaining bytes would otherwise hand back a short
    // entry instead of failing loudly (a truncated tarball is corruption,
    // not a smaller file).
    const dataOffset = offset + BLOCK
    const paddedEnd = dataOffset + Math.ceil(size / BLOCK) * BLOCK
    if (paddedEnd > tar.length) {
      throw new Error(
        `${what} entry '${path}' claims ${String(size)} data bytes but only ${String(Math.max(tar.length - dataOffset, 0))} remain — the archive is truncated`,
      )
    }
    offset += Math.ceil(size / BLOCK) * BLOCK
    if (type === '0' || type === '\0' || type === '7') {
      entries.push({ path, type: 'file', mode, mtime, data: Buffer.from(tar.subarray(dataOffset, dataOffset + size)) })
    } else if (type === '2') {
      if (!safeLinkTarget(path, linkName)) {
        throw new Error(
          `${what} symlink '${path}' carries an unsafe link target '${linkName}' ` +
          '(empty, absolute, or resolving outside the package/ root — a later entry writing through it would land outside the extraction directory)',
        )
      }
      entries.push({ path, type: 'symlink', mode, mtime, linkName })
    } else if (type === '5') {
      entries.push({ path: path.replace(/\/$/u, ''), type: 'directory', mode, mtime })
    } else {
      throw new Error(`${what} carries an unsupported tar entry type '${type}' ('${path}')`)
    }
  }
  if (entries.length === 0) throw new Error(`${what} carries no entries`)
  return entries
}

/** Split a long path into a ustar (prefix, name) pair, or throw when unrepresentable. */
function ustarNameSplit(path) {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { prefix: '', name: path }
  const chunks = path.split('/')
  for (let cut = chunks.length - 1; cut > 0; cut -= 1) {
    const prefix = chunks.slice(0, cut).join('/')
    const name = chunks.slice(cut).join('/')
    if (prefix.length > 0 && Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) return { prefix, name }
  }
  throw new Error(`tar entry '${path}' is too long for the ustar format (255 bytes max)`)
}

/** Write a string field into a header at a fixed offset as exactly its utf8 bytes. */
const writeHeaderField = (header, offset, value, length) =>
  Buffer.from(value, 'utf8').subarray(0, length).copy(header, offset)

/** Serialize entries into the deterministic container: sorted paths, fixed metadata, gzip mtime 0. */
export function buildDeterministicTarball(entries) {
  const files = entries
    .filter((entry) => entry.type === 'file' || entry.type === 'symlink')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (files.length === 0) throw new Error('the tarball would carry no files')
  const blocks = []
  for (const entry of files) {
    const { prefix, name } = ustarNameSplit(entry.path)
    const data = entry.type === 'file' ? entry.data : Buffer.alloc(0)
    // Mode normalization: the executable bit survives, everything else
    // collapses to the canonical 644/755 pair — a chmod on the build machine
    // must never change the published bytes.
    const mode = entry.type === 'symlink' || (entry.mode & 0o111) !== 0 ? 0o755 : 0o644
    const header = Buffer.alloc(BLOCK)
    writeHeaderField(header, 0, name, 100)
    header.write(octal(mode, 8), 100, 'binary')
    header.write(octal(data.byteLength, 12), 124, 'binary')
    header.write(octal(0, 12), 136, 'binary') // mtime 0 — determinism
    header.write('        ', 148, 'binary') // checksum placeholder (spaces)
    header.write(entry.type === 'symlink' ? '2' : '0', 156, 'binary')
    if (entry.type === 'symlink') writeHeaderField(header, 157, entry.linkName, 100)
    USTAR_MAGIC.copy(header, 257)
    header.write('00', 263, 'binary')
    header.write('root', 265, 'binary') // uname
    header.write('root', 297, 'binary') // gname
    header.write(octal(0, 8), 329, 'binary') // devmajor
    header.write(octal(0, 8), 337, 'binary') // devminor
    if (prefix.length > 0) writeHeaderField(header, 345, prefix, 155)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(octal(checksum, 7) + ' ', 148, 'binary')
    blocks.push(header, data)
    const padding = (BLOCK - (data.byteLength % BLOCK)) % BLOCK
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(BLOCK * 2))
  return gzipSync(Buffer.concat(blocks), { level: GZIP_LEVEL, mtime: 0 })
}

/**
 * Rewrite an npm pack artifact in place as the deterministic container and
 * return its integrity facts. The file's bytes change (that is the point);
 * its name, contents, and npm semantics do not.
 */
export function normalizeTarballFile(tarballPath) {
  const bytes = readFileSync(tarballPath)
  const entries = parseTarball(bytes, tarballPath)
  const normalized = buildDeterministicTarball(entries)
  writeFileSync(tarballPath, normalized)
  return { sizeBytes: normalized.byteLength, integrity: sha512IntegrityOf(normalized), fileCount: entries.filter((entry) => entry.type === 'file').length }
}

/** Copy a plugin source tree into the staging dir, dropping what must never ship. */
export function stageSourceDirectory(sourceDir, targetDir) {
  const stat = statSync(sourceDir)
  if (!stat.isDirectory()) throw new Error(`the plugin source ${sourceDir} is not a directory`)
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (path) => {
      const relativePath = relative(sourceDir, path)
      if (relativePath === '') return true
      const segments = relativePath.split(/[\\/]/u)
      if (segments.includes('node_modules') || segments.includes('.git')) return false
      // A stale pack output in the source root would otherwise ship inside
      // the artifact (npm packs top-level *.tgz files) — the accident is far
      // more likely than a plugin legitimately shipping its own .tgz.
      if (segments.length === 1 && relativePath.endsWith('.tgz')) return false
      return true
    },
  })
  return targetDir
}

/**
 * Final containment assertion over an extraction: every node that landed —
 * files, directories, symlinks — must realpath back inside the target
 * directory. parseTarball's link-target validation already fails closed on
 * escapes before anything is written; this walk is the independent safety
 * net over the result itself (defense in depth for the arbitrary-path-write
 * class: extractTarballEntries can be called with hand-built entries, and a
 * containment bug in the lexical check must still be caught here). A
 * dangling symlink cannot have routed a write outside — any successful
 * write or mkdir through it would have materialized its target — so it is
 * skipped rather than failing the walk.
 */
function assertExtractionContained(root) {
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const node = join(dir, dirent.name)
      let real
      try {
        real = realpathSync(node)
      } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      const inside = relative(root, real)
      if (inside.startsWith('..') || isAbsolute(inside)) {
        throw new Error(
          `extracting the tarball produced '${relative(root, node)}', whose real path ${real} lies outside the extraction directory ${root} — the tarball carries an escaping link`,
        )
      }
      // Symlinked directories are not descended into (their real location is
      // covered by the walk when it is inside the tree; a link outside the
      // tree tripped the check above).
      if (dirent.isDirectory()) pending.push(node)
    }
  }
}

/** Materialize a parsed tarball under a directory (the npm-fetch patch staging area). */
export function extractTarballEntries(entries, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  const root = realpathSync(targetDir)
  for (const entry of entries) {
    const destination = join(targetDir, entry.path.replace(/^package\//u, ''))
    if (entry.type === 'directory') {
      mkdirSync(destination, { recursive: true })
      continue
    }
    mkdirSync(dirname(destination), { recursive: true })
    if (entry.type === 'symlink') {
      rmSync(destination, { force: true })
      symlinkSync(entry.linkName, destination)
      continue
    }
    writeFileSync(destination, entry.data, { mode: 0o644 })
  }
  assertExtractionContained(root)
  return targetDir
}

/**
 * Read and validate the packed plugin's manifest (name/version must be
 * signable by the pipeline at all).
 */
function readPackedManifest(pkgDir) {
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`${pkgDir} carries no package.json — npm pack cannot run there`)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON (${error.message})`)
  }
  if (typeof manifest.name !== 'string' || !PACKAGE_NAME_PATTERN.test(manifest.name)) {
    throw new Error(`${manifestPath} carries no signable package name (got ${JSON.stringify(manifest.name)})`)
  }
  if (typeof manifest.version !== 'string' || !STABLE_VERSION_PATTERN.test(manifest.version)) {
    throw new Error(`${manifestPath} version must be an exact stable semver X.Y.Z (got ${JSON.stringify(manifest.version)}) — prerelease/build spellings cannot be signed`)
  }
  return { name: manifest.name, version: manifest.version }
}

/**
 * Pack one staged plugin source directory into `outDir` as the deterministic
 * npm-compatible tarball and return the pack record (the allowlist source
 * material). `outDir` is created when missing.
 */
export function packPluginSource({ sourceDir, outDir, log }) {
  const staging = mkdtempSync(join(tmpdir(), 'company-catalog-pack-'))
  try {
    const pkgDir = join(staging, 'pkg')
    stageSourceDirectory(sourceDir, pkgDir)
    return packStagedDirectory({ pkgDir, outDir, log })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Pack an already-staged, already-trusted package directory (shared by both input modes). */
function packStagedDirectory({ pkgDir, outDir, log }) {
  const { name, version } = readPackedManifest(pkgDir)
  mkdirSync(outDir, { recursive: true })
  const report = runNpmPack({ cwd: pkgDir, packDestination: outDir, log })
  const expected = expectedTarballFilename(name, version)
  if (report.filename !== expected) {
    throw new Error(`npm pack produced '${report.filename}' but ${name}@${version} must pack as '${expected}' — the hosting layout pins the filename`)
  }
  const tarballPath = join(outDir, report.filename)
  const { sizeBytes, integrity, fileCount } = normalizeTarballFile(tarballPath)
  if (sizeBytes > TARBALL_MAX_BYTES) {
    throw new Error(`the packed tarball is ${String(sizeBytes)} bytes, over the ${String(TARBALL_MAX_BYTES)}-byte bound`)
  }
  const absolute = resolve(tarballPath)
  const repoRelative = relative(REPO_ROOT, absolute).split('\\').join('/')
  const record = {
    packageName: name,
    version,
    filename: report.filename,
    // The allowlist `source.path` form: repo-relative when inside the repo
    // (the signable spelling), absolute otherwise (informational only).
    path: repoRelative.startsWith('../') ? absolute : repoRelative,
    sizeBytes,
    integrity,
    fileCount,
  }
  writeFileSync(join(outDir, `${report.filename}.pack.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return record
}

/**
 * npm-fetch mode: pull the exact public-registry version, unpack it, run the
 * reviewed patch command inside the unpacked tree, and pack the patched tree.
 * The patch command is operator material (like the signing key): it runs in
 * a shell with the unpacked package as cwd and a nonzero exit fails the pack.
 */
export function packFromNpmSpec({ spec, patchCommand, outDir, log }) {
  const { packageName, version } = parsePackSpec(spec)
  const staging = mkdtempSync(join(tmpdir(), 'company-catalog-pack-npm-'))
  try {
    const fetchDir = join(staging, 'fetch')
    mkdirSync(fetchDir, { recursive: true })
    const report = runNpmPack({ cwd: fetchDir, spec: `${packageName}@${version}`, packDestination: fetchDir, log })
    const fetched = join(fetchDir, report.filename)
    const entries = parseTarball(readFileSync(fetched), `the registry tarball for ${packageName}@${version}`)
    const pkgDir = join(staging, 'pkg')
    extractTarballEntries(entries, pkgDir)
    const manifest = readPackedManifest(pkgDir)
    if (manifest.name !== packageName || manifest.version !== version) {
      throw new Error(`the registry tarball carries ${manifest.name}@${manifest.version}, not the requested ${packageName}@${version}`)
    }
    if (patchCommand !== undefined) {
      const patched = spawnSync(patchCommand, { shell: true, cwd: pkgDir, encoding: 'utf8', timeout: 600_000, env: { ...process.env, COMPANY_CATALOG_PATCH_CWD: pkgDir } })
      if (patched.error !== undefined) throw new Error(`the patch command could not run (${patched.error.message})`)
      if (patched.status !== 0) {
        const detail = `${patched.stdout ?? ''}\n${patched.stderr ?? ''}`.trim().split('\n').slice(-8).join(' | ')
        throw new Error(`the patch command exited ${String(patched.status)}: ${detail.slice(0, 600)}`)
      }
      log(`patch:   ${patchCommand} applied inside ${packageName}@${version}`)
    }
    return packStagedDirectory({ pkgDir, outDir, log })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
