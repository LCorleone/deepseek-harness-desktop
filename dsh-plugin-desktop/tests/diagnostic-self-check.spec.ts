import { createHash, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { canonicalJsonText, ed25519PublicKeyFingerprint } from 'dsh-community-market'
import {
  assembleDesktopSelfCheckExport,
  canonicalDesktopSelfCheckReportWindow,
  DESKTOP_SELF_CHECK_REPORT_ENTRY,
  DESKTOP_SELF_CHECK_UNSIGNED_REASON,
  desktopBootVerificationSnapshotPath,
  desktopPolicySelfCheckStatus,
  desktopSelfCheckReportText,
  type DesktopSelfCheckExportPayload,
  type DesktopSelfCheckReport,
  DIAGNOSTICS_SIGNING_PUBLIC_KEYS,
  diagnosticsViewKeyFingerprint,
  normalizeDiagnosticsViewKeys,
  readDesktopBootVerificationSnapshot,
  verifyDesktopSelfCheckReport,
  writeDesktopBootVerificationSnapshot,
} from '../src/diagnostic-self-check.ts'
import { exportDesktopDiagnostics, exportDiagnosticsZip } from '../src/diagnostic-export.ts'
import type { DesktopBootVerification } from '../src/boot-verification.ts'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const viewKey = {
  keyId: 'diagnostics-view-2026.01',
  publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
}
const fingerprint = ed25519PublicKeyFingerprint(publicKey)
const APP_VERSION = '2.0.1-test'
const temporaryDirectories: string[] = []

const verifyScript = fileURLToPath(new URL('../scripts/verify-diagnostics-report.mjs', import.meta.url))

/**
 * Client-side signing was removed (direction B), so tests that need a signed
 * fixture construct one the way the future centralized re-signing service
 * will: sign the canonical window with an ed25519 key and attach the
 * self-contained signature block.
 */
function reSignReportFixture(
  report: DesktopSelfCheckReport,
  privateKey: KeyObject,
  keyId: string,
): DesktopSelfCheckReport {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const publicKey = Buffer.from(spki.subarray(12)).toString('base64')
  const cleared: DesktopSelfCheckReport = { ...report, unsigned: null }
  const value = sign(null, Buffer.from(canonicalDesktopSelfCheckReportWindow(cleared), 'utf8'), privateKey)
  return {
    ...cleared,
    signature: { algorithm: 'ed25519', keyId, publicKey, value: value.toString('base64') },
  }
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

function lockedBootVerification(): DesktopBootVerification {
  return {
    manifestTrusted: true,
    manifestSequence: 21,
    keyId: 'company-catalog-2026.01',
    manifestFailure: undefined,
    allowed: [
      {
        packageName: 'dsh-plugin-safe',
        evidence: 'receipt',
        manifestSequence: 21,
        keyId: 'company-catalog-2026.01',
      },
      {
        packageName: 'dsh-plugin-audited',
        evidence: 'manifest-only',
        manifestSequence: 21,
        keyId: 'company-catalog-2026.01',
      },
    ],
    rejected: [
      {
        packageName: 'dsh-plugin-tampered',
        reason: 'the installed files of dsh-plugin-tampered@1.0.0 differ from the tree recorded in its install receipt',
      },
    ],
  }
}

function untrustedManifestBootVerification(): DesktopBootVerification {
  return {
    manifestTrusted: false,
    manifestSequence: undefined,
    keyId: undefined,
    manifestFailure: { code: 'stale-sequence', reason: 'sequence 4 does not exceed the last seen sequence 9' },
    allowed: [],
    rejected: [{ packageName: 'dsh-plugin-safe', reason: 'the company manifest is not trusted (stale-sequence)' }],
  }
}

function writeSnapshot(dir: string, verification: DesktopBootVerification | null): string {
  const path = desktopBootVerificationSnapshotPath(dir)
  expect(writeDesktopBootVerificationSnapshot(dir, verification === null ? undefined : verification,
    () => new Date('2026-08-20T08:30:00.000Z'))).toBe(true)
  return path
}

function unsignedReportInput(dir: string, verification: DesktopBootVerification | null) {
  const userDataDir = temporaryDirectory('dsh-self-check-user-')
  writeSnapshot(userDataDir, verification)
  return assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
    bootSnapshotPath: desktopBootVerificationSnapshotPath(userDataDir),
    policyAssetPath: join(dir, 'missing-policy.json'),
    now: () => new Date('2026-08-20T09:00:00.000Z'),
  })
}

