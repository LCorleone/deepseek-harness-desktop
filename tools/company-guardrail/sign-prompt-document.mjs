/**
 * Company guardrail security-prompt document signer (#046, publish side).
 *
 * Signs one template revision into the canonical, ed25519-signed sibling
 * document the managed desktop fetches beside the company catalog manifest
 * (schema: `revision` / `template` / `expiresAt` + the detached
 * `signature` block, verified by
 * `dsh-plugin-desktop/src/company-guardrail.ts` — `verifyDesktopSecurityPromptDocument`).
 * Plain Node script: no build step, no dependencies beyond Node built-ins
 * and the built dsh-community-market workspace package (same discipline as
 * tools/company-catalog/cli.mjs).
 *
 * VERIFICATION SEAM (decision, see lib/verify-seam.mjs): plain Node cannot
 * import the desktop TypeScript sources from tools/ (strip-only mode), so
 * the round-trip verification shells out to the desktop-side seam script
 * `dsh-plugin-desktop/scripts/verify-security-prompt-document.ts` under
 * `node --experimental-transform-types` — the client's ACTUAL verifier,
 * never a fork. Fail-closed ordering: the exact bytes that will become
 * --out are verified BEFORE anything is written there; only a verified
 * document is renamed into place, and the file is read back and byte-
 * compared (the catalog pipeline's sign → verify → write → disk re-verify
 * chain, adapted to the subprocess seam).
 *
 * Signing material comes only from the environment (--key-from-env):
 *   COMPANY_CATALOG_SIGNING_KEY      base64 PKCS#8 DER ed25519 private key
 *   COMPANY_CATALOG_KEY_ID           keyId written into the signature block
 * The private key never lives in this repository and is never written to
 * disk; the same deployment trust root signs the catalog manifest and the
 * security-prompt documents, so the secrets are shared with the catalog
 * publish workflow (COMPANY_CATALOG_KEY_FINGERPRINT is optional here; the
 * intranet uploader checks the fleet policy trust roots again anyway).
 *
 * Channel semantics mirror the catalog's two files: `--channel beta` signs
 * the document destined for `security-prompt.beta.json` (the beta-roster
 * soak channel), `--channel stable` the one for `security-prompt.json`.
 * The channel changes NOTHING in the signed bytes — the document carries
 * no channel field — it only documents the deployment intent and drives
 * the meta sidecar plus the target-filename notice below; the intranet
 * uploader (upload-prompt-document.mjs) enforces the filename↔channel
 * pairing at push time.
 *
 * Usage:
 *   node tools/company-guardrail/sign-prompt-document.mjs \
 *     --revision 1 --channel beta --key-from-env \
 *     --out run/security-prompt.beta.json \
 *     [--template <path>] [--expires-at <RFC3339>]
 */

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMarketLibrary } from './lib/market.mjs'
import { verifyWithDesktopClient } from './lib/verify-seam.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(TOOL_DIR, '..', '..')

/** Default template: the frozen embedded v1 asset (the factory default's own bytes). */
export const DEFAULT_TEMPLATE_PATH = resolve(
  REPO_ROOT, 'dsh-plugin-desktop', 'assets', 'company-guardrail', 'prompt-template-v1.md',
)

/** The deployed file names, one per channel (mirrors the client constants). */
const CHANNEL_FILENAMES = { beta: 'security-prompt.beta.json', stable: 'security-prompt.json' }

/** Template size ceiling (UTF-8 bytes) — the client's MAX_COMPANY_GUARDRAIL_TEMPLATE_BYTES. */
const MAX_TEMPLATE_BYTES = 8 * 1024
/** Highest revision a document may carry — the client's own ceiling. */
const MAX_REVISION = 9_007_199_254_740_991
/** The user-input placeholder token every template must carry (client: GUARDRAIL_PLACEHOLDER_TOKEN). */
const GUARDRAIL_PLACEHOLDER_TOKEN = '{user_input_placeholder}'
/** Default expiresAt horizon (days) — the catalog pipeline's 90-day convention. */
const DEFAULT_EXPIRES_DAYS = 90
const DAY_MS = 86_400_000

