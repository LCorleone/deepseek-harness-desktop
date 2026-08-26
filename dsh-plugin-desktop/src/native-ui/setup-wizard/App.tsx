import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Bell,
  Check,
  Globe2,
  Monitor,
  PanelsTopLeft,
  SkipForward,
} from 'lucide-react'
import {
  desktopSetupWizardRequiresLanAcknowledgement,
  isDesktopSetupWizardInput,
  type DesktopSetupWizardInput,
  type DesktopSetupWizardMarket,
  type DesktopSetupWizardMode,
  type DesktopSetupWizardNetworkExposure,
  type DesktopSetupWizardNotifications,
  type DesktopSetupWizardSelection,
} from '../../setup-wizard-contract.ts'
import { desktopSetupWizardCopy, type DesktopSetupWizardCopy } from '../../setup-wizard-copy.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.tsx'
import { Label } from '../components/ui/label.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.tsx'
import { DesktopFrame } from '../shared/DesktopFrame.tsx'

const SCHEME = 'dsh-setup-wizard:'
const MAX_STATE_CHARACTERS = 32 * 1024

type Locale = 'en' | 'zh'

function localLocale(search: string): Locale {
  return new URLSearchParams(search).get('locale') === 'zh' ? 'zh' : 'en'
}

function decodeBase64Url(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_STATE_CHARACTERS || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    return undefined
  }
  const standard = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = standard.padEnd(standard.length + (4 - standard.length % 4) % 4, '=')
  try {
    const binary = window.atob(padded)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** Decode only the exact state/query tuple emitted by DesktopSetupWizardWindow. */
export function decodeDesktopSetupWizardInput(search: string): DesktopSetupWizardInput | undefined {
  const query = new URLSearchParams(search)
  const expected = ['locale', 'state', 'platform', 'frame']
  const keys = [...query.keys()]
  if (keys.length !== expected.length
    || keys.some(key => !expected.includes(key))
    || expected.some(key => query.getAll(key).length !== 1)) return undefined
  const locale = query.get('locale')
  const frame = query.get('frame')
  if ((locale !== 'en' && locale !== 'zh') || (frame !== 'true' && frame !== 'false')) return undefined
  const state = query.get('state')
  if (state === null) return undefined
  const decoded = decodeBase64Url(state)
  if (decoded === undefined) return undefined
  let value: unknown
  try { value = JSON.parse(decoded) as unknown } catch { return undefined }
  if (!isDesktopSetupWizardInput(value) || query.get('platform') !== value.platform) return undefined
  return value
}

function normalizedSelection(input: DesktopSetupWizardInput): DesktopSetupWizardSelection {
  return {
    mode: input.platform === 'linux' ? 'compatibility' : input.mode,
    macosMaterial: input.macosMaterial,
    windowsMaterial: input.platform === 'win32' && input.windowsMaterial === 'mica' && !input.micaSupported
      ? 'acrylic'
      : input.windowsMaterial,
    openBrowser: input.openBrowser,
    networkExposure: input.networkExposure,
    market: input.market,
    notifications: { ...input.notifications },
  }
}

function finish(selection: DesktopSetupWizardSelection): void {
  const url = new URL(`${SCHEME}//complete`)
  url.searchParams.set('mode', selection.mode)
  url.searchParams.set('macosMaterial', selection.macosMaterial)
  url.searchParams.set('windowsMaterial', selection.windowsMaterial)
  url.searchParams.set('openBrowser', String(selection.openBrowser))
  url.searchParams.set('networkExposure', selection.networkExposure)
  url.searchParams.set('market', selection.market)
  url.searchParams.set('notificationsEnabled', String(selection.notifications.enabled))
  url.searchParams.set('notifyOnTurnCompletion', String(selection.notifications.notifyOnTurnCompletion))
  url.searchParams.set('notifyOnTurnFailure', String(selection.notifications.notifyOnTurnFailure))
  url.searchParams.set('notifyOnJobCompletion', String(selection.notifications.notifyOnJobCompletion))
  url.searchParams.set('notifyOnJobFailure', String(selection.notifications.notifyOnJobFailure))
  window.location.assign(url.href)
}

function Choice({
  title,
  body,
  selected,
  disabled = false,
  onSelect,
}: {
  readonly title: string
  readonly body: string
  readonly selected: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}): JSX.Element {
  return <button
    aria-checked={selected}
    className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30 ${selected ? 'border-primary bg-muted/70' : 'hover:bg-muted/40'}`}
    disabled={disabled}
    onClick={onSelect}
    role="radio"
    type="button"
  >
    <span aria-hidden="true" className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/60'}`}>{selected ? <Check className="size-3" /> : null}</span>
    <span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{body}</span></span>
  </button>
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  readonly label: string
  readonly description?: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
}): JSX.Element {
  return <div className="flex items-center justify-between gap-5 border-b py-3 last:border-b-0">
    <span className="min-w-0"><span className="block text-sm font-medium">{label}</span>{description === undefined ? null : <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{description}</span>}</span>
    <button
      aria-checked={checked}
      aria-label={label}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 ${checked ? 'border-primary bg-primary' : 'bg-muted'}`}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
      role="switch"
      type="button"
    ><span aria-hidden="true" className={`absolute top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} /></button>
  </div>
}

