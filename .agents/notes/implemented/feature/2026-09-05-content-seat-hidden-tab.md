# Agent Note: the page seat answers from a tab the user is not looking at

Status: implemented

English | [中文](2026-09-05-content-seat-hidden-tab.zh.md)

## Problem

Two facts kept the six content-column tools from answering a console that was open and working.

**Visibility was a veto.** The seat claimed nothing while `document.visibilityState` was `hidden`, and the model was told `No open, visible console tab is showing this session's content column`. That word covers more than a tab in the background: macOS reports a foreground window another window covers as hidden, and so does a locked screen. [The claim-restart note](../bug-fix/2026-09-03-content-seat-claim-restart.md) recorded 33 of those refusals in about 400 calls on one running console with the user sitting at it, named the fix in its line 46 — visibility as a preference rather than a veto, matching the host's own `PREFERRED_TAB_WINDOW_MS` hold — and left it for a note of its own. This is that note; the trigger it named arrived on 2026-09-05, and the same refusal was reproduced on a real machine under an occluded window before this change.

**The session on display was a filter.** The seat read the current session's row alone, so switching the console to another session took every call of the session behind it out of the seat's list — with the tab fully visible. The frame was still mounted and its document still live, because the column hides a frame rather than unmounting it, and nothing was reading it.

## Decision

**Visibility orders the bidding instead of gating it.** Every seat bids; a seat whose tab is not in front pays `HIDDEN_CLAIM_GRACE_MS` (250ms) before its first bid and nothing after it. The constant sits beside `PREFERRED_TAB_WINDOW_MS` in `src/access/wire.ts` and is the seat's half of the same race: both consoles receive the call over their own projection stream from one host, so the skew between them is milliseconds. The state and the `visibilitychange` listener that mirrored the value are gone with the veto — it is read at the bid, where it is used.

**The seat holds one column per session rather than one column.** `ContentReadSeat.sessions` carries a `SeatSession` for the session on display and for every other session the seat still holds a frame of. The session on display takes its page from the column's own selection, which is where the user's pick among several entries lives; every other session takes it from the frame cache, whose recency list is the only record of what the user last had in front for it. `CachedFrame` now carries the session and entry ids it was already encoding in the frame id, so nothing parses that string. A session with no live frame here is absent from the list rather than empty, so the seat never bids for a call it cannot answer, and the host's claim window ends that call as it does today.

**`content_act` is served on a session that is not in front, on one branch.** The approval names the entry the user was reading the request against, and the existing front-changed guard compares it against that session's own page rather than the console's — a session that moved since is refused by name. Flipping this to "refuse every step on a session that is not on display" is one branch in `answer`; it is written here so the decision is visible rather than buried.

**The refusal says showing, not visible.** `No console tab is showing this session's content column (waited 3s)`, with the `; the <kind> "<title>" is already in front.` tail unchanged. Nothing about the ending is about visibility any more; what is still true is that no console holds a live frame of that session's column, whether the page was never on display there or its frame has since been evicted.

## Alternatives considered

**Carry visibility in `ClaimRequest` and let the host hold a hidden bid.** Stronger — the host would arbitrate rather than the seats' own clocks — but it costs a wire field, its parser, a host branch, a supersede rule and a host test suite, and at the default `claimTimeoutMs` of 3000 every hidden bid would spend a third of the claim window in a hold. The claim-restart note had already settled the shape as a seat-side grace. The upgrade path stands: the trigger is a real deployment with two consoles on one session reporting that a set of steps ran in the window nobody was looking at.

**Ask the content column which entry a session other than the current one has in front.** That selection is component-local state in `dsh-experimental-content-column` and is published for the current session alone. The frame cache is a better answer and this package's own: the entry it names is the one whose document is still mounted here, which is the only page the seat could read anyway.

**A `cacheSize`-like knob for how many sessions may be served.** There already is one. A session is servable exactly while its frame is alive, which `cacheSize` bounds; a second knob would let the two disagree.

