/**
 * Typed minimal CDP client over `webContents.debugger` (design §3).
 *
 * Four domains are in scope for the capability overall — DOM, Runtime, Input,
 * Page — but this module implements ONLY the commands the current batch uses
 * (B1 read-only loop: DOM.enable/getDocument, Page lifecycle/navigate/screenshot).
 * Runtime isolated-world helpers and Input dispatch arrive with the act loop
 * (B2) as new typed methods on the same client.
 *
 * The client never talks to a websocket: `webContents.debugger` is the
 * transport, so the structural target interface below is exactly the Electron
 * `Debugger` surface we use, which also lets tests fake the protocol.
 *
 * @module dsh-plugin-desktop/agent-browser-cdp
 */

/** Structural subset of Electron's `webContents.debugger` used by the client. */
export interface AgentBrowserDebuggerTarget {
  /** Attach over one CDP protocol version. */
  attach(protocolVersion?: string): void
  /** Detach the session. */
  detach(): void
  /** Whether a debugger session is currently attached. */
  isAttached(): boolean
  /** Send one CDP command; resolves with the command's `returns` payload. */
  sendCommand(method: string, commandParams?: unknown, sessionId?: string): Promise<unknown>
  /** Instrumentation-event subscription (structural `Debugger.on`). */
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId: string) => void): unknown
  /** Remove an instrumentation-event subscription. */
  off(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId: string) => void): unknown
  /** Session-termination subscription (DevTools takeover, target loss). */
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  /** Remove a session-termination subscription. */
  off(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
}

/** CDP protocol version the client attaches with. */
export const AGENT_BROWSER_CDP_PROTOCOL_VERSION = '1.3'

/** One DOM node of a `DOM.getDocument` payload (structure we consume). */
export interface AgentBrowserCdpNode {
  readonly nodeId: number
  readonly backendNodeId?: number
  readonly parentId?: number
  /** Node type as in `Node.nodeType` (1 element, 3 text, 9 document, 11 fragment). */
  readonly nodeType: number
  /** Uppercase tag name for elements (`#document`, `#text` otherwise). */
  readonly nodeName: string
  /** Local name for elements (HTML documents lowercase it). */
  readonly localName?: string
  /** Text content for text nodes. */
  readonly nodeValue?: string
  /** Flat `[name, value, …]` attribute pairs. */
  readonly attributes?: readonly string[]
  readonly children?: readonly AgentBrowserCdpNode[]
  readonly shadowRoots?: readonly AgentBrowserCdpNode[]
  readonly templateContent?: AgentBrowserCdpNode
  readonly contentDocument?: AgentBrowserCdpNode
  readonly pseudoElements?: readonly AgentBrowserCdpNode[]
}

/** `DOM.getDocument` result. */
export interface AgentBrowserCdpGetDocumentResult {
  readonly root: AgentBrowserCdpNode
}

/** `Page.getFrameTree` frame node (only the main frame matters to us). */
export interface AgentBrowserCdpFrame {
  readonly id: string
  readonly parentId?: string
  readonly url: string
}

/** `Page.navigate` result. */
export interface AgentBrowserCdpNavigateResult {
  readonly frameId: string
  readonly loaderId?: string
  readonly errorText?: string
}

/** `Page.getLayoutMetrics` sizes we consume (CSS pixels). */
export interface AgentBrowserCdpLayoutMetrics {
  readonly cssVisualViewport: {
    readonly x: number
    readonly y: number
    readonly clientWidth: number
    readonly clientHeight: number
    readonly scale: number
  }
}

/** `Page.captureScreenshot` result (base64 payload). */
export interface AgentBrowserCdpScreenshotResult {
  readonly data: string
}

/** `Page.frameNavigated` event. */
export interface AgentBrowserCdpFrameNavigated {
  readonly frame: AgentBrowserCdpFrame
}

/** `Page.navigatedWithinDocument` event. */
export interface AgentBrowserCdpNavigatedWithinDocument {
  readonly frameId: string
  readonly url: string
}

/** `DOM.setChildNodes` event. */
export interface AgentBrowserCdpSetChildNodes {
  readonly parentId: number
  readonly nodes: readonly AgentBrowserCdpNode[]
}

