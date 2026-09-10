/**
 * Provider behaviour and the registration seam.
 *
 * The seam assertions are the load-bearing ones: the provider must be
 * registered from a disposable child fiber created by `ctx.inject(['skills'])`,
 * because a bare `ctx.skills` read inside a plugin fiber throws under Cordis
 * reflective contexts. The red-line half of that pair (the bare read really
 * does throw) is pinned here too, so the reason for the shape survives a future
 * "simplification".
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { emptyCatalog, loadCatalogFromFile, loadCatalogFromText } from '../src/catalog.js'
import * as CompanySkills from '../src/index.js'
import { createProvider } from '../src/provider.js'
import { FIXTURE_NAMES, PACKAGE_ROOT, toolsBundle, toolsCodec } from './tools.js'

const PACKAGE_ROOT_PATH = fileURLToPath(PACKAGE_ROOT)
const FIXTURES_DIR = join(PACKAGE_ROOT_PATH, 'fixtures')
const ASSET = new URL('../assets/skills.bundle', import.meta.url)

/** Canary lines that must never reach a candidate, a definition, or a log. */
const CANARIES = ['FIXTURE-HELLO-PLAINTEXT-CANARY', 'FIXTURE-NOTES-PLAINTEXT-CANARY']

const packed = (name: string) => toolsBundle.readSkillDirectory(join(FIXTURES_DIR, name))
const encode = (document: unknown): string => toolsCodec.encodeBundleBlob(JSON.stringify(document))

function providerFor(assetText: string, warnings: string[] = []): SkillProvider {
  return createProvider(loadCatalogFromText(assetText), (message) => warnings.push(message))
}

/** The provider's complete-array shorthand, narrowed for the assertions. */
async function candidatesOf(provider: SkillProvider): Promise<readonly SkillCandidate[]> {
  const listed = await provider.list({})
  if (!Array.isArray(listed)) throw new Error('the company-skills provider must list a candidate array')
  return listed
}

async function candidateNamed(provider: SkillProvider, name: string): Promise<SkillCandidate> {
  const candidate = (await candidatesOf(provider)).find((entry) => entry.name === name)
  if (candidate === undefined) throw new Error(`no candidate named ${name}`)
  return candidate
}

