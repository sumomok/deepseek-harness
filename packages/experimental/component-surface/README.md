# @deepseek-ai/dsh-experimental-component-surface

English | [中文](README.zh.md)

`show_component`: the agent places a block of interface — a prompt with a row of buttons, today — in the content panel beside the conversation, chosen from a catalog this package owns and judged against that catalog before anything is drawn.

The package is both halves. The host half offers the tool, validates each call, and claims the `component` kind of the [content surface](../content-surface/README.md)'s entry stream; the browser half claims the `component` key of the content column's `content.surface.kind` slot and draws each entry's spec. Neither half owns a component: the renderers come from [`component-kit`](../component-kit/README.md), which knows no layout, and this package is what puts one of its blocks in a column.

What the user then does inside a block comes back the other way, through one command this row owns: `/component-action`.

Nothing here appends a session event. A call's record is the `tool/call` the loop already writes and an action's is the `command/run` the command registry already writes, so both directions replay from the log the agent actually wrote, and removing this row leaves every past session readable.

## Composition

[`overlay/component-surface.patch.yml`](overlay/component-surface.patch.yml) inserts this row and the component row over the service-line console composition, which already carries the content surface and the content column. The overlay's own comments carry the launch line.

The row activates in three independent pieces. The tool needs a tool runtime and nothing else, so a composition with no content column still offers it and still records its calls. The extractor needs the content-surface router; without it the calls are in the log and no column reads them, which is exactly what a composition growing a column later wants. The return channel needs all three of the command registry, that router, and the projection registry the entry is read out of — with no column there is nothing on screen for an action to name, so the command is absent rather than answering every gesture with a refusal.

## Configuration

None. The numbers a deployment might want to move — the spec byte ceiling, the node ceiling, the nesting ceiling, the action byte ceiling — are enforced twice: here, and again by the browser seat over the value that arrives on the wire. The seat receives no Cordis configuration, so a per-deployment ceiling would be a ceiling the two halves disagree on: a block silently missing from the column rather than a refusal the model can act on. They are protocol constants in [`src/component-call.ts`](src/component-call.ts) until the seat can read a deployment's settings, at which point the ceilings and the route that serves them arrive together. The nesting ceiling is not written down even there: it is measured off the catalog, so a component declaring a nested property widens it by exactly what that property needs and no legal document is refused as malformed.

An action's report grade is not a ceiling and is not configuration either. It says what a gesture means — a pressed confirmation is the answer the agent stopped for — so it is declared beside the action in the catalog, and a deployment that moved it would be changing what the agent is told happened.

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

## What comes back

A block reports what the user did by running one command: `/component-action <json>`, whose whole input is a single JSON object — `entryId`, `componentId`, `actionId`, `nodeId`, and a `payload` carrying the properties that action declares and nothing else. A document carrying any other property, at either level, is refused whole rather than trimmed. `el.confirm-bar` declares one action, `press`, whose payload is the pressed button's `id`.

Nothing the block sends is shown as written. The entry, the node, the component, and the action are identifiers resolved against the log; the words the agent and the user then read — the entry's title, the component's name, the pressed button's label — are read back out of the catalog and out of the spec the model itself wrote. A block reporting a button its entry does not draw, a node the entry does not carry, or a property its action does not declare reports nothing at all, and the person who clicked is told the gesture was not recorded.

This adds no session event. A command's input is already a durable log-only record: the registry writes `command/run` carrying the action document verbatim before the handler runs, the settlement is the paired `command/done`, and the notice the handler builds is logged as the `user/message` the loop writes when the agent claims it.

A press the agent is reading leaves no row of its own in the conversation. The command is dispatched for that record, not to tell someone about a button they just pressed themselves, so this row registers its own chat view at the command's name — the chat view's own default would otherwise print `component-action · Completed` — and the row it leaves empty is collapsed by the stylesheet [`content-column`](../content-column/README.md) installs for exactly this. What the conversation shows of such a press is the notice the agent claims.

