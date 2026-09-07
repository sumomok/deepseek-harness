# Agent Note: putting a block of interface in the content column — the component library's first slice

Status: implemented

English | [中文](2026-09-04-content-component-library-v0.zh.md)

## Problem

The service-line console's content column can already show two things: a page in an iframe, and a chart. Both arrived as one package each, and each package owns the whole path from a tool the model calls to the React that draws it. What the console actually needs is a third thing that is not a third one-off — a way for the agent to put a *piece of interface* in front of the user, a confirmation bar today and a filter row, a metric, a record view later, without a new tool, a new content kind, a new session event, and a new seat every time.

Three constraints made that harder than "add another package".

- **A block is model output that becomes markup inside the shell's own origin.** A design that lets a model write a property whose value is markup, a function body, or a URL has to sanitize it somewhere, and every sanitizer is a list of what somebody thought of.
- **The browser half receives no Cordis configuration.** Whatever the host judges a call against, the seat must be able to judge the same document by, over a payload that reached it through a persisted checkpoint another composition may have written.
- **Every experimental row in this repository was uncovered by an assembled snapshot.** The seven of them all carried the same Known Limitation sentence, and the snapshot lanes replay the shipped composition, which composes no experimental row. A new model-visible tool description without a keyless snapshot is against the repo's own rule, so the lane had to exist before the tool could ship.

## Decision

**Three layers, two packages, and the split is between what a block looks like and where it lands.** `@deepseek-ai/dsh-experimental-component-kit` is the component row: React renderers, their copy, and the table that names them. It declares no slot, knows no column, reads no configuration, and its node half is an empty plugin — so the whole package is portable to any surface that wants to draw a block. `@deepseek-ai/dsh-experimental-component-surface` is the placement package: the `show_component` tool, the catalog every call is judged against, the `component` extractor, and the seat that claims the column's `component` kind. The seat reaches the renderer table through the loader's module table (`dsh.client.external`), which is what keeps one copy of the components in the page.

**One tool for every component, not one tool per component.** Which blocks a deployment offers is its catalog, and `describeCatalog()` splices the catalog into the tool description. A growing tool list is read by the model on every request; a catalog inside one description is read once. `show_component` takes three parameters — `id` (the entry the call owns), `title` (the phrase the user reads in the switcher strip), and `spec` (`{ nodes: [{ id, component, props }] }`).

**The property schema is the security boundary, and it is a type rather than a sanitizer.** `PropsFieldSchema` is a closed union of bounded string, enumeration, record, and identified list. There is no member that can express rich text, a function body, or a URL — so a model cannot write one into a block's properties and no later pass has to recognize one. The alternative this replaces is the concrete failure it prevents: the source library this catalog is eventually meant to cover already ships a table renderer that evaluates a `formatter` string.

**Nothing appends a session event.** Both log shapes that already record a tool call count: a top-level `tool/call` whose `arguments` is raw JSON, and a Code Mode `tool/code-dispatch-start` whose `arguments` is already decoded. Reading only one would leave a session that reached the tool through `run_code` with no entries at all. The consequence of the double read is that removing this row leaves every past session readable, and `SESSION_FORMAT_VERSION` does not move.

**Judgement lives in two modules that import nothing but each other, and both halves run it.** `component-call.ts` (zero imports) holds the catalog, the tool name, the kind, and the ceilings; `validate.ts` imports only it. The host judges a call before answering the model; the extractor judges each *recorded* call so a refused call never becomes an entry the seat cannot draw; and the seat judges the payload again at the wire edge, because an entry can arrive from a checkpoint written by a build whose catalog was not this one. `validateField`'s exhaustiveness check is a local `never` assignment rather than `dsh-llm`'s `assertNever`, because this module is compiled into a browser bundle and must not pull the LLM package into a page.

