# Agent Note: content_read and the browser channel behind it

Status: implemented

English | [中文](2026-09-01-content-read-page-channel.zh.md)

## Problem

The content column puts a page in front of the user, and the agent that put it there cannot see it. Everything it knows about that page came from the deployment's own configuration — an id, a title, a one-line description — so a conversation about what the user is looking at runs on the agent's imagination. Asking the user to describe the screen is the workaround the absence forces, and it is the one thing an agent sitting beside the screen should not have to do.

Reading the page is not a host capability. The document lives in an iframe in somebody's browser, rendered by a real engine with real layout, and the host has neither the DOM nor a way to address the browser holding it. Whatever answers the question has to run in the page seat and get its answer back into a tool call that is still waiting.

## Decision

`content_read` is a tool whose body computes nothing. It validates its arguments, registers a wait keyed by `exec.callId`, and publishes the call in the session's own `contentAccess` projection. The page seat showing that session claims the call over `POST /content-frame/claim`, walks the frame's document with the structural reader that already lives in `src/client/access/`, and posts the listing to `POST /content-frame/report`, which settles the waiting call. Everything the model is ever told about a page therefore comes from a browser that was looking at it.

The whole slice is `Config.pageAccess`, and absent is the default: no tool, no routes, no projection unit, no `pageAccess` field in the settings document, and no reader installed in the browser. A deployment that only shows pages does not pay for a capability it did not ask for, and the switch is one block rather than one flag per piece because the pieces are useless separately.

### Two phases, not one

A read waits twice. `claimTimeoutMs` bounds the first phase and answers "no console is showing this session's content column"; `readTimeoutMs` bounds the second and answers "the console claimed this read but did not answer". The distinction is the whole reason for the claim round trip: the model's next step differs — open a console versus retry once — and a single deadline would collapse both into one unactionable timeout.

Both deadlines belong to the host, and the seat is served both so it can stay inside them. Its re-bidding is bounded by the claim window rather than the report deadline, because that window is what the call is actually waiting inside; and it spends at most half the report deadline on a page that is still loading, because the host started counting the moment it granted the claim. Without that share the "page had not finished loading" sentence is unreachable — the host answers first, every time. Inside those bounds a claim or a report that never lands is tried again rather than abandoned: one dropped request would otherwise tell the model no console is open while the console sits in front of the user.

### One session's reads stick to one tab

Refs (`e12`) name elements of one document in one browser. Two consoles open on the same session answering alternate reads would hand the model refs that name nothing in the document the next read reaches. The table therefore pins the tab that last answered for `pinMs` and holds any other tab's claim for a fixed 250 ms so the pinned one can take it first — long enough for a live console to win the race, short enough that a closed one costs a quarter second.

### The call id is the capability

The two routes carry the same `sec-fetch-site` and `application/json` fences the shell's `/api` uses, and no Host allow-list, because the webserver has none and `trustedHosts` guards `/api` alone. What stands in its place is the call id: claiming or answering a read requires an id the host minted and published only into that session's own projection stream, and a claim or report for an unknown id changes nothing. This is the same argument `show_chart`'s report route rests on, with a larger consequence — page text reaches the model — and the same conclusion, because the id is not guessable and a wrong id is inert.

The premise underneath that, stated because nothing enforces it: the entropy is the LLM provider's, not this package's. DeepSeek's call ids are `call_00_` plus twenty-four alphanumeric characters whose last four are digits, and `code-mode`'s subcalls are that same id plus `:code:<n>`, which is roughly 130 bits either way. This package never inspects the format and never adds to it. A provider that numbered its calls `call_1`, `call_2` would turn both routes into an open channel for any page that can reach the host: half of it — claiming, then reporting a forged listing — puts text of the attacker's choosing in front of the model. A deployment on an untrusted network is fenced at its reverse proxy regardless, but a deployment changing providers has this to check.

### A refused body is not a body read

