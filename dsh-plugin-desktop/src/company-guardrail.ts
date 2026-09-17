/**
 * Company guardrail security prompt (#046): the per-turn user-input
 * hardening template of the managed model gateway.
 *
 * The guardrail is a tripwire (detection/probabilistic), not a gate: it
 * prepends a fixed security-policy template to the LAST user message of
 * every managed-model chat-completions request (see `model-gateway.ts` for
 * the wire rewrite) so a hand-slip toward dangerous operations meets the
 * policy on every turn. It complements — never replaces — the deterministic
 * boot/install gates.
 *
 * The template text reaches this machine through exactly three layers,
 * strictest first, each split into the same stable/beta channels the
 * catalog manifest uses:
 *
 * 1. the signed sibling documents `security-prompt.json` (stable) and
 *    `security-prompt.beta.json` (beta), hosted beside the stable catalog
 *    manifest on the policy-pinned origin (same directory, URLs derived
 *    mechanically like the beta overlay's), verified with the same ed25519
 *    trust roots, canonical-JSON byte equality, and detached signature as
 *    the company manifest — but under their OWN minimal schema
 *    (`revision`/`template`/`expiresAt`), so publishing a template change
 *    needs no client release and, crucially, an OLD client is unaffected by
 *    construction: no code path in a build before this module fetched the
 *    files at all, where a new manifest key would have made every
 * field-unaware build reject the whole catalog manifest (catalog dark).
 *    The beta document is fetched ONLY on a boot whose beta catalog overlay
 *    applied (the same signed-roster decision, never a duplicated one), and
 *    a verified beta template wins over a verified stable one exactly like
 *    overlay entries win over stable entries;
 * 2. the last ACCEPTED document per channel, cached in user data (the same
 *    locked-atomic state discipline `desktop-market.ts` applies to its
 *    provider state) — a reboot without network keeps yesterday's verified
 *    template instead of falling to the factory default. The two channels
 *    ratchet INDEPENDENTLY: a machine moving from beta revision 5 back to
 *    stable revision 3 (roster removal, a beta fetch failure) must accept
 *    the lower stable revision, which a single global ratchet would refuse
 *    forever, so a verified document of EITHER channel is compared only
 *    against its own channel's cached revision;
 * 3. the embedded frozen default v1, the committed asset
 *    `assets/company-guardrail/prompt-template-v1.md` bundled into the
 *    package at build time (byte-frozen; the assembly FILLS the template's
 *    `{user_input_placeholder}` token with the user's original input).
 *    Every active template — verified document or embedded default —
 *    carries the token exactly once and not as its first byte (validated
 *    at the document verifier and the embedded loader), so the gateway's
 *    prefix-marker idempotence stays total.
 *
 * Resolution NEVER blocks boot: the sibling fetches ride the boot-time
 * catalog fetch concurrency block with their own bounded timeouts, and
 * every failure — transport, non-200, tamper, expiry, unknown key, or a
 * revision at or below that channel's cached one (replay/rollback) —
 * resolves to `undefined`, leaving the other channel, the cache, or the
 * embedded default active. The template text itself never appears in
 * diagnostics or telemetry: outcomes are reported as categories, channel
 * names, and revision numbers only.
 *
 * @module dsh-plugin-desktop/company-guardrail
 */

import { verify as cryptoVerify } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  canonicalJsonText,
  ed25519PublicKeyFingerprint,
  type CompanyManifestTrustRoot,
} from 'dsh-community-market'
import {
  ed25519PublicKeyFromRaw,
  isMarketDateTimeFormat,
} from './desktop-market.ts'
import type { DesktopPolicy } from './desktop-policy.ts'
import { fetchUpdateChannelBytes, type UpdateChannelRequest } from './update-manifest.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** File name of the signed stable-channel sibling document, hosted in the stable manifest's directory. */
export const COMPANY_SECURITY_PROMPT_FILENAME = 'security-prompt.json'
/** File name of the signed beta-channel sibling document, hosted beside the stable one. */
export const COMPANY_BETA_SECURITY_PROMPT_FILENAME = 'security-prompt.beta.json'
/** Default whole-request bound of one sibling-document fetch (the beta overlay's bound). */
export const COMPANY_SECURITY_PROMPT_FETCH_TIMEOUT_MS = 8_000
/** Default sibling-document body bound: one 8 KiB template plus JSON/signature overhead. */
export const COMPANY_SECURITY_PROMPT_MAX_BYTES = 64 * 1024
/** Template size ceiling (UTF-8 bytes) for both the document and the cached state. */
export const MAX_COMPANY_GUARDRAIL_TEMPLATE_BYTES = 8 * 1024
/** Highest revision a document may carry, mirroring the manifest sequence ceiling. */
const MAX_REVISION = 9_007_199_254_740_991

