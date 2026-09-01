import { Component, useEffect, type ReactNode } from 'react'
import { Globe, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { buttonVariants } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { cn } from '../lib/utils.ts'

const SCHEME = 'dsh-sso-gate:'

type Locale = 'en' | 'zh'
type Phase = 'ready' | 'waiting' | 'authenticated'

interface Copy {
  readonly title: string
  readonly lead: string
  readonly statusLabel: string
  readonly statusReady: string
  readonly statusWaiting: string
  readonly statusAuthenticated: string
  readonly signIn: string
  readonly signInAgain: string
  readonly errorTitle: string
  readonly gateBody: string
  readonly closeNotice: string
  /** Boundary fallback body — the renderer itself failed, not the handshake. */
  readonly renderFailure: string
}

const COPY: Record<Locale, Copy> = {
  en: {
    title: 'Deloitte DSH Desktop Sign In',
    lead: 'This build requires Deloitte single sign-on before it can start.',
    statusLabel: 'Status',
    statusReady: 'Automatic sign-in was not available. Use the browser sign-in below.',
    statusWaiting: 'Waiting for the browser sign-in to complete…',
    statusAuthenticated: 'Authenticated. Starting Deloitte DSH Desktop…',
    signIn: 'Sign in with Browser',
    signInAgain: 'Try Browser Sign-in Again',
    errorTitle: 'Sign-in attempt',
    gateBody: 'Deloitte DSH Desktop stays closed until single sign-on succeeds. Closing this window exits the application.',
    closeNotice: 'You can close this window to exit without signing in.',
    renderFailure: 'Sign-in window failed to render. Quit and start again.',
  },
  zh: {
    title: 'Deloitte DSH Desktop 登录',
    lead: '此版本需要完成德勤单点登录后才能启动。',
    statusLabel: '状态',
    statusReady: '自动登录不可用，请使用下方浏览器登录。',
    statusWaiting: '正在等待浏览器登录完成…',
    statusAuthenticated: '已认证，正在启动 Deloitte DSH Desktop…',
    signIn: '使用浏览器登录',
    signInAgain: '重试浏览器登录',
    errorTitle: '登录尝试',
    gateBody: '完成单点登录前，Deloitte DSH Desktop 不会启动。关闭此窗口将退出应用。',
    closeNotice: '可以关闭此窗口并退出，不登录也不会启动应用。',
    renderFailure: '登录窗口渲染失败，请退出后重新启动。',
  },
}

interface SsoGateState {
  readonly locale: Locale
  readonly phase: Phase
  readonly errorDetail?: string
}

const LOCALES: readonly Locale[] = ['en', 'zh']
const PHASES: readonly Phase[] = ['ready', 'waiting', 'authenticated']

function decodeState(): SsoGateState | undefined {
  const encoded = new URLSearchParams(window.location.search).get('state')
  if (encoded === null || encoded.length > 512_000) return undefined
  try {
    const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    // Strict shape check: an unexpected locale or phase would index COPY or
    // the status lookup with undefined and crash the renderer to a blank
    // window (issue #36 — `state=e30` reproduced it locally). A malformed
    // model must render the fallback card instead.
    if (!LOCALES.includes(record.locale as Locale)) return undefined
    if (!PHASES.includes(record.phase as Phase)) return undefined
    if (record.errorDetail !== undefined && typeof record.errorDetail !== 'string') return undefined
    return {
      locale: record.locale as Locale,
      phase: record.phase as Phase,
      ...(record.errorDetail === undefined ? {} : { errorDetail: record.errorDetail }),
    }
  } catch { /* Render the bounded fallback below. */ }
  return undefined
}

function signInHref(): string {
  return `${SCHEME}//sign-in`
}

/** Boundary fallback card: the renderer failed, but the window stays readable. */
export function SsoGateRenderFailure({ locale }: { readonly locale: Locale }): JSX.Element {
  return <main className="flex min-h-screen items-center justify-center p-6"><Alert variant="destructive"><AlertTitle>{COPY[locale].title}</AlertTitle><AlertDescription>{COPY[locale].renderFailure}</AlertDescription></Alert></main>
}

/** Best-effort locale for the boundary fallback; any malformed state is English. */
function boundaryLocale(): Locale {
  try {
    return decodeState()?.locale ?? 'en'
  } catch {
    return 'en'
  }
}

interface SsoGateErrorBoundaryState {
  readonly failed: boolean
}

/**
 * Minimal render boundary for the gate window (issue #36): a throwing child
 * must never leave a blank/black sign-in window with no visible diagnostic.
 * The other native-ui windows have no boundary yet, so this is the first —
 * deliberately a plain class component, the only React construct that can
 * intercept a child render error.
 */
export class SsoGateErrorBoundary
  extends Component<{ readonly children?: ReactNode }, SsoGateErrorBoundaryState> {
  override state: SsoGateErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): SsoGateErrorBoundaryState {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed
      ? <SsoGateRenderFailure locale={boundaryLocale()} />
      : this.props.children
  }
}

export function SsoGateApp(): JSX.Element {
  const state = decodeState()
  useEffect(() => { document.title = state === undefined ? 'Deloitte DSH Desktop Sign In' : COPY[state.locale].title }, [state])
  if (state === undefined) {
    return <main className="flex min-h-screen items-center justify-center p-6"><Alert variant="destructive"><AlertTitle>Deloitte DSH Desktop Sign In</AlertTitle><AlertDescription>The sign-in state could not be read. Quit and start Deloitte DSH Desktop again.</AlertDescription></Alert></main>
  }
  const copy = COPY[state.locale]
  const status = state.phase === 'waiting' ? copy.statusWaiting : state.phase === 'authenticated' ? copy.statusAuthenticated : copy.statusReady
  return <main className="flex min-h-screen items-center justify-center p-6">
    <div className="w-full max-w-lg space-y-4">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{copy.lead}</p>
      </header>
      <Card>
        <CardHeader><CardTitle>{copy.statusLabel}</CardTitle><CardDescription>{status}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {state.errorDetail === undefined ? null : (
            <Alert aria-live="polite" variant="destructive">
              <AlertTitle>{copy.errorTitle}</AlertTitle>
              <AlertDescription><span className="block break-words font-mono text-xs">{state.errorDetail}</span></AlertDescription>
            </Alert>
          )}
          {state.phase === 'authenticated'
            ? <p className="flex items-center gap-2 text-sm"><RefreshCw className="animate-spin" />{copy.statusAuthenticated}</p>
            : <a className={cn(buttonVariants({ variant: 'default' }), 'w-full')} href={signInHref()} onClick={event => { if (state.phase === 'waiting') event.preventDefault() }}>
                <Globe />{state.errorDetail === undefined ? copy.signIn : copy.signInAgain}
              </a>}
          <p className="text-xs text-muted-foreground">{copy.gateBody}</p>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">{copy.closeNotice}</p>
    </div>
  </main>
}
