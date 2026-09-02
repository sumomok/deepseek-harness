# Agent Note: what the agent knows about the content column

Status: implemented

English | [中文](2026-09-02-content-column-perception.zh.md)

## Problem

The content column is drawn by the browser, and until this change the agent could see none of it. Three facts in particular never reached a model request. A user opening a page from the sidebar's navigation menu changed what the conversation was about, and the agent was the only party in the room that did not notice. A user bringing another tab to the front was a decision that lived in one browser tab's component state and vanished on reload, so neither the agent nor a second console could know which entry the user was looking at. And the application inside the frame routes itself constantly — a menu click, a redirect after sign-in, a table replaced by a detail view — none of which touches the page id the column recorded, so the agent's picture of the column was right about which application was on screen and wrong about everything inside it.

The reader shipped in [the page-read channel note](2026-09-01-content-read-page-channel.md) made the gap worse rather than better: a model that can read the page in front of the user is a model that will be asked about it, and it was reading a page whose address it could not name and whose arrival it never heard about. It was also reading whenever the tool call landed, which for a single-page application means somewhere in the middle of the page drawing itself.

## Decision

Three facts, three carriers, each chosen for how often the fact changes and who needs it.

### A page the user opened is a message; a tab brought forward is not

`show-content-page` injects one sentence after its `content/shown` append — `The user opened the page "<title>" in the content column (内容区); it is in front now.` — as a plugin-sourced `user/message` with `form: 'notice'`. `content-surface`'s `dismiss-content-entry` does the same for a closed tab. `select-content-entry` injects nothing.

The line between them is how often the gesture repeats and what the agent would do differently. Opening a page and closing a tab change what the conversation is about, and each happens a handful of times per session; bringing a tab forward is a glance, repeated as often as the user looks around, and an agent that heard every one of them would read a transcript that is mostly the user looking around. Which entry is in front reaches the model through the column context instead, where it costs one marker on a line that is there anyway.

`inject` rather than `queue`: opening a page is not a question. The notice is queued for the agent's next pre-step and wakes no driver, so an idle agent stays idle until the user says something. It is durable from the moment it is queued — the inbox splice is itself a session event carrying the whole message — and enters the model-visible surface as a `user/message` when a driver claims it. It is a `user/message` because that is the model-visible surface: anything reaching a model request must be reconstructable from the log, and an injected context message is how this repository carries a fact the user did not type.

### Which entry is in front is a logged decision, and the later fact wins

`content-surface/selected` records a user's tab choice; the `contentSurface` fold keeps the latest one beside the records and publishes `front`. The rule resolving it against the stream is one line: **a selection loses to any entry recorded after it.** A user picking a tab and the agent showing a page a moment later are both real intentions, and the later one is what the column follows.

The browser half applies the identical rule to the click it is still holding — the moment between the button and the record of it arriving through the projection — which is why both compare by `seq` rather than by wall-clock time or by arrival order. A `front` naming an entry no longer in the stream falls back to the newest entry, so neither a dismissal nor a redraw can blank the column.

### Where the column stands is a prompt context, never a section

`content:column` at order 130 lists what the column holds, newest first, marks the entry in front, and for a page whose frame has moved away from its configured address names the address it is at now. It is a `ctx.systemPrompt.context`, not a section, for the reason `approval:policy` is one: the value changes as the user works, and a context is materialized after the retained history, so a column that moved does not rewrite the stable system-prompt prefix the provider caches.

Nothing in it is timestamped. A relative time ("opened 3 minutes ago") would differ between a live run and its replay, which would make every recording of a scenario that shows a page unreplayable; the conversation the model reads already carries the order things happened in.

The whole block is folded from this session's own projections — `contentSurface`'s entries and this package's `contentPages` state — so the model-visible half is reconstructable from the log. `contentPages` records who opened each page and where its frame went, and carries no `wire`: no browser reads it.

### The ref rule lives in the context, not in the tool description

`Refs like e12 are your handles for content_read's scope and after; when you answer the user, name what the page shows, never a ref.` sits in the column context's closing lines, offered only where the deployment configured a reader.