/** The user-input placeholder token every active template must carry (see the gateway's fill assembly). */
const GUARDRAIL_PLACEHOLDER_TOKEN = '{user_input_placeholder}'

/**
 * Assert a template is ASSEMBLABLE (#046 fill semantics): it must carry the
 * `{user_input_placeholder}` token EXACTLY ONCE and not as its first byte.
 * A token at index 0 would make the gateway's prefix-before-token marker
 * the empty string (`startsWith('')` always true) and silently disable the
 * rewrite; a second occurrence would ride along literally in the string
 * fill. A template failing this is a publish/packaging fault and is
 * refused at the layer that produced it (review #046 P2).
 * @param template - the candidate template text.
 * @param what - what the caller is validating, for the error message.
 * @throws describing the fault.
 */
function assertAssemblableGuardrailTemplate(template: string, what: string): void {
  const first = template.indexOf(GUARDRAIL_PLACEHOLDER_TOKEN)
  if (first <= 0) {
    throw new Error(
      `${what} must carry the ${GUARDRAIL_PLACEHOLDER_TOKEN} token exactly once, after its policy text (found at offset ${String(first)})`,
    )
  }
  if (template.indexOf(GUARDRAIL_PLACEHOLDER_TOKEN, first + GUARDRAIL_PLACEHOLDER_TOKEN.length) !== -1) {
    throw new Error(`${what} must carry the ${GUARDRAIL_PLACEHOLDER_TOKEN} token exactly once`)
  }
}

const STATE_VERSION = 1
const STATE_DIRECTORY_NAME = 'company-guardrail'
const STATE_FILENAME = 'state.json'
const STATE_DIRECTORY_MODE = 0o700
const STATE_FILE_MODE = 0o600
const MAX_STATE_BYTES = 64 * 1024

const DOCUMENT_KEYS = ['expiresAt', 'revision', 'signature', 'template'] as const
const SIGNATURE_KEYS = ['keyId', 'publicKey', 'value'] as const
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/u
const SIGNATURE_VALUE_PATTERN = /^[A-Za-z0-9+/]{86}==$/u

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const unknownFields = (value: Record<string, unknown>, allowed: readonly string[]): readonly string[] =>
  Object.keys(value).filter(key => !allowed.includes(key))

/** The guardrail document channels, mirroring the catalog manifest's. */
export type CompanyGuardrailChannel = 'stable' | 'beta'

/**
 * Derive the sibling document URL of one channel from the stable manifest
 * URL: the same directory, with the file name replaced by the channel's
 * document file name — the same mechanical derivation as the beta
 * overlay's, so the channels need no policy change and no client release,
 * and the deployment keeps pinning exactly one catalog origin.
 * @param companyManifestUrl - the policy's stable manifest URL (origin mode).
 * @param channel - which channel's document URL to derive.
 * @returns the sibling document URL on the same origin.
 * @throws when the stable URL is not a parseable absolute https URL.
 */