describe('company-skills provider', () => {
  it('registers through the reactive skills injection and disposes with the plugin', async () => {
    const ctx = new Context()
    const app = await ctx.plugin(CompanySkills)
    await ctx.plugin(SkillRegistry)

    const summaries = await ctx.skills.list()
    expect(summaries.map((summary) => summary.name)).toEqual(FIXTURE_NAMES)
    expect(summaries[0]).toMatchObject({
      description: packed('fixture-hello').description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'company-skills',
      source: 'bundled',
      resourceBase: { kind: 'opaque' },
    })

    await app.dispose()
    await expect(ctx.skills.list()).resolves.toEqual([])
  })

  it('waits for the registry, then registers: the injection is what makes the seam work', async () => {
    const ctx = new Context()
    const pending = ctx.plugin(CompanySkills)
    expect(ctx.get('skills')).toBeUndefined()

    await ctx.plugin(SkillRegistry)
    await pending
    expect((await ctx.skills.list()).map((summary) => summary.name)).toEqual(FIXTURE_NAMES)
  })

  it('a bare ctx.skills read inside a plugin fiber throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let thrown: unknown
    const probe = {
      name: 'probe-bare-skills-read',
      apply(probeCtx: Context): void {
        try {
          void probeCtx.skills
        } catch (error) {
          thrown = error
        }
      },
    }
    await ctx.plugin(probe)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('without inject')
  })

  it('registers from the inject child fiber, never from a direct ctx.skills use', () => {
    const source = readFileSync(join(PACKAGE_ROOT_PATH, 'src', 'index.ts'), 'utf8')
    expect(source).toMatch(/ctx\.inject\(\s*\['skills'\]\s*,/)
    expect(source).toMatch(/inner\.effect\(\(\) => inner\.skills\.registerProvider/)
    expect(source).not.toMatch(/\bctx\.skills\./)
  })

  it('list() exposes the index and never a body', async () => {
    const provider = providerFor(readFileSync(ASSET, 'utf8'))
    const candidates = await candidatesOf(provider)
    expect(candidates.map((candidate) => candidate.name)).toEqual(FIXTURE_NAMES)
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({
        description: packed(candidate.name).description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'company-skills',
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        locator: candidate.name,
        resourceBase: { kind: 'opaque' },
      })
    }
    const serialized = JSON.stringify(candidates)
    for (const canary of CANARIES) expect(serialized).not.toContain(canary)
    expect(serialized).not.toContain('"content"')
  })

  it('get() materializes exactly the requested body', async () => {
    const provider = providerFor(readFileSync(ASSET, 'utf8'))
    const hello = await provider.get(await candidateNamed(provider, 'fixture-hello'), {})
    expect(hello?.content).toBe(packed('fixture-hello').body)
    expect(hello?.resourceBase).toEqual({ kind: 'opaque', description: expect.any(String) })
    expect(JSON.stringify(hello)).not.toContain(CANARIES[1] as string)

    const notes = await ctxGet(provider, 'fixture-notes')
    expect(notes?.content).toBe(packed('fixture-notes').body)
    expect(JSON.stringify(notes)).not.toContain(CANARIES[0] as string)
  })

  it('returns undefined for an unknown name and for an unusable locator', async () => {
    const warnings: string[] = []
    const provider = providerFor(readFileSync(ASSET, 'utf8'), warnings)
    await expect(provider.get({ name: 'nope', locator: 'nope' } as SkillCandidate, {})).resolves.toBeUndefined()
    await expect(provider.get({ name: 'fixture-hello', locator: 42 } as unknown as SkillCandidate, {})).resolves.toBeUndefined()
    expect(warnings.some((message) => message.includes('unknown company skill'))).toBe(true)
    expect(warnings.some((message) => message.includes('locator is not a skill name'))).toBe(true)
  })

  it('lists a skill whose payload is broken and refuses only that skill', async () => {
    const broken = { name: 'fixture-broken', description: 'A skill whose payload was corrupted.', body: 42, scripts: [], assets: [] }
    const health = packed('fixture-hello')
    const warnings: string[] = []
    const provider = providerFor(
      encode({ version: 1, skills: [broken, health] }),
      warnings,
    )

    const candidates = await candidatesOf(provider)
    expect(candidates.map((candidate) => candidate.name)).toEqual(['fixture-broken', 'fixture-hello'])
    await expect(provider.get(await candidateNamed(provider, 'fixture-broken'), {})).resolves.toBeUndefined()
    expect(warnings.some((message) => message.includes('"fixture-broken" is not loadable'))).toBe(true)
    // The healthy neighbour is unaffected: list() never validated a payload.
    const definition = await provider.get(await candidateNamed(provider, 'fixture-hello'), {})
    expect(definition?.content).toBe(health.body)
  })

  it('degrades to an empty catalog instead of throwing on a missing or corrupt asset', async () => {
    const missing = loadCatalogFromFile(new URL('file:///definitely/not/here/skills.bundle'))
    expect(missing.entries).toEqual([])
    expect(missing.reason).toMatch(/unreadable/)

    const corrupt = [
      '',
      'not base64 at all',
      encode('{not json'),
      encode({ version: 2, skills: [packed('fixture-hello')] }),
      encode({ version: 1, skills: [] }),
      encode({ version: 1, skills: [{ name: 'fixture-hello' }] }),
    ]
    for (const text of corrupt) {
      const catalog = loadCatalogFromText(text)
      expect(catalog.entries, text.slice(0, 24)).toEqual([])
      expect(catalog.reason).toBeDefined()
      expect(catalog.skill('fixture-hello').ok).toBe(false)
      const provider = createProvider(catalog)
      await expect(provider.list({})).resolves.toEqual([])
    }
  })

  it('survives a degraded catalog on a live host: it registers, lists nothing, and warns once', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const warnings: string[] = []
    const provider = createProvider(emptyCatalog('the company skills container did not load'), (message) => warnings.push(message))
    const app = await ctx.plugin({
      name: 'degraded-company-skills',
      inject: ['skills'],
      apply(childCtx: Context): void {
        childCtx.inject(['skills'], (inner) => {
          inner.effect(() => inner.skills.registerProvider(() => provider))
        })
      },
    })

    await expect(ctx.skills.list()).resolves.toEqual([])
    await expect(ctx.skills.get('fixture-hello')).resolves.toBeUndefined()
    await expect(ctx.skills.list()).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
    await app.dispose()
  })

  it('exports the shipped catalog for inspection', () => {
    expect(CompanySkills.name).toBe('company-skills')
    expect(CompanySkills.inject).toEqual(['skills'])
    expect(CompanySkills.catalog.reason).toBeUndefined()
    expect(CompanySkills.catalog.entries.map((entry) => entry.name)).toEqual(FIXTURE_NAMES)
  })
})

/** Load one skill through the provider the way the registry does. */
async function ctxGet(provider: SkillProvider, name: string) {
  return provider.get(await candidateNamed(provider, name), {})
}