describe('diagnostics view keys (P4-1 direction B)', () => {
  it('keeps the empty constant as future centralized re-signing material', () => {
    expect(DIAGNOSTICS_SIGNING_PUBLIC_KEYS).toEqual([])
  })

  it('accepts and freezes well-formed view keys', () => {
    expect(normalizeDiagnosticsViewKeys([viewKey])).toEqual([viewKey])
    expect(normalizeDiagnosticsViewKeys([])).toEqual([])
  })

  it('rejects malformed or duplicated view keys', () => {
    expect(() => normalizeDiagnosticsViewKeys('nope')).toThrow(/must be an array/u)
    expect(() => normalizeDiagnosticsViewKeys([{ keyId: 'bad key!', publicKey: viewKey.publicKey }])).toThrow(/keyId/u)
    expect(() => normalizeDiagnosticsViewKeys([{ keyId: viewKey.keyId, publicKey: Buffer.alloc(8).toString('base64') }]))
      .toThrow(/raw 32-byte/u)
    expect(() => normalizeDiagnosticsViewKeys([{ keyId: viewKey.keyId }])).toThrow(/keyId and publicKey/u)
    expect(() => normalizeDiagnosticsViewKeys([viewKey, { ...viewKey }])).toThrow(/duplicate/u)
    expect(() => normalizeDiagnosticsViewKeys([
      viewKey,
      { keyId: 'other', publicKey: viewKey.publicKey },
    ])).toThrow(/duplicate/u)
  })

  it('fingerprints the raw key exactly like the catalog channel', () => {
    expect(diagnosticsViewKeyFingerprint(viewKey.publicKey)).toBe(fingerprint)
    expect(() => diagnosticsViewKeyFingerprint(Buffer.alloc(4).toString('base64'))).toThrow(/32 bytes/u)
  })
})

describe('boot verification snapshots', () => {
  it('round-trips a locked boot decision with dropped optional members', () => {
    const dir = temporaryDirectory('dsh-self-check-snapshot-')
    const path = writeSnapshot(dir, lockedBootVerification())
    const snapshot = readDesktopBootVerificationSnapshot(path)
    expect(snapshot).toEqual({
      recordedAt: '2026-08-20T08:30:00.000Z',
      bootVerification: lockedBootVerification(),
    })
  })

  it('round-trips an untrusted-manifest boot decision', () => {
    const dir = temporaryDirectory('dsh-self-check-snapshot-')
    const path = writeSnapshot(dir, untrustedManifestBootVerification())
    const snapshot = readDesktopBootVerificationSnapshot(path)
    expect(snapshot?.bootVerification).toEqual(untrustedManifestBootVerification())
  })

  it('records unlocked boots as null and invalidates stale locked records', () => {
    const dir = temporaryDirectory('dsh-self-check-snapshot-')
    writeSnapshot(dir, lockedBootVerification())
    const path = writeSnapshot(dir, null)
    expect(readDesktopBootVerificationSnapshot(path)).toEqual({
      recordedAt: '2026-08-20T08:30:00.000Z',
      bootVerification: null,
    })
  })

  it('ignores missing, malformed, or unexpected documents', () => {
    const dir = temporaryDirectory('dsh-self-check-snapshot-')
    expect(readDesktopBootVerificationSnapshot(join(dir, 'absent.json'))).toBeUndefined()
    const malformed = desktopBootVerificationSnapshotPath(dir)
    for (const body of ['not json\n', '{"recordedAt":"x"}', '{"recordedAt":"x","bootVerification":7,"extra":1}']) {
      writeFileSync(malformed, body)
      expect(readDesktopBootVerificationSnapshot(malformed)).toBeUndefined()
    }
    writeFileSync(malformed, JSON.stringify({
      recordedAt: '2026-08-20T08:30:00.000Z',
      bootVerification: { manifestTrusted: 'yes', allowed: [], rejected: [] },
    }))
    expect(readDesktopBootVerificationSnapshot(malformed)).toBeUndefined()
  })
})

