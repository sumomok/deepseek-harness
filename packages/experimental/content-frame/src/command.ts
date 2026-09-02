/**
 * The two commands the browser drives this package's log with:
 * `show-content-page`, the user-triggered counterpart to `content_show`, and
 * `content-navigated`, the page seat reporting that a frame moved.
 *
 * Neither goes through the model, and both exist for the same reason: a
 * command definition already gives a browser gesture what it needs — a durable
 * `command/run`/`command/done` pairing around one direct, non-turn append,
 * replayable from the log alone. `show-content-page` does the same one durable
 * thing `content_show` does, and records `by: 'user'`, which is the whole
 * reason that event carries the field.
 *
 * `show-content-page` also injects a notice, because opening a page is the user
 * changing what the conversation is about, and the agent would otherwise be the
 * only party in the room that did not notice. `content-navigated` injects
 * nothing: an application's own routing moves under the user constantly, and a
 * notice per route change would be the noisiest thing in the transcript. Where
 * the frame is reaches the model through the content-column context instead.
 *
 * `content-navigated` is the one command here whose input crossed a process, so
 * every field is checked and every refusal names the field to fix.
 *
 * The command names are a small wire contract the sidebar package hardcodes
 * (mirroring how it hardcodes this package's settings route path) rather than
 * importing: both packages are fork-owned together in this deployment, and a
 * cross-package value import is not this repository's sanctioned way to
 * couple two client-adjacent plugins.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { isPrintable, MAX_HEADER_CHARS, MAX_URL_CHARS } from './access/wire.ts'
import { openedPageNotice } from './perception/text.ts'
import { type PageIndex } from './pages.ts'

/**
 * Command name the sidebar's page-navigation menu invokes. Exported for this
 * package's own tests; the sidebar package keeps its own literal copy rather
 * than importing this one (see the module doc).
 */
export const SHOW_CONTENT_PAGE_COMMAND = 'show-content-page'

/** Command name this package's own page seat invokes when a frame moves. */
export const CONTENT_NAVIGATED_COMMAND = 'content-navigated'

/**
 * What this package names itself as the source of an injected notice. A
 * literal rather than the `name` export, which lives in the module that
 * imports this one.
 */
const PLUGIN_NAME = 'content-frame'

/**
 * Build the failure text for an id the deployment does not configure.
 * @param command - the command refusing it, so the failure says which.
 * @param requested - the id the invocation passed.
 * @returns a message naming the requested id; the command's discovery text
 * already carries the full catalogue, so the error need not repeat it.
 */
function unknownPageMessage(command: string, requested: string): string {
  return `/${command}: unknown page ${JSON.stringify(requested)}`
}

/**
 * Build the `show-content-page` command for one deployment's page list.
 * @param pages - the validated page index.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function showContentPageCommand(pages: PageIndex): CommandDefinition {
  return {
    name: SHOW_CONTENT_PAGE_COMMAND,
    description: 'Show one of this deployment\'s content-column pages. Used by the sidebar\'s page-navigation menu; not meant to be typed by hand.',
    input: { hint: 'page id' },
    handler: (invocation) => {
      const id = invocation.rawInput.trim()
      if (id.length === 0) {
        return { kind: 'error', text: `/${SHOW_CONTENT_PAGE_COMMAND} requires a page id` }
      }
      const page = pages.get(id)
      if (page === undefined) return { kind: 'error', text: unknownPageMessage(SHOW_CONTENT_PAGE_COMMAND, id) }
      // The column is per-session state living in the session log; a command
      // invocation always carries the receiving agent, unlike a tool call.
      invocation.agent.session.append('content/shown', { page: page.id, by: 'user' })
      // Injected after the append, so the log carries the fact before the
      // sentence about it. `inject` queues context for the next pre-step
      // without waking the driver: opening a page is not a question, and an
      // idle agent stays idle until the user says something.
      const text = openedPageNotice(page.title)
      invocation.agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: boundContextSummary(text) },
      }))
      return { kind: 'success', text: `Now showing ${page.title} in the content column.` }
    },
  }
}

/** The four fields `content-navigated` carries, before any of them is checked. */
interface NavigatedFields {
  /** Who moved the frame. */
  readonly by: string
  /** The page id whose frame moved. */
  readonly page: string
  /** Where it went. */
  readonly url: string
  /** The document's title then; empty when the input carried none. */
  readonly title: string
}

/**
 * Split `"<by> <page> <url> [title]"` on its first three spaces.
 *
 * The title comes last because it is the one field that may carry spaces of
 * its own, and it may be absent entirely: a document with no title reports an
 * empty one, and trimming the input takes its separator with it.
 * @param trimmedInput - the command's raw input, already trimmed.
 * @returns the four fields, or `undefined` when the input has fewer than three.
 */
function splitNavigated(trimmedInput: string): NavigatedFields | undefined {
  const first = trimmedInput.indexOf(' ')
  if (first === -1) return undefined
  const second = trimmedInput.indexOf(' ', first + 1)
  if (second === -1) return undefined
  const third = trimmedInput.indexOf(' ', second + 1)
  return {
    by: trimmedInput.slice(0, first),
    page: trimmedInput.slice(first + 1, second),
    url: third === -1 ? trimmedInput.slice(second + 1) : trimmedInput.slice(second + 1, third),
    title: third === -1 ? '' : trimmedInput.slice(third + 1),
  }
}

/**
 * Build the `content-navigated` command for one deployment's page list.
 *
 * The two length bounds are the read channel's own, because they bound the same
 * two things: `MAX_URL_CHARS` is a document's address and `MAX_HEADER_CHARS` is
 * a document's title, and one page has one of each whichever half of this
 * package is looking at it.
 * @param pages - the validated page index; a report naming anything else is refused.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function contentNavigatedCommand(pages: PageIndex): CommandDefinition {
  return {
    name: CONTENT_NAVIGATED_COMMAND,
    description: 'Record that the page in the content column moved to a different address inside itself. Used by the content column\'s own page seat; not meant to be typed by hand.',
    input: { hint: 'by page url title' },
    handler: (invocation) => {
      const refuse = (text: string): CommandResult => ({ kind: 'error', text })
      const fields = splitNavigated(invocation.rawInput.trim())
      if (fields === undefined) {
        return refuse(`/${CONTENT_NAVIGATED_COMMAND} requires "<by> <page> <url> [title]"`)
      }
      if (fields.by !== 'user' && fields.by !== 'agent') {
        return refuse(`/${CONTENT_NAVIGATED_COMMAND}: by must be "user" or "agent"`)
      }
      const page = pages.get(fields.page)
      if (page === undefined) return refuse(unknownPageMessage(CONTENT_NAVIGATED_COMMAND, fields.page))
      // Same-origin by construction and by contract: the seat reports where
      // inside the application the frame is, and an address that is not a path
      // is not that.
      if (!fields.url.startsWith('/') || fields.url.length > MAX_URL_CHARS || !isPrintable(fields.url)) {
        return refuse(`/${CONTENT_NAVIGATED_COMMAND}: url must be a path starting with "/", at most ${MAX_URL_CHARS} printable characters`)
      }
      if (fields.title.length > MAX_HEADER_CHARS || !isPrintable(fields.title)) {
        return refuse(`/${CONTENT_NAVIGATED_COMMAND}: title must be at most ${MAX_HEADER_CHARS} printable characters`)
      }
      invocation.agent.session.append('content/navigated', {
        page: page.id,
        url: fields.url,
        title: fields.title,
        by: fields.by,
      })
      return { kind: 'success' }
    },
  }
}
