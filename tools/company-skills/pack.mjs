#!/usr/bin/env node
/**
 * Pack one skill source directory into the obfuscated bundle artifact a
 * `company-skills` plugin ships (P6 batch 1).
 *
 *   node tools/company-skills/pack.mjs --skill <dir> [--out <file>]
 *
 * The plaintext is read from the skill directory and exists only in memory
 * for the duration of the run: nothing is written to a temporary file, no
 * cache is touched, and the only artifact is the encoded blob (or the module
 * wrapping it). Deterministic — the same source tree always produces the
 * same bytes, so a re-pack of an unchanged skill is diff-free.
 *
 * The output form follows the extension: `.js`, `.mjs`, or `.ts` writes a
 * generated ESM module; anything else writes the raw base64 blob. The
 * default output is `tools/company-skills/out/<name>.bundle.js` (gitignored
 * scratch).
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
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBFUSCATION_KEY_ID, encodeBundleBlob, renderBundleModule } from './lib/codec.mjs'
import { bundlePlaintextJson, readSkillDirectory } from './lib/bundle.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

/** Extensions that receive the generated-module wrapper instead of the raw blob. */
const MODULE_EXTENSIONS = new Set(['.js', '.mjs', '.ts', '.mts'])

const USAGE = `usage: node tools/company-skills/pack.mjs --skill <dir> [--out <file>]

  --skill <dir>   skill source directory (SKILL.md plus optional scripts/ and assets/)
  --out <file>    artifact path; .js/.mjs/.ts write a module, anything else the raw blob
                  (default: tools/company-skills/out/<name>.bundle.js)
`

/**
 * Parse the command line. Unknown flags and missing values abort rather than
 * falling back to a default — a silently wrong output path is how plaintext
 * ends up somewhere nobody looks.
 * @param {string[]} argv - arguments after the node and script names.
 * @returns {{ skill: string, out: string | undefined }} the parsed options.
 */
export function parseArgs(argv) {
  const options = { skill: undefined, out: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    if (flag !== '--skill' && flag !== '--out') throw new Error(`unknown argument "${flag}"\n\n${USAGE}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value\n\n${USAGE}`)
    options[flag.slice(2)] = value
    index += 1
  }
  if (options.skill === undefined) throw new Error(`--skill is required\n\n${USAGE}`)
  return options
}

/** The gitignored scratch path a skill packs to when `--out` is omitted. */
export function defaultDestination(name) {
  return join(TOOL_DIR, 'out', `${name}.bundle.js`)
}

/**
 * Encode one validated bundle for one destination, choosing the raw or the
 * module form from the destination extension.
 * @param {object} bundle - a canonical bundle.
 * @param {string} destination - the artifact path being written.
 * @returns {{ bundle: object, json: string, blob: string, artifact: string, sha256: string }} the pack result.
 */
export function packBundle(bundle, destination) {
  const json = bundlePlaintextJson(bundle)
  const blob = encodeBundleBlob(json)
  const moduleForm = MODULE_EXTENSIONS.has(extname(destination).toLowerCase())
  return {
    bundle,
    json,
    blob,
    artifact: moduleForm ? renderBundleModule(blob) : `${blob}\n`,
    sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
  }
}

/**
 * Read a skill directory and encode it for one destination, without touching
 * the filesystem — the piece both the CLI and the tests assert on.
 * @param {string} skillDir - skill source directory.
 * @param {string} destination - the artifact path the caller will write.
 * @returns {{ bundle: object, json: string, blob: string, artifact: string, sha256: string }} the pack result.
 */
export function packSkill(skillDir, destination) {
  return packBundle(readSkillDirectory(skillDir), destination)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const bundle = readSkillDirectory(resolve(options.skill))
  const destination = options.out === undefined ? defaultDestination(bundle.name) : resolve(options.out)
  const result = packBundle(bundle, destination)

  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, result.artifact, 'utf8')
  process.stdout.write(
    `packed ${bundle.name} → ${destination}\n`
    + `  key ${OBFUSCATION_KEY_ID}  scripts ${String(bundle.scripts.length)}  assets ${String(bundle.assets.length)}\n`
    + `  plaintextBytes ${String(Buffer.byteLength(result.json, 'utf8'))}  plaintextSha256 ${result.sha256}\n`,
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
