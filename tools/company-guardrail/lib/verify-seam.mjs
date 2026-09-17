/**
 * The desktop-client verification seam (#046 publish pipeline).
 *
 * The fleet's security-prompt document verifier lives in TypeScript inside
 * the desktop workspace (`dsh-plugin-desktop/src/company-guardrail.ts`,
 * `verifyDesktopSecurityPromptDocument`). Plain Node cannot import that
 * source graph from `tools/` (strip-only type stripping rejects the desktop
 * sources' parameter properties — ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX,
 * verified empirically), so the pipeline re-verifies its signed bytes by
 * executing the desktop-side seam script
 * `dsh-plugin-desktop/scripts/verify-security-prompt-document.ts` with
 * `node --experimental-transform-types`, the one runtime that can load the
 * desktop source graph outside vitest. Every verification in this pipeline
 * goes through the client's ACTUAL verifier this way — never a fork — so a
 * byte-shape drift between the signer and the fleet verifier fails the
 * pipeline instead of the fleet.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Absolute path of the desktop-side verifier seam script. */
export const DESKTOP_VERIFY_SEAM_PATH = resolve(
  REPO_ROOT, 'dsh-plugin-desktop', 'scripts', 'verify-security-prompt-document.ts',
)

/**
 * Verify one document file with the desktop client's actual verifier.
 * @param file - absolute or cwd-relative path of the signed document bytes.
 * @param trustRootsPath - JSON file carrying the trust roots (bare array or
 * a desktop-policy object with `trustRoots`).
 * @param options.floor - anti-rollback floor (`lastAcceptedRevision`).
 * @returns the parsed one-line JSON verdict (shape:
 * `{ok:true, revision, keyId, fingerprint, expiresAt, verifiedAt}` or
 * `{ok:false, code, reason}`) plus the raw stderr.
 * @throws when the seam script is missing or cannot be executed at all.
 */
export function verifyWithDesktopClient(file, trustRootsPath, options = {}) {
  if (!existsSync(DESKTOP_VERIFY_SEAM_PATH)) {
    throw new Error(
      `the desktop verification seam ${DESKTOP_VERIFY_SEAM_PATH} does not exist — ` +
      'the publishing pipeline requires the desktop workspace checkout',
    )
  }
  const args = [
    '--experimental-transform-types',
    DESKTOP_VERIFY_SEAM_PATH,
    '--file', file,
    '--trust-roots', trustRootsPath,
  ]
  if (options.floor !== undefined) {
    if (!Number.isSafeInteger(options.floor) || options.floor < 0) {
      throw new TypeError('the anti-rollback floor must be a safe non-negative integer')
    }
    args.push('--floor', String(options.floor))
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
  if (result.error !== undefined) {
    throw new Error(`the desktop verification seam could not be executed (${result.error.message})`)
  }
  // The verdict is the LAST stdout line (an ExperimentalWarning may precede
  // it on stderr; stdout carries only the JSON).
  const lines = (result.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const verdictLine = lines[lines.length - 1]
  let verdict
  if (verdictLine !== undefined) {
    try {
      verdict = JSON.parse(verdictLine)
    } catch {
      verdict = undefined
    }
  }
  if (result.status === 0 && (verdict === undefined || verdict.ok !== true)) {
    // exit 0 without an ok verdict means the seam printed something else
    // (usage, or an internal failure) — fail closed rather than trust it.
    return {
      ok: false,
      code: 'seam-protocol',
      reason: `the desktop verification seam exited 0 without an ok verdict (stdout: ${(result.stdout ?? '').slice(0, 300)})`,
      stderr: (result.stderr ?? '').trim(),
      status: result.status,
    }
  }
  if (verdict === undefined) {
    const stderr = (result.stderr ?? '').trim()
    const hint = /dsh-community-market|company-guardrail|ERR_MODULE_NOT_FOUND/u.test(stderr)
      ? " — the seam imports the desktop sources and the built market workspace; run 'corepack yarn install' and 'corepack yarn workspace dsh-community-market build' first"
      : ''
    return {
      ok: false,
      code: 'seam-failed',
      reason: `the desktop verification seam could not verify the document (exit ${String(result.status)}): ${stderr.slice(0, 400)}${hint}`,
      stderr,
      status: result.status,
    }
  }
  return { ...verdict, status: result.status, stderr: (result.stderr ?? '').trim() }
}
