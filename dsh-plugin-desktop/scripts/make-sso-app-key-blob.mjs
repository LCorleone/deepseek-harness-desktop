/**
 * Generate `src/sso-app-key-blob.ts` from plaintext supplied through an
 * environment variable.
 *
 * OBVIOUS DISCLAIMER, SIGNED OFF BY THE COMPANY REVIEW: obfuscation is NOT
 * encryption. XOR with a fixed key plus base64 keeps the SSO app key out of
 * plaintext greps (accidental pastes, casual shoulder surfing, `strings` on
 * a settings file) and nothing more. Anyone with the shipped JavaScript can
 * recover the value in minutes; this is a soft barrier against honest
 * mistakes, not a defense against reverse engineering. The decision to
 * accept that bar is recorded here so nobody mistakes the encoding for a
 * control — same positioning as `make-model-gateway-blob.mjs`.
 *
 * Usage:
 *   DSH_SSO_APP_KEY=... node scripts/make-sso-app-key-blob.mjs [--out path]
 *
 * The plaintext exists only in the invoking environment (and the invoking
 * shell's history); the repository stores the obfuscated blob and never the
 * plaintext. Rotating the key (ops) is exactly one re-run of this script.
 *
 * @module scripts/make-sso-app-key-blob
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Fixed XOR key. NOT a secret (see the header): it exists in the runtime
 * decoder (`src/company-sso.ts`) by necessity and must stay byte-identical
 * here or the runtime decode fails loudly.
 */
const OBFUSCATION_KEY = 'dsh-desktop-sso-app-key-obfuscation-key-v1'

const ENVIRONMENT = 'DSH_SSO_APP_KEY'

/**
 * Obfuscation codec shared with the runtime decoder: UTF-8 bytes XOR the
 * cycled key bytes, then standard base64.
 * @param {string} appKey - validated app key plaintext.
 * @returns {string} the base64 blob to embed.
 */
export function encodeSsoAppKeyBlob(appKey) {
  const key = Buffer.from(OBFUSCATION_KEY, 'utf8')
  const cipher = Buffer.from(JSON.stringify({ appKey }), 'utf8')
  for (let index = 0; index < cipher.length; index += 1) {
    cipher[index] = cipher[index] ^ key[index % key.length]
  }
  return cipher.toString('base64')
}

/** Render the generated TypeScript module for one blob. */
export function renderSsoAppKeyBlobModule(blob) {
  return [
    '/**',
    ' * GENERATED FILE — do not edit by hand.',
    ' * Produced by `scripts/make-sso-app-key-blob.mjs` from plaintext that',
    ' * exists only in the invoking environment. Obfuscation is not encryption;',
    ' * see the generator header for the signed-off soft-barrier positioning.',
    ' */',
    '',
    `export const SSO_APP_KEY_BLOB = ${JSON.stringify(blob)}`,
    '',
  ].join('\n')
}

/**
 * Read and validate the plaintext input from one environment.
 * @param {NodeJS.ProcessEnv} environment - environment carrying the input.
 * @returns {string} the app key plaintext.
 */
export function ssoAppKeyFromEnvironment(environment) {
  const appKey = environment[ENVIRONMENT]
  if (typeof appKey !== 'string' || appKey.length === 0) {
    throw new Error(`${ENVIRONMENT} must be a non-empty app key`)
  }
  if (appKey.trim() !== appKey) {
    throw new Error(`${ENVIRONMENT} must not carry surrounding whitespace`)
  }
  return appKey
}

/**
 * Programmatic entry point.
 * @param {string[]} argv - arguments after the script name.
 * @returns {string} the absolute output path written.
 */
export async function makeSsoAppKeyBlob(argv = []) {
  const flag = argv.indexOf('--out')
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const outputPath = resolve(
    flag >= 0 && argv[flag + 1] !== undefined
      ? argv[flag + 1]
      : join(packageRoot, 'src', 'sso-app-key-blob.ts'),
  )
  const appKey = ssoAppKeyFromEnvironment(process.env)
  const blob = encodeSsoAppKeyBlob(appKey)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderSsoAppKeyBlobModule(blob), 'utf8')
  return outputPath
}

function isDirectExecution() {
  const entry = process.argv[1]
  return entry !== undefined && fileURLToPath(import.meta.url) === entry
}

if (isDirectExecution()) {
  try {
    const written = await makeSsoAppKeyBlob(process.argv.slice(2))
    console.log(`dsh-plugin-desktop: wrote the sso app key blob to ${written}`)
  } catch (cause) {
    process.stderr.write(`dsh-plugin-desktop: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
