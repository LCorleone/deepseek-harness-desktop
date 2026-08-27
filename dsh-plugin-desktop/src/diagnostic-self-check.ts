/**
 * Self-check report for the diagnostics export (security plan P4-1, review
 * direction B).
 *
 * The diagnostics archive gains one deterministic entry,
 * `self-check-report.json`: a machine-readable snapshot of what this build's
 * own security posture looked like when the export ran — the boot
 * verification decision over third-party bundles (P2-4: the full allowed and
 * refused lists, manifest sequence, and trust-root key), the digest of the
 * embedded policy asset (`desktop-policy.json`), the bundled Node runtime
 * self-check (P3-1), the application version, and a generation timestamp.
 *
 * Reports are generated unsigned, by design (review direction B): a
 * client-side signature is not a forge-resistant control, because an
 * attacker who can modify the client can extract or strip its signing key,
 * so signing on the client proves nothing the report's content does not
 * already carry. The tamper signal is the report's absence — a modified
 * client can suppress or forge an unsigned report, but its content then has
 * to contradict the company-published policy digests and manifest
 * sequences to be useful, and suppressing the report entirely is itself
 * the signal the operations manual (P4-2) instructs reviewers to act on.
 * The `signature`/`unsigned` grammar, the `signing.viewKeys` section, and
 * the canonical signed-window functions are retained so a future
 * centralized re-signing service can sign exported reports off-client
 * without a format break; `scripts/verify-diagnostics-report.mjs` already
 * verifies such signature blocks when present.
 *
 * Key relationship (P4-1 vs P2-1): diagnostics signing uses a dedicated
 * "view key" pair — the same ed25519 library and trust-root shape as the
 * company catalog and update channels, but a completely independent key.
 * {@link DIAGNOSTICS_SIGNING_PUBLIC_KEYS} keeps the `{keyId, publicKey}`
 * shape (the key body, not just a fingerprint, because a self-contained
 * re-signed report must carry it) as future material for the centralized
 * signer; it ships empty today and the client embeds it only in the
 * report's `signing.viewKeys` fingerprints section.
 *
 * Evidence vocabulary: allowed and refused bundles use the `resolved` /
 * `decided` field names of `dsh-community-fabric` RFC 0004
 * "Provenance, Validation, Diagnostics, and the Effect Ledger" §4, the same
 * vocabulary `dsh-community-market` receipt v2 (P2-3) defines locally as
 * `MarketEvidenceClass`. Desktop defines the same-named structures here
 * against that RFC source; they must not drift from it.
 *
 * Determinism: the report body is written as canonical JSON (sorted keys, no
 * whitespace, safe integers only), so the archived file bytes are exactly
 * the bytes a verifier re-serializes after parsing.
 */

import {
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  canonicalJsonText,
  ed25519PublicKeyFingerprint,
} from 'dsh-community-market'
import { desktopPolicyAssetPath, parseDesktopPolicy, desktopPolicyConstants } from './desktop-policy.ts'
import type { DesktopPolicyTrustRoot } from './desktop-policy.ts'
import { isPackagedModuleUrl, resolveDesktopNodeExecutable } from './desktop-node-runtime.ts'
import type { DesktopBootVerification } from './boot-verification.ts'

/** Archive entry carrying the self-check report inside a diagnostics zip. */
export const DESKTOP_SELF_CHECK_REPORT_ENTRY = 'self-check-report.json'

/** Report grammar version; bumped on any breaking field change. */
export const DESKTOP_SELF_CHECK_REPORT_VERSION = '1.0.0'

/** Upper bound of one boot-verification snapshot document. */
const MAX_BOOT_SNAPSHOT_BYTES = 4 * 1024 * 1024

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

/** Raw ed25519 public keys are exactly 32 bytes. */
export const DIAGNOSTICS_PUBLIC_KEY_BYTES = 32
/** Detached ed25519 signatures are exactly 64 bytes. */
export const DIAGNOSTICS_SIGNATURE_BYTES = 64