**Skip the settle wait in a hidden tab and mark the listing still-changing.** Every read of a permanently hidden page would then carry `The page was still changing when this read ran`, the model would read again on each, and the answer would never change — a macro loop of the kind the screenshot-plugin field report already cost us. The quiet timer arriving late only makes the verdict more conservative, never wrong.

**A Worker-backed or `MessageChannel` clock for the seat's waits.** Not taken here; see the throttling consequence below, which is the trigger for taking it.

## Consequences

- A console the user has switched away from, covered with another window, or left behind a locked screen answers reads and steps as one in front does, one grace window later.
- With two consoles on one session, the grace orders the first round only. A read's wait is open when the projection frame arrives, so the tab in front bids into an unclaimed call and the other into a claim already granted. `content_act` registers its wait only after a person answers the approval, so the two seats' retry loops are at arbitrary phase by then and the ordering is statistical; the host's `pinMs` preference is what converges consecutive calls on one tab.
- **A hidden tab's timers are the browser's, and past about five minutes they are one wake-up a minute.** Measured on a real console after 8.4 minutes hidden: `setTimeout` aligned to one second immediately, and Chrome's intensive throttling then stretched it to roughly a minute — with the console's own WebSocket connected throughout, so holding a live connection does not exempt the page. Every wait this seat spends is one of those timers: the interval between bids, the grace above, the quiet window a page is watched through, the poll inside a step, and the poll that asks the frame in front where it is. A read taken in a long-hidden tab can therefore end at the host's report deadline, where the model is told `The console claimed this read but did not answer within Ns.` — which is true, and one the model retries. No wait is changed for it here: the seat's own share constants are how one call's deadline is divided and have nothing to do with visibility, and a step run's deadline is wall-clock and unaffected. The follow-up is a Worker-backed clock for the seat's waits, which is its own slice; its trigger is a field report of claimed-then-silent reads from a console left hidden.
- A picture read in a hidden tab may export a frame the user never saw, because a page drawing through `requestAnimationFrame` stops drawing when its tab goes away. Recorded in the package README beside the WebGL ceiling, and undetectable from outside the page either way.
- A session whose page this console never showed, or whose frame `cacheSize` has evicted, still ends its read on the host's claim window. That is the ceiling the refusal now states.
- `SESSION_FORMAT_VERSION`, the `contentAccess` `stateVersion` (4), the wire schemas and the `Config` surface are all unchanged: this slice adds one protocol constant and no deployment-varying value.

## Testing

`packages/experimental/content-frame` keeps per-file 100% coverage. The two executor suites gain a hidden tab that bids one grace window late and reports its listing, a tab in front that bids inside the grace, a grace paid once rather than per bid, and a set of steps run from a tab that is not in front. `tests/content-cross-session.client.spec.tsx` drives the seat through its props with two sessions: a read for the session behind the one on display answered from its own frame, two sessions' reads landing in their own documents, and the three ways a session is left off the list. The case named `claims nothing while the tab is hidden, and catches up when it comes back` described the behaviour this replaces and is rewritten with it.

`apps/web/tests/content-read-hidden.e2e.ts` is the browser lane's share and takes neither a key nor a recording: the open call is spliced into the seeded log, which is what the `contentAccess` projection publishes to every browser, and the host's wait for it is opened by running the tool under the same call id. Playwright launches Chromium with background throttling disabled, so that lane covers the gate and can never cover the clocks. The four verbatim-refusal suites carry the new sentence, and `tests/self-contained-copy.client.spec.ts` walks it for tool names.

Two probes ran on a real machine on 2026-09-05. The refusal was reproduced under an occluded foreground window, which is the premise of the whole slice. And `checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })` was read on a `content-visibility: auto` subtree inside the hosted frame with the tab hidden for 8.4 minutes: it answered `true` throughout, so the reader asks the browser the same question whether or not the tab is in front, and the conditional branch that was drafted for it is not written.
