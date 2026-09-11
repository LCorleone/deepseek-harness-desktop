/**
 * Batch-4 layout fidelity: the collected bundle preserves each source skill's
 * root layout verbatim, and the staged tree reconstructs it exactly.
 *
 * This is the regression the batch-4 review found: remapping every non-script
 * entry under a synthetic `assets/` prefix moved `editor/index.html` to
 * `<staged>/assets/editor/index.html`, so ppt-designer's own
 * `resolve_editor_root()` (`SKILL_DIR / "editor"`, with
 * `SKILL_DIR = Path(__file__).parent.parent`) could never find the editor. The
 * load-bearing case below runs the real collected `scripts/export_pptx.py`,
 * imports it as a sibling module, and calls its `resolve_editor_root()` against
 * the staged tree.
 *
 * @module dsh-company-skills/tests/collected-layout
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import type { SkillBundle, SkillBundleEntry } from '../src/bundle.js'
import { compareCodePoints } from '../src/bundle.js'
import { loadCatalogFromFile, loadCatalogFromText, type CompanySkillCatalog } from '../src/catalog.js'
import { ASSETS_ENV_VAR, createScriptExecutor, type ScriptSpawn } from '../src/execute.js'
import { localSpawn } from './local-spawn.js'
import { pythonInterpreter, pythonResolution } from './python.js'
import { toolsCodec } from './tools.js'

/** The shipped container, decoded once through the plugin's own catalog. */
const SHIPPED: CompanySkillCatalog = loadCatalogFromFile(new URL('../assets/skills.bundle', import.meta.url))

/** One shipped skill's validated bundle, or a hard failure naming the reason. */
function shippedBundle(name: string): SkillBundle {
  const loaded = SHIPPED.skill(name)
  if (!loaded.ok) throw new Error(loaded.reason)
  return loaded.bundle
}

/** Every carried entry path, scripts and assets together. */
function carriedPaths(bundle: SkillBundle): string[] {
  return [...bundle.scripts, ...bundle.assets].map((entry) => entry.path)
}

describe('the collected bundle keys entries by their source-relative path', () => {
  it('keeps the ppt-designer root layout, with no synthetic assets/ prefix', () => {
    const bundle = shippedBundle('ppt-designer')
    const paths = carriedPaths(bundle)

    expect(bundle.scripts.map((entry) => entry.path)).toContain('scripts/export_pptx.py')
    expect(paths).toContain('editor/index.html')
    expect(paths).toContain('reference/pptd.md')
    expect(paths.some((path) => path.startsWith('pptd-template/'))).toBe(true)
    // The batch-4 remap that broke resolve_editor_root() is gone.
    expect(paths.some((path) => path.startsWith('assets/'))).toBe(false)
  }, 120_000)

  it('keeps skill-creator references and license at the skill root', () => {
    const bundle = shippedBundle('skill-creator')
    const paths = carriedPaths(bundle)
    expect(paths).toContain('references/workflows.md')
    expect(paths).toContain('references/output-patterns.md')
    expect(paths).toContain('LICENSE.txt')
    expect(bundle.scripts.map((entry) => entry.path)).toContain('scripts/init_skill.py')
  }, 120_000)
})