Two settlements are the exception, and they are the whole reason that view is a component rather than an absence. A refused press reached no agent, so no notice and no answer ever follows it. A press that only reached the inbox will be read, but not until the user writes again. Either way the row is the only place the person who pressed can learn that, so it draws the handler's own sentence — 这个动作没能记下来。 or 已记下，你下次发消息时对话会看到。 — and nothing else about the command; a refusal reads as the failure it is, the waiting press as an ordinary line. Neither row is empty, so the collapsing rule leaves both alone.

### What a press is answered with

The delivery, not the grade. `deliverAction` reports where the notice landed — nothing at all, a turn opened for it, or the agent's inbox — and only the last of those carries a sentence back, because it is the only one where nothing will happen until the user writes again. A user told the conversation has their answer while it is waiting on them is a user left waiting by their own screen.

### The pressed state

Folded out of the log, and no block keeps one. The column discards a kind's DOM whenever the user picks another entry, so a block holding its own pressed flag comes back untouched and lets one decision be reported twice; the seat therefore reads the `componentActions` projection this row registers alongside the command. It folds the two records a press already writes — `command/run` opening one cell per `(entryId, nodeId)`, the `command/done` paired by `commandId` settling it into `sent`, `queued`, or `refused` — and the browser reads the value off the session's projection values, exactly where the column reads its entry stream. Each block gets its own cell as [`component-kit`](../component-kit/README.md)'s `state` prop; `refused` stays pressable, since reporting it again is the only thing left to try.

A gesture counts for the call currently on display and no other: the cell's `seq` is the press's own log position and the entry's is its placing call's, so a later call under the same id starts unanswered.

The one thing the log cannot cover is the round trip, and that is held for the page rather than by the block. The browser half keeps one table of presses that have no record yet, keyed by session, entry, placing call, and block — the same four parts the seat gives each block as its React identity, because a session switch redraws the seat rather than unmounting it and two sessions whose calls landed at the same log position would otherwise share one mounted block and its waiting: a block writes its row when the press leaves and reads it back whenever it is drawn again, so a tab round trip made inside that window brings back a bar still saying the press is on its way rather than one the user can answer a second time. A block waits for a gesture recorded later than the one it can see, and reads `sending` until there is one.

Exactly two things clear a row. One is the record arriving. The other is the dispatch answering that no record is coming — an oversized document, a rejected call, a gateway that is not there — which is why the dispatch reports back at all: a command that never ran leaves no settlement to wait for, so the block says the gesture was not recorded and accepts another press instead of sitting at `sending` with every button dead. That second answer is the page's own reading of what it saw, held as the log position the press was anchored to: a record the host wrote before the transport dropped settles the block like any other.

### The three grades

Each action declares what an occurrence of it means, and that is what decides delivery:

| Grade | The gesture | What happens |
|---|---|---|
| `silent` | sorting, paging, opening a row | nothing reaches the agent |
| `context` | ticking a row, editing a filter before submitting it | waits in the agent's inbox, read at its next step |
| `wake` | pressing confirm, submit, or delete | opens a turn now |

`press` is `wake`: the agent put a decision in front of the user and stopped, and an answer nothing claims is one it never hears. A `wake` reaching an agent that is already working is staged instead, exactly like `context`, because a running turn reads its inbox without a turn boundary of its own.

### The wake budget

Three turns per agent. A user drumming on a button would otherwise be an unbounded chain of turns; past the third, presses are staged as `context` until the agent claims a message from the human, which refills the budget in full. A notice this row queued never refills it.

### Where the approval gate is

Not here. This row places no write tool and requests no approval of its own — a command handler can run with no turn open, and an approval request throws there. The gate is the deployment's own `tools/pre-execute` policy over whatever write tool the model reaches for in the turn a press opened, and that is what the composition test pins: an existing write tool the policy asks about does not run.

## Trust

