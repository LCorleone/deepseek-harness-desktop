/**
 * Low-frequency client event reporting to the company telemetry database.
 *
 * PRIVACY CONTRACT (extends the P5 model-usage posture, 2026-09-07): one row
 * per event carries ONLY categorical metadata — who (`user_email`, from the
 * authenticated SSO session or NULL), when, the event type, the client
 * version, and a small typed `detail` document (result codes, sequences,
 * package names, one-line failure categories). Conversation content, file
 * paths, workspace names, prompts, tokens, and roster contents never enter a
 * row, and the log surface of this module is event TYPE plus counters only —
 * `detail` content is never logged.
 *
 * Composition facts:
 *
 * - The destination is the SAME decoded DSN as the model usage reporter
 *   (`resolveUsageReportDbDsn`, blob plus unpackaged-only environment
 *   overrides) — no second DSN logic exists here. The MySQL CONNECTION is
 *   deliberately separate and structurally light: client events fire a
 *   handful of times per day (boot, login, install), so a dedicated lazily
 *   created connection keeps the usage reporter's flush/backoff state and
 *   its pooled writes isolated from event traffic, and each module degrades
 *   on its own.
 * - There is NO queue and NO retry: a failed write drops its row and counts
 *   it. Low frequency makes a bounded retry pointless — the next event
 *   retries the connection implicitly with a fresh attempt.
 * - Recording never blocks and never throws into a host flow (SSO failure ≠
 *   reporting failure ≠ boot crash). The write is fire-and-forget; the
 *   connection is created lazily on the FIRST event so the module stays off
 *   the startup network path until something actually happens.
 * - Credentials, log hygiene, and degradation mirror the model usage
 *   reporter: a `usageReport: false` policy keeps the collector completely
 *   unwired (no connection, no blob decode), an invalid destination keeps
 *   it offline with ONE sanitized log line, and errors pass through the
 *   usage reporter's sanitizer before any logger sees them.
 *
 * @module dsh-plugin-desktop/client-event-reporter
 */

import { readDesktopPolicy, type DesktopPolicy } from './desktop-policy.ts'
import { maskSecrets } from './mask-secrets.ts'
import {
  createMysql2WriteBoundary,
  modelUsageClientVersion,
  resolveUsageReportDbDsn,
  sanitizeUsageReportError,
  type ModelUsageConnection,
  type ModelUsageWriteBoundary,
  type UsageReportConnectionConfig,
  type UsageReportDbDsn,
} from './model-usage-reporter.ts'

// ---------------------------------------------------------------------------
// Event vocabulary and destination
// ---------------------------------------------------------------------------

/** The event types of this collector (the `event_type` column). */
export const CLIENT_EVENT_TYPES = Object.freeze({
  ssoLogin: 'sso_login',
  catalogRefresh: 'catalog_refresh',
  pluginInstall: 'plugin_install',
  bootVerify: 'boot_verify',
  disclaimer: 'disclaimer',
  pluginReset: 'plugin_reset',
} as const)

/** Target table (company MySQL, database `DSH_LOG`; DDL is owned upstream). */
export const CLIENT_EVENTS_TABLE = 'dsh_client_events'

/** Column order of the INSERT statement; values follow the same order. */
export const CLIENT_EVENT_COLUMNS: readonly string[] = Object.freeze([
  'event_type',
  'user_email',
  'client_version',
  'detail',
  'created_at',
])

/**
 * Render the single-row INSERT statement. No IGNORE and no idempotency key:
 * every event is a fresh occurrence (a boot, a login attempt, an install),
 * so duplicate rows mean duplicate real-world attempts — exactly what fleet
 * health wants to see.
 */
export function clientEventInsertSql(): string {
  const columns = CLIENT_EVENT_COLUMNS.map(column => `\`${column}\``).join(', ')
  const placeholders = `(${CLIENT_EVENT_COLUMNS.map(() => '?').join(', ')})`
  return `INSERT INTO \`${CLIENT_EVENTS_TABLE}\` (${columns}) VALUES ${placeholders}`
}

/** One telemetry row: identity, version, a JSON detail document, and time. */
export interface ClientEventRow {
  readonly eventType: string
  readonly userEmail: string | null
  readonly clientVersion: string | null
  /**
   * JSON column payload: a plain JSON document of categorical metadata only
   * (see the module privacy contract). Serialized on the write path and
   * never logged.
   */
  readonly detail: object
  readonly createdAt: Date
}

