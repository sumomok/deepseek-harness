/**
 * The content column: one iframe per cached session, all mounted at once, all
 * but the current one hidden.
 *
 * Hiding rather than unmounting is the whole point. The column is a `root`
 * slot, so the framework never remounts it, and a cached entry keeps its React
 * key across every session switch — which keeps its iframe element, which
 * keeps the live document inside it. A session the user returns to finds its
 * page exactly as it left it, scroll position and all.
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
 * framework's own session feed, and every string comes from the locale seat.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentPageView } from '../types.ts'
import { foldFrames, NO_FRAMES, type CachedFrame, type FrameCache } from './frame-cache.ts'
import css from './ContentFrame.module.css'

/** Plain data this registration injects. */
export interface ContentFrameFace {
  /** How many sessions' frames stay alive at once, as the node half configured it. */
  cacheSize: number
  /** The deployment's default page, for the no-session state no projection covers. */
  defaultPage?: { url: string; title: string }
}

/** Composed props: the root runtime share, the injected face, and the locale seat. */
export type ContentFrameProps =
  & PropsRuntime<'content'>
  & ContentFrameFace
  & PropsLocale<'contentFrame'>

/**
 * Cache key of the frame shown with no session current. Session ids are never
 * empty, so this key can collide with none of them, and the no-session frame
 * ages out of the cache under the same rule as every other.
 */
const NO_SESSION = ''

/**
 * The page one projection value puts on display.
 * @param view - the `content` projection value.
 * @returns the URL to show, or undefined when the value is not a page.
 */
function viewUrl(view: ContentPageView): string | undefined {
  return view.state === 'shown' || view.state === 'default' ? view.url : undefined
}

/**
 * The frame the column shows now.
 * @param sessionId - the current session, or undefined in the no-session state.
 * @param view - that session's `content` projection value, while the host has published one.
 * @param defaultPage - the deployment's default page, when it configured one.
 * @returns the frame to show, or undefined when the column shows a notice instead.
 */
function activeFrame(
  sessionId: string | undefined,
  view: ContentPageView | undefined,
  defaultPage: { url: string } | undefined,
): CachedFrame | undefined {
  // No value yet means no session is current, or its history has not landed;
  // both are the default page's state, not a reason to blank the column.
  const url = view === undefined ? defaultPage?.url : viewUrl(view)
  if (url === undefined) return undefined
  return { sessionId: sessionId ?? NO_SESSION, url }
}

/**
 * Render the content column.
 * @param props - the session feed, the cache bound, the default page, and the locale seat.
 * @returns the column: every cached frame, plus a notice when none is on display.
 */
export function ContentFrame({ useSessions, cacheSize, defaultPage, t }: ContentFrameProps) {
  const sessionId = useSessions(state => state.current)
  const view = useSessions(state => (
    state.current === undefined ? undefined : state.byId[state.current]?.projectionValues?.content))
  const active = activeFrame(sessionId, view, defaultPage)

  // Derived state, not a subscription: the cache is a fold over the session
  // feed, and folding it during render is React's sanctioned form (the same
  // one the slot renderer's adoption bookkeeping uses). foldFrames returns its
  // input when nothing moved, so the update converges in one extra render.
  const [cache, setCache] = useState<FrameCache>(NO_FRAMES)
  const next = foldFrames(cache, active, cacheSize)
  if (next !== cache) setCache(next)

  return (
    <div className={css.column} data-content-column>
      {next.frames.map(frame => (
        <iframe
          key={frame.sessionId}
          className={frame.sessionId === active?.sessionId ? css.frame : `${css.frame} ${css.cached}`}
          src={frame.url}
          title={t('frame.title')}
          data-content-frame
          data-content-session={frame.sessionId}
          data-content-active={frame.sessionId === active?.sessionId || undefined}
        />
      ))}
      {active === undefined && (
        <p className={css.notice} data-content-notice>
          {t(view?.state === 'missing' ? 'frame.missing' : 'frame.empty')}
        </p>
      )}
    </div>
  )
}
