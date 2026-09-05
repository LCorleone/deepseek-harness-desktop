/**
 * Beta tester roster state (P9).
 *
 * The signed roster lives in the beta manifest's top-level `testers` array;
 * this module is the pipeline-side source of that array — the state file
 * `state/beta-testers.json` — so roster changes re-sign one file instead of
 * shipping a client release. The initial roster is the user-named first
 * test group (2026-09-05); a missing state file means exactly that initial
 * roster until the first explicit write materializes the file.
 *
 * Normalization is deliberate and one-way: every admitted address is
 * lowercased and trimmed (the desktop's SSO identity comparison normalizes
 * both sides the same way — see
 * dsh-plugin-desktop/src/beta-channel.ts). Non-email shapes are hard
 * errors, never silent drops: a roster the pipeline cannot trust must not
 * reach a signed manifest.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const BETA_TESTERS_FILE_NAME = 'beta-testers.json'

/** The user-named first test group (2026-09-05): the roster a missing state file means. */
export const INITIAL_BETA_TESTERS = [
  'julu@deloittecn.com.cn',
  'sebtang@deloittecn.com.cn',
  'lizywu@deloittecn.com.cn',
]

/** Email shape admitted to the roster: one `@`, no whitespace, a dotted domain (mirrors the desktop verifier). */
export const BETA_TESTER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const MAX_BETA_TESTERS = 1_000
const MAX_BETA_TESTER_EMAIL_LENGTH = 254

/** Validate and normalize one roster address; returns undefined when unusable. */
export function normalizeBetaTesterEmail(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_BETA_TESTER_EMAIL_LENGTH) return undefined
  return BETA_TESTER_EMAIL_PATTERN.test(trimmed) ? trimmed : undefined
}

/** State-file path of the roster under a state directory. */
export const betaTestersPath = (stateDir) => join(stateDir, BETA_TESTERS_FILE_NAME)

/** Validate a full roster list (normalized, unique); throws on any unusable entry. */
function validateRoster(list, label) {
  if (!Array.isArray(list)) throw new Error(`${label} must be an array of email addresses`)
  if (list.length > MAX_BETA_TESTERS) throw new Error(`${label} must carry at most ${String(MAX_BETA_TESTERS)} addresses`)
  const normalized = []
  const seen = new Set()
  for (const entry of list) {
    const email = normalizeBetaTesterEmail(entry)
    if (email === undefined) {
      throw new Error(`${label}: ${JSON.stringify(entry)} is not a usable email address — fix or remove it before publishing`)
    }
    if (seen.has(email)) throw new Error(`${label} must not repeat ${email}`)
    seen.add(email)
    normalized.push(email)
  }
  return normalized
}

/**
 * Read the roster: `{ testers, existed, path }`. A missing file means the
 * initial first test group (`existed: false`); anything unreadable or
 * invalid is a hard error — roster state is signed material, never guessed.
 */
export function loadBetaTesters(stateDir) {
  const path = betaTestersPath(stateDir)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { testers: [...INITIAL_BETA_TESTERS], existed: false, path }
    }
    throw new Error(`beta roster ${path} is not readable (${error.message})`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`beta roster ${path} is not valid JSON (${error.message}) — restore it; the roster is signed material`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`beta roster ${path} must be an object with a testers array`)
  }
  const unknown = Object.keys(parsed).filter((key) => key !== 'testers' && key !== 'updatedAt')
  if (unknown.length > 0) throw new Error(`beta roster ${path} has unknown field(s) ${unknown.join(', ')}`)
  return { testers: validateRoster(parsed.testers, `beta roster ${path}`), existed: true, path }
}

/** Persist the roster (normalized on write; `updatedAt` for audit). */
export function saveBetaTesters(stateDir, testers) {
  const normalized = validateRoster(testers, 'the beta roster')
  mkdirSync(stateDir, { recursive: true })
  const path = betaTestersPath(stateDir)
  writeFileSync(path, `${JSON.stringify({ testers: normalized, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return { path, testers: normalized }
}

/**
 * Apply one `beta-roster` change set: `{ testers, changed }`. Adds and
 * removes normalize exactly like stored addresses; `changed` is false when
 * the operation is a no-op (the address was already absent/present), which
 * the caller uses to skip the re-sign entirely — a roster that did not
 * change must not consume a sequence.
 */
export function applyBetaRosterChanges(current, { add, remove }) {
  const before = validateRoster(current, 'the current beta roster')
  const additions = add === undefined ? [] : [add]
  const removals = remove === undefined ? [] : [remove]
  for (const email of [...additions, ...removals]) {
    if (normalizeBetaTesterEmail(email) === undefined) {
      throw new Error(`${JSON.stringify(email)} is not a usable email address (lowercase corporate SSO addresses; no wildcards)`)
    }
  }
  const set = new Set(before)
  let changed = false
  for (const email of additions) {
    const normalized = normalizeBetaTesterEmail(email)
    if (!set.has(normalized)) {
      set.add(normalized)
      changed = true
    }
  }
  for (const email of removals) {
    const normalized = normalizeBetaTesterEmail(email)
    if (set.delete(normalized)) changed = true
  }
  return { testers: [...set], changed }
}
