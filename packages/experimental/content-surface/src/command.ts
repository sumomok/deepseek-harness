/**
 * The switcher strip's two commands: `dismiss-content-entry` closes a tab and
 * `select-content-entry` brings one to the front.
 *
 * Content-column's tab buttons are client concerns with no host state of their
 * own to check against: the router keeps no catalogue of which
 * `(kind, entryId)` pairs currently exist, so neither command validates the
 * pair against the live stream before appending. A dismissal naming a pair that
 * is already gone (a race between two clicks, a stale tab reopened from
 * history) is harmless — `projection.ts`'s fold removes a record that is no
 * longer there exactly as it removes one that still is: nothing to find,
 * nothing changes — and a selection naming one is harmless for the same
 * reason: the stream's `front` falls back to the newest entry.
 *
 * Only one of the two narrates itself to the agent. Closing a tab is the user
 * putting away something the conversation produced, and an agent that never
 * hears it goes on offering to update content that is no longer on screen;
 * bringing a tab forward is a glance, repeated as often as the user looks
 * around, and which entry is in front reaches the model through the
 * content-column context every request already carries.
 *
 * The command names are a small wire contract content-column hardcodes
 * (mirroring how `dsh-experimental-server-sidebar` hardcodes content-frame's
 * `show-content-page` name and settings route) rather than importing: both
 * packages are fork-owned together in this deployment, and a cross-package
 * value import is not this repository's sanctioned way to couple two
 * client-adjacent plugins.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ContentSurfaceEntry } from './types.ts'

/**
 * Command name content-column's switcher strip invokes to close a tab.
 * Exported for this package's own tests; the column package keeps its own
 * literal copy rather than importing this one (see the module doc).
 */
export const DISMISS_CONTENT_ENTRY_COMMAND = 'dismiss-content-entry'

/**
 * Command name content-column's switcher strip invokes to bring a tab to the
 * front. Exported and hardcoded on the other side for the same reasons as
 * {@link DISMISS_CONTENT_ENTRY_COMMAND}.
 */
export const SELECT_CONTENT_ENTRY_COMMAND = 'select-content-entry'

/** What this package names itself as the source of an injected notice. */
const PLUGIN_NAME = 'content-surface'

/**
 * The sentence the agent reads when the user closes a tab.
 *
 * It names the kind rather than assuming a page: the router's key domain is
 * open, and this row has never heard of the kinds registered over it.
 * @param kind - the closed entry's kind, as its extractor names it.
 * @param title - the closed entry's title, as the column showed it.
 * @returns the model-facing sentence.
 */
export function closedEntryNotice(kind: string, title: string): string {
  return `The user closed the ${kind} "${title}" in the content column.`
}

/**
 * Read one session's live entries, for the title a dismissal notice names. The
 * projection registry is an optional seam, so a composition without one
 * supplies no lookup and the notice is skipped.
 */
export type ContentEntryLookup = (session: Session) => readonly ContentSurfaceEntry[] | undefined

/**
 * Split `"<kind> <entryId>"` on its first space. `kind` values are extractor
 * identifiers (`'page'`, `'chart'`) that never carry whitespace; `entryId` is
 * everything after the first space, kept whole in case a kind's own id ever
 * does.
 *
 * Both halves are guaranteed non-empty once a space is found: `trimmedInput`
 * carries no leading or trailing whitespace (the caller trims first), so a
 * found space can be neither the first nor the last character.
 * @param trimmedInput - the command's raw input, already trimmed.
 * @returns the split pair, or `undefined` when the input has no space to split on.
 */
function splitPair(trimmedInput: string): { kind: string; entryId: string } | undefined {
  const spaceAt = trimmedInput.indexOf(' ')
  if (spaceAt === -1) return undefined
  return { kind: trimmedInput.slice(0, spaceAt), entryId: trimmedInput.slice(spaceAt + 1) }
}

/**
 * The title the column is showing for one pair, read before the event that
 * takes it out of the stream.
 * @param lookup - reads the session's live entries, when a projection registry is composed.
 * @param session - the session whose column is read.
 * @param pair - the entry being closed.
 * @returns the title, or `undefined` when nothing in the stream names that pair.
 */
function titleOf(
  lookup: ContentEntryLookup | undefined,
  session: Session,
  pair: { kind: string; entryId: string },
): string | undefined {
  return lookup?.(session)?.find(entry => entry.kind === pair.kind && entry.entryId === pair.entryId)?.title
}

/**
 * Build the `dismiss-content-entry` command.
 * @param lookup - reads a session's live entries, for the title the notice
 * names; omitted in a composition with no projection registry, where the
 * dismissal is still recorded and only the notice is skipped.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function dismissContentEntryCommand(lookup?: ContentEntryLookup): CommandDefinition {
  return {
    name: DISMISS_CONTENT_ENTRY_COMMAND,
    description: 'Close one entry\'s tab in the content column\'s switcher strip. Used by the switcher\'s own close button; not meant to be typed by hand.',
    input: { hint: 'kind entryId' },
    handler: (invocation) => {
      const pair = splitPair(invocation.rawInput.trim())
      if (pair === undefined) {
        return { kind: 'error', text: `/${DISMISS_CONTENT_ENTRY_COMMAND} requires "<kind> <entryId>"` }
      }
      // Read before the append, because the append is what takes the entry out
      // of the stream this reads.
      const title = titleOf(lookup, invocation.agent.session, pair)
      // A command invocation always carries the receiving agent, unlike a
      // tool call — see `content/shown`'s own `by: 'user'` writer for the
      // same shape.
      invocation.agent.session.append('content-surface/dismissed', { kind: pair.kind, entryId: pair.entryId, by: 'user' })
      // Injected after the append, so the log carries the fact before the
      // sentence about it. `inject` queues context for the next pre-step
      // without waking the driver, which is the whole point here: closing a
      // tab is not a question, and an idle agent stays idle until the user
      // says something.
      if (title !== undefined) {
        const text = closedEntryNotice(pair.kind, title)
        invocation.agent.inject(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: boundContextSummary(text) },
        }))
      }
      return { kind: 'success' }
    },
  }
}

/**
 * Build the `select-content-entry` command.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function selectContentEntryCommand(): CommandDefinition {
  return {
    name: SELECT_CONTENT_ENTRY_COMMAND,
    description: 'Bring one entry\'s tab to the front of the content column\'s switcher strip. Used by the switcher\'s own tab buttons; not meant to be typed by hand.',
    input: { hint: 'kind entryId' },
    handler: (invocation) => {
      const pair = splitPair(invocation.rawInput.trim())
      if (pair === undefined) {
        return { kind: 'error', text: `/${SELECT_CONTENT_ENTRY_COMMAND} requires "<kind> <entryId>"` }
      }
      invocation.agent.session.append('content-surface/selected', { kind: pair.kind, entryId: pair.entryId, by: 'user' })
      return { kind: 'success' }
    },
  }
}
