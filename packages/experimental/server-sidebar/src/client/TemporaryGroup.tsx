/**
 * The 临时工作流 (temporary workflows) section: the conversations this process
 * can see that no other row in this shell already shows. Membership and order
 * are `workflow-actions.ts`'s `temporarySessions`; the cut to a first few rows
 * is its `collapsedRows`. This component is presentation over what it is
 * handed.
 *
 * A row shows the conversation's own durable title and nothing else. There is
 * deliberately no fallback chain behind it: the session list's `displayTitle`
 * falls back to a directory basename and then to a bare id, which are the
 * internal vocabulary this console exists to keep off the screen (see the
 * package README's De-terminology section) — and a bare id is not something a
 * banned-word check can catch. A conversation with no durable title gets
 * fixed copy instead.
 *
 * 移出列表 (remove from the list) archives the conversation rather than
 * deleting it: the log survives on the host. This console offers no way back
 * to an archived conversation, so the control asks for a second click before
 * it commits, and the armed row is drawn so that a second click cannot commit
 * by accident: 确定移出 opens to the LEFT, and the row's right edge — where
 * the 移出列表 icon just was, and where a double click's second press lands —
 * becomes 取消. Escape disarms as well, from wherever the focus went. The
 * armed row drops its relative time: the column is narrow, and the two
 * controls would otherwise squeeze the title down to a character or two — the
 * question is what that row has to say while it is asked.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/TemporaryGroup
 */
import { useEffect, useState } from 'react'
import { IconCloseOutline16, IconTriangleRightFill14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServerSidebarKey } from './locales.ts'
import { collapsedRows } from './workflow-actions.ts'
import css from './SidebarGroups.module.css'

/** Milliseconds in each unit {@link relativeTime} reports. */
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** One unnamed conversation, already filtered and ordered by the caller. */
export interface TemporaryRow {
  /** The conversation's id: what a click opens and what 移出列表 archives. */
  id: string
  /** Its durable title, or `undefined` when it has none yet (the row then shows fixed copy). */
  title: string | undefined
  /** When it last changed (epoch ms) — what the row's relative time reports. */
  updatedAt: number
  /** Whether it finished while unselected and unopened (decision ④'s green dot). */
  unread: boolean
  /** Whether it is the conversation currently open. */
  active: boolean
}

/** Full props of the temporary section. */
export interface TemporaryGroupProps {
  /** The rows to draw, most recently updated first. */
  rows: readonly TemporaryRow[]
  /** Whether the section is folded shut; a display preference the store persists per browser. */
  collapsed: boolean
  /** Fold the section shut or open it. */
  onSetCollapsed: (collapsed: boolean) => void
  /** Whether every row shows rather than the first few. */
  expanded: boolean
  /** Show every row; 显示更多 never asks to go back, and the store remembers the answer per browser. */
  onSetExpanded: (expanded: boolean) => void
  /** Open one conversation. Not awaited by this component. */
  onOpen: (sessionId: string) => Promise<void>
  /** Take one conversation off this list; it is archived, not deleted. Not awaited by this component. */
  onDismiss: (sessionId: string) => Promise<void>
  /**
   * Whether the last 移出列表 was refused. Reported here rather than in
   * 我的工作流 because that is the section the click was in, and in this
   * section's own fixed wording: nothing about an archive is a save, and the
   * refusal's own text is the host runtime's (see `locales.ts`).
   */
  failed: boolean
  /** Locale seat. */
  t: (key: ServerSidebarKey, vars?: Record<string, string>) => string
}

/**
 * Report how long ago something happened, in the coarsest unit that still
 * says something: under a minute, then whole minutes, hours, and days. Days
 * do not roll over into weeks or months — a row that old reads as "a while
 * back" either way, and the exact time is on the conversation itself.
 * @param updatedAt - when it last changed (epoch ms).
 * @param now - the moment to measure against (epoch ms); an `updatedAt` in
 * the future reads as just now rather than as a negative count.
 * @param t - locale seat.
 * @returns the phrase to draw.
 */
