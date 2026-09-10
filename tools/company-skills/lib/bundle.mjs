/**
 * Company skill bundle format (P6 batch 1): directory on disk → validated
 * `{name, description, body, scripts[], assets[]}` document → blob.
 *
 * This module is the single source of truth for the format; `pack.mjs` reads
 * through it and `unpack.mjs` validates through it, so a payload the packer
 * accepts always validates on the way back. Batch 2's container plugin
 * re-implements the same field checks on the decoder side on purpose (the
 * shipped plugin cannot import this tool), and its `list`/`get` behaviour is
 * pinned against these field rules.
 *
 * Directory layout the packer accepts, and nothing else:
 *
 *   <skill-dir>/
 *     SKILL.md        YAML frontmatter (name, description) + body
 *     scripts/**      optional — executable text carried as `scripts[]`
 *     assets/**       optional — every other resource, carried as `assets[]`
 *
 * Paths inside the bundle are always bundle-root-relative POSIX paths
 * (`scripts/run.mjs`, `assets/data.json`), never skill-directory-relative:
 * the batch-2 provider resolves them through an `opaque` resourceBase, so a
 * script that wants its data file writes `assets/data.json`, not
 * `../assets/data.json`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { decodeCanonicalBase64 } from './codec.mjs'

/** The only file a skill directory may carry at its top level. */
export const SKILL_MANIFEST_NAME = 'SKILL.md'

/** Directory names the packer maps onto the two bundle arrays. */
export const SCRIPTS_DIR = 'scripts'
export const ASSETS_DIR = 'assets'

/** Canonical field order of a bundle document; the exact set, no more, no less. */
export const BUNDLE_FIELDS = Object.freeze(['name', 'description', 'body', 'scripts', 'assets'])

/** Canonical field order of one `scripts[]`/`assets[]` entry. */
export const ENTRY_FIELDS = Object.freeze(['path', 'content'])

/**
 * The public skill-name grammar, copied from the runtime registry
 * (`deepseek-harness/packages/skill/skill/src/index.ts`). A bundle whose name
 * fails this can never be registered by the batch-2 provider.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Description bound. The catalog consumer truncates at
 * `catalogDescriptionMaxLength`, default 500
 * (`deepseek-harness/docs/subsystems/skills.md`); the packer refuses to author
 * a description the catalog would silently cut.
 */
export const DESCRIPTION_MAX_LENGTH = 500

/** Largest single carried file (body, one script, or one asset). */
export const FILE_MAX_BYTES = 1024 * 1024

/** Largest canonical bundle JSON document — the unit the blob carries. */
export const BUNDLE_MAX_BYTES = 4 * 1024 * 1024

/** Longest accepted relative path, keeping the resource table addressable. */
export const PATH_MAX_LENGTH = 200

/**
 * References a body or a script may make to a sibling resource. A match must
 * be preceded by a delimiter so prose like `xsassets/y` cannot match, and the
 * path must carry at least one segment after the directory so a bare mention
 * of `scripts/` stays prose.
 */
