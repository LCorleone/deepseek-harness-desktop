/**
 * Generate `src/usage-report-db-blob.ts` from plaintext supplied through
 * environment variables.
 *
 * OBVIOUS DISCLAIMER, SIGNED OFF BY THE COMPANY REVIEW (same positioning as
 * `make-model-gateway-blob.mjs`): obfuscation is NOT encryption. XOR with a
 * fixed key plus base64 keeps the report-database DSN out of plaintext greps
 * and nothing more; anyone with the shipped JavaScript recovers the values
 * in minutes. The DSN itself is low-privilege (INSERT-only on one table) and
 * the root credential never exists in any client artifact.
 *
 * Usage:
 *   DSH_REPORT_DB_HOST=10.0.0.1 \
 *   DSH_REPORT_DB_PORT=3306 \
 *   DSH_REPORT_DB_USER=dsh_report_writer \
 *   DSH_REPORT_DB_PASSWORD=... \
 *   DSH_REPORT_DB_DATABASE=dsh_usage \
 *   node scripts/make-usage-report-blob.mjs [--out path]
 *
 * The plaintext exists only in the invoking environment (and the invoking
 * shell's history); the repository stores the obfuscated blob and never the
 * plaintext. Rotation means regenerating the blob and shipping a release.
 *
 * @module scripts/make-usage-report-blob
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fixed XOR key. NOT a secret (see the header): it exists in the runtime
 * decoder (`src/model-usage-reporter.ts`) by necessity and must stay
 * byte-identical here or the runtime decode fails loudly.
 */
const OBFUSCATION_KEY = 'dsh-desktop-usage-report-obfuscation-key-v1'

const ENVIRONMENTS = Object.freeze({
  host: 'DSH_REPORT_DB_HOST',
  port: 'DSH_REPORT_DB_PORT',
  user: 'DSH_REPORT_DB_USER',
  password: 'DSH_REPORT_DB_PASSWORD',
  database: 'DSH_REPORT_DB_DATABASE',
})

const HOST_PATTERN = /^[A-Za-z0-9._-]{1,253}$/u

/**
 * Obfuscation codec shared with the runtime decoder: UTF-8 bytes XOR the
 * cycled key bytes, then standard base64.
 * @param {object} payload - validated `{ host, port, user, password, database }` payload.
 * @returns {string} the base64 blob to embed.
 */
export function encodeUsageReportDbBlob(payload) {
  const key = Buffer.from(OBFUSCATION_KEY, 'utf8')
  const cipher = Buffer.from(JSON.stringify(payload), 'utf8')
  for (let index = 0; index < cipher.length; index += 1) {
    cipher[index] = cipher[index] ^ key[index % key.length]
  }
  return cipher.toString('base64')
}

/** Render the generated TypeScript module for one blob. */
export function renderUsageReportDbBlobModule(blob) {
  return [
    '/**',
    ' * GENERATED FILE — do not edit by hand.',
    ' * Produced by `scripts/make-usage-report-blob.mjs` from plaintext that',
    ' * exists only in the invoking environment. Obfuscation is not encryption;',
    ' * see the generator header for the signed-off soft-barrier positioning.',
    ' */',
    '',
    'export const USAGE_REPORT_DB_BLOB = ' + JSON.stringify(blob),
    '',
  ].join('\n')
}

/**
 * Read and validate the plaintext inputs from one environment.
 * @param {NodeJS.ProcessEnv} environment - environment carrying the inputs.
 * @returns {{ host: string, port: number, user: string, password: string, database: string }} the payload.
 */
export function usageReportDbPayloadFromEnvironment(environment) {
  const host = environment[ENVIRONMENTS.host]
  const port = environment[ENVIRONMENTS.port]
  const user = environment[ENVIRONMENTS.user]
  const password = environment[ENVIRONMENTS.password]
  const database = environment[ENVIRONMENTS.database]
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
    throw new Error(`${ENVIRONMENTS.host} must be a bare hostname or IP literal`)
  }
  const portNumber = typeof port === 'string' ? Number.parseFloat(port) : NaN
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error(`${ENVIRONMENTS.port} must be an integer between 1 and 65535`)
  }
  if (typeof user !== 'string' || user.length === 0) {
    throw new Error(`${ENVIRONMENTS.user} must be a non-empty user name`)
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error(`${ENVIRONMENTS.password} must be a non-empty password`)
  }
  if (typeof database !== 'string' || database.length === 0) {
    throw new Error(`${ENVIRONMENTS.database} must be a non-empty database name`)
  }
  return { host, port: portNumber, user, password, database }
}

/** Programmatic entry point.
 * @param {string[]} argv - arguments after the script name.
 * @returns {string} the absolute output path written.
 */
export async function makeUsageReportDbBlob(argv = []) {
  const flag = argv.indexOf('--out')
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const outputPath = resolve(
    flag >= 0 && argv[flag + 1] !== undefined
      ? argv[flag + 1]
      : join(packageRoot, 'src', 'usage-report-db-blob.ts'),
  )
  const payload = usageReportDbPayloadFromEnvironment(process.env)
  const blob = encodeUsageReportDbBlob(payload)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderUsageReportDbBlobModule(blob), 'utf8')
  return outputPath
}

function isDirectExecution() {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  try {
    const written = await makeUsageReportDbBlob(process.argv.slice(2))
    console.log(`dsh-plugin-desktop: wrote the usage report database blob to ${written}`)
  } catch (cause) {
    process.stderr.write(`dsh-plugin-desktop: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