describe('policy self-measurement', () => {
  it('digests a well-formed policy asset with its trust roots', () => {
    const dir = temporaryDirectory('dsh-self-check-policy-')
    const asset = join(dir, 'desktop-policy.json')
    const body = JSON.stringify({
      allowHomePatch: false,
      allowManualPluginAdd: false,
      companyCatalogOrigin: null,
      companyManifestUrl: 'company-market/catalog-manifest.json',
      locked: true,
      trustRoots: [{ keyId: 'company-catalog-2026.01', fingerprint: fingerprint }],
    })
    writeFileSync(asset, body)
    const status = desktopPolicySelfCheckStatus(asset)
    expect(status).toEqual({
      available: true,
      reason: null,
      locked: true,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
      trustRoots: [{ keyId: 'company-catalog-2026.01', fingerprint }],
    })
  })

  it('reports unavailable instead of throwing for missing or invalid assets', () => {
    const dir = temporaryDirectory('dsh-self-check-policy-')
    const missing = desktopPolicySelfCheckStatus(join(dir, 'missing.json'))
    expect(missing.available).toBe(false)
    expect(missing.sha256).toBeNull()
    expect(missing.reason).toMatch(/unreadable/u)
    const invalid = join(dir, 'desktop-policy.json')
    writeFileSync(invalid, '{"locked":true}')
    expect(desktopPolicySelfCheckStatus(invalid).reason).toMatch(/strict parsing/u)
  })
})

describe('unsigned reports (direction B: always unsigned)', () => {
  it('carries the fixed absence-is-the-signal reason on every export', () => {
    const dir = temporaryDirectory('dsh-self-check-dev-')
    const userDataDir = temporaryDirectory('dsh-self-check-user-')
    writeSnapshot(userDataDir, lockedBootVerification())
    const payload = assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
      bootSnapshotPath: desktopBootVerificationSnapshotPath(userDataDir),
      policyAssetPath: join(dir, 'missing-policy.json'),
      now: () => new Date('2026-08-20T09:00:00.000Z'),
    })
    expect(payload.signed).toBe(false)
    const report = JSON.parse(payload.reportText)
    expect(report.signature).toBeNull()
    expect(report.unsigned).toEqual({ reason: DESKTOP_SELF_CHECK_UNSIGNED_REASON })
    expect(report.unsigned.reason).toMatch(/absence of the report is the tamper signal/u)
    expect(report.signing.viewKeys).toEqual([])
    const verification = verifyDesktopSelfCheckReport(report)
    expect(verification).toMatchObject({ ok: false, code: 'unsigned' })
    expect(verification.ok === false ? verification.reason : '').toBe(DESKTOP_SELF_CHECK_UNSIGNED_REASON)
  })

  it('records the boot refusal list, manifest sequence, and policy digest fields', () => {
    const dir = temporaryDirectory('dsh-self-check-dev-')
    const payload = unsignedReportInput(dir, lockedBootVerification())
    const report = JSON.parse(payload.reportText)
    expect(report.reportVersion).toBe('1.0.0')
    expect(report.app).toBe('dsh-plugin-desktop')
    expect(report.appVersion).toBe(APP_VERSION)
    expect(report.generatedAt).toBe('2026-08-20T09:00:00.000Z')
    expect(report.platform).toBe(process.platform)
    expect(report.nodeRuntime.status).toBe('development')
    expect(report.policy.available).toBe(false)
    expect(report.bootVerification).toEqual({
      available: true,
      recordedAt: '2026-08-20T08:30:00.000Z',
      manifestTrusted: true,
      manifestSequence: 21,
      keyId: 'company-catalog-2026.01',
      manifestFailure: null,
      allowed: [
        {
          packageName: 'dsh-plugin-safe',
          resolved: { evidence: 'receipt', manifestSequence: 21, keyId: 'company-catalog-2026.01' },
          decided: { allowedBy: 'signed-company-manifest' },
        },
        {
          packageName: 'dsh-plugin-audited',
          resolved: { evidence: 'manifest-only', manifestSequence: 21, keyId: 'company-catalog-2026.01' },
          decided: { allowedBy: 'signed-company-manifest' },
        },
      ],
      refused: [
        {
          packageName: 'dsh-plugin-tampered',
          decided: {
            refusedBy: 'boot-verification',
            reason: 'the installed files of dsh-plugin-tampered@1.0.0 differ from the tree recorded in its install receipt',
          },
        },
      ],
    })
  })

  it('explains an untrusted manifest with its failure code', () => {
    const dir = temporaryDirectory('dsh-self-check-dev-')
    const payload = unsignedReportInput(dir, untrustedManifestBootVerification())
    const report = JSON.parse(payload.reportText)
    expect(report.bootVerification).toEqual({
      available: true,
      recordedAt: '2026-08-20T08:30:00.000Z',
      manifestTrusted: false,
      manifestSequence: null,
      keyId: null,
      manifestFailure: { code: 'stale-sequence', reason: 'sequence 4 does not exceed the last seen sequence 9' },
      allowed: [],
      refused: [{
        packageName: 'dsh-plugin-safe',
        decided: {
          refusedBy: 'boot-verification',
          reason: 'the company manifest is not trusted (stale-sequence)',
        },
      }],
    })
  })

  it('records absent and unlocked boot states as unavailable', () => {
    const dir = temporaryDirectory('dsh-self-check-dev-')
    const userDataDir = temporaryDirectory('dsh-self-check-user-')
    const absent = assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
      policyAssetPath: join(dir, 'missing-policy.json'),
    })
    expect(JSON.parse(absent.reportText).bootVerification).toMatchObject({
      available: false,
      reason: expect.stringMatching(/no boot verification snapshot/u),
    })
    writeSnapshot(userDataDir, null)
    const unlocked = assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
      bootSnapshotPath: desktopBootVerificationSnapshotPath(userDataDir),
      policyAssetPath: join(dir, 'missing-policy.json'),
    })
    expect(JSON.parse(unlocked.reportText).bootVerification).toMatchObject({
      available: false,
      reason: expect.stringMatching(/unlocked policy/u),
    })
  })
})

