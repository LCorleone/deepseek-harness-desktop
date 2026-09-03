/**
 * P7 2a review fix (P3): the staging keepalive must not delete a staged
 * tarball over a transient read failure. `sha512OfStagedFile` used to fold
 * EACCES/EMFILE/AV-lock errors into "not intact", so a momentary unreadable
 * staging location deleted bytes the profile lockfile still referenced —
 * exactly the stranding the keepalive exists to prevent. Those failures now
 * keep the file unverified and surface through the `warn` sink instead.
 *
 * The read failure is injected by wrapping `openSync` for the staged `.tgz`
 * path only (this spec's file-scoped mock); every other file operation is
 * the real one, so the staging write path (`.tmp` sibling + rename) stays
 * untouched.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stageCompanyMarketTarball } from '../src/desktop-market.ts'
import { desktopMarketTarballStagingPath } from '../src/pnpm.ts'

const injectedReadFailure = vi.hoisted(() => ({ code: undefined as string | undefined }))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (
      path: import('node:fs').PathLike,
      flags: string | number,
      mode?: import('node:fs').Mode | null,
    ): number => {
      const name = String(path)
      if (injectedReadFailure.code !== undefined
        && name.includes('.dsh-market-tarballs') && name.endsWith('.tgz')) {
        const code = injectedReadFailure.code
        const error = new Error(`${code}: injected staging read failure (open)`) as NodeJS.ErrnoException
        error.code = code
        throw error
      }
      return actual.openSync(path, flags, mode)
    },
  }
})

const CATALOG_ORIGIN = 'https://gitlab.company.example'
const TARBALL_BYTES = Buffer.from('company-hardened-plugin tarball fixture\n', 'utf8')
const TARBALL_URL = `${CATALOG_ORIGIN}/julu/dsh-desktop-config/-/packages/company-hardened-plugin-2.1.0.tgz`
const TARBALL_INTEGRITY = `sha512-${createHash('sha512').update(TARBALL_BYTES).digest('base64')}`

const roots: string[] = []

afterEach(() => {
  injectedReadFailure.code = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A profile whose staged tarball still hashes to the signed integrity. */
function profileWithIntactStaging(): { profileDir: string; stagedPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-company-keepalive-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'web')
  const stagedPath = desktopMarketTarballStagingPath(profileDir, 'company-hardened-plugin', '2.1.0')
  mkdirSync(dirname(stagedPath), { recursive: true })
  writeFileSync(stagedPath, TARBALL_BYTES)
  return { profileDir, stagedPath }
}

const failingRequest = async (): Promise<Response> => {
  throw new TypeError('network is unreachable')
}

describe('staging keepalive under transient read failures', () => {
  it.each(['EMFILE', 'EACCES', 'EBUSY'] as const)('keeps the intact staged tarball and warns on %s', async code => {
    const { profileDir, stagedPath } = profileWithIntactStaging()
    const warnings: string[] = []
    injectedReadFailure.code = code
    try {
      await expect(stageCompanyMarketTarball({
        policy: { companyCatalogOrigin: CATALOG_ORIGIN },
        source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
        packageName: 'company-hardened-plugin',
        version: '2.1.0',
        profileDir,
        request: failingRequest,
        warn: message => warnings.push(message),
      })).rejects.toThrow('could not be downloaded')
    } finally {
      injectedReadFailure.code = undefined
    }
    // The staged bytes survive the unreadable keepalive — never deleted over
    // a possibly momentary error — and the warning makes it loud.
    expect(readFileSync(stagedPath)).toEqual(TARBALL_BYTES)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not be read for the keepalive check')
    expect(warnings[0]).toContain(code)
    expect(warnings[0]).toContain('keeping it unverified')
  })

  it('still removes a corrupt staged tarball when the read succeeds', async () => {
    // The widened keep branch must not weaken the remove branch: bytes that
    // demonstrably hash away from the signed integrity are still deleted,
    // and no warning fires for a decisive (readable) mismatch.
    const { profileDir, stagedPath } = profileWithIntactStaging()
    writeFileSync(stagedPath, Buffer.from('tampered bytes\n'))
    const warnings: string[] = []
    await expect(stageCompanyMarketTarball({
      policy: { companyCatalogOrigin: CATALOG_ORIGIN },
      source: { kind: 'tarball', url: TARBALL_URL, integrity: TARBALL_INTEGRITY },
      packageName: 'company-hardened-plugin',
      version: '2.1.0',
      profileDir,
      request: failingRequest,
      warn: message => warnings.push(message),
    })).rejects.toThrow('could not be downloaded')
    expect(warnings).toEqual([])
    expect(existsSync(stagedPath)).toBe(false)
  })
})
