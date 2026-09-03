/**
 * Tarball-push planning for the intranet publisher (P7 batch 2b).
 *
 * The hosting layout: every tarball-channel entry's artifact lives in the
 * SAME GitLab config repo as the manifest, at `packages/<name>-<version>.tgz`,
 * served at the raw url the manifest signs —
 * `https://<origin>/<project>/-/raw/<branch>/packages/<name>-<version>.tgz`
 * (the raw-URL prefix publish-local already derives for the manifest itself).
 * These helpers parse that contract off the signed bytes, verify the
 * artifact directory actually carries matching bytes, and plan the push:
 * pure functions, fully testable without a GitLab.
 *
 * Integrity rule: the bytes in the artifact must hash to the entry's SIGNED
 * source.integrity — the same value the desktop verifies over the downloaded
 * tarball and the profile lockfile pins for the `file:` install. Transport
 * (gh artifact download, catalog-artifacts branch, --artifact-dir replay) is
 * only transport: whatever carried the bytes, they face this check.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Byte bound of one hosted tarball; mirrors lib/tarball.mjs. */
export const TARBALL_MAX_BYTES = 128 * 1024 * 1024
/** Headroom over the cap when a subprocess must emit the whole tarball on stdout. */
export const TARBALL_SPAWN_BUFFER_HEADROOM_BYTES = 1024 * 1024

/** Standard-base64 SHA-512 integrity of exact bytes. */
export const sha512IntegrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const isSafeBasename = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 214
  && !value.includes('/')
  && !value.includes('\\')
  && !value.includes('\0')
  && value.endsWith('.tgz')

/**
 * Parse one signed tarball source url against the deployment being pushed to
 * (`{ origin, project, branch }`). Returns
 * `{ repoPath, filePath, filename }` where `repoPath` is the GitLab project
 * path the url must address, `filePath` the in-repo file path
 * (`packages/<name>-<version>.tgz`), and `filename` its basename. Every
 * mismatch — another origin, another project or ref, a path outside
 * packages/, dot segments — is a hard error naming the entry: the publisher
 * refuses to push bytes to an address the signed manifest does not name.
 */
export function parseTarballSourceUrl(url, { origin, project, branch, at }) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${at} tarball url '${url}' is not a parseable URL`)
  }
  if (parsed.origin !== origin) {
    throw new Error(
      `${at} tarball url origin ${parsed.origin} is not the GitLab origin ${origin} being published to — ` +
      'the manifest must sign the address this publisher actually serves (fix the allowlist source url or pass --gitlab)',
    )
  }
  const expectedPrefix = `/${project}/-/raw/${branch}/`
  if (!parsed.pathname.startsWith(expectedPrefix)) {
    throw new Error(
      `${at} tarball url path must be ${expectedPrefix}packages/<name>-<version>.tgz (got '${parsed.pathname}') — ` +
      `the hosting layout pins the artifact into the ${project} config repo on ${branch}`,
    )
  }
  const filePath = decodeURIComponent(parsed.pathname.slice(expectedPrefix.length))
  const segments = filePath.split('/')
  if (segments.length !== 2 || segments[0] !== 'packages' || !isSafeBasename(segments[1])) {
    throw new Error(
      `${at} tarball url must address exactly packages/<name>-<version>.tgz inside the config repo (got '${filePath}') — ` +
      'deeper layouts are not part of the hosting contract',
    )
  }
  return { repoPath: project, filePath, filename: segments[1] }
}

/**
 * Plan every tarball-channel push the manifest demands: for each signed
 * `source:{kind:'tarball'}` entry, locate `packages/<filename>` in the
 * acquired artifact directory, verify its bytes hash to the signed
 * `source.integrity` (fail closed with both values printed on mismatch), and
 * return the push records. Duplicate hosted filenames across entries are
 * rejected (two entries may not share one artifact address).
 */
export function planTarballPushes({ manifest, artifactDir, origin, project, branch }) {
  const packages = Array.isArray(manifest?.packages) ? manifest.packages : []
  const pushes = []
  const seenFilenames = new Map()
  for (const entry of packages) {
    if (entry?.source?.kind !== 'tarball') continue
    const at = `${entry.packageName}@${entry.version}`
    const url = entry.source.url
    if (typeof url !== 'string' || typeof entry.source.integrity !== 'string') {
      throw new Error(`${at} carries a tarball source without url/integrity — the artifact does not describe a signable entry`)
    }
    const { filePath, filename } = parseTarballSourceUrl(url, { origin, project, branch, at })
    const previous = seenFilenames.get(filename)
    if (previous !== undefined) {
      throw new Error(`${at} wants to host ${filename}, already claimed by ${previous} — one artifact address serves exactly one entry`)
    }
    seenFilenames.set(filename, at)
    const artifactPath = join(artifactDir, 'packages', filename)
    let stat
    try {
      stat = statSync(artifactPath)
    } catch (error) {
      throw new Error(
        `${at} needs its tarball ${filePath}, but ${artifactPath} is missing from the artifact (${error.code ?? error.message}) — ` +
        'the workflow must pack the artifact (pack-tarball --from-allowlist) and upload run/packages/ with the manifest',
      )
    }
    if (!stat.isFile()) throw new Error(`${at} artifact path ${artifactPath} is not a file`)
    if (stat.size > TARBALL_MAX_BYTES) {
      throw new Error(`${at} tarball ${filename} is ${String(stat.size)} bytes, over the ${String(TARBALL_MAX_BYTES)}-byte bound`)
    }
    const bytes = readFileSync(artifactPath)
    const integrity = sha512IntegrityOf(bytes)
    if (integrity !== entry.source.integrity) {
      throw new Error(
        `${at} tarball ${filename} hashes to ${integrity} but the manifest signs ${entry.source.integrity} — ` +
        'the artifact bytes do not match the signed integrity; re-run the workflow (fail closed; nothing was pushed)',
      )
    }
    pushes.push({
      packageName: entry.packageName,
      version: entry.version,
      filename,
      filePath,
      artifactPath,
      url,
      integrity: entry.source.integrity,
      sizeBytes: bytes.byteLength,
      bytes,
    })
  }
  return pushes
}

/**
 * Read a raw-url body as bytes under a hard byte cap (the mirror of the
 * pipeline's deployed-manifest discipline, for binary tarballs); cancels the
 * stream on overrun.
 */
export async function readBytesWithLimit(response, maxBytes, label) {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number.parseInt(declared, 10) > maxBytes) {
    throw new Error(`${label} declares ${declared} bytes, over the ${String(maxBytes)}-byte bound`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error(`${label} returned no body`)
  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) throw new Error(`${label} exceeds the ${String(maxBytes)}-byte bound`)
      chunks.push(Buffer.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
    await reader.cancel().catch(() => undefined)
  }
  const bytes = Buffer.concat(chunks)
  if (bytes.byteLength === 0) throw new Error(`${label} returned an empty body`)
  return bytes
}