const SIGNING_KEY_ENV = 'COMPANY_CATALOG_SIGNING_KEY'
const KEY_ID_ENV = 'COMPANY_CATALOG_KEY_ID'
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u

const USAGE = `Usage: node tools/company-guardrail/sign-prompt-document.mjs [options]

Sign one revision of the guardrail security-prompt template into the
canonical sibling document (security-prompt.json / security-prompt.beta.json)
and verify the emitted bytes with the desktop client's actual verifier
before anything is written to --out.

Options:
  --template <path>     Template file
                        (default: the frozen embedded asset
                        dsh-plugin-desktop/assets/company-guardrail/prompt-template-v1.md)
  --revision <int>      Publication revision; a safe positive integer
                        (required — the client's anti-rollback ratchet
                        requires strictly increasing revisions per channel)
  --channel <beta|stable>
                        Which deployed file this document is destined for
                        (default: beta). Affects only the output filename
                        convention and the meta sidecar — the signed bytes
                        carry no channel field
  --expires-at <RFC3339>
                        Expiry timestamp (default: now + ${String(DEFAULT_EXPIRES_DAYS)} days)
  --out <file>          Signed document output (required); canonical single
                        line, byte-exact — never reformat it
  --key-from-env        Take the signing key from ${SIGNING_KEY_ENV} +
                        ${KEY_ID_ENV} (required — the key never lives in
                        this repository)
  --help                Show this help

Also writes <out>.meta.json (revision, channel, keyId, fingerprint,
templateSha256, bytesSha256) as the audit sidecar for the publishing
workflow, mirroring the catalog pipeline's publish-meta.json.`

const fail = (message) => {
  console.error(`sign-prompt-document: ${message}`)
  process.exitCode = 1
}

/** Minimal hand-rolled parser: `--flag value`, `--flag=value`, no positionals. */
function parseArgs(argv) {
  const flags = {}
  const valueFlags = new Set(['template', 'revision', 'channel', 'expires-at', 'out'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) throw new Error(`unexpected argument '${argument}'`)
    const equals = argument.indexOf('=')
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals)
    if (name === 'help') {
      flags.help = true
      continue
    }
    const isValueFlag = valueFlags.has(name)
    if (equals !== -1 && !isValueFlag) throw new Error(`--${name} does not take a value`)
    if (!isValueFlag) {
      flags[name] = true
      continue
    }
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1)
    if (value === undefined) throw new Error(`--${name} requires a value`)
    if (equals === -1) index += 1
    flags[name] = value
  }
  return flags
}

/**
 * Local replica of the client's `assertAssemblableGuardrailTemplate`
 * (dsh-plugin-desktop/src/company-guardrail.ts): the template must carry the
 * `{user_input_placeholder}` token EXACTLY ONCE and not as its first byte.
 * Identical logic and messages, so a refusal here reads exactly like the
 * client's; the round-trip verification below re-enforces it with the real
 * client code.
 */
function assertAssemblableGuardrailTemplate(template) {
  const first = template.indexOf(GUARDRAIL_PLACEHOLDER_TOKEN)
  if (first <= 0) {
    throw new Error(
      `the template must carry the ${GUARDRAIL_PLACEHOLDER_TOKEN} token exactly once, after its policy text (found at offset ${String(first)})`,
    )
  }
  if (template.indexOf(GUARDRAIL_PLACEHOLDER_TOKEN, first + GUARDRAIL_PLACEHOLDER_TOKEN.length) !== -1) {
    throw new Error(`the template must carry the ${GUARDRAIL_PLACEHOLDER_TOKEN} token exactly once`)
  }
}

