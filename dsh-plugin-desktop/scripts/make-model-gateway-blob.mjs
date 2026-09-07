/**
 * Generate `src/model-gateway-blob.ts` from plaintext supplied through
 * environment variables.
 *
 * OBVIOUS DISCLAIMER, SIGNED OFF BY THE COMPANY REVIEW: obfuscation is NOT
 * encryption. XOR with a fixed key plus base64 keeps the gateway URLs,
 * tokens, and model ids out of plaintext greps (accidental pastes, casual
 * shoulder surfing, `strings` on a settings file) and nothing more. Anyone
 * with the shipped JavaScript can recover the values in minutes; this is a
 * soft barrier against honest mistakes, not a defense against reverse
 * engineering. The decision to accept that bar is recorded here so nobody
 * mistakes the encoding for a control.
 *
 * Usage:
 *   DSH_GATEWAY_PROVIDERS_JSON='{"providers":[
 *     {"route":"dsh-company-gateway","displayName":"Company LLM Gateway",
 *      "apiKeyEnv":"DSH_COMPANY_LLM_KEY","baseUrl":"https://gw.example/v1",
 *      "apiKey":"...","models":[{"id":"DSV4-DSH","name":"deepseek-v4-flash"}]},
 *     {"route":"dsh-company-kimi","displayName":"Kimi",
 *      "apiKeyEnv":"DSH_COMPANY_KIMI_KEY","baseUrl":"https://gw.example/v1",
 *      "apiKey":"...","models":[{"id":"kimi-k2.6"}]}]}' \
 *   node scripts/make-model-gateway-blob.mjs [--out path]
 *
 * The plaintext exists only in the invoking environment (and the invoking
 * shell's history); the repository stores the obfuscated blob and never the
 * plaintext. The first listed model of the first provider is the pinned
 * default for managed builds. Model entries carry `id` plus optional
 * `name` (selector display), `contextWindow`, and `maxTokens` (positive
 * integers; absent capacities fall back to the upstream route defaults).
 * The validation below mirrors the runtime decoder (`src/model-gateway.ts`)
 * — most rules exist in both places on purpose, so a payload the generator
 * accepts always decodes later.
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

/** Single environment variable carrying the whole providers JSON document. */
const PROVIDERS_JSON_ENV = 'DSH_GATEWAY_PROVIDERS_JSON'

/** Sorted key set every provider entry must carry, exactly. */
const PROVIDER_KEYS = Object.freeze(['apiKey', 'apiKeyEnv', 'baseUrl', 'displayName', 'models', 'route'])

/** apiKeyEnv shape: `DSH_`-prefixed so `.env` layers reject it and masks see it. */
const API_KEY_ENV_PATTERN = /^DSH_[A-Z][A-Z0-9_]*$/u

/** Every key a model entry may carry; `id` is the only required one. */
const MODEL_KEYS = Object.freeze(['id', 'name', 'contextWindow', 'maxTokens'])

function invalid(message) {
  return new Error(`${PROVIDERS_JSON_ENV}: ${message}`)
}

function sameKeys(keys, expected) {
  return keys.length === expected.length && expected.every((name, index) => keys[index] === name)
}

function validateBareHttpsBaseUrl(site, baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw invalid(`${site}.baseUrl must be a non-empty https base URL`)
  }
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw invalid(`${site}.baseUrl must be a parseable https base URL`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw invalid(`${site}.baseUrl must be a bare https base URL`)
  }
  return url.href.replace(/\/$/u, '')
}

/**
 * Validate one parsed providers document (the payload the blob carries).
 * @param {unknown} document - the parsed JSON document.
 * @returns {{ providers: object[] }} the validated payload.
 */
