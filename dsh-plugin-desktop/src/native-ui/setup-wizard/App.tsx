import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  SkipForward,
} from 'lucide-react'
import {
  desktopSetupWizardRequiresLanAcknowledgement,
  isDesktopSetupWizardInput,
  type DesktopSetupWizardInput,
  type DesktopSetupWizardMacosMaterial,
  type DesktopSetupWizardMarket,
  type DesktopSetupWizardMode,
  type DesktopSetupWizardNetworkExposure,
  type DesktopSetupWizardNotifications,
  type DesktopSetupWizardSelection,
  type DesktopSetupWizardWindowsMaterial,
} from '../../setup-wizard-contract.ts'
import { desktopSetupWizardCopy, type DesktopSetupWizardCopy } from '../../setup-wizard-copy.ts'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Card, CardContent } from '../components/ui/card.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog.tsx'
import { Label } from '../components/ui/label.tsx'
import { Switch } from '../components/ui/switch.tsx'
import { DesktopFrame } from '../shared/DesktopFrame.tsx'

const SCHEME = 'dsh-setup-wizard:'
const MAX_STATE_CHARACTERS = 32 * 1024

type Locale = 'en' | 'zh'

export type DesktopSetupWizardStep =
  | 'mode'
  | 'material'
  | 'market'
  | 'notifications'
  | 'browser'
  | 'success'

export const DESKTOP_SETUP_WIZARD_STEPS = Object.freeze([
  'mode',
  'material',
  'market',
  'notifications',
  'browser',
  'success',
] as const satisfies readonly DesktopSetupWizardStep[])

export function previousDesktopSetupWizardStep(
  step: DesktopSetupWizardStep,
): DesktopSetupWizardStep | undefined {
  const index = DESKTOP_SETUP_WIZARD_STEPS.indexOf(step)
  return index > 0 ? DESKTOP_SETUP_WIZARD_STEPS[index - 1] : undefined
}

