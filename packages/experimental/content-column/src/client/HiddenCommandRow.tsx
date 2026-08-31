/**
 * Empty `conversation.chat.commandview` registrant for
 * `DISMISS_CONTENT_ENTRY_COMMAND`. The switcher strip's close button invokes
 * that command to append `content-surface/dismissed` with `by: 'user'` — the
 * durable record is the point, not a chat message narrating a tab the user
 * just closed themselves. Registering this component at the command's key
 * replaces `dsh-client-ui-conversation`'s default `GenericCommandCard`
 * fallback with nothing.
 *
 * The row's DOM anchor still exists after this returns null — the sibling
 * stylesheet in `hide-empty-command-row.ts` is what removes the resulting
 * empty flex item, not this component.
 * @module @deepseek-ai/dsh-experimental-content-column/client/HiddenCommandRow
 */

/**
 * Render nothing for the `dismiss-content-entry` command row.
 * @returns always `null`.
 */
export function HiddenCommandRow(): null {
  return null
}
