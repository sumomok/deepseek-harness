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
 * The seat holds the frame elements because it is the only placement that can:
 * `content_read` needs the live document, and both things this seat drives —
 * the reader and the navigation watch — live here for that reason alone. Each
 * frame keeps its own element numbering, dropped when the frame navigates:
 * refs name elements of one document, and a reloaded page is a different one.
 *
 * The watch follows the frame in front and no other. What a hidden frame is
 * doing is not what the user is looking at, and the two things the log records
 * about a page's address — the context assembled for each request and the ref
 * table a read resolves against — are both about the page in front.
 *
 * Everything else is presentation: the frame cache is component-local state
 * folded from the entry the column hands over, and every string comes from the
 * locale seat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Also pulls the content surface's `contentSurface` SessionProjectionMap merge.
import type { ContentSurfaceEntry, ContentSurfaceView } from '@deepseek-ai/dsh-experimental-content-surface/types'
import type { ContentFrameAccessSettings } from '../route.ts'
// Type-only: pulls this package's own `contentAccess` SessionProjectionMap merge.
import type { ContentPageView, ContentAccessRequest, ContentAccessView } from '../types.ts'
import { foldFrames, frameFor, NO_FRAMES, type CachedFrame, type FrameCache } from './frame-cache.ts'
import { RefTable } from './access/refs.ts'
import { TAB_ID, useContentRead, type SeatSession } from './access/executor.ts'
import { exportPixels } from './access/export-pixels.ts'
import { watchFrame, type FrameAddress, type FrameWatch } from './perception/navigation.ts'
import css from './ContentFrame.module.css'

/** Plain data and one callback this registration injects. */
export interface ContentFrameFace {
  /** How many (session, page) frames stay alive at once, as the node half configured it. */
  cacheSize: number
  /**
   * How often the frame in front is asked where it is, in milliseconds, as the
   * node half configured it. It is what catches a router that changes route
   * through `history.pushState`, which fires no event this seat can listen for.
   */
  navigationPollMs: number
  /** The reader's budget and deadlines; absent when the deployment configures no page access. */
  pageAccess?: ContentFrameAccessSettings
  /**
   * Record that the frame in front moved: appends `content/navigated` through
   * `/content-navigated` against `sessionId`. Fire-and-forget — nothing the
   * seat renders depends on it, and the log is what the agent reads.
   */
  onNavigated: (sessionId: string, page: string, url: string, title: string) => void
}

/** Composed props: the kind-seat runtime share, the injected face, and the locale seat. */
export type ContentFrameProps =
  & PropsRuntime<'content.surface.kind', 'page'>
  & ContentFrameFace
  & PropsLocale<'contentFrame'>

/** The empty entry list, shared so a session with no column does not re-render the seat. */
const NO_ENTRIES: readonly ContentSurfaceEntry[] = []

/** The empty pending list, shared for the same reason. */
const NO_CALLS: readonly ContentAccessRequest[] = []

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
  return { frameId: `${sessionId} ${entry.entryId}`, sessionId, entryId: entry.entryId, url: view.url }
}

/** One session row as this seat reads it: the two projection views its column publishes. */
interface SessionColumn {
  /** Absent for a session the host has published no projection value of yet. */
  readonly projectionValues?: Readonly<Partial<{
    /** That session's column entries. */
    contentSurface: ContentSurfaceView
    /** That session's open channel calls. */
    contentAccess: ContentAccessView
  }>>
}

/**
 * The columns this seat can answer for, one per session it holds a page of.
 *
 * The session on display takes its page from the column's own selection, which
 * is where the user's pick among several entries lives and the only thing this
 * seat is handed rather than deriving. Every other session takes it from the
 * frame cache: the entry it last had in front is the one whose document is
 * still mounted here. A session whose entry has since left the column, stopped
 * being a shown page, or had its frame evicted is left off entirely, so the
 * reader never bids for a call it has no document to answer.
 * @param summaries - every session row the console holds, by session id.
 * @param cache - this seat's frames and their recency.
 * @param current - the session the column is showing, when one is.
 * @param entry - the entry that session has in front, when it has one.
 * @param currentFrameId - the frame that entry is showing, when it has one.
 * @returns one column per session this seat can serve.
 */
function seatSessions(
  summaries: Readonly<Record<string, SessionColumn>>,
  cache: FrameCache,
  current: string | undefined,
  entry: ContentFrameProps['entry'],
  currentFrameId: string | undefined,
): SeatSession[] {
  const sessions: SeatSession[] = []
  for (const [sessionId, summary] of Object.entries(summaries)) {
    const values = summary.projectionValues
    const entries = values?.contentSurface?.entries ?? NO_ENTRIES
    const pending = values?.contentAccess?.pending ?? NO_CALLS
    if (sessionId === current) {
      const page = entry === undefined ? undefined : { id: entry.entryId, title: entry.title }
      sessions.push({ sessionId, entries, pending, page, frameId: currentFrameId })
      continue
    }
    const cached = frameFor(cache, sessionId)
    if (cached === undefined) continue
    const shown = entries.find(item => item.entryId === cached.entryId)
    if (shown === undefined || pageView(shown.payload)?.state !== 'shown') continue
    sessions.push({
      sessionId,
      entries,
      pending,
      page: { id: shown.entryId, title: shown.title },
      frameId: cached.frameId,
    })
  }
  return sessions
}

