/**
 * The container decoder, pinned against the packer that writes it.
 *
 * The interesting assertion is the cross-implementation one: bytes produced by
 * `tools/company-skills/pack.mjs` must decode through this package's
 * independent decoder into exactly the canonical document the packer
 * canonicalized, and into a source tree that equals the fixture directory byte
 * for byte. That is what stops the two copies of the format from drifting.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { validateSkillBundle } from '../src/bundle.js'
import { BUNDLE_BLOB_EXPORT_NAME, OBFUSCATION_KEY, OBFUSCATION_KEY_ID, decodeBundleBlob, extractBundleBlob } from '../src/codec.js'
import { CONTAINER_VERSION, decodeContainer, parseContainer } from '../src/container.js'
import {
  FIXTURES_DIR,
  FIXTURE_NAMES,
  PACKAGE_ROOT,
  REPO_ROOT,
  SHIPPED_SKILL_NAMES,
  SKILLS_DIR,
  toolsBundle,
  toolsCodec,
  toolsReleaseSurface,
} from './tools.js'

const REPO_ROOT_PATH = fileURLToPath(REPO_ROOT)
const PACKAGE_ROOT_PATH = fileURLToPath(PACKAGE_ROOT)
const FIXTURES_ROOT_PATH = fileURLToPath(FIXTURES_DIR)
const SKILLS_ROOT_PATH = fileURLToPath(SKILLS_DIR)
const ASSET_PATH = join(PACKAGE_ROOT_PATH, 'assets', 'skills.bundle')
const PACKER = join(REPO_ROOT_PATH, 'tools', 'company-skills', 'pack.mjs')

/** Canary lines that must never appear in a packed artifact: one distinctive
 * body line from each collected real skill (the fixture canaries live in the
 * fixtures-root tests; fixtures are no longer shipped). */
const CANARIES = [
  'Strictly follow the Deloitte template. The deliverable must look like the template',
  'The context window is a public good',
]

const scratchDirectories: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-company-skills-test-'))
  scratchDirectories.push(directory)
  return directory
}

afterAll(() => {
  for (const directory of scratchDirectories) rmSync(directory, { recursive: true, force: true })
})

