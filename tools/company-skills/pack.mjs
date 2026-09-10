#!/usr/bin/env node
/**
 * Pack skill sources into the obfuscated blob artifact a `company-skills`
 * plugin ships (P6 batch 1).
 *
 *   node tools/company-skills/pack.mjs (--skill <dir> | --skills <dir>) [--out <file>]
 *
 * `--skills` is the container form the plugin ships: one skills root directory
 * holding N skill directories (one SKILL.md each) packs into a single
 * `{version: 1, skills: […]}` blob. `--skill` remains as the single-skill
 * compatibility entry point; batch 2 consumes the container.
 *
 * The plaintext is read from the source directories and exists only in memory
 * for the duration of the run: nothing is written to a temporary file, no
 * cache is touched, and the only artifact is the encoded blob (or the module
 * wrapping it). Deterministic — the same source tree always produces the
 * same bytes, so a re-pack of unchanged skills is diff-free.
 *
 * The output form follows the extension: `.js`, `.mjs`, or `.ts` writes a
 * generated ESM module; anything else writes the raw base64 blob. The
 * default output is `tools/company-skills/out/<name>.bundle.js` (gitignored
 * scratch), where `<name>` is the skill name for `--skill` and the root
 * directory name for `--skills`.
 *
 * This runs on an author machine. It is deliberately not wired into any CI
 * chain, exactly like the model-gateway / SSO / usage-report generators: the
 * plaintext input lives outside the repository and the repository only ever
 * stores the blob.
 *
 * @module tools/company-skills/pack
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBFUSCATION_KEY_ID, encodeBundleBlob, renderBundleModule } from './lib/codec.mjs'
import {
  bundlePlaintextJson,
  containerPlaintextJson,
  danglingReferences,
  readSkillDirectory,
  readSkillsDirectory,
} from './lib/bundle.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

/** Extensions that receive the generated-module wrapper instead of the raw blob. */
const MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.mts'])

const USAGE = `usage: node tools/company-skills/pack.mjs (--skill <dir> | --skills <dir>) [--out <file>]

  --skill <dir>   one skill source directory (SKILL.md plus optional scripts/ and assets/)
  --skills <dir>  a skills root: N skill directories packed into one container artifact
  --out <file>    artifact path; .js/.mjs/.ts write a module, anything else the raw blob
                  (default: tools/company-skills/out/<name>.bundle.js, where <name> is the
                  skill name for --skill and the root directory name for --skills)
`

/**
 * Parse the command line. Unknown flags and missing values abort rather than
 * falling back to a default — a silently wrong output path is how plaintext
 * ends up somewhere nobody looks. Exactly one of `--skill`/`--skills` is
 * required so the artifact format is never guessed.
 * @param {string[]} argv - arguments after the node and script names.
 * @returns {{ skill: string | undefined, skills: string | undefined, out: string | undefined }} the parsed options.
 */
