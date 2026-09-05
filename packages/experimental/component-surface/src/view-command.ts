/**
 * `show-content-view` — the user-triggered counterpart to `show_component`.
 *
 * The sidebar's navigation menu runs this command instead of asking the model
 * to place a view the deployment already wrote: a command definition gives a UI
 * gesture exactly what a click needs — a durable `command/run`/`command/done`
 * pairing around one direct, non-turn append, replayable from the log alone,
 * and never routed through the model.
 *
 * What it appends is the one session event this package writes. A tool call has
 * the loop's own `tool/call` to be reconstructed from; a click has nothing, so
 * the click writes the record itself, carrying the whole spec rather than the
 * view id — an entry the log can replay without the configuration file that
 * produced it.
 *
 * The command name is a small wire contract the sidebar package keeps a literal
 * copy of rather than importing, mirroring how it already treats this
 * deployment's other client-adjacent plugins: both packages are fork-owned
 * together, and a cross-package value import is not this repository's
 * sanctioned way to couple two of them.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/view-command
 */

import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ViewIndex } from './views.ts'

/**
 * Command name the sidebar's navigation menu invokes. Exported for this
 * package's own tests and its browser half; the sidebar keeps its own literal
 * copy (see the module doc).
 */
export const SHOW_CONTENT_VIEW_COMMAND = 'show-content-view'

/**
 * What a click that names no configured view is answered with.
 *
 * One sentence, in the language and register the end user reads, for every way
 * the id can miss: a menu built from a catalog the deployment has since edited,
 * and an empty invocation, are the same event from where the person is sitting
 * — they clicked and there is nothing to show. The row that draws it is this
 * command's own chat seat; a success draws nothing at all, because the view
 * appearing in the column is the answer.
 */
const NO_SUCH_VIEW = '没有这个视图。'

/**
 * Build the `show-content-view` command for one deployment's view list.
 * @param views - the validated view index.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function showContentViewCommand(views: ViewIndex): CommandDefinition {
  return {
    name: SHOW_CONTENT_VIEW_COMMAND,
    // Chinese, and free of any noun the console does not show the person
    // reading it (a sidebar row is drawn as its title alone, never called a
    // view or a page): the command registry has no way to keep a row out of
    // the slash menu, so this sentence is read by an end user scrolling that
    // menu, and by nobody else — `commands.list` is a Remote method and
    // reaches no model. What it has to say is that the row is not an
    // instruction they are meant to type.
    description: '点侧栏里的条目就会打开，内容出现在对话旁边；这一行不用手动输入。',
    input: { hint: '名称' },
    handler: (invocation): CommandResult => {
      const view = views.get(invocation.rawInput.trim())
      if (view === undefined) return { kind: 'error', text: NO_SUCH_VIEW }
      // The column is per-session state living in the session log; a command
      // invocation always carries the receiving agent, unlike a tool call.
      // Appending unconditionally is what makes a second click on the view the
      // user is already looking at move the entry back to the front of the
      // switcher rather than do nothing.
      invocation.agent.session.append('content-component/shown', {
        entryId: view.id,
        title: view.title,
        spec: view.spec,
        by: 'user',
      })
      // No sentence: the block arriving in the column is what the click asked
      // for, and a line of chat narrating a click the user just made themselves
      // is the terminology-free shell's own noise. The chat row this command
      // owns draws nothing for a settlement carrying no text.
      return { kind: 'success' }
    },
  }
}
