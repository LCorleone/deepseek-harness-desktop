/** Company manifest schema validation and semantic checks. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'
import { validRange } from 'semver'
import type { CompanyManifest, PackageEntry } from '../contracts/generated/company-manifest.js'

/** Result of validating a parsed value against the company manifest contract. */
export type CompanyManifestShape =
  | { readonly ok: true; readonly manifest: CompanyManifest }
  | { readonly ok: false; readonly reason: string }

function readCompanyManifestSchema(): AnySchema {
  const url = new URL('../../docs/schemas/company-manifest.schema.json', import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as AnySchema
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true })
const require = createRequire(import.meta.url)
const addFormats = require('ajv-formats') as FormatsPlugin
addFormats(ajv)

export const companyManifestValidator: ValidateFunction<CompanyManifest> = ajv.compile(readCompanyManifestSchema())

/** Aligned with the sha512 integrity guard in install/service.ts. */
function sha512Integrity(value: string): boolean {
  const digest = Buffer.from(value.slice('sha512-'.length), 'base64')
  return digest.byteLength === 64 && digest.toString('base64') === value.slice('sha512-'.length)
}

/** Aligned with the bundle patch path guard in install/service.ts. */
function safeBundlePatchPath(value: string): boolean {
  if (value.includes('\0') || value.includes('\\')) return false
  const path = value.startsWith('./') ? value.slice(2) : value
  return path.length > 0
    && !path.startsWith('/')
    && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes(':'))
}

const schemaIssueText = (validate: ValidateFunction<CompanyManifest>): string =>
  (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`).join('; ')

/**
 * Validate a parsed value against `docs/schemas/company-manifest.schema.json`
 * plus the semantic contract the schema cannot express: decodable 64-byte
 * SHA-512 integrity, safe relative bundle patch paths, valid node-semver
 * runtime ranges, and unique (packageName, version) entries.
 */
export function validateCompanyManifestShape(value: unknown): CompanyManifestShape {
  if (!companyManifestValidator(value)) {
    return { ok: false, reason: `company manifest schema violations: ${schemaIssueText(companyManifestValidator)}` }
  }
  const manifest = value
  const seen = new Set<string>()
  for (const [index, entry] of manifest.packages.entries()) {
    const at = `packages[${index}]`
    if (!sha512Integrity(entry.integrity)) {
      return { ok: false, reason: `${at}.integrity must be the base64 SHA-512 digest of the package tarball` }
    }
    if (!safeBundlePatchPath(entry.bundlePatch)) {
      return { ok: false, reason: `${at}.bundlePatch must be a safe relative path inside the package` }
    }
    for (const field of ['dshRuntimeVersion', 'cordisRuntimeVersion', 'nodeRuntimeVersion'] as const) {
      const range = entry.runtime[field]
      if (range !== undefined && validRange(range) === null) {
        return { ok: false, reason: `${at}.runtime.${field} is not a valid node-semver range` }
      }
    }
    const identity = `${entry.packageName}\0${entry.version}`
    if (seen.has(identity)) {
      return { ok: false, reason: `${at} duplicates the signed entry for ${entry.packageName}@${entry.version}` }
    }
    seen.add(identity)
  }
  return { ok: true, manifest }
}

/** Look up one exact (packageName, version) entry; revoked entries stay findable and readable. */
export function findCompanyManifestPackage(
  manifest: CompanyManifest,
  packageName: string,
  version: string,
): PackageEntry | undefined {
  return manifest.packages.find(entry => entry.packageName === packageName && entry.version === version)
}