function PageCard({ title, body, children }: {
  readonly title: string
  readonly body: string
  readonly children: ReactNode
}): JSX.Element {
  return <Card><CardHeader className="pb-4"><CardTitle>{title}</CardTitle><CardDescription>{body}</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>
}

function AppearancePanel({
  copy,
  input,
  selection,
  update,
}: {
  readonly copy: DesktopSetupWizardCopy
  readonly input: DesktopSetupWizardInput
  readonly selection: DesktopSetupWizardSelection
  readonly update: (selection: DesktopSetupWizardSelection) => void
}): JSX.Element {
  const modes: readonly { readonly value: DesktopSetupWizardMode; readonly title: string; readonly body: string }[] = [
    { value: 'compatibility', title: copy.compatibilityMode, body: copy.compatibilityModeBody },
    { value: 'extended', title: copy.extendedMode, body: input.platform === 'linux' ? copy.unavailableOnLinux : copy.extendedModeBody },
    { value: 'advanced', title: copy.advancedMode, body: input.platform === 'linux' ? copy.unavailableOnLinux : copy.advancedModeBody },
  ]
  const material = input.platform === 'darwin' ? selection.macosMaterial
    : input.platform === 'win32' ? selection.windowsMaterial : 'off'
  return <div className="space-y-4 py-4">
    <PageCard body={copy.presentationBody} title={copy.presentationTitle}><div className="grid gap-3 sm:grid-cols-3" role="radiogroup">{modes.map(option => <Choice
      body={option.body}
      disabled={input.platform === 'linux' && option.value !== 'compatibility'}
      key={option.value}
      onSelect={() => { update({ ...selection, mode: option.value }) }}
      selected={selection.mode === option.value}
      title={option.title}
    />)}</div></PageCard>
    <PageCard body={copy.windowMaterialBody} title={copy.windowMaterial}>
      {input.platform === 'linux' ? <p className="text-sm text-muted-foreground">{copy.materialOff}</p> : <div className="max-w-sm space-y-2"><Label htmlFor="setup-window-material">{copy.windowMaterial}</Label><select
        className="h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        id="setup-window-material"
        onChange={(event) => {
          const next = event.currentTarget.value
          if (input.platform === 'darwin' && (next === 'off' || next === 'transparent')) {
            update({ ...selection, macosMaterial: next })
          } else if (input.platform === 'win32' && (next === 'off' || next === 'acrylic' || next === 'mica' && input.micaSupported)) {
            update({ ...selection, windowsMaterial: next })
          }
        }}
        value={material}
      ><option value="off">{copy.materialOff}</option>{input.platform === 'darwin' ? <option value="transparent">{copy.materialTransparent}</option> : <><option value="acrylic">{copy.materialAcrylic}</option>{input.micaSupported ? <option value="mica">{copy.materialMica}</option> : null}</>}</select></div>}
    </PageCard>
  </div>
}

