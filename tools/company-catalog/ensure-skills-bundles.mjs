#!/usr/bin/env node
/**
 * CI pre-pack step (issue #011): make sure every dsh-company-skills staging
 * tree under plugin-sources/ carries assets/skills.bundle before
 * `pack-tarball --from-allowlist` runs.
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
 * Usage (repository root, as the company-catalog workflows run it):
 *
 *   node tools/company-catalog/ensure-skills-bundles.mjs
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSkillsBundles } from './lib/skills-bundle.mjs'

// tools/company-catalog/ → tools/ → repository root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

try {
  ensureSkillsBundles({ repoRoot })
} catch (error) {
  process.stderr.write(`ensure-skills-bundles: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
