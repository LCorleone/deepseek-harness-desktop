/**
 * The skill collector: the CLI-name guard that keeps `rmSync` inside
 * `skills/`, and the verbatim layout copy the packer depends on.
 *
 * @module dsh-company-skills/tests/collect
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/** The slice of `scripts/collect-skills.mjs` these tests read. */
interface CollectModule {
  readonly SKILL_NAME_PATTERN: RegExp
  validateSkillName(name: unknown): string
  collectSkill(sourceDir: string, targetDir: string): { files: number }
  parseArgs(argv: readonly string[]): { sourceRoot: string; names: readonly string[] }
}

const collect = await import(
  /* @vite-ignore */ new URL('../scripts/collect-skills.mjs', import.meta.url).href
) as CollectModule

const scratchDirectories: string[] = []

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'company-skills-collect-'))
  scratchDirectories.push(directory)
  return directory
}

afterAll(async () => {
  for (const directory of scratchDirectories) await rm(directory, { recursive: true, force: true })
})

describe('collector skill-name guard', () => {
  it('accepts only the registry kebab-case grammar, so a CLI name can never escape skills/', () => {
    for (const name of ['ppt-designer', 'skill-creator', 'a', 'a1-b2']) {
      expect(collect.validateSkillName(name)).toBe(name)
    }
    for (const name of ['..', '../src', 'a/b', 'a\\b', '/etc', '.', '.hidden', 'Bad', 'trailing-', '', 7]) {
      expect(() => collect.validateSkillName(name), `accepted ${JSON.stringify(name)}`).toThrow(/invalid skill name/)
    }
  })

  it('defaults to the shipped set and parses an explicit source root', () => {
    expect(collect.parseArgs([]).names).toEqual(['ppt-designer', 'skill-creator'])
    const parsed = collect.parseArgs(['--source', '/tmp/hub', 'one', 'two'])
    expect(parsed.sourceRoot).toBe('/tmp/hub')
    expect(parsed.names).toEqual(['one', 'two'])
  })
})

describe('collector layout copy', () => {
  it('copies the source root layout verbatim and prunes interpreter caches', async () => {
    const source = join(await scratch(), 'ppt-designer')
    await mkdir(join(source, 'scripts', '__pycache__'), { recursive: true })
    await mkdir(join(source, 'editor', 'neo-ppt'), { recursive: true })
    await mkdir(join(source, 'reference'), { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '---\nname: ppt-designer\ndescription: d\n---\nbody\n')
    await writeFile(join(source, 'scripts', 'export_pptx.py'), 'print("hi")\n')
    await writeFile(join(source, 'scripts', '__pycache__', 'export_pptx.cpython-310.pyc'), 'stale\n')
    await writeFile(join(source, 'editor', 'index.html'), '<p>editor</p>\n')
    await writeFile(join(source, 'editor', 'neo-ppt', 'app.js'), 'app()\n')
    await writeFile(join(source, 'reference', 'pptd.md'), '# pptd\n')
    await writeFile(join(source, 'LICENSE.txt'), 'Apache License\n')

    const target = join(await scratch(), 'skills', 'ppt-designer')
    const result = collect.collectSkill(source, target)
    expect(result.files).toBe(6)

    /** Every file under `root`, as POSIX relative paths, sorted. */
    const list = async (root: string, base = root): Promise<string[]> => {
      const found: string[] = []
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) found.push(...await list(path, base))
        else found.push(join(path).slice(base.length + 1).split('\\').join('/'))
      }
      return found.sort()
    }

    expect(await list(target)).toEqual([
      'LICENSE.txt',
      'SKILL.md',
      'editor/index.html',
      'editor/neo-ppt/app.js',
      'reference/pptd.md',
      'scripts/export_pptx.py',
    ])
    expect(await readFile(join(target, 'editor', 'index.html'), 'utf8')).toBe('<p>editor</p>\n')
  })
})
