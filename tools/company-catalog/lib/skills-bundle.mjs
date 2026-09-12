/**
 * The dsh-company-skills bundle asset as a pack-time dependency (issue #011):
 * `assets/skills.bundle` is a deterministic rebuild output of the
 * `dsh-company-skills/skills/` tree (`node dsh-company-skills/scripts/
 * build-bundle-asset.mjs`), not source material — since #011 it is untracked
 * and gitignored, so the source-tree copy and any 0.1.2+ staging-tree copy
 * never reach a fresh checkout. Transitional exception (#011 review): the
 * two legacy v1-era staging pins (`dsh-company-skills-{0.1.0,0.1.1}`, the
 * bytes md5-pinned to the PUBLISHED 0.1.0/0.1.1 tgz) stay committed until
 * their catalog entries are revoked→retired — see the negations in
 * `.gitignore`.
 *
 * Two consumers bridge that gap, both fail-closed:
 *
 *  - packing (`packPluginSource`): a skills staging tree or source directory
 *    without the asset is an invalid package (the tgz would ship a plugin
 *    that cannot load its own skills), so `assertSkillsBundlePresent` refuses
 *    the pack with the one-command rebuild guidance;
 *  - CI (`tools/company-catalog/ensure-skills-bundles.mjs`, run before the
 *    pack step in the company-catalog workflows): rebuild the asset from
 *    `skills/` and copy the fresh bytes into every skills staging tree that
 *    lacks one (only genuinely-missing ones — the committed legacy pins make
 *    it a no-op for 0.1.0/0.1.1), leaving the `.bundle-rebuilt` marker so
 *    measure.mjs re-measures those entries from this run's packed bytes.
 *
 * Staging trees are matched by their `package.json` `name` field — never by a
 * stem-spelling guess: the `plugin-sources/<stem>/` convention is
 * filename-derived (`<name>-<version>`), and only the manifest name is the
 * package identity the check can trust.
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// lib/ → company-catalog/ → tools/ → repository root (same derivation as
// lib/tarball.mjs; kept local so this module never imports its consumer).
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** The package identity whose tarballs must carry the bundle asset. */
export const SKILLS_PACKAGE_NAME = 'dsh-company-skills'
/** Where the asset lives inside a skills package tree (POSIX, repo-convention spelling). */
export const SKILLS_BUNDLE_RELATIVE_PATH = 'assets/skills.bundle'
/**
 * The marker file `ensureSkillsBundles` drops at the root of every staging
 * tree it provisioned (issue #011 review): a staging bundle freshly copied
 * this run means this run's packed bytes are the shipped truth, so measure
 * must re-measure those entries' treeDigest from the repacked artifact
 * instead of trusting the submitter's own tgz measurement (the marker is
 * gitignored and never packed — stageSourceDirectory drops it).
 */
export const SKILLS_BUNDLE_REBUILT_MARKER_FILENAME = '.bundle-rebuilt'
/** The deterministic rebuild script (repo-relative) — writes the source-tree asset. */
export const BUILD_SCRIPT_RELATIVE_PATH = 'dsh-company-skills/scripts/build-bundle-asset.mjs'
/** Default in-repo root of the plugin staging trees (mirrors lib/tarball.mjs). */
export const DEFAULT_PLUGIN_SOURCES_DIR_RELATIVE = 'tools/company-catalog/plugin-sources'

/** Read a package directory's `name` field; undefined when it carries no readable manifest. */
function packageNameOf(directory) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    return typeof manifest?.name === 'string' ? manifest.name : undefined
  } catch {
    return undefined
  }
}

/**
 * Refuse to pack a skills package tree whose bundle asset is missing (fail
 * closed: a skills tgz without the asset is invalid, never silently packed).
 * Called on the pre-staging source directory so the guidance names the tree
 * a human can fix, not the pack's tmp staging copy. Trees that are not the
 * skills package — or whose manifest cannot be read — pass through; the
 * regular pack path fails those with its own precise errors.
 * @param sourceDir - the plugin source directory about to be packed.
 * @param at - label for the error message (e.g. the allowlist entry key).
 */