**The ceilings are protocol constants, not `Config`.** Both halves enforce them and only one half can be configured, so a per-deployment ceiling is a ceiling the two halves disagree on — which shows up as a block silently missing from the column instead of a refusal the model can act on. They become configurable the day the seat can read a deployment's settings, and the ceilings and the route that serves them arrive together. The nesting ceiling is not a written number even now: `maxSpecDepthOf` measures it off the catalog, so a component declaring a nested property widens it by exactly what that property needs instead of having its own legal documents refused as malformed.

**The seat is keyed and additive.** `content.surface.kind` is an open keyed slot; claiming `component` leaves every other kind's seat exactly as it was. The key is written as the literal `'component'` at the registration because the client-slot catalog generator scans for literal keys. `entry === undefined` renders `null`, matching the chart seat; what the column keeps mounted under `visibility` is its own wrapper for the kind, not the blocks, so being unselected costs a block its DOM and everything typed into it.

**The renderer contract is four props and no context.** `nodeId`, the already-validated `props`, `onAction(actionId, nodeId)`, and the row's `t`. A renderer holds no ctx, subscribes to nothing, and performs no navigation, no request, and no write. `COMPONENT_RENDERERS` is a plain object with literal keys and `COMPONENT_CATALOG` is `as const`, so `CatalogId` is derived from the catalog and the seat's `satisfies Record<CatalogId, ComponentRenderer>` turns "a catalog entry with no renderer" into a compile error instead of a blank block. Deriving the union is the load-bearing half: a union restated by hand beside the catalog pins the renderer table against a literal that nobody widens when the catalog grows, so the check would pass while the seat drew a blank block. `renderer-coverage.client.spec.ts` holds the mechanism down with a `@ts-expect-error` over a catalog one entry ahead of the row.

**`onAction` exists and goes nowhere.** The return channel is the next slice; the seat passes a named sink, the tool description tells the model in as many words that what the user does with a block does not come back, and both READMEs record it. Declaring the prop now rather than later means the renderers do not change shape when the channel arrives — only the seat's sink does.

**One dictionary namespace, owned by the component row.** The seat translates through `componentKit` and has none of its own, naming it at its own registration. Which components exist is the row's fact, so the sentence shown in place of one it does not have belongs with the components; and `locale:` accepts one namespace per registration anyway.

**The invariant companion audits derived data against the log.** Every `kind: 'component'` record in the `contentSurface` fold must correspond to an accepted `show_component` call in that session's own log, counted by the same reader the extractor uses. The relationship is real in both directions: the content surface decides whether a persisted checkpoint still applies by hashing its extractor table into 31 bits (its own README records the collision as residual risk), and its registry admits two extractors claiming one kind, so a second producer of `component` entries is composable. The audit runs at startup over loaded sessions and again on each committed event that arrives through `internal/dispatch` — not through `sessionProjections.onChanged`, because `Session.append` turns a throwing listener into a `logger.warn` and the failure would never reach the caller.

**The snapshot gap is closed, not documented.** `snapshots/console` is the console's own snapshot lane: the console's backend spine under the ACP automation transport, composing exactly the rows a recorded transcript can observe — the adapter, the ACP app, the projection registry, `content-surface`, `host-webserver`, and the two tools that place an entry in the column. The four browser-only rows are absent by construction, and the spine's own skill, goal, and background-job tools are switched off so an upstream edit to *their* descriptions cannot churn this lane's pinned header. Two scenarios share one header class; `show-chart-turn` pins it, so `tool-schemas.expected.json` now carries both tools whole — every description, the ceilings and the catalog quoted into them, and every parameter description.

### The gate table, as built

