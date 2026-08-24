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
 * Which entry is on display is a viewing decision, not a logged one: it lives
 * in component-local state keyed by session id (a root slot means the framework
 * clears nothing on a switch), it defaults to the newest entry, and it never
 * reaches the session log.
 *
 * Pure presentation: the seats and the selection are pure folds over the
 * framework's own session feed, and every string comes from the locale seat.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { entryKeyOf, foldSeats, NO_ENTRIES, NO_SEATS, selectedEntry, type SurfaceSeats } from './surface-seats.ts'
import css from './ContentSurface.module.css'

/** Composed props: the root runtime share, the kind-slot render share, and the locale seat. */
export type ContentSurfaceProps =
  & PropsRuntime<'content'>
  & PropsRenderSlots<'content.surface.kind'>
  & PropsLocale<'contentSurface'>

/**
 * Render the content column.
 * @param props - the session feed, the kind-slot dispatcher, and the locale seat.
 * @returns the switcher strip, every mounted kind seat, and the empty-state notice.
 */
export function ContentSurface({ useSessions, renderSlot, t }: ContentSurfaceProps) {
  const sessionId = useSessions(state => state.current)
  const entries: readonly ContentSurfaceEntry[] = useSessions(state => (
    state.current === undefined
      ? undefined
      : state.byId[state.current]?.projectionValues?.contentSurface?.entries)) ?? NO_ENTRIES

  // Per session, because a root slot survives every switch: the framework
  // clears nothing, so the column carries one choice per session itself.
  const [picked, setPicked] = useState<Readonly<Record<string, string>>>({})
  const selected = selectedEntry(entries, sessionId === undefined ? undefined : picked[sessionId])

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
              <button
                key={key}
                type="button"
                className={active ? `${css.entry} ${css.selected}` : css.entry}
                data-content-surface-entry={key}
                data-content-surface-selected={active || undefined}
                onClick={() => { setPicked(current => ({ ...current, [sessionId]: key })) }}
              >
                <span className={css.entryTitle}>{entry.title}</span>
                <span className={css.entryKind}>{entry.kind}</span>
              </button>
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
