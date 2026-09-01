/** Authenticated-account card for the upstream Settings → General section. */

import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: brings the 'settings.general.item' SlotMap merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopSettingsApi, DesktopSettingsSsoView } from './desktop-settings-api.ts'

/** Registration-side capability for the user-info card. */
export interface GeneralUserInfoCardInjected {
  readonly api: Pick<DesktopSettingsApi, 'read'>
}

/** Renderer-composed props for the General user-info card. */
export type GeneralUserInfoCardProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<GeneralUserInfoCardInjected>

type Translate = GeneralUserInfoCardProps['t']

/**
 * Render the signed-in account card body. Presentational and pure so the
 * three observable states unit test cleanly: an absent session returns null,
 * an authenticated session renders the full email and source, and the copy
 * follows the bound locale.
 * @param props - projected SSO session and the bound translate.
 * @returns the card, or null when no authenticated session is live.
 */
export function GeneralUserInfoCardView({
  sso,
  t,
}: {
  readonly sso: DesktopSettingsSsoView | undefined
  readonly t: Translate
}): JSX.Element | null {
  if (sso === undefined || sso.authenticated !== true) return null
  const source = sso.source === 'browser' ? t('userInfoSourceBrowser') : t('userInfoSourceSilent')
  return (
    <section className="dshGeneralUserInfoCard" aria-labelledby="dsh-general-user-info-title">
      <h3 id="dsh-general-user-info-title" className="dshGeneralUserInfoTitle">{t('userInfoTitle')}</h3>
      <dl className="dshGeneralUserInfoList">
        <div className="dshGeneralUserInfoRow">
          <dt className="dshGeneralUserInfoLabel">{t('userInfoEmail')}</dt>
          <dd className="dshGeneralUserInfoValue">{sso.email ?? '—'}</dd>
        </div>
        <div className="dshGeneralUserInfoRow">
          <dt className="dshGeneralUserInfoLabel">{t('userInfoAuthMethod')}</dt>
          <dd className="dshGeneralUserInfoValue">{t('userInfoAuthCompany')} · {source}</dd>
        </div>
        <div className="dshGeneralUserInfoRow">
          <dt className="dshGeneralUserInfoLabel">{t('userInfoStatus')}</dt>
          <dd className="dshGeneralUserInfoValue">{t('userInfoStatusValue')}</dd>
        </div>
      </dl>
    </section>
  )
}

/**
 * Slot-registered General card: reads the live SSO session from the Desktop
 * settings API once on mount and renders the card only when authenticated.
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
