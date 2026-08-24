# Agent Note: One content column, many producers — an entry stream instead of a seat

Status: implemented

English | [中文](2026-08-24-content-surface-router.zh.md)

## Problem

The service-line shell declares `content` as a `single`, `root` slot: exactly one registration ever occupies it. Two packages already wanted it. [`content-frame`](../../../../packages/experimental/content-frame/README.md) claimed it for a hosted application, and the retired `vue2-echarts-content-poc` claimed it for a chart panel; the two overlays that composed them said so in their comments — "the two placements are alternatives" — and a deployment had to pick one.

Picking one is the wrong shape for what the column is. The field evidence came from the chart tool: a session draws several charts, redraws one of them, and the transcript already knows how to say that the older call was superseded. The column had no way to express any of it. It could show *a* chart, chosen by whoever registered first, with no way to reach the others and no way to reach a page at the same time.

## Decision

The column is a per-session **stream of typed content entries**, and the seat is a router.

[`content-surface`](../../../../packages/experimental/content-surface/README.md) is the host half. `ctx.contentSurface.register(extractor)` takes one kind's whole contribution — which committed events it recognizes, what identifies the entry each one records, and how a stored record resolves into a title and a payload — and the router folds every registered extractor into one session projection, `contentSurface`, publishing `{ kind, entryId, seq, title, payload }` per live entry, newest first. [`content-column`](../../../../packages/experimental/content-column/README.md) is the browser half: it claims `content` and declares one child, `content.surface.kind`, keyed by the entry's kind, root-scoped, owner share `{ sessionId, entry }`. The two are always composed together; the split is a toolchain constraint recorded below, not a seam.

**No new session event.** Every entry is derived from a fact another package already logs — `content/shown` for a page, a `show_chart` call for a chart — so the whole column replays from the log the agent actually wrote, and adding a kind adds no durable format.

**One record per `(kind, entryId)`.** A later record naming the same pair replaces the earlier one in the fold, so a redrawn chart and a re-shown page are each one row rather than two. That is the supersede rule the transcript already applies, read from the same events through the same reader.

**Latest wins, with a switcher.** The column shows `entries[0]` until the user picks another from a strip listing the session's entries newest first. The choice is UI-local: component state keyed by session id, defaulting to the newest, falling back to the newest when the entry it named is replaced, and never logged.

### Registration timing, against what the projection registry actually does

The projection registry (`packages/session/session-projection`) fixes a unit's `apply`, `view`, and `stateVersion` at registration, caches one folded cell per `Session` in a `WeakMap`, and never revisits a cell it has built. A router holding one long-lived unit whose fold read a live extractor table would therefore be silently wrong: every session with an existing cell would permanently lack the history of any kind registered after it, and a persisted checkpoint written under one set of kinds would be forward-applied under another.

So the registry registers a **new unit for every table change**. Dropping the old registration drops its cells with it (`refs` reaches zero and the entry leaves the map), and each session's next touch refolds `init` over its whole in-memory log through the new table — the registry's own documented lazy-build path. `stateVersion` is derived from the table for the durable side of the same problem: the sorted `kind@dataVersion` list hashed into 31 bits, so a composition change discards checkpoint rows instead of forward-applying them.

The residual cost is push latency, not correctness: the registry publishes a changed value only while driving an event, so a browser already connected when a kind row is hot-loaded reads the previous stream until that session's next event. Boot-time composition never reaches this.

### One surface, two packages

Typert's host face builds one program per batch of discovered packages, rooted at every member's whole tsconfig file list. A package whose host entry declares a Cordis service is discovered on the host face; if that same package also has a `src/client` reaching the client runtime, both faces' `TypertContextMap` merges land in one program and the generator fails on a duplicated key (`agent`, declared by both `packages/core/agent` and `packages/client/runtime/src/client`). Every dual-face package in the tree avoids this by having no host surface (`content-frame`, `server-layout`, the `ui-*` rows) or no client-runtime reach (`client-modules`); a content router with a service and a column has both.

`packages/AGENTS.md` forbids splitting one package's tsconfig into faces, so the split is by package instead: the service, the extractor contract, the projection, and the shared types in `content-surface`; the column, its slot declaration, and its copy in `content-column`, which type-imports `@deepseek-ai/dsh-experimental-content-surface/types`. Nothing about the design moved — every overlay composes both rows, and a kind's package depends on both.

### Kind renderers stay mounted

`content.surface.kind` is root-scoped and the column keeps **every** seat it has ever seen mounted, hiding the unselected ones with `visibility`. A renderer may hold DOM the column must not destroy — content-frame's live iframes are the case this was built around — and unmounting the page seat while a chart is selected would reload every one of them. The seat list is append-only for the same reason a frame list is: React moves a keyed child whose position changes, and moving an iframe reloads it.

### The chart panel package is gone