/** Serialize the detail document and flatten the row in column order. */
export function clientEventRowValues(row: ClientEventRow): unknown[] {
  return [
    row.eventType,
    // VARCHAR(320) — a longer identity (never legitimate) truncates instead of
    // silently dropping the whole row under a strict-mode INSERT.
    row.userEmail === null ? null : row.userEmail.slice(0, 320),
    row.clientVersion,
    JSON.stringify(row.detail),
    row.createdAt,
  ]
}

// ---------------------------------------------------------------------------
// Typed detail documents (one per event type)
// ---------------------------------------------------------------------------

/** `sso_login`: which path authenticated and whether it produced a session. */
export interface SsoLoginEventDetail {
  readonly result: 'success' | 'failure'
  /** Failure one-liner in the existing silent/browser reason vocabulary. */
  readonly reason?: string
  readonly mode: 'silent' | 'browser'
}

/**
 * `catalog_refresh`: every outcome of one catalog channel resolution. The
 * union spans both channels — the stable manifest's verification failure
 * codes and the beta overlay's ignored reasons — so every outcome category
 * of both paths is reportable.
 */
export type CatalogRefreshEventOutcome =
  | 'applied'
  // Beta overlay ignored reasons (beta-channel.ts).
  | 'fetch-failed'
  | 'unverified'
  | 'stale-sequence'
  | 'no-sso-identity'
  | 'not-a-tester'
  // Stable manifest failures (boot-verification.ts: 'manifest-missing' plus
  // the company manifest verification codes).
  | 'manifest-missing'
  | 'malformed-json'
  | 'non-canonical'
  | 'invalid-manifest'
  | 'unknown-key'
  | 'key-mismatch'
  | 'bad-signature'
  | 'expired'

/** `catalog_refresh` detail. */
export interface CatalogRefreshEventDetail {
  readonly outcome: CatalogRefreshEventOutcome
  /** Sequence of the verified manifest; present on `applied` outcomes. */
  readonly sequence?: number
  /** Entries of the verified manifest; present on `applied` outcomes. */
  readonly entries?: number
  readonly channel: 'stable' | 'beta-overlay'
}

/** One refused bundle of a `boot_verify` event. */
export interface BootVerifyRejectedEntry {
  readonly packageName: string
  readonly code: string
}

/** `boot_verify` detail: one row per boot, only when something was refused. */
export interface BootVerifyEventDetail {
  readonly rejected: readonly BootVerifyRejectedEntry[]
  /** Bundles cleared to load on the same boot. */
  readonly loaded: number
}

/** `plugin_install`: what happened to one market install attempt. */
export interface PluginInstallEventDetail {
  readonly packageName: string
  readonly version: string
  /** Which catalog channel delivered the installed version; absent for
   * uninstalls (the removed version's delivery channel is not knowable from
   * the boot-time overlay set — guessing would pollute churn analytics). */
  readonly channel?: 'stable' | 'beta'
  readonly outcome: 'installed' | 'updated-in-place' | 'uninstalled' | 'rolled-back' | 'failed'
  /** Bounded failure category (the market's install error code vocabulary). */
  readonly reasonCode?: string
  /** Optional one-line bounded failure reason; never free stderr text. */
  readonly reason?: string
}

/** Version facts the disclaimer decision is about (the desktop's own state). */
export interface DisclaimerEventView {
  readonly clientVersion: string
  readonly textHash: string
}

/** `disclaimer`: the user's decision on the per-version beta disclaimer
 * prompt (one row only when the prompt actually appeared — quiet boots
 * stay silent, the boot_verify discipline). */
export interface DisclaimerEventDetail {
  readonly decision: 'agree' | 'disagree'
  /** Client version the decision acknowledged (matches the ack record). */
  readonly clientVersion: string
  /** sha256 of the acknowledged statement text (disclaimer-text.ts). */
  readonly textHash: string
}