| Cell | Content |
|---|---|
| **0 — which settled principle already said no** | "Model-visible ⟺ logged" ruled out a block fetching its own data and handing it to the model. "Upstream zero-change" ruled out touching `agent-loop`. "Explicit > implicit" ruled out `?? defaultComponent`: the component id is required, and an unknown one is refused with the whole catalog in the refusal. "One event, one kind, first recognizer wins, no detection" ruled out five kinds for five components. |
| **1 — new things touched: 5** = 1 + 1 + 1 + 0 + 0 + 0 + 0 + 1 | data source **1** (the tool's `spec` argument); UI surface **1** (the `component` seat); tool or parameter **1** (`show_component`, three parameters); route or RPC **0**; `Config` field **0** (the two halves must agree on one set of ceilings and only one of them can be configured, see above); event type **0** (two existing shapes are read); approval gate **0**; dependency **1** (the component row's `/client` module request). |
| **2 — smallest version that proves it** | One in-repository `.tsx` confirmation bar placed through `show_component`, appearing in the column and on the switcher strip under a title the model wrote. Zero Vue, zero element-ui, zero vendored tarball. |
| **3 — seam or hard-coded** | **Seam: `COMPONENT_CATALOG`**, because two near-term changes are real, not hypothetical — the first batch grows from one entry to several, and the catalog is meant to cover a source library that has no version history, so a change there means an entry added or removed. **Hard-coded**: the kind name `'component'`, the spec field name `nodes`, and the fact that the catalog is a static table rather than a registered service. "An outside package contributes a component" is a supposition, not an instance; the review trigger is written into the table's own JSDoc. |
| **4 — one line per direction** | *Neighbours*: the tool knows the catalog and nothing else — not the column, not the sidebar, not any backend. Guards against the tool becoming a second thirty-seven-property universal entry point. *Contract*: `resolve()` is synchronous and pure; `read()` recognizes both recorded call shapes. Guards against a Code Mode session showing no entries at all. *Temptation*: `propsSchema` cannot express markup, a function body, or a cross-origin URL at the type level. Guards against a model-authored formatter string being evaluated in the shell's own origin. *Red line*: `component-call.ts` imports nothing, and the host half never imports a component or element-ui — that library reads `document` at module scope, so a host-side import is a `ReferenceError`. *Ceiling*: two entries of one kind are not shown side by side; the column shows one entry at a time, and changing that is the column's decision, deferred until the product asks for a split view. |

## Alternatives considered

**A separate catalog package the two halves both depend on.** Rejected: the catalog, the ceilings, and the validator are one decision, and splitting them across a package boundary buys a third `package.json`, a third build, and a third version to keep in step — while the thing it would prevent (the two halves judging by different rules) is prevented instead by the modules importing nothing, which makes them safe to compile into either half from one source.

**Publishing the catalog and validator as subpath exports.** Built that way first, then removed: the only reader is the seat *inside the same package*, which imports them relatively. Keeping the subpaths would have published the whole `lib/types/**/*.js` tsc tree, whose emitted `ComponentSurface.js` imports a CSS module that is not published — a real `publint` failure, caused by an export that had no consumer. Bring them back when a package this one does not own needs to judge a spec.

**A session event of this package's own.** Rejected: the readers of such an event number zero, `tool/call` already records the arguments verbatim, and a new `SessionEventMap` member is a compatibility obligation on every build that reads a log. Nor could such an event be made optional to read: `ignorable` is not part of the envelope `Session.append` constructs for a non-surface event.

**One content kind per component.** Rejected: the column's kind registry admits one seat per key, and five components would mean five seats, five extractors, and five entries competing for the same column. One kind whose payload names a component is the same expressiveness with one seat.

**Making the confirmation bar a Vue component behind the existing bridge.** Rejected for this slice: it puts the first end-to-end proof of the tool → event → extractor → projection → seat path behind a Vue shim, an element-ui inlining, and a vendored tarball, each an independent way to fail. The `.tsx` bar proves the path with none of them, and the Vue half is a later slice whose two blocking experiments are still unrun.

**A registry service for renderers instead of a static table.** Rejected: one package owns every entry, and a static table with literal keys is what makes the consumer's `satisfies` a compile-time check. A service would move the same failure to runtime and show the user a blank block.

**Leaving the assembled-snapshot gap documented.** Rejected: the design itself made closing it the first task of this slice, precisely so that "no lane exists" could not quietly become the reason a model-visible tool description shipped unpinned.

## Consequences

**Evidence this slice actually produced.**

