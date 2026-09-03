/**
 * Execute the switcher strip's tab-selection command.
 * @module @deepseek-ai/dsh-experimental-content-column/client/select
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Command `@deepseek-ai/dsh-experimental-content-surface`'s node half registers
 * for a user-chosen tab. A literal copy of that package's
 * `SELECT_CONTENT_ENTRY_COMMAND` rather than an imported value — see
 * `pages.ts`'s module doc in `dsh-experimental-server-sidebar` for why two
 * client-adjacent packages hardcode a shared name instead of importing it.
 */
const SELECT_CONTENT_ENTRY_COMMAND = 'select-content-entry'

/**
 * Execute `/select-content-entry <kind> <entryId>` against a session, warning
 * (never throwing) on a failed dispatch or a rejected input.
 *
 * The column has already moved by the time this runs, so a failure costs the
 * record rather than the click: the tab the user pressed stays in front until
 * the page reloads, at which point the stream's `front` — which this call is
 * what writes — decides again.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session whose entry moves to the front.
 * @param kind - the selected entry's kind.
 * @param entryId - the selected entry's id within `kind`.
 */
export async function selectContentEntry(ctx: ClientContext, sessionId: string, kind: string, entryId: string): Promise<void> {
  const result = await ctx.remote.commands.execute(sessionId as SessionId, `/${SELECT_CONTENT_ENTRY_COMMAND} ${kind} ${entryId}`, [])
  if (!result.ok) {
    console.warn(`content-column: select-content-entry failed: ${result.error.code}: ${result.error.message}`)
    return
  }
  if (result.value !== undefined && result.value.result.kind === 'error') {
    console.warn(`content-column: select-content-entry: ${result.value.result.text}`)
  }
}
