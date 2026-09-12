/**
 * The embedded offline-fallback company manifest (#030): the checked-in
 * sample `assets/company-market/catalog-manifest.json` is what
 * `scripts/embed-company-manifest.mjs` embeds into `lib/` whenever the
 * repository-root pipeline output is absent — which is exactly the case on
 * a fresh CI checkout (out/ is gitignored), so every release build ships
 * this file as the market's bootstrap view until the first live fetch.
 *
 * Design makes an old sample SAFE but weak: the anti-rollback floors come
 * from install receipts and the persisted ratchet (never from the embedded
 * asset), and the first live fetch replaces it. Weak still has a bound — a
 * build must not ship a fallback that rotted. These tests fail loudly when
 *
 *  - the sample no longer verifies under the release policy's trust root
 *    (a beta manifest, a foreign key, or non-canonical bytes would all make
 *    the offline fallback dead weight the first time it is needed);
 *  - its sequence lags the repository's catalog ratchet by more than the
 *    documented slack (refresh it with the deployed stable manifest bytes
 *    before the next build);
 *  - its expiry has passed (an expired manifest never verifies, so the
 *    fallback would be dead weight the first time it is needed).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDesktopPolicy } from '../src/desktop-policy.ts'
import { verifyDesktopCompanyManifest } from '../src/desktop-market.ts'

/** How far the embedded fallback may lag the repository's catalog ratchet
 * (sequence numbers) before this suite fails. The ratchet
 * (`tools/company-catalog/state/last-sequence.json`) advances with every
 * stable AND beta publish; the fallback only needs to be plausible, not
 * current. Slack 8 ≈ a few publish cycles — when the gap exceeds it,
 * re-embed the deployed stable manifest (see the RELEASE runbook's manifest
 * refresh note) so a build never ships a badly aged offline fallback. */
const MAX_SEQUENCE_LAG = 8

const embeddedPath = fileURLToPath(new URL('../assets/company-market/catalog-manifest.json', import.meta.url))
const embeddedText = readFileSync(embeddedPath, 'utf8')
const embedded = JSON.parse(embeddedText) as { sequence: number; expiresAt: string; packages: unknown[] }

const releasePolicy = parseDesktopPolicy(
  JSON.parse(readFileSync(new URL('../src/policy/desktop-policy.release.json', import.meta.url), 'utf8')),
)

// The repository's catalog ratchet: the highest sequence this repository's
// publishing state has ever confirmed (the same file publish-local bumps).
const ratchetPath = fileURLToPath(new URL('../../tools/company-catalog/state/last-sequence.json', import.meta.url))
const ratchet = (JSON.parse(readFileSync(ratchetPath, 'utf8')) as { lastSequence: number }).lastSequence

describe('the embedded offline-fallback company manifest (#030)', () => {
  it('verifies under the release policy trust root as a stable manifest', () => {
    // Exactly the verification the fallback goes through when it is used
    // (company-market-install.ts): raw bytes, release trust roots, release
    // catalog origin, stable channel (the default). No lastSeenSequence
    // floor — the fallback predates any local receipt by construction.
    const verification = verifyDesktopCompanyManifest(embeddedText, {
      trustRoots: releasePolicy.trustRoots,
      companyCatalogOrigin: releasePolicy.companyCatalogOrigin,
    })
    if (!verification.ok) {
      throw new Error(`the embedded fallback manifest does not verify (${verification.code}): ${verification.reason}`)
    }
    expect(verification.keyId).toBe('company-catalog-2026-08')
    expect(embedded.packages.length).toBeGreaterThan(0)
    // Not a beta manifest: the fallback must verify through the stable
    // schema (a testers-carrying document would only ever serve the beta
    // channel, and the stable fallback scan would drop it).
    expect('testers' in embedded).toBe(false)
  })

  it('is not stale beyond the documented slack (sequence vs the repository ratchet)', () => {
    expect(
      Number.isSafeInteger(embedded.sequence) && embedded.sequence >= 1,
      `the embedded manifest must carry a safe positive sequence (got ${String(embedded.sequence)})`,
    ).toBe(true)
    const lag = ratchet - embedded.sequence
    expect(
      lag,
      `the embedded offline fallback is at sequence ${String(embedded.sequence)} while the repository catalog ratchet is at ${String(ratchet)} — a lag of ${String(lag)} exceeds the documented slack of ${String(MAX_SEQUENCE_LAG)}. Refresh dsh-plugin-desktop/assets/company-market/catalog-manifest.json with the currently deployed STABLE manifest bytes (fetch ${releasePolicy.companyManifestUrl}, verify with \`node tools/company-catalog/cli.mjs verify <file>\` under COMPANY_CATALOG_KEY_FINGERPRINT, then embed the exact canonical bytes). An old fallback is safe (floors come from receipts and the ratchet) but a build must not ship a rotted one.`,
    ).toBeLessThanOrEqual(MAX_SEQUENCE_LAG)
  })

  it('has not expired', () => {
    const expiresAt = Date.parse(embedded.expiresAt)
    expect(Number.isFinite(expiresAt), `the embedded manifest carries an unparseable expiresAt (${embedded.expiresAt})`).toBe(true)
    expect(
      expiresAt > Date.now(),
      `the embedded offline fallback expired at ${embedded.expiresAt} — an expired manifest never verifies, so the fallback is dead weight the first time a machine needs it. Re-embed the currently deployed stable manifest bytes (see the sequence-staleness failure for the refresh procedure).`,
    ).toBe(true)
  })
})
