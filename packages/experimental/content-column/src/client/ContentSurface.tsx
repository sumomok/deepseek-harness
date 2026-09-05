/**
 * The content column: a switcher strip over one mounted seat per content kind.
 *
 * The column is a `single`, `root` slot, so this component mounts once for the
 * page's life and owns every session transition itself. It reads the current
 * session and that session's `contentSurface` entries through the root standard
 * hook, keeps one seat per kind it has ever seen, and hides the seats that do
 * not own the selection instead of unmounting them — a kind renderer may hold
 * DOM that must survive both a session switch and a switch to another kind.
 *
 * Both tab gestures are logged decisions, dispatched through this
 * registration's own injected face (wired in `client/index.ts`). Selecting a
 * tab goes to `/select-content-entry` and comes back as the stream's own
 * `front`; closing one goes to `/dismiss-content-entry`, and the entry leaving
 * the stream is what `selectedEntry`'s fallback then reacts to.
 *
 * What stays component-local is one click per session (a root slot means the
 * framework clears nothing on a switch), held only until the record of it
 * arrives — and given up before then to any entry recorded after the click, so
 * a page the agent shows lands in front of a tab the user picked a moment
 * earlier. A freshly loaded page holds no click at all and reads `front`.
 *
 * Each tab is a wrapper `<div>` around two sibling `<button>`s — selection and
 * close — never a button nested inside a button. `data-content-surface-entry`
 * and `data-content-surface-selected` stay on the selection button; the wrapper
 * carries no attribute of its own. A tab shows the entry's title and nothing
 * else: the kind is how the column routes an entry to a seat, not a word this
 * column can put in front of a user, and it stays in `data-content-surface-entry`
 * for tests and styling.
 *
 * Pure presentation: the seats and the selection are pure folds over the
 * framework's own session feed, and every string comes from the locale seat.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import {
  entryKeyOf, foldSeats, NO_ENTRIES, NO_SEATS, pickedAt, selectedEntry, type PickedEntry, type SurfaceSeats,
} from './surface-seats.ts'
import css from './ContentSurface.module.css'

/** This registration's own injected face, wired in `client/index.ts`. */
export interface ContentSurfaceInjected {
  /**
   * Close one entry's tab: appends `content-surface/dismissed` through
   * `/dismiss-content-entry` against `sessionId`. Fire-and-forget from the
   * component's own perspective — the entry leaving `entries` on the next
   * render is the visible effect, not this call's return.
   */
  onDismiss: (sessionId: string, kind: string, entryId: string) => void
  /**
   * Bring one entry's tab to the front: appends `content-surface/selected`
   * through `/select-content-entry` against `sessionId`. Fire-and-forget for
   * the same reason — the column already moved on the click itself, and this
   * is what makes the move survive a reload and reach the agent.
   */
  onSelect: (sessionId: string, kind: string, entryId: string) => void
}

/** Composed props: the root runtime share, the kind-slot render share, this registration's injected face, and the locale seat. */
export type ContentSurfaceProps =
  & PropsRuntime<'content'>
  & PropsRenderSlots<'content.surface.kind'>
  & ContentSurfaceInjected
  & PropsLocale<'contentSurface'>

/**
 * Render the content column.
 * @param props - the session feed, the kind-slot dispatcher, the two tab callbacks, and the locale seat.
 * @returns the switcher strip, every mounted kind seat, and the empty-state notice.
 */
export function ContentSurface({ useSessions, renderSlot, onDismiss, onSelect, t }: ContentSurfaceProps) {
  const sessionId = useSessions(state => state.current)
  const entries: readonly ContentSurfaceEntry[] = useSessions(state => (
    state.current === undefined
      ? undefined
      : state.byId[state.current]?.projectionValues?.contentSurface?.entries)) ?? NO_ENTRIES
  const front = useSessions(state => (
    state.current === undefined
      ? undefined
      : state.byId[state.current]?.projectionValues?.contentSurface?.front))

  // Per session, because a root slot survives every switch: the framework
  // clears nothing, so the column carries the click it is still waiting on
  // itself. The recorded decision comes back as `front`.
  const [picked, setPicked] = useState<Readonly<Record<string, PickedEntry>>>({})
  const selected = selectedEntry(entries, sessionId === undefined ? undefined : picked[sessionId], front)

  // Derived state, not a subscription: the seat list is a fold over the session
  // feed, and folding it during render is React's sanctioned form. foldSeats
  // returns its input when nothing is new, so the update converges in one
  // extra render.
  const [seats, setSeats] = useState<SurfaceSeats>(NO_SEATS)
  const next = foldSeats(seats, entries)
  if (next !== seats) setSeats(next)

  return (
    <div className={css.column} data-content-surface>
      {/* No session means no entries, so the strip has nothing to list and its
          absence is what says so — the empty-state notice below carries the copy. */}
      {sessionId !== undefined && (
        <nav className={css.switcher} aria-label={t('switcher.label')} data-content-surface-switcher>
          {entries.map((entry) => {
            const key = entryKeyOf(entry)
            const active = selected !== undefined && entryKeyOf(selected) === key
            return (
              <div key={key} className={active ? `${css.tab} ${css.tabSelected}` : css.tab}>
                <button
                  type="button"
                  className={css.entry}
                  data-content-surface-entry={key}
                  data-content-surface-selected={active || undefined}
                  onClick={() => {
                    setPicked(current => ({ ...current, [sessionId]: pickedAt(entries, key) }))
                    onSelect(sessionId, entry.kind, entry.entryId)
                  }}
                >
                  <span className={css.entryTitle}>{entry.title}</span>
                </button>
                {/* A sibling button, never nested inside the one above: closing
                    a tab and selecting it are two independent gestures. */}
                <button
                  type="button"
                  className={css.dismiss}
                  data-content-surface-dismiss={key}
                  aria-label={t('entry.dismiss', { title: entry.title })}
                  onClick={() => { onDismiss(sessionId, entry.kind, entry.entryId) }}
                >
                  ×
                </button>
              </div>
            )
          })}
        </nav>
      )}
      <div className={css.stage}>
        {next.kinds.map((kind) => {
          const active = selected?.kind === kind
          return (
            <div
              key={kind}
              className={active ? css.seat : `${css.seat} ${css.hidden}`}
              data-content-surface-seat={kind}
              data-content-surface-active={active || undefined}
            >
              {renderSlot('content.surface.kind', {
                sessionId,
                entry: active ? selected : undefined,
              }, {
                entryKey: kind,
                fallback: <p className={css.notice}>{t('entry.unsupported', { kind })}</p>,
              })}
            </div>
          )
        })}
        {selected === undefined && (
          <p className={css.notice} data-content-surface-empty>{t('column.empty')}</p>
        )}
      </div>
    </div>
  )
}
