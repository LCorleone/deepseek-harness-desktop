/**
 * Company skill bundle codec (P6 batch 2) — the decoder the shipped plugin owns.
 *
 * This is an independent re-implementation of the algorithm in
 * `tools/company-skills/lib/codec.mjs`, on purpose: the plugin is a standalone
 * published artifact and must not import the author-machine tool. The key
 * string, the cycled XOR, and the canonical-standard-base64 check are
 * identical by construction, and `tests/container.spec.ts` packs real skills
 * with that tool (through its CLI) and decrypts the artifact through this
 * module, so the two copies cannot drift silently.
 *
 * Only the decode direction ships. Writing a bundle is an author-machine
 * concern (`tools/company-skills/pack.mjs` plus this package's
 * `scripts/build-bundle-asset.mjs`); a runtime encoder would be dead code with
 * a second chance to disagree.
 *
 * Wire formats (the #013 change: compression composes *inside* the
 * obfuscation layer, so the 明文不落盘 invariant is exactly what it was —
 * the plaintext document exists only in memory, and the only bytes that ever
 * reach disk are obfuscated):
 *
 *   v1  base64(XOR(utf8 json))            — what the batch-1.5 packer writes
 *   v2  base64(XOR("dskb2:br:" || brotli(utf8 json)))
 *                                          — what `scripts/build-bundle-asset.mjs`
 *                                            re-encodes the packer output into
 *
 * The `dskb2:<codec>:` header rides behind the XOR layer, so it discriminates
 * the two payloads only after the (key-public) XOR step and adds nothing
 * readable to a casual `strings` pass. v1 needs no header: its payload is the
 * JSON text itself and always starts with `{`, which a v2 payload (magic
 * first) can never collide with. An unknown codec tag is rejected by name
 * instead of guessed at, so a future `dskb2:…` codec degrades to an empty
 * catalog with a reason rather than a misread. Both formats decode through
 * {@link decodeBundleBlob}; the container *document* grammar is unchanged
 * (still `version: 1`), so every v1 asset — including packed test fixtures —
 * keeps loading.
 *
 * OBVIOUS DISCLAIMER: obfuscation is NOT encryption. The key is reproduced in
 * this shipped file by necessity, so it only keeps skill bodies out of
 * plaintext greps, out of `strings` on the asset, and out of casual copies of
 * the profile directory. `tools/company-skills/README.zh.md` records the
 * accepted bar ("防普通用户") and the single-shared-key gap. Compression
 * changes none of that: brotli is applied before the XOR and undone after it,
 * in memory, on both sides.
 *
 * The key is never read from a file and never overridden by the environment:
 * an env-selected key would only produce bundles nothing else can read back.
 */

import { brotliDecompressSync } from 'node:zlib'

/**
 * Fixed XOR key. NOT a secret (see the header): it is reproduced here and in
 * the author-machine packer by necessity, so treat it as a public constant
 * that only raises the cost of accidental disclosure.
 */
export const OBFUSCATION_KEY = 'dsh-company-skill-bundle-obfuscation-key-v1'

/** Stable identifier for the key above; the discriminator a future key-derivation switch reads. */
export const OBFUSCATION_KEY_ID = 'company-skill-bundle-v1'

/** Name of the single ESM export a generated `pack.mjs` module carries. */
export const BUNDLE_BLOB_EXPORT_NAME = 'COMPANY_SKILL_BUNDLE_BLOB'

/**
 * Wire-format v2 magic ("DSH company-skills bundle v2"). A payload decoded out
 * of the XOR layer that starts with `dskb2:` is followed by a codec tag and a
 * colon (`dskb2:br:` — brotli) and then that codec's stream. Mirrored by
 * `scripts/build-bundle-asset.mjs`; `tests/container.spec.ts` pins the pair.
 */
export const BLOB_V2_MAGIC = 'dskb2'

/** The one v2 codec tag this decoder understands: brotli (`node:zlib` built-in). */
export const BLOB_V2_CODEC_BROTLI = 'br'

