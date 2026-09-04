# @deepseek-ai/dsh-experimental-component-surface

English | [中文](README.zh.md)

`show_component`: the agent places a block of interface — a prompt with a row of buttons, today — in the content panel beside the conversation, chosen from a catalog this package owns and judged against that catalog before anything is drawn.

The package is both halves. The host half offers the tool, validates each call, and claims the `component` kind of the [content surface](../content-surface/README.md)'s entry stream; the browser half claims the `component` key of the content column's `content.surface.kind` slot and draws each entry's spec. Neither half owns a component: the renderers come from [`component-kit`](../component-kit/README.md), which knows no layout, and this package is what puts one of its blocks in a column.

Nothing here appends a session event. A call's record is the `tool/call` the loop already writes, so what the panel shows replays from the log the agent actually wrote, and removing this row leaves every past session readable.

## Composition

[`overlay/component-surface.patch.yml`](overlay/component-surface.patch.yml) inserts this row and the component row over the service-line console composition, which already carries the content surface and the content column. The overlay's own comments carry the launch line.

The row activates in two independent pieces. The tool needs a tool runtime and nothing else, so a composition with no content column still offers it and still records its calls. The extractor needs the content-surface router; without it the calls are in the log and no column reads them, which is exactly what a composition growing a column later wants.

## Configuration

None. The three numbers a deployment might want to move — the spec byte ceiling, the node ceiling, and the nesting ceiling — are enforced twice: here, and again by the browser seat over the value that arrives on the wire. The seat receives no Cordis configuration, so a per-deployment ceiling would be a ceiling the two halves disagree on: a block silently missing from the column rather than a refusal the model can act on. They are protocol constants in [`src/component-call.ts`](src/component-call.ts) until the seat can read a deployment's settings, at which point the ceilings and the route that serves them arrive together. The nesting ceiling is not written down even there: it is measured off the catalog, so a component declaring a nested property widens it by exactly what that property needs and no legal document is refused as malformed.

## The catalog

One tool for every component, rather than one tool per component. Which blocks exist is a deployment's catalog, and a catalog is cheaper to state once inside a description than to spread across a growing tool list the model reads on every request. The catalog is a static table in `component-call.ts`; replace it with a registered seam when a package this one does not own needs to contribute a component.

Today it holds one entry, `el.confirm-bar` — 确认条 — an optional title, an optional message, and one to five buttons each carrying an id, a label, and an optional tone.

A component's properties are declared as a small schema of four shapes: a bounded string (optionally restricted to an alphabet), a fixed set of strings, a record of further declared properties, and a bounded list of identified records. That union is the security boundary rather than a convenience, for the reason the trust section below states.

## What a call is judged against

In order, and each step can end the call: the entry `id` and the `title`; the spec's nesting depth; its size in bytes; the properties a spec and a node may carry at all; every node's id, its uniqueness within the call, and the component it names; and finally every property of that component.

Depth is measured before size because both walk the document and only the depth walk is bounded by construction — it stops at the ceiling rather than at the bottom of the value.

Every refusal names the offending parameter path, because that path is the only channel the model has: a call carrying eight nodes gets one sentence back, and unless the sentence says `spec.nodes[3].props.buttons[1].id` the next call is a guess. A call naming a component the deployment does not have gets the whole catalog back rather than a count, so the correction needs no extra round trip.

## One entry, several calls

A call owns the entry its `id` names, written in the same alphabet as a node id — letters, digits, underscores and hyphens. Calling again with the same id replaces what that entry shows — both calls stay in the transcript, because the log is what happened, but the column shows one block under one tab in its switcher strip. A different id adds a second entry beside it.

The fold recognizes both shapes a call takes in the log: a top-level `tool/call`, whose `arguments` is raw JSON, and a Code Mode `tool/code-dispatch-start`, whose `arguments` is already decoded. A model reaching the tool through `run_code` logs only the second.

A call the tool refused is still in the log — the loop records the call, not its outcome — and the extractor runs the same judgement over it, so a refused call records no entry rather than an entry the seat has nothing to draw.

Resolving a stored record consults no catalog. The catalog is a build-time table that grows and changes, a persisted checkpoint written before a component was renamed must still resolve, and it is the seat — which knows which renderers it actually has — that reports a block it cannot draw. What resolving does check is that the record carries the two fields it reads. A checkpoint is plain JSON whose declared type is a claim, and one throw there would cost the column not this entry but every kind's entries at once, so a record this build cannot read resolves into an entry the seat draws its notice for.

## Trust

`spec` is model output that becomes a rendered block inside the shell's own origin. It is bounded rather than trusted, and the bound is the property schema rather than a sanitizer: there is no member of that schema union which can express markup, a function body, or a URL, so there is no such value for a later pass to have to recognize. A property the component does not declare is refused outright rather than dropped, so a model writing `onClick` learns that it did.

