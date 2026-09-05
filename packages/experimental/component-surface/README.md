# @deepseek-ai/dsh-experimental-component-surface

English | [中文](README.zh.md)

`show_component`: the agent places a block of interface — a prompt with a row of buttons, the details of one record, a table of them, a row of filter conditions, one number — in the content panel beside the conversation, chosen from a catalog this package owns and judged against that catalog before anything is drawn.

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

Today it holds five entries:

| Component | 名称 | What it draws | What comes back |
|---|---|---|---|
| `el.confirm-bar` | 确认条 | an optional title, an optional message, and one to five buttons each carrying an id, a label, and an optional tone | `press`, carrying the pressed button's id |
| `toy.record` | 记录详情 | one to sixty rows, each a label of at most 40 characters and a value of at most 400, with an optional label width of 40 to 240 and an optional column count of 1, 2 or 3 | nothing |
| `toy.table` | 数据表 | one to thirty columns over one to five hundred rows, each column reading its cell out of a row by field name and optionally drawn by one of five cell renderers; optionally a selection column, clickable row names, up to five custom operation buttons, and an operation column width | `select`, `row-click`, `sort` and `operation` |
| `el.filter-bar` | 筛选条件 | one to forty attributes the user builds conditions over, optionally narrowed to some of the sixteen match strategies | `submit` and `change` |
| `el.metric` | 指标球 | one measurement from 0 to 100 drawn as a filling ball, with an optional word, size, and three colors | nothing |

A component reporting no action says so on its own line of the tool description — a model told a block answers back would otherwise place a display-only one and wait. Each component's properties are stated under that line, derived from its `propsSchema` rather than written beside it, so what the model is offered and what a call is judged against cannot drift apart and a model learns what to send without spending a refused call on finding out. The line goes all the way down: a nested list states what one of its items carries, because a list named without its item properties costs one refused call per property to discover. What it leaves out is every bound a refusal already states — a string's length, a token's alphabet — because the description is paid for on every request and a refusal is paid for once.

A record's row keeps its place when its value is the empty string: the component draws the label with nothing beside it, which is what an attribute the record has but does not fill looks like.

A component's properties are declared as a small schema of seven shapes: a bounded string (optionally restricted to an alphabet), a number in a declared range, `true` or `false`, a fixed set of strings or numbers, an object of further declared properties, an object whose keys are the caller's own, and a bounded list of any of those. A list whose items are something the user points at also names the item property that identifies them; a list nothing comes back from — the rows of a record — declares none, and two rows sharing a label are the data rather than a mistake. That union is the security boundary rather than a convenience, for the reason the trust section below states.

The caller-keyed object is what a table row is: the keys are the field names the columns read, so they cannot be listed in advance the way a component's own properties are. It is bounded instead — an alphabet and a length for the keys, a count of them, and scalars only for the values — and the description writes it as `{<field>: text|number|boolean}`.

What a schema cannot say is what a string *means*. A component that reads one as a path, a color, or the name of a cell renderer declares that reading beside the schema, from a closed list of three, and [`src/sanitize.ts`](src/sanitize.ts) enforces it on the way in: a path that is not one same-origin path and a color outside `#RGB`, `#RRGGBB`, `rgb()` and `rgba()` are dropped, and a renderer name outside the whitelist falls back to the plain renderer rather than leaving a cell with nothing to draw it. A declared reading is stated in the description, because the pass drops the value rather than refusing the call and a model that is not told the notation is never told why what it sent disappeared. The renderer name is also declared as a fixed set, so a call naming one outside it is refused and the fallback is left for a stored record written against a catalog whose whitelist has since narrowed. The table declares the renderer name, the metric ball declares its three colors, and `path` is the one reading nothing declares yet; the pass runs regardless, because the alternative is a rule that arrives with the first component that needs it and has never run before.

A caller-keyed object declares its own readings rather than sharing its component's, because its keys are data: `color` is a configuration key of a cell renderer and also a perfectly ordinary column of somebody's records, and a rule keyed by name at the component level would tighten both.

## What a call is judged against