/** Swap facts of one rebuild; the desktop call site adds the outcome. */
export interface PluginResetSwapView {
  readonly profileName: string
  /**
   * `swapped` landed, `failed` broke before/after the set-aside, and
   * `deferred` means Windows kept the Profile directory locked through every
   * rename retry — the existing Profile keeps booting and the next startup
   * retries the swap.
   */
  readonly outcome: 'swapped' | 'failed' | 'deferred'
  readonly materialized: boolean
  /** Market install receipts dropped by the ledger clear. */
  readonly receiptsCleared: number
  /**
   * Which automatic rule fired: `forced` = `pluginResetOnVersionChange` on
   * (any build identity change), `version` = the switch off (product-version
   * change only). Omitted for the recovery window's manual action.
   */
  readonly rule?: 'forced' | 'version'
}

/** `plugin_reset`: one fresh-Profile rebuild (P14) — the automatic
 * version-change reset or the recovery window's manual action. The row says
 * which trigger fired and whether the rebuild landed; `client_version`
 * already carries the build identity the reset happened on. */
export interface PluginResetEventDetail {
  readonly trigger: 'version-change' | 'recovery-window'
  readonly profileName: string
  readonly outcome: 'swapped' | 'failed' | 'deferred'
  readonly materialized: boolean
  readonly receiptsCleared: number
  /** Which automatic rule fired; omitted for the manual recovery-window action. */
  readonly rule?: 'forced' | 'version'
}

// ---------------------------------------------------------------------------
// Fire-and-forget reporter (single row, drop on failure)
// ---------------------------------------------------------------------------

/** One MySQL connection (the mysql2/promise surface the sink uses). */
export type ClientEventConnection = ModelUsageConnection

/** Injected mysql2 seam; tests substitute a recorder. */
export type ClientEventWriteBoundary = ModelUsageWriteBoundary

/** Connection options the sink hands to the boundary. */
export type ClientEventConnectionConfig = UsageReportConnectionConfig

/** Decoded report-database destination; the password never enters a log. */
export type ClientEventDbDsn = UsageReportDbDsn

/** Boundary factory — the model usage reporter's lazy mysql2 seam, reused. */
export type ClientEventWriteBoundaryFactory = () => ClientEventWriteBoundary | Promise<ClientEventWriteBoundary>

/** mysql2 connection handshake deadline (same budget as the usage reporter). */
export const CLIENT_EVENT_CONNECT_TIMEOUT_MS = 8_000

/** Counter-only status surface — the whole module's log vocabulary. */
export interface ClientEventReporterStats {
  readonly recorded: number
  readonly written: number
  readonly dropped: number
  readonly errors: number
  readonly connected: boolean
}

/** Reporter construction options; every dependency is injectable. */
export interface ClientEventReporterOptions {
  readonly logInfo?: ((message: string) => void) | undefined
  readonly logError?: ((message: string) => void) | undefined
}

/**
 * Single-row fire-and-forget MySQL sink.
 *
 * Writes are serialized through one trailing task so a burst never contends
 * on the shared connection; each row is attempted exactly once. A failed
 * write (including a failed connect) drops its row, drops the connection,
 * and logs ONE sanitized counter line — the next event starts a fresh
 * connection, which is the whole retry story at event frequency.
 */
export class ClientEventReporter {
  readonly #createBoundary: ClientEventWriteBoundaryFactory
  readonly #dsn: ClientEventDbDsn
  readonly #logInfo: (message: string) => void
  readonly #logError: (message: string) => void

  #recorded = 0
  #written = 0
  #dropped = 0
  #errors = 0
  #connection: ClientEventConnection | undefined
  #connectionTask: Promise<ClientEventConnection> | undefined
  #writeTask: Promise<void> = Promise.resolve()
  #disposed = false

  constructor(
    createBoundary: ClientEventWriteBoundaryFactory,
    dsn: ClientEventDbDsn,
    options: ClientEventReporterOptions = {},
  ) {
    this.#createBoundary = createBoundary
    this.#dsn = dsn
    this.#logInfo = options.logInfo ?? (() => {})
    this.#logError = options.logError ?? (() => {})
  }

  /** Counter-only status. */
  stats(): ClientEventReporterStats {
    return {
      recorded: this.#recorded,
      written: this.#written,
      dropped: this.#dropped,
      errors: this.#errors,
      connected: this.#connection !== undefined,
    }
  }

  /**
   * Record one event. Never throws, never blocks: the write runs on the
   * trailing task and every failure degrades to a drop with a counter.
   */
  record(row: ClientEventRow): void {
    if (this.#disposed) {
      this.#dropped += 1
      return
    }
    this.#recorded += 1
    this.#writeTask = this.#writeTask.then(() => this.#write(row))
  }

