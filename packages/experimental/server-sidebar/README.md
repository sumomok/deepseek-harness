# @deepseek-ai/dsh-experimental-server-sidebar

English | [中文](README.zh.md)

A fixed-width product-console sidebar: a drop-in replacement for the shipped [`dsh-client-ui-sidebar`](../../client/ui-sidebar/README.md) that removes session/workspace browsing entirely and replaces it with three sections — 工作台 (workbench, one persistent default conversation), 导航 (navigation, `@deepseek-ai/dsh-experimental-content-frame`'s configured pages), and 我的工作流 (my workflows, a user's own named shortcuts back to conversations they taught the agent something in). It replaces ui-sidebar in a composition rather than sitting beside it, because `sidebar` is a single slot and its child slots may be declared only once.

This package targets a "customer form" composition: an end customer using the product never needs to know a conversation is a durable, resumable object with a Workspace behind it. Every session/workspace management step (creating one, reconnecting one, choosing which one is "current") happens inside this package's own actions; the vocabulary itself — 会话/session, 工作区/workspace — is banned from every string this package's own dictionaries carry, and the composition disables the shipped controls that would otherwise leak it (see De-terminology below).

## Replacing the shipped sidebar

- **Four child slots survive** — `sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.settings`, and `sidebar.footer.action` keep the kinds and scopes `dsh-client-ui-sidebar` declared, reused by type import rather than restated, so ui-settings's existing registration and any brand package filling the two identity slots work unchanged. `sidebar.workspaces` is dropped outright: this shell has no session-browsing region for it to seat in, and the customer composition simply never composes `ui-workspace` (see Composition below) — composing it unchanged would throw at boot, since its own registration targets a slot this shell no longer declares.
- **The New Session button is gone.** There is no "start an ad-hoc conversation" affordance in this shell; every entry point (工作台, a 导航 page, a 我的工作流 row) resolves or creates its own session internally.
- **The 56px collapse rail is gone.** This shell never calls a collapse action and always renders its full content regardless of the `collapsed` owner prop — see the Known Limitations entry on the residual coupling this leaves with the surrounding shell's own track geometry.
- **The pointer-driven scrollbar behavior is unchanged** — the column's scrollbars draw while the pointer is inside it and for two seconds after it leaves, canceling a pending hide if the pointer returns, tracked geometrically rather than by DOM containment (so a portalled overlay that is a DOM descendant of the column, as ui-settings renders its panel, does not read as "the pointer left").

## Workbench

工作台 is the one persistent default conversation this shell always lands on. Clicking it, or loading the sidebar with no session currently selected, resolves the recorded `workbenchSessionId` and reopens it if it is still live; with none recorded (first use) or a recorded one that is gone, it creates a fresh session against the recent Workspace and records the new id. `workbenchSessionId` is a weak reference for exactly the same reason a workflow's `homeSessionId` is (see below): nothing here owns session deletion, and a stale pointer degrades to a fresh conversation rather than corrupting the document that names it.

## Navigation

导航 lists `@deepseek-ai/dsh-experimental-content-frame`'s configured pages, read once from its `/content-frame/settings` route before this entry registers (a hardcoded route path and locally validated JSON shape, not an imported value or type — a cross-package value import is not this repository's sanctioned way to couple two client-adjacent plugins). Clicking a page executes content-frame's `show-content-page` command against the current session (creating one first when none is open, through the same resolution the workbench and every workflow action share — see `client/session-resolution.ts`), through `ctx.remote.commands.execute` — the same command seam a session log can replay, not a direct service call. The command's handler appends `content/shown` with `by: 'user'`. Navigation order follows deployment configuration order; it is never user-reordered (decision ⑤).

## My Workflows

我的工作流 is a user's own named shortcuts, persisted per account (this deployment model's one-process-per-user shape — "per account" means "per `$DSH_HOME`"). One workflow binds exactly one conversation (v1 boundary; see Known Limitations): `{id, name, order, homeSessionId, navSnapshot, savedAt}`.

