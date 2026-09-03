/**
 * Agent-browser session: window/webview lifecycle, the ref+generation
 * mechanism, snapshot construction, waits, the B2 act loop (click/type/
 * scroll over trusted Input events with audited isolated-world helpers),
 * the claimControl state machine, transient-CDP retry, and serialization
 * (design §1–§5).
 *
 * The revision discipline (2026-09-03 review) is implemented literally:
 *
 * - `generation` bumps ONLY on main-frame navigation, completion of
 *   `browser_open`/`browser_navigate` (deduplicated against the navigation
 *   events the very same operation observed), and the future human-release
 *   boundary (B2). DOM mutation events NEVER bump it — on animation-heavy
 *   SPAs a per-mutation counter churns and turns nearly every act call into a
 *   false `STALE_SNAPSHOT`.
 * - Mutations only mark the page dirty, invalidating the cached snapshot
 *   before the next `browser_snapshot`.
 *
 * The module stays Electron-free: window creation is injected as a factory
 * and the CDP client talks to a structural debugger target, so the whole
 * state machine is testable headless (the day-1 spike validated the real
 * composition under Electron 43.4.0).
 *
 * @module dsh-plugin-desktop/agent-browser-session
 */

import type {
  AgentBrowserActionResult,
  AgentBrowserClickRequest,
  AgentBrowserLiveState,
  AgentBrowserMouseButton,
  AgentBrowserOverlayState,
  AgentBrowserPageInfo,
  AgentBrowserPhase,
  AgentBrowserScreenshot,
  AgentBrowserScrollDirection,
  AgentBrowserScrollRequest,
  AgentBrowserSnapshot,
  AgentBrowserTypeRequest,
  AgentBrowserViewModel,
  AgentBrowserViewport,
  AgentBrowserWaitOutcome,
  AgentBrowserWaitRequest,
  DesktopAgentBrowser,
} from './agent-browser-contract.ts'
import {
  AgentBrowserCdpClient,
  AgentBrowserCdpError,
  type AgentBrowserCdpBox,
  type AgentBrowserCdpNode,
  type AgentBrowserDebuggerTarget,
} from './agent-browser-cdp.ts'

/** Guest webContents surface the session consumes (structural Electron subset). */
export interface AgentBrowserGuestWebContents {
  /** CDP transport for the automation session. */
  readonly debugger: AgentBrowserDebuggerTarget
  /** Current committed main-frame URL. */
  getURL(): string
  /** Current document title. */
  getTitle(): string
  /** Deny every guest-initiated window open (design §1). */
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  /**
   * Best-effort renderer keyboard focus (optional in fakes). Trusted text
   * insertion is dropped by a guest that holds no OS-level focus — the
   * embedder window owns the real focus — so `browser_type` hands it over
   * before the isolated-world focus helper runs (B2 smoke finding).
   */
  focus?(): void
}

/** Window host surface the session consumes (implemented in agent-browser-window). */
export interface AgentBrowserWindowHost {
  /** Open the window and resolve once the guest webContents has attached. */
  open(): Promise<AgentBrowserGuestWebContents>
  /** Push one view-model snapshot into the window document. */
  pushState(state: AgentBrowserViewModel): void
  /** Close and dispose the window (idempotent). */
  close(): void
  /** Whether the window is gone. */
  isClosed(): boolean
}

/** Factory creating one window host bound to a one-shot partition token. */
export type AgentBrowserWindowHostFactory = (options: {
  readonly partition: string
  readonly onViewModelState: (state: AgentBrowserViewModel) => void
  readonly onWindowClosed: () => void
  /** Toolbar claim button (§5.4): the human takes over. */
  readonly onHumanClaim: () => void
  /** Toolbar release button (§5.4): the human hands control back. */
  readonly onHumanRelease: () => void
  readonly logError?: (message: string) => void
}) => AgentBrowserWindowHost

/** Snapshot input defaults (design §3: depth 12–16, ~5k-node budget). */
export const AGENT_BROWSER_SNAPSHOT_DEPTH = 14
/** Shallow re-fetch depth when the node budget overruns a full-depth fetch. */
export const AGENT_BROWSER_SNAPSHOT_SHALLOW_DEPTH = 6
/** Hard cap on nodes projected into one snapshot tree. */
export const AGENT_BROWSER_SNAPSHOT_NODE_BUDGET = 5_000
/** Marker appended when the projection hit its budget. */
export const AGENT_BROWSER_SNAPSHOT_TRUNCATION_MARKER = '[snapshot truncated: node budget reached]'

/** Milliseconds of no navigation and no mutation required by `until: 'settle'`. */
export const AGENT_BROWSER_SETTLE_QUIET_MS = 500
/** Default cap for `browser_wait` conditions. */
export const AGENT_BROWSER_WAIT_DEFAULT_TIMEOUT_MS = 30_000
/** Poll interval while waiting for `settle`. */
const SETTLE_POLL_MS = 100

/**
 * Audited isolated-world helper snippets (design §3/§5.3b) — the ONLY
 * page-side script the capability ever runs. Observation stays script-free
 * by construction; these fixed, reviewable snippets serve the act phase:
 * focus, select-all (for clear), scrollIntoView, scrollBy, and reading a
 * NON-secret input's live value. The scrollBy template interpolates a
 * validated finite integer only — never model text.
 */
export const AUDITED_SNIPPET_FOCUS = 'function(){ this.focus(); return document.activeElement === this; }'
export const AUDITED_SNIPPET_FOCUS_SELECT = 'function(){ this.focus(); if (typeof this.select === "function") this.select(); return document.activeElement === this; }'
export const AUDITED_SNIPPET_SCROLL_INTO_VIEW = 'function(){ if (typeof this.scrollIntoView === "function") this.scrollIntoView({ block: "center", inline: "nearest" }); }'
export const AUDITED_SNIPPET_READ_VALUE = 'function(){ return (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) && this.type !== "password" ? this.value : undefined; }'

/** Audited `scrollBy` snippet; only a rounded finite number is interpolated. */
export function auditedSnippetScrollBy(deltaY: number): string {
  if (!Number.isFinite(deltaY)) {
    throw new Error('auditedSnippetScrollBy requires a finite pixel amount')
  }
  return `function(){ const before = this.scrollTop; this.scrollBy(0, ${String(Math.round(deltaY))}); return { before, after: this.scrollTop }; }`
}