function AccessPanel({
  copy,
  selection,
  update,
  requestExposure,
}: {
  readonly copy: DesktopSetupWizardCopy
  readonly selection: DesktopSetupWizardSelection
  readonly update: (selection: DesktopSetupWizardSelection) => void
  readonly requestExposure: (exposure: DesktopSetupWizardNetworkExposure) => void
}): JSX.Element {
  const markets: readonly { readonly value: DesktopSetupWizardMarket; readonly title: string; readonly body: string }[] = [
    { value: 'disabled', title: copy.marketDisabled, body: copy.marketDisabledBody },
    { value: 'community-market', title: copy.communityMarket, body: copy.communityMarketBody },
    { value: 'dsh-market', title: copy.dshMarket, body: copy.dshMarketBody },
  ]
  return <div className="space-y-4 py-4">
    <PageCard body={copy.browserBody} title={copy.browserTitle}>
      <ToggleRow checked={selection.openBrowser} label={copy.openBrowser} onChange={openBrowser => { update({ ...selection, openBrowser }) }} />
      <div className="pt-4"><h3 className="text-sm font-semibold">{copy.networkExposure}</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.networkExposureBody}</p><div className="mt-3 grid gap-3 sm:grid-cols-2" role="radiogroup"><Choice body={copy.loopbackBody} onSelect={() => { requestExposure('loopback') }} selected={selection.networkExposure === 'loopback'} title={copy.loopback} /><Choice body={copy.lanBody} onSelect={() => { requestExposure('lan') }} selected={selection.networkExposure === 'lan'} title={copy.lan} /></div></div>
    </PageCard>
    <PageCard body={copy.marketBody} title={copy.marketTitle}><div className="grid gap-3 sm:grid-cols-3" role="radiogroup">{markets.map(option => <Choice body={option.body} key={option.value} onSelect={() => { update({ ...selection, market: option.value }) }} selected={selection.market === option.value} title={option.title} />)}</div></PageCard>
  </div>
}

function NotificationsPanel({
  copy,
  notifications,
  update,
}: {
  readonly copy: DesktopSetupWizardCopy
  readonly notifications: DesktopSetupWizardNotifications
  readonly update: (notifications: DesktopSetupWizardNotifications) => void
}): JSX.Element {
  const set = (key: keyof DesktopSetupWizardNotifications, checked: boolean): void => {
    update({ ...notifications, [key]: checked })
  }
  return <div className="py-4"><PageCard body={copy.notificationsBody} title={copy.notificationsTitle}>
    <ToggleRow checked={notifications.enabled} label={copy.notificationsEnabled} onChange={checked => { set('enabled', checked) }} />
    <div className="ml-4 border-l pl-4"><ToggleRow checked={notifications.notifyOnTurnCompletion} disabled={!notifications.enabled} label={copy.turnCompletion} onChange={checked => { set('notifyOnTurnCompletion', checked) }} /><ToggleRow checked={notifications.notifyOnTurnFailure} disabled={!notifications.enabled} label={copy.turnFailure} onChange={checked => { set('notifyOnTurnFailure', checked) }} /><ToggleRow checked={notifications.notifyOnJobCompletion} disabled={!notifications.enabled} label={copy.jobCompletion} onChange={checked => { set('notifyOnJobCompletion', checked) }} /><ToggleRow checked={notifications.notifyOnJobFailure} disabled={!notifications.enabled} label={copy.jobFailure} onChange={checked => { set('notifyOnJobFailure', checked) }} /></div>
  </PageCard></div>
}

export function SetupWizardLanConfirmation({ copy, confirm, cancel }: {
  readonly copy: DesktopSetupWizardCopy
  readonly confirm: () => void
  readonly cancel: () => void
}): JSX.Element {
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') cancel() }
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('keydown', escape) }
  }, [cancel])
  return <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-6">
    <Card aria-describedby="lan-warning-body" aria-labelledby="lan-warning-title" aria-modal="true" className="w-full max-w-lg shadow-2xl" role="alertdialog">
      <CardHeader><div className="flex gap-3"><AlertTriangle aria-hidden="true" className="size-6 shrink-0 text-destructive" /><div><CardTitle id="lan-warning-title">{copy.lanWarningTitle}</CardTitle><CardDescription className="mt-2 text-foreground" id="lan-warning-body">{copy.lanWarningBody}</CardDescription></div></div></CardHeader>
      <CardContent className="flex flex-wrap justify-end gap-2"><Button onClick={cancel} type="button" variant="outline">{copy.cancelLan}</Button><Button autoFocus onClick={confirm} type="button" variant="destructive"><AlertTriangle />{copy.confirmLan}</Button></CardContent>
    </Card>
  </div>
}