  /** End the connection; the in-flight write is awaited best-effort. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    try {
      await this.#writeTask
    } catch {
      // Unreachable: #write catches its own failures. Defensive only.
    }
    await this.#dropConnection()
  }

  async #write(row: ClientEventRow): Promise<void> {
    try {
      const connection = await this.#connectionRef()
      await connection.query(clientEventInsertSql(), clientEventRowValues(row))
    } catch (cause) {
      this.#dropped += 1
      this.#errors += 1
      await this.#dropConnection()
      // Counter line only: the event type and counts, never the detail.
      this.#logError(`dsh-plugin-desktop: client event write failed type=${row.eventType} written=${String(this.#written)} dropped=${String(this.#dropped)} errors=${String(this.#errors)} connection=failed: ${sanitizeUsageReportError(cause, this.#dsn)}`)
      return
    }
    this.#written += 1
    this.#logInfo(`dsh-plugin-desktop: client event recorded type=${row.eventType} written=${String(this.#written)} dropped=${String(this.#dropped)} errors=${String(this.#errors)}`)
  }

  async #connectionRef(): Promise<ClientEventConnection> {
    if (this.#connection !== undefined) return this.#connection
    if (this.#connectionTask === undefined) {
      this.#connectionTask = (async () => {
        const boundary = await this.#createBoundary()
        return await boundary.createConnection({
          host: this.#dsn.host,
          port: this.#dsn.port,
          user: this.#dsn.user,
          password: this.#dsn.password,
          database: this.#dsn.database,
          connectTimeout: CLIENT_EVENT_CONNECT_TIMEOUT_MS,
        })
      })()
    }
    try {
      this.#connection = await this.#connectionTask
    } catch (cause) {
      this.#connectionTask = undefined
      throw cause
    }
    return this.#connection
  }

  async #dropConnection(): Promise<void> {
    const connection = this.#connection
    this.#connection = undefined
    this.#connectionTask = undefined
    if (connection !== undefined) {
      try {
        await connection.end()
      } catch {
        // A broken connection's end failure is not actionable.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Detail projections (pure; the desktop hook sites call these)
// ---------------------------------------------------------------------------

/** Narrow stable-verification view that `DesktopBootVerification` satisfies. */
export interface StableCatalogVerificationView {
  readonly manifestTrusted: boolean
  readonly manifestSequence: number | undefined
  /** First manifest-level failure code; undefined after successful verify. */
  readonly manifestFailureCode: CatalogRefreshEventOutcome | undefined
}

/** Manifest text view accepting either wire form of the verified bytes. */
export type StableManifestText = string | Uint8Array | undefined

function manifestTextOf(manifest: StableManifestText): string | undefined {
  if (manifest === undefined) return undefined
  return typeof manifest === 'string' ? manifest : Buffer.from(manifest).toString('utf8')
}

/**
 * Count the entries of one verified stable manifest. The bytes were
 * already verified end to end by boot verification before this runs; an
 * unparseable or shapeless document contributes no count rather than a
 * guess.
 */
export function stableManifestEntryCount(manifestText: StableManifestText): number | undefined {
  const text = manifestTextOf(manifestText)
  if (text === undefined) return undefined
  try {
    const document = JSON.parse(text) as { packages?: unknown }
    return Array.isArray(document.packages) ? document.packages.length : undefined
  } catch {
    return undefined
  }
}

/**
 * Project one locked boot's stable catalog outcome into a `catalog_refresh`
 * detail: `applied` with sequence and entry count when the manifest
 * verified, the manifest failure code otherwise (a trusted manifest with no
 * recorded failure code cannot happen — fail-closed phrasing anyway).
 * Returns undefined for unlocked boots: no stable catalog exists to report.
 */
export function stableCatalogRefreshEvent(
  verification: StableCatalogVerificationView | undefined,
  manifestText: StableManifestText,
): CatalogRefreshEventDetail | undefined {
  if (verification === undefined) return undefined
  if (!verification.manifestTrusted) {
    return {
      outcome: verification.manifestFailureCode ?? 'manifest-missing',
      channel: 'stable',
    }
  }
  const entries = stableManifestEntryCount(manifestText)
  return {
    outcome: 'applied',
    ...(verification.manifestSequence === undefined ? {} : { sequence: verification.manifestSequence }),
    ...(entries === undefined ? {} : { entries }),
    channel: 'stable',
  }
}

/** Narrow beta-resolution view that `DesktopBetaChannelOutcome` satisfies. */
export type BetaCatalogOutcomeView =
  | { readonly outcome: 'applied'; readonly sequence: number; readonly entries: number }
  | { readonly outcome: 'fetch-failed' | 'unverified' | 'stale-sequence' | 'no-sso-identity' | 'not-a-tester' }

/** Project one beta overlay resolution outcome into a `catalog_refresh` detail. */
export function betaCatalogRefreshEvent(outcome: BetaCatalogOutcomeView): CatalogRefreshEventDetail {
  return outcome.outcome === 'applied'
    ? { outcome: 'applied', sequence: outcome.sequence, entries: outcome.entries, channel: 'beta-overlay' }
    : { outcome: outcome.outcome, channel: 'beta-overlay' }
}

/** Narrow boot-decision view that `DesktopBootVerification` satisfies. */
export interface BootVerificationView {
  readonly allowed: readonly unknown[]
  readonly rejected: readonly { readonly packageName: string; readonly code: string }[]
}

/**
 * Project one sso login attempt into an `sso_login` detail. The failure
 * reason is masked HERE (not at the call site) so the masking is a tested
 * property of the projection — a main.ts hook cannot silently drop it.
 */
export function ssoLoginEvent(
  result: 'success' | 'failure',
  mode: 'silent' | 'browser',
  reason?: string,
): SsoLoginEventDetail {
  const bounded = result === 'failure' ? boundedSsoReason(reason ?? '') : undefined
  return {
    result,
    mode,
    ...(bounded === undefined ? {} : { reason: bounded }),
  }
}

/** Mask + bound one sso failure reason (same vocabulary discipline as the
 * log line: masked secrets, no control characters, hard length bound). */
function boundedSsoReason(value: string): string | undefined {
  const flattened = maskSecrets(value).replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  return flattened.length === 0 ? undefined : flattened.slice(0, 240)
}

/**
 * Project one boot decision into a `boot_verify` detail — one row per boot,
 * emitted ONLY when at least one bundle was refused (success stays silent to
 * keep the low-frequency table low-frequency).
 */
export function bootVerifyEvent(
  verification: BootVerificationView | undefined,
): BootVerifyEventDetail | undefined {
  if (verification === undefined || verification.rejected.length === 0) return undefined
  return {
    rejected: verification.rejected.map(bundle => ({ packageName: bundle.packageName, code: bundle.code })),
    loaded: verification.allowed.length,
  }
}

/** Narrow install-event view that the market sink adapter satisfies. */
export interface MarketInstallEventView {
  readonly packageName: string
  readonly version: string
  readonly outcome: 'installed' | 'updated-in-place' | 'uninstalled' | 'rolled-back' | 'failed'
  /** Sequence of the signed manifest that allowed the install, when known. */
  readonly manifestSequence?: number | undefined
  /** Failure category (the market's install error code); present on failures. */
  readonly reasonCode?: string | undefined
  readonly reason?: string | undefined
}

/** Longest failure reason kept in a `plugin_install` detail. */
export const PLUGIN_INSTALL_REASON_LIMIT = 200

function boundedReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // Secret-shaped fragments never survive into a row even when a market
  // failure message inlined a stderr tail.
  const flattened = maskSecrets(value)
    // Path-shaped fragments (drive letters, POSIX homes, node_modules trees)
    // never enter the database either — the privacy line lists file paths.
    .replace(/(?:[A-Za-z]:\\|\\\\|\/home\/|\/Users\/|\/root\/|\S*[\/]node_modules[\/]?)\S*/gu, '‹path›')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  return flattened.length === 0 ? undefined : flattened.slice(0, PLUGIN_INSTALL_REASON_LIMIT)
}

