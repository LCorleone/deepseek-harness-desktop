/**
 * Shared contract of the P8 agent-browser surface (design:
 * `.agents/notes/proposed/architecture/2026-09-03-agent-browser.md`).
 *
 * This module is deliberately runtime-pure: it must stay importable from the
 * sandboxed native-ui renderer (which has no Node globals and must never pull
 * a main-process module into its bundle), so every import here is type-only
 * and every export is either a constant or a type.
 *
 * @module dsh-plugin-desktop/agent-browser-contract
 */

import type { Context } from '@deepseek-ai/cordis'
import type { DesktopPolicy } from './desktop-policy.ts'

/** Same-origin loopback route the Web client banner reads (registered in B3). */
export const DESKTOP_AGENT_BROWSER_STATE_PATH = '/_dsh/desktop/agent-browser/state'

/** Same-origin loopback route the Web client banner claims control through (B3). */
export const DESKTOP_AGENT_BROWSER_CLAIM_PATH = '/_dsh/desktop/agent-browser/claim'

/** Same-origin loopback route the Web client banner releases control through (B3). */
export const DESKTOP_AGENT_BROWSER_RELEASE_PATH = '/_dsh/desktop/agent-browser/release'

/** Same-origin SSE route streaming browser frames to the Web client (B3). */
export const DESKTOP_AGENT_BROWSER_EVENTS_PATH = '/_dsh/desktop/agent-browser/events'

/** Main→window channel carrying serialized view-model snapshots. */
export const DESKTOP_AGENT_BROWSER_STATE_CHANNEL = 'dsh-agent-browser/state'

/** Window→main channel signalling the human claimed control (§5.4, B2). */
export const DESKTOP_AGENT_BROWSER_CLAIM_CHANNEL = 'dsh-agent-browser/claim'

/** Window→main channel signalling the human released control (consumed in B2). */
export const DESKTOP_AGENT_BROWSER_RELEASE_CHANNEL = 'dsh-agent-browser/release'

/** Window→main channel requesting window close from the toolbar. */
export const DESKTOP_AGENT_BROWSER_CLOSE_CHANNEL = 'dsh-agent-browser/close'

/** Main-world key of the context-isolated agent-browser bridge. */
export const DESKTOP_AGENT_BROWSER_BRIDGE = '__DSH_DESKTOP_AGENT_BROWSER__'

/** Lifecycle phase of the browser surface (design §2). */
export type AgentBrowserPhase = 'idle' | 'observing' | 'acting' | 'claimed'

/**
 * View model pushed to the browser window document. `partition` rides the
 * model so the `<webview>` attribute is rendered from host-minted tokens and
 * never hand-authored in the document (design §1); the window's
 * `will-attach-webview` guard re-asserts the same token as the fallback.
 */
export interface AgentBrowserViewModel {
  /** Current main-frame URL (`about:blank` until the first navigation). */
  readonly url: string
  /** Current document title. */
  readonly title: string
  /** Current lifecycle phase. */
  readonly phase: AgentBrowserPhase
  /** Monotonic navigation counter; refs are only valid within one generation. */
  readonly generation: number
  /** Guest partition token the `<webview>` element must be mounted with. */
  readonly partition: string
  /** Executor-known overlay coordinates (cursor dot, click highlight). */
  readonly overlay?: AgentBrowserOverlayState
  /** Human-readable description of the in-flight action, when any. */
  readonly actionDescription?: string
}

/** Guest viewport size in CSS pixels. */
export interface AgentBrowserViewport {
  readonly width: number
  readonly height: number
}

/** One host-known point in guest-viewport CSS pixels (design §5.4). */
export interface AgentBrowserOverlayPoint {
  readonly x: number
  readonly y: number
}

/**
 * Overlay state pushed to the window document: the executor's known
 * coordinates (getBoxModel centers, last dispatched mouse point). The
 * native overlay layer draws from these — zero page CSS injection anywhere.
 */
export interface AgentBrowserOverlayState {
  readonly cursor?: AgentBrowserOverlayPoint
  readonly click?: AgentBrowserOverlayPoint
  /** Epoch milliseconds of the click highlight; the overlay fades it. */
  readonly clickedAt?: number
}