/**
 * One diagnostics view key trusted to sign self-check reports. Unlike the
 * catalog and update trust roots, which pin fingerprints only, this shape
 * carries the public key body (standard base64 of the raw 32-byte ed25519
 * key): the report is self-contained for the off-client verifier, so the
 * signer must embed the key it signed with.
 */
export interface DiagnosticsViewKey {
  /** Stable identifier selecting among overlapping rotation keys. */
  readonly keyId: string
  /** Standard base64 of the raw 32-byte ed25519 public key. */
  readonly publicKey: string
}

/**
 * Reason recorded on every generated report (review direction B): the
 * client cannot hold a signing key an attacker could not also hold, so the
 * report is unsigned and its absence — plus content that contradicts the
 * company-published policy digests and manifest sequences — is the tamper
 * signal. Exported for the runbook and tests.
 */
export const DESKTOP_SELF_CHECK_UNSIGNED_REASON
  = 'client-side signing is not a forge-resistant control; absence of the report is the tamper signal'

/**
 * Diagnostics view keys embedded at build time.
 *
 * Future material for the centralized re-signing service (P4-1 direction
 * B): client-side signing was removed — a private key shipped to the client
 * is extractable by exactly the attacker it would claim to bound — so
 * reports are generated unsigned and the report's absence plus content
 * comparison is the tamper signal. The constant stays empty in every build
 * today and the shape stays strict, so a later company-side signer can
 * publish `{keyId, publicKey}` entries without touching the report grammar,
 * the verifier, or the P4-2 runbook.
 */
export const DIAGNOSTICS_SIGNING_PUBLIC_KEYS: readonly DiagnosticsViewKey[] = [] // future centralized re-signing material — deliberately empty under the direction-B unsigned-report model (P4-1)

/**
 * Validate and freeze diagnostics view keys. Mirrors the strict catalog and
 * update trust-root parsers: entries are `{keyId, publicKey}` objects only,
 * keyIds match the shared identifier grammar, public keys decode to exactly
 * 32 bytes, and neither keyIds nor key bodies may repeat.
 */
export function normalizeDiagnosticsViewKeys(value: unknown): readonly DiagnosticsViewKey[] {
  if (!Array.isArray(value)) {
    throw new TypeError('diagnostics view keys must be an array of {keyId, publicKey} entries')
  }
  const viewKeys: DiagnosticsViewKey[] = []
  const keyIds = new Set<string>()
  const publicKeys = new Set<string>()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('diagnostics view keys must be objects')
    }
    const object = entry as Record<string, unknown>
    const keys = Object.keys(object).sort()
    if (keys.length !== 2 || keys[0] !== 'keyId' || keys[1] !== 'publicKey') {
      throw new TypeError('diagnostics view keys have exactly keyId and publicKey fields')
    }
    const { keyId, publicKey } = object
    if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
      throw new TypeError('diagnostics view key keyId must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
    }
    if (typeof publicKey !== 'string' || !BASE64_PATTERN.test(publicKey)
      || Buffer.from(publicKey, 'base64').byteLength !== DIAGNOSTICS_PUBLIC_KEY_BYTES) {
      throw new TypeError('diagnostics view key publicKey must be base64 of a raw 32-byte ed25519 key')
    }
    if (keyIds.has(keyId)) throw new TypeError(`duplicate diagnostics view key keyId ${keyId}`)
    if (publicKeys.has(publicKey)) throw new TypeError('duplicate diagnostics view key publicKey')
    keyIds.add(keyId)
    publicKeys.add(publicKey)
    viewKeys.push(Object.freeze({ keyId, publicKey }))
  }
  return Object.freeze(viewKeys)
}

