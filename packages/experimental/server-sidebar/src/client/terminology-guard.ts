/**
 * De-terminology CSS layer (decision ②): hides the one piece of banned
 * vocabulary this repository has no configuration hook for.
 *
 * Three of the four pieces the task calls out have a regular composition-level
 * channel and need no code at all — `ui-trajectory`, `ui-model-selection`, and
 * `@deepseek-ai/dsh-session-log-export`'s `session-log-download` row are
 * ordinary bundle rows a customer overlay disables outright (see the package
 * README's Composition section and `overlay/customer.patch.yml`).
 *
 * The turns/steps stats row (`dsh-client-ui-conversation`'s `StatsLine`,
 * mounted on the composer's `conversation.composer.dock` list) has neither: no
 * Config flag gates it, and it carries no stable `data-*` attribute of its
 * own. The nearest stable anchor is the composer card's own
 * `[data-composer-card]` attribute (`InputBar.tsx`) — the stats row renders as
 * that card's next sibling. This is a DOM-position coupling, not a semantic
 * one: a future `ui-conversation` change that inserts another sibling between
 * the card and the stats row, or that stops rendering the stats footer as a
 * sibling at all, silently breaks this hide without a compile-time signal.
 * The package README records this fragility, and an e2e scenario pins "this
 * row renders invisible under the customer composition" so a broken selector
 * turns the gate red instead of shipping the banned vocabulary silently. This
 * plugin is unconditional (see its own module doc on why): this package now
 * exists solely for the customer/service-line product experience, not as a
 * general-purpose sidebar.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/terminology-guard
 */

/** Marks the injected stylesheet so a second `apply()` (HMR) does not duplicate it. */
const STYLE_ID = 'dsh-server-sidebar-terminology-guard'

/**
 * Inject the hiding stylesheet.
 * @returns a disposer that removes the stylesheet.
 */
export function installTerminologyGuard(): () => void {
  const existing = document.getElementById(STYLE_ID)
  existing?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = '[data-composer-card] + * { display: none !important; }'
  document.head.append(style)
  return () => { style.remove() }
}
