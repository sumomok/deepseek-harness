/**
 * `conversation.chat.commandview` registrant for `SHOW_CONTENT_VIEW_COMMAND`:
 * nothing for a click the host took, the host's own sentence for one that named
 * no view, and the question a click on a data page is answered with.
 *
 * A click runs that command for the durable record it writes — the
 * `content-component/shown` the column is folded from — not to narrate in chat
 * a view the user just opened themselves; what the conversation shows of a
 * successful click is the block arriving in the column beside it. Registering
 * this component at the command's key replaces
 * `dsh-client-ui-conversation`'s default `GenericCommandCard` fallback, whose
 * row would read `show-content-view · Completed`.
 *
 * The two settlements that draw something are the two nobody else says. A click
 * that named no view puts nothing in the column, and a person who clicked a
 * menu row and watched nothing happen is owed the sentence saying so. And a
 * view that opens the deployment's own data page for a table is a question
 * before it is a draw: the host answers the first click with the card a call
 * for that page is put through, and this row is where that card is put to the
 * person who clicked. Agreeing runs the same command again with the value the
 * card carried; declining draws one line and sends nothing.
 *
 * The answer is this row's own state and nothing durable, because there is
 * nothing durable to write: a decline is a page that was not opened, and an
 * agreement has the command it runs to be read back from. A transcript loaded
 * again therefore shows the card as it was asked, and pressing it then is one
 * more click that ends at a fresh card (the README's Known Limitations records
 * it).
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
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readConsentQuestion } from '../consent-question.ts'
import type { ConsentReport } from './consent.ts'
import css from './ViewCommandRow.module.css'

/** What this row needs beside the folded command: where an agreement goes. */
export interface ViewCommandRowInjected {
  /**
   * Run the same command again with the card's own value, against the session
   * the card was drawn in. The registration binds the session, so the row
   * hands over the card and nothing else.
   */
  readonly onConsent: ConsentReport
}

/** Full props of this row: the chat's own share, the dispatch, and this package's dictionary. */
export type ViewCommandRowProps =
  & PropsRuntime<'conversation.chat.commandview', 'show-content-view'>
  & ViewCommandRowInjected
  & PropsLocale<'contentComponent'>

/** What this row's own reader has answered, for as long as it stays mounted. */
type Answer = 'allowed' | 'declined'

/**
 * Render the `show-content-view` command's row.
 * @param props - the folded command lifecycle node, the dispatch, and the translate.
 * @returns the question the click raised, the refusal it earned, or `null` for a click the host took and for one still running.
 */
export function ViewCommandRow({ node, onConsent, t }: ViewCommandRowProps) {
  const [answer, setAnswer] = useState<Answer | undefined>(undefined)
  const outcome = node.outcome
  const question = readConsentQuestion(outcome?.text)
  if (question !== undefined) {
    // An agreement draws nothing here for the reason a taken click does: the
    // page arriving in the column is the answer, and the command it runs draws
    // its own row.
    if (answer === 'allowed') return null
    if (answer === 'declined') return <p className={css.refusal} data-content-view-declined>{t('consent.declined')}</p>
    return (
      <div className={css.question} data-content-view-consent={question.view}>
        <p className={css.card}>{question.card}</p>
        <div className={css.answers}>
          <button
            type="button"
            className={`${css.answer} ${css.allow}`}
            data-content-view-allow
            onClick={() => {
              setAnswer('allowed')
              onConsent(question)
            }}
          >
            {t('consent.allow')}
          </button>
          <button
            type="button"
            className={css.answer}
            data-content-view-decline
            onClick={() => { setAnswer('declined') }}
          >
            {t('consent.decline')}
          </button>
        </div>
      </div>
    )
  }
  // Everything but a refusal draws nothing: a click the host took is answered
  // by the column, and a settlement with no sentence — a `done` whose `run`
  // fell outside the window folds into one — has nothing to draw either.
  if (outcome === null || outcome.kind !== 'error' || outcome.text === undefined) return null
  return <p className={css.refusal} data-content-view-refused>{outcome.text}</p>
}
