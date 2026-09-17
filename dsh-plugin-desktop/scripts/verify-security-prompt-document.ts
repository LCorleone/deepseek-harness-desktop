/**
 * Desktop-side verification seam for the #046 security-prompt publishing
 * pipeline (`tools/company-guardrail/sign-prompt-document.mjs` and
 * `upload-prompt-document.mjs`).
 *
 * The publishing tools are plain-Node scripts under `tools/` (the
 * company-catalog CLI convention: no build step of their own), while the
 * document verifier the FLEET actually runs —
 * `verifyDesktopSecurityPromptDocument` in `src/company-guardrail.ts` — is
 * TypeScript inside the desktop workspace. A direct `tools/ → src/*.ts`
 * import is not executable: plain Node's type stripping is strip-only and
 * the desktop source graph uses parameter properties, so the import fails
 * with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX (verified empirically), and the
 * tools convention keeps tools dependent on nothing beyond Node built-ins
 * and the built market workspace anyway. This script is the compliant seam:
 * it lives INSIDE the desktop workspace (importing the client verifier is
 * its native direction, exactly like `scripts/bundled-python-wheels.ts`
 * being both a script and an importable module) and is executed by the
 * tools through
 *
 *   node --experimental-transform-types dsh-plugin-desktop/scripts/verify-security-prompt-document.ts
 *
 * which CAN load the desktop source graph. The tools therefore re-verify
 * their signed bytes with the client's ACTUAL verifier — never a fork — and
 * a byte-shape drift between signer and fleet verifier becomes a hard
 * pipeline failure instead of a fleet-wide rejection.
 *
 * Exports only pure helpers (no side effects at import time); the CLI below
 * runs only when the file is executed directly. Output discipline mirrors
 * the client's: verdicts carry categories, revisions, key ids, and
 * fingerprints — never template text.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CompanyManifestTrustRoot } from 'dsh-community-market'
import {
  verifyDesktopSecurityPromptDocument,
  type DesktopSecurityPromptVerification,
} from '../src/company-guardrail.ts'

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** The fleet's trust decision: the release policy pinned into the desktop package. */
export const DEFAULT_TRUST_ROOTS_PATH = resolve(PACKAGE_ROOT, '..', 'src', 'policy', 'desktop-policy.release.json')

/** Hard cap on a document file this seam reads (the client's COMPANY_SECURITY_PROMPT_MAX_BYTES). */
const MAX_DOCUMENT_BYTES = 64 * 1024
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/**
 * Validate one trust-root entry: exactly `keyId` + `fingerprint`, both
 * well-formed (the same shapes publish-local.mjs pins against the desktop
 * release policy).
 */
function parseTrustRoot(value: unknown): CompanyManifestTrustRoot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('a trust root must be an object with keyId and fingerprint')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'fingerprint' || keys[1] !== 'keyId') {
    throw new Error('a trust root must carry exactly keyId and fingerprint')
  }
  if (typeof record.keyId !== 'string' || !KEY_ID_PATTERN.test(record.keyId)) {
    throw new Error(`trust root keyId '${String(record.keyId)}' must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`)
  }
  if (typeof record.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(record.fingerprint)) {
    throw new Error('a trust root fingerprint must be 64 lowercase hex characters')
  }
  return { keyId: record.keyId, fingerprint: record.fingerprint }
}

/**
 * Parse trust roots from a parsed JSON value: either a bare array of
 * `{keyId, fingerprint}` roots or a desktop-policy-shaped object carrying
 * `trustRoots` (the release policy file's own shape).
 */
