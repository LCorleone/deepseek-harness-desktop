/**
 * Launcher-side staging of the origin-mode company manifest for bundled-Node
 * CLI children.
 *
 * The desktop-cli subprocess (market installs and terminal plugin adds both
 * spawn it) has no Electron `net` module, so its own fetch cannot reach a
 * corporate-CA origin (see `electron-company-manifest.ts` for the TLS stack
 * split). Instead, the Electron main process stages the exact manifest bytes
 * it just fetched and verified for boot composition into one private,
 * generation-scoped file under the Electron user-data directory and points
 * the children at it through `DSH_COMPANY_MANIFEST_FILE` — the same
 * trusted-parent hand-off pattern the four `DSH_DESKTOP_POLICY_*` entries
 * use. The child still hands the bytes to `verifyCompanyManifest` itself:
 * the signature chain, not the transport, owns the trust decision.
 *
 * Lifecycle: the staging file is removed through the generation's release
 * hook (app quit, recovery) — installs only run inside a live generation. A
 * crash that skips the hook leaks at most one ≤4 MiB JSON file, and the next
 * origin-mode boot sweeps stale staged files before writing its own. A child
 * holding a stale path after a restart falls back to its restricted network
 * fetch and fails closed on unreachable origins.
 */

import { readdirSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DESKTOP_COMPANY_MANIFEST_FILE_ENV } from './company-manifest-origin.ts'

const BIN_NAME = 'dsh-plugin-desktop'
const STAGING_DIRECTORY_NAME = 'cli-company-manifest'
const STAGED_FILE_PREFIX = 'company-manifest-'
const STAGED_FILE_SUFFIX = '.json'
const STAGING_DIRECTORY_MODE = 0o700
const STAGED_FILE_MODE = 0o600
const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u

/** One staged manifest hand-off and its environment entry for CLI children. */
export interface CompanyManifestCliHandoff {
  /** Environment entries to merge into every desktop-cli child environment. */
  readonly environment: Readonly<Record<string, string>>
  /** Idempotent removal of the staging file; safe to call more than once. */
  readonly dispose: () => void
}

/**
 * Stage verified origin-mode manifest bytes for the CLI children of one
 * startup generation.
 * @param userDataDir - Electron-owned persistent user-data directory.
 * @param generationId - opaque identity of the owning startup generation.
 * @param manifestBytes - the manifest text the launcher fetched for boot
 *   verification; `undefined` (or empty) skips staging so the children fall
 *   back to their restricted network fetch.
 * @returns the hand-off, or undefined when there is nothing to stage.
 * @throws when the user-data anchor or the generation id is malformed, or the
 *   staging write fails — the caller treats boot-time staging as required.
 */
export async function stageCompanyManifestForCliChildren(
  userDataDir: string,
  generationId: string,
  manifestBytes: string | Uint8Array | undefined,
): Promise<CompanyManifestCliHandoff | undefined> {
  if (manifestBytes === undefined || manifestBytes.length === 0) return undefined
  if (typeof userDataDir !== 'string' || !isAbsolute(userDataDir) || userDataDir.includes('\0')) {
    throw new TypeError(`${BIN_NAME}: the company manifest staging anchor must be an absolute user-data path without NUL`)
  }
  if (typeof generationId !== 'string' || !GENERATION_ID_PATTERN.test(generationId)) {
    throw new TypeError(`${BIN_NAME}: the company manifest staging name must carry a generation id`)
  }
  const text = typeof manifestBytes === 'string' ? manifestBytes : Buffer.from(manifestBytes).toString('utf8')
  const directory = join(userDataDir, STAGING_DIRECTORY_NAME)
  const file = join(directory, `${STAGED_FILE_PREFIX}${generationId}${STAGED_FILE_SUFFIX}`)
  await writeFileAtomic(file, text, { mode: STAGED_FILE_MODE, dirMode: STAGING_DIRECTORY_MODE })
  // Best-effort sweep of files leaked by generations that crashed before
  // their release hook ran; anything else in the directory stays untouched.
  const staged = basename(file)
  try {
    for (const entry of readdirSync(directory)) {
      if (entry === staged
        || !entry.startsWith(STAGED_FILE_PREFIX)
        || !entry.endsWith(STAGED_FILE_SUFFIX)) continue
      rmSync(join(directory, entry), { force: true })
    }
  } catch {
    // A failed sweep only leaves bounded stale files for the next boot.
  }
  let disposed = false
  return {
    environment: { [DESKTOP_COMPANY_MANIFEST_FILE_ENV]: file },
    dispose: () => {
      if (disposed) return
      disposed = true
      try {
        rmSync(file, { force: true })
      } catch {
        // Best-effort removal; the next origin-mode boot sweeps the file.
      }
    },
  }
}