/** Result of `browser_snapshot` (the OBSERVE primitive, design §3–4). */
export interface AgentBrowserSnapshot {
  readonly url: string
  readonly title: string
  readonly generation: number
  readonly viewport: AgentBrowserViewport
  /** Whether the projected tree hit the node budget and was truncated. */
  readonly truncated: boolean
  /** Text projection of the DOM tree with `e<base36>` refs. */
  readonly tree: string
}

/** Live surface state projected into the dynamic system-prompt context. */
export interface AgentBrowserLiveState {
  /** Whether a browser window with a mounted guest currently exists. */
  readonly open: boolean
  readonly url: string
  readonly title: string
  readonly phase: AgentBrowserPhase
  readonly generation: number
}

/** Page identity returned by `browser_open` / `browser_navigate`. */
export interface AgentBrowserPageInfo {
  readonly url: string
  readonly title: string
  readonly generation: number
}

/** Arguments of `browser_wait`. */
export interface AgentBrowserWaitRequest {
  /** Plain dwell time in milliseconds. */
  readonly ms?: number
  /** Lifecycle condition: `load` waits for the next load event; `settle` waits for a quiet window. */
  readonly until?: 'load' | 'settle'
  /** Cooperative cap for the wait itself; defaults to the executor's cap. */
  readonly timeoutMs?: number
}

/** Result of `browser_wait`. */
export interface AgentBrowserWaitOutcome {
  readonly generation: number
  readonly waited: number
}

/** Full surface snapshot streamed as a `state` frame (§2, B3). */
export interface AgentBrowserStateFrame {
  readonly kind: 'state'
  /** Whether a live window host exists — false is how observers learn the surface closed (B3 review P2). */
  readonly open: boolean
  readonly url: string
  readonly title: string
  readonly phase: AgentBrowserPhase
  readonly generation: number
}

/** Main-frame navigation boundary streamed to loopback observers (§2, B3). */
export interface AgentBrowserNavigationFrame {
  readonly kind: 'navigation'
  readonly url: string
  readonly generation: number
}

/** The observed state was invalidated (mutation); URL/generation unchanged (§2, B3). */
export interface AgentBrowserStaleFrame {
  readonly kind: 'stale'
  readonly generation: number
}

/** One SSE frame of `/_dsh/desktop/agent-browser/events` (renderer-safe: no partition token). */
export type AgentBrowserEventFrame =
  | AgentBrowserStateFrame
  | AgentBrowserNavigationFrame
  | AgentBrowserStaleFrame

/** Renderer-safe login-persistence projection (§5.2, B3). */
export interface AgentBrowserLoginView {
  /** Whether login persistence is enabled (applies at the next window creation). */
  readonly persistLogin: boolean
  /** Whether a persist UUID (and therefore a persist partition) exists. */
  readonly persisted: boolean
  /** Whether the live browser window, if any, currently runs on the persist partition. */
  readonly windowOnPersistPartition: boolean
}

/** Mouse button of `browser_click` (CDP button names). */
export type AgentBrowserMouseButton = 'left' | 'middle' | 'right'

/** Arguments of `browser_click` (design §4). */
export interface AgentBrowserClickRequest {
  readonly ref: string
  readonly generation?: number
  readonly button?: AgentBrowserMouseButton
  readonly clickCount?: number
}

/** Arguments of `browser_type` (design §4). */
export interface AgentBrowserTypeRequest {
  readonly ref: string
  readonly text: string
  readonly generation?: number
  readonly clear?: boolean
  readonly submit?: boolean
}

/** Scroll direction of `browser_scroll` (design §4). */
export type AgentBrowserScrollDirection = 'up' | 'down'

/** Arguments of `browser_scroll` (design §4). */
export interface AgentBrowserScrollRequest {
  readonly ref?: string
  readonly direction: AgentBrowserScrollDirection
  readonly amount: number
  readonly generation?: number
}

/** Shared result of every act tool. */
export interface AgentBrowserActionResult {
  readonly generation: number
  readonly performed: boolean
}

