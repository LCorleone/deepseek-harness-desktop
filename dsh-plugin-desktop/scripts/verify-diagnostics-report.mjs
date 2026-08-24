#!/usr/bin/env node
/**
 * Verify the detached ed25519 signature of a DSH Desktop self-check report
 * (security plan P4-1).
 *
 * The intended verifier is the company security administrator, on any
 * machine, without installing anything: this script runs on a stock Node
 * (`node scripts/verify-diagnostics-report.mjs <file>`) and depends only on
 * Node builtins. It accepts either the extracted `self-check-report.json`
 * file or a whole diagnostics `diagnostics-*.zip` archive, from which it
 * reads the `self-check-report.json` entry.
 *
 * What the check proves — and what it does not:
 *
 * - A valid signature proves the report content is byte-intact under the
 *   ed25519 key embedded beside the signature (the report is self-contained).
 * - Binding that key to the company is the administrator's step: compare the
 *   printed SHA-256 fingerprint against the fingerprint published in the
 *   operations manual (P4-2), or pass `--fingerprint <64 hex>` to let this
 *   script enforce the comparison (`--key-id` pins the rotation slot too).
 * - An unsigned report (development build) fails verification and prints the
 *   recorded reason.
 *
 * Exit codes: 0 signature verified; 1 verification failed (including usage
 * of a malformed file); 2 bad command-line usage.
 */

import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

const REPORT_ENTRY = 'self-check-report.json'
const PUBLIC_KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u

function fail(message) {
  process.stderr.write(`verify-diagnostics-report: ${message}\n`)
  process.exit(1)
}

function usage(message) {
  if (message !== undefined) process.stderr.write(`verify-diagnostics-report: ${message}\n`)
  process.stderr.write(
    'Usage: node verify-diagnostics-report.mjs <self-check-report.json | diagnostics-*.zip>\n'
      + '                                  [--fingerprint <64 lowercase hex>] [--key-id <id>]\n',
  )
  process.exit(2)
}

/**
 * Canonical JSON serialization, mirroring `canonicalJsonText` of the
 * dsh-community-market signing surface (and documented in its module docs):
 * sorted keys, no insignificant whitespace, minimal JSON.stringify string
 * escapes with literal non-ASCII, and safe integers as the only numbers.
 * A report is canonical exactly when serializing its parsed value reproduces
 * the original bytes, which is what the signature covers.
 */
function canonicalJsonText(value) {
  const out = []
  const write = (node) => {
    if (node === null) {
      out.push('null')
      return
    }
    switch (typeof node) {
      case 'string':
        out.push(JSON.stringify(node))
        return
      case 'boolean':
        out.push(node ? 'true' : 'false')
        return
      case 'number':
        if (!Number.isSafeInteger(node)) {
          throw new TypeError('canonical JSON only allows safe integers')
        }
        out.push(node.toString())
        return
      case 'object': {
        if (Array.isArray(node)) {
          out.push('[')
          node.forEach((entry, index) => {
            if (index > 0) out.push(',')
            write(entry)
          })
          out.push(']')
          return
        }
        out.push('{')
        Object.keys(node).sort().forEach((key, index) => {
          const member = node[key]
          if (member === undefined) {
            throw new TypeError('canonical JSON cannot encode undefined object members')
          }
          if (index > 0) out.push(',')
          out.push(JSON.stringify(key), ':')
          write(member)
        })
        out.push('}')
        return
      }
      default:
        throw new TypeError(`canonical JSON cannot encode a value of type ${typeof node}`)
    }
  }
  write(value)
  return out.join('')
}

/**
 * Read one stored or deflated entry out of a zip archive. This is a minimal
 * central-directory reader for well-formed non-zip64 archives — exactly what
 * the diagnostics writer produces — kept here so the script stays
 * dependency-free for off-site verification.
 */
function readZipEntry(archiveBytes, wantedName) {
  const view = new DataView(archiveBytes.buffer, archiveBytes.byteOffset, archiveBytes.byteLength)
  const findEndOfCentralDirectory = () => {
    const minimum = 22
    const windowStart = Math.max(0, archiveBytes.byteLength - 65_536 - minimum)
    for (let offset = archiveBytes.byteLength - minimum; offset >= windowStart; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) return offset
    }
    return -1
  }
  const eocd = findEndOfCentralDirectory()
  if (eocd < 0) throw new Error('the file is not a zip archive (no end-of-central-directory record)')
  const entries = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('the zip central directory is malformed')
    }
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const name = archiveBytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (name === wantedName) {
      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error(`the zip local header of ${wantedName} is malformed`)
      }
      const localNameLength = view.getUint16(localHeaderOffset + 26, true)
      const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
      const data = archiveBytes.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`the zip entry ${wantedName} uses unsupported compression method ${String(method)}`)
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`the archive does not contain ${wantedName}`)
}