/** Read and validate the template file under the client's own bounds. */
function loadTemplate(path) {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    throw new Error(`the template ${path} is not readable (${error.code ?? error.message})`)
  }
  if (!stat.isFile()) throw new Error(`the template ${path} is not a file`)
  const bytes = readFileSync(path)
  if (bytes.byteLength === 0) throw new Error(`the template ${path} is empty`)
  if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `the template ${path} is ${String(bytes.byteLength)} bytes, over the ${String(MAX_TEMPLATE_BYTES)}-byte bound the client enforces`,
    )
  }
  const template = bytes.toString('utf8')
  if (template.length === 0) throw new Error(`the template ${path} is not valid UTF-8 text`)
  assertAssemblableGuardrailTemplate(template)
  return { template, templateSha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Decode one line of canonical standard base64; anything else is rejected. */
function decodeBase64Strict(value, what) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\n') || value.includes(' ')) {
    throw new Error(`${what} must be a single line of standard base64`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error(`${what} is not standard base64`)
  const buffer = Buffer.from(value, 'base64')
  if (buffer.byteLength === 0 || buffer.toString('base64') !== value) {
    throw new Error(`${what} is not canonical standard base64`)
  }
  return buffer
}

/**
 * Load the signing key from the environment (the only key source — the
 * pipeline never reads key files and never writes keys to disk).
 */
function loadSigningKeyFromEnv(env = process.env) {
  const encoded = env[SIGNING_KEY_ENV]
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error(
      `missing ${SIGNING_KEY_ENV}: set it to the base64 PKCS#8 DER ed25519 private key shared with the catalog pipeline ` +
      '(read from the environment only — the pipeline never reads key files and never writes keys to disk)',
    )
  }
  const keyId = env[KEY_ID_ENV]
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`missing or invalid ${KEY_ID_ENV}: keyId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`)
  }
  const der = decodeBase64Strict(encoded, SIGNING_KEY_ENV)
  let privateKey
  try {
    privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  } catch (error) {
    throw new Error(`${SIGNING_KEY_ENV} is not a base64 PKCS#8 DER private key (${error.message})`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${SIGNING_KEY_ENV} is a ${privateKey.asymmetricKeyType ?? 'non-ed25519'} key; the document is signed with ed25519`)
  }
  return { privateKey, keyId }
}

/** Raw 32-byte public key of an ed25519 KeyObject. */
function rawPublicKeyBytes(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' })
  if (typeof jwk.x !== 'string') throw new Error('the ed25519 public key could not be exported')
  return Buffer.from(jwk.x, 'base64url')
}

/** Resolve the expiresAt value: explicit RFC 3339 or now + days. */
function resolveExpiresAt(explicit) {
  if (explicit === undefined) {
    return new Date(Date.now() + DEFAULT_EXPIRES_DAYS * DAY_MS).toISOString()
  }
  if (typeof explicit !== 'string' || !RFC3339_PATTERN.test(explicit) || Number.isNaN(Date.parse(explicit))) {
    throw new Error(`--expires-at must be an RFC 3339 timestamp (got '${explicit}')`)
  }
  if (Date.parse(explicit) <= Date.now()) {
    throw new Error(`--expires-at '${explicit}' is already in the past — the client verifier would refuse the document as expired`)
  }
  return explicit
}

async function main() {
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    console.error('')
    console.error(USAGE)
    return
  }
  if (flags.help === true) {
    console.log(USAGE)
    return
  }
  if (flags.out === undefined) {
    fail('--out is required (the signed document destination)')
    console.error('')
    console.error(USAGE)
    return
  }
  if (flags['key-from-env'] !== true) {
    fail('--key-from-env is required: the signing key exists only in the environment and never in this repository')
    console.error('')
    console.error(USAGE)
    return
  }
  if (flags.revision === undefined) {
    fail('--revision is required (a safe positive integer; strictly greater than the channel\'s deployed revision)')
    console.error('')
    console.error(USAGE)
    return
  }
  if (!/^\d+$/u.test(flags.revision) || !Number.isSafeInteger(Number.parseInt(flags.revision, 10))) {
    fail(`--revision must be a positive integer (got '${flags.revision}')`)
    return
  }
  const revision = Number.parseInt(flags.revision, 10)
  if (revision < 1 || revision > MAX_REVISION) {
    fail(`--revision must be between 1 and ${String(MAX_REVISION)} (got '${flags.revision}')`)
    return
  }
  const channel = flags.channel === undefined ? 'beta' : flags.channel
  if (channel !== 'beta' && channel !== 'stable') {
    fail(`--channel must be 'beta' or 'stable' (got '${String(flags.channel)}')`)
    return
  }
  const templatePath = resolve(process.cwd(), flags.template ?? DEFAULT_TEMPLATE_PATH)
  const outPath = resolve(process.cwd(), flags.out)
  const expiresAt = resolveExpiresAt(flags['expires-at'])

  const { template, templateSha256 } = loadTemplate(templatePath)
  const { privateKey, keyId } = loadSigningKeyFromEnv()
  const rawPublicKey = rawPublicKeyBytes(createPublicKey(privateKey))
  const market = await loadMarketLibrary()
  const fingerprint = market.ed25519PublicKeyFingerprint(rawPublicKey)

  // Assemble and sign: the unsigned body is {revision, template, expiresAt};
  // createCompanyManifestSignature returns the detached-signature block
  // {keyId, publicKey (raw 32-byte base64), value (64-byte base64)} over the
  // canonical JSON of the unsigned body — exactly the client's
  // SIGNATURE_KEYS shape — and canonicalJsonText emits the byte-exact
  // serialization the client's canonical-equality check demands.
  const unsigned = { revision, template, expiresAt }
  const signature = market.createCompanyManifestSignature(unsigned, privateKey, keyId)
  const text = market.canonicalJsonText({ ...unsigned, signature })

  // Fail-closed round-trip: verify the EXACT bytes that will become --out
  // with the client's actual verifier (through the desktop seam), against
  // the signing key's own trust root, BEFORE anything lands at --out.
  const stagingPath = `${outPath}.signing-${String(process.pid)}.tmp`
  const rootsPath = `${outPath}.signing-${String(process.pid)}.roots.tmp`
  mkdirSync(dirname(outPath), { recursive: true })
  try {
    writeFileSync(stagingPath, text, 'utf8')
    writeFileSync(rootsPath, `${JSON.stringify({ trustRoots: [{ keyId, fingerprint }] })}\n`, 'utf8')
    const verdict = verifyWithDesktopClient(stagingPath, rootsPath)
    if (verdict.ok !== true) {
      throw new Error(
        `round-trip verification failed (${String(verdict.code)}): ${String(verdict.reason)} — ` +
        'the emitted bytes do not satisfy the desktop client verifier; nothing was written',
      )
    }
    if (verdict.keyId !== keyId || verdict.fingerprint !== fingerprint || verdict.revision !== revision) {
      throw new Error(
        `round-trip verification reported keyId ${String(verdict.keyId)}/${String(verdict.fingerprint)} revision ${String(verdict.revision)} — not the signed identity; nothing was written`,
      )
    }
    renameSync(stagingPath, outPath)
  } finally {
    rmSync(stagingPath, { force: true })
    rmSync(rootsPath, { force: true })
  }

  // Disk re-verify: the persisted file must be the verified bytes exactly.
  const written = readFileSync(outPath, 'utf8')
  if (written !== text) {
    throw new Error(`${outPath} does not hold the verified bytes (read-back mismatch) — remove it and re-run`)
  }
  const bytesSha256 = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

  // Audit sidecar, mirroring the catalog pipeline's publish-meta.json.
  const meta = {
    document: 'security-prompt-document',
    revision,
    channel,
    keyId,
    fingerprint,
    templateSha256,
    bytesSha256,
    expiresAt,
    templatePath,
    signedAt: new Date().toISOString(),
  }
  const metaPath = `${outPath}.meta.json`
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  const targetFilename = CHANNEL_FILENAMES[channel]
  console.log(`signed:   ${outPath} (${String(Buffer.byteLength(text, 'utf8'))} bytes, canonical single line, sha256 ${bytesSha256})`)
  console.log(`verified: desktop client verifier round-trip ok (keyId ${keyId}, fingerprint ${fingerprint}, revision ${String(revision)})`)
  console.log(`meta:     ${metaPath}`)
  console.log(`channel:  ${channel} → deployed file name ${targetFilename}`)
  if (basename(outPath) !== targetFilename) {
    console.log(
      `note:     --out's base name is not ${targetFilename} — fine for staging/artifacts, but the intranet uploader requires the deployed file to be named exactly ${targetFilename} for channel ${channel}`,
    )
  }
  if (channel === 'beta') {
    console.log('note:     beta documents are fetched only by machines whose beta catalog overlay applied (the signed roster)')
  }
}

try {
  await main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
