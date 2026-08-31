/**
 * `dismiss-content-entry` — the switcher strip's close-button command.
 *
 * Content-column's tab close button is a client concern with no host state of
 * its own to check against: the router keeps no catalogue of which
 * `(kind, entryId)` pairs currently exist, so this command does not validate
 * the pair against the live stream before appending. A dismissal naming a
 * pair that is already gone (a race between two clicks, a stale tab reopened
 * from history) is harmless — `projection.ts`'s fold removes a record that is
 * no longer there exactly as it removes one that still is: nothing to find,
 * nothing changes.
 *
 * The command name is a small wire contract content-column hardcodes
 * (mirroring how `dsh-experimental-server-sidebar` hardcodes content-frame's
 * `show-content-page` name and settings route) rather than importing: both
 * packages are fork-owned together in this deployment, and a cross-package
 * value import is not this repository's sanctioned way to couple two
 * client-adjacent plugins.
 */

import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

/**
 * Command name content-column's switcher strip invokes. Exported for this
 * package's own tests; the column package keeps its own literal copy rather
 * than importing this one (see the module doc).
 */
export const DISMISS_CONTENT_ENTRY_COMMAND = 'dismiss-content-entry'

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
 * Build the `dismiss-content-entry` command.
 * @returns the definition to hand to `ctx.commands.register`.
 */
export function dismissContentEntryCommand(): CommandDefinition {
  return {
    name: DISMISS_CONTENT_ENTRY_COMMAND,
    description: 'Close one entry\'s tab in the content column\'s switcher strip. Used by the switcher\'s own close button; not meant to be typed by hand.',
    input: { hint: 'kind entryId' },
    handler: (invocation) => {
      const pair = splitPair(invocation.rawInput.trim())
      if (pair === undefined) {
        return { kind: 'error', text: `/${DISMISS_CONTENT_ENTRY_COMMAND} requires "<kind> <entryId>"` }
      }
      // A command invocation always carries the receiving agent, unlike a
      // tool call — see `content/shown`'s own `by: 'user'` writer for the
      // same shape.
      invocation.agent.session.append('content-surface/dismissed', { kind: pair.kind, entryId: pair.entryId, by: 'user' })
      return { kind: 'success' }
    },
  }
}