/** Stable `name@version` pins of one verified manifest. */
function stableManifestPackages(manifestText: StableManifestText): ReadonlySet<string> | undefined {
  const text = manifestTextOf(manifestText)
  if (text === undefined) return undefined
  try {
    const document = JSON.parse(text) as { packages?: unknown }
    if (!Array.isArray(document.packages)) return undefined
    return new Set(document.packages.map(entry =>
      `${String((entry as { packageName?: unknown }).packageName)}@${String((entry as { version?: unknown }).version)}`))
  } catch {
    return undefined
  }
}

/**
 * The `name@version` keys a beta overlay delivers that the stable manifest
 * does not also pin — the exact set an install's channel attribution
 * consults. Both inputs are boot-time facts the desktop owns; `undefined`
 * (no overlay, or an overlay the stable manifest already fully covers) means
 * every install is attributed to the stable channel.
 */
export function betaDeliveredPackageKeys(
  overlayPackages: readonly { readonly packageName: string; readonly version: string }[] | undefined,
  stableManifestText: StableManifestText,
): ReadonlySet<string> | undefined {
  if (overlayPackages === undefined || overlayPackages.length === 0) return undefined
  const stable = stableManifestPackages(stableManifestText)
  const keys = new Set<string>()
  for (const entry of overlayPackages) {
    const key = `${entry.packageName}@${entry.version}`
    // An unresolvable stable document cannot prove a pin, so an overlay key
    // stands (the overlay itself was verified independently).
    if (stable === undefined || !stable.has(key)) keys.add(key)
  }
  return keys.size === 0 ? undefined : keys
}

