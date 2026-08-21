/**
 * The content column's occupant: one iframe over the hosted application's
 * same-origin route.
 *
 * No `sandbox` attribute, deliberately. The hosted application is
 * operator-configured content that the deployment already trusts, and
 * same-origin is what lets it call the dsh API at all. Adding `sandbox`
 * without `allow-same-origin` would give the document an opaque origin, which
 * the API's own Origin check rejects; adding it with `allow-same-origin`
 * removes nothing. Untrusted content needs a different plugin, not a flag here
 * — see the package README's trust section.
 *
 * Pure presentation: the URL arrives through the injected face, the label
 * through the locale seat.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ContentFrame.module.css'

/** Plain data this registration injects. */
export interface ContentFrameFace {
  /** Same-origin URL of the hosted application's entry document. */
  src: string
}

/** Composed props: the injected face plus the locale seat. */
export type ContentFrameProps = ContentFrameFace & PropsLocale<'contentFrame'>

/**
 * Render the hosted application.
 * @param props - the injected src and the locale seat.
 * @returns the iframe filling the content column.
 */
export function ContentFrame({ src, t }: ContentFrameProps) {
  return <iframe className={css.frame} src={src} title={t('frame.title')} data-content-frame />
}