In order, and each step can end the call: the entry `id` and the `title`; the spec's nesting depth; its size in bytes; the properties a spec and a node may carry at all; every node's id, its uniqueness within the call, and the component it names; and finally every property of that component.

An accepted node leaves that judgement with its properties already tightened, because validation is the one path all three readers take — the tool, the fold over the log, and the browser seat — and a second pass a caller has to remember to run is a second pass that eventually is not run.

Depth is measured before size because both walk the document and only the depth walk is bounded by construction — it stops at the ceiling rather than at the bottom of the value.

Every refusal names the offending parameter path, because that path is the only channel the model has: a call carrying eight nodes gets one sentence back, and unless the sentence says `spec.nodes[3].props.buttons[1].id` the next call is a guess. A call naming a component the deployment does not have gets the whole catalog back rather than a count, so the correction needs no extra round trip.

## One entry, several calls

A call owns the entry its `id` names, written in the same alphabet as a node id — letters, digits, underscores and hyphens. Calling again with the same id replaces what that entry shows — both calls stay in the transcript, because the log is what happened, but the column shows one block under one tab in its switcher strip. A different id adds a second entry beside it.

The fold recognizes both shapes a call takes in the log: a top-level `tool/call`, whose `arguments` is raw JSON, and a Code Mode `tool/code-dispatch-start`, whose `arguments` is already decoded. A model reaching the tool through `run_code` logs only the second.

A call the tool refused is still in the log — the loop records the call, not its outcome — and the extractor runs the same judgement over it, so a refused call records no entry rather than an entry the seat has nothing to draw.

Resolving a stored record consults no catalog. The catalog is a build-time table that grows and changes, a persisted checkpoint written before a component was renamed must still resolve, and it is the seat — which knows which renderers it actually has — that reports a block it cannot draw. What resolving does check is that the record carries the two fields it reads. A checkpoint is plain JSON whose declared type is a claim, and one throw there would cost the column not this entry but every kind's entries at once, so a record this build cannot read resolves into an entry the seat draws its notice for.

## What comes back

A block reports what the user did by running one command: `/component-action <json>`, whose whole input is a single JSON object — `entryId`, `componentId`, `actionId`, `nodeId`, and a `payload` carrying the properties that action declares and nothing else. A document carrying any other property, at either level, is refused whole rather than trimmed.

| Action | Payload | Grade |
|---|---|---|
| `el.confirm-bar` `press` | the pressed button's `buttonId` | `wake` |
| `toy.table` `select` | `rowIndexes`, one per ticked row and as many as the table drew | `context` |
| `toy.table` `row-click` | one `rowIndex` | `context` |
| `toy.table` `sort` | the column's `prop` and an `order` of `asc`, `desc` or `none` | `silent` |
| `toy.table` `operation` | the pressed button's `opId` and the `rowIndex` it was pressed on | `wake` |
| `el.filter-bar` `submit` | one to ten `conditions`, each a `key`, an `op` and a `value`, and the `matchMode` the user joined them with where the bar offered the choice | `wake` |
| `el.filter-bar` `change` | the `count` of conditions standing after one committed edit | `silent` |

Nothing the block sends is shown as written. The entry, the node, the component, and the action are identifiers resolved against the log; the words the agent and the user then read — the entry's title, the component's name, the pressed button's label, a row's name, a column's header, the wording of a match strategy — are read back out of the catalog and out of the spec the model itself wrote. A block reporting a button its entry does not draw, a row past the ones it listed, an operation it does not carry, an attribute its filter does not offer, a node the entry does not carry, or a property its action does not declare reports nothing at all, and the person who clicked is told the gesture was not recorded. One refusal is told apart from those: a gesture carrying more than its action accepts — more conditions than a filter submits, more of anything than a ceiling admits — is answered with the sentence saying there is too much, which is the only one of these a person can act on.

A row is named by what the first column the table draws shows, and by its position — `#4`, 第 4 行 — where that column shows nothing or where the call hid every column. A selection names its first five rows and counts the rest. Everything a notice quotes is free text somebody wrote: the title the model gave the entry, the header it put on a column, the label on a button, what a row's first cell shows, and — the one thing that is not the model's own words — what the user typed into a filter. All of it is read back the same way, because a sentence that treated one quoted value differently from the next is a sentence either of them could rewrite: the agent's account writes each as JSON writes a string, so nothing inside a value can end the quotation it sits in, and the user's line reads back what was written with anything that would not stay on one line replaced by a space.

