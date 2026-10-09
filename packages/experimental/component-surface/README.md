---
description: "`show_component`: the agent places a block of interface — a prompt with buttons, a record, a table, a filter row, one number, the deployment's own data page — in the content panel from a catalog this package owns, and a user's press comes back through the `/component-action` command; for deployments configuring their own views and the maintainers of that surface."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-component-surface

English | [中文](README.zh.md)

## Summary

`show_component`: the agent places a block of interface — a prompt with a row of buttons, the details of one record, a table of them, a row of filter conditions, one number, the deployment's own full data page for a table — in the content panel beside the conversation, chosen from the catalog this deployment's composed component plugins registered and judged against that catalog before anything is drawn.

## Table of Contents

- [Composition](#composition)
- [Configuration](#configuration)
- [Views the deployment writes](#views-the-deployment-writes)
  - [Views another package ships](#views-another-package-ships)
- [Rows read from the deployment's own data](#rows-read-from-the-deployments-own-data)
- [The deployment's own data page](#the-deployments-own-data-page)
  - [A view may place a form page and an info card beside it](#view-placed-components)
- [The catalog](#the-catalog)
- [What a call is judged against](#what-a-call-is-judged-against)
- [How the blocks are arranged](#how-the-blocks-are-arranged)
- [What one block reads from another](#what-one-block-reads-from-another)
- [One entry, several calls](#one-entry-several-calls)
- [What comes back](#what-comes-back)
- [Acting inside the entry on display](#acting-inside-the-entry-on-display)
- [Trust](#trust)
- [The seat](#the-seat)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="composition"></a>
## Composition

The package is both halves. The host half owns the catalog registry, offers the tool, validates each call, and claims the `component` kind of the [content surface](../content-surface/README.md)'s entry stream; the browser half owns the renderer registry, claims the `component` key of the content column's `content.surface.kind` slot and draws each entry's spec. Neither half owns a component: a component plugin registers its definition and its renderer together, and this package is what puts one of its blocks in a column. [`component-kit`](../component-kit/README.md) is the one this repository ships, and a deployment that composes none is offered no `show_component` at all.

What the user then does inside a block comes back the other way, through one command this row owns: `/component-action`.

The same column also takes blocks nobody asked the model for: a deployment writes views of its own, the shell's sidebar lists them, and a click puts one there, without the model being asked anything.

Nothing the agent does appends a session event. A call's record is the `tool/call` the loop already writes and an action's is the `command/run` the command registry already writes, so both directions replay from the log the agent actually wrote. The one event this package writes is the user's own: the click that opens a configured view.

[`overlay/component-surface.patch.yml`](overlay/component-surface.patch.yml) inserts this row and the component row over the service-line console composition, which already carries the content surface and the content column. The overlay's own comments carry the launch line.

The row activates in three independent pieces, all of them behind the catalog. The tool needs a tool runtime and at least one registered component, so a composition with no content column still offers it and still records its calls, and one with no component plugin offers nothing at all — the description's whole substance is the component list, and a list with no entries is an offer the model could only spend a refused call discovering. The extractor needs the content-surface router; without it the calls are in the log and no column reads them, which is exactly what a composition growing a column later wants. The return channel needs all three of the command registry, that router, and the projection registry the entry is read out of — with no column there is nothing on screen for an action to name, so the command is absent rather than answering every gesture with a refusal.

Every one of those is rebuilt when the catalog moves: a component plugin loaded later widens the description, the judgement and the fold together, and one disposed narrows them the same way. The changed description reaches the log the way every description does — the request header records the assembled tool schemas verbatim, so a re-registration is a header the next request is reconstructable from and this row still appends no session event of its own.

The opposite direction is `act_component`, the tool that runs steps inside the entry already on display. It is offered only where the shared content channel is composed: a host cannot address a browser, so the call reaches the tab over the claim and report routes [content-frame](../content-frame/README.md#the-channel) provides — `ctx.contentChannel` on the host and `ctx.contentTabChannel` on the browser. A composition carrying this row with no content-frame therefore offers `show_component` and no `act_component` at all, which is what the model sees as the tool simply not existing. The channel lives in that row rather than in a package of its own today, and moving it out is deferred work recorded in [Known Limitations](#known-limitations-and-deferred-work).

<a id="configuration"></a>
## Configuration

Eight fields. `views` and `homeView` are about blocks a person wrote rather than about anything the model does, and the next section is their whole documentation. `dataSource` and `dataDefaultPageSize` are about rows the model asks this deployment for rather than writes out, and the section after that is theirs. `dataPage` and `dataPageLoadTimeoutMs` are about the deployment's own page being opened in the panel instead, together with the two blocks a view places beside it, and the section after *that* is theirs. `actClaimTimeoutMs` and `actTimeoutMs` are the two deadlines an `act_component` call waits with, and [Acting inside the entry on display](#acting-inside-the-entry-on-display) is theirs. Everything else is fixed.

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

Every view is judged by the pass that judges a call — the same catalog, the same ceilings, the same alphabet for an id — so what a deployment may write is exactly what the model may send. A view that would not survive that judgement takes down everything this row offers, and says so at error level under the row's own logger name, naming the view a person has to go and edit, the value inside it, and what the refusal cost:

```
component-surface: views[0] "site-overview" — spec.nodes[0].component — names no component of this deployment. Available components: …; this deployment comes up with no components, no views and no show_component tool until that view is corrected or removed
```

Loud rather than skipped, because a view quietly dropped is a menu row that shows an empty column when a user clicks it, with nothing anywhere saying why, and because every other trace of this failure is an absence. A repeated id and a `homeView` naming no configured view fail the same way.

<a id="views-another-package-ships"></a>
### Views another package ships

A view can also come from a package rather than from `cordis.yml`. `ctx.componentViews` is the index both end up in: the deployment's own views first, then each registered source in registration order, and a click shows either one the same way. [`skill-pack-components`](../skill-pack-components/README.md) is the source there is — it offers the views of every active skill pack and re-offers them whenever the pack set moves, so a pack activating puts its views in the sidebar and a pack going inactive takes them out, with no restart.

What differs between the two is only what a refusal costs. A view the deployment wrote is its own configuration, so a refusal fails the row. A view a source contributed is somebody else's file: it is dropped from the index with one error line naming the source and the value, because failing the console over an installed file would take the component contribution that completed the catalog down with it. An id two contributors claim is the same: the first claim wins — the deployment's own always — and the later one is dropped with a line naming both.

A contributed view may also carry `params`, and then a property written `{"$param": "<name>"}` anywhere in its `spec` stands for that entry of them. The substitution happens when the view is read, not when it is shown, so what the catalog judges is what will be drawn and everything downstream sees an ordinary spec. A name the view declares no param for, a param whose value is not text, a number or a yes-or-no, and a reference standing where one item of a list would are each refused by the path they sit at. `{"$from": …}` is left exactly as written: that reference is resolved in the page out of what another block currently reports, which is a value no host has.

The package root exports what a view file is judged by besides the catalog: the limits on ids, titles, nodes, layout and spec size, the keys a spec, a node, a stack and a placed block may carry, the `$from` and `$param` keys and the binding notation, `describeSchema`, `DATA_PAGE_ID`, `withheldComponents`, which names the components a composition registers and does not offer, and `unbindableReason`, which says why a component's own property cannot be read from another block. [`skill-pack-components`](../skill-pack-components/README.md#the-component-catalog-file) writes its component catalog file from them.

Two registrations exist only where views do. `GET /component-surface/views` answers the catalog a navigation menu is built from — `{"views":[{"id","title"},…],"homeView"?}` — and nothing more: a spec never travels this route, so a page cannot ask for a view the deployment did not configure. `/show-content-view <id>` is what a click runs; it appends the event below, draws nothing in the chat for a click the host took, and answers a click naming no view with one sentence, `没有这个视图。`, which is the only thing its chat row ever draws. Clicking the view already on screen appends again, which is what moves that entry back to the front of the switcher strip rather than doing nothing. The command declares `engages: false`, so its `command/run` leaves the Session list's `blank` flag set: a draft whose only activity is showing views stays reusable as the workbench's blank draft.

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
2. Every read from here on is made for the session the call runs in — `{ kind: 'session', sessionId: exec.agent.id }` — so a call with no session behind it is refused first, with nothing asked and nothing read. Whether a credential is held for that session is then read off the gate, which costs nothing and reaches nothing. A session holding none is refused here, because allowing a read this process cannot perform buys the person who allowed it nothing.
3. The signed-in person's own permissions are read once and judged by the data backend's rule table — the one `bizOperationRules` on the sign-on gate configures, so this package keeps no copy of it. Every table the call names must allow both `metadata_read`, because its dictionary and default columns are its description, and `read`; one that does not refuses the whole call, before anybody is asked and before anything of any table is requested, in one sentence whether or not the deployment has a table of that name: `show_component: no data model whose rows the signed-in person may read is called "<meta>", so nothing was read from the data source. Nothing on the panel changed.` A permissions read that fails refuses every table, stating what it answered, and reads nothing on a guess.
4. The user is asked once — one card for the whole call, however many tables it names, and once per call because `allowed-once` is the only grant the approval service has. Nothing of any table has been requested of the backend when that card is drawn, so a person who refuses has had nothing of theirs read.
5. The table's dictionary is read, and every attribute the read names is checked against it: each column's `relatedMetaAttr`, each condition's `key`, and the attribute sorted by. One the table does not have is refused here, with the dictionary's own first ten names, because nothing downstream treats it as an error. A column would simply arrive without its key and draw blank in front of the user; a filter or a sort is the backend's to interpret, and a backend that ignores an unknown filter answers a read the user allowed as a narrowed one with everything up to the page size. The dictionary also supplies a header for every column the call wrote none for.
6. A block that named no columns of its own has them settled here, out of the table's default query scheme, and judged against the dictionary just read and against the thirty columns a table draws. A scheme this table cannot be drawn from is refused before a row is read, in words naming the scheme, because the call wrote no column for such a sentence to name.
7. The rows are read, one table after another, and each row is held to the columns the read takes, whoever settled them — the backend answers with the attributes it chose, putting its own row identifier in front of every set of attributes it is given. The first failure ends the whole call, and the rows already read are dropped.
8. The rows are put in, and the filled call is judged again by the same pass a hand-written one gets — this time for what only the rows can decide: how many arrived, and how many bytes the filled call is.
9. `content-component/resolved` records the whole filled entry.

Nothing is appended and nothing is drawn unless step 9 is reached, so every way of failing leaves the column exactly as it was — and the `tool/call` of a reading call records no entry either, because the blocks in its own arguments are missing the rows they are required to carry.

### What the user is asked

The card is Chinese, free of any term the console does not otherwise show a person, and carries the table's backend name on a line of its own — there for someone who wants to check what was really asked for, out of the way of someone who does not. The example below is the card as it is written, and as the panel draws it: the panel keeps the reason's line breaks rather than collapsing them.

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

<a id="the-deployments-own-data-page"></a>
## The deployment's own data page

Off by default, and a different thing from the section above. `dataSource` reads rows on the host and puts them into a block this package's catalog describes; `toy.data-page` opens the deployment's own page inside the panel and this process reads nothing at all — the page's scheme, its dictionary and every query go browser → deployment under the visitor's own credential, and no cell of any of it reaches the host.

A deployment sets `dataPage: true`, and the row then waits for `approval` before offering the tool: every page is put to the user before it opens, and a component nobody can be asked about is one nobody may place. `bizBackend` is neither needed nor waited for.

```yml
- name: '@deepseek-ai/dsh-user-approval'
- id: component-kit
  name: '@deepseek-ai/dsh-experimental-component-kit'
  config:
    bizBasePath: /ini-server/
- id: show-component
  name: '@deepseek-ai/dsh-experimental-component-surface'
  config:
    dataPage: true
    dataPageLoadTimeoutMs: 10000
```

Where the page requests its table is [`component-kit`](../component-kit/README.md)'s own `bizBasePath` and not a field here, because those requests are the browser's under the shell's own origin and this half is never on that path.

Eight properties are the model's — the eight below, of which seven reach the page and `metaLabel` stops here, on the card — and a page a call places is read-only over the table whatever else that call writes: the arrangement is refused, so the page opens with its own defaults, and its own default is refusing every write, which hides the add button, the batch menu, the two exports and the row's modify and delete buttons with it. What opens it for writing is `readOnly: false` in the file whoever wrote the page down wrote, and from there each press is the deployment's own answer to the request the page makes with the visitor's credential. Which of the drawn entrances this visitor keeps is the host's to decide: [`component-kit`](../component-kit/README.md) passes the page the host's verdict on this visitor's rights as `abilities`, which only removes entrances, and the catalog here declares no property of that name, so a call or a written-down page carrying one is refused as any undeclared property is. Whether a press succeeds is still the backend's, answered one request at a time. What those rights do decide is whether the page opens at all — where they name tables and none of them is this one, and where they could not be obtained at all, the page fetches nothing and reports `denied` with which of the two it was, and no property of the block, written by a call or by a page, is read before that. A credential this deployment refuses outright is neither of those and is reported as `auth-failed`: the page goes nowhere, draws a line of its own, and every data page on screen reports the same refusal, because the layer that judged it is not told which block asked.

| Property | Required | What it is |
|---|---|---|
| `relatedMeta` | ✅ | the table's name in the backend |
| `metaLabel` | ✅ | that table's name in the user's own language, at most 20 characters of one plain line; this is what the approval card shows |
| `conditions` | | at most ten `{key, op, value}`, applied to every query without being drawn; `op` is one of the sixteen strategies the filter bar offers, and a value is text, a number, a yes-or-no, or a list of at most twenty of the first two |
| `matchMode` | | `AND` or `OR` |
| `querySort` | | `{asc}` or `{desc}`, one attribute; sending both is refused |
| `selectMode` | | `checkbox` or `radio`; rows can then be ticked, and the ticks stay in the panel |
| `isInitQuery` | | whether the first query runs without the user pressing anything |
| `customOperations` | | at most five `{name, label}`, each drawn as a button on every row; a press reports the `name` and that row's drawn cells |

No property of a page may be read from another block. Every one of them is on the card the user answers, and the card is drawn from the call before anything another block could resolve exists.

### The order, and what each step costs

1. The whole call is judged the way any call is, and then the five refusals this component adds. A deployment that does not offer the page refuses it by name, with the components it does offer. A second page in one call is refused, because a call asks one question and a page is a whole table's worth of screen. A sort naming both directions is refused the way a `dataSource` sort is. A property of the page's arrangement is refused, because how the page is laid out and whether it can be written in are settled where the page was written down — so a page a call places always opens read-only and holding everything. And a page placed by the same call that reads a `dataSource` is refused: those are two questions, and a card asks one.
2. The user is asked once. Nothing has been requested of anything when that card is drawn — not by this process, which requests nothing for this kind ever, and not by the browser, because the block is not on screen yet.
3. `content-component/resolved` records the entry: the same event a read appends, with `fetched` empty because nothing was fetched here.
4. The call waits, up to `dataPageLoadTimeoutMs`, for a browser to report the page's columns, and answers either with them or with the sentence saying no client reported them in time — which also says the columns and counts will arrive as notices, so a model is not tempted to place the page again and ask the user the same question twice.

A call's own `tool/call` records no entry for this kind; the extractor reads that off `recordsEntry`. Drawing the entry from the call would put the page on screen — and its first request on the wire, with the user's own credential — before the question was answered, and would leave it there after a refusal.

### A view may place one, and the click opens it

`/show-content-view <view>` places a data page on the click that named it, the same way it places every other view: no card, nothing to confirm, nothing minted. The person clicked a menu row whose title they read, and that click is the decision.

Four facts are what make a question in front of it unnecessary, and losing any one of them is what would bring one back:

1. **A card would be the same button twice.** The page draws in the console's own origin, beside the [`content-frame`](../content-frame/README.md) screens of the same deployment, which open on a click and ask nothing. A confirmation of a press the person just made stops nobody and protects nothing.
2. **The model cannot run this command.** `CommandInvocation` carries no source and `CommandSourceMap` has one member, `user`, so every invocation of it is a person's own click — pinned by a type-level assertion in `view-command.client.spec.ts` that stops compiling the day a second producer exists.
3. **The model's own way in still asks.** A `show_component` call placing `toy.data-page` goes through `ctx.approval` and the card below, unchanged: there the decision is the model's and the person is being interrupted mid-turn, which is what that service is for.
4. **The deployment still decides.** `dataPage: false` withholds the component and the two blocks a view places beside it, and a view placing any of the three is then refused by name at load — the same refusal a call for the page earns.

What reaches the log is the command's own `command/run` / `command/done` pair with one `content-component/shown` between them: it names the view, and the spec it carries names the table, so what the user opened is reconstructable from the log without the configuration that produced it.

### What the user is asked

One page, one card, in the register the read's card uses and carrying the same identifier line beneath it.

```
用您的账号打开「图层配置」的完整数据页，可以在里面查询、翻页、排序；小助手看不到表里的内容，只会知道有哪些列、每次查到多少条，以及您点到的那一行。
数据表：SpaceLayer
```

Hidden conditions are counted on that first line and never shown — `，预设了 2 个筛选条件` — because a condition's value is the model's text and the page draws none of it. `metaLabel` is held to the same one-plain-line alphabet a `dataSource` label is, so nothing the model writes can draw the identifier line that a person checks the rest of the card against.

What the user then queries inside the page asks nothing further. The page is theirs once it is open, which is what the card promises, and the last clause of that promise is the one that must always hold: columns, counts and the one clicked row are what the agent learns, and rows are not.

### What is recorded, and what the model is told

`content-component/resolved` carries the call id, the entry id, the title, the spec the user agreed to, and an empty `fetched`. It carries no credential and no row, because there were none to carry: this half read nothing.

The model is told the entry it placed, and then what the page loaded — the table, its first 20 drawn columns named as `header (attr)`, and a count of any beyond them. That report reaches the model in the result line when a browser sent it before the deadline, and as a notice when it did not; a report a waiting call takes is delivered nowhere else, so the agent reads it exactly once. Every later query and every clicked cell is a notice.

<a id="view-placed-components"></a>
### A view may place a form page and an info card beside it

Two more components go with the page, and only a view places them. `toy.form-page` (表单页) is the add and modify form of one table, and `toy.info-card` (信息卡) is one record's card. This package declares both with `placement: 'view'`, and [`component-kit`](../component-kit/README.md) registers them with its other six and draws them through the vendored page's own form and card.

`placement: 'view'` is read through one predicate everywhere a block could reach the column. The tool refuses a call naming such a component before the user is asked anything or it appends a record of its own, in the same sentence whether the call writes its rows out or reads a `dataSource` and whether or not the deployment offers the component: `names toy.form-page, which is placed only by a view written down for this deployment, never by a call.` The tool reads this off the call as written, before the shared pass judges the block's properties, so a refusal never lists what the component accepts. The extractor draws a spec carrying one only out of the `content-component/shown` a click on a view writes; a `tool/call`, a `tool/ptc-dispatch-start` or a `content-component/resolved` carrying one records no entry. The tool's description leaves the component out, and the view pass accepts it. `ctx.componentCatalog.offered` still counts it, because what can be drawn here includes what a view draws, and `dataPage: false` withholds both blocks with the page.

The page declares the two values they read. `editing` is `{mode (add|modify), type, id?, name?}`: what the page's add button or a row's modify button is editing — a new record of the page's table, or that row. `opened` is `{id, name?, type}`: the record a name or a relation link on the page opened, whose `type` is the related table where a relation link opened it. Both are what the page shows now rather than a count of presses, so pressing the same button again publishes the same value. The declaration also fixes when a publisher withdraws each by publishing `undefined`: `opened` when the page closes its card, is cleared or turns a page, and not on a query; either one when the record it names is deleted. Both are declared `readers: 'view'` — every property that accepts either belongs to a component only a view places — and [`tests/layout-binding.client.spec.ts`](tests/layout-binding.client.spec.ts) holds that declaration to the properties that accept each output.

The form page takes `relatedMeta`, the table it saves into, written out — the save is reported under it, and the view pass compares it with the page's table — and `request`, which reads `editing`. The info card takes `record`, which reads `opened`, and `infoCardTabs`, from the list the page's own card is arranged by. Neither declares the visitor's abilities, so a view writing them is refused as it is for any undeclared property. `request` and `record` are optional, so a block whose binding has nothing to stand for yet is handed its properties without it rather than drawn as the seat's waiting line. A view must still write each of them, and only as one binding, which the property's `bindsFrom` declaration names: the component, the output of its block, and the reason a refusal states. That is judged in the view pass and not in the shared one, because the browser seat runs the shared pass after it has put the resolved value where the binding was; a call never reaches it, because a call cannot place either block.

After the shared pass and the page's own judgement, a view placing either block meets the rules below, each refused at the path that has to change. Every `bindsFrom` property must be written as a binding to that output of a `toy.data-page` block of the same view, whole and with no `[index]`. A form page is placed at most once, saves into the page's own table, and sits beside a page whose `readOnly` is `false` — a read-only page draws no add or modify button, so the form would never have a record to save — and whose own add and modify forms are both switched off with `regions.addForm: false` and `regions.modifyForm: false`, so one press does not open two forms. A view with no form page, whose page switches a form off while keeping the button that opens it, is refused at that region, because the button would open nothing: the add button is kept where the page is writable, draws its toolbar and lists `add` in `toolbarButtons`, and the modify button where the page is writable and lists `modify` in `rowOperations`, a list the view leaves out standing for the page's own default. An info card is placed at most once, beside a page whose own side card is switched off with `regions.infoCard: false`, so one click does not open two cards and only the info card reports the record it shows, and whose names stay links with `infoCardLinks: true`, so something on the page opens a record. A page whose names are links while its own card is switched off is refused at `infoCardLinks` where no info card is beside it, because a click would open nothing. A form page reading `opened`, or a card reading `editing`, is refused by the shared pass, because neither value fits the other property.

Both blocks report `context` actions. The form page reports `added` and `modified` under its own `relatedMeta`, with at most eight saved cells, and a save carrying no cell as saved and nothing more. The info card reports `card-open`, naming the record and its table, and `card-close`, as the card no longer showing a record. Neither account reads `request` or `record` back: on the host each is the binding the view wrote, which is what lets it be bound. The side card's opening and closing is reported once: the data page reports its own card where it draws one, and where a view switched that card off the page only publishes and withdraws `opened`, and the info card reports. A save, a delete and a batch edit refresh the data pages and cards on that table through the vendored page's own save notification rather than a binding, so nothing the form page reports is bound back into the page.

A written-down page also takes two properties a call may not send, both view-only like `readOnly`. `infoCardLinks: true` keeps a name and a relation link clickable where the page draws no side card of its own, which an info card beside it needs. `deleteGisResource` is what a delete asks the backend to do with the spatial resource data bound to each record: `1` deletes it with the record, `2` deletes it and clears the binding, and `3`, which the page sends where the view writes none, deletes no record that still has any bound and reports it instead. The deployment's own page always sent `1`, whatever it was configured with; a view writing `1` chooses that.

<a id="the-catalog"></a>
## The catalog

One tool for every component, rather than one tool per component. Which blocks exist is a deployment's catalog, and a catalog is cheaper to state once inside a description than to spread across a growing tool list the model reads on every request.

The catalog is `ctx.componentCatalog`, and it starts empty. A component plugin registers a batch of definitions into it together with the package that wrote them — read from that package's own manifest — and gets back the disposer that takes them out again; a second package claiming a registered id is refused at registration, naming both. The browser has the matching registry, `ctx.componentRenderers`, which takes the same definitions paired with the renderers that draw them, so the two halves of a component arrive together and a page that loaded no component plugin refuses a payload rather than drawing a blank block.

Registering a component is the contributing plugin's act; offering it is the deployment's. `ctx.componentCatalog.offered` is the second: the registered components minus the ones this deployment will not place, which are the data page and the two blocks a view places beside it on a console that left `dataPage` off. A component only a view places is still offered: it is kept out of what a call may place, not out of what can be drawn here. The tool's description applies that rule to what a model reads, and `offered` is how a reader outside this package — [`skill-pack-components`](../skill-pack-components/README.md) is the one there is — asks what can actually be drawn here without re-deriving it.

[`component-kit`](../component-kit/README.md) is the component plugin this repository ships, and its eight entries are what every composition here offers, the last two only through a view:

| Component | 名称 | What it draws | What comes back | What another block can read |
|---|---|---|---|---|
| `el.confirm-bar` | 确认条 | an optional title, an optional message, and one to five buttons each carrying an id, a label, and an optional tone | `press`, carrying the pressed button's id | nothing |
| `toy.record` | 记录详情 | one to sixty rows, each a label of at most 64 characters and a value of at most 400, with an optional label width of 40 to 240 and an optional column count of 1, 2 or 3 | nothing | nothing |
| `toy.table` | 数据表 | one to thirty columns over one to five hundred rows, each column reading its cell out of a row by field name and optionally drawn by one of five cell renderers; optionally a selection column, clickable row names, up to five custom operation buttons, and an operation column width | `select`, `row-click`, `sort` and `operation` | `selectionDetail`, the first ticked row as label-and-value rows |
| `el.filter-bar` | 筛选条件 | one to forty attributes the user builds conditions over, optionally narrowed to some of the sixteen match strategies | `submit` and `change` | nothing |
| `el.metric` | 指标球 | one measurement from 0 to 100 drawn as a filling ball, with an optional word, size, and three colors | nothing | nothing |
| `toy.data-page` | 完整数据页 | the deployment's own full page for one table, opened with the visitor's own credential once they agree; read-only whatever a call writes, and arranged by whoever wrote the page down | `denied`, `auth-failed`, `load`, `query`, `select`, `cell-click`, `card-open`, `card-close`, `added`, `modified`, `operation`, `exported`, `deleted` and `batch-modified` | `editing` and `opened`, which only a block a view places reads |
| `toy.form-page` | 表单页 | the add and modify form of one table, beside that table's data page in a written-down view; it follows the page's add and modify buttons and saves with the visitor's own credential | `added` and `modified` | nothing |
| `toy.info-card` | 信息卡 | one record's card, beside a data page in a written-down view, showing the record the page's names and relation links open | `card-open` and `card-close` | nothing |

An action and an output are two different things. An action is news the agent is told about and a record in the log; an output is a value that stays inside the panel, for another block of the same call to draw from. A table therefore reports a selection twice over — once to the agent, as the rows the user ticked, and once to the panel, where a record detail can be drawn from it without the agent being involved at all. An output is declared only where some property in this catalog accepts it: what a block reports and nobody can read would be a binding the model is offered and then refused. An output only the properties of components a view places accept is declared `readers: 'view'`, and the description leaves it out with them; a binding to one, on a block a call places, is refused as naming nothing the source block reports, and the refusal states none of its fields.

A detail row's label is bounded by the field-name ceiling rather than a shorter number of its own, because `selectionDetail` is read into that list and a column with no header of its own contributes the field it reads. Two ceilings there would be a binding the catalog offers and then refuses.

A component reporting no action says so on its own line of the tool description — a model told a block answers back would otherwise place a display-only one and wait. Each component's properties are stated under that line, derived from its `propsSchema` rather than written beside it, so what the model is offered and what a call is judged against cannot drift apart and a model learns what to send without spending a refused call on finding out. The line goes all the way down: a nested list states what one of its items carries, because a list named without its item properties costs one refused call per property to discover. What it leaves out is every bound a refusal already states — a string's length, a token's alphabet — because the description is paid for on every request and a refusal is paid for once. A component only a view places is not in the description at all.

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

A property the host itself reads back cannot be bound either, and the refusal says which property it is and why. A table's rows are the case: what a reported gesture is named against — the row that was ticked, the column that was sorted — is read out of the call that wrote the rows, and a resolved value lives for one render of one page and reaches no record. So a table cannot be fed its rows, and the one binding a call can write is a table's `selectionDetail` into the record block beside it.

Values therefore travel one way. Every component that publishes an output — the table and the data page — refuses a binding on every property it declares, either because the host reads the property back or because no output in the catalog fits it, so a block that publishes is one no other block can feed. The form page and the info card read a binding and publish nothing; what they report are actions, which no block reads. No chain of bindings can close, and nothing here looks for one. The catalog is held to that by its own test rather than by a runtime pass.

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
| `toy.data-page` `denied` | the `reason` the page did not open, `no-row` where the table is not among the permissions this deployment holds for this user and `no-rights-table` where those permissions could not be obtained at all, and nothing else: the page fetched nothing and drew the deployment's own 无权限. The table it is about is the `relatedMeta` the call wrote, and the profile the page judged against stays in the browser | `context` |
| `toy.data-page` `auth-failed` | the `status` this deployment refused the visitor's credential with, `0` where the page had none to present, and the `code` it answered beside it where it answered one; never the credential itself. Every data page on screen reports its own, because the request layer is not told which block asked | `context` |
| `toy.data-page` `load` | the `meta` the page loaded, its first 20 drawn `columns` as `attr` and an optional `alias`, the `total` it draws, and the `rights` this deployment answered with for this user | `context` |
| `toy.data-page` `query` | one answered query's `total` matched, `rows` shown and `page` number | `context` |
| `toy.data-page` `select` | the `count` of ticked rows and the `names` of the first five, by what their first drawn column shows | `context` |
| `toy.data-page` `cell-click` | the clicked column's `attr` and `label`, and the clicked `row`'s drawn cells | `context` |
| `toy.data-page` `card-open` / `card-close` | the `name` of the record a side card opened on and its table `type`, which for a relation link is the related one; nothing when the card no longer shows a record | `context` |
| `toy.data-page` `added` / `modified` | a `record` of at most eight drawn cells of the saved row, read through the columns the page's last `load` reported | `context` |
| `toy.data-page` `operation` | the pressed operation's `opId` and the `row`'s drawn cells | `context` |
| `toy.data-page` `exported` | which of the two toolbar exports the page submitted as `mode`, and the `fileType` the press named where it named one; the export is a task on the deployment's own backend and the file is collected from that deployment's own task list, so the task number it answered with reaches nobody here | `context` |
| `toy.data-page` `deleted` | how many records one delete removed as `succeeded`, how many it could not as `failed`, and the `names` of at most five of the removed records; never a field value | `context` |
| `toy.data-page` `batch-modified` | `succeeded`, `failed` and `names` as for `deleted`, and the `fields` one batch edit changed, by attribute name and never by value | `context` |
| `toy.form-page` `added` / `modified` | a `record` of at most eight cells of the saved record, under the form's own `relatedMeta`; the empty record where no data page on that table has reported its columns | `context` |
| `toy.info-card` `card-open` / `card-close` | the `name` of the record the card shows and its table `type`; nothing when it no longer shows one | `context` |

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

<a id="acting-inside-the-entry-on-display"></a>
## Acting inside the entry on display

`act_component` is the agent's other direction into the column: one call names one entry and carries between 1 and 8 steps, run in order, stopping at the first that fails. A step is one of three — `click` presses the control a block declares under an action key, `set` writes the field the entry names for one column or property, `wait` waits until a block or a declared control is drawn — and every one of them addresses the components' own language rather than a DOM reference: `entry` is the id `show_component` placed, `node` is a block id the placement wrote, `key` is an action the component declares for a control, and `name` is the column or property a field is named by. A written value is at most 4096 characters, a name at most 64 characters of letters, digits, underscores and hyphens, and a `wait` at most ten seconds.

**One call acts inside one entry and nowhere else.** The console finds the entry's container from the column's own two markers — the selected switcher button's key and the active kind wrapper's entry root — re-reads both after the claim, and refuses unless the entry it finds is the one the call named. Every search a step makes is bounded by that container: what the console draws beside the entry — its own sidebar, the chat input, another entry, a stale seat of the same kind — is unreachable rather than merely unchecked, and a step whose target the entry does not declare is refused with one sentence. That sentence is the same whether the target is nowhere or outside the entry, because from the call's side they are the same fact: the entry this call is confined to does not hold what the step named.

**What is not inside the entry is out of reach, overlays included.** A date panel or a cascade the component library teleports to `document.body` is outside the container, so a two-step action that opens one and then picks an item is refused at the pick. The rule is deliberate: admitting what a call opened in this document would need a way to tell a popup this call caused from everything else the page drew, which is a window this row does not cut. A component that wants such a step draws the overlay inside its entry, which [`component-kit`](../component-kit/README.md) does for element-ui's select, and the consequence is recorded in [Known Limitations](#known-limitations-and-deferred-work).

**A select field is filled by choosing an option, and every write is confirmed or refused.** element-ui draws a select's value in the component rather than in the input the entry marks — that input is read-only and shows the chosen label — so `set` on one does not assign a value the component would never see: the step opens the select's list, chooses the one drawn option whose label is the value, and reports done only once the select itself displays it. Two drawn options carrying the value, and no drawn option carrying it, are refusals naming the value; an option the component did not take ends the step as failed rather than reported. The same rule holds for every write: a field the entry draws disabled or read-only is refused — a read-only text control included, whose DOM value a script can assign while the person, and the component behind it, never see the write — and so is a control that did not take the value.

**A step is performed by a control the block marks, and refused where a person could not reach it.** A press names a control by the action the component declares (`data-component-action`) or by the control's own key where one action is performed by several controls — a confirmation bar's buttons, a table row's operation links, a data page's toolbar buttons (`data-component-key`); [`component-kit`](../component-kit/README.md#marks) records which of its controls carry which. Both are read off the entry's own markup and never off a DOM reference the call carried. Where the control is disabled, or the document's own hit test finds something else drawn over the point the control occupies, the press is refused instead of reported as one that ran: the click a step dispatches reaches the block's handler whether or not a person could reach the control, so a step reported as done would say somebody could have done what they could not. A table that draws a fixed column in a layer of its own draws that control twice, and the second drawing standing over the one a step found is that control reached again rather than something covering it: the two copies carry the block's own declaration, in the same block. `set` reads one name the same way, because a page keeps the write dialog it closed in the document under the field names its query panel asks with: the copy inside an open dialog is the one written when there is one, and where no dialog is open a name two drawn copies carry is refused with the ambiguity named, rather than written at one of them. The entry itself is read again before every step, and the run stops where it no longer matches the one the call was claimed against — the same switcher key and the same container element, with the reason saying which entry is in front instead. The column replaces what it draws without telling this seat, and one kind's entries share the element they are drawn in, so the steps after a switch would otherwise land in whatever entry took the place of the one the call named while the report still named the original.

**What comes back is the document a set of page steps answers with.** A call that ran reports the entry it acted on, one result per requested step in order — `ok`, or the one that stopped the call with its sentence, or `skipped` for the steps behind it — and one text naming each step and its ending. Three endings reject instead: no entry in front at all, another entry in front, and a component that threw while a step ran. A claimed call that never reports answers `unverified` rather than failing, because its steps may have run in part; a call no console claimed within `actClaimTimeoutMs` rejects naming that deadline, and a claimed call that goes quiet is answered against `actTimeoutMs`.

**One call of this tool runs at a time.** Two calls acting on one entry would interleave their steps in a document neither of them read, so the definition declares itself unsafe to run beside another call and the runtime serializes it.

**The review gate judges every call.** `act_component` drives what the user is looking at, so it is not a read-only tool and must not join `@haoran/dsh-llm-permission-gateway`'s `readOnlyTools` list. The classification file this repository ships, [`content-frame`'s gate overlay](../content-frame/overlay/permission-gateway.patch.yml), names the five page reads and `content_show` and leaves this tool out; a deployment composing this row writes its own list and keeps it out too. `tests/act-component-gate.client.spec.ts` holds the shipped file to that.

**A pick and a call do not exclude each other yet.** The content-point picker reads the user's own pointer while a point is in progress, and this tool synthesizes clicks and input events inside the entry; nothing today stops one from happening during the other, because the picker's state belongs to another package's browser half and no service reports it. The exclusion needs a seam there — a client service saying a pick is active, which this tool would refuse against — and is recorded in [Known Limitations](#known-limitations-and-deferred-work).

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

A block publishes its own current reading of itself — the row a table has ticked, laid out as a record's rows — through `onOutput`, and the seat keeps those values in React state for as long as the call that placed the blocks is on display. A property written `{ "$from": "node:<id>.<output>[<index>]" }` stands for whatever the named block last published, and the substitution happens in the page: the resolved value never enters the payload, never reaches the host, and never reaches the session log. That is what lets a record follow a table's selection without every tick becoming model-visible input something has to record, and it is why the vocabulary is one reference with no expression, no condition and no loop. Publishing `undefined` withdraws a value: a property bound to it is then left with no value, so an optional one is absent from the block's properties and a required one puts the block back on the waiting line. Publishing the value already standing hands the blocks reading it nothing new.

The seat resolves before it judges, so the value a block is drawn from goes through the same schema the call was judged against. That matters because a published value is not a value any host judged: the host checked that the output *could* stand where the property is declared, never what it would carry. A block whose required property has nothing to stand for it yet is left out of the judgement rather than failing it, and draws the component row's waiting line in its place; a value that does not fit where it was put leaves the fed blocks waiting the same way, so the blocks nothing fed still draw.

A later call under the same entry id starts with nothing published, because the blocks it draws have published nothing: carrying the previous call's values across would feed a new record block the rows of a table that is gone.

Each block is memoized on its own identity — its entry, that entry's owning sequence, the node, the gesture the fold records against it, and, for a block that reads from another, what its references resolved to — so a block nothing feeds keeps the object it already had when the seat re-reads the payload because some other block published something. That is not an optimization: `el-table` reads a new row list as a table whose rows have been replaced and clears the selection, so a table handed fresh properties every time the block beside it was fed would drop the tick that fed it. The renderer comes from the component row's table by the catalog id the node names; a table with no entry for it says so in that block's place, which is what a deployment composing a mismatched row sees.

The seat carries no dictionary. It translates through `componentKit`, the component row's namespace, because the sentence shown in place of a block belongs with the components rather than with the package that placed them.

## Model Experience

### The `show_component` offer

#### What the model sees

One tool, `show_component`, with a required `id` string, a required `title` string, and a required `spec` object carrying a required `nodes` array and an optional `layout`. The description carries the whole catalog as two lines per component: `- id — label — purpose`, with `Nothing comes back from it.` on the line of a component that reports no action, and beneath it a `props:` line naming every property that component declares — `?` on the ones a call may omit, `(min–max)` on a number, `(a|b|c)` on a fixed set, `(true|false)` on a yes-or-no, `[what one item is] (min–max)` on a list, `{…}` on an object of declared properties, and `{<field>: text|number|boolean}` on an object whose keys the model chooses. A component another block can read from carries a third line, `outputs:`, naming each value and writing its form in the same notation, which is what makes a binding writable: the reference names one of those ids, and whether the property it is bound to accepts the value is decided against the form on that line. Then the reuse rule for `id`, the node and byte ceilings, the refusal rule for undeclared properties, one paragraph on the layout tree and one on reading another block, and the sentence naming what comes back: what the user does inside a block reaches the model, with the entry and the block it happened in, unless that component's line said otherwise. The component labels in that list are the Chinese names the end user reads, so a model naming a block in conversation names it the way the user sees it. This package contributes no system-prompt section. Where the deployment composed a data source, the offer carries one further optional `dataSource` array and one further paragraph: the fields of an entry, the sixteen match strategies by name, the row and page fields, that a named block sends no rows of its own while its `gridItems` say which attributes to read and that leaving `gridItems` out takes the columns the deployment shows for that table by default, that the user is asked once per call and a refusal draws nothing, and that what comes back is a count, a list of attributes, the page read and the attributes that were empty in every row rather than the rows themselves. Where it composed none, neither the parameter nor the paragraph exists, so those deployments' request bytes are unchanged.

#### Token effect

One fixed description plus the parameter schema, on every request where the tool is visible. The description grows by two lines per catalog entry — three where another block can read from it — the second as long as that component's whole property tree; the table's line is the longest, because its columns are a list inside an object. The `spec` schema stays shallow — one object, one array, and one unconstrained `layout` — because the per-component properties are in the catalog lines and the layout's own vocabulary is in the description, rather than in a nested JSON Schema. A component only a view places adds nothing, and neither does an output only such components read: neither is in the description.

#### KV Cache effect

The description is assembled from the catalog when the row loads and depends on nothing else, so the tool block is byte-identical across every request in a deployment whose component plugins are all composed at boot — which is every shipped composition — and the prefix holds. Loading or disposing a component plugin mid-session re-registers the tool and therefore writes a new request header, which is a prefix break paid once per such change.

### Tool-call result

#### What the model sees

An accepted call answers `Now showing "<title>" in the content panel: <labels>.` followed by the sentence naming the id to reuse. A refused call answers `Error: show_component: <path> — <what is wrong and what to send instead>`, and for an unknown component the whole catalog again, property lines included, so the corrected call needs no second refusal to learn what the component it picks instead accepts. A call that read its rows adds one sentence per filled block — `Read 20 of 89 matching rows from "SpaceLayer" into block "rows", for the attributes zh_label, layer_id. Page 1 of 5.` — and nothing out of any row. A read that did not happen answers one sentence saying which of the seven ways it did not: no credential is held, the user did not allow it, the backend answered something else, the table has no attribute by that name (with the dictionary's own first ten, so the next call needs no second refusal either), the table's own default query scheme cannot fill a block that named no columns, nothing matched, or the rows that arrived are more than a spec carries. No sentence this package writes — a description, a refusal, a result line or a notice — names another tool, under the rule [the self-contained-copy Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.md) records; [`tests/self-contained-copy.client.spec.ts`](tests/self-contained-copy.client.spec.ts) walks them and fails on such a name, and `show_component`'s own name in a refusal's prefix and in the result line is outside the rule.

#### Token effect

One short line per call. A refusal naming an unknown component is longer by the length of the catalog, which is the point: it replaces a second failed call.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

### The `act_component` offer

#### What the model sees

One tool, `act_component`, with a required `entry` string and a required `steps` array of 1 to 8 objects. Each step carries a required `action` of `click`, `set` or `wait`, and the fields that action takes: `key` for a press, `name` and `value` for a write, `node` throughout as the block within the entry, and `timeoutMs` for a wait. The description states the confine in its own words — nothing outside the named entry, and it must be the entry in front — then the addressing vocabulary, one line per action, and one sentence saying the answer reports which steps ran, which one stopped the call, and what the entry's controls said. There is no catalog in it: what a component declares is a runtime fact of the catalog, while which key or field a call may name is something the entry's own markup answers at the moment the step runs.

#### Token effect

One fixed description plus the parameter schema, on every request where the tool is visible. It carries no catalog and no per-component lines, so it does not grow with the component plugins a deployment composes.

#### KV Cache effect

The description depends on nothing but this row's own text, so the tool block is byte-identical across a deployment's requests and the prefix holds. The tool is registered only where the shared channel is composed; a row that gains or loses that service mid-session re-registers it and writes a new request header.

### The result of a set of steps on an entry

#### What the model sees

A call that ran answers `status` (`done` or `failed`), the entry it acted on as `{id, title}`, one `steps` entry per requested step — `{index, status}` and, for the step that stopped the call, its `message` — and one `text` naming the entry and every step's ending: `Acted on the component entry "Demo" (demo).` followed by one line per step, `- click on "add": done`, `- set "title" in grid: …`, `- wait for grid: done`, or `not run` for the steps behind a failure. A step that named a control the entry does not declare reads as `control "console-add" is not part of the entry on display.` — one sentence for both a target that is nowhere and one the console draws outside the entry, because from the call's side they are the same fact. A call no console claimed rejects with `No console showing this session claimed the call within <claimTimeoutMs>ms, so no step ran.`; a call answered by nothing — no entry in front, another entry in front, a component that threw — rejects with that console's own sentence prefixed by `act_component did not run: `. A claimed call that never reported answers `status: "unverified"` with no entry and no steps, and a text saying the steps may have run in full, in part, or not at all.

#### Token effect

One line per step, and the sentences the console wrote for the ones that failed. A refusal is one sentence: the tool never prints the console's document, so a call that named the wrong control costs its own step line rather than a listing.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

## Known Limitations and Deferred Work

- **A step cannot reach an overlay the entry draws outside itself** — a date panel or a cascade the component library teleports to `document.body` is outside the entry's container, so the click that opens it succeeds and the step that picks an item is refused as not part of the entry. That is the v1 rule rather than a defect in the search: admitting what a call opened would need a way to tell a popup this call caused from everything else the page drew. element-ui's select no longer falls under it, because [`component-kit`](../component-kit/README.md) draws its list inside the select; the trigger for revisiting the rest is the first component plugin whose picker cannot be moved into the entry.
- **A select's list is drawn inside the select, so an ancestor that clips takes whatever does not fit** — element-ui positions a list against its own trigger and knows nothing about an ancestor's `overflow`, so a dialog body that scrolls, or a block's own box, can cut a list taller than the room under its field. That is the price of the list being inside the entry, which is what makes a `set` step on a select possible at all; a single select that needs the old behaviour passes `popper-append-to-body`, and the trigger for revisiting the default is the first field whose options do not fit under it.
- **A content-point pick and an `act_component` call are not mutually excluded** — the picker reads the user's own pointer while a point is in progress, and this tool synthesizes clicks and input events inside the entry; nothing today stops the two from overlapping, because the picker's state lives in another package's browser half and no service reports it. The fix is a seam there — `content-point`'s client half providing whether a pick is active, which this tool's browser half injects and refuses against — and it belongs with that package rather than here. The trigger is the first report of a point taken on a control a call was pressing.
- **The tool exists only where the shared content channel is composed, and that channel lives in `content-frame`** — a deployment composing this row without [content-frame](../content-frame/README.md) is offered `show_component` and no `act_component`, which is the tool not existing rather than one that always times out. The narrower arrangement would be the channel in a package of its own, or on the `content-surface` layer both domains already share; both are pure moves and neither is scheduled, so the composition prerequisite is what stands today.

- **Row-level trimming is the backend's, and this row cannot prove it happens** — the deployment's own frontend has a row and column permission pass, but with no signed-in profile it returns early and opens the data up rather than closing it down, so it is not a boundary. If the backend does not trim rows against the token it was handed, one read can draw rows a person was not meant to see onto that person's screen and write them into that person's session log — and signing out does not clean a log already written. Closing it needs an answer from whoever owns that backend, not code here.
- **The identifier line is drawn where it is written** — the approval panel draws the reason's line breaks rather than collapsing them, so `数据表：SpaceLayer` stands on its own line beneath the sentence, at the sentence's own size. It is the one part of the card no word the model wrote can reach, and the web scenario reads it back out of the panel's rendered text so the written form and the drawn form cannot change apart.
- **The table's name on the card is the model's word for it** — `metaLabel` is written by the call, not read out of the backend's dictionary. The dictionary is only read after the user has already answered, so a model that mislabelled the table has already been believed. Reading a name before asking would mean spending the credential before the question, which is the one order this row will not take. What the identifier line beneath it can do is let a person notice the mismatch; what it cannot do is stop a plausible wrong label from being read as right.
- **A header is the dictionary's only where the call wrote none** — a column carrying `alias` keeps it, whatever the backend calls that attribute. A model naming a column something it is not is therefore visible only to someone who knows the table.
- **A read that fails leaves the previous table on screen, with nothing saying it is stale** — the entry is untouched, so a replacement that could not be read shows what the last successful call put there. The model is told and should say so in the conversation; making the block itself say it needs the entry to carry a staleness bit, which is another change.
- **This row asks for fewer columns than the deployment's own page does** — the component library sends every column of a scheme, hidden ones included; a call here sends the columns it declared, or, where it declared none, the shown columns of that scheme. That is a deliberate narrowing, not a failed alignment, and it is why a table drawn here can hold less than the same table on the deployment's own page.
- **Rows in the log are checkpoint weight** — a filled spec is up to 65536 bytes, once per live entry, carried in every checkpoint the content surface writes. It is the same cost a chart's whole option document already has, and this route pays it per read.
- **The card says the page size, never the page number** — a read of page three is described to the user as `取最多 200 条`, the same words a read of page one gets. What the model asked for and what the user is told about it therefore differ on which rows, and only on which rows; the identifier line and the column list are unaffected.
- **A refusal is still drawn in the chat row** — `没有这个视图。` is a settlement sentence rather than a question, so it stays on the command's own row, which the shell does not draw at all until the session has run a turn. A person who clicks a menu row the deployment has since dropped, on a draft they have not written in, sees nothing. Moving it beside the question means the seat telling a refusal apart from every other command's, which the settlement it reads cannot say; the trigger is the first deployment that edits its view list while a menu is on screen.
- **A view the deployment wrote cannot read its own rows** — `dataSource` is a parameter of the call, so a view configured in `cordis.yml` carries whatever rows the person who wrote it typed there and nothing else. A console whose home view is meant to show live data has no way to say so today. Giving a view its own read means asking the user at click time rather than at call time, since a configured view has no model turn to hang the question on, and that is the next slice rather than this one.
- **A configured view is judged when the catalog first carries components, not at load** — what a view may place is what the composed component plugins offer, so the judgement cannot run in this row's own `apply`. A view the catalog refuses fails the contribution that completed the catalog: that contribution is taken back out, and the deployment comes up with no components, no views and no tool rather than with a menu row nothing can draw. The refusal is logged here, under this row's name, because that is the row whose config is wrong; the rejection that travels back to the contributing row is not what an operator should have to read. Moving the judgement itself back to load would need a load barrier the plugin system does not offer.
- **The refusal line reaches a terminal only where the deployment composes a log exporter** — it is written through `ctx.logger.error`, which cordis keeps in an in-memory ring buffer and hands to whatever exporters are registered. No profile in this repository composes `@deepseek-ai/cordis-plugin-logger-console`, so on a shipped composition the line is recorded and not printed. That is the same for every `ctx.logger` call in the repository, and fixing it is a profile change rather than this package's.
- **A cell the table cannot draw is dropped, not refused** — the rows are text, numbers and yes-or-no; a null, a nested record or a list is left out of the row rather than failing the read, because an absent cell is what a table already draws for one. Where the backend returns a different number of stored rows than displayed ones, the stored rows are left out entirely, since the table's two lists stand one for one.
- **A `load` naming another table is reported to nobody, and says so in the conversation** — a page reports on the entry it was drawn in, and a later call under the same entry id is a different table's page; a report whose `meta` is not the block's own is dropped rather than delivered. It is not silence: the handler answers 这个动作没能记下来。 and the chat row draws that refusal, for a gesture the user never made, beside a page that is on screen and working. The window is small — it closes as soon as the replacing page loads — and what it costs is one wrong-looking line rather than a wrong sentence to the agent.
- **A page opened in a composition no browser attaches to costs the whole deadline** — the call waits `dataPageLoadTimeoutMs` for a report that cannot come, once per such call. The ACP snapshot lane sets it to one second for exactly this; a headless deployment that offers `dataPage` should do the same.
- **What the page does after it opens is outside every rule here** — a page a call places is read-only by the properties the host writes, and the windows a writable page opens are the vendored build's in [`component-kit`](../component-kit/README.md). Nothing in this package inspects the mounted page, so what a press there writes is that build's and the backend's alone.
- **The page's queries are written to the deployment's own audit trail** — every answered query POSTs a front-event record under the visitor's own credential, carrying the table, the console's own path, and the query's parameters, the model's hidden conditions among them. The card promises only what the agent learns and says nothing about that record. It is what the deployment's own page does with the same credential; [`component-kit`](../component-kit/README.md) records the endpoint and what suppressing it would take. The same request layer also leaves three keys in the browser: the visitor's profile in `localStorage.userInfo`, the bearer token verbatim inside it, and two localforage entries holding one table's schemes and its attribute dictionary. Signing out clears the first and not the other two. `component-kit` names all three.
- **What the form page, the info card and the page's delete and batch windows leave out is recorded where they are drawn** — [`component-kit`](../component-kit/README.md) names each, among them that a batch edit that partly fails reaches the agent as nothing and that a save refreshes every data page on its table with one audited query each.
- **A data page is judged by the page, not by the rule table** — a `dataSource` read is refused on the host by the data backend's `bizOperationRules`, but `toy.data-page` requests nothing through the host: the page's own judgement opens it wherever the visitor's profile holds a row for the table, which matches the default `read` and `metadata_read` rules and does not follow a deployment that changes either. What a visitor may write or export on it is the host's verdict all the same, passed in by `component-kit`.
- **No service account, by decision** — a session with no signed-in credential is refused and the visitor signs in. The alternative would make the approval card's first three characters, 用您的账号, untrue for whoever the fallback account turned out to be.
- **A read's record is required on read** — `content-component/resolved` carries no `ignorable` marker, for the same reason `content-component/shown` does not: `Session.append` gives an appending plugin no way to set one. Every build of this repository knows the type.
- **The payload whitelist is the block's own promise, not something the host enforces** — the command registry records a command's input verbatim before any handler runs, so an over-full action document is in the log by the time this row refuses it. What the host still enforces is the byte ceiling and the declared properties: past the ceiling, or carrying a property its action does not declare, the action is not delivered to the agent at all. Sending only what the action declares is the seat's obligation, and both halves ship here.
- **The transcript row names the mechanism rather than the block** — a notice wakes its own turn, so the chat draws it as that turn's trigger, headed `收到执行请求` (`Execution requested` in English): the shell's wording for a trigger from a source it has no family for, which says nothing about the block that was pressed. The one-line summary the notice declares is not drawn at all. Expanding the trigger is no better: what it opens on is the model-facing English sentence with the internal identifiers inside it — `The user pressed "Approve" in content panel entry "budget" ("Budget approval"), on the 确认条 block "ask".` — which is the account written for the agent, shown to the person who made the gesture. The trigger and its body are drawn by [`ui-chat`](../../client/ui-chat/README.md) for every custom source alike; the review trigger for all of it is the `develop`-line change that gives a producer its own display name, which is where per-producer copy for the expanded body belongs too.
- **The command is in the end user's slash menu** — `commands.register` has no way to keep a row out of the menu the composer offers, so `/component-action` is listed there with the hint `<json>` beside it, in a product where every other row is something a person is meant to type. What that row can be is a sentence saying it is not: the description is end-user Chinese naming the buttons in the content panel and saying the page sends it. A line typed there by hand resolves against nothing and answers with the same refusal a lost press gets — and, where it is well-formed enough to name an entry and a node, it repaints that block with that refusal, because the gesture fold reads the identifiers a line carries and only the handler resolves them against the entry on display. Keeping it out of the menu is a `dsh-commands` change — one `listed` field on the descriptor — and it belongs with whichever row needs it second.
- **The wake budget is memory** — spent wakes live in a table keyed by the agent object, so a restart hands every agent a full budget again and a resumed session cannot tell how many turns its presses had already opened. The table of unclaimed `context` notices is keyed the same way and forgotten the same way: after a restart the first tick of a block queues a second notice beside the one the log still holds, which costs the model one superseded sentence and nothing else.
- **A press with nothing complete in it looks like a button that does nothing** — a filter bar starts holding one empty condition row, so the first press a user can make submits nothing; that press reports nothing, and the block draws no line about it either, because a line would say something happened. What the user gets is a button that answers a press with no change on screen at all. Greying the button out is the fix and it is not local: the block would have to know how many complete conditions the editor holds, which is the `change` gesture's own count, and drawing state off a count that arrives on every committed edit needs the two packages to agree about when the button may move. The trigger is the first report of a press that seemed to do nothing.
- **A block cannot say *why* a gesture was refused** — the fold settles a refused gesture into one state, so the block draws 这个动作没能记下来，可以再试 whether the action named nothing on display or carried more than it accepts, while the chat row beside it draws the handler's own 内容太多了，少选几项或写短一些再试。. The two disagree in front of the user about the same press. Telling them apart on the block needs a further `ComponentActionState` member, which is a contract between this package's fold and [`component-kit`](../component-kit/README.md)'s state table and dictionary; the trigger is the first deployment where the chat row is not beside the block.
- **The gesture fold is per block, not per action** — one cell per `(entryId, nodeId)`. It is enough today only because a component declares at most one `wake` and nothing else reaches a cell: the day one declares two, a block will draw the state of whichever of them it reported last. Growing the cell key by `actionId` is the fix, in [`src/action-state.ts`](src/action-state.ts) and the projection beside it, and it is what the second `wake` on one component pays for.
- **A press the log opened and never closed reads as on its way forever** — `command/run` and `command/done` are written either side of the handler, so a host that stops between them leaves a cell open, and nothing closes it afterwards. That block stays unpressable until a later call replaces the entry. A press that produced no record at all is the other case and settles itself: the dispatch says so, the page drops its row, and the block is answerable again.
- **The settlement sentences are Chinese in any interface** — `这个动作没能记下来。`, `内容太多了，少选几项或写短一些再试。` and `已记下，你下次发消息时对话会看到。` are written by the handler, which is handed no browser locale: a command result is one string, and the session log has to keep the words the user was actually shown. In a non-Chinese console they are drawn in the chat row beside a bar whose own lines came from [`component-kit`](../component-kit/README.md)'s dictionary and are localized. The fix is either a key the client translates or a locale carried on the command result, and the trigger is the console offering an interface in any other language.
- **The return channel has no assembled-transcript coverage** — the `snapshots/console` lane drives an ACP agent, and the ACP protocol has no command method, so no recorded transcript can carry a press. The lane composes the command registry regardless, because the description it pins tells the model a press comes back; the press itself is covered by the Playwright scenario against a real console composition, where the browser, the RPC gateway, the command registry, and the session log are all the shipped ones.
- **The model cannot see what the panel holds** — there is no read path. The agent knows which calls it made, not which entry the user is looking at, whether one was dismissed, or what any block currently shows.
- **An output is declared where a property takes it, and only there** — the catalog holds three: a table's `selectionDetail`, which a record block's `dataList` takes, and the data page's `editing` and `opened`, which a form page's `request` and an info card's `record` take. A table also knows the ticked rows in the form the call wrote them, and a filter bar knows the conditions it holds, and neither is declared, because no property here accepts either — an output nothing accepts is a binding the model is offered and then refused. Each is declared with the component that takes rows or conditions as an input: a catalog line and the renderer's `publish` call together, since neither renderer publishes one now. The rest of the catalog reports nothing at all, and a binding naming one of them is told so.
- **A property read as something narrower than text cannot be bound** — a path, a color, or a cell renderer name is read on the way in, over the value the call itself wrote; a bound property has no such value, so the whole property is refused rather than reaching a renderer having skipped its reading. That covers the property at any depth, which is why a table's `tableConfig` cannot be bound at all while its rows can.
- **An empty output leaves the blocks it feeds on the waiting line** — compatibility is kind and ceilings only, so a binding to a table's `selectionDetail` is accepted while nothing is ticked rather than the call being refused for a list the user has not made yet. The floor is still there at draw time: every bindable property in this catalog requires at least one item, so an empty selection substituted into one refuses the judged document, and the fed blocks draw the waiting line until the user ticks a row. Comparing floors statically instead would refuse the binding outright, which is worse: the pair could never be written at all, because a selection is empty until the user does something.
- **A binding reads one block, never a second entry and never an expression** — `$from` names one node, one of its declared outputs, and optionally one item of it. There is no arithmetic, no condition, no default, and no way to reach a block of another entry, because the seat's own props carry one entry at a time. A model that wants a value computed writes the value.
- **The arrangement is read twice, by two modules that must agree** — the host judges a `layout` and names the path it refused; the seat reads the same tree again at the wire edge, because the pass judging its nodes runs over the drawable ones alone and `layout` is kept out of that pass, and it answers a tree it cannot read with the plain column. The two share every word list — the directions, the gaps, the ceilings, and the keys each kind of node may carry — so what is written twice is the walk itself, and a rule of the walk added to one and not the other shows up as a call the model was told was fine and a column that ignores it. Collapsing them means exporting a layout reader beside the judgement, and the trigger is the second rule that has to be written twice.
- **A waiting block says only that it is waiting** — a block whose required property has nothing to stand for it draws one line, and so does a block whose value did not fit where it was put. The user cannot tell "tick a row above" from "what was ticked cannot be drawn here", and the second is a mistake in the call rather than something the user can act on. Telling them apart needs a second sentence and a way for the seat to know which case it is in past the refusal it already discards.
- **An empty value is drawn as an empty value** — a `toy.record` row whose `display` is the empty string keeps its label and shows nothing beside it. That is deliberate: the alternative reading, dropping the row, hides from the user that the record has the attribute at all. A model that means "this attribute is not set" writes the words for it.
- **Eight catalog entries** — the mapping from the rest of a real component library to catalog entries, and the packaging that gets those components into a browser bundle, are separate work.
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
- **A remembered answer is memory, and a renewal is a new person to it** — the consent table is keyed by the digest of the token this process holds, so a restart asks again and so does the deployment's own token renewal, which issues a different token for the same visitor. Asking once per renewal is more asking than the rule needs and less than no memory at all; keying it on a claim inside the token would mean reading a token this deployment authenticates nobody with, and the trigger is the first report that a person is asked more often than they expect.
- **A menu row and a call for the same page are judged alike and asked about differently** — both are judged by `judgeDataPageNodes`, but a call is put to the user through `ctx.approval` and a click is not put to anybody. That is the decision this row takes, and what it rests on is that every invocation of `/show-content-view` is a person's own click; a deployment that ever reaches that command from anywhere else would be opening a data page nobody chose.
- **A contributed view that loses an id collision is dropped, and its owner is not told** — the first claim wins and the later view is left out of the index with one error line. A package whose views are meant to arrive together therefore has no way to learn that one of them did not, and a skill pack that asks before it contributes ([`skill-pack-components`](../skill-pack-components/README.md) does) is held back by its own provider rather than by this index. Telling a source about a refusal at registration means a return value the registration does not have today, and the trigger is the second source.
- **A source is re-read only when it registers again** — the index is rebuilt from what each source last handed over, so a source whose own answer moved must register again. The one moment the index is out of date is a source between its two calls, and nothing here can see that moment.
- **A deployment with no views serves no catalog route** — the route and the command are claimed only where `views` has an entry, so a sidebar asking a deployment that configured none gets whatever the webserver's fallback answers with rather than an empty catalog. That is the same answer it gets where this row is not composed at all, and it is a case the sidebar already contains; what it costs is that the two cannot be told apart.
- **A view click has no assembled-transcript coverage** — the `snapshots/console` lane drives an ACP agent and the ACP protocol has no command method, so no recorded transcript can carry a click, exactly as none can carry a press. The lane still configures a view, because the load-time judgement over it is part of what booting that composition proves; what a click then does is covered by this package's own composition suite and by the Playwright scenario against a real console.
- **A stored entry carries its whole spec** — the column's projection keeps the validated spec per live entry, so it rides the wire value and the persisted checkpoint. The byte ceiling is what bounds it.
- **The drawn block is not covered by an assembled snapshot** — the tool's whole model-visible surface, the catalog spliced into its description and the result line included, is pinned by the [`snapshots/console`](../../../snapshots/console/README.md) lane, which composes this row for real and runs a call end to end. What the seat then draws is a Playwright scenario against a real console composition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
