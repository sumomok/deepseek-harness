/**
 * De-terminology CSS layer (decision ②): hides the pieces of banned
 * vocabulary and internal-status chrome this repository has no configuration
 * hook for.
 *
 * Three of the four turns/steps-adjacent pieces the original task calls out
 * have a regular composition-level channel and need no code at all —
 * `ui-trajectory`, `ui-model-selection`, and
 * `@deepseek-ai/dsh-session-log-export`'s `session-log-download` row are
 * ordinary bundle rows the console bundle disables outright (see the package
 * README's Composition section and `@deepseek-ai/dsh-experimental-console-profile`'s
 * `cordis.patch.yml`).
 *
 * The turns/steps stats row (`dsh-client-ui-chat`'s `StatsLine`,
 * mounted on the composer's `conversation.composer.dock` list) has neither: no
 * Config flag gates it, and it carries no stable `data-*` attribute of its
 * own. The nearest stable anchor is the composer card's own
 * `[data-composer-card]` attribute (`InputBar.tsx`) — the stats row renders as
 * that card's next sibling. This is a DOM-position coupling, not a semantic
 * one: a future `ui-conversation` change that inserts another sibling between
 * the card and the stats row, or that stops rendering the stats footer as a
 * sibling at all, silently breaks this hide without a compile-time signal.
 * The package README records this fragility, and an e2e scenario pins that the
 * row is present AND renders nothing, so a broken selector turns the gate red
 * instead of shipping the banned vocabulary silently. Both halves are the
 * assertion: an element that stopped matching is also an element that is not
 * visible, so invisibility alone would pass on the very failure it guards.
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
 * - the headline text, the first child of `titleGroup` (`HeroShell.module.css`;
 *   the badge is its sibling), is collapsed to `font-size: 0`
 *   and given a `::after` pseudo-element carrying this package's own brand
 *   copy at the headline's original size — swapping the rendered glyphs
 *   without touching the DOM text node itself, which stays in the
 *   accessibility tree unchanged (see the package README's Known
 *   Limitations for this residual gap).
 * - `heroWorkspaceRow` (`ConversationRoot.module.css`) hides the whole
 *   workspace-chip-plus-picker row outright, not scoped to `[data-phase='hero']`:
 *   `ConversationRoot.tsx` only ever mounts it during the hero phase. This is
 *   the ONLY thing keeping workspace vocabulary off the page — `ui-workspace`
 *   is composed (`dsh-client-ui-conversation` requires its `uiWorkspace`
 *   service; see the package README), so the chip carries a real Workspace
 *   title and its picker menu is live. A row this rule stopped matching would
 *   put both back on screen, which is why an e2e scenario asserts the row is
 *   present and renders nothing, rather than trusting the selector.
 *   `conversation.hero.agentPreset`, the row's other seat, is emptied at the
 *   composition level instead (`ui-agent-preset` disabled outright by the
 *   console bundle), not by this CSS: disabling the whole
 *   package also removes its session-header preset label and its Settings
 *   row, which this hero-only rule could not reach.
 *
 * The permission-preset chip (`PermissionSelect`, which
 * `@deepseek-ai/dsh-client-ui-permission-presets` registers into the
 * `conversation.input.permission` seat of `InputBar.tsx`'s `modes` row,
 * alongside the `conversation.input.plan` seat) renders as soon as a
 * conversation carries the `permissions` projection, and labels itself off
 * the preset's own machine name — `workspace-write` title-cased into
 * "Workspace Write", a string no locale entry and no disable row can reach.
 * The rule scopes on two class substrings under `[data-composer-card]`:
 * `modes` (`InputBar.module.css`) picks the seat's own row, which keeps the
 * rule off the other `trigger`-named controls the same card carries
 * (`ContextMeter.module.css`'s trailing meter, `InputBar.module.css`'s own
 * `chipTrigger`/`textRefTrigger` mirror decorations), and `trigger`
 * (`PermissionSelect.module.css`) picks the chip button with its icon, label,
 * and chevron spans. Renaming either class, or reseating the chip outside that
 * row, silently un-hides it; the e2e scenario screens the whole landing page's
 * rendered text for the banned word, so a broken selector fails the gate
 * instead of shipping the vocabulary. The plan chip sharing the row is left
 * alone: "Plan" is neither banned vocabulary nor internal status, and that
 * chip is the only control that leaves plan mode. `Menu`'s wrapper span around
 * the hidden button survives as a zero-width flex item, and the preset menu it
 * anchors never opens, since the only control that opens it is gone. The
 * console bundle disables that package's `ui-permission` row, so under it the
 * rule matches nothing; the rule covers a composition that keeps the row, such
 * as `overlay/sidebar-menu.patch.yml`.
 *
 * This rule closes one permission surface of three. The console offers an end
 * user no permission switch of any kind (product decision, 2026-09-07), and
 * the other two are closed at the composition level rather than here:
 * the console bundle disables the `ui-permission` row, which is the
 * Settings → General default-preset control, and sets
 * `isolate: { commands: true }` on the `permission-presets` row, so that
 * package's command child never activates and `/permission` is never
 * registered. The preset in force is untouched by all three — the Host keeps
 * whatever `permission-presets` row the deployment composes, on the
 * `defaultPreset` that overlay names unless the deployment's settings document
 * stores one of its own (see the package README's De-terminology section).
 *
 * The Settings header's action row is the fourth piece with no composition
 * hook. `dsh-client-ui-settings-general` is the settings shell itself — the
 * panel, the navigation, the General section — so its row cannot be disabled,
 * and it registers the **Open configuration file** action into its own
 * `settings.action` list slot with no Config field gating it. No other plugin
 * can withdraw the entry: `ctx.slots.register()` hands its disposer to the
 * registrant. An entry registered under the same list id (`open-document`) at
 * a lower priority would keep it from rendering — the shadowing
 * `settings-rows.ts` applies to a General row — and this action is hidden
 * by the rule below instead.
 *
 * That action is the shell's only `settings.action` registrant in this
 * repository, so hiding the row that holds it hides exactly it. It is guarded
 * by `ctx.remote.$host.isLoopback`, which this console makes true on a remote
 * visitor: `dsh-experimental-server-base`'s `ownsHost` declares the deployment's
 * own login gate as the thing deciding who reaches the page, and every visitor
 * it admits then gets the operator surface. So this is not a rule that only
 * matters on a developer's own machine — without it, a customer signed in to
 * the deployed console is offered the Host's configuration file.
 *
 * The selector pairs the panel's own semantics with tsdown's `[hash]_[local]`
 * class naming: `[role='dialog'][aria-modal='true']` is `SettingsRoot.tsx`'s
 * own dialog element, and `[class$="_header"] > [class$="_actions"]` is the
 * header's action row as its direct child. The direct-child pair is what keeps
 * the rule off a section that happens to name a class `actions`. The rule hides
 * what the row holds and leaves the row itself in the layout: the row's
 * `margin-left: auto` is what seats the close button at the header's right
 * edge, and a row taken out of the layout lets that button fall to the left.
 * Reseating the
 * action outside that row, or giving either element a second class, silently
 * un-hides it — so an e2e scenario asserts the row is present AND renders
 * nothing, the same pairing every rule above is pinned with.
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
[data-phase='hero'] [class*="titleGroup"] > :first-child { font-size: 0 !important; }
[data-phase='hero'] [class*="titleGroup"] > :first-child::after {
  content: '工作台小助手';
  font-size: 26px;
  line-height: 32px;
}
[class*="heroWorkspaceRow"] { display: none !important; }
[data-composer-card] [class*="modes"] [class*="trigger"] { display: none !important; }
[role='dialog'][aria-modal='true'] [class$="_header"] > [class$="_actions"] > * { display: none !important; }
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