- **Save** — the "存为工作流" (Save as workflow) action lives in the conversation's own session header (`conversation.session.header.actions`, order 30, after the subagent catalog and background jobs), not a sidebar "+" button: a regular seat for a session-scoped, occasional action already existed, and adding a second interaction pattern for the same kind of action was not justified. It is visible only once the current conversation carries at least one user-authored message (decision ③, checked via `chat.legacy.nodes` — see Known Limitations for the v1 approximation this implies), matching the intuition that a workflow is a shortcut back to a conversation the user actually started, not an empty one. Saving captures the current session id as `homeSessionId` and the content column's currently-shown page ids, oldest first, as `navSnapshot`.
- **Open** — clicking a workflow reopens `homeSessionId` directly when it is still live. **Restoring only fills in what is missing** (decision ⑦): reopening a live session never touches its content, since there is nothing missing to fill.
- **Degrade** (decision ⑧) — when `homeSessionId` is gone, opening the workflow creates a fresh session against the recent Workspace, replays `navSnapshot` onto it in order (oldest first, so the last one replayed ends up on display, matching what was on display when the workflow was saved), and repoints `homeSessionId` at the new session. A fresh session starts empty, so "fill in what is missing" is trivially the whole snapshot.
- **Rename / remove / reorder** — hover-revealed icon buttons (the former favorites menu's own idiom), not a native right-click context menu, and up/down buttons rather than HTML5 drag-and-drop — both are v1 downgrades from the task's own permitted fallback clause; see Known Limitations. Reordering follows user drag order (decision ⑤), expressed here as explicit move-up/move-down swaps of the `order` field.
- **Unread indicator** (decision ④) — a workflow whose `homeSessionId` has unseen output draws a green dot, reusing the session list's own `completed` bit ("finished while not selected and not yet opened") verbatim rather than a second last-seen bookkeeping mechanism the original brief suggested as a fallback: `completed` already means exactly this, and it already clears the instant `sessions.open` selects the session — see Known Limitations for why this is unit-tested only, not covered end to end.

The durable document (`{workflows, workbenchSessionId}`) lives in this package's own settings namespace and is served over one same-origin route:

- `GET /server-menu/workflows` — the current document, `cache-control: no-store`.
- `POST /server-menu/workflows` — **merges** the posted patch (`{workflows?, workbenchSessionId?}`) into the current document rather than replacing it wholesale, so a caller changing only `workbenchSessionId` never has to resend the current workflow list, and vice versa. A duplicate workflow id in the resulting document is refused before it commits, by both the route's `validate` hook and this package's invariant.

The browser cannot call `settings.*` RPC directly — it is a loopback-privileged method group a reverse proxy answers 403 for — so this package's node half is an optional child that registers the route only when both `ctx.settings` and `ctx.webServer` are composed; without them the sidebar itself still works (navigation is unaffected), just with nothing to show or persist under 我的工作流.

## De-terminology

Decision ② bans 会话/新会话/session/workspace from every user-visible string this composition renders, on top of the whole-shell restructure above. Four more shipped surfaces name this vocabulary and are removed the same way ui-sidebar/ui-workspace are — by disabling the row in the customer overlay, never by patching the row's own copy:

| Surface | Row disabled | Note |
| --- | --- | --- |
| Chat/Trajectory tabs | `ui-trajectory` | The Trajectory tab is `ui-trajectory`'s own registration; removing it leaves a single-option tab switcher, which renders as no tab control at all. |
| Session log download button | `session-log-download` (`@deepseek-ai/dsh-session-log-export`) | The download dialog itself also carries "Session" copy; disabling the row removes both the trigger and the dialog. |
| Model selector | `ui-model-selection` | Also the composer's own "unselected model" block (`ConversationRoot.tsx`'s `useComposerBlock`) — with the row gone, no plugin ever arms that block, so the composer stays usable with no model picker at all. |
| Turns/steps status row | *(no disable row exists)* | `StatsLine` is a shipped `ui-conversation` component with no Config flag and no disable seat of its own — see below. |