This adds no session event. A command's input is already a durable log-only record: the registry writes `command/run` carrying the action document verbatim before the handler runs, the settlement is the paired `command/done`, and the notice the handler builds is logged as the `user/message` the loop writes when the agent claims it.

A press the agent is reading leaves no row of its own in the conversation. The command is dispatched for that record, not to tell someone about a button they just pressed themselves, so this row registers its own chat view at the command's name — the chat view's own default would otherwise print `component-action · Completed` — and the row it leaves empty is collapsed by the stylesheet [`content-column`](../content-column/README.md) installs for exactly this. What the conversation shows of such a press is the notice the agent claims.

Two settlements are the exception, and they are the whole reason that view is a component rather than an absence. A refused press reached no agent, so no notice and no answer ever follows it. A press the agent stopped for that reached only the inbox will be read, but not until the user writes again. Either way the row is the only place the person who pressed can learn that, so it draws the handler's own sentence — 这个动作没能记下来。, 内容太多了，少选几项或写短一些再试。 for the refusal that says which, or 已记下，你下次发消息时对话会看到。 — and nothing else about the command; a refusal reads as the failure it is, the waiting press as an ordinary line. Neither row is empty, so the collapsing rule leaves both alone.

### What a press is answered with

The delivery, not the grade. `deliverAction` reports where the notice landed — nothing at all, a turn opened for it, the inbox because the agent could not take a turn for it, or the inbox because that is what the gesture asked for — and exactly one of those carries a sentence back. It is the third: the user answered something the agent stopped for, and nothing will happen until they write again. A user told the conversation has their answer while it is waiting on them is a user left waiting by their own screen.

The fourth carries none, and that is the point of telling it apart from the third. Ticking a row is the user working rather than asking, nobody is waiting on a reply to it, and a sentence per tick would put a line in the conversation for every row the user touches — under the agent's replies, which is what the person is reading the conversation for. A textless success is the settlement the chat row draws nothing for, so a ticked table leaves the transcript alone.

### The pressed state

Folded out of the log, and no block keeps one. The column discards a kind's DOM whenever the user picks another entry, so a block holding its own pressed flag comes back untouched and lets one decision be reported twice; the seat therefore reads the `componentActions` projection this row registers alongside the command. It folds the two records a press already writes — `command/run` opening one cell per `(entryId, nodeId)`, the `command/done` paired by `commandId` settling it into `sent`, `queued`, or `refused` — and the browser reads the value off the session's projection values, exactly where the column reads its entry stream. Each block gets its own cell as [`component-kit`](../component-kit/README.md)'s `state` prop; `refused` stays pressable, since reporting it again is the only thing left to try.

Only a `wake` reaches a cell. A block's state is the answer it was placed for, and a block holds one cell for every gesture it reports, so a table whose tick claimed that cell would report a selection as an answer and then refuse the row button underneath it, and a filter bar would disable its own submit the first time the user committed an edit. A `context` or a `silent` gesture is reported and leaves the block as it found it — the fold writes it no cell, and the seat files it no row in the page's waiting table, because there is no settlement coming for it.

A gesture counts for the call currently on display and no other: the cell's `seq` is the press's own log position and the entry's is its placing call's, so a later call under the same id starts unanswered.

The one thing the log cannot cover is the round trip, and that is held for the page rather than by the block. The browser half keeps one table of presses that have no record yet, keyed by session, entry, placing call, and block — the same four parts the seat gives each block as its React identity, because a session switch redraws the seat rather than unmounting it and two sessions whose calls landed at the same log position would otherwise share one mounted block and its waiting: a block writes its row when the press leaves and reads it back whenever it is drawn again, so a tab round trip made inside that window brings back a bar still saying the press is on its way rather than one the user can answer a second time. A block waits for a gesture recorded later than the one it can see, and reads `sending` until there is one.

