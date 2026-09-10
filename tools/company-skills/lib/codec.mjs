/**
 * Company skill bundle codec — the obfuscation layer P6 batch 1 owns.
 *
 * A bundle is a UTF-8 JSON document XORed with a fixed, cycled obfuscation
 * key and then standard base64 encoded: the exact shape of the three shipped
 * precedents (`dsh-plugin-desktop/scripts/make-model-gateway-blob.mjs`, the
 * SSO app key, the usage-report DSN). OBVIOUS DISCLAIMER: obfuscation is NOT
 * encryption. XOR with a fixed key plus base64 keeps skill bodies out of
 * plaintext greps, out of `strings` on a shipped file, and out of casual
 * copies of the profile directory; it does not resist anyone who reads the
 * shipped JavaScript. That is the signed-off bar for P6 ("防普通用户"), and
 * tools/company-skills/README.zh.md records it together with the
 * single-shared-key gap.
 *
 * The key string exists in three copies by construction — here (the author
 * machine packer), the generated blob module, and the batch-2 runtime
 * decoder. All three must stay byte-identical or decoding fails loudly.
 * The key is never read from a file and never overridden by the environment:
 * the runtime decoder is a shipped constant, so an env-selected key would
 * produce bundles nothing can read back.
 */

/**
 * Fixed XOR key. NOT a secret (see the header): it is reproduced in the
 * runtime decoder by necessity, so treat it as a public constant that only
 * raises the cost of accidental disclosure.
 */
export const OBFUSCATION_KEY = 'dsh-company-skill-bundle-obfuscation-key-v1'

/** Stable identifier for the key above, carried by the design docs and the batch-2 decoder. */
export const OBFUSCATION_KEY_ID = 'company-skill-bundle-v1'

/** Name of the single ESM export a generated blob module carries. */
export const BUNDLE_BLOB_EXPORT_NAME = 'COMPANY_SKILL_BUNDLE_BLOB'

/** First line of every generated module; `unpack.mjs` keys off it when sniffing input. */
export const GENERATED_HEADER = 'GENERATED FILE — do not edit by hand.'

const KEY_BYTES = Buffer.from(OBFUSCATION_KEY, 'utf8')

/**
 * XOR a byte sequence with the cycled key bytes. The transform is its own
 * inverse, which is what makes `decodeBundleBlob` a one-liner.
 * @param {Uint8Array} bytes - input bytes; the caller's buffer is copied.
 * @returns {Buffer} the transformed bytes.
 */
export function xorKeyBytes(bytes) {
  const out = Buffer.from(bytes)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = out[index] ^ KEY_BYTES[index % KEY_BYTES.length]
  }
  return out
}

/**
 * Encode one canonical bundle JSON document into the base64 blob a plugin
 * ships. Deterministic: the same JSON string always yields the same blob.
 * @param {string} json - the canonical bundle JSON (see `bundlePlaintextJson`).
 * @returns {string} the standard-base64 blob.
 */
export function encodeBundleBlob(json) {
  if (typeof json !== 'string' || json.length === 0) {
    throw new TypeError('encodeBundleBlob expects the non-empty canonical bundle JSON string')
  }
  return xorKeyBytes(Buffer.from(json, 'utf8')).toString('base64')
}

/**
 * Decode one blob back into its JSON document. The caller is responsible for
 * `JSON.parse` plus `validateBundle` — this function only undoes the codec.
 * @param {string} blob - standard base64 blob, no whitespace.
 * @param {string} [what] - subject for error messages.
 * @returns {string} the decoded JSON document.
 */
export function decodeBundleBlob(blob, what = 'bundle blob') {
  return xorKeyBytes(decodeCanonicalBase64(blob, what)).toString('utf8')
}

/**
 * Decode one line of canonical standard base64; anything else is rejected.
 * Mirrors `tools/company-catalog/lib/keys.mjs` so both tools fail the same way.
 * @param {string} value - the candidate base64 string.
 * @param {string} what - subject for error messages.
 * @returns {Buffer} the decoded bytes.
 */
export function decodeCanonicalBase64(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${what} must be a non-empty standard base64 string`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`${what} is not standard base64 (single line, no whitespace or padding noise)`)
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.byteLength === 0 || buffer.toString('base64') !== value) {
    throw new Error(`${what} is not canonical standard base64`)
  }
  return buffer
}

/**
 * Render the generated ESM module a plugin ships in place of the plaintext.
 * Deterministic and timestamp-free, so re-packing unchanged sources is
 * byte-identical.
 * @param {string} blob - the encoded bundle blob.
 * @returns {string} the module source.
 */
export function renderBundleModule(blob) {
  return [
    '/**',
    ` * ${GENERATED_HEADER}`,
    ' * Produced by `tools/company-skills/pack.mjs` from a skill source directory',
    ' * that stays on the author machine. Obfuscation is not encryption; see',
    ' * tools/company-skills/README.zh.md (密钥策略) for the accepted bar and for',
    ' * the single-shared-key gap.',
    ' */',
    '',
    `export const ${BUNDLE_BLOB_EXPORT_NAME} = ${JSON.stringify(blob)}`,
    '',
  ].join('\n')
}

/**
 * Pull the blob out of either a generated module or a raw base64 file.
 * Accepts surrounding whitespace/newlines so a checked-out blob file with a
 * trailing newline still loads.
 * @param {string} text - file contents.
 * @returns {string} the base64 blob.
 */
export function extractBundleBlob(text) {
  if (typeof text !== 'string') throw new TypeError('extractBundleBlob expects file text')
  const trimmed = text.trim()
  const match = trimmed.match(new RegExp(`export const ${BUNDLE_BLOB_EXPORT_NAME} = "([A-Za-z0-9+/=]+)"`, 'u'))
  if (match !== null) return match[1]
  if (/^[A-Za-z0-9+/=]+$/u.test(trimmed)) return trimmed
  throw new Error(
    'the input carries neither a generated bundle module nor a raw base64 blob '
    + `(expected an \`export const ${BUNDLE_BLOB_EXPORT_NAME}\` module from pack.mjs)`,
  )
}
