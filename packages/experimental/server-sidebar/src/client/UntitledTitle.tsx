/**
 * The session header's title for a conversation with no durable title.
 *
 * `dsh-client-ui-conversation`'s session header draws the session list's
 * `displayTitle` as its current crumb, and that value falls back to the
 * basename of the session's working directory, then to the bare session id,
 * whenever the session carries no durable title — the vocabulary this console
 * keeps off the screen (see the package README's De-terminology section). The
 * header's title slot cannot be replaced from outside: its child seats are
 * declared by the shipped entry, and only the declaring entry may render them.
 *
 * This component is an entry in the header's `conversation.session.header.actions`
 * list, ordered ahead of every other action. While the session has no durable
 * title it renders this package's own name for the console's conversation,
 * `workbench.label` (工作台 / Workbench), and marks itself with
 * `data-server-sidebar-untitled-title`; `terminology-guard.ts` hides the
 * header's crumb navigation whenever the header holds that mark, so the copy
 * takes the crumb's place. A session with a durable title renders nothing here
 * and keeps the shipped crumb. A delegated session is left to the shipped
 * lineage crumbs; this console's presets delegate nothing.
 *
 * The decision reads `title`, never `displayTitle`: a durable title that
 * happens to equal the directory basename is still the conversation's own.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/UntitledTitle
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's declaration of `conversation.session.header.actions`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './UntitledTitle.module.css'

/** Full props: the header-action runtime share and this package's locale seat. */
export type UntitledTitleProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'serverSidebar'>

/** The two session-list row fields the decision reads. */
export interface TitleFacts {
  /** The durable title, absent until the host projects one. */
  readonly title?: string | undefined
  /** `'subagent'` for a delegated session. */
  readonly origin?: string | undefined
}

/**
 * Whether the header would fall back from a durable title for this session.
 * @param summary - the session's row in the session list, or `undefined`
 *   while it has not arrived.
 * @returns true when the session is not delegated and carries no non-blank
 *   durable title, including while its row has not arrived.
 */
export function lacksDurableTitle(summary: TitleFacts | undefined): boolean {
  if (summary?.origin === 'subagent') return false
  const title = summary?.title?.trim()
  return title === undefined || title.length === 0
}

/**
 * Render the console's title for an untitled conversation, or nothing.
 * @param props - see {@link UntitledTitleProps}.
 * @returns the marked title element, or `null` for a titled or delegated session.
 */
export function UntitledTitle({ sessionId, useSessions, t }: UntitledTitleProps) {
  const untitled = useSessions(list => lacksDurableTitle(list.byId[sessionId]))
  if (!untitled) return null
  return (
    <span className={css.title} data-server-sidebar-untitled-title="">
      {t('workbench.label')}
    </span>
  )
}
