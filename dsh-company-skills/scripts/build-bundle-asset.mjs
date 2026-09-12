#!/usr/bin/env node
/**
 * Generate (or verify) `assets/skills.bundle` — the one obfuscated block the
 * plugin ships.
 *
 *   node scripts/build-bundle-asset.mjs            # write the asset
 *   node scripts/build-bundle-asset.mjs --check    # fail if it is stale (an
 *     absent asset is rebuilt in place — the untracked-output world of
 *     issue #011, where a fresh clone carries none to compare against)
 *   node scripts/build-bundle-asset.mjs --document-digest <asset-path>
 *     # print the sha256 of the asset's decoded canonical document (issue
 *     #028): the content-level identity of the bundle, stable across the
 *     documented compressor-version wire drift. Read-only; never writes.
 *
 * This is the author-side assembly step of P6 batch 2/4 (plus the #013 size
 * work). It assembles in two steps, both in this script:
 *
 *  1. it runs the batch-1.5 packer over the `skills/` root — the same command
 *     a human would type
 *
 *       node tools/company-skills/pack.mjs --skills dsh-company-skills/skills --out <scratch>
 *
 *     so the *document writer* stays in one place (`tools/company-skills`) and
 *     this package owns only the reader. `skills/` holds the collected,
 *     adapted copies of the real company skills (`scripts/collect-skills.mjs`
 *     refreshes them read-only from the skills hub).
 *  2. it re-encodes the packer's v1 blob (XOR+base64 of the container JSON)
 *     into the v2 wire format the plugin ships since #013:
 *     `base64(XOR("dskb2:br:" || brotli-11(json)))`. Compression composes
 *     *inside* the obfuscation layer (compress-then-obfuscate), so the
 *     明文不落盘 red line is exactly what it was: the plaintext JSON exists
 *     only in memory between the two steps, and the only bytes ever written
 *     are obfuscated — the scratch v1 blob and the final v2 asset. The v1 blob
 *     is written to a private tmpdir scratch and deleted in a `finally`; it
 *     carries the same obfuscation as the shipped asset itself.
 *
 *     Numbers that motivated the codec choice (measured 2026-09-12 on the
 *     45,016,577-byte container): gzip-9 → 25.3 MB, brotli-11 lgwin-24 →
 *     16.5 MB, with decompression at ~0.2 s either way; zstd is not in
 *     `node:zlib` on the supported engines (^22.19 — zstd landed in 23.8),
 *     and brotli is a built-in, so the dependency graph does not move.
 *
 * Determinism: within one Node version, an unchanged skill tree re-produces
 * byte-identical bytes (the packer has no timestamps, sorts by name, and
 * brotli is deterministic). Across Node/brotli versions the compressed bytes
 * may drift while the decoded document stays identical, so `--check` compares
 * the decoded canonical documents before declaring the asset stale — CI on a
 * different Node minor must not ping-pong the committed bytes.
 *
 * The packer and the v2 encoder both deliberately stay dev-time concerns: the
 * shipped plugin imports nothing outside its own `src/`, and every plaintext
 * source under `skills/` (like `fixtures/`) is excluded from the package
 * `files` whitelist.
 *
 * @module dsh-company-skills/scripts/build-bundle-asset
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { decodeBundleBlob, extractBundleBlob, xorKeyBytes } from '../../tools/company-skills/lib/codec.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(PACKAGE_ROOT)
const PACKER = join(REPO_ROOT, 'tools', 'company-skills', 'pack.mjs')
const SKILLS_DIR = join(PACKAGE_ROOT, 'skills')
export const ASSET_PATH = join(PACKAGE_ROOT, 'assets', 'skills.bundle')

/**
 * The v2 wire header this script writes — `dskb2` (the magic) + `br` (brotli).
 * Mirrors `src/codec.ts` (`BLOB_V2_MAGIC`/`BLOB_V2_CODEC_BROTLI`);
 * `tests/container.spec.ts` pins the two against each other.
 */
const V2_HEADER = 'dskb2:br:'
const V2_HEADER_BYTES = Buffer.from(V2_HEADER, 'utf8')

/**
 * Run the batch-1.5 packer over the collected skills root.
 * @param destination - artifact path the packer writes.
 * @returns the artifact text.
 */
export function packSkillsRoot(destination) {
  execFileSync(process.execPath, [PACKER, '--skills', SKILLS_DIR, '--out', destination], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return readFileSync(destination, 'utf8')
}

/**
 * Re-encode one packer artifact (v1 wire) into the v2 wire format the plugin
 * ships: brotli-11 (lgwin 24, size-hinted) *before* the XOR, header first.
 * The plaintext JSON is decoded and recompressed in memory only.
 * @param packerArtifact - the v1 blob text `pack.mjs` wrote.
 * @returns the v2 asset text (base64 blob plus a trailing newline).
 */
export function encodeShippedBundle(packerArtifact) {
  const json = decodeBundleBlob(extractBundleBlob(packerArtifact), 'company skills container')
  const jsonBytes = Buffer.from(json, 'utf8')
  const compressed = brotliCompressSync(jsonBytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: jsonBytes.length,
    },
  })
  const payload = Buffer.concat([V2_HEADER_BYTES, compressed])
  return `${xorKeyBytes(payload).toString('base64')}\n`
}

/**
 * Decode either wire format (v1 plain or v2 brotli) back to the JSON document,
 * in memory — the dev-script mirror of `decodeBundleBlob` in `src/codec.ts`.
 * Used by `--check`'s content-level fallback.
 * @param assetText - raw blob or generated-module asset text.
 * @returns the JSON document text.
 */