export function desktopSecurityPromptUrl(
  companyManifestUrl: string,
  channel: CompanyGuardrailChannel = 'stable',
): string {
  let url: URL
  try {
    url = new URL(companyManifestUrl)
  } catch {
    throw new TypeError(`${BIN_NAME}: the company manifest URL is not a valid URL`)
  }
  if (url.protocol !== 'https:') {
    throw new TypeError(`${BIN_NAME}: the company manifest URL must be https`)
  }
  const filename = channel === 'beta' ? COMPANY_BETA_SECURITY_PROMPT_FILENAME : COMPANY_SECURITY_PROMPT_FILENAME
  url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}${filename}`
  return url.href
}

/** A verified sibling document: the template, its revision, and expiry. */
export interface DesktopSecurityPromptDocument {
  /** Monotonic publication revision; strictly greater than the last accepted one advances. */
  readonly revision: number
  /** The guardrail template text (non-empty, at most 8 KiB). */
  readonly template: string
  /** RFC 3339 expiry timestamp of this publication. */
  readonly expiresAt: string
  readonly signature: {
    readonly keyId: string
    readonly publicKey: string
    readonly value: string
  }
}

/** Options of {@link verifyDesktopSecurityPromptDocument}. */
export interface DesktopSecurityPromptVerificationOptions {
  /** Policy-pinned signing keys; a document signed by any listed key verifies. */
  readonly trustRoots: readonly CompanyManifestTrustRoot[]
  /**
   * Anti-rollback floor: the revision of the last ACCEPTED document. A
   * revision at or below it is a replay or a rollback and refuses with
   * `stale-revision` — only a strictly greater revision may replace the
   * active template.
   */
  readonly lastAcceptedRevision?: number
  /** Clock deciding document expiry; defaults to `Date.now`. */
  readonly now?: () => number
}

/** Result of verifying sibling-document bytes end to end. */
export type DesktopSecurityPromptVerification =
  | {
    readonly ok: true
    readonly document: DesktopSecurityPromptDocument
    readonly keyId: string
    readonly fingerprint: string
    readonly verifiedAt: number
  }
  | {
    readonly ok: false
    readonly code:
      | 'malformed-json'
      | 'non-canonical'
      | 'invalid-document'
      | 'unknown-key'
      | 'key-mismatch'
      | 'bad-signature'
      | 'stale-revision'
      | 'expired'
    readonly reason: string
  }

/**
 * Validate one parsed document value against the minimal sibling schema.
 * Reasons name fields and shapes, never field VALUES — the template text
 * must not ride inside a diagnostic line.
 */
function parseDesktopSecurityPromptValue(value: unknown): DesktopSecurityPromptDocument {
  if (!isPlainObject(value)) throw new Error('the security prompt document must be a JSON object')
  const unknown = unknownFields(value, DOCUMENT_KEYS)
  if (unknown.length > 0) throw new Error(`the security prompt document has unknown field(s) ${unknown.join(', ')}`)
  for (const key of DOCUMENT_KEYS) {
    if (!(key in value)) throw new Error(`the security prompt document is missing ${key}`)
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || (value.revision as number) > MAX_REVISION) {
    throw new Error('the security prompt document revision must be a safe positive integer')
  }
  if (typeof value.template !== 'string' || value.template.length === 0
    || Buffer.byteLength(value.template, 'utf8') > MAX_COMPANY_GUARDRAIL_TEMPLATE_BYTES) {
    throw new Error(
      `the security prompt document template must be a non-empty string of at most ${String(MAX_COMPANY_GUARDRAIL_TEMPLATE_BYTES)} bytes`,
    )
  }
  assertAssemblableGuardrailTemplate(value.template, 'the security prompt document template')
  if (typeof value.expiresAt !== 'string' || value.expiresAt.length < 20 || value.expiresAt.length > 64
    || !isMarketDateTimeFormat(value.expiresAt)
    || Number.isNaN(Date.parse(value.expiresAt))) {
    throw new Error('the security prompt document expiresAt must be an RFC 3339 timestamp')
  }
  if (!isPlainObject(value.signature)) throw new Error('the security prompt document signature must be an object')
  {
    const signatureUnknown = unknownFields(value.signature, SIGNATURE_KEYS)
    if (signatureUnknown.length > 0) {
      throw new Error(`the security prompt document signature has unknown field(s) ${signatureUnknown.join(', ')}`)
    }
    for (const key of SIGNATURE_KEYS) {
      if (!(key in value.signature)) throw new Error(`the security prompt document signature is missing ${key}`)
    }
    if (typeof value.signature.keyId !== 'string' || !KEY_ID_PATTERN.test(value.signature.keyId)) {
      throw new Error('the security prompt document signature keyId is invalid')
    }
    if (typeof value.signature.publicKey !== 'string' || !PUBLIC_KEY_PATTERN.test(value.signature.publicKey)) {
      throw new Error('the security prompt document signature publicKey must be the base64 of a raw 32-byte ed25519 key')
    }
    if (typeof value.signature.value !== 'string' || !SIGNATURE_VALUE_PATTERN.test(value.signature.value)) {
      throw new Error('the security prompt document signature value must be the base64 of a 64-byte ed25519 signature')
    }
  }
  return Object.freeze({
    revision: value.revision as number,
    template: value.template,
    expiresAt: value.expiresAt,
    signature: Object.freeze({
      keyId: value.signature.keyId as string,
      publicKey: value.signature.publicKey as string,
      value: value.signature.value as string,
    }),
  })
}

/**
 * Verify sibling-document bytes end to end under the minimal own schema:
 * canonical JSON byte equality, the strict shape above (every unknown key
 * rejects the document), trust-root binding through the SAME ed25519
 * verification primitives as the company manifest (canonical text,
 * fingerprint, DER import, detached signature — imported from
 * `desktop-market.ts`, never forked), the strictly-greater anti-rollback
 * revision floor, and expiry. Mirrors `verifyDesktopCompanyManifest`'s
 * decision structure so the two verifiers stay recognizable twins.
 */
export function verifyDesktopSecurityPromptDocument(
  raw: string | Uint8Array,
  options: DesktopSecurityPromptVerificationOptions,
): DesktopSecurityPromptVerification {
  if (options === null || typeof options !== 'object' || !Array.isArray(options.trustRoots)) {
    throw new TypeError(`${BIN_NAME}: security prompt document verification requires trust roots`)
  }
  const lastAcceptedRevision = options.lastAcceptedRevision ?? 0
  if (!Number.isSafeInteger(lastAcceptedRevision) || lastAcceptedRevision < 0) {
    throw new TypeError(`${BIN_NAME}: lastAcceptedRevision must be a safe non-negative integer`)
  }
  const now = options.now ?? Date.now
  const verifiedAt = now()
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt)) {
    throw new TypeError(`${BIN_NAME}: now must return a finite epoch millisecond timestamp`)
  }
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, code: 'malformed-json', reason: 'security prompt document is not valid JSON' }
  }
  let canonical: string
  try {
    canonical = canonicalJsonText(parsed)
  } catch (cause) {
    return { ok: false, code: 'non-canonical', reason: cause instanceof Error ? cause.message : String(cause) }
  }
  if (canonical !== text) {
    return {
      ok: false,
      code: 'non-canonical',
      reason: 'security prompt document bytes are not the canonical JSON serialization of their parsed value',
    }
  }
  let document: DesktopSecurityPromptDocument
  try {
    document = parseDesktopSecurityPromptValue(parsed)
  } catch (cause) {
    return { ok: false, code: 'invalid-document', reason: cause instanceof Error ? cause.message : String(cause) }
  }
  const root = options.trustRoots.find(candidate => candidate.keyId === document.signature.keyId)
  if (root === undefined) {
    return { ok: false, code: 'unknown-key', reason: `document keyId ${document.signature.keyId} is not in the trusted roots` }
  }
  const rawKey = Buffer.from(document.signature.publicKey, 'base64')
  if (rawKey.byteLength !== 32) {
    return { ok: false, code: 'key-mismatch', reason: 'the document signing key is not a raw 32-byte ed25519 public key' }
  }
  const fingerprint = ed25519PublicKeyFingerprint(rawKey)
  if (fingerprint !== root.fingerprint) {
    return {
      ok: false,
      code: 'key-mismatch',
      reason: `document signing key fingerprint does not match the pinned fingerprint for keyId ${root.keyId}`,
    }
  }
  const unsigned = { ...(parsed as Record<string, unknown>) }
  delete unsigned.signature
  const signedBytes = Buffer.from(canonicalJsonText(unsigned), 'utf8')
  const signatureBytes = Buffer.from(document.signature.value, 'base64')
  if (signatureBytes.byteLength !== 64) {
    return { ok: false, code: 'bad-signature', reason: 'the detached ed25519 signature is not 64 bytes' }
  }
  let signatureOk: boolean
  try {
    signatureOk = cryptoVerify(null, signedBytes, ed25519PublicKeyFromRaw(rawKey), signatureBytes)
  } catch {
    return { ok: false, code: 'bad-signature', reason: 'ed25519 signature verification failed' }
  }
  if (!signatureOk) {
    return { ok: false, code: 'bad-signature', reason: 'ed25519 signature verification failed' }
  }
  if (document.revision < lastAcceptedRevision) {
    return {
      ok: false,
      code: 'stale-revision',
      reason: `document revision ${String(document.revision)} is below the last accepted revision ${String(lastAcceptedRevision)}`,
    }
  }
  const expiresAtMs = Date.parse(document.expiresAt)
  if (verifiedAt >= expiresAtMs) {
    return { ok: false, code: 'expired', reason: `security prompt document expired at ${document.expiresAt}` }
  }
  return { ok: true, document, keyId: root.keyId, fingerprint, verifiedAt }
}

/**
 * The last accepted document of one channel as persisted in user data: the
 * revision that channel's anti-rollback ratchet pins and the template text
 * it published, both under the document schema's own bounds.
 */
export interface CompanyGuardrailCachedPrompt {
  readonly revision: number
  readonly template: string
}

/** Per-channel last-accepted documents as persisted in user data. */
export interface CompanyGuardrailCachedChannels {
  readonly stable?: CompanyGuardrailCachedPrompt
  readonly beta?: CompanyGuardrailCachedPrompt
}

/** Persisted strict version-one cache document (independent per-channel ratchets). */
export interface CompanyGuardrailCacheStateV1 {
  readonly version: 1
  readonly stable?: CompanyGuardrailCachedPrompt
  readonly beta?: CompanyGuardrailCachedPrompt
}

/** Validate a user-data directory and return its fixed cache state path. */
export function companyGuardrailStatePath(userDataDir: string): string {
  if (typeof userDataDir !== 'string' || !isAbsolute(userDataDir)
    || userDataDir.includes('\0') || userDataDir.length === 0) {
    throw new TypeError(`${BIN_NAME}: company guardrail user-data directory must be an absolute path without NUL`)
  }
  return join(userDataDir, STATE_DIRECTORY_NAME, STATE_FILENAME)
}

/** Validate an exact cache state path before reading or writing it. */
export function assertCompanyGuardrailStatePath(statePath: string): void {
  if (typeof statePath !== 'string' || !isAbsolute(statePath)
    || statePath.includes('\0') || basename(statePath) !== STATE_FILENAME
    || basename(dirname(statePath)) !== STATE_DIRECTORY_NAME) {
    throw new TypeError(`${BIN_NAME}: company guardrail state path must be <userData>/${STATE_DIRECTORY_NAME}/${STATE_FILENAME}`)
  }
}

function invalidState(message: string): Error {
  return new Error(`${BIN_NAME}: invalid company guardrail state: ${message}`)
}

/** Parse one channel entry: exactly revision + template, both bounded. */
function parseCachedChannel(value: unknown, channel: CompanyGuardrailChannel): CompanyGuardrailCachedPrompt {
  if (!isPlainObject(value)) throw invalidState(`${channel} must be an object`)
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'revision' || keys[1] !== 'template') {
    throw invalidState(`${channel} must carry exactly revision and template`)
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || (value.revision as number) > MAX_REVISION) {
    throw invalidState(`${channel}.revision must be a safe positive integer`)
  }
  if (typeof value.template !== 'string' || value.template.length === 0
    || Buffer.byteLength(value.template, 'utf8') > MAX_COMPANY_GUARDRAIL_TEMPLATE_BYTES) {
    throw invalidState(
      `${channel}.template must be a non-empty string of at most ${String(MAX_COMPANY_GUARDRAIL_TEMPLATE_BYTES)} bytes`,
    )
  }
  try {
    assertAssemblableGuardrailTemplate(value.template, `${channel}.template`)
  } catch (cause) {
    throw invalidState(cause instanceof Error ? cause.message : String(cause))
  }
  return Object.freeze({ revision: value.revision as number, template: value.template })
}

/**
 * Parse the strict version-one persisted cache document. The two channels
 * ratchet independently, so each is validated alone: a malformed beta entry
 * never invalidates a well-formed stable entry's parse — but the state
 * document is small and written atomically, so any malformed entry still
 * rejects the whole parse (fail-safe to empty, never to a half-read).
 */
export function parseCompanyGuardrailCacheState(value: unknown): CompanyGuardrailCacheStateV1 {
  if (!isPlainObject(value)) throw invalidState('root must be an object')
  const keys = Object.keys(value).sort()
  if (keys.some(key => key !== 'beta' && key !== 'stable' && key !== 'version')) {
    throw invalidState('unexpected fields')
  }
  if (value.version !== STATE_VERSION) throw invalidState('unsupported version')
  if (value.stable === undefined && value.beta === undefined) throw invalidState('at least one channel is required')
  return Object.freeze({
    version: STATE_VERSION,
    ...(value.stable === undefined ? {} : { stable: parseCachedChannel(value.stable, 'stable') }),
    ...(value.beta === undefined ? {} : { beta: parseCachedChannel(value.beta, 'beta') }),
  })
}

/**
 * Read the per-channel last accepted documents from user data. Never
 * throws: a missing, corrupted, non-regular, or oversized cache fails safe
 * to `undefined` and the resolution falls through to the embedded default —
 * a tampered cache can only ever REMOVE a layer, never bypass one (the wire
 * rewrite uses whatever template resolves, and a forged template would
 * first have to pass the signed-document verification that alone raises a
 * ratchet).
 */
export function readCompanyGuardrailChannels(statePath: string): CompanyGuardrailCachedChannels | undefined {
  try {
    assertCompanyGuardrailStatePath(statePath)
    const pathInfo = lstatSync(statePath)
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return undefined
    const descriptor = openSync(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = fstatSync(descriptor)
      if (!info.isFile() || info.size > MAX_STATE_BYTES) return undefined
      const state = parseCompanyGuardrailCacheState(JSON.parse(readFileSync(descriptor, 'utf8')) as unknown)
      // The persisted `version` is a parse concern; callers see the channels.
      return Object.freeze({
        ...(state.stable === undefined ? {} : { stable: state.stable }),
        ...(state.beta === undefined ? {} : { beta: state.beta }),
      })
    } finally {
      closeSync(descriptor)
    }
  } catch {
    return undefined
  }
}

function assertRealStateDirectory(statePath: string): void {
  const directory = dirname(statePath)
  try {
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${BIN_NAME}: company guardrail state directory must be a real directory`)
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(directory, { recursive: true, mode: STATE_DIRECTORY_MODE })
      return
    }
    throw cause
  }
}