export function relativeTime(
  updatedAt: number, now: number, t: (key: ServerSidebarKey, vars?: Record<string, string>) => string,
): string {
  const elapsed = Math.max(0, now - updatedAt)
  if (elapsed < MINUTE_MS) return t('time.now')
  if (elapsed < HOUR_MS) return t('time.minutes', { count: String(Math.floor(elapsed / MINUTE_MS)) })
  if (elapsed < DAY_MS) return t('time.hours', { count: String(Math.floor(elapsed / HOUR_MS)) })
  return t('time.days', { count: String(Math.floor(elapsed / DAY_MS)) })
}

/**
 * Render the temporary section.
 * @param props - see {@link TemporaryGroupProps}.
 * @returns the section element tree.
 */
export function TemporaryGroup({
  rows, collapsed, onSetCollapsed, expanded, onSetExpanded, onOpen, onDismiss, failed, t,
}: TemporaryGroupProps) {
  const [confirming, setConfirming] = useState<string | null>(null)
  // Read once per render rather than from a ticking clock: a relative time is
  // a rough marker here, and the section re-renders on every session-list
  // change, which is what actually moves a row's `updatedAt`.
  const now = Date.now()
  const { visible, hiddenCount } = collapsedRows(rows, expanded)

  // Listened for on the document rather than on the row: a click arms the row
  // without leaving the focus anywhere this component owns, so a handler bound
  // to the row would never see the key.
  useEffect(() => {
    if (confirming === null) return undefined
    const disarm = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConfirming(null)
    }
    document.addEventListener('keydown', disarm)
    return () => { document.removeEventListener('keydown', disarm) }
  }, [confirming])

  return (
    <section className={css.group} data-server-sidebar-section="temporary">
      <div className={css.groupHead}>
        <button
          type="button"
          className={css.caret}
          data-expanded={!collapsed}
          aria-label={collapsed ? t('groups.expand') : t('groups.collapse')}
          aria-expanded={!collapsed}
          onClick={() => {
            setConfirming(null)
            onSetCollapsed(!collapsed)
          }}
        >
          <IconTriangleRightFill14 size={10} />
        </button>
        <h3 className={css.groupTitle}>{t('temporary.title')}</h3>
      </div>
      {failed && <p className={css.error} role="alert">{t('temporary.error')}</p>}
      {!collapsed && rows.length === 0 && <p className={css.empty}>{t('temporary.empty')}</p>}
      {!collapsed && rows.length > 0 && (
        <ul className={css.list}>
          {visible.map(row => (
            <li key={row.id} className={css.workflowRow}>
              <button
                type="button"
                className={css.itemButton}
                data-active={row.active}
                onClick={() => { void onOpen(row.id) }}
              >
                {row.unread && <span className={css.dot} aria-hidden="true" />}
                <span className={css.rowName}>{row.title ?? t('temporary.untitled')}</span>
                {confirming !== row.id && (
                  <span className={css.rowTime}>{relativeTime(row.updatedAt, now, t)}</span>
                )}
              </button>
              <div className={css.workflowActions}>
                {confirming === row.id ? (
                  <>
                    <button
                      type="button"
                      className={css.confirmButton}
                      onClick={() => {
                        setConfirming(null)
                        void onDismiss(row.id)
                      }}
                    >
                      {t('temporary.dismissConfirm')}
                    </button>
                    <Tooltip label={t('temporary.dismissCancel')} side="bottom" delayMs={500}>
                      <button
                        type="button"
                        className={css.iconButton}
                        aria-label={t('temporary.dismissCancel')}
                        onClick={() => { setConfirming(null) }}
                      >
                        <IconCloseOutline16 size={12} />
                      </button>
                    </Tooltip>
                  </>
                ) : (
                  <Tooltip label={t('temporary.dismiss')} side="bottom" delayMs={500}>
                    <button
                      type="button"
                      className={css.iconButton}
                      aria-label={t('temporary.dismiss')}
                      onClick={() => { setConfirming(row.id) }}
                    >
                      <IconCloseOutline16 size={12} />
                    </button>
                  </Tooltip>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!collapsed && hiddenCount > 0 && (
        <button type="button" className={css.moreButton} onClick={() => { onSetExpanded(true) }}>
          {t('temporary.more')}
        </button>
      )}
    </section>
  )
}