/** SHA-256 fingerprint (64 lowercase hex) of a raw ed25519 diagnostics view key. */
export function diagnosticsViewKeyFingerprint(publicKeyBase64: string): string {
  const raw = Buffer.from(publicKeyBase64, 'base64')
  if (raw.byteLength !== DIAGNOSTICS_PUBLIC_KEY_BYTES) {
    throw new TypeError('a raw ed25519 public key is exactly 32 bytes')
  }
  return ed25519PublicKeyFingerprint(new Uint8Array(raw))
}

/**
 * RFC 0004 evidence class `resolved` for one allowed bundle: the evidence
 * the boot decision actually measured. `evidence` is the P2-4 boot evidence
 * grade — `signed-tree` means the installed tree matched the tree digest
 * pinned in the signed company manifest entry (the authority anchor),
 * `receipt` means it matched its market install receipt digest (entries
 * without a signed tree digest), and `manifest-only` means the signed entry
 * and lockfile integrity bound the bundle without a usable receipt.
 */
export interface DesktopSelfCheckResolvedEvidence {
  readonly evidence: 'receipt' | 'manifest-only' | 'signed-tree'
  readonly manifestSequence: number
  readonly keyId: string
}

/**
 * RFC 0004 evidence class `decided` for one allowed bundle: the only
 * authority that may permit a third-party bundle in a locked boot.
 */
export interface DesktopSelfCheckAllowedDecision {
  readonly allowedBy: 'signed-company-manifest'
}

/** One bundle the recorded boot cleared for loading. */
export interface DesktopSelfCheckAllowedBundle {
  readonly packageName: string
  readonly resolved: DesktopSelfCheckResolvedEvidence
  readonly decided: DesktopSelfCheckAllowedDecision
}

/**
 * RFC 0004 evidence class `decided` for one refused bundle: the boot
 * verification outcome with the first failing check as the reason.
 */
export interface DesktopSelfCheckRefusedDecision {
  readonly refusedBy: 'boot-verification'
  readonly reason: string
}

/** One bundle the recorded boot refused, with the first failing check. */
export interface DesktopSelfCheckRefusedBundle {
  readonly packageName: string
  readonly decided: DesktopSelfCheckRefusedDecision
}

/** Boot verification section of the self-check report. */
export type DesktopSelfCheckBootVerification =
  | {
    /** No boot verification record exists for this export. */
    readonly available: false
    readonly reason: string
  }
  | {
    readonly available: true
    /** When the recorded boot decision was taken (`recordedAt` of the snapshot). */
    readonly recordedAt: string
    /** Whether the signed company manifest verified for the recorded boot. */
    readonly manifestTrusted: boolean
    /** Verified manifest sequence, or null when the manifest was not trusted. */
    readonly manifestSequence: number | null
    /** keyId that verified the manifest, or null when the manifest was not trusted. */
    readonly keyId: string | null
    /** First manifest-level failure, or null after a successful verification. */
    readonly manifestFailure: { readonly code: string, readonly reason: string } | null
    /** Bundles cleared for loading, in boot submission order. */
    readonly allowed: readonly DesktopSelfCheckAllowedBundle[]
    /** Bundles refused for loading, in boot submission order. */
    readonly refused: readonly DesktopSelfCheckRefusedBundle[]
  }

/** Self-measurement of the embedded policy asset (`desktop-policy.json`). */
export interface DesktopSelfCheckPolicyStatus {
  /** Whether the policy asset could be read and strictly parsed. */
  readonly available: boolean
  /** Why the asset was unavailable; null once the digest was computed. */
  readonly reason: string | null
  /** Policy `locked` flag; null when unavailable. */
  readonly locked: boolean | null
  /** SHA-256 (64 lowercase hex) of the exact policy asset bytes. */
  readonly sha256: string | null
  /** Policy asset size in bytes; null when unavailable. */
  readonly bytes: number | null
  /** Trust roots the parsed policy pins for company manifest verification. */
  readonly trustRoots: readonly DesktopPolicyTrustRoot[]
}