export function assertSkillsBundlePresent(sourceDir, at = SKILLS_PACKAGE_NAME) {
  if (packageNameOf(sourceDir) !== SKILLS_PACKAGE_NAME) return
  if (existsSync(join(sourceDir, ...SKILLS_BUNDLE_RELATIVE_PATH.split('/')))) return
  throw new Error(
    `${at}: ${sourceDir} carries no ${SKILLS_BUNDLE_RELATIVE_PATH} — a skills package without the bundle asset is invalid, so nothing was packed (fail closed)\n` +
    `deterministic rebuild required — run \`node ${BUILD_SCRIPT_RELATIVE_PATH}\` and copy the asset to ` +
    `${join(sourceDir, SKILLS_BUNDLE_RELATIVE_PATH)} (CI does this automatically; see the company-catalog-publish/company-catalog-digest workflows). ` +
    'Packing the repository\'s own dsh-company-skills tree needs no copy — the script writes dsh-company-skills/assets/skills.bundle in place',
  )
}

/**
 * Classify the staging trees under a plugin-sources root by whether they are
 * the skills package and whether their bundle asset is present. The stem
 * spelling is reported (for logs) but never trusted for matching.
 * @param pluginSourcesRoot - the `plugin-sources/` directory to scan.
 * @returns `{ missing: [{stem, dir}], present: [stem] }`.
 */