Exactly two things clear a row. One is the record arriving. The other is the dispatch answering that no record is coming — an oversized document, a rejected call, a gateway that is not there — which is why the dispatch reports back at all: a command that never ran leaves no settlement to wait for, so the block says the gesture was not recorded and accepts another press instead of sitting at `sending` with every button dead. That second answer is the page's own reading of what it saw, held as the log position the press was anchored to: a record the host wrote before the transport dropped settles the block like any other.

### The three grades

Each action declares what an occurrence of it means, and that is what decides delivery:

| Grade | The gesture | What happens |
|---|---|---|
| `silent` | sorting a table, editing a filter before submitting it | nothing reaches the agent |
| `context` | ticking a row, opening one | waits in the agent's inbox, read at its next step, and replaced by the next occurrence of the same gesture |
| `wake` | pressing confirm, submit, or delete | opens a turn now |

The grade also decides whether the gesture is the block's own answer: a `wake` is, and the other two are not — see the pressed state above.

`press`, a table's `operation` and a filter's `submit` are `wake`: the agent put a decision in front of the user and stopped, and an answer nothing claims is one it never hears. A `wake` reaching an agent that is already working is staged instead, exactly like `context`, because a running turn reads its inbox without a turn boundary of its own.

Ticking rows and opening one are `context`: they change what the agent should be reasoning about at its next step without answering anything it stopped for. Unticking everything is reported too, rather than passed over as an absence — an agent told nothing would go on believing the rows it last heard about are still ticked. An opened row is reported only by a table whose call asked for openable rows, and then for a click anywhere in the row: the component draws its name link from `isNameClick` and reports a click on any of its cells through one event, so a table with nothing to open reports no click at all.

A second occurrence of one gesture replaces the first while the first is still unclaimed. What the user has selected is one fact rather than a history of ticks, the inbox has no ceiling of its own, and a user working a table would otherwise queue a notice per tick, each one corrected by the next. The key is the entry, the block and the action together — an opened row does not overwrite a selection — and the replacement is `Inbox.replace`, which cancels the earlier notice and inserts the new one in its place, so the agent log accounts for it as work still pending rather than work dropped unrun. A notice the agent has already claimed is never rewritten: the model has read it, and the later gesture is queued behind it. A `wake` is never replaced either, because two answers to two questions are two answers.

Sorting a table and editing a filter before submitting it are `silent`: the order rows are drawn in is the user arranging their own screen, and an unsubmitted filter is the user still typing.

### The wake budget

Three turns per agent. A user drumming on a button would otherwise be an unbounded chain of turns; past the third, presses are staged as `context` until the agent claims a message from the human, which refills the budget in full. A notice this row queued never refills it.

### Where the approval gate is

Not here. This row places no write tool and requests no approval of its own — a command handler can run with no turn open, and an approval request throws there. The gate is the deployment's own `tools/pre-execute` policy over whatever write tool the model reaches for in the turn a press opened, and that is what the composition test pins: an existing write tool the policy asks about does not run.

## Trust

`spec` is model output that becomes a rendered block inside the shell's own origin. It is bounded rather than trusted, and the first bound is the property schema: no member of that union can express markup or a function body, so a model reaching for a `formatter` or an `onClick` is refused by the absence of a property to write it into rather than by a sanitizer that recognized a function body. A property the component does not declare is refused outright rather than dropped, so a model writing one learns that it did, and the refusal names it.

The second bound is the tightening pass above, and it covers what a schema cannot state: a declared reading is enforced value by value, and a value outside its reading is dropped from the block rather than refused to the model, because the pass also runs where no model is waiting — over a stored record on the way to the seat. The pass drops undeclared properties too, which through validation can never happen; that arm is what a record written by another build gets.

The browser seat re-runs the identical judgement over the payload arriving on the wire, which is why the catalog and the validator sit in modules of their own that import nothing but each other: the seat reads them without pulling a tool runtime into a page, and the two halves cannot drift onto different rules.

What the pass answers with is frozen, deeply. A renderer may draw a block with a Vue 2 component, and Vue makes a component's props reactive by rewriting them property by property — which would leave the seat's own memo and the Vue tree disagreeing about what changed. Vue walks past a frozen value, so freezing on the way out is what settles it, for the React renderers too: what a renderer is lent, it may read and may not write.