/** `DOM.childNodeInserted` event. */
export interface AgentBrowserCdpChildNodeInserted {
  readonly parentNodeId: number
  readonly previousNodeId: number
  readonly node: AgentBrowserCdpNode
}

/** `DOM.childNodeRemoved` event. */
export interface AgentBrowserCdpChildNodeRemoved {
  readonly parentNodeId: number
  readonly nodeId: number
}

/** Typed event map over the raw `Debugger` message stream. */
export interface AgentBrowserCdpEvents {
  'Page.frameNavigated': AgentBrowserCdpFrameNavigated
  'Page.navigatedWithinDocument': AgentBrowserCdpNavigatedWithinDocument
  'Page.loadEventFired': Record<string, never>
  'Page.domContentEventFired': Record<string, never>
  'DOM.setChildNodes': AgentBrowserCdpSetChildNodes
  'DOM.childNodeInserted': AgentBrowserCdpChildNodeInserted
  'DOM.childNodeRemoved': AgentBrowserCdpChildNodeRemoved
  'DOM.shadowRootPushed': AgentBrowserCdpChildNodeInserted
  'DOM.shadowRootPopped': AgentBrowserCdpChildNodeRemoved
}

/** Event names the typed client accepts (extensible as later batches add domains). */
export type AgentBrowserCdpEventName = keyof AgentBrowserCdpEvents

/** Failure of a CDP command or session; retriable detachment races included. */
export class AgentBrowserCdpError extends Error {
  constructor(message: string, readonly method?: string) {
    super(message)
    this.name = 'AgentBrowserCdpError'
  }
}

/** Options of {@link AgentBrowserCdpClient.getDocument}. */
export interface AgentBrowserGetDocumentOptions {
  /** Maximum tree depth; the tightened default bounds main-process walk cost. */
  readonly depth?: number
  /** Whether shadow DOM and iframe documents are traversed. */
  readonly pierce?: boolean
}

/**
 * Typed four-domain client bound to one guest webContents' debugger.
 *
 * All commands funnel through {@link send}, which rejects non-object payloads
 * so a fake or hostile transport cannot smuggle a string into typed decoders.
 */
export class AgentBrowserCdpClient {
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly onMessage: (event: unknown, method: string, params: unknown, sessionId: string) => void
  private readonly onDetach: (event: unknown, reason: string) => void
  private detachReason: string | undefined
  private attached = false

  constructor(private readonly target: AgentBrowserDebuggerTarget) {
    this.onMessage = (_event, method, params) => {
      if (method === undefined) return
      const entry = this.listeners.get(method)
      if (entry === undefined) return
      for (const listener of [...entry]) listener(params)
    }
    this.onDetach = (_event, reason) => {
      this.detachReason = reason
      this.attached = false
    }
    this.target.on('message', this.onMessage)
    this.target.on('detach', this.onDetach)
  }

