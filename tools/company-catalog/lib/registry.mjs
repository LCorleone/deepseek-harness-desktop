/**
 * npm registry dist lookups for the publishing pipeline. Integrity is always
 * taken from the official registry response, never trusted from local files,
 * and the tarball URL must live on the same registry origin: mirrors that
 * repack tarballs break the integrity-to-tarball binding the manifest signs.
 */

export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'

const FETCH_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 8_000

/**
 * Why a registry lookup failed: `network` (registry unreachable), `not-published`
 * (the exact version is absent), or `bad-dist` (response lacks a usable dist).
 */
export class RegistryError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

const isNetworkError = (error) => {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'TypeError') return true
  const cause = error.cause
  return cause !== null && typeof cause === 'object' && typeof cause.code === 'string'
    && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR)/.test(cause.code)
}

/** Standard-base64 SHA-512 integrity, mirroring the market verifier's guard. */
export function isSha512Integrity(value) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) return false
  const encoded = value.slice('sha512-'.length)
  const digest = Buffer.from(encoded, 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === encoded
}

async function registryFetch(url, timeoutMs) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
  } catch (error) {
    if (isNetworkError(error)) {
      throw new RegistryError(`registry.npmjs.org is unreachable (${error.message})`, 'network')
    }
    throw error
  }
}

/**
 * Fetch `dist.integrity` and `dist.tarball` for one exact version from the
 * official registry. Unpublished versions are hard errors: the pipeline must
 * never guess or substitute a closest match.
 */
export async function fetchPackageDist(packageName, version) {
  const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(packageName)}/${version}`
  const response = await registryFetch(url, FETCH_TIMEOUT_MS)
  if (response.status === 404 || response.status === 410) {
    throw new RegistryError(`${packageName}@${version} is not published on ${NPM_REGISTRY_ORIGIN} (HTTP ${String(response.status)})`, 'not-published')
  }
  if (!response.ok) {
    throw new RegistryError(`${NPM_REGISTRY_ORIGIN} answered HTTP ${String(response.status)} for ${packageName}@${version}`, 'bad-response')
  }
  let body
  try {
    body = await response.json()
  } catch (error) {
    throw new RegistryError(`registry response for ${packageName}@${version} is not JSON: ${error.message}`, 'bad-response')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || body.version !== version) {
    throw new RegistryError(`registry response for ${packageName}@${version} does not describe that exact version`, 'bad-dist')
  }
  const dist = body.dist
  if (dist === null || typeof dist !== 'object' || !isSha512Integrity(dist.integrity)) {
    throw new RegistryError(`registry dist for ${packageName}@${version} lacks a standard sha512-… integrity value`, 'bad-dist')
  }
  let tarball
  try {
    tarball = new URL(dist.tarball)
  } catch {
    throw new RegistryError(`registry dist.tarball for ${packageName}@${version} is not a URL`, 'bad-dist')
  }
  if (tarball.origin !== NPM_REGISTRY_ORIGIN) {
    throw new RegistryError(
      `registry dist.tarball for ${packageName}@${version} is served from ${tarball.origin}, not ${NPM_REGISTRY_ORIGIN} — ` +
      'mirrors that repack tarballs break the signed integrity binding',
      'bad-dist',
    )
  }
  return { integrity: dist.integrity, tarball: tarball.href, url }
}

/** Whether the official registry is reachable at all (used by the selftest offline notice). */
export async function probeRegistry() {
  try {
    const response = await registryFetch(`${NPM_REGISTRY_ORIGIN}/-/ping`, PROBE_TIMEOUT_MS)
    return response.ok || response.status < 500
  } catch (error) {
    if (error instanceof RegistryError && error.code === 'network') return false
    throw error
  }
}
