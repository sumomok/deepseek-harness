# Agent Note: the component catalog is a registry component plugins fill

Status: implemented

English | [中文](2026-09-18-component-catalog-registry.zh.md)

## Problem

`show_component` chose from `COMPONENT_CATALOG`, a static table in `component-surface`'s `component-call.ts`. The table's own comment said what was wrong with it: "A static table rather than a registry service, because one package owns every entry… Replace it with a registered seam when a package this one does not own needs to contribute a component." Two such packages are already in view — `vue2-echarts-tool-poc` ships a `chart` kind with its own tool because it had nowhere to contribute a component, and a per-customer component library is the point of the surface — and a third, `component-kit`, already shipped the renderers for all six entries while the definitions that admit them lived in the package that places them.

The table also made "which components exist" a compile-time fact: `CatalogId` was derived from it, and the browser seat pinned `component-kit`'s renderer table against that union. The pin is what forced the dependency to run from the placement package to the component package, which is backwards from the direction a contribution travels.

## Decision

**The catalog is `ctx.componentCatalog`, a Service Definition owned by `component-surface`, and it starts empty.** A component plugin registers a batch of definitions with the package that wrote them; `register` returns a disposer, goes through `ctx.effect`, and refuses an id another package already registered by naming both packages and both versions. The contributing package's name and version are read from its own `package.json` at registration, so a version written beside the call cannot go stale. The service exposes the current catalog and a subscription, `onChange`.

**The change notification is a service subscription rather than a Cordis event.** A refusal has to travel: a reader that rejects the catalog a contribution makes is refusing that contribution, and a dispatched event contains its listeners' failures by design. `onChange(listener)` registers through `ctx.effect` on the calling context, so a watcher is released with its fiber; watchers are called in registration order, and the first to refuse stops the rest. It also keeps the repository's event vocabulary out of a Client-face package, whose dispatch sites the host-seeded doc gates cannot see at all.

**Every reader is handed a `ComponentCatalog` value rather than reading a module global.** `readCatalog(entries)` derives the id index and the depth ceiling once per change; `validate.ts`, `tool.ts`, `crud.ts`, `views.ts`, `surface.ts`, `command.ts`, `action-state.ts` and the browser's `spec.ts` all take it as a parameter. `trackCatalog(ctx, install, label)` rebuilds one registration per catalog version, which is what keeps the tool description, the content extractor and the gesture fold from answering out of a catalog that has moved under them.

**An empty offer is no offer.** The tool is registered only while the catalog holds a component this composition can honour, so a deployment composing no component plugin is offered no `show_component` at all rather than a description whose component list is empty.

**The browser has the matching registry, `ctx.componentRenderers`,** which takes the same definitions paired with the renderers that draw them and the contributing row's own translate. That inverts the package dependency: `component-surface` imports nothing of `component-kit` at runtime, and `component-kit` depends on `component-surface`. The renderer props contract moved with the registry, because it is what the placement package promises every component plugin; the three lines the seat draws in place of a block moved into the seat's own `contentComponent` dictionary, because which components exist is now the seat's lookup rather than any one package's table.

**`CatalogId` is branded.** There is no closed set of ids left to derive a union from, so the repo's rule for opaque cross-boundary ids applies: `Branded<'ComponentCatalogId'>` from `dsh-brand`, minted by `catalogId(id)`. `component-call.ts` gives up its "imports nothing" rule for exactly that one zero-dependency helper.

**The entry definitions stay in `component-surface` as an exported library, `COMPONENT_KIT_ENTRIES`, which `component-kit` registers on both halves.** Moving them into `component-kit` is the honest end state and the follow-up: the six definitions are interleaved with about 1200 lines of notice builders and schema constants in `component-call.ts`, and that module is the one both halves and the session fold read, so the move is a separate change with its own risk.

### Decision gate