/** Self-check state of the bundled Node runtime (P3-1). */
export interface DesktopSelfCheckNodeRuntimeStatus {
  /** `verified` (digest matched), `development` (unpackaged run), or `failed`. */
  readonly status: 'verified' | 'development' | 'failed'
  /** Human-readable context; null when there is nothing to add. */
  readonly detail: string | null
}

/** Detached ed25519 signature block of one signed report. */
export interface DesktopSelfCheckSignature {
  readonly algorithm: 'ed25519'
  readonly keyId: string
  /** Standard base64 of the raw 32-byte ed25519 public key that signed. */
  readonly publicKey: string
  /** Standard base64 of the 64-byte detached signature. */
  readonly value: string
}

/** Complete self-check report embedded in the diagnostics archive. */
export interface DesktopSelfCheckReport {
  readonly reportVersion: typeof DESKTOP_SELF_CHECK_REPORT_VERSION
  /** RFC 3339 generation timestamp. */
  readonly generatedAt: string
  readonly app: 'dsh-plugin-desktop'
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
  readonly nodeVersion: string
  readonly policy: DesktopSelfCheckPolicyStatus
  readonly nodeRuntime: DesktopSelfCheckNodeRuntimeStatus
  readonly bootVerification: DesktopSelfCheckBootVerification
  /** keyIds and fingerprints of the view keys this build pins. */
  readonly signing: { readonly viewKeys: readonly { readonly keyId: string, readonly fingerprint: string }[] }
  /** Present exactly when the report is signed; the signed window excludes it. */
  readonly signature: DesktopSelfCheckSignature | null
  /** Present exactly when the report is unsigned; carries the reason. */
  readonly unsigned: { readonly reason: string } | null
}

/** Inputs of {@link buildDesktopSelfCheckReport}. */
export interface DesktopSelfCheckReportInput {
  readonly appVersion: string
  readonly policy: DesktopSelfCheckPolicyStatus
  readonly nodeRuntime: DesktopSelfCheckNodeRuntimeStatus
  /** Boot verification snapshot of the export; undefined records no boot data. */
  readonly bootSnapshot: DesktopBootVerificationSnapshot | undefined
  /** View keys pinned by this build (reported as fingerprints, never used to sign). */
  readonly viewKeys: readonly DiagnosticsViewKey[]
  /** Clock injection for the generation timestamp; defaults to now. */
  readonly now?: () => Date
  /** Platform override for focused tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Architecture override for focused tests; defaults to `process.arch`. */
  readonly arch?: string
  /** Node version override for focused tests; defaults to `process.version`. */
  readonly nodeVersion?: string
}

function selfCheckBootVerification(
  bootSnapshot: DesktopBootVerificationSnapshot | undefined,
): DesktopSelfCheckBootVerification {
  if (bootSnapshot === undefined) {
    return {
      available: false,
      reason: 'no boot verification snapshot exists for this user data'
        + ' (unlocked development build, or the export ran before any boot completed)',
    }
  }
  const verification = bootSnapshot.bootVerification
  if (verification === null) {
    return {
      available: false,
      reason: `the boot recorded at ${bootSnapshot.recordedAt} ran an unlocked policy without boot verification`,
    }
  }
  return {
    available: true,
    recordedAt: bootSnapshot.recordedAt,
    manifestTrusted: verification.manifestTrusted,
    manifestSequence: verification.manifestSequence ?? null,
    keyId: verification.keyId ?? null,
    manifestFailure: verification.manifestFailure === undefined
      ? null
      : { code: verification.manifestFailure.code, reason: verification.manifestFailure.reason },
    allowed: verification.allowed.map(bundle => ({
      packageName: bundle.packageName,
      resolved: {
        evidence: bundle.evidence,
        manifestSequence: bundle.manifestSequence,
        keyId: bundle.keyId,
      },
      decided: { allowedBy: 'signed-company-manifest' },
    })),
    refused: verification.rejected.map(bundle => ({
      packageName: bundle.packageName,
      decided: { refusedBy: 'boot-verification', reason: bundle.reason },
    })),
  }
}

