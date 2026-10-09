/**
 * @deepseek-ai/dsh-experimental-content-point — 「指一下」: the user points at a
 * place in the content column or the sidebar, and the model is told where.
 *
 * The browser half (`./client`) puts a button in the composer's tool row; a
 * click starts `@haoran/dsh-point-anchor`'s picker over the console document,
 * and the place clicked becomes a reference draft in the attachment row, filed
 * under {@link POINT_SOURCE}. Its `data` is point-anchor's description of the
 * place without the DataPage row, or, for a block point-anchor does not
 * describe, a block reference (`./block`). The send records the references on
 * the accepted user message's source; no provider request carries a source.
 *
 * This host half makes them model-visible. Before each step it reads the user
 * messages entering it and, after each one carrying references of
 * {@link POINT_SOURCE}, appends one logged user message whose text writes each
 * of them — at most `MAX_PROMPT_REFERENCES` — with its key line and display
 * text and no row value. The appended message's source is the
 * `content-point` kind this module declares, naming the message it answers, so
 * a step that already holds it appends nothing more. It appends no session
 * event and writes no `content-component/shown`.
 * @module @deepseek-ai/dsh-experimental-content-point
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { withPointNotices } from './notice.ts'

export { POINT_SOURCE } from './text.ts'
export { POINT_MESSAGE_KIND } from './notice.ts'

/** Stable Cordis plugin name. */
export const name = 'content-point'

/**
 * Append the text of each user message's points before the step it enters.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    return { ...decision, messages: withPointNotices(decision.messages) }
  })
}
