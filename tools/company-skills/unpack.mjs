#!/usr/bin/env node
/**
 * Decode and verify a company-skill artifact — the author side self-check.
 *
 * NOTE: decodes the v1 wire format only (base64(XOR(json))). Shipped assets
 * since the v2 brotli codec are read by dsh-company-skills/src/codec.ts;
 * this tool remains for author-side checks against v1-era blobs.
 *
 *   node tools/company-skills/unpack.mjs --in <blob> [--out <dir>] [--expect-sha256 <hex>]
 *
 * Both document shapes are accepted: the batch-1 single-skill bundle and the
 * container (`{version: 1, skills: […]}`) a plugin ships. The default output
 * is a metadata summary and never prints a skill body: for a container it
 * lists every skill's name, script/asset counts, and description. `--out` is
 * the explicit switch that materializes plaintext — one directory per skill
 * for a container.
 *
 * ⚠ THIS SCRIPT MUST NEVER SHIP. It is the only tool in this directory that
 * turns a blob back into plaintext, so it belongs on an author machine and in
 * CI verification runs only. Two guards keep it out of artifacts:
 *
 *   1. `lib/release-surface.mjs` audits every `package.json` `files`/`bin`/
 *      `main` entry in the repository and fails the test suite if any of them
 *      would ship an `unpack.mjs` (see tests/unpack-release-guard.test.mjs).
 *   2. This script refuses to start when its own directory carries a
 *      `package.json` — the layout mistake that would make rule 1 possible.
 *
 * `--expect-sha256` covers whichever document was decoded, so CI can assert
 * "this blob unpacks to exactly the reviewed plaintext".
 *
 * @module tools/company-skills/unpack
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBFUSCATION_KEY_ID, decodeBundleBlob, extractBundleBlob } from './lib/codec.mjs'
import {
  bundlePlaintextJson,
  bundleSourceFiles,
  containerPlaintextJson,
  containerSourceFiles,
  validateBundle,
  validateContainer,
} from './lib/bundle.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

const USAGE = `usage: node tools/company-skills/unpack.mjs --in <blob> [--out <dir>] [--expect-sha256 <hex>]

  --in <file>            blob artifact: a generated module or a raw base64 file, single-skill
                         or container
  --out <dir>            materialize plaintext there (default: summary only). A container
                         writes one directory per skill
  --expect-sha256 <hex>  abort unless the plaintext digest matches (64 lowercase hex)
`

/**
 * Parse the command line; `--help` and unknown flags behave as in pack.mjs.
 * @param {string[]} argv - arguments after the node and script names.
 * @returns {{ in: string, out: string | undefined, expectSha256: string | undefined }} the parsed options.
 */
export function parseArgs(argv) {
  const options = { in: undefined, out: undefined, expectSha256: undefined }
  const flags = { '--in': 'in', '--out': 'out', '--expect-sha256': 'expectSha256' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    const name = flags[flag]
    if (name === undefined) throw new Error(`unknown argument "${flag}"\n\n${USAGE}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value\n\n${USAGE}`)
    options[name] = value
    index += 1
  }
  if (options.in === undefined) throw new Error(`--in is required\n\n${USAGE}`)
  return options
}

/** Refuse to run from a directory that could be packaged — see the module header. */
function assertNotInsideAPackage() {
  if (existsSync(resolve(TOOL_DIR, 'package.json'))) {
    throw new Error(
      'unpack.mjs sits next to a package.json: this is the verifier, it must never be publishable. '
      + 'Move the packaging manifest out of tools/company-skills/ first.',
    )
  }
}

/**
 * Whether a decoded document is a container (top-level `version` + `skills`).
 * The two shapes cannot collide: a single-skill bundle's top level is exactly
 * `name`/`description`/`body`/`scripts`/`assets`.
 * @param {unknown} document - the JSON-decoded artifact document.
 * @returns {boolean} true when the document is container-shaped.
 */