/**
 * Project one market install event into a `plugin_install` detail. Channel
 * attribution is desktop knowledge: the market reports the facts it owns
 * (including the signed-manifest sequence that allowed the install), and
 * this side compares the installed `name@version` against the boot-time
 * beta-delivered set — an overlay pin the stable manifest also carries is a
 * stable publication (the post-promote steady state), so only beta-only
 * pins count as `beta`.
 */
export function pluginInstallEvent(
  event: MarketInstallEventView,
  betaDelivered: ReadonlySet<string> | undefined,
): PluginInstallEventDetail {
  if (event.outcome === 'uninstalled') {
    return { packageName: event.packageName, version: event.version, outcome: 'uninstalled' }
  }
  const channel = betaDelivered !== undefined
    && betaDelivered.has(`${event.packageName}@${event.version}`)
    ? 'beta'
    : 'stable'
  const reason = boundedReason(event.reason)
  return {
    packageName: event.packageName,
    version: event.version,
    channel,
    outcome: event.outcome,
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    ...(reason === undefined ? {} : { reason }),
  }
}

/**
 * Project one disclaimer gate decision into a `disclaimer` detail. The
 * detail carries the version and text hash the decision was about (the
 * same pair the ack record pins), so a fleet view can tell an install
 * consent from an update re-consent without joining on client_version.
 */
export function disclaimerEvent(
  decision: 'agree' | 'disagree',
  current: DisclaimerEventView,
): DisclaimerEventDetail {
  return { decision, clientVersion: current.clientVersion, textHash: current.textHash }
}

/**
 * Project one fresh-Profile rebuild into a `plugin_reset` detail. The trigger
 * distinguishes the automatic version-change layer from the recovery
 * window's manual action; `outcome: 'failed'` rows exist because a failed
 * rebuild degrades to the existing Profile (the boot continues) and is
 * otherwise invisible in the telemetry table.
 */
export function pluginResetEvent(
  trigger: 'version-change' | 'recovery-window',
  swap: PluginResetSwapView,
): PluginResetEventDetail {
  return {
    trigger,
    profileName: swap.profileName,
    outcome: swap.outcome,
    materialized: swap.materialized,
    receiptsCleared: Number.isSafeInteger(swap.receiptsCleared) && swap.receiptsCleared > 0
      ? swap.receiptsCleared
      : 0,
    ...(swap.rule === undefined ? {} : { rule: swap.rule }),
  }
}

// ---------------------------------------------------------------------------
// Collector (typed facade over the reporter) and desktop wiring
// ---------------------------------------------------------------------------

/** Per-row inputs the event facts cannot supply. */
export interface ClientEventAttribution {
  /** Authenticated SSO account email, or NULL — reporting never depends on SSO. */
  readonly userEmail: () => string | null
  /** Desktop product version stamped on every row. */
  readonly clientVersion: string
}

/**
 * Typed event facade: one method per event type, each stamping the event
 * name, attribution, and time, then handing the row to the reporter. Every
 * method is void and non-throwing by construction.
 */