The browser seat re-runs the identical judgement over the payload arriving on the wire, which is why the catalog and the validator sit in modules of their own that import nothing but each other: the seat reads them without pulling a tool runtime into a page, and the two halves cannot drift onto different rules.

## The seat

The browser half is one keyed registration: `component` of `content.surface.kind`, the content column's open key domain. The seat draws the entry's title over the blocks the call placed, stacked in the order it wrote them, and draws nothing while another kind holds the column, which reaches it as no entry at all. What `visibility` keeps mounted there is the column's wrapper for the kind, not the blocks, whose DOM goes with the draw.

Before drawing, the seat runs the call's own judgement over the payload again. That is not distrust of the host it ships with: an entry's payload can arrive from a persisted checkpoint written by a composition whose catalog and ceilings were not this build's, so the type it comes with is a claim. The check is the same import-free module the tool judged the call with, which is why that module imports nothing. A payload this build does not accept becomes one sentence in the column instead of blocks.

Each block is memoized on its own identity — its entry, that entry's owning sequence, and the node — so a redraw elsewhere in the stack leaves a block holding the props it already had. The renderer comes from the component row's table by the catalog id the node names; a table with no entry for it says so in that block's place, which is what a deployment composing a mismatched row sees.

The seat carries no dictionary. It translates through `componentKit`, the component row's namespace, because the sentence shown in place of a block belongs with the components rather than with the package that placed them.

## Model Experience

### The `show_component` offer

#### What the model sees

One tool, `show_component`, with a required `id` string, a required `title` string, and a required `spec` object whose `nodes` array is required. The description carries the whole catalog as one `- id — label — purpose` line per component, the reuse rule for `id`, the node and byte ceilings, the refusal rule for undeclared properties, and the sentence that keeps a model from waiting on a block: what the user does with it does not come back. The component labels in that list are the Chinese names the end user reads, so a model naming a block in conversation names it the way the user sees it. This package contributes no system-prompt section.

#### Token effect

One fixed description plus the parameter schema, on every request where the tool is visible. The description grows by one line per catalog entry; the `spec` schema stays shallow — one object with one array — because the per-component shape is in the catalog lines rather than in a nested JSON Schema.

#### KV Cache effect

The description is assembled once when the row loads and depends on nothing but the catalog, so the tool block is byte-identical across every request in a deployment and the prefix holds.

### Tool-call result

#### What the model sees

An accepted call answers `Now showing "<title>" in the content panel: <labels>.` followed by the sentence naming the id to reuse. A refused call answers `Error: show_component: <path> — <what is wrong and what to send instead>`, and for an unknown component the whole catalog again.

#### Token effect

One short line per call. A refusal naming an unknown component is longer by the length of the catalog, which is the point: it replaces a second failed call.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

## Known Limitations and Deferred Work

- **Nothing comes back from the block** — a button the user presses reaches no agent. The tool description says so, so the model asks in the conversation instead; the return channel (a command carrying the action, and the three delivery grades it is dispatched under) is designed but not built.
- **The model cannot see what the panel holds** — there is no read path. The agent knows which calls it made, not which entry the user is looking at, whether one was dismissed, or what any block currently shows.
- **No layout and no binding between blocks** — a spec is a flat list of nodes drawn top to bottom. There is no row/column tree, no width, and no way for one block's state to feed another's properties.
- **One catalog entry** — `el.confirm-bar`. The mapping from a real component library to catalog entries, and the packaging that gets those components into a browser bundle, are separate work.
- **No block survives being unselected** — the seat draws the selected entry alone and nothing at all while another kind holds the column, so switching kinds, or switching between two `component` entries, discards whatever the user had typed into the blocks that were on display.
- **An entry this build cannot fully accept shows nothing at all** — the seat re-judges the whole payload, so one node naming a component this catalog no longer carries costs the entry every block it could have drawn, not just that one.
- **The ceilings are protocol constants, not configuration** — the configuration section above states why, and what has to exist before they can become a deployment's choice.
- **A stored entry carries its whole spec** — the column's projection keeps the validated spec per live entry, so it rides the wire value and the persisted checkpoint. The byte ceiling is what bounds it.
- **The invariant reports through the dispatch path only** — `Session.append` reports a throwing listener to the logger and carries on, so the live audit reaches a caller only where a committed event is dispatched through the context. The startup audit over loaded sessions is unaffected.
- **The switcher strip labels this kind in English** — every tab of this kind carries a `COMPONENT` badge beside its title, a technical term in front of an end user. The badge is drawn by [`content-column`](../content-column/README.md) rather than here, and the decision already taken is to remove it for every kind at once; this row left it alone.
- **The drawn block is not covered by an assembled snapshot** — the tool's whole model-visible surface, the catalog spliced into its description and the result line included, is pinned by the [`examples/content-console`](../../../examples/content-console/README.md) lane, which composes this row for real and runs a call end to end. What the seat then draws is a Playwright scenario against a real console composition.
