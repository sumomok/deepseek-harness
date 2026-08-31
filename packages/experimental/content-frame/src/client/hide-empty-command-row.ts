/**
 * De-terminology-adjacent CSS layer: collapses the zero-height row an empty
 * `conversation.chat.commandview` registrant (`HiddenCommandRow.tsx`) leaves
 * behind.
 *
 * `dsh-client-ui-conversation`'s chat column lays out its rows with a flex
 * `gap: 16px`; an empty flex item still reserves that gap even at zero
 * height, so a registrant that renders nothing leaves an invisible 16px hole
 * rather than making the row disappear. `ChatNodeSeat.tsx`'s
 * `.flowItem:empty { display: none }` rule does not reach this case: the
 * flow item wraps a non-empty `.callRow`, which itself wraps the slot's own
 * `display: contents` anchor `<div data-slot>` — that anchor is empty, but
 * its non-empty ancestor is what `:empty` tests.
 *
 * This rule reaches past that ancestor with `:has()`, coupled to two DOM
 * shapes this package does not own: `ChatNodeSeat.tsx`'s
 * `data-chat-flow-kind` attribute and `dsh-client-ui-renderer`'s
 * `data-slot` anchor wrapper (`scoped-slots.tsx`). Neither is a contract
 * this package can rely on staying stable; a shape change on either side
 * un-collapses the row silently (it comes back with its 16px gap) rather
 * than failing loud — see the package README's Known Limitations.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/hide-empty-command-row
 */

/** Marks the injected stylesheet so a second `apply()` (HMR) does not duplicate it. */
const STYLE_ID = 'dsh-content-frame-hide-empty-command-row'

/**
 * Inject the row-collapsing stylesheet.
 * @returns a disposer that removes the stylesheet.
 */
export function installHiddenCommandRowStyle(): () => void {
  const existing = document.getElementById(STYLE_ID)
  existing?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = '[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty) { display: none !important; }'
  document.head.append(style)
  return () => { style.remove() }
}