The turns/steps row has no official channel to remove, so this package falls back to a scoped CSS injection: a client-only effect (`terminology-guard.ts`) inserts `[data-composer-card] + * { display: none !important; }` into the document head. `data-composer-card` is the composer's own card wrapper (`InputBar.tsx`); its next sibling is the composer's footer/dock region, which in the shipped composition carries only `StatsLine` (`conversation.composer.dock`, order 0) — so this hides exactly the turns/steps row today, but it is a DOM-order-coupled selector, not a Config flag: a future plugin registering into `conversation.composer.dock`, or a DOM restructure of the composer's own markup, would silently change what this rule hides without either package's tests catching it from the other side. It is pinned by this package's own e2e scenario (`apps/web/tests/server-sidebar.e2e.ts`), which fails loud if the row becomes visible again.

## Composition

The plugin is not part of any shipped bundle. `overlay/customer.patch.yml` is the full customer-form overlay: it disables `ui-layout`, `ui-sidebar`, `ui-workspace`, `ui-cordis`, `ui-trajectory`, `ui-model-selection`, and `session-log-download`, and inserts `server-layout`, `content-surface`, `content-column`, and this package. It does not insert `content-frame` — the deployment's own page catalog is composed separately, alongside it. Apply it with `dsh --profile <name> --patch <path>`; the package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile <name> add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Model Experience

None, as this package manages browser viewing state and a user-driven workflow document; the commands it executes run outside any model turn and reach no model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Literal 240px is not independently enforced.** This shell never fixes an inline pixel width; it renders at whatever `width` its owner (`dsh-experimental-server-layout`) hands it, and never toggles collapse. `server-layout`'s frozen 3:16:5 track ratio happens to equal exactly 240px at its own 1920px reference frame width (`1920 * 3/24 = 240`), but at any other frame width the column is proportional, not fixed. Making it literally fixed would require changing `server-layout`'s own frozen, deliberately non-configurable geometry, which is out of this change's scope.
- **Decision ③'s user-message check is a paged-window approximation.** Visibility of "存为工作流" reads `useSession(s => s.chat.legacy.nodes)`, the same paged conversation-snapshot window `StatsLine.tsx` reads from — a user message far enough back to have paged out of the window would not be found. A whole-log check would need a durable projection this v1 does not add.
- **The turns/steps status row is hidden by a DOM-order-coupled CSS selector, not a Config flag.** See De-terminology above for the exact fragility and what pins it.
- **`navSnapshot` never captures a chart-kind entry.** `captureNavSnapshot` filters the content-surface projection to `kind === 'page'` entries only; a workflow saved while a chart holds the column replays only the page entries, dropping the chart from the degraded re-creation.
- **The green-dot mechanism reuses `completed` rather than new bookkeeping, and is unit-tested only.** It is an exact match for "finished while not selected and not yet opened," but proving it end to end would require a real agent-loop running→idle transition while unselected — `SessionManager`'s `running` bit is a host-frame push tied to actual execution, not something a log-only append can fake. This scenario's own e2e suite issues no model calls (matching its established design), so the mechanism is pinned by `packages/experimental/server-sidebar`'s own unit tests instead.
- **Reordering is up/down buttons, not drag-and-drop; rename/remove/reorder use hover-revealed icon buttons, not a native context menu.** Both are v1 downgrades the task's own brief explicitly permitted ("若实现体量失控，降级为右键菜单「上移/下移」"), exercised here given this change's overall size.
- **`ui-workspace` not composed, not merely hidden.** A zero-Workspace fresh install still leaves a page or workflow click a contained no-op (see Navigation above) — an existing, already-accepted edge case carried forward from the prior favorites-based design, not new here.
- **The settings route assumes an HTTP carrier.** The browser half fetches `/server-menu/workflows` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would fail the row, the same way content-frame's settings route would.
- **Not covered by an assembled snapshot.** The browser evidence is a Playwright scenario against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