const REFERENCE_PATTERN = /(?:^|[\s'"`([{=,:])((?:scripts|assets)\/[A-Za-z0-9._@%+~-]+(?:\/[A-Za-z0-9._@%+~-]+)*)/gu

/** Path charset the loader can address; deliberately ASCII-only and URL-safe. */
const PATH_PATTERN = /^[A-Za-z0-9._@%+~/-]+$/u

/** Control characters are not allowed anywhere in the single-line metadata fields. */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u

const invalid = (message) => new Error(`invalid skill bundle: ${message}`)

/** Code-point ordering — the same comparator the skill registry sorts with. */
export function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameKeySet(keys, expected) {
  const actual = [...keys].sort(compareCodePoints)
  const wanted = [...expected].sort(compareCodePoints)
  return actual.length === wanted.length && wanted.every((name, index) => actual[index] === name)
}

/** Decode one entry's base64 content after the shape checks pass. */
function decodeEntryContent(entry, site) {
  const bytes = decodeCanonicalBase64(entry.content, `${site}.content`)
  if (bytes.byteLength > FILE_MAX_BYTES) {
    throw invalid(`${site}.content is ${String(bytes.byteLength)} bytes; the per-file bound is ${String(FILE_MAX_BYTES)}`)
  }
  return bytes
}

/** Validate one `scripts[]`/`assets[]` path, including its required prefix. */
function validateEntryPath(path, site, prefix) {
  if (typeof path !== 'string' || path.length === 0) {
    throw invalid(`${site}.path must be a non-empty bundle-relative POSIX path`)
  }
  if (path.length > PATH_MAX_LENGTH) {
    throw invalid(`${site}.path is longer than the ${String(PATH_MAX_LENGTH)}-character bound`)
  }
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.includes('\\')) {
    throw invalid(`${site}.path must be relative and use forward slashes ("${path}")`)
  }
  if (!PATH_PATTERN.test(path)) {
    throw invalid(`${site}.path carries characters the loader cannot address ("${path}")`)
  }
  if (posix.normalize(path) !== path || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`${site}.path must be a normalized relative path without "." or ".." segments ("${path}")`)
  }
  if (!path.startsWith(`${prefix}/`)) {
    throw invalid(`${site}.path must live under ${prefix}/ ("${path}")`)
  }
}

