/**
 * Deterministic content measurement of one installed package directory (P2-3).
 *
 * The digest turns the post-install state of a package tree into a stable
 * value recorded in install receipts and compared independently of package
 * manager bookkeeping. Determinism rules, pinned here and enforced by the
 * receipt validator in `install/service.ts`:
 *
 * 1. Every entry of the package directory is enumerated recursively. Empty
 *    directories contribute no record and cannot change the digest.
 * 2. Record paths are package-relative POSIX paths: `/` separators, no leading
 *    `./`, no leading or trailing `/`.
 * 3. Regular files hash their raw bytes with SHA-256. Symbolic links hash the
 *    UTF-8 encoding of their target text and are never followed, so a link
 *    never reads content outside the measured tree. Any other entry type
 *    fails the whole measurement instead of being silently skipped.
 * 4. Records are sorted by path in ascending UTF-16 code-unit order (the
 *    order of `Array.prototype.sort` on the path strings), so enumeration
 *    order never affects the result.
 * 5. Every digest is 64 lowercase hex characters.
 * 6. `rootDigest` is the hex SHA-256 of the UTF-8 concatenation of
 *    `sha256:<path>\n<digest>\n` over all records in sorted order.
 *
 * Bounded inputs: at most {@link MAX_INSTALL_TREE_DIGEST_FILES} records and
 * paths of at most {@link MAX_INSTALL_TREE_PATH_LENGTH} characters; larger
 * trees fail the measurement (and therefore the install) instead of writing
 * an unbounded receipt.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Upper bound of measured files per package tree; larger trees fail the digest. */
export const MAX_INSTALL_TREE_DIGEST_FILES = 20_000
/** Upper bound of one measured relative path in characters. */
export const MAX_INSTALL_TREE_PATH_LENGTH = 1024

/** One measured file of an installed package tree. */
export interface MarketInstallTreeDigestFile {
  /** Package-relative POSIX path (`/` separators, no leading or trailing slash). */
  readonly path: string
  /** Lowercase hex SHA-256 of the file bytes; symlink entries hash the link target text. */
  readonly digest: string
}

/** Deterministic SHA-256 measurement of one installed package directory tree. */
export interface MarketInstallTreeDigest {
  readonly algorithm: 'sha256'
  /** Sorted by `path` in ascending UTF-16 code-unit order, unique, possibly empty. */
  readonly files: readonly MarketInstallTreeDigestFile[]
  /** Lowercase hex SHA-256 over the sorted per-file records (rule 6 of the module docs). */
  readonly rootDigest: string
}

const sha256Hex = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

const byPath = (left: MarketInstallTreeDigestFile, right: MarketInstallTreeDigestFile): number =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0

async function collectTreeDigestEntries(
  dir: string,
  prefix: string,
  files: MarketInstallTreeDigestFile[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (path.length > MAX_INSTALL_TREE_PATH_LENGTH) {
      throw new Error('install tree digest exceeded the path length limit')
    }
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectTreeDigestEntries(child, path, files)
    } else if (entry.isFile()) {
      files.push({ path, digest: sha256Hex(await readFile(child)) })
    } else if (entry.isSymbolicLink()) {
      files.push({ path, digest: sha256Hex(Buffer.from(await readlink(child), 'utf8')) })
    } else {
      throw new Error(`install tree entry ${path} is not a file, directory, or symbolic link`)
    }
    if (files.length > MAX_INSTALL_TREE_DIGEST_FILES) {
      throw new Error('install tree digest exceeded the file limit')
    }
  }
}

/**
 * Measure one installed package directory tree. Synchronous content rules and
 * the exact serialization of `rootDigest` are documented at the top of this
 * module; identical content always produces an identical result regardless of
 * file creation or enumeration order.
 */
export async function computeInstallTreeDigest(packageDir: string): Promise<MarketInstallTreeDigest> {
  const files: MarketInstallTreeDigestFile[] = []
  await collectTreeDigestEntries(packageDir, '', files)
  files.sort(byPath)
  const root = createHash('sha256')
  for (const file of files) root.update(`sha256:${file.path}\n${file.digest}\n`, 'utf8')
  return { algorithm: 'sha256', files, rootDigest: root.digest('hex') }
}
