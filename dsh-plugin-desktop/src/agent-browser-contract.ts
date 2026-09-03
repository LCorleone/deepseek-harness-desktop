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

/** Window→main channel signalling the human claimed control (consumed in B2). */
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
  /** Human-readable description of the in-flight action, when any. */
  readonly actionDescription?: string
}

/** Guest viewport size in CSS pixels. */
export interface AgentBrowserViewport {
  readonly width: number
  readonly height: number
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
  /** Capture the viewport as JPEG bytes (persistence happens plugin-side). */
  captureScreenshot(signal?: AbortSignal): Promise<AgentBrowserScreenshot>
  /** Current surface state for the dynamic prompt context. */
  describe(): AgentBrowserLiveState
  /** Tear down debugger session and window. */
  close(): Promise<void>
}

/** Capability exposed by the context-isolated agent-browser preload. */
export interface AgentBrowserBridge {
  /** Subscribe to pushed view models; returns an unsubscribe function. */
  onState(callback: (state: AgentBrowserViewModel) => void): () => void
  /** Ask the operator to take over (state machine lands in B2). */
  claimControl(): void
  /** Return control to the agent (state machine lands in B2). */
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