## The seat

The browser half is one keyed registration: `component` of `content.surface.kind`, the content column's open key domain. The seat draws the entry's title over the blocks the call placed, stacked in the order it wrote them, and draws nothing while another kind holds the column, which reaches it as no entry at all. What `visibility` keeps mounted there is the column's wrapper for the kind, not the blocks, whose DOM goes with the draw.

Before drawing, the seat runs the call's own judgement over the payload again. That is not distrust of the host it ships with: an entry's payload can arrive from a persisted checkpoint written by a composition whose catalog and ceilings were not this build's, so the type it comes with is a claim. The check is the same import-free module the tool judged the call with, which is why that module imports nothing. A payload this build does not accept becomes one sentence in the column instead of blocks.

Each block is memoized on its own identity — its entry, that entry's owning sequence, the node, and the gesture the fold records against it — so a redraw elsewhere in the stack leaves a block holding the props it already had. The renderer comes from the component row's table by the catalog id the node names; a table with no entry for it says so in that block's place, which is what a deployment composing a mismatched row sees.

The seat carries no dictionary. It translates through `componentKit`, the component row's namespace, because the sentence shown in place of a block belongs with the components rather than with the package that placed them.

## Model Experience

### The `show_component` offer

#### What the model sees

One tool, `show_component`, with a required `id` string, a required `title` string, and a required `spec` object whose `nodes` array is required. The description carries the whole catalog as two lines per component: `- id — label — purpose`, with `Nothing comes back from it.` on the line of a component that reports no action, and beneath it a `props:` line naming every property that component declares — `?` on the ones a call may omit, `(min–max)` on a number, `(a|b|c)` on a fixed set, `(true|false)` on a yes-or-no, `[what one item is] (min–max)` on a list, `{…}` on an object of declared properties, and `{<field>: text|number|boolean}` on an object whose keys the model chooses. Then the reuse rule for `id`, the node and byte ceilings, the refusal rule for undeclared properties, and the sentence naming what comes back: what the user does inside a block reaches the model, with the entry and the block it happened in, unless that component's line said otherwise. The component labels in that list are the Chinese names the end user reads, so a model naming a block in conversation names it the way the user sees it. This package contributes no system-prompt section.

#### Token effect

One fixed description plus the parameter schema, on every request where the tool is visible. The description grows by two lines per catalog entry, the second as long as that component's whole property tree — the table's line is the longest, because its columns are a list inside an object; the `spec` schema stays shallow — one object with one array — because the per-component properties are in the catalog lines rather than in a nested JSON Schema.

#### KV Cache effect

The description is assembled once when the row loads and depends on nothing but the catalog, so the tool block is byte-identical across every request in a deployment and the prefix holds.

### Tool-call result

#### What the model sees

An accepted call answers `Now showing "<title>" in the content panel: <labels>.` followed by the sentence naming the id to reuse. A refused call answers `Error: show_component: <path> — <what is wrong and what to send instead>`, and for an unknown component the whole catalog again, property lines included, so the corrected call needs no second refusal to learn what the component it picks instead accepts.

#### Token effect

One short line per call. A refusal naming an unknown component is longer by the length of the catalog, which is the point: it replaces a second failed call.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

## Known Limitations and Deferred Work