/** Assemble one self-check report from measured inputs; always unsigned (direction B). */
export function buildDesktopSelfCheckReport(input: DesktopSelfCheckReportInput): DesktopSelfCheckReport {
  const viewKeys = normalizeDiagnosticsViewKeys(input.viewKeys)
  return {
    reportVersion: DESKTOP_SELF_CHECK_REPORT_VERSION,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    app: 'dsh-plugin-desktop',
    appVersion: input.appVersion,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    nodeVersion: input.nodeVersion ?? process.version,
    policy: input.policy,
    nodeRuntime: input.nodeRuntime,
    bootVerification: selfCheckBootVerification(input.bootSnapshot),
    signing: {
      viewKeys: viewKeys.map(key => ({
        keyId: key.keyId,
        fingerprint: diagnosticsViewKeyFingerprint(key.publicKey),
      })),
    },
    signature: null,
    unsigned: { reason: DESKTOP_SELF_CHECK_UNSIGNED_REASON },
  }
}

/**
 * Canonical text of the signed window: the report minus its `signature`
 * member. This is exactly the byte window the detached signature covers and
 * the verifier reconstructs.
 */
export function canonicalDesktopSelfCheckReportWindow(report: DesktopSelfCheckReport): string {
  const window: Record<string, unknown> = { ...report }
  delete window.signature
  return canonicalJsonText(window)
}

/** Canonical text of the complete report — the exact archived file bytes. */
export function desktopSelfCheckReportText(report: DesktopSelfCheckReport): string {
  return canonicalJsonText(report)
}

/** Why a self-check report signature was rejected. */
export type DesktopSelfCheckVerificationCode =
  | 'invalid-report'
  | 'unsigned'
  | 'unknown-key'
  | 'key-mismatch'
  | 'invalid-public-key'
  | 'invalid-signature-encoding'
  | 'bad-signature'

/** Result of verifying one self-check report signature. */
export type DesktopSelfCheckVerification =
  | {
    readonly ok: true
    readonly keyId: string
    /** SHA-256 fingerprint of the verified signing key; compare against the manual. */
    readonly fingerprint: string
  }
  | {
    readonly ok: false
    readonly code: DesktopSelfCheckVerificationCode
    readonly reason: string
  }

/** Parse one value into a report shape, or return undefined when malformed. */
export function parseDesktopSelfCheckReport(value: unknown): DesktopSelfCheckReport | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  if (object.reportVersion !== DESKTOP_SELF_CHECK_REPORT_VERSION) return undefined
  if (object.app !== 'dsh-plugin-desktop') return undefined
  for (const key of ['generatedAt', 'appVersion', 'platform', 'arch', 'nodeVersion'] as const) {
    if (typeof object[key] !== 'string') return undefined
  }
  const signature = object.signature
  if (signature !== null
    && (signature === undefined
      || typeof signature !== 'object'
      || Array.isArray(signature)
      || (signature as Record<string, unknown>).algorithm !== 'ed25519'
      || typeof (signature as Record<string, unknown>).keyId !== 'string'
      || typeof (signature as Record<string, unknown>).publicKey !== 'string'
      || typeof (signature as Record<string, unknown>).value !== 'string')) {
    return undefined
  }
  const unsigned = object.unsigned
  if (unsigned !== null
    && (unsigned === undefined
      || typeof unsigned !== 'object'
      || Array.isArray(unsigned)
      || typeof (unsigned as Record<string, unknown>).reason !== 'string')) {
    return undefined
  }
  if ((signature === null) === (unsigned === null)) return undefined
  return value as DesktopSelfCheckReport
}

/**
 * Verify one self-check report against its embedded signature. Without
 * `trustedViewKeys` the check proves integrity under whatever key the report
 * carries — binding that key to the company is the administrator's manual
 * fingerprint comparison (or `trustedViewKeys`, which the verify script
 * exposes as `--fingerprint`/`--key-id` pinning). Business failures are
 * result values; only invalid call arguments throw.
 */
