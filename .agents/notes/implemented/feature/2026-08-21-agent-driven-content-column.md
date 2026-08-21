# Agent Note: The agent drives the content column, and its frames outlive session switches

Status: implemented

English | [中文](2026-08-21-agent-driven-content-column.zh.md)

## Problem

[The hosted-application note](2026-08-21-content-column-hosted-application.md) put one static application in the shell's content column and named its own gap: the agent could not drive the frame, what the column showed was not model-visible, and it was not reconstructable from a session log. The column showed one page, chosen by configuration, forever.

Two things had to change together. The agent needs a way to put a chosen page in front of the user, recorded durably so a reopened session shows what it showed. And the frame has to survive a session switch: a `session-maybe` occupant is remounted on every switch after the first, which destroys the iframe's document — the state a user leaves in a page is exactly what a work surface exists to hold.

## Decision

`content` is now a **`root`** slot. `content_show` is the agent's only control over it, `content/shown` is what that control writes, and the `content` projection is what the browser reads. The browser half keeps one live frame per session.

`Config` grows three fields beside `root`: `pages` (at least one `{id, title, description, url}`, each `url` a same-origin path), optional `defaultPage`, and `cacheSize` (default 3). A duplicate id, the reserved id `none`, a URL naming a scheme or host, a `defaultPage` matching no page, and a `cacheSize` below 1 each fail the row at load.

### One tool, one event, one projection

`content_show(page)` carries the whole page list in its description as `id — title — description` lines, so the deployment's vocabulary reaches the model without a system-prompt section. A configured id appends `content/shown` and answers `Now showing <title> in the content column.`; `none` appends `{ page: null }` and answers `Content column cleared.`; anything else **appends nothing** and answers with the catalogue again, so the model corrects itself from the result rather than from a retry.

`content/shown` records the id as the agent named it, unresolved. The `content` projection folds it last-wins and resolves it in `wire.view` against the page list running **now**, into a four-arm discriminated value: `shown`, `default` (nothing shown, a default configured), `empty`, and `missing` (the id no longer names a page). That split is what lets a deployment rename or retire a page without rewriting history, and it leaves the browser with a finished `{url, title}` to render.

The event carries no `ignorable` marker: a runtime whose session vocabulary lacks it refuses the log rather than silently dropping a state change.

### A browser half receives no cordis config

The boot manifest carries plugin names, not their `config` blocks — `BootPluginRow` is `{id, inject, immediately}` and `loader.create({ name })` is the whole browser entry call. A `Config` field the browser must obey therefore has to be **served** to it. The node half claims a second exact route, `/content-frame/settings`, answering `cacheSize` and the resolved `defaultPage`; the browser half reads it in `apply` before claiming the column and fails the row when it is unreachable or unusable. That keeps `cacheSize` a real configuration field instead of a constant, and keeps the per-session projection free of deployment-wide values.

### Two browser facts decide the whole cache design

Both kill an iframe's document without removing its element, and the column exists to prevent exactly that:

- **Blink detaches an iframe removed from the layout tree and reloads it on return.** The column therefore stacks its frames absolutely and hides the inactive ones with `visibility`, never `display: none`.
- **React moves a keyed child whose position among its siblings changes, and moving an iframe reloads it.** The rendered list is therefore append-only: entries keep their mount order for life, and recency lives in a separate `order` list that never reaches the DOM. Eviction deletes one entry, which leaves every survivor's relative position intact.

`foldFrames` is that fold as one pure function: a session active again moves only in `order`; a session active at a different page has its entry's URL replaced, so its frame navigates in place; and the active session is never the one evicted. The no-session state is an ordinary cache entry under the reserved key `''`, so the default page survives a round trip through a session too.

The component reads the current session and its projected value through `useSessions` — the root-scope standard hook, whose `SessionListState` already carries `current` and per-session `projectionValues`. No registrant-private observable, no hooks compartment: the framework hook is the first rung of the data-access ladder and it reaches everything this column needs.

## Alternatives considered

**Keep `content` at `session-maybe` and re-create the frame per session.** Rejected: it is the behavior this step exists to remove. Under adoption the hosted document dies on every switch after the first, so no amount of package-side care can keep a page's state.

**Resolve `defaultPage` in the browser from the page list.** Rejected because the browser has no page list — it has no config at all. Resolving in `wire.view` also means one resolution site for both the per-session and the never-shown states.

**Ride `cacheSize` and the default page on the projection value.** Rejected: they are deployment-wide constants, and every session's whole value would carry them. A projection is per-session state.

**Make `page` a schema `enum` of the configured ids.** Rejected because argument validation rejects before `execute` runs, and the resulting message is a schema error rather than this tool's catalogue. A self-correcting failure is worth one plain string parameter.

**Give the tool a `postMessage` reply channel so the agent learns what the user did in the page.** Rejected as a separate capability with its own protocol and versioning; the agent can put a page in front of the user, and that is the whole claim.

**Split the package into a host half and a client half.** Rejected for now — the two halves are defined against shared routes and one types module, and the package is registered in exactly one aggregate. See the consequence below.

## Consequences

The column is now a model-facing surface: `docs/tool-catalog.md` does not list `content_show` (the generator's completeness guard scans `packages/*/tool-*`, which this directory is not), so the package README's Model Experience section and the verbatim pins in `content-show-tool.client.spec.ts` are what hold the text.

`content` being `root`-scoped moves a cost onto every future occupant: the framework clears nothing on a session switch, so an occupant holding per-session component state must key it by session id itself. The other three columns keep their session scopes.

The package's node half now imports `dsh-tools`, `dsh-session`, and `dsh-session-projection` while its browser half imports the client runtime — two sides of the cordis `Context` merges in one package, which compiles only because referenced projects reach each other through declarations under `skipLibCheck`. Test files feel it directly: `ctx.sessions` resolves to the client `ISessions` there, so a spec needing the host store reaches it through `ctx.get('sessions')` with a cast. If this package grows more host code, the fix is the repository's ordinary shape — a host package plus a client package — not `api/remotes`' split tsconfigs, which `docs/development.md` forbids copying.

## Testing

`content-show-tool.client.spec.ts` runs the tool on a real `ToolRuntime` over a real `Session`: the three execution paths, what each writes to the log (an unknown id writes nothing), and the name, description, parameter schema, result texts, and failure message pinned verbatim. `content-projection.client.spec.ts` folds over a real registry: the initial and cleared states resolving to the default, last-wins across unrelated events, a retired id reading `missing`, and removal on fiber disposal. `frame-cache.client.spec.ts` pins the two DOM-preserving properties directly — mount order never changes, the active frame is never evicted — and `content-frame.client.spec.tsx` drives the component over a fake session feed to assert element identity across a switch and back.

`apps/web/tests/content-show.e2e.ts` seeds two sessions with different `content/shown` events and runs the real composition: each session restores its own page from its log, and returning to a session finds the same iframe element still holding the document it loaded once — stamped on both the element and its `contentWindow`, so a reload shows up as a lost mark rather than a lost element.
