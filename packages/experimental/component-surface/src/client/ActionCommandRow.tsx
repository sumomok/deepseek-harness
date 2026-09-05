/**
 * `conversation.chat.commandview` registrant for `COMPONENT_ACTION_COMMAND`:
 * nothing for a press the host simply took, and the host's own sentence for one
 * it could not act on now.
 *
 * A press runs that command for its durable record — `command/run` carries the
 * action document verbatim — not to narrate in chat a button the user just
 * pressed themselves; what the conversation shows of a press the agent is
 * reading is the notice the agent claims. Registering this component at the
 * command's key replaces `dsh-client-ui-conversation`'s default
 * `GenericCommandCard` fallback, whose row would read
 * `component-action · Completed`.
 *
 * The two settlements that carry a sentence are the two the person who pressed
 * cannot learn any other way. A refused press reaches no agent at all, so no
 * notice and no answer follows it. A press that only reached the inbox will be
 * read, but not until the user writes again, and nothing else in the
 * conversation says so. The row draws whichever sentence the handler answered
 * with — each already one end-user sentence in the user's own language — and
 * nothing else about the command; a refusal reads as the failure it is, a
 * waiting press as an ordinary line.
 *
 * The row's DOM anchor still exists after this returns null. What removes the
 * resulting empty flex item is the stylesheet
 * `dsh-experimental-content-column` installs, which collapses an empty
 * commandview row regardless of which command left it empty; this package
 * requires that row for the column it draws in, so the rule is present
 * wherever this registration is. A row carrying a sentence is not empty, and
 * that same rule leaves it alone.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/ActionCommandRow
 */
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ActionCommandRow.module.css'

/**
 * Render the `component-action` command's row.
 * @param props - the folded command lifecycle node, as the chat view hands it over.
 * @returns the sentence the press earned, or `null` for a press the host simply took and for one still running.
 */
export function ActionCommandRow({ node }: CommandRowProps) {
  const outcome = node.outcome
  // A settlement carrying no sentence is a press the host took: what the
  // conversation shows of it is the notice the agent claims, not a row here.
  // The chat view types a settlement's text as optional for a second reason —
  // a `done` whose `run` fell outside the window folds into a node with
  // neither — and this row has nothing to say in that case either.
  if (outcome === null || outcome.text === undefined) return null
  const refused = outcome.kind === 'error'
  return (
    <p
      className={refused ? css.refusal : css.notice}
      data-component-action-refused={refused || undefined}
      data-component-action-waiting={refused ? undefined : true}
    >
      {outcome.text}
    </p>
  )
}