const KEY_BYTES = Buffer.from(OBFUSCATION_KEY, 'utf8')

const V2_MAGIC_BYTES = Buffer.from(`${BLOB_V2_MAGIC}:`, 'utf8')

/**
 * XOR a byte sequence with the cycled key bytes. The transform is its own
 * inverse, which is what lets {@link decodeBundleBlob} undo it in place.
 * @param bytes - input bytes; the caller's buffer is copied.
 * @returns the transformed bytes.
 */
export function xorKeyBytes(bytes: Uint8Array): Buffer {
  const out = Buffer.from(bytes)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (out[index] as number) ^ (KEY_BYTES[index % KEY_BYTES.length] as number)
  }
  return out
}

/**
 * Decode one line of canonical standard base64; anything else is rejected.
 * Mirrors `tools/company-skills/lib/codec.mjs` so both sides fail the same way.
 * @param value - the candidate base64 string.
 * @param what - subject for error messages.
 * @returns the decoded bytes.
 */
export function decodeCanonicalBase64(value: string, what: string): Buffer {
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
 * Decompress the v2 payload that follows the `dskb2:<codec>:` header. A
 * truncated header or a stream the codec rejects throws (and the catalog
 * degrades with that reason); an unknown codec tag is named in the error so a
 * future wire codec reads as "not understood", never as a misparse.
 * @param payload - the XOR-decoded bytes, starting at the v2 magic.
 * @param what - subject for error messages.
 * @returns the JSON document text.
 */
function decodeV2Payload(payload: Buffer, what: string): string {
  const headerEnd = payload.indexOf(0x3a, V2_MAGIC_BYTES.length)
  if (headerEnd < 0) throw new Error(`${what} carries a truncated ${BLOB_V2_MAGIC} header (no codec terminator)`)
  const codec = payload.subarray(V2_MAGIC_BYTES.length, headerEnd).toString('utf8')
  if (codec !== BLOB_V2_CODEC_BROTLI) {
    throw new Error(
      `${what} carries wire-format v2 with the unknown compression codec "${codec}" `
      + `(this decoder understands ${BLOB_V2_CODEC_BROTLI} = brotli)`,
    )
  }
  return brotliDecompressSync(payload.subarray(headerEnd + 1)).toString('utf8')
}

/**
 * Decode one blob back into its JSON document, in either wire format. The
 * caller is responsible for `JSON.parse` and for validating the document; this
 * function only undoes the codec (base64, XOR, and — when the payload carries
 * the v2 magic — decompression, all in memory).
 * @param blob - standard base64 blob, no whitespace.
 * @param what - subject for error messages.
 * @returns the decoded JSON document.
 */
export function decodeBundleBlob(blob: string, what = 'bundle blob'): string {
  const payload = xorKeyBytes(decodeCanonicalBase64(blob, what))
  if (payload.subarray(0, V2_MAGIC_BYTES.length).equals(V2_MAGIC_BYTES)) return decodeV2Payload(payload, what)
  return payload.toString('utf8')
}

/**
 * Pull the blob out of either a raw base64 asset or a generated module, so the
 * loader accepts both shipped forms. Surrounding whitespace is ignored, which
 * keeps a checked-out asset with a trailing newline loadable.
 * @param text - file contents.
 * @returns the base64 blob.
 */
export function extractBundleBlob(text: string): string {
  if (typeof text !== 'string') throw new TypeError('extractBundleBlob expects file text')
  const trimmed = text.trim()
  const match = trimmed.match(new RegExp(`export const ${BUNDLE_BLOB_EXPORT_NAME} = "([A-Za-z0-9+/=]+)"`, 'u'))
  if (match !== null) return match[1] as string
  if (/^[A-Za-z0-9+/=]+$/u.test(trimmed)) return trimmed
  throw new Error(
    'the input carries neither a raw base64 blob nor a generated bundle module '
    + `(expected an \`export const ${BUNDLE_BLOB_EXPORT_NAME}\` export from pack.mjs)`,
  )
}
