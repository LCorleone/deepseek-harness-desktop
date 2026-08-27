import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stageCompanyManifestForCliChildren } from '../src/company-manifest-handoff.ts'
import { DESKTOP_COMPANY_MANIFEST_FILE_ENV } from '../src/company-manifest-origin.ts'

const MANIFEST_TEXT = '{"manifestVersion":"1.0.0","sequence":3}'

function temporaryUserData(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-company-manifest-handoff-'))
}

describe('company manifest CLI hand-off staging', () => {
  it('stages nothing without manifest bytes', async () => {
    const userDataDir = temporaryUserData()
    try {
      await expect(stageCompanyManifestForCliChildren(userDataDir, 'gen-1', undefined))
        .resolves.toBeUndefined()
      await expect(stageCompanyManifestForCliChildren(userDataDir, 'gen-1', ''))
        .resolves.toBeUndefined()
      expect(existsSync(join(userDataDir, 'cli-company-manifest'))).toBe(false)
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('writes a private generation-scoped file and hands its path to the children', async () => {
    const userDataDir = temporaryUserData()
    try {
      const handoff = await stageCompanyManifestForCliChildren(userDataDir, 'gen-1', MANIFEST_TEXT)

      expect(handoff).toBeDefined()
      const file = handoff!.environment[DESKTOP_COMPANY_MANIFEST_FILE_ENV]!
      expect(file).toBe(join(userDataDir, 'cli-company-manifest', 'company-manifest-gen-1.json'))
      expect(readFileSync(file, 'utf8')).toBe(MANIFEST_TEXT)
      expect(Object.keys(handoff!.environment)).toEqual([DESKTOP_COMPANY_MANIFEST_FILE_ENV])
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('accepts Uint8Array bytes and removes the staging file on dispose, exactly once', async () => {
    const userDataDir = temporaryUserData()
    try {
      const handoff = await stageCompanyManifestForCliChildren(
        userDataDir,
        'gen-2',
        new TextEncoder().encode(MANIFEST_TEXT),
      )
      const file = handoff!.environment[DESKTOP_COMPANY_MANIFEST_FILE_ENV]!
      expect(readFileSync(file, 'utf8')).toBe(MANIFEST_TEXT)

      handoff!.dispose()
      handoff!.dispose()
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('sweeps stale staged files from crashed generations but leaves neighbors alone', async () => {
    const userDataDir = temporaryUserData()
    try {
      const directory = join(userDataDir, 'cli-company-manifest')
      mkdirSync(directory, { recursive: true })
      const stale = join(directory, 'company-manifest-gen-0.json')
      const neighbor = join(directory, 'operator-notes.txt')
      writeFileSync(stale, MANIFEST_TEXT)
      writeFileSync(neighbor, 'keep')

      const handoff = await stageCompanyManifestForCliChildren(userDataDir, 'gen-3', MANIFEST_TEXT)

      expect(existsSync(stale)).toBe(false)
      expect(existsSync(neighbor)).toBe(true)
      expect(readdirSync(directory).sort()).toEqual(['company-manifest-gen-3.json', 'operator-notes.txt'])
      handoff!.dispose()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('rejects malformed staging anchors and generation ids loudly', async () => {
    await expect(stageCompanyManifestForCliChildren('relative/dir', 'gen-1', MANIFEST_TEXT))
      .rejects.toThrow('must be an absolute user-data path without NUL')
    await expect(stageCompanyManifestForCliChildren(join(tmpdir(), 'x\0y'), 'gen-1', MANIFEST_TEXT))
      .rejects.toThrow('must be an absolute user-data path without NUL')
    await expect(stageCompanyManifestForCliChildren(join(tmpdir(), 'ok'), 'not a uuid!', MANIFEST_TEXT))
      .rejects.toThrow('must carry a generation id')
  })
})
