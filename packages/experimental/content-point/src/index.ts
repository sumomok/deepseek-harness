/**
 * @deepseek-ai/dsh-experimental-content-point — 「指一下」: the user points at a
 * place in the content column or the sidebar, and the model is told where. The
 * browser half (`./client`) files each point as a reference under
 * {@link POINT_SOURCE}; before each step, this host half appends the logged
 * message `./notice.ts` writes after each user message carrying them.
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