/** Read one array field, enforcing shape, prefix, uniqueness, and content bounds. */
function validateEntryArray(value, field, prefix) {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of {path, content} entries`)
  const seen = new Set()
  const entries = []
  for (const [index, entry] of value.entries()) {
    const site = `${field}[${String(index)}]`
    if (!isPlainObject(entry)) throw invalid(`${site} must be an object`)
    if (!sameKeySet(Object.keys(entry), ENTRY_FIELDS)) {
      throw invalid(`${site} must carry exactly path and content`)
    }
    validateEntryPath(entry.path, site, prefix)
    if (seen.has(entry.path)) throw invalid(`${site}.path "${entry.path}" duplicates an earlier entry`)
    seen.add(entry.path)
    decodeEntryContent(entry, site)
    entries.push({ path: entry.path, content: entry.content })
  }
  return entries
}

/** Every `scripts/…` / `assets/…` path a text mentions, deduplicated and sorted. */
export function collectReferences(text) {
  const found = new Set()
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    // A sentence-ending period is punctuation, not part of the path.
    found.add(match[1].replace(/\.+$/u, ''))
  }
  return [...found].sort(compareCodePoints)
}

/** Sort entries by path so the canonical document never depends on read order. */
export function sortEntries(entries) {
  return [...entries]
    .sort((left, right) => compareCodePoints(left.path, right.path))
    .map((entry) => ({ path: entry.path, content: entry.content }))
}

/**
 * Rebuild a bundle in canonical field and entry order. Encoding this object
 * is what makes the blob (and therefore the artifact) deterministic.
 * @param {object} bundle - a bundle-shaped object.
 * @returns {object} the canonical bundle.
 */
export function canonicalBundle(bundle) {
  return {
    name: bundle.name,
    description: bundle.description,
    body: bundle.body,
    scripts: sortEntries(bundle.scripts),
    assets: sortEntries(bundle.assets),
  }
}

/** The exact JSON document the blob carries — also the digest subject. */
export function bundlePlaintextJson(bundle) {
  return JSON.stringify(canonicalBundle(bundle))
}

/** `body` plus every script body as text, for the reference scan. */
function referenceScanTargets(bundle) {
  const targets = [['body', bundle.body]]
  for (const script of bundle.scripts) {
    targets.push([`script "${script.path}"`, decodeEntryContent(script, `script "${script.path}"`).toString('utf8')])
  }
  return targets
}

/**
 * Validate a decoded bundle document and return it in canonical order.
 * Throws on the first violation; the message names the offending field so a
 * red CI run points straight at the skill source.
 * @param {unknown} bundle - the candidate document.
 * @returns {object} the canonical bundle.
 */
export function validateBundle(bundle) {
  if (!isPlainObject(bundle)) throw invalid('the document must be an object')
  if (!sameKeySet(Object.keys(bundle), BUNDLE_FIELDS)) {
    throw invalid(`the document must carry exactly ${BUNDLE_FIELDS.join(', ')}`)
  }

  const { name, description, body } = bundle
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw invalid(`name must be kebab-case matching ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got ${JSON.stringify(name)})`)
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw invalid(`${name}: description must be a non-empty string (the catalog index needs it)`)
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw invalid(
      `${name}: description is ${String(description.length)} characters; the catalog bound is `
      + `${String(DESCRIPTION_MAX_LENGTH)} and a longer one would be silently truncated`,
    )
  }
  if (CONTROL_PATTERN.test(description)) throw invalid(`${name}: description must be a single line without control characters`)
  if (description !== description.trim()) throw invalid(`${name}: description must not carry leading or trailing whitespace`)
  if (typeof body !== 'string' || body.length === 0) throw invalid(`${name}: body must be a non-empty string`)
  if (Buffer.byteLength(body, 'utf8') > FILE_MAX_BYTES) {
    throw invalid(`${name}: body exceeds the ${String(FILE_MAX_BYTES)}-byte per-file bound`)
  }

  const scripts = validateEntryArray(bundle.scripts, 'scripts', SCRIPTS_DIR)
  const assets = validateEntryArray(bundle.assets, 'assets', ASSETS_DIR)

  const carried = new Set([...scripts, ...assets].map((entry) => entry.path))
  const canonical = canonicalBundle({ name, description, body, scripts, assets })
  for (const [site, text] of referenceScanTargets(canonical)) {
    for (const reference of collectReferences(text)) {
      if (!carried.has(reference)) {
        throw invalid(`${name}: ${site} references "${reference}", which the bundle does not carry`)
      }
    }
  }

  const json = JSON.stringify(canonical)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > BUNDLE_MAX_BYTES) {
    throw invalid(`${name}: the bundle is ${String(bytes)} bytes; the bound is ${String(BUNDLE_MAX_BYTES)}`)
  }
  return canonical
}

/** Split `key: value` frontmatter lines into a map; unknown keys are ignored. */
function parseFrontmatter(lines, site) {
  const fields = new Map()
  for (const [offset, line] of lines.entries()) {
    const separator = line.indexOf(':')
    if (separator <= 0) throw invalid(`${site} line ${String(offset + 2)} must be a "key: value" pair`)
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (fields.has(key)) throw invalid(`${site} repeats the frontmatter key "${key}"`)
    fields.set(key, value)
  }
  return fields
}

/**
 * Parse one SKILL.md into `{name, description, body}`. `body` is exactly the
 * text after the closing `---` line's newline, so `renderSkillManifest`
 * reconstructs a byte-identical file.
 * @param {string} text - SKILL.md contents.
 * @param {string} [site] - subject for error messages.
 * @returns {{ name: string, description: string, body: string }} the parsed pieces.
 */
export function parseSkillManifest(text, site = SKILL_MANIFEST_NAME) {
  if (typeof text !== 'string' || text.length === 0) {
    throw invalid(`${site} must be a non-empty file`)
  }
  if (text.includes('\r')) throw invalid(`${site} must use LF line endings, not CRLF`)
  if (!text.startsWith('---\n')) {
    throw invalid(`${site} must open with a "---" frontmatter block`)
  }
  const lines = text.split('\n')
  let closing = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      closing = index
      break
    }
  }
  if (closing === -1) throw invalid(`${site} frontmatter is never closed by a "---" line`)
  const fields = parseFrontmatter(lines.slice(1, closing), site)
  if (!fields.has('name')) throw invalid(`${site} frontmatter requires a name`)
  if (!fields.has('description')) throw invalid(`${site} frontmatter requires a description`)
  return {
    name: fields.get('name'),
    description: fields.get('description'),
    body: lines.slice(closing + 1).join('\n'),
  }
}

/** Rebuild the SKILL.md bytes for one bundle (frontmatter regenerated, body verbatim). */
export function renderSkillManifest(bundle) {
  return `---\nname: ${bundle.name}\ndescription: ${bundle.description}\n---\n${bundle.body}`
}

/** Walk a skill directory and hand every carried file's relative path to `collect`. */
function walkSkillDirectory(rootDir, relativeDir, collect) {
  const entries = readdirSync(join(rootDir, relativeDir), { withFileTypes: true })
  for (const entry of entries) {
    const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw invalid(`skill directory entry "${relative}" is a symlink; only regular files are packed`)
    }
    if (entry.isDirectory()) {
      if (relativeDir !== '' || (entry.name !== SCRIPTS_DIR && entry.name !== ASSETS_DIR)) {
        throw invalid(
          `unexpected directory "${relative}" in the skill directory `
          + `(only ${SKILL_MANIFEST_NAME}, ${SCRIPTS_DIR}/, and ${ASSETS_DIR}/ are allowed)`,
        )
      }
      walkSkillDirectory(rootDir, relative, collect)
      continue
    }
    if (!entry.isFile()) throw invalid(`skill directory entry "${relative}" is not a regular file`)
    if (relativeDir === '' && entry.name !== SKILL_MANIFEST_NAME) {
      throw invalid(
        `unexpected file "${relative}" in the skill directory `
        + `(only ${SKILL_MANIFEST_NAME}, ${SCRIPTS_DIR}/, and ${ASSETS_DIR}/ are allowed)`,
      )
    }
    collect(relative)
  }
}

/** Read one carried file as a bundle entry. */
function entryFromFile(rootDir, relative) {
  const bytes = readFileSync(join(rootDir, relative))
  if (bytes.byteLength === 0) throw invalid(`"${relative}" is empty; drop the file instead of shipping it`)
  return { path: relative, content: bytes.toString('base64') }
}

/**
 * Read a skill source directory into a validated canonical bundle.
 * Symlinks, unexpected files, empty files, and unreadable layouts all reject
 * here — nothing outside the declared layout can ride along.
 * @param {string} skillDir - the skill source directory.
 * @returns {object} the canonical bundle.
 */
export function readSkillDirectory(skillDir) {
  if (typeof skillDir !== 'string' || skillDir.length === 0) {
    throw new TypeError('readSkillDirectory expects a skill directory path')
  }
  let manifestSeen = false
  const relativePaths = []
  walkSkillDirectory(skillDir, '', (relative) => {
    if (relative === SKILL_MANIFEST_NAME) {
      manifestSeen = true
      return
    }
    relativePaths.push(relative)
  })
  if (!manifestSeen) throw invalid(`${skillDir} carries no ${SKILL_MANIFEST_NAME}`)

  const manifest = parseSkillManifest(readFileSync(join(skillDir, SKILL_MANIFEST_NAME), 'utf8'))
  const scripts = []
  const assets = []
  for (const relative of sortEntries(relativePaths.map((path) => ({ path })))) {
    const entry = entryFromFile(skillDir, relative.path)
    if (relative.path.startsWith(`${SCRIPTS_DIR}/`)) scripts.push(entry)
    else if (relative.path.startsWith(`${ASSETS_DIR}/`)) assets.push(entry)
    else throw invalid(`unexpected file "${relative.path}" in the skill directory`)
  }

  return validateBundle({
    name: manifest.name,
    description: manifest.description,
    body: manifest.body,
    scripts,
    assets,
  })
}

/**
 * Expand a bundle into the files `unpack.mjs` writes: SKILL.md plus every
 * carried entry, in path order.
 * @param {object} bundle - a validated bundle.
 * @returns {{ path: string, bytes: Buffer }[]} the materialized files.
 */
export function bundleSourceFiles(bundle) {
  const files = [{ path: SKILL_MANIFEST_NAME, bytes: Buffer.from(renderSkillManifest(bundle), 'utf8') }]
  for (const entry of sortEntries([...bundle.scripts, ...bundle.assets])) {
    files.push({ path: entry.path, bytes: decodeCanonicalBase64(entry.content, entry.path) })
  }
  return files
}