/**
 * Persist one channel's last accepted document with the same locked, atomic
 * replacement the Desktop Market provider state uses. The write is a
 * read-merge-write UNDER THE FILE LOCK: only the named channel's entry is
 * replaced, and the other channel's ratchet survives untouched — the two
 * channels advance on independent publication schedules, so clobbering one
 * with the other's write would silently reset its anti-rollback floor. An
 * unreadable or malformed existing document starts a fresh one. The cache
 * is an availability layer, not an authority: a failed write keeps the
 * in-memory template active and the next accepted document simply
 * overwrites the stale file.
 */
export async function writeCompanyGuardrailChannel(
  statePath: string,
  channel: CompanyGuardrailChannel,
  accepted: CompanyGuardrailCachedPrompt,
): Promise<void> {
  assertCompanyGuardrailStatePath(statePath)
  const entry = parseCachedChannel({ ...accepted }, channel)
  // The directory must exist before the lock file is created beside the
  // state file — the same before-and-inside-the-lock discipline the Desktop
  // Market provider state write uses.
  assertRealStateDirectory(statePath)
  await withFileLock(statePath, async () => {
    assertRealStateDirectory(statePath)
    const existing = readCompanyGuardrailChannels(statePath)
    const state: CompanyGuardrailCacheStateV1 = Object.freeze({
      version: STATE_VERSION,
      ...(channel === 'stable'
        ? { stable: entry, ...(existing?.beta === undefined ? {} : { beta: existing.beta }) }
        : { ...(existing?.stable === undefined ? {} : { stable: existing.stable }), beta: entry }),
    })
    await writeFileAtomic(statePath, `${JSON.stringify(state)}\n`, {
      mode: STATE_FILE_MODE,
      dirMode: STATE_DIRECTORY_MODE,
    })
  })
}

