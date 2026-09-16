#!/usr/bin/env node
/**
 * Collect read-only skill sources into this package's packable layout
 * (P6 batch 4).
 *
 *   node scripts/collect-skills.mjs [--source <skills-root>] [<name> ...]
 *
 * Reads each named skill directory under the source root (default
 * `/opt/july/skills-hub/skills`) and writes a verbatim copy under
 * `skills/<name>/`: `SKILL.md`, `scripts/**`, and every other top-level entry
 * keep their own relative paths (`editor/` stays `editor/`, `reference/`
 * stays `reference/`, `LICENSE.txt` stays `LICENSE.txt`). The collected
 * layout therefore reconstructs the original skill root exactly, and the
 * packer keys every bundle entry by that same relative path. `__pycache__`
 * directories and `.env` credential files are pruned; nothing else is moved,
 * renamed, or rewritten. The `.env` prune is the collect half of #043 D1: the
 * API skills' sources carry a live `ROUTER_URL`/`ROUTER_API_KEY` file next to
 * their scripts, and those values must never ship inside the bundle — the
 * managed desktop injects them into the skill executor's spawn environment
 * at run time, and the skills' `load_dotenv()` falls back to the OS
 * environment when no `.env` exists, so stripping is behavior-neutral.
 *
 * The source tree is only ever READ — this collector never writes anything
 * under the source root (the batch-4 red line: the skills-hub copy is
 * read-only, every adaptation lands in this repository).
 *
 * Human adaptations live in the committed copy, not here: the ppt-designer
 * frontmatter description is trimmed to the packer's 500-character catalog
 * bound (the source carries more). Re-running this script overwrites the
 * collected trees, so re-apply that trim afterwards if the source changed.
 *
 * @module dsh-company-skills/scripts/collect-skills
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_SOURCE_ROOT = '/opt/july/skills-hub/skills'
const TARGET_ROOT = join(PACKAGE_ROOT, 'skills')

const USAGE = `usage: node scripts/collect-skills.mjs [--source <skills-root>] [<name> ...]

  --source <skills-root>  read-only source root (default: ${DEFAULT_SOURCE_ROOT})
  <name> ...              skill directories to collect (default: the six-skill shipped set below)
`

/** Directory names pruned during collection, mirroring the packer's list. */
const PRUNED_DIRECTORY_NAMES = ['__pycache__']

/**
 * File names pruned during collection (#043 D1): a skills-hub source carries
 * a `.env` with the live `ROUTER_URL`/`ROUTER_API_KEY` next to its scripts.
 * That file is the hub author's local credential layer, never bundle content —
 * the managed desktop injects both variables into the skill child's spawn
 * environment, so the collected copy must not carry it.
 */
const PRUNED_FILE_NAMES = ['.env']

/** The collected set this package ships (#043: batch A office four + batch B API five). */
const DEFAULT_SKILLS = [
  'ppt-designer',
  'skill-creator',
  'docx',
  'xlsx',
  'pdf',
  'pptx',
  'company-info',
  'ocr',
  'vlm-image',
  'scms-financial-api',
  'smart-pdf-parser',
]

/** Skill names the collector accepts: the registry's kebab-case grammar. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Parse the command line.
 * @param {string[]} argv - arguments after the node and script names.
 * @returns {{ sourceRoot: string, names: string[] }} the parsed options.
 */
export function parseArgs(argv) {
  const options = { sourceRoot: DEFAULT_SOURCE_ROOT, names: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    if (flag === '--source') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`--source requires a value\n\n${USAGE}`)
      options.sourceRoot = value
      index += 1
      continue
    }
    if (flag.startsWith('--')) throw new Error(`unknown argument "${flag}"\n\n${USAGE}`)
    options.names.push(flag)
  }
  if (options.names.length === 0) options.names = [...DEFAULT_SKILLS]
  return options
}

/**
 * Guard one CLI-supplied skill name before it is turned into a target path.
 * The name reaches `rmSync`, so only the registry's kebab-case grammar may
 * pass: `..`, a path separator, or an absolute path would delete something
 * outside `skills/` (`collect-skills.mjs ../src` must never touch `src/`).
 * @param {string} name - the requested skill directory name.
 * @returns {string} the validated name.
 */
export function validateSkillName(name) {
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `collect: invalid skill name ${JSON.stringify(name)} `
      + '(expected kebab-case matching ^[a-z0-9]+(?:-[a-z0-9]+)*$; path segments and ".." are refused)',
    )
  }
  return name
}

/**
 * Copy one collected skill from the read-only source into `skills/<name>`,
 * preserving the source root's relative layout verbatim and pruning
 * interpreter caches.
 * @param {string} sourceDir - the skill's directory under the source root.
 * @param {string} targetDir - the destination directory (removed first).
 * @returns {{ files: number }} what was copied.
 */
export function collectSkill(sourceDir, targetDir) {
  if (!existsSync(sourceDir)) throw new Error(`collect: no such skill directory: ${sourceDir}`)
  const files = []
  const walk = (relativeDir) => {
    for (const entry of readdirSync(join(sourceDir, relativeDir), { withFileTypes: true })) {
      if (PRUNED_DIRECTORY_NAMES.includes(entry.name)) continue
      const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(relative)
        continue
      }
      if (!entry.isFile()) throw new Error(`collect: not a regular file: ${join(sourceDir, relative)}`)
      if (PRUNED_FILE_NAMES.includes(entry.name)) continue
      files.push(relative)
      const destination = join(targetDir, relative)
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(join(sourceDir, relative), destination)
    }
  }
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  walk('')
  return { files: files.length }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const sourceRoot = resolve(options.sourceRoot)
  if (!existsSync(sourceRoot)) throw new Error(`collect: source root does not exist: ${sourceRoot}`)
  mkdirSync(TARGET_ROOT, { recursive: true })
  for (const requested of options.names) {
    const name = validateSkillName(requested)
    const { files } = collectSkill(join(sourceRoot, name), join(TARGET_ROOT, name))
    process.stdout.write(`collected ${name}: ${String(files)} files → skills/${name} (source layout preserved)\n`)
  }
  process.stdout.write('remember: re-apply the manual adaptations if SKILL.md was overwritten — ppt-designer description trim; #043 batch A: docx/xlsx/pdf/pptx description trims and flattened frontmatter, docx D3′ dynamic three-stage tool notes + non-empty scripts/office/helpers/__init__.py, xlsx D3′ dynamic note + Content_Types.xml template rename, pdf D3′ dynamic note; #043 batch B: company-info flattened frontmatter, .env-edit wording replaced with managed-injection wording in the five API skills, smart-pdf-parser vendored scripts/vendor/{call_ocr.py,vlm_ocr.py} + smart_parse.py default-path re-point (D5)\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`collect-skills: ${error.message}\n`)
    process.exit(1)
  }
}