/** Captured screenshot bytes before attachment persistence (design §2). */
export interface AgentBrowserScreenshot {
  /** JPEG bytes (quality 60, width downscaled to ≤1280 at capture time). */
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/**
 * The narrow Electron-main executor behind `ctx.desktopAgentBrowser`
 * (constructed in `src/main.ts`, design §2). Host plugins call these typed
 * methods in-process; observation never injects page script.
 */
export interface DesktopAgentBrowser {
  /** Create window/webview/guest as needed and navigate to `url`. */
  open(url: string, options: { readonly waitForLoad?: boolean }, signal?: AbortSignal): Promise<AgentBrowserPageInfo>
  /** Navigate the live page to `url`. */
  navigate(url: string, signal?: AbortSignal): Promise<AgentBrowserPageInfo>
  /** Build a DOM text snapshot; a stale `generation` fails `STALE_SNAPSHOT`. */
  snapshot(generation: number | undefined, signal?: AbortSignal): Promise<AgentBrowserSnapshot>
  /** Wait for a dwell time or a lifecycle condition. */
  wait(request: AgentBrowserWaitRequest, signal?: AbortSignal): Promise<AgentBrowserWaitOutcome>
  /** Click the box-model center of one ref via trusted Input events. */
  click(request: AgentBrowserClickRequest, signal?: AbortSignal): Promise<AgentBrowserActionResult>
  /** Focus a ref and insert text; password targets hard-fail (§5.3c). */
  type(request: AgentBrowserTypeRequest, signal?: AbortSignal): Promise<AgentBrowserActionResult>
  /** Scroll one ref (or the document) by `amount` px; wheel fallback. */
  scroll(request: AgentBrowserScrollRequest, signal?: AbortSignal): Promise<AgentBrowserActionResult>
  /**
   * Best-effort §5.1 classifier: whether one `#e…` ref resolves to a
   * form-submit control (`<button>`/`<input type=submit|image>` inside a
   * form). Resolves the ref in the isolated world; false when unknown/dead.
   */
  isSubmitControl(ref: string): Promise<boolean>
  /** Human takes over: aborts in-flight agent input, act tools fail fast (§5.4). */
  claimControl(reason?: string): void
  /** Human hands control back: generation bump (the page likely changed). */
  releaseControl(): void
  /** Capture the viewport as JPEG bytes (persistence happens plugin-side). */
  captureScreenshot(signal?: AbortSignal): Promise<AgentBrowserScreenshot>
  /** Current surface state for the dynamic prompt context. */
  describe(): AgentBrowserLiveState
  /** Observe surface frames (state/navigation/stale, all carrying phase-relevant state); returns unsubscribe. */
  subscribe(listener: (frame: AgentBrowserEventFrame) => void): () => void
  /** Login-persistence projection for the settings surface (§5.2). */
  describeLogin(): AgentBrowserLoginView
  /** Toggle login persistence; the persist UUID is minted once at first enable (§5.2). */
  setPersistLogin(enabled: boolean): Promise<AgentBrowserLoginView>
  /** Clear login state: close, wipe storage + partition directory, rotate the UUID (§5.2). */
  clearLoginState(): Promise<AgentBrowserLoginView>
  /**
   * Enforce the persist-login policy over residual state (§5.2, B3 review):
   * when the policy denies persistence but the login document still carries
   * a persist UUID, wipe that partition once and rotate the UUID.
   */
  enforceLoginPersistencePolicy(): Promise<void>
  /** Tear down debugger session and window. */
  close(): Promise<void>
}

/** Capability exposed by the context-isolated agent-browser preload. */
export interface AgentBrowserBridge {
  /** Subscribe to pushed view models; returns an unsubscribe function. */
  onState(callback: (state: AgentBrowserViewModel) => void): () => void
  /** Ask the operator to take over (the §5.4 claim state machine, B2). */
  claimControl(): void
  /** Return control to the agent (generation bumps on release, B2). */
  releaseControl(): void
  /** Close the browser window from the toolbar. */
  closeWindow(): void
}

/** Window shape consumed by the agent-browser renderer. */
export interface AgentBrowserBridgeWindow {
  readonly [DESKTOP_AGENT_BROWSER_BRIDGE]?: AgentBrowserBridge
}

/** Keeps the augmentation target resolved through the package entry (see pnpm class issues). */
export type AgentBrowserCordisContext = Context

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-provided embedded desktop policy (`hostCtx.provide` in src/main.ts). */
    desktopPolicy: DesktopPolicy
    /** Electron-main agent-browser executor (window/webview/CDP lifecycle). */
    desktopAgentBrowser: DesktopAgentBrowser
  }
}
