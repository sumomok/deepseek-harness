# Agent Note: Answering an approval from the Windows toast

Status: implemented

English | [中文](2026-09-06-desktop-toast-actions.zh.md)

## Problem

The desktop shell already tells the user that a session is waiting for a tool approval, and clicking that toast raises the window. Refusing the request still costs the round trip through the window: restore it, find the session, read the card, press the button. A refusal is the one answer that needs none of that — a request refused unread costs a retry, nothing more — so the cheapest safe answer was the one the notification could not carry.

## Decision

An approval toast on Windows carries two buttons, in this order: 「拒绝」 and 「去看看」.

「拒绝」 answers that waterfall delivery on `$events/result` with `{ kind: 'result', value: 'rejected' }`, over the same authenticated HTTP carrier the shell already answers `next` on. A `result` from any client settles the request for all of them, so the Host cancels the delivery to the browser page and its approval card disappears as the button is pressed — the user's action lands where the user can see it. 「去看看」 calls the same `reveal` that clicking the toast body calls; clicking the body is unchanged.

There is no 「批准」. The toast says which tool a session asked for and nothing else — not the command, not the file, not what would be written — and an approval is given in front of what is being approved.

**A toast lives exactly as long as this shell's standing to answer it.** Windows files a shown banner into the action centre within seconds and keeps its buttons live indefinitely; the shell's own grace answers `next` a minute after the delivery and is removed from the delivery's clients as it does, after which the Host discards anything it sends. Those two spans barely overlap, and the grace always arms on Windows because 「最小化到托盘」 hides the window rather than destroying it — so a user who comes back to the action centre and presses 「拒绝」 is, in the ordinary case, pressing a button this shell can no longer honour. The shell therefore closes a toast the moment it has been acted on or the request behind it is over: **a button was pressed on it, its own `next` went out, a `cancel` frame arrived, or the generation was stopped.** Pressing 「去看看」 is on that list without answering anything — the delivery is untouched, the toast has simply had its say — and stopping the generation is there because a rebind leaves toasts on screen whose buttons name deliveries of a server this shell has left. The rule is the same for the toasts that carry no buttons: a question announced and then answered in the window does not stay in the action centre asking.

A press that still reaches a toast this shell can no longer answer for raises the window instead. Raising it is not a consolation prize: the request is usually still pending, because the page is a client of it too and the Host settles a `next` only once the last client abstains, so the card is there to be answered; and when it is gone, its absence is the answer to what the press did. Either way one log line records it.

**A refusal that did not reach the Host is sent again, and gives up rather than holding the request open.** The answer is a POST that can fail, and the Host replays a delivery it never got an answer for. Giving that replay the ordinary grace would answer `next` a minute later and drop the user's refusal in silence — the id is already announced, so no second toast would ask. Refused ids are remembered until the answer is accepted, and a replay of one re-sends the refusal instead of arming a grace; the Host takes an answering client out of the delivery before it settles, so a refusal that lands is forgotten on the response rather than on a `cancel` that never comes. Any answer that fails takes the grace again, because the Host counts this shell among the delivery's clients until it hears one and will not settle anyone else's `next` while it does. A refusal that fails twice therefore ends as the abstention it was competing with — the one trade made here, and the losing half of it is a request that hangs.

**A message is not raised for a request that is already gone, and the delivery is announceable again.** Every waterfall announcement first looks the session's title up over the same HTTP carrier, and a delivery can be settled — or the socket carrying it closed — while that round trip is in flight. The continuation re-checks that the shell is still waiting before it announces, so a settled approval never arrives as a toast offering two live buttons on a request nobody holds. It also drops the id from the announced set as it declines, because a lost socket is not a settled request: the Host replays the delivery to the next registration, and a replay that found the id already announced would say nothing at all and leave the request with no notification ever.

`toastButtons` draws the actions on Windows only. Electron declares `actions` for macOS as well, but macOS never reaches a `Notification` here — the shell answers a macOS attention event with a Dock badge and one bounce — and Linux's `Notification` ignores `actions` outright.

Sending the wrong word would be safe by construction: `dsh-user-approval` normalizes any answer outside its vocabulary to `unavailable`, which refuses the tool call. A shell that mis-answers can only over-refuse, never approve.