// ---------------------------------------------------------------------------
// Embedded frozen default (layer 3).
// ---------------------------------------------------------------------------

/** Package-relative directory of the frozen template asset, as bundled into `lib/`. */
export const COMPANY_GUARDRAIL_TEMPLATE_ASSET_DIRECTORY = 'company-guardrail'
/** File name of the frozen v1 template asset. */
export const COMPANY_GUARDRAIL_TEMPLATE_ASSET_FILENAME = 'prompt-template-v1.md'

/**
 * The candidate absolute paths of the embedded frozen template for one
 * module URL, in order: the bundled location beside the built module
 * (`lib/company-guardrail/prompt-template-v1.md`, written by
 * `scripts/embed-company-guardrail.mjs` and shipped by the package `files`
 * globs), then the repository source tree (`<package>/assets/company-guardrail/…`)
 * that source-run tests and `yarn dev` resolve against. Both spellings are
 * the same frozen bytes; the first is the packaged app's only candidate.
 */
export function companyGuardrailTemplateAssetCandidates(moduleUrl: string): readonly string[] {
  if (typeof moduleUrl !== 'string' || moduleUrl.length === 0) {
    throw new TypeError(`${BIN_NAME}: the guardrail template module URL must be a non-empty file URL`)
  }
  const moduleDirectory = dirname(fileURLToPath(new URL(moduleUrl)))
  return [
    join(moduleDirectory, COMPANY_GUARDRAIL_TEMPLATE_ASSET_DIRECTORY, COMPANY_GUARDRAIL_TEMPLATE_ASSET_FILENAME),
    join(moduleDirectory, '..', 'assets', COMPANY_GUARDRAIL_TEMPLATE_ASSET_DIRECTORY, COMPANY_GUARDRAIL_TEMPLATE_ASSET_FILENAME),
  ]
}

