#!/usr/bin/env node
/**
 * Decode and verify a company-skill bundle blob — the author side self-check.
 *
 *   node tools/company-skills/unpack.mjs --in <blob> [--out <dir>] [--expect-sha256 <hex>]
 *
 * ⚠ THIS SCRIPT MUST NEVER SHIP. It is the only tool in this directory that
 * turns a blob back into plaintext, so it belongs on an author machine and in
 * CI verification runs only. Two guards keep it out of artifacts:
 *
 *   1. `lib/release-surface.mjs` audits every `package.json` `files`/`bin`
 *      whitelist in the repository and fails the test suite if any of them
 *      would ship an `unpack.mjs` (see tests/unpack-release-guard.test.mjs).
 *   2. This script refuses to start when its own directory carries a
 *      `package.json` — the layout mistake that would make rule 1 possible.
 *
 * Default output is a metadata summary (no body): name, description, counts,
 * the plaintext digest, and the carried file table. `--out <dir>` materializes
 * the skill directory for a diff against the original source.
 *
 * @module tools/company-skills/unpack
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBFUSCATION_KEY_ID, decodeBundleBlob, extractBundleBlob } from './lib/codec.mjs'
import { bundlePlaintextJson, bundleSourceFiles, validateBundle } from './lib/bundle.mjs'

const TOOL_DIR = dirname(fileURLToPath(import.meta.url))

const USAGE = `usage: node tools/company-skills/unpack.mjs --in <blob> [--out <dir>] [--expect-sha256 <hex>]

  --in <file>            blob artifact: a generated module or a raw base64 file
  --out <dir>            materialize the skill directory there (default: summary only)
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
 * Decode one blob artifact back into a validated canonical bundle.
 * @param {string} artifactText - the module or raw blob file contents.
 * @param {string} [subject] - subject for error messages.
 * @returns {{ bundle: object, json: string, sha256: string }} the decoded bundle and its digest.
 */
export function decodeBundleArtifact(artifactText, subject = 'bundle artifact') {
  const blob = extractBundleBlob(artifactText)
  let document
  try {
    document = JSON.parse(decodeBundleBlob(blob, subject))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${subject} does not decode to JSON: ${error.message}`)
    throw error
  }
  const bundle = validateBundle(document)
  const json = bundlePlaintextJson(bundle)
  return { bundle, json, sha256: createHash('sha256').update(json, 'utf8').digest('hex') }
}

function main() {
  assertNotInsideAPackage()
  const options = parseArgs(process.argv.slice(2))
  const source = resolve(options.in)
  const decoded = decodeBundleArtifact(readFileSync(source, 'utf8'), source)

  if (options.expectSha256 !== undefined && options.expectSha256 !== decoded.sha256) {
    throw new Error(
      `plaintext digest mismatch: expected ${options.expectSha256}, decoded ${decoded.sha256}`,
    )
  }

  if (options.out !== undefined) {
    const target = resolve(options.out)
    mkdirSync(target, { recursive: true })
    for (const file of bundleSourceFiles(decoded.bundle)) {
      const destination = resolve(target, file.path)
      if (!destination.startsWith(`${target}/`)) throw new Error(`refusing to write outside ${target}: ${file.path}`)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, file.bytes)
    }
    process.stdout.write(`unpacked ${decoded.bundle.name} → ${target}\n`)
  }

  const { bundle } = decoded
  const lines = [
    `skill ${bundle.name}`,
    `description ${bundle.description}`,
    `key ${OBFUSCATION_KEY_ID}`,
    `body ${String(Buffer.byteLength(bundle.body, 'utf8'))} bytes`,
    `plaintextBytes ${String(Buffer.byteLength(decoded.json, 'utf8'))}`,
    `plaintextSha256 ${decoded.sha256}`,
  ]
  for (const entry of bundleSourceFiles(bundle)) {
    lines.push(`file ${entry.path} ${String(entry.bytes.byteLength)} bytes`)
  }
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