## Testing

`apps/desktop-shell/tests/notifications.spec.ts` pins the buttons' order and labels and the platform rule as pure functions. `apps/desktop-shell/tests/toast-answer.spec.ts` drives the module itself — a stand-in `WebSocket` global delivers `ready` and an `approval/request` waterfall, a stand-in `Notification` captures the toast — and reads the answer off a loopback server: the exact `$events/result` payload for a pressed 「拒绝」, the reveal for 「去看看」, the reveal and the log line for a press after a `cancel`, after a second press, and during a reconnect gap, the toast closed by the grace `next`, by a `cancel` on a question that carries no buttons, and by the generation being stopped, the toast never raised for a delivery cancelled mid-lookup but raised on the replay when the socket was what went, the refusal re-sent when a failed one is replayed, forgotten when one is accepted, and abandoned for the abstention after it has failed twice.

**"Nothing was answered" is asserted on what the module issued, not on what the loopback server received.** `fetch` is wrapped rather than replaced, so a press that answered anything is recorded the moment the request is issued; the same assertion written against the server's received payloads passes under a mutation that makes clicking the toast body send a refusal, because the POST has not landed yet when the assertion runs.

The Windows toast itself is not unit-testable and is verified on a real Windows machine against the installed build — the buttons require the AUMID that the NSIS installer writes onto the start-menu shortcut, which `pnpm dev` does not create. Five things only that machine can answer:

1. Whether pressing a button also fires the toast's `click`, which would raise the window on every 「拒绝」.
2. Whether both buttons are drawn, in this order, on a toast whose body is this long.
3. What `close()` does to a banner already filed in the action centre, which Electron documents only as an attempt.
4. What a button on a toast that outlived the app does, and whether pressing it launches the app.
5. Where a press lands more than a minute after the toast — the window comes up, with the approval card still on it or visibly gone.

## Alternatives considered

**Put 「批准」 on the toast too.** Rejected because approving from the toast approves something the toast did not show. The body names the session and the tool; everything that makes an approval a decision — the command, the paths, the diff — lives on the card in the window.

**Answer `{ kind: 'rejected', error }` instead of a `result`.** Rejected because that outcome is the carrier's own failure channel: it rejects the Host's pending promise rather than settling the approval, and the approval service would read the thrown answer as `unavailable`. The user pressed a button, which is an answer, not a transport failure.

**Let a press this shell cannot honour do nothing but log.** Rejected. It reads as tidy — the Host discards a late answer anyway — but it leaves a button that looks live and answers nothing, on a toast that reaches the user mostly after the shell has already given up its standing. Raising the window is the one response that is true whatever happened to the request.

**Leave a settled request's toast in the action centre.** Rejected for the same reason. Holding each shown `Notification` on the generation and closing it costs a map and one call; what it buys is that a toast never outlives the thing it asks about, which is correctness rather than tidiness once the shell's own grace answer is one of the ways the asking ends.

**Register `Notification.handleActivation` for the cold-start path.** Not done. Electron 43 routes a press on a toast with no in-memory `Notification` — including one that survived an app restart — through that static handler, but a cold-started shell has no generation, no client registration, and no delivery to match the press to; making the press mean anything needs the shell to re-open the stream and find the request still pending first. Until then a press on a toast from a previous run reaches no delivery; what Windows itself does with it — launching the app among the possibilities — is one of the questions the real machine answers.

**Carry the toast's buttons through `toastXml` or `electron-windows-notifications`.** Unnecessary: Electron 43.4.0 supports `actions` of type `button` on Windows natively, and the app already sets the AUMID that Windows requires of a toast sender.

## Consequences

The shell is no longer a client that only abstains: one delivery in its stream can now be settled by it, and the module's `answer` takes the outcome rather than assuming `next`. Everything else it announces — a finished turn, a question, a plan review — still carries no buttons; a question's answer is not a two-way choice and would need a different action type.

A refusal from the toast reaches the model as the ordinary rejection, so the agent retries or asks again exactly as it does for a refusal from the card. The user gives up nothing by pressing it and gains nothing they could not already do — only the window trip.