Both routes hold a posted body to a byte bound — a claim to a kilobyte, a report to the seat's own render budget at four UTF-8 bytes per character plus a JSON envelope — and the bound is a running total over the chunks as they arrive, not a check on the declared `content-length`. Refusing on the header alone reads nothing in the route and everything in the process: node drains a body nothing consumed off the wire once the exchange finishes, so a request refused for its size still costs its size.

Every refusal therefore consumes the body itself, to the route's own bound, before its answer goes out — the reader for a body past the bound, a counting listener for the four refusals written before the reader runs — and closes the connection with it. Both halves are needed. Consuming is what stops node's drain, and closing does not: node has resumed the request by the time the socket goes. Closing is what stops the consuming from running on, because node destroys the socket as soon as the answer has flushed. Measured on this machine's loopback, an eight-megabyte post costs 131,072 bytes on every path that reads to a bound, against 8,388,747 for the same post drained; the cross-site and wrong-content-type refusals cost 490,792 and 555,288 before they consumed anything of their own.

The trade is that a client still writing megabytes may lose the race for its own refusal; a body a real seat could produce is a few kilobytes past the bound and receives it.

That refusal is a 413 rather than the 400 a malformed or wrong-shaped body gets, because the two are different mistakes: one body was never read, the other was read and is not the document the route takes.

### The byte bound is computed from the wire's own field bounds

The envelope around the listing was a constant while everything inside it came from the page: `url`, the document title, the breadcrumb trail and the open dialog's name were checked for type and not for length. A page with a six-thousand-character title therefore posted a legitimate report of 6266 bytes and collected a 413 for it.

Each of those fields now carries a bound — 2048 characters for the address, 200 for the three header fields (the clip the reader already applies to every text it prints), 256 for the ids, the page title and a failure's named entry, 32 for the cursor, and the 2000 a failure message already had. The seat cuts what it posts to them, and the envelope is those bounds added up at four UTF-8 bytes per character plus 512 for the punctuation and key names, which is 23,328. No character costs more than four bytes, so a listing rendered inside the budget arrives whole whatever the page is written in.

The budget itself gained a floor of 1000 characters, because a listing can exceed it: the renderer prints a listing's first row however long that row is, while the parser holds a posted listing to four times the budget. The longest row the reader prints is a table block — the table's name, a header row and a sample row of its cells, the rows hint and the pagination line, each text clipped at 200 — which is about 535 characters plus 402 per column. Four times the floor is 4000 characters, which holds that row for a table of eight columns. A table wider than that is what this bound can still refuse.

### A refused report is not posted again

A report that never landed is worth sending again; a report the route refused is not, because the second post carries the same document to the same check. The seat tells the two apart — an answer in the 4xx range is the route deciding about this document, a network failure or a server failure is not — and tries again only for the second, for a claim as much as for a report.

The model reads the same sentence either way. The host cannot recover the call id from a body it stopped reading, so a refused report ends as the report deadline passing and `unansweredRefusal`, which tells the model to retry once and then ask the user to reload the console. That advice is right for what is left: with every field bounded and the seat cutting what it posts, the deterministic refusals a real seat can still collect are the ones where its settings and the host's disagree — a console that booted before the deployment changed `outlineChars` — and reloading the console is what fixes exactly those.

### Every ending is a sentence, and every failure throws

The tool returns a value for exactly one outcome: a listing. Everything else — no console, no answer, an empty column, another kind in front, a stale ref, an unreadable frame, a sign-in form — throws, with a sentence naming what to do next. A failure is the only tool text a model reads while deciding its next step, so an outcome returned as a `status: 'empty'` value would be read past. The sign-in case is the sharpest: the listing exists and is withheld, because a password form is where the agent hands the keyboard back rather than narrating.

### The reader lives in the page seat