describe('re-signed report fixtures (centralized re-signing forward compatibility)', () => {
  function reSignedPayload(
    viewKeys: readonly { keyId: string, publicKey: string }[] = [viewKey],
    signer: KeyObject = privateKey,
    keyId = viewKey.keyId,
  ): DesktopSelfCheckExportPayload {
    const dir = temporaryDirectory('dsh-self-check-signed-')
    const userDataDir = temporaryDirectory('dsh-self-check-user-')
    writeSnapshot(userDataDir, lockedBootVerification())
    const unsigned = assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
      bootSnapshotPath: desktopBootVerificationSnapshotPath(userDataDir),
      policyAssetPath: join(dir, 'missing-policy.json'),
      viewKeys,
      now: () => new Date('2026-08-20T09:00:00.000Z'),
    })
    const report = reSignReportFixture(JSON.parse(unsigned.reportText), signer, keyId)
    return { reportText: desktopSelfCheckReportText(report), signed: true }
  }

  it('verifies a signature over the canonical window against the pinned view key', () => {
    const payload = reSignedPayload()
    expect(payload.signed).toBe(true)
    const report = JSON.parse(payload.reportText)
    expect(report.unsigned).toBeNull()
    expect(report.signature).toMatchObject({ algorithm: 'ed25519', keyId: viewKey.keyId })
    expect(report.signature.publicKey).toBe(viewKey.publicKey)
    expect(verifyDesktopSelfCheckReport(report)).toEqual({ ok: true, keyId: viewKey.keyId, fingerprint })
    expect(verifyDesktopSelfCheckReport(report, { trustedViewKeys: [viewKey] })).toEqual({
      ok: true,
      keyId: viewKey.keyId,
      fingerprint,
    })
  })

  it('archives exactly the canonical bytes of the signed window', () => {
    const payload = reSignedPayload()
    const report = JSON.parse(payload.reportText)
    expect(payload.reportText).toBe(canonicalJsonText(report))
    const window = { ...report }
    delete window.signature
    expect(canonicalDesktopSelfCheckReportWindow(report)).toBe(canonicalJsonText(window))
  })

  it('fails verification after report content is tampered with', () => {
    const report = JSON.parse(reSignedPayload().reportText)
    const tampered = { ...report, appVersion: '9.9.9-evil' }
    expect(verifyDesktopSelfCheckReport(tampered)).toMatchObject({ ok: false, code: 'bad-signature' })
    const tamperedBoot = JSON.parse(JSON.stringify(report))
    tamperedBoot.bootVerification.refused = []
    expect(verifyDesktopSelfCheckReport(tamperedBoot)).toMatchObject({ ok: false, code: 'bad-signature' })
    const tamperedSignature = JSON.parse(JSON.stringify(report))
    tamperedSignature.signature.value = Buffer.alloc(64, 1).toString('base64')
    expect(verifyDesktopSelfCheckReport(tamperedSignature)).toMatchObject({ ok: false, code: 'bad-signature' })
    const shortSignature = JSON.parse(JSON.stringify(report))
    shortSignature.signature.value = Buffer.alloc(10).toString('base64')
    expect(verifyDesktopSelfCheckReport(shortSignature)).toMatchObject({ ok: false, code: 'invalid-signature-encoding' })
  })

  it('rejects signatures under keys outside the pinned view keys', () => {
    const other = generateKeyPairSync('ed25519')
    // Signed with the real view key; only the administrator's pin is wrong.
    const signed = reSignedPayload()
    const report = JSON.parse(signed.reportText)

    const wrongPin = { keyId: viewKey.keyId, publicKey: other.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64') }
    expect(verifyDesktopSelfCheckReport(report, { trustedViewKeys: [wrongPin] }))
      .toMatchObject({ ok: false, code: 'key-mismatch' })
    expect(verifyDesktopSelfCheckReport(report, { trustedViewKeys: [{ keyId: 'other-key', publicKey: viewKey.publicKey }] }))
      .toMatchObject({ ok: false, code: 'unknown-key' })
    expect(verifyDesktopSelfCheckReport(desktopSelfCheckReportText(report))).toMatchObject({ ok: false, code: 'invalid-report' })
    expect(verifyDesktopSelfCheckReport(null)).toMatchObject({ ok: false, code: 'invalid-report' })
  })
})