describe('company_skill_list discovers the collected layout instead of guessing it', () => {
  /** A listing never spawns and never stages; a throwing seam proves both. */
  const noSpawn: ScriptSpawn = () => { throw new Error('a listing must never spawn') }
  const executor = createScriptExecutor({ catalog: SHIPPED, spawn: noSpawn })

  it('lists every carried ppt-designer path, sorted, including the real finance presets', async () => {
    const result = await executor.list({ skill: 'ppt-designer' })
    // The whole carried tree, in one code-point-sorted list: the oracle is
    // the bundle's own entry index, reconstructed independently.
    expect(result.entries).toEqual(carriedPaths(shippedBundle('ppt-designer')).sort(compareCodePoints))
    expect(result.total).toBe(result.entries.length)
    expect(result.truncated).toBe(false)
    // The exact entries a real device blind-guessed wrong (investment/equity/
    // deep-blue do not exist; these are the real names).
    expect(result.entries).toContain('reference/design_system/finance/black-gold-ledger/design.md')
    expect(result.entries).toContain('reference/pptd.md')
    expect(result.entries).toContain('scripts/export_pptx.py')
  }, 120_000)

  it('narrows to the finance presets: exactly the six design.md files', async () => {
    const result = await executor.list({ skill: 'ppt-designer', path: 'reference/design_system/finance' })
    expect(result.entries).toEqual([
      'reference/design_system/finance/black-gold-ledger/design.md',
      'reference/design_system/finance/ebony-ledger/design.md',
      'reference/design_system/finance/honey-orange-memo/design.md',
      'reference/design_system/finance/lake-blue-memo/design.md',
      'reference/design_system/finance/prospect-annual/design.md',
      'reference/design_system/finance/rice-paper-annual/design.md',
    ])
    expect(result.total).toBe(6)
    expect(result.truncated).toBe(false)
  }, 120_000)

  it('treats a matching-nothing prefix as a normal empty listing', async () => {
    const result = await executor.list({ skill: 'ppt-designer', path: 'reference/nope' })
    expect(result).toEqual({ skill: 'ppt-designer', path: 'reference/nope', entries: [], total: 0, truncated: false })
  }, 120_000)
})

describe("the staged tree satisfies ppt-designer's own editor lookup", () => {
  it.skipIf(pythonInterpreter === undefined)(
    'resolves <staged>/editor/index.html from scripts/export_pptx.py',
    async () => {
      const bundle = shippedBundle('ppt-designer')
      // A probe script that imports the collected sibling module and asks it
      // where the editor is — exactly the call export_pptx makes at export time.
      const probe = [
        'import os, sys',
        'from pathlib import Path',
        'os.environ.pop("OPEN_KIMI_PPT_EDITOR", None)',
        'sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))',
        'import export_pptx',
        'print("SKILL-DIR=" + str(Path(export_pptx.__file__).resolve().parent.parent))',
        'print("EDITOR-INDEX=" + str(export_pptx.resolve_editor_root() / "index.html"))',
      ].join('\n')
      const probeEntry: SkillBundleEntry = {
        path: 'scripts/zz_editor_probe.py',
        content: Buffer.from(probe, 'utf8').toString('base64'),
      }
      const entries = [...bundle.scripts, ...bundle.assets, probeEntry]
      const document = {
        name: bundle.name,
        description: bundle.description,
        body: bundle.body,
        scripts: entries.filter((entry) => entry.path.startsWith('scripts/')),
        assets: entries.filter((entry) => !entry.path.startsWith('scripts/')),
      }
      const catalog = loadCatalogFromText(
        toolsCodec.encodeBundleBlob(JSON.stringify({ version: 1, skills: [document] })),
      )

      const tempRoot = await mkdtemp(join(tmpdir(), 'company-skills-layout-'))
      let stagedRoot = ''
      const spawn: ScriptSpawn = (spec: SubprocessSpawnSpec) => {
        stagedRoot = spec.env?.[ASSETS_ENV_VAR] ?? ''
        return localSpawn(spec)
      }
      try {
        const executor = createScriptExecutor({
          catalog,
          spawn,
          tempRoot,
          ...(pythonResolution === undefined ? {} : { interpreterResolution: pythonResolution }),
        })
        const result = await executor.run({
          skill: 'ppt-designer',
          script: 'scripts/zz_editor_probe.py',
          sessionKey: 'layout',
          signal: new AbortController().signal,
        })

        expect(result.exitCode).toBe(0)
        // The interpreter's own `__file__` places the skill root at the staged
        // root, and resolve_editor_root() finds the editor beside it.
        expect(result.stdout.text).toContain(`SKILL-DIR=${stagedRoot}`)
        expect(result.stdout.text).toContain(`EDITOR-INDEX=${join(stagedRoot, 'editor', 'index.html')}`)
        // And the whole staged tree is gone once the run settles.
        await expect(stat(join(stagedRoot, 'editor', 'index.html'))).rejects.toThrow()
      } finally {
        await rm(tempRoot, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
