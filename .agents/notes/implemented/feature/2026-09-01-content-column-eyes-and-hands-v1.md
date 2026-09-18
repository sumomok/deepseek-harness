# Agent Note: content column eyes and hands v1

Status: implemented

English | [中文](2026-09-01-content-column-eyes-and-hands-v1.zh.md)

## Problem

The content column puts something in front of the user — a hosted page today, a chart beside it, a spreadsheet or a slide deck once a second kind exists — and the agent beside it can see none of it. It knows the page catalogue a deployment configured and nothing else: not what the user opened, not which tab they are looking at, not where the application inside has routed itself, and nothing at all about what that application draws.

Four slices closed most of that gap for the page kind, and each records its own mechanism. What none of them records is the delivery they belong to: which layer answers which question, what a second content kind would have to hand in, what reaches the session log and what deliberately does not, what a deployment is allowed to set, what a real console taught about all of it, and where the line stops on purpose.

## Decision

Five layers, split by the question each answers rather than by the package that implements it. Version 1 delivers the first two for the page kind. The third is being built on its own line, the fourth is vocabulary, and the fifth is a route with two prerequisites.

### The layers, and where each one lives

| Layer | What it answers | Where it lives |
|---|---|---|
| Perception | What the column holds, who put each entry there, which one is in front, and where the application inside has gone | [the perception note](2026-09-02-content-column-perception.md) |
| Eyes | What the entry in front actually shows, as numbered structure a later call can point at | [the reading rules](2026-09-02-content-snapshot-engine.md), carried over [the read channel](2026-09-01-content-read-page-channel.md) |
| Hands | Operating that entry the way the user would, one approval per batch | Being built on its own line; see [Deferred](#deferred) |
| The kind contract | What stays the same when the column holds something that is not a page | This note |
| Reuse | Turning what was done once into a capability the next session can call | Unbuilt; the route is under [Deferred](#deferred) |

The reading half ships before the acting half, and the order is a dependency rather than a schedule: every step of an action names its target with a ref the reader minted, so a reader that reads a page wrongly is an agent that clicks the wrong element.

### What a kind hands in

Only a small part of the machinery above knows what a page is. The split is the contract a second kind is written against, and it is fixed now because the words are the interface — not the registry, which has one implementation to generalize from and therefore waits.

| Layer | Kind-agnostic | The kind's own |
|---|---|---|
| Perception | The entry stream, which entry is in front, the notices, the prompt context | — |
| Addressing | A ref: an address inside one entry | What an address looks like |
| Seeing | The map, entering a region, the cursor, and the budget they render under | How structure is read out of the thing |
| Acting | A batch of labelled steps, one approval, step-by-step results | The action vocabulary |
| Pointing | A chip in the conversation naming a kind, an address and a label | How the renderer lets the user pick |
| Reuse | Object signature, capability declaration, orchestration, source memory | How a signature is computed |

A kind hands in four things: a rendering seat in the `content.surface.kind` slot [`content-column`](../../../../packages/experimental/content-column/README.md) dispatches, a structural read, an address form with an action vocabulary, and optionally a picker. A kind that carries data hands in a fifth — a data read answering with values rather than text — and a data-heavy kind cannot be useful without it. Whatever a user hands over, through the conversation or through the column, gets a seat, and the same pointing, reading, acting and reuse apply to all of it.

### What reaches the session log

Two rules decide it. Anything a model request carries must be reconstructable from the log. And a replay must be able to say what the user was looking at — what the column held, which entry was in front, and where the frame had gone.

| Fact | How it is recorded |
|---|---|
| A page put in the column, by the user or the agent | `content/shown` |
| A tab closed | `content-surface/dismissed` |
| The tab the user picked | `content-surface/selected`, appended by the switcher's own command |
| Where the frame has routed itself | `content/navigated`, appended after the browser's settling window |
| A page opened or a tab closed, as the conversation reads it | A `user/message` the command injects |
| What the column holds on every request | The `content:column` prompt context, folded from the two projections |
| A read's call and its answer | `tool/call` and `tool/result`, and the code-mode dispatch pair when the read runs inside `run_code` |
| An approval question and its answer | `approval/asked` and `approval/decided` |
| A claim, the pinned tab, a frame's ref table, a frame reload | Nothing: runtime state, which the model learns from the result or the failure sentence |

Every event this line adds is required on read, because `Session.append` offers no way to mark one ignorable and this fork does not change upstream core to add one ([mechanism](2026-09-02-content-column-perception.md)). A build that does not know these types therefore refuses the whole log rather than skipping an event it cannot type.

### What a deployment sets

No deployment-varying number in this line is a constant inside a plugin. Every one of them is a validated `Config` field on [`content-frame`](../../../../packages/experimental/content-frame/README.md), whose own JSDoc says which way to move each and why; what this note owns is the set and the bound each is refused at.

| Setting | What it bounds | Refused at load |
|---|---|---|
| `cacheSize` | Frames kept alive, counted over (session, page) pairs | Below 1 |
| `navigationPollMs` | How often the frame in front is asked where it is | Below 1 |
| `contextEntries` | Entries the prompt context lists | Below 1 |
| `contextFieldChars` | Characters of a name one context line carries | Below 8 |
| `claimTimeoutMs` | The wait for a console to claim a read | Below 1 |
| `readTimeoutMs` | The wait for the claiming console to answer | Below 1 |
| `pinMs` | How long the tab that answered stays preferred | Below 1 |
| `settleQuietMs` | The stillness that counts as a page having been drawn | Below 1, or above its share of `readTimeoutMs` |
| `outlineChars` | Characters one listing is rendered under | Below 1000 |

The reading half is one block rather than one flag per piece: `pageAccess` absent means no tool, no routes, no pending projection and no reader in the browser, because the pieces are useless separately ([why](2026-09-01-content-read-page-channel.md)). The model has no budget parameter of its own — narrowing a read is the tool it is given, not a number to raise.

### Probes before guidance, and how guidance retires

A sentence that tells the model to do something costs context on every request that carries it, forever. So a question of the form "will the model do this by itself" is measured before it is answered: a fixed prompt against a real console page, ten fresh draft sessions, scored from the session logs. P0 asks whether a user saying "that table on the right" makes the agent read the page.

| Build | First call is a read | Redundant `content_show` | Answered the true total | Median reads | Median seconds |
|---|---|---|---|---|---|
| Before the column context | 2/10 | 8/10 | 10/10 | 6 | 12.5 |
| With the column context | 11/11 | 0/11 | 10/11 | 6 | 13 |
| With the merged table reader | 10/10 | 2/10 | 1/10 | 3 | 6 |

P0 needs no guidance at all: the model reached for the read unprompted in every round, and the answer was right whenever the reader gave it the right numbers. What the column context bought is the redundant call — a model that cannot see the column shows a page that is already in front on eight questions out of ten, and the context takes that to zero. What the third round exposed is a counting regression, recorded under [Deferred](#deferred).

Guidance that does get written carries three things together: a `Config` switch that turns it off, two lines in an Agent Note naming which model weakness it compensates and which probe run retires it, and the probe script in the repository. The rule does not cover what carries safety — the approval, the label check before a step runs, the refusal to fill a sign-in form — which is not compensation and never retires.

### What the real console taught

The reader was written against fixtures and then pointed at a real Element UI console. Every finding below changed the product, and each rule it produced is recorded with the rules it belongs to.

A component library pins a column by drawing the whole table again over the top of itself, so one table the user sees is six tables in the document, and a reader that treats them separately answers with the pinned columns empty and tells the user a column they can see does not exist. A row's commands can carry no clickable signal whatsoever — no role, no label, no title, no pointer cursor — which is what the reader's class-name heuristic for icons exists for. A form can tie no label to any field and draw its required marks with a stylesheet, so a read that trusts the document alone answers with a form of forty-nine fields, a name on none of them, and no way to tell which the page insists on.

The model reads three to ten times per question, walking map to region to text match, and it quoted the refs it collected back at a user who has no way to see one — which is why the rule against that sits in the column context rather than in the tool description ([placement](2026-09-02-content-column-perception.md)). When the answering console left the session, the failure sentence offering `content_show` first sent the model around that loop ten times in eighty seconds, which is why the sentence now branches on what the column holds ([both paths](2026-09-01-content-read-page-channel.md)).

Across two pages open at once the agent named the right one every time, including after the user closed the tab it had been reading. Refs are per frame, and two pages' main tables can carry the same number, so a scope aimed at the page that is not in front can be accepted and match nothing rather than refused.

### What this line does not do

| Rule | What it prevents | Reconsidered when |
|---|---|---|
| No page adapter: no component library's name appears in the reader | A reader that stops working when a deployment upgrades its own dependency | Never |
| The tools never touch the session in the frame | A tool that forges a sign-in, and [`auth-gate`](../../../../packages/experimental/auth-gate/README.md)'s work leaking in here | Never |
| A read answers for the entry in front and takes no address | Reading behind the user's back, and steering the frame anywhere | Never |
| A read is never cut blind: over budget it answers with the map, or with a cursor | A model holding half a listing with no way to reach the rest | Never |
| What the model knows about the column comes from the perception layer and nowhere else | A model that believes it knows what the column holds | Never |
| Not a browser: no tabs opened, no other sessions, no reading the conversation column | A second browser extension | Never |
| No arbitrary script inside the page | An approval preview no one can read | A read and an act together cannot reach the data |
| No mechanism that keeps the most recent listing | A second compaction | Never |
| Nothing runs without a visible console, and nothing queues for one | An action taken while nobody is watching | Never |
| One claim per call, and a claimed call is never replayed | A delete pressed twice | Never |
| A password's value never leaves the page, and nothing invisible is read | A credential in the log, and a model clicking at nothing | Never |
| Guidance that compensates a model ships with its own retirement | A strong model still paying for guidance written for a weaker one | Never |
| No screenshot, no hover, no diff between two reads | A rendering dependency and a diff engine to keep working | A page proves unreadable, or a menu appears only on hover |
| The page kind is the only implementation | A registry built around one case | A second real kind lands |

## Alternatives considered

**Shipping the reading half and the acting half as one slice.** One design, one review, one round of tests. Rejected because an action names its target with a ref the reader minted, and against real component-library markup the reader answers with a column the user can see and the model cannot name, with a table dropped as one thing the page drew twice, and with a form whose fields nothing can tell apart. Each of those is an action on the wrong element. A ref the reader gets wrong is an action on the wrong element, so the reader was measured against a real console before anything was allowed to click.

**Answering with a screenshot instead of a structural listing.** A picture is what the user sees, and vision models read one. Rejected because a picture has no addresses in it: the whole point of the listing is that the model can name an element in a later call, which is what makes reading a large page and acting on it possible at all. A screenshot stays a ceiling rather than a rejected idea — its trigger is a page whose critical information the reader cannot produce.

**Writing the guidance first and measuring afterwards.** Every sentence in the design's failure text and system prompt was a plausible thing to tell a model. Rejected on the first probe: the model already read the page unprompted in ten runs out of ten, so guidance telling it to would have been permanent context spent on a weakness that is not there. The context block earned its place by removing a call the model was making, measured, rather than by adding an instruction.

**Letting a read name any entry, or any address.** A parameter naming the entry or the URL would make the tool useful with the console closed and let the agent survey a page without disturbing anyone. Rejected because a read is defined as what the user is looking at: reading something the user cannot see makes the answer unverifiable to them, and an address parameter turns the column into a browser the agent drives. Changing what is read costs a `content_show`, which the user sees.

**Building the kind registry now.** The contract is written; a registry over it is a small step and would make the second kind free. Rejected because one implementation cannot show which parts of the vocabulary are general. The words are fixed instead, which is what a second kind actually needs, and the registry is extracted when there is a second kind to extract it from.

## Consequences

The agent can say what is on the user's screen, in their words, and answer questions about it. It cannot touch it: the acting layer is not in this delivery (see [Deferred](#deferred)).

The standing cost is one prompt-context block on every request in a session with a live column, bounded by two deployment settings, plus one listing per read bounded by a third. A deployment that writes no `pageAccess` block pays none of the read half at all — no tool, no routes, no reader.

Counting a paged table is the one answer this line gets wrong on a real console, and it got worse as the reader got better: a table that looks complete is a table the model stops looking past. What is left to do about it is under [Deferred](#deferred).

Everything a deployment needs to change is a validated field, so a console whose users keep a dozen entries open, or whose application repaints slowly, is configured rather than patched. The price is every field listed above to get right, each of which refuses a value it cannot work under at load.

This line's session vocabulary is not the desktop build's and none of it is ignorable, so the two cannot share a harness home: this console runs on one of its own.

## Deferred

**Acting on the page.** `content_act` is not in this delivery; it is being built on a line of its own, and the contract below is what it is being built to rather than a settled interface — the implementation settles it, and the note that ships with it owns the result. A batch of steps, each `click`, `fill`, `select`, `press` or `wait`, over the entry in front. A `label` on every step, copied from the listing, because the approval panel can render nothing but the call's own arguments and the browser re-checks the element's name against it before the step runs. One approval for the whole batch, refused outright where no approval service is composed. The first failure stops the batch, and what the page did while the steps ran comes back with the result. No new event type: the call, the result and the approval already have theirs. `actTimeoutMs`, `maxSteps` and `settleMaxMs` join `pageAccess` with that slice, so the settings above are this delivery's rather than the final set.

**Counting a paged table.** The strip carrying a table's total is paired to the table drawn nearest it, and any other table between the two breaks the pairing — which is exactly what a pinned copy is. On the real console the model therefore answers with the rows on the page rather than the total, in nine runs out of ten. The fix is to pair the strip across the pieces of one table; P0's third round is what exposed the gap.

**Version 2, each with the trigger that starts it.** Picking an element on the page to hand the agent a chip; data reads through the framework the page is written in, and through a canvas library's own API where there is no DOM to read; capturing the deployment's own network traffic at the reverse proxy, which also gives the settle wait a signal that says the page is still fetching; file upload and a copy of a download; scrolling until a row appears, dragging, and editing a rich-text field; and a way for a file to reach the agent at all.

**Version 3, reuse.** An object signature, a capability that declares which signatures it accepts, an orchestration step that plans before it acts, and a memory of what was used on this kind of input last time. Its prerequisites are the version 2 network capture and a probe result: whether the model proposes and stores a capability without being told to.

**The kind registry**, when a second real kind lands.

## Testing

P0 is this line's fixed regression probe, not a one-off measurement: the same real console page, the same question, ten fresh draft sessions, scored on the first call, the redundant `content_show` calls, the number of reads and the answer. It is re-run against any build that changes the reader or the context, and it is what caught the counting regression that no unit test could have.

Recording a keyless fixture for this line takes one script per session, with calls bound in first-call order, and cuts the seeded history at the `session/end-seed` boundary before harvesting (`afterSeed` in [`apps/web/tests/scaffold.ts`](../../../../apps/web/tests/scaffold.ts)) so the fixture replays the turn rather than the history the scenario was seeded with. Recording needs an API key; replay does not.

Unit and browser coverage belongs to each slice and is recorded with it: the reading rules over fixtures written as four component libraries draw them, the channel's two routes and their refusals, and the perception layer's events, context and navigation watch, each with a Playwright scenario over a real composition.
