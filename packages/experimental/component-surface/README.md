---
description: "`show_component`: the agent places a block of interface — a prompt with buttons, a record, a table, a filter row, one number — in the content panel from a catalog this package owns, and a user's press comes back through the `/component-action` command; for deployments configuring their own views and the maintainers of that surface."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-component-surface

English | [中文](README.zh.md)

## Summary

`show_component`: the agent places a block of interface — a prompt with a row of buttons, the details of one record, a table of them, a row of filter conditions, one number — in the content panel beside the conversation, chosen from a catalog this package owns and judged against that catalog before anything is drawn.

The package is both halves. The host half offers the tool, validates each call, and claims the `component` kind of the [content surface](../content-surface/README.md)'s entry stream; the browser half claims the `component` key of the content column's `content.surface.kind` slot and draws each entry's spec. Neither half owns a component: the renderers come from [`component-kit`](../component-kit/README.md), which knows no layout, and this package is what puts one of its blocks in a column.

What the user then does inside a block comes back the other way, through one command this row owns: `/component-action`.

The same column also takes blocks nobody asked the model for: a deployment writes views of its own, the shell's sidebar lists them, and a click puts one there, without the model being asked anything.

Nothing the agent does appends a session event. A call's record is the `tool/call` the loop already writes and an action's is the `command/run` the command registry already writes, so both directions replay from the log the agent actually wrote. The one event this package writes is the user's own: the click that opens a configured view.

## Table of Contents