function decodeStrictBase64(text, expectedBytes) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) return undefined
  const bytes = Buffer.from(text, 'base64')
  return bytes.byteLength === expectedBytes ? bytes : undefined
}

function main() {
  const positional = []
  let expectedFingerprint
  let expectedKeyId
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === '--fingerprint') {
      expectedFingerprint = process.argv[index + 1]
      index += 1
    } else if (argument === '--key-id') {
      expectedKeyId = process.argv[index + 1]
      index += 1
    } else if (argument.startsWith('--')) {
      usage(`unknown option ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  if (positional.length !== 1) usage('exactly one report file or diagnostics zip is required')
  if (expectedFingerprint !== undefined && !FINGERPRINT_PATTERN.test(expectedFingerprint)) {
    usage('--fingerprint must be 64 lowercase hex characters')
  }

  let raw
  try {
    const file = readFileSync(positional[0])
    // A diagnostics archive starts with the zip magic "PK\x03\x04"; anything
    // else is treated as an extracted report JSON file.
    raw = file[0] === 0x50 && file[1] === 0x4b
      ? readZipEntry(file, REPORT_ENTRY)
      : file
  } catch (cause) {
    fail(`cannot read ${REPORT_ENTRY}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (cause) {
    fail(`the report is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('the report must be a JSON object')
  }
  if (parsed.app !== 'dsh-plugin-desktop') {
    fail('the report is not a dsh-plugin-desktop self-check report')
  }
  if (parsed.reportVersion !== '1.0.0') {
    fail(`unsupported report version ${JSON.stringify(parsed.reportVersion)}`)
  }

  const signature = parsed.signature ?? null
  if (signature === null) {
    const reason = parsed.unsigned !== null && typeof parsed.unsigned === 'object'
      && typeof parsed.unsigned.reason === 'string'
      ? parsed.unsigned.reason
      : 'no reason recorded'
    fail(`the report is unsigned and cannot be verified (${reason})`)
  }
  if (signature.algorithm !== 'ed25519' || typeof signature.keyId !== 'string'
    || typeof signature.publicKey !== 'string' || typeof signature.value !== 'string') {
    fail('the signature block is malformed')
  }
  if (expectedKeyId !== undefined && signature.keyId !== expectedKeyId) {
    fail(`report keyId ${signature.keyId} does not match the pinned --key-id ${expectedKeyId}`)
  }

  const rawKey = decodeStrictBase64(signature.publicKey, PUBLIC_KEY_BYTES)
  if (rawKey === undefined) {
    fail('the diagnostics signing key is not a raw 32-byte ed25519 public key')
  }
  const fingerprint = createHash('sha256').update(rawKey).digest('hex')
  if (expectedFingerprint !== undefined && fingerprint !== expectedFingerprint) {
    fail(`report signing-key fingerprint ${fingerprint} does not match the pinned --fingerprint ${expectedFingerprint}`)
  }

  const signatureBytes = decodeStrictBase64(signature.value, SIGNATURE_BYTES)
  if (signatureBytes === undefined) {
    fail('the detached ed25519 signature is not 64 bytes')
  }

  // The signed window is the report minus its signature member, serialized
  // canonically — mirroring the desktop sign-side window byte for byte.
  const window = { ...parsed }
  delete window.signature
  let canonical
  try {
    canonical = canonicalJsonText(window)
  } catch (cause) {
    fail(`the report is not canonicalizable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') },
    format: 'jwk',
  })
  // node:crypto requires a null algorithm for Ed25519; the key carries the designation.
  if (!verify(null, Buffer.from(canonical, 'utf8'), publicKey, signatureBytes)) {
    fail('ed25519 signature verification failed — the report content was modified or the signature is invalid')
  }

  const boot = parsed.bootVerification
  const bootSummary = boot !== null && typeof boot === 'object' && boot.available === true
    ? `boot ${typeof boot.recordedAt === 'string' ? boot.recordedAt : '?'}: manifest sequence `
      + `${boot.manifestSequence === null ? 'n/a' : String(boot.manifestSequence)}`
      + `, allowed ${String(Array.isArray(boot.allowed) ? boot.allowed.length : 0)}`
      + `, refused ${String(Array.isArray(boot.refused) ? boot.refused.length : 0)}`
    : 'boot verification: no locked-boot record in this report'
  process.stdout.write(
    `self-check report signature VERIFIED\n`
      + `  app version : ${String(parsed.appVersion)}\n`
      + `  generated at: ${String(parsed.generatedAt)}\n`
      + `  ${bootSummary}\n`
      + `  key id      : ${signature.keyId}\n`
      + `  fingerprint : ${fingerprint}\n`
      + (expectedFingerprint === undefined
        ? '  compare the fingerprint above against the operations manual before trusting this report\n'
        : '  fingerprint matches the pinned --fingerprint\n'),
  )
}

main()
