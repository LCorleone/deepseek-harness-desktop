#!/usr/bin/env node
/**
 * CI pre-pack step (issue #011 + #028): make sure every dsh-company-skills
 * staging tree under plugin-sources/ carries assets/skills.bundle before
 * `pack-tarball --from-allowlist` runs — with the accepted content pinned.
 *
 * The bundle is a deterministic rebuild output of dsh-company-skills/skills/
 * (`node dsh-company-skills/scripts/build-bundle-asset.mjs`) and is untracked
 * + gitignored (except the two committed legacy v1-era staging pins, see
 * .gitignore), so a fresh checkout carries no source-tree asset and no
 * 0.1.2+ staging-tree copy. This step rebuilds the asset once from skills/
 * and copies the fresh bytes into each staging tree whose package.json names
 * the skills package and whose asset is absent (matching is by manifest
 * name, never by the filename-derived stem spelling), leaving a
 * .bundle-rebuilt marker so the measure step re-measures those entries from
 * this run's packed bytes; with nothing missing it is a logged no-op (the
 * committed legacy pins make it one today). Local publishers never need
 * this script — a local pack of a bundle-less skills tree fails with the
 * one-command rebuild guidance instead (lib/skills-bundle.mjs).
 *
 * Content authority (#028): the loaded allowlist is passed in, and every
 * dsh-company-skills entry carrying a bundleDocumentDigest (recorded by
 * accept-handoff at handoff acceptance) is asserted — the fresh rebuild (or,
 * on a no-op run, the staging tree's own bundle) must decode to exactly the
 * accepted canonical document, else the step fails loudly telling review to
 * re-run. Legacy entries accepted before the field existed (0.1.0/0.1.1)
 * carry no pin and are never asserted.
 *
 * Usage (repository root, as the company-catalog workflows run it):
 *
 *   node tools/company-catalog/ensure-skills-bundles.mjs
 *
 * Tarball-channel entries validate against the deployment's pinned catalog
 * origin, so COMPANY_CATALOG_ORIGIN must be exported when the allowlist
 * carries them (the workflows export it before this step; the value is
 * optional for an npm-only allowlist).
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG_ORIGIN_ENV, loadAllowlist, validateCatalogOrigin } from './lib/allowlist.mjs'
import { ensureSkillsBundles } from './lib/skills-bundle.mjs'

// tools/company-catalog/ → tools/ → repository root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const allowlistPath = join(dirname(fileURLToPath(import.meta.url)), 'allowlist.json')

try {
  const catalogOriginRaw = process.env[CATALOG_ORIGIN_ENV]
  const entries = loadAllowlist(allowlistPath, {
    ...(catalogOriginRaw === undefined ? {} : { companyCatalogOrigin: validateCatalogOrigin(catalogOriginRaw) }),
  })
  ensureSkillsBundles({ repoRoot, entries })
} catch (error) {
  process.stderr.write(`ensure-skills-bundles: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