- **The payload whitelist is the block's own promise, not something the host enforces** — the command registry records a command's input verbatim before any handler runs, so an over-full action document is in the log by the time this row refuses it. What the host still enforces is the byte ceiling and the declared properties: past the ceiling, or carrying a property its action does not declare, the action is not delivered to the agent at all. Sending only what the action declares is the seat's obligation, and both halves ship here.
- **The transcript row names the mechanism rather than the block** — a notice arrives as a collapsed row headed `上下文注入 · content-component` (`Context injection · content-component` in English), a term and a plugin id in front of an end user, and the one-line summary beside them is a flexible cell that the console's three-column chat width squeezes to nothing. Expanding it is no better: what it opens on is the model-facing English sentence with the internal identifiers inside it — `The user pressed "Approve" in content panel entry "budget" ("Budget approval"), on the 确认条 block "ask".` — which is the account written for the agent, shown to the person who made the gesture. Both the row and the body are drawn by [`ui-conversation`](../../client/ui-conversation/README.md) for every producer alike; the review trigger for all of it is the `develop`-line change that gives a producer its own display name, which is where per-producer copy for the expanded body belongs too.
- **The command is in the end user's slash menu** — `commands.register` has no way to keep a row out of the menu the composer offers, so `/component-action` is listed there with the hint `<json>` beside it, in a product where every other row is something a person is meant to type. What that row can be is a sentence saying it is not: the description is end-user Chinese naming the buttons in the content panel and saying the page sends it. A line typed there by hand resolves against nothing and answers with the same refusal a lost press gets — and, where it is well-formed enough to name an entry and a node, it repaints that block with that refusal, because the gesture fold reads the identifiers a line carries and only the handler resolves them against the entry on display. Keeping it out of the menu is a `dsh-commands` change — one `listed` field on the descriptor — and it belongs with whichever row needs it second.
- **The wake budget is memory** — spent wakes live in a table keyed by the agent object, so a restart hands every agent a full budget again and a resumed session cannot tell how many turns its presses had already opened. The table of unclaimed `context` notices is keyed the same way and forgotten the same way: after a restart the first tick of a block queues a second notice beside the one the log still holds, which costs the model one superseded sentence and nothing else.
- **A press with nothing complete in it looks like a button that does nothing** — a filter bar starts holding one empty condition row, so the first press a user can make submits nothing; that press reports nothing, and the block draws no line about it either, because a line would say something happened. What the user gets is a button that answers a press with no change on screen at all. Greying the button out is the fix and it is not local: the block would have to know how many complete conditions the editor holds, which is the `change` gesture's own count, and drawing state off a count that arrives on every committed edit needs the two packages to agree about when the button may move. The trigger is the first report of a press that seemed to do nothing.
- **A block cannot say *why* a gesture was refused** — the fold settles a refused gesture into one state, so the block draws 这个动作没能记下来，可以再试 whether the action named nothing on display or carried more than it accepts, while the chat row beside it draws the handler's own 内容太多了，少选几项或写短一些再试。. The two disagree in front of the user about the same press. Telling them apart on the block needs a further `ComponentActionState` member, which is a contract between this package's fold and [`component-kit`](../component-kit/README.md)'s state table and dictionary; the trigger is the first deployment where the chat row is not beside the block.
- **The gesture fold is per block, not per action** — one cell per `(entryId, nodeId)`. It is enough today only because a component declares at most one `wake` and nothing else reaches a cell: the day one declares two, a block will draw the state of whichever of them it reported last. Growing the cell key by `actionId` is the fix, in [`src/action-state.ts`](src/action-state.ts) and the projection beside it, and it is what the second `wake` on one component pays for.
- **A press the log opened and never closed reads as on its way forever** — `command/run` and `command/done` are written either side of the handler, so a host that stops between them leaves a cell open, and nothing closes it afterwards. That block stays unpressable until a later call replaces the entry. A press that produced no record at all is the other case and settles itself: the dispatch says so, the page drops its row, and the block is answerable again.
- **The settlement sentences are Chinese in any interface** — `这个动作没能记下来。`, `内容太多了，少选几项或写短一些再试。` and `已记下，你下次发消息时对话会看到。` are written by the handler, which is handed no browser locale: a command result is one string, and the session log has to keep the words the user was actually shown. In a non-Chinese console they are drawn in the chat row beside a bar whose own lines came from [`component-kit`](../component-kit/README.md)'s dictionary and are localized. The fix is either a key the client translates or a locale carried on the command result, and the trigger is the console offering an interface in any other language.
- **The return channel has no assembled-transcript coverage** — the `content-console` lane drives an ACP agent, and the ACP protocol has no command method, so no recorded transcript can carry a press. The lane composes the command registry regardless, because the description it pins tells the model a press comes back; the press itself is covered by the Playwright scenario against a real console composition, where the browser, the RPC gateway, the command registry, and the session log are all the shipped ones.
- **The model cannot see what the panel holds** — there is no read path. The agent knows which calls it made, not which entry the user is looking at, whether one was dismissed, or what any block currently shows.
- **No layout and no binding between blocks** — a spec is a flat list of nodes drawn top to bottom. There is no row/column tree, no width, and no way for one block's state to feed another's properties.
- **An empty value is drawn as an empty value** — a `toy.record` row whose `display` is the empty string keeps its label and shows nothing beside it. That is deliberate: the alternative reading, dropping the row, hides from the user that the record has the attribute at all. A model that means "this attribute is not set" writes the words for it.
- **Five catalog entries** — the mapping from the rest of a real component library to catalog entries, and the packaging that gets those components into a browser bundle, are separate work.
- **No component declares a `path` yet** — the reading is enforced and tested, and the first component that addresses an asset is what puts it on a screen. The renderer-name and color readings are declared, by the table and the metric ball.
- **One match strategy has no evaluator** — the sixteen a call may narrow to are the sixteen the condition editor draws, because a strategy the user can pick and this package cannot name is a filter the person builds and is then told was not recorded. `NOT_BETWEEN` is the one the component library's own `matchUtil` has no branch for, so a condition carrying it reaches the model as an account of what the user asked for and a backend that is asked to run it answers for itself. Nothing in this package evaluates a condition.
- **A filter offers no AND/OR unless the call asks** — `confStyle.showMatchMode` is off unless a block turns it on, because the control is worth drawing only where the answer carries it. A bar that does draw it submits the mode beside the conditions, and the notice states which of the two the user chose.
- **A table of five hundred rows rarely fits** — the row ceiling is the table's, and `spec` is capped at 65536 bytes, which a table of a few hundred rows with several columns reaches first. The refusal says so and names the byte count. The action ceiling bites the same way from the other side: a filter submitting ten conditions of two hundred characters each is past 4096 bytes and is answered with the sentence saying the content was too large. Ticking every row of a full table is not one of those cases — the selection ceiling *is* the row ceiling, and the byte ceiling is set wide enough to carry it.
- **The condition editor has no ceiling of its own** — a filter bar submits at most ten conditions, and the vendored editor adds rows for as long as the user presses its add button. An eleventh condition is therefore built without anything on screen saying it cannot be sent, and the press that sends it is answered with the sentence saying there is too much. The block itself says only that the gesture was not recorded, because the settlement it folds carries no reason; the reason is in the chat row beside it. Capping the editor needs the ceiling on the renderer's side of the seam, and this package cannot hand it one — [`component-kit`](../component-kit/README.md) draws blocks for whoever places them and must not import a placement package.
- **The value control's kind depends on a field this schema does not carry** — an attribute's `dataType` is read by the condition editor only when that attribute also says its values are typed in rather than chosen from a service. This package declares `dataType` and not that field, so supplying it is the renderer's; a renderer that does not draws every condition as a plain text input whatever `dataType` says.
- **No block's own input survives being unselected** — the seat draws the selected entry alone and nothing at all while another kind holds the column, so switching kinds, or switching between two `component` entries, discards whatever the user had typed into the blocks that were on display. A reported gesture does survive, because it is in the log rather than in the block.
- **An entry this build cannot fully accept shows nothing at all** — the seat re-judges the whole payload, so one node naming a component this catalog no longer carries costs the entry every block it could have drawn, not just that one.
- **The ceilings are protocol constants, not configuration** — the configuration section above states why, and what has to exist before they can become a deployment's choice.
- **A stored entry carries its whole spec** — the column's projection keeps the validated spec per live entry, so it rides the wire value and the persisted checkpoint. The byte ceiling is what bounds it.
- **The invariant reports through the dispatch path only** — `Session.append` reports a throwing listener to the logger and carries on, so the live audit reaches a caller only where a committed event is dispatched through the context. The startup audit over loaded sessions is unaffected.
- **The drawn block is not covered by an assembled snapshot** — the tool's whole model-visible surface, the catalog spliced into its description and the result line included, is pinned by the [`examples/content-console`](../../../examples/content-console/README.md) lane, which composes this row for real and runs a call end to end. What the seat then draws is a Playwright scenario against a real console composition.
