/** The one banner this plugin draws, in the shell's frame-wide overlay layer. */
import type { ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { visibleNotice, type BannerState, type PageNotice } from './banner-state.ts'
import type { PageRefreshKey } from './locales.ts'
import css from './PageRefreshBanner.module.css'

/** What the registration injects: the banner state and the reload action. */
export interface PageRefreshBannerFace {
  hooks: { pageRefresh: ObservableSnapshot<BannerState> }
  /** Load the page again. */
  reloadPage: () => void
}

/** Render inputs: the bound banner state, the reload action, and the dictionary. */
export type PageRefreshBannerProps = InjectFace<PageRefreshBannerFace> & PropsLocale<'pageRefresh'>

/** How one notice is drawn. */
interface Presentation {
  /** Colour family: a problem, a confirmation, or the page acting by itself. */
  readonly tone: 'warning' | 'success' | 'info'
  /** The sentence. */
  readonly text: PageRefreshKey
  /** Whether something is still happening, shown by the progress dot. */
  readonly busy: boolean
  /** Whether the notice offers the page reload. */
  readonly reload: boolean
}

const PRESENTATION: Readonly<Record<PageNotice, Presentation>> = {
  update: { tone: 'warning', text: 'update.text', busy: false, reload: true },
  reloading: { tone: 'info', text: 'reloading.text', busy: true, reload: false },
  lost: { tone: 'warning', text: 'lost.text', busy: true, reload: false },
  stuck: { tone: 'warning', text: 'stuck.text', busy: false, reload: true },
  recovered: { tone: 'success', text: 'recovered.text', busy: false, reload: false },
}

/**
 * Draw the current notice at the top of the page, clear of the composer, on
 * one line; the sentence's title carries it whole where the line cuts it.
 * @param props - the bound banner state, the reload action, and the dictionary.
 * @returns the banner, or `null` when there is nothing to say.
 */
export function PageRefreshBanner({ usePageRefresh, reloadPage, t }: PageRefreshBannerProps): ReactNode {
  const notice = usePageRefresh(visibleNotice)
  if (notice === null) return null
  const { tone, text, busy, reload } = PRESENTATION[notice]
  return (
    <div className={[css.banner, css[tone]].join(' ')} role="status" data-page-refresh-notice={notice}>
      {busy && <span className={css.icon} aria-hidden="true"><StateDot state="ongoing" /></span>}
      <span className={css.text} title={t(text)}>{t(text)}</span>
      {reload && <Button variant="primary" size="sm" onClick={reloadPage}>{t('reload.label')}</Button>}
    </div>
  )
}