/** Audited document-scroll expression over `document.scrollingElement`. */
export function auditedExpressionDocumentScrollBy(deltaY: number): string {
  if (!Number.isFinite(deltaY)) {
    throw new Error('auditedExpressionDocumentScrollBy requires a finite pixel amount')
  }
  return `(() => { const el = document.scrollingElement; if (el === null) return { before: 0, after: 0 }; const before = el.scrollTop; el.scrollBy(0, ${String(Math.round(deltaY))}); return { before, after: el.scrollTop }; })()`
}

/** Backoff ladder for transient CDP failures: ≤3 tries, ≤600 ms slept (≤2 s budget, design §4). */
const TRANSIENT_RETRY_DELAYS_MS = [150, 450] as const
/** Failure text that marks a transient CDP condition worth retrying. */
const TRANSIENT_CDP_PATTERN = /detach|busy|target closed|target went away|session not found/iu

/** Sensitive `autocomplete` tokens whose values never leave the page (design §5.3). */
const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set(['current-password', 'new-password', 'one-time-code'])
const SENSITIVE_AUTOCOMPLETE_PREFIX = 'cc-'
/** Secret-shaped `name`/`id` substrings (B1 review P2: heuristic addition). */
const SENSITIVE_NAME_PATTERN = /(?:password|passwd|pwd)/u

/** Error classification of the agent-browser surface (design §4 taxonomy). */
export type AgentBrowserErrorCode =
  | 'STALE_SNAPSHOT'
  | 'REF_NOT_FOUND'
  | 'OPERATOR_HAS_CONTROL'
  | 'DENIED_BY_POLICY'
  | 'INVALID_ARGS'
  | 'WINDOW_CLOSED'
  | 'BUSY'
  | 'CDP_UNAVAILABLE'

/** Classified agent-browser failure; the code drives the model-facing text. */
export class AgentBrowserError extends Error {
  constructor(readonly code: AgentBrowserErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'AgentBrowserError'
  }
}

/** Render one CDP `backendNodeId` as the model-facing ref form `e<base36>`. */
export function agentBrowserRef(backendNodeId: number): string {
  return `e${backendNodeId.toString(36)}`
}

/**
 * Parse one model-facing `e<base36>` ref back to its `backendNodeId`.
 *
 * Anything that is not the emitted ref form fails `REF_NOT_FOUND` — the
 * corrective text points back at `browser_snapshot`, never at coordinates.
 */
export function agentBrowserBackendNodeId(ref: string): number {
  if (typeof ref !== 'string' || !/^e[0-9a-z]+$/u.test(ref)) {
    throw new AgentBrowserError(
      'REF_NOT_FOUND',
      `${JSON.stringify(ref)} is not an element ref; call browser_snapshot and use one of its #e… refs (aliases element/ref_id are normalized by the tool)`,
    )
  }
  return Number.parseInt(ref.slice(1), 36)
}

/** Flatten a node's `[name, value, …]` attribute pairs into a lookup. */
export function agentBrowserNodeAttributes(node: AgentBrowserCdpNode): Record<string, string> {
  const attributes: Record<string, string> = {}
  const flat = node.attributes
  if (flat === undefined) return attributes
  for (let index = 0; index + 1 < flat.length; index += 2) {
    attributes[flat[index]!] = flat[index + 1]!
  }
  return attributes
}

/** Whether one input node is secret-shaped and must never project a value. */
export function isSensitiveInputNode(node: AgentBrowserCdpNode): boolean {
  if (node.nodeType !== 1) return false
  const tag = (node.localName ?? node.nodeName).toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') return false
  const attributes = agentBrowserNodeAttributes(node)
  const type = (attributes.type ?? 'text').toLowerCase()
  if (type === 'password') return true
  // B1 review P2: pages that omit autocomplete still name their secret
  // fields honestly — `name`/`id` carrying password|passwd|pwd marks the
  // input secret-shaped even when the type is plain text. Masking extra
  // fields is the safe direction; a false positive only hides a value.
  const name = (attributes.name ?? '').toLowerCase()
  const id = (attributes.id ?? '').toLowerCase()
  if (SENSITIVE_NAME_PATTERN.test(name) || SENSITIVE_NAME_PATTERN.test(id)) return true
  // Multi-token autocomplete values ("tel current-password") match by
  // token, not as a whole — the autofill detail tokens ride alongside the
  // sensitive section token.
  for (const token of (attributes.autocomplete ?? '').toLowerCase().trim().split(/\s+/u)) {
    if (SENSITIVE_AUTOCOMPLETE_TOKENS.has(token)) return true
    if (token.startsWith(SENSITIVE_AUTOCOMPLETE_PREFIX)) return true
  }
  return false
}

/** Infer a concise role from the tag and ARIA attributes (design §3). */
function inferRole(tag: string, attributes: Record<string, string>): string | undefined {
  const explicit = attributes.role
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim().toLowerCase()
  switch (tag) {
    case 'a': return (attributes.href !== undefined ? 'link' : undefined)
    case 'button': return 'button'
    case 'select': return 'listbox'
    case 'option': return 'option'
    case 'textarea': return 'textbox'
    case 'nav': return 'navigation'
    case 'main': return 'main'
    case 'article': return 'article'
    case 'img': return 'image'
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading'
    case 'label': return 'label'
    default: return undefined
  }
}

/** Options of the pure snapshot-tree projection. */
export interface AgentBrowserSnapshotBuildOptions {
  /** Hard node cap for one projection. */
  readonly nodeBudget?: number
  /** Characters one text contribution may add to a line. */
  readonly maxTextLength?: number
}

/** Result of the pure snapshot-tree projection. */
export interface AgentBrowserSnapshotBuildResult {
  /** Multi-line text projection with `ref` attributes on element lines. */
  readonly tree: string
  /** Whether the node budget stopped the walk early. */
  readonly truncated: boolean
  /** Number of nodes consumed by the projection. */
  readonly nodeCount: number
}

/** Collapse whitespace like rendered text content would. */
function collapseText(value: string | undefined): string {
  if (value === undefined) return ''
  return value.replaceAll(/\s+/gu, ' ').trim()
}