| # | Question | Answer |
|---|---|---|
| 0 | Which standing principle already decides it | **A capability seam comprises Service Definition / Service Provider / Consumer roles; it is complete, never one role** (`AGENTS.md`). A catalog whose entries come from other packages is a Service Definition with providers; the static table was a Consumer holding the providers' data. The table's own comment had already named the trigger. |
| 1 | Count and list of new permanent surfaces | **Five.** `ctx.componentCatalog` (host Service Definition: `catalog`, `components`, `register`, `onChange`); `trackCatalog()`; `ctx.componentRenderers` (browser Service Definition: `catalog`, `rendererFor`, `register`); `ComponentRendererProps` / `ComponentRenderer` / `ComponentRendererTable` moved into `component-surface/client`; the `contentComponent` locale namespace. |
| 2 | Smallest version that proves it | `component-kit` registering its six on both halves, plus a composition that omits it and is offered no tool (`composition.client.spec.ts`, "offers no tool where no component plugin is composed"). Anything smaller — a registry only one package can fill, or a host-only registry — leaves the browser edge deciding which components exist and the package dependency running the wrong way. |
| 3 | Seam or hardcode, naming ≥2 real near-term variants | **Seam.** Three real contributors: `component-kit` (migrated here); `vue2-echarts-tool-poc`, which ships `show_chart` and a `chart` content kind because there was no catalog for it to contribute a `toy.chart` to — its definition would be one entry with one action and one renderer; and per-customer component libraries, which are the reason the content surface exists and which cannot be added to a table in this repository at all. |
| 4 | Six-direction boundary table | below |

| Direction | What is fixed | Named failure it prevents | Term |
|---|---|---|---|
| Who may contribute | Any package holding a Cordis context; no allowlist | A customer library that cannot be composed without editing this repository | 永久 |
| What a contribution carries | Definitions plus the contributing package's name and version, read from its own manifest | "Duplicate id" naming neither the row to remove nor the row that was there first; a version written beside the call going stale at the next release | 永久 |
| Id ownership | One package per id, first registration wins, second refused at registration | Two packages drawing different things under one id, decided by load order | 永久 |
| Host ⇄ browser | Both halves take the same definitions; the browser's carries no package identity | A page judging a payload against components it cannot draw, or a manifest read the browser has no way to perform | 永久 |
| When a reader sees a change | Each catalog-dependent registration is rebuilt per catalog version through `trackCatalog`, never read live | A description, a fold or an extractor answering out of whichever catalog happened to be in place when its first caller arrived | 永久 |
| Where a configured view is judged | On the first catalog that holds components, failing the contribution that completed it, with the whole refusal and its cost logged at error level by the row whose config is wrong | A menu row that shows an empty column, with nothing anywhere saying why | 暂缓 — revisit when the plugin system offers a load barrier that lets this row wait for every composed contributor, which would put the refusal back on the row whose config is wrong |

## Alternatives considered

**Keep the static table and let `component-kit` stay a renderer library.** Rejected: it is the arrangement whose own comment asked to be replaced, and it cannot admit the chart plugin or a customer library at all.

**Put the registry in a third package both rows depend on.** Rejected: it adds a package whose only content is one Service Definition, and the catalog is the placement package's fact — it is what `show_component` offers.

**Keep `component-surface → component-kit` and have only the host half register.** Not possible: the two packages share one TypeScript project each, so a contribution in either direction plus the existing renderer import is a project-reference cycle. The client edge had to go whichever half registered.

**Keep `CatalogId` as a derived union by having `component-kit` own the definitions and export their ids.** Rejected: it pins the union to one package again, which is the thing being removed, and any second contributor widens it at runtime regardless.

## Consequences

`snapshots/console/cordis.yml` now composes `component-kit`'s node half; without it the lane's `show_component` call answered `UNKNOWN_TOOL`. The fixtures are unchanged, which is the evidence that the six entries and their order survived the move.

A configured view whose spec the catalog refuses no longer fails the boot from this row's own `apply`. It fails the contribution that completed the catalog, that contribution is withdrawn, and the deployment comes up with no components, no views and no tool.

Every trace of that failure is otherwise an absence. Measured on the booted composition, no row reports a failed state, no fiber carries a visible error, and the tool list is empty — so this row logs the whole refusal at error level under its own name, with what the refusal cost, and rethrows. Cordis records the same rejection again for the same fiber, with a stack and no consequence. Neither reaches a terminal on a shipped composition: no profile in this repository composes `@deepseek-ai/cordis-plugin-logger-console`, so `ctx.logger` output is buffered and never printed. Both READMEs carry that as a Known Limitation.

`block.unsupported` is now reached only by a page holding a component's definition with no renderer for it, which the registration API does not produce; the reachable case for a payload naming an unregistered component is the whole entry refused, because the seat runs the host's judgement against the catalog it actually has.

`component-kit` keeps `component-surface` as a devDependency for the seat specs that draw the real renderers, which is a development-only cycle; the runtime edge runs one way.
