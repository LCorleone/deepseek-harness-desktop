/**
 * Corporate network environment self-injection for sandboxed shell children.
 *
 * On corporate Windows networks that enforce an outbound proxy with TLS
 * inspection, the Electron/Chromium network stack clears both gates through
 * OS services (system proxy resolver incl. PAC, system certificate store),
 * while shell descendants fail both: git's libcurl against its packaged CA
 * bundle, the bundled Node runtime against its compiled-in roots — TLS
 * handshakes are cut by the inspection middlebox. This module resolves the
 * same two facts through the OS at desktop startup and returns them as plain
 * environment entries, so assigning them into the Electron main process's
 * `process.env` before any child spawns makes every descendant (pnpm, the
 * Host, sandboxed pwsh shells) inherit them. The runtime stays untouched;
 * `scrubbedParentEnv` in dsh-subprocess keeps proxy and CA variable names.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { session } from 'electron'

/**
 * HTTPS probe whose system-proxy decision stands in for desktop outbound
 * traffic. Chromium answers for exactly this URL — a PAC that routes other
 * hosts differently is an accepted approximation (see the architecture note
 * `.agents/notes/implemented/architecture/2026-09-05-corporate-network-env.md`).
 */
export const CORPORATE_PROXY_PROBE_URL = 'https://registry.npmjs.org/'

/** File name of the exported CA bundle inside the desktop user-data directory. */
export const CORPORATE_CA_BUNDLE_FILENAME = 'corporate-ca-bundle.pem'

/** Hard deadline for one PowerShell certificate-store export. */
const DEFAULT_CA_EXPORT_TIMEOUT_MS = 10_000

/** Upper bound on PowerShell stderr retained for the failure log line. */
const MAX_CA_EXPORT_STDERR_BYTES = 64 * 1024

/**
 * Hosts and domains that must bypass the corporate proxy: loopback, the
 * RFC1918 range intranet services live on, and the known company domains.
 * This list is the maintenance point when intranet hostnames evolve.
 *
 * Each wildcard domain is spelled three ways because NO_PROXY consumers
 * disagree: libcurl suffix-matches a bare domain (`deloitte.cn` covers every
 * `*.deloitte.cn` host and honors `10.0.0.0/8` for IP ranges), Go's
 * httpproxy and npm understand a `*.` prefix, and undici's environment
 * proxy agent wants a leading dot. Consumers that do not need a spelling
 * ignore it.
 */
export const INTRANET_NO_PROXY_ENTRIES: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '10.*',
  '10.0.0.0/8',
  '*.deloitte.cn',
  'deloitte.cn',
  '.deloitte.cn',
  '*.deloitte.com.cn',
  'deloitte.com.cn',
  '.deloitte.com.cn',
  'gitlab.s.dai.deloitte.cn',
  'sdp.deloitre.com.cn',
  'ai.deloitre.com.cn',
]

/** The Electron `app` surface this module consumes (structural; tests inject a fake). */
export interface CorporateNetworkApp {
  getPath(name: 'userData'): string
}

/** Chromium `resolveProxy` directive kinds translated into proxy URL schemes. */
const PROXY_DIRECTIVE_SCHEMES: Readonly<Record<string, string>> = {
  PROXY: 'http',
  HTTPS: 'https',
  SOCKS4: 'socks4',
  SOCKS5: 'socks5',
  SOCKS: 'socks5',
}

/**
 * Translate one Chromium proxy resolution — `"PROXY host:port;PROXY
 * host:port;DIRECT"` — into the proxy URL that proxy environment variables
 * expect, honoring only the first directive: static env vars cannot express
 * Chromium's ordered fallback chain. `DIRECT`, empty, and unrecognized
 * resolutions yield `undefined` (no proxy variables injected).
 */
export function parseCorporateProxyDirective(resolution: string): string | undefined {
  const directive = (resolution.split(';', 1)[0] ?? '').trim()
  if (directive === '' || directive.toUpperCase() === 'DIRECT') return undefined
  const fragments = directive.split(/\s+/)
  if (fragments.length !== 2) return undefined
  const scheme = PROXY_DIRECTIVE_SCHEMES[fragments[0]!.toUpperCase()]
  if (scheme === undefined) return undefined
  return `${scheme}://${fragments[1]}`
}