/** Render one element's attribute summary (value-carrying, secrets excluded). */
function describeAttributes(node: AgentBrowserCdpNode, attributes: Record<string, string>): string {
  const parts: string[] = []
  const tag = (node.localName ?? node.nodeName).toLowerCase()
  if (attributes.id !== undefined && attributes.id.length > 0) parts.push(`id="${attributes.id}"`)
  const role = inferRole(tag, attributes)
  if (role !== undefined) parts.push(`role=${role}`)
  for (const name of ['name', 'aria-label', 'placeholder', 'title', 'type', 'for']) {
    const value = attributes[name]
    if (value === undefined || value.length === 0) continue
    parts.push(`${name}="${collapseText(value).slice(0, 120)}"`)
  }
  if (tag === 'a' && attributes.href !== undefined) {
    parts.push(`href="${collapseText(attributes.href).slice(0, 200)}"`)
  }
  if (isSensitiveInputNode(node)) {
    // Never emit the value attribute for secret-shaped inputs (§5.3a).
    parts.push('[password field: value hidden]')
    return parts.join(' ')
  }
  if (tag === 'input' && attributes.value !== undefined && attributes.value.length > 0) {
    // Hidden inputs carry CSRF/session tokens that must never enter the
    // model context (B1 review P3): the value attribute is projected for
    // VISIBLE inputs only, and hidden inputs declare their own type.
    if ((attributes.type ?? 'text').toLowerCase() !== 'hidden') {
      parts.push(`value="${collapseText(attributes.value).slice(0, 120)}"`)
    }
  }
  return parts.join(' ')
}

/**
 * Project one `DOM.getDocument` root into the bounded text tree (pure).
 *
 * The walk is breadth-limited by the payload's own depth, node-limited by the
 * budget, and consumes only tag/attribute/text data — zero page script.
 */
export function buildAgentBrowserSnapshotTree(
  root: AgentBrowserCdpNode,
  options: AgentBrowserSnapshotBuildOptions = {},
): AgentBrowserSnapshotBuildResult {
  const nodeBudget = options.nodeBudget ?? AGENT_BROWSER_SNAPSHOT_NODE_BUDGET
  const maxTextLength = options.maxTextLength ?? 240
  const lines: string[] = []
  let nodeCount = 0
  let truncated = false

  const visit = (node: AgentBrowserCdpNode, depth: number): void => {
    if (truncated) return
    if (nodeCount >= nodeBudget) {
      truncated = true
      return
    }
    nodeCount += 1
    if (node.nodeType === 3) {
      const text = collapseText(node.nodeValue)
      if (text.length > 0) lines.push(`${'  '.repeat(depth)}${text.slice(0, maxTextLength)}`)
      return
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 10 && node.nodeType !== 11) return
    const tag = (node.localName ?? node.nodeName).toLowerCase()
    const isDocumentRoot = node.nodeType === 9 || node.nodeName === '#document'
    const ref = node.backendNodeId === undefined ? undefined : agentBrowserRef(node.backendNodeId)
    const indent = '  '.repeat(depth)
    if (isDocumentRoot) {
      lines.push(`${indent}document`)
    } else {
      const summary = describeAttributes(node, agentBrowserNodeAttributes(node))
      const refText = ref === undefined ? '' : ` #${ref}`
      lines.push(`${indent}${tag}${refText}${summary.length > 0 ? ` ${summary}` : ''}`)
    }
    if (isSensitiveInputNode(node)) {
      // Secret-shaped inputs are never descended into: their pierced UA
      // shadow tree carries the typed value as a text node (day-1 smoke
      // finding), so the subtree stays sealed, not just the attribute.
      return
    }
    for (const child of node.children ?? []) {
      visit(child, depth + 1)
      if (truncated) return
    }
    // Pierced trees carry detached containers the DOM domain still reports.
    for (const shadowRoot of node.shadowRoots ?? []) {
      if (truncated) return
      lines.push(`${'  '.repeat(depth + 1)}shadow-root`)
      visit(shadowRoot, depth + 2)
    }
    if (node.contentDocument !== undefined && !truncated) {
      lines.push(`${'  '.repeat(depth + 1)}iframe-document`)
      visit(node.contentDocument, depth + 2)
    }
  }

  visit(root, 0)
  if (truncated) lines.push(AGENT_BROWSER_SNAPSHOT_TRUNCATION_MARKER)
  return { tree: lines.join('\n'), truncated, nodeCount }
}

/**
 * The monotonic navigation counter (revised §3 semantics).
 *
 * Exported as a class because the acceptance spec pins the discipline
 * directly: navigation bumps, mutation marks dirty only.
 */
export class AgentBrowserGenerationCounter {
  private value = 0
  private dirty = false

  /** Current generation; refs are only valid at the generation they were observed in. */
  get current(): number { return this.value }

  /** Whether mutations invalidated the last observed state. */
  get isDirty(): boolean { return this.dirty }

  /** Main-frame navigation boundary: the only event-driven bump. */
  noteMainFrameNavigation(): void {
    this.value += 1
    this.dirty = false
  }

  /** Completion of open/navigate: bump unless the operation already observed one. */
  noteOperationCompletion(since: number): void {
    if (this.value > since) return
    this.value += 1
    this.dirty = false
  }

  /** Future human-release boundary (§5.4); wired to the claim state machine in B2. */
  noteHumanRelease(): void {
    this.value += 1
    this.dirty = false
  }

  /** DOM mutation: mark dirty without churning the generation. */
  markDirty(): void { this.dirty = true }

  /** Dirty flag consumed by the next snapshot build. */
  consumeDirty(): boolean {
    const dirty = this.dirty
    this.dirty = false
    return dirty
  }
}

/** Options of {@link DesktopAgentBrowserSession}. */
export interface AgentBrowserSessionOptions {
  /** Creates the window host bound to a fresh one-shot partition token. */
  readonly createWindowHost: AgentBrowserWindowHostFactory
  /** Mints one-shot partition tokens (`dsh-agent-browser-<uuid>`; §5.2). */
  readonly mintPartitionToken: () => string
  /** Clock used for waits (injectable for tests). */
  readonly now?: () => number
  /** Quiet window required by `until: "settle"` (injectable for tests). */
  readonly settleQuietMs?: number
  /** Poll interval while waiting for a condition (injectable for tests). */
  readonly pollMs?: number
  /** Error log sink for window observability. */
  readonly logError?: (message: string) => void
}

/**
 * Executor behind `ctx.desktopAgentBrowser`: one window, one guest, one CDP
 * session; tool calls serialize through the per-window mutex (design §1).
 */
