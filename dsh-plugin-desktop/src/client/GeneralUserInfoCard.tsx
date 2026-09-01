/** Authenticated-account row for the upstream Settings → General section. */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: brings the 'settings.general.item' SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopSettingsApi, DesktopSettingsSsoView } from './desktop-settings-api.ts'

/** Registration-side capability for the user-info row. */
export interface GeneralUserInfoCardInjected {
  readonly api: Pick<DesktopSettingsApi, 'read'>
}

/** Renderer-composed props for the General user-info row. */
export type GeneralUserInfoCardProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<GeneralUserInfoCardInjected>

type Translate = GeneralUserInfoCardProps['t']

/**
 * Render the signed-in account row body. Presentational and pure so the
 * observable states unit test cleanly: an absent session returns null, and an
 * authenticated session renders one Setting-Cell line — the locale label on
 * the left, the full account email on the right — following the bound locale.
 * @param props - projected SSO session and the bound translate.
 * @returns the row, or null when no authenticated session is live.
 */
export function GeneralUserInfoCardView({
  sso,
  t,
}: {
  readonly sso: DesktopSettingsSsoView | undefined
  readonly t: Translate
}): JSX.Element | null {
  if (sso === undefined || sso.authenticated !== true) return null
  return (
    <div className="dshGeneralUserInfoRow">
      <div className="dshGeneralUserInfoText">
        <div className="dshGeneralUserInfoTitle">{t('userInfoEmail')}</div>
      </div>
      <div className="dshGeneralUserInfoValue">{sso.email ?? '—'}</div>
    </div>
  )
}

/**
 * Slot-registered General row: reads the live SSO session from the Desktop
 * settings API once on mount and renders the row only when authenticated.
 * Every build registers the seat, but an unauthenticated or unlocked build
 * simply renders nothing — the account email is still carried by the
 * launcher-native window title and tray row.
 */
export function GeneralUserInfoCard({ api, t }: GeneralUserInfoCardProps): JSX.Element | null {
  const [sso, setSso] = useState<DesktopSettingsSsoView | undefined>()

  useEffect(() => {
    let active = true
    void api.read().then((view) => {
      if (active) setSso(view.sso)
    }).catch(() => {})
    return () => { active = false }
  }, [api])

  return <GeneralUserInfoCardView sso={sso} t={t} />
}
