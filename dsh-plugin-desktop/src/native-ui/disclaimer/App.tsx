import { Component, useEffect, type ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { buttonVariants } from '../components/ui/button.tsx'
import { cn } from '../lib/utils.ts'


/** Fixed window chrome (the statement itself travels in the view model). */
const WORDMARK_BRAND = 'DSH'
const WORDMARK_REST = 'Desktop'
const BUTTON_DISAGREE = '不同意'
const BUTTON_AGREE = '同意'
const FALLBACK_TITLE = '内测声明'
const FALLBACK_BODY = '声明内容读取失败，请退出后重新启动 Deloitte DSH Desktop。'
/** Boundary fallback body — the renderer itself failed, not the gate. */
const RENDER_FAILURE_BODY = '声明窗口渲染失败，请退出后重新启动 Deloitte DSH Desktop。'

interface DisclaimerState {
  readonly title: string
  readonly items: readonly string[]
}

function decodeState(): DisclaimerState | undefined {
  const encoded = new URLSearchParams(window.location.search).get('state')
  if (encoded === null || encoded.length > 512_000) return undefined
  try {
    const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    // Strict shape check (the sso gate's issue #36 lesson): an unexpected
    // model must render the fallback card, never crash the renderer to a
    // blank window the user cannot dismiss or decide on.
    if (typeof record.title !== 'string' || record.title.length === 0) return undefined
    if (!Array.isArray(record.items) || record.items.length === 0) return undefined
    if (!record.items.every(item => typeof item === 'string')) return undefined
    return { title: record.title, items: record.items as readonly string[] }
  } catch { /* Render the bounded fallback below. */ }
  return undefined
}

/** The preload IPC bridge (disclaimer-preload.cjs). The v1 scheme-anchor
 * transport is dead in packaged sandboxed renderers — this is the transport. */
declare global {
  interface Window {
    readonly desktopDisclaimerBridge?: { readonly decide: (action: 'agree' | 'disagree') => void }
  }
}

const BRIDGE_MISSING_NOTICE = '界面组件加载异常：决策通道未就绪。请截图此窗口并联系管理员（cndchatgen@deloittecn.com.cn）。'

/** Visible degradation (review P1): a missing bridge must never be a silent
 * dead button — the #63 incident's exact symptom. console.error rides the
 * window's console-message observability into the desktop log. */
function bridgeMissing(): boolean {
  if (window.desktopDisclaimerBridge !== undefined) return false
  console.error('disclaimer bridge missing: the preload did not load — decisions cannot be delivered')
  return true
}

function decide(action: 'agree' | 'disagree'): void {
  window.desktopDisclaimerBridge?.decide(action)
}

/** Boundary fallback card: the renderer failed, but the window stays readable. */
export function DisclaimerRenderFailure(): JSX.Element {
  return <main className="flex min-h-screen items-center justify-center p-6"><Alert variant="destructive"><AlertTitle>{FALLBACK_TITLE}</AlertTitle><AlertDescription>{RENDER_FAILURE_BODY}</AlertDescription></Alert></main>
}

interface DisclaimerErrorBoundaryState {
  readonly failed: boolean
}

/**
 * Minimal render boundary for the disclaimer window (the sso gate's issue
 * #36 defense): a throwing child must leave a visible card, not a blank
 * window standing between the user and the desktop.
 */
export class DisclaimerErrorBoundary
  extends Component<{ readonly children?: ReactNode }, DisclaimerErrorBoundaryState> {
  override state: DisclaimerErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): DisclaimerErrorBoundaryState {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed
      ? <DisclaimerRenderFailure />
      : this.props.children
  }
}

export function DisclaimerApp(): JSX.Element {
  const state = decodeState()
  const degraded = bridgeMissing()
  useEffect(() => { document.title = state === undefined ? FALLBACK_TITLE : state.title }, [state])
  if (state === undefined) {
    return <main className="flex min-h-screen items-center justify-center p-6"><Alert variant="destructive"><AlertTitle>{FALLBACK_TITLE}</AlertTitle><AlertDescription>{FALLBACK_BODY}</AlertDescription></Alert></main>
  }
  return <main className="flex h-screen flex-col">
    <header className="dshDisclaimerHeader">
      <span className="dshDisclaimerWordmark"><span className="dshDisclaimerWordmarkBrand">{WORDMARK_BRAND}</span> {WORDMARK_REST}</span>
    </header>
    <section className="flex-1 overflow-y-auto" aria-label={state.title}>
      <div className="mx-auto w-full max-w-2xl space-y-4 px-6 py-6">
        <h1 className="text-xl font-semibold tracking-tight">{state.title}</h1>
        <ol className="space-y-3">
          {state.items.map((item, index) => (
            <li key={index} className="flex gap-2 text-sm leading-relaxed">
              <span className="dshDisclaimerMarker flex-none" aria-hidden="true">{String(index + 1)}.</span>
              <span className="whitespace-pre-line">{item}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
    <footer className="dshDisclaimerFooter">
      {degraded ? <p className="mx-auto w-full max-w-2xl px-6 pt-2 text-xs text-red-400" role="alert">{BRIDGE_MISSING_NOTICE}</p> : null}
      <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-3 px-6 py-4">
        <button type="button" disabled={degraded} className={cn(buttonVariants({ variant: 'outline' }), 'h-10 px-6')} onClick={() => { decide('disagree') }}>{BUTTON_DISAGREE}</button>
        <button type="button" disabled={degraded} className={cn(buttonVariants({ variant: 'default' }), 'dshDisclaimerPrimary h-10 px-6')} onClick={() => { decide('agree') }}>{BUTTON_AGREE}</button>
      </div>
    </footer>
  </main>
}