It governs the answer rather than the call. A model choosing `content_read` has already read its description; the sentence it writes to the user afterwards is composed against whatever the request carried, and the description is far behind it by then. Recorded runs had the model quoting `e9` back to a user who has no way to see one — the context is the last thing before the conversation, which is where a rule about the reply belongs.

### A route change is polled, never patched

The browser half watches the frame in front for `load`, `hashchange` and `popstate`, and polls its `location.href` every `navigationPollMs`. Everything the four signals produce goes through one 300ms settling window, is compared against the last address reported for that frame, and becomes one `content/navigated` carrying the page id, the path, the document title, and `by: 'user'`.

Polling exists because none of the three events fires for `history.pushState`, which is how every current router changes route in history mode — the case a navigation watch exists for is the one no event announces. The alternative is below; what polling costs is one same-origin property read per watched frame per interval, and up to one interval of latency before a move that then sits still is noticed. `navigationPollMs` is a Config field rather than a constant because that trade is a deployment's: a console whose application routes constantly wants a longer interval than one whose agent is asked "what is on the screen" seconds after a click. The factory value is one second, which is under the time it takes a user to finish a sentence and far above the cost of the read.

`by` is `'user'` for every navigation this slice records, and `'agent'` is reserved: the field exists so the hands slice can record a click the agent itself made without a second event type.

### A read waits for the page to stop drawing itself

Between the load wait and the walk, a read installs a `MutationObserver` over the frame's document and answers as soon as it has held still for `settleQuietMs`, giving up at `readTimeoutMs × SETTLE_WAIT_SHARE`. The two shares of the report deadline — `LOAD_WAIT_SHARE` for a page still loading, `SETTLE_WAIT_SHARE` for one still drawing — sum to less than one, which a test pins, so the walk and the trip back keep the rest.

Both outcomes reach the model rather than being hidden inside a retry. A page that never settled is read anyway and the listing header says so, because the listing is a real read of that instant and the model is the one who decides whether to read again. `ReadOutcome` carries `settled: boolean`, validated at the report route like every other field, so the fact crosses the process rather than being re-derived on the host. And whatever the page marks `aria-busy="true"` while visible is named on a header line of its own, at most three, through the engine's own naming ladder — a page that says which region is still loading has told the model exactly what a screenshot would have.

`role="progressbar"` is not read as a busy mark: a page can draw one as its subject, and a dashboard of progress bars is not a loading page. No framework's loading class is read either, for the reason the whole engine is written that way — [the engine note](2026-09-02-content-snapshot-engine.md) records that rule.

`content/navigated` does not wait. An address change is reported the moment the frame settles at it, and waiting for the page behind that address belongs to reading it. The division with the engine's own ref invalidation is the same split: navigation is a fact about the column, ref lifetime is a fact about a document, and the engine already owns the second — the ref table is reset on the frame's `load`, a ref whose element left the document resolves to nothing, and a stale `scope` or `after` is refused with a message telling the model to read again. Nothing in this slice touches that, and `content/navigated` deliberately does not invalidate refs: a SPA route change that keeps the document alive keeps the refs that still resolve, and the ones that do not are already covered.

### Neither new event is `ignorable`

`content-surface/selected` and `content/navigated` are required-on-read, like `content/shown` and `content-surface/dismissed` before them. That is not a judgment that a build should refuse a log over a selection — it is that `Session.append` offers no way to set the marker today, and adding one is a change to upstream core, which this fork does not make. A runtime whose session vocabulary excludes these packages refuses the whole log rather than silently showing the wrong tab. Any build of this repository knows both types.

## Alternatives considered

**Patch `history.pushState` inside the frame.** The obvious way to see a route change with no polling at all: wrap the frame's own `history.pushState` and `replaceState`. Rejected on ownership. That document belongs to the deployment, not to this package, and a router installed after the patch — every framework wraps `history` itself — takes it straight back out, leaving a watch that reports nothing and says nothing about why. Polling reads a property the frame already exposes and needs the page's cooperation for nothing.