export function SetupWizardApp(): JSX.Element {
  const locale = localLocale(window.location.search)
  const copy = desktopSetupWizardCopy(locale)
  const input = decodeDesktopSetupWizardInput(window.location.search)
  const [selection, setSelection] = useState<DesktopSetupWizardSelection | undefined>(() => input === undefined ? undefined : normalizedSelection(input))
  const [lanAcknowledged, setLanAcknowledged] = useState(false)
  const [confirmLan, setConfirmLan] = useState<'select' | 'finish'>()
  if (input === undefined || selection === undefined) {
    return <><DesktopFrame /><main className="dshNativeContent flex h-screen items-center justify-center p-6"><div className="w-full max-w-lg space-y-4"><Alert variant="destructive"><AlertTriangle /><AlertTitle>{copy.title}</AlertTitle><AlertDescription>{copy.invalidState}</AlertDescription></Alert><div className="flex justify-end"><Button onClick={() => { window.location.assign(`${SCHEME}//skip`) }} type="button" variant="outline"><SkipForward />{copy.skip}</Button></div></div></main></>
  }
  const requestExposure = (requested: DesktopSetupWizardNetworkExposure): void => {
    if (desktopSetupWizardRequiresLanAcknowledgement(
      selection.networkExposure,
      requested,
      lanAcknowledged,
    )) {
      setConfirmLan('select')
      return
    }
    if (requested === 'loopback') setLanAcknowledged(false)
    setSelection({ ...selection, networkExposure: requested })
  }
  const complete = (): void => {
    if (desktopSetupWizardRequiresLanAcknowledgement(
      selection.networkExposure,
      selection.networkExposure,
      lanAcknowledged,
    )) {
      setConfirmLan('finish')
      return
    }
    finish(selection)
  }
  return <><DesktopFrame /><main className="dshNativeContent h-screen overflow-hidden p-5 sm:p-6"><section className="mx-auto flex h-full w-full max-w-5xl flex-col">
    <header className="mb-4 shrink-0"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight">{copy.heading}</h1><p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{copy.introduction}</p></div><span className="rounded-full bg-muted px-3 py-1.5 text-xs font-medium">{copy.profile}: {input.profileName}</span></div></header>
    <Tabs defaultValue="appearance"><TabsList className="w-full justify-start"><TabsTrigger value="appearance"><Monitor />{copy.appearanceTab}</TabsTrigger><TabsTrigger value="access"><Globe2 />{copy.accessTab}</TabsTrigger><TabsTrigger value="notifications"><Bell />{copy.notificationsTab}</TabsTrigger></TabsList><TabsContent className="overflow-y-auto" value="appearance"><AppearancePanel copy={copy} input={input} selection={selection} update={setSelection} /></TabsContent><TabsContent className="overflow-y-auto" value="access"><AccessPanel copy={copy} requestExposure={requestExposure} selection={selection} update={setSelection} /></TabsContent><TabsContent className="overflow-y-auto" value="notifications"><NotificationsPanel copy={copy} notifications={selection.notifications} update={notifications => { setSelection({ ...selection, notifications }) }} /></TabsContent></Tabs>
    <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t pt-4"><Button onClick={() => { window.location.assign(`${SCHEME}//skip`) }} type="button" variant="outline"><SkipForward />{copy.skip}</Button><Button onClick={complete} type="button"><PanelsTopLeft />{copy.complete}</Button></footer>
  </section></main>{confirmLan === undefined ? null : <SetupWizardLanConfirmation
    cancel={() => { setConfirmLan(undefined) }}
    confirm={() => {
      const next = { ...selection, networkExposure: 'lan' as const }
      const completeAfterAcknowledgement = confirmLan === 'finish'
      setSelection(next)
      setLanAcknowledged(true)
      setConfirmLan(undefined)
      if (completeAfterAcknowledgement) finish(next)
    }}
    copy={copy}
  />}</>
}