`vue2-echarts-content-poc` existed only to place a static demo panel in the column. Its whole reason was that the column took one occupant; with the column routed by kind, the same components reach it through `vue2-echarts-tool-poc`'s `chart` kind, drawing the session's real charts instead of seeded demo data. The package, its overlay, and its e2e are deleted rather than deprecated (pre-release stance). `ChartPanel` and `EChartsBar` stay in the component row with their specs and no placement.

## Alternatives considered

**Give content-frame a `page` kind but no router — one package owning `content` and a `component` child slot inside it.** Rejected: it makes the column's routing content-frame's business, so a deployment wanting charts in the column has to compose a hosted-application package it does not want, and the chart package has to know content-frame's slot key. The seam belongs to whoever owns the seat, not to the first occupant.

**Tabs with pinning, two entries side by side.** Rejected for now as a second mechanism on top of an unproven first one. Latest-wins plus a switcher is what the field evidence asked for; a pin is a durable per-user preference, which is a logged fact the column deliberately does not have yet.

**A global surface rather than a per-session one.** Rejected: every producer's data is per-session (a page a session showed, a chart a session drew), and the column already sits beside a per-session conversation. A global surface would have to invent a merge rule across sessions and would make a session switch change nothing, which is the opposite of what the column is for.

**One package with both halves.** Rejected against the analyzer, not the design: see "One surface, two packages" above. The alternative inside one package was splitting its tsconfig into host and client projects, which `packages/AGENTS.md` reserves for `api/remotes` and which would also put the shared `src/types.ts` in two programs.

**Read a live extractor table inside one long-lived projection unit.** Rejected against the registry's semantics above: it drops history silently, which is the one failure mode worth spending a re-registration on.

**Derive entries in the browser from each kind's own projection, with no host registry.** Rejected: the client would need a table of "which projection key means what", which is the same registry one layer later, and it would make every kind's wire value a public dependency of the column instead of the kind's own business.

**Client-side keepalive owned by the router (one seat per entry, not per kind).** Rejected: it would move content-frame's hard-won frame-cache rules — LRU bound, active never evicted, append-only order — into a package that knows nothing about what a frame costs, and would mount one renderer per entry where a kind may want one engine for all of them.

## Consequences

The column's occupancy changed, and so did one user-visible behavior: **content-frame's `defaultPage` no longer shows in the column.** The column lists what a session produced, and a default page is not something a session produced, so a session that has shown nothing gets the empty-state notice. `defaultPage` survives as a value of content-frame's `content` projection, which now has no in-tree consumer — the one place the resolved current page is still published.

content-frame's frame cache is now keyed by `(session, page)` rather than by session: two pages of one session are two live frames, and `cacheSize` counts pairs. The settings document lost its `defaultPage` field, since the browser half no longer has a no-session state to fill.

A chart entry carries its whole option document, because a chart call is self-contained and the column must be able to draw one without reaching into the conversation it sits in. That option rides the projection state, the wire value, and the persisted checkpoint; `maxOptionBytes` is what bounds it.

The switcher badges the raw kind key (`page`, `chart`) beside each title. The router cannot localize a name for a kind it does not know, and no per-kind label contribution exists; the surrounding product copy is Chinese while the badge is not.

Three overlays now compose the column: content-frame's `content-column.patch.yml` (shell + router + hosted application), the tool package's `show-chart-three-column.patch.yml` (shell + router + charts, no hosted application, so the `page` kind never occurs), and content-surface's own `full-surface.patch.yml` (everything at once).

## Testing

`packages/experimental/content-surface/tests/registry.spec.ts` drives the registry over real sessions and a real projection registry: what a table publishes, one entry per id, a late extractor recovering the history it should have found, a disposed extractor taking its entries with it, the whole projection leaving with the plugin, an assembly with no projection registry, and a `stateVersion` that moves when a kind joins, leaves, or changes its stored shape. `projection.spec.ts` covers the unit directly with a record whose kind has left the table — what a stale checkpoint would look like if one ever reached the fold. `content-column`'s `surface-seats.client.spec.ts` covers the append-only seat list and the selection fallback; `content-surface.client.spec.tsx` covers the strip, the per-session choice, the seat that stays mounted across a kind switch, and the notice for an unregistered kind; `browser-plugin.client.spec.ts` drives the column's registration against the real `SlotRegistry`.

Both kinds are proven in their own packages and in real compositions: `page-extractor.client.spec.ts` and `chart-extractor.client.spec.ts` for what each recognizes, and each package's Loader-booted route spec now mounts the router so the extractor children actually activate and the published entries are asserted.

`apps/web/tests/content-surface.e2e.ts` boots the full-surface overlay over a session carrying a shown page, a redrawn chart, and a second chart. It asserts three switcher entries for four logged calls, the newest chart painted as a sized canvas, and the keepalive proof no unit test can give: the hosted iframe is the SAME element after a chart takes the column and gives it back, and after a second session's own stream comes and goes. `content-frame.e2e.ts` and `content-show.e2e.ts` cover the page kind's geometry, its document, and its per-session frames; `show-chart.e2e.ts` covers the chart kind under both shells.
