/**
 * Execute the switcher strip's close-button command.
 * @module @deepseek-ai/dsh-experimental-content-column/client/dismiss
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Command `@deepseek-ai/dsh-experimental-content-surface`'s node half registers
 * for a user-triggered dismissal. A literal copy of that package's
 * `DISMISS_CONTENT_ENTRY_COMMAND` rather than an imported value — see
 * `pages.ts`'s module doc in `dsh-experimental-server-sidebar` for why two
 * client-adjacent packages hardcode a shared name instead of importing it.
 */
const DISMISS_CONTENT_ENTRY_COMMAND = 'dismiss-content-entry'

/**
 * Execute `/dismiss-content-entry <kind> <entryId>` against a session,
 * warning (never throwing) on a failed dispatch or a rejected input.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session whose entry to dismiss.
 * @param kind - the dismissed entry's kind.
 * @param entryId - the dismissed entry's id within `kind`.
 */
export async function dismissContentEntry(ctx: ClientContext, sessionId: string, kind: string, entryId: string): Promise<void> {
  const result = await ctx.remote.commands.execute(sessionId as SessionId, `/${DISMISS_CONTENT_ENTRY_COMMAND} ${kind} ${entryId}`, [])
  if (!result.ok) {
    console.warn(`content-column: dismiss-content-entry failed: ${result.error.code}: ${result.error.message}`)
    return
  }
  if (result.value !== undefined && result.value.result.kind === 'error') {
    console.warn(`content-column: dismiss-content-entry: ${result.value.result.text}`)
  }
}
