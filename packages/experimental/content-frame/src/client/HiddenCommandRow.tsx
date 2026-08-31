/**
 * Empty `conversation.chat.commandview` registrant for
 * `SHOW_CONTENT_PAGE_COMMAND`. The sidebar's page-navigation menu invokes
 * that command to append `content/shown` with `by: 'user'` — the durable
 * record is the point, not a chat message narrating a click the user just
 * made themselves. Registering this component at the command's key replaces
 * `dsh-client-ui-conversation`'s default `GenericCommandCard` fallback with
 * nothing.
 *
 * The row's DOM anchor still exists after this returns null — the sibling
 * stylesheet in `hide-empty-command-row.ts` is what removes the resulting
 * empty flex item, not this component.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/HiddenCommandRow
 */

/**
 * Render nothing for the `show-content-page` command row.
 * @returns always `null`.
 */
export function HiddenCommandRow(): null {
  return null
}