/**
 * Read the embedded frozen default template. The asset is byte-frozen
 * (issue #046): this function returns the exact committed file bytes, and
 * the tests pin that byte identity against `assets/company-guardrail/…`.
 * @param moduleUrl - module URL to resolve against; defaults to this module.
 * @returns the frozen template bytes as UTF-8 text.
 * @throws listing the candidate paths when no candidate exists — the build
 * bundles the asset, so its absence is a packaging defect a managed build
 * surfaces while staying bootable (the guardrail stays inert).
 */
export function readEmbeddedCompanyGuardrailTemplate(moduleUrl: string = import.meta.url): string {
  const candidates = companyGuardrailTemplateAssetCandidates(moduleUrl)
  for (const candidate of candidates) {
    try {
      const text = readFileSync(candidate, 'utf8')
      if (text.length > 0) {
        // The same assemblability contract the document verifier enforces:
        // a malformed frozen asset is a packaging defect, surfaced loudly
        // (the caller keeps the guardrail inert, never broken).
        assertAssemblableGuardrailTemplate(text, 'the embedded guardrail template asset')
        return text
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`${BIN_NAME}: the embedded guardrail template asset was not found (tried ${candidates.join(', ')})`)
}

// ---------------------------------------------------------------------------
// Resolution and boot-time fetch (layers 1 and 2).
// ---------------------------------------------------------------------------

/** Which layer the active template came from. */
export type CompanyGuardrailTemplateSource = 'document' | 'cache' | 'embedded'

/** Decision of {@link companyGuardrailTemplateDecision}. */
export interface CompanyGuardrailTemplateDecision {
  /** The active template text, or undefined when every layer is empty (guardrail inert). */
  readonly template: string | undefined
  /** The layer the active template came from; `none` when no layer provided one. */
  readonly source: CompanyGuardrailTemplateSource | 'none'
  /** The channel the winning layer belongs to, when a channel won. */
  readonly channel?: CompanyGuardrailChannel
  /** The accepted document's revision when a document layer won (persistence hint). */
  readonly acceptedRevision?: number
}

/**
 * Apply the resolution order over the channels and layers:
 *
 *   verified beta document > verified stable document > cached beta >
 *   cached stable > embedded frozen default
 *
 * A verified document wins over its OWN channel's cache at an equal or
 * greater revision (equal = idempotent re-confirmation of the same signed
 * bytes — the verifier refuses strictly-lower revisions, mirroring the
 * manifest verifier's `<`-only floor); a document below its channel's
 * cache is ignored and falls through. Equal-acceptance is what keeps a
 * de-rostered machine's steady state on its verified stable document:
 * refusing the equal re-confirmation would flip the decision back to the
 * stale cached beta template on every later boot (review #046 P2). The
 * two channels' ratchets are INDEPENDENT, so a lower verified stable
 * revision still beats a higher cached beta revision (a machine leaving
 * the beta roster must be allowed to move back down to stable's number
 * instead of being pinned to the stale beta template forever). The
 * cached-beta-over-cached-stable order keeps a roster machine's steady
 * state on the beta template while offline: a cached template is always
 * one a signature previously accepted, so the guardrail never weakens
 * below a verified floor. Pure: callers own fetching, verification,
 * roster gating, and persistence.
 */
export function companyGuardrailTemplateDecision(inputs: {
  /** The VERIFIED beta document, fetched only on a boot whose beta catalog overlay applied. */
  readonly betaDocument?: { readonly revision: number, readonly template: string }
  /** The VERIFIED stable document, when the boot's stable fetch verified one. */
  readonly stableDocument?: { readonly revision: number, readonly template: string }
  /** The per-channel last accepted documents read from user data, when present. */
  readonly cached?: CompanyGuardrailCachedChannels
  /** The embedded frozen default template, when readable. */
  readonly embedded?: string
}): CompanyGuardrailTemplateDecision {
  const { betaDocument, stableDocument, cached, embedded } = inputs
  if (betaDocument !== undefined && (cached?.beta === undefined || betaDocument.revision >= cached.beta.revision)) {
    return { template: betaDocument.template, source: 'document', channel: 'beta', acceptedRevision: betaDocument.revision }
  }
  if (stableDocument !== undefined && (cached?.stable === undefined || stableDocument.revision >= cached.stable.revision)) {
    return { template: stableDocument.template, source: 'document', channel: 'stable', acceptedRevision: stableDocument.revision }
  }
  if (cached?.beta !== undefined) return { template: cached.beta.template, source: 'cache', channel: 'beta' }
  if (cached?.stable !== undefined) return { template: cached.stable.template, source: 'cache', channel: 'stable' }
  if (embedded !== undefined && embedded.length > 0) return { template: embedded, source: 'embedded' }
  return { template: undefined, source: 'none' }
}

/** Options of {@link resolveCompanySecurityPromptUpdate}. */
export interface DesktopSecurityPromptResolveOptions {
  /** Deployment policy: trust roots and the pinned stable manifest URL. */
  readonly policy: Pick<DesktopPolicy, 'companyManifestUrl' | 'trustRoots'>
  /** Which channel's document to fetch; defaults to `stable`. */
  readonly channel?: CompanyGuardrailChannel
  /** Fetch-compatible request boundary (the Electron composition injects `net.fetch`). */
  readonly request?: UpdateChannelRequest
  /** Revision of the last accepted document IN THIS CHANNEL; a non-advancing revision refuses. */
  readonly lastAcceptedRevision?: number
  /** Caller cancellation folded into the whole-request bound. */
  readonly signal?: AbortSignal
  /** Whole-request timeout; defaults to {@link COMPANY_SECURITY_PROMPT_FETCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Document body bound; defaults to {@link COMPANY_SECURITY_PROMPT_MAX_BYTES}. */
  readonly maxBytes?: number
  /** Clock deciding document expiry; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Diagnostic sink receiving at most one line per outcome — categories,
   * channel names, and revision numbers only, never the template text.
   */
  readonly log?: (message: string) => void
}

const defaultRequest: UpdateChannelRequest = (url, init) => globalThis.fetch(url, init)

/**
 * Fetch and verify one channel's signed sibling document. Every failure —
 * transport, non-200 (a 404 is the channel simply not being used yet),
 * corrupt or non-canonical bytes, an untrusted key, a bad signature, a
 * non-advancing revision, or expiry — resolves to `undefined`; the caller
 * keeps whatever the precedence chain below this channel holds, exactly
 * today's behavior. Never throws for business outcomes; caller cancellation
 * propagates like on every other fetch boundary. This resolution NEVER
 * blocks boot on its own — the boot path installs the cached or embedded
 * template first and adopts this result only when it later lands. The beta
 * channel's document is fetched ONLY by callers that already know the
 * beta catalog overlay applied (the roster decision lives in the overlay,
 * never here).
 */
export async function resolveCompanySecurityPromptUpdate(
  options: DesktopSecurityPromptResolveOptions,
): Promise<DesktopSecurityPromptDocument | undefined> {
  const channel = options.channel ?? 'stable'
  const url = desktopSecurityPromptUrl(options.policy.companyManifestUrl, channel)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? COMPANY_SECURITY_PROMPT_FETCH_TIMEOUT_MS)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let bytes: Buffer
  try {
    const result = await fetchUpdateChannelBytes({
      request: options.request ?? defaultRequest,
      url,
      label: `company guardrail security prompt document (${channel})`,
      maxBytes: options.maxBytes ?? COMPANY_SECURITY_PROMPT_MAX_BYTES,
      redirect: 'error',
      signal,
    })
    if (!result.ok) {
      options.log?.(`${BIN_NAME}: security prompt document ${channel} not fetched (${result.code}: ${result.reason})`)
      return undefined
    }
    bytes = result.bytes
  } catch (cause) {
    if (options.signal?.aborted === true) throw cause
    options.log?.(`${BIN_NAME}: security prompt document ${channel} not fetched (${cause instanceof Error ? cause.message : String(cause)})`)
    return undefined
  }
  const verification = verifyDesktopSecurityPromptDocument(bytes, {
    trustRoots: options.policy.trustRoots,
    ...(options.lastAcceptedRevision === undefined ? {} : { lastAcceptedRevision: options.lastAcceptedRevision }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (!verification.ok) {
    // Categories, channels, and revisions only: the reason strings are
    // field/shape names by construction, but slice defensively so a future
    // verifier edit can never leak template text into a log line either.
    options.log?.(`${BIN_NAME}: security prompt document ${channel} ignored (${verification.code}: ${verification.reason.slice(0, 200)})`)
    return undefined
  }
  options.log?.(`${BIN_NAME}: security prompt document ${channel} verified (revision ${String(verification.document.revision)})`)
  return verification.document
}

/**
 * Compose the beta-channel prompt-document prefetch from the boot's beta
 * catalog overlay promise (#046): the beta document is fetched on exactly
 * the boots whose beta overlay applied — one roster decision, reused, with
 * no duplicated testers-roster logic. An absent overlay promise (locked
 * boot without a beta channel, or an unlocked boot) composes to
 * `undefined`, and an overlay that resolves to `undefined` (fetch failed,
 * unverified, or the machine is not on the roster) makes NO beta-prompt
 * network request at all. Extracted from the main-process wiring so that
 * property is testable without an Electron boot (review #046 P3).
 */
export function guardrailBetaPrefetchFromOverlay<Overlay, Document>(
  overlayPromise: Promise<Overlay | undefined> | undefined,
  fetchBetaDocument: () => Promise<Document | undefined>,
): Promise<Document | undefined> | undefined {
  if (overlayPromise === undefined) return undefined
  return overlayPromise.then(overlay => (overlay === undefined ? undefined : fetchBetaDocument()))
}
