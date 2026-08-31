/**
 * Generate `src/model-gateway-blob.ts` from plaintext supplied through
 * environment variables.
 *
 * OBVIOUS DISCLAIMER, SIGNED OFF BY THE COMPANY REVIEW: obfuscation is NOT
 * encryption. XOR with a fixed key plus base64 keeps the gateway URL, token,
 * and model ids out of plaintext greps (accidental pastes, casual shoulder
 * surfing, `strings` on a settings file) and nothing more. Anyone with the
 * shipped JavaScript can recover the values in minutes; this is a soft
 * barrier against honest mistakes, not a defense against reverse engineering.
 * The decision to accept that bar is recorded here so nobody mistakes the
 * encoding for a control.
 *
 * Usage:
 *   DSH_GATEWAY_BASE_URL=https://gateway.example/v1 \
 *   DSH_GATEWAY_API_KEY=... \
 *   DSH_GATEWAY_MODELS=DSV4-DSH,SECOND-MODEL \
 *   node scripts/make-model-gateway-blob.mjs [--out path]
 *
 * The plaintext exists only in the invoking environment (and the invoking
 * shell's history); the repository stores the obfuscated blob and never the
 * plaintext. The first listed model is the pinned default for managed builds.
 *
 * @module scripts/make-model-gateway-blob
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fixed XOR key. NOT a secret (see the header): it exists in the runtime
 * decoder (`src/model-gateway.ts`) by necessity and must stay byte-identical
 * here or the runtime decode fails loudly.
 */
const OBFUSCATION_KEY = 'dsh-desktop-model-gateway-obfuscation-key-v1'

const ENVIRONMENTS = Object.freeze({
  baseUrl: 'DSH_GATEWAY_BASE_URL',
  apiKey: 'DSH_GATEWAY_API_KEY',
  models: 'DSH_GATEWAY_MODELS',
})

/**
 * Obfuscation codec shared with the runtime decoder: UTF-8 bytes XOR the
 * cycled key bytes, then standard base64.
 * @param {object} payload - validated `{ baseUrl, apiKey, models }` payload.
 * @returns {string} the base64 blob to embed.
 */
export function encodeModelGatewayBlob(payload) {
  const key = Buffer.from(OBFUSCATION_KEY, 'utf8')
  const cipher = Buffer.from(JSON.stringify(payload), 'utf8')
  for (let index = 0; index < cipher.length; index += 1) {
    cipher[index] = cipher[index] ^ key[index % key.length]
  }
  return cipher.toString('base64')
}

/** Render the generated TypeScript module for one blob. */
export function renderModelGatewayBlobModule(blob) {
  return [
    '/**',
    ' * GENERATED FILE — do not edit by hand.',
    ' * Produced by `scripts/make-model-gateway-blob.mjs` from plaintext that',
    ' * exists only in the invoking environment. Obfuscation is not encryption;',
    ' * see the generator header for the signed-off soft-barrier positioning.',
    ' */',
    '',
    `export const MODEL_GATEWAY_BLOB = ${JSON.stringify(blob)}`,
    '',
  ].join('\n')
}

/**
 * Read and validate the plaintext inputs from one environment.
 * @param {NodeJS.ProcessEnv} environment - environment carrying the inputs.
 * @returns {{ baseUrl: string, apiKey: string, models: string[] }} the payload.
 */
export function modelGatewayPayloadFromEnvironment(environment) {
  const baseUrl = environment[ENVIRONMENTS.baseUrl]
  const apiKey = environment[ENVIRONMENTS.apiKey]
  const models = environment[ENVIRONMENTS.models]
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error(`${ENVIRONMENTS.baseUrl} must be a non-empty https base URL`)
  }
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`${ENVIRONMENTS.baseUrl} must be a parseable https base URL`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(`${ENVIRONMENTS.baseUrl} must be a bare https base URL`)
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error(`${ENVIRONMENTS.apiKey} must be a non-empty api key`)
  }
  if (typeof models !== 'string' || models.trim().length === 0) {
    throw new Error(`${ENVIRONMENTS.models} must be a comma-separated model id list`)
  }
  const seen = new Set()
  const ids = []
  for (const raw of models.split(',')) {
    const id = raw.trim()
    if (id.length === 0) throw new Error(`${ENVIRONMENTS.models} must not contain empty model ids`)
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return { baseUrl: url.href.replace(/\/$/u, ''), apiKey, models: ids }
}

/** Programmatic entry point.
 * @param {string[]} argv - arguments after the script name.
 * @returns {string} the absolute output path written.
 */
export async function makeModelGatewayBlob(argv = []) {
  const flag = argv.indexOf('--out')
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const outputPath = resolve(
    flag >= 0 && argv[flag + 1] !== undefined
      ? argv[flag + 1]
      : join(packageRoot, 'src', 'model-gateway-blob.ts'),
  )
  const payload = modelGatewayPayloadFromEnvironment(process.env)
  const blob = encodeModelGatewayBlob(payload)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderModelGatewayBlobModule(blob), 'utf8')
  return outputPath
}

function isDirectExecution() {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  try {
    const written = await makeModelGatewayBlob(process.argv.slice(2))
    const payload = modelGatewayPayloadFromEnvironment(process.env)
    console.log(
      `dsh-plugin-desktop: wrote the model gateway blob for ${String(payload.models.length)} model(s) to ${written}`,
    )
  } catch (cause) {
    process.stderr.write(`dsh-plugin-desktop: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