`spec` is model output that becomes a rendered block inside the shell's own origin. It is bounded rather than trusted, and the bound is the property schema rather than a sanitizer: there is no member of that schema union which can express markup, a function body, or a URL, so there is no such value for a later pass to have to recognize. A property the component does not declare is refused outright rather than dropped, so a model writing `onClick` learns that it did.

The browser seat re-runs the identical judgement over the payload arriving on the wire, which is why the catalog and the validator sit in modules of their own that import nothing but each other: the seat reads them without pulling a tool runtime into a page, and the two halves cannot drift onto different rules.

## The seat

The browser half is one keyed registration: `component` of `content.surface.kind`, the content column's open key domain. The seat draws the entry's title over the blocks the call placed, stacked in the order it wrote them, and draws nothing while another kind holds the column, which reaches it as no entry at all. What `visibility` keeps mounted there is the column's wrapper for the kind, not the blocks, whose DOM goes with the draw.

Before drawing, the seat runs the call's own judgement over the payload again. That is not distrust of the host it ships with: an entry's payload can arrive from a persisted checkpoint written by a composition whose catalog and ceilings were not this build's, so the type it comes with is a claim. The check is the same import-free module the tool judged the call with, which is why that module imports nothing. A payload this build does not accept becomes one sentence in the column instead of blocks.

Each block is memoized on its own identity — its entry, that entry's owning sequence, the node, and the gesture the fold records against it — so a redraw elsewhere in the stack leaves a block holding the props it already had. The renderer comes from the component row's table by the catalog id the node names; a table with no entry for it says so in that block's place, which is what a deployment composing a mismatched row sees.

The seat carries no dictionary. It translates through `componentKit`, the component row's namespace, because the sentence shown in place of a block belongs with the components rather than with the package that placed them.

## Model Experience

### The `show_component` offer

#### What the model sees

One tool, `show_component`, with a required `id` string, a required `title` string, and a required `spec` object whose `nodes` array is required. The description carries the whole catalog as one `- id — label — purpose` line per component, the reuse rule for `id`, the node and byte ceilings, the refusal rule for undeclared properties, and the sentence naming what comes back: what the user does inside a block reaches the model, with the entry and the block it happened in. The component labels in that list are the Chinese names the end user reads, so a model naming a block in conversation names it the way the user sees it. This package contributes no system-prompt section.

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