- [Composition](#composition)
- [Configuration](#configuration)
- [Views the deployment writes](#views-the-deployment-writes)
- [Rows read from the deployment's own data](#rows-read-from-the-deployments-own-data)
- [The catalog](#the-catalog)
- [What a call is judged against](#what-a-call-is-judged-against)
- [How the blocks are arranged](#how-the-blocks-are-arranged)
- [What one block reads from another](#what-one-block-reads-from-another)
- [One entry, several calls](#one-entry-several-calls)
- [What comes back](#what-comes-back)
- [Trust](#trust)
- [The seat](#the-seat)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="composition"></a>
## Composition

[`overlay/component-surface.patch.yml`](overlay/component-surface.patch.yml) inserts this row and the component row over the service-line console composition, which already carries the content surface and the content column. The overlay's own comments carry the launch line.

The row activates in three independent pieces. The tool needs a tool runtime and nothing else, so a composition with no content column still offers it and still records its calls. The extractor needs the content-surface router; without it the calls are in the log and no column reads them, which is exactly what a composition growing a column later wants. The return channel needs all three of the command registry, that router, and the projection registry the entry is read out of — with no column there is nothing on screen for an action to name, so the command is absent rather than answering every gesture with a refusal.

<a id="configuration"></a>
## Configuration

Four fields. `views` and `homeView` are about blocks a person wrote rather than about anything the model does, and the next section is their whole documentation. `dataSource` and `dataDefaultPageSize` are about rows the model asks this deployment for rather than writes out, and the section after that is theirs. Everything else is fixed.

The numbers a deployment might want to move — the spec byte ceiling, the node ceiling, the nesting ceiling, the action byte ceiling — are enforced twice: here, and again by the browser seat over the value that arrives on the wire. The seat receives no Cordis configuration, so a per-deployment ceiling would be a ceiling the two halves disagree on: a block silently missing from the column rather than a refusal the model can act on. They are protocol constants in [`src/component-call.ts`](src/component-call.ts) until the seat can read a deployment's settings, at which point the ceilings and the route that serves them arrive together. The nesting ceiling is not written down even there: it is measured off the catalog, so a component declaring a nested property widens it by exactly what that property needs and no legal document is refused as malformed.

An action's report grade is not a ceiling and is not configuration either. It says what a gesture means — a pressed confirmation is the answer the agent stopped for — so it is declared beside the action in the catalog, and a deployment that moved it would be changing what the agent is told happened.

<a id="views-the-deployment-writes"></a>
## Views the deployment writes

A view is the same three values a `show_component` call carries — an entry id, a short title, and a spec — written by a person in `cordis.yml` instead of by the model in a tool call. That is what lets one entry kind, one extractor and one seat serve both: what differs is who wrote the spec, not what it is.

```yml
- id: show-component
  name: '@deepseek-ai/dsh-experimental-component-surface'
  config:
    homeView: site-overview
    views:
      - id: site-overview
        title: 站点概览
        spec:
          nodes:
            - id: sites
              component: toy.table
              props:
                selectMode: radio
                tableConfig:
                  gridItems:
                    - { relatedMetaAttr: name, alias: 站点 }
                displayValueList:
                  - { name: 一号站点 }
            - id: detail
              component: toy.record
              props:
                dataList: { $from: 'node:sites.selectionDetail' }
                columnNum: 1
          layout:
            node: stack
            dir: col
            gap: md
            children:
              - { node: component, id: sites, flex: 2 }
              - { node: component, id: detail, flex: 1 }
```

`homeView` names the view the sidebar opens by itself the first time a session lands on a blank draft, so a new conversation starts on a populated column; omit it to leave that column empty until the user or the agent chooses. It must name a configured view, and what it drives is a real click, leaving the same durable record one would.

Every view is judged at load by the pass that judges a call — the same catalog, the same ceilings, the same alphabet for an id — so what a deployment may write is exactly what the model may send. A view that would not survive that judgement stops the row from loading, naming both the view a person has to go and edit and the value inside it:

```
component-surface: views[0] "site-overview" — spec.nodes[0].component — names no component of this deployment. Available components: …
```

Loud rather than skipped, because a view quietly dropped is a menu row that shows an empty column when a user clicks it, with nothing anywhere saying why. A repeated id and a `homeView` naming no configured view fail the same way.

Two registrations exist only where views do. `GET /component-surface/views` answers the catalog a navigation menu is built from — `{"views":[{"id","title"},…],"homeView"?}` — and nothing more: a spec never travels this route, so a page cannot ask for a view the deployment did not configure. `/show-content-view <id>` is what a click runs; it appends the event below, draws nothing in the chat for a click the host took, and answers a click naming no view with one sentence, `没有这个视图。`, which is the only thing its chat row ever draws. Clicking the view already on screen appends again, which is what moves that entry back to the front of the switcher strip rather than doing nothing.

`content-component/shown` is the one session event this package writes. It is Log-only — nothing about it reaches a model request, because what the model is told about the column is what the tool it called said — and it carries the whole spec rather than the view id, so a view the deployment later edits or drops still replays as what the user actually saw. The entry is folded out of it by the extractor that folds a call, under the entry id the view owns.

<a id="rows-read-from-the-deployments-own-data"></a>
## Rows read from the deployment's own data

Off by default. A deployment sets `dataSource: true`, and the row then waits for both of the seams a read needs before offering the tool at all: `bizBackend`, which [`auth-gate`](../auth-gate/README.md) registers when it is configured with a `bizUpstream`, and `approval`. With either missing, `show_component` is not registered — a description promising a parameter with nothing behind it is worse than a row that never loaded.

```yml
- name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    bizUpstream: https://<host>/ini-server/
- name: '@deepseek-ai/dsh-user-approval'
- id: show-component
  name: '@deepseek-ai/dsh-experimental-component-surface'
  config:
    dataSource: true
    dataDefaultPageSize: 200
```

`bizUpstream` is the deployment's own API prefix and ends in `/`; it has no default, and leaving it out is how a deployment says it serves no data.

Where it is on, a call may send `dataSource` beside `spec`: one entry per `toy.table` block whose rows it wants read rather than written out.

| Field | Required | What it is |
|---|---|---|
| `nodeId` | ✅ | a `toy.table` block of this same call |
| `meta` | ✅ | the table's name in the backend |
| `metaLabel` | ✅ | that table's name in the user's own language, at most 20 characters of one plain line; this is what the approval card shows |
| `conditions` | | at most ten `{key, op, value}`; `op` is one of the sixteen strategies the filter bar offers, and a value is text, a number, a yes-or-no, or a list of at most twenty of the first two |
| `matchMode` | | `AND` (the default) or `OR` |
| `page` | | `{pageSize, currentPage}`; `pageSize` is between 1 and 500 and is `dataDefaultPageSize` where the call leaves it out, `currentPage` is a whole number of 1 or more and is 1 where the call leaves it out |
| `asc` / `desc` | | one attribute, one direction; sending both is refused |

A block named here sends no `displayValueList` and no `rawValueList`, and a `toy.table` block **not** named here must still send its own rows. Both are refused before anything is asked of anyone.

Which attributes are read is not a parameter. It is that block's own `tableConfig.gridItems[].relatedMetaAttr`, hidden columns included, or — for a block that declares no columns — the columns the table's default query scheme shows. Either way a read asks for exactly the columns that block will be drawn with, and a block that names its own columns can be read for no attribute outside them.

A filled block may leave `gridItems` out, and `tableConfig` with it. That asks for the columns this deployment's own resource list opens the table with: the table's default query scheme, read through `describeScheme` once the user has allowed the read, minus the columns the scheme hides, in the scheme's own order, with the scheme's headers and its sortable flag carried into the drawn columns. It is a tool default rather than something a model is expected to look up first, because the failure it removes is one a model cannot see: guessing an attribute name costs one refusal and is then corrected, while guessing a column that exists and is empty in every row draws a table of blanks and tells the user it has three columns of data. A table with no default scheme, one whose scheme names no column this component could draw, one whose scheme names an attribute the table's own dictionary does not list, and one whose scheme is wider than a table draws all refuse the call before a row is read — in words naming the scheme rather than a column the call never wrote, and naming the parameter to send instead.

### The order, and what each step costs

1. `dataSource` and every block it names are judged — and so is the rest of the call, over a copy carrying one stand-in row per table to be filled. A title too long, a thirteenth block, a component this deployment does not have and a thirty-first column have nothing to do with the rows, so all of them are refused here rather than after a person has answered for them. Nothing has been asked and nothing has been spent.
2. Whether a credential is held at all is read off the gate, which costs nothing and reaches nothing. A session holding none is refused here, because allowing a read this process cannot perform buys the person who allowed it nothing.
3. The user is asked once — one card for the whole call, however many tables it names, and once per call because `allowed-once` is the only grant the approval service has. Nothing has been requested of the backend when that card is drawn, so a person who refuses has had nothing of theirs read.
4. The table's dictionary is read, and every attribute the read names is checked against it: each column's `relatedMetaAttr`, each condition's `key`, and the attribute sorted by. One the table does not have is refused here, with the dictionary's own first ten names, because nothing downstream treats it as an error. A column would simply arrive without its key and draw blank in front of the user; a filter or a sort is the backend's to interpret, and a backend that ignores an unknown filter answers a read the user allowed as a narrowed one with everything up to the page size. The dictionary also supplies a header for every column the call wrote none for.
5. A block that named no columns of its own has them settled here, out of the table's default query scheme, and judged against the dictionary just read and against the thirty columns a table draws. A scheme this table cannot be drawn from is refused before a row is read, in words naming the scheme, because the call wrote no column for such a sentence to name.
6. The rows are read, one table after another, and each row is held to the columns the read takes, whoever settled them — the backend answers with the attributes it chose, putting its own row identifier in front of every set of attributes it is given. The first failure ends the whole call, and the rows already read are dropped.
7. The rows are put in, and the filled call is judged again by the same pass a hand-written one gets — this time for what only the rows can decide: how many arrived, and how many bytes the filled call is.
8. `content-component/resolved` records the whole filled entry.

Nothing is appended and nothing is drawn unless step 8 is reached, so every way of failing leaves the column exactly as it was — and the `tool/call` of a reading call records no entry either, because the blocks in its own arguments are missing the rows they are required to carry.

### What the user is asked

The card is Chinese, free of any term the console does not otherwise show a person, and carries the table's backend name on a line of its own — small print for someone who wants to check what was really asked for, out of the way of someone who does not. The example below is the card as it is written; the panel that draws it today runs those lines together, which the limitations at the end of this document record.

That identifier line is the only part of the card the model did not write, so nothing the model writes can reach it. Each table's description is cut to its share of a three-hundred-character prose budget **before** its identifier line and the closing promise are appended, so neither can be pushed off the card by a long header or a long label; and every word the model contributes to the card — `metaLabel` and each column header — is refused unless it is one plain line without a `「」` bracket, a control or format character, or a Unicode line or paragraph separator, so none can draw a line the card never wrote.

```
用您的账号查一份数据：从「图层配置」里取最多 200 条，只取「名称、图层id、所属地图主题」这几列。
数据表：SpaceLayer

取回来的数据画成表格放在右边，小助手看不到表里的内容；您在表里勾选的行，会作为您的选择告诉小助手。
```

Every table gets a paragraph and its own identifier line, however many there are. A block taking the table's default columns says that and no more — `取这张表默认显示的列` — because what decides them is the scheme, and the scheme is read with the very credential this card is asking for. A column is named by the header the call wrote for it, at most three of them and then a count; a column with no header of its own is counted rather than named, because the only other name it has is the attribute the backend keys it by and the dictionary that could translate that is not read until this question has been answered. Filters follow the same rule and never carry a value — they are named by header and strategy where every filtered column has a header, counted otherwise, since a condition can carry another person's identifier and the card's job is to say what is about to be read, not to repeat it. The last sentence is the one that must always be there: a ticked row leaves the panel through `/component-action` and reaches the model as the user's own answer, so a card promising the rows stay out of the conversation would be promising something this row does not do.

### What is recorded, and what the model is told

`content-component/resolved` carries the call id, the entry id, the title, the whole filled spec, and one `fetched` entry per table naming the block, the table, how many rows arrived, how many match, and which attributes the read asked for — which are the only ones the recorded rows carry, because a backend answers with the attributes it chose and this row keeps the columns the read takes. It carries no credential, no request URL and no trace identifier. It is the record the column replays from, for the same reason a view's click writes one: the rows are nowhere in the `tool/call`, and replaying by reading again would be a second read of a person's data at a moment nobody asked for it.

The model is told the same counts and attribute names, plus two things the record does not carry because they are read back out of it: which page it read, in a sentence of its own (`Page 3 of 5.` where the backend reported a total, `Page 3.` where it did not), and which of the attributes it asked for had no value in any row that arrived (`No value in any read row: layer_id, belong_map_topic.`, and nothing at all where every attribute had a value somewhere). Nothing out of any row is told either way.

<a id="the-catalog"></a>
## The catalog

One tool for every component, rather than one tool per component. Which blocks exist is a deployment's catalog, and a catalog is cheaper to state once inside a description than to spread across a growing tool list the model reads on every request. The catalog is a static table in `component-call.ts`; replace it with a registered seam when a package this one does not own needs to contribute a component.

Today it holds five entries:

| Component | 名称 | What it draws | What comes back | What another block can read |
|---|---|---|---|---|
| `el.confirm-bar` | 确认条 | an optional title, an optional message, and one to five buttons each carrying an id, a label, and an optional tone | `press`, carrying the pressed button's id | nothing |
| `toy.record` | 记录详情 | one to sixty rows, each a label of at most 64 characters and a value of at most 400, with an optional label width of 40 to 240 and an optional column count of 1, 2 or 3 | nothing | nothing |
| `toy.table` | 数据表 | one to thirty columns over one to five hundred rows, each column reading its cell out of a row by field name and optionally drawn by one of five cell renderers; optionally a selection column, clickable row names, up to five custom operation buttons, and an operation column width | `select`, `row-click`, `sort` and `operation` | `selectionDetail`, the first ticked row as label-and-value rows |
| `el.filter-bar` | 筛选条件 | one to forty attributes the user builds conditions over, optionally narrowed to some of the sixteen match strategies | `submit` and `change` | nothing |
| `el.metric` | 指标球 | one measurement from 0 to 100 drawn as a filling ball, with an optional word, size, and three colors | nothing | nothing |

An action and an output are two different things. An action is news the agent is told about and a record in the log; an output is a value that stays inside the panel, for another block of the same call to draw from. A table therefore reports a selection twice over — once to the agent, as the rows the user ticked, and once to the panel, where a record detail can be drawn from it without the agent being involved at all. An output is declared only where some property in this catalog accepts it: what a block reports and nobody can read would be a binding the model is offered and then refused.

A detail row's label is bounded by the field-name ceiling rather than a shorter number of its own, because `selectionDetail` is read into that list and a column with no header of its own contributes the field it reads. Two ceilings there would be a binding the catalog offers and then refuses.

A component reporting no action says so on its own line of the tool description — a model told a block answers back would otherwise place a display-only one and wait. Each component's properties are stated under that line, derived from its `propsSchema` rather than written beside it, so what the model is offered and what a call is judged against cannot drift apart and a model learns what to send without spending a refused call on finding out. The line goes all the way down: a nested list states what one of its items carries, because a list named without its item properties costs one refused call per property to discover. What it leaves out is every bound a refusal already states — a string's length, a token's alphabet — because the description is paid for on every request and a refusal is paid for once.

A record's row keeps its place when its value is the empty string: the component draws the label with nothing beside it, which is what an attribute the record has but does not fill looks like.

A component's properties are declared as a small schema of seven shapes: a bounded string (optionally restricted to an alphabet), a number in a declared range, `true` or `false`, a fixed set of strings or numbers, an object of further declared properties, an object whose keys are the caller's own, and a bounded list of any of those. A list whose items are something the user points at also names the item property that identifies them; a list nothing comes back from — the rows of a record — declares none, and two rows sharing a label are the data rather than a mistake. That union is the security boundary rather than a convenience, for the reason the trust section below states.

The caller-keyed object is what a table row is: the keys are the field names the columns read, so they cannot be listed in advance the way a component's own properties are. It is bounded instead — an alphabet and a length for the keys, a count of them, and scalars only for the values — and the description writes it as `{<field>: text|number|boolean}`.

What a schema cannot say is what a string *means*. A component that reads one as a path, a color, or the name of a cell renderer declares that reading beside the schema, from a closed list of three, and [`src/sanitize.ts`](src/sanitize.ts) enforces it on the way in: a path that is not one same-origin path and a color outside `#RGB`, `#RRGGBB`, `rgb()` and `rgba()` are dropped, and a renderer name outside the whitelist falls back to the plain renderer rather than leaving a cell with nothing to draw it. A declared reading is stated in the description, because the pass drops the value rather than refusing the call and a model that is not told the notation is never told why what it sent disappeared. The renderer name is also declared as a fixed set, so a call naming one outside it is refused and the fallback is left for a stored record written against a catalog whose whitelist has since narrowed. The table declares the renderer name, the metric ball declares its three colors, and `path` is the one reading nothing declares yet; the pass runs regardless, because the alternative is a rule that arrives with the first component that needs it and has never run before.

A caller-keyed object declares its own readings rather than sharing its component's, because its keys are data: `color` is a configuration key of a cell renderer and also a perfectly ordinary column of somebody's records, and a rule keyed by name at the component level would tighten both.

<a id="what-a-call-is-judged-against"></a>
## What a call is judged against

In order, and each step can end the call: the entry `id` and the `title`; the spec's nesting depth; its size in bytes; the properties a spec and a node may carry at all; every node's id, its uniqueness within the call, and the component it names; every property of that component; then the layout over those nodes; and last the properties one node reads from another.

The last two come last because both are about the whole spec rather than about one node: which nodes exist, and what each of them reports, is not settled until every node is in.

An accepted node leaves that judgement with its properties already tightened, because validation is the one path all three readers take — the tool, the fold over the log, and the browser seat — and a second pass a caller has to remember to run is a second pass that eventually is not run.

Depth is measured before size because both walk the document and only the depth walk is bounded by construction — it stops at the ceiling rather than at the bottom of the value. The ceiling is the deeper of the two documents a spec carries — a node's properties, and the layout tree — plus one layout level of slack, so a layout that opens one stack too many is refused at the stack that opened it rather than answered with a sentence about how deep `spec` may nest.

Every refusal names the offending parameter path, because that path is the only channel the model has: a call carrying twelve nodes gets one sentence back, and unless the sentence says `spec.nodes[3].props.buttons[1].id` or `spec.layout.children[1].children[0].id` the next call is a guess. A call naming a component the deployment does not have gets the whole catalog back rather than a count, so the correction needs no extra round trip.

<a id="how-the-blocks-are-arranged"></a>
## How the blocks are arranged

A spec with no `layout` is the flat reading it always had: the blocks drawn top to bottom in the order the call wrote them, which is what keeps every spec written before layouts existed drawable. A `layout` is a tree of stacks, and a stack is the only primitive there is — a direction, one of three gaps, whether it wraps, and for each child placed in it the share of the stack it takes. A child is a block or a further stack, and both ask for their share under the same name: what divides a row is its children, whichever kind they are. The outermost stack asks for none: it fills the entry on its own, so a share written on it would divide nothing, and it is refused by name rather than accepted and ignored. Nesting expresses every arrangement of rectangles a panel needs, and the two candidates for a second primitive are not ones: a grid is that same nesting, and a tab strip is what the content column already does with entries of its own.

Every node is placed exactly once. A node the tree leaves out is a block the call paid for and nobody sees; one placed twice is two blocks sharing one identity, and that identity is what a reported gesture names and what the seat memoizes a block on. Both are refused, the first at the node and the second at the second position that named it.

The ceilings are twelve nodes, twelve children per stack, and four stacks open at once. The node ceiling is what bounds the tree: every leaf is a node, every node is placed once, and a stack must hold something, so a layout cannot be wider or busier than the spec it arranges.

The host judges shapes and ceilings and understands nothing else about a layout. What a stack looks like is the seat's, which is why the direction and the gaps are words rather than measurements.

<a id="what-one-block-reads-from-another"></a>
## What one block reads from another

A property may be written `{"$from": "node:<id>.<output>[<index>]"}` instead of a value, and then it stands for whatever that block currently reports. The reference is the whole vocabulary: one node, one of its declared outputs, optionally one item of it. No expression, no condition, no loop — the value is assembled in the seat, inside the shell's own origin, and a language evaluated there is a template engine nobody asked for.

The host judges the reference and never the value. That the source node is placed by this call, that it is not the block being written, that the output is one the component declares, that an index is one the output could hold, and that what the output carries is something the receiving property accepts — all of it from the catalog, before anything is drawn. What the property will actually hold is the seat's, and it never reaches the log: a selection that drove a detail block is not model-visible input, so nothing about it has to be recorded.

Whether an output fits a property is decided by kind and by ceilings — the same kind, and nothing it may carry past what the property accepts: a longer string, a wider number, a value outside the fixed set, more items, more keys. Floors are deliberately not compared, and neither is whether a list's items repeat. An output is what the user has done so far, so how many items it lists and whether two of them are the same are facts about a moment rather than promises, and a property waiting for its first item draws the seat's waiting line rather than a value.

A property the component reads as something narrower than text cannot be bound at all, at any depth. The tightening pass runs on the way in, over the value a call wrote out; a bound property has no such value, so a path, a color or a renderer name declared under it would be a reading nothing performs. The refusal names the property, and the value it wanted is one the call can write out itself.

A property the host itself reads back cannot be bound either, and the refusal says which property it is and why. A table's rows are the case: what a reported gesture is named against — the row that was ticked, the column that was sorted — is read out of the call that wrote the rows, and a resolved value lives for one render of one page and reaches no record. So a table cannot be fed its rows, and the one binding the catalog offers is a table's `selectionDetail` into the record block beside it.

Values therefore travel one way. Every component that reports something reads its own properties back, which leaves nothing to write into it, so no chain of bindings can close and nothing here looks for one. The catalog is held to that by its own test rather than by a runtime pass.

A binding is a whole property's value or nothing. `{"$from": …}` inside a list item or a nested object is refused where it sits, and the reason is that the alternative is a walk over every value looking for references — in the seat, on every redraw.

<a id="one-entry-several-calls"></a>
## One entry, several calls

A call owns the entry its `id` names, written in the same alphabet as a node id — letters, digits, underscores and hyphens. Calling again with the same id replaces what that entry shows — both calls stay in the transcript, because the log is what happened, but the column shows one block under one tab in its switcher strip. A different id adds a second entry beside it.

The fold recognizes three log shapes. Two are a call: a top-level `tool/call`, whose `arguments` is raw JSON, and a Code Mode `tool/code-dispatch-start`, whose `arguments` is already decoded — a model reaching the tool through `run_code` logs only the second. The third is `content-component/shown`, the click that opened a configured view. All three answer with the same three values, so an agent correcting the block a user opened lands on that block rather than beside it.

A call the tool refused is still in the log — the loop records the call, not its outcome — and the extractor runs the same judgement over it, so a refused call records no entry rather than an entry the seat has nothing to draw. A view's event takes the identical pass: its spec was judged once at load, and judging the record too is what keeps one reading of the log.

Resolving a stored record consults no catalog. The catalog is a build-time table that grows and changes, a persisted checkpoint written before a component was renamed must still resolve, and it is the seat — which knows which renderers it actually has — that reports a block it cannot draw. What resolving does check is that the record carries the two fields it reads. A checkpoint is plain JSON whose declared type is a claim, and one throw there would cost the column not this entry but every kind's entries at once, so a record this build cannot read resolves into an entry the seat draws its notice for.

<a id="what-comes-back"></a>
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

<a id="trust"></a>
## Trust

`spec` is model output that becomes a rendered block inside the shell's own origin. It is bounded rather than trusted, and the first bound is the property schema: no member of that union can express markup or a function body, so a model reaching for a `formatter` or an `onClick` is refused by the absence of a property to write it into rather than by a sanitizer that recognized a function body. A property the component does not declare is refused outright rather than dropped, so a model writing one learns that it did, and the refusal names it.

The second bound is the tightening pass above, and it covers what a schema cannot state: a declared reading is enforced value by value, and a value outside its reading is dropped from the block rather than refused to the model, because the pass also runs where no model is waiting — over a stored record on the way to the seat. The pass drops undeclared properties too, which through validation can never happen; that arm is what a record written by another build gets.

The browser seat re-runs the identical judgement over the payload arriving on the wire, which is why the catalog and the validator sit in modules of their own that import nothing but each other: the seat reads them without pulling a tool runtime into a page, and the two halves cannot drift onto different rules.

What the pass answers with is frozen, deeply. A renderer may draw a block with a Vue 2 component, and Vue makes a component's props reactive by rewriting them property by property — which would leave the seat's own memo and the Vue tree disagreeing about what changed. Vue walks past a frozen value, so freezing on the way out is what settles it, for the React renderers too: what a renderer is lent, it may read and may not write.

<a id="the-seat"></a>
## The seat

The browser half is one keyed registration: `component` of `content.surface.kind`, the content column's open key domain. The seat draws the entry's title over the blocks the call placed, arranged the way the spec's `layout` says and stacked top to bottom in call order when it says nothing, and draws nothing while another kind holds the column, which reaches it as no entry at all. What `visibility` keeps mounted there is the column's wrapper for the kind, not the blocks, whose DOM goes with the draw.

The arrangement is nested flex rows and columns and nothing else: a direction, one of three gaps, whether a row wraps, and a share of what is left over on each block. Reading it in the seat is a second reading rather than the judgement — the host has already named the path it refused, in a sentence the model can act on, and what runs here has nobody to tell — so a tree this build cannot make sense of falls back to the plain column instead of blanking the entry. The vocabulary both readings accept is one declaration in `component-call.ts`.

Before drawing, the seat runs the call's own judgement over the payload again. That is not distrust of the host it ships with: an entry's payload can arrive from a persisted checkpoint written by a composition whose catalog and ceilings were not this build's, so the type it comes with is a claim. The check is the same import-free module the tool judged the call with, which is why that module imports nothing. A payload this build does not accept becomes one sentence in the column instead of blocks.

### What one block lends another

A block publishes its own current reading of itself — the row a table has ticked, laid out as a record's rows — through `onOutput`, and the seat keeps those values in React state for as long as the call that placed the blocks is on display. A property written `{ "$from": "node:<id>.<output>[<index>]" }` stands for whatever the named block last published, and the substitution happens in the page: the resolved value never enters the payload, never reaches the host, and never reaches the session log. That is what lets a record follow a table's selection without every tick becoming model-visible input something has to record, and it is why the vocabulary is one reference with no expression, no condition and no loop.

The seat resolves before it judges, so the value a block is drawn from goes through the same schema the call was judged against. That matters because a published value is not a value any host judged: the host checked that the output *could* stand where the property is declared, never what it would carry. A block whose required property has nothing to stand for it yet is left out of the judgement rather than failing it, and draws the component row's waiting line in its place; a value that does not fit where it was put leaves the fed blocks waiting the same way, so the blocks nothing fed still draw.

A later call under the same entry id starts with nothing published, because the blocks it draws have published nothing: carrying the previous call's values across would feed a new record block the rows of a table that is gone.

Each block is memoized on its own identity — its entry, that entry's owning sequence, the node, the gesture the fold records against it, and, for a block that reads from another, what its references resolved to — so a block nothing feeds keeps the object it already had when the seat re-reads the payload because some other block published something. That is not an optimization: `el-table` reads a new row list as a table whose rows have been replaced and clears the selection, so a table handed fresh properties every time the block beside it was fed would drop the tick that fed it. The renderer comes from the component row's table by the catalog id the node names; a table with no entry for it says so in that block's place, which is what a deployment composing a mismatched row sees.

The seat carries no dictionary. It translates through `componentKit`, the component row's namespace, because the sentence shown in place of a block belongs with the components rather than with the package that placed them.

## Model Experience

### The `show_component` offer

#### What the model sees

One tool, `show_component`, with a required `id` string, a required `title` string, and a required `spec` object carrying a required `nodes` array and an optional `layout`. The description carries the whole catalog as two lines per component: `- id — label — purpose`, with `Nothing comes back from it.` on the line of a component that reports no action, and beneath it a `props:` line naming every property that component declares — `?` on the ones a call may omit, `(min–max)` on a number, `(a|b|c)` on a fixed set, `(true|false)` on a yes-or-no, `[what one item is] (min–max)` on a list, `{…}` on an object of declared properties, and `{<field>: text|number|boolean}` on an object whose keys the model chooses. A component another block can read from carries a third line, `outputs:`, naming each value and writing its form in the same notation, which is what makes a binding writable: the reference names one of those ids, and whether the property it is bound to accepts the value is decided against the form on that line. Then the reuse rule for `id`, the node and byte ceilings, the refusal rule for undeclared properties, one paragraph on the layout tree and one on reading another block, and the sentence naming what comes back: what the user does inside a block reaches the model, with the entry and the block it happened in, unless that component's line said otherwise. The component labels in that list are the Chinese names the end user reads, so a model naming a block in conversation names it the way the user sees it. This package contributes no system-prompt section. Where the deployment composed a data source, the offer carries one further optional `dataSource` array and one further paragraph: the fields of an entry, the sixteen match strategies by name, the row and page fields, that a named block sends no rows of its own while its `gridItems` say which attributes to read and that leaving `gridItems` out takes the columns the deployment shows for that table by default, that the user is asked once per call and a refusal draws nothing, and that what comes back is a count, a list of attributes, the page read and the attributes that were empty in every row rather than the rows themselves. Where it composed none, neither the parameter nor the paragraph exists, so those deployments' request bytes are unchanged.

#### Token effect

One fixed description plus the parameter schema, on every request where the tool is visible. The description grows by two lines per catalog entry — three where another block can read from it — the second as long as that component's whole property tree; the table's line is the longest, because its columns are a list inside an object. The `spec` schema stays shallow — one object, one array, and one unconstrained `layout` — because the per-component properties are in the catalog lines and the layout's own vocabulary is in the description, rather than in a nested JSON Schema.

#### KV Cache effect

The description is assembled once when the row loads and depends on nothing but the catalog, so the tool block is byte-identical across every request in a deployment and the prefix holds.

### Tool-call result

#### What the model sees

An accepted call answers `Now showing "<title>" in the content panel: <labels>.` followed by the sentence naming the id to reuse. A refused call answers `Error: show_component: <path> — <what is wrong and what to send instead>`, and for an unknown component the whole catalog again, property lines included, so the corrected call needs no second refusal to learn what the component it picks instead accepts. A call that read its rows adds one sentence per filled block — `Read 20 of 89 matching rows from "SpaceLayer" into block "rows", for the attributes zh_label, layer_id. Page 1 of 5.` — and nothing out of any row. A read that did not happen answers one sentence saying which of the seven ways it did not: no credential is held, the user did not allow it, the backend answered something else, the table has no attribute by that name (with the dictionary's own first ten, so the next call needs no second refusal either), the table's own default query scheme cannot fill a block that named no columns, nothing matched, or the rows that arrived are more than a spec carries.

#### Token effect

One short line per call. A refusal naming an unknown component is longer by the length of the catalog, which is the point: it replaces a second failed call.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

## Known Limitations and Deferred Work

- **Row-level trimming is the backend's, and this row cannot prove it happens** — the deployment's own frontend has a row and column permission pass, but with no signed-in profile it returns early and opens the data up rather than closing it down, so it is not a boundary. If the backend does not trim rows against the token it was handed, one read can draw rows a person was not meant to see onto that person's screen and write them into that person's session log — and signing out does not clean a log already written. Closing it needs an answer from whoever owns that backend, not code here.
- **The identifier line is written on a line of its own and is not drawn on one** — the approval panel renders the reason's line breaks as spaces, so `数据表：SpaceLayer` reads as a clause inside the sentence rather than as small print beneath it. Everything that makes that line trustworthy still holds — it is the one part of the card no word the model wrote can reach — but a person checking the card has to find it inside a paragraph. Keeping the line breaks is the panel's to do.
- **The table's name on the card is the model's word for it** — `metaLabel` is written by the call, not read out of the backend's dictionary. The dictionary is only read after the user has already answered, so a model that mislabelled the table has already been believed. Reading a name before asking would mean spending the credential before the question, which is the one order this row will not take. What the identifier line beneath it can do is let a person notice the mismatch; what it cannot do is stop a plausible wrong label from being read as right.
- **A header is the dictionary's only where the call wrote none** — a column carrying `alias` keeps it, whatever the backend calls that attribute. A model naming a column something it is not is therefore visible only to someone who knows the table.
- **A read that fails leaves the previous table on screen, with nothing saying it is stale** — the entry is untouched, so a replacement that could not be read shows what the last successful call put there. The model is told and should say so in the conversation; making the block itself say it needs the entry to carry a staleness bit, which is another change.
- **This row asks for fewer columns than the deployment's own page does** — the component library sends every column of a scheme, hidden ones included; a call here sends the columns it declared, or, where it declared none, the shown columns of that scheme. That is a deliberate narrowing, not a failed alignment, and it is why a table drawn here can hold less than the same table on the deployment's own page.
- **Rows in the log are checkpoint weight** — a filled spec is up to 65536 bytes, once per live entry, carried in every checkpoint the content surface writes. It is the same cost a chart's whole option document already has, and this route pays it per read.
- **The card says the page size, never the page number** — a read of page three is described to the user as `取最多 200 条`, the same words a read of page one gets. What the model asked for and what the user is told about it therefore differ on which rows, and only on which rows; the identifier line and the column list are unaffected.
- **A view the deployment wrote cannot read its own rows** — `dataSource` is a parameter of the call, so a view configured in `cordis.yml` carries whatever rows the person who wrote it typed there and nothing else. A console whose home view is meant to show live data has no way to say so today. Giving a view its own read means asking the user at click time rather than at call time, since a configured view has no model turn to hang the question on, and that is the next slice rather than this one.
- **A cell the table cannot draw is dropped, not refused** — the rows are text, numbers and yes-or-no; a null, a nested record or a list is left out of the row rather than failing the read, because an absent cell is what a table already draws for one. Where the backend returns a different number of stored rows than displayed ones, the stored rows are left out entirely, since the table's two lists stand one for one.
- **No service account, by decision** — a session with no signed-in credential is refused and the visitor signs in. The alternative would make the approval card's first three characters, 用您的账号, untrue for whoever the fallback account turned out to be.
- **A read's record is required on read** — `content-component/resolved` carries no `ignorable` marker, for the same reason `content-component/shown` does not: `Session.append` gives an appending plugin no way to set one. Every build of this repository knows the type.
- **The payload whitelist is the block's own promise, not something the host enforces** — the command registry records a command's input verbatim before any handler runs, so an over-full action document is in the log by the time this row refuses it. What the host still enforces is the byte ceiling and the declared properties: past the ceiling, or carrying a property its action does not declare, the action is not delivered to the agent at all. Sending only what the action declares is the seat's obligation, and both halves ship here.
- **The transcript row names the mechanism rather than the block** — a notice arrives as a collapsed row headed `上下文注入 · content-component` (`Context injection · content-component` in English), a term and a plugin id in front of an end user, and the one-line summary beside them is a flexible cell that the console's three-column chat width squeezes to nothing. Expanding it is no better: what it opens on is the model-facing English sentence with the internal identifiers inside it — `The user pressed "Approve" in content panel entry "budget" ("Budget approval"), on the 确认条 block "ask".` — which is the account written for the agent, shown to the person who made the gesture. Both the row and the body are drawn by [`ui-conversation`](../../client/ui-conversation/README.md) for every producer alike; the review trigger for all of it is the `develop`-line change that gives a producer its own display name, which is where per-producer copy for the expanded body belongs too.
- **The command is in the end user's slash menu** — `commands.register` has no way to keep a row out of the menu the composer offers, so `/component-action` is listed there with the hint `<json>` beside it, in a product where every other row is something a person is meant to type. What that row can be is a sentence saying it is not: the description is end-user Chinese naming the buttons in the content panel and saying the page sends it. A line typed there by hand resolves against nothing and answers with the same refusal a lost press gets — and, where it is well-formed enough to name an entry and a node, it repaints that block with that refusal, because the gesture fold reads the identifiers a line carries and only the handler resolves them against the entry on display. Keeping it out of the menu is a `dsh-commands` change — one `listed` field on the descriptor — and it belongs with whichever row needs it second.
- **The wake budget is memory** — spent wakes live in a table keyed by the agent object, so a restart hands every agent a full budget again and a resumed session cannot tell how many turns its presses had already opened. The table of unclaimed `context` notices is keyed the same way and forgotten the same way: after a restart the first tick of a block queues a second notice beside the one the log still holds, which costs the model one superseded sentence and nothing else.
- **A press with nothing complete in it looks like a button that does nothing** — a filter bar starts holding one empty condition row, so the first press a user can make submits nothing; that press reports nothing, and the block draws no line about it either, because a line would say something happened. What the user gets is a button that answers a press with no change on screen at all. Greying the button out is the fix and it is not local: the block would have to know how many complete conditions the editor holds, which is the `change` gesture's own count, and drawing state off a count that arrives on every committed edit needs the two packages to agree about when the button may move. The trigger is the first report of a press that seemed to do nothing.
- **A block cannot say *why* a gesture was refused** — the fold settles a refused gesture into one state, so the block draws 这个动作没能记下来，可以再试 whether the action named nothing on display or carried more than it accepts, while the chat row beside it draws the handler's own 内容太多了，少选几项或写短一些再试。. The two disagree in front of the user about the same press. Telling them apart on the block needs a further `ComponentActionState` member, which is a contract between this package's fold and [`component-kit`](../component-kit/README.md)'s state table and dictionary; the trigger is the first deployment where the chat row is not beside the block.
- **The gesture fold is per block, not per action** — one cell per `(entryId, nodeId)`. It is enough today only because a component declares at most one `wake` and nothing else reaches a cell: the day one declares two, a block will draw the state of whichever of them it reported last. Growing the cell key by `actionId` is the fix, in [`src/action-state.ts`](src/action-state.ts) and the projection beside it, and it is what the second `wake` on one component pays for.
- **A press the log opened and never closed reads as on its way forever** — `command/run` and `command/done` are written either side of the handler, so a host that stops between them leaves a cell open, and nothing closes it afterwards. That block stays unpressable until a later call replaces the entry. A press that produced no record at all is the other case and settles itself: the dispatch says so, the page drops its row, and the block is answerable again.
- **The settlement sentences are Chinese in any interface** — `这个动作没能记下来。`, `内容太多了，少选几项或写短一些再试。` and `已记下，你下次发消息时对话会看到。` are written by the handler, which is handed no browser locale: a command result is one string, and the session log has to keep the words the user was actually shown. In a non-Chinese console they are drawn in the chat row beside a bar whose own lines came from [`component-kit`](../component-kit/README.md)'s dictionary and are localized. The fix is either a key the client translates or a locale carried on the command result, and the trigger is the console offering an interface in any other language.
- **The return channel has no assembled-transcript coverage** — the `snapshots/console` lane drives an ACP agent, and the ACP protocol has no command method, so no recorded transcript can carry a press. The lane composes the command registry regardless, because the description it pins tells the model a press comes back; the press itself is covered by the Playwright scenario against a real console composition, where the browser, the RPC gateway, the command registry, and the session log are all the shipped ones.
- **The model cannot see what the panel holds** — there is no read path. The agent knows which calls it made, not which entry the user is looking at, whether one was dismissed, or what any block currently shows.
- **An output is declared where a property takes it, and only there** — the catalog holds one: a table's `selectionDetail`, which a record block's `dataList` takes. A table also knows the ticked rows in the form the call wrote them, and a filter bar knows the conditions it holds, and neither is declared, because no property here accepts either — an output nothing accepts is a binding the model is offered and then refused. Each is declared with the component that takes rows or conditions as an input: a catalog line and the renderer's `publish` call together, since neither renderer publishes one now. The rest of the catalog reports nothing at all, and a binding naming one of them is told so.
- **A property read as something narrower than text cannot be bound** — a path, a color, or a cell renderer name is read on the way in, over the value the call itself wrote; a bound property has no such value, so the whole property is refused rather than reaching a renderer having skipped its reading. That covers the property at any depth, which is why a table's `tableConfig` cannot be bound at all while its rows can.
- **An empty output leaves the blocks it feeds on the waiting line** — compatibility is kind and ceilings only, so a binding to a table's `selectionDetail` is accepted while nothing is ticked rather than the call being refused for a list the user has not made yet. The floor is still there at draw time: every bindable property in this catalog requires at least one item, so an empty selection substituted into one refuses the judged document, and the fed blocks draw the waiting line until the user ticks a row. Comparing floors statically instead would refuse the binding outright, which is worse: the pair could never be written at all, because a selection is empty until the user does something.
- **A binding reads one block, never a second entry and never an expression** — `$from` names one node, one of its declared outputs, and optionally one item of it. There is no arithmetic, no condition, no default, and no way to reach a block of another entry, because the seat's own props carry one entry at a time. A model that wants a value computed writes the value.
- **The arrangement is read twice, by two modules that must agree** — the host judges a `layout` and names the path it refused; the seat reads the same tree again at the wire edge, because the pass judging its nodes runs over the drawable ones alone and `layout` is kept out of that pass, and it answers a tree it cannot read with the plain column. The two share every word list — the directions, the gaps, the ceilings, and the keys each kind of node may carry — so what is written twice is the walk itself, and a rule of the walk added to one and not the other shows up as a call the model was told was fine and a column that ignores it. Collapsing them means exporting a layout reader beside the judgement, and the trigger is the second rule that has to be written twice.
- **A waiting block says only that it is waiting** — a block whose required property has nothing to stand for it draws one line, and so does a block whose value did not fit where it was put. The user cannot tell "tick a row above" from "what was ticked cannot be drawn here", and the second is a mistake in the call rather than something the user can act on. Telling them apart needs a second sentence and a way for the seat to know which case it is in past the refusal it already discards.
- **An empty value is drawn as an empty value** — a `toy.record` row whose `display` is the empty string keeps its label and shows nothing beside it. That is deliberate: the alternative reading, dropping the row, hides from the user that the record has the attribute at all. A model that means "this attribute is not set" writes the words for it.
- **Five catalog entries** — the mapping from the rest of a real component library to catalog entries, and the packaging that gets those components into a browser bundle, are separate work.
- **No component declares a `path` yet** — the reading is enforced and tested, and the first component that addresses an asset is what puts it on a screen. The renderer-name and color readings are declared, by the table and the metric ball.
- **One match strategy has no evaluator** — the sixteen a call may narrow to are the sixteen the condition editor draws, because a strategy the user can pick and this package cannot name is a filter the person builds and is then told was not recorded. `NOT_BETWEEN` is the one the component library's own `matchUtil` has no branch for, so a condition carrying it reaches the model as an account of what the user asked for and a backend that is asked to run it answers for itself. Nothing in this package evaluates a condition.
- **A filter offers no AND/OR unless the call asks** — `confStyle.showMatchMode` is off unless a block turns it on, because the control is worth drawing only where the answer carries it. A bar that does draw it submits the mode beside the conditions, and the notice states which of the two the user chose.
- **A table of five hundred rows rarely fits** — the row ceiling is the table's, and `spec` is capped at 65536 bytes, which a table of a few hundred rows with several columns reaches first. The refusal says so and names the byte count. The action ceiling bites the same way from the other side: a filter submitting ten conditions of two hundred characters each is past 4096 bytes and is answered with the sentence saying the content was too large. Ticking every row of a full table is not one of those cases — the selection ceiling *is* the row ceiling, and the byte ceiling is set wide enough to carry it.
- **The condition editor has no ceiling of its own** — a filter bar submits at most ten conditions, and the vendored editor adds rows for as long as the user presses its add button. An eleventh condition is therefore built without anything on screen saying it cannot be sent, and the press that sends it is answered with the sentence saying there is too much. The block itself says only that the gesture was not recorded, because the settlement it folds carries no reason; the reason is in the chat row beside it. Capping the editor needs the ceiling on the renderer's side of the seam, and this package cannot hand it one — [`component-kit`](../component-kit/README.md) draws blocks for whoever places them and must not import a placement package.
- **The value control's kind depends on a field this schema does not carry** — an attribute's `dataType` is read by the condition editor only when that attribute also says its values are typed in rather than chosen from a service. This package declares `dataType` and not that field, so supplying it is the renderer's; a renderer that does not draws every condition as a plain text input whatever `dataType` says.
- **No block's own input survives being unselected** — the seat draws the selected entry alone and nothing at all while another kind holds the column, so switching kinds, or switching between two `component` entries, discards whatever the user had typed into the blocks that were on display. A reported gesture does survive, because it is in the log rather than in the block.
- **An entry this build cannot fully accept shows nothing at all** — the seat re-judges the whole payload, so one node naming a component this catalog no longer carries costs the entry every block it could have drawn, not just that one. The one exception is a block fed by another: what it was fed is a value from the page rather than from the call, so a value that does not fit leaves the fed blocks waiting and draws the rest.
- **The ceilings are protocol constants, not configuration** — the configuration section above states why, and what has to exist before they can become a deployment's choice.
- **A view click's record is required on read** — `content-component/shown` carries no `ignorable` marker, because `Session.append` gives an appending plugin no way to set one, so a runtime whose session vocabulary excludes this package refuses a log holding one rather than skipping the event. Every build of this repository knows the type; a separately built runtime that dropped this package would not. The console's other two content rows are in the same position, for the same reason.
- **A deployment with no views serves no catalog route** — the route and the command are claimed only where `views` has an entry, so a sidebar asking a deployment that configured none gets whatever the webserver's fallback answers with rather than an empty catalog. That is the same answer it gets where this row is not composed at all, and it is a case the sidebar already contains; what it costs is that the two cannot be told apart.
- **A view click has no assembled-transcript coverage** — the `snapshots/console` lane drives an ACP agent and the ACP protocol has no command method, so no recorded transcript can carry a click, exactly as none can carry a press. The lane still configures a view, because the load-time judgement over it is part of what booting that composition proves; what a click then does is covered by this package's own composition suite and by the Playwright scenario against a real console.
- **A stored entry carries its whole spec** — the column's projection keeps the validated spec per live entry, so it rides the wire value and the persisted checkpoint. The byte ceiling is what bounds it.
- **The invariant reports through the dispatch path only** — `Session.append` reports a throwing listener to the logger and carries on, so the live audit reaches a caller only where a committed event is dispatched through the context. The startup audit over loaded sessions is unaffected.
- **The drawn block is not covered by an assembled snapshot** — the tool's whole model-visible surface, the catalog spliced into its description and the result line included, is pinned by the [`snapshots/console`](../../../snapshots/console/README.md) lane, which composes this row for real and runs a call end to end. What the seat then draws is a Playwright scenario against a real console composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
