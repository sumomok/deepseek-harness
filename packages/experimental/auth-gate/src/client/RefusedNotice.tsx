/**
 * The notice the browser half shows when it stops over a sign-in the site no
 * longer accepts: the login page handed back a token the site had already
 * refused, so the page stays where it is and says why, rather than leaving
 * the visitor in front of a console whose every gated request fails.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/client/RefusedNotice
 */
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './RefusedNotice.module.css'

/** What the registration injects: whether the gate has stopped over a refused sign-in. */
export interface RefusedNoticeFace {
  hooks: { authGateRefusal: ObservableSnapshot<boolean> }
}

/** Render inputs: the bound refusal state and the dictionary. */
export type RefusedNoticeProps = InjectFace<RefusedNoticeFace> & PropsLocale<'authGate'>

/**
 * Draw the notice once the gate has stopped, at the top of the page and clear
 * of the composer. It has no button and no way to close it: the sign-in it
 * reports stays refused until the visitor signs in again and refreshes.
 * @param props - the bound refusal state and the dictionary.
 * @returns the notice, or `null` while the gate runs.
 */
export function RefusedNotice({ useAuthGateRefusal, t }: RefusedNoticeProps): ReactNode {
  const shown = useAuthGateRefusal(state => state)
  if (!shown) return null
  return <div className={css.notice} role="alert" data-auth-gate-refused="">{t('refused.text')}</div>
}
