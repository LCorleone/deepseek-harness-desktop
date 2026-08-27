/* Generated from docs/schemas by scripts/generate-contract-types.mjs. Do not edit. */

export type HttpsUri = string
/**
 * Optional expected SHA-256 root digest (64 lowercase hex) of the installed package tree, computed with the market install tree-digest contract (package-relative POSIX paths, per-file SHA-256, records sorted by path, root digest over the sha256:<path>\n<digest>\n lines). The digest depends on the installing environment's package-manager layout, so the publishing pipeline cannot derive it: the field is omitted until the expected value is measured in a clean reference environment and reviewed into the allowlist. Clients enable the installed-tree check against this signed expectation only for entries that carry it; entries without it keep the receipt-anchored behavior.
 */
export type TreeDigest = string
/**
 * npm dependency name whose build scripts the signed entry approves.
 */
export type ApprovedBuildDependency = string

/**
 * The company-signed install allowlist for DSH Desktop. Each package entry pins an exact npm package version, its npm dist SHA-512 integrity, the in-package bundle patch path, a revocation flag, and the DSH runtime compatibility ranges the entry supports; two optional fields extend the anchor per entry — `treeDigest` pins the expected installed-tree digest so the client verifies the disk tree against the signed value instead of a user-writable receipt, and `approvedBuilds` carries the signed dependency build-script approval list. The manifest is signed with a company ed25519 key: the signature block is detached (the signed bytes are the canonical JSON serialization of the document without the signature block itself) and carries the keyId plus the raw public key whose SHA-256 fingerprint must match the deployment policy trust root pinned for that keyId. Without a server-side revocation channel, freshness is enforced by the monotonic sequence (clients reject any manifest whose sequence does not strictly exceed the highest previously verified value) and expiresAt (the entire catalog is untrusted after the RFC 3339 instant). Canonical JSON rules for this schema: object keys sorted in UTF-16 code-unit order, no insignificant whitespace, minimal JSON string escaping with non-ASCII characters kept literal and encoded as UTF-8, and sequence as the only number (a safe integer in plain decimal); every other value is a string, boolean, null, array, or object. Verification additionally requires the raw manifest bytes to equal the canonical re-serialization of their parsed value byte for byte, which rejects reordered keys, added whitespace, alternate escapes, and non-canonical number spellings.
 */
export interface CompanyManifest {
  manifestVersion: '1.0.0'
  /**
   * Monotonic publication counter and the only JSON number allowed anywhere in the document. Clients persist the highest verified sequence and reject any manifest that does not strictly exceed it.
   */
  sequence: number
  /**
   * RFC 3339 timestamp with an explicit UTC offset or Zulu suffix. The whole catalog, including every package entry, is untrusted at and after this instant.
   */
  expiresAt: string
  /**
   * Install allowlist entries with unique packageName and version pairs.
   *
   * @minItems 0
   * @maxItems 10000
   */
  packages: PackageEntry[]
  signature: SignatureBlock
}
export interface PackageEntry {
  /**
   * npm package name of the plugin bundle.
   */
  packageName: string
  /**
   * Exact stable semantic version; prerelease and build metadata are not allowed.
   */
  version: string
  /**
   * npm dist integrity: the standard base64 encoding of the 64-byte SHA-512 digest of the package tarball.
   */
  integrity: string
  /**
   * Relative path of the bundle patch file inside the installed package, for example ./cordis.patch.yml. Absolute paths, backslashes, drive letters, and dot segments are rejected by verification.
   */
  bundlePatch: string
  repository: Repository
  treeDigest?: TreeDigest
  /**
   * Optional signed build-script approval list: the native dependency names inside this plugin's dependency tree whose install scripts the client may pre-approve in its package-manager workspace. Entries without the field keep the client's built-in approval list only; publishing it is a per-plugin decision, so the field is absent until a reviewed entry carries it.
   *
   * @minItems 1
   * @maxItems 128
   */
  approvedBuilds?: [ApprovedBuildDependency, ...ApprovedBuildDependency[]]
  /**
   * true withdraws the entry while keeping the signed audit trail intact. Revoked entries stay verifiable and readable but must be treated as uninstallable.
   */
  revoked: boolean
  runtime: RuntimeRanges
}
/**
 * The package's true VCS repository identity, signed so the install-time verifier can back-link the candidate against the live npm metadata (package.json repository). Catalog rows without a verifiable repository identity never become install candidates, and an npm metadata mismatch fails preview; therefore every entry must pin it.
 */
export interface Repository {
  url: HttpsUri
  subdirectory?: string
}
/**
 * Semver ranges a client compares against its bundled runtime versions. The ranges are authoritative manifest data; clients only compare and never fall back to local defaults.
 */
export interface RuntimeRanges {
  /**
   * Semver range of @deepseek-ai/dsh runtime versions this entry supports.
   */
  dshRuntimeVersion: string
  /**
   * Optional semver range of @deepseek-ai/cordis host versions this entry supports.
   */
  cordisRuntimeVersion?: string
  /**
   * Optional semver range of bundled Node.js versions this entry supports.
   */
  nodeRuntimeVersion?: string
}
export interface SignatureBlock {
  /**
   * Stable identifier selecting among overlapping rotation keys pinned by the deployment policy trust roots.
   */
  keyId: string
  /**
   * Standard base64 encoding of the raw 32-byte ed25519 public key. Its SHA-256 fingerprint (64 lowercase hex characters) must equal the trust root fingerprint pinned for keyId.
   */
  publicKey: string
  /**
   * Standard base64 encoding of the 64-byte detached ed25519 signature over the canonical JSON serialization of the manifest without the signature block.
   */
  value: string
}