  /** Attach the session; a DevTools takeover surfaces as a typed error. */
  attach(): void {
    if (this.attached || this.target.isAttached()) {
      // Another session holding the debugger (guest DevTools belongs to the
      // human, design §7) is reported, not fought over.
      throw new AgentBrowserCdpError(
        this.detachReason === undefined
          ? 'a debugger session is already attached to the guest webContents'
          : `the previous debugger session detached (${this.detachReason}) and must be re-attached`,
      )
    }
    try {
      this.target.attach(AGENT_BROWSER_CDP_PROTOCOL_VERSION)
    } catch (cause) {
      throw new AgentBrowserCdpError(
        `attaching the guest debugger failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    this.attached = true
    this.detachReason = undefined
  }

  /** Detach the session and drop every typed listener registration. */
  detach(): void {
    for (const entry of this.listeners.values()) entry.clear()
    this.target.off('message', this.onMessage)
    this.target.off('detach', this.onDetach)
    if (this.attached && this.target.isAttached()) this.target.detach()
    this.attached = false
  }

  /** Subscribe to one typed CDP event; returns the unsubscriber. */
  on<Event extends AgentBrowserCdpEventName>(
    event: Event,
    listener: (params: AgentBrowserCdpEvents[Event]) => void,
  ): () => void {
    let entry = this.listeners.get(event)
    if (entry === undefined) {
      entry = new Set()
      this.listeners.set(event, entry)
    }
    const set = entry
    const wrapped = (params: unknown): void => { listener(params as AgentBrowserCdpEvents[Event]) }
    set.add(wrapped)
    return () => { set.delete(wrapped) }
  }

  /** Raw `sendCommand` with payload-shape and session-state checks. */
  private async send(method: string, params?: unknown): Promise<Record<string, unknown>> {
    if (!this.attached) {
      throw new AgentBrowserCdpError(
        this.detachReason === undefined
          ? `CDP command ${method} requested without an attached session`
          : `CDP command ${method} failed: the debugger session detached (${this.detachReason})`,
        method,
      )
    }
    let result: unknown
    try {
      result = await this.target.sendCommand(method, params)
    } catch (cause) {
      throw new AgentBrowserCdpError(
        `CDP command ${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        method,
      )
    }
    if (result === undefined || result === null) return {}
    if (typeof result !== 'object' || Array.isArray(result)) {
      throw new AgentBrowserCdpError(`CDP command ${method} returned a non-object payload`, method)
    }
    return result as Record<string, unknown>
  }

  /** `DOM.enable` — required before DOM commands and mutation events flow. */
  async domEnable(): Promise<void> {
    await this.send('DOM.enable')
  }

  /** `DOM.getDocument` with the tightened depth default (design §3). */
  async getDocument(options: AgentBrowserGetDocumentOptions = {}): Promise<AgentBrowserCdpGetDocumentResult> {
    const result = await this.send('DOM.getDocument', {
      depth: options.depth ?? 14,
      pierce: options.pierce ?? true,
    })
    const root = result.root
    if (root === undefined || typeof root !== 'object') {
      throw new AgentBrowserCdpError('DOM.getDocument returned no document root', 'DOM.getDocument')
    }
    return result as unknown as AgentBrowserCdpGetDocumentResult
  }

  /** `Page.enable` — required before Page events flow. */
  async pageEnable(): Promise<void> {
    await this.send('Page.enable')
  }

  /** `Page.navigate` the main frame. */
  async navigate(url: string): Promise<AgentBrowserCdpNavigateResult> {
    const result = await this.send('Page.navigate', { url })
    const errorText = result.errorText
    if (typeof errorText === 'string' && errorText.length > 0) {
      throw new AgentBrowserCdpError(`Page.navigate failed: ${errorText}`, 'Page.navigate')
    }
    return result as unknown as AgentBrowserCdpNavigateResult
  }

  /** `Page.setLifecycleEventsEnabled` — gates `loadEventFired` delivery. */
  async setLifecycleEventsEnabled(enabled: boolean): Promise<void> {
    await this.send('Page.setLifecycleEventsEnabled', { enabled })
  }

  /** `Page.getLayoutMetrics` for the CSS visual viewport. */
  async getLayoutMetrics(): Promise<AgentBrowserCdpLayoutMetrics> {
    const result = await this.send('Page.getLayoutMetrics')
    const viewport = (result as { cssVisualViewport?: unknown }).cssVisualViewport
    if (viewport === undefined || typeof viewport !== 'object') {
      throw new AgentBrowserCdpError('Page.getLayoutMetrics returned no CSS visual viewport', 'Page.getLayoutMetrics')
    }
    return result as unknown as AgentBrowserCdpLayoutMetrics
  }

  /** `Page.captureScreenshot` as JPEG quality 60, width downscaled ≤1280. */
  async captureScreenshot(viewport: { width: number, height: number }): Promise<AgentBrowserCdpScreenshotResult> {
    // CDP clip.scale performs the downscale at capture time — no raster
    // library on the main-process event loop (design §4 screenshot budget).
    // `scale` is mandatory whenever `clip` is present, and the clip must be
    // within the visual viewport (probe finding, 2026-09-03).
    const scale = Math.min(1, viewport.width <= 0 ? 1 : 1280 / viewport.width)
    const result = await this.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },
    })
    if (typeof result.data !== 'string' || result.data.length === 0) {
      throw new AgentBrowserCdpError('Page.captureScreenshot returned no image data', 'Page.captureScreenshot')
    }
    return result as unknown as AgentBrowserCdpScreenshotResult
  }
}