export function parseArgs(argv) {
  const options = { skill: undefined, skills: undefined, out: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    if (flag !== '--skill' && flag !== '--skills' && flag !== '--out') {
      throw new Error(`unknown argument "${flag}"\n\n${USAGE}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value\n\n${USAGE}`)
    options[flag.slice(2)] = value
    index += 1
  }
  if ((options.skill === undefined) === (options.skills === undefined)) {
    throw new Error(`exactly one of --skill or --skills is required\n\n${USAGE}`)
  }
  return options
}

/** The gitignored scratch path a source packs to when `--out` is omitted. */
export function defaultDestination(name) {
  return join(TOOL_DIR, 'out', `${name}.bundle.js`)
}

/**
 * Print the authoring lint for un-carried `scripts/…`/`assets/…` mentions.
 * A miss is a warning, not a rejection: collected third-party skills
 * legitimately mention example paths in prose. See `danglingReferences`.
 * @param {object[]} skills - the packed canonical skills.
 * @returns {number} how many misses were reported.
 */
export function reportDanglingReferences(skills) {
  let misses = 0
  for (const skill of skills) {
    for (const miss of danglingReferences(skill)) {
      misses += 1
      process.stderr.write(
        `pack: warning: ${skill.name}: ${miss.site} references "${miss.reference}", which the bundle does not carry\n`,
      )
    }
  }
  return misses
}

/**
 * Encode one canonical JSON document for one destination, choosing the raw or
 * the module form from the destination extension.
 * @param {string} json - the canonical document JSON.
 * @param {string} destination - the artifact path being written.
 * @returns {{ json: string, blob: string, artifact: string, sha256: string }} the encoded pieces.
 */
function encodeDocument(json, destination) {
  const blob = encodeBundleBlob(json)
  const moduleForm = MODULE_EXTENSIONS.has(extname(destination).toLowerCase())
  return {
    json,
    blob,
    artifact: moduleForm ? renderBundleModule(blob) : `${blob}\n`,
    sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
  }
}

/**
 * Encode one validated bundle for one destination.
 * @param {object} bundle - a canonical bundle.
 * @param {string} destination - the artifact path being written.
 * @returns {{ bundle: object, json: string, blob: string, artifact: string, sha256: string }} the pack result.
 */
export function packBundle(bundle, destination) {
  return { bundle, ...encodeDocument(bundlePlaintextJson(bundle), destination) }
}

/**
 * Encode one validated container for one destination.
 * @param {object} container - a canonical container.
 * @param {string} destination - the artifact path being written.
 * @returns {{ container: object, json: string, blob: string, artifact: string, sha256: string }} the pack result.
 */
export function packContainer(container, destination) {
  return { container, ...encodeDocument(containerPlaintextJson(container), destination) }
}

/**
 * Read one skill directory and encode it for one destination, without touching
 * the filesystem — the piece both the CLI and the tests assert on.
 * @param {string} skillDir - skill source directory.
 * @param {string} destination - the artifact path the caller will write.
 * @returns {{ bundle: object, json: string, blob: string, artifact: string, sha256: string }} the pack result.
 */
export function packSkill(skillDir, destination) {
  return packBundle(readSkillDirectory(skillDir), destination)
}

/**
 * Read one skills root directory and encode the container for one
 * destination, without touching the filesystem.
 * @param {string} skillsRoot - skills root directory.
 * @param {string} destination - the artifact path the caller will write.
 * @returns {{ container: object, json: string, blob: string, artifact: string, sha256: string }} the pack result.
 */
export function packSkillsDirectory(skillsRoot, destination) {
  return packContainer(readSkillsDirectory(skillsRoot), destination)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const containerMode = options.skills !== undefined
  const source = resolve(containerMode ? options.skills : options.skill)
  const document = containerMode ? readSkillsDirectory(source) : readSkillDirectory(source)
  const destination = options.out === undefined
    ? defaultDestination(containerMode ? basename(source) : document.name)
    : resolve(options.out)
  const result = containerMode ? packContainer(document, destination) : packBundle(document, destination)

  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, result.artifact, 'utf8')
  const linted = containerMode ? result.container.skills : [result.bundle]
  reportDanglingReferences(linted)
  const plaintext = `  plaintextBytes ${String(Buffer.byteLength(result.json, 'utf8'))}  plaintextSha256 ${result.sha256}\n`
  if (containerMode) {
    const skills = result.container.skills
    const count = (key) => skills.reduce((total, skill) => total + skill[key].length, 0)
    process.stdout.write(
      `packed container ${String(skills.length)} skills → ${destination}\n`
      + `  key ${OBFUSCATION_KEY_ID}  skills ${String(skills.length)}  scripts ${String(count('scripts'))}  assets ${String(count('assets'))}\n`
      + plaintext,
    )
    return
  }
  const bundle = result.bundle
  process.stdout.write(
    `packed ${bundle.name} → ${destination}\n`
    + `  key ${OBFUSCATION_KEY_ID}  scripts ${String(bundle.scripts.length)}  assets ${String(bundle.assets.length)}\n`
    + plaintext,
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`pack: ${error.message}\n`)
    process.exit(1)
  }
}
