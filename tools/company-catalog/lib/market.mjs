/**
 * Resolve the `dsh-community-market` signing library (P2-1) used by every
 * pipeline stage: canonical JSON serialization, detached ed25519 signing,
 * full manifest verification, and the repository identity contract the build
 * applies to every resolved repository before signing it. The tool itself
 * has no dependencies beyond Node built-ins; the market package provides the
 * crypto and identity contracts.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REQUIRED_EXPORTS = [
  'canonicalJsonText',
  'createCompanyManifestSignature',
  'ed25519PublicKeyFingerprint',
  'findCompanyManifestPackage',
  'normalizeRepositoryIdentity',
  'verifyCompanyManifest',
]

/** Built workspace entry, used when the root linker has not exposed the package. */
const WORKSPACE_ENTRY = new URL('../../../dsh-community-market/lib/index.js', import.meta.url)
const isModuleNotFound = (error) =>
  error instanceof Error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')

/**
 * Load the market signing library. The preferred path is the bare
 * `dsh-community-market` specifier resolved through the root `node_modules`
 * (Yarn node-modules linker); when hoisting limits keep workspace packages
 * out of the root, fall back to the built workspace entry directly.
 */
export async function loadMarketLibrary() {
  let market
  try {
    market = await import('dsh-community-market')
  } catch (error) {
    if (!isModuleNotFound(error)) throw error
    const entryPath = fileURLToPath(WORKSPACE_ENTRY)
    if (!existsSync(entryPath)) {
      throw new Error(
        'the market signing library is unavailable: \'dsh-community-market\' is not resolvable from the root ' +
        `and ${entryPath} does not exist — run 'corepack yarn workspace dsh-community-market build' first`,
      )
    }
    market = await import(WORKSPACE_ENTRY.href)
  }
  const missing = REQUIRED_EXPORTS.filter((name) => typeof market[name] !== 'function')
  if (missing.length > 0) {
    throw new Error(`dsh-community-market does not export ${missing.join(', ')}; rebuild the market workspace`)
  }
  return market
}

/**
 * The node-semver `validRange` checker, resolved from the market workspace's
 * own dependency tree (the tool itself is dependency-free; the semver grammar
 * belongs to the market contract, so its checker is borrowed from there).
 * The manifest-shape mirror needs it to validate runtime ranges exactly the
 * way the market verifier does.
 */
export async function loadSemverRangeChecker() {
  const { createRequire } = await import('node:module')
  const require = createRequire(WORKSPACE_ENTRY)
  try {
    const semver = require('semver')
    if (typeof semver.validRange !== 'function') throw new Error('semver.validRange is unavailable')
    return semver.validRange
  } catch (error) {
    throw new Error(
      `the node-semver checker could not be resolved from the market workspace (${error.message}) — ` +
      "run 'corepack yarn install' and build the market workspace first",
    )
  }
}
