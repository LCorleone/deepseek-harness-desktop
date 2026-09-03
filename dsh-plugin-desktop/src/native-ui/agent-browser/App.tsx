/**
 * Agent-browser window UI: a minimal toolbar, the `<webview>` host, and the
 * zero-injection overlay.
 *
 * The `<webview>` element is created imperatively (React has no intrinsic
 * typing for it) from the pushed view model: the partition token is rendered
 * host-side and never hand-authored here, and the element is remounted
 * whenever the token changes, honoring Electron's "partition only before the
 * first navigation" rule. The toolbar's claim/release buttons are the B2
 * window-side entry points of the claim state machine (§5.4) — the human
 * takes over at any moment, and control returns with a generation bump.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Globe, Hand, MousePointerClick, X } from 'lucide-react'
import {
  DESKTOP_AGENT_BROWSER_BRIDGE,
  type AgentBrowserBridge,
  type AgentBrowserViewModel,
  type AgentBrowserBridgeWindow,
} from '../../agent-browser-contract.ts'
import { AgentBrowserOverlay } from './Overlay.tsx'

/** The bridge window, resolved lazily so static rendering (tests) never touches it. */
const bridge = (): AgentBrowserBridge | undefined => {
  if (typeof window === 'undefined') return undefined
  return (window as AgentBrowserBridgeWindow & typeof globalThis)[DESKTOP_AGENT_BROWSER_BRIDGE]
}

const COPY = {
  claim: 'Claim control',
  claimHint: 'Take the mouse and keyboard from the agent',
  release: 'Release control',
  releaseHint: 'Hand the browser back to the agent',
  generation: 'generation',
  placeholder: 'No page opened yet',
} as const

/**
 * Toolbar row: URL line, generation chip, claim/release (§5.4), close.
 * Exported for the static-render spec.
 */
export function AgentBrowserToolbar({
  state,
  onClaim,
  onRelease,
  onClose,
}: {
  readonly state: AgentBrowserViewModel | undefined
  readonly onClaim: () => void
  readonly onRelease: () => void
  readonly onClose: () => void
}): ReactNode {
  const claimed = state?.phase === 'claimed'
  return (
    <header
      className="flex items-center gap-3 border-b border-border bg-background px-3 py-2"
      aria-label="Agent browser toolbar"
    >
      <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        className="min-w-0 flex-1 truncate rounded-md border border-input bg-muted/40 px-2 py-1 font-mono text-xs text-foreground"
        value={state === undefined ? COPY.placeholder : state.url}
        readOnly
        aria-label="Current page URL"
        spellCheck={false}
      />
      <span
        className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground"
        data-toolbar-phase={state === undefined ? 'unknown' : state.phase}
      >
        {COPY.generation} {state === undefined ? '—' : state.generation}
        {state === undefined ? '' : ` · ${state.phase}`}
      </span>
      {claimed ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-sky-400/60 bg-sky-500/15 px-2 py-1 text-xs font-medium text-foreground hover:bg-sky-500/25"
          onClick={onRelease}
          title={COPY.releaseHint}
          data-claim-button="release"
        >
          <Hand className="size-3.5" aria-hidden />
          {COPY.release}
        </button>
      ) : (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50"
          onClick={onClaim}
          disabled={state === undefined}
          title={state === undefined ? COPY.placeholder : COPY.claimHint}
          data-claim-button="claim"
        >
          <MousePointerClick className="size-3.5" aria-hidden />
          {COPY.claim}
        </button>
      )}
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground hover:bg-accent"
        onClick={onClose}
      >
        <X className="size-3.5" aria-hidden />
        Close
      </button>
    </header>
  )
}

/**
 * The `<webview>` host. The element mounts once per partition token with
 * `src="about:blank"` (a src-less webview never attaches — day-1 spike
 * finding); every real navigation is driven from the main process via CDP.
 */
function WebviewHost({ partition }: { readonly partition: string }): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    host.replaceChildren()
    const webview = document.createElement('webview')
    webview.setAttribute('partition', partition)
    webview.setAttribute('src', 'about:blank')
    webview.setAttribute('allowpopups', 'false')
    webview.className = 'h-full w-full border-0'
    host.appendChild(webview)
  }, [partition])
  return <div ref={hostRef} className="min-h-0 flex-1" />
}

export function AgentBrowserApp(): ReactNode {
  const [state, setState] = useState<AgentBrowserViewModel | undefined>(undefined)
  useEffect(() => {
    const bridgeWindow = bridge()
    if (bridgeWindow === undefined) return
    return bridgeWindow.onState(next => { setState(next) })
  }, [])
  const close = (): void => { bridge()?.closeWindow() }
  const claim = (): void => { bridge()?.claimControl() }
  const release = (): void => { bridge()?.releaseControl() }
  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <AgentBrowserToolbar state={state} onClaim={claim} onRelease={release} onClose={close} />
      {state === undefined
        ? <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Waiting for the desktop host…
          </div>
        : (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <WebviewHost partition={state.partition} />
            {/*
              The overlay must sit exactly over the webview content box: the
              pushed coordinates are CSS pixels in the GUEST viewport, whose
              origin is the webview element's top-left corner — the same box
              this relative container fills.
            */}
            <AgentBrowserOverlay overlay={state.overlay} />
          </div>
          )}
    </main>
  )
}