- **The payload whitelist is the block's own promise, not something the host enforces** — the command registry records a command's input verbatim before any handler runs, so an over-full action document is in the log by the time this row refuses it. What the host still enforces is the byte ceiling and the declared properties: past the ceiling, or carrying a property its action does not declare, the action is not delivered to the agent at all. Sending only what the action declares is the seat's obligation, and both halves ship here.
- **The transcript row names the mechanism rather than the block** — a notice arrives as a collapsed row headed `上下文注入 · content-component` (`Context injection · content-component` in English), a term and a plugin id in front of an end user, and the one-line summary beside them is a flexible cell that the console's three-column chat width squeezes to nothing. Expanding it is no better: what it opens on is the model-facing English sentence with the internal identifiers inside it — `The user pressed "Approve" in content panel entry "budget" ("Budget approval"), on the 确认条 block "ask".` — which is the account written for the agent, shown to the person who made the gesture. Both the row and the body are drawn by [`ui-conversation`](../../client/ui-conversation/README.md) for every producer alike; the review trigger for all of it is the `develop`-line change that gives a producer its own display name, which is where per-producer copy for the expanded body belongs too.
- **The command is in the end user's slash menu** — `commands.register` has no way to keep a row out of the menu the composer offers, so `/component-action` is listed there with the hint `<json>` beside it, in a product where every other row is something a person is meant to type. What that row can be is a sentence saying it is not: the description is end-user Chinese naming the buttons in the content panel and saying the page sends it. A line typed there by hand resolves against nothing and answers with the same refusal a lost press gets — and, where it is well-formed enough to name an entry and a node, it repaints that block with that refusal, because the gesture fold reads the identifiers a line carries and only the handler resolves them against the entry on display. Keeping it out of the menu is a `dsh-commands` change — one `listed` field on the descriptor — and it belongs with whichever row needs it second.
- **A `silent` action's block would say the conversation has it** — a delivery that reached nobody and one that opened a turn settle as the same textless success in the log, so the gesture fold reads both as `sent`, which is the state the bar says the conversation has it in. No catalog action declares `silent` today; the first one that does decides its block's line in the same change.
- **The wake budget is memory** — spent wakes live in a table keyed by the agent object, so a restart hands every agent a full budget again and a resumed session cannot tell how many turns its presses had already opened.
- **The gesture fold is per block, not per action** — one cell per `(entryId, nodeId)`, so a component declaring two actions would draw the state of whichever it reported last rather than of the action being asked about. Every catalog component declares one action today; a second one grows the cell key with it.
- **A press the log opened and never closed reads as on its way forever** — `command/run` and `command/done` are written either side of the handler, so a host that stops between them leaves a cell open, and nothing closes it afterwards. That block stays unpressable until a later call replaces the entry. A press that produced no record at all is the other case and settles itself: the dispatch says so, the page drops its row, and the block is answerable again.
- **The settlement sentences are Chinese in any interface** — `这个动作没能记下来。` and `已记下，你下次发消息时对话会看到。` are written by the handler, which is handed no browser locale: a command result is one string, and the session log has to keep the words the user was actually shown. In a non-Chinese console they are drawn in the chat row beside a bar whose own lines came from [`component-kit`](../component-kit/README.md)'s dictionary and are localized. The fix is either a key the client translates or a locale carried on the command result, and the trigger is the console offering an interface in any other language.
- **The return channel has no assembled-transcript coverage** — the `content-console` lane drives an ACP agent, and the ACP protocol has no command method, so no recorded transcript can carry a press. The lane composes the command registry regardless, because the description it pins tells the model a press comes back; the press itself is covered by the Playwright scenario against a real console composition, where the browser, the RPC gateway, the command registry, and the session log are all the shipped ones.
- **The model cannot see what the panel holds** — there is no read path. The agent knows which calls it made, not which entry the user is looking at, whether one was dismissed, or what any block currently shows.
- **No layout and no binding between blocks** — a spec is a flat list of nodes drawn top to bottom. There is no row/column tree, no width, and no way for one block's state to feed another's properties.
- **One catalog entry** — `el.confirm-bar`. The mapping from a real component library to catalog entries, and the packaging that gets those components into a browser bundle, are separate work.
- **No block's own input survives being unselected** — the seat draws the selected entry alone and nothing at all while another kind holds the column, so switching kinds, or switching between two `component` entries, discards whatever the user had typed into the blocks that were on display. A reported gesture does survive, because it is in the log rather than in the block.
- **An entry this build cannot fully accept shows nothing at all** — the seat re-judges the whole payload, so one node naming a component this catalog no longer carries costs the entry every block it could have drawn, not just that one.
- **The ceilings are protocol constants, not configuration** — the configuration section above states why, and what has to exist before they can become a deployment's choice.
- **A stored entry carries its whole spec** — the column's projection keeps the validated spec per live entry, so it rides the wire value and the persisted checkpoint. The byte ceiling is what bounds it.
- **The invariant reports through the dispatch path only** — `Session.append` reports a throwing listener to the logger and carries on, so the live audit reaches a caller only where a committed event is dispatched through the context. The startup audit over loaded sessions is unaffected.
- **The drawn block is not covered by an assembled snapshot** — the tool's whole model-visible surface, the catalog spliced into its description and the result line included, is pinned by the [`examples/content-console`](../../../examples/content-console/README.md) lane, which composes this row for real and runs a call end to end. What the seat then draws is a Playwright scenario against a real console composition.
