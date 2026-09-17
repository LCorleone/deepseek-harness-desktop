/**
 * Resolve the `dsh-community-market` signing library used by the guardrail
 * prompt-document pipeline: canonical JSON serialization, detached ed25519
 * signing, and the trust-root key fingerprint — the same contracts the
 * desktop's sibling-document verifier applies. The tool itself has no
 * dependencies beyond Node built-ins; the market package provides the
 * crypto contracts (same loader discipline as tools/company-catalog).
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REQUIRED_EXPORTS = [
  'canonicalJsonText',
  'createCompanyManifestSignature',
  'ed25519PublicKeyFingerprint',
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
