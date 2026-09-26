/**
 * `conversation.chat.commandview` registrant for `SHOW_CONTENT_VIEW_COMMAND`:
 * nothing for a click the host took, and the host's own sentence for one that
 * named no view.
 *
 * A click runs that command for the durable record it writes — the
 * `content-component/shown` the column is folded from — not to narrate in chat
 * a view the user just opened themselves; what the conversation shows of a
 * successful click is the block arriving in the column beside it. Registering
 * this component at the command's key replaces
 * `dsh-client-ui-conversation`'s default `GenericCommandCard` fallback, whose
 * row would read `show-content-view · Completed`.
 *
 * The one settlement that draws something is the one nobody else says: a click
 * that named no view puts nothing in the column, and a person who clicked a
 * menu row and watched nothing happen is owed the sentence saying so. The
 * question a data-page click raises is not drawn here — a chat row is not on
 * screen for a session that has never run a turn, which is where most of these
 * clicks are made (see `ViewConsentDock.tsx`).
 *
 * The row's DOM anchor still exists after this returns null. What removes the
 * resulting empty flex item is the stylesheet
 * `dsh-experimental-content-column` installs, which collapses an empty
 * commandview row regardless of which command left it empty; this package
 * requires that row for the column it draws in, so the rule is present wherever
 * this registration is. A row carrying a sentence is not empty, and that same
 * rule leaves it alone.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/ViewCommandRow
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ViewCommandRow.module.css'

/** Full props of this row: the chat's own share and nothing else. */
export type ViewCommandRowProps = PropsRuntime<'conversation.chat.commandview', 'show-content-view'>

/**
 * Render the `show-content-view` command's row.
 * @param props - the folded command lifecycle node.
 * @returns the refusal the click earned, or `null` for a click the host took and for one still running.
 */
export function ViewCommandRow({ node }: ViewCommandRowProps) {
  const outcome = node.outcome
  // Everything but a refusal draws nothing: a click the host took is answered
  // by the column, a question is answered above the composer, and a settlement
  // with no sentence — a `done` whose `run` fell outside the window folds into
  // one — has nothing to draw either.
  if (outcome === null || outcome.kind !== 'error' || outcome.text === undefined) return null
  return <p className={css.refusal} data-content-view-refused>{outcome.text}</p>
}
