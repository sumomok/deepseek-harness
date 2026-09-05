# Agent Note: Answering an approval from the Windows toast

Status: implemented

English | [中文](2026-09-06-desktop-toast-actions.zh.md)

## Problem

The desktop shell already tells the user that a session is waiting for a tool approval, and clicking that toast raises the window. Refusing the request still costs the round trip through the window: restore it, find the session, read the card, press the button. A refusal is the one answer that needs none of that — a request refused unread costs a retry, nothing more — so the cheapest safe answer was the one the notification could not carry.

## Decision

An approval toast on Windows carries two buttons, in this order: 「拒绝」 and 「去看看」.

「拒绝」 answers that waterfall delivery on `$events/result` with `{ kind: 'result', value: 'rejected' }`, over the same authenticated HTTP carrier the shell already answers `next` on. A `result` from any client settles the request for all of them, so the Host cancels the delivery to the browser page and its approval card disappears as the button is pressed — the user's action lands where the user can see it. 「去看看」 calls the same `reveal` that clicking the toast body calls; clicking the body is unchanged.

There is no 「批准」. The toast says which tool a session asked for and nothing else — not the command, not the file, not what would be written — and an approval is given in front of what is being approved.

A pressed button closes its toast, because Windows keeps a shown toast in the action centre with its buttons live. A button pressed on a delivery this shell is no longer waiting on — the page answered it, another client answered it, or its own 60-second grace answer went out — does nothing but write one log line: the Host discards a late answer, and the button does not pretend otherwise.

`toastButtons` draws the actions on Windows only. Linux's `Notification` ignores `actions` outright, and macOS never reaches a notification at all — the shell answers a macOS attention event with a Dock badge and one bounce.

Sending the wrong word would be safe by construction: `dsh-user-approval` normalizes any answer outside its vocabulary to `unavailable`, which refuses the tool call. A shell that mis-answers can only over-refuse, never approve.

## Testing

`apps/desktop/tests/notifications.spec.ts` pins the buttons' order and labels and the platform rule as pure functions. `apps/desktop/tests/toast-answer.spec.ts` drives the module itself — a stand-in `WebSocket` global delivers `ready` and an `approval/request` waterfall, a stand-in `Notification` captures the toast — and reads the answer off a loopback server: the exact `$events/result` payload for a pressed 「拒绝」, the reveal for 「去看看」, and the silence after the delivery was cancelled or already answered.

The Windows toast itself is not unit-testable and is verified on a real Windows machine against the installed build: the buttons require the AUMID that the NSIS installer writes onto the start-menu shortcut, which `pnpm dev` does not create.

## Alternatives considered

**Put 「批准」 on the toast too.** Rejected because approving from the toast approves something the toast did not show. The body names the session and the tool; everything that makes an approval a decision — the command, the paths, the diff — lives on the card in the window.

**Answer `{ kind: 'rejected', error }` instead of a `result`.** Rejected because that outcome is the carrier's own failure channel: it rejects the Host's pending promise rather than settling the approval, and the approval service would read the thrown answer as `unavailable`. The user pressed a button, which is an answer, not a transport failure.

**Reveal the window when a stale button is pressed.** Rejected because the request is gone: raising the window would show the user a session with no card and no explanation of why their press did nothing.

**Close the toast when the request is settled elsewhere.** Not done. It would keep the action centre honest, at the cost of holding every shown `Notification` on the generation and disposing of it on the `cancel` frame; the stale press is already inert, so the cost buys tidiness rather than correctness.

**Carry the toast's buttons through `toastXml` or `electron-windows-notifications`.** Unnecessary: Electron 43.4.0 supports `actions` of type `button` on Windows natively, and the app already sets the AUMID that Windows requires of a toast sender.

## Consequences

The shell is no longer a client that only abstains: one delivery in its stream can now be settled by it, and the module's `answer` takes the outcome rather than assuming `next`. Everything else it announces — a finished turn, a question, a plan review — still carries no buttons; a question's answer is not a two-way choice and would need a different action type.

A refusal from the toast reaches the model as the ordinary rejection, so the agent retries or asks again exactly as it does for a refusal from the card. The user gives up nothing by pressing it and gains nothing they could not already do — only the window trip.