export function isContainerDocument(document) {
  return typeof document === 'object' && document !== null && !Array.isArray(document)
    && Object.hasOwn(document, 'version') && Object.hasOwn(document, 'skills')
}

/**
 * Decode one blob artifact back into the validated canonical document it
 * carries, whichever shape that is.
 * @param {string} artifactText - the module or raw blob file contents.
 * @param {string} [subject] - subject for error messages.
 * @returns {{ kind: 'container' | 'skill', document: object, json: string, sha256: string }} the decoded document and its digest.
 */
export function decodeArtifact(artifactText, subject = 'bundle artifact') {
  const blob = extractBundleBlob(artifactText)
  let document
  try {
    document = JSON.parse(decodeBundleBlob(blob, subject))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${subject} does not decode to JSON: ${error.message}`)
    throw error
  }
  const container = isContainerDocument(document)
  const canonical = container ? validateContainer(document) : validateBundle(document)
  const json = container ? containerPlaintextJson(canonical) : bundlePlaintextJson(canonical)
  return {
    kind: container ? 'container' : 'skill',
    document: canonical,
    json,
    sha256: createHash('sha256').update(json, 'utf8').digest('hex'),
  }
}

/** Write one materialized file under `target`, refusing paths that escape it. */
function writeSourceFile(target, file) {
  const destination = resolve(target, file.path)
  if (!destination.startsWith(`${target}/`)) throw new Error(`refusing to write outside ${target}: ${file.path}`)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, file.bytes)
}

/** Print the single-skill metadata summary (never a body line). */
function skillSummary(bundle, sha256, json) {
  const lines = [
    `skill ${bundle.name}`,
    `description ${bundle.description}`,
    `key ${OBFUSCATION_KEY_ID}`,
    `body ${String(Buffer.byteLength(bundle.body, 'utf8'))} bytes`,
    `plaintextBytes ${String(Buffer.byteLength(json, 'utf8'))}`,
    `plaintextSha256 ${sha256}`,
  ]
  for (const entry of bundleSourceFiles(bundle)) {
    lines.push(`file ${entry.path} ${String(entry.bytes.byteLength)} bytes`)
  }
  return lines
}

/** Print the container metadata summary: one line per skill, never a body. */
function containerSummary(container, sha256, json) {
  const lines = [
    `container ${String(container.skills.length)} skills`,
    `key ${OBFUSCATION_KEY_ID}`,
    `plaintextBytes ${String(Buffer.byteLength(json, 'utf8'))}`,
    `plaintextSha256 ${sha256}`,
  ]
  for (const skill of container.skills) {
    lines.push(
      `skill ${skill.name}  scripts ${String(skill.scripts.length)}  assets ${String(skill.assets.length)}`
      + `  description ${skill.description}`,
    )
  }
  return lines
}

function main() {
  assertNotInsideAPackage()
  const options = parseArgs(process.argv.slice(2))
  const source = resolve(options.in)
  const decoded = decodeArtifact(readFileSync(source, 'utf8'), source)

  if (options.expectSha256 !== undefined && options.expectSha256 !== decoded.sha256) {
    throw new Error(
      `plaintext digest mismatch: expected ${options.expectSha256}, decoded ${decoded.sha256}`,
    )
  }

  const container = decoded.kind === 'container'
  if (options.out !== undefined) {
    const target = resolve(options.out)
    mkdirSync(target, { recursive: true })
    const files = container ? containerSourceFiles(decoded.document) : bundleSourceFiles(decoded.document)
    for (const file of files) writeSourceFile(target, file)
    process.stdout.write(
      container
        ? `unpacked container ${String(decoded.document.skills.length)} skills → ${target}\n`
        : `unpacked ${decoded.document.name} → ${target}\n`,
    )
  }

  const lines = container
    ? containerSummary(decoded.document, decoded.sha256, decoded.json)
    : skillSummary(decoded.document, decoded.sha256, decoded.json)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`unpack: ${error.message}\n`)
    process.exit(1)
  }
}
