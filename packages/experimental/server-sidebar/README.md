# @deepseek-ai/dsh-experimental-server-sidebar

English | [中文](README.zh.md)

A drop-in replacement for the shipped [`dsh-client-ui-sidebar`](../../client/ui-sidebar/README.md), adding one "改造" (retrofit) menu area above the session list: **页面路由** (page routes) — every page `@deepseek-ai/dsh-experimental-content-frame` is configured with, one click away from the center content column — and **业务流程** (favorites) — a user's own named shortcuts back to specific sessions. It replaces ui-sidebar in a composition rather than sitting beside it, because `sidebar` is a single slot and its five child slots may be declared only once.

## Replacing the shipped sidebar

A sidebar replacement is only a drop-in if it honors everything the shipped one published. The shipped `dsh-client-ui-sidebar` entry has no host-side behavior beyond its client half — its own node half is `export function apply(): void {}` — so there was nothing else to carry over; this package's own node half exists solely for the favorites feature (below), which the shipped sidebar has no counterpart for. This package reproduces the rest of the client contract:

- **The five child slots** — `sidebar.brand.mark`, `sidebar.brand.name`, `sidebar.workspaces`, `sidebar.settings`, and `sidebar.footer.action` keep their kinds and scopes, so ui-workspace's and ui-settings's existing registrations, and any brand package filling the two identity slots, work unchanged. The declarations are reused from ui-sidebar by type import rather than restated, so a registrant compiles against one documented contract regardless of which sidebar is composed.
- **The New Session button and the sidebar toggle** — the same two triggers, wired to `ctx.workspaces.startSession()` and `ctx.layout.toggleSidebar()`.
- **The fold geometry** — a 56px collapsed rail, a 150ms wide-content fade-out before the rail settles, and the `.railIn` slide-in animation applying only to a live collapse, never a cold start into the collapsed state.
- **The pointer-driven scrollbar behavior** — the column's scrollbars draw while the pointer is inside it and for two seconds after it leaves, canceling a pending hide if the pointer returns; a pointer moving across a portalled overlay that is a DOM descendant of the column (as ui-settings renders its panel) is tracked geometrically rather than by DOM containment.

The one thing this shell adds on top of that contract is the menu section between the New Session button and the workspace browser, described below.

## Page routes

The menu's first group lists `@deepseek-ai/dsh-experimental-content-frame`'s configured pages, read once from its `/content-frame/settings` route before this entry registers (a hardcoded route path and locally validated JSON shape, not an imported value or type — a cross-package value import is not this repository's sanctioned way to couple two client-adjacent plugins). Clicking a page executes content-frame's `show-content-page` command against the current session, through `ctx.remote.commands.execute` — the same command-seam a session log can replay, not a direct service call. The command's handler appends `content/shown` with `by: 'user'`, which content-frame's `page` extractor and its README document.

**With no current session**, a click first resolves one to execute the command against: the current session's Workspace if one is selected in the abstract, otherwise the most recently used Workspace, connecting it exactly as the New Session button's own resolution does (`WorkspaceRuntime.startSession`'s target logic, replicated rather than called directly — `startSession` is fire-and-forget and never hands back the new session id this caller needs in hand). With no Workspace at all — a fresh install that has never connected one — there is nowhere to create a session into, and the click is a contained no-op (see Known Limitations).

## Favorites

The menu's second group is a user's own named shortcuts to sessions, persisted per account. "Per account" here means "per `$DSH_HOME`", matching this deployment model's one-process-per-user shape: the durable list lives in the `settings` capability's file-backed document, so favoriting a session in one browser tab shows up in every other browser reading the same account, and survives a process restart the same way any other setting does.

The browser cannot call `settings.*` RPC directly — it is a loopback-privileged method group that a reverse proxy answers 403 — so this package's node half is an optional child that, when both `ctx.settings` and `ctx.webServer` are composed, registers the `server-sidebar` settings namespace and serves it over one same-origin route:

- `GET /server-menu/favorites` — the current list, `cache-control: no-store`.
- `POST /server-menu/favorites` — replaces the whole list. Fenced to same-site, JSON-only requests (the same pattern [`auth-gate`](../auth-gate/README.md)'s `rejectCrossSite`/`rejectNonJson` use, copied rather than imported for the same cross-package reason as the page route above) and bounded in size; a duplicate session id in the posted list is refused before it commits, by both the route's `validate` hook and this package's invariant.

A favorite names a session by id and carries its own user-typed label, independent of the session's own title. **A favorite is a weak reference**: this package never observes session deletion, so a favorite naming a session the workspace domain no longer lists is expected, not corrupt. The menu filters live sessions from the current `useSessions` snapshot on every render and renders a stale favorite as a grayed-out, non-navigable row that stays removable — never silently dropping it from the list.

## Composition

The plugin is not part of any shipped bundle. Compose it as an overlay over the Web surface:

```yaml
- id: ui-sidebar
  name: '@deepseek-ai/dsh-client-ui-sidebar'
  disabled: true

- insert:
    - id: server-sidebar
      name: '@deepseek-ai/dsh-experimental-server-sidebar'
```

`overlay/sidebar-menu.patch.yml` is that file; `dsh --profile web --patch <path>` applies it, typically alongside content-frame's own overlay so the page-routes group has something configured to list. A disabled row never reaches the browser boot manifest, so the browser fetches this bundle instead of ui-sidebar's. The package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Model Experience

None, as this package manages browser viewing state and a user-driven favorites document; the command it executes runs outside any model turn and reaches no model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The on-display rule does not distinguish writers** — a page this menu opens and a page the agent's `content_show` tool chooses both land as the identical `content/shown` event, differing only in `by`. [`content-surface`](../content-surface/README.md)'s kind-agnostic prompt rule still tells the model to update "something you have already produced and put on display," which reads as if the agent produced a page the user opened by hand. That prompt text is a pinned, measured string and is deliberately left unchanged here — see content-frame's own README for the full account of this tension and the field that exists to let a future prompt or renderer draw the distinction.
- **Auto-creating a session on a page click is a deliberately revisable default** — clicking a configured page with no session open silently creates one (see Page routes above) rather than asking first or doing nothing. Nothing about the command seam or the settings model depends on this choice; a future revision could prompt instead, or open the page in an unattached preview.
- **A fresh install with no Workspace at all leaves a page click a no-op** — there is nowhere to create a session into, and the click is silently absorbed (a console warning is the only trace). This is a genuinely empty edge case in current deployments (every one in production has at least one Workspace by the time a user opens a sidebar), not a handled state in the UI.
- **Favorites have no reordering affordance beyond insertion order** — `order` exists in the durable schema and the menu sorts by it, but nothing in this package's UI lets a user drag or renumber a favorite; today's `order` is assigned once, at add time, one past the current highest.
- **No favorites import/export or cross-account sharing** — the document is exactly this account's list, read and written through this account's own settings scope; there is no path to copy a favorites list between accounts or deployments.
- **The settings route assumes an HTTP carrier** — the browser half fetches `/server-menu/favorites` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would fail the row, the same way content-frame's settings route would.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
