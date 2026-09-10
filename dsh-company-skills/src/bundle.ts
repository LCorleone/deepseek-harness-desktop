/**
 * One company skill bundle (P6 batch 2): the shape `tools/company-skills`
 * packs and this plugin decodes.
 *
 * The field rules are a deliberate re-implementation of
 * `tools/company-skills/lib/bundle.mjs`; the plugin cannot import that tool,
 * and `tests/container.spec.ts` pins the two implementations against each
 * other (the same packed bytes must decode to the same canonical document
 * here). Kept identical:
 *
 *  - the exact top-level field set `{name, description, body, scripts, assets}`;
 *  - the exact entry field set `{path, content}`;
 *  - the kebab-case name grammar shared with the runtime registry;
 *  - the 500-character description bound, which is the catalog truncation
 *    bound (`catalogDescriptionMaxLength`), so an index entry is never
 *    silently cut;
 *  - the per-file (1 MiB) and whole-document (4 MiB) byte bounds;
 *  - bundle-root-relative POSIX entry paths, which is the addressing
 *    `resourceBase: { kind: 'opaque' }` implies (a script reads
 *    `assets/data.json`, never `../assets/data.json`).
 *
 * Deliberately NOT re-checked here: the packed-reference closure (every
 * `scripts/…`/`assets/…` literal a body or script mentions must be carried).
 * That is an authoring invariant the packer enforces before the blob is
 * written; re-deriving it at runtime would only add a second place for the
 * two implementations to disagree, and a missed reference is a batch-3
 * execution-time concern, not a catalog one.
 */

import { decodeCanonicalBase64 } from './codec.js'

/** The public skill-name grammar, shared with the runtime registry. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Description bound: the catalog's `catalogDescriptionMaxLength` default. */
export const DESCRIPTION_MAX_LENGTH = 500

/** Largest single carried file (body, one script, or one asset). */
export const FILE_MAX_BYTES = 1024 * 1024

/** Largest canonical bundle JSON document — the unit a container element carries. */
export const BUNDLE_MAX_BYTES = 4 * 1024 * 1024

/** Longest accepted relative entry path. */
export const PATH_MAX_LENGTH = 200

/** Directory prefix every `scripts[]` entry must carry. */
export const SCRIPTS_DIR = 'scripts'

/** Directory prefix every `assets[]` entry must carry. */
export const ASSETS_DIR = 'assets'

/** Canonical fields of one bundle element, in document order. */
export const BUNDLE_FIELDS = Object.freeze(['name', 'description', 'body', 'scripts', 'assets'])

/** Canonical fields of one `scripts[]`/`assets[]` entry, in document order. */
export const ENTRY_FIELDS = Object.freeze(['path', 'content'])

/** One carried script or asset, base64-encoded. */
export interface SkillBundleEntry {
  /** Bundle-root-relative POSIX path, e.g. `scripts/run.mjs`. */
  readonly path: string
  /** Canonical standard base64 of the file bytes. */
  readonly content: string
}

/** One complete skill carried by the container. */
export interface SkillBundle {
  readonly name: string
  readonly description: string
  /** Markdown body, exactly the bytes after the `SKILL.md` frontmatter. */
  readonly body: string
  readonly scripts: readonly SkillBundleEntry[]
  readonly assets: readonly SkillBundleEntry[]
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u
const PATH_PATTERN = /^[A-Za-z0-9._@%+~/-]+$/u

const invalid = (message: string): Error => new Error(`invalid skill bundle: ${message}`)

/** Code-point ordering — the comparator the skill registry sorts with. */
export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameKeySet(keys: readonly string[], expected: readonly string[]): boolean {
  const actual = [...keys].sort(compareCodePoints)
  const wanted = [...expected].sort(compareCodePoints)
  return actual.length === wanted.length && wanted.every((name, index) => actual[index] === name)
}

/** Decode one entry's content after its shape checks pass. */
function decodeEntryContent(entry: SkillBundleEntry, site: string): Buffer {
  const bytes = decodeCanonicalBase64(entry.content, `${site}.content`)
  if (bytes.byteLength > FILE_MAX_BYTES) {
    throw invalid(`${site}.content is ${String(bytes.byteLength)} bytes; the per-file bound is ${String(FILE_MAX_BYTES)}`)
  }
  return bytes
}

/** Validate one `scripts[]`/`assets[]` entry path, including its required prefix. */
function validateEntryPath(path: unknown, site: string, prefix: string): string {
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
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw invalid(`${site}.path must be a normalized relative path without "." or ".." segments ("${path}")`)
  }
  if (!path.startsWith(`${prefix}/`)) {
    throw invalid(`${site}.path must live under ${prefix}/ ("${path}")`)
  }
  return path
}

/** Read one array field, enforcing shape, prefix, uniqueness, and content bounds. */
function validateEntryArray(value: unknown, field: string, prefix: string): SkillBundleEntry[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of {path, content} entries`)
  const seen = new Set<string>()
  const entries: SkillBundleEntry[] = []
  for (const [index, candidate] of value.entries()) {
    const site = `${field}[${String(index)}]`
    if (!isPlainObject(candidate)) throw invalid(`${site} must be an object`)
    if (!sameKeySet(Object.keys(candidate), ENTRY_FIELDS)) {
      throw invalid(`${site} must carry exactly path and content`)
    }
    const path = validateEntryPath(candidate.path, site, prefix)
    if (seen.has(path)) throw invalid(`${site}.path "${path}" duplicates an earlier entry`)
    seen.add(path)
    const content = candidate.content
    if (typeof content !== 'string') throw invalid(`${site}.content must be a base64 string`)
    const entry = { path, content }
    decodeEntryContent(entry, site)
    entries.push(entry)
  }
  return entries
}

/** Sort entries by path so a decoded document never depends on element order. */
export function sortEntries(entries: readonly SkillBundleEntry[]): SkillBundleEntry[] {
  return [...entries]
    .sort((left, right) => compareCodePoints(left.path, right.path))
    .map((entry) => ({ path: entry.path, content: entry.content }))
}

/**
 * Validate one container element and return it in canonical field and entry
 * order. This is the only path that reads a body, so `list()` stays
 * index-only; it throws on the first violation and names the offending field.
 * @param document - the candidate element.
 * @returns the canonical bundle.
 */
export function validateSkillBundle(document: unknown): SkillBundle {
  if (!isPlainObject(document)) throw invalid('the document must be an object')
  if (!sameKeySet(Object.keys(document), BUNDLE_FIELDS)) {
    throw invalid(`the document must carry exactly ${BUNDLE_FIELDS.join(', ')}`)
  }

  const { name, description, body } = document
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

  const scripts = validateEntryArray(document.scripts, 'scripts', SCRIPTS_DIR)
  const assets = validateEntryArray(document.assets, 'assets', ASSETS_DIR)
  const canonical: SkillBundle = {
    name,
    description,
    body,
    scripts: sortEntries(scripts),
    assets: sortEntries(assets),
  }

  const bytes = Buffer.byteLength(JSON.stringify(canonical), 'utf8')
  if (bytes > BUNDLE_MAX_BYTES) {
    throw invalid(`${name}: the bundle is ${String(bytes)} bytes; the bound is ${String(BUNDLE_MAX_BYTES)}`)
  }
  return canonical
}