export function verifyDesktopSelfCheckReport(
  report: unknown,
  options: { readonly trustedViewKeys?: readonly DiagnosticsViewKey[] } = {},
): DesktopSelfCheckVerification {
  const parsed = parseDesktopSelfCheckReport(report)
  if (parsed === undefined) {
    return { ok: false, code: 'invalid-report', reason: 'the value is not a dsh-plugin-desktop self-check report' }
  }
  const signature = parsed.signature
  if (signature === null) {
    return {
      ok: false,
      code: 'unsigned',
      reason: parsed.unsigned?.reason ?? 'the report carries no signature',
    }
  }
  const trusted = options.trustedViewKeys === undefined
    ? []
    : normalizeDiagnosticsViewKeys(options.trustedViewKeys)
  if (trusted.length > 0 && !trusted.some(entry => entry.keyId === signature.keyId)) {
    return { ok: false, code: 'unknown-key', reason: `diagnostics keyId ${signature.keyId} is not in the trusted view keys` }
  }
  if (!BASE64_PATTERN.test(signature.publicKey)
    || Buffer.from(signature.publicKey, 'base64').byteLength !== DIAGNOSTICS_PUBLIC_KEY_BYTES) {
    return { ok: false, code: 'invalid-public-key', reason: 'the diagnostics signing key is not a raw 32-byte ed25519 public key' }
  }
  const rawKey = Buffer.from(signature.publicKey, 'base64')
  const fingerprint = ed25519PublicKeyFingerprint(new Uint8Array(rawKey))
  const pinned = trusted.find(entry => entry.keyId === signature.keyId)
  if (pinned !== undefined && diagnosticsViewKeyFingerprint(pinned.publicKey) !== fingerprint) {
    return { ok: false, code: 'key-mismatch', reason: `the diagnostics signing key fingerprint does not match the pinned fingerprint for keyId ${signature.keyId}` }
  }
  if (!BASE64_PATTERN.test(signature.value)
    || Buffer.from(signature.value, 'base64').byteLength !== DIAGNOSTICS_SIGNATURE_BYTES) {
    return { ok: false, code: 'invalid-signature-encoding', reason: 'the detached ed25519 signature is not 64 bytes' }
  }
  const publicKey = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: rawKey.toString('base64url') },
    format: 'jwk',
  })
  const windowBytes = Buffer.from(canonicalDesktopSelfCheckReportWindow(parsed), 'utf8')
  // node:crypto requires a null algorithm for Ed25519; the key carries the designation.
  const verified = cryptoVerify(null, windowBytes, publicKey, Buffer.from(signature.value, 'base64'))
  if (!verified) {
    return { ok: false, code: 'bad-signature', reason: 'ed25519 signature verification failed' }
  }
  return { ok: true, keyId: signature.keyId, fingerprint }
}

/** One persisted boot decision plus the moment it was recorded. */
export interface DesktopBootVerificationSnapshot {
  readonly recordedAt: string
  /** The locked-boot decision; null records an unlocked boot without one. */
  readonly bootVerification: DesktopBootVerification | null
}

/** Path of the boot-verification snapshot inside one Electron user-data directory. */
export function desktopBootVerificationSnapshotPath(userDataDir: string): string {
  return join(userDataDir, 'boot-verification.json')
}