/** One frame's two DOM callbacks, cached so React does not re-run them every render. */
interface FrameHandlers {
  /** Registers and withdraws the element itself. */
  readonly ref: (node: HTMLIFrameElement | null) => void
  /** Retires the numbering of the document being navigated away from. */
  readonly onLoad: () => void
}

/**
 * Render the page seat.
 * @param props - the column's selection, the two bounds and the reader's
 * settings the node half configured, the navigation callback, and the locale
 * seat. Taken whole because the navigation watch reads them live, one render
 * after the one that armed it.
 * @returns every cached frame, plus a notice when the selected page is gone.
 */
export function ContentFrame(props: ContentFrameProps) {
  const { sessionId, entry, cacheSize, navigationPollMs, pageAccess, useSessions, t } = props
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

  const frames = useRef<Map<string, HTMLIFrameElement>>(new Map())
  const tables = useRef<Map<string, RefTable>>(new Map())
  const handlers = useRef<Map<string, FrameHandlers>>(new Map())
  const watches = useRef<Map<string, FrameWatch>>(new Map())
  // Where each frame was last reported to be, kept by the seat because a watch
  // is remade every time its frame comes back to the front (see
  // `FrameWatchOptions.lastReported`).
  const reported = useRef<Map<string, FrameAddress>>(new Map())

  // Read live by the watch below, which outlives the render that created it.
  const live = useRef(props)
  useEffect(() => { live.current = props })

  // The seat is root-scoped, so the framework binds no `useProjection` here and
  // every session's values are read off the list snapshot every root slot gets.
  // The whole list, not the current session's row: the frames of the sessions
  // behind the one on display are mounted here too, and their calls are this
  // seat's to answer.
  const summaries = useSessions(state => state.byId)
  const activeFrameId = active?.frameId
  const sessions = useMemo(
    () => seatSessions(summaries, next, sessionId, entry, activeFrameId),
    [summaries, next, sessionId, entry, activeFrameId],
  )

  useContentRead({
    sessions,
    frames,
    tables,
    access: pageAccess,
    tabId: TAB_ID,
    draw: exportPixels,
  })

  const activeUrl = active?.url
  const page = entry?.entryId
  useEffect(() => {
    if (sessionId === undefined || activeFrameId === undefined || activeUrl === undefined || page === undefined) return
    const element = frames.current.get(activeFrameId)
    /* v8 ignore next -- the frame in front is always rendered, and React runs its ref callback before this effect */
    if (element === undefined) return
    const watch = watchFrame({
      frame: element,
      entryUrl: activeUrl,
      lastReported: reported.current.get(activeFrameId),
      onNavigated: (address) => {
        reported.current.set(activeFrameId, address)
        live.current.onNavigated(sessionId, page, address.url, address.title)
      },
    })
    watches.current.set(activeFrameId, watch)
    const polling = setInterval(() => { watch.poll() }, navigationPollMs)
    return () => {
      clearInterval(polling)
      watches.current.delete(activeFrameId)
      watch.dispose()
    }
  }, [sessionId, activeFrameId, activeUrl, page, navigationPollMs])

  const handlersFor = useCallback((frameId: string): FrameHandlers => {
    const known = handlers.current.get(frameId)
    if (known !== undefined) return known
    const minted: FrameHandlers = {
      ref: (node) => {
        if (node === null) {
          frames.current.delete(frameId)
          tables.current.delete(frameId)
          handlers.current.delete(frameId)
          // The element is gone, so the next frame under this id is a fresh
          // document with nothing reported about it.
          reported.current.delete(frameId)
          return
        }
        frames.current.set(frameId, node)
      },
      // Numbers are never reused, so a ref the model still holds from the
      // previous document resolves to nothing rather than to whatever element
      // inherited its place. The watch re-arms on the same signal: a load
      // replaced the window its listeners were registered on.
      onLoad: () => {
        tables.current.get(frameId)?.reset()
        watches.current.get(frameId)?.reload()
      },
    }
    handlers.current.set(frameId, minted)
    return minted
  }, [])

  return (
    <div className={css.column} data-content-column>
      {next.frames.map((frame) => {
        const { ref, onLoad } = handlersFor(frame.frameId)
        return (
          <iframe
            key={frame.frameId}
            ref={ref}
            onLoad={onLoad}
            className={frame.frameId === active?.frameId ? css.frame : `${css.frame} ${css.cached}`}
            src={frame.url}
            title={t('frame.title')}
            data-content-frame
            data-content-frame-id={frame.frameId}
            data-content-active={frame.frameId === active?.frameId || undefined}
          />
        )
      })}
      {retired && (
        <p className={css.notice} data-content-notice>{t('frame.missing')}</p>
      )}
    </div>
  )
}