export function nextDesktopSetupWizardStep(
  step: DesktopSetupWizardStep,
): DesktopSetupWizardStep | undefined {
  const index = DESKTOP_SETUP_WIZARD_STEPS.indexOf(step)
  return index >= 0 && index < DESKTOP_SETUP_WIZARD_STEPS.length - 1
    ? DESKTOP_SETUP_WIZARD_STEPS[index + 1]
    : undefined
}

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
  id,
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
}): JSX.Element {
  return <div className="flex items-center justify-between gap-5 rounded-xl border p-4">
    <div className="min-w-0 space-y-1">
      <Label className="block text-sm font-medium" htmlFor={id}>{label}</Label>
      {description === undefined ? null : <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
    </div>
    <Switch
      aria-label={label}
      checked={checked}
      disabled={disabled}
      id={id}
      onCheckedChange={onChange}
    />
  </div>
}

function Page({
  step,
  title,
  subtitle,
  children,
}: {
  readonly step: DesktopSetupWizardStep
  readonly title: string
  readonly subtitle: string
  readonly children: ReactNode
}): JSX.Element {
  return <div className="mx-auto flex w-full max-w-2xl flex-col py-5" data-setup-step={step}>
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
    </header>
    <Card><CardContent className="space-y-3 p-4 sm:p-5">{children}</CardContent></Card>
  </div>
}

function ModeOptions({
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
  return <div aria-orientation="vertical" className="space-y-3" role="radiogroup">{modes.map(option => <Choice
    body={option.body}
    disabled={input.platform === 'linux' && option.value !== 'compatibility'}
    key={option.value}
    onSelect={() => { update({ ...selection, mode: option.value }) }}
    selected={selection.mode === option.value}
    title={option.title}
  />)}</div>
}

type MaterialOption = {
  readonly value: DesktopSetupWizardMacosMaterial | DesktopSetupWizardWindowsMaterial
  readonly title: string
  readonly body: string
}

function MaterialOptions({
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
  const options: readonly MaterialOption[] = input.platform === 'darwin' ? [
    { value: 'off', title: copy.materialOff, body: copy.materialOffBody },
    { value: 'transparent', title: copy.materialTransparent, body: copy.materialTransparentBody },
  ] : input.platform === 'win32' ? [
    { value: 'off', title: copy.materialOff, body: copy.materialOffBody },
    { value: 'acrylic', title: copy.materialAcrylic, body: copy.materialAcrylicBody },
    ...(input.micaSupported ? [{ value: 'mica' as const, title: copy.materialMica, body: copy.materialMicaBody }] : []),
  ] : [
    { value: 'off', title: copy.materialOff, body: copy.unavailableOnLinux },
  ]
  const selected = input.platform === 'darwin' ? selection.macosMaterial
    : input.platform === 'win32' ? selection.windowsMaterial : 'off'
  const choose = (value: MaterialOption['value']): void => {
    if (input.platform === 'darwin' && (value === 'off' || value === 'transparent')) {
      update({ ...selection, macosMaterial: value })
    } else if (input.platform === 'win32' && (value === 'off' || value === 'acrylic' || value === 'mica')) {
      update({ ...selection, windowsMaterial: value })
    }
  }
  return <div aria-orientation="vertical" className="space-y-3" role="radiogroup">{options.map(option => <Choice
    body={option.body}
    disabled={input.platform === 'linux'}
    key={option.value}
    onSelect={() => { choose(option.value) }}
    selected={selected === option.value}
    title={option.title}
  />)}</div>
}

function MarketOptions({
  copy,
  selection,
  update,
}: {
  readonly copy: DesktopSetupWizardCopy
  readonly selection: DesktopSetupWizardSelection
  readonly update: (selection: DesktopSetupWizardSelection) => void
}): JSX.Element {
  const markets: readonly { readonly value: DesktopSetupWizardMarket; readonly title: string; readonly body: string }[] = [
    { value: 'disabled', title: copy.marketDisabled, body: copy.marketDisabledBody },
    { value: 'community-market', title: copy.communityMarket, body: copy.communityMarketBody },
    { value: 'dsh-market', title: copy.dshMarket, body: copy.dshMarketBody },
  ]
  return <div aria-orientation="vertical" className="space-y-3" role="radiogroup">{markets.map(option => <Choice
    body={option.body}
    key={option.value}
    onSelect={() => { update({ ...selection, market: option.value }) }}
    selected={selection.market === option.value}
    title={option.title}
  />)}</div>
}

function NotificationOptions({
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
  return <div aria-orientation="vertical" className="space-y-3">
    <ToggleRow checked={notifications.enabled} id="setup-notifications-enabled" label={copy.notificationsEnabled} onChange={checked => { set('enabled', checked) }} />
    <div className="space-y-3 border-l pl-4">
      <ToggleRow checked={notifications.notifyOnTurnCompletion} disabled={!notifications.enabled} id="setup-turn-completion" label={copy.turnCompletion} onChange={checked => { set('notifyOnTurnCompletion', checked) }} />
      <ToggleRow checked={notifications.notifyOnTurnFailure} disabled={!notifications.enabled} id="setup-turn-failure" label={copy.turnFailure} onChange={checked => { set('notifyOnTurnFailure', checked) }} />
      <ToggleRow checked={notifications.notifyOnJobCompletion} disabled={!notifications.enabled} id="setup-job-completion" label={copy.jobCompletion} onChange={checked => { set('notifyOnJobCompletion', checked) }} />
      <ToggleRow checked={notifications.notifyOnJobFailure} disabled={!notifications.enabled} id="setup-job-failure" label={copy.jobFailure} onChange={checked => { set('notifyOnJobFailure', checked) }} />
    </div>
  </div>
}

function BrowserOptions({
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
  return <div className="space-y-5">
    <ToggleRow checked={selection.openBrowser} id="setup-open-browser" label={copy.openBrowser} onChange={openBrowser => { update({ ...selection, openBrowser }) }} />
    <section>
      <h2 className="text-sm font-semibold">{copy.networkExposure}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.networkExposureBody}</p>
      <div aria-orientation="vertical" className="mt-3 space-y-3" role="radiogroup">
        <Choice body={copy.loopbackBody} onSelect={() => { requestExposure('loopback') }} selected={selection.networkExposure === 'loopback'} title={copy.loopback} />
        <Choice body={copy.lanBody} onSelect={() => { requestExposure('lan') }} selected={selection.networkExposure === 'lan'} title={copy.lan} />
      </div>
    </section>
  </div>
}

export function SetupWizardStepPage({
  step,
  copy,
  input,
  selection,
  update,
  requestExposure,
}: {
  readonly step: DesktopSetupWizardStep
  readonly copy: DesktopSetupWizardCopy
  readonly input: DesktopSetupWizardInput
  readonly selection: DesktopSetupWizardSelection
  readonly update: (selection: DesktopSetupWizardSelection) => void
  readonly requestExposure: (exposure: DesktopSetupWizardNetworkExposure) => void
}): JSX.Element {
  if (step === 'mode') return <Page step={step} subtitle={copy.presentationBody} title={copy.presentationTitle}><ModeOptions copy={copy} input={input} selection={selection} update={update} /></Page>
  if (step === 'material') return <Page step={step} subtitle={copy.windowMaterialBody} title={copy.windowMaterial}><MaterialOptions copy={copy} input={input} selection={selection} update={update} /></Page>
  if (step === 'market') return <Page step={step} subtitle={copy.marketBody} title={copy.marketTitle}><MarketOptions copy={copy} selection={selection} update={update} /></Page>
  if (step === 'notifications') return <Page step={step} subtitle={copy.notificationsBody} title={copy.notificationsTitle}><NotificationOptions copy={copy} notifications={selection.notifications} update={notifications => { update({ ...selection, notifications }) }} /></Page>
  if (step === 'browser') return <Page step={step} subtitle={copy.browserBody} title={copy.browserTitle}><BrowserOptions copy={copy} requestExposure={requestExposure} selection={selection} update={update} /></Page>
  return <div data-setup-step="success" />
}

function SetupWizardSkipDialog({
  copy,
  onSkip,
  outlined = false,
}: {
  readonly copy: DesktopSetupWizardCopy
  readonly onSkip: () => void
  readonly outlined?: boolean
}): JSX.Element {
  return <Dialog>
    <DialogTrigger render={<Button type="button" variant={outlined ? 'outline' : 'ghost'} />}><SkipForward />{copy.skip}</DialogTrigger>
    <DialogContent aria-describedby="skip-warning-body" aria-labelledby="skip-warning-title" aria-modal="true" role="alertdialog" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle id="skip-warning-title">{copy.skipDialogTitle}</DialogTitle>
        <DialogDescription id="skip-warning-body">{copy.skipDialogBody}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose render={<Button autoFocus type="button" variant="outline" />}>{copy.cancelSkip}</DialogClose>
        <Button onClick={onSkip} type="button">{copy.confirmSkip}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function SetupWizardNavigation({
  copy,
  step,
  onBack,
  onNext,
  onSkip,
}: {
  readonly copy: DesktopSetupWizardCopy
  readonly step: DesktopSetupWizardStep
  readonly onBack: () => void
  readonly onNext: () => void
  readonly onSkip: () => void
}): JSX.Element | null {
  if (step === 'success') return null
  return <footer className="flex shrink-0 items-center justify-between gap-3 border-t pt-4">
    <SetupWizardSkipDialog copy={copy} onSkip={onSkip} />
    <div className="flex items-center gap-2">
      <Button aria-label={copy.back} disabled={previousDesktopSetupWizardStep(step) === undefined} onClick={onBack} size="icon" title={copy.back} type="button" variant="outline"><ArrowLeft /></Button>
      <Button aria-label={copy.next} onClick={onNext} size="icon" title={copy.next} type="button"><ArrowRight /></Button>
    </div>
  </footer>
}

export function SetupWizardSuccess({
  copy,
  onStart,
}: {
  readonly copy: DesktopSetupWizardCopy
  readonly onStart: () => void
}): JSX.Element {
  return <div className="flex flex-1 items-center justify-center" data-align="center" data-setup-step="success">
    <div className="flex max-w-md flex-col items-center text-center">
      <span className="mb-5 flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground"><CheckCircle2 className="size-8" /></span>
      <h1 className="text-2xl font-semibold tracking-tight">{copy.successTitle}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.successBody}</p>
      <Button className="mt-8" onClick={onStart} size="lg" type="button">{copy.startUsing}</Button>
    </div>
  </div>
}

export function SetupWizardLanConfirmation({ copy, confirm, cancel }: {
  readonly copy: DesktopSetupWizardCopy
  readonly confirm: () => void
  readonly cancel: () => void
}): JSX.Element {
  return <Dialog onOpenChange={open => { if (!open) cancel() }} open>
    <DialogContent aria-describedby="lan-warning-body" aria-labelledby="lan-warning-title" aria-modal="true" role="alertdialog" showCloseButton={false}>
      <DialogHeader>
        <div className="flex gap-3">
          <AlertTriangle aria-hidden="true" className="size-6 shrink-0 text-destructive" />
          <div>
            <DialogTitle id="lan-warning-title">{copy.lanWarningTitle}</DialogTitle>
            <DialogDescription className="mt-2 text-foreground" id="lan-warning-body">{copy.lanWarningBody}</DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <DialogFooter>
        <Button onClick={cancel} type="button" variant="outline">{copy.cancelLan}</Button>
        <Button autoFocus onClick={confirm} type="button" variant="destructive"><AlertTriangle />{copy.confirmLan}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

type LanConfirmationReason = 'select' | 'advance' | 'start'

export function SetupWizardApp(): JSX.Element {
  const locale = localLocale(window.location.search)
  const copy = desktopSetupWizardCopy(locale)
  const input = decodeDesktopSetupWizardInput(window.location.search)
  const [selection, setSelection] = useState<DesktopSetupWizardSelection | undefined>(() => input === undefined ? undefined : normalizedSelection(input))
  const [step, setStep] = useState<DesktopSetupWizardStep>('mode')
  const [lanAcknowledged, setLanAcknowledged] = useState(false)
  const [confirmLan, setConfirmLan] = useState<LanConfirmationReason>()
  if (input === undefined || selection === undefined) {
    return <><DesktopFrame /><main className="dshNativeContent flex h-screen items-center justify-center p-6"><div className="w-full max-w-lg space-y-4"><Alert variant="destructive"><AlertTriangle /><AlertTitle>{copy.title}</AlertTitle><AlertDescription>{copy.invalidState}</AlertDescription></Alert><div className="flex justify-end"><SetupWizardSkipDialog copy={copy} onSkip={() => { window.location.assign(`${SCHEME}//skip`) }} outlined /></div></div></main></>
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

  const advance = (): void => {
    const next = nextDesktopSetupWizardStep(step)
    if (next === undefined) return
    if (step === 'browser' && desktopSetupWizardRequiresLanAcknowledgement(
      selection.networkExposure,
      selection.networkExposure,
      lanAcknowledged,
    )) {
      setConfirmLan('advance')
      return
    }
    setStep(next)
  }

  const startUsing = (): void => {
    if (desktopSetupWizardRequiresLanAcknowledgement(
      selection.networkExposure,
      selection.networkExposure,
      lanAcknowledged,
    )) {
      setConfirmLan('start')
      return
    }
    finish(selection)
  }

  return <><DesktopFrame /><main className="dshNativeContent h-screen overflow-hidden p-5 sm:p-6"><section className="mx-auto flex h-full w-full max-w-3xl flex-col">
    <header className="flex shrink-0 items-center justify-between gap-3 pb-2">
      <span className="text-sm font-semibold">{copy.title}</span>
      <span className="rounded-full bg-muted px-3 py-1.5 text-xs font-medium">{copy.profile}: {input.profileName}</span>
    </header>
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      {step === 'success'
        ? <SetupWizardSuccess copy={copy} onStart={startUsing} />
        : <SetupWizardStepPage copy={copy} input={input} requestExposure={requestExposure} selection={selection} step={step} update={setSelection} />}
    </div>
    <SetupWizardNavigation
      copy={copy}
      onBack={() => {
        const previous = previousDesktopSetupWizardStep(step)
        if (previous !== undefined) setStep(previous)
      }}
      onNext={advance}
      onSkip={() => { window.location.assign(`${SCHEME}//skip`) }}
      step={step}
    />
  </section></main>
  {confirmLan === undefined ? null : <SetupWizardLanConfirmation
    cancel={() => { setConfirmLan(undefined) }}
    confirm={() => {
      const next = { ...selection, networkExposure: 'lan' as const }
      const reason = confirmLan
      setSelection(next)
      setLanAcknowledged(true)
      setConfirmLan(undefined)
      if (reason === 'advance') setStep('success')
      if (reason === 'start') finish(next)
    }}
    copy={copy}
  />}</>
}