export function validateProvidersDocument(document) {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw invalid('the document must be an object')
  }
  const keys = Object.keys(document).sort()
  if (keys.length === 3 && keys[0] === 'apiKey' && keys[1] === 'baseUrl' && keys[2] === 'models') {
    throw invalid(
      'the document is the retired single-provider v1 shape; wrap each provider as '
      + '{"route","displayName","apiKeyEnv","baseUrl","apiKey","models"} under a top-level '
      + 'providers array (see the usage header)',
    )
  }
  if (keys.length !== 1 || keys[0] !== 'providers') {
    throw invalid('the document must carry exactly a providers array')
  }
  const providers = document.providers
  if (!Array.isArray(providers) || providers.length === 0) {
    throw invalid('providers must be a non-empty array')
  }
  const routes = new Set()
  const apiKeyEnvs = new Set()
  const validated = []
  for (const [index, entry] of providers.entries()) {
    const site = `providers[${String(index)}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`${site} must be an object`)
    }
    if (!sameKeys(Object.keys(entry).sort(), PROVIDER_KEYS)) {
      throw invalid(`${site} must carry exactly route, displayName, apiKeyEnv, baseUrl, apiKey, and models`)
    }
    const { route, displayName, apiKeyEnv, baseUrl, apiKey, models } = entry
    if (typeof route !== 'string' || route.length === 0) {
      throw invalid(`${site}.route must be a non-empty string`)
    }
    if (routes.has(route)) throw invalid(`provider route "${route}" is listed more than once`)
    routes.add(route)
    if (typeof displayName !== 'string' || displayName.length === 0) {
      throw invalid(`${site}.displayName must be a non-empty string`)
    }
    if (typeof apiKeyEnv !== 'string' || !API_KEY_ENV_PATTERN.test(apiKeyEnv)) {
      throw invalid(`${site}.apiKeyEnv must be a DSH_-prefixed environment name (uppercase letters, digits, underscores)`)
    }
    if (apiKeyEnvs.has(apiKeyEnv)) throw invalid(`apiKeyEnv "${apiKeyEnv}" is listed more than once`)
    apiKeyEnvs.add(apiKeyEnv)
    const normalizedBaseUrl = validateBareHttpsBaseUrl(site, baseUrl)
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      throw invalid(`${site}.apiKey must be a non-empty string`)
    }
    if (!Array.isArray(models) || models.length === 0) {
      throw invalid(`${site}.models must be a non-empty array`)
    }
    const seenModelIds = new Set()
    const validatedModels = []
    for (const [modelIndex, modelEntry] of models.entries()) {
      const modelSite = `${site}.models[${String(modelIndex)}]`
      if (typeof modelEntry !== 'object' || modelEntry === null || Array.isArray(modelEntry)) {
        throw invalid(`${modelSite} must be an object`)
      }
      const modelKeys = Object.keys(modelEntry)
      if (!modelKeys.includes('id') || modelKeys.some(name => !MODEL_KEYS.includes(name))) {
        throw invalid(`${modelSite} must carry exactly id, with optional name, contextWindow, and maxTokens`)
      }
      const { id, name, contextWindow, maxTokens } = modelEntry
      if (typeof id !== 'string' || id.length === 0) {
        throw invalid(`${modelSite}.id must be a non-empty string`)
      }
      if (seenModelIds.has(id)) throw invalid(`model "${id}" is listed more than once under provider "${route}"`)
      seenModelIds.add(id)
      if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
        throw invalid(`${modelSite}.name must be a non-empty string when present`)
      }
      // Capacities are optional: absent means the upstream route defaults
      // apply (catalog.ts falls back to defaultContextWindow/defaultMaxTokens).
      // Present values must already satisfy upstream's own positive-integer
      // rule so a decoded blob can never compose into an invalid route.
      for (const [field, value] of [['contextWindow', contextWindow], ['maxTokens', maxTokens]]) {
        if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
          throw invalid(`${modelSite}.${field} must be a positive integer when present`)
        }
      }
      validatedModels.push({ id, ...(name === undefined ? {} : { name }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }) })
    }
    validated.push({
      route,
      displayName,
      apiKeyEnv,
      baseUrl: normalizedBaseUrl,
      apiKey,
      models: validatedModels,
    })
  }
  return { providers: validated }
}

/**
 * Obfuscation codec shared with the runtime decoder: UTF-8 bytes XOR the
 * cycled key bytes, then standard base64.
 * @param {object} payload - validated `{ providers }` payload.
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
 * Read and validate the plaintext input from one environment.
 * @param {NodeJS.ProcessEnv} environment - environment carrying the input.
 * @returns {{ providers: object[] }} the payload.
 */
export function modelGatewayPayloadFromEnvironment(environment) {
  const raw = environment[PROVIDERS_JSON_ENV]
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw invalid('must carry the full providers JSON document (see the usage header)')
  }
  let document
  try {
    document = JSON.parse(raw)
  } catch (cause) {
    // Fixed wording only — a V8 JSON error quotes the offending text, which
    // here is the plaintext document carrying the API keys (review P1).
    void cause
    throw invalid('DSH_GATEWAY_PROVIDERS_JSON is not valid JSON (the error text is suppressed because it can quote the plaintext document)')
  }
  return validateProvidersDocument(document)
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
  return { outputPath, payload }
}

function isDirectExecution() {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  try {
    const { outputPath, payload } = await makeModelGatewayBlob(process.argv.slice(2))
    const modelCount = payload.providers.reduce((total, provider) => total + provider.models.length, 0)
    console.log(
      `dsh-plugin-desktop: wrote the model gateway blob for ${String(payload.providers.length)} provider(s)`
      + ` (${String(modelCount)} model(s)) to ${outputPath}`,
    )
  } catch (cause) {
    process.stderr.write(`dsh-plugin-desktop: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