**Make the selection UI-local, as it was.** The column already tracked the selected tab in component state, and leaving it there costs no event type. Rejected because it fails the model-visible-implies-logged rule the moment the context names which entry is in front, and because it was a visible product defect on its own: a reload put the user back on the newest entry rather than the one they were reading.

**Say which entry is in front in a system-prompt section.** A section is simpler to register and reads the same. Rejected because a section is part of the cached prefix: the column changes several times per session, and each change would invalidate every request's prefix from that section onward. A context is materialized after the retained history precisely so a moving value costs nothing upstream of it.

**Inject a notice per navigation.** Symmetric with the page-opened notice, and it would carry the address into the conversation where the model reads it in order. Rejected on volume: an application routes under the user constantly, and one message per route change would be the noisiest thing in the transcript for the least new information. The context carries where the frame is at the cost of one line, refreshed for free on every request.

**Put the ref rule in `content_read`'s description.** It is a rule about refs, and refs are the tool's. Rejected because the tool description is read when the model chooses the tool and the rule applies to the sentence it writes afterwards, by which point the description is thousands of tokens behind. Both placements were available; only one is adjacent to the text it governs.

**Retry the read instead of reporting a page that never settled.** A read that lands mid-paint could be discarded and re-run. Rejected because the deadline belongs to the host: a retry inside the seat spends the model's report deadline on a decision the model can make better, having seen the listing and the line saying it may be stale.

**Wait on `document.readyState` or a network-quiet heuristic instead of mutations.** Both are cheaper. Rejected because neither describes the thing being waited for: `readyState` is complete long before a single-page application has drawn anything, and network quiet says nothing about a page rendering from data it already has. What the read needs is the DOM to stop moving, which is what a `MutationObserver` reports.

## Consequences

Every request in a session with a live column now carries the column context — one line per entry, at most ten listed, each field cut to 120 characters, plus two or three closing lines. That is the standing cost of the agent knowing what is on the screen, and it is paid on requests where the model never asks about the column.

A page the user opens costs one permanent sentence in the conversation, and so does a tab the user closes. A tab brought forward costs a session event and nothing in the transcript.

Two new required-on-read event types enter the session vocabulary, and `contentSurface`'s fold semantics version moves to 3 — both because the fold gained a case and because its stored state changed from a bare record list to `{ records, selected }`, so a checkpoint written under the old shape is discarded rather than replayed.

Every watched frame costs one property read per `navigationPollMs`, and only the frame in front is watched: a cached, hidden frame that routes itself is noticed when it comes back to the front. A frame that has left the dsh origin answers every read with a `SecurityError`, and the watch reports nothing rather than failing a read the user never asked for.

Reads of a page that never holds still now carry a header line saying so on every one of them. That is the honest answer rather than a defect: the budget bounds the wait, not the page.

## Testing

Unit suites pin the fold's `front` rule and both commands' refusals, the two new events' payload validation, every model-visible string verbatim (`perception/text.ts`, `access/text.ts`), the settling wait and the busy naming under fake timers in jsdom, the navigation watch against a stub frame — including a `pushState` that fires nothing, a repeated address that reports nothing, and a cross-origin frame that says nothing — and the column context over a real Loader composition, where the commands actually run and `assemble()` carries the block.

`apps/web/tests/content-perception.e2e.ts` drives all three facts through a real browser with no model call: a sidebar page click and the notice it injects, a switcher click and the selection surviving a reload, a `history.pushState` inside the live frame and the `content/navigated` it produces, and the assembled context naming both pages and the address the frame routed itself to. `apps/web/tests/content-read.e2e.ts` asserts that a settled fixture page carries neither header line.

## Deferred

The keyless snapshot asserting a model's final answer carries no `e<n>` ref is not added here: the committed `content-read` fixture was recorded before the ref rule existed and its answer quotes several refs, so the assertion would only be honest against a re-recorded fixture. Recording needs an API key this slice does not hold.
