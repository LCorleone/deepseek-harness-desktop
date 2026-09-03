/**
 * Agent-browser window UI: a minimal toolbar plus the `<webview>` host.
 *
 * B1 scope is deliberately minimal — URL line, generation, close, and a
 * disabled claim placeholder. The `<webview>` element is created
 * imperatively (React has no intrinsic typing for it) from the pushed view
 * model: the partition token is rendered host-side and never hand-authored
 * here, and the element is remounted whenever the token changes, honoring
 * Electron's "partition only before the first navigation" rule.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Globe, MousePointerClick, X } from 'lucide-react'
import {
  DESKTOP_AGENT_BROWSER_BRIDGE,
  type AgentBrowserViewModel,
  type AgentBrowserBridgeWindow,
} from '../../agent-browser-contract.ts'

const windowWithBridge = window as AgentBrowserBridgeWindow & typeof globalThis

interface Copy {
  readonly claim: string
  readonly claimPending: string
  readonly generation: string
  readonly placeholder: string
}

const COPY: Copy = {
  claim: 'Claim control',
  claimPending: 'Claim control (arrives with the act loop)',
  generation: 'generation',
  placeholder: 'No page opened yet',
}

/** Toolbar row: URL line, generation chip, claim placeholder, close. */
function Toolbar({ state, onClose }: {
  readonly state: AgentBrowserViewModel | undefined
  readonly onClose: () => void
}): ReactNode {
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
      <span className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
        {COPY.generation} {state === undefined ? '—' : state.generation}
        {state === undefined ? '' : ` · ${state.phase}`}
      </span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground"
        disabled
        title={COPY.claimPending}
      >
        <MousePointerClick className="size-3.5" aria-hidden />
        {COPY.claim}
      </button>
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
    const bridge = windowWithBridge[DESKTOP_AGENT_BROWSER_BRIDGE]
    if (bridge === undefined) return
    return bridge.onState(next => { setState(next) })
  }, [])
  const close = (): void => {
    windowWithBridge[DESKTOP_AGENT_BROWSER_BRIDGE]?.closeWindow()
  }
  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Toolbar state={state} onClose={close} />
      {state === undefined
        ? <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Waiting for the desktop host…
          </div>
        : <WebviewHost partition={state.partition} />}
    </main>
  )
}
