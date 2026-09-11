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
 * concern (`tools/company-skills/pack.mjs`); a runtime encoder would be dead
 * code with a second chance to disagree.
 *
 * OBVIOUS DISCLAIMER: obfuscation is NOT encryption. The key is reproduced in
 * this shipped file by necessity, so it only keeps skill bodies out of
 * plaintext greps, out of `strings` on the asset, and out of casual copies of
 * the profile directory. `tools/company-skills/README.zh.md` records the
 * accepted bar ("防普通用户") and the single-shared-key gap.
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
 * XOR a byte sequence with the cycled key bytes. The transform is its own
 * inverse, which is what makes {@link decodeBundleBlob} a one-liner.
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
 * Decode one blob back into its JSON document. The caller is responsible for
 * `JSON.parse` and for validating the document; this function only undoes the
 * codec.
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
