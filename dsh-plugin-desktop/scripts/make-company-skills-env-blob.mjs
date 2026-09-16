/**
 * Generate `src/company-skills-env-blob.ts` from plaintext supplied through
 * environment variables.
 *
 * OBVIOUS DISCLAIMER, SIGNED OFF BY THE COMPANY REVIEW: obfuscation is NOT
 * encryption. XOR with a fixed key plus base64 keeps the skills-router URL
 * and API key out of plaintext greps (accidental pastes, casual shoulder
 * surfing, `strings` on a settings file) and nothing more. Anyone with the
 * shipped JavaScript can recover the values in minutes; this is a soft
 * barrier against honest mistakes, not a defense against reverse
 * engineering. The decision to accept that bar is recorded here so nobody
 * mistakes the encoding for a control — same positioning as
 * `make-model-gateway-blob.mjs` and `make-sso-app-key-blob.mjs`.
 *
 * Usage:
 *   ROUTER_URL='http://router.internal' ROUTER_API_KEY='...' \
 *   node scripts/make-company-skills-env-blob.mjs [--out path]
 *
 * The plaintext exists only in the invoking environment (and the invoking
 * shell's history); the repository stores the obfuscated blob and never the
 * plaintext. With BOTH variables absent the script writes the EMPTY payload
 * blob (`{"routerUrl":"","routerApiKey":""}`) — the committed default, which
 * decodes to "inject nothing", so a checkout without the secrets still
 * builds and tests green. Providing exactly one of the two is an error: a
 * half-configured router would fail every skill run at request time with a
 * misleading missing-variable error instead of at build time.
 *
 * CI SECRET WIRING IS A FOLLOW-UP (#043 batch B): the release pipeline must
 * export ROUTER_URL/ROUTER_API_KEY (same secret store the model-gateway
 * providers JSON comes from) before invoking this script, then verify the
 * written blob is non-empty. Until that wiring lands, a managed package
 * carries the empty blob and the five API skills degrade to
 * missing-credential errors at run time — same posture as an unmanaged
 * build. Rotating either value (ops) is exactly one re-run of this script.
 *
 * @module scripts/make-company-skills-env-blob
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fixed XOR key. NOT a secret (see the header): it exists in the runtime
 * decoder (`src/company-skills-env.ts`) by necessity and must stay
 * byte-identical here or the runtime decode fails loudly.
 */
const OBFUSCATION_KEY = 'dsh-desktop-company-skills-env-obfuscation-key-v1'

/** Environment name carrying the skills-router base URL. */
export const ROUTER_URL_ENV = 'ROUTER_URL'

/** Environment name carrying the skills-router API key. */
export const ROUTER_API_KEY_ENV = 'ROUTER_API_KEY'

const invalid = (message) => new Error(`company-skills env blob: ${message}`)

/**
 * Obfuscation codec shared with the runtime decoder: UTF-8 bytes XOR the
 * cycled key bytes, then standard base64.
 * @param {{ routerUrl: string, routerApiKey: string }} payload - validated payload.
 * @returns {string} the base64 blob to embed.
 */
export function encodeCompanySkillsEnvBlob(payload) {
  const key = Buffer.from(OBFUSCATION_KEY, 'utf8')
  const cipher = Buffer.from(JSON.stringify(payload), 'utf8')
  for (let index = 0; index < cipher.length; index += 1) {
    cipher[index] = cipher[index] ^ key[index % key.length]
  }
  return cipher.toString('base64')
}

/** Render the generated TypeScript module for one blob. */
export function renderCompanySkillsEnvBlobModule(blob) {
  return [
    '/**',
    ' * GENERATED FILE — do not edit by hand.',
    ' * Produced by `scripts/make-company-skills-env-blob.mjs` from plaintext that',
    ' * exists only in the invoking environment. Obfuscation is not encryption;',
    ' * see the generator header for the signed-off soft-barrier positioning.',
    ' */',
    '',
    `export const COMPANY_SKILLS_ENV_BLOB = ${JSON.stringify(blob)}`,
    '',
  ].join('\n')
}

/** The committed-empty payload: decodes to "inject nothing". */
export function emptyCompanySkillsEnvPayload() {
  return { routerUrl: '', routerApiKey: '' }
}

/** Whether a decoded payload carries nothing to inject. */
export function isEmptyCompanySkillsEnvPayload(payload) {
  return payload.routerUrl.length === 0 && payload.routerApiKey.length === 0
}

/**
 * Read and validate the plaintext input from one environment.
 * @param {NodeJS.ProcessEnv} environment - environment carrying the input.
 * @returns {{ routerUrl: string, routerApiKey: string }} the payload.
 */
export function companySkillsEnvFromEnvironment(environment) {
  const routerUrl = environment[ROUTER_URL_ENV]
  const routerApiKey = environment[ROUTER_API_KEY_ENV]
  const urlPresent = typeof routerUrl === 'string' && routerUrl.length > 0
  const keyPresent = typeof routerApiKey === 'string' && routerApiKey.length > 0
  if (!urlPresent && !keyPresent) return emptyCompanySkillsEnvPayload()
  if (urlPresent !== keyPresent) {
    // Fixed wording only — the values themselves never appear in the error.
    throw invalid(`${ROUTER_URL_ENV} and ${ROUTER_API_KEY_ENV} must be provided together (exactly one was set)`)
  }
  if (routerUrl.trim() !== routerUrl || routerApiKey.trim() !== routerApiKey) {
    throw invalid('neither value may carry surrounding whitespace')
  }
  let url
  try {
    url = new URL(routerUrl)
  } catch {
    throw invalid(`${ROUTER_URL_ENV} must be a parseable absolute URL`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw invalid(`${ROUTER_URL_ENV} must be a bare http(s) URL without credentials in it`)
  }
  return { routerUrl, routerApiKey }
}

/**
 * Programmatic entry point.
 * @param {string[]} argv - arguments after the script name.
 * @returns {Promise<{ outputPath: string, payload: object }>} the path written and the payload.
 */
export async function makeCompanySkillsEnvBlob(argv = []) {
  const flag = argv.indexOf('--out')
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const outputPath = resolve(
    flag >= 0 && argv[flag + 1] !== undefined
      ? argv[flag + 1]
      : join(packageRoot, 'src', 'company-skills-env-blob.ts'),
  )
  const payload = companySkillsEnvFromEnvironment(process.env)
  const blob = encodeCompanySkillsEnvBlob(payload)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderCompanySkillsEnvBlobModule(blob), 'utf8')
  return { outputPath, payload }
}

function isDirectExecution() {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  try {
    const { outputPath, payload } = await makeCompanySkillsEnvBlob(process.argv.slice(2))
    const summary = payload.routerUrl.length === 0
      ? 'the EMPTY payload (no ROUTER_* secrets in the invoking environment)'
      : `router URL ${payload.routerUrl.length + payload.routerApiKey.length} plaintext characters`
    console.log(`dsh-plugin-desktop: wrote the company-skills env blob (${summary}) to ${outputPath}`)
  } catch (cause) {
    process.stderr.write(`dsh-plugin-desktop: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