| Claim | Evidence |
|---|---|
| The model is offered the tool, its catalog, and its ceilings verbatim | `snapshots/console/show-chart-turn/tool-schemas.expected.json` — both tools' complete schemas, pinned for both scenarios |
| A call executes and the model reads back what it placed | `snapshots/show-component-turn/session.jsonl` — the recorded `tool/call` arguments and the `tool/result` line naming the entry id and the component's label |
| The composed prompt is what the console assembles | `snapshots/show-chart-turn/system-prompt.expected.md` — persona plus `content-surface`'s on-display section |
| A refusal names the offending parameter path | `packages/experimental/component-surface/tests/validate.client.spec.ts` — a refusal per ceiling, an unknown component id whose refusal carries the whole catalog, and an undeclared property named by path |
| The path runs end to end in a real browser | `apps/web/tests/component-surface.e2e.ts` — four assertions over a real chromium against a real console composition; screenshots under `.artifacts/` |
| Three calls under two ids fold to two entries, the later owning its id | the same scenario's second assertion: two switcher tabs, the superseded draft's title nowhere on the page |
| Switching entries redraws the one seat | the same scenario's third assertion |
| Per-file coverage | 100% statements / branches / functions / lines on every file of both packages |

**A new experimental package now costs a fixed registration list.** `tsconfig.base.json` paths (three entries, spelled out — the `@deepseek-ai/dsh-*` wildcard does not reach an `experimental` directory name), `tsconfig.client.json` references and the CSS-module declaration, the package's own `tsconfig.json` extending the client base, `tsdown.config.ts`, a real `src/invariant.ts`, two READMEs plus the pairing record, `packages/experimental/README.md` in both languages, and `pnpm install`. A new `apps/web` e2e additionally needs one line in `tsconfig.host.json`'s `include` and one in `apps/web/tsconfig.json`'s `exclude`.

**Two packages moved out of the "not covered by an assembled snapshot" column.** `content-surface`'s prompt section and `vue2-echarts-tool-poc`'s whole model-visible surface are now pinned by `snapshots/console`. Their Known Limitations were rewritten to say what remains uncovered — what a browser paints — rather than repeating a sentence that is no longer true. The other five experimental packages keep the sentence, correctly.

**`component-surface` publishes a hashed shared chunk.** The tool entry and the invariant companion judge a call with the same catalog and validator, so tsdown emits `lib/validate-*.js` for both. The manifest's `files` and the workspace-constraints allow-list both name it, following `dsh-sandbox-windows-acl`'s precedent. If the shared module set changes, the chunk is renamed and the built-package-invariant gate goes red — which is the right failure, provided the next reader recognizes it.

**Known Limitations, carried in both packages' READMEs.**

- A pressed button reaches nothing. The seat's action sink discards it.
- The catalog holds one entry. Mapping a real component library into catalog entries, and bundling those components into a browser artifact, is later work.
- No block survives being unselected. What the column keeps mounted is its own wrapper for the kind, not the blocks, so switching to another `component` entry and switching to another kind both cost a block its DOM and everything typed into it.
- An entry this build cannot fully accept is drawn as one notice rather than degrading block by block: the seat re-judges the whole spec, so one node naming a component this catalog no longer carries takes the drawable blocks with it. Per-block degradation needs a structure-only entry point in `validate.ts`.
- The ceilings are protocol constants, not deployment choices.
- One entry carries its whole spec, so it travels with the live value and the persisted checkpoint; the byte ceiling is what bounds it.
- The invariant reports only along the dispatch path, for the reason above.
- The switcher strip still shows an English kind badge beside each title (`COMPONENT`). Removing it is a one-line deletion in `content-column`, out of this slice's scope.

**Six decisions the design left open, and this slice did not take.** Whether the first real batch includes components from the source library or stays in-repository `.tsx`; whether a host-side query tool is the better route to the same data; whether the column's business blocks stay light-themed and Chinese; whether the bundle size of a full component set is acceptable; the two user-facing terminology violations (the kind badge, and the collapsed context-injection row's header); and whether the advanced query-condition component belongs in the first batch. Each is a product call, and none of them blocks the path this slice proved.