export class ClientEventCollector {
  readonly #reporter: ClientEventReporter
  readonly #attribution: ClientEventAttribution
  readonly #now: () => number

  constructor(
    reporter: ClientEventReporter,
    attribution: ClientEventAttribution,
    options: { readonly now?: (() => number) | undefined } = {},
  ) {
    this.#reporter = reporter
    this.#attribution = attribution
    this.#now = options.now ?? (() => Date.now())
  }

  /** End the sink's connection (writes are fire-and-forget; nothing drains). */
  dispose(): Promise<void> {
    return this.#reporter.dispose()
  }

  ssoLogin(detail: SsoLoginEventDetail): void {
    this.#emit(CLIENT_EVENT_TYPES.ssoLogin, detail)
  }

  catalogRefresh(detail: CatalogRefreshEventDetail): void {
    this.#emit(CLIENT_EVENT_TYPES.catalogRefresh, detail)
  }

  pluginInstall(detail: PluginInstallEventDetail): void {
    this.#emit(CLIENT_EVENT_TYPES.pluginInstall, detail)
  }

  bootVerify(detail: BootVerifyEventDetail): void {
    this.#emit(CLIENT_EVENT_TYPES.bootVerify, detail)
  }

  disclaimer(detail: DisclaimerEventDetail): void {
    this.#emit(CLIENT_EVENT_TYPES.disclaimer, detail)
  }

  pluginReset(detail: PluginResetEventDetail): void {
    this.#emit(CLIENT_EVENT_TYPES.pluginReset, detail)
  }

  #emit<T extends object>(eventType: string, detail: T): void {
    this.#reporter.record({
      eventType,
      userEmail: this.#attribution.userEmail(),
      clientVersion: this.#attribution.clientVersion,
      detail,
      createdAt: new Date(this.#now()),
    })
  }
}

/** Factory options; tests substitute every injectable dependency. */
export interface ClientEventCollectorOptions {
  readonly policy?: DesktopPolicy | undefined
  readonly dsnBlob?: string | undefined
  readonly environment?: NodeJS.ProcessEnv | undefined
  readonly moduleUrl?: string | undefined
  readonly clientVersion?: string | undefined
  readonly userEmail?: (() => string | null) | undefined
  readonly createWriteBoundary?: ClientEventWriteBoundaryFactory | undefined
  readonly logInfo?: ((message: string) => void) | undefined
  readonly logError?: ((message: string) => void) | undefined
}

/**
 * Wire the collector, mirroring the model usage reporter's degradation: a
 * `usageReport: false` policy (the dev variant) and any destination
 * resolution failure keep the desktop completely offline — the hook sites
 * hold an `undefined` collector and telemetry must never fail the boot.
 */
export function createClientEventCollector(options: ClientEventCollectorOptions = {}): ClientEventCollector | undefined {
  const logError = options.logError ?? (() => {})

  let policy: DesktopPolicy
  try {
    policy = options.policy ?? readDesktopPolicy()
  } catch (cause) {
    logError(`dsh-plugin-desktop: client event reporting stays offline (unreadable policy): ${sanitizeUsageReportError(cause)}`)
    return undefined
  }
  if (policy.usageReport !== true) return undefined

  let dsn: ClientEventDbDsn
  try {
    dsn = resolveUsageReportDbDsn(
      options.dsnBlob,
      options.environment ?? process.env,
      options.moduleUrl ?? import.meta.url,
    )
  } catch (cause) {
    logError(`dsh-plugin-desktop: client event reporting stays offline (invalid destination): ${sanitizeUsageReportError(cause)}`)
    return undefined
  }

  let clientVersion: string
  try {
    clientVersion = options.clientVersion ?? modelUsageClientVersion(options.moduleUrl)
  } catch {
    // An unreadable package manifest must not lose the whole event stream;
    // the column carries the same empty-string stamp the usage reporter
    // uses for its non-null version column.
    clientVersion = ''
  }

  const reporter = new ClientEventReporter(
    options.createWriteBoundary ?? createMysql2WriteBoundary,
    dsn,
    { logInfo: options.logInfo, logError: options.logError },
  )
  return new ClientEventCollector(reporter, {
    userEmail: options.userEmail ?? (() => null),
    clientVersion,
  })
}