`content.surface.kind` is root-scoped, so the framework binds it no `useProjection` and no session id; the seat reads its session's values off the list snapshot every root slot receives (`useSessions(state => state.byId[id]?.projectionValues?…)`), the way the column's own router already does. The seat is nonetheless the only possible placement: it is the one component holding the iframe elements, and a read without the element is a read without a document. It also owns each frame's ref numbering and retires it on the frame's `load`, because a ref names an element of the document that just left.

## Alternatives considered

**Forwarded cordis events, the way `cordis/inspect-query` asks a browser a question.** That mechanism fits the shape of this problem better than HTTP does — the host emits, the browser answers through a Typert `@Remote`, the first valid answer wins, and ownership is checked. It was rejected on ownership, not on merit: the forwarded-event allow-list is a literal array in `@deepseek-ai/dsh-api-remotes`, and adding an entry means editing an upstream package this fork does not modify. The HTTP channel is entirely inside this package and costs two routes.

**One deadline instead of two.** Simpler table, one timer, one refusal. Rejected because the two failures are not the same instruction: a session with no console open needs the user to open one, and a console that went quiet needs a retry. Collapsing them produces a message the model can only guess at.

**Answering the first browser that claims, with no preferred tab.** Rejected because refs would stop meaning anything the moment two consoles are open on one session — the model would read `e12` from one document and point at it in another. The pin costs one held claim per read at most, and only when an unpinned tab bids first.

**Returning failures as ordinary values.** A `{ status: 'empty' }` value keeps the tool from ever "failing" and lets the model branch on a discriminant. Rejected because the model does not branch on discriminants it was not told about, and the failure sentence — which names `content_show`, or the parameter to drop — is what actually changes the next call. This is the cookbook's rule about naming the parameter in the failure that parameter would fix.

**Putting the reader in `shell.overlay` instead of the page seat.** A global overlay row is always mounted and independent of what the column shows. Rejected because it cannot reach the iframe elements except through `document.querySelector`, which would couple the reader to the seat's DOM attributes rather than to its own state, and would leave the per-frame ref tables homeless.

**Composing the whole model-facing sentence in the browser.** The seat knows why a read failed, so it could send finished text. Rejected for the two cases the host can state better: an empty column and a non-page entry are facts about the session, and their sentences name `content_show`, which is the host's own tool. The seat sends a short reason for those and the finished sentence only for the frame failures, which are the ones no host can describe.

## Consequences

The agent can read the page it put in front of the user, bounded by `outlineChars` per read and by two deadlines per call. A deployment that wants none of it writes nothing and gets none of it.

The channel is a browser dependency in a tool result. A read has no answer when no console is open, when the tab is hidden, or when the console is on another session — all three are stated rather than approximated, but none of them can be worked around from the host, and a headless composition can never call this tool successfully. That is the correct behavior and a real limit on where the tool is useful.

`content-frame` now depends on `@deepseek-ai/dsh-client-ui-tool` for the transcript row's slot declaration — a type-only import, but a manifest and tsconfig edge that did not exist before.

The browser lane is the only place the real path can be exercised: jsdom has no layout and never loads a frame pointed at a real route, so the package's own suites read hand-mounted documents and `apps/web/tests/content-read.e2e.ts` covers the assembled composition.

The structural reader itself is untouched by this change. Its refusals travel to the model verbatim, so a wording change there is a change to what the model reads, with no test in this slice pinning it.

## Follow-ups

Three body readers now live in this repository, and they are no longer one shape: this package's listens for chunks and answers a discriminated union, `@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc`'s collects `Buffer`s under `for await` and is bounded, and `@deepseek-ai/dsh-llm-mock-server`'s collects them under `for await` with no bound at all. Extracting one reader now means first deciding which of the three it is. Together with the nine-line `hide-empty-command-row.ts` clone `content-frame` and `@deepseek-ai/dsh-experimental-content-column` each carry, they wait on the same thing: a host-side home both experimental packages belong to. `packages/host/webserver` is upstream source this fork does not edit, and neither experimental package is the other's home, so extracting them is a separate change once that home exists.
