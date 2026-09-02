/**
 * Execute the page seat's own navigation-report command.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/perception/navigated
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Command this package's node half registers for a frame that moved. A literal
 * copy of that half's `CONTENT_NAVIGATED_COMMAND` rather than an imported
 * value: the two halves of this package are bundled separately, and the client
 * bundle takes nothing from the node entry point.
 */
const CONTENT_NAVIGATED_COMMAND = 'content-navigated'

/**
 * Percent-encode the whitespace in one address.
 *
 * The command line is split on spaces, and the title after the address may
 * carry its own — so the address may not. Encoding only the whitespace leaves
 * everything a router already encoded exactly as the page wrote it, which is
 * what the log should carry: re-encoding the whole address would turn one `%20`
 * into `%2520`.
 * @param url - the frame's address, path onwards.
 * @returns the address as the command line carries it.
 */
function forCommandLine(url: string): string {
  return url.replace(/\s/g, character => encodeURIComponent(character))
}

/**
 * Execute `/content-navigated user <page> <url> <title>` against a session,
 * warning (never throwing) on a failed dispatch or a rejected report.
 *
 * `user` for every move this seat observes: the browser sees an address change,
 * not who caused it, and everything it can see today was caused by the page in
 * front of the user.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session whose column moved.
 * @param page - the configured page id whose frame moved.
 * @param url - where the frame is now, path onwards.
 * @param title - the document's title then; may be empty.
 */
export async function reportNavigation(
  ctx: ClientContext,
  sessionId: string,
  page: string,
  url: string,
  title: string,
): Promise<void> {
  const line = `/${CONTENT_NAVIGATED_COMMAND} user ${page} ${forCommandLine(url)} ${title}`
  const result = await ctx.remote.commands.execute(sessionId as SessionId, line, [])
  if (!result.ok) {
    console.warn(`content-frame: content-navigated failed: ${result.error.code}: ${result.error.message}`)
    return
  }
  if (result.value !== undefined && result.value.result.kind === 'error') {
    console.warn(`content-frame: content-navigated: ${result.value.result.text}`)
  }
}
