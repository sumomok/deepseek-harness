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
 * opens the deployment's own data page with the visitor's own credential. The
 * question is the clicking person's, not a model's, so it is put where this
 * command's own answer is already drawn rather than through the agent's
 * approval card — the first click is answered with the card and an agreement to
 * carry back, and the page is placed by the second click, the one that carries
 * it. Nothing is appended and nothing is asked of any backend until then.
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
// Type-only: resolves ctx.loginIdentity, which names the login an answer is remembered under.
import type {} from '@deepseek-ai/dsh-experimental-auth-gate'
import { crudMeta, crudNodes, type ComponentCall, type ComponentNode } from './component-call.ts'
import { encodeConsentQuestion, parseViewCommandInput } from './consent-question.ts'
import { crudApprovalReason } from './crud.ts'
import { loginBinding, sessionBinding, type ConsentTickets, type ViewConsentMemory } from './view-consent.ts'
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
 * What this command needs to decide whether one data page may be drawn.
 *
 * The two tables are the row's, for the life of the row: an answer a person
 * gave and a card they have not answered yet both outlive the rebuild a pack
 * arriving causes, so neither can live in the command the rebuild replaces.
 */
export interface ViewConsentGate {
  /** The answers this process has been given. */
  readonly memory: ViewConsentMemory
  /** The cards it has drawn and not yet seen come back. */
  readonly tickets: ConsentTickets
}

/**
 * Decide one data page: draw it, or answer with the question.
 *
 * The person is named by `ctx.loginIdentity` where an `auth-gate` row is
 * composed, and by the session otherwise. Both can carry an agreement through
 * one exchange; only a login can be remembered, because a session is not a
 * person and a second conversation is not the same seat.
 * @param ctx - the context the command is registered on, carrying the optional identity service.
 * @param gate - what this process remembers, and the cards it has drawn.
 * @param invocation - the click, carrying the session it was made in.
 * @param view - the view that was clicked, already found in the index.
 * @param page - the data page block that view places.
 * @returns `undefined` when the page may be drawn, or the settlement to answer the click with.
 */
function judgeDataPage(
  ctx: Context,
  gate: ViewConsentGate,
  invocation: CommandInvocation,
  view: ComponentCall,
  page: ComponentNode,
): CommandResult | undefined {
  const meta = crudMeta(page)
  const login = ctx.get('loginIdentity')?.current()
  const binding = login === undefined
    ? sessionBinding(invocation.agent.session.id)
    : loginBinding(login)
  if (login !== undefined && gate.memory.holds(binding, view.id, meta)) return undefined
  const { nonce } = parseViewCommandInput(invocation.rawInput)
  if (nonce !== undefined && gate.tickets.redeem(nonce, binding, view.id, meta)) {
    // Remembered only for a person this process can name again. A session-bound
    // agreement is spent by the click that carried it and nothing outlives it.
    if (login !== undefined) gate.memory.remember(binding, view.id, meta)
    return undefined
  }
  // Every other way in ends here, the spent and the expired agreement included:
  // a fresh card with a fresh agreement is the one answer that leaves the
  // person able to open the page, and it never reads as a failure.
  return {
    kind: 'success',
    text: encodeConsentQuestion({
      view: view.id,
      // The card a `show_component` call for this page is put through, word for
      // word: the page this click opens is that page, and a question about it
      // that read differently would be a second card for one thing.
      card: crudApprovalReason(page),
      nonce: gate.tickets.mint(binding, view.id, meta),
    }),
  }
}

/**
 * Build the `show-content-view` command for one deployment's view index.
 * @param ctx - the context the command is registered on, carrying the optional identity service.
 * @param views - the validated view index.
 * @param gate - what this process remembers of earlier answers, and the cards it has drawn.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function showContentViewCommand(ctx: Context, views: ViewIndex, gate: ViewConsentGate): CommandDefinition {
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
      const view: ComponentCall | undefined = views.get(parseViewCommandInput(invocation.rawInput).viewId)
      if (view === undefined) return { kind: 'error', text: NO_SUCH_VIEW }
      const page = crudNodes(view.spec)[0]
      // Before anything is appended: an entry in the log is an entry the column
      // draws, and drawing the page is what puts its first request on the wire
      // with the user's own credential.
      if (page !== undefined) {
        const asked = judgeDataPage(ctx, gate, invocation, view, page)
        if (asked !== undefined) return asked
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