export class DesktopAgentBrowserSession implements DesktopAgentBrowser {
  private readonly createWindowHost: AgentBrowserWindowHostFactory
  private readonly mintPartitionToken: () => string
  private readonly now: () => number
  private readonly settleQuietMs: number
  private readonly pollMs: number
  private readonly logError: ((message: string) => void) | undefined
  private readonly counter = new AgentBrowserGenerationCounter()
  private windowHost: AgentBrowserWindowHost | undefined
  private guest: AgentBrowserGuestWebContents | undefined
  private client: AgentBrowserCdpClient | undefined
  private partition = ''
  private phase: AgentBrowserPhase = 'idle'
  private url = 'about:blank'
  private title = ''
  private cachedSnapshot: AgentBrowserSnapshot | undefined
  /** Main-frame identity from `Page.getFrameTree`; filters same-document events. */
  private mainFrameId: string | undefined
  /** Claim state machine (§5.4): aborted while the operator holds control. */
  private agentEpoch = new AbortController()
  private claimReason: string | undefined
  /** Overlay coordinates drawn by the window document (§5.4, zero injection). */
  private overlay: AgentBrowserOverlayState | undefined
  /** Isolated world of the current main-frame document (act helpers only). */
  private isolatedWorld: { frameId: string, executionContextId: number } | undefined
  private mutex: Promise<unknown> = Promise.resolve()
  private readonly unsubscribers: Array<() => void> = []

  constructor(options: AgentBrowserSessionOptions) {
    this.createWindowHost = options.createWindowHost
    this.mintPartitionToken = options.mintPartitionToken
    this.now = options.now ?? (() => Date.now())
    this.settleQuietMs = options.settleQuietMs ?? AGENT_BROWSER_SETTLE_QUIET_MS
    this.pollMs = options.pollMs ?? SETTLE_POLL_MS
    this.logError = options.logError
  }