export function skillsBundleStagingTrees(pluginSourcesRoot) {
  const missing = []
  const present = []
  if (!existsSync(pluginSourcesRoot)) return { missing, present }
  for (const dirent of readdirSync(pluginSourcesRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    if (packageNameOf(join(pluginSourcesRoot, dirent.name)) !== SKILLS_PACKAGE_NAME) continue
    const hasBundle = existsSync(join(pluginSourcesRoot, dirent.name, ...SKILLS_BUNDLE_RELATIVE_PATH.split('/')))
    if (hasBundle) present.push(dirent.name)
    else missing.push({ stem: dirent.name, dir: join(pluginSourcesRoot, dirent.name) })
  }
  return { missing, present }
}

/**
 * The staging tree a path-pinned allowlist entry packs from: the same
 * stem convention `pack-tarball --from-allowlist` uses (the `<stem>.tgz`
 * filename of `source.path` names the `plugin-sources/<stem>/` directory).
 * @param sourcePath - the allowlist entry's `source.path` (repo-relative,
 *   POSIX-spelled, ending in `<stem>.tgz`).
 * @param pluginSourcesRoot - the plugin-sources root the pack step uses.
 * @returns the staging directory path (existence is the caller's concern).
 */
export function stagingTreeForTarballSourcePath(sourcePath, pluginSourcesRoot) {
  const stem = sourcePath.split('/').pop().replace(/\.tgz$/u, '')
  return join(pluginSourcesRoot, stem)
}

/**
 * Whether a staging tree's skills bundle was freshly provisioned by
 * `ensureSkillsBundles` this run (the `.bundle-rebuilt` marker). A missing
 * tree (or a legacy tree whose committed bundle made the step a no-op)
 * carries no marker — false.
 * @param stagingDir - the plugin-sources staging tree to inspect.
 */
export function stagingBundleWasProvisioned(stagingDir) {
  return existsSync(join(stagingDir, SKILLS_BUNDLE_REBUILT_MARKER_FILENAME))
}

/**
 * Whether a measurable allowlist entry must be (re-)measured this run: an
 * entry without a treeDigest always measures (the usual fill), and an entry
 * that already pins one is skipped EXCEPT when its staging skills bundle was
 * freshly provisioned this run — then the digest must reflect the bytes this
 * run actually packs, never the submitter's measurement of their own tgz
 * (a mismatch fails measure loudly; equality confirms the pin). Non-tarball
 * entries (npm / registry) have no staging tree and keep the plain rule.
 * @param entry - a loaded allowlist entry.
 * @param pluginSourcesRoot - the plugin-sources root the pack step uses.
 */
export function needsTreeDigestMeasurement(entry, pluginSourcesRoot) {
  if (entry.treeDigest === undefined) return true
  if (entry.source?.kind !== 'tarball' || entry.source.path === undefined) return false
  return stagingBundleWasProvisioned(stagingTreeForTarballSourcePath(entry.source.path, pluginSourcesRoot))
}

/**
 * Rebuild the source-tree bundle asset and copy it into every skills staging
 * tree that lacks one (the CI pre-pack step, issue #011). The rebuild always
 * runs fresh when a copy is needed — a pre-existing source-tree asset is
 * never trusted as the copy source — and with nothing missing the whole step
 * is a logged no-op. Every copy is logged with its byte count and leaves the
 * `.bundle-rebuilt` marker at the staging-tree root so the measure step
 * re-measures those entries from this run's packed bytes.
 * @param options - `{ repoRoot, pluginSourcesRoot?, buildAsset?, log? }`;
 *   `buildAsset` (injectable for tests) must produce the asset at
 *   `<repoRoot>/dsh-company-skills/assets/skills.bundle`.
 * @returns `{ rebuilt: string[], copied: [{stem, bytes}] }`.
 */
export function ensureSkillsBundles({
  repoRoot,
  pluginSourcesRoot = join(repoRoot, ...DEFAULT_PLUGIN_SOURCES_DIR_RELATIVE.split('/')),
  buildAsset = defaultBuildAsset(repoRoot),
  log = console.log,
} = {}) {
  if (repoRoot === undefined) throw new Error('ensureSkillsBundles requires a repoRoot')
  const { missing, present } = skillsBundleStagingTrees(pluginSourcesRoot)
  if (missing.length === 0) {
    log(
      `skills-bundle: no ${SKILLS_PACKAGE_NAME} staging tree lacks ${SKILLS_BUNDLE_RELATIVE_PATH} `
      + `(checked ${present.length > 0 ? present.join(', ') : 'no skills staging tree'}) — nothing to rebuild`,
    )
    return { rebuilt: [], copied: [] }
  }
  log(
    `skills-bundle: ${String(missing.length)} staging tree(s) lack ${SKILLS_BUNDLE_RELATIVE_PATH}: `
    + `${missing.map((tree) => tree.stem).join(', ')} — rebuilding from ${BUILD_SCRIPT_RELATIVE_PATH}`,
  )
  buildAsset()
  const sourceAsset = join(repoRoot, SKILLS_PACKAGE_NAME, ...SKILLS_BUNDLE_RELATIVE_PATH.split('/'))
  if (!existsSync(sourceAsset) || !statSync(sourceAsset).isFile()) {
    throw new Error(`${BUILD_SCRIPT_RELATIVE_PATH} produced no ${sourceAsset} — refusing to pack a bundle-less skills tree (fail closed)`)
  }
  const copied = []
  for (const tree of missing) {
    const target = join(tree.dir, ...SKILLS_BUNDLE_RELATIVE_PATH.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(sourceAsset, target)
    writeFileSync(join(tree.dir, SKILLS_BUNDLE_REBUILT_MARKER_FILENAME), `${new Date().toISOString()}\n`, 'utf8')
    const bytes = statSync(target).size
    copied.push({ stem: tree.stem, bytes })
    log(`skills-bundle: copied ${String(bytes)} freshly built bytes → ${target} (marker ${SKILLS_BUNDLE_REBUILT_MARKER_FILENAME} left for the measure step)`)
  }
  return { rebuilt: missing.map((tree) => tree.stem), copied }
}

/** The real builder: run the deterministic rebuild script from the repo root. */
function defaultBuildAsset(repoRoot) {
  return () => {
    const probe = spawnSync(process.execPath, [join(repoRoot, ...BUILD_SCRIPT_RELATIVE_PATH.split('/'))], {
      cwd: repoRoot,
      stdio: 'inherit',
      timeout: 600_000,
    })
    if (probe.error !== undefined) {
      throw new Error(`the bundle rebuild could not run (${probe.error.message}) — is Node available?`)
    }
    if (probe.status !== 0) {
      throw new Error(`${BUILD_SCRIPT_RELATIVE_PATH} exited ${String(probe.status)} — the skills bundle cannot be rebuilt from skills/ (fail closed)`)
    }
  }
}
