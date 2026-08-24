/**
 * The `page` seat of the content column: one iframe per cached (session, page)
 * pair, all mounted at once, all but the current one hidden.
 *
 * Hiding rather than unmounting is the whole point. The seat is root-scoped and
 * the column keeps it mounted even while another content kind is on display, so
 * a cached entry keeps its React key across every transition — which keeps its
 * iframe element, which keeps the live document inside it. A page the user
 * returns to is found exactly as it was left, scroll position and all.
 *
 * No `sandbox` attribute, deliberately. The hosted pages are
 * operator-configured content that the deployment already trusts, and
 * same-origin is what lets them call the dsh API at all. Adding `sandbox`
 * without `allow-same-origin` would give the document an opaque origin, which
 * the API's own Origin check rejects; adding it with `allow-same-origin`
 * removes nothing. Untrusted content needs a different plugin, not a flag here
 * — see the package README's trust section.
 *
 * Pure presentation: the frame cache is component-local state folded from the
 * entry the column hands over, and every string comes from the locale seat.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentPageView } from '../types.ts'
import { foldFrames, NO_FRAMES, type CachedFrame, type FrameCache } from './frame-cache.ts'
import css from './ContentFrame.module.css'

/** Plain data this registration injects. */
export interface ContentFrameFace {
  /** How many (session, page) frames stay alive at once, as the node half configured it. */
  cacheSize: number
}

/** Composed props: the kind-seat runtime share, the injected face, and the locale seat. */
export type ContentFrameProps =
  & PropsRuntime<'content.surface.kind', 'page'>
  & ContentFrameFace
  & PropsLocale<'contentFrame'>

/**
 * Read the page one surface entry puts on display.
 *
 * The payload crosses the host/browser edge as kind-owned JSON the column
 * itself never interprets, so its discriminant is checked here rather than
 * assumed from the entry type.
 * @param payload - the entry's payload, as the column handed it over.
 * @returns the resolved view, or undefined when the payload is not one.
 */
function pageView(payload: unknown): ContentPageView | undefined {
  const view = payload as ContentPageView | undefined
  return view?.state === 'shown' || view?.state === 'missing' ? view : undefined
}

/**
 * The frame this seat shows now.
 * @param sessionId - the session the column is showing, when one is current.
 * @param entry - the selected entry while it belongs to this seat's kind.
 * @returns the frame to show, or undefined when the seat shows a notice or nothing.
 */
function activeFrame(
  sessionId: string | undefined,
  entry: { entryId: string; payload: unknown } | undefined,
): CachedFrame | undefined {
  if (sessionId === undefined || entry === undefined) return undefined
  const view = pageView(entry.payload)
  if (view?.state !== 'shown') return undefined
  return { frameId: `${sessionId} ${entry.entryId}`, url: view.url }
}

/**
 * Render the page seat.
 * @param props - the column's selection, the cache bound, and the locale seat.
 * @returns every cached frame, plus a notice when the selected page is gone.
 */
export function ContentFrame({ sessionId, entry, cacheSize, t }: ContentFrameProps) {
  const active = activeFrame(sessionId, entry)

  // Derived state, not a subscription: the cache is a fold over the entries the
  // column hands over, and folding it during render is React's sanctioned form
  // (the same one the slot renderer's adoption bookkeeping uses). foldFrames
  // returns its input when nothing moved, so the update converges in one extra
  // render.
  const [cache, setCache] = useState<FrameCache>(NO_FRAMES)
  const next = foldFrames(cache, active, cacheSize)
  if (next !== cache) setCache(next)

  const retired = entry !== undefined && active === undefined

  return (
    <div className={css.column} data-content-column>
      {next.frames.map(frame => (
        <iframe
          key={frame.frameId}
          className={frame.frameId === active?.frameId ? css.frame : `${css.frame} ${css.cached}`}
          src={frame.url}
          title={t('frame.title')}
          data-content-frame
          data-content-frame-id={frame.frameId}
          data-content-active={frame.frameId === active?.frameId || undefined}
        />
      ))}
      {retired && (
        <p className={css.notice} data-content-notice>{t('frame.missing')}</p>
      )}
    </div>
  )
}
