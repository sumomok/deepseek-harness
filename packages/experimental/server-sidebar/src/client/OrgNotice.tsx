/**
 * The organization notice card: the organization's disclosure, shown once to
 * a member who has to read it, or with 同意 (I agree) to one who has to agree
 * to it (`org-notice.ts` owns which, and when).
 *
 * The card never stands between a member and the conversation. It is a
 * `shell.overlay` entry, not a modal: it takes no focus when it appears,
 * leaves the page under it usable, and is placed clear of the composer. On a
 * wide frame it stands over the lower part of the sidebar column, above the
 * column's foot band (`foot-placement.ts`), and on a narrow frame under the
 * drawer button. A notice has one button, 知道了 (Got it); a disclosure to
 * agree to has 同意 and 稍后 (Later), which puts it away for this page only.
 * There is no close button, and a click outside the card changes nothing.
 *
 * The title, body, and category names are the organization's own text,
 * shown in the page's language as plain text with their line breaks. The
 * policy address is linked only when it is an `https:` address.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/OrgNotice
 */
import { useId, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BilingualText, DisclosureText, OrgNoticeView } from './org-notice.ts'
import type { FootPlacement } from './foot-placement.ts'
import css from './OrgNotice.module.css'

/** The card's injected face: its state, its placement, its language, and the member's three actions. */
export interface OrgNoticeInjected {
  hooks: {
    /** What the card shows. */
    orgNotice: HostObservable<OrgNoticeView>
    /** Where the sidebar's foot band is, absent while no sidebar is mounted. */
    footPlacement: HostObservable<FootPlacement | undefined>
    /** Which language a disclosure's text is shown in. */
    language: HostObservable<'zh' | 'en'>
  }
  /** 知道了: put the notice away and record it as read. */
  acknowledge: () => void
  /** 稍后: put the disclosure away for this page. */
  later: () => void
  /** 同意: send the member's agreement. */
  consent: () => void
}

/** The card's props. */
export type OrgNoticeProps = InjectFace<OrgNoticeInjected> & PropsLocale<'serverSidebar'>

/** The custom properties the card's stylesheet places a wide-frame card by. */
type PlacementStyle = CSSProperties & Record<'--server-sidebar-notice-left' | '--server-sidebar-notice-width' | '--server-sidebar-notice-bottom', string>

/**
 * Place a wide-frame card by the sidebar's measurement.
 * @param placement - the measurement, when there is one.
 * @returns the card's custom properties, or none.
 */
function placementStyle(placement: FootPlacement | undefined): PlacementStyle | undefined {
  if (placement === undefined) return undefined
  return {
    '--server-sidebar-notice-left': `${String(placement.left)}px`,
    '--server-sidebar-notice-width': `${String(placement.width)}px`,
    '--server-sidebar-notice-bottom': `${String(placement.bottom)}px`,
  }
}

/**
 * The policy address as a link target.
 * @param url - the disclosure's policy address.
 * @returns the address when it is an `https:` address, else nothing.
 */
function httpsLink(url: string): string | undefined {
  return URL.canParse(url) && new URL(url).protocol === 'https:' ? url : undefined
}

/**
 * Who may read what the member uploads, in this package's words.
 * @param disclosure - the disclosure.
 * @param org - the organization's name, when known.
 * @param t - this package's dictionary lookup.
 * @returns the sentence.
 */
function viewersCopy(disclosure: DisclosureText, org: string | undefined, t: OrgNoticeProps['t']): string {
  if (disclosure.viewers === 'self') return t('orgNotice.viewers.self')
  return org === undefined ? t('orgNotice.viewers.selfAndAdminsUnnamed') : t('orgNotice.viewers.selfAndAdmins', { org })
}

/**
 * Render the card while there is one to show.
 * @param props - the injected face and the dictionary lookup.
 * @returns the card, or nothing.
 */
export function OrgNotice({ useOrgNotice, useFootPlacement, useLanguage, acknowledge, later, consent, t }: OrgNoticeProps) {
  const view = useOrgNotice(state => state)
  const placement = useFootPlacement(state => state)
  const language = useLanguage(state => state)
  const titleId = useId()
  if (view.shown === undefined) return null
  const { kind, disclosure } = view.shown
  const text = (value: BilingualText): string => value[language]
  const named = view.shown.orgName?.trim()
  const org = named === undefined || named.length === 0 ? undefined : named
  const days = disclosure.retentionDays
  const policy = httpsLink(disclosure.policyUrl)
  return (
    <section
      role="dialog"
      aria-labelledby={titleId}
      className={css.card}
      data-server-sidebar-org-notice={kind}
      data-unplaced={placement === undefined ? '' : undefined}
      style={placementStyle(placement)}
    >
      <h2 id={titleId} className={css.title}>{text(disclosure.title)}</h2>
      <div className={css.body}>
        <p className={css.text}>{text(disclosure.body)}</p>
        <dl className={css.facts}>
          <div>
            <dt className={css.term}>{t('orgNotice.collects')}</dt>
            <dd className={css.detail}>
              {disclosure.categories.length > 0 && (
                <ul className={css.categories}>
                  {disclosure.categories.map(category => <li key={category.id}>{text(category.label)}</li>)}
                </ul>
              )}
              {org === undefined ? t('orgNotice.sentToUnnamed') : t('orgNotice.sentTo', { org })}
            </dd>
          </div>
          <div>
            <dt className={css.term}>{t('orgNotice.viewers')}</dt>
            <dd className={css.detail}>{viewersCopy(disclosure, org, t)}</dd>
          </div>
          <div>
            <dt className={css.term}>{t('orgNotice.retention')}</dt>
            <dd className={css.detail}>{t(`orgNotice.retentionDays.${days === 1 ? 'one' : 'other'}`, { n: days })}</dd>
          </div>
        </dl>
        {disclosure.contact.length > 0 && <p className={css.line}>{t('orgNotice.contact', { contact: disclosure.contact })}</p>}
        {policy !== undefined && (
          <a className={css.link} href={policy} target="_blank" rel="noopener noreferrer">{t('orgNotice.policy')}</a>
        )}
        <p className={css.where}>{t('orgNotice.whereLater')}</p>
      </div>
      {view.failed && <p role="alert" className={css.error}>{t('orgNotice.consentFailed')}</p>}
      <div className={css.actions}>
        {kind === 'notice'
          ? <Button variant="primary" size="sm" onClick={acknowledge}>{t('orgNotice.acknowledge')}</Button>
          : (
            <>
              <Button variant="ghost" size="sm" disabled={view.confirming} onClick={later}>{t('orgNotice.dismiss')}</Button>
              <Button variant="primary" size="sm" disabled={view.confirming} onClick={consent}>{t('orgNotice.consent')}</Button>
            </>
          )}
      </div>
    </section>
  )
}