function isDesktopBootVerification(value: unknown): value is DesktopBootVerification {
  if (value === null || typeof value !== 'object') return false
  const object = value as Record<string, unknown>
  if (typeof object.manifestTrusted !== 'boolean') return false
  // JSON.stringify drops `undefined` members, so absent keys are the written
  // form of the optional fields; anything else must match the strict shape.
  const manifestSequence = object.manifestSequence
  if (manifestSequence !== undefined
    && (typeof manifestSequence !== 'number'
      || !Number.isSafeInteger(manifestSequence)
      || manifestSequence < 1)) return false
  if (object.keyId !== undefined
    && (typeof object.keyId !== 'string' || object.keyId.length === 0)) return false
  const manifestFailure = object.manifestFailure
  if (manifestFailure !== undefined
    && (manifestFailure === null
      || typeof manifestFailure !== 'object'
      || Array.isArray(manifestFailure)
      || typeof (manifestFailure as Record<string, unknown>).code !== 'string'
      || typeof (manifestFailure as Record<string, unknown>).reason !== 'string')) {
    return false
  }
  for (const list of [object.allowed, object.rejected]) {
    if (!Array.isArray(list)) return false
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') return false
      const bundle = entry as Record<string, unknown>
      if (typeof bundle.packageName !== 'string' || bundle.packageName.length === 0) return false
      if (list === object.allowed) {
        if (bundle.evidence !== 'receipt' && bundle.evidence !== 'manifest-only' && bundle.evidence !== 'signed-tree') return false
        const sequence: unknown = bundle.manifestSequence
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return false
        if (typeof bundle.keyId !== 'string' || bundle.keyId.length === 0) return false
      } else if (typeof bundle.reason !== 'string') {
        return false
      }
    }
  }
  return true
}

/**
 * Persist one boot decision as the export snapshot. The snapshot is local
 * evidence for the next diagnostics export, so this never throws: any
 * failure returns false and the startup that owns the write keeps going.
 * Unlocked boots record `null`, which overwrites and thereby invalidates any
 * stale locked record from an earlier boot.
 */
