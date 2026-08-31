/**
 * De-terminology CSS layer (decision ②): hides the pieces of banned
 * vocabulary and internal-status chrome this repository has no configuration
 * hook for.
 *
 * Three of the four turns/steps-adjacent pieces the original task calls out
 * have a regular composition-level channel and need no code at all —
 * `ui-trajectory`, `ui-model-selection`, and
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
 * turns the gate red instead of shipping the banned vocabulary silently.
 *
 * The hero-phase rules below carry the identical class-substring coupling
 * for the same reason: `dsh-client-ui-conversation`'s
 * `HeroShell.module.css`/`ConversationRoot.module.css` classes have no
 * Config flag or `data-*` seat either, and tsdown's `[hash]_[local]` module
 * naming means the local part of the class name is the only stable substring
 * across a build (`apps/web/tests/agent-preset-selection.e2e.ts`'s own
 * `[class*="heroWorkspaceRow"]` locator is this repository's existing
 * precedent for the pattern). `[data-phase='hero']` (`ConversationRoot.tsx`'s
 * own root attribute) scopes the fish/badge/headline rules to the
 * blank-draft hero only:
 * - `fishHitbox` (`HeroShell.module.css`) hides the fish-mark hitbox
 *   outright — `client/index.ts`'s own priority-shadowed
 *   `conversation.hero.brand.mark` registration already leaves it empty, but
 *   the empty hitbox still reserves layout space and carries the hover-swim
 *   affordance; hiding it removes both.
 * - `previewBadge` (`HeroShell.module.css`) hides the "PREVIEW" pill: a
 *   product-internal status marker with no customer-facing meaning.
 * - `headlineText` (`HeroShell.module.css`) is collapsed to `font-size: 0`
 *   and given a `::after` pseudo-element carrying this package's own brand
 *   copy at the headline's original size — swapping the rendered glyphs
 *   without touching the DOM text node itself, which stays in the
 *   accessibility tree unchanged (see the package README's Known
 *   Limitations for this residual gap).
 * - `heroWorkspaceRow` (`ConversationRoot.module.css`) hides the whole
 *   workspace-chip-plus-picker row outright, not scoped to `[data-phase='hero']`:
 *   `ConversationRoot.tsx` only ever mounts it during the hero phase, and with
 *   `ui-workspace` disabled (see the package README) the row's own
 *   `WorkspaceChip` is a dead control — clicking it opens a picker menu no
 *   plugin fills. `conversation.hero.agentPreset`, the row's other seat, is
 *   emptied at the composition level instead (`ui-agent-preset` disabled
 *   outright — see `overlay/customer.patch.yml`), not by this CSS: disabling
 *   the whole package also removes its session-header preset label and its
 *   Settings row, which this hero-only rule could not reach.
 *
 * This plugin is unconditional (see its own module doc on why): this package
 * now exists solely for the customer/service-line product experience, not as
 * a general-purpose sidebar.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/terminology-guard
 */

/** Marks the injected stylesheet so a second `apply()` (HMR) does not duplicate it. */
const STYLE_ID = 'dsh-server-sidebar-terminology-guard'

/** The complete hiding/overriding stylesheet — see the module doc for what each rule targets and why. */
const STYLE = `
[data-composer-card] + * { display: none !important; }
[data-phase='hero'] [class*="fishHitbox"] { display: none !important; }
[data-phase='hero'] [class*="previewBadge"] { display: none !important; }
[data-phase='hero'] [class*="headlineText"] { font-size: 0 !important; }
[data-phase='hero'] [class*="headlineText"]::after {
  content: '工作台小助手';
  font-size: 26px;
  line-height: 32px;
}
[class*="heroWorkspaceRow"] { display: none !important; }
`

/**
 * Inject the hiding stylesheet.
 * @returns a disposer that removes the stylesheet.
 */
export function installTerminologyGuard(): () => void {
  const existing = document.getElementById(STYLE_ID)
  existing?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.append(style)
  return () => { style.remove() }
}
