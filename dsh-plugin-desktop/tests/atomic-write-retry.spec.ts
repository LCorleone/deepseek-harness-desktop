/**
 * Retry contract of the `@deepseek-ai/dsh-atomic-write` yarn patch
 * (`.yarn/patches/@deepseek-ai-dsh-atomic-write-npm-0.1.1-rc.2-be3f055a11.patch`):
 * the rename commit of `writeFileAtomic` retries transient EPERM/EACCES/EINVAL
 * failures with bounded exponential backoff — the Windows antivirus/indexer
 * race that fatally broke real-machine market installs (`EPERM: operation not
 * permitted, rename <settings.yaml>.tmp -> settings.yaml` surfacing out of
 * `persistSection`) — and rethrows anything else, or a failure that outlasts
 * the window, as the original error. The rename boundary is faked here
 * because a real Linux rename as root never produces EPERM.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/**
 * Rename failure script shared with the mocked `node:fs/promises`: how many
 * renames still fail, and with which codes (defaults to EPERM — the code the
 * real-machine log showed). `calls` counts every rename attempt.
 */
const renameScript = vi.hoisted(() => ({
  remaining: 0,
  codes: [] as string[],
  calls: 0,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameScript.calls++
      if (renameScript.remaining > 0) {
        renameScript.remaining--
        const code = renameScript.codes.length > 0 ? renameScript.codes.shift()! : 'EPERM'
        throw Object.assign(
          new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`),
          { code },
        )
      }
      return actual.rename(from, to)
    },
  }
})

const roots: string[] = []

/** A directory holding one pre-existing settings-like target file. */
function temporaryTarget(label: string, initial = 'previous\n'): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-atomic-write-retry-${label}-`))
  roots.push(root)
  const target = join(root, 'settings.yaml')
  writeFileSync(target, initial)
  return target
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  renameScript.remaining = 0
  renameScript.codes = []
  renameScript.calls = 0
  vi.restoreAllMocks()
})

describe('writeFileAtomic transient rename retry (Windows EPERM patch)', () => {
  it('commits the new content when the first two renames fail EPERM and the third succeeds', async () => {
    const target = temporaryTarget('recovers')
    renameScript.remaining = 2
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await writeFileAtomic(target, 'next content\n', { mode: 0o600 })
    expect(readFileSync(target, 'utf8')).toBe('next content\n')
    // The committed file replaced the target in place: no temp litter left.
    expect(readdirSync(dirname(target))).toEqual(['settings.yaml'])
    // One warn-level summary records the recovered transient failure: warn
    // rides stderr, which packaged captures keep — console.debug aliases
    // stdout-bound console.log in Node and is dropped in packaged GUI runs.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('dsh-atomic-write: atomic rename onto')
    expect(warn.mock.calls[0]?.[0]).toContain('succeeded after 2 retries')
    expect(warn.mock.calls[0]?.[0]).toContain('transient EPERM')
    expect(renameScript.calls).toBe(3)
  })

  it.each(['EPERM', 'EACCES', 'EINVAL'])('retries %s as transient', async code => {
    const target = temporaryTarget(`transient-${code}`)
    renameScript.remaining = 1
    renameScript.codes = [code]
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await writeFileAtomic(target, 'recovered\n', { mode: 0o600 })
    expect(readFileSync(target, 'utf8')).toBe('recovered\n')
  })

  it('rethrows the original error, code intact, after exactly five retries of a permanent EPERM', async () => {
    const target = temporaryTarget('exhausts', 'untouched\n')
    renameScript.remaining = Number.MAX_SAFE_INTEGER
    const failure = await writeFileAtomic(target, 'never lands\n', { mode: 0o600 })
      .then(() => undefined, (cause: unknown) => cause) as NodeJS.ErrnoException
    // The original error shape rides through unwrapped: same code, same
    // message form the real-machine log showed.
    expect(failure).toBeInstanceOf(Error)
    expect(failure.code).toBe('EPERM')
    expect(failure.message).toContain('EPERM: operation not permitted, rename')
    // One initial attempt plus the five backoff retries (25/50/100/200/400ms).
    expect(renameScript.calls).toBe(6)
    // The target keeps its previous complete content and no temp sibling stays.
    expect(readFileSync(target, 'utf8')).toBe('untouched\n')
    expect(readdirSync(dirname(target))).toEqual(['settings.yaml'])
  })

  it('does not retry a non-transient rename failure', async () => {
    const target = temporaryTarget('immediate')
    renameScript.remaining = Number.MAX_SAFE_INTEGER
    renameScript.codes = ['ENOENT']
    const failure = await writeFileAtomic(target, 'never lands\n', { mode: 0o600 })
      .then(() => undefined, (cause: unknown) => cause) as NodeJS.ErrnoException
    expect(failure.code).toBe('ENOENT')
    expect(renameScript.calls).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('previous\n')
  })
})
