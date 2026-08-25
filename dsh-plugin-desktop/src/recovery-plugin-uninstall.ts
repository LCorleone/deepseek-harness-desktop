/** Run the official DSH plugin-removal flow before the Cordis Host starts. */

import { execFile } from 'node:child_process'
import { delimiter, isAbsolute } from 'node:path'
import { assertDesktopProfileName } from './profile-manager.ts'
import { PNPM_IGNORE_MINIMUM_RELEASE_AGE } from './pnpm-policy.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

export interface RecoveryPluginUninstallOptions {
  readonly appExecutable: string
  readonly dshBootstrapPath: string
  readonly profileName: string
  readonly profileDir: string
  readonly homeDir: string
  readonly nodeBinDir: string
  readonly nodeShimPath: string
  readonly electronVersion: string
  readonly packageName: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

export interface RecoveryPluginUninstallResult {
  readonly packageName: string
  readonly profileName: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export class RecoveryPluginUninstallError extends Error {
  constructor(
    message: string,
    readonly result?: Omit<RecoveryPluginUninstallResult, 'exitCode'> & {
      readonly exitCode: number | string | null
      readonly signal: NodeJS.Signals | null
    },
  ) {
    super(message)
    this.name = 'RecoveryPluginUninstallError'
  }
}

function assertAbsolutePath(label: string, value: string): void {
  if (value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new RecoveryPluginUninstallError(`recovery plugin uninstall ${label} must be an absolute path without NUL`)
  }
}

function inheritedPath(): string {
  const exact = process.env.PATH
  if (exact !== undefined || process.platform !== 'win32') return exact ?? ''
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
}

function diagnosticStream(label: string, value: string): string | undefined {
  const normalized = value.trim()
  return normalized.length === 0 ? undefined : `${label}:\n${normalized}`
}

/** Bounded technical context suitable for a local Desktop error window. */
export function formatRecoveryPluginRemoveFailure(cause: unknown): string {
  if (!(cause instanceof RecoveryPluginUninstallError) || cause.result === undefined) {
    return cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  }
  return [
    'DSH plugin uninstall failed.',
    `Command: dsh plugin --profile ${cause.result.profileName} ${PNPM_IGNORE_MINIMUM_RELEASE_AGE} remove ${cause.result.packageName}`,
    `Exit status: ${String(cause.result.exitCode)}`,
    `Signal: ${cause.result.signal ?? 'none'}`,
    diagnosticStream('stderr', cause.result.stderr),
    diagnosticStream('stdout', cause.result.stdout),
  ].filter((section): section is string => section !== undefined).join('\n\n')
}

/**
 * Remove one direct Profile dependency through the packaged `dsh plugin`
 * entry. That command owns both pnpm mutation and bundle reconciliation.
 */
export async function removeRecoveryPlugin(
  options: RecoveryPluginUninstallOptions,
): Promise<RecoveryPluginUninstallResult> {
  assertDesktopProfileName(options.profileName)
  if (!PACKAGE_NAME_PATTERN.test(options.packageName)) {
    throw new RecoveryPluginUninstallError('recovery plugin uninstall package name is invalid')
  }
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['DSH bootstrap', options.dshBootstrapPath],
    ['Profile directory', options.profileDir],
    ['Harness home', options.homeDir],
    ['Node command directory', options.nodeBinDir],
    ['Node command', options.nodeShimPath],
  ] as const) assertAbsolutePath(label, value)
  if (options.electronVersion.length === 0 || options.electronVersion.includes('\0')) {
    throw new RecoveryPluginUninstallError('recovery plugin uninstall Electron version is invalid')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBuffer) || maxBuffer <= 0) {
    throw new RecoveryPluginUninstallError('recovery plugin uninstall process limits are invalid')
  }
  options.signal?.throwIfAborted()
  const path = inheritedPath()
  const args = [
    '--expose-internals',
    options.dshBootstrapPath,
    'plugin',
    '--profile',
    options.profileName,
    PNPM_IGNORE_MINIMUM_RELEASE_AGE,
    'remove',
    options.packageName,
  ] as const
  return await new Promise<RecoveryPluginUninstallResult>((resolve, reject) => {
    execFile(options.appExecutable, args, {
      cwd: options.profileDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: path.length === 0 ? options.nodeBinDir : `${options.nodeBinDir}${delimiter}${path}`,
        NODE: options.nodeShimPath,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: options.homeDir,
        CI: 'true',
        npm_config_runtime: 'electron',
        npm_config_target: options.electronVersion,
        npm_config_disturl: ELECTRON_HEADERS_URL,
      },
      maxBuffer,
      timeout: timeoutMs,
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (cause, stdout, stderr) => {
      if (cause === null) {
        resolve({
          packageName: options.packageName,
          profileName: options.profileName,
          exitCode: 0,
          stdout,
          stderr,
        })
        return
      }
      reject(new RecoveryPluginUninstallError(
        `dsh plugin remove exited unsuccessfully (code=${String(cause.code)}, signal=${String(cause.signal)})`,
        {
          packageName: options.packageName,
          profileName: options.profileName,
          exitCode: cause.code ?? null,
          signal: cause.signal ?? null,
          stdout,
          stderr,
        },
      ))
    })
  })
}
