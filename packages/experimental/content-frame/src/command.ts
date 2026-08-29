/**
 * `show-content-page` — the user-triggered counterpart to `content_show`.
 *
 * The sidebar's page-navigation menu
 * (`@deepseek-ai/dsh-experimental-server-sidebar`) executes this command
 * instead of calling the model: a command definition already gives a UI
 * gesture exactly what a page click needs — a durable `command/run`/
 * `command/done` pairing around one direct, non-turn append, replayable from
 * the log alone, and never routed through the model. Execution does the same
 * one durable thing the tool does — append `content/shown` — but records `by:
 * 'user'`, which is the whole reason this event carries that field.
 *
 * The command name is a small wire contract the sidebar package hardcodes
 * (mirroring how it hardcodes this package's settings route path) rather than
 * importing: both packages are fork-owned together in this deployment, and a
 * cross-package value import is not this repository's sanctioned way to
 * couple two client-adjacent plugins.
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { type PageIndex } from './pages.ts'

/**
 * Command name the sidebar's page-navigation menu invokes. Exported for this
 * package's own tests; the sidebar package keeps its own literal copy rather
 * than importing this one (see the module doc).
 */
export const SHOW_CONTENT_PAGE_COMMAND = 'show-content-page'

/**
 * Build the failure text for an id the deployment does not configure.
 * @param requested - the id the invocation passed.
 * @returns a message naming the requested id; the command's discovery text
 * already carries the full catalogue, so the error need not repeat it.
 */
function unknownPageMessage(requested: string): string {
  return `/${SHOW_CONTENT_PAGE_COMMAND}: unknown page ${JSON.stringify(requested)}`
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
      if (page === undefined) return { kind: 'error', text: unknownPageMessage(id) }
      // The column is per-session state living in the session log; a command
      // invocation always carries the receiving agent, unlike a tool call.
      invocation.agent.session.append('content/shown', { page: page.id, by: 'user' })
      return { kind: 'success', text: `Now showing ${page.title} in the content column.` }
    },
  }
}
