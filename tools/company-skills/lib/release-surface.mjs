/**
 * Release-surface guard for the P6 batch-1 tools: `unpack.mjs` is an author
 * self-check/verifier and must never reach a shipped artifact.
 *
 * "Never reaches" is enforced by inspecting the one mechanism that decides
 * what a plugin tarball carries — the `package.json` `files` whitelist (plus
 * `bin`, which also publishes a file verbatim). For every package in the
 * repository, every `unpack.mjs` inside that package's directory is matched
 * against the whitelist: a literal entry, a directory entry, or any glob that
 * would sweep it in counts as a violation.
 *
 * The npm `files` semantics implemented here are the subset that can leak an
 * `unpack.mjs`: bare names, relative paths, and directory prefixes include
 * everything beneath them; `*`, `?`, and `**` globs are expanded the way npm
 * documents them. The npm always-included set (`package.json`, `README*`,
 * `LICENSE*`, the `main` file) cannot name an `unpack.mjs`, so it is out of
 * scope on purpose.
 *
 * A second, coarser rule covers the layout mistake that makes the first rule
 * possible: a directory holding an `unpack.mjs` must not carry a
 * `package.json` at all. That is exactly why `tools/company-skills/` (like
 * `tools/company-catalog/`) is not a workspace and has no manifest.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** Directory names never walked: dependencies, build output, and the upstream submodule. */
const PRUNED_DIRECTORIES = new Set([
  '.git',
  '.yarn',
  '.build',
  'node_modules',
  'dist',
  'lib',
  'out',
  'deepseek-harness',
])

/** The basename this guard exists for. */
export const FORBIDDEN_ARTIFACT_BASENAME = 'unpack.mjs'

/** One glob token → its path-regex fragment; applied in a single pass so a
 * fragment is never rescanned as a glob. */
const GLOB_TOKENS = Object.freeze({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })

/**
 * Translate one npm `files` entry into a predicate over package-relative
 * POSIX paths.
 * @param {string} pattern - one raw `files`/`bin` entry.
 * @returns {(path: string) => boolean} whether the entry publishes that path.
 */
export function filesEntryMatcher(pattern) {
  const normalized = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (normalized === '') return () => false
  if (pattern.includes('*') || pattern.includes('?')) {
    const escaped = normalized.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    const translated = escaped.replace(/\*\*\/|\*\*|\*|\?/gu, (token) => GLOB_TOKENS[token])
    const regex = new RegExp(`^${translated}$`, 'u')
    return (path) => regex.test(path)
  }
  // A literal entry publishes the path itself and everything under a directory of that name.
  return (path) => path === normalized || path.startsWith(`${normalized}/`)
}

/**
 * Recursively list files under `root`, skipping dependency and build trees.
 * @param {string} root - absolute directory to walk.
 * @returns {string[]} absolute file paths.
 */
export function walkFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!PRUNED_DIRECTORIES.has(entry.name)) visit(path)
        continue
      }
      if (entry.isFile()) files.push(path)
    }
  }
  visit(root)
  return files
}

/** Read every `package.json` under `root` without walking pruned trees. */
function readPackageJsons(root) {
  const manifests = []
  for (const path of walkFiles(root)) {
    if (path.slice(-'/package.json'.length) !== '/package.json') continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`${relative(root, path)} is not readable JSON (${error.message})`)
    }
    manifests.push({ path, manifest })
  }
  return manifests
}

/** Every path a package publishes by whitelist. `bin` names a file verbatim. */
function publishedEntries(manifest) {
  const entries = []
  if (Array.isArray(manifest.files)) {
    for (const entry of manifest.files) if (typeof entry === 'string') entries.push(entry)
  }
  if (typeof manifest.bin === 'string') entries.push(manifest.bin)
  if (typeof manifest.bin === 'object' && manifest.bin !== null) {
    for (const value of Object.values(manifest.bin)) if (typeof value === 'string') entries.push(value)
  }
  return entries
}

/**
 * Find every way an `unpack.mjs` could ride into a published artifact under
 * `root`.
 * @param {string} root - repository root to audit.
 * @returns {{ file: string, kind: string, detail: string }[]} violations, empty when clean.
 */
export function findUnpackPublishViolations(root) {
  const absoluteRoot = resolve(root)
  const unpackFiles = walkFiles(absoluteRoot).filter((path) => path.endsWith(`/${FORBIDDEN_ARTIFACT_BASENAME}`))
  const violations = []

  for (const unpackPath of unpackFiles) {
    const directory = resolve(unpackPath, '..')
    if (walkFiles(directory).some((path) => path === join(directory, 'package.json'))) {
      violations.push({
        file: relative(absoluteRoot, unpackPath),
        kind: 'package-directory',
        detail: 'an unpack.mjs must not live in a directory that carries a package.json',
      })
    }
  }

  for (const { path, manifest } of readPackageJsons(absoluteRoot)) {
    const directory = resolve(path, '..')
    const published = publishedEntries(manifest)
    for (const unpackPath of unpackFiles) {
      if (!unpackPath.startsWith(`${directory}/`)) continue
      const relativePath = relative(directory, unpackPath).split('\\').join('/')
      for (const entry of published) {
        if (!filesEntryMatcher(entry)(relativePath)) continue
        violations.push({
          file: relative(absoluteRoot, path),
          kind: 'files',
          detail: `the published entry "${entry}" would ship ${relativePath}`,
        })
        break
      }
    }
  }

  return violations
}
