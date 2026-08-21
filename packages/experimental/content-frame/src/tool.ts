/**
 * `content_show` — the agent's control over the shell's content column.
 *
 * The tool is the deployment's page list turned into a model-facing choice:
 * the description carries the whole catalogue, so the model needs no separate
 * prompt section to know what it may show. Execution does one durable thing —
 * append `content/shown` — and the browser follows through the `content`
 * projection, so what the column shows is reconstructable from the log alone.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CLEAR_PAGE, type PageIndex } from './pages.ts'

/** Opening paragraph: what the column is, from where the model sits. */
const DESCRIPTION_HEAD =
  'Show one of this deployment\'s pages in the content column of the user\'s GUI — the panel beside the '
  + 'conversation, which the user sees immediately without opening or scrolling anything. Use it to put a '
  + 'page in front of the user while you talk about it. The column keeps showing that page until you change '
  + 'it, and each session has its own column.\n\nPages:\n'

/** Closing paragraph: the clear id and the failure mode, stated once. */
const DESCRIPTION_TAIL =
  `\n\nPass \`${CLEAR_PAGE}\` to empty the column instead of showing a page. `
  + 'Any other id that is not in the list above changes nothing and comes back as an error.'

/**
 * Render the page catalogue the description offers the model.
 * @param pages - the validated page index, in declaration order.
 * @returns one `- id — title — description` line per page.
 */
function catalogue(pages: PageIndex): string {
  return [...pages.values()].map(page => `- ${page.id} — ${page.title} — ${page.description}`).join('\n')
}

/**
 * Build the tool description for one deployment's page list.
 * @param pages - the validated page index.
 * @returns the complete model-facing description.
 */
function describeContentShow(pages: PageIndex): string {
  return DESCRIPTION_HEAD + catalogue(pages) + DESCRIPTION_TAIL
}

/**
 * Build the failure text for an id the deployment does not configure.
 * @param requested - the id the model passed.
 * @param pages - the validated page index.
 * @returns a message naming the whole choice again, so the next call can be right.
 */
function unknownPageMessage(requested: string, pages: PageIndex): string {
  return `unknown page ${JSON.stringify(requested)}. Available pages:\n${catalogue(pages)}\n`
    + `Or pass ${JSON.stringify(CLEAR_PAGE)} to empty the column.`
}

/** Result text for a cleared column. */
const CLEARED_TEXT = 'Content column cleared.'

/**
 * Build the `content_show` tool for one deployment's page list.
 * @param pages - the validated page index.
 * @returns the definition to hand to `ctx.tools.register`.
 */
export function contentShowTool(pages: PageIndex): ToolDefinition {
  return defineTool({
    name: 'content_show',
    description: describeContentShow(pages),
    parameters: {
      page: {
        type: 'string',
        required: true,
        description: `Id of the page to show, or "${CLEAR_PAGE}" to empty the column.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'string', required: true, description: `The page now on display, or "${CLEAR_PAGE}".` },
          title: { type: 'string', description: 'Name of the page now on display; absent for a cleared column.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.title === undefined ? CLEARED_TEXT : `Now showing ${value.title} in the content column.`,
      }],
    },
    execute(args, exec) {
      // The column is per-session state, and the session log is where it
      // lives; a caller with no owning session has nowhere to write it.
      if (!exec.agent) throw new Error('content_show requires an owning agent session')
      if (args.page === CLEAR_PAGE) {
        exec.agent.session.append('content/shown', { page: null })
        return Promise.resolve({ page: CLEAR_PAGE })
      }
      const page = pages.get(args.page)
      // Nothing is appended for an unknown id: the column keeps showing what
      // it showed, and the model gets the catalogue back to correct itself.
      if (page === undefined) throw new Error(unknownPageMessage(args.page, pages))
      exec.agent.session.append('content/shown', { page: page.id })
      return Promise.resolve({ page: page.id, title: page.title })
    },
    presentCall: (args): GenericCallView => ({
      card: 'generic',
      title: args.page === CLEAR_PAGE ? 'Clear the content column' : `Show ${args.page} in the content column`,
      kind: 'other',
      rawInput: args.page,
    }),
  })
}
