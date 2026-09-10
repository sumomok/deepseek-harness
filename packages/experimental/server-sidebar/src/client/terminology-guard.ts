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
 * - `headlineText` (`HeroShell.module.css`) is collapsed to `font-size: 0`
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
 *   composition level instead (`ui-agent-preset` disabled outright — see
 *   `overlay/customer.patch.yml`), not by this CSS: disabling the whole
 *   package also removes its session-header preset label and its Settings
 *   row, which this hero-only rule could not reach.
 *
 * The permission-preset chip (`PermissionSelect`, seated in `InputBar.tsx`'s
 * `modes` row alongside the `conversation.input.plan` seat) renders as soon as
 * a conversation carries the `permissions` projection, and labels itself off
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
 * anchors never opens, since the only control that opens it is gone.
 *
 * This rule closes one permission surface of three. The console offers an end
 * user no permission switch of any kind (product decision, 2026-09-07), and
 * the other two are closed at the composition level rather than here:
 * `overlay/customer.patch.yml` disables the `ui-permission` row, which is the
 * Settings → General default-preset control, and sets
 * `isolate: { commands: true }` on the `permission-presets` row, so that
 * package's command child never activates and `/permission` is never
 * registered. The preset in force is untouched by all three — the Host keeps
 * whatever `permission-presets` row the deployment composes, on the
 * `defaultPreset` that overlay names unless the deployment's settings document
 * stores one of its own (see the package README's De-terminology section).
 *
 * The conversation column shows business content only (product decision,
 * 2026-09-07): a customer reads what they asked for and what came back, not
 * how the run got there. Nothing in `dsh-client-ui-chat` gates that — the
 * `ui-chat.transcriptView` setting is a closed `'normal' | 'compact'` union
 * whose most-hiding value is already the default, it folds process rows
 * behind a disclosure instead of removing them, it never applies to a running
 * turn (`ChatNodeSeat.tsx`'s `processWindowReady` requires a closed turn and a
 * complete history), and it is not pinnable from a composition (`ui-chat`
 * supplies neither a `Config` nor a settings `base`). So the rows go the same
 * way the stats row does, through this stylesheet.
 *
 * The process rules key on `data-chat-flow-kind`, `ChatNodeSeat.tsx`'s own
 * per-row attribute carrying the Chat Node's kind. That is a real attribute
 * rather than a class substring or a DOM position, so it is the most stable
 * coupling in this file: it breaks only if `ui-chat` renames a kind, which the
 * e2e turns red by asserting each row is present AND computed `display:
 * none` — `compact` already folds process rows behind `hidden="until-found"`,
 * so an invisibility assertion alone would pass with these rules deleted.
 *
 * `ChatNodeDataMap` (`ui-chat/src/client/contract/chat-nodes.ts:16-19`) is a
 * merge-extensible map, so the kind union is open and a kind this file does
 * not name renders unchanged. Every member this console composes is therefore
 * accounted for below, hidden or kept; the unit spec fails to compile if the
 * union gains one that is in neither list.
 *
 * Hidden:
 * - `system-prompt` (`SystemPromptNodeView`, `chat/SystemPromptRow.tsx:43`) — the
 *   系统提示词 disclosure holding the whole prompt.
 * - `turn-process` (`chat/TurnProcessNodeView.tsx:7`) — the completed-turn
 *   fold row ("N 次工具调用 · M 条消息"). With the members it folds hidden
 *   outright, the control it offers has nothing left to reveal.
 * - `tool-call` (keyed `tool.call.toolview`, `ui-tool/src/client/apply.ts:34-42`)
 *   — every tool row, including `content_read`'s own result card
 *   (`dsh-experimental-content-frame`'s `ContentReadRow`, a keyed entry under
 *   this kind). That card is hidden on purpose: the content column shows the
 *   page itself, so the row restates in the transcript what is already on
 *   screen.
 * - `command`, `manual-compaction` (`chat/CommandNodeView.tsx:13,27`) and
 *   `compaction` (`chat/MessageItem.tsx:356`) — the command rows. The three
 *   kinds are one surface split by how the command arrived: `manual-compaction`
 *   is `/compact` with its compaction transaction, `compaction` the automatic
 *   one, and `command` everything else. Hiding only `command` would leave
 *   `/compact` on screen. This supersedes, inside this composition only,
 *   content-frame's and content-column's own narrower
 *   `[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty)`
 *   rules; those still carry compositions that do not install this guard.
 * - `context` (`chat/MessageItem.tsx:342`, drawing `ContextInjectionRow.tsx:31`) — the injected
 *   runtime-context message (上下文注入 / 跨会话召回). It is a `user/message`
 *   whose source is not the user, so it is machinery the run needed, not
 *   something the visitor wrote or the model answered.
 * - `model-retry` (`chat/MessageItem.tsx:361`) — the provider-retry chain.
 *   Internal status: the retry either succeeds, in which case the answer is
 *   the outcome the visitor reads, or it exhausts, in which case `turn-error`
 *   says so and is kept.
 * - `command-input` (`dsh-client-ui-goal`,
 *   `ui-goal/src/client/goal-command-input.ts:18`) — the `/goal` line echoed
 *   back as its own row. `ui-goal` is composed by the web bundle and no
 *   console overlay disables it, so this kind is live here.
 * - `workflow-run` (`dsh-client-ui-workflow-run`,
 *   `ui-workflow-run/src/client/workflow-definition.ts:40`) — the
 *   workflow-run lifecycle card with its phases and members. `ui-workflow-run`
 *   is likewise composed and undisabled. The sidebar's own 我的工作流 section
 *   is a different thing entirely: a saved shortcut back to a conversation,
 *   not this tool's run report.
 * - `unknown` (`ui-chat`'s registered fallback,
 *   `conversation-nodes/fallback.ts:10`; `UnknownNodeView` renders a
 *   `JsonBlock`) — the raw JSON of an append-surface event no Definition
 *   claimed. Nothing in the console can produce one today (see the unit spec),
 *   but a definition-set change upstream would put raw event payloads in front
 *   of a customer, which is the exact opposite of this decision.
 * - `[data-variant="think"]` — the reasoning disclosure. It is not a row kind:
 *   `ReasoningRow.tsx` renders it inside the `assistant-step` seat, whose text
 *   is kept, so the rule keys on the attribute that component sets
 *   unconditionally. `ToolRowVariant` has no other `think` member, so nothing
 *   else in the column matches.
 *
 * Kept: `user` and `steering` messages, `assistant-step` text, `turn-error`
 * and `turn-max-tokens` (notices a reader must act on), and `turn-tail`, whose
 * `{tail}` chain is `dsh-client-ui-deliverables`' produced-files list — the
 * files a run made are the business result, so the footer rule below takes the
 * metric pills and leaves the tail and the row's own controls. Approval cards
 * are out of reach of every rule here by construction: `dsh-client-ui-approval`
 * registers into `conversation.composer`, so an approval takes the composer
 * over and never becomes a flow row at all.
 *
 * The reply footer loses its two metric pills — 用量 33.7K tok and 用时 6 秒 —
 * and keeps everything else in the row: copy, like/dislike, branch, and the
 * end-of-turn clock are the visitor's own affordances, not process reporting.
 * Neither pill carries a `data-*` attribute of its own (`TurnUsagePanel.tsx`
 * puts one on each opened dialog and none on either trigger), so the rule
 * couples on the CSS-module local name both panels give that button,
 * `TurnUsagePanel.module.css`'s `.trigger`, and hides the wrapper through it:
 * `[data-turn-tail] :has(> [class*="trigger"])` selects each panel's own
 * `span.root`, so the pill leaves no flex slot and no `.root + .root` margin
 * rebate behind, which hiding the button alone would.
 *
 * `aria-haspopup="dialog"` looked like the semantic handle and is not one:
 * `dsh-client-ui-message-feedback`'s note-open button carries it too, and that
 * button sits in this same row as part of the like/dislike affordance the
 * decision keeps. The class substring is therefore the fragility here, the
 * same shape as the permission-chip rule above: renaming `.trigger` in
 * `TurnUsagePanel.module.css`, or seating any other `trigger`-named control in
 * the tail, changes what this hides with no compile-time signal. The e2e reads
 * both halves — the pills gone, and copy, branch and the clock still on
 * screen — so either direction of that drift turns the gate red.
 *
 * The composer placeholder is swapped through the same `::after` technique the
 * hero headline uses, but it takes two rules rather than one, because
 * `InputBar.tsx` renders a single `[data-composer-placeholder]` element for
 * every state of a placeholder ladder that is longer than it looks
 * (`InputBar.tsx:467-476`: the owner prop first — hero copy, the inert
 * composer's own diagnostic, a raised block's reason — then `parentOffline`,
 * then any other disabled state, then the steer-queue hint, then plan mode,
 * then the default). The rules split it on what the composer can do:
 * - **Accepts input** →  说说要做什么, the invitation. Scoped
 *   `[data-composer-input]:not([data-phase='inert']):not([aria-disabled])`.
 * - **Refuses input, with a session** →  暂时无法输入. Scoped
 *   `[data-composer-input][aria-disabled]`. This is where `placeholder.unavailable`
 *   (会话不可用 / "Session unavailable") and `placeholder.parentOffline`
 *   (父会话已离线…) land — banned session vocabulary decision ② reaches no
 *   other way, since both belong to `ui-conversation`'s own locale namespace.
 *   The swap keeps what a visitor needs (input is unavailable right now) and
 *   drops the word. It also covers a raised composer block, whose placeholder
 *   would be the blocker's own reason: that state is dead in this composition
 *   (`ui-model-selection`, its only producer, is disabled by the customer
 *   overlay) and a deployment that brought it back would have its reason
 *   masked by this copy.
 * - **The inert composer with no Workspace** → left alone. Its placeholder is
 *   the only thing saying the composer is unusable and why
 *   (`ConversationRoot.tsx:334`, `placeholder.workspace`), so neither swap
 *   reaches it — see the package README's Known Limitations.
 *
 * `data-phase` is `input?.phase ?? 'inert'` (`InputBar.tsx:533`), so the inert
 * state is the one with no composer input face at all; `aria-disabled` is
 * `editorDisabled` (`:534`), which every refusing state sets and the
 * workspace-picker trigger deliberately does not — that asymmetry is what
 * makes the three-way split expressible at all. The `+` combinator is exact:
 * `InputBar.tsx:545-549` renders the placeholder as that element's immediately
 * following sibling. The swapped copy carries `ui-conversation`'s own
 * font-size token rather than a fixed pixel value, so it keeps tracking the
 * Settings font-size preference the composer card sets. `ui-conversation`
 * offers nothing else: the `placeholder` prop of `conversation.composer.bar`
 * is supplied by `ConversationRoot` alone, and the locale registry rejects a
 * second registration for a namespace/locale pair it already holds, so the
 * `conversation` namespace cannot be shadowed. As with the headline, the
 * element's own text node survives — and here so do the sibling
 * `[data-composer-input]`'s `data-placeholder` and `aria-label`, which is what
 * keeps the e2e's `composer(page, …)` locators working and what the package
 * README's Known Limitations records as the residual gap.
 *
 * The running-turn indicator (`ChatView.tsx`'s `TurnStatus`) stays on screen —
 * a customer must see that work is under way — but its copy and its paint are
 * vendor branding: `chat.deepDiving` is 深度求索中..., the vendor's Chinese
 * brand name, painted in `--dsw-static-deepseek-500/200` through a
 * background-clip-text shimmer. The rule re-texts it to 正在处理… by the same
 * `::after` swap and neutralises the gradient to the theme's ordinary label
 * colour. It scopes as `[data-chat-flow] > [class*="turnStatus"]`: the
 * indicator is a direct child of the column (`ChatView.tsx` renders it outside
 * every `ChatNodeSeat`, which is also why no `data-chat-flow-kind` rule
 * reaches it), and the direct-child combinator keeps the rule off the nested
 * `turnStatusClock` span, which sets its own font size and colour and keeps
 * showing the elapsed clock after fifteen seconds.
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
[data-composer-card] [class*="modes"] [class*="trigger"] { display: none !important; }
[data-chat-flow-kind="system-prompt"] { display: none !important; }
[data-chat-flow-kind="turn-process"] { display: none !important; }
[data-chat-flow-kind="tool-call"] { display: none !important; }
[data-chat-flow-kind="command"] { display: none !important; }
[data-chat-flow-kind="manual-compaction"] { display: none !important; }
[data-chat-flow-kind="compaction"] { display: none !important; }
[data-chat-flow-kind="context"] { display: none !important; }
[data-chat-flow-kind="model-retry"] { display: none !important; }
[data-chat-flow-kind="command-input"] { display: none !important; }
[data-chat-flow-kind="workflow-run"] { display: none !important; }
[data-chat-flow-kind="unknown"] { display: none !important; }
[data-variant="think"] { display: none !important; }
[data-turn-tail] :has(> [class*="trigger"]) { display: none !important; }
[data-composer-input]:not([data-phase='inert']):not([aria-disabled]) + [data-composer-placeholder] {
  font-size: 0 !important;
}
[data-composer-input]:not([data-phase='inert']):not([aria-disabled]) + [data-composer-placeholder]::after {
  content: '说说要做什么';
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
[data-composer-input][aria-disabled] + [data-composer-placeholder] { font-size: 0 !important; }
[data-composer-input][aria-disabled] + [data-composer-placeholder]::after {
  content: '暂时无法输入';
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
[data-chat-flow] > [class*="turnStatus"] {
  font-size: 0 !important;
  background: none !important;
  animation: none !important;
  color: var(--dsw-alias-label-primary) !important;
  -webkit-text-fill-color: var(--dsw-alias-label-primary) !important;
}
[data-chat-flow] > [class*="turnStatus"]::after {
  content: '正在处理…';
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
}
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