/**
 * Assemble the injection set. Proxy variables (with the intranet bypass
 * list) appear only when a proxy was resolved; CA variables only with a
 * bundle path. Absent keys are omitted, so merging over `process.env`
 * leaves any inherited value untouched.
 */
export function buildCorporateNetworkEnvironment(
  proxyUrl: string | undefined,
  caBundlePath: string | undefined,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {}
  if (proxyUrl !== undefined) {
    environment.HTTPS_PROXY = proxyUrl
    environment.HTTP_PROXY = proxyUrl
    environment.NO_PROXY = INTRANET_NO_PROXY_ENTRIES.join(',')
  }
  if (caBundlePath !== undefined) {
    environment.NODE_EXTRA_CA_CERTS = caBundlePath
    environment.SSL_CERT_FILE = caBundlePath
    environment.CURL_CA_BUNDLE = caBundlePath
  }
  return environment
}

/** Inputs for one CA-bundle export. */
export interface CorporateCaExportOptions {
  /** User-data directory; the bundle is written alongside its logs and state. */
  readonly userDataDir: string
  /** Full bundle path; defaults to `<userDataDir>/corporate-ca-bundle.pem`. */
  readonly bundlePath?: string
  /** Hard deadline before the export is killed and skipped. */
  readonly timeoutMs?: number
  /** Failure sink; every skip path reports one line through it. */
  readonly onError?: (message: string) => void
  /** Test seams for the PowerShell executable probe and spawn. */
  readonly exists?: (path: string) => boolean
  readonly spawn?: typeof spawn
}

/** PowerShell candidates for the export, mirroring `desktopWindowsPwshPath` without pulling the ACL-sandbox module into the main bundle. */
function corporatePowerShellPath(
  exists: (path: string) => boolean,
  programFiles: string = process.env.ProgramFiles ?? 'C:\\Program Files',
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): string | undefined {
  return [
    win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ].find(candidate => exists(candidate))
}

/**
 * Export the effective Windows trust stores — LocalMachine\Root,
 * CurrentUser\Root, LocalMachine\CA, deduplicated by thumbprint — as one PEM
 * bundle (base64 DER per certificate) into the user-data directory,
 * overwriting on every launch. PowerShell is spawned by the Electron main
 * process itself, outside any sandbox, so it sees the real machine stores.
 *
 * Every failure (missing executable, non-zero exit, timeout, missing or
 * empty bundle) resolves `undefined` after one `onError` line — the caller
 * skips CA injection and boots on; a stale bundle from an earlier launch is
 * deliberately not trusted, because only a successful export proves this
 * launch's stores.
 */
