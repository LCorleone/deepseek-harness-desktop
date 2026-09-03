/**
 * Agent-browser overlay: cursor dot + click highlight drawn from
 * host-known coordinates — the `getBoxModel` center before a click, the last
 * dispatched mouse point (design §5.4). Zero page injection anywhere: this
 * layer sits above the `<webview>` element in the EMBEDDER document and
 * never touches guest CSS.
 *
 * The click ring fades after {@link AGENT_BROWSER_CLICK_RING_MS}; the
 * component re-renders itself once on expiry so a stale ring cannot linger.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { AgentBrowserOverlayState } from '../../agent-browser-contract.ts'

/** How long the click highlight stays visible after `clickedAt`. */
export const AGENT_BROWSER_CLICK_RING_MS = 1_200

/**
 * The overlay layer. `now` is injectable so static rendering (tests, SSR)
 * can pin the clock against `clickedAt`.
 */
export function AgentBrowserOverlay({
  overlay,
  now = Date.now,
}: {
  readonly overlay: AgentBrowserOverlayState | undefined
  /** Clock used for the click-ring expiry; defaults to Date.now. */
  readonly now?: () => number
}): ReactNode {
  const [, setExpired] = useState(0)
  const clickedAt = overlay?.clickedAt
  useEffect(() => {
    if (clickedAt === undefined) return
    const remaining = AGENT_BROWSER_CLICK_RING_MS - (now() - clickedAt)
    if (remaining <= 0) return
    const timer = setTimeout(() => { setExpired(value => value + 1) }, remaining)
    return () => { clearTimeout(timer) }
    // The timer self-destructs once, when this ring expires.
  }, [clickedAt, now])

  const cursor = overlay?.cursor
  const click = overlay?.click
  const clickVisible = click !== undefined
    && clickedAt !== undefined
    && now() - clickedAt < AGENT_BROWSER_CLICK_RING_MS
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      aria-hidden
      data-agent-browser-overlay={cursor === undefined ? 'cursor-off' : 'cursor-on'}
    >
      {cursor === undefined ? null : (
        <div
          className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/90 bg-sky-400/90 shadow-sm shadow-black/40"
          style={{ left: `${String(cursor.x)}px`, top: `${String(cursor.y)}px` }}
          data-overlay-cursor=""
        />
      )}
      {clickVisible && click !== undefined ? (
        <div
          className="absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-300/90 opacity-90"
          style={{ left: `${String(click.x)}px`, top: `${String(click.y)}px` }}
          data-overlay-click=""
        />
      ) : null}
    </div>
  )
}