  /** Serialize every public operation through the per-window mutex. */
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(operation, operation)
    this.mutex = next.catch(() => undefined)
    return next
  }

  private assertClient(): AgentBrowserCdpClient {
    if (this.client === undefined || this.windowHost === undefined || this.windowHost.isClosed()) {
      throw new AgentBrowserError('WINDOW_CLOSED', 'the browser window is not open; call browser_open first')
    }
    return this.client
  }

  private async ensureStarted(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted()
    if (this.client !== undefined && this.windowHost !== undefined && !this.windowHost.isClosed()) return
    this.partition = this.mintPartitionToken()
    const host = this.createWindowHost({
      partition: this.partition,
      onViewModelState: () => { this.pushViewModel() },
      onWindowClosed: () => { void this.close() },
      onHumanClaim: () => { this.claimControl('the operator pressed the claim button') },
      onHumanRelease: () => { this.releaseControl() },
      ...(this.logError === undefined ? {} : { logError: this.logError }),
    })
    this.windowHost = host
    this.pushViewModel('opening the browser window')
    try {
      const guest = await host.open()
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      this.guest = guest
      const client = new AgentBrowserCdpClient(guest.debugger)
      client.attach()
      this.client = client
      await client.pageEnable()
      await client.setLifecycleEventsEnabled(true)
      await client.domEnable()
      await this.learnMainFrameId(client)
      this.registerGuestEvents(client)
      this.phase = 'observing'
    } catch (cause) {
      // A half-started surface never lingers: reset before the error escapes.
      await this.closeLocked()
      throw cause
    }
  }

  /**
   * Learn the main-frame identity once per start (B1 review P2).
   *
   * `Page.navigatedWithinDocument` fires for IFRAMES too, and an iframe's
   * pushState is not a main-frame boundary — the unconditional bump turned
   * every iframe history tweak into a false `STALE_SNAPSHOT`. The identity
   * self-heals on the next main-frame `frameNavigated` when the tree read
   * fails.
   */
  private async learnMainFrameId(client: AgentBrowserCdpClient): Promise<void> {
    try {
      const id = (await client.getFrameTree()).frameTree.frame.id
      if (typeof id === 'string' && id.length > 0) this.mainFrameId = id
    } catch {
      // Without the identity the same-document filter stays permissive.
    }
  }

  private registerGuestEvents(client: AgentBrowserCdpClient): void {
    // Main-frame navigation is the only generation bump source (rev §3).
    this.unsubscribers.push(client.on('Page.frameNavigated', params => {
      if (params.frame.parentId !== undefined) return
      this.mainFrameId = params.frame.id
      this.url = params.frame.url
      this.counter.noteMainFrameNavigation()
      this.cachedSnapshot = undefined
      this.isolatedWorld = undefined
      this.pushViewModel()
    }))
    this.unsubscribers.push(client.on('Page.navigatedWithinDocument', params => {
      // Only the MAIN frame's same-document navigation is a boundary; an
      // iframe pushState must not churn the generation (B1 review P2).
      if (this.mainFrameId !== undefined && params.frameId !== this.mainFrameId) return
      this.url = params.url
      this.counter.noteMainFrameNavigation()
      this.cachedSnapshot = undefined
      this.pushViewModel()
    }))
    // Mutations only mark dirty: no generation churn on animated SPAs.
    const markDirty = (): void => {
      this.counter.markDirty()
      this.cachedSnapshot = undefined
    }
    for (const event of [
      'DOM.setChildNodes',
      'DOM.childNodeInserted',
      'DOM.childNodeRemoved',
      'DOM.shadowRootPushed',
      'DOM.shadowRootPopped',
    ] as const) {
      this.unsubscribers.push(client.on(event, markDirty))
    }
  }

  private pushViewModel(actionDescription?: string): void {
    this.windowHost?.pushState({
      url: this.url,
      title: this.title,
      phase: this.phase,
      generation: this.counter.current,
      partition: this.partition,
      ...(this.overlay === undefined ? {} : { overlay: this.overlay }),
      ...(this.claimReason === undefined || this.phase !== 'claimed' ? {} : { actionDescription: this.claimReason }),
      ...(actionDescription === undefined || this.phase === 'claimed' ? {} : { actionDescription }),
    })
  }

  private refreshPageIdentity(): void {
    if (this.guest === undefined) return
    this.url = this.guest.getURL() || this.url
    this.title = this.guest.getTitle() ?? ''
  }

  async open(
    url: string,
    options: { readonly waitForLoad?: boolean },
    signal?: AbortSignal,
  ): Promise<AgentBrowserPageInfo> {
    return await this.runExclusive(async () => {
      await this.ensureStarted(signal)
      return await this.navigateLocked(url, options.waitForLoad !== false, signal)
    })
  }

  async navigate(url: string, signal?: AbortSignal): Promise<AgentBrowserPageInfo> {
    return await this.runExclusive(() => this.navigateLocked(url, true, signal))
  }

  private async navigateLocked(
    url: string,
    waitForLoad: boolean,
    signal: AbortSignal | undefined,
  ): Promise<AgentBrowserPageInfo> {
    const client = this.assertClient()
    // Navigation is agent input too: it fails fast while the operator holds
    // control, and its in-flight waits abort on claim (§5.4).
    const composed = this.assertNotClaimed(signal)
    const since = this.counter.current
    this.pushViewModel(`navigating to ${url}`)
    let loadFired = false
    const unsubscribeLoad = client.on('Page.loadEventFired', () => { loadFired = true })
    try {
      await client.navigate(url)
      if (waitForLoad) {
        await this.waitForCondition(() => loadFired, AGENT_BROWSER_WAIT_DEFAULT_TIMEOUT_MS, composed, () => {
          // Navigation completes even when the load event is late; the wait
          // is best-effort, the generation boundary is the navigate reply.
        })
      }
      this.counter.noteOperationCompletion(since)
      this.cachedSnapshot = undefined
      this.isolatedWorld = undefined
      this.refreshPageIdentity()
      this.pushViewModel()
      return { url: this.url, title: this.title, generation: this.counter.current }
    } finally {
      unsubscribeLoad()
    }
  }

  async snapshot(
    generation: number | undefined,
    signal?: AbortSignal,
  ): Promise<AgentBrowserSnapshot> {
    return await this.runExclusive(async () => {
      const client = this.assertClient()
      signal?.throwIfAborted()
      if (generation !== undefined && generation !== this.counter.current) {
        throw new AgentBrowserError(
          'STALE_SNAPSHOT',
          `the snapshot was observed at generation ${String(generation)} but the page is at generation ${String(this.counter.current)}; call browser_snapshot again and use only the new refs`,
        )
      }
      // B1 review P3: the dirty flag is read BEFORE trusting the cache. A
      // mutation that landed while the previous build was in flight left the
      // cached tree stale at an unchanged generation — consuming the flag
      // and then returning that cache served exactly that stale tree.
      const dirty = this.counter.consumeDirty()
      const cached = this.cachedSnapshot
      if (!dirty && cached !== undefined && cached.generation === this.counter.current) return cached
      const viewport = await this.readViewport(client, signal)
      // Budget overrun triggers a shallow re-fetch (§3): the truncation
      // marker caps output text, not the native→V8 conversion cost.
      let document = await client.getDocument({ depth: AGENT_BROWSER_SNAPSHOT_DEPTH })
      let projection = buildAgentBrowserSnapshotTree(document.root)
      if (projection.truncated) {
        document = await client.getDocument({ depth: AGENT_BROWSER_SNAPSHOT_SHALLOW_DEPTH })
        projection = buildAgentBrowserSnapshotTree(document.root)
      }
      this.refreshPageIdentity()
      const snapshot: AgentBrowserSnapshot = {
        url: this.url,
        title: this.title,
        generation: this.counter.current,
        viewport,
        truncated: projection.truncated,
        tree: projection.tree,
      }
      this.cachedSnapshot = snapshot
      return snapshot
    })
  }

  private async readViewport(
    client: AgentBrowserCdpClient,
    signal: AbortSignal | undefined,
  ): Promise<AgentBrowserViewport> {
    signal?.throwIfAborted()
    try {
      const metrics = await client.getLayoutMetrics()
      const width = Math.max(1, Math.round(metrics.cssVisualViewport.clientWidth))
      const height = Math.max(1, Math.round(metrics.cssVisualViewport.clientHeight))
      return { width, height }
    } catch {
      // Layout metrics race with early navigation; the snapshot stays useful.
      return { width: 0, height: 0 }
    }
  }

  async wait(request: AgentBrowserWaitRequest, signal?: AbortSignal): Promise<AgentBrowserWaitOutcome> {
    return await this.runExclusive(async () => {
      this.assertClient()
      signal?.throwIfAborted()
      const timeoutMs = Math.max(1, request.timeoutMs ?? AGENT_BROWSER_WAIT_DEFAULT_TIMEOUT_MS)
      const start = this.now()
      if (request.until === 'settle') {
        // Settle = no navigation AND no mutation-dirty flag for the quiet
        // window (§4): navigation bumps the generation and mutations set the
        // dirty flag, so both disturbances are observable here.
        const deadline = start + timeoutMs
        const generationAtStart = this.counter.current
        let quietSince = start
        while (this.now() < deadline) {
          signal?.throwIfAborted()
          await this.sleep(this.pollMs, signal)
          if (this.counter.consumeDirty() || this.counter.current !== generationAtStart) {
            quietSince = this.now()
            continue
          }
          if (this.now() - quietSince >= this.settleQuietMs) break
        }
      } else if (request.until === 'load') {
        const client = this.assertClient()
        let loadFired = false
        const unsubscribe = client.on('Page.loadEventFired', () => { loadFired = true })
        try {
          await this.waitForCondition(() => loadFired, timeoutMs, signal, () => {})
        } finally {
          unsubscribe()
        }
      } else {
        const ms = Math.max(1, Math.min(request.ms ?? 1_000, timeoutMs))
        await this.sleep(ms, signal)
      }
      return { generation: this.counter.current, waited: Math.round(this.now() - start) }
    })
  }

  /** Poll one condition; `onPoll` runs between checks for settle bookkeeping. */
  private async waitForCondition(
    condition: () => boolean,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onPoll: () => void,
  ): Promise<void> {
    const deadline = this.now() + timeoutMs
    while (!condition()) {
      signal?.throwIfAborted()
      if (this.now() >= deadline) return
      await this.sleep(this.pollMs, signal)
      onPoll()
    }
  }

  private async sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        const reason = signal.reason
        reject(reason instanceof Error ? reason : new Error('aborted'))
      }, { once: true })
    })
  }

  // ── Claim state machine (design §5.4) ─────────────────────────────────

  /**
   * The operator takes over: in-flight agent input aborts through the epoch
   * signal, subsequent act tools (and navigation) fail fast, and the human's
   * real mouse/keyboard work natively — there is nothing to intercept.
   *
   * Deliberately NOT mutex-serialized: a claim arriving mid-operation must
   * act immediately, not queue behind the operation it is interrupting.
   */
  claimControl(reason?: string): void {
    if (this.phase === 'claimed') {
      if (reason !== undefined) this.claimReason = reason
      return
    }
    this.phase = 'claimed'
    this.claimReason = reason ?? 'the operator claimed control'
    this.overlay = undefined
    this.pushViewModel()
    this.agentEpoch.abort(new AgentBrowserError(
      'OPERATOR_HAS_CONTROL',
      'the operator claimed control of the browser window while this browser operation was in flight; stop driving the browser and wait for the release',
    ))
  }

  /**
   * The operator hands control back: a one-shot generation boundary (the
   * page likely changed under human input), a fresh agent epoch, and the
   * cached snapshot invalidated so the next observe re-reads the page.
   */
  releaseControl(): void {
    if (this.phase !== 'claimed') return
    this.agentEpoch = new AbortController()
    this.claimReason = undefined
    this.counter.noteHumanRelease()
    this.cachedSnapshot = undefined
    this.isolatedWorld = undefined
    this.phase = this.windowHost !== undefined && !this.windowHost.isClosed() ? 'observing' : 'idle'
    this.pushViewModel()
  }

  /** Compose one caller signal with the agent epoch (claim aborts). */
  private composeAgentSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (signal === undefined) return this.agentEpoch.signal
    return AbortSignal.any([signal, this.agentEpoch.signal])
  }

  /** Agent-driven page mutations fail fast while the operator holds control. */
  private assertNotClaimed(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (this.phase === 'claimed') {
      throw new AgentBrowserError(
        'OPERATOR_HAS_CONTROL',
        'the operator has claimed control of the browser window; act tools and navigation fail fast until the operator releases control — observe with browser_snapshot if you must, then wait',
      )
    }
    const composed = this.composeAgentSignal(signal)
    composed?.throwIfAborted()
    return composed
  }

  /** Between-step checkpoint of one act sequence (claim or cancel mid-action). */
  private assertActContinues(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted()
    if (this.phase === 'claimed') {
      throw new AgentBrowserError(
        'OPERATOR_HAS_CONTROL',
        'the operator claimed control mid-action; the partial input stopped — re-observe after the release',
      )
    }
  }

  /** Ref/generation validation shared by every act tool (design §3/§4). */
  private checkActRequest(generation: number | undefined, ref: string): number {
    if (generation !== undefined && generation !== this.counter.current) {
      throw new AgentBrowserError(
        'STALE_SNAPSHOT',
        `the ref ${ref} was observed at generation ${String(generation)} but the page is at generation ${String(this.counter.current)}; call browser_snapshot and act on a ref from the current generation`,
      )
    }
    return agentBrowserBackendNodeId(ref)
  }

  /**
   * Run one CDP command with the transient-failure policy of §4: detach
   * races and target-busy retry with capped backoff (≤3 tries, ≤2 s), a
   * DevTools takeover re-attaches exactly once, everything else surfaces as
   * a classified `CDP_UNAVAILABLE` with corrective text.
   */
  private async runCdp<T>(label: string, operation: (client: AgentBrowserCdpClient) => Promise<T>): Promise<T> {
    const client = this.assertClient()
    let attempt = 0
    for (;;) {
      try {
        return await operation(client)
      } catch (cause) {
        const transient = cause instanceof AgentBrowserCdpError
          && (!client.isAttached || TRANSIENT_CDP_PATTERN.test(cause.message))
        if (!transient || attempt >= TRANSIENT_RETRY_DELAYS_MS.length) {
          if (transient && cause instanceof AgentBrowserCdpError) {
            // The retry budget ran out on a transient condition — classify.
            throw new AgentBrowserError(
              'CDP_UNAVAILABLE',
              `${label} failed after ${String(attempt + 1)} attempts (${cause.message}); the guest debugger session may have been taken over — guest DevTools belongs to the human, so close it, then retry the action`,
            )
          }
          // Non-transient failures keep their shape: callers classify them
          // (a dead ref maps to REF_NOT_FOUND, a navigate errorText stays).
          throw cause
        }
        attempt += 1
        if (!client.isAttached) {
          // DevTools takeover: re-attach once before the retry (design §7).
          try {
            client.attach()
          } catch {
            // The retry (or the final surface below) reports the takeover.
          }
        }
        await this.sleep(TRANSIENT_RETRY_DELAYS_MS[attempt - 1]!, undefined)
      }
    }
  }

  /** Resolve a ref to a remote object; a dead ref fails `REF_NOT_FOUND`. */
  private async resolveRef(backendNodeId: number, label: string, executionContextId?: number): Promise<string> {
    try {
      const resolved = await this.runCdp(label, client => client.resolveNode(backendNodeId, {
        ...(executionContextId === undefined ? {} : { executionContextId }),
      }))
      if (typeof resolved.object.objectId !== 'string' || resolved.object.objectId.length === 0) {
        throw new AgentBrowserError(
          'REF_NOT_FOUND',
          'the ref no longer resolves to a live node; call browser_snapshot and use a ref from the current generation',
        )
      }
      return resolved.object.objectId
    } catch (cause) {
      if (cause instanceof AgentBrowserError) throw cause
      // A backendNodeId dies with its document; the protocol rejects the resolve.
      throw new AgentBrowserError(
        'REF_NOT_FOUND',
        `the ref died with its document (${cause instanceof Error ? cause.message : String(cause)}); call browser_snapshot and use a ref from the current generation`,
      )
    }
  }

  /** The isolated world for act-phase helpers, recreated per document. */
  private async ensureIsolatedWorld(client: AgentBrowserCdpClient): Promise<number> {
    let frameId = this.mainFrameId
    if (frameId === undefined) {
      await this.learnMainFrameId(client)
      frameId = this.mainFrameId
    }
    if (frameId === undefined) {
      throw new AgentBrowserError('CDP_UNAVAILABLE', 'the main frame identity is unknown; retry the action once the page settled')
    }
    if (this.isolatedWorld !== undefined && this.isolatedWorld.frameId === frameId) {
      return this.isolatedWorld.executionContextId
    }
    const knownFrameId = frameId
    const world = await this.runCdp('creating the isolated world', candidate => candidate.createIsolatedWorld(knownFrameId))
    this.isolatedWorld = { frameId: knownFrameId, executionContextId: world.executionContextId }
    return world.executionContextId
  }

  /** Record executor-known coordinates for the zero-injection overlay. */
  private noteOverlay(update: {
    readonly cursor?: { readonly x: number, readonly y: number }
    readonly click?: { readonly x: number, readonly y: number }
  }): void {
    const previous = this.overlay ?? {}
    this.overlay = {
      ...previous,
      ...(update.cursor === undefined ? {} : { cursor: update.cursor }),
      ...(update.click === undefined ? {} : { click: update.click, clickedAt: this.now() }),
    }
    this.pushViewModel()
  }

  /** Read the box of one ref, scrolling it into view when it is off-screen. */
  private async boxForRef(
    client: AgentBrowserCdpClient,
    backendNodeId: number,
    objectId: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentBrowserCdpBox> {
    let box = await this.runCdp('reading the element box', candidate => candidate.getBoxModel(backendNodeId))
    const viewport = await this.readViewport(client, signal)
    const outside = box.x < 0 || box.y < 0 || box.x > viewport.width || box.y > viewport.height
    if (outside) {
      await this.runCdp('scrolling the element into view', candidate => candidate.callFunctionOn({
        objectId,
        functionDeclaration: AUDITED_SNIPPET_SCROLL_INTO_VIEW,
      }))
      this.assertActContinues(signal)
      box = await this.runCdp('re-reading the element box', candidate => candidate.getBoxModel(backendNodeId))
    }
    return box
  }

  /** Dispatch one trusted click (move → press → release) at a known point. */
  private async dispatchTrustedClick(
    box: { readonly x: number, readonly y: number },
    options: { readonly button: AgentBrowserMouseButton, readonly clickCount: number },
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await this.runCdp('moving the mouse', candidate => candidate.dispatchMouseEvent({
      type: 'mouseMoved', x: box.x, y: box.y,
    }))
    this.assertActContinues(signal)
    await this.runCdp('pressing the mouse', candidate => candidate.dispatchMouseEvent({
      type: 'mousePressed', x: box.x, y: box.y, button: options.button, clickCount: options.clickCount,
    }))
    await this.runCdp('releasing the mouse', candidate => candidate.dispatchMouseEvent({
      type: 'mouseReleased', x: box.x, y: box.y, button: options.button, clickCount: options.clickCount,
    }))
  }

  /** `browser_click` — trusted Input press/release at the box-model center. */
  async click(request: AgentBrowserClickRequest, signal?: AbortSignal): Promise<AgentBrowserActionResult> {
    return await this.runExclusive(async () => {
      const client = this.assertClient()
      const composed = this.assertNotClaimed(signal)
      const backendNodeId = this.checkActRequest(request.generation, request.ref)
      const button: NonNullable<AgentBrowserMouseButton> = request.button ?? 'left'
      const clickCount = Math.max(1, Math.min(request.clickCount ?? 1, 3))
      this.phase = 'acting'
      this.pushViewModel(`clicking ${request.ref}`)
      try {
        const objectId = await this.resolveRef(backendNodeId, 'resolving the click target')
        this.assertActContinues(composed)
        const box = await this.boxForRef(client, backendNodeId, objectId, composed)
        this.noteOverlay({ cursor: { x: box.x, y: box.y }, click: { x: box.x, y: box.y } })
        await this.dispatchTrustedClick(box, { button, clickCount }, composed)
        return { generation: this.counter.current, performed: true }
      } finally {
        if (this.phase === 'acting') this.phase = 'observing'
        // Acts change the page without necessarily emitting a subscribed
        // mutation event (attribute edits, selection state): the next
        // browser_snapshot must re-read the tree, never serve the cache.
        this.counter.markDirty()
        this.cachedSnapshot = undefined
        this.pushViewModel()
      }
    })
  }

  /** `browser_type` — isolated-world focus, trusted insert, optional Enter. */
  async type(request: AgentBrowserTypeRequest, signal?: AbortSignal): Promise<AgentBrowserActionResult> {
    if (typeof request.text !== 'string') {
      throw new AgentBrowserError('INVALID_ARGS', 'browser_type requires the text to type (string)')
    }
    return await this.runExclusive(async () => {
      const client = this.assertClient()
      const composed = this.assertNotClaimed(signal)
      const backendNodeId = this.checkActRequest(request.generation, request.ref)
      this.phase = 'acting'
      this.pushViewModel(`typing into ${request.ref}`)
      try {
        // Trusted text insertion needs the guest renderer keyboard-focused;
        // the embedder owns the real window focus (B2 smoke finding).
        try {
          this.guest?.focus?.()
        } catch {
          // Best-effort: a guest without the method keeps the DOM focus path.
        }
        // Host-side password classification (§5.3c): the same classifier the
        // snapshot walker uses, so masking and typing refusal can never drift.
        const described = await this.runCdp('describing the type target', candidate => candidate.describeNode(backendNodeId))
        const node = described.node
        if (isSensitiveInputNode({
          nodeId: 0,
          nodeType: node.nodeType ?? 1,
          nodeName: node.nodeName ?? 'INPUT',
          ...(node.localName === undefined ? {} : { localName: node.localName }),
          ...(node.attributes === undefined ? {} : { attributes: node.attributes }),
        })) {
          throw new AgentBrowserError(
            'DENIED_BY_POLICY',
            `the type target ${request.ref} is a password/secret-shaped field; credentials are never read or typed by the agent — invite the operator to type them personally via claimControl, then release`,
          )
        }
        const executionContextId = await this.ensureIsolatedWorld(client)
        const objectId = await this.resolveRef(backendNodeId, 'resolving the type target', executionContextId)
        this.assertActContinues(composed)
        // A human clicks into a field before typing; trusted text insertion
        // needs exactly that — a guest render widget without OS-level focus
        // (the embedder owns the real focus) drops `Input.insertText` (B2
        // smoke finding). The click also gives the overlay its cursor point.
        const box = await this.boxForRef(client, backendNodeId, objectId, composed)
        this.noteOverlay({ cursor: { x: box.x, y: box.y }, click: { x: box.x, y: box.y } })
        await this.dispatchTrustedClick(box, { button: 'left', clickCount: 1 }, composed)
        this.assertActContinues(composed)
        const focused = await this.runCdp('focusing the type target', candidate => candidate.callFunctionOn({
          objectId,
          functionDeclaration: request.clear === true ? AUDITED_SNIPPET_FOCUS_SELECT : AUDITED_SNIPPET_FOCUS,
          returnByValue: true,
        }))
        if (focused.value !== true) {
          throw new AgentBrowserError(
            'REF_NOT_FOUND',
            `the type target ${request.ref} could not be focused; it may be hidden or inert — re-observe and pick a visible field`,
          )
        }
        if (request.clear === true && request.text.length === 0) {
          // Clear-only: the select() above armed the selection; Backspace
          // deletes it through trusted input.
          await this.runCdp('clearing the field', candidate => candidate.dispatchKeyEvent({
            type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
          }))
          await this.runCdp('clearing the field', candidate => candidate.dispatchKeyEvent({
            type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
          }))
        } else if (request.text.length > 0) {
          // IME-style insertion replaces the active selection, so `clear`
          // needs no separate erase when text follows (§4).
          this.assertActContinues(composed)
          await this.runCdp('inserting text', candidate => candidate.insertText(request.text))
        }
        if (request.submit === true) {
          this.assertActContinues(composed)
          await this.runCdp('pressing Enter', candidate => candidate.dispatchKeyEvent({
            type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13,
          }))
          await this.runCdp('pressing Enter', candidate => candidate.dispatchKeyEvent({
            type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
          }))
        }
        return { generation: this.counter.current, performed: true }
      } finally {
        if (this.phase === 'acting') this.phase = 'observing'
        // Acts change the page without necessarily emitting a subscribed
        // mutation event (attribute edits, selection state): the next
        // browser_snapshot must re-read the tree, never serve the cache.
        this.counter.markDirty()
        this.cachedSnapshot = undefined
        this.pushViewModel()
      }
    })
  }

  /** `browser_scroll` — isolated-world scrollBy with a wheel fallback. */
  async scroll(request: AgentBrowserScrollRequest, signal?: AbortSignal): Promise<AgentBrowserActionResult> {
    if (request.direction !== 'up' && request.direction !== 'down') {
      throw new AgentBrowserError('INVALID_ARGS', `browser_scroll requires direction "up" or "down" (got ${JSON.stringify(request.direction)})`)
    }
    if (typeof request.amount !== 'number' || !Number.isFinite(request.amount) || request.amount < 0) {
      throw new AgentBrowserError('INVALID_ARGS', `browser_scroll requires a non-negative pixel amount (got ${JSON.stringify(request.amount)})`)
    }
    return await this.runExclusive(async () => {
      const client = this.assertClient()
      const composed = this.assertNotClaimed(signal)
      const backendNodeId = request.ref === undefined
        ? undefined
        : this.checkActRequest(request.generation, request.ref)
      const direction: AgentBrowserScrollDirection = request.direction
      const delta = direction === 'down' ? Math.round(request.amount) : -Math.round(request.amount)
      this.phase = 'acting'
      this.pushViewModel(request.ref === undefined
        ? `scrolling the page ${direction}`
        : `scrolling ${request.ref} ${direction}`)
      try {
        let moved = false
        let wheelPoint: { readonly x: number, readonly y: number }
        if (backendNodeId === undefined) {
          // Document scroll: the audited expression runs over the scrolling
          // element in the isolated world.
          const executionContextId = await this.ensureIsolatedWorld(client)
          const outcome = await this.runCdp('scrolling the document', candidate =>
            candidate.evaluateInContext(executionContextId, auditedExpressionDocumentScrollBy(delta)))
          const positions = outcome.value as { before?: number, after?: number } | undefined
          moved = typeof positions?.after === 'number' && positions.after !== positions.before
          const viewport = await this.readViewport(client, composed)
          wheelPoint = { x: viewport.width / 2, y: viewport.height / 2 }
        } else {
          const objectId = await this.resolveRef(backendNodeId, 'resolving the scroll target')
          this.assertActContinues(composed)
          const box = await this.boxForRef(client, backendNodeId, objectId, composed)
          wheelPoint = { x: box.x, y: box.y }
          const outcome = await this.runCdp('scrolling the element', candidate => candidate.callFunctionOn({
            objectId,
            functionDeclaration: auditedSnippetScrollBy(delta),
            returnByValue: true,
          }))
          const positions = outcome.value as { before?: number, after?: number } | undefined
          moved = typeof positions?.after === 'number' && positions.after !== positions.before
        }
        if (!moved) {
          // Custom scrollers swallow programmatic scrollBy; the trusted wheel
          // event at the same point reaches their real listeners (§4).
          this.assertActContinues(composed)
          this.noteOverlay({ cursor: wheelPoint })
          await this.runCdp('scrolling with the mouse wheel', candidate => candidate.dispatchMouseEvent({
            type: 'wheel', x: wheelPoint.x, y: wheelPoint.y, deltaX: 0, deltaY: delta,
          }))
        }
        return { generation: this.counter.current, performed: true }
      } finally {
        if (this.phase === 'acting') this.phase = 'observing'
        // Acts change the page without necessarily emitting a subscribed
        // mutation event (attribute edits, selection state): the next
        // browser_snapshot must re-read the tree, never serve the cache.
        this.counter.markDirty()
        this.cachedSnapshot = undefined
        this.pushViewModel()
      }
    })
  }

  async captureScreenshot(signal?: AbortSignal): Promise<AgentBrowserScreenshot> {
    return await this.runExclusive(async () => {
      const client = this.assertClient()
      signal?.throwIfAborted()
      const metrics = await client.getLayoutMetrics()
      const width = Math.max(1, Math.round(metrics.cssVisualViewport.clientWidth))
      const height = Math.max(1, Math.round(metrics.cssVisualViewport.clientHeight))
      const shot = await client.captureScreenshot({ width, height })
      // base64 → bytes without Node Buffer: manual decode keeps the module
      // portable across the Electron main process and test runners.
      const data = decodeBase64(shot.data)
      const scale = Math.min(1, 1280 / width)
      return {
        data,
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      }
    })
  }

  describe(): AgentBrowserLiveState {
    const open = this.windowHost !== undefined && !this.windowHost.isClosed()
    this.refreshPageIdentity()
    return {
      open,
      url: this.url,
      title: this.title,
      phase: this.phase,
      generation: this.counter.current,
    }
  }

  async close(): Promise<void> {
    await this.runExclusive(() => this.closeLocked())
  }

  private closeLocked(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    try {
      this.client?.detach()
    } catch (cause) {
      if (!(cause instanceof AgentBrowserCdpError)) throw cause
      // Detach races (target already gone) are benign during teardown.
    }
    this.client = undefined
    this.guest = undefined
    this.mainFrameId = undefined
    this.isolatedWorld = undefined
    this.claimReason = undefined
    this.overlay = undefined
    this.agentEpoch = new AbortController()
    const host = this.windowHost
    this.windowHost = undefined
    this.phase = 'idle'
    this.url = 'about:blank'
    this.title = ''
    this.cachedSnapshot = undefined
    host?.close()
    return Promise.resolve()
  }
}

/** Decode canonical base64 without Node globals. */
function decodeBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = value.replaceAll('=', '')
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let buffer = 0
  let bits = 0
  let offset = 0
  for (const character of clean) {
    const index = alphabet.indexOf(character)
    if (index < 0) continue
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[offset] = (buffer >> bits) & 0xff
      offset += 1
    }
  }
  return bytes.subarray(0, offset)
}
