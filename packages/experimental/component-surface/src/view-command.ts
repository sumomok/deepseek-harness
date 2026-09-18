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
 * One view is a question before it is a draw: a view that places `toy.crud`
 * opens the deployment's own data page with the visitor's own credential, so
 * the click is put to the user through the same approval request, with the same
 * card, a `show_component` call asking for that page is put through. Nothing is
 * appended and nothing is drawn unless the answer is a grant.
 *
 * The command name is a small wire contract the sidebar package keeps a literal
 * copy of rather than importing, mirroring how it already treats this
 * deployment's other client-adjacent plugins: both packages are fork-owned
 * together, and a cross-package value import is not this repository's
 * sanctioned way to couple two of them.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/view-command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: resolves ctx.approval, the question a data page is put through.
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: resolves ctx.loginIdentity, which names the login an answer is remembered under.
import type {} from '@deepseek-ai/dsh-experimental-auth-gate'
import { crudMeta, crudNodes, SHOW_COMPONENT_TOOL_NAME, type ComponentCall, type ComponentNode } from './component-call.ts'
import { crudApprovalReason } from './crud.ts'
import { consentKey, type ViewConsentMemory } from './view-consent.ts'
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
 * What a click on a data page that was not agreed to is answered with.
 *
 * One sentence for every way the question can end other than a grant, and for
 * every way it could not be asked at all, because the four are one thing from
 * where the person is sitting: they clicked and the page did not open.
 */
const NOT_OPENED = '没有打开。'

/**
 * Put one data page to the user, unless this person already agreed to it.
 *
 * The approval service has one grant, `allowed-once`, and no store, so the
 * memory of an answer is this row's own: it is keyed by the login, the view and
 * the table, and it is in this process only. A composition with no login to
 * scope an answer to remembers nothing and asks every time, which is the
 * fail-closed answer.
 *
 * Asking is impossible outside an open turn — the audit pair the approval
 * service writes has to be enclosed by one — and a command handler runs
 * wherever the user clicked. That refusal, an approval service that is not
 * composed, and a user who says no all reach the same place: nothing is drawn.
 * @param ctx - the context the command is registered on, carrying the optional approval and identity services.
 * @param memory - what this process remembers of earlier answers.
 * @param invocation - the click, carrying the agent to ask for and the cancellation to ask under.
 * @param viewId - the view that was clicked, which the answer is remembered against.
 * @param page - the data page block the view places.
 * @returns whether the page may be drawn.
 */
async function allowDataPage(
  ctx: Context,
  memory: ViewConsentMemory,
  invocation: CommandInvocation,
  viewId: string,
  page: ComponentNode,
): Promise<boolean> {
  const login = ctx.get('loginIdentity')?.current()
  const key = login === undefined ? undefined : consentKey(login, viewId, crudMeta(page))
  if (key !== undefined && memory.holds(key)) return true
  const approval = ctx.get('approval')
  if (approval === undefined) return false
  let outcome
  try {
    outcome = await approval.request({
      agent: invocation.agent,
      // The tool the question is about, which is what draws the card: the page
      // this click opens is the one a `show_component` call opens, and a
      // question about it that read differently would be a second card for one
      // thing.
      toolName: SHOW_COMPONENT_TOOL_NAME,
      reason: crudApprovalReason(page),
      signal: invocation.signal,
    })
  } catch (_couldNotAsk) {
    // Swallowed here and nowhere else: the approval service throws when there
    // is no open turn to enclose its audit pair, which is where a click made
    // between turns lands, and it throws when either audit append fails. Both
    // mean the same thing — the user was not asked — and the answer below says
    // the page did not open.
    return false
  }
  if (outcome !== 'allowed-once') return false
  if (key !== undefined) memory.remember(key)
  return true
}

/**
 * Build the `show-content-view` command for one deployment's view index.
 * @param ctx - the context the command is registered on, carrying the optional approval and identity services.
 * @param views - the validated view index.
 * @param memory - what this process remembers of earlier answers to a data page.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function showContentViewCommand(ctx: Context, views: ViewIndex, memory: ViewConsentMemory): CommandDefinition {
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
    handler: async (invocation): Promise<CommandResult> => {
      const view: ComponentCall | undefined = views.get(invocation.rawInput.trim())
      if (view === undefined) return { kind: 'error', text: NO_SUCH_VIEW }
      const page = crudNodes(view.spec)[0]
      // Before anything is appended: an entry in the log is an entry the column
      // draws, and drawing the page is what puts its first request on the wire
      // with the user's own credential.
      if (page !== undefined && !await allowDataPage(ctx, memory, invocation, view.id, page)) {
        return { kind: 'error', text: NOT_OPENED }
      }
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
