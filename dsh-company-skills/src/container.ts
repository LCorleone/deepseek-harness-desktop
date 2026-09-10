/**
 * The container document (P6 batch 2): one plugin ships many skills.
 *
 * Wire format, confirmed by the product owner on 2026-09-10 and written by the
 * batch-1.5 packer (`tools/company-skills/pack.mjs --skills <root>`), carried
 * as a single XOR+base64 block in `assets/skills.bundle`:
 *
 *   {"version":1,"skills":[{"name":…,"description":…,"body":…,
 *                            "scripts":[…],"assets":[…]}, …]}
 *
 * Every element is exactly one `tools/company-skills` bundle (see
 * `bundle.ts`), so authoring stays per-skill and this file only adds the outer
 * frame. The frame rules mirror the writer's `validateContainer` exactly:
 * version 1, exactly `version` and `skills`, at least one skill, names unique
 * across the container, and a 128 MiB (2 × the per-skill 64 MiB) document
 * bound — the first real container (ppt-designer + skill-creator) measures
 * ≈ 43 MiB.
 *
 * The split with the writer is deliberate: the tool validates every element
 * eagerly because it is checking an artifact before it ships, while this
 * runtime validates an element's *index* fields at load and leaves the body,
 * scripts, and assets to `validateSkillBundle` on `get()`. That is what
 * `list()` needs and nothing more. The bytes are already in memory once the
 * one XOR block is decoded (a single block is indivisible), so "on demand"
 * here means *materialized on demand*: no body, script, or asset is parsed,
 * validated, or handed to the registry until a caller asks for that exact
 * skill, and a broken payload in one skill cannot empty the whole catalog.
 *
 * Version 1 is the only accepted version: a future frame bumps this number,
 * and an older plugin then degrades to an empty catalog instead of misreading
 * it.
 */

import {
  BUNDLE_FIELDS,
  BUNDLE_MAX_BYTES,
  DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_PATTERN,
  compareCodePoints,
} from './bundle.js'
import { decodeBundleBlob, extractBundleBlob } from './codec.js'

/** The only accepted container version. */
export const CONTAINER_VERSION = 1

/** Canonical fields of the container document, in order. */
export const CONTAINER_FIELDS = Object.freeze(['version', 'skills'])

/** Largest accepted container document, bytes of canonical JSON; 2 × the per-skill bound. */
export const CONTAINER_MAX_BYTES = 2 * BUNDLE_MAX_BYTES

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u

const invalid = (message: string): Error => new Error(`invalid skill container: ${message}`)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameKeySet(keys: readonly string[], expected: readonly string[]): boolean {
  const actual = [...keys].sort(compareCodePoints)
  const wanted = [...expected].sort(compareCodePoints)
  return actual.length === wanted.length && wanted.every((name, index) => actual[index] === name)
}

/**
 * One container element whose name and description are already validated and
 * whose payload fields are deliberately still `unknown`: only `get()` decodes
 * them.
 */
export interface SkillElementIndex {
  readonly name: string
  readonly description: string
  /** Untouched element, validated by `validateSkillBundle` on demand. */
  readonly element: Record<string, unknown>
}

/**
 * Validate one element's index fields. A body, script, or asset is never
 * inspected here: an element with a broken payload still lists, and fails
 * loudly at `get()` instead of emptying the whole catalog.
 * @param value - the candidate element.
 * @param site - subject for error messages.
 * @returns the validated index entry.
 */
function validateElementIndex(value: unknown, site: string): SkillElementIndex {
  if (!isPlainObject(value)) throw invalid(`${site} must be an object`)
  if (!sameKeySet(Object.keys(value), BUNDLE_FIELDS)) {
    throw invalid(`${site} must carry exactly ${BUNDLE_FIELDS.join(', ')}`)
  }
  const { name, description } = value
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw invalid(`${site}.name must be kebab-case matching ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got ${JSON.stringify(name)})`)
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw invalid(`${site}.description must be a non-empty string (the catalog index needs it)`)
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw invalid(
      `${site}.description is ${String(description.length)} characters; the catalog bound is `
      + `${String(DESCRIPTION_MAX_LENGTH)} and a longer one would be silently truncated`,
    )
  }
  if (CONTROL_PATTERN.test(description) || description !== description.trim()) {
    throw invalid(`${site}.description must be a single trimmed line without control characters`)
  }
  return { name, description, element: value }
}

/**
 * Parse one canonical container JSON document into per-skill index entries.
 *
 * A duplicate name is rejected outright rather than resolved first-wins: the
 * catalog is authored, not user data, so a duplicate is a packaging bug that
 * must fail the load loudly instead of silently hiding one skill. (The writer
 * rejects it too, so a duplicate can only appear in a hand-edited or corrupt
 * asset.)
 * @param document - the candidate document.
 * @returns the validated index entries, in document order.
 */
export function parseContainer(document: unknown): SkillElementIndex[] {
  if (!isPlainObject(document)) throw invalid('the document must be an object')
  if (!sameKeySet(Object.keys(document), CONTAINER_FIELDS)) {
    throw invalid(`the document must carry exactly ${CONTAINER_FIELDS.join(', ')}`)
  }
  if (document.version !== CONTAINER_VERSION) {
    throw invalid(`version must be ${String(CONTAINER_VERSION)} (got ${JSON.stringify(document.version)})`)
  }
  const skills = document.skills
  if (!Array.isArray(skills)) throw invalid('skills must be an array of skill bundles')
  if (skills.length === 0) throw invalid('skills must carry at least one skill; an empty container ships nothing')
  const entries = skills.map((value, index) => validateElementIndex(value, `skills[${String(index)}]`))
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.name)) throw invalid(`skills repeats the name "${entry.name}"`)
    seen.add(entry.name)
  }
  const bytes = Buffer.byteLength(JSON.stringify(document), 'utf8')
  if (bytes > CONTAINER_MAX_BYTES) {
    throw invalid(`the container is ${String(bytes)} bytes; the bound is ${String(CONTAINER_MAX_BYTES)}`)
  }
  return entries
}

/**
 * Decode one shipped asset — raw base64 blob or a generated module — into
 * per-skill index entries.
 * @param text - the asset file contents.
 * @returns the validated index entries.
 */
export function decodeContainer(text: string): SkillElementIndex[] {
  return parseContainer(JSON.parse(decodeBundleBlob(extractBundleBlob(text), 'company skills container')))
}
