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
/**
 * Fixed XOR key. NOT a secret (see the header): it is reproduced here and in
 * the author-machine packer by necessity, so treat it as a public constant
 * that only raises the cost of accidental disclosure.
 */
export declare const OBFUSCATION_KEY = "dsh-company-skill-bundle-obfuscation-key-v1";
/** Stable identifier for the key above; the discriminator a future key-derivation switch reads. */
export declare const OBFUSCATION_KEY_ID = "company-skill-bundle-v1";
/** Name of the single ESM export a generated `pack.mjs` module carries. */
export declare const BUNDLE_BLOB_EXPORT_NAME = "COMPANY_SKILL_BUNDLE_BLOB";
/**
 * Wire-format v2 magic ("DSH company-skills bundle v2"). A payload decoded out
 * of the XOR layer that starts with `dskb2:` is followed by a codec tag and a
 * colon (`dskb2:br:` — brotli) and then that codec's stream. Mirrored by
 * `scripts/build-bundle-asset.mjs`; `tests/container.spec.ts` pins the pair.
 */
export declare const BLOB_V2_MAGIC = "dskb2";
/** The one v2 codec tag this decoder understands: brotli (`node:zlib` built-in). */
export declare const BLOB_V2_CODEC_BROTLI = "br";
/**
 * XOR a byte sequence with the cycled key bytes. The transform is its own
 * inverse, which is what lets {@link decodeBundleBlob} undo it in place.
 * @param bytes - input bytes; the caller's buffer is copied.
 * @returns the transformed bytes.
 */
export declare function xorKeyBytes(bytes: Uint8Array): Buffer;
/**
 * Decode one line of canonical standard base64; anything else is rejected.
 * Mirrors `tools/company-skills/lib/codec.mjs` so both sides fail the same way.
 * @param value - the candidate base64 string.
 * @param what - subject for error messages.
 * @returns the decoded bytes.
 */
export declare function decodeCanonicalBase64(value: string, what: string): Buffer;
/**
 * Decode one blob back into its JSON document, in either wire format. The
 * caller is responsible for `JSON.parse` and for validating the document; this
 * function only undoes the codec (base64, XOR, and — when the payload carries
 * the v2 magic — decompression, all in memory).
 * @param blob - standard base64 blob, no whitespace.
 * @param what - subject for error messages.
 * @returns the decoded JSON document.
 */
export declare function decodeBundleBlob(blob: string, what?: string): string;
/**
 * Pull the blob out of either a raw base64 asset or a generated module, so the
 * loader accepts both shipped forms. Surrounding whitespace is ignored, which
 * keeps a checked-out asset with a trailing newline loadable.
 * @param text - file contents.
 * @returns the base64 blob.
 */
export declare function extractBundleBlob(text: string): string;
