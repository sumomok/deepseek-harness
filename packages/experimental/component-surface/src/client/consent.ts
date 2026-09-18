/**
 * Carry one person's agreement to open a data page back to the host.
 *
 * The agreeing click runs the same command the sidebar row ran, with the
 * one-time value the card carried on the line, so what a person agreed to lands
 * in the session log as that command's own recorded input. The host owns every
 * decision about it; what is here is the dispatch.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/consent
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatViewCommandLine, type ConsentQuestion } from '../consent-question.ts'
import { SHOW_CONTENT_VIEW_COMMAND } from '../view-command.ts'

/** Where an agreed card goes, with the session it was drawn in already bound. */
export type ConsentReport = (question: ConsentQuestion) => void

/**
 * Execute `/show-content-view <view> <nonce>` against a session.
 *
 * Nothing is reported back. What the person sees of their own agreement is the
 * page arriving in the column beside the conversation, and what they see of an
 * agreement the host would not take is the card drawn again in a new row —
 * both of which come off the session log rather than off this call. A dispatch
 * that never reached the host leaves a warning in the browser console and the
 * card they pressed where it was.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session the card was drawn in.
 * @param question - the card as the host wrote it, carrying the view and the value that redeems it.
 */
export function postConsent(ctx: ClientContext, sessionId: SessionId, question: ConsentQuestion): void {
  // The gateway seam, not a same-process call: a closed socket, a gateway that
  // restarted, or a session the host no longer holds reject the promise.
  void ctx.remote.commands.execute(sessionId, `/${SHOW_CONTENT_VIEW_COMMAND} ${formatViewCommandLine(question.view, question.nonce)}`, [])
    .then((result) => {
      if (!result.ok) {
        console.warn(`component-surface: ${SHOW_CONTENT_VIEW_COMMAND} failed: ${result.error.code}: ${result.error.message}`)
      }
    })
    .catch((reason: unknown) => {
      console.warn(`component-surface: ${SHOW_CONTENT_VIEW_COMMAND} did not reach the host: ${String(reason)}`)
    })
}