/** Run the batch-1.5 packer over the fixture skills root; returns the artifact text. */
function packFixtures(extension: string, directory = scratch()): string {
  const out = join(directory, `container${extension}`)
  execFileSync(process.execPath, [PACKER, '--skills', FIXTURES_ROOT_PATH, '--out', out], {
    cwd: REPO_ROOT_PATH,
    // Piped so the packer's authoring lint never pollutes the test output.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return readFileSync(out, 'utf8')
}

/** Run the batch-1.5 packer over the collected real skills root. */
function packCompanySkills(extension: string, directory = scratch()): string {
  const out = join(directory, `company${extension}`)
  execFileSync(process.execPath, [PACKER, '--skills', SKILLS_ROOT_PATH, '--out', out], {
    cwd: REPO_ROOT_PATH,
    // The collected skills legitimately mention example paths in prose, so
    // their dangling-reference lint is expected; pipe it away here.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return readFileSync(out, 'utf8')
}

/** The canonical manifest of one shipped or fixture skill, from its plaintext source. */
function manifestOf(name: string): { name: string; description: string; body: string } {
  const root = FIXTURE_NAMES.includes(name) ? FIXTURES_ROOT_PATH : SKILLS_ROOT_PATH
  return toolsBundle.parseSkillManifest(readFileSync(join(root, name, 'SKILL.md'), 'utf8'))
}

/** Every file under `root`, as package-relative POSIX paths, sorted. */
function listFiles(root: string, base = root): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...listFiles(path, base))
    else if (entry.isFile()) found.push(relative(base, path).split('\\').join('/'))
  }
  return found.sort()
}

/** Encode one hand-built document the way the packer would. */
function encode(document: unknown): string {
  return toolsCodec.encodeBundleBlob(JSON.stringify(document))
}

/** One valid element straight from the packer. */
function packedSkill(name = 'fixture-hello') {
  return toolsBundle.readSkillDirectory(join(FIXTURE_NAMES.includes(name) ? FIXTURES_ROOT_PATH : SKILLS_ROOT_PATH, name))
}

describe('company skills container decode', () => {
  it('shares the codec constants with the packer', () => {
    expect(OBFUSCATION_KEY).toBe(toolsCodec.OBFUSCATION_KEY)
    expect(OBFUSCATION_KEY_ID).toBe(toolsCodec.OBFUSCATION_KEY_ID)
    expect(BUNDLE_BLOB_EXPORT_NAME).toBe(toolsCodec.BUNDLE_BLOB_EXPORT_NAME)
  })

  it('decodes the shipped asset into one index entry per collected skill', () => {
    const entries = decodeContainer(readFileSync(ASSET_PATH, 'utf8'))
    expect(entries.map((entry) => entry.name)).toEqual(SHIPPED_SKILL_NAMES)
    for (const entry of entries) {
      expect(entry.description).toBe(manifestOf(entry.name).description)
    }
  })

  it('reads the packed container the same way the packer canonicalized it', () => {
    const artifact = packFixtures('.bundle')
    const entries = decodeContainer(artifact)
    const oracle = JSON.parse(decodeBundleBlob(extractBundleBlob(artifact))) as { version: number; skills: readonly unknown[] }
    expect(oracle.version).toBe(CONTAINER_VERSION)
    expect(entries.map((entry) => entry.name)).toEqual(
      oracle.skills.map((skill) => (skill as { name: string }).name),
    )

    for (const entry of entries) {
      const bundle = validateSkillBundle(entry.element)
      const packed = packedSkill(bundle.name)
      // The plugin's decoded element is byte-identical to the packer's
      // canonical element — no re-ordering, no field loss, no coercion.
      expect(JSON.stringify(bundle)).toBe(toolsBundle.bundlePlaintextJson(packed))
      // ...and it materializes back into the fixture directory byte for byte.
      const reconstructed = toolsBundle.bundleSourceFiles(bundle)
      expect(reconstructed.map((file) => file.path).sort()).toEqual(listFiles(join(FIXTURES_ROOT_PATH, bundle.name)))
      for (const file of reconstructed) {
        expect(file.bytes.equals(readFileSync(join(FIXTURES_ROOT_PATH, bundle.name, file.path)))).toBe(true)
      }
    }
  })

  it('accepts both shipped forms: the raw blob and the generated module', () => {
    const blob = packFixtures('.bundle')
    const module = packFixtures('.js')
    expect(extractBundleBlob(module)).toBe(extractBundleBlob(blob))
    expect(decodeContainer(module)).toEqual(decodeContainer(blob))
  })

  it('is deterministic: the same sources always produce the same bytes', () => {
    expect(packFixtures('.bundle')).toBe(packFixtures('.bundle'))
    // The shipped asset is exactly a re-pack of the collected skills root —
    // what `verify:bundle` asserts in CI, pinned here against the decoder too.
    expect(packCompanySkills('.bundle')).toBe(readFileSync(ASSET_PATH, 'utf8'))
  })

  it('carries no plaintext of any bundled skill', () => {
    const artifact = readFileSync(ASSET_PATH, 'utf8')
    for (const canary of CANARIES) expect(artifact.includes(canary)).toBe(false)
    expect(artifact.includes('# Skill Creator')).toBe(false)
    expect(artifact.includes('"skills"')).toBe(false)

    // Positive control: the blocked plaintext really is inside the artifact, so
    // the assertions above cannot pass vacuously. Body prose sits in the
    // container document (newline-escaped but literal); carried assets sit
    // base64-encoded inside their element, one decode away.
    const container = JSON.parse(decodeBundleBlob(extractBundleBlob(artifact))) as {
      skills: readonly {
        name: string
        body: string
        assets: readonly { path: string; content: string }[]
      }[]
    }
    for (const skill of container.skills) {
      // Every shipped body is present verbatim inside the (decoded) document.
      expect(skill.body).toBe(manifestOf(skill.name).body)
    }
    for (const [name, canary, assetPath] of [
      // Distinctive carried resources prove the collected trees really ride
      // inside the bundle — ppt-designer's local editor README (text) and its
      // 4.9 MiB binary font table (byte size), plus skill-creator's Apache-2.0
      // license — not just the manifests.
      ['ppt-designer', 'NeoDeck Local', 'assets/editor/README.md'],
      ['skill-creator', 'Apache License', 'assets/LICENSE.txt'],
    ] as const) {
      const skill = container.skills.find((candidate) => candidate.name === name)
      const asset = skill?.assets.find((entry) => entry.path === assetPath)
      expect(asset, `${name} must carry ${assetPath}`).toBeDefined()
      expect(Buffer.from(asset?.content ?? '', 'base64').toString('utf8')).toContain(canary)
    }
    const fonts = container.skills.find((candidate) => candidate.name === 'ppt-designer')
      ?.assets.find((entry) => entry.path === 'assets/editor/neo-ppt/fonts/fnt/MiSans.fntdata')
    expect(Buffer.from(fonts?.content ?? '', 'base64').byteLength).toBeGreaterThan(4_000_000)
  })

  it('keeps the plaintext out of every shipped plugin file', () => {
    const shipped = [
      ...listFiles(join(PACKAGE_ROOT_PATH, 'src')).map((file) => `src/${file}`),
      ...listFilesIfPresent(join(PACKAGE_ROOT_PATH, 'lib')).map((file) => `lib/${file}`),
    ]
    for (const file of shipped) {
      const bytes = readFileSync(join(PACKAGE_ROOT_PATH, file))
      for (const canary of CANARIES) expect(bytes.includes(canary)).toBe(false)
    }
  })
})

/** `listFiles` for a directory that may not exist yet (`lib/` before a build). */
function listFilesIfPresent(root: string): string[] {
  return existsSync(root) ? listFiles(root) : []
}

describe('container frame rules', () => {
  it('accepts a container the packer would write', () => {
    const entries = decodeContainer(encode({ version: CONTAINER_VERSION, skills: [packedSkill()] }))
    expect(entries.map((entry) => entry.name)).toEqual(['fixture-hello'])
  })

  it('rejects every malformed frame', () => {
    const skill = packedSkill()
    const cases: readonly [string, unknown][] = [
      ['a non-object document', [1, 2, 3]],
      ['a missing version', { skills: [skill] }],
      ['an unknown top-level field', { version: CONTAINER_VERSION, skills: [skill], extra: true }],
      ['a future version', { version: CONTAINER_VERSION + 1, skills: [skill] }],
      ['a non-array skills field', { version: CONTAINER_VERSION, skills: skill }],
      ['an empty container', { version: CONTAINER_VERSION, skills: [] }],
      ['a duplicated skill name', { version: CONTAINER_VERSION, skills: [skill, skill] }],
      ['a non-kebab skill name', { version: CONTAINER_VERSION, skills: [{ ...skill, name: 'Fixture Hello' }] }],
      ['a description the catalog would truncate', { version: CONTAINER_VERSION, skills: [{ ...skill, description: 'x'.repeat(501) }] }],
      ['an element with an unknown field', { version: CONTAINER_VERSION, skills: [{ ...skill, extra: true }] }],
    ]
    for (const [what, document] of cases) {
      expect(() => parseContainer(document), what).toThrow()
      // The packer rejects the same document, so neither side can drift into
      // accepting what the other refuses.
      expect(() => toolsBundle.validateContainer(document), what).toThrow()
    }
  })

  it('rejects every malformed element the packer rejects', () => {
    const skill = packedSkill()
    const encoded = (path: string): string => Buffer.from(path, 'utf8').toString('base64')
    const cases: readonly [string, unknown][] = [
      ['a missing field', { name: skill.name, description: skill.description, body: skill.body }],
      ['a non-kebab name', { ...skill, name: 'Not-Kebab' }],
      ['an empty description', { ...skill, description: '' }],
      ['a description over the catalog bound', { ...skill, description: 'x'.repeat(501) }],
      ['a multi-line description', { ...skill, description: 'two\nlines' }],
      ['a padded description', { ...skill, description: ' padded ' }],
      ['an empty body', { ...skill, body: '' }],
      ['a non-string body', { ...skill, body: 42 }],
      ['a script outside scripts/', { ...skill, scripts: [{ path: 'assets/run.mjs', content: encoded('x') }] }],
      ['a path with a parent segment', { ...skill, scripts: [{ path: 'scripts/../run.mjs', content: encoded('x') }] }],
      ['a non-canonical base64 content', { ...skill, assets: [{ path: 'assets/notes.md', content: '!!!!' }] }],
      ['an empty content', { ...skill, assets: [{ path: 'assets/notes.md', content: '' }] }],
      ['an entry with an unknown field', { ...skill, assets: [{ path: 'assets/notes.md', content: encoded('x'), extra: 1 }] }],
      ['an entry missing content', { ...skill, assets: [{ path: 'assets/notes.md' }] }],
      ['a duplicated entry path', {
        ...skill,
        assets: [
          { path: 'assets/notes.md', content: encoded('x') },
          { path: 'assets/notes.md', content: encoded('y') },
        ],
      }],
    ]
    for (const [what, element] of cases) {
      expect(() => validateSkillBundle(element), what).toThrow()
      expect(
        () => toolsBundle.validateContainer({ version: CONTAINER_VERSION, skills: [element] }),
        what,
      ).toThrow()
    }
  })
})

describe('package release surface', () => {
  it('ships the container asset and no plaintext source', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT_PATH, 'package.json'), 'utf8')) as { files: readonly string[] }
    const matchers = manifest.files.map((pattern) => toolsReleaseSurface.filesEntryMatcher(pattern))
    expect(matchers.some((matches) => matches('assets/skills.bundle'))).toBe(true)

    for (const root of ['fixtures', 'skills', 'tests', 'scripts', 'src']) {
      for (const file of listFiles(join(PACKAGE_ROOT_PATH, root))) {
        const path = `${root}/${file}`
        expect(matchers.some((matches) => matches(path)), `${path} must not be published`).toBe(false)
      }
    }
  })
})