export function parseSecurityPromptTrustRootsJson(value: unknown, what: string): readonly CompanyManifestTrustRoot[] {
  const roots = Array.isArray(value) ? value : (value as { trustRoots?: unknown } | null)?.trustRoots
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error(`${what} carries no trustRoots — cannot confirm the fleet would accept a document`)
  }
  return roots.map((entry, index) => {
    try {
      return parseTrustRoot(entry)
    } catch (cause) {
      throw new Error(`${what} trust root ${String(index)} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  })
}

/** Read trust roots from a JSON file (bare array or desktop-policy shape). */
export function loadSecurityPromptTrustRoots(path: string): readonly CompanyManifestTrustRoot[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new Error(`the trust-root file ${path} could not be read (${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message})`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`the trust-root file ${path} is not valid JSON (${(cause as Error).message})`)
  }
  return parseSecurityPromptTrustRootsJson(parsed, path)
}

/**
 * Verify document text with the client's actual verifier. A thin, exports-
 * only delegation: the pipeline tools call the CLI below, desktop-side
 * callers may import this function directly.
 */
export function verifySecurityPromptDocumentText(
  text: string | Uint8Array,
  trustRoots: readonly CompanyManifestTrustRoot[],
  options: { lastAcceptedRevision?: number, now?: () => number } = {},
): DesktopSecurityPromptVerification {
  return verifyDesktopSecurityPromptDocument(text, { trustRoots, ...options })
}

/** Read a document file under the client's byte bound. */
function readDocumentFile(path: string): Buffer {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`${path} is not a file`)
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`${path} is ${String(stat.size)} bytes, over the ${String(MAX_DOCUMENT_BYTES)}-byte document bound`)
  }
  return readFileSync(path)
}

/** Minimal hand-rolled parser: `--flag value` / `--flag=value`, no positionals. */
function parseArgs(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  const valueFlags = new Set(['file', 'trust-roots', 'floor'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith('--')) throw new Error(`unexpected argument '${argument}'`)
    const equals = argument.indexOf('=')
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
    if (!valueFlags.has(name)) throw new Error(`--${name} is not a recognized flag`)
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1)
    if (value === undefined) throw new Error(`--${name} requires a value`)
    if (equals === -1) index += 1
    flags[name] = value
  }
  return flags
}

function printUsage(): number {
  console.log(`Usage: node --experimental-transform-types dsh-plugin-desktop/scripts/verify-security-prompt-document.ts [options]

Verify a signed security-prompt document (security-prompt.json / security-prompt.beta.json)
with the desktop client's actual verifier (src/company-guardrail.ts).

Options:
  --file <path>        Document file to verify (required)
  --trust-roots <json> Trust roots as a JSON file: either a bare
                       [{keyId, fingerprint}] array or a desktop-policy
                       object carrying trustRoots (default: the committed
                       release policy, resolved inside this package)
  --floor <n>          Anti-rollback floor: the last accepted revision; a
                       document below it refuses with stale-revision
                       (default: 0)

Prints a one-line JSON verdict and exits 0 when the document verifies, 1
when it is refused, 2 on usage errors. Verdicts never contain the template
text (categories, revisions, key ids, and fingerprints only).`)
  return 2
}

/** CLI entry: exits 0/1/2. Runs only when executed directly. */
async function main(): Promise<number> {
  const [fileArgument, ...rest] = process.argv.slice(2)
  if (fileArgument === undefined || fileArgument === 'help' || fileArgument === '--help' || fileArgument === '-h') {
    return printUsage()
  }
  if (!fileArgument.startsWith('--')) return printUsage()
  let flags: Record<string, string>
  try {
    flags = parseArgs([fileArgument, ...rest])
  } catch (cause) {
    console.error(`verify-security-prompt-document: ${cause instanceof Error ? cause.message : String(cause)}`)
    return 2
  }
  if (flags.file === undefined) return printUsage()
  const documentPath = isAbsolute(flags.file) ? flags.file : resolve(process.cwd(), flags.file)
  const trustRootsPath = flags['trust-roots'] === undefined
    ? DEFAULT_TRUST_ROOTS_PATH
    : (isAbsolute(flags['trust-roots']) ? flags['trust-roots'] : resolve(process.cwd(), flags['trust-roots']))
  let floor = 0
  if (flags.floor !== undefined) {
    floor = Number.parseInt(flags.floor, 10)
    if (!Number.isSafeInteger(floor) || floor < 0 || String(floor) !== flags.floor) {
      console.error(`verify-security-prompt-document: --floor must be a non-negative integer (got '${flags.floor}')`)
      return 2
    }
  }
  let bytes: Buffer
  try {
    bytes = readDocumentFile(documentPath)
  } catch (cause) {
    console.error(`verify-security-prompt-document: ${cause instanceof Error ? cause.message : String(cause)}`)
    return 2
  }
  let trustRoots: readonly CompanyManifestTrustRoot[]
  try {
    trustRoots = loadSecurityPromptTrustRoots(trustRootsPath)
  } catch (cause) {
    console.error(`verify-security-prompt-document: ${cause instanceof Error ? cause.message : String(cause)}`)
    return 2
  }
  const verification = verifySecurityPromptDocumentText(bytes, trustRoots, { lastAcceptedRevision: floor })
  if (verification.ok) {
    console.log(JSON.stringify({
      ok: true,
      revision: verification.document.revision,
      keyId: verification.keyId,
      fingerprint: verification.fingerprint,
      expiresAt: verification.document.expiresAt,
      verifiedAt: verification.verifiedAt,
    }))
    return 0
  }
  console.log(JSON.stringify({ ok: false, code: verification.code, reason: verification.reason.slice(0, 200) }))
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
