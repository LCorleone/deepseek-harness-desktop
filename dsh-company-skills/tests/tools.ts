/**
 * Test-only access to the P6 batch-1 tooling in `tools/company-skills/`.
 *
 * The plugin itself must never import the author-machine tool (it is a
 * standalone published artifact), so these imports are deliberately here, in a
 * test helper, and go through dynamic import with a computed specifier: the
 * tool ships plain JavaScript with no type declarations, and a hand-written
 * `.d.ts` facade would be one more thing to drift out of date.
 *
 * `tests/container.spec.ts` uses these as the *oracle*: whatever the packer
 * wrote must decode to exactly what the packer canonicalized, and the
 * reconstructed source tree must equal the fixture directory byte for byte.
 */

/** One entry of a bundle's `scripts[]`/`assets[]`. */
export interface ToolsBundleEntry {
  readonly path: string
  readonly content: string
}

/** A canonical batch-1 single-skill bundle. */
export interface ToolsSkillBundle {
  readonly name: string
  readonly description: string
  readonly body: string
  readonly scripts: readonly ToolsBundleEntry[]
  readonly assets: readonly ToolsBundleEntry[]
}

/** The slice of `tools/company-skills/lib/bundle.mjs` these tests read. */
export interface ToolsBundleModule {
  readSkillDirectory(directory: string): ToolsSkillBundle
  bundlePlaintextJson(bundle: ToolsSkillBundle): string
  containerPlaintextJson(container: { version: number; skills: readonly ToolsSkillBundle[] }): string
  bundleSourceFiles(bundle: ToolsSkillBundle): { path: string; bytes: Buffer }[]
  validateContainer(container: unknown): unknown
  parseSkillManifest(text: string, site?: string): { name: string; description: string; body: string }
}

/** The slice of `tools/company-skills/lib/codec.mjs` these tests read. */
export interface ToolsCodecModule {
  readonly OBFUSCATION_KEY: string
  readonly OBFUSCATION_KEY_ID: string
  readonly BUNDLE_BLOB_EXPORT_NAME: string
  encodeBundleBlob(json: string): string
  decodeBundleBlob(blob: string, what?: string): string
  extractBundleBlob(text: string): string
}

/** The slice of `tools/company-skills/lib/release-surface.mjs` these tests read. */
export interface ToolsReleaseSurfaceModule {
  filesEntryMatcher(pattern: string): (path: string) => boolean
}

/** The slice of `scripts/build-bundle-asset.mjs` these tests read — the v2 wire encoder/decoder this package owns. */
export interface BuildAssetModule {
  readonly ASSET_PATH: string
  encodeShippedBundle(packerArtifact: string): string
  decodeShippedBundle(assetText: string): string
}

const toolsUrl = (relative: string): string => new URL(relative, import.meta.url).href

export const toolsBundle = await import(/* @vite-ignore */ toolsUrl('../../tools/company-skills/lib/bundle.mjs')) as ToolsBundleModule
export const toolsCodec = await import(/* @vite-ignore */ toolsUrl('../../tools/company-skills/lib/codec.mjs')) as ToolsCodecModule
export const toolsReleaseSurface = await import(/* @vite-ignore */ toolsUrl('../../tools/company-skills/lib/release-surface.mjs')) as ToolsReleaseSurfaceModule
export const buildAsset = await import(/* @vite-ignore */ toolsUrl('../scripts/build-bundle-asset.mjs')) as BuildAssetModule

/** Repository root, derived from this test file's own location. */
export const REPO_ROOT = new URL('../..', import.meta.url)

/** This package's root. */
export const PACKAGE_ROOT = new URL('..', import.meta.url)

/** The two fixture skills, sorted by name. */
export const FIXTURE_NAMES = ['fixture-hello', 'fixture-notes']

/** The collected real skills, sorted by name — batch 4's shipped set. */
export const SHIPPED_SKILL_NAMES = ['ppt-designer', 'skill-creator']

/** The packable plaintext root holding the collected real skills. */
export const SKILLS_DIR = new URL('../skills', import.meta.url)

/** The packable plaintext root holding the test fixtures. */
export const FIXTURES_DIR = new URL('../fixtures', import.meta.url)