export function writeDesktopBootVerificationSnapshot(
  userDataDir: string,
  bootVerification: DesktopBootVerification | undefined,
  now: () => Date = () => new Date(),
): boolean {
  try {
    const path = desktopBootVerificationSnapshotPath(userDataDir)
    const document = {
      recordedAt: now().toISOString(),
      bootVerification: bootVerification ?? null,
    }
    const text = JSON.stringify(document)
    if (text.length > MAX_BOOT_SNAPSHOT_BYTES) return false
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${text}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Read one boot-verification snapshot. The file lives in user-writable user
 * data, so anything but a small, well-formed document yields undefined; the
 * caller then reports an unavailable boot section instead of trusting it.
 * Never throws.
 */
export function readDesktopBootVerificationSnapshot(path: string): DesktopBootVerificationSnapshot | undefined {
  try {
    const body = readFileSync(path)
    if (body.byteLength === 0 || body.byteLength > MAX_BOOT_SNAPSHOT_BYTES) return undefined
    const parsed: unknown = JSON.parse(body.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const object = parsed as Record<string, unknown>
    const keys = Object.keys(object).sort()
    if (keys.length !== 2 || keys[0] !== 'bootVerification' || keys[1] !== 'recordedAt') return undefined
    if (typeof object.recordedAt !== 'string' || object.recordedAt.length === 0) return undefined
    if (object.bootVerification !== null && !isDesktopBootVerification(object.bootVerification)) return undefined
    return {
      recordedAt: object.recordedAt,
      bootVerification: object.bootVerification as DesktopBootVerification | null,
    }
  } catch {
    return undefined
  }
}

/**
 * Measure the embedded policy asset: SHA-256 over its exact bytes plus the
 * strictly parsed `locked` flag and trust roots. Any read or parse failure —
 * a missing asset in an unpackaged checkout included — reports
 * `available: false` with the reason instead of throwing, because a
 * self-check observes; it must not fail the export.
 */
export function desktopPolicySelfCheckStatus(assetPath?: string): DesktopSelfCheckPolicyStatus {
  const unavailable = (reason: string): DesktopSelfCheckPolicyStatus => ({
    available: false,
    reason,
    locked: null,
    sha256: null,
    bytes: null,
    trustRoots: [],
  })
  let body: Buffer
  const path = assetPath ?? desktopPolicyAssetPath(import.meta.url)
  try {
    body = readFileSync(path)
  } catch (cause) {
    return unavailable(`the policy asset is unreadable at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (body.byteLength > desktopPolicyConstants.maxPolicyBytes) {
    return unavailable(`the policy asset exceeds ${String(desktopPolicyConstants.maxPolicyBytes)} bytes`)
  }
  let document: unknown
  try {
    document = JSON.parse(body.toString('utf8')) as unknown
  } catch (cause) {
    return unavailable(`the policy asset is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  try {
    const policy = parseDesktopPolicy(document)
    return {
      available: true,
      reason: null,
      locked: policy.locked,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.byteLength,
      trustRoots: policy.trustRoots,
    }
  } catch (cause) {
    return unavailable(`the policy asset failed strict parsing: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * Measure the bundled Node runtime this process would hand to children
 * (P3-1). An unpackaged run reports `development` (the environment Node
 * command applies, no digest manifest); a packaged run re-runs the packaged
 * digest-manifest verification and reports `verified` or `failed`.
 */
export function desktopNodeRuntimeSelfCheckStatus(moduleUrl: string = import.meta.url): DesktopSelfCheckNodeRuntimeStatus {
  if (!isPackagedModuleUrl(moduleUrl)) {
    return {
      status: 'development',
      detail: 'unpackaged run: child processes use the environment Node command, so no bundled digest manifest applies',
    }
  }
  try {
    resolveDesktopNodeExecutable(moduleUrl, { platform: process.platform })
    return { status: 'verified', detail: 'the bundled Node command matched its packaged sha256 digest manifest' }
  } catch (cause) {
    return { status: 'failed', detail: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Override seams of {@link assembleDesktopSelfCheckExport}. */
export interface DesktopSelfCheckAssemblyInputs {
  /** Policy asset path override; defaults to the asset beside this module. */
  readonly policyAssetPath?: string
  /** Boot snapshot path override; defaults to `<userDataDir>/boot-verification.json`. */
  readonly bootSnapshotPath?: string
  /** View keys override; defaults to the embedded {@link DIAGNOSTICS_SIGNING_PUBLIC_KEYS}. */
  readonly viewKeys?: readonly DiagnosticsViewKey[]
  /** Clock injection for the generation timestamp. */
  readonly now?: () => Date
}

/** Serialized self-check report ready for the diagnostics archive. */
export interface DesktopSelfCheckExportPayload {
  /** Canonical JSON text of the complete (signed or unsigned) report. */
  readonly reportText: string
  /** Whether `reportText` carries a signature. */
  readonly signed: boolean
}

/**
 * Assemble the self-check report for one diagnostics export: measure the
 * policy asset and Node runtime, read the latest boot-verification snapshot
 * from user data, and emit the canonical report. Every report is unsigned
 * (direction B): client-side signing is not a forge-resistant control, so
 * the recorded reason states the absence-is-the-signal model instead.
 */
export function assembleDesktopSelfCheckExport(
  userDataDir: string,
  appVersion: string,
  inputs: DesktopSelfCheckAssemblyInputs = {},
): DesktopSelfCheckExportPayload {
  const viewKeys = inputs.viewKeys ?? normalizeDiagnosticsViewKeys(DIAGNOSTICS_SIGNING_PUBLIC_KEYS)
  const report = buildDesktopSelfCheckReport({
    appVersion,
    policy: desktopPolicySelfCheckStatus(inputs.policyAssetPath),
    nodeRuntime: desktopNodeRuntimeSelfCheckStatus(),
    bootSnapshot: readDesktopBootVerificationSnapshot(
      inputs.bootSnapshotPath ?? desktopBootVerificationSnapshotPath(userDataDir),
    ),
    viewKeys,
    ...(inputs.now === undefined ? {} : { now: inputs.now }),
  })
  return {
    reportText: desktopSelfCheckReportText(report), signed: report.signature !== null,
  }
}