describe('diagnostics archive integration', () => {
  it('embeds the unsigned self-check report and records it in system-info', async () => {
    const userDataDir = temporaryDirectory('dsh-self-check-export-')
    writeSnapshot(userDataDir, lockedBootVerification())
    const out = await exportDesktopDiagnostics(userDataDir, { appVersion: APP_VERSION })
    const zip = new AdmZip(out)
    expect(zip.getEntries().map(entry => entry.entryName)).toContain(DESKTOP_SELF_CHECK_REPORT_ENTRY)
    const reportText = zip.readAsText(DESKTOP_SELF_CHECK_REPORT_ENTRY)
    const report = JSON.parse(reportText)
    expect(report.unsigned).toEqual({ reason: DESKTOP_SELF_CHECK_UNSIGNED_REASON })
    expect(report.bootVerification.available).toBe(true)
    expect(report.bootVerification.refused).toHaveLength(1)
    expect(report.bootVerification.manifestSequence).toBe(21)
    const systemInfo = zip.readAsText('system-info.txt')
    expect(systemInfo).toContain('included-self-check-report: true')
    expect(systemInfo).toContain('self-check-report-signed: false')
  })

  it('verifies a re-signed report straight from the exported zip with the zero-dependency script', async () => {
    const userDataDir = temporaryDirectory('dsh-self-check-export-')
    writeSnapshot(userDataDir, lockedBootVerification())
    const unsignedPayload = assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
      bootSnapshotPath: desktopBootVerificationSnapshotPath(userDataDir),
      viewKeys: [viewKey],
      now: () => new Date('2026-08-20T09:00:00.000Z'),
    })
    // The client never signs (direction B); this fixture is signed the way the
    // future centralized re-signing service will, so the script's verify path
    // stays covered.
    const reSigned = reSignReportFixture(JSON.parse(unsignedPayload.reportText), privateKey, viewKey.keyId)
    const payload: DesktopSelfCheckExportPayload = {
      reportText: desktopSelfCheckReportText(reSigned),
      signed: true,
    }
    const logs = join(userDataDir, 'logs')
    mkdirSync(logs)
    const out = await exportDiagnosticsZip(logs, userDataDir, { appVersion: APP_VERSION, selfCheck: payload })
    const zip = new AdmZip(out)
    expect(zip.readAsText(DESKTOP_SELF_CHECK_REPORT_ENTRY)).toBe(payload.reportText)
    expect(zip.readAsText('system-info.txt')).toContain('self-check-report-signed: true')

    const verified = spawnSync(process.execPath, [verifyScript, out], { encoding: 'utf8' })
    expect(verified.stderr).toBe('')
    expect(verified.status).toBe(0)
    expect(verified.stdout).toContain('self-check report signature VERIFIED')
    expect(verified.stdout).toContain(fingerprint)
    expect(verified.stdout).toContain(`key id      : ${viewKey.keyId}`)

    const pinned = spawnSync(process.execPath, [verifyScript, out, '--fingerprint', fingerprint], { encoding: 'utf8' })
    expect(pinned.status).toBe(0)
    expect(pinned.stdout).toContain('fingerprint matches the pinned --fingerprint')

    const wrongPin = spawnSync(process.execPath, [verifyScript, out, '--fingerprint', '0'.repeat(64)], { encoding: 'utf8' })
    expect(wrongPin.status).toBe(1)
    expect(wrongPin.stderr).toContain('does not match the pinned --fingerprint')
  })

  it('flags an unsigned report with exit 0 and fails only on tampered content or bad usage', async () => {
    const userDataDir = temporaryDirectory('dsh-self-check-export-')
    writeSnapshot(userDataDir, lockedBootVerification())
    const unsignedPayload = assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
      bootSnapshotPath: desktopBootVerificationSnapshotPath(userDataDir),
      viewKeys: [viewKey],
      now: () => new Date('2026-08-20T09:00:00.000Z'),
    })
    const reSigned = reSignReportFixture(JSON.parse(unsignedPayload.reportText), privateKey, viewKey.keyId)
    const tampered = JSON.parse(desktopSelfCheckReportText(reSigned))
    tampered.bootVerification.allowed = []
    const tamperedPath = join(userDataDir, 'tampered-report.json')
    writeFileSync(tamperedPath, canonicalJsonText(tampered))
    const tamperedRun = spawnSync(process.execPath, [verifyScript, tamperedPath], { encoding: 'utf8' })
    expect(tamperedRun.status).toBe(1)
    expect(tamperedRun.stderr).toContain('signature verification failed')

    const unsignedPayloadPlain = assembleDesktopSelfCheckExport(userDataDir, APP_VERSION, {
      bootSnapshotPath: desktopBootVerificationSnapshotPath(userDataDir),
    })
    const unsignedPath = join(userDataDir, 'unsigned-report.json')
    writeFileSync(unsignedPath, unsignedPayloadPlain.reportText)
    const unsignedReportRun = spawnSync(process.execPath, [verifyScript, unsignedPath], { encoding: 'utf8' })
    expect(unsignedReportRun.status).toBe(0)
    expect(unsignedReportRun.stderr).toBe('')
    expect(unsignedReportRun.stdout).toContain('UNSIGNED self-check report')
    expect(unsignedReportRun.stdout).toContain(DESKTOP_SELF_CHECK_UNSIGNED_REASON)

    const usage = spawnSync(process.execPath, [verifyScript], { encoding: 'utf8' })
    expect(usage.status).toBe(2)
    const missingFingerprint = spawnSync(process.execPath, [verifyScript, unsignedPath, '--fingerprint'], { encoding: 'utf8' })
    expect(missingFingerprint.status).toBe(2)
    expect(missingFingerprint.stderr).toContain('--fingerprint requires a value')
    const missingKeyId = spawnSync(process.execPath, [verifyScript, unsignedPath, '--key-id'], { encoding: 'utf8' })
    expect(missingKeyId.status).toBe(2)
    expect(missingKeyId.stderr).toContain('--key-id requires a value')
  })
})