export async function exportCorporateCaBundle(options: CorporateCaExportOptions): Promise<string | undefined> {
  const onError = options.onError ?? (() => {})
  const bundlePath = options.bundlePath ?? join(options.userDataDir, CORPORATE_CA_BUNDLE_FILENAME)
  const powerShellPath = corporatePowerShellPath(options.exists ?? existsSync)
  if (powerShellPath === undefined) {
    onError(`corporate CA export skipped: no PowerShell executable found (looked for pwsh 7 and Windows PowerShell 5.1)`)
    return undefined
  }

  // Single-quoted PS string literal with the only escaping PS defines ('' for ').
  const literalPath = bundlePath.replaceAll("'", "''")
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '$seen = @{}',
    '$lines = New-Object System.Collections.Generic.List[string]',
    'foreach ($store in \'Cert:\\LocalMachine\\Root\',\'Cert:\\CurrentUser\\Root\',\'Cert:\\LocalMachine\\CA\') {',
    '  foreach ($certificate in Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue) {',
    '    if ($seen.ContainsKey($certificate.Thumbprint)) { continue }',
    '    $seen.Add($certificate.Thumbprint, $true)',
    "    $lines.Add('-----BEGIN CERTIFICATE-----')",
    '    $lines.Add([Convert]::ToBase64String($certificate.RawData, \'InsertLineBreaks\'))',
    "    $lines.Add('-----END CERTIFICATE-----')",
    '  }',
    '}',
    `[System.IO.File]::WriteAllLines('${literalPath}', $lines, (New-Object System.Text.UTF8Encoding($false)))`,
  ].join('\n')

  try {
    const exitCode = await runPowerShellExport(
      options.spawn ?? spawn,
      powerShellPath,
      script,
      options.timeoutMs ?? DEFAULT_CA_EXPORT_TIMEOUT_MS,
    )
    if (exitCode !== 0) {
      onError(`corporate CA export failed: PowerShell exited with code ${String(exitCode)}; no bundle injected`)
      return undefined
    }
    const bundleStat = await stat(bundlePath)
    if (!bundleStat.isFile() || bundleStat.size === 0) {
      onError(`corporate CA export produced no certificates; no bundle injected at ${bundlePath}`)
      return undefined
    }
    return bundlePath
  } catch (cause) {
    onError(`corporate CA export failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

/** Run the export script to completion; resolves the exit code, rejects on spawn errors and timeouts. */
function runPowerShellExport(
  spawnExport: typeof spawn,
  powerShellPath: string,
  script: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawnExport(powerShellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let settled = false
    let failure: Error | undefined
    let exitCode: number | null = null
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure !== undefined) reject(failure)
      else resolve(exitCode ?? -1)
    }
    let stderrBytes = 0
    const stderr = child.stderr
    if (stderr !== null) {
      stderr.on('data', (chunk: Buffer | string) => {
        stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk)
        if (stderrBytes > MAX_CA_EXPORT_STDERR_BYTES) stderr.destroy()
      })
    }
    const timer = setTimeout(() => {
      // A failed kill on an unresponsive shell must not hold the boot hostage:
      // settle immediately, the kill is best-effort.
      failure = new Error(`PowerShell certificate export timed out after ${String(timeoutMs)}ms`)
      try {
        child.kill()
      } catch {
        // An already-dead child needs no further cleanup.
      }
      settle()
    }, timeoutMs)
    child.once('error', error => {
      // A spawn-level failure (missing executable, EACCES) never emits close.
      failure = error
      settle()
    })
    child.once('close', (code, _signal) => {
      exitCode = code
      settle()
    })
  })
}

/** Inputs for {@link resolveCorporateNetworkEnv}; every field is a test seam. */
export interface ResolveCorporateNetworkEnvOptions {
  /** Host platform gate; defaults to the real platform. */
  readonly platform?: NodeJS.Platform
  /** Chromium proxy resolution seam; defaults to `session.defaultSession.resolveProxy`. */
  readonly resolveProxy?: (url: string) => Promise<string>
  /** CA export seam; defaults to {@link exportCorporateCaBundle}. */
  readonly exportCaBundle?: (options: CorporateCaExportOptions) => Promise<string | undefined>
  /** Passed through to the CA export. */
  readonly timeoutMs?: number
  /** Failure sink for the proxy and CA skip paths. */
  readonly onError?: (message: string) => void
}

/**
 * Resolve the corporate network environment (proxy variables + CA bundle
 * variables) for the desktop process and its descendants. Windows-only:
 * every other platform, and every Windows network where no proxy is
 * detected, yields an empty set — bare-launch behavior identical to before
 * this module existed. CA export failures degrade to proxy-only injection;
 * proxy resolution failures degrade to CA-only injection.
 * @param app - Electron app providing the user-data directory.
 * @param options - test seams; see {@link ResolveCorporateNetworkEnvOptions}.
 */
export async function resolveCorporateNetworkEnv(
  app: CorporateNetworkApp,
  options: ResolveCorporateNetworkEnvOptions = {},
): Promise<Readonly<Record<string, string>>> {
  if ((options.platform ?? process.platform) !== 'win32') return {}
  const onError = options.onError ?? (() => {})

  let proxyUrl: string | undefined
  try {
    const resolveProxy = options.resolveProxy ?? ((url: string) => session.defaultSession.resolveProxy(url))
    proxyUrl = parseCorporateProxyDirective(await resolveProxy(CORPORATE_PROXY_PROBE_URL))
  } catch (cause) {
    onError(`corporate proxy resolution failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  let caBundlePath: string | undefined
  try {
    const exportCaBundle = options.exportCaBundle ?? exportCorporateCaBundle
    caBundlePath = await exportCaBundle({
      userDataDir: app.getPath('userData'),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    })
  } catch (cause) {
    onError(`corporate CA export failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    caBundlePath = undefined
  }

  return buildCorporateNetworkEnvironment(proxyUrl, caBundlePath)
}