export function decodeShippedBundle(assetText) {
  const payload = xorKeyBytes(Buffer.from(extractBundleBlob(assetText), 'base64'))
  if (!payload.subarray(0, V2_HEADER_BYTES.length).equals(V2_HEADER_BYTES)) return payload.toString('utf8')
  return brotliDecompressSync(payload.subarray(V2_HEADER_BYTES.length)).toString('utf8')
}

/** Canonical form of one JSON document text, for content-level comparison. */
function canonicalDocument(assetText) {
  return JSON.stringify(JSON.parse(decodeShippedBundle(assetText)))
}

/**
 * The content-level digest of one bundle asset (issue #028): sha256 over the
 * canonical JSON of the DECODED document — never the wire bytes, which the
 * documented compressor-version drift may change while the document stays
 * identical. `accept-handoff` pins this value on dsh-company-skills allowlist
 * entries (`bundleDocumentDigest`) at handoff acceptance, and the CI
 * `ensure-skills-bundles` step asserts the fresh skills/ rebuild still
 * produces it — the reviewed-content authority for a bundle CI repacks from
 * skills/ at publish time.
 * @param assetText - raw blob or generated-module asset text (v1 or v2 wire).
 * @returns the lowercase hex sha256 of the canonical document.
 */
export function documentDigest(assetText) {
  return createHash('sha256').update(canonicalDocument(assetText), 'utf8').digest('hex')
}

/** Read the committed asset if it exists; undefined when absent (issue #011 rebuild world). */
function readAsSetIfExists(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function main() {
  const args = process.argv.slice(2)
  // --document-digest <path> (issue #028): print the canonical-document
  // sha256 of the asset at <path> and touch nothing. The decode/canon
  // machinery is the one this script already owns — the catalog-side callers
  // (accept-handoff, ensure-skills-bundles) spawn this mode instead of
  // duplicating the codec.
  const digestIndex = args.indexOf('--document-digest')
  if (digestIndex !== -1) {
    if (args.includes('--check')) {
      process.stderr.write('build-bundle-asset: --document-digest and --check are mutually exclusive (one reads an asset, the other rebuilds from skills/)\n')
      process.exit(1)
    }
    const unknown = args.filter((argument, index) => index !== digestIndex && index !== digestIndex + 1)
    if (unknown.length > 0) {
      process.stderr.write(`build-bundle-asset: unknown argument "${unknown[0]}"\n`)
      process.exit(1)
    }
    const target = args[digestIndex + 1]
    if (typeof target !== 'string' || target.length === 0 || target.startsWith('--')) {
      process.stderr.write('build-bundle-asset: --document-digest requires the path of the bundle asset to digest\n')
      process.exit(1)
    }
    let assetText
    try {
      assetText = readFileSync(target, 'utf8')
    } catch (error) {
      process.stderr.write(`build-bundle-asset: cannot read ${target} (${error.code ?? error.message})\n`)
      process.exit(1)
    }
    process.stdout.write(`${documentDigest(assetText)}\n`)
    return
  }
  const check = args.includes('--check')
  const unknown = args.filter((argument) => argument !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`build-bundle-asset: unknown argument "${unknown[0]}"\n`)
    process.exit(1)
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-company-skills-asset-'))
  try {
    const packerArtifact = packSkillsRoot(join(scratch, 'skills.v1.bundle'))
    const artifact = encodeShippedBundle(packerArtifact)

    if (!check) {
      const jsonBytes = Buffer.byteLength(decodeShippedBundle(packerArtifact), 'utf8')
      writeFileSync(ASSET_PATH, artifact, 'utf8')
      process.stdout.write(
        `build-bundle-asset: wrote assets/skills.bundle (${String(artifact.length)} bytes, v2 wire) from skills/\n`
          + `  ${String(jsonBytes)} plaintext bytes → brotli-11 → ${String(artifact.length)} wire bytes; plaintext never written\n`,
      )
      return
    }

    const committed = readAsSetIfExists(ASSET_PATH)
    if (committed === undefined) {
      // Issue #011: the asset is a deterministic rebuild output, untracked
      // and gitignored — a fresh clone (or a clean CI checkout) has none.
      // Checking an absent asset means building it: write what skills/ packs
      // (loudly — never a silent skip) so this run passes because the tree
      // just produced the asset, and later runs compare against real bytes.
      writeFileSync(ASSET_PATH, artifact, 'utf8')
      process.stdout.write(
        'build-bundle-asset: assets/skills.bundle was absent (untracked build output, issue #011) '
          + '— wrote it from skills/ so the check passes by production; nothing was committed\n',
      )
      return
    }
    if (committed === artifact) {
      process.stdout.write('build-bundle-asset: assets/skills.bundle matches skills/\n')
      return
    }
    // Byte drift alone (a different Node/brotli version compressing the same
    // document) is not staleness: the asset still decodes to exactly what the
    // current skills/ tree packs. Only a content difference fails the check.
    if (canonicalDocument(committed) === canonicalDocument(artifact)) {
      process.stderr.write(
        'build-bundle-asset: assets/skills.bundle bytes differ from a fresh pack, but both decode to the same document '
          + '(compressor-version byte drift); the asset is current — re-running the writer will refresh the bytes\n',
      )
      return
    }
    process.stderr.write(
      'build-bundle-asset: assets/skills.bundle is stale — run `node scripts/build-bundle-asset.mjs` '
        + 'to refresh it (the asset is an untracked build output since issue #011 — nothing to commit; '
        + 'the company-catalog workflows rebuild it automatically)\n',
    )
    process.exit(1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
