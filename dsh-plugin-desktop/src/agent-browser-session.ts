/**
 * Agent-browser session: window/webview lifecycle, the ref+generation
 * mechanism, snapshot construction, waits, and serialization (design §1–§4).
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
  AgentBrowserLiveState,
  AgentBrowserPageInfo,
  AgentBrowserPhase,
  AgentBrowserScreenshot,
  AgentBrowserSnapshot,
  AgentBrowserViewModel,
  AgentBrowserViewport,
  AgentBrowserWaitOutcome,
  AgentBrowserWaitRequest,
  DesktopAgentBrowser,
} from './agent-browser-contract.ts'
import {
  AgentBrowserCdpClient,
  AgentBrowserCdpError,
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
      ...(actionDescription === undefined ? {} : { actionDescription }),
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
    signal?.throwIfAborted()
    const since = this.counter.current
    this.pushViewModel(`navigating to ${url}`)
    let loadFired = false
    const unsubscribeLoad = client.on('Page.loadEventFired', () => { loadFired = true })
    try {
      await client.navigate(url)
      if (waitForLoad) {
        await this.waitForCondition(() => loadFired, AGENT_BROWSER_WAIT_DEFAULT_TIMEOUT_MS, signal, () => {
          // Navigation completes even when the load event is late; the wait
          // is best-effort, the generation boundary is the navigate reply.
        })
      }
      this.counter.noteOperationCompletion(since)
      this.cachedSnapshot = undefined
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
